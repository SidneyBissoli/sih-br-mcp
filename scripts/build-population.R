# =============================================================================
# build-population.R
# Gera cubos de dados populacionais em Parquet
# Projeto: sih-br-mcp
#
# FONTES DE DADOS:
#   1. DATASUS FTP - Dados municipais 1991-2024 (via csapAIH::ler_popbr)
#   2. IBGE - Projecoes da Populacao, REVISAO 2024 (planilha oficial
#      projecoes_2024_tab1_idade_simples.xlsx do FTP do IBGE: UF x sexo x idade
#      simples x ano 2000-2070). Desde 2026-09-07 (sih:canal-acabamento);
#      antes vinha da SIDRA 7358, que so tem a revisao 2018 (a 2024 nao foi
#      carregada na SIDRA) — build_pop_uf_sidra2018() fica como legado.
#
# REGRAS CRITICAS:
#   - NAO interpolar dados
#   - NAO incluir ano alem do ultimo cubo FECHADO do SIH (hoje 2025); ver CONTEXT.md
#   - APENAS baixar dados existentes nas fontes
#   - Agregar municipios para UF e permitido (soma)
#
# USO:
#   source("scripts/build-population.R")
#   build_population()             # Gera todos os 3 arquivos
#   build_pop_municipios()         # Apenas pop_municipios.parquet
#   build_pop_uf()                 # Apenas pop_uf.parquet (planilha IBGE, Revisao 2024)
#   build_pop_uf_agregado()        # Apenas pop_uf_agregado.parquet
# =============================================================================

library(dplyr)
library(arrow)
library(cli)
library(httr)
library(jsonlite)

# =============================================================================
# CONFIGURACAO
# =============================================================================

OUTPUT_DIR <- here::here("data")
dir.create(OUTPUT_DIR, showWarnings = FALSE, recursive = TRUE)

# Mapeamento codigo UF -> sigla
UF_CODIGO_SIGLA <- c(
  "11" = "RO", "12" = "AC", "13" = "AM", "14" = "RR", "15" = "PA",
  "16" = "AP", "17" = "TO", "21" = "MA", "22" = "PI", "23" = "CE",
  "24" = "RN", "25" = "PB", "26" = "PE", "27" = "AL", "28" = "SE",
  "29" = "BA", "31" = "MG", "32" = "ES", "33" = "RJ", "35" = "SP",
  "41" = "PR", "42" = "SC", "43" = "RS", "50" = "MS", "51" = "MT",
  "52" = "GO", "53" = "DF"
)

# =============================================================================
# FUNCAO 1: build_pop_municipios()
# Dados municipais 1991-2024 via DATASUS/csapAIH
# =============================================================================

#' Gera pop_municipios.parquet
#'
#' Baixa dados populacionais municipais do DATASUS (via csapAIH::ler_popbr)
#' Periodo: 1991-2024
#' Granularidade: municipio, sexo, faixa etaria
#'
#' Colunas retornadas por ler_popbr():
#'   munic_res  - Codigo IBGE do municipio (6 digitos)
#'   ano        - Ano (usado internamente, nao como coluna)
#'   sexo       - "masc" ou "fem"
#'   fxetar5    - Faixa etaria quinquenal (fator)
#'   populacao  - Populacao estimada
#'
#' @return Invisivel. Salva pop_municipios.parquet no diretorio data/
build_pop_municipios <- function() {

  cli_h1("Gerando pop_municipios.parquet")
  cli_alert_info("Fonte: DATASUS FTP (via pacote csapAIH)")
  cli_alert_info("Periodo: 1991-2024")

  if (!requireNamespace("csapAIH", quietly = TRUE)) {
    cli_abort("Pacote 'csapAIH' necessario. Instale com: install.packages('csapAIH')")
  }

  anos_disponiveis <- 1991:2024
  cli_alert_info("Baixando dados para {length(anos_disponiveis)} anos...")

  dados_todos <- list()

  for (ano in anos_disponiveis) {
    cli_alert_info("  Ano {ano}...")

    tryCatch({
      pop_ano <- csapAIH::ler_popbr(ano)

      if (is.null(pop_ano) || nrow(pop_ano) == 0) {
        cli_alert_warning("  Sem dados para {ano}")
        next
      }

      # Debug: mostra nomes das colunas na primeira iteracao
      if (ano == anos_disponiveis[1]) {
        cli_alert_info("  Colunas do ler_popbr(): {paste(names(pop_ano), collapse=', ')}")
      }

      # Determina fonte
      fonte <- dplyr::case_when(
        ano %in% c(1991, 2000, 2010, 2022) ~ "censo",
        ano == 1996 ~ "contagem",
        TRUE ~ "estimativa"
      )

      # ler_popbr() retorna: munic_res, sexo, fxetar5 (ou fxetaria), populacao
      # Extrai vetores usando os nomes corretos
      mun_vec <- as.character(pop_ano[["munic_res"]])

      # Sexo
      if ("sexo" %in% names(pop_ano)) {
        sexo_raw <- tolower(as.character(pop_ano[["sexo"]]))
        sex_vec <- dplyr::case_when(
          sexo_raw %in% c("masc", "masculino", "m") ~ "M",
          sexo_raw %in% c("fem", "feminino", "f") ~ "F",
          TRUE ~ "total"
        )
      } else {
        sex_vec <- rep("total", nrow(pop_ano))
      }

      # Faixa etaria
      if ("fxetar5" %in% names(pop_ano)) {
        age_group_vec <- as.character(pop_ano[["fxetar5"]])
      } else if ("fxetaria" %in% names(pop_ano)) {
        age_group_vec <- as.character(pop_ano[["fxetaria"]])
      } else {
        age_group_vec <- rep("total", nrow(pop_ano))
      }

      # Populacao
      pop_vec <- as.integer(pop_ano[["populacao"]])

      # Monta data frame
      pop_processado <- data.frame(
        year = as.integer(ano),
        source = fonte,
        municipality_code = mun_vec,
        uf = UF_CODIGO_SIGLA[substr(mun_vec, 1, 2)],
        sex = sex_vec,
        age_group = age_group_vec,
        population = pop_vec,
        stringsAsFactors = FALSE
      ) %>%
        dplyr::filter(!is.na(uf), !is.na(population), population > 0)

      dados_todos[[as.character(ano)]] <- pop_processado
      cli_alert_success("  {ano}: {format(nrow(pop_processado), big.mark='.')} registros")

    }, error = function(e) {
      cli_alert_warning("  Erro ao processar {ano}: {e$message}")
    })
  }

  if (length(dados_todos) == 0) {
    cli_abort("Nenhum dado foi baixado com sucesso")
  }

  dados_final <- dplyr::bind_rows(dados_todos)

  # Agrega duplicatas
  dados_final <- dados_final %>%
    dplyr::group_by(year, source, municipality_code, uf, sex, age_group) %>%
    dplyr::summarise(population = sum(population, na.rm = TRUE), .groups = "drop")

  # Salva
  arquivo_saida <- file.path(OUTPUT_DIR, "pop_municipios.parquet")
  arrow::write_parquet(dados_final, arquivo_saida)

  cli_h2("Resumo pop_municipios.parquet")
  cli_alert_success("Arquivo: {.path {arquivo_saida}}")
  cli_alert_success("Registros: {.val {format(nrow(dados_final), big.mark='.')}}")
  cli_alert_success("Anos: {.val {min(dados_final$year)}} a {.val {max(dados_final$year)}}")
  cli_alert_success("UFs: {.val {length(unique(dados_final$uf))}}")
  cli_alert_success("Tamanho: {.val {round(file.info(arquivo_saida)$size / 1024 / 1024, 2)}} MB")

  return(invisible(dados_final))
}

# =============================================================================
# FUNCAO 2: build_pop_uf()
# Projecoes UF 2000-2025 via API HTTP do SIDRA (Tabela 7358)
#
# NOTA TECNICA:
#   Na API SIDRA, Tabela 7358 usa:
#     - p/2018 = periodo fixo (revisao 2018)
#     - c287   = classificacao de idade (individual + grupos)
#     - c1933  = classificacao de ano projetado (2000-2060)
#     - c2     = classificacao de sexo (4=Homens, 5=Mulheres)
#     - v/606  = variavel populacao
#     - n3     = nivel UF
# =============================================================================

# Mapeamento: ano projetado -> codigo da categoria c1933 na API SIDRA
ANO_CATEGORIA_SIDRA <- c(
  "2000" = "116338", "2001" = "116336", "2002" = "116335", "2003" = "116334",
  "2004" = "116332", "2005" = "116331", "2006" = "116330", "2007" = "116329",
  "2008" = "116327", "2009" = "119270", "2010" = "4336",  "2011" = "12037",
  "2012" = "13242",  "2013" = "49029",  "2014" = "49030", "2015" = "49031",
  "2016" = "49032",  "2017" = "49033",  "2018" = "49034", "2019" = "49035",
  "2020" = "49036",  "2021" = "49037",  "2022" = "49038", "2023" = "49039",
  "2024" = "49040", "2025" = "49041"
)

# Codigos das categorias de idades individuais em c287
# 49111=0ano, 6558=1ano, 6559=2anos, ..., 6581=24anos,
# 6582=25anos, 6656=26anos, ..., 49110=90+
# Usar "all" e filtrar depois e mais robusto
IDADES_INDIVIDUAIS_PATTERN <- "^(\\d+) (ano|anos)( ou mais)?$"

#' Baixa dados do SIDRA Tabela 7358 via API HTTP
#'
#' @param ano Ano projetado a baixar (2000-2025)
#' @return Data frame com os dados ou NULL se falhar
baixar_sidra_7358 <- function(ano) {

  cat_ano <- ANO_CATEGORIA_SIDRA[as.character(ano)]
  if (is.na(cat_ano)) {
    cli_alert_warning("  Ano {ano} nao tem codigo de categoria mapeado")
    return(NULL)
  }

  # URL correta: p/2018 (periodo fixo), c287/all (idades), c1933/CAT (ano projetado)
  url <- sprintf(
    "https://apisidra.ibge.gov.br/values/t/7358/n3/all/v/606/p/2018/c2/4,5/c287/all/c1933/%s",
    cat_ano
  )

  tryCatch({
    resp <- httr::GET(url, httr::timeout(120))

    if (httr::status_code(resp) != 200) {
      cli_alert_warning("  HTTP {httr::status_code(resp)} para {ano}")
      return(NULL)
    }

    conteudo <- httr::content(resp, as = "text", encoding = "UTF-8")
    dados <- jsonlite::fromJSON(conteudo)

    if (length(dados) == 0) return(NULL)

    # A API retorna header na primeira linha
    if (is.data.frame(dados)) {
      # Primeira linha e o header
      df <- dados[-1, , drop = FALSE]
      names(df) <- as.character(dados[1, ])
    } else if (is.matrix(dados)) {
      df <- as.data.frame(dados[-1, , drop = FALSE], stringsAsFactors = FALSE)
      names(df) <- dados[1, ]
    } else {
      return(NULL)
    }

    return(df)

  }, error = function(e) {
    cli_alert_warning("  Erro HTTP: {e$message}")
    return(NULL)
  })
}

# Planilha oficial da Projecao da Populacao, Revisao 2024 (IBGE): uma linha por
# IDADE (0..90, 90 = 90+) x SEXO (Ambos/Homens/Mulheres) x LOCAL (BR, regioes e
# UFs, com SIGLA), colunas 2000..2070. Cabecalho na 6a linha.
IBGE_PROJECAO_2024_URL <- "https://ftp.ibge.gov.br/Projecao_da_Populacao/Projecao_da_Populacao_2024/projecoes_2024_tab1_idade_simples.xlsx"

# Ultimo ano de populacao a gravar = ultimo ano de cubo FECHADO do SIH (CONTEXT.md)
POP_UF_ULTIMO_ANO <- 2025L

#' Gera pop_uf.parquet a partir da Projecao da Populacao 2024 do IBGE
#'
#' Le a planilha oficial (idade simples) do FTP do IBGE, filtra as 27 UFs,
#' Homens/Mulheres e os anos 2000..POP_UF_ULTIMO_ANO, e grava o mesmo esquema
#' de antes (year, uf, sex, age, population; 90 = 90+). Nada e interpolado.
#' Conferencia embutida: a soma Homens + Mulheres tem de bater com "Ambos"
#' em cada UF x ano, e o Brasil de 2024 com 212.583.750 (valor da planilha).
#'
#' @param arquivo Caminho local da planilha; se NULL, baixa do FTP do IBGE
#'   para tempdir().
#' @return Invisivel. Salva pop_uf.parquet no diretorio data/
build_pop_uf <- function(arquivo = NULL) {
  if (!requireNamespace("readxl", quietly = TRUE)) {
    cli_abort("Instale o pacote readxl: install.packages('readxl')")
  }
  cli_h1("Gerando pop_uf.parquet (Projecao da Populacao 2024, IBGE)")
  cli_alert_info("Fonte: {IBGE_PROJECAO_2024_URL}")
  cli_alert_info("Periodo: 2000-{POP_UF_ULTIMO_ANO} (ate o ultimo cubo fechado do SIH)")

  if (is.null(arquivo)) {
    arquivo <- file.path(tempdir(), basename(IBGE_PROJECAO_2024_URL))
    cli_alert_info("Baixando a planilha...")
    utils::download.file(IBGE_PROJECAO_2024_URL, arquivo, mode = "wb", quiet = TRUE)
  }

  bruto <- suppressMessages(readxl::read_excel(arquivo, sheet = 1, skip = 5))
  esperadas <- c("IDADE", "SEXO", "SIGLA", "LOCAL")
  if (!all(esperadas %in% names(bruto))) {
    cli_abort("Planilha fora do leiaute esperado; colunas: {paste(names(bruto), collapse = ', ')}")
  }
  anos <- as.character(2000:POP_UF_ULTIMO_ANO)
  faltam <- setdiff(anos, names(bruto))
  if (length(faltam) > 0) cli_abort("Planilha sem os anos {paste(faltam, collapse = ', ')}")

  ufs <- unname(UF_CODIGO_SIGLA)
  longo <- bruto %>%
    dplyr::filter(SIGLA %in% ufs, SEXO %in% c("Homens", "Mulheres", "Ambos")) %>%
    dplyr::select(IDADE, SEXO, uf = SIGLA, dplyr::all_of(anos)) %>%
    tidyr::pivot_longer(dplyr::all_of(anos), names_to = "year", values_to = "population") %>%
    dplyr::mutate(
      year = as.integer(year),
      age = pmin(as.integer(IDADE), 90L),
      population = as.integer(round(population))
    )

  # Conferencia: Homens + Mulheres == Ambos, por UF x ano
  ambos <- longo %>% dplyr::filter(SEXO == "Ambos") %>% dplyr::group_by(uf, year) %>%
    dplyr::summarise(ambos = sum(population), .groups = "drop")
  soma <- longo %>% dplyr::filter(SEXO != "Ambos") %>% dplyr::group_by(uf, year) %>%
    dplyr::summarise(soma = sum(population), .groups = "drop")
  conf <- dplyr::full_join(ambos, soma, by = c("uf", "year")) %>% dplyr::filter(abs(ambos - soma) > 1)
  if (nrow(conf) > 0) {
    cli_abort("Homens + Mulheres != Ambos em {nrow(conf)} UF x ano (ex.: {conf$uf[1]} {conf$year[1]})")
  }
  br_2024 <- bruto %>% dplyr::filter(SIGLA == "BR", SEXO == "Ambos") %>% dplyr::pull("2024") %>% sum()
  if (br_2024 != 212583750) cli_abort("Brasil 2024 na planilha = {br_2024}, esperado 212.583.750")

  dados_final <- longo %>%
    dplyr::filter(SEXO != "Ambos") %>%
    dplyr::mutate(sex = ifelse(SEXO == "Homens", "M", "F")) %>%
    dplyr::group_by(year, uf, sex, age) %>%
    dplyr::summarise(population = sum(population), .groups = "drop") %>%
    dplyr::arrange(year, uf, sex, age) %>%
    as.data.frame()

  stopifnot(length(unique(dados_final$uf)) == 27, all(0:90 %in% dados_final$age))

  arquivo_saida <- file.path(OUTPUT_DIR, "pop_uf.parquet")
  arrow::write_parquet(dados_final, arquivo_saida)
  cli_h2("Resumo pop_uf.parquet")
  cli_alert_success("Arquivo: {.path {arquivo_saida}}")
  cli_alert_success("Registros: {.val {format(nrow(dados_final), big.mark='.')}}")
  cli_alert_success("Anos: {.val {min(dados_final$year)}} a {.val {max(dados_final$year)}}")
  cli_alert_success("UFs: {.val {length(unique(dados_final$uf))}}; idades 0 a 90+")
  cli_alert_success("Brasil {POP_UF_ULTIMO_ANO}: {.val {format(sum(dados_final$population[dados_final$year == POP_UF_ULTIMO_ANO]), big.mark='.')}}")
  return(invisible(dados_final))
}

#' LEGADO (ate 2026-09-07): pop_uf.parquet pela SIDRA 7358, revisao 2018
#'
#' A SIDRA so carregou a revisao 2018 da projecao (p/2018); a Revisao 2024 esta
#' apenas na planilha do FTP do IBGE (build_pop_uf acima). Mantida para
#' reproduzir os cubos de populacao anteriores.
#' Periodo: 2000-2025 (ate o ultimo ano de cubo FECHADO do SIH; nunca alem — CONTEXT.md)
#' Granularidade: UF, sexo, idade simples (0-90+)
#'
#' @return Invisivel. Salva pop_uf.parquet no diretorio data/
build_pop_uf_sidra2018 <- function() {

  cli_h1("Gerando pop_uf.parquet (via API HTTP, SIDRA 7358 revisao 2018 — LEGADO)")
  cli_alert_info("Fonte: SIDRA/IBGE - Tabela 7358 (Projecoes)")
  cli_alert_info("Periodo: 2000-2025 (ate o ultimo cubo fechado do SIH)")
  cli_alert_info("Parametros: p/2018, c287/all, c1933/[codigo_ano]")

  dados_todos <- list()

  for (ano in 2000:2025) {
    cli_alert_info("  Baixando ano {ano}...")

    df <- baixar_sidra_7358(ano)

    if (is.null(df) || nrow(df) == 0) {
      cli_alert_warning("  Sem dados para {ano}")
      next
    }

    # Debug: mostra colunas na primeira vez
    if (ano == 2000) {
      cli_alert_info("  Colunas da API: {paste(names(df), collapse=', ')}")
    }

    tryCatch({
      # A API SIDRA retorna colunas com nomes descritivos
      # Identificar dinamicamente
      col_names <- names(df)

      # Valor (populacao)
      col_valor <- "V"
      if (!"V" %in% col_names) {
        col_valor <- col_names[grepl("Valor", col_names, ignore.case = TRUE)][1]
      }

      # UF codigo - coluna D1C
      col_uf <- "D1C"
      if (!"D1C" %in% col_names) {
        col_uf <- col_names[grepl("Unidade.*Federa.*C.digo", col_names, ignore.case = TRUE)][1]
      }

      # Sexo - coluna D4N
      col_sexo <- "D4N"
      if (!"D4N" %in% col_names) {
        col_sexo <- col_names[grepl("^Sexo$", col_names, ignore.case = TRUE)][1]
      }

      # Idade (nome) - coluna D5N
      col_idade <- "D5N"
      if (!"D5N" %in% col_names) {
        col_idade <- col_names[grepl("^Idade$", col_names, ignore.case = TRUE)][1]
      }

      if (is.na(col_uf) || is.na(col_sexo) || is.na(col_idade) || is.na(col_valor)) {
        cli_alert_warning("  Colunas nao identificadas para {ano}")
        cli_alert_info("  Disponiveis: {paste(col_names, collapse=', ')}")
        next
      }

      # Filtra apenas idades individuais (remove grupos como "0 a 4 anos", "Total")
      idade_label <- as.character(df[[col_idade]])
      is_individual <- grepl(IDADES_INDIVIDUAIS_PATTERN, idade_label)

      df_filtered <- df[is_individual, , drop = FALSE]

      if (nrow(df_filtered) == 0) {
        cli_alert_warning("  Nenhuma idade individual encontrada para {ano}")
        next
      }

      # Extrai idade numerica do label
      idade_num <- as.integer(gsub("\\s*(ano|anos).*$", "",
                                   as.character(df_filtered[[col_idade]])))

      pop_processado <- data.frame(
        year = as.integer(ano),
        uf = UF_CODIGO_SIGLA[substr(as.character(df_filtered[[col_uf]]), 1, 2)],
        sex = ifelse(
          grepl("Homens|Masculino", as.character(df_filtered[[col_sexo]]), ignore.case = TRUE),
          "M", "F"
        ),
        age = idade_num,
        population = suppressWarnings(as.integer(as.character(df_filtered[[col_valor]]))),
        stringsAsFactors = FALSE
      )

      # Remove linhas invalidas
      pop_processado <- pop_processado[
        !is.na(pop_processado$uf) &
        !is.na(pop_processado$sex) &
        !is.na(pop_processado$age) &
        !is.na(pop_processado$population) &
        pop_processado$population > 0,
      ]

      # Agrupa >= 90 como 90+
      pop_processado$age <- pmin(pop_processado$age, 90L)
      pop_processado <- pop_processado %>%
        dplyr::group_by(year, uf, sex, age) %>%
        dplyr::summarise(population = sum(population, na.rm = TRUE), .groups = "drop")

      if (nrow(pop_processado) > 0) {
        dados_todos[[as.character(ano)]] <- pop_processado
        cli_alert_success("  {ano}: {format(nrow(pop_processado), big.mark='.')} registros")
      }

    }, error = function(e) {
      cli_alert_warning("  Erro ao processar {ano}: {e$message}")
    })

    Sys.sleep(1)  # Evita rate limit (API e pesada)
  }

  if (length(dados_todos) == 0) {
    cli_alert_danger("Nenhum dado baixado. Verifique a conexao com a API SIDRA.")
    return(invisible(NULL))
  }

  dados_final <- dplyr::bind_rows(dados_todos)

  arquivo_saida <- file.path(OUTPUT_DIR, "pop_uf.parquet")
  arrow::write_parquet(dados_final, arquivo_saida)

  cli_h2("Resumo pop_uf.parquet")
  cli_alert_success("Arquivo: {.path {arquivo_saida}}")
  cli_alert_success("Registros: {.val {format(nrow(dados_final), big.mark='.')}}")
  cli_alert_success("Anos: {.val {min(dados_final$year)}} a {.val {max(dados_final$year)}}")
  cli_alert_success("UFs: {.val {length(unique(dados_final$uf))}}")
  cli_alert_success("Idades: 0 a 90+")
  cli_alert_success("Tamanho: {.val {round(file.info(arquivo_saida)$size / 1024 / 1024, 2)}} MB")

  return(invisible(dados_final))
}

# =============================================================================
# FUNCAO 3: build_pop_uf_agregado()
# UF 1991-1999 agregado dos municipios (soma)
# =============================================================================

#' Gera pop_uf_agregado.parquet
#'
#' Agrega dados municipais para obter populacao por UF
#' Para anos onde nao ha projecao IBGE por UF com idade (1991-1999)
#'
#' @param pop_municipios Data frame de pop_municipios (ou le do arquivo)
#' @return Invisivel. Salva pop_uf_agregado.parquet no diretorio data/
build_pop_uf_agregado <- function(pop_municipios = NULL) {

  cli_h1("Gerando pop_uf_agregado.parquet")
  cli_alert_info("Fonte: Agregacao de pop_municipios.parquet")
  cli_alert_info("Periodo: 1991-1999")

  if (is.null(pop_municipios)) {
    arquivo_mun <- file.path(OUTPUT_DIR, "pop_municipios.parquet")
    if (!file.exists(arquivo_mun)) {
      cli_abort("Arquivo pop_municipios.parquet nao encontrado. Execute build_pop_municipios() primeiro.")
    }
    pop_municipios <- arrow::read_parquet(arquivo_mun)
  }

  # Filtra 1991-1999 e agrega por UF
  dados_agregado <- pop_municipios %>%
    dplyr::filter(year >= 1991, year <= 1999) %>%
    dplyr::group_by(year, uf, sex, age_group) %>%
    dplyr::summarise(population = sum(population, na.rm = TRUE), .groups = "drop")

  arquivo_saida <- file.path(OUTPUT_DIR, "pop_uf_agregado.parquet")
  arrow::write_parquet(dados_agregado, arquivo_saida)

  cli_h2("Resumo pop_uf_agregado.parquet")
  cli_alert_success("Arquivo: {.path {arquivo_saida}}")
  cli_alert_success("Registros: {.val {format(nrow(dados_agregado), big.mark='.')}}")
  cli_alert_success("Anos: {.val {min(dados_agregado$year)}} a {.val {max(dados_agregado$year)}}")
  cli_alert_success("UFs: {.val {length(unique(dados_agregado$uf))}}")
  cli_alert_success("Tamanho: {.val {round(file.info(arquivo_saida)$size / 1024 / 1024, 2)}} MB")

  return(invisible(dados_agregado))
}

# =============================================================================
# FUNCAO PRINCIPAL: build_population()
# =============================================================================

#' Gera todos os arquivos de populacao
#'
#' Executa em sequencia:
#'   1. build_pop_municipios() -> pop_municipios.parquet
#'   2. build_pop_uf()         -> pop_uf.parquet
#'   3. build_pop_uf_agregado() -> pop_uf_agregado.parquet
#'
#' @return Lista invisivel com os 3 data frames
build_population <- function() {

  cli_h1("SIH-BR-MCP: Geracao de Dados Populacionais")
  cli_rule()

  resultado <- list()

  # 1. Dados municipais
  cli_h1("Etapa 1/3: Dados Municipais (DATASUS)")
  resultado$municipios <- build_pop_municipios()

  # 2. Projecoes UF (SIDRA HTTP)
  cli_h1("Etapa 2/3: Projecoes UF (SIDRA)")
  resultado$uf <- build_pop_uf()

  # 3. UF agregado (1991-1999)
  cli_h1("Etapa 3/3: UF Agregado (1991-1999)")
  resultado$uf_agregado <- build_pop_uf_agregado(resultado$municipios)

  # Resumo final
  cli_h1("PROCESSAMENTO CONCLUIDO!")
  cli_rule()

  arquivos <- c("pop_municipios.parquet", "pop_uf.parquet", "pop_uf_agregado.parquet")

  cli_alert_success("Arquivos gerados:")
  for (arq in arquivos) {
    caminho <- file.path(OUTPUT_DIR, arq)
    if (file.exists(caminho)) {
      tamanho_mb <- round(file.info(caminho)$size / 1024 / 1024, 2)
      cli_alert_success("  {.path {arq}}: {.val {tamanho_mb}} MB")
    } else {
      cli_alert_warning("  {.path {arq}}: NAO GERADO")
    }
  }

  return(invisible(resultado))
}

# =============================================================================
# MENSAGEM AO CARREGAR
# =============================================================================

cli_alert_info("Script build-population.R carregado.")
cli_alert_info("Use: build_population() para gerar todos os arquivos")
cli_alert_info("Ou execute individualmente:")
cli_bullets(c(
  " " = "build_pop_municipios()   # pop_municipios.parquet (DATASUS)",
  " " = "build_pop_uf()           # pop_uf.parquet (SIDRA HTTP)",
  " " = "build_pop_uf_agregado()  # pop_uf_agregado.parquet (derivado)"
))
cli_rule()
cli_alert_warning("LEMBRETE: NAO interpolar. NAO incluir ano alem do ultimo cubo FECHADO do SIH (hoje 2025).")
