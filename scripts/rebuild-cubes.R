# =============================================================================
# rebuild-cubes.R — linha de comando de scripts/build-aggregations.R
# Projeto: sih-br-mcp
#
# É o que o workflow `.github/workflows/rebuild-cubes.yml` roda no runner, e o
# que se roda à mão para reconstruir um cubo: recebe os anos por argumento,
# decide as UFs de arquivo pelo SIDECAR já versionado do ano (o escopo de cada
# cubo é explícito e sobrevive ao rebuild — 2023/RR continua 2023/RR até alguém
# mandar outra coisa), chama build_data() um ano por vez e sai com status 1 se
# QUALQUER ano falhar. build_data() sozinho engole o erro de um ano (retorna
# FALSE para ele e segue): num runner isso seria verde por engano.
#
# USO:
#   Rscript scripts/rebuild-cubes.R --years 2023
#   Rscript scripts/rebuild-cubes.R --years 2023,2024 --ufs RR,AC
#   Rscript scripts/rebuild-cubes.R --years 2024 --ufs all      # ano novo: sem
#                                                                # sidecar, --ufs
#                                                                # é obrigatório
#
# Saída: data/sih_{causas,series,icsap}_<ano>.parquet + data/sih_provenance_<ano>.json
# (o mesmo lugar de build_data(); `--out <dir>` muda só para medir sem tocar
# em data/).
# =============================================================================

args <- commandArgs(trailingOnly = TRUE)

opt <- function(flag, default = NULL) {
  i <- match(flag, args)
  if (is.na(i) || i == length(args)) return(default)
  args[[i + 1L]]
}
split_csv <- function(x) {
  if (is.null(x) || !nzchar(x)) return(character())
  trimws(strsplit(x, ",", fixed = TRUE)[[1]])
}

years <- suppressWarnings(as.integer(split_csv(opt("--years"))))
if (length(years) == 0 || anyNA(years)) {
  stop("Uso: Rscript scripts/rebuild-cubes.R --years 2023[,2024] [--ufs RR,AC|all] [--out <dir>]", call. = FALSE)
}
ufs_arg <- split_csv(opt("--ufs"))
out_arg <- opt("--out")

# O script de build resolve tudo por here::here() a partir da raiz do repo;
# este arquivo vive em scripts/, então a raiz é o diretório acima.
script_path <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE))
repo_root <- normalizePath(file.path(dirname(script_path[1]), ".."), winslash = "/")
setwd(repo_root)
source(file.path(repo_root, "scripts", "build-aggregations.R"))
if (!is.null(out_arg)) {
  OUTPUT_DIR <- normalizePath(out_arg, winslash = "/", mustWork = FALSE)
  dir.create(OUTPUT_DIR, showWarnings = FALSE, recursive = TRUE)
}

ufs_do_ano <- function(ano) {
  if (length(ufs_arg) > 0) return(if (identical(ufs_arg, "all")) "all" else toupper(ufs_arg))
  sidecar <- file.path(repo_root, "data", sprintf("sih_provenance_%d.json", ano))
  if (!file.exists(sidecar)) {
    stop(sprintf(
      "Ano %d nao tem sidecar em data/ e nenhum --ufs foi dado: o escopo (UFs de arquivo) de um cubo novo tem de ser explicito.",
      ano), call. = FALSE)
  }
  ufs <- jsonlite::fromJSON(sidecar)$ufs_arquivo
  if (length(ufs) == 27) "all" else ufs
}

falhas <- character()
t0 <- Sys.time()
for (ano in years) {
  ufs <- ufs_do_ano(ano)
  cli::cli_alert_info("rebuild {ano}: UFs de arquivo = {if (identical(ufs, 'all')) 'todas (27)' else paste(ufs, collapse = ', ')}")
  res <- build_data(years = ano, ufs = ufs)
  ok <- isTRUE(res[[as.character(ano)]])
  if (!ok) falhas <- c(falhas, as.character(ano))
}
cli::cli_rule()
cli::cli_alert_info("rebuild-cubes: {length(years)} ano(s) em {format(round(Sys.time() - t0, 1))}")
if (length(falhas) > 0) {
  cli::cli_alert_danger("Anos com falha: {paste(falhas, collapse = ', ')}")
  quit(status = 1L)
}
cli::cli_alert_success("rebuild-cubes: todos os anos concluidos")
