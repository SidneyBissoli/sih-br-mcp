#!/usr/bin/env node
// Mede o CAMINHO FRIO do PLAN-006 sem o container: cache vazio, canal real,
// uma thread (como no `basic`). É o que separa "o código novo é lento a frio"
// de "o container estava trocando de imagem".
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sih-frio-"));
process.env.SIH_CACHE_DIR = dir;
process.env.SIH_DATA_DIR = dir;
process.env.SIH_DUCKDB_THREADS = "1";
process.env.SIH_FRESHNESS_CHECK = "off";

const { callTool } = await import("../dist/tools.js");

const anos = Array.from({ length: 34 }, (_, i) => 1992 + i);
const t0 = Date.now();
const r = await callTool("get_hospitalizations", { year: anos, group_by: ["year"] });
const dt = (Date.now() - t0) / 1000;
const b = JSON.parse(r.content[0].text);

const arquivos = readdirSync(dir);
const bytes = arquivos.reduce((s, f) => s + statSync(join(dir, f)).size, 0);
console.log(`\n34 anos a FRIO: ${dt.toFixed(1)} s`);
console.log(`  ${b.data.length} anos, ${b.summary.total_hospitalizations.toLocaleString("pt-BR")} internações, ${b.notes.length} notas`);
console.log(`  cache ficou com ${arquivos.length} arquivos, ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`  parquets: ${arquivos.filter((f) => f.endsWith(".parquet")).join(", ") || "nenhum"}`);
console.log(`  sidecars: ${arquivos.filter((f) => f.startsWith("sih_provenance_")).length}`);

const t1 = Date.now();
await callTool("get_hospitalizations", { year: anos, group_by: ["year"] });
console.log(`  a mesma pergunta a QUENTE: ${((Date.now() - t1) / 1000).toFixed(1)} s`);

rmSync(dir, { recursive: true, force: true });
