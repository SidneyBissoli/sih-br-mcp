#!/usr/bin/env node
// As tabelas de classificação de src/data/ são CÓPIAS de um contrato que vive
// no produtor dos cubos (healthbr-data, scripts/pipeline/sih-cubos/tables/) e
// é publicado no canal em sih/cubos/tables/*.json, com o SHA-256 de cada uma
// no bloco `tables` de sih/cubos/manifest.json (manifest_version >= 1.1.0,
// 2026-09-08). O servidor importa as cópias em tempo de build (TypeScript);
// este script garante que a cópia é a mesma tabela que o builder usou para
// gerar os cubos que o servidor lê — sem isso, um cubo classificado por uma
// lista e um servidor rotulando por outra passariam pelo golden sem ninguém
// ver (o golden roda sobre a fixture, com as cópias que estão aqui).
//
//   node scripts/tables-check.mjs                 # baixa o manifesto do canal
//   node scripts/tables-check.mjs --manifest <arquivo.json>   # offline
//
// Compara só as tabelas que o manifesto assina (cid9-codes, cid9-chapters,
// csap-groups, csap-groups-cid9, csap-universe); brazil-regions.json e
// cid-chapters.json são do servidor. Divergência = exit 1 (a correção é copiar
// a tabela do produtor, ou o produtor publicar a nova — nunca editar aqui).
// Canal indisponível = aviso e exit 0: o CI não fica refém do portal
// (`::warning`), e o `--manifest` local cobre o teste offline.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (process.env.SIH_CUBES_BASE_URL ?? "https://data.sidneybissoli.com/sih/cubos/").replace(/\/?$/, "/");
const dataDir = resolve(opt("--data") ?? "src/data");

let manifest;
if (opt("--manifest")) {
  manifest = JSON.parse(readFileSync(opt("--manifest"), "utf8"));
} else {
  try {
    const r = await fetch(`${base}manifest.json?v=${Date.now()}`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    manifest = await r.json();
  } catch (e) {
    // sem process.exit(): no Windows o fetch ainda fecha handles e o Node
    // aborta com asserção do libuv (ruído, mas assusta)
    console.log(`::warning::tables-check: manifesto do canal indisponível (${e.message}) — conferência das tabelas pulada`);
    manifest = null;
  }
}

const tables = manifest?.tables ?? {};
const names = Object.keys(tables).sort();
if (manifest && names.length === 0) {
  console.log("::warning::tables-check: manifesto sem bloco `tables` (produtor anterior a 1.1.0) — nada a conferir");
}

let falhas = 0;
for (const name of names) {
  const local = join(dataDir, name);
  if (!existsSync(local)) {
    console.error(`tables-check: ${name} assinada no manifesto mas ausente em ${dataDir}`);
    falhas++;
    continue;
  }
  const sha = createHash("sha256").update(readFileSync(local)).digest("hex");
  if (sha !== tables[name].sha256) {
    console.error(`tables-check: ${name} DIVERGE do produtor (local ${sha.slice(0, 12)}…, canal ${String(tables[name].sha256).slice(0, 12)}…)`);
    falhas++;
  } else {
    console.log(`tables-check: ${name} ok`);
  }
}
if (falhas) {
  console.error(`tables-check: ${falhas} tabela(s) divergente(s) — copie de healthbr-data/scripts/pipeline/sih-cubos/tables/ (ou baixe de ${base}tables/)`);
  process.exitCode = 1;
} else if (names.length) {
  console.log(`tables-check: ${names.length} tabela(s) iguais às do produtor (manifesto ${manifest.generated_at ?? "?"})`);
}
