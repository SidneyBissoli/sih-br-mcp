# Comparativo: sih-br-mcp e as alternativas para o SIH/SUS

**Quem trabalha com internações hospitalares do SUS** (SIH/SUS, AIH, DATASUS) já tem
ferramentas consolidadas em R e em Python: [microdatasus][md], [PySUS][py],
[read.dbc][rd], [csapAIH][cs], [brpop][bp]. Elas vieram antes e resolvem um problema
que este servidor não resolve. Este documento diz, com números medidos, **onde cada
uma serve** — e quando usar mais de uma.

Resumo em uma linha: microdatasus, PySUS e read.dbc entregam o **microdado**;
`sih-br-mcp` responde a **pergunta agregada** dentro do assistente de IA, sem ETL.

## A cadeia do dado, e onde cada ferramenta entra

```
Ministério da Saúde / DATASUS — FTP, RD<UF><AAMM>.dbc          23,67 GiB, 11.157 arquivos UF-mês (1992–2026)
   │
   ├── read.dbc (R) ................................. descomprime o .dbc
   ├── microdatasus (R) ............................. baixa, processa e rotula o microdado
   ├── PySUS (Python) ............................... baixa e lê DBC/DBF
   │        │
   │        └── csapAIH (R) ......................... classifica a AIH em ICSAP
   │        └── brpop (R) ........................... denominador populacional
   │
   └── healthbr-data (espelho Parquet 1:1, MD5 por partição)
            │
            └── cubos agregados sih/cubos/ .......... 1,17 GiB, 34 anos, 420.103.883 internações
                     │
                     ├── sih-br-mcp (este) .......... pergunta agregada no assistente de IA
                     └── healthbR (R) ............... o mesmo espelho, em data.frame
```

## Tabela

| | Linguagem / distribuição | Grão que entrega | O que você escreve | Onde roda |
| --- | --- | --- | --- | --- |
| **sih-br-mcp** | TypeScript, [npm][np] + [MCP Registry][mr] | **Agregado** (ano, mês, UF, município, capítulo e grupo CID, sexo, idade, raça/cor, ICSAP; internações, dias, valor pago, óbitos) | A pergunta, em linguagem comum | Cliente MCP (Claude, ChatGPT, Claude Code) ou HTTP |
| [microdatasus][md] 3.0.0 | R, CRAN | **Registro individual** da AIH, com variáveis rotuladas | Download, processamento, filtro e agregação | R local |
| [PySUS][py] 2.11.2 | Python, PyPI | **Registro individual** (DBC/DBF do FTP) | O ETL e a análise | Python local |
| [read.dbc][rd] 1.2.0 | R, CRAN | O arquivo `.dbc` aberto | A leitura e todo o resto | R local |
| [csapAIH][cs] | R, GitHub | Classificação ICSAP do seu microdado | A classificação sobre os seus dados | R local |
| [brpop][bp] 0.7.0 | R, CRAN | População por município, UF, sexo e faixa | O cálculo da taxa | R local |
| [healthbR][hb] 0.4.0 | R, CRAN | Agregado e microdado do mesmo espelho Parquet | Chamada de função, em R | R local |

## Três perguntas, lado a lado

### 1. "Internações por pneumonia no Espírito Santo em 2024, por faixa de idade"

*Pelo microdado (microdatasus, PySUS):* baixar as 12 partições `RD-ES-2024mm`,
descomprimir, processar e rotular, filtrar os códigos CID da pneumonia, recortar a
idade em faixas, agregar. O ano de 2024 inteiro são **1.019 MiB** de `.dbc`; só o ES,
uma fração disso. Quem já tem o pipeline pronto faz em minutos; quem não tem, escreve
o pipeline.

*Aqui:* uma chamada de `get_hospitalizations` com UF, ano, grupo CID e
`group_by: ["age_group"]`. O assistente escolhe a ferramenta; você lê a resposta com a
citação da safra.

### 2. "A taxa de ICSAP por UF caiu entre 2010 e 2023, padronizada por idade?"

*Pelo microdado:* 14 anos × 27 UFs de microdado, mais a classificação ICSAP da Lista
Brasileira ([csapAIH][cs] resolve), mais o denominador populacional por UF, sexo e
faixa ([brpop][bp] resolve), mais a padronização por idade — e a decisão de qual
população-padrão usar.

*Aqui:* uma chamada de `get_icsap_indicators` ou `compare_icsap_trends`. A lista ICSAP
é a da **Portaria SAS/MS 221/2008** (19 grupos, 197 códigos CID-10); antes de 1998, em
que o SIH usava CID-9, vale a lista derivada e documentada em
[`analise-003-icsap-cid9.md`](analise-003-icsap-cid9.md) (19 grupos, 439 códigos). A
população vem do IBGE (Projeção 2024) e do DATASUS POPBR/POPSVS, publicada assinada no
mesmo canal.

### 3. "Internações e gasto do SUS por ano, desde 1992"

*Pelo microdado:* 34 anos, **23,67 GiB** de `.dbc` em 11.157 arquivos.

*Aqui:* uma chamada. Medido contra o endpoint público em 10/09/2026
([`plan-006`](plan-006-causas-pre-agregada.md), `scripts/borda-plan-006.mjs`):

| Pergunta | antes (0.14.2) | agora (0.15.0+) |
| --- | --- | --- |
| Internações, dias, gasto e óbitos por ano, 34 anos | 54,7 s | **0,6 s** |
| Principais capítulos CID na série longa | 58,7 s | **0,2 s** |
| Taxa por 100 mil, 60 anos e mais, por UF (2024) | 1,6 s | **0,5 s** |

Cada número devolvido é idêntico nas duas versões. Com cache vazio, a série de 34 anos
custa **9,7 s** e baixa **10,3 MB** — o pré-agregado de causas (569.486 bytes) e os 34
sidecares de proveniência, nenhum cubo.

## Volume, em números

| | Tamanho | Fonte |
| --- | --- | --- |
| Microdado bruto SIH-RD, 1992–2026 | 23,67 GiB (11.157 partições UF-mês) | [`sih/rd/manifest-summary.json`](https://data.sidneybissoli.com/sih/rd/manifest-summary.json) |
| Um ano de microdado bruto (2024) | 1.019 MiB | idem |
| Cubos agregados de causas, 34 anos | 1,17 GiB | [`sih/cubos/manifest.json`](https://data.sidneybissoli.com/sih/cubos/manifest.json) |
| Pré-agregado de causas (grão A, 34 anos) | 569.486 bytes | idem |
| Uma pergunta agregada de 34 anos, cache vazio | 10,3 MB | [`plan-006`](plan-006-causas-pre-agregada.md) |

## O que este servidor não faz

- **Registro individual.** Os cubos são agregados; não há como recuperar uma AIH.
- **Variáveis fora dos cubos**: procedimento realizado, CNES do estabelecimento,
  caráter de atendimento, diagnóstico secundário. O que existe está em
  [`tool-specifications.md`](tool-specifications.md).
- **Outros sistemas do DATASUS**: SIM, SINASC, SIA, SINAN, CNES. Para eles, o caminho é
  microdatasus, PySUS ou o espelho [healthbr-data][hd].
- **Dado que não passou pelo espelho.** A safra é a do manifesto, e cada resposta diz
  qual é; quem precisa do que o DATASUS publicou hoje vai ao FTP.

## Como conferir os números

Comparação é barata aqui de propósito:

1. Cada resposta traz `provenance` e `attribution` — safra, versão do servidor e a
   citação formal da fonte.
2. Os cubos derivam do espelho Parquet 1:1 do [healthbr-data][hd], com MD5 por partição
   de origem e SHA-256 por arquivo publicado no `manifest.json`. O servidor confere o
   SHA-256 do que baixa.
3. Os pré-agregados só são usados se o `derived_from` deles ainda bater com o SHA-256 do
   cubo publicado; se não bater, a pergunta cai no cubo e sai exata.
4. O repositório tem a fixture real de 2023/RR e um golden das 12 ferramentas
   (`npm run golden:tools`): qualquer mudança de número reprova no CI.
5. **Refaça pelo microdado.** Baixe o mesmo recorte com microdatasus ou PySUS, agregue e
   compare. Divergência é bug — [abra uma issue][is] com o recorte.

## Usar juntos

- **Pergunta agregada, resposta auditável, dentro do assistente:** este servidor.
- **Microdado, variável fora do cubo, outro sistema:** microdatasus ou PySUS.
- **Tudo em R:** [healthbR][hb] para o dado, [csapAIH][cs] para a classificação ICSAP,
  [brpop][bp] para o denominador.

## In English

Brazilian hospital admission data (SIH/SUS, "AIH" records, published by DATASUS) is
usually handled with [microdatasus][md] (R) or [PySUS][py] (Python): both download and
decode the raw `.dbc` microdata — 23.67 GiB for the full 1992–2026 series. `sih-br-mcp`
sits one layer up: it answers **aggregate** questions (by year, month, state,
municipality, ICD-10 chapter and group, sex, age, race, ambulatory care sensitive
conditions — admissions, length of stay, amount paid, deaths) from pre-built cubes,
inside Claude, ChatGPT or any MCP client, with provenance and a citation in every
answer. A 34-year national series costs 10.3 MB and under a second. Use microdatasus or
PySUS when you need record-level data, variables the cubes do not carry, or another
DATASUS system; use this when the question is aggregate and the answer must be
auditable.

[md]: https://github.com/rfsaldanha/microdatasus
[py]: https://github.com/AlertaDengue/PySUS
[rd]: https://cran.r-project.org/package=read.dbc
[cs]: https://fulvionedel.github.io/csapAIH/
[bp]: https://cran.r-project.org/package=brpop
[hb]: https://cran.r-project.org/package=healthbR
[hd]: https://github.com/SidneyBissoli/healthbr-data
[np]: https://www.npmjs.com/package/sih-br-mcp
[mr]: https://registry.modelcontextprotocol.io/
[is]: https://github.com/SidneyBissoli/sih-br-mcp/issues
