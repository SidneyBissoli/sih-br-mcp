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
# FUNCOES AUXILIARES
# =============================================================================

#' Extrai capitulo CID-10 do codigo
extrair_capitulo_cid <- function(cid) {
  if (is.na(cid) || nchar(cid) < 1) return(NA_integer_)

  letra <- toupper(substr(cid, 1, 1))
  num <- suppressWarnings(as.integer(substr(cid, 2, 3)))
  if (is.na(num)) num <- 0

  capitulo <- dplyr::case_when(
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

#' Classifica codigo CID-10 como CSAP
#' Baseado na Portaria MS/SAS 221/2008
classificar_csap <- function(cid) {
  if (is.na(cid) || cid == "") return(NA_character_)

  cid <- toupper(trimws(cid))
  cid3 <- substr(cid, 1, 3)
  cid4 <- substr(cid, 1, 4)

  # g01: Doencas preveniveis por imunizacao
  g01_prefixos <- c("A33", "A34", "A35", "A36", "A37", "A95", "B05", "B06",
                    "B16", "B26", "A19", "A15", "A16", "A18", "I00", "I01",
                    "I02", "A51", "A52", "A53", "B50", "B51", "B52", "B53",
                    "B54", "B77")
  g01_especificos <- c("G000", "A170", "A171", "A178", "A179")
  if (cid3 %in% g01_prefixos || cid4 %in% g01_especificos) return("g01")

  # g02: Gastroenterites infecciosas
  g02_prefixos <- c("E86", "A00", "A01", "A02", "A03", "A04", "A05", "A06",
                    "A07", "A08", "A09")
  if (cid3 %in% g02_prefixos) return("g02")

  # g03: Anemia
  if (cid3 == "D50") return("g03")

  # g04: Deficiencias nutricionais
  g04_prefixos <- c("E40", "E41", "E42", "E43", "E44", "E45", "E46", "E50",
                    "E51", "E52", "E53", "E54", "E55", "E56", "E58", "E59",
                    "E60", "E61", "E63", "E64")
  if (cid3 %in% g04_prefixos) return("g04")

  # g05: Infeccoes de ouvido, nariz e garganta
  g05_prefixos <- c("H66", "J00", "J01", "J02", "J03", "J06", "J31")
  if (cid3 %in% g05_prefixos) return("g05")

  # g06: Pneumonias bacterianas
  g06_prefixos <- c("J13", "J14")
  g06_especificos <- c("J153", "J154", "J158", "J159", "J181")
  if (cid3 %in% g06_prefixos || cid4 %in% g06_especificos) return("g06")

  # g07: Asma
  g07_prefixos <- c("J45", "J46")
  if (cid3 %in% g07_prefixos) return("g07")

  # g08: Doencas pulmonares
  g08_prefixos <- c("J20", "J21", "J40", "J41", "J42", "J43", "J44", "J47")
  if (cid3 %in% g08_prefixos) return("g08")

  # g09: Hipertensao
  g09_prefixos <- c("I10", "I11")
  if (cid3 %in% g09_prefixos) return("g09")

  # g10: Angina
  if (cid3 == "I20") return("g10")

  # g11: Insuficiencia cardiaca
  g11_prefixos <- c("I50", "J81")
  if (cid3 %in% g11_prefixos) return("g11")

  # g12: Doencas cerebrovasculares
  g12_prefixos <- c("I63", "I64", "I65", "I66", "I67", "I69", "G45", "G46")
  if (cid3 %in% g12_prefixos) return("g12")

  # g13: Diabetes mellitus
  g13_prefixos <- c("E10", "E11", "E12", "E13", "E14")
  if (cid3 %in% g13_prefixos) return("g13")

  # g14: Epilepsias
  g14_prefixos <- c("G40", "G41")
  if (cid3 %in% g14_prefixos) return("g14")

  # g15: Infeccao no rim e trato urinario
  g15_prefixos <- c("N10", "N11", "N12", "N30", "N34")
  g15_especificos <- c("N390")
  if (cid3 %in% g15_prefixos || cid4 %in% g15_especificos) return("g15")

  # g16: Infeccao da pele e tecido subcutaneo
  g16_prefixos <- c("A46", "L01", "L02", "L03", "L04", "L08")
  if (cid3 %in% g16_prefixos) return("g16")

  # g17: Doenca inflamatoria dos orgaos pelvicos femininos
  g17_prefixos <- c("N70", "N71", "N72", "N73", "N75", "N76")
  if (cid3 %in% g17_prefixos) return("g17")

  # g18: Ulcera gastrointestinal
  g18_prefixos <- c("K25", "K26", "K27", "K28")
  g18_especificos <- c("K920", "K921", "K922")
  if (cid3 %in% g18_prefixos || cid4 %in% g18_especificos) return("g18")

  # g19: Doencas relacionadas ao pre-natal e parto
  g19_prefixos <- c("O23", "A50")
  g19_especificos <- c("P350")
  if (cid3 %in% g19_prefixos || cid4 %in% g19_especificos) return("g19")

  return(NA_character_)
}

#' Classifica vetor de CIDs como CSAP (vetorizado)
classificar_csap_vec <- Vectorize(classificar_csap)

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
      dplyr::mutate(
        ano = as.integer(substr(DT_INTER, 1, 4)),
        mes = as.integer(substr(DT_INTER, 5, 6)),
        ano_mes = sprintf("%04d-%02d", ano, mes),
        uf = uf_codigo_para_sigla(substr(MUNIC_RES, 1, 2)),
        municipio_res = MUNIC_RES,
        sexo = dplyr::case_when(
          SEXO == "Masculino" ~ "M",
          SEXO == "Feminino" ~ "F",
          TRUE ~ "I"
        ),
        # IDADE SIMPLES (em anos completos) - process_sih() ja converte para anos
        idade = as.integer(IDADE),
        raca = dplyr::case_when(
          RACA_COR == "Branca" ~ "branca",
          RACA_COR == "Preta" ~ "preta",
          RACA_COR == "Parda" ~ "parda",
          RACA_COR == "Amarela" ~ "amarela",
          RACA_COR == "Indigena" ~ "indigena",
          TRUE ~ "ignorado"
        ),
        diag_princ = DIAG_PRINC,
        dias = as.integer(DIAS_PERM),
        valor = as.numeric(VAL_TOT),
        obito = as.integer(MORTE == "Sim")
      )

    # Classifica CSAP
    cli_alert_info("Classificando ICSAP...")
    dados <- dados %>%
      dplyr::mutate(
        grupo_csap = classificar_csap_vec(diag_princ),
        is_csap = !is.na(grupo_csap),
        capitulo_cid = sapply(diag_princ, extrair_capitulo_cid)
      )

    # =========================================================================
    # CUBO 1: sih_causas_{ano}.parquet
    # =========================================================================

    cli_alert_info("Gerando cubo sih_causas_{ano}.parquet...")

    cubo_causas <- dados %>%
      dplyr::group_by(
        year = ano,
        month = mes,
        uf,
        municipality_code = municipio_res,
        cid_chapter = capitulo_cid,
        cid_group = substr(diag_princ, 1, 3),
        is_csap,
        csap_group = grupo_csap,
        sex = sexo,
        age = idade,
        race = raca
      ) %>%
      dplyr::summarise(
        n = dplyr::n(),
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
      dplyr::group_by(
        year_month = ano_mes,
        uf,
        cid_chapter = capitulo_cid
      ) %>%
      dplyr::summarise(
        n = dplyr::n(),
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
      dplyr::group_by(
        year = ano,
        uf,
        municipality_code = municipio_res,
        sex = sexo,
        age = idade,
        race = raca
      ) %>%
      dplyr::summarise(
        n_total = dplyr::n(),
        .groups = "drop"
      )

    # ICSAP por grupo
    icsap <- dados %>%
      dplyr::filter(is_csap) %>%
      dplyr::group_by(
        year = ano,
        uf,
        municipality_code = municipio_res,
        csap_group = grupo_csap,
        sex = sexo,
        age = idade,
        race = raca
      ) %>%
      dplyr::summarise(
        n = dplyr::n(),
        days = sum(dias, na.rm = TRUE),
        value = sum(valor, na.rm = TRUE),
        deaths = sum(obito, na.rm = TRUE),
        .groups = "drop"
      )

    # Junta com totais
    cubo_icsap <- icsap %>%
      dplyr::left_join(
        totais,
        by = c("year", "uf", "municipality_code", "sex", "age", "race")
      )

    write_parquet(cubo_icsap, file.path(output_dir, sprintf("sih_icsap_%d.parquet", ano)))
    cli_alert_success("  sih_icsap_{ano}.parquet: {.val {format(nrow(cubo_icsap), big.mark='.')}} linhas")

    # Estatisticas de validacao
    total_internacoes <- sum(cubo_causas$n)
    total_icsap <- sum(cubo_causas$n[cubo_causas$is_csap])
    pct_icsap <- round(total_icsap / total_internacoes * 100, 2)

    cli_alert_info("Validacao: {.val {format(total_internacoes, big.mark='.')}} internacoes, {.val {pct_icsap}}% ICSAP")

    # Distribuicao de idade
    idade_min <- min(cubo_causas$age, na.rm = TRUE)
    idade_max <- max(cubo_causas$age, na.rm = TRUE)
    cli_alert_info("Idade: min={.val {idade_min}}, max={.val {idade_max}}")

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
#' @param years Anos para processar
#' @param ufs UFs para processar
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
  " " = "test_data(years = 2024, ufs = 'AC')              # Teste minimo",
  " " = "test_data(years = 2023:2024, ufs = c('AC', 'RR'))  # Teste rapido",
  " " = "test_data(years = 2024, ufs = 'SP')                # Teste com UF grande"
))
