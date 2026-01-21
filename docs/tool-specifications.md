# SIH-BR MCP - Especificações das Ferramentas

## Visão Geral

O MCP SIH-BR fornece acesso aos dados do Sistema de Informações Hospitalares do SUS, com foco especial em Internações por Condições Sensíveis à Atenção Primária (ICSAP).

**Período de dados:** 1998-2024 (26 anos em CID-10)
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
  municipality_code?: string;         // Código IBGE 7 dígitos
  region?: string;                    // "N", "NE", "SE", "S", "CO"
  
  // Filtros clínicos
  cid_chapter?: string | string[];    // Capítulo CID-10: "IX", "X"
  cid_group?: string;                 // Grupo CID-10: "J40-J47"
  cid_code?: string;                  // Código específico: "J45"
  
  // Filtros demográficos
  sex?: "M" | "F";
  age_group?: string | string[];      // "0-4", "5-14", "15-24", etc.
  race?: string | string[];           // "branca", "preta", "parda", "amarela", "indigena", "ignorado"
  
  // Agregação
  group_by?: ("year" | "month" | "uf" | "cid_chapter" | "sex" | "age_group" | "race")[];
  
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

**Exemplos de uso:**
- Internações por capítulo CID em SP, 2023: `get_hospitalizations({ year: 2023, uf: "SP", group_by: ["cid_chapter"] })`
- Série temporal por sexo: `get_hospitalizations({ year: [2019,2020,2021,2022,2023], group_by: ["year", "sex"] })`

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
  cid_chapter?: string | string[];
  sex?: "M" | "F";
  age_group?: string | string[];
  race?: string | string[];           // "branca", "preta", "parda", "amarela", "indigena", "ignorado"
  
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
  cid_chapter?: string | string[];
  
  // Para taxas específicas
  age_group?: string | string[];
  sex?: "M" | "F";
  race?: string | string[];           // "branca", "preta", "parda", "amarela", "indigena", "ignorado"
  
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
  cid_chapter?: string | string[];
  
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
  csap_group?: number | number[];      // 1-19 (grupos da Portaria 221)
  
  // Filtros demográficos
  sex?: "M" | "F";
  age_group?: string | string[];
  race?: string | string[];           // "branca", "preta", "parda", "amarela", "indigena", "ignorado"
  
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
  sex?: "M" | "F";
  age_group?: string | string[];
  race?: string | string[];           // "branca", "preta", "parda", "amarela", "indigena", "ignorado"
  
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
  sex?: "M" | "F";
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
    csap_group_id: number;
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
  cid_codes: string[];                 // Lista de códigos CID-10
}

interface ClassifyAsCsapResponse {
  classifications: {
    cid_code: string;
    is_csap: boolean;
    csap_group_id?: number;            // null se não for CSAP
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
    code: string;                      // "I", "II", ..., "XXII"
    roman: string;
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
  update_info: {
    last_update: string;               // ISO date
    next_expected_update: string;
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

### Cubo 1: `sih_causas.parquet`
Agregação principal por causas e demografia.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int16 | Ano |
| month | int8 | Mês (1-12) |
| uf | string | Sigla UF |
| cid_chapter | string | Capítulo CID-10 |
| cid_group | string | Grupo CID-10 |
| sex | string | "M" ou "F" |
| age_group | string | Faixa etária |
| race | string | Raça/cor: "branca", "preta", "parda", "amarela", "indigena", "ignorado" |
| is_csap | bool | É ICSAP |
| csap_group | int8 | Grupo CSAP (1-19, null se não CSAP) |
| n | int32 | Contagem |
| days | int32 | Dias de internação |
| value | float64 | Valor total (R$) |
| deaths | int32 | Óbitos |

**Estimativa:** 3-8 MB/ano → 80-210 MB total

### Cubo 2: `sih_series.parquet`
Série temporal simplificada.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year_month | string | "2023-01" |
| uf | string | Sigla UF |
| cid_chapter | string | Capítulo CID-10 |
| n | int32 | Contagem |
| deaths | int32 | Óbitos |

### Cubo 3: `sih_icsap.parquet`
Dados específicos de ICSAP.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int16 | Ano |
| uf | string | Sigla UF |
| municipality_code | string | Código IBGE 7 dígitos |
| csap_group | int8 | Grupo CSAP (1-19) |
| sex | string | "M" ou "F" |
| age_group | string | Faixa etária |
| race | string | Raça/cor: "branca", "preta", "parda", "amarela", "indigena", "ignorado" |
| n | int32 | Contagem ICSAP |
| n_total | int32 | Total internações (CSAP + não-CSAP) |
| days | int32 | Dias de internação |
| value | float64 | Valor total (R$) |
| deaths | int32 | Óbitos |

### Dados auxiliares

#### `populacao_municipios.parquet`
Estimativas populacionais do pacote csapAIH.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int16 | Ano |
| municipality_code | string | Código IBGE |
| sex | string | "M" ou "F" |
| age_group | string | Faixa etária |
| population | int32 | População |

---

## Notas de Implementação

### Faixas Etárias Padrão
```
"0-4", "5-9", "10-14", "15-19", "20-24", "25-29", "30-34", 
"35-39", "40-44", "45-49", "50-54", "55-59", "60-64", 
"65-69", "70-74", "75-79", "80+"
```

### Raça/Cor (RACA_COR)
| Código SIH | Valor |
|------------|-------|
| 01 | branca |
| 02 | preta |
| 03 | parda |
| 04 | amarela |
| 05 | indigena |
| 99 / vazio | ignorado |

**Nota:** Variável disponível consistentemente a partir de ~2008. Anos anteriores podem ter alta proporção de "ignorado".

### Códigos de Região
- N: Norte
- NE: Nordeste
- SE: Sudeste
- S: Sul
- CO: Centro-Oeste

### UFs por Região
```json
{
  "N": ["AC", "AM", "AP", "PA", "RO", "RR", "TO"],
  "NE": ["AL", "BA", "CE", "MA", "PB", "PE", "PI", "RN", "SE"],
  "SE": ["ES", "MG", "RJ", "SP"],
  "S": ["PR", "RS", "SC"],
  "CO": ["DF", "GO", "MS", "MT"]
}
```

### Tratamento de Partos
As internações por parto (CID-10 O80-O84) são **excluídas** do cálculo de ICSAP, seguindo a metodologia padrão.

### Referências
- Portaria MS/SAS nº 221, de 17 de abril de 2008
- Alfradique et al. (2009) - Projeto ICSAP-Brasil
- Pacote csapAIH (Nedel, 2017; 2019)
