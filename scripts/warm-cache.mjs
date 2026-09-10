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
// | estratos das causas (34)    | 18,8 MB | recorte por sexo, idade ou raça na série longa |
// | estratos da ICSAP (34)      | 59,0 MB | o mesmo, do lado da ICSAP |
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
// E o mesmo A/B para a pergunta demográfica na série longa ("a internação de
// idosos mudou desde 1992?"), que foi o que trouxe os ESTRATOS para cá:
//
//   imagem sem os estratos assados   14,0 s, baixando 18,8 MB
//   imagem com os estratos assados    2,8 s, sem baixar NADA
//
// Custo: a imagem foi de 132 MB para 222,9 MB no total das duas voltas
// (`docker image inspect <tag> --format '{{.Size}}'`, que é a contagem
// reprodutível — `docker images` e `docker history` dão totais diferentes para
// esta imagem de dois estágios, mas concordam no delta).
//
// Os ESTRATOS entraram depois, na mesma volta. Eles são POR ANO, então o custo
// escala com o número de anos perguntados: três anos custavam 2,4 MB e 1,2 s,
// mas os 34 custavam 18,8 MB e 11,7 s — o dobro do teto de espera aceitável,
// numa pergunta banal ("a internação de idosos mudou desde 1992?"). Deixá-los
// de fora só se sustenta se a série longa com recorte demográfico for rara, e
// não há como saber que é.
//
// O QUE NÃO VEM: os cubos por ano (23–72 MB cada). Esses somam 1.644 MB nos 34
// anos, contra uma imagem de 584 MB — assá-los seria embarcar o conjunto de
// dados e reconstruir a imagem a cada republicação de qualquer ano, que é
// exatamente o acoplamento que o canal existe para evitar. Podem ser pedidos
// caso a caso com --years (ou WARM_YEARS no build).
//
//   node scripts/warm-cache.mjs                 # tudo da tabela acima
//   node scripts/warm-cache.mjs --years 2024,2025
//   node scripts/warm-cache.mjs --skip-estratos # sem os 78 MB de estratos
//   node scripts/warm-cache.mjs --skip-sidecars # só população (imagem mínima)
//
// Respeita SIH_CACHE_DIR e SIH_CUBES_BASE_URL como o servidor.
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  cubesCacheDir,
  ensureCausasEstratosYears,
  ensureCausasSummary,
  ensureEstratosYears,
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
const skipEstratos = skipSidecars || args.includes("--skip-estratos");

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

  // Estratos: um arquivo por ano, e é isso que os torna caros na série longa.
  // Conferidos por SHA-256 a cada chamada como os resumos, então assar não
  // cria risco de artefato velho.
  if (!skipEstratos) {
    for (const [nome, ensure, bloco, prefixo] of [
      ["ICSAP", ensureEstratosYears, "icsap_summary", "sih_icsap_estratos_"],
      ["causas", ensureCausasEstratosYears, "causas_summary", "sih_causas_estratos_"],
    ]) {
      if (!manifest[bloco]?.files?.estratos) {
        console.error(`[warm] manifesto sem os estratos de ${nome} — o recorte demográfico longo vai pagar o download`);
        continue;
      }
      await ensure(dir, anos, log);
      const faltando = anos.filter((y) => {
        const f = manifest[bloco].files.estratos[String(y)];
        if (!f) return false;
        try {
          return statSync(join(dir, f.name)).size !== f.size_bytes;
        } catch {
          return true;
        }
      });
      if (faltando.length) {
        console.error(`[warm] estratos de ${nome} faltando: ${faltando.join(", ")}`);
        process.exit(1);
      }
      const bytes = anos.reduce((t, y) => t + (manifest[bloco].files.estratos[String(y)]?.size_bytes ?? 0), 0);
      console.error(`[warm] ${anos.length} estrato(s) de ${nome} em ${dir} (${(bytes / 1e6).toFixed(1)} MB), prefixo ${prefixo}`);
    }
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
