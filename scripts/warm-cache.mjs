#!/usr/bin/env node
// Pré-aquece o cache local do servidor (PLAN-004): baixa do canal público a
// população (sempre) e, opcionalmente, os cubos dos anos pedidos, com a MESMA
// rotina que o servidor usa em produção (src/cache.ts: SHA-256 conferido,
// manifesto assinado). Roda na construção da imagem do container, onde o
// disco é efêmero e a população precisa vir pronta; serve também para aquecer
// uma instalação local antes de ficar sem rede.
//
//   node scripts/warm-cache.mjs                 # só população
//   node scripts/warm-cache.mjs --years 2024,2025
//
// Respeita SIH_CACHE_DIR e SIH_CUBES_BASE_URL como o servidor.
import { cubesCacheDir, ensurePopulation, ensureYears } from "../dist/cache.js";

const args = process.argv.slice(2);
const i = args.indexOf("--years");
const years = i >= 0 && args[i + 1]
  ? args[i + 1].split(",").map((s) => Number(s.trim())).filter(Number.isInteger)
  : [];

const dir = cubesCacheDir();
const log = (m) => console.error(`[warm] ${m}`);

const pop = await ensurePopulation(dir, log);
if (!pop.available) {
  console.error(`[warm] manifesto sem bloco population — as ferramentas de taxa ficarão sem denominador`);
  process.exit(1);
}
console.error(`[warm] população em ${dir}: ${pop.downloaded.length ? `baixada (${pop.downloaded.join(", ")})` : "já presente"}`);

if (years.length) {
  const { downloaded, unavailable } = await ensureYears(dir, years, log);
  if (unavailable.length) {
    console.error(`[warm] ano(s) não publicado(s) no canal: ${unavailable.join(", ")}`);
    process.exit(1);
  }
  console.error(`[warm] cubos em ${dir}: ${downloaded.length ? `baixados (${downloaded.join(", ")})` : "já presentes"}`);
}
