# SPEC-001 — Base de microdados do DATASUS em Parquet

**Status:** proposto
**Versão:** 0.1.0
**Data:** 2026-08-09
**Responsável:** Sidney (DataSenado)
**Documento relacionado:** ADR-001 — Uso de MCP no acesso a microdados de saúde

---

## 0. Como ler este documento

Especificação normativa da infraestrutura de dados. Usa RFC 2119: **DEVE**
(obrigatório), **NÃO DEVE** (proibido), **DEVERIA** (recomendado forte),
**PODE** (opcional).

Itens marcados **[VERIFICAR]** dependem de conferência em fonte primária antes
da implementação. Estão consolidados na §12. Nenhum deles DEVE ser tratado como
fato até verificação.

---

## 1. Escopo e objetivo

Infraestrutura de dados secundários de saúde destinada a servir **múltiplos
projetos de pesquisa ao longo de anos**, com horizonte que excede os estudos que
a originaram.

Requisito primário: **um terceiro, no futuro, DEVE conseguir reproduzir qualquer
número publicado a partir desta base**, identificando exatamente qual versão dos
dados brutos e qual conjunto de regras de transformação foram usados.

Todas as decisões deste documento derivam desse requisito. Onde houver conflito
entre conveniência e rastreabilidade, rastreabilidade prevalece.

### 1.1 Sistemas em escopo

| Sistema | Conteúdo | Prioridade |
|---|---|---|
| SIH-SUS (RD) | Internações hospitalares (AIH reduzida) | 1 |
| SIM | Mortalidade | 1 |
| SINASC | Nascidos vivos | 1 |
| CNES | Estabelecimentos, equipes, profissionais | 2 |
| SINAN | Agravos de notificação | 3 |
| SIA | Produção ambulatorial | 3 |

Séries populacionais do IBGE são tratadas na §9 — **não** são microdados e NÃO
DEVEM ser armazenadas sob a mesma estrutura.

### 1.2 Fora de escopo

- Dados identificados ou identificáveis por vínculo nominal.
- Dados sob acordo de sigilo específico não coberto pela publicação em FTP
  público do DATASUS.
- Camada analítica de projetos individuais (§4.3 define a fronteira).

---

## 2. Princípios

1. **A camada bruta é imutável.** Uma vez gravada, não é editada, corrigida nem
   sobrescrita. Correções entram como nova safra.
2. **A camada harmonizada é derivada e regenerável.** DEVE ser reconstruível
   integralmente a partir da bruta pela execução de código versionado, sem
   intervenção manual. Se essa propriedade se perder, a garantia de
   reprodutibilidade acabou.
3. **Toda transformação é declarada.** Nenhuma recodificação, exclusão ou
   imputação ocorre sem registro identificado (§7).
4. **Metadados são dados.** Dicionários, manifestos e regras vivem em tabelas
   consultáveis, não em prosa ou comentários de código.
5. **Falhar alto e cedo.** Violação de contrato de validação bloqueia a
   ingestão. NÃO DEVE haver caminho que grave dado que falhou validação.

---

## 3. Convenções gerais

### 3.1 Nomenclatura

- Identificadores em `snake_case`, ASCII, sem acentos.
- Nomes de coluna harmonizados em português, sem abreviação críptica.
- Sufixos semânticos obrigatórios em campos com risco de ambiguidade:
  `_res` (residência), `_ocor` (ocorrência), `_int` (internação),
  `_arquivo` (proveniência do arquivo, não atributo do registro).

### 3.2 Datas e competências

- Competência no formato `AAAAMM` (string de 6 caracteres, com zero à esquerda).
- Datas harmonizadas como `Date` (ISO 8601). Na camada bruta permanecem
  `character` no formato original.
- Timestamps de proveniência em UTC, ISO 8601 com offset explícito.

### 3.3 Codificação

- Arquivos de origem DATASUS usam Latin-1 (ISO-8859-1). **[VERIFICAR]** por
  sistema; há variação relatada. A conversão para UTF-8 DEVE ocorrer na leitura
  e ser registrada no manifesto.
- Todo Parquet gravado usa UTF-8.

---

## 4. Arquitetura em três camadas

```
datasus-base/
├── manifest/                 # proveniência (§6)
├── dictionary/               # dicionário de variáveis (§8)
├── rules/                    # registro de regras de harmonização (§7)
├── raw/                      # camada bruta — IMUTÁVEL (§4.1)
├── harmonized/               # camada harmonizada — regenerável (§4.2)
├── R/                        # código de ingestão, harmonização e validação
├── tests/                    # contratos de validação (§10)
└── SPEC-001.md               # este documento
```

`raw/` e `harmonized/` NÃO DEVEM ser versionados no Git (adicionar ao
`.gitignore`). `manifest/`, `dictionary/`, `rules/`, `R/` e `tests/` DEVEM ser.

### 4.1 Camada bruta (`raw/`)

Espelho fiel do arquivo de origem.

**Regras:**

- Toda coluna gravada como `character`. Sem exceção.
- Nenhuma coluna renomeada, removida ou derivada. Nomes originais preservados.
- Nenhuma linha excluída, inclusive registros manifestamente inválidos.
- Colunas técnicas acrescentadas (as únicas permitidas), todas com prefixo `_`:

| Coluna | Tipo | Descrição |
|---|---|---|
| `_arquivo_origem` | chr | Nome do `.dbc` de origem |
| `_hash_origem` | chr | SHA-256 do `.dbc` |
| `_safra` | chr | Identificador da safra (§5) |
| `_linha_origem` | int | Posição da linha no arquivo original |

**Particionamento:** Hive, por `sistema/safra/uf_arquivo/ano`. Os 12 meses de um
ano DEVEM ser consolidados no mesmo arquivo (§4.4).

```
raw/sistema=sih_rd/safra=2026-08/uf_arquivo=DF/ano=2023/part-0.parquet
```

**Compressão:** ZSTD nível 3. **[VERIFICAR]** disponibilidade na build de
`arrow`/`duckdb` em uso; fallback SNAPPY.

### 4.2 Camada harmonizada (`harmonized/`)

Tipagem, padronização entre anos e resolução de campos compostos.

**Permitido:**

- Casting de tipos conforme dicionário (§8).
- Renomeação para nomes harmonizados.
- Resolução de deriva de schema entre anos (§4.5).
- Resolução de campos compostos (ex.: `IDADE` + `COD_IDADE` → `idade_anos`).
- Marcação de invalidez em coluna própria — **nunca** exclusão silenciosa.

**Proibido:**

- Exclusão de registros sem regra declarada em `rules/` (§7).
- Imputação de qualquer natureza sem regra declarada.
- Cálculo de indicador, taxa ou denominador (isso é camada analítica).
- Qualquer transformação que não seja reproduzível pela execução do código.

**Colunas técnicas herdadas:** `_arquivo_origem`, `_hash_origem`, `_safra`,
`_linha_origem`, acrescidas de:

| Coluna | Tipo | Descrição |
|---|---|---|
| `_versao_harmonizacao` | chr | SemVer do conjunto de regras aplicado |
| `_regras_aplicadas` | chr | IDs das regras que afetaram a linha, separados por `;` |

### 4.3 Camada analítica

**Não pertence a esta base.** Vive no repositório do projeto que a consome.
Fronteira: no momento em que se calcula um indicador, se define um denominador
ou se aplica um critério de inclusão/exclusão de estudo, saiu-se da
infraestrutura e entrou-se em análise.

Camada analítica NÃO DEVE ser fonte para outra camada analítica.

### 4.4 Consolidação de arquivos

Parquet penaliza fragmentação. Sem consolidação, 27 UFs × 12 meses × N anos
produz milhares de arquivos pequenos e o custo de metadados domina a leitura.

- Alvo: **100–500 MB por arquivo** físico.
- Na prática: um arquivo por `uf_arquivo` × `ano`, contendo as 12 competências.
- `row_group_size`: 100.000–1.000.000 linhas. **[VERIFICAR]** empiricamente
  contra o padrão de consulta predominante.

### 4.5 Deriva de schema

Variáveis entram e saem do layout entre anos. Duas estratégias, ambas aceitáveis
desde que **documentadas no dicionário**:

| Estratégia | Prós | Contras |
|---|---|---|
| Superschema com `NA` explícito | Leitura trivial; schema estável | Colunas vazias em anos antigos; arquivo maior |
| `union_by_name = true` na leitura | Arquivos enxutos | Exige disciplina de leitura; risco de erro silencioso |

**Recomendação:** superschema na camada harmonizada, schema nativo na bruta.

**Risco crítico:** uma série temporal construída sobre variável com
disponibilidade variável entre anos vira artefato de disponibilidade, não
achado. O dicionário (§8) DEVE registrar `ano_inicio` e `ano_fim` de cada
variável, e a análise DEVE checar isso antes de montar série.

---

## 5. Safras

**Safra** é o conjunto de arquivos baixados em um mesmo evento de ingestão,
identificado por `AAAA-MM` (ou `AAAA-MM-DD` se houver mais de uma no mês).

**Justificativa.** O DATASUS revisa arquivos já publicados — inclusões tardias,
correções de campo. A competência 2019/03 do SIH baixada hoje não é
necessariamente idêntica à baixada em 2023.

**Regras:**

- Nova ingestão de competência já existente DEVE gerar nova safra, ao lado da
  anterior. NÃO DEVE sobrescrever.
- Toda análise DEVE fixar explicitamente a safra utilizada. Consulta sem filtro
  de safra é erro, não conveniência.
- Publicação DEVE reportar a safra no texto ou material suplementar.

**Consequência.** Isto responde à única pergunta que se precisa responder sob
pressão: *por que o número mudou entre a submissão e a revisão?* Sem safra
versionada, a resposta é conjectura.

---

## 6. Manifesto de proveniência

Artefato de primeira classe. Uma linha por arquivo ingerido. Formato: Parquet
em `manifest/ingestao.parquet`, com espelho em CSV versionado no Git.

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `id_ingestao` | chr | sim | UUID do evento |
| `sistema` | chr | sim | `sih_rd`, `sim`, `sinasc`, ... |
| `uf_arquivo` | chr | sim | UF do nome do arquivo (§11.1) |
| `competencia` | chr | sim | `AAAAMM` |
| `safra` | chr | sim | `AAAA-MM` |
| `url_origem` | chr | sim | URL completa no FTP |
| `ts_arquivo_ftp` | chr | sim | Timestamp do arquivo no servidor (UTC) |
| `ts_download` | chr | sim | Momento do download (UTC) |
| `bytes_origem` | int | sim | Tamanho do `.dbc` |
| `hash_origem` | chr | sim | SHA-256 do `.dbc` |
| `n_linhas_origem` | int | sim | Contagem lida do `.dbc` |
| `n_colunas_origem` | int | sim | — |
| `caminho_parquet` | chr | sim | Caminho relativo do arquivo gravado |
| `hash_parquet` | chr | sim | SHA-256 do Parquet |
| `n_linhas_parquet` | int | sim | DEVE igualar `n_linhas_origem` |
| `versao_script` | chr | sim | SemVer ou hash de commit do ingestor |
| `versao_r` | chr | sim | `R.version.string` |
| `versao_pacotes` | chr | sim | JSON com versões de pacotes relevantes |
| `encoding_origem` | chr | sim | Encoding detectado/assumido |
| `status` | chr | sim | `ok`, `falha_validacao`, `divergencia_contagem` |
| `observacoes` | chr | não | Anotações; **nunca** edição do dado |

**Regra de ouro:** erro descoberto na camada bruta vira anotação em
`observacoes` ou nova safra — **nunca** edição do arquivo.

---

## 7. Registro de regras de harmonização

Arquivo `rules/regras.csv`, versionado no Git.

| Campo | Descrição |
|---|---|
| `id_regra` | Identificador estável, ex.: `SIH-IDADE-001` |
| `sistema` | Sistema afetado |
| `variavel` | Variável afetada |
| `vigencia_inicio` / `vigencia_fim` | Anos de aplicação |
| `tipo` | `casting`, `recodificacao`, `unificacao`, `marcacao`, `derivacao` |
| `descricao` | O que a regra faz, em uma frase |
| `justificativa` | Por que |
| `fonte` | Documento, portaria, nota técnica ou dicionário de origem |
| `versao_introducao` | SemVer em que entrou |
| `autor` | Quem decidiu |

**Emissão obrigatória em execução.** A cada harmonização, o log DEVE reportar,
por regra, o número e o percentual de registros afetados. Regra que afeta 0,3%
dos registros precisa estar visível, não enterrada.

### 7.1 Modo de falha que esta seção previne

Ao longo de anos, decisões pontuais se acumulam na camada harmonizada — "aqui eu
excluí datas inválidas", "aqui imputei UF pelo município", "aqui unifiquei duas
categorias que mudaram de código". Cada uma defensável isoladamente. Somadas e
não documentadas, a camada deixa de ser derivação transparente e vira base
própria com epistemologia opaca — e os manuscritos que dependem dela herdam
premissas que ninguém consegue enumerar.

Esta é a forma mais provável de falha do projeto. A contramedida é chata e
funciona.

---

## 8. Dicionário de variáveis

Arquivo `dictionary/variaveis.csv`, versionado. Uma linha por
(sistema, variável, faixa de vigência).

| Campo | Descrição |
|---|---|
| `sistema` | — |
| `nome_origem` | Nome no arquivo `.dbc` |
| `nome_harmonizado` | Nome na camada harmonizada |
| `ano_inicio` / `ano_fim` | Vigência (`NA` = corrente) |
| `tipo_harmonizado` | `chr`, `int`, `dbl`, `Date`, `fct` |
| `dominio` | Conjunto de valores válidos ou faixa |
| `tabela_dominio` | Referência a tabela auxiliar (CID-10, CNES, IBGE) |
| `unidade` | Quando aplicável |
| `fonte_documental` | Dicionário oficial de referência |
| `observacao` | Pegadinhas conhecidas |

Esta tabela é o insumo natural da camada MCP de metadados prevista no ADR-001
§4.1 — o único uso de MCP que sobreviveu àquela análise, e cuja justificativa
aqui se fortalece pela existência de múltiplos consumidores.

---

## 9. Denominadores populacionais

**Armazenados fora de `raw/` e `harmonized/`**, em `population/`. Não são
microdados e não seguem o ciclo de safra do DATASUS.

**Metadados obrigatórios por série:** instituição, publicação exata, data de
divulgação, método (censo, estimativa intercensitária, projeção), base censitária
de referência, nível geográfico, URL, data de acesso.

**Alerta metodológico.** O Censo 2022 alterou substancialmente estimativas
populacionais em relação às projeções baseadas no Censo 2010, com revisão de
porte relevante em parte dos municípios. Taxas calculadas com denominador
pré-revisão e pós-revisão **não são comparáveis**, e a magnitude da diferença é
suficiente para inverter conclusões em análises municipais. **[VERIFICAR]** a
situação atual das revisões e definir a série padrão do projeto antes de
qualquer cálculo de taxa.

**Regra:** toda taxa publicada DEVE declarar a série de denominador utilizada com
a mesma especificidade com que declara a safra dos microdados.

---

## 10. Contratos de validação

Executados a cada ingestão. Falha bloqueia gravação e registra `status` no
manifesto.

### 10.1 Validações estruturais (bloqueantes)

- `n_linhas_parquet == n_linhas_origem`.
- Conjunto de colunas do `.dbc` corresponde ao esperado para (sistema, ano).
- Hash do `.dbc` confere com o registrado (quando reingestão).
- Nenhuma coluna gravada com tipo diferente de `character` na camada bruta.

### 10.2 Validações de conteúdo (bloqueantes)

- Campo de competência do registro coerente com a competência do arquivo.
- Domínios categóricos contidos no conjunto declarado no dicionário.
- Códigos CID-10 conformes à estrutura da revisão vigente no ano.
- Datas parseáveis no formato declarado para o sistema/ano (§11.2).

### 10.3 Validações de alerta (não bloqueantes, registradas)

- Variação de contagem >10% em relação à mesma competência de safra anterior.
- Percentual de campos ausentes acima de limiar histórico.
- Municípios presentes no dado e ausentes na tabela do IBGE, ou vice-versa.

### 10.4 Implementação

`pointblank` produz relatório navegável e integra bem com pipeline em R;
`stopifnot()` também serve para as bloqueantes. O que **não** serve é validação
ad hoc no momento da análise, anos depois, por outra pessoa.

---

## 11. Pegadinhas específicas do DATASUS

Registradas aqui porque cada uma já produziu erro publicado em literatura.

### 11.1 A UF do nome do arquivo não é a UF de residência

`RDSP2301.dbc` contém internações **ocorridas** em SP, não de **residentes** de
SP. Particionar por essa UF e depois calcular taxa por residência faz o predicate
pushdown filtrar a partição errada, perdendo residentes de MG internados em SP.

**Regra:** particionar por `uf_arquivo` (é o que a origem oferece), nomear
inequivocamente, e **nunca** usá-la como proxy de residência.

### 11.2 Formatos de data divergem entre sistemas

SIH usa `AAAAMMDD`; SIM e SINASC usam `DDMMAAAA`. **[VERIFICAR]** por
sistema e por faixa de anos. Parsing automático inverte dia e mês em parte dos
registros — silenciosamente, e apenas onde dia ≤ 12, o que produz viés não
aleatório.

**Regra:** formato declarado explicitamente no dicionário, por sistema e
vigência. Parsing automático é proibido.

### 11.3 Idade é campo composto

No SIH, `IDADE` só tem sentido com `COD_IDADE` (unidade: dias, meses, anos).
Tratar `IDADE` isoladamente como inteiro produz recém-nascidos de 15 anos.
**[VERIFICAR]** a codificação de `COD_IDADE` no dicionário oficial.

### 11.4 Zeros à esquerda e códigos alfanuméricos

CID-10 é alfanumérico. CNES, códigos IBGE de município e vários campos numéricos
têm zeros à esquerda significativos. Casting para inteiro os destrói de forma
irreversível. Este é o motivo central da regra "tudo `character` na bruta".

### 11.5 Código de município: 6 ou 7 dígitos

O DATASUS usa código IBGE de 6 dígitos (sem dígito verificador); tabelas do IBGE
frequentemente usam 7. Join entre eles falha silenciosamente, retornando `NA` em
vez de erro. **Regra:** padronizar em 6 dígitos na harmonizada, documentar, e
validar a taxa de match do join como contrato (§10.3).

### 11.6 Pacote `microdatasus`

As funções `process_*` (Saldanha et al.) recodificam categorias, aplicam rótulos
e derivam campos — exatamente o que a camada bruta não deve conter. Para
ingestão, usar apenas `fetch_datasus()` sem processamento, ou `read.dbc`
diretamente. As recodificações entram na harmonizada, sob o registro da §7.

---

## 12. Pendências de verificação

Nenhum item abaixo DEVE ser tratado como fato antes de conferência em fonte
primária. Itens marcados **[VERIFICAR]** ao longo do texto:

- [ ] Encoding de origem por sistema (§3.3).
- [ ] Disponibilidade de ZSTD na build de `arrow`/`duckdb` em uso (§4.1).
- [ ] `row_group_size` ótimo para o padrão de consulta predominante (§4.4).
- [ ] Formatos de data por sistema e faixa de anos (§11.2).
- [ ] Codificação de `COD_IDADE` no dicionário oficial do SIH (§11.3).
- [ ] Situação atual das revisões populacionais pós-Censo 2022 e definição da
      série padrão de denominador (§9).
- [ ] Vigência e versão atual da Lista Brasileira de ICSAP (Portaria SAS/MS
      nº 221/2008) — pré-requisito da camada analítica, não desta base.
- [ ] Estrutura atual dos diretórios do FTP DATASUS por sistema.
- [ ] Layouts oficiais e sua cobertura temporal por sistema.

---

## 13. Governança e sigilo

Os microdados do FTP público são não identificados. Contudo, a combinação
**município de residência + data + sexo + idade** constitui quase-identificador
em municípios de pequeno porte, com risco real de reidentificação.

**Regras:**

- Qualquer distribuição da base além do responsável DEVE ter posição explícita
  sobre risco de reidentificação, definida **antes** da distribuição.
- Resultados agregados publicados DEVERIAM adotar supressão de células com
  contagem baixa em desagregação municipal. Limiar a definir e documentar.
- Camada analítica com recorte de subgrupo em município pequeno DEVE ser
  avaliada caso a caso.

---

## 14. Versionamento desta especificação

SemVer. **MAIOR** para mudança que invalide dados já gravados; **MENOR** para
acréscimo compatível; **CORREÇÃO** para ajuste redacional. Toda mudança de
MAIOR ou MENOR DEVE registrar a versão correspondente em `_versao_harmonizacao`.

### Histórico

| Versão | Data | Mudança |
|---|---|---|
| 0.1.0 | 2026-08-09 | Redação inicial |

---

## Anexo A — Esqueleto de ingestão em R

Ilustrativo, não normativo. Implementa §4.1, §6 e §10.1.

```r
library(dplyr)
library(arrow)
library(digest)

#' Ingest a single DATASUS .dbc file into the raw layer
#'
#' Everything is read as character on purpose (see SPEC-001 s.4.1, s.11.4).
#' No row is dropped, no column renamed. Failures raise, never silently pass.
ingest_dbc <- function(path_dbc, sistema, uf_arquivo, competencia,
                       safra, url_origem, ts_arquivo_ftp,
                       root = "raw", versao_script) {

  id_ingestao <- uuid::UUIDgenerate()
  ts_download <- format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z", tz = "UTC")
  hash_origem <- digest::digest(path_dbc, algo = "sha256", file = TRUE)

  # Read as-is; coerce every column to character before anything else
  df <- read.dbc::read.dbc(path_dbc, as.is = TRUE) |>
    mutate(across(everything(), as.character))

  n_linhas_origem <- nrow(df)

  df <- df |>
    mutate(
      `_arquivo_origem` = basename(path_dbc),
      `_hash_origem`    = hash_origem,
      `_safra`          = safra,
      `_linha_origem`   = row_number()
    )

  ano <- substr(competencia, 1, 4)
  dir_out <- file.path(
    root,
    sprintf("sistema=%s", sistema),
    sprintf("safra=%s", safra),
    sprintf("uf_arquivo=%s", uf_arquivo),
    sprintf("ano=%s", ano)
  )
  dir.create(dir_out, recursive = TRUE, showWarnings = FALSE)

  path_parquet <- file.path(dir_out, sprintf("%s.parquet", competencia))
  arrow::write_parquet(df, path_parquet, compression = "zstd")

  # Blocking contract: round-trip row count must match (SPEC-001 s.10.1)
  n_linhas_parquet <- nrow(arrow::read_parquet(path_parquet))
  if (!identical(n_linhas_origem, n_linhas_parquet)) {
    unlink(path_parquet)
    stop(sprintf(
      "Row count mismatch for %s: source=%d, parquet=%d. File discarded.",
      basename(path_dbc), n_linhas_origem, n_linhas_parquet
    ))
  }

  tibble::tibble(
    id_ingestao      = id_ingestao,
    sistema          = sistema,
    uf_arquivo       = uf_arquivo,
    competencia      = competencia,
    safra            = safra,
    url_origem       = url_origem,
    ts_arquivo_ftp   = ts_arquivo_ftp,
    ts_download      = ts_download,
    bytes_origem     = file.size(path_dbc),
    hash_origem      = hash_origem,
    n_linhas_origem  = n_linhas_origem,
    n_colunas_origem = ncol(df) - 4L,  # minus technical columns
    caminho_parquet  = path_parquet,
    hash_parquet     = digest::digest(path_parquet, algo = "sha256", file = TRUE),
    n_linhas_parquet = n_linhas_parquet,
    versao_script    = versao_script,
    versao_r         = R.version.string,
    status           = "ok"
  )
}
```

## Anexo B — Leitura da camada harmonizada

```r
# Lazy connection; nothing is materialised until collect()
con <- DBI::dbConnect(duckdb::duckdb(), read_only = TRUE)
DBI::dbExecute(con, "SET threads TO 16;")        # parallel execution
DBI::dbExecute(con, "SET memory_limit = '16GB';")

sih <- dplyr::tbl(
  con,
  "read_parquet('harmonized/sistema=sih_rd/**/*.parquet',
                hive_partitioning = true, union_by_name = true)"
)

# Safra filter is mandatory, not optional (SPEC-001 s.5)
res <- sih |>
  dplyr::filter(`_safra` == "2026-08", ano == 2023, uf_arquivo == "DF") |>
  dplyr::summarise(n = dplyr::n(), .by = c(munic_res, diag_princ)) |>
  dplyr::collect()

# Inspect the generated SQL before trusting the result
sih |> dplyr::filter(`_safra` == "2026-08") |> dplyr::show_query()
```
