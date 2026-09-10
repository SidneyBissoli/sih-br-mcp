#!/usr/bin/env node
// Pré-aquece o cache local do servidor (PLAN-004): baixa do canal público o
// que TODA chamada acaba precisando, com a MESMA rotina que o servidor usa em
// produção (src/cache.ts: SHA-256 conferido, manifesto assinado). Roda na
// construção da imagem do container, onde o disco é efêmero e o que não vier
// pronto é pago no primeiro uso; serve também para aquecer uma instalação
// local antes de ficar sem rede.
//
// O QUE VEM SEMPRE, e por quê (medido em 10/09/2026, PLAN-006 F3):
//
// | Artefato                    | Tamanho | Por que na imagem |
// |-----------------------------|---------|-------------------|
// | população (3 Parquet + sidecar) | 13 MB | as ferramentas de taxa não respondem sem denominador |
// | 34 sidecars de proveniência | 9,7 MB  | é deles que saem as notas de era; eram QUASE TODO o custo frio |
// | resumo da ICSAP             | 276 KB  | atende a série longa sem cubo (PLAN-005) |
// | grão A das causas           | 569 KB  | atende a série longa sem cubo (PLAN-006) |
//
// Os sidecars são o oposto do cubo: pequenos, muitos, SEMPRE pedidos (é deles
// que saem as notas de era) e baixados em SÉRIE — o pior formato possível para
// pagar a frio. Medido na IMAGEM DE VERDADE, com os limites do `basic`
// (`docker run --memory=1g --cpus=0.25`), container recém-nascido nos dois
// casos, mesma pergunta de 34 anos e mesma resposta:
//
//   imagem sem os sidecars assados   13,4 s, baixando 10,3 MB
//   imagem com os sidecars assados    2,5 s, sem baixar NADA
//
// Custo: a imagem passou de 571 MB para 584 MB.
//
// O QUE NÃO VEM: os cubos por ano (23–72 MB cada) e os ESTRATOS por ano do
// grão B (~0,55 MB cada). Os dois são por ano e sob demanda; assar 34 de cada
// engorda a imagem para servir uma pergunta que talvez não venha. Cubos podem
// ser pedidos caso a caso com --years (ou WARM_YEARS no build).
//
//   node scripts/warm-cache.mjs                 # população + sidecars + resumos
//   node scripts/warm-cache.mjs --years 2024,2025
//   node scripts/warm-cache.mjs --skip-sidecars # só população (imagem mínima)
//
// Respeita SIH_CACHE_DIR e SIH_CUBES_BASE_URL como o servidor.
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  cubesCacheDir,
  ensureCausasSummary,
  ensureIcsapSummary,
  ensurePopulation,
  ensureSidecars,
  ensureYears,
  loadCubesManifest,
  publishedYears,
} from "../dist/cache.js";

const args = process.argv.slice(2);
const i = args.indexOf("--years");
const years = i >= 0 && args[i + 1]
  ? args[i + 1].split(",").map((s) => Number(s.trim())).filter(Number.isInteger)
  : [];
const skipSidecars = args.includes("--skip-sidecars");

const dir = cubesCacheDir();
const log = (m) => console.error(`[warm] ${m}`);

const pop = await ensurePopulation(dir, log);
if (!pop.available) {
  console.error(`[warm] manifesto sem bloco population — as ferramentas de taxa ficarão sem denominador`);
  process.exit(1);
}
console.error(`[warm] população em ${dir}: ${pop.downloaded.length ? `baixada (${pop.downloaded.join(", ")})` : "já presente"}`);

if (!skipSidecars) {
  const { manifest } = await loadCubesManifest();
  if (!manifest) {
    console.error(`[warm] manifesto indisponível — não dá para assar sidecars nem resumos`);
    process.exit(1);
  }
  const anos = publishedYears(manifest);

  // GATE: sidecar que não vier agora vira download a frio em produção, então
  // uma falha aqui reprova a imagem em vez de sair barata e cara depois.
  // ensureSidecars() engole erro de rede de propósito (em produção, ficar sem
  // a nota é melhor que derrubar a consulta); aqui a conferência é por
  // arquivo presente, não pelo que ele devolveu.
  await ensureSidecars(dir, anos, log);
  const faltando = anos.filter((y) => {
    const f = manifest.years[String(y)]?.files?.provenance;
    if (!f) return false;
    try {
      return statSync(join(dir, f.name)).size !== f.size_bytes;
    } catch {
      return true;
    }
  });
  if (faltando.length) {
    console.error(`[warm] sidecar(s) faltando ou truncado(s): ${faltando.join(", ")}`);
    process.exit(1);
  }
  console.error(`[warm] ${anos.length} sidecar(s) de proveniência em ${dir} (notas de era prontas a frio)`);

  // Os dois resumos: pequenos, sempre pedidos pelas ferramentas que cobrem, e
  // reconferidos por SHA-256 a cada chamada — assar não cria risco de resumo
  // velho, o servidor rebaixa sozinho se o canal mudar.
  for (const [nome, ensure, arquivo] of [
    ["ICSAP", ensureIcsapSummary, "sih_icsap_resumo.parquet"],
    ["causas", ensureCausasSummary, "sih_causas_resumo.parquet"],
  ]) {
    const { available } = await ensure(dir, log);
    if (!available) {
      console.error(`[warm] manifesto sem o bloco de pré-agregados de ${nome} — a série longa vai pagar o cubo`);
      continue;
    }
    console.error(`[warm] resumo de ${nome} em ${dir} (${(statSync(join(dir, arquivo)).size / 1e3).toFixed(0)} KB)`);
  }
}

if (years.length) {
  const { downloaded, unavailable } = await ensureYears(dir, years, log);
  if (unavailable.length) {
    console.error(`[warm] ano(s) não publicado(s) no canal: ${unavailable.join(", ")}`);
    process.exit(1);
  }
  console.error(`[warm] cubos em ${dir}: ${downloaded.length ? `baixados (${downloaded.join(", ")})` : "já presentes"}`);
}
