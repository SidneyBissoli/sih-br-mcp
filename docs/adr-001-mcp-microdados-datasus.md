# ADR-001 — Uso de MCP no acesso a microdados de saúde (DATASUS)

**Status:** proposto
**Data:** 2026-08-09
**Autor:** Sidney (DataSenado)
**Escopo:** pipeline analítico de pesquisa em atenção primária (ICSAP, ESF, determinantes sociais)

---

## 1. Contexto

Avaliação sobre adotar servidores MCP (Model Context Protocol) como camada de
acesso do LLM a bases secundárias brasileiras — SIH, SIM, SINASC, CNES, SINAN,
VIGITEL — dentro de um fluxo de trabalho cujo produto final é manuscrito
submetido a revisão por pares.

### 1.1 O que MCP é

Protocolo (JSON-RPC 2.0 sobre stdio ou HTTP) que padroniza a exposição de
capacidades a modelos de linguagem. Primitivas do lado servidor:

| Primitiva | Natureza | Exemplo no domínio |
|---|---|---|
| **Resources** | leitura de contexto | dicionário de variáveis do SIH |
| **Tools** | execução com efeito | disparar agregação parametrizada |
| **Prompts** | template parametrizado | roteiro de checagem de consistência |

Primitivas no sentido inverso (servidor → cliente) incluem *sampling* (servidor
solicita inferência) e *elicitation* (servidor solicita input ao usuário).

### 1.2 Precisão arquitetural relevante

A arquitetura é **host → client → server**. O LLM não acessa dado: emite
intenção estruturada. Quem executa a chamada e toca o dado é o host, que decide
o que devolver como contexto. Autenticação, autorização e auditoria residem
nessa camada. Consequência prática: "conectei um MCP" ≠ "o modelo tem acesso
irrestrito à base".

### 1.3 Sobre a escala dos dados

Correção de premissa comum: os volumes em questão **não são big data**.

| Base | Ordem de grandeza anual |
|---|---|
| SIH-SUS (AIH) | ~11–12 milhões de registros |
| SINASC | ~2,5 milhões |
| SIM | ~1,4 milhão |

Isso é *medium data* — cabe em notebook com DuckDB ou Arrow, sem cluster e sem
Spark. A restrição real **não é o volume do dado, é a janela de contexto**.
Mesmo 200k tokens comportam apenas dezenas de milhares de linhas estreitas, e
ocupá-la com dado bruto degrada a atenção do modelo sem ganho analítico.

---

## 2. Decisão

**Não adotar MCP como camada de acesso a microdados no pipeline analítico que
alimenta manuscritos.** Adotar apenas nos escopos delimitados na seção 4.

---

## 3. Justificativa

### 3.1 O problema que MCP resolve não é o problema existente

MCP existe para eliminar a combinatória N×M — N aplicações × M fontes, cada par
exigindo integração ad hoc. A configuração atual é aproximadamente 1 analista ×
1 host × poucas fontes. Construir servidor, definir schema, versionar e manter
não se amortiza nessa razão.

### 3.2 Incompatibilidade com o artefato exigido (argumento decisivo)

O produto do trabalho é script reproduzível. Um terceiro deve conseguir
reexecutar o código anos depois e obter o mesmo número. Isso exige caminho
analítico **determinístico e inspecionável**.

Uma tool MCP invocada em tempo de inferência opera no sentido oposto: a seleção
de parâmetros passa pelo modelo e pode variar entre execuções. Mesmo com o
indicador codificado no servidor, o registro de *qual* recorte foi solicitado,
em que ordem e com que filtro vive em log de conversa — não em arquivo `.R` sob
controle de versão. Troca-se script auditável por transcript. Para revisão por
pares, é regressão.

### 3.3 Risco de redefinição silenciosa da operacionalização

Risco principal, e não é performance. ICSAP exige:

- Lista Brasileira de ICSAP (Portaria SAS/MS nº 221/2008), com agrupamentos de
  CID-10 fixos — **verificar vigência e eventuais atualizações antes de usar**;
- exclusão de partos;
- denominador populacional coerente com a fonte IBGE adotada (estimativas
  intercensitárias vs. censo), explicitada;
- decisão explícita entre município de residência e município de internação.

Se essas regras não estiverem codificadas em código versionado, o modelo as
reconstrói por inferência a cada consulta — plausivelmente, e de modo
inconsistente entre execuções. **A falha não se manifesta como erro; manifesta-se
como número.**

### 3.4 A alternativa já cobre a necessidade agêntica

Agente com acesso a filesystem e execução de R (ex.: Claude Code) escreve o
script, executa, observa o erro, corrige e commita. O artefato final é código no
Git. A capacidade agêntica está presente; ausente está apenas a camada de
protocolo, que neste caso só adiciona indireção.

---

## 4. Escopos em que MCP é adequado

1. **Metadados e documentação (read-only).** Dicionário de variáveis do
   SIH/SINAN, Lista Brasileira de ICSAP, tabelas do CNES, correspondências
   CID-10. Consulta de referência, sem efeito sobre a análise. Ganho real, risco
   nulo.

2. **Governança institucional multiusuário.** Se o DataSenado precisar mediar
   acesso de vários analistas a bases com restrição de sigilo, o servidor vira
   ponto único de autorização e auditoria. Aqui o N×M efetivamente existe.

3. **Fase exploratória descartável.** "Qual a cobertura temporal desta base?",
   "quais municípios apresentam indício de subnotificação?" — perguntas cuja
   resposta não entra no manuscrito.

> **Retratado.** Uma versão anterior deste raciocínio listava um quarto item
> ("produtos para terceiros, ex.: Shiny"). O item não se sustenta. Shiny é
> interface para humano; MCP é interface para LLM. São ortogonais: um app Shiny
> não se torna servidor MCP nem se beneficia de um. O que ambos compartilham é a
> camada de lógica abaixo — o pacote R com as funções validadas —, o que é
> observação sobre modularização, não sobre MCP.

### 4.1 Critério de decisão

> **O resultado da chamada vai para o manuscrito?**
> Se sim → script versionado, obrigatoriamente.
> Se é reconhecimento de terreno ou consulta de referência → MCP é adequado.

---

## 5. Arquitetura recomendada para o acesso aos dados

Independente de MCP. O princípio é: **o dado não trafega; trafega o resultado.**

1. **Pushdown da agregação.** Expor funções que retornam o agregado, não a
   tabela. Filtros obrigatórios (UF, recorte temporal) e teto de cardinalidade.
2. **Retornar referências, não payloads.** Gravar resultado em Parquet/CSV e
   devolver caminho, schema, `n` e head de 10 linhas.
3. **Metadados primeiro.** Dicionário de variáveis, cardinalidade e cobertura
   temporal disponíveis antes da consulta, para permitir planejamento em vez de
   varredura exploratória.
4. **Superfície de consulta parametrizada, não SQL livre.** Razão metodológica
   (§3.3), não de performance.

### 5.1 Stack

Microdados convertidos de `.dbc` para Parquet particionado por UF/ano; DuckDB
por cima. Predicate e projection pushdown fazem uma query filtrada tocar fração
dos arquivos.

```r
# Lazy connection: nothing is materialised until collect()
con <- DBI::dbConnect(duckdb::duckdb(), read_only = TRUE)
DBI::dbExecute(con, "SET threads TO 16;")  # parallel execution

sih <- dplyr::tbl(
  con,
  "read_parquet('data/sih/**/*.parquet', hive_partitioning = true)"
)

sih |>
  dplyr::filter(ano == 2023, uf == "DF") |>
  dplyr::summarise(n = dplyr::n(), .by = c(munic_res, diag_princ)) |>
  dplyr::collect()  # only the aggregate crosses into R
```

O uso de `dbplyr` preserva a sintaxe tidyverse e a avaliação preguiçosa; a
tradução para SQL é inspecionável via `dplyr::show_query()` — o que é requisito,
não conveniência, dado §3.2.

---

## 6. Consequências

**Positivas**

- Caminho analítico permanece integralmente em código versionado.
- Operacionalização dos indicadores fica sob controle explícito do pesquisador.
- Nenhum custo de manutenção de servidor no caminho crítico.

**Negativas**

- Perde-se conveniência conversacional na exploração inicial (mitigado por §4.3).
- Se o DataSenado escalar para múltiplos analistas com necessidade de acesso
  mediado, esta decisão deve ser reavaliada (gatilho: §4.2).

**Dívida assumida**

- Validação da vigência da Portaria SAS/MS nº 221/2008 e de eventuais
  atualizações da Lista Brasileira de ICSAP permanece pendente e é
  pré-requisito para qualquer implementação.

---

## 7. Pendências de verificação

Itens deste memo que dependem de conferência em fonte primária antes de uso:

- [ ] Vigência e versão atual da Lista Brasileira de ICSAP.
- [ ] Volumetria anual exata das bases (os números da §1.3 são ordens de
      grandeza, não valores auditados).
- [ ] Definição da fonte de denominador populacional a ser padronizada no
      projeto.
