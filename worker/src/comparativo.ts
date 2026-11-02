/**
 * Página de comparação em `/vs-microdatasus-pysus` — a SEGUNDA página própria
 * do produto.
 *
 * POR QUE EXISTE (02/11/2026, ação `geo:sih-br-mcp`). Três rodadas do monitor
 * GEO com a superfície de nome já corrigida (README, npm, registro) deram ao sih
 * 3/7 → 1/7 → 1/7 no claude com busca, e zero no resto; as alternativas citadas
 * foram sempre microdatasus, PySUS e read.dbc. O comparativo existia desde
 * 13/09, mas como `docs/comparativo-alternativas.md` DENTRO do repositório, onde
 * motor com busca não chega. O healthbR, mesmo público, foi a 5/7 em 1º com uma
 * PÁGINA que compara com os nomes que os motores já citam. Esta é essa página.
 *
 * O QUE ELA AFIRMA, E DE ONDE VEIO. Nenhum número é ilustrativo: a mesma pergunta
 * foi respondida em 02/11/2026 pelos três caminhos, com os scripts que estão em
 * `scripts/comparativo/` do repositório, e os resultados estão em `MEDIDO`. Os
 * números vão envelhecer (o DATASUS reedita arquivos; o espelho é ressincronizado)
 * — por isso a página data a medição em vez de se apresentar como o valor atual.
 * `tests/comparativo.test.ts` confere que cada número de `MEDIDO` aparece no HTML
 * e que os três caminhos deram o mesmo total.
 */

import { SERVER_CONFIG, LANDING } from "./config.js";

/** Rota da página. Exportada para o sitemap e a landing não repetirem a literal. */
export const COMPARATIVO_ROUTE = "/vs-microdatasus-pysus";

/** Escapa texto para interpolação segura em HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * O que foi medido em 02/11/2026. Pergunta: internações por pneumonia
 * (CID-10 J12–J18) de RESIDENTES do Espírito Santo, com data de internação em
 * 2024. Contagens são inteiros; tempos em segundos; tamanhos em bytes ou MiB.
 */
export const MEDIDO = {
  data: "2026-11-02",
  sih: {
    versao: "1.8.1",
    internacoes: 13305,
    obitos: 1250,
    segundosPrimeira: 0.9,
    segundosSegunda: 0.7,
    kbResposta: 21,
  },
  microdatasus: {
    versao: "3.0.0",
    internacoes: 13305,
    obitos: 1250,
    arquivos: 432,
    mibDbc: 1358,
    registrosLidos: 18863265,
    minutos: 40.6,
  },
  soArquivoDoEs: { arquivos: 16, mib: 30, internacoes: 13097 },
  pysus: {
    versao: "2.11.7",
    // Rodada completa no Linux (WSL): 345 arquivos lidos, 87 vazios, 15.516.999
    // registros. O tempo NÃO é comparável ao do microdatasus: o WSL lia e gravava
    // no disco do Windows (/mnt/c).
    internacoesGroupRd: 9135,
    obitosGroupRd: 760,
    minutos: 59.4,
    arquivosPerdidos: 87,
    pneumoniasNosPerdidos: 4170,
    arquivosRdNoCatalogo: 10946,
    arquivosRdSemGrupo: 4526,
  },
  volumes: {
    gibMicrodado: 23.86,
    particoes: 11211,
    registros: 432173746,
    gibCanalCubos: 1.63,
    internacoes34Anos: 420107114,
  },
} as const;

const pt = (n: number, casas = 0): string =>
  n.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
const en = (n: number, casas = 0): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: casas, maximumFractionDigits: casas });

/** Título com os três nomes: é o que os motores já citam e o que se busca. */
export const TITULO = {
  "pt-BR": "sih-br-mcp, microdatasus e PySUS: a mesma pergunta sobre internações do SIH/SUS por três caminhos",
  en: "sih-br-mcp, microdatasus and PySUS: one SIH/SUS hospital admissions question, three ways",
} as const;

export const RESUMO = {
  "pt-BR":
    "Internações por pneumonia de moradores do Espírito Santo em 2024, respondidas pelo microdado do DATASUS " +
    "com microdatasus (R) e PySUS (Python) e pelo sih-br-mcp no assistente de IA: o mesmo total, quanto custa " +
    "cada caminho e onde cada um serve. Medido em 02/11/2026.",
  en:
    "Pneumonia admissions of Espírito Santo residents in 2024, answered from DATASUS microdata with microdatasus " +
    "(R) and PySUS (Python) and by sih-br-mcp inside an AI assistant: the same total, what each path costs and " +
    "where each one fits. Measured on 2 November 2026.",
} as const;

const UFS = `"AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
         "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"`;

const CODIGO_R = `library(microdatasus)
library(dplyr)

ufs   <- c(${UFS})
comps <- seq(as.Date("2024-01-01"), as.Date("2025-04-01"), by = "month")

pneu <- list()
for (d in as.list(comps)) for (uf in ufs) {
  y <- as.integer(format(d, "%Y")); m <- as.integer(format(d, "%m"))
  rd <- fetch_datasus(year_start = y, month_start = m, year_end = y, month_end = m,
                      uf = uf, information_system = "SIH-RD",
                      vars = c("MUNIC_RES", "DT_INTER", "DIAG_PRINC", "MORTE"))
  pneu[[length(pneu) + 1]] <- rd |>
    filter(substr(MUNIC_RES, 1, 2) == "32",                     # mora no ES
           substr(DT_INTER, 1, 4) == "2024",                    # internou em 2024
           substr(DIAG_PRINC, 1, 3) %in% sprintf("J%02d", 12:18))
}
bind_rows(pneu) |> summarise(internacoes = n(), obitos = sum(MORTE == "1"))
#>   internacoes obitos
#> 1       ${MEDIDO.microdatasus.internacoes}   ${MEDIDO.microdatasus.obitos}`;

const CODIGO_PY = `import pandas as pd
import pysus

ufs = "AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO".split()
comps = [(2024, m) for m in range(1, 13)] + [(2025, m) for m in range(1, 5)]
pneumonia = {f"J{n}" for n in range(12, 19)}

partes = []
for y, m in comps:
    for uf in ufs:
        rd = pysus.ftp.sih(state=uf, year=y, month=m, group="RD", as_dataframe=True)
        if rd.empty:
            continue
        partes.append(rd[rd["MUNIC_RES"].str[:2].eq("32")
                         & rd["DT_INTER"].str[:4].eq("2024")
                         & rd["DIAG_PRINC"].str[:3].isin(pneumonia)])
pneu = pd.concat(partes)
len(pneu)
#> ${MEDIDO.pysus.internacoesGroupRd}      # ver a seção sobre o PySUS 2.11.7`;

const CODIGO_MCP = `get_hospitalizations {
  "uf": ["ES"], "year": [2024], "cid_chapter": [10], "group_by": ["cid_group"]
}
# J12 461 · J13 37 · J14 1 · J15 3.648 · J16 265 · J17 100 · J18 8.793
# soma J12–J18: ${pt(MEDIDO.sih.internacoes)} internações, ${pt(MEDIDO.sih.obitos)} óbitos
# provenance: competências 2024-01 a 2025-04, 27 UFs de arquivo, safra do espelho, citação`;

function secaoPt(): string {
  const s = MEDIDO;
  return `
<p class="muted">Medido em 2 de novembro de 2026: sih-br-mcp ${s.sih.versao} no endpoint público,
microdatasus ${s.microdatasus.versao} com R 4.6.1 no Windows, PySUS ${s.pysus.versao} com Python 3.13 no Linux,
numa conexão residencial no Brasil. Os scripts estão em
<a href="${esc(LANDING.repoUrl)}/tree/master/scripts/comparativo"><code>scripts/comparativo/</code></a>; nada aqui é ilustrativo.</p>

<p>Quem trabalha com internações hospitalares do SUS (SIH/SUS, as AIH publicadas pelo DATASUS) costuma chegar
ao dado por dois pacotes: o <a href="https://github.com/rfsaldanha/microdatasus">microdatasus</a>, em R, e o
<a href="https://github.com/AlertaDengue/PySUS">PySUS</a>, em Python. Os dois baixam e decodificam o
<strong>microdado</strong> do FTP do DATASUS. O <strong>sih-br-mcp</strong> fica uma camada acima: responde a
<strong>pergunta agregada</strong> dentro do assistente de IA (Claude, ChatGPT ou qualquer cliente MCP), a partir de
cubos pré-agregados, com a proveniência em toda resposta. Esta página faz a mesma pergunta pelos três caminhos.</p>

<h2>A pergunta</h2>
<p><em>"Quantas internações por pneumonia (CID-10 J12–J18) tiveram os moradores do Espírito Santo em 2024, e quantos óbitos?"</em></p>
<p>Ela parece pedir um arquivo. Pede ${s.microdatasus.arquivos}. O DATASUS publica um arquivo por UF <em>do hospital</em> e
por <em>competência</em> (o mês de faturamento), e a pergunta é por UF de <em>residência</em> e por <em>data de
internação</em>. Quem mora no ES e foi internado em Minas está no arquivo de MG; quem internou em dezembro de 2024
pode ter sido faturado em março de 2025. Por isso: 27 UFs × 16 competências (2024-01 a 2025-04) =
${s.microdatasus.arquivos} arquivos, ${pt(s.microdatasus.mibDbc)} MiB de <code>.dbc</code>,
${pt(s.microdatasus.registrosLidos)} registros. Lendo só o arquivo do ES (${s.soArquivoDoEs.arquivos} arquivos,
${s.soArquivoDoEs.mib} MiB) saem ${pt(s.soArquivoDoEs.internacoes)} internações: faltam
${pt(s.microdatasus.internacoes - s.soArquivoDoEs.internacoes)}, de moradores do ES internados em MG, no RJ e em outras UFs.</p>

<h2>Os três caminhos, lado a lado</h2>
<table>
<thead><tr><th></th><th>Internações</th><th>Óbitos</th><th>O que baixou</th><th>Tempo</th></tr></thead>
<tbody>
<tr><td><strong>sih-br-mcp</strong> ${s.sih.versao}</td><td>${pt(s.sih.internacoes)}</td><td>${pt(s.sih.obitos)}</td><td>resposta de ${s.sih.kbResposta} KB</td><td>${pt(s.sih.segundosPrimeira, 1)} s</td></tr>
<tr><td>microdatasus ${s.microdatasus.versao}</td><td>${pt(s.microdatasus.internacoes)}</td><td>${pt(s.microdatasus.obitos)}</td><td>${s.microdatasus.arquivos} arquivos, ${pt(s.microdatasus.mibDbc)} MiB</td><td>${pt(s.microdatasus.minutos, 1)} min</td></tr>
<tr><td>PySUS ${s.pysus.versao}, <code>group="RD"</code></td><td>${pt(s.pysus.internacoesGroupRd)}</td><td>${pt(s.pysus.obitosGroupRd)}</td><td>${s.microdatasus.arquivos - s.pysus.arquivosPerdidos} de ${s.microdatasus.arquivos} arquivos</td><td>${pt(s.pysus.minutos, 1)} min*</td></tr>
</tbody>
</table>
<p class="muted">* No Linux do WSL, lendo e gravando no disco do Windows: não compare com o tempo do microdatasus.</p>
<p>O microdatasus e o sih-br-mcp chegam ao <strong>mesmo número, grupo a grupo</strong> (J12 461, J13 37, J14 1, J15 3.648,
J16 265, J17 100, J18 8.793). Não é coincidência: os cubos do sih saem do espelho Parquet 1:1 dos mesmos <code>.dbc</code>, lendo a
mesma janela de competências. A diferença é onde o trabalho acontece: no microdado, no seu computador, a cada pergunta;
no sih, uma vez, na construção dos cubos.</p>

<h3>microdatasus (R)</h3>
<pre><code>${esc(CODIGO_R)}</code></pre>

<h3>PySUS (Python)</h3>
<pre><code>${esc(CODIGO_PY)}</code></pre>

<h3>sih-br-mcp (no assistente)</h3>
<p>A pergunta vai em linguagem comum; o assistente escolhe a ferramenta e lê a resposta, que traz a safra e a citação:</p>
<pre><code>${esc(CODIGO_MCP)}</code></pre>

<h2>Uma nota sobre o PySUS ${s.pysus.versao}</h2>
<p>Com <code>group="RD"</code>, a chamada acima devolveu ${pt(s.pysus.internacoesGroupRd)} internações, não
${pt(s.microdatasus.internacoes)}. A causa está no catálogo que o PySUS ${s.pysus.versao} consulta antes de baixar: dos
${pt(s.pysus.arquivosRdNoCatalogo)} arquivos RD do SIH, ${pt(s.pysus.arquivosRdSemGrupo)} estão sem grupo, e a consulta por
grupo não os enxerga — sem erro e sem aviso. Na janela desta pergunta são ${s.pysus.arquivosPerdidos} dos
${s.microdatasus.arquivos} arquivos (entre eles 7 dos 16 meses do próprio ES), com ${pt(s.pysus.pneumoniasNosPerdidos)}
das pneumonias. Chamando sem <code>group</code>, esses arquivos aparecem (junto com os de outros grupos, ER, RJ e SP, que é
preciso descartar). No Windows há um segundo defeito: o filtro de caminho não reconhece a barra invertida, e as chamadas
do SIH devolveram uma tabela vazia. É o tipo de coisa que se conserta numa tarde depois de relatada; até lá, confira a contagem de
arquivos que voltaram.</p>

<h2>Volume, em números</h2>
<table>
<thead><tr><th></th><th>Tamanho</th></tr></thead>
<tbody>
<tr><td>Microdado bruto SIH-RD, 1992–2026, no espelho</td><td>${pt(s.volumes.gibMicrodado, 2)} GiB, ${pt(s.volumes.particoes)} arquivos, ${pt(s.volumes.registros)} registros</td></tr>
<tr><td>Tudo o que o canal de cubos publica (cubos, pré-agregados, população, tabelas)</td><td>${pt(s.volumes.gibCanalCubos, 2)} GiB</td></tr>
<tr><td>A pergunta desta página</td><td>${s.microdatasus.arquivos} arquivos e ${pt(s.microdatasus.mibDbc)} MiB pelo microdado; ${s.sih.kbResposta} KB pelo sih</td></tr>
<tr><td>Internações, dias, gasto e óbitos por ano, 1992–2025</td><td>${pt(s.volumes.internacoes34Anos)} internações numa chamada de menos de 1 s</td></tr>
</tbody>
</table>

<h2>O que o sih-br-mcp não faz</h2>
<ul>
  <li><strong>Registro individual.</strong> Os cubos são agregados; não há como recuperar uma AIH.</li>
  <li><strong>Variáveis fora dos cubos</strong>: procedimento realizado, CNES do estabelecimento, caráter de atendimento, diagnóstico secundário.</li>
  <li><strong>Outros sistemas do DATASUS</strong> (SIM, SINASC, SIA, SINAN, CNES).</li>
  <li><strong>O que o DATASUS publicou hoje.</strong> A safra é a do espelho, e cada resposta diz qual é.</li>
</ul>
<p>Para tudo isso, o caminho é o microdatasus ou o PySUS.</p>

<h2>Qual usar</h2>
<ul>
  <li><strong>Pergunta agregada, resposta auditável, dentro do assistente:</strong> sih-br-mcp.</li>
  <li><strong>Microdado, variável fora do cubo, outro sistema, em R:</strong> microdatasus (e <a href="https://cran.r-project.org/package=read.dbc">read.dbc</a> para só abrir o <code>.dbc</code>).</li>
  <li><strong>O mesmo, em Python:</strong> PySUS, conferindo quantos arquivos voltaram.</li>
  <li><strong>Para conferir o sih:</strong> refaça a conta pelo microdado, como esta página fez. Divergência é defeito —
    <a href="${esc(LANDING.repoUrl)}/issues">abra uma issue</a> com o recorte.</li>
</ul>`;
}

function secaoEn(): string {
  const s = MEDIDO;
  return `
<p class="muted">Measured on 2 November 2026: sih-br-mcp ${s.sih.versao} on the public endpoint, microdatasus
${s.microdatasus.versao} with R 4.6.1 on Windows, PySUS ${s.pysus.versao} with Python 3.13 on Linux, over a residential
connection in Brazil. The scripts are in <code>scripts/comparativo/</code> of the repository.</p>

<p>Brazilian hospital admission data (SIH/SUS, the AIH records published by DATASUS) is usually reached through
<a href="https://github.com/rfsaldanha/microdatasus">microdatasus</a> (R) or <a href="https://github.com/AlertaDengue/PySUS">PySUS</a>
(Python), which download and decode the raw microdata. sih-br-mcp sits one layer up: it answers the
<strong>aggregate question</strong> inside an AI assistant, from pre-built cubes, with provenance in every answer.</p>

<p><strong>The question</strong> — pneumonia admissions (ICD-10 J12–J18) of Espírito Santo <em>residents</em>, by
<em>admission date</em> in 2024 — needs ${s.microdatasus.arquivos} DATASUS files: one per hospital state and billing month,
27 states × 16 months, ${en(s.microdatasus.mibDbc)} MiB of <code>.dbc</code>, ${en(s.microdatasus.registrosLidos)} records.
Reading only Espírito Santo's own files gives ${en(s.soArquivoDoEs.internacoes)}, missing the
${en(s.microdatasus.internacoes - s.soArquivoDoEs.internacoes)} residents admitted in other states.</p>

<table>
<thead><tr><th></th><th>Admissions</th><th>Deaths</th><th>Downloaded</th><th>Time</th></tr></thead>
<tbody>
<tr><td><strong>sih-br-mcp</strong> ${s.sih.versao}</td><td>${en(s.sih.internacoes)}</td><td>${en(s.sih.obitos)}</td><td>${s.sih.kbResposta} KB response</td><td>${en(s.sih.segundosPrimeira, 1)} s</td></tr>
<tr><td>microdatasus ${s.microdatasus.versao}</td><td>${en(s.microdatasus.internacoes)}</td><td>${en(s.microdatasus.obitos)}</td><td>${s.microdatasus.arquivos} files, ${en(s.microdatasus.mibDbc)} MiB</td><td>${en(s.microdatasus.minutos, 1)} min</td></tr>
<tr><td>PySUS ${s.pysus.versao}, <code>group="RD"</code></td><td>${en(s.pysus.internacoesGroupRd)}</td><td>${en(s.pysus.obitosGroupRd)}</td><td>${s.microdatasus.arquivos - s.pysus.arquivosPerdidos} of ${s.microdatasus.arquivos} files</td><td>${en(s.pysus.minutos, 1)} min*</td></tr>
</tbody>
</table>
<p class="muted">* On Linux under WSL, reading and writing the Windows disk: not comparable with microdatasus's time.</p>

<p>microdatasus and sih-br-mcp agree to the unit, group by group: the cubes are built from a 1:1 Parquet mirror of the
same <code>.dbc</code> files, over the same billing-month window. PySUS ${s.pysus.versao} returned fewer admissions because
${en(s.pysus.arquivosRdSemGrupo)} of the ${en(s.pysus.arquivosRdNoCatalogo)} SIH RD files in its catalog carry no group, and a
<code>group="RD"</code> query silently skips them (${s.pysus.arquivosPerdidos} of the ${s.microdatasus.arquivos} files here);
calling without <code>group</code> reaches them. On Windows, a path-separator check made the SIH calls return an empty table.</p>

<p><strong>Which one.</strong> Aggregate question, auditable answer, inside the assistant: sih-br-mcp. Record-level data,
variables the cubes do not carry (procedure, facility, secondary diagnosis) or other DATASUS systems (SIM, SINASC, SIA,
SINAN): microdatasus or PySUS. To check sih-br-mcp, redo the count from the microdata, as this page did; a difference is
a bug.</p>`;
}

export function comparativoHtml(): string {
  const c = SERVER_CONFIG;
  const url = `${c.websiteUrl}${COMPARATIVO_ROUTE}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: TITULO["pt-BR"],
    alternativeHeadline: TITULO.en,
    description: RESUMO["pt-BR"],
    inLanguage: ["pt-BR", "en"],
    datePublished: MEDIDO.data,
    url,
    author: { "@type": "Person", name: "Sidney da Silva Pereira Bissoli" },
    about: [
      { "@type": "SoftwareApplication", name: "sih-br-mcp", url: c.websiteUrl },
      { "@type": "SoftwareApplication", name: "microdatasus", url: "https://github.com/rfsaldanha/microdatasus" },
      { "@type": "SoftwareApplication", name: "PySUS", url: "https://github.com/AlertaDengue/PySUS" },
    ],
  };

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITULO["pt-BR"])}</title>
<meta name="description" content="${esc(RESUMO["pt-BR"])}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="/icon.png" type="image/png">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${esc(c.title)}">
<meta property="og:title" content="${esc(TITULO["pt-BR"])}">
<meta property="og:description" content="${esc(RESUMO["pt-BR"])}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(c.websiteUrl)}/icon.png">
<meta property="og:locale" content="pt_BR">
<meta property="og:locale:alternate" content="en_US">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.6; margin: 0; padding: 2rem 1rem; color: CanvasText; background: Canvas;
  }
  main { max-width: 48rem; margin: 0 auto; }
  h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 .5rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; }
  h3 { font-size: 1rem; margin-top: 1.5rem; }
  code { background: color-mix(in srgb, CanvasText 10%, Canvas 90%); padding: .1rem .3rem; border-radius: 4px; }
  pre { overflow-x: auto; padding: .8rem; border-radius: 6px; background: color-mix(in srgb, CanvasText 7%, Canvas 93%); font-size: .85rem; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; font-size: .92rem; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, Canvas 80%); }
  .lead { font-size: 1.05rem; }
  .muted { color: color-mix(in srgb, CanvasText 70%, Canvas 30%); font-size: .92rem; }
  .outro { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid color-mix(in srgb, CanvasText 20%, Canvas 80%); }
</style>
</head>
<body>
<main>
<p class="muted"><a href="/">${esc(c.title)}</a></p>
<h1>${esc(TITULO["pt-BR"])}</h1>
<p class="lead">${esc(RESUMO["pt-BR"])}</p>
${secaoPt()}

<section class="outro" lang="en">
<h2>${esc(TITULO.en)}</h2>
${secaoEn()}
</section>
</main>
</body>
</html>`;
}

export function comparativoResponse(): Response {
  return new Response(comparativoHtml(), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
