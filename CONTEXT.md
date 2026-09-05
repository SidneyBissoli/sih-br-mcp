# SIH-BR-MCP: Contexto do Projeto

> **Este arquivo resume as decisões tomadas no planejamento e orienta o Claude Code sobre o estado atual e próximos passos.**

## Objetivo

Desenvolver um **MCP Server** para análise de dados do Sistema de Informações Hospitalares do SUS (SIH-SUS), com foco em **Internações por Condições Sensíveis à Atenção Primária (ICSAP)**.

---

## Progresso do Desenvolvimento

### Passo 1 (Planejamento) ✅
### Passo 2 (Estrutura e Scripts R) ✅
### Passo 3 (Geração de Dados de Teste) ✅
### Passo 4 (Ferramentas MCP em TypeScript) ✅
- 12 ferramentas implementadas (todas)

### Passo 5 (Dados Populacionais) ✅
- [x] Script R `build-population.R` criado e funcional
- [x] `pop_municipios.parquet` gerado (1991-2024, 27 UFs, 6.326.761 registros)
- [x] `pop_uf.parquet` gerado (2000-2024, 27 UFs, 117.450 registros)
- [x] `pop_uf_agregado.parquet` gerado (1991-1999, derivado dos municípios)

### Passo 6 (Ferramentas Finais) ✅
- [x] `get_hospitalization_rates` implementada (taxa por 100 mil hab, anos 2000-2024)
- [x] `compare_icsap_trends` implementada (tendências com taxa, regressão linear)
- [x] Validação: erro se ano < 2000 (sem dados populacionais UF)
- [x] Build sem erros, testes de população passando

---

## Decisões Arquiteturais

1. **Idade simples** nos cubos de internação (inteiro 0-100+)
2. **Faixa etária** nos cubos de população municipal (limitação da fonte)
3. **Idade simples** nas projeções por UF (quando disponível)
4. **Grupos CSAP** como string ("g01"-"g19")
5. **Capítulos CID** como inteiro (1-22)
6. **População incluída no MCP** (não depende de outro MCP)
7. **Cliente DuckDB: `@duckdb/node-api`** ("Node Neo", cliente oficial atual), desde 2026-09-05 — o binding legado `duckdb` pinava `node-gyp ^9` em runtime e arrastava tar/cacache/glob antigos para o lock (60 dos 72 alertas do Dependabot de 09/2026); o Neo tem binário pré-compilado por plataforma e nenhum toolchain nativo na árvore. Só `src/db/duckdb.ts` toca o cliente, pelo funil `query()`, que lê com `getRowObjectsJS()` e converte bigint. Plano e medições: `docs/plan-002-migracao-duckdb-node-api.md`
8. **Ordem das linhas garantida** nas consultas agrupadas (`buildOrderBy` no funil, 2026-09-05): toda coluna de agrupamento não ordenada pelo chamador entra como desempate — sem isso, duas chamadas iguais devolviam rankings diferentes em empate e subconjuntos diferentes com `limit`
9. **Gate do CI: smoke + golden pelo stdio** (`scripts/smoke-stdio.mjs`, `scripts/golden-tools.mjs`) sobre a fixture versionada em `tests/fixtures/sih` — superfície e valores das 12 ferramentas byte a byte contra `baselines/`; não é suíte (ver `campanha:contrato-vitest` no portfolio-monitor)
10. **Origem dos cubos SIH: healthbr-data, não o FTP** (2026-09-05). `scripts/build-aggregations.R` v2 lê as partições `sih/rd/ano=AAAA/mes=MM/uf=XX/` do R2 público do healthbr-data (Parquet 1:1 do `.dbc`, colunas cruas como string, projetando só as 10 colunas que os cubos usam — 2023/RR são 45.354 linhas em ~13 s) em vez de baixar o `.dbc` via `microdatasus::fetch_datasus`. Motivo além do volume: `process_sih()` trocava os códigos de SEXO, COD_IDADE e MORTE por rótulos e convertia DT_INTER para `Date`, e o script comparava com códigos — o cubo antigo saiu com `sex = "I"` em todas as linhas, `age` nulo, `deaths = 0` e `month` só com `-1`/`0`. O cubo novo tem os mesmos n, dias, valor, raça e CSAP, e sexo, idade, óbitos e mês corretos. `year`/`month` vêm de DT_INTER (data da internação). **Desde o build v2.2.0 (2026-09-05) o script lê o espelho pelo pacote healthbR** — `healthbR::sih_status()` para saber quais partições existem e de que `.dbc` vieram (URL, MD5, tamanho, SHA-256 do Parquet, versão e commit do pipeline) e `healthbR::sih_data(source = "r2", lazy = TRUE)` para ler as 10 colunas projetadas — e não tem mais código S3 nem token próprio (viviam duplicados no script e no pacote). Cada partição lida é conferida contra a contagem do manifesto. `retrieved_at` do sidecar passou a ser o `processing_timestamp` do manifesto, igual ao segundo ao `download_date` do rodapé do Parquet que o script lia antes; o campo `download_date` saiu do sidecar (opcional no tipo TS). Verificado regenerando 2023/RR: cubos idênticos, golden e smoke verdes sem regravar baseline.
10a. **Cubo por ANO DE INTERNAÇÃO, janela de 4 meses** (2026-09-05, build v2.1.0, `MESES_SEGUINTES <- 4L`). O cubo do ano Y lê as competências Y-01..Y-12 e (Y+1)-01..04 e descarta internações de outros anos. Decidido nos dados, não em hipótese: `docs/analise-001-janela-competencia.md` mede, em 131,8 milhões de AIH (competências 2016-01 a 2026-06, 27 UFs), que 4 meses fecham 99,7–99,9% das internações do ano (dezembro 99,3–99,7%), que o 5º e o 6º mês somam 0,04 ponto, e que a cauda restante (0,06–0,19% depois de +12) é reapresentação difusa em GO, RJ e SP que nenhuma janela recupera. Consequências: `year` é sempre o ano do arquivo e `month` vai de 1 a 12 sem queda artificial no fim do ano; o cubo de Y FECHA quando (Y+1)-04 é publicada (partições posteriores não o alteram; só reedição dentro da janela justifica rebuild — regra para `sih:cubos-frescor`); janela incompleta fica marcada no sidecar (`window.complete = false`) e no `data_vintage` ("janela INCOMPLETA"). 2023/RR: 16 partições, 59.141 AIH lidas, 10.661 de outros anos descartadas, 48.480 internações de 2023 (antes: 45.354 AIH de competência 2023, com 5.884 de 2022 e sem 9.010 faturadas em 2024). Scripts da evidência: `scripts/lag-competencia.mjs` (DuckDB sobre o R2) e `scripts/lag-competencia-analise.py`.
11. **Sidecar de proveniência ao lado de cada cubo** (`data/sih_provenance_<ano>.json`, versionado; cópia na fixture). Gravado pelo script R a partir do rodapé `healthbr` de cada Parquet e do manifesto público (`https://pub-99d9e1a3f5c542178d04efbddf1bba97.r2.dev/sih/rd/manifest.json`): URL do `.dbc` no FTP, MD5 e tamanho da origem, data de download no espelho, SHA-256 do Parquet, contagens, versão do script, R e arrow. É o registro de SAFRA (spec-001 §5): `retrieved_at` do bloco de proveniência = maior data de download dos `.dbc` usados, não o instante da chamada — por isso o golden pode gravar o bloco. Vigiar deriva (o MS reedita arquivos): comparar `source_hash_md5`/`source_size_bytes` do sidecar com o manifesto do espelho — mecanismo de checagem e rebuild automático ainda por fazer (`sih:cubos-frescor` no portfolio-monitor).
12. **Bloco de proveniência em toda resposta** (`src/provenance.ts`, contrato `@sbissoli/mcp-provenance` v1, modo concise, namespace `br.sbissoli.sih`). A fonte no topo é o Ministério da Saúde/DATASUS; o healthbr-data aparece em `citation`, `derivation_note` e `license` como redistribuição (CC-BY-4.0), nunca como fonte. Ferramentas de referência citam a Portaria 221/2008 ou a CID-10; `get_hospitalization_rates` leva um segundo bloco do IBGE (SIDRA 7358); as de ICSAP levam SIH + Portaria. O texto da resposta é o próprio `structuredContent` (com `provenance` e `attribution`); não há rodapé em parte separada porque smoke e golden juntam as partes e fazem `JSON.parse`. Os scripts de smoke/golden leem o ano do campo estrutural `years` — o regex sobre o texto inteiro pegaria o `2026` da citação.

---

## REGRAS PARA DADOS POPULACIONAIS

### Hierarquia de fontes
1. **Primeiro:** Usar dados que o IBGE disponibiliza
2. **Segundo:** Se IBGE não tiver, usar dados que o DATASUS disponibiliza
3. **Nunca:** Criar dados que nem IBGE nem DATASUS disponibilizam

### Proibições absolutas
- ❌ **PROIBIDO interpolar** dados entre anos
- ❌ **PROIBIDO incluir projeções futuras** (após 2024)
- ❌ **PROIBIDO inventar** valores não existentes nas fontes

### Operações permitidas
- ✅ Baixar dados exatamente como estão nas fontes
- ✅ Padronizar formatos (códigos de município, nomes de variáveis)
- ✅ **Agregar municípios para obter UF** (soma simples, não é interpolação)

---

## Estrutura dos Dados Populacionais (GERADOS)

### Arquivo 1: `pop_municipios.parquet` ✅

Dados municipais consolidados de todas as fontes (IBGE via DATASUS).

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int | Ano (1991-2024) |
| source | string | Fonte: "censo", "contagem", "estimativa" |
| municipality_code | string | Código IBGE 6 dígitos |
| uf | string | Sigla UF |
| sex | string | "M", "F" ou "total" |
| age_group | string | Faixa etária (ex: "0-4", "5-9", ..., "80+") |
| population | int | População |

**Estatísticas:** 6.326.761 registros, 27 UFs, 1991-2024

### Arquivo 2: `pop_uf.parquet` ✅

Projeções/estimativas por UF do IBGE (Revisão 2024), com sexo e idade simples.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int | Ano (2000-2024) |
| uf | string | Sigla UF |
| sex | string | "M" ou "F" |
| age | int | Idade simples (0-90, onde 90 = 90+) |
| population | int | População |

**Estatísticas:** 117.450 registros, 27 UFs, 2000-2024

### Arquivo 3: `pop_uf_agregado.parquet` ✅

Para anos onde não há projeção UF com idade (antes de 2000), agregado dos dados municipais.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int | Ano (1991-1999) |
| uf | string | Sigla UF |
| sex | string | "M", "F" ou "total" |
| age_group | string | Faixa etária |
| population | int | População (soma dos municípios) |

---

## Ferramentas MCP

| Ferramenta | Status | Descrição |
|------------|--------|-----------|
| `get_hospitalizations` | ✅ | Contagens de internações |
| `get_hospitalization_trends` | ✅ | Séries temporais |
| `get_hospitalization_rates` | ✅ | Taxas por 100 mil hab (anos 2000-2024) |
| `compare_regions` | ✅ | Comparação entre regiões |
| `get_icsap` | ✅ | Internações ICSAP |
| `get_icsap_indicators` | ✅ | Indicadores ICSAP |
| `compare_icsap_trends` | ✅ | Tendências ICSAP com taxas (anos 2000-2024) |
| `rank_csap_groups` | ✅ | Ranking grupos CSAP |
| `classify_as_csap` | ✅ | Classifica CID como CSAP |
| `list_csap_groups` | ✅ | Lista grupos CSAP |
| `list_cid_chapters` | ✅ | Lista capítulos CID |
| `get_available_years` | ✅ | Anos disponíveis |

**Total:** 12/12 implementadas ✅

---

## Estrutura do Projeto

```
sih-br-mcp/
├── data/
│   ├── sih_causas_2023.parquet      ✅
│   ├── sih_series_2023.parquet      ✅
│   ├── sih_icsap_2023.parquet       ✅
│   ├── pop_municipios.parquet       ✅ NOVO
│   ├── pop_uf.parquet               ✅ NOVO
│   ├── pop_uf_agregado.parquet      ✅ NOVO
│   └── test/
├── scripts/
│   ├── build-aggregations.R
│   ├── test-aggregations.R
│   └── build-population.R           ✅ NOVO
├── src/
│   ├── index.ts                     (servidor MCP + 12 ferramentas)
│   ├── db/duckdb.ts                 (queries DuckDB + população)
│   └── utils/                       (age-groups, population)
└── ...
```

---

## Ambiente

- **Sistema:** Windows + PowerShell
- **Projeto:** `C:\Users\SIDNEY\OneDrive\Programacao\MCP\sih-br-mcp`
- **R:** Pacotes necessários: `sidrar`, `csapAIH`, `arrow`, `dplyr`, `cli`
- **Node:** TypeScript, esbuild, @modelcontextprotocol/sdk

---

## Referências

- **DATASUS População:** http://tabnet.datasus.gov.br/cgi/ibge/popdescr.htm
- **SIDRA IBGE:** https://sidra.ibge.gov.br/
- **Projeções IBGE:** https://www.ibge.gov.br/estatisticas/sociais/populacao/9109-projecao-da-populacao.html
- **Pacote csapAIH:** https://github.com/fulvionedel/csapAIH
- **FTP DATASUS:** ftp://ftp.datasus.gov.br/dissemin/publicos/IBGE/
