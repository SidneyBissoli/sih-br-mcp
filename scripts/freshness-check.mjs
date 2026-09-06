#!/usr/bin/env node
// Frescor dos cubos SIH frente ao espelho healthbr-data (src/freshness.ts), fora
// do servidor MCP — para olhar o veredito à mão, para o CI e para regenerar a
// fixture. Três modos:
//
//   node scripts/freshness-check.mjs [--fixtures <dir>] [--out <estado.json>]
//       AO VIVO: mesma checagem que o servidor faz na inicialização (sonda
//       Range de 512 bytes; baixa o resumo ou o manifesto inteiro só se ele
//       mudou). Sai 0 em `current`, 3 em `stale`, 2 em `unknown` (rede).
//       `--out` grava o estado em JSON — é o que o job `decide` de
//       .github/workflows/rebuild-cubes.yml lê para escolher os anos. Não é
//       gate de CI: depende do portal.
//
//   node scripts/freshness-check.mjs --fixtures tests/fixtures/sih --selftest
//       OFFLINE, determinístico (é o que o CI roda): compara o sidecar da
//       fixture com `tests/fixtures/sih/manifest-excerpt.json` — trecho do
//       manifesto público restrito às partições que o sidecar usou — e exige
//       `current`; depois altera uma cópia do trecho (MD5 de uma partição,
//       remove outra, acrescenta a competência seguinte) e exige `stale` com
//       exatamente essas partições nas listas certas. Se a comparação
//       regredir, cai aqui, sem tocar na rede.
//
//   node scripts/freshness-check.mjs --fixtures tests/fixtures/sih --write-excerpt
//       Baixa o manifesto público e regrava `manifest-excerpt.json` com as
//       partições do sidecar. Rodar quando o sidecar da fixture mudar (novo
//       build) — se o espelho tiver reeditado uma partição, o selftest passa a
//       reprovar até o cubo ser regenerado, e é isso que se quer.
//
// `--fixtures` aponta SIH_DATA_DIR antes de importar o dist/ (o módulo de dados
// lê a variável ao carregar); sem a flag, lê data/ como o servidor.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (flag) => args.includes(flag);
const fixtures = opt("--fixtures");
if (fixtures) process.env.SIH_DATA_DIR = resolve(fixtures);
delete process.env.SIH_FRESHNESS_CHECK;

const fail = (msg) => {
  console.error(`FRESCOR FALHOU: ${msg}`);
  process.exit(1);
};

const { loadSidecars } = await import("../dist/provenance.js");
const { evaluateManifest, startFreshnessCheck } = await import("../dist/freshness.js");

const sidecars = loadSidecars();
if (sidecars.length === 0) fail("nenhum sih_provenance_<ano>.json na pasta de cubos");
const excerptPath = resolve(fixtures ?? "tests/fixtures/sih", "manifest-excerpt.json");

if (has("--write-excerpt")) {
  const url = sidecars[0].distributor.manifest_url;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) fail(`HTTP ${res.status} em ${url}`);
  const m = await res.json();
  const keys = sidecars.flatMap((s) => s.partitions.map((p) => p.partition));
  const out = {
    manifest_version: m.manifest_version,
    dataset: m.dataset,
    last_updated: m.last_updated,
    pipeline_version: m.pipeline_version,
    _excerpt: {
      note: `Trecho do manifesto público do healthbr-data restrito às partições que o sidecar da fixture usou; gerado por scripts/freshness-check.mjs --write-excerpt a partir de ${url}`,
      generated_at: new Date().toISOString().slice(0, 10),
      partitions: keys.length,
    },
    partitions: {},
  };
  for (const k of keys) {
    if (!m.partitions[k]) fail(`partição ${k} do sidecar não está no manifesto público`);
    out.partitions[k] = m.partitions[k];
  }
  writeFileSync(excerptPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`trecho gravado em ${excerptPath} (${keys.length} partições, last_updated ${m.last_updated})`);
  process.exit(0);
}

if (has("--selftest")) {
  const excerpt = JSON.parse(readFileSync(excerptPath, "utf8"));
  const ok = evaluateManifest(sidecars, excerpt);
  if (ok.status !== "current") {
    fail(
      `sidecar vs trecho do manifesto deveria dar current, deu ${ok.status}: ` +
        JSON.stringify(ok.cubes.filter((c) => c.behind)) +
        " — se o espelho reeditou a partição, regenerar o cubo e o sidecar; se só o trecho envelheceu, --write-excerpt",
    );
  }
  console.log(`selftest 1/2: current (manifesto ${ok.manifest_last_updated_remote}, ${ok.cubes.length} cubo(s))`);

  // Cópia adulterada: 1ª partição reeditada, última retirada, competência seguinte publicada.
  const s = sidecars[0];
  const parts = s.partitions.map((p) => p.partition);
  const first = parts[0];
  const last = parts.at(-1);
  const lastComp = (s.window?.competencias_expected ?? s.competencias).at(-1);
  const [yy, mm] = lastComp.split("-").map(Number);
  const nextComp = mm === 12 ? `${yy + 1}-01` : `${yy}-${String(mm + 1).padStart(2, "0")}`;
  const bad = structuredClone(excerpt);
  bad.last_updated = "2099-01-01T00:00:00";
  bad.partitions[first] = { ...bad.partitions[first], source_hash_md5: "0".repeat(32) };
  delete bad.partitions[last];
  // Competência FORA da janela esperada não conta como nova (o cubo fechou);
  // uma DENTRO só conta se o sidecar não a usou — a fixture usou todas, então
  // simulamos janela incompleta retirando a última competência do sidecar.
  const incomplete = structuredClone(s);
  incomplete.window = { ...s.window, competencias_expected: [...s.window.competencias_expected, nextComp], complete: false };
  bad.partitions[`${nextComp}-${s.ufs_arquivo[0]}`] = { source_hash_md5: "f".repeat(32), source_size_bytes: 1 };

  const st = evaluateManifest([incomplete], bad);
  const c = st.cubes[0];
  const want = (name, got, exp) => {
    if (JSON.stringify(got) !== JSON.stringify(exp)) fail(`${name}: esperado ${JSON.stringify(exp)}, veio ${JSON.stringify(got)}`);
  };
  if (st.status !== "stale") fail(`cópia adulterada deveria dar stale, deu ${st.status}`);
  want("reedited", c.reedited, [first]);
  want("removed", c.removed, [last]);
  want("new_in_window", c.new_in_window, [`${nextComp}-${s.ufs_arquivo[0]}`]);
  want("reprocessed", c.reprocessed, []);
  if (st.manifest_last_updated_remote !== "2099-01-01T00:00:00") fail("manifest_last_updated_remote não veio do manifesto");
  console.log(`selftest 2/2: stale detectado — reeditada ${first}, retirada ${last}, nova ${nextComp}-${s.ufs_arquivo[0]}`);
  console.log("FRESCOR SELFTEST OK");
  process.exit(0);
}

// Ao vivo.
const t0 = Date.now();
const state = await startFreshnessCheck();
console.log(JSON.stringify(state, null, 2));
if (opt("--out")) writeFileSync(opt("--out"), JSON.stringify(state, null, 2) + "\n");
console.log(`(${Date.now() - t0} ms)`);
process.exit(state.status === "current" ? 0 : state.status === "stale" ? 3 : 2);
