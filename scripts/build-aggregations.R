# =============================================================================
# build-aggregations.R
# Gera os cubos Parquet do sih-br-mcp a partir dos microdados SIH-RD
# redistribuídos em Parquet pelo healthbr-data (espelho do FTP do DATASUS).
# Projeto: sih-br-mcp
#
# CADEIA DE PROVENIÊNCIA (registrada em data/sih_provenance_<ano>.json):
#   Ministério da Saúde / DATASUS (RD<UF><AA><MM>.dbc no FTP)
#     -> healthbr-data (Parquet 1:1, sem transformação; manifesto com hash e
#        data de download de cada .dbc; CC-BY-4.0)
#     -> este script (agrega em três cubos por ano de competência)
#
# USO:
#   source("scripts/build-aggregations.R")
#   build_data(years = 2023, ufs = "RR")           # 1 ano, 1 UF de arquivo
#   build_data(years = 2020:2024, ufs = "all")     # 5 anos, todas as UFs
#   build_data(years = "all", ufs = "all")         # TUDO (demorado)
#
# `ufs` é a UF do ARQUIVO (estabelecimento), como no FTP; a coluna `uf` dos
# cubos é a UF de RESIDÊNCIA (MUNIC_RES). `year`/`month` vêm de DT_INTER
# (data da internação); o arquivo do cubo é o ano de COMPETÊNCIA da AIH e por
# isso contém internações iniciadas no ano anterior.
#
# Acesso ao R2: token público somente-leitura publicado no README do
# healthbr-data; pode ser sobrescrito por HEALTHBR_R2_ACCESS_KEY /
# HEALTHBR_R2_SECRET_KEY / HEALTHBR_R2_ENDPOINT.
# =============================================================================

library(dplyr)
library(tidyr)
library(purrr)
library(arrow)
library(stringr)
library(cli)
library(jsonlite)

# =============================================================================
# CONFIGURACAO
# =============================================================================

OUTPUT_DIR <- here::here("data")
dir.create(OUTPUT_DIR, showWarnings = FALSE, recursive = TRUE)

BUILDER_VERSION <- "2.0.0"

HEALTHBR_BUCKET <- "healthbr-data"
HEALTHBR_PREFIX <- "sih/rd"
HEALTHBR_ENDPOINT <- Sys.getenv("HEALTHBR_R2_ENDPOINT",
  "https://5c499208eebced4e34bd98ffa204f2fb.r2.cloudflarestorage.com")
HEALTHBR_ACCESS_KEY <- Sys.getenv("HEALTHBR_R2_ACCESS_KEY",
  "28c72d4b3e1140fa468e367ae472b522")
HEALTHBR_SECRET_KEY <- Sys.getenv("HEALTHBR_R2_SECRET_KEY",
  "2937b2106736e2ba64e24e92f2be4e6c312bba3355586e41ce634b14c1482951")
HEALTHBR_MANIFEST_URL <- "https://pub-99d9e1a3f5c542178d04efbddf1bba97.r2.dev/sih/rd/manifest.json"
HEALTHBR_REPO_URL <- "https://github.com/SidneyBissoli/healthbr-data"
HEALTHBR_LICENSE <- "CC-BY-4.0"

DATASUS_FTP_DIR <- "ftp://ftp.datasus.gov.br/dissemin/publicos/SIHSUS/200801_/Dados/"

# Colunas cruas do SIH-RD que os cubos usam (projeção na leitura do R2)
COLUNAS_SIH <- c("DT_INTER", "MUNIC_RES", "DIAG_PRINC", "SEXO", "IDADE",
                 "COD_IDADE", "RACA_COR", "DIAS_PERM", "VAL_TOT", "MORTE")

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
#' @param cid Codigo CID-10 (3 ou 4 caracteres, sem ponto)
#' @return Codigo do grupo CSAP (g01-g19) ou NA
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

# =============================================================================
# ACESSO AO HEALTHBR-DATA (R2)
# =============================================================================

.healthbr <- new.env(parent = emptyenv())

healthbr_fs <- function() {
  if (is.null(.healthbr$fs)) {
    .healthbr$fs <- S3FileSystem$create(
      access_key = HEALTHBR_ACCESS_KEY,
      secret_key = HEALTHBR_SECRET_KEY,
      endpoint_override = HEALTHBR_ENDPOINT,
      region = "auto"
    )
  }
  .healthbr$fs
}

#' Manifesto do dataset sih/rd (uma partição por competência x UF de arquivo)
healthbr_manifest <- function() {
  if (is.null(.healthbr$manifest)) {
    cli_alert_info("Baixando manifesto do healthbr-data ({.url {HEALTHBR_MANIFEST_URL}})")
    .healthbr$manifest <- jsonlite::fromJSON(HEALTHBR_MANIFEST_URL, simplifyVector = FALSE)
    n_part <- length(.healthbr$manifest$partitions)
    atualizado <- .healthbr$manifest$last_updated
    cli_alert_success("Manifesto: {.val {n_part}} partições, atualizado em {.val {atualizado}}")
  }
  .healthbr$manifest
}

#' Chaves "AAAA-MM-UF" publicadas para um ano e um conjunto de UFs de arquivo
healthbr_particoes <- function(ano, ufs, manifest) {
  chaves <- names(manifest$partitions)
  padrao <- sprintf("^%d-\\d{2}-(%s)$", ano, paste(ufs, collapse = "|"))
  sort(chaves[grepl(padrao, chaves)])
}

#' Lê as partições (só as colunas dos cubos) e recolhe a proveniência de cada
#' arquivo: rodapé `healthbr` do Parquet + entrada do manifesto.
ler_particoes <- function(chaves, manifest) {
  fs <- healthbr_fs()
  caminhos <- vapply(chaves, function(k) manifest$partitions[[k]]$output_files[[1]]$path, "")
  completos <- paste0(HEALTHBR_BUCKET, "/", caminhos)

  ds <- open_dataset(completos, filesystem = fs, format = "parquet")
  faltam <- setdiff(COLUNAS_SIH, names(ds))
  if (length(faltam) > 0) {
    cli_abort("Colunas ausentes no Parquet do healthbr-data: {paste(faltam, collapse = ', ')}")
  }
  dados <- ds %>% select(all_of(COLUNAS_SIH)) %>% collect()

  particoes <- lapply(seq_along(chaves), function(i) {
    leitor <- ParquetFileReader$create(fs$OpenInputFile(completos[i]))
    rodape <- jsonlite::fromJSON(leitor$GetSchema()$metadata$healthbr, simplifyVector = FALSE)
    entrada <- manifest$partitions[[chaves[i]]]
    saida <- entrada$output_files[[1]]
    if (!is.null(saida$record_count) && saida$record_count != leitor$num_rows) {
      cli_abort("Partição {chaves[i]}: manifesto diz {saida$record_count} linhas, Parquet tem {leitor$num_rows}")
    }
    list(
      partition = chaves[i],
      parquet_path = caminhos[[i]],
      parquet_sha256 = saida$sha256,
      record_count = leitor$num_rows,
      source_file = rodape$source_file,
      source_url = rodape$source_url,
      source_hash_md5 = rodape$source_hash_md5,
      source_size_bytes = rodape$source_size_bytes,
      download_date = rodape$download_date,
      processing_timestamp = entrada$processing_timestamp,
      healthbr_pipeline_version = rodape$pipeline_version,
      healthbr_git_commit = rodape$git_commit
    )
  })

  total_manifesto <- sum(vapply(particoes, function(p) as.numeric(p$record_count), 0))
  if (total_manifesto != nrow(dados)) {
    cli_abort("Soma das partições ({total_manifesto}) difere das linhas lidas ({nrow(dados)})")
  }

  list(dados = dados, particoes = particoes)
}

#' Escreve data/sih_provenance_<ano>.json — o registro de safra do cubo
escrever_sidecar <- function(ano, chaves, particoes, manifest, totais, output_dir) {
  git_commit <- tryCatch(
    trimws(system2("git", c("-C", shQuote(here::here()), "rev-parse", "HEAD"), stdout = TRUE, stderr = FALSE)),
    error = function(e) NA_character_, warning = function(w) NA_character_
  )
  if (length(git_commit) != 1 || is.na(git_commit) || !nzchar(git_commit)) git_commit <- NULL

  datas_download <- vapply(particoes, function(p) p$download_date, "")
  sidecar <- list(
    manifest_version = "1.0.0",
    dataset = HEALTHBR_PREFIX,
    cube_year = ano,
    competencias = I(sort(unique(substr(chaves, 1, 7)))),
    ufs_arquivo = I(sort(unique(substr(chaves, 9, 10)))),
    built_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    builder = list(
      script = "scripts/build-aggregations.R",
      version = BUILDER_VERSION,
      git_commit = git_commit,
      r_version = R.version.string,
      arrow_version = as.character(packageVersion("arrow"))
    ),
    source = list(
      name = "Ministério da Saúde — DATASUS, SIH/SUS (AIH reduzida, RD)",
      agency = "Ministério da Saúde",
      database = "SIH/SUS",
      endpoint = DATASUS_FTP_DIR
    ),
    distributor = list(
      name = "healthbr-data",
      url = HEALTHBR_REPO_URL,
      bucket = sprintf("s3://%s/%s/", HEALTHBR_BUCKET, HEALTHBR_PREFIX),
      manifest_url = HEALTHBR_MANIFEST_URL,
      manifest_last_updated = manifest$last_updated,
      license = HEALTHBR_LICENSE
    ),
    retrieved_at = max(datas_download),
    partitions = particoes,
    totals = totais,
    notes = I(c(
      "year/month derivados de DT_INTER (data da internação); o arquivo do cubo é o ano de competência da AIH e contém internações iniciadas no ano anterior.",
      "uf dos cubos = UF de residência (MUNIC_RES); ufs_arquivo = UF do estabelecimento (nome do arquivo RD no FTP).",
      "retrieved_at = data de download mais recente, no healthbr-data, dos .dbc que alimentaram este cubo (extração no upstream)."
    ))
  )
  destino <- file.path(output_dir, sprintf("sih_provenance_%d.json", ano))
  jsonlite::write_json(sidecar, destino, auto_unbox = TRUE, pretty = TRUE, null = "null", digits = NA)
  cli_alert_success("  sih_provenance_{ano}.json: {.val {length(particoes)}} partições, retrieved_at {.val {sidecar$retrieved_at}}")
  invisible(destino)
}

#' Processa dados de um ano de competência
processar_ano <- function(ano, ufs_arquivo, output_dir) {

  cli_h2("Ano {ano}")

  tryCatch({
    manifest <- healthbr_manifest()
    chaves <- healthbr_particoes(ano, ufs_arquivo, manifest)
    esperadas <- length(ufs_arquivo) * 12
    if (length(chaves) == 0) {
      cli_alert_warning("Sem partições publicadas para {ano} / {paste(ufs_arquivo, collapse=', ')}")
      return(NULL)
    }
    if (length(chaves) < esperadas) {
      cli_alert_warning("{length(chaves)} de {esperadas} partições publicadas para {ano} (competências ainda não divulgadas pelo MS ficam de fora)")
    }

    cli_alert_info("Lendo {length(chaves)} partições do R2 (colunas: {paste(COLUNAS_SIH, collapse=', ')})")
    t0 <- Sys.time()
    lido <- ler_particoes(chaves, manifest)
    dados <- lido$dados
    cli_alert_success("{.val {format(nrow(dados), big.mark='.')}} registros lidos em {format(round(Sys.time() - t0, 1))}")

    # Processa variaveis (colunas cruas do DATASUS, todas string no healthbr)
    cli_alert_info("Processando variaveis...")

    n_lidos <- nrow(dados)
    dados <- dados %>%
      dplyr::mutate(dt_inter = as.Date(DT_INTER, format = "%Y%m%d"))
    n_invalidos <- sum(is.na(dados$dt_inter))
    if (n_invalidos > 0) {
      cli_alert_warning("{n_invalidos} registros com DT_INTER inválido ficam fora dos cubos")
      dados <- dados %>% dplyr::filter(!is.na(dt_inter))
    }

    dados <- dados %>%
      dplyr::mutate(
        ano = as.integer(format(dt_inter, "%Y")),
        mes = as.integer(format(dt_inter, "%m")),
        ano_mes = sprintf("%04d-%02d", ano, mes),
        uf_codigo = substr(MUNIC_RES, 1, 2),
        uf = uf_codigo_para_sigla(uf_codigo),
        municipio_res = MUNIC_RES,
        cid = substr(DIAG_PRINC, 1, 3),
        cid_4 = substr(DIAG_PRINC, 1, 4),
        capitulo_cid = map_int(cid, extrair_capitulo_cid),
        sexo = dplyr::case_when(
          SEXO == "1" ~ "M",
          SEXO == "3" ~ "F",
          TRUE ~ "I"
        ),
        # IDADE SIMPLES (em anos completos)
        idade = dplyr::case_when(
          COD_IDADE == "2" ~ as.integer(floor(as.numeric(IDADE) / 12)),
          COD_IDADE == "3" ~ 0L,  # dias -> 0 anos
          COD_IDADE == "4" ~ as.integer(IDADE),
          COD_IDADE == "5" ~ as.integer(as.numeric(IDADE) + 100),
          TRUE ~ NA_integer_
        ),
        raca = dplyr::case_when(
          RACA_COR == "01" ~ "branca",
          RACA_COR == "02" ~ "preta",
          RACA_COR == "03" ~ "parda",
          RACA_COR == "04" ~ "amarela",
          RACA_COR == "05" ~ "indigena",
          TRUE ~ "ignorado"
        ),
        dias = as.numeric(DIAS_PERM),
        valor = as.numeric(VAL_TOT),
        obito = as.integer(MORTE == "1")
      )

    # Classifica ICSAP
    cli_alert_info("Classificando ICSAP...")

    dados <- dados %>%
      dplyr::mutate(
        grupo_csap = classificar_csap_vec(cid_4),
        is_csap = !is.na(grupo_csap)
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
        cid_chapter = capitulo_cid,
        cid_group = cid,
        sex = sexo,
        age = idade,
        race = raca,
        is_csap,
        csap_group = grupo_csap
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

    # =========================================================================
    # SIDECAR DE PROVENIÊNCIA
    # =========================================================================

    escrever_sidecar(
      ano, chaves, lido$particoes, manifest,
      totais = list(
        records_read = n_lidos,
        records_invalid_dt_inter = n_invalidos,
        causas_rows = nrow(cubo_causas),
        series_rows = nrow(cubo_series),
        icsap_rows = nrow(cubo_icsap)
      ),
      output_dir = output_dir
    )

    # Limpa memoria
    rm(dados, lido, cubo_causas, cubo_series, totais, icsap, cubo_icsap)
    gc()

    cli_alert_success("Ano {ano} concluido!")

    return(TRUE)

  }, error = function(e) {
    cli_alert_danger("Erro ao processar ano {ano}: {e$message}")
    return(FALSE)
  })
}

# =============================================================================
# FUNCAO PRINCIPAL: build_data()
# =============================================================================

#' Gera cubos de dados Parquet a partir do SIH-SUS
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
build_data <- function(years, ufs) {

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

  # Alerta para processamento completo
  if (length(years) > 20 && length(ufs) == 27) {
    cli_alert_warning("Voce solicitou processar {length(years)} anos e TODAS as 27 UFs.")
    cli_alert_warning("Isso le todas as particoes do R2 (colunas projetadas) e pode levar horas.")
    resposta <- readline(prompt = "Deseja continuar? (S/N): ")
    if (!toupper(resposta) %in% c("S", "SIM", "Y", "YES")) {
      cli_alert_info("Operacao cancelada pelo usuario.")
      return(invisible(NULL))
    }
  }

  # Cabecalho
  cli_h1("SIH-BR-MCP: Geracao de Cubos de Dados")
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

  cli_h1("PROCESSAMENTO CONCLUIDO!")
  cli_alert_success("Anos processados com sucesso: {.val {sucessos}}")
  if (falhas > 0) {
    cli_alert_warning("Anos com falha: {.val {falhas}}")
  }
  cli_alert_info("Arquivos salvos em: {.path {OUTPUT_DIR}}")

  return(invisible(resultados))
}

# =============================================================================
# MENSAGEM AO CARREGAR
# =============================================================================

cli_alert_info("Script build-aggregations.R carregado (origem: healthbr-data, s3://{HEALTHBR_BUCKET}/{HEALTHBR_PREFIX}/).")
cli_alert_info("Use: build_data(years = ..., ufs = ...)")
cli_alert_info("Exemplos:")
cli_bullets(c(
  " " = "build_data(years = 2023, ufs = 'RR')",
  " " = "build_data(years = 2020:2024, ufs = 'all')",
  " " = "build_data(years = 'all', ufs = 'all')  # TUDO"
))
