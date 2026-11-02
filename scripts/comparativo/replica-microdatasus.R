# Reproduce, from DATASUS microdata with microdatasus, the sih-br-mcp answer:
# pneumonia (ICD-10 J12-J18) admissions of Espirito Santo RESIDENTS whose
# admission date (DT_INTER) is in 2024, reading competences 2024-01..2025-04
# of the files of all 27 states (residents admitted elsewhere are in other
# states' files). One file at a time: binding 432 files does not fit in memory.
library(microdatasus)
library(dplyr)

ufs <- c("AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS",
         "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC",
         "SE", "SP", "TO")
comps <- seq(as.Date("2024-01-01"), as.Date("2025-04-01"), by = "month")
vars <- c("MUNIC_RES", "DT_INTER", "DIAG_PRINC", "MORTE", "IDADE", "COD_IDADE")

out_dir <- commandArgs(trailingOnly = TRUE)[1]
log_file <- file.path(out_dir, "md-log.csv")
cat("comp,uf,rows,kept,secs,status\n", file = log_file)

pieces <- list()
t0 <- Sys.time()
for (d in as.list(comps)) {
  y <- as.integer(format(d, "%Y"))
  m <- as.integer(format(d, "%m"))
  for (uf in ufs) {
    t1 <- Sys.time()
    res <- tryCatch(
      fetch_datasus(year_start = y, month_start = m, year_end = y, month_end = m,
                    uf = uf, information_system = "SIH-RD", vars = vars),
      error = function(e) e
    )
    secs <- round(as.numeric(difftime(Sys.time(), t1, units = "secs")), 1)
    if (inherits(res, "error")) {
      cat(sprintf("%d-%02d,%s,NA,NA,%s,%s\n", y, m, uf, secs,
                  gsub("[,\n]", " ", conditionMessage(res))),
          file = log_file, append = TRUE)
      next
    }
    kept <- res |>
      filter(substr(MUNIC_RES, 1, 2) == "32",
             substr(DT_INTER, 1, 4) == "2024",
             substr(DIAG_PRINC, 1, 3) %in% sprintf("J%02d", 12:18))
    pieces[[length(pieces) + 1]] <- kept
    cat(sprintf("%d-%02d,%s,%d,%d,%s,ok\n", y, m, uf, nrow(res), nrow(kept), secs),
        file = log_file, append = TRUE)
  }
}
total_secs <- as.numeric(difftime(Sys.time(), t0, units = "secs"))

pneu <- bind_rows(pieces)
saveRDS(pneu, file.path(out_dir, "md-pneumonia-es-2024.rds"))

res <- pneu |>
  summarise(admissions = n(), deaths = sum(MORTE == "1"))
by_group <- pneu |>
  mutate(cid_group = substr(DIAG_PRINC, 1, 3)) |>
  count(cid_group, name = "admissions")

sink(file.path(out_dir, "md-result.txt"))
cat("microdatasus", as.character(packageVersion("microdatasus")),
    "| dplyr", as.character(packageVersion("dplyr")), "|", R.version.string, "\n")
cat("started", format(t0, "%Y-%m-%d %H:%M:%S %Z"), "| total seconds", round(total_secs, 1), "\n")
print(as.data.frame(res))
print(as.data.frame(by_group))
sink()
