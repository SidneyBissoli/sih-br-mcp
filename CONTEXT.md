# SIH-BR-MCP: Contexto do Projeto

> **Este arquivo resume as decisões tomadas no planejamento. Use-o para dar contexto ao Claude Code.**

## Objetivo

Desenvolver um **MCP Server** para análise de dados do Sistema de Informações Hospitalares do SUS (SIH-SUS), com foco em **Internações por Condições Sensíveis à Atenção Primária (ICSAP)**.

## Indicadores Principais

1. **Percentual ICSAP:** (ICSAP / Total de internações) × 100
2. **Taxa ICSAP:** (ICSAP / População) × 10.000 habitantes

## Variáveis Demográficas

| Variável | Disponibilidade | Notas |
|----------|-----------------|-------|
| Sexo | Sempre | Boa qualidade |
| Idade | Sempre | Boa qualidade |
| Raça/Cor | A partir de ~2008 | Alta proporção de "ignorado" em anos iniciais |
| Município de residência | Sempre | Código IBGE 7 dígitos |

## Decisões Arquiteturais

### Projeto Único
Decidimos por **um único projeto** (`sih-br-mcp`) em vez de separar internações gerais e ICSAP. Motivos:
- ICSAP requer dados de internações totais para calcular o percentual
- Evita duplicação de dados e código
- Instalação única para usuários

### Abordagem Híbrida de Dados
1. **Camada 1 (principal):** Dados pré-agregados em Parquet/DuckDB
2. **Camada 2 (fallback):** TabNet para dados muito recentes
3. **Camada 3 (quando disponível):** OpenDataSUS API

### Período de Dados
- **1998-2024** (26 anos em CID-10)
- CID-10 implementado no SIH em janeiro/1998
- Não precisamos de CID-9 (CSAP é definida em CID-10)

## Estrutura do Projeto

```
sih-br-mcp/
├── docs/
│   └── tool-specifications.md    # ✅ Criado - Specs das 12 ferramentas
├── src/
│   ├── data/
│   │   ├── csap-groups.json      # ✅ Criado - 19 grupos CSAP
│   │   ├── cid-chapters.json     # ✅ Criado - 22 capítulos CID-10
│   │   └── brazil-regions.json   # ✅ Criado - Regiões e UFs
│   ├── tools/
│   │   ├── general/              # get_hospitalizations, trends, rates
│   │   ├── icsap/                # get_icsap, indicators, trends, rank
│   │   └── metadata/             # list_csap_groups, cid_chapters, etc.
│   ├── db/
│   │   └── duckdb.ts             # Conexão DuckDB
│   └── utils/
│       ├── age-groups.ts
│       └── population.ts
├── data/                          # Parquet files (gerados pelo R)
│   ├── sih_causas.parquet
│   ├── sih_series.parquet
│   ├── sih_icsap.parquet
│   └── populacao_municipios.parquet
├── scripts/
│   └── build-aggregations.R      # Script para processar dados
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

## Cubos de Dados (Parquet)

### Cubo 1: `sih_causas.parquet`
Dimensões: year, month, uf, cid_chapter, cid_group, sex, age_group, race, is_csap, csap_group
Métricas: n, days, value, deaths

### Cubo 2: `sih_series.parquet`
Dimensões: year_month, uf, cid_chapter
Métricas: n, deaths

### Cubo 3: `sih_icsap.parquet`
Dimensões: year, uf, municipality_code, csap_group, sex, age_group, race
Métricas: n, n_total, days, value, deaths

### Auxiliar: `populacao_municipios.parquet`
Fonte: Pacote csapAIH (estimativas 2012-2024)

## Pacotes R Necessários

```r
# Instalação
install.packages(c("arrow", "dplyr", "tidyr", "purrr"))
remotes::install_github("rfsaldanha/microdatasus")
remotes::install_github("fulvionedel/csapAIH")
```

- **microdatasus**: Download dos arquivos RD do DATASUS
- **csapAIH**: Classificação CSAP + população municipal
- **arrow**: Exportação para Parquet

## Progresso

### Passo 2 (Claude Code) - CONCLUÍDO ✅
Arquivos criados:
- `package.json` ✅ - Configuração do projeto Node.js com dependências MCP
- `tsconfig.json` ✅ - Configuração TypeScript
- `scripts/build-aggregations.R` ✅ - Script para download e agregação dos dados
- `src/utils/age-groups.ts` ✅ - Utilitários para faixas etárias
- `src/utils/population.ts` ✅ - Utilitários para dados populacionais

### Passo 3 (R local) - PENDENTE ⏳
**Objetivo:** Executar o script R para gerar os arquivos Parquet

**Pré-requisitos:**
1. Instalar pacotes R necessários:
   ```r
   install.packages(c("arrow", "dplyr", "tidyr", "purrr", "stringr", "lubridate", "cli"))
   remotes::install_github("rfsaldanha/microdatasus")
   remotes::install_github("fulvionedel/csapAIH")
   ```

**Execução:**
1. Abrir R/RStudio
2. Definir o diretório de trabalho para a pasta do projeto
3. Executar o script:
   ```r
   source("scripts/build-aggregations.R")
   ```

**O que o script faz:**
- Baixa dados do SIH-SUS de 1998-2024 (26 anos)
- Classifica internações como CSAP usando o pacote csapAIH
- Gera 3 cubos de dados agregados + 1 arquivo auxiliar:
  - `data/sih_causas.parquet` - Cubo principal por causa
  - `data/sih_series.parquet` - Séries temporais mensais
  - `data/sih_icsap.parquet` - Cubo ICSAP por município
  - `data/populacao_municipios.parquet` - População municipal

**Tempo estimado:** O download e processamento podem levar várias horas dependendo da conexão.

**Arquivos gerados (na pasta `data/`):**
- [ ] `sih_causas.parquet`
- [ ] `sih_series.parquet`
- [ ] `sih_icsap.parquet`
- [ ] `populacao_municipios.parquet`

### Passo 4 (Claude Code, paralelo ao 3) - PENDENTE ⏳
5. Implementar ferramentas MCP em TypeScript
6. Integrar DuckDB
7. Testes

## Referências

- **Portaria MS/SAS 221/2008**: Lista Brasileira de ICSAP
- **Pacote csapAIH**: https://github.com/fulvionedel/csapAIH
- **microdatasus**: https://github.com/rfsaldanha/microdatasus
- **MCP SDK**: https://github.com/modelcontextprotocol/typescript-sdk
