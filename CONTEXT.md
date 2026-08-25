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
