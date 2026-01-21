# SIH-BR-MCP: Contexto do Projeto

> **Este arquivo resume as decisões tomadas no planejamento. Use-o para dar contexto ao Claude Code.**

## Objetivo

Desenvolver um **MCP Server** para análise de dados do Sistema de Informações Hospitalares do SUS (SIH-SUS), com foco em **Internações por Condições Sensíveis à Atenção Primária (ICSAP)**.

## Tipos de Usuário

| Tipo | Descrição | Interação |
|------|-----------|-----------|
| **Desenvolvedor** | Quem mantém o projeto | Roda scripts R, gera Parquets, desenvolve código TypeScript |
| **Usuário Final** | Quem usa o MCP | Conversa com Claude Desktop em linguagem natural |

O **usuário final NUNCA** interage com scripts R ou arquivos Parquet. Ele apenas faz perguntas ao Claude Desktop e o MCP responde usando os dados já processados.

## Indicadores Principais

1. **Percentual ICSAP:** (ICSAP / Total de internações) × 100
2. **Taxa ICSAP:** (ICSAP / População) × 10.000 habitantes

## Variáveis Demográficas

| Variável | Disponibilidade | Notas |
|----------|-----------------|-------|
| Sexo | Sempre | Boa qualidade |
| Idade | Sempre | Boa qualidade |
| Raça/Cor | A partir de ~2008 | Alta proporção de "ignorado" em anos iniciais |
| Município de residência | Sempre | Código IBGE 6 dígitos |

## Estrutura de Arquivos Parquet

**Um arquivo por ano** (o DuckDB lê múltiplos Parquets automaticamente):

```
data/
├── sih_causas_1998.parquet
├── sih_causas_1999.parquet
├── ...
├── sih_causas_2024.parquet
├── sih_series_1998.parquet
├── sih_series_1999.parquet
├── ...
├── sih_icsap_1998.parquet
├── sih_icsap_1999.parquet
├── ...
├── populacao_municipios.parquet
└── test/                          # Dados de teste (não usar em produção)
    ├── sih_causas_2023.parquet
    ├── sih_causas_2024.parquet
    └── ...
```

**Estimativa de espaço:** ~5-10 MB por ano por cubo. Total para 27 anos: ~400-800 MB.

## Cubos de Dados (Parquet)

### Cubo 1: `sih_causas_{ano}.parquet`
Dimensões: year, month, uf, cid_chapter, cid_group, sex, age_group, race, is_csap, csap_group
Métricas: n, days, value, deaths

### Cubo 2: `sih_series_{ano}.parquet`
Dimensões: year_month, uf, cid_chapter
Métricas: n, deaths

### Cubo 3: `sih_icsap_{ano}.parquet`
Dimensões: year, uf, municipality_code, csap_group, sex, age_group, race
Métricas: n, n_total, days, value, deaths

### Auxiliar: `populacao_municipios.parquet`
Fonte: Pacote csapAIH (estimativas 2000-2021)

## Scripts R

### build-aggregations.R (Produção)

Gera dados de **produção** em `data/`.

```r
source("scripts/build-aggregations.R")
build_data(years = ..., ufs = ...)
```

#### Parâmetros

| Parâmetro | Valores aceitos | Exemplos |
|-----------|-----------------|----------|
| `years` | Um ano, vetor, sequência ou "all" | `2023`, `c(2020, 2022)`, `2020:2024`, `"all"` |
| `ufs` | Uma UF, vetor ou "all" | `"SP"`, `c("SP", "RJ")`, `"all"` |

#### Exemplos de uso

```r
# 1 ano, 1 UF
build_data(years = 2023, ufs = "SP")

# 1 ano, todas as UFs
build_data(years = 2023, ufs = "all")

# Todos os anos, 1 UF
build_data(years = "all", ufs = "AC")

# 5 anos em sequência, 1 UF
build_data(years = 2020:2024, ufs = "SP")

# 3 anos não sequenciais, 2 UFs
build_data(years = c(2015, 2020, 2024), ufs = c("SP", "RJ"))

# TUDO (alertará que é demorado)
build_data(years = "all", ufs = "all")
```

#### Comportamento

- Se o Parquet do ano já existe, **SOBRESCREVE**
- Não guarda dados brutos: baixa → processa → gera Parquet → descarta
- Log claro com progresso (ano X de Y)
- Se `years = "all"` e `ufs = "all"`, exibe confirmação antes de continuar

### test-aggregations.R (Teste)

Gera dados de **teste** em `data/test/`. **Mesma lógica** do build-aggregations.R.

```r
source("scripts/test-aggregations.R")
test_data(years = ..., ufs = ...)
```

#### Exemplos de uso

```r
# Teste rápido: 2 anos, 2 UFs pequenas
test_data(years = 2023:2024, ufs = c("AC", "RR"))

# Teste com UF grande
test_data(years = 2024, ufs = "SP")
```

#### Finalidade

- Validar que o código funciona corretamente
- Testar após mudanças no código do MCP
- **NÃO** é para gerar dados de produção

### Quando usar cada script

| Situação | test-aggregations.R | build-aggregations.R |
|----------|:-------------------:|:--------------------:|
| Desenvolvimento inicial | ✅ Validar fluxo | ✅ Depois, gerar dados |
| Atualização anual de dados | ❌ | ✅ |
| Alterações no código do MCP | ✅ Validar que não quebrou | ❌ |
| Corrigir/reprocessar ano específico | ❌ | ✅ |

## Estrutura do Projeto

```
sih-br-mcp/
├── docs/
│   └── tool-specifications.md    # Specs das 12 ferramentas
├── src/
│   ├── data/
│   │   ├── csap-groups.json      # 19 grupos CSAP
│   │   ├── cid-chapters.json     # 22 capítulos CID-10
│   │   └── brazil-regions.json   # Regiões e UFs
│   ├── tools/
│   │   ├── general/              # get_hospitalizations, trends, rates
│   │   ├── icsap/                # get_icsap, indicators, trends, rank
│   │   └── metadata/             # list_csap_groups, cid_chapters, etc.
│   ├── db/
│   │   └── duckdb.ts             # Conexão DuckDB
│   └── utils/
│       ├── age-groups.ts
│       └── population.ts
├── data/                          # Parquets de PRODUÇÃO (um por ano)
│   ├── sih_causas_YYYY.parquet
│   ├── sih_series_YYYY.parquet
│   ├── sih_icsap_YYYY.parquet
│   └── populacao_municipios.parquet
├── scripts/
│   ├── build-aggregations.R      # Produção: build_data(years, ufs)
│   └── test-aggregations.R       # Teste: test_data(years, ufs)
├── package.json
├── tsconfig.json
└── CONTEXT.md                    # Este arquivo
```

## Ferramentas MCP (12 total)

### Internações Gerais (4)
| Ferramenta | Descrição |
|------------|-----------|
| `get_hospitalizations` | Consulta flexível com filtros por ano, UF, CID, sexo, idade |
| `get_hospitalization_trends` | Séries temporais mensais/anuais |
| `get_hospitalization_rates` | Taxas brutas, ajustadas por idade, mortalidade hospitalar |
| `compare_regions` | Rankings e comparações entre UFs/regiões |

### ICSAP (5)
| Ferramenta | Descrição |
|------------|-----------|
| `get_icsap` | Consulta de ICSAP com múltiplas dimensões |
| `get_icsap_indicators` | Calcula % ICSAP e taxa por 10.000 hab. |
| `compare_icsap_trends` | Análise temporal comparativa |
| `rank_csap_groups` | Ranking dos 19 grupos CSAP |
| `classify_as_csap` | Classifica códigos CID-10 como CSAP ou não |

### Metadados (3)
| Ferramenta | Descrição |
|------------|-----------|
| `list_csap_groups` | Lista os 19 grupos da Portaria 221/2008 |
| `list_cid_chapters` | Lista capítulos CID-10 |
| `get_available_years` | Anos disponíveis nos dados |

## Pacotes R Necessários

```r
# Instalação
install.packages(c("arrow", "dplyr", "tidyr", "purrr", "stringr", "cli", "here"))
remotes::install_github("rfsaldanha/microdatasus")
remotes::install_github("fulvionedel/csapAIH")
```

- **microdatasus**: Download dos arquivos RD do DATASUS
- **csapAIH**: Classificação CSAP + população municipal
- **arrow**: Exportação para Parquet
- **cli**: Mensagens formatadas no console

## Progresso

### Passo 2 (Claude Code) - CONCLUÍDO ✅
Arquivos criados:
- `package.json` ✅ - Configuração do projeto Node.js com dependências MCP
- `tsconfig.json` ✅ - Configuração TypeScript
- `scripts/build-aggregations.R` ✅ - Função `build_data(years, ufs)`
- `scripts/test-aggregations.R` ✅ - Função `test_data(years, ufs)`
- `src/utils/age-groups.ts` ✅ - Utilitários para faixas etárias
- `src/utils/population.ts` ✅ - Utilitários para dados populacionais

### Passo 3 (R local) - PENDENTE ⏳
**Objetivo:** Executar os scripts R para gerar os arquivos Parquet

**Pré-requisitos:**
```r
install.packages(c("arrow", "dplyr", "tidyr", "purrr", "stringr", "cli", "here"))
remotes::install_github("rfsaldanha/microdatasus")
remotes::install_github("fulvionedel/csapAIH")
```

**Execução sugerida:**

1. **Primeiro, validar com teste:**
   ```r
   source("scripts/test-aggregations.R")
   test_data(years = 2023:2024, ufs = c("AC", "RR"))
   ```

2. **Depois, gerar dados de produção:**
   ```r
   source("scripts/build-aggregations.R")
   build_data(years = "all", ufs = "all")
   ```

### Passo 4 (Claude Code) - PENDENTE ⏳
**Executa em paralelo ao Passo 3**

- [ ] Implementar ferramentas MCP em TypeScript (12 tools)
- [ ] Integrar DuckDB para consultas nos Parquets
- [ ] Testes

## Referências

- **Portaria MS/SAS 221/2008**: Lista Brasileira de ICSAP
- **Pacote csapAIH**: https://github.com/fulvionedel/csapAIH
- **microdatasus**: https://github.com/rfsaldanha/microdatasus
- **MCP SDK**: https://github.com/modelcontextprotocol/typescript-sdk
