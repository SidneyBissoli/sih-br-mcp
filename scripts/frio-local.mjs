#!/usr/bin/env node
// Mede o CAMINHO FRIO do PLAN-006 sem o container: cache vazio, canal real,
// uma thread (como no `basic`). É o que separa "o código novo é lento a frio"
// de "o container estava trocando de imagem" — e é onde se mede o ganho de
// pré-assar artefatos na imagem.
//
//   node scripts/frio-local.mjs                # cache do zero
//   node scripts/frio-local.mjs --pre-assado   # com o que a imagem já traz
//
// RODE UM POR PROCESSO. O servidor memoiza estado (sidecars lidos, resumos
// conferidos, pasta de dados escolhida); medir os dois cenários no mesmo
// processo faz o segundo parecer rápido por memo, não por desenho.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const preAssado = process.argv.includes("--pre-assado");
const dir = mkdtempSync(join(tmpdir(), "sih-frio-"));
process.env.SIH_CACHE_DIR = dir;
process.env.SIH_DATA_DIR = dir;
process.env.SIH_DUCKDB_THREADS = "1";
process.env.SIH_FRESHNESS_CHECK = "off";

const anos = Array.from({ length: 34 }, (_, i) => 1992 + i);
const tamanho = () => {
  const arquivos = readdirSync(dir);
  return { arquivos, bytes: arquivos.reduce((s, f) => s + statSync(join(dir, f)).size, 0) };
};

// Cenário "pré-assado": encher a pasta com o que o Dockerfile assa na imagem,
// FORA da medição. É o mesmo caminho de código do build (warm-cache.mjs).
if (preAssado) {
  const { ensureCausasSummary, ensureIcsapSummary, ensurePopulation, ensureSidecars, loadCubesManifest, publishedYears } =
    await import("../dist/cache.js");
  const quieto = () => {};
  await ensurePopulation(dir, quieto);
  const { manifest } = await loadCubesManifest();
  await ensureSidecars(dir, publishedYears(manifest), quieto);
  await ensureIcsapSummary(dir, quieto);
  await ensureCausasSummary(dir, quieto);
  const t = tamanho();
  console.log(`imagem traz ${t.arquivos.length} arquivos, ${(t.bytes / 1e6).toFixed(1)} MB`);
}
const antes = tamanho();

const { callTool } = await import("../dist/tools.js");

const t0 = Date.now();
const r = await callTool("get_hospitalizations", { year: anos, group_by: ["year"] });
const dt = (Date.now() - t0) / 1000;
const b = JSON.parse(r.content[0].text);
const depois = tamanho();

console.log(`\n34 anos${preAssado ? ", com a imagem PRÉ-ASSADA" : ", cache DO ZERO"}: ${dt.toFixed(1)} s`);
console.log(`  ${b.data.length} anos, ${b.summary.total_hospitalizations.toLocaleString("pt-BR")} internações, ${b.notes.length} notas`);
console.log(`  baixou ${depois.arquivos.length - antes.arquivos.length} arquivo(s), ${((depois.bytes - antes.bytes) / 1e6).toFixed(1)} MB`);
console.log(`  cubos no cache: ${depois.arquivos.filter((f) => /^sih_(causas|series|icsap)_\d{4}\.parquet$/.test(f)).length}`);

const t1 = Date.now();
await callTool("get_hospitalizations", { year: anos, group_by: ["year"] });
console.log(`  a mesma pergunta a QUENTE: ${((Date.now() - t1) / 1000).toFixed(1)} s`);

rmSync(dir, { recursive: true, force: true });
