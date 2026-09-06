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
# cubos é a UF de RESIDÊNCIA (MUNIC_RES).
#
# JANELA DE COMPETÊNCIAS (decidida nos dados em 2026-09-05, ver
# docs/analise-001-janela-competencia.md): o cubo do ano Y contém as
# internações com DT_INTER em Y, lidas das competências Y-01..Y-12 e dos
# MESES_SEGUINTES primeiros meses de Y+1. Com 4 meses: 99,7–99,9% das
# internações do ano (dezembro 99,3–99,7%) em todas as UFs; o que falta é
# reapresentação tardia difusa, que nem +12 meses recupera. O cubo de Y fica
# FECHADO quando a competência (Y+1)-04 é publicada: partições posteriores não
# o alteram, só reedições dentro da janela.
#
# Acesso ao R2: pelo pacote healthbR (>= 0.3.1.9000, dev de 2026-09-05):
# `healthbR::sih_status()` diz quais partições existem e de que .dbc vieram;
# `healthbR::sih_data(source = "r2", lazy = TRUE)` abre o espelho como dataset
# arrow remoto, com a projeção das 10 colunas empurrada para o Parquet. O token
# público somente-leitura vive no pacote; outro bucket entra por
# `r2_credentials` (ver ?healthbR::sih_data). Este script não tem código S3
# próprio desde a v2.2.0.
# =============================================================================

library(dplyr)
library(tidyr)
library(purrr)
library(arrow)      # write_parquet dos cubos
library(stringr)
library(cli)
library(jsonlite)

if (!requireNamespace("healthbR", quietly = TRUE) ||
    !exists("sih_status", asNamespace("healthbR"))) {
  stop(paste(
    "Este script precisa do healthbR com sih_status() (versao dev >= 2026-09-05).",
    "Instale com: devtools::install('C:/dev/r-packages/healthbR', upgrade = FALSE)"
  ), call. = FALSE)
}

# =============================================================================
# CONFIGURACAO
# =============================================================================

OUTPUT_DIR <- here::here("data")
dir.create(OUTPUT_DIR, showWarnings = FALSE, recursive = TRUE)

BUILDER_VERSION <- "2.3.1"

# Meses de Y+1 lidos para fechar as internações de Y (ver cabeçalho)
MESES_SEGUINTES <- 4L

# Identidade do distribuidor, registrada no sidecar (o acesso é do healthbR)
HEALTHBR_BUCKET <- "healthbr-data"
HEALTHBR_PREFIX <- "sih/rd"
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

#' Mapa de codigo UF para sigla. `unname()` porque `uf_map[codigo]` devolve
#' vetor NOMEADO (um nome por linha) e o arrow grava atributos de R nos
#' metadados do Parquet: o cubo de causas de 5 UFs carregava 5,5 MB de
#' metadado só de nomes (1,5 MB depois de tirar o Vectorize; ~0 depois disto).
#' Medido em 2026-09-06. O conteúdo das colunas não muda.
uf_codigo_para_sigla <- function(codigo) {
  uf_map <- c(
    "11" = "RO", "12" = "AC", "13" = "AM", "14" = "RR", "15" = "PA",
    "16" = "AP", "17" = "TO", "21" = "MA", "22" = "PI", "23" = "CE",
    "24" = "RN", "25" = "PB", "26" = "PE", "27" = "AL", "28" = "SE",
    "29" = "BA", "31" = "MG", "32" = "ES", "33" = "RJ", "35" = "SP",
    "41" = "PR", "42" = "SC", "43" = "RS", "50" = "MS", "51" = "MT",
    "52" = "GO", "53" = "DF"
  )
  unname(uf_map[codigo])
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

#' Aplica uma função escalar a um vetor PELOS VALORES ÚNICOS e espalha o
#' resultado de volta (match). extrair_capitulo_cid() e classificar_csap()
#' custam milissegundos por chamada (case_when e uma cadeia de %in% por
#' elemento); linha a linha, 393 mil internações levavam mais de 10 minutos e
#' um ano nacional (~14 milhões) levaria horas — enquanto os CIDs distintos
#' num ano são poucos milhares. Medido em 2026-09-06 (build 2.2.1). O
#' resultado é idêntico ao de map_int/Vectorize: mesma função, mesmos valores.
por_valor_unico <- function(x, f, tipo) {
  u <- unique(x)
  v <- unname(vapply(u, f, tipo, USE.NAMES = FALSE))
  v[match(x, u)]
}

# =============================================================================
# ACESSO AO HEALTHBR-DATA (via healthbR)
# =============================================================================

.healthbr <- new.env(parent = emptyenv())

#' Estado do espelho: uma linha por partição publicada (competência x UF de
#' arquivo), com o .dbc de origem, o Parquet gerado e a versão do pipeline.
#' `attr(, "last_updated")` é a data do manifesto. Memorizado por sessão.
healthbr_status <- function() {
  if (is.null(.healthbr$status)) {
    cli_alert_info("Lendo o manifesto do healthbr-data pelo healthbR ({.fn healthbR::sih_status})")
    st <- healthbR::sih_status()
    precisa <- c("year", "month", "uf", "records", "processing_timestamp",
                 "source_url", "source_hash_md5", "source_size_bytes",
                 "parquet_path", "parquet_sha256", "pipeline_version", "git_commit")
    faltam <- setdiff(precisa, names(st))
    if (nrow(st) == 0 || length(faltam) > 0) {
      cli_abort(c(
        "healthbR::sih_status() não trouxe o que o sidecar precisa.",
        "x" = if (nrow(st) == 0) "Manifesto vazio ou inacessível." else
          "Colunas ausentes: {paste(faltam, collapse = ', ')} (healthbR dev >= 2026-09-05)."
      ))
    }
    .healthbr$status <- st
    cli_alert_success("Manifesto: {.val {nrow(st)}} partições, atualizado em {.val {attr(st, 'last_updated')}}")
  }
  .healthbr$status
}

#' Competências "AAAA-MM" da janela do ano Y: Y-01..Y-12 + MESES_SEGUINTES de Y+1
janela_competencias <- function(ano) {
  c(sprintf("%d-%02d", ano, 1:12),
    if (MESES_SEGUINTES > 0) sprintf("%d-%02d", ano + 1L, seq_len(MESES_SEGUINTES)))
}

#' Partições publicadas na janela de um ano, para as UFs de arquivo: linhas
#' de healthbr_status() com a chave "AAAA-MM-UF", ordenadas por chave.
healthbr_particoes <- function(ano, ufs, status) {
  status %>%
    dplyr::mutate(competencia = sprintf("%04d-%02d", year, month),
                  chave = paste(competencia, uf, sep = "-")) %>%
    dplyr::filter(competencia %in% janela_competencias(ano), uf %in% ufs) %>%
    dplyr::arrange(chave)
}

#' Lê as partições (só as colunas dos cubos) pelo healthbR, em modo lazy: a
#' projeção e o filtro da janela são empurrados para o Parquet no R2. Confere,
#' partição a partição, que as linhas lidas batem com o manifesto, e monta o
#' registro de proveniência de cada arquivo.
ler_particoes <- function(ano, ufs, particoes) {
  anos <- sort(unique(particoes$year))
  ds <- healthbR::sih_data(year = anos, uf = ufs, source = "r2",
                           lazy = TRUE, parse = FALSE)
  faltam <- setdiff(COLUNAS_SIH, names(ds))
  if (length(faltam) > 0) {
    cli_abort("Colunas ausentes no Parquet do healthbr-data: {paste(faltam, collapse = ', ')}")
  }
  dados <- ds %>%
    dplyr::filter(year == ano | (year == ano + 1L & month <= MESES_SEGUINTES)) %>%
    dplyr::select(dplyr::all_of(c("year", "month", "uf_source", COLUNAS_SIH))) %>%
    dplyr::collect()

  # Cada partição lida tem de ter exatamente as linhas que o manifesto declara
  lidas <- dados %>%
    dplyr::count(year, month, uf = uf_source, name = "linhas") %>%
    dplyr::mutate(chave = sprintf("%04d-%02d-%s", year, month, uf))
  conferencia <- particoes %>%
    dplyr::select(chave, records) %>%
    dplyr::full_join(lidas %>% dplyr::select(chave, linhas), by = "chave") %>%
    dplyr::mutate(linhas = dplyr::coalesce(linhas, 0L),
                  records = dplyr::coalesce(records, 0))
  divergentes <- conferencia %>% dplyr::filter(linhas != records)
  if (nrow(divergentes) > 0) {
    detalhe <- sprintf("%s: manifesto %s, lidas %s", divergentes$chave,
                       format(divergentes$records, big.mark = "."),
                       format(divergentes$linhas, big.mark = "."))
    cli_abort(c("Partições com contagem diferente do manifesto:", setNames(detalhe, rep("x", length(detalhe)))))
  }
  dados <- dados %>% dplyr::select(-year, -month, -uf_source)

  registro <- lapply(seq_len(nrow(particoes)), function(i) {
    p <- particoes[i, ]
    list(
      partition = p$chave,
      parquet_path = p$parquet_path,
      parquet_sha256 = p$parquet_sha256,
      record_count = as.integer(p$records),
      source_file = basename(p$source_url),
      source_url = p$source_url,
      source_hash_md5 = p$source_hash_md5,
      source_size_bytes = p$source_size_bytes,
      processing_timestamp = p$processing_timestamp,
      healthbr_pipeline_version = p$pipeline_version,
      healthbr_git_commit = p$git_commit
    )
  })

  list(dados = dados, particoes = registro)
}

#' "AAAA-MM-DD HH:MM:SS.ffffff" (UTC, do manifesto) -> "AAAA-MM-DDTHH:MM:SSZ"
iso_utc <- function(ts) {
  sub("^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2}:\\d{2}).*$", "\\1T\\2Z", ts)
}

#' Escreve data/sih_provenance_<ano>.json — o registro de safra do cubo
escrever_sidecar <- function(ano, chaves, particoes, manifest_last_updated, janela_completa, totais, output_dir) {
  git_commit <- tryCatch(
    trimws(system2("git", c("-C", shQuote(here::here()), "rev-parse", "HEAD"), stdout = TRUE, stderr = FALSE)),
    error = function(e) NA_character_, warning = function(w) NA_character_
  )
  if (length(git_commit) != 1 || is.na(git_commit) || !nzchar(git_commit)) git_commit <- NULL

  # processing_timestamp do manifesto == download_date do rodapé do Parquet ao
  # segundo (o pipeline do healthbr-data grava os dois no mesmo instante)
  processados_em <- iso_utc(vapply(particoes, function(p) p$processing_timestamp, ""))
  sidecar <- list(
    manifest_version = "1.0.0",
    dataset = HEALTHBR_PREFIX,
    cube_year = ano,
    window = list(
      rule = "internações com DT_INTER no ano; competências do ano + meses seguintes de Y+1",
      months_after = MESES_SEGUINTES,
      competencias_expected = I(janela_competencias(ano)),
      complete = janela_completa,
      evidence = "docs/analise-001-janela-competencia.md"
    ),
    competencias = I(sort(unique(substr(chaves, 1, 7)))),
    ufs_arquivo = I(sort(unique(substr(chaves, 9, 10)))),
    built_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    builder = list(
      script = "scripts/build-aggregations.R",
      version = BUILDER_VERSION,
      git_commit = git_commit,
      r_version = R.version.string,
      arrow_version = as.character(packageVersion("arrow")),
      healthbr_version = as.character(packageVersion("healthbR"))
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
      manifest_last_updated = manifest_last_updated,
      license = HEALTHBR_LICENSE
    ),
    retrieved_at = max(processados_em),
    partitions = particoes,
    totals = totais,
    notes = I(c(
      "Cubo por ANO DE INTERNAÇÃO (DT_INTER): lê as competências do ano e os meses seguintes de Y+1 (window.months_after) e descarta internações de outros anos. Com 4 meses, 99,7-99,9% das internações do ano (dezembro 99,3-99,7%); o restante é reapresentação tardia difusa.",
      "uf dos cubos = UF de residência (MUNIC_RES); ufs_arquivo = UF do estabelecimento (nome do arquivo RD no FTP).",
      "retrieved_at = processing_timestamp mais recente, no manifesto do healthbr-data, dos .dbc que alimentaram este cubo (extração no upstream; igual, ao segundo, ao download_date do rodapé do Parquet). Lido por healthbR::sih_status()."
    ))
  )
  destino <- file.path(output_dir, sprintf("sih_provenance_%d.json", ano))
  jsonlite::write_json(sidecar, destino, auto_unbox = TRUE, pretty = TRUE, null = "null", digits = NA)
  cli_alert_success("  sih_provenance_{ano}.json: {.val {length(particoes)}} partições, retrieved_at {.val {sidecar$retrieved_at}}")
  invisible(destino)
}

#' Agrega UM LOTE de internações já lidas (as colunas cruas do healthbr-data)
#' nos três cubos parciais do ano. Devolve as agregações do lote e as contagens
#' de controle; quem soma os lotes é processar_ano(). Um lote = uma UF de
#' arquivo: o ano nacional de 2023 são 13,3 milhões de internações e, num
#' único data frame, estourou os 16 GB do runner (run 34038116890, 06/09/2026);
#' por UF o maior lote (SP) fica em ~3,5 milhões. Somar agregados de lotes
#' disjuntos dá o mesmo cubo que agregar tudo de uma vez: n, deaths e days são
#' contagens/inteiros (exatos); value é soma de doubles, igual ao último ulp.
agregar_lote <- function(dados, ano) {
  n_lidos <- nrow(dados)
  dados <- dados %>%
    dplyr::mutate(dt_inter = as.Date(DT_INTER, format = "%Y%m%d"))
  n_invalidos <- sum(is.na(dados$dt_inter))
  if (n_invalidos > 0) {
    cli_alert_warning("{n_invalidos} registros com DT_INTER inválido ficam fora dos cubos")
    dados <- dados %>% dplyr::filter(!is.na(dt_inter))
  }
  # O cubo é por ANO DE INTERNAÇÃO: o que a janela trouxe de outros anos
  # (internações de Y-1 faturadas em Y; de Y+1 nas competências extras) sai.
  ano_inter <- as.integer(format(dados$dt_inter, "%Y"))
  n_outros_anos <- sum(ano_inter != ano)
  dados <- dados[ano_inter == ano, , drop = FALSE]

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
      capitulo_cid = por_valor_unico(cid, extrair_capitulo_cid, NA_integer_),
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
      obito = as.integer(MORTE == "1"),
      grupo_csap = por_valor_unico(cid_4, classificar_csap, NA_character_),
      is_csap = !is.na(grupo_csap)
    )

  causas <- dados %>%
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

  series <- dados %>%
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

  list(
    causas = causas, series = series, totais = totais, icsap = icsap,
    n_lidos = n_lidos, n_invalidos = n_invalidos, n_outros_anos = n_outros_anos,
    n_cubo = nrow(dados)
  )
}

#' Soma agregados parciais (um por lote) nas mesmas chaves de grupo:
#' bind_rows + summarise(sum). Com um lote só, devolve o próprio.
somar_lotes <- function(lotes, chaves) {
  x <- dplyr::bind_rows(lotes)
  if (length(lotes) == 1L) return(x)
  x %>%
    dplyr::group_by(dplyr::across(dplyr::all_of(chaves))) %>%
    dplyr::summarise(dplyr::across(dplyr::everything(), ~ sum(.x)), .groups = "drop")
}

#' Processa dados de um ano de competência, UMA UF DE ARQUIVO POR VEZ
processar_ano <- function(ano, ufs_arquivo, output_dir) {

  cli_h2("Ano {ano}")

  tryCatch({
    status <- healthbr_status()
    particoes <- healthbr_particoes(ano, ufs_arquivo, status)
    chaves <- particoes$chave
    esperadas <- length(ufs_arquivo) * length(janela_competencias(ano))
    if (length(chaves) == 0) {
      cli_alert_warning("Sem partições publicadas para {ano} / {paste(ufs_arquivo, collapse=', ')}")
      return(NULL)
    }
    janela_completa <- length(chaves) == esperadas
    if (!janela_completa) {
      cli_alert_warning("{length(chaves)} de {esperadas} partições publicadas na janela de {ano} (competências ainda não divulgadas pelo MS ficam de fora; o cubo sai INCOMPLETO)")
    }

    ufs_com_dados <- sort(unique(particoes$uf))
    cli_alert_info("Lendo {length(chaves)} partições do R2 pelo healthbR, {length(ufs_com_dados)} UF(s) de arquivo em lotes (colunas: {paste(COLUNAS_SIH, collapse=', ')})")
    t0 <- Sys.time()
    lotes <- list()
    registro <- list()
    for (uf in ufs_com_dados) {
      part_uf <- particoes[particoes$uf == uf, , drop = FALSE]
      lido <- ler_particoes(ano, uf, part_uf)
      registro <- c(registro, lido$particoes)
      lote <- agregar_lote(lido$dados, ano)
      cli_alert_info("  {uf}: {format(lote$n_lidos, big.mark='.')} lidas, {format(lote$n_cubo, big.mark='.')} internações de {ano}, {format(nrow(lote$causas), big.mark='.')} linhas de causas ({format(round(Sys.time() - t0, 1))})")
      lotes[[uf]] <- lote
      rm(lido, lote)
      gc()
    }
    n_lidos <- sum(vapply(lotes, function(l) l$n_lidos, numeric(1)))
    n_invalidos <- sum(vapply(lotes, function(l) l$n_invalidos, numeric(1)))
    n_outros_anos <- sum(vapply(lotes, function(l) l$n_outros_anos, numeric(1)))
    cli_alert_success("{.val {format(n_lidos, big.mark='.')}} registros lidos em {format(round(Sys.time() - t0, 1))}")
    cli_alert_info("{format(n_outros_anos, big.mark='.')} registros de outros anos de internação descartados; {format(n_lidos - n_invalidos - n_outros_anos, big.mark='.')} internações de {ano}")

    # =========================================================================
    # CUBO 1: sih_causas_{ano}.parquet
    # =========================================================================

    cli_alert_info("Gerando cubo sih_causas_{ano}.parquet...")
    cubo_causas <- somar_lotes(
      lapply(lotes, function(l) l$causas),
      c("year", "month", "uf", "cid_chapter", "cid_group", "sex", "age", "race", "is_csap", "csap_group")
    )
    write_parquet(cubo_causas, file.path(output_dir, sprintf("sih_causas_%d.parquet", ano)))
    cli_alert_success("  sih_causas_{ano}.parquet: {.val {format(nrow(cubo_causas), big.mark='.')}} linhas")
    # 2.3.1: o maior objeto do ano (6,5 M linhas) e os lotes de causas não são
    # mais necessários — soltar ANTES do cubo ICSAP. Em 2025 (14,6 M
    # internações) o passo ICSAP estourou os 16 GB do runner com tudo isso
    # ainda na memória (run 34062485932, "The operation was canceled").
    records_in_cube <- sum(cubo_causas$n)
    causas_rows <- nrow(cubo_causas)
    rm(cubo_causas)
    lotes <- lapply(lotes, function(l) { l$causas <- NULL; l })
    gc()

    # =========================================================================
    # CUBO 2: sih_series_{ano}.parquet
    # =========================================================================

    cli_alert_info("Gerando cubo sih_series_{ano}.parquet...")
    cubo_series <- somar_lotes(
      lapply(lotes, function(l) l$series),
      c("year_month", "uf", "cid_chapter")
    )
    write_parquet(cubo_series, file.path(output_dir, sprintf("sih_series_%d.parquet", ano)))
    cli_alert_success("  sih_series_{ano}.parquet: {.val {format(nrow(cubo_series), big.mark='.')}} linhas")

    # =========================================================================
    # CUBO 3: sih_icsap_{ano}.parquet
    # =========================================================================

    cli_alert_info("Gerando cubo sih_icsap_{ano}.parquet...")
    totais <- somar_lotes(
      lapply(lotes, function(l) l$totais),
      c("year", "uf", "municipality_code", "sex", "age", "race")
    )
    icsap <- somar_lotes(
      lapply(lotes, function(l) l$icsap),
      c("year", "uf", "municipality_code", "csap_group", "sex", "age", "race")
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
      ano, chaves, registro, attr(status, "last_updated"), janela_completa,
      totais = list(
        records_read = n_lidos,
        records_invalid_dt_inter = n_invalidos,
        records_other_year = n_outros_anos,
        records_in_cube = records_in_cube,
        causas_rows = causas_rows,
        series_rows = nrow(cubo_series),
        icsap_rows = nrow(cubo_icsap)
      ),
      output_dir = output_dir
    )

    # Limpa memoria
    rm(lotes, registro, cubo_series, totais, icsap, cubo_icsap)
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

  # Alerta para processamento completo. Só PERGUNTA em sessão interativa:
  # num runner (scripts/rebuild-cubes.R) o readline() leria EOF e travaria ou
  # cancelaria em silêncio — lá o aviso fica no log e o build segue.
  if (length(years) > 20 && length(ufs) == 27) {
    cli_alert_warning("Voce solicitou processar {length(years)} anos e TODAS as 27 UFs.")
    cli_alert_warning("Isso le todas as particoes do R2 (colunas projetadas) e pode levar horas.")
    if (interactive()) {
      resposta <- readline(prompt = "Deseja continuar? (S/N): ")
      if (!toupper(resposta) %in% c("S", "SIM", "Y", "YES")) {
        cli_alert_info("Operacao cancelada pelo usuario.")
        return(invisible(NULL))
      }
    } else {
      cli_alert_info("Sessao nao interativa: seguindo sem confirmacao.")
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

cli_alert_info("Script build-aggregations.R v{BUILDER_VERSION} carregado (origem: healthbr-data s3://{HEALTHBR_BUCKET}/{HEALTHBR_PREFIX}/, lido pelo healthbR {packageVersion('healthbR')}).")
cli_alert_info("Use: build_data(years = ..., ufs = ...)")
cli_alert_info("Exemplos:")
cli_bullets(c(
  " " = "build_data(years = 2023, ufs = 'RR')",
  " " = "build_data(years = 2020:2024, ufs = 'all')",
  " " = "build_data(years = 'all', ufs = 'all')  # TUDO"
))
