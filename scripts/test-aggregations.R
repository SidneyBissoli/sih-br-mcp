# =============================================================================
# test-aggregations.R
# Script de TESTE - Gera cubos Parquet em data/test/
# Projeto: sih-br-mcp
#
# USO:
#   source("scripts/test-aggregations.R")
#   test_data(years = 2023:2024, ufs = c("AC", "RR"))  # Teste rapido
#   test_data(years = 2024, ufs = "SP")                # Teste com UF grande
#
# FINALIDADE:
#   - Validar que o codigo funciona corretamente
#   - Testar apos mudancas no codigo do MCP
#   - NAO e para gerar dados de producao (use build-aggregations.R para isso)
# =============================================================================

library(dplyr)
library(tidyr)
library(purrr)
library(arrow)
library(microdatasus)
library(csapAIH)
library(stringr)
library(cli)

# =============================================================================
# CONFIGURACAO - PASTA DE TESTE
# =============================================================================

OUTPUT_DIR <- here::here("data", "test")
dir.create(OUTPUT_DIR, showWarnings = FALSE, recursive = TRUE)

# Todas as UFs brasileiras
ALL_UFS <- c("AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
             "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
             "RS", "RO", "RR", "SC", "SP", "SE", "TO")

# Ano inicial (CID-10 implementado em jan/1998)
FIRST_YEAR <- 1998

# =============================================================================
# FUNCOES AUXILIARES (identicas ao build-aggregations.R)
# =============================================================================

#' Cria faixas etarias padronizadas
criar_faixa_etaria <- function(idade) {
  breaks <- c(-Inf, 1, 5, 10, 15, 20, 30, 40, 50, 60, 70, 80, Inf)
  labels <- c("<1", "1-4", "5-9", "10-14", "15-19", "20-29", "30-39",
              "40-49", "50-59", "60-69", "70-79", "80+")
  cut(idade, breaks = breaks, labels = labels, right = FALSE)
}

#' Extrai capitulo CID-10 do codigo
extrair_capitulo_cid <- function(cid) {
  if (is.na(cid) || nchar(cid) < 1) return(NA_integer_)

  letra <- toupper(substr(cid, 1, 1))
  num <- suppressWarnings(as.integer(substr(cid, 2, 3)))
  if (is.na(num)) num <- 0

  capitulo <- case_when(
    letra %in% c("A", "B") ~ 1L,
    letra == "C" | (letra == "D" & num <= 48) ~ 2L,
    letra == "D" & num >= 50 ~ 3L,
    letra == "E" ~ 4L,
    letra == "F" ~ 5L,
    letra == "G" ~ 6L,
    letra == "H" & num <= 59 ~ 7L,
    letra == "H" & num >= 60 ~ 8L,
    letra == "I" ~ 9L,
    letra == "J" ~ 10L,
    letra == "K" ~ 11L,
    letra == "L" ~ 12L,
    letra == "M" ~ 13L,
    letra == "N" ~ 14L,
    letra == "O" ~ 15L,
    letra == "P" ~ 16L,
    letra == "Q" ~ 17L,
    letra == "R" ~ 18L,
    letra %in% c("S", "T") ~ 19L,
    letra %in% c("V", "W", "X", "Y") ~ 20L,
    letra == "Z" ~ 21L,
    letra == "U" ~ 22L,
    TRUE ~ NA_integer_
  )

  return(capitulo)
}

#' Mapa de codigo UF para sigla
uf_codigo_para_sigla <- function(codigo) {
  uf_map <- c(
    "11" = "RO", "12" = "AC", "13" = "AM", "14" = "RR", "15" = "PA",
    "16" = "AP", "17" = "TO", "21" = "MA", "22" = "PI", "23" = "CE",
    "24" = "RN", "25" = "PB", "26" = "PE", "27" = "AL", "28" = "SE",
    "29" = "BA", "31" = "MG", "32" = "ES", "33" = "RJ", "35" = "SP",
    "41" = "PR", "42" = "SC", "43" = "RS", "50" = "MS", "51" = "MT",
    "52" = "GO", "53" = "DF"
  )
  uf_map[codigo]
}

#' Processa dados de um ano especifico
processar_ano <- function(ano, ufs_para_baixar, output_dir) {

  cli_h2("Ano {ano}")

  tryCatch({
    # Download dos dados
    cli_alert_info("Baixando dados do DATASUS para UF(s): {paste(ufs_para_baixar, collapse=', ')}")

    dados <- fetch_datasus(
      year_start = ano,
      year_end = ano,
      month_start = 1,
      month_end = 12,
      uf = ufs_para_baixar,
      information_system = "SIH-RD"
    )

    if (is.null(dados) || nrow(dados) == 0) {
      cli_alert_warning("Sem dados para o ano {ano}")
      return(NULL)
    }

    cli_alert_success("{.val {format(nrow(dados), big.mark='.')}} registros baixados")

    # Processa variaveis
    cli_alert_info("Processando variaveis...")

    dados <- dados %>%
      process_sih() %>%
      mutate(
        ano = as.integer(substr(DT_INTER, 1, 4)),
        mes = as.integer(substr(DT_INTER, 5, 6)),
        ano_mes = paste0(ano, "-", sprintf("%02d", mes)),
        uf_codigo = substr(MUNIC_RES, 1, 2),
        uf = uf_codigo_para_sigla(uf_codigo),
        municipio_res = MUNIC_RES,
        cid = substr(DIAG_PRINC, 1, 3),
        cid_4 = substr(DIAG_PRINC, 1, 4),
        capitulo_cid = map_int(cid, extrair_capitulo_cid),
        sexo = case_when(
          SEXO == "1" ~ "M",
          SEXO == "3" ~ "F",
          TRUE ~ "I"
        ),
        idade_anos = case_when(
          COD_IDADE == "2" ~ as.numeric(IDADE) / 12,
          COD_IDADE == "3" ~ as.numeric(IDADE) / 365,
          COD_IDADE == "4" ~ as.numeric(IDADE),
          COD_IDADE == "5" ~ as.numeric(IDADE) + 100,
          TRUE ~ NA_real_
        ),
        faixa_etaria = criar_faixa_etaria(floor(idade_anos)),
        raca = case_when(
          RACA_COR == "01" ~ "Branca",
          RACA_COR == "02" ~ "Preta",
          RACA_COR == "03" ~ "Parda",
          RACA_COR == "04" ~ "Amarela",
          RACA_COR == "05" ~ "Indigena",
          TRUE ~ "Ignorado"
        ),
        dias = as.numeric(DIAS_PERM),
        valor = as.numeric(VAL_TOT),
        obito = as.integer(MORTE == 1)
      )

    # Classifica ICSAP
    cli_alert_info("Classificando ICSAP...")

    dados <- dados %>%
      mutate(
        csap_result = csapAIH::csap(cid_4, session = FALSE),
        is_csap = !is.na(csap_result) & csap_result != "",
        grupo_csap = ifelse(is_csap, csap_result, NA_character_)
      )

    # =========================================================================
    # CUBO 1: sih_causas_{ano}.parquet
    # =========================================================================

    cli_alert_info("Gerando cubo sih_causas_{ano}.parquet...")

    cubo_causas <- dados %>%
      group_by(
        year = ano,
        month = mes,
        uf,
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

    write_parquet(cubo_causas, file.path(output_dir, sprintf("sih_causas_%d.parquet", ano)))
    cli_alert_success("  sih_causas_{ano}.parquet: {.val {format(nrow(cubo_causas), big.mark='.')}} linhas")

    # =========================================================================
    # CUBO 2: sih_series_{ano}.parquet
    # =========================================================================

    cli_alert_info("Gerando cubo sih_series_{ano}.parquet...")

    cubo_series <- dados %>%
      group_by(
        year_month = ano_mes,
        uf,
        cid_chapter = capitulo_cid
      ) %>%
      summarise(
        n = n(),
        deaths = sum(obito, na.rm = TRUE),
        .groups = "drop"
      )

    write_parquet(cubo_series, file.path(output_dir, sprintf("sih_series_%d.parquet", ano)))
    cli_alert_success("  sih_series_{ano}.parquet: {.val {format(nrow(cubo_series), big.mark='.')}} linhas")

    # =========================================================================
    # CUBO 3: sih_icsap_{ano}.parquet
    # =========================================================================

    cli_alert_info("Gerando cubo sih_icsap_{ano}.parquet...")

    # Total de internacoes por estrato
    totais <- dados %>%
      group_by(
        year = ano,
        uf,
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
    icsap <- dados %>%
      filter(is_csap) %>%
      group_by(
        year = ano,
        uf,
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

    write_parquet(cubo_icsap, file.path(output_dir, sprintf("sih_icsap_%d.parquet", ano)))
    cli_alert_success("  sih_icsap_{ano}.parquet: {.val {format(nrow(cubo_icsap), big.mark='.')}} linhas")

    # Estatisticas de validacao
    total_internacoes <- sum(cubo_causas$n)
    total_icsap <- sum(cubo_causas$n[cubo_causas$is_csap])
    pct_icsap <- round(total_icsap / total_internacoes * 100, 2)

    cli_alert_info("Validacao: {.val {format(total_internacoes, big.mark='.')}} internacoes, {.val {pct_icsap}}% ICSAP")

    # Limpa memoria
    rm(dados, cubo_causas, cubo_series, totais, icsap, cubo_icsap)
    gc()

    cli_alert_success("Ano {ano} concluido!")

    return(TRUE)

  }, error = function(e) {
    cli_alert_danger("Erro ao processar ano {ano}: {e$message}")
    return(FALSE)
  })
}

# =============================================================================
# FUNCAO PRINCIPAL: test_data()
# =============================================================================

#' Gera cubos de dados Parquet de TESTE a partir do SIH-SUS
#'
#' @param years Anos para processar. Pode ser:
#'   - Um ano: 2023
#'   - Vetor de anos: c(2020, 2022, 2024)
#'   - Sequencia: 2020:2024
#'   - "all" para todos os anos (1998 ate ano atual)
#'
#' @param ufs UFs para processar. Pode ser:
#'   - Uma UF: "SP"
#'   - Vetor de UFs: c("SP", "RJ", "AC")
#'   - "all" para todas as 27 UFs
#'
#' @examples
#' test_data(years = 2023:2024, ufs = c("AC", "RR"))  # Teste rapido
#' test_data(years = 2024, ufs = "SP")                # Teste com UF grande
#'
test_data <- function(years, ufs) {

  # Valida e expande parametro years
  if (identical(years, "all")) {
    ano_atual <- as.integer(format(Sys.Date(), "%Y"))
    years <- FIRST_YEAR:ano_atual
  } else {
    years <- as.integer(years)
    if (any(is.na(years))) {
      cli_abort("Parametro 'years' invalido. Use um numero, vetor ou 'all'.")
    }
  }

  # Valida e expande parametro ufs
  if (identical(ufs, "all")) {
    ufs <- ALL_UFS
  } else {
    ufs <- toupper(ufs)
    ufs_invalidas <- setdiff(ufs, ALL_UFS)
    if (length(ufs_invalidas) > 0) {
      cli_abort("UF(s) invalida(s): {paste(ufs_invalidas, collapse=', ')}")
    }
  }

  # Cabecalho

  cli_h1("SIH-BR-MCP: TESTE de Geracao de Cubos")
  cli_alert_warning("MODO DE TESTE - Arquivos serao salvos em data/test/")
  cli_alert_info("Anos: {.val {paste(range(years), collapse=' a ')}} ({length(years)} anos)")
  cli_alert_info("UFs: {.val {if(length(ufs)==27) 'TODAS (27)' else paste(ufs, collapse=', ')}}")
  cli_alert_info("Diretorio de saida: {.path {OUTPUT_DIR}}")
  cli_rule()

  # Processa cada ano
  resultados <- list()
  total_anos <- length(years)

  for (i in seq_along(years)) {
    ano <- years[i]
    cli_h1("Processando ano {ano} ({i}/{total_anos})")

    resultado <- processar_ano(ano, ufs, OUTPUT_DIR)
    resultados[[as.character(ano)]] <- resultado
  }

  # Gera dados populacionais de teste
  cli_h1("Gerando dados populacionais (teste)")

  pop <- csapAIH::popbr2000_2021 %>%
    filter(ano >= min(years)) %>%
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
  cli_alert_success("populacao_municipios.parquet: {.val {format(nrow(pop), big.mark='.')}} linhas")

  # Resumo final
  sucessos <- sum(unlist(resultados), na.rm = TRUE)
  falhas <- sum(!unlist(resultados), na.rm = TRUE)

  cli_h1("TESTE CONCLUIDO!")
  cli_alert_success("Anos processados com sucesso: {.val {sucessos}}")
  if (falhas > 0) {
    cli_alert_warning("Anos com falha: {.val {falhas}}")
  }
  cli_alert_info("Arquivos de TESTE salvos em: {.path {OUTPUT_DIR}}")
  cli_text("")
  cli_alert_warning("Lembre-se: estes sao dados de TESTE.")
  cli_alert_info("Para dados de producao, use: source('scripts/build-aggregations.R')")

  return(invisible(resultados))
}

# =============================================================================
# MENSAGEM AO CARREGAR
# =============================================================================

cli_alert_info("Script test-aggregations.R carregado.")
cli_alert_warning("MODO DE TESTE - Arquivos serao salvos em data/test/")
cli_alert_info("Use: test_data(years = ..., ufs = ...)")
cli_alert_info("Exemplos:")
cli_bullets(c(
  " " = "test_data(years = 2023:2024, ufs = c('AC', 'RR'))  # Teste rapido",
  " " = "test_data(years = 2024, ufs = 'SP')                # Teste com UF grande"
))
