# =============================================================================
# build-aggregations.R
# Script para processar dados do SIH-SUS e gerar cubos de dados em Parquet
# Projeto: sih-br-mcp
# =============================================================================

# Carrega bibliotecas necessárias
library(dplyr)
library(tidyr)
library(purrr)
library(arrow)
library(microdatasus)
library(csapAIH)
library(lubridate)
library(stringr)

# =============================================================================
# CONFIGURAÇÃO
# =============================================================================

# Diretório de saída para arquivos Parquet
OUTPUT_DIR <- here::here("data")
dir.create(OUTPUT_DIR, showWarnings = FALSE, recursive = TRUE)

# Anos para processar (CID-10 implementado em jan/1998)
ANOS <- 1998:2024

# UFs brasileiras
UFS <- c("AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
         "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
         "RS", "RO", "RR", "SC", "SP", "SE", "TO")

# =============================================================================
# FUNÇÕES AUXILIARES
# =============================================================================

#' Cria faixas etárias padronizadas
#' @param idade Idade em anos
#' @return Faixa etária como fator ordenado
criar_faixa_etaria <- function(idade) {
  breaks <- c(-Inf, 0, 1, 5, 10, 15, 20, 30, 40, 50, 60, 70, 80, Inf)
  labels <- c("<1", "1-4", "5-9", "10-14", "15-19", "20-29", "30-39",
              "40-49", "50-59", "60-69", "70-79", "80+")
  cut(idade, breaks = breaks, labels = labels, right = FALSE)
}

#' Extrai capítulo CID-10 do código
#' @param cid Código CID-10 (ex: "J18", "A09")
#' @return Número do capítulo (1-22)
extrair_capitulo_cid <- function(cid) {
  if (is.na(cid) || nchar(cid) < 1) return(NA_integer_)

  letra <- toupper(substr(cid, 1, 1))
  num <- as.integer(substr(cid, 2, 3))

  # Mapeamento letra -> capítulos possíveis
  capitulos <- case_when(
    letra == "A" | letra == "B" ~ 1L,                    # I. Infecciosas
    letra == "C" | (letra == "D" & num <= 48) ~ 2L,      # II. Neoplasias
    letra == "D" & num >= 50 ~ 3L,                       # III. Sangue
    letra == "E" ~ 4L,                                   # IV. Endócrinas
    letra == "F" ~ 5L,                                   # V. Mentais
    letra == "G" ~ 6L,                                   # VI. Sistema nervoso
    letra == "H" & num <= 59 ~ 7L,                       # VII. Olho
    letra == "H" & num >= 60 ~ 8L,                       # VIII. Ouvido
    letra == "I" ~ 9L,                                   # IX. Circulatório
    letra == "J" ~ 10L,                                  # X. Respiratório
    letra == "K" ~ 11L,                                  # XI. Digestivo
    letra == "L" ~ 12L,                                  # XII. Pele
    letra == "M" ~ 13L,                                  # XIII. Osteomuscular
    letra == "N" ~ 14L,                                  # XIV. Geniturinário
    letra == "O" ~ 15L,                                  # XV. Gravidez
    letra == "P" ~ 16L,                                  # XVI. Perinatal
    letra == "Q" ~ 17L,                                  # XVII. Malformações
    letra == "R" ~ 18L,                                  # XVIII. Sintomas
    letra == "S" | letra == "T" ~ 19L,                   # XIX. Lesões
    letra == "V" | letra == "W" | letra == "X" | letra == "Y" ~ 20L, # XX. Causas externas
    letra == "Z" ~ 21L,                                  # XXI. Contato com serviços
    letra == "U" ~ 22L,                                  # XXII. Propósitos especiais
    TRUE ~ NA_integer_
  )

  return(capitulos)
}

#' Processa dados de um ano específico
#' @param ano Ano para processar
#' @return Data frame processado ou NULL se falhar
processar_ano <- function(ano) {
  message(sprintf("\n=== Processando ano %d ===", ano))

  tryCatch({
    # Download dos dados RD (AIH reduzida) via microdatasus
    message("  Baixando dados...")
    dados <- fetch_datasus(
      year_start = ano,
      year_end = ano,
      month_start = 1,
      month_end = 12,
      uf = "all",
      information_system = "SIH-RD"
    )

    if (is.null(dados) || nrow(dados) == 0) {
      warning(sprintf("Sem dados para o ano %d", ano))
      return(NULL)
    }

    message(sprintf("  %d registros baixados", nrow(dados)))

    # Processa variáveis básicas
    message("  Processando variáveis...")
    dados <- dados %>%
      process_sih() %>%
      mutate(
        # Ano e mês da competência
        ano = as.integer(substr(DT_INTER, 1, 4)),
        mes = as.integer(substr(DT_INTER, 5, 6)),
        ano_mes = paste0(ano, "-", sprintf("%02d", mes)),

        # UF de residência
        uf = substr(MUNIC_RES, 1, 2),

        # Município de residência (código IBGE 6 dígitos)
        municipio_res = MUNIC_RES,

        # CID principal (3 caracteres)
        cid = substr(DIAG_PRINC, 1, 3),
        cid_4 = substr(DIAG_PRINC, 1, 4),

        # Capítulo CID-10
        capitulo_cid = map_int(cid, extrair_capitulo_cid),

        # Sexo
        sexo = case_when(
          SEXO == "1" ~ "M",
          SEXO == "3" ~ "F",
          TRUE ~ "I"
        ),

        # Idade em anos
        idade_anos = case_when(
          COD_IDADE == "2" ~ as.numeric(IDADE) / 12,  # meses
          COD_IDADE == "3" ~ as.numeric(IDADE) / 365, # dias
          COD_IDADE == "4" ~ as.numeric(IDADE),       # anos
          COD_IDADE == "5" ~ as.numeric(IDADE) + 100, # >100 anos
          TRUE ~ NA_real_
        ),

        # Faixa etária
        faixa_etaria = criar_faixa_etaria(floor(idade_anos)),

        # Raça/cor (disponível a partir de ~2008)
        raca = case_when(
          RACA_COR == "01" ~ "Branca",
          RACA_COR == "02" ~ "Preta",
          RACA_COR == "03" ~ "Parda",
          RACA_COR == "04" ~ "Amarela",
          RACA_COR == "05" ~ "Indígena",
          TRUE ~ "Ignorado"
        ),

        # Dias de internação
        dias = as.numeric(DIAS_PERM),

        # Valor total
        valor = as.numeric(VAL_TOT),

        # Óbito (1 = óbito)
        obito = as.integer(MORTE == 1)
      )

    # Classifica ICSAP usando csapAIH
    message("  Classificando ICSAP...")
    dados <- dados %>%
      mutate(
        csap_result = csapAIH::csap(cid_4, session = FALSE),
        is_csap = !is.na(csap_result) & csap_result != "",
        grupo_csap = ifelse(is_csap, csap_result, NA_character_)
      )

    # Converte código UF para sigla
    uf_map <- c(
      "11" = "RO", "12" = "AC", "13" = "AM", "14" = "RR", "15" = "PA",
      "16" = "AP", "17" = "TO", "21" = "MA", "22" = "PI", "23" = "CE",
      "24" = "RN", "25" = "PB", "26" = "PE", "27" = "AL", "28" = "SE",
      "29" = "BA", "31" = "MG", "32" = "ES", "33" = "RJ", "35" = "SP",
      "41" = "PR", "42" = "SC", "43" = "RS", "50" = "MS", "51" = "MT",
      "52" = "GO", "53" = "DF"
    )

    dados <- dados %>%
      mutate(uf_sigla = uf_map[uf])

    message(sprintf("  Processamento concluído: %d registros", nrow(dados)))

    return(dados)

  }, error = function(e) {
    warning(sprintf("Erro ao processar ano %d: %s", ano, e$message))
    return(NULL)
  })
}

# =============================================================================
# PROCESSAMENTO PRINCIPAL
# =============================================================================

message("============================================")
message("SIH-BR-MCP: Geração de Cubos de Dados")
message("============================================")
message(sprintf("Período: %d-%d", min(ANOS), max(ANOS)))
message(sprintf("Diretório de saída: %s", OUTPUT_DIR))
message("============================================\n")

# Processa todos os anos
dados_completos <- map(ANOS, processar_ano) %>%
  compact() %>%
  bind_rows()

message(sprintf("\n=== Total de registros: %d ===\n", nrow(dados_completos)))

# =============================================================================
# CUBO 1: sih_causas.parquet
# Agregação por causas com todas as dimensões
# =============================================================================

message("Gerando Cubo 1: sih_causas.parquet...")

cubo_causas <- dados_completos %>%
  group_by(
    year = ano,
    month = mes,
    uf = uf_sigla,
    cid_chapter = capitulo_cid,
    cid_group = cid,
    sex = sexo,
    age_group = faixa_etaria,
    race = raca,
    is_csap,
    csap_group = grupo_csap
  ) %>%
  summarise(
    n = n(),
    days = sum(dias, na.rm = TRUE),
    value = sum(valor, na.rm = TRUE),
    deaths = sum(obito, na.rm = TRUE),
    .groups = "drop"
  )

write_parquet(cubo_causas, file.path(OUTPUT_DIR, "sih_causas.parquet"))
message(sprintf("  Salvo: %d linhas", nrow(cubo_causas)))

# =============================================================================
# CUBO 2: sih_series.parquet
# Série temporal mensal simplificada
# =============================================================================

message("Gerando Cubo 2: sih_series.parquet...")

cubo_series <- dados_completos %>%
  group_by(
    year_month = ano_mes,
    uf = uf_sigla,
    cid_chapter = capitulo_cid
  ) %>%
  summarise(
    n = n(),
    deaths = sum(obito, na.rm = TRUE),
    .groups = "drop"
  )

write_parquet(cubo_series, file.path(OUTPUT_DIR, "sih_series.parquet"))
message(sprintf("  Salvo: %d linhas", nrow(cubo_series)))

# =============================================================================
# CUBO 3: sih_icsap.parquet
# Foco em ICSAP com granularidade municipal
# =============================================================================

message("Gerando Cubo 3: sih_icsap.parquet...")

# Primeiro, total de internações por estrato
totais <- dados_completos %>%
  group_by(
    year = ano,
    uf = uf_sigla,
    municipality_code = municipio_res,
    sex = sexo,
    age_group = faixa_etaria,
    race = raca
  ) %>%
  summarise(
    n_total = n(),
    .groups = "drop"
  )

# ICSAP por grupo
icsap <- dados_completos %>%
  filter(is_csap) %>%
  group_by(
    year = ano,
    uf = uf_sigla,
    municipality_code = municipio_res,
    csap_group = grupo_csap,
    sex = sexo,
    age_group = faixa_etaria,
    race = raca
  ) %>%
  summarise(
    n = n(),
    days = sum(dias, na.rm = TRUE),
    value = sum(valor, na.rm = TRUE),
    deaths = sum(obito, na.rm = TRUE),
    .groups = "drop"
  )

# Junta com totais
cubo_icsap <- icsap %>%
  left_join(
    totais,
    by = c("year", "uf", "municipality_code", "sex", "age_group", "race")
  )

write_parquet(cubo_icsap, file.path(OUTPUT_DIR, "sih_icsap.parquet"))
message(sprintf("  Salvo: %d linhas", nrow(cubo_icsap)))

# =============================================================================
# DADOS POPULACIONAIS
# =============================================================================

message("Gerando dados populacionais...")

# Usa dados do pacote csapAIH
pop <- csapAIH::popbr2000_2021 %>%
  select(
    year = ano,
    municipality_code = mun,
    sex = sexo,
    age_group = fxetar5,
    population = pop
  ) %>%
  mutate(
    sex = case_when(
      sex == "masc" ~ "M",
      sex == "fem" ~ "F",
      TRUE ~ "I"
    ),
    age_group = case_when(
      age_group == "0a4" ~ "0-4",
      age_group == "5a9" ~ "5-9",
      age_group == "10a14" ~ "10-14",
      age_group == "15a19" ~ "15-19",
      age_group == "20a24" ~ "20-24",
      age_group == "25a29" ~ "25-29",
      age_group == "30a34" ~ "30-34",
      age_group == "35a39" ~ "35-39",
      age_group == "40a44" ~ "40-44",
      age_group == "45a49" ~ "45-49",
      age_group == "50a54" ~ "50-54",
      age_group == "55a59" ~ "55-59",
      age_group == "60a64" ~ "60-64",
      age_group == "65a69" ~ "65-69",
      age_group == "70a74" ~ "70-74",
      age_group == "75a79" ~ "75-79",
      age_group == "80+" ~ "80+",
      TRUE ~ age_group
    )
  )

write_parquet(pop, file.path(OUTPUT_DIR, "populacao_municipios.parquet"))
message(sprintf("  Salvo: %d linhas", nrow(pop)))

# =============================================================================
# RESUMO FINAL
# =============================================================================

message("\n============================================")
message("PROCESSAMENTO CONCLUÍDO!")
message("============================================")
message(sprintf("Arquivos gerados em: %s", OUTPUT_DIR))
message("")
message("Cubos de dados:")
message(sprintf("  - sih_causas.parquet: %d linhas", nrow(cubo_causas)))
message(sprintf("  - sih_series.parquet: %d linhas", nrow(cubo_series)))
message(sprintf("  - sih_icsap.parquet: %d linhas", nrow(cubo_icsap)))
message(sprintf("  - populacao_municipios.parquet: %d linhas", nrow(pop)))
message("============================================")
