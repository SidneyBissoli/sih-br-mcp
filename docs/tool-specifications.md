# SIH-BR MCP - Especificações das Ferramentas

## Visão Geral

O MCP SIH-BR fornece acesso aos dados do Sistema de Informações Hospitalares do SUS, com foco especial em Internações por Condições Sensíveis à Atenção Primária (ICSAP).

**Período de dados:** 1998-2024 (27 anos em CID-10)  
**Cobertura:** Brasil, 27 UFs, 5.570 municípios

---

## 1. FERRAMENTAS DE INTERNAÇÕES GERAIS

### 1.1 `get_hospitalizations`

Consulta internações hospitalares com filtros flexíveis.

```typescript
interface GetHospitalizationsParams {
  // Filtros temporais
  year?: number | number[];           // Ex: 2023 ou [2020, 2021, 2022]
  month?: number | number[];          // 1-12
  
  // Filtros geográficos
  uf?: string | string[];             // Sigla UF: "SP", ["SP", "RJ"]
  municipality_code?: string;         // Código IBGE 6 dígitos
  region?: string;                    // "N", "NE", "SE", "S", "CO"
  
  // Filtros clínicos
  cid_chapter?: number | number[];    // Capítulo CID-10: 1-22
  cid_group?: string;                 // Grupo CID-10: "J45", "I10"
  
  // Filtros demográficos
  sex?: "M" | "F" | "I";
  age?: number | [number, number];    // Idade exata ou range [min, max]
  age_group?: string | string[];      // Faixa etária calculada: "0-4", "5-14", etc.
  race?: string | string[];           // "branca", "preta", "parda", "amarela", "indigena", "ignorado"
  
  // Agregação
  group_by?: ("year" | "month" | "uf" | "cid_chapter" | "sex" | "age" | "age_group" | "race")[];
  
  // Métricas
  metrics?: ("count" | "days" | "value" | "deaths" | "mortality_rate")[];
}

interface GetHospitalizationsResponse {
  data: {
    [groupKey: string]: any;           // Chaves dinâmicas conforme group_by
    n_hospitalizations: number;
    total_days?: number;
    total_value?: number;
    deaths?: number;
    hospital_mortality_rate?: number;  // deaths/hospitalizations * 100
  }[];
  metadata: {
    total_records: number;
    filters_applied: object;
    period: { start: string; end: string };
  };
}
```

**Notas sobre idade:**
- Os dados armazenam idade simples em anos completos (0-100+)
- Use `age` para filtrar por idade exata ou range: `age: 65` ou `age: [60, 79]`
- Use `age_group` para filtrar por faixas predefinidas (calculadas dinamicamente)
- Use `group_by: ["age_group"]` para agrupar em faixas etárias

**Exemplos de uso:**
- Internações por capítulo CID em SP, 2023: `get_hospitalizations({ year: 2023, uf: "SP", group_by: ["cid_chapter"] })`
- Série temporal por sexo: `get_hospitalizations({ year: [2019,2020,2021,2022,2023], group_by: ["year", "sex"] })`
- Idosos (60+) por UF: `get_hospitalizations({ year: 2023, age: [60, 120], group_by: ["uf"] })`

---

### 1.2 `get_hospitalization_trends`

Análise de séries temporais de internações.

```typescript
interface GetHospitalizationTrendsParams {
  // Período
  start_year: number;
  end_year: number;
  granularity?: "monthly" | "yearly";  // default: yearly
  
  // Filtros (mesmos de get_hospitalizations)
  uf?: string | string[];
  cid_chapter?: number | number[];
  sex?: "M" | "F" | "I";
  age?: number | [number, number];
  age_group?: string | string[];
  race?: string | string[];
  
  // Comparação
  compare_by?: "uf" | "cid_chapter" | "sex" | "age_group" | "race";
  
  // Cálculos adicionais
  include_variation?: boolean;         // Variação percentual período a período
  include_moving_average?: boolean;    // Média móvel (3 períodos)
}

interface GetHospitalizationTrendsResponse {
  series: {
    period: string;                    // "2023" ou "2023-01"
    [compareKey: string]?: any;        // Se compare_by definido
    n_hospitalizations: number;
    variation_pct?: number;
    moving_average?: number;
  }[];
  summary: {
    total_hospitalizations: number;
    avg_per_period: number;
    trend: "increasing" | "decreasing" | "stable";
    change_pct: number;                // Primeiro vs último período
  };
}
```

---

### 1.3 `get_hospitalization_rates`

Calcula taxas de internação (por população).

```typescript
interface GetHospitalizationRatesParams {
  year: number | number[];
  
  // Tipo de taxa
  rate_type: "crude" | "age_adjusted" | "specific";
  rate_per?: number;                   // default: 10000
  
  // Filtros geográficos
  uf?: string | string[];
  municipality_code?: string;
  
  // Filtros clínicos
  cid_chapter?: number | number[];
  
  // Para taxas específicas
  age?: number | [number, number];
  age_group?: string | string[];
  sex?: "M" | "F" | "I";
  race?: string | string[];
  
  // Agregação
  group_by?: ("year" | "uf" | "sex" | "age_group" | "race")[];
}

interface GetHospitalizationRatesResponse {
  data: {
    [groupKey: string]: any;
    n_hospitalizations: number;
    population: number;
    rate: number;                      // por rate_per habitantes
    rate_ci_lower?: number;            // IC 95%
    rate_ci_upper?: number;
  }[];
  metadata: {
    rate_type: string;
    rate_per: number;
    population_source: string;
  };
}
```

---

### 1.4 `compare_regions`

Comparação e ranking entre regiões/UFs.

```typescript
interface CompareRegionsParams {
  year: number | number[];
  
  // Nível de comparação
  level: "region" | "uf" | "municipality";
  
  // Filtros (opcional)
  region?: string;                     // Filtrar municípios de uma região
  uf?: string;                         // Filtrar municípios de uma UF
  
  // Métrica para ranking
  metric: "count" | "rate" | "mortality_rate" | "avg_stay" | "avg_value";
  
  // Filtros clínicos
  cid_chapter?: number | number[];
  
  // Ordenação
  order?: "asc" | "desc";              // default: desc
  limit?: number;                      // default: 10
}

interface CompareRegionsResponse {
  ranking: {
    rank: number;
    code: string;
    name: string;
    metric_value: number;
    n_hospitalizations: number;
  }[];
  statistics: {
    mean: number;
    median: number;
    std_dev: number;
    min: number;
    max: number;
  };
}
```

---

## 2. FERRAMENTAS ICSAP

### 2.1 `get_icsap`

Consulta de Internações por Condições Sensíveis à Atenção Primária.

```typescript
interface GetIcsapParams {
  // Filtros temporais
  year?: number | number[];
  month?: number | number[];
  
  // Filtros geográficos
  uf?: string | string[];
  municipality_code?: string;
  region?: string;
  
  // Filtros CSAP
  csap_group?: string | string[];      // "g01"-"g19" (grupos da Portaria 221)
  
  // Filtros demográficos
  sex?: "M" | "F" | "I";
  age?: number | [number, number];
  age_group?: string | string[];
  race?: string | string[];
  
  // Agregação
  group_by?: ("year" | "month" | "uf" | "csap_group" | "sex" | "age_group" | "race")[];
  
  // Métricas
  include_non_csap?: boolean;          // Incluir não-CSAP para comparação
}

interface GetIcsapResponse {
  data: {
    [groupKey: string]: any;
    n_icsap: number;
    n_total?: number;                  // Se include_non_csap
    pct_icsap?: number;                // n_icsap / n_total * 100
    total_days: number;
    total_value: number;
    deaths: number;
  }[];
  metadata: {
    total_icsap: number;
    period: { start: string; end: string };
    csap_list_version: "Portaria MS/SAS 221/2008";
  };
}
```

---

### 2.2 `get_icsap_indicators`

Calcula os indicadores principais de ICSAP.

```typescript
interface GetIcsapIndicatorsParams {
  year: number | number[];
  
  // Filtros geográficos
  uf?: string | string[];
  municipality_code?: string;
  
  // Filtros demográficos
  sex?: "M" | "F" | "I";
  age?: number | [number, number];
  age_group?: string | string[];
  race?: string | string[];
  
  // Indicadores desejados
  indicators?: ("percentage" | "rate_per_10k" | "rate_per_100k" | "all")[];
  
  // Agregação
  group_by?: ("year" | "uf" | "sex" | "age_group" | "race")[];
}

interface GetIcsapIndicatorsResponse {
  data: {
    [groupKey: string]: any;
    n_icsap: number;
    n_total_hospitalizations: number;
    population: number;
    
    // Indicadores
    icsap_percentage: number;          // (ICSAP / Total) * 100
    icsap_rate_per_10k?: number;       // (ICSAP / Pop) * 10.000
    icsap_rate_per_100k?: number;      // (ICSAP / Pop) * 100.000
  }[];
  metadata: {
    population_source: string;
    population_year: number;
    indicators_calculated: string[];
  };
}
```

---

### 2.3 `compare_icsap_trends`

Análise temporal comparativa de ICSAP.

```typescript
interface CompareIcsapTrendsParams {
  start_year: number;
  end_year: number;
  granularity?: "monthly" | "yearly";
  
  // Comparar por
  compare_by?: "uf" | "region" | "csap_group" | "age_group" | "race";
  compare_values?: string[] | number[];  // Valores específicos para comparar
  
  // Indicador para análise
  indicator: "percentage" | "rate_per_10k" | "count";
  
  // Cálculos
  include_trend_line?: boolean;        // Regressão linear
  include_annual_variation?: boolean;
}

interface CompareIcsapTrendsResponse {
  series: {
    period: string;
    [compareKey: string]: number | string;
  }[];
  trends?: {
    [compareKey: string]: {
      slope: number;                   // Inclinação da reta
      r_squared: number;               // R²
      direction: "increasing" | "decreasing" | "stable";
      avg_annual_change: number;       // Variação média anual
    };
  };
  summary: {
    overall_change_pct: number;
    best_performer?: string;
    worst_performer?: string;
  };
}
```

---

### 2.4 `rank_csap_groups`

Ranking dos 19 grupos de CSAP.

```typescript
interface RankCsapGroupsParams {
  year: number | number[];
  
  // Filtros
  uf?: string | string[];
  sex?: "M" | "F" | "I";
  age?: number | [number, number];
  age_group?: string | string[];
  
  // Métrica para ranking
  metric: "count" | "percentage" | "rate" | "mortality_rate" | "avg_stay" | "avg_value";
  
  // Ordenação
  order?: "asc" | "desc";
  limit?: number;                      // default: 19 (todos)
}

interface RankCsapGroupsResponse {
  ranking: {
    rank: number;
    csap_group: string;                // "g01", "g02", etc.
    csap_group_name: string;
    metric_value: number;
    n_hospitalizations: number;
    pct_of_total_icsap: number;
  }[];
  total_icsap: number;
  concentration: {
    top3_pct: number;                  // % acumulado dos 3 primeiros
    top5_pct: number;
  };
}
```

---

### 2.5 `classify_as_csap`

Classifica códigos CID-10 como CSAP ou não.

```typescript
interface ClassifyAsCsapParams {
  cid_codes: string[];                 // Lista de códigos CID-10 (3 ou 4 caracteres)
}

interface ClassifyAsCsapResponse {
  classifications: {
    cid_code: string;
    is_csap: boolean;
    csap_group?: string;               // "g01"-"g19", null se não for CSAP
    csap_group_name?: string;
    diagnosis_name?: string;           // Nome do diagnóstico na lista
  }[];
  summary: {
    total_codes: number;
    csap_count: number;
    non_csap_count: number;
  };
}
```

---

## 3. FERRAMENTAS DE METADADOS

### 3.1 `list_csap_groups`

Lista os 19 grupos da Lista Brasileira de CSAP.

```typescript
interface ListCsapGroupsParams {
  language?: "pt" | "en";              // default: pt
  include_cid_codes?: boolean;         // default: false
}

interface ListCsapGroupsResponse {
  groups: {
    id: number;
    code: string;                      // "g01", "g02", etc.
    name: string;
    cid_codes?: string[];              // Se include_cid_codes
    n_diagnoses: number;
  }[];
  metadata: {
    source: "Portaria MS/SAS 221/2008";
    total_groups: 19;
    language: string;
  };
}
```

---

### 3.2 `list_cid_chapters`

Lista os capítulos da CID-10 com dados disponíveis.

```typescript
interface ListCidChaptersParams {
  include_statistics?: boolean;        // Incluir contagem de internações
  year?: number;                       // Ano para estatísticas
}

interface ListCidChaptersResponse {
  chapters: {
    id: number;                        // 1-22
    code: string;                      // "I", "II", ..., "XXII"
    name_pt: string;
    name_en: string;
    cid_range: string;                 // "A00-B99"
    n_hospitalizations?: number;       // Se include_statistics
    pct_total?: number;
  }[];
}
```

---

### 3.3 `get_available_years`

Retorna os anos disponíveis nos dados.

```typescript
interface GetAvailableYearsResponse {
  years: number[];                     // [1998, 1999, ..., 2024]
  data_range: {
    first_year: number;
    last_year: number;
    total_years: number;
  };
  note: string;
  // Frescor dos cubos frente ao espelho healthbr-data (src/freshness.ts, 0.5.0):
  // checado em segundo plano na inicialização; `pending` até o veredito.
  freshness: {
    status: "current" | "stale" | "unknown" | "pending" | "disabled";
    checked_at: string | null;
    method: "range" | "full" | null;  // sonda de 512 bytes bastou, ou baixou o manifesto
    manifest_url: string | null;
    manifest_last_updated_local: string | null;   // manifesto com que os cubos foram gerados (sidecar)
    manifest_last_updated_remote: string | null;  // manifesto público agora
    cubes: {
      cube_year: number;
      reedited: string[];       // .dbc reeditado pelo MS (MD5/tamanho mudou)
      reprocessed: string[];    // Parquet regenerado no espelho (SHA-256 mudou)
      removed: string[];        // partição sumiu do manifesto
      new_in_window: string[];  // competência da janela publicada depois do build
      behind: boolean;
    }[];
    error: string | null;
  };
}
```

---

### 3.4 `get_data_dictionary`

Dicionário de variáveis do SIH-SUS.

```typescript
interface GetDataDictionaryParams {
  variable?: string;                   // Nome da variável específica
  category?: "identification" | "demographic" | "clinical" | "financial" | "outcome";
}

interface GetDataDictionaryResponse {
  variables: {
    name: string;
    description_pt: string;
    description_en: string;
    type: "numeric" | "categorical" | "date" | "text";
    source_field: string;              // Nome no arquivo RD
    valid_values?: { value: any; label: string }[];
    notes?: string;
  }[];
}
```

---

## Estrutura de Dados (Parquet)

### Cubo 1: `sih_causas_{ano}.parquet`

Agregação principal por causas e demografia.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int | Ano |
| month | int | Mês (1-12) |
| uf | string | Sigla UF |
| municipality_code | string | Código IBGE 6 dígitos |
| cid_chapter | int | Capítulo CID-10 (1-22) |
| cid_group | string | Grupo CID-10 (3 caracteres, ex: "J45") |
| sex | string | "M", "F" ou "I" |
| age | int | Idade em anos completos (0-100+) |
| race | string | Raça/cor |
| is_csap | bool | É ICSAP |
| csap_group | string | Grupo CSAP ("g01"-"g19", null se não CSAP) |
| n | int | Contagem de internações |
| days | int | Soma de dias de internação |
| value | double | Soma do valor total (R$) |
| deaths | int | Contagem de óbitos |

**Estimativa:** 5-10 MB/ano → 135-270 MB total

### Cubo 2: `sih_series_{ano}.parquet`

Série temporal simplificada.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year_month | string | "YYYY-MM" (ex: "2023-01") |
| uf | string | Sigla UF |
| cid_chapter | int | Capítulo CID-10 (1-22) |
| n | int | Contagem de internações |
| deaths | int | Contagem de óbitos |

**Estimativa:** <1 MB/ano

### Cubo 3: `sih_icsap_{ano}.parquet`

Dados específicos de ICSAP.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int | Ano |
| uf | string | Sigla UF |
| municipality_code | string | Código IBGE 6 dígitos |
| csap_group | string | Grupo CSAP ("g01"-"g19") |
| sex | string | "M", "F" ou "I" |
| age | int | Idade em anos completos (0-100+) |
| race | string | Raça/cor |
| n | int | Contagem de ICSAP |
| n_total | int | Total de internações no estrato (CSAP + não-CSAP) |
| days | int | Soma de dias de internação |
| value | double | Soma do valor total (R$) |
| deaths | int | Contagem de óbitos |

**Estimativa:** 3-8 MB/ano

### Dados auxiliares

#### `populacao_municipios.parquet`

Estimativas populacionais do pacote csapAIH.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int | Ano |
| municipality_code | string | Código IBGE |
| sex | string | "M" ou "F" |
| age_group | string | Faixa etária |
| population | int | População |

---

## Notas de Implementação

### Idade

Os cubos armazenam **idade simples em anos completos** (0, 1, 2, ... 100+), não faixas etárias.

As ferramentas MCP podem:
- Filtrar por idade exata: `age: 65`
- Filtrar por range: `age: [60, 79]` (60 a 79 anos)
- Agrupar em faixas etárias padrão: `group_by: ["age_group"]`

**Faixas etárias padrão** (calculadas dinamicamente):
```
"0-4", "5-9", "10-14", "15-19", "20-29", "30-39", 
"40-49", "50-59", "60-69", "70-79", "80+"
```

### Raça/Cor

| Valor | Descrição |
|-------|-----------|
| branca | Branca |
| preta | Preta |
| parda | Parda |
| amarela | Amarela |
| indigena | Indígena |
| ignorado | Não informado / Ignorado |

**Nota:** Variável disponível consistentemente a partir de ~2008. Anos anteriores podem ter alta proporção de "ignorado".

### Grupos CSAP

Os 19 grupos seguem a **Portaria MS/SAS 221/2008**:

| Código | Nome |
|--------|------|
| g01 | Doenças preveníveis por imunização |
| g02 | Gastroenterites infecciosas e complicações |
| g03 | Anemia |
| g04 | Deficiências nutricionais |
| g05 | Infecções de ouvido, nariz e garganta |
| g06 | Pneumonias bacterianas |
| g07 | Asma |
| g08 | Doenças pulmonares |
| g09 | Hipertensão |
| g10 | Angina |
| g11 | Insuficiência cardíaca |
| g12 | Doenças cerebrovasculares |
| g13 | Diabetes mellitus |
| g14 | Epilepsias |
| g15 | Infecção no rim e trato urinário |
| g16 | Infecção da pele e tecido subcutâneo |
| g17 | Doença inflamatória de órgãos pélvicos femininos |
| g18 | Úlcera gastrointestinal |
| g19 | Doenças relacionadas ao pré-natal e parto |

### Capítulos CID-10

Os capítulos são identificados por número inteiro (1-22):

| ID | Código | Nome | Range CID |
|----|--------|------|-----------|
| 1 | I | Doenças infecciosas e parasitárias | A00-B99 |
| 2 | II | Neoplasias | C00-D48 |
| 3 | III | Doenças do sangue | D50-D89 |
| 4 | IV | Doenças endócrinas, nutricionais e metabólicas | E00-E90 |
| 5 | V | Transtornos mentais e comportamentais | F00-F99 |
| 6 | VI | Doenças do sistema nervoso | G00-G99 |
| 7 | VII | Doenças do olho | H00-H59 |
| 8 | VIII | Doenças do ouvido | H60-H95 |
| 9 | IX | Doenças do aparelho circulatório | I00-I99 |
| 10 | X | Doenças do aparelho respiratório | J00-J99 |
| 11 | XI | Doenças do aparelho digestivo | K00-K93 |
| 12 | XII | Doenças da pele | L00-L99 |
| 13 | XIII | Doenças do sistema osteomuscular | M00-M99 |
| 14 | XIV | Doenças do aparelho geniturinário | N00-N99 |
| 15 | XV | Gravidez, parto e puerpério | O00-O99 |
| 16 | XVI | Afecções originadas no período perinatal | P00-P96 |
| 17 | XVII | Malformações congênitas | Q00-Q99 |
| 18 | XVIII | Sintomas e sinais anormais | R00-R99 |
| 19 | XIX | Lesões e causas externas | S00-T98 |
| 20 | XX | Causas externas de morbidade | V01-Y98 |
| 21 | XXI | Fatores que influenciam o estado de saúde | Z00-Z99 |
| 22 | XXII | Códigos para propósitos especiais | U00-U99 |

### Códigos de Região

| Código | Nome | UFs |
|--------|------|-----|
| N | Norte | AC, AM, AP, PA, RO, RR, TO |
| NE | Nordeste | AL, BA, CE, MA, PB, PE, PI, RN, SE |
| SE | Sudeste | ES, MG, RJ, SP |
| S | Sul | PR, RS, SC |
| CO | Centro-Oeste | DF, GO, MS, MT |

### Tratamento de Partos

As internações por parto (CID-10 O80-O84) são **excluídas** do cálculo de ICSAP, seguindo a metodologia padrão.

### Referências

- Portaria MS/SAS nº 221, de 17 de abril de 2008
- Alfradique et al. (2009) - Projeto ICSAP-Brasil
- Pacote csapAIH (Nedel, 2017; 2019)
