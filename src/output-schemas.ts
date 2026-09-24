/**
 * `outputSchema` das doze ferramentas — JSON Schema escrito à mão, servido
 * verbatim (como o `inputSchema` em src/tools.ts; molde do bcb-br-mcp).
 *
 * De onde vêm as formas. NÃO foram inventadas a partir do código: foram MEDIDAS
 * em 16/09/2026 contra o servidor de verdade (`createServer`, transporte em
 * memória, fixture 2023/RR) — os 36 casos do golden, os 27 casos cheio/magro
 * de tests/output-contract.test.ts e mais 38 variantes de `group_by`, filtro,
 * universo e ano ausente, 101 chamadas ao todo — e depois conferidas contra
 * cada handler, porque a fixture não alcança tudo (raça nula em 1998–2007,
 * município nulo em 1992–1997, o `catch` de cada handler). A medição de 14/09
 * (decisão 37 do CONTEXT.md) já dizia o essencial: a forma NÃO varia com
 * `group_by`; varia com o caminho de erro-mole.
 *
 * O que "honesto" quer dizer aqui, e por que importa: cliente que valida (o
 * MCP Inspector valida) rejeita a resposta INTEIRA quando o `structuredContent`
 * não obedece ao esquema anunciado. Um esquema que promete mais do que o
 * servidor cumpre — campo obrigatório que a fonte omite, `number` onde vem
 * `null` — transforma resposta certa em erro no cliente. Por isso:
 *
 * - campo que algum caminho omite é opcional (fora do `required`);
 * - medida que vem NULA em recorte vazio (`get_hospitalizations` sem linha)
 *   é `["number", "null"]`;
 * - coluna de agrupamento que a FONTE anula (raça antes de 2008, município
 *   antes de 1994, grupo CSAP das internações não sensíveis, `exclusion`) é
 *   anulável, mesmo que a fixture de 2023 nunca a mostre nula;
 * - o CAMINHO DE ERRO-MOLE — resposta de sucesso (não `isError`) que carrega
 *   `error` em vez dos dados: "ano sem dado" do funil (decisão 38), grupo
 *   CSAP inexistente, o `catch` de cada handler, cobertura populacional — é
 *   um ramo do `anyOf`, ao lado do caminho feliz. Ramo do caminho feliz exige
 *   os campos de dados; ramo de erro-mole exige `error`. Resposta que não
 *   cumpre nenhum dos dois reprova — é isso que dá dente ao gate
 *   (tests/output-contract.test.ts).
 *
 * Todos os `properties` ficam declarados no topo, com descrição; o `anyOf` só
 * carrega `required`. Cliente que renderiza `properties` vê tudo; validador
 * aplica a exclusividade.
 *
 * Erros de verdade (`isError: true`, sem `structuredContent`) ficam fora: o
 * SDK v2 só exige `structuredContent` em sucesso.
 */

import type { JsonSchemaType } from "@modelcontextprotocol/server";

type Schema = Record<string, unknown>;

// =============================================================================
// Átomos
// =============================================================================

const str = (description: string): Schema => ({ type: "string", description });
const strOuNulo = (description: string): Schema => ({ type: ["string", "null"], description });
const num = (description: string): Schema => ({ type: "number", description });
const numOuNulo = (description: string): Schema => ({ type: ["number", "null"], description });
const bool = (description: string): Schema => ({ type: "boolean", description });
const boolOuNulo = (description: string): Schema => ({ type: ["boolean", "null"], description });
const enumDe = (valores: readonly (string | number)[], description: string): Schema => ({
  enum: [...valores],
  description,
});
const lista = (items: Schema, description: string): Schema => ({ type: "array", items, description });
const listaDeNumeros = (description: string): Schema => lista({ type: "number" }, description);
const listaDeTextos = (description: string): Schema => lista({ type: "string" }, description);

/** Objeto FECHADO: toda chave declarada, `required` explícito. */
const obj = (properties: Record<string, Schema>, required: string[], description?: string): Schema => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required,
  additionalProperties: false,
});

/** Mapa com chave dinâmica (ano, revisão da CID, UF, grupo): só o valor é tipado. */
const mapa = (valor: Schema, description: string): Schema => ({
  type: "object",
  description,
  additionalProperties: valor,
});

// =============================================================================
// Blocos compartilhados
// =============================================================================

/**
 * Projeção `concise` do bloco de proveniência (contrato @sbissoli/mcp-provenance
 * v1.0, `ConciseBlock` em render.ts): a forma que `withProvenance` põe em
 * `structuredContent`. Transcrito do PROVENANCE_BLOCK_SCHEMA do bcb-br-mcp
 * (src/provenance.ts) — o pacote comum publica o esquema canônico em zod, não
 * a projeção concise em JSON Schema, então cada servidor a escreve.
 */
export const PROVENANCE_BLOCK_SCHEMA: Schema = obj(
  {
    source: str("Fonte oficial do dado"),
    source_url: str("URL canônica que reproduz a consulta ou localiza a fonte"),
    data_vintage: strOuNulo("Competência ou safra do dado segundo a fonte; null quando a fonte não expõe"),
    retrieved_at: str("Instante REAL da extração na origem (ISO-8601)"),
    citation: str("Citação pronta para uso"),
    license: strOuNulo("Regime legal do dado (id SPDX quando há)"),
  },
  ["source", "source_url", "data_vintage", "retrieved_at", "citation", "license"],
  "Bloco de proveniência (contrato v1.0): fonte, URL, competência, extração e licença",
);

const ATTRIBUTION_SCHEMA: Schema = listaDeTextos("URLs canônicas das fontes desta resposta (lista de atribuição)");

const PROVENIENCIA_UNICA: Schema = PROVENANCE_BLOCK_SCHEMA;
const PROVENIENCIA_MULTI: Schema = lista(
  PROVENANCE_BLOCK_SCHEMA,
  "Um bloco por procedência que contribuiu com esta resposta (SIH, lista CSAP, csapAIH, população…); licenças nunca se fundem",
);

/** `years_not_available`: o funil acrescenta quando PARTE dos anos pedidos não tem dado (decisão 38). */
const ANOS_AUSENTES: Schema = obj(
  {
    years: listaDeNumeros("Anos pedidos que não têm dados SIH e ficaram fora do resultado"),
    note: str("Quais anos ficaram fora e quais os números cobrem"),
  },
  ["years", "note"],
  "Presente só quando parte dos anos pedidos não tem dado: os números cobrem apenas os anos atendidos",
);

/** `truncated`: `capData` (src/tools.ts) corta `data` em MAX_ROWS e diz quanto ficou de fora. */
const TRUNCADO: Schema = obj(
  {
    returned: num("Linhas devolvidas (o teto)"),
    total: num("Linhas que a consulta produziu"),
  },
  ["returned", "total"],
  "Presente só quando `data` foi truncado no teto de linhas; os totais em `summary` são do conjunto inteiro",
);

const NOTAS: Schema = listaDeTextos(
  "Avisos que qualificam os números: era CID-9, raça/cor ausente, universo do % ICSAP, denominador populacional, truncamento",
);

const ANOS_DISPONIVEIS: Schema = listaDeNumeros("Anos com dados SIH atendíveis por este servidor");

/** Cobertura dos arquivos de população (`PopulationCoverage`, src/db/duckdb.ts). */
const FAIXA_POP = (description: string): Schema =>
  obj(
    {
      first_year: num("Primeiro ano coberto"),
      last_year: num("Último ano coberto"),
      source: str("Arquivo parquet que serve o intervalo"),
      age: str("Grão etário do arquivo"),
      age_groups: listaDeTextos("Faixas etárias quinquenais (só no arquivo agregado)"),
    },
    ["first_year", "last_year", "source", "age"],
    description,
  );
const COBERTURA_POPULACIONAL: Schema = obj(
  {
    first_year: num("Primeiro ano com população por UF (união dos dois arquivos)"),
    last_year: num("Último ano com população por UF"),
    detailed: { ...FAIXA_POP("pop_uf.parquet — idade simples por UF e sexo (projeções IBGE, 2000+)"), type: ["object", "null"] },
    aggregated: {
      ...FAIXA_POP("pop_uf_agregado.parquet — faixa etária quinquenal por UF e sexo (1991–1999)"),
      type: ["object", "null"],
    },
  },
  ["first_year", "last_year", "detailed", "aggregated"],
  "Cobertura dos arquivos de população por UF: o que as ferramentas de taxa aceitam",
);

/**
 * Campos do caminho de ERRO-MOLE, comuns às ferramentas de dado. `error` é o
 * único obrigatório nesse ramo; os outros aparecem conforme a origem:
 * "ano sem dado" do funil traz `data: []`, `available_sih_years` e `note`;
 * o `catch` de um handler traz só `error` mais a lista vazia da ferramenta.
 */
const ERRO_MOLE: Record<string, Schema> = {
  error: str("Motivo pelo qual não há dados nesta resposta (ano sem dado, cobertura populacional, falha na consulta)"),
  available_sih_years: ANOS_DISPONIVEIS,
  note: str("Como obter o dado (por exemplo, consultar get_available_years)"),
};

// =============================================================================
// Montagem
// =============================================================================

interface Corpo {
  description: string;
  /** Todos os campos que podem aparecer no topo, fora do envelope. */
  properties: Record<string, Schema>;
  /** As FORMAS que a resposta pode ter: cada uma é o `required` de um ramo do `anyOf`. */
  formas: string[][];
  /** Um bloco (`provenanceFor` devolve um) ou vários (devolve array). Ver src/provenance.ts. */
  proveniencia: "unica" | "multi";
}

function envelopar(corpo: Corpo): Schema {
  return {
    type: "object",
    description: corpo.description,
    properties: {
      ...corpo.properties,
      provenance: corpo.proveniencia === "multi" ? PROVENIENCIA_MULTI : PROVENIENCIA_UNICA,
      attribution: ATTRIBUTION_SCHEMA,
    },
    required: ["provenance", "attribution"],
    anyOf: corpo.formas.map((required) => ({ required })),
    additionalProperties: false,
  };
}

/** `filters_applied` ecoa os argumentos recebidos: as propriedades são as do `inputSchema` da própria ferramenta. */
function ecoDosArgumentos(inputSchema: JsonSchemaType, description: string): Schema {
  const properties = ((inputSchema as Schema).properties ?? {}) as Record<string, Schema>;
  return { type: "object", description, properties, additionalProperties: false };
}

// =============================================================================
// Linhas das consultas (as medidas com os nomes das colunas dos cubos)
// =============================================================================

/** Colunas de agrupamento do cubo de CAUSAS (enum `group_by` de get_hospitalizations). */
const COLUNAS_CAUSAS: Record<string, Schema> = {
  year: num("Ano (group_by: year)"),
  month: num("Mês, 1–12 (group_by: month)"),
  uf: str("UF de residência — do estabelecimento em 1992–1997 (group_by: uf)"),
  cid_chapter: num("Capítulo da CID, 1–22 (group_by: cid_chapter)"),
  cid_revision: num("Revisão da CID do diagnóstico: 9 ou 10 (group_by: cid_revision)"),
  cid_group: str("Categoria CID de 3 dígitos (group_by: cid_group)"),
  sex: str("Sexo: M ou F (group_by: sex)"),
  age: num("Idade em anos (group_by: age)"),
  race: strOuNulo("Raça/cor; null em 1998–2007, quando a AIH não trazia o campo (group_by: race)"),
  exclusion: strOuNulo("Motivo de exclusão do universo csapAIH; null quando dentro do universo (group_by: exclusion)"),
  is_csap: bool("Internação por condição sensível à atenção primária (group_by: is_csap)"),
  csap_group: strOuNulo("Grupo CSAP g01–g19; null quando a internação não é sensível (group_by: csap_group)"),
};

const LINHA_CAUSAS: Schema = obj(
  {
    ...COLUNAS_CAUSAS,
    n_hospitalizations: numOuNulo("Internações; null quando o recorte não tem nenhuma linha"),
    total_days: numOuNulo("Dias de permanência; null quando o recorte não tem nenhuma linha"),
    total_value: numOuNulo("Valor total pago (R$); null quando o recorte não tem nenhuma linha"),
    deaths: numOuNulo("Óbitos; null quando o recorte não tem nenhuma linha"),
  },
  ["n_hospitalizations", "total_days", "total_value", "deaths"],
  "Uma linha por combinação de `group_by` (só as colunas pedidas aparecem)",
);

/** Colunas de agrupamento do cubo ICSAP (enums `group_by` de get_icsap e get_icsap_indicators). */
const COLUNAS_ICSAP: Record<string, Schema> = {
  year: num("Ano (group_by: year)"),
  uf: str("UF de residência — do estabelecimento em 1992–1997 (group_by: uf)"),
  municipality_code: strOuNulo("Código IBGE do município de residência (6 dígitos); null em 1992–1997 (group_by: municipality_code)"),
  cid_revision: num("Revisão da CID: 9 ou 10 (group_by: cid_revision)"),
  csap_group: strOuNulo("Grupo CSAP g01–g19 (group_by: csap_group)"),
  sex: str("Sexo: M ou F (group_by: sex)"),
  age: num("Idade em anos (group_by: age)"),
  race: strOuNulo("Raça/cor; null em 1998–2007 (group_by: race)"),
};

const MEDIDAS_ICSAP: Record<string, Schema> = {
  n_icsap: num("Internações por condições sensíveis à atenção primária no universo escolhido"),
  n_total: num("Total de internações no universo escolhido (denominador)"),
  icsap_percentage: num("n_icsap / n_total × 100, duas casas"),
  total_days: num("Dias de permanência das ICSAP"),
  total_value: num("Valor pago das ICSAP (R$)"),
  deaths: num("Óbitos nas ICSAP"),
};

const LINHA_ICSAP: Schema = obj(
  { ...COLUNAS_ICSAP, ...MEDIDAS_ICSAP },
  Object.keys(MEDIDAS_ICSAP),
  "Uma linha por combinação de `group_by` (só as colunas pedidas aparecem)",
);

// =============================================================================
// Os doze
// =============================================================================

const list_csap_groups: Corpo = {
  description:
    "Os 19 grupos CSAP (lista completa) ou um grupo só, quando `group_code` é informado; `error` quando o código não existe",
  properties: {
    total_groups: num("Número de grupos na lista (19)"),
    source: str("Norma que define a lista (Portaria MS/SAS 221/2008)"),
    groups: lista(
      obj(
        {
          code: str("Código do grupo, g01–g19"),
          name: str("Nome do grupo em português"),
          cid_count: num("Quantos códigos CID-10 compõem o grupo"),
          cid_codes: listaDeTextos("Códigos CID-10 do grupo; só com `include_cid_codes: true`"),
        },
        ["code", "name", "cid_count"],
      ),
      "Os 19 grupos, na ordem da Portaria",
    ),
    group: obj(
      {
        id: num("Número do grupo na Portaria, 1–19"),
        code: str("Código do grupo, g01–g19"),
        name_pt: str("Nome em português"),
        name_en: str("Nome em inglês"),
        diagnoses: lista(
          obj({ name: str("Diagnóstico"), cid10: listaDeTextos("Códigos CID-10 do diagnóstico") }, ["name", "cid10"]),
          "Diagnósticos que compõem o grupo, com seus códigos",
        ),
        cid_codes: listaDeTextos("Todos os códigos CID-10 do grupo; só com `include_cid_codes: true`"),
      },
      ["id", "code", "name_pt", "name_en", "diagnoses"],
      "O grupo pedido por `group_code`",
    ),
    error: str("Grupo CSAP não encontrado"),
  },
  formas: [["total_groups", "source", "groups"], ["group"], ["error"]],
  proveniencia: "unica",
};

const list_cid_chapters: Corpo = {
  description: "Os 22 capítulos da CID-10 (versão 2019), com intervalo de códigos e nomes",
  properties: {
    total_chapters: num("Número de capítulos (22)"),
    chapters: lista(
      obj(
        {
          code: str("Capítulo em algarismo romano (chave usada em `cid_chapter` é o número, 1–22)"),
          roman: str("Capítulo em algarismo romano"),
          range: str("Intervalo de códigos CID-10 (ex.: A00-B99)"),
          name_pt: str("Nome em português"),
          name_en: str("Nome em inglês"),
        },
        ["code", "roman", "range", "name_pt", "name_en"],
      ),
      "Os capítulos, na ordem da CID",
    ),
  },
  formas: [["total_chapters", "chapters"]],
  proveniencia: "unica",
};

const porAno = (valor: Schema, description: string): Schema => mapa(valor, `${description} — chave é o ano (string)`);

const get_available_years: Corpo = {
  description:
    "Anos com cubo local, o que cada ano carrega (revisão da CID, raça/cor, município, moeda, universo ICSAP), cobertura da população, canal de cubos e frescor",
  properties: {
    years: listaDeNumeros("Anos com cubos Parquet presentes localmente"),
    data_range: obj(
      {
        first_year: num("Primeiro ano local; ausente quando não há cubo"),
        last_year: num("Último ano local; ausente quando não há cubo"),
        total_years: num("Quantos anos"),
      },
      ["total_years"],
      "Intervalo dos anos locais",
    ),
    note: str("Aviso sobre o que `years` significa"),
    race_available: porAno(bool("true quando o cubo tem raça/cor"), "Raça/cor disponível"),
    years_without_race: listaDeNumeros("Anos sem raça/cor (1998–2007)"),
    cid_revision: porAno(
      mapa(numOuNulo("Internações naquela revisão; null quando o sidecar não traz o total"), "Revisão da CID (\"9\" ou \"10\") → internações"),
      "Internações por revisão da CID",
    ),
    years_cid9: listaDeNumeros("Anos em que o cubo usa CID-9 (1992–1997)"),
    icsap_available: porAno(bool("true quando o cubo tem a marcação ICSAP"), "ICSAP disponível"),
    icsap_list_revision: porAno(mapa(str("Lista usada (portaria-221-2008 ou cid9-derivada)"), "Revisão → lista"), "Lista ICSAP por revisão da CID"),
    uf_basis: porAno(enumDe(["residencia", "arquivo"], "Base do eixo `uf`"), "Base do eixo `uf`"),
    years_uf_arquivo: listaDeNumeros("Anos em que `uf` é a do estabelecimento (1992–1997)"),
    municipality_available: porAno(bool("false quando `municipality_code` é nulo em todas as linhas"), "Município disponível"),
    currency: porAno(
      {
        type: ["array", "null"],
        description: "Moeda de `value` por competência; null quando o sidecar não informa",
        items: obj(
          {
            from: str("Primeira competência (AAAA-MM)"),
            to: str("Última competência (AAAA-MM)"),
            code: str("Código ISO 4217 (BRE, BRR, BRL)"),
            symbol: str("Símbolo (Cr$, CR$, R$)"),
            name: str("Nome da moeda"),
          },
          ["from", "to", "code", "symbol", "name"],
        ),
      },
      "Moeda de `value`",
    ),
    records_date_imputed: porAno(num("Internações que entraram com data imputada"), "Datas imputadas"),
    csap_universe: porAno(
      {
        type: ["object", "null"],
        description: "Universo do % ICSAP como o csapAIH; null em cubo anterior ao builder 2.6.0",
        properties: {
          method: str("Método (csapAIH)"),
          records_in_universe: numOuNulo("Internações dentro do universo"),
          excluded: mapa(num("Internações fora do universo por este motivo"), "Motivo de exclusão → internações"),
        },
        required: ["method", "records_in_universe", "excluded"],
        additionalProperties: false,
      },
      "Universo do % ICSAP",
    ),
    population_years: { ...COBERTURA_POPULACIONAL, type: ["object", "null"] },
    cubes_channel: obj(
      {
        enabled: bool("false quando o cache de cubos está desligado"),
        base_url: str("URL do canal público de cubos"),
        published_years: listaDeNumeros("Anos publicados no manifesto do canal"),
        cache_dir: strOuNulo("Pasta do cache local; null quando desligado"),
        manifest_source: enumDe(["remote", "disk", "none", "disabled"], "De onde veio o manifesto"),
        manifest_generated_at: strOuNulo("Quando o manifesto foi gerado; null sem manifesto"),
        note: str("Como o cache baixa os anos pedidos"),
      },
      ["enabled", "base_url", "published_years", "cache_dir", "manifest_source"],
      "Canal público dos cubos e cache local",
    ),
    freshness: obj(
      {
        status: enumDe(["disabled", "pending", "current", "stale", "unknown"], "Frescor dos cubos frente ao espelho"),
        checked_at: strOuNulo("Instante (UTC) da última checagem; null se nunca terminou"),
        method: { enum: ["range", "full", null], description: "Como checou: sonda parcial ou manifesto inteiro" },
        manifest_url: strOuNulo("URL do manifesto do espelho"),
        manifest_last_updated_local: strOuNulo("Manifesto com que os cubos foram gerados"),
        manifest_last_updated_remote: strOuNulo("Manifesto público lido agora"),
        cubes: lista(
          obj(
            {
              cube_year: num("Ano do cubo"),
              reedited: listaDeTextos("Partições cujo .dbc de origem mudou (reedição do MS)"),
              reprocessed: listaDeTextos("Partições regeneradas pelo espelho"),
              removed: listaDeTextos("Partições que saíram do manifesto"),
              new_in_window: listaDeTextos("Competências publicadas depois do build"),
              behind: bool("true quando alguma lista acima tem item"),
            },
            ["cube_year", "reedited", "reprocessed", "removed", "new_in_window", "behind"],
          ),
          "Cubos atrasados frente ao espelho",
        ),
        error: strOuNulo("Erro da checagem; null quando não houve"),
      },
      ["status", "checked_at", "method", "manifest_url", "manifest_last_updated_local", "manifest_last_updated_remote", "cubes", "error"],
      "Frescor dos cubos locais frente ao espelho healthbr-data",
    ),
    error: str("Falha ao listar os anos"),
  },
  formas: [
    [
      "years",
      "data_range",
      "note",
      "race_available",
      "years_without_race",
      "cid_revision",
      "years_cid9",
      "icsap_available",
      "icsap_list_revision",
      "uf_basis",
      "years_uf_arquivo",
      "municipality_available",
      "currency",
      "records_date_imputed",
      "csap_universe",
      "population_years",
      "cubes_channel",
      "freshness",
    ],
    ["error", "years"],
  ],
  proveniencia: "unica",
};

const classify_as_csap: Corpo = {
  description:
    "Cada código CID-10 informado classificado como sensível (com o grupo) ou não; `is_csap` é null no código que não é CID-10, que não recebe classificação",
  properties: {
    classifications: lista(
      obj(
        {
          cid: str("Código como foi informado"),
          // `null` é a terceira resposta, não um buraco: separa "não é sensível"
          // de "isto não é uma doença". Ver `ehCodigoCid10` em tools.ts.
          is_csap: boolOuNulo(
            "true quando o código cai em algum grupo CSAP; false quando é CID-10 e não cai; null quando não é um código CID-10 (não classificado — veja `error` da entrada)",
          ),
          csap_group: strOuNulo("Grupo CSAP g01–g19; null quando não é sensível ou não foi classificado"),
          csap_name: strOuNulo("Nome do grupo; null quando não é sensível ou não foi classificado"),
          error: str("Só nas entradas não classificadas: por que o código não é CID-10"),
        },
        ["cid", "is_csap", "csap_group", "csap_name"],
      ),
      "Uma entrada por código, na ordem informada",
    ),
    summary: obj(
      {
        total: num("Códigos informados"),
        csap: num("Quantos são sensíveis"),
        non_csap: num("Quantos são CID-10 e não são sensíveis (não inclui os não classificados)"),
        not_classified: num("Só quando houver: quantos não são CID-10"),
      },
      ["total", "csap", "non_csap"],
    ),
    error: str("Só quando houver código não classificado: quantos foram e para onde olhar"),
  },
  formas: [["classifications", "summary"]],
  proveniencia: "unica",
};

const get_hospitalizations = (inputSchema: JsonSchemaType): Corpo => ({
  description:
    "Internações do cubo de causas, agrupadas conforme `group_by`, com totais do recorte inteiro; `error` quando nenhum ano pedido tem dado",
  properties: {
    data: lista(LINHA_CAUSAS, "Linhas agrupadas (vazio no caminho de erro-mole)"),
    summary: obj(
      {
        total_hospitalizations: num("Internações no recorte inteiro"),
        total_days: num("Dias de permanência"),
        total_value: num("Valor pago (R$), duas casas"),
        deaths: num("Óbitos"),
        hospital_mortality_rate: num("Óbitos / internações × 100, duas casas"),
        records_returned: num("Linhas em `data`"),
      },
      ["total_hospitalizations", "total_days", "total_value", "deaths", "hospital_mortality_rate", "records_returned"],
      "Totais do recorte inteiro (não do trecho devolvido, quando truncado)",
    ),
    filters_applied: ecoDosArgumentos(inputSchema, "Os argumentos recebidos, ecoados"),
    notes: NOTAS,
    years_not_available: ANOS_AUSENTES,
    truncated: TRUNCADO,
    ...ERRO_MOLE,
  },
  formas: [["data", "summary", "filters_applied"], ["error"]],
  proveniencia: "unica",
});

const get_hospitalization_trends: Corpo = {
  description:
    "Série temporal de internações, anual (`year`) ou mensal (`year_month`); `error` quando nenhum ano do intervalo tem dado",
  properties: {
    granularity: enumDe(["yearly", "monthly"], "Grão da série"),
    period: obj(
      {
        start: { type: ["number", "string"], description: "Ano (anual) ou AAAA-MM (mensal) inicial" },
        end: { type: ["number", "string"], description: "Ano (anual) ou AAAA-MM (mensal) final" },
      },
      ["start", "end"],
      "Intervalo pedido",
    ),
    series: lista(
      {
        anyOf: [
          obj(
            { year: num("Ano"), n_hospitalizations: num("Internações no ano"), deaths: num("Óbitos no ano") },
            ["year", "n_hospitalizations", "deaths"],
            "Ponto anual",
          ),
          obj(
            { year_month: str("Competência AAAA-MM"), n: num("Internações no mês"), deaths: num("Óbitos no mês") },
            ["year_month", "n", "deaths"],
            "Ponto mensal",
          ),
        ],
      },
      "Um ponto por ano ou por mês, em ordem cronológica",
    ),
    notes: NOTAS,
    years_not_available: ANOS_AUSENTES,
    data: lista({}, "Sempre vazio: só aparece no caminho de erro-mole do funil"),
    ...ERRO_MOLE,
  },
  formas: [["granularity", "period", "series"], ["error"]],
  proveniencia: "unica",
};

const compare_regions: Corpo = {
  description: "Ranking de UFs por internações ou óbitos; `error` quando nenhum ano pedido tem dado",
  properties: {
    compare_by: enumDe(["uf", "region"], "Eixo da comparação (hoje ambos agrupam por UF)"),
    metric: enumDe(["n", "deaths"], "Métrica que ordena o ranking"),
    ranking: lista(
      obj(
        {
          rank: num("Posição, 1 = maior"),
          uf: str("UF"),
          n_hospitalizations: num("Internações"),
          deaths: num("Óbitos"),
          mortality_rate: num("Óbitos / internações × 100, duas casas"),
        },
        ["rank", "uf", "n_hospitalizations", "deaths", "mortality_rate"],
      ),
      "Ranking em ordem decrescente da métrica",
    ),
    total_locations: num("Quantas localidades no ranking"),
    notes: NOTAS,
    years_not_available: ANOS_AUSENTES,
    data: lista({}, "Sempre vazio: só aparece no caminho de erro-mole do funil"),
    ...ERRO_MOLE,
  },
  formas: [["compare_by", "metric", "ranking", "total_locations"], ["error"]],
  proveniencia: "unica",
};

const get_icsap = (inputSchema: JsonSchemaType): Corpo => ({
  description:
    "Internações por condições sensíveis à atenção primária, agrupadas conforme `group_by`, com totais e a nota do universo; `error` quando nenhum ano pedido tem dado",
  properties: {
    data: lista(LINHA_ICSAP, "Linhas agrupadas (vazio no caminho de erro-mole)"),
    notes: NOTAS,
    summary: obj(
      {
        total_icsap: num("ICSAP no recorte inteiro"),
        total_hospitalizations: num("Internações no universo (denominador)"),
        icsap_percentage: num("total_icsap / total_hospitalizations × 100, duas casas"),
        total_days: num("Dias de permanência das ICSAP"),
        total_value: num("Valor pago das ICSAP (R$)"),
        deaths: num("Óbitos nas ICSAP"),
        records_returned: num("Linhas em `data`"),
      },
      ["total_icsap", "total_hospitalizations", "icsap_percentage", "total_days", "total_value", "deaths", "records_returned"],
      "Totais do recorte inteiro, calculados sem agrupamento",
    ),
    filters_applied: ecoDosArgumentos(inputSchema, "Os argumentos recebidos, ecoados"),
    years_not_available: ANOS_AUSENTES,
    truncated: TRUNCADO,
    ...ERRO_MOLE,
  },
  formas: [["data", "notes", "summary", "filters_applied"], ["error"]],
  proveniencia: "multi",
});

const get_icsap_indicators: Corpo = {
  description: "Percentual de ICSAP por estrato de `group_by`, com a fórmula e a nota do universo; `error` quando nenhum ano pedido tem dado",
  properties: {
    data: lista(LINHA_ICSAP, "Um estrato por linha (vazio no caminho de erro-mole)"),
    notes: NOTAS,
    indicators_calculated: listaDeTextos("Indicadores presentes nas linhas (icsap_percentage)"),
    note: str("Fórmula do indicador — ou, no caminho de erro-mole, como obter o dado"),
    years_not_available: ANOS_AUSENTES,
    truncated: TRUNCADO,
    error: ERRO_MOLE.error,
    available_sih_years: ERRO_MOLE.available_sih_years,
  },
  formas: [["data", "notes", "indicators_calculated", "note"], ["error"]],
  proveniencia: "multi",
};

const rank_csap_groups: Corpo = {
  description: "Os grupos CSAP ordenados pela métrica, com participação de cada um e concentração nos primeiros; `error` quando nenhum ano pedido tem dado",
  properties: {
    metric: enumDe(["n", "days", "value", "deaths"], "Métrica que ordena"),
    ranking: lista(
      obj(
        {
          rank: num("Posição, 1 = maior"),
          csap_group: str("Grupo CSAP g01–g19"),
          csap_name: str("Nome do grupo"),
          metric_value: num("Valor da métrica escolhida"),
          pct_of_total: num("Participação do grupo no total da métrica, %"),
          n_hospitalizations: num("Internações do grupo"),
          total_days: num("Dias de permanência"),
          total_value: num("Valor pago (R$)"),
          deaths: num("Óbitos"),
        },
        ["rank", "csap_group", "csap_name", "metric_value", "pct_of_total", "n_hospitalizations", "total_days", "total_value", "deaths"],
      ),
      "Ranking em ordem decrescente da métrica",
    ),
    notes: NOTAS,
    concentration: obj(
      { top_3_percentage: num("Soma da participação dos 3 primeiros, %"), top_5_percentage: num("Soma dos 5 primeiros, %") },
      ["top_3_percentage", "top_5_percentage"],
    ),
    total_groups: num("Quantos grupos no ranking"),
    years_not_available: ANOS_AUSENTES,
    data: lista({}, "Sempre vazio: só aparece no caminho de erro-mole do funil"),
    ...ERRO_MOLE,
  },
  formas: [["metric", "ranking", "notes", "concentration", "total_groups"], ["error"]],
  proveniencia: "multi",
};

const get_hospitalization_rates = (inputSchema: JsonSchemaType): Corpo => ({
  description:
    "Taxa de internação por população (IBGE por UF), bruta ou específica; `error` quando o ano está fora da cobertura populacional ou nenhum ano pedido tem dado",
  properties: {
    data: lista(
      obj(
        {
          year: num("Ano (quando agrupado por ano ou mais de um ano)"),
          uf: str("UF (quando agrupado por UF ou mais de uma UF)"),
          n_hospitalizations: num("Internações"),
          deaths: num("Óbitos"),
          population: num("População do estrato (denominador)"),
          rate_per_100k: num("Internações por `rate_per` habitantes (o nome do campo é histórico; a base está em `rate_per`)"),
          rate_per: num("Base da taxa (1000, 10000 ou 100000)"),
          population_source: { enum: ["detailed", "aggregated", null], description: "Arquivo de população que serviu o ano" },
          mortality_rate: num("Óbitos / internações × 100, duas casas"),
        },
        ["n_hospitalizations", "deaths", "population", "rate_per_100k", "rate_per", "population_source", "mortality_rate"],
      ),
      "Um estrato por linha (vazio quando não há internação no recorte)",
    ),
    summary: obj(
      {
        total_hospitalizations: num("Internações somadas"),
        total_population: num("População somada"),
        overall_rate: num("Taxa do conjunto, na base `rate_per`"),
        rate_per: num("Base da taxa"),
        rate_type: enumDe(["crude", "specific"], "Bruta ou específica"),
      },
      ["total_hospitalizations", "total_population", "overall_rate", "rate_per", "rate_type"],
    ),
    metadata: obj(
      {
        population_source: porAno({ enum: ["detailed", "aggregated", null], description: "Arquivo que serviu o ano" }, "Fonte da população"),
        population_notes: listaDeTextos("Avisos sobre o denominador (faixa quinquenal antes de 2000; mistura de fontes)"),
        filters_applied: ecoDosArgumentos(inputSchema, "Os argumentos, com UFs normalizadas e só os anos atendidos"),
        note: str("Presente quando nenhuma internação casou o recorte"),
        available_sih_years: ANOS_DISPONIVEIS,
      },
      ["population_source", "filters_applied"],
    ),
    years_not_available: ANOS_AUSENTES,
    notes: NOTAS,
    truncated: TRUNCADO,
    population_years: COBERTURA_POPULACIONAL,
    ...ERRO_MOLE,
  },
  formas: [["data", "summary", "metadata"], ["error"]],
  proveniencia: "multi",
});

const compare_icsap_trends: Corpo = {
  description:
    "Séries anuais do indicador ICSAP por UF ou grupo CSAP, com tendência linear e melhor/pior desempenho; `error` quando o intervalo está fora da cobertura",
  properties: {
    indicator: enumDe(["percentage", "count", "rate_per_10k"], "Indicador das séries"),
    period: obj({ start: num("Ano inicial pedido"), end: num("Ano final pedido") }, ["start", "end"]),
    compare_by: str("Eixo comparado: uf, csap_group ou total (sem eixo)"),
    series: lista(
      {
        type: "object",
        description: "Um ponto por ano: `year` mais uma chave por valor comparado (UF, grupo ou `total`) com o indicador",
        properties: { year: num("Ano") },
        required: ["year"],
        additionalProperties: { type: "number", description: "Valor do indicador para esta UF, grupo ou `total`" },
      },
      "Pontos em ordem cronológica",
    ),
    notes: NOTAS,
    trends: mapa(
      obj(
        {
          slope: num("Inclinação da regressão linear (indicador por ano)"),
          direction: enumDe(["increasing", "decreasing", "stable"], "Sentido da tendência"),
          avg_annual_change: num("Variação média anual"),
          start_value: num("Valor no primeiro ano"),
          end_value: num("Valor no último ano"),
          change_pct: num("Variação relativa entre as pontas, %"),
        },
        ["slope", "direction", "avg_annual_change", "start_value", "end_value", "change_pct"],
      ),
      "Tendência por valor comparado; só com `include_trend_line` e ao menos dois anos — ausente quando desligada",
    ),
    summary: obj(
      {
        best_performer: str("Valor comparado com a melhor evolução; só com mais de uma tendência"),
        worst_performer: str("Valor comparado com a pior evolução; só com mais de uma tendência"),
        note: str("Como ler o indicador; só para `percentage`"),
      },
      [],
    ),
    years_not_available: ANOS_AUSENTES,
    data: lista({}, "Sempre vazio: só aparece no caminho de erro-mole do funil"),
    population_years: obj(
      { first_year: num("Primeiro ano com população"), last_year: num("Último ano com população") },
      ["first_year", "last_year"],
      "Cobertura populacional; só no erro-mole de `rate_per_10k` fora do intervalo",
    ),
    ...ERRO_MOLE,
  },
  formas: [["indicator", "period", "compare_by", "series", "notes", "summary"], ["error"]],
  proveniencia: "multi",
};

// =============================================================================
// Ponto de entrada
// =============================================================================

const CORPOS: Record<string, Corpo | ((inputSchema: JsonSchemaType) => Corpo)> = {
  list_csap_groups,
  list_cid_chapters,
  get_available_years,
  classify_as_csap,
  get_hospitalizations,
  get_hospitalization_trends,
  compare_regions,
  get_icsap,
  get_icsap_indicators,
  rank_csap_groups,
  get_hospitalization_rates,
  compare_icsap_trends,
};

/**
 * O `outputSchema` da ferramenta, pronto para o `tools/list`. Recebe o
 * `inputSchema` porque `filters_applied` ecoa os argumentos e é descrito pelas
 * mesmas propriedades. Lança para ferramenta desconhecida: ferramenta nova
 * entra em src/tools.ts e reprova aqui até ganhar o seu esquema.
 */
export function outputSchemaFor(name: string, inputSchema: JsonSchemaType): JsonSchemaType {
  const corpo = CORPOS[name];
  if (!corpo) throw new Error(`outputSchemaFor: ferramenta sem esquema de saída: ${name}`);
  return envelopar(typeof corpo === "function" ? corpo(inputSchema) : corpo) as JsonSchemaType;
}
