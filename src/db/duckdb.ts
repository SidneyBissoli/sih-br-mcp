/**
 * Módulo de conexão DuckDB para consulta aos cubos de dados Parquet
 * Suporta múltiplos arquivos Parquet por ano (sih_causas_YYYY.parquet)
 */

// Cliente DuckDB: `@duckdb/node-api` ("Node Neo"), o cliente oficial atual,
// desde 05/09/2026 (PLAN-002). Antes era o binding legado `duckdb`, que pinava
// `node-gyp ^9` em runtime e arrastava tar 6/cacache 16/glob 7 para o lock — a
// origem de 60 dos 72 alertas do Dependabot zerados em 04/09. O Neo traz
// binário pré-compilado por plataforma (optionalDependencies de
// @duckdb/node-bindings): zero node-gyp, zero tar. A API é toda de Promise;
// o funil `query()` continua sendo o único ponto que toca a conexão.
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { CUBES_BASE_URL, CUBES_CACHE_ENABLED, cubesCacheDir } from "../cache.js";

// Obtém diretório do projeto
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..");
// SIH_DATA_DIR aponta o servidor para outra pasta de cubos — é a costura que o
// smoke stdio usa para ler a fixture versionada em tests/fixtures/sih, já que
// data/*.parquet não vai para o git. Sem a variável, nada muda: data/ do projeto.
const DATA_DIR = process.env.SIH_DATA_DIR
  ? resolve(process.env.SIH_DATA_DIR)
  : join(PROJECT_ROOT, "data");
const TEST_DATA_DIR = join(DATA_DIR, "test");

// Singleton do banco de dados. `connecting` segura a Promise da primeira
// abertura para que chamadas concorrentes (as tools de taxa disparam várias
// consultas) não criem duas instâncias — o legado tinha essa corrida.
let instance: DuckDBInstance | null = null;
let conn: DuckDBConnection | null = null;
let connecting: Promise<DuckDBConnection> | null = null;

// Detecta se estamos em modo teste (data/test tem arquivos)
let dataDirectory: string | null = null;

/**
 * Determina qual diretório de dados usar.
 * - Padrão: data/ (dados reais)
 * - Teste: data/test/ (somente se SIH_TEST_MODE=1 estiver definido)
 */
/**
 * A pasta de cubos CONFIGURADA (SIH_DATA_DIR ou data/ do projeto), exista
 * cubo nela ou não. Quem precisa só do sidecar de proveniência — o frescor
 * num checkout limpo, onde data/*.parquet é gitignored e só o JSON está
 * versionado — lê daqui; quem precisa de Parquet usa getDataDirectory().
 */
export function configuredDataDirectory(): string {
  return DATA_DIR;
}

export function getDataDirectory(): string {
  if (dataDirectory) return dataDirectory;

  // Usa data/test/ somente em modo teste explícito
  if (process.env.SIH_TEST_MODE === "1" && existsSync(TEST_DATA_DIR)) {
    const testFiles = readdirSync(TEST_DATA_DIR).filter((f) =>
      f.endsWith(".parquet")
    );
    if (testFiles.length > 0) {
      console.error(`[DuckDB] Modo TESTE: usando ${TEST_DATA_DIR}`);
      dataDirectory = TEST_DATA_DIR;
      return dataDirectory;
    }
  }

  // Padrão: dados reais em data/
  if (existsSync(DATA_DIR)) {
    const prodFiles = readdirSync(DATA_DIR).filter((f) =>
      f.startsWith("sih_") && f.endsWith(".parquet")
    );
    if (prodFiles.length > 0) {
      console.error(`[DuckDB] Usando dados em ${DATA_DIR}`);
      dataDirectory = DATA_DIR;
      return dataDirectory;
    }
  }

  // Sem cubo na pasta do projeto (instalação pelo npm, que não embarca cubo):
  // a pasta passa a ser o cache local, que `src/cache.ts` enche sob demanda a
  // partir do canal público (data.sidneybissoli.com/sih/cubos/). A pasta pode
  // estar vazia agora; os handlers chamam ensureYears() antes de consultar.
  if (CUBES_CACHE_ENABLED) {
    const cacheDir = cubesCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    console.error(`[DuckDB] Sem cubos em ${DATA_DIR}; usando o cache ${cacheDir} (baixa de ${CUBES_BASE_URL} sob demanda)`);
    dataDirectory = cacheDir;
    return dataDirectory;
  }

  throw new Error(
    `Nenhum arquivo SIH Parquet encontrado em ${DATA_DIR} e o cache está desligado (SIH_CUBES_CACHE=off). Execute os scripts R de agregação ou baixe os cubos de ${CUBES_BASE_URL}.`
  );
}

/**
 * Retorna o padrão glob para um tipo de cubo
 */
export function getParquetPattern(cube: "causas" | "series" | "icsap"): string {
  const dir = getDataDirectory();
  return join(dir, `sih_${cube}_*.parquet`).replace(/\\/g, "/");
}

/**
 * Lista os anos disponíveis nos dados
 */
export function getAvailableYears(): number[] {
  const dir = getDataDirectory();
  const files = readdirSync(dir).filter((f) => f.startsWith("sih_causas_"));
  const years = files
    .map((f) => {
      const match = f.match(/sih_causas_(\d{4})\.parquet/);
      return match ? parseInt(match[1]) : null;
    })
    .filter((y): y is number => y !== null)
    .sort((a, b) => a - b);

  return years;
}

/**
 * Inicializa conexão com DuckDB
 */
export async function getDatabase(): Promise<DuckDBConnection> {
  if (conn) {
    return conn;
  }
  if (connecting) {
    return connecting;
  }

  connecting = (async () => {
    // Usa banco em memória (consultas diretas aos Parquet)
    try {
      instance = await DuckDBInstance.create(":memory:");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Erro ao criar banco DuckDB: ${message}`);
    }
    const connection = await instance.connect();

    // Configura DuckDB para melhor performance com Parquet
    try {
      await connection.run("SET threads TO 4");
    } catch {
      console.error("Aviso: não foi possível configurar threads");
    }

    conn = connection;
    return connection;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/**
 * Fecha conexão com o banco
 */
export async function closeDatabase(): Promise<void> {
  if (conn) {
    conn.closeSync();
    conn = null;
  }
  if (instance) {
    instance.closeSync();
    instance = null;
  }
  dataDirectory = null; // Reset para próxima conexão
}

/**
 * Converte BigInt para Number em objetos aninhados
 */
function convertBigIntToNumber(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === "bigint") {
    return Number(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(convertBigIntToNumber);
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = convertBigIntToNumber(value);
    }
    return result;
  }
  return obj;
}

/**
 * Executa query SQL e retorna resultados
 */
export async function query<T = Record<string, unknown>>(
  sql: string
): Promise<T[]> {
  const connection = await getDatabase();

  let rows: Record<string, unknown>[];
  try {
    const result = await connection.runAndReadAll(sql);
    // `getRowObjectsJS()` e não `getRowObjects()`: o segundo devolve DECIMAL
    // como {width, scale, value} e DATE como {days} (classes do Neo), que
    // virariam objetos no JSON da ferramenta; o primeiro entrega tipos JS
    // nativos (DECIMAL → number, DATE → ISO). Medido em 05/09/2026. Hoje os
    // cubos só têm INTEGER/DOUBLE/VARCHAR/BOOLEAN, mas o funil é um só e a
    // defesa fica aqui. BIGINT e HUGEINT (SUM de INTEGER) continuam chegando
    // como bigint nos dois leitores — é o que `convertBigIntToNumber` trata.
    rows = result.getRowObjectsJS();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Erro na query: ${message}\nSQL: ${sql}`);
  }

  // Converte BigInt para Number para serialização JSON
  return convertBigIntToNumber(rows) as T[];
}

// =============================================================================
// INTERFACES DE FILTROS
// =============================================================================

export interface CausasFilters {
  years?: number[];
  months?: number[];
  ufs?: string[];
  municipalityCodes?: string[];
  cidChapters?: number[];
  cidGroups?: string[];
  sex?: string;
  ageMin?: number;
  ageMax?: number;
  races?: string[];
  isCsap?: boolean;
  csapGroups?: string[];
}

export interface IcsapFilters {
  years?: number[];
  ufs?: string[];
  municipalityCodes?: string[];
  csapGroups?: string[];
  sex?: string;
  ageMin?: number;
  ageMax?: number;
  races?: string[];
}

export interface SeriesFilters {
  yearMonthStart?: string; // "YYYY-MM"
  yearMonthEnd?: string;
  ufs?: string[];
  cidChapters?: number[];
}

// =============================================================================
// FUNÇÕES DE QUERY ESPECÍFICAS
// =============================================================================

/**
 * Constrói cláusula WHERE a partir de filtros
 */
function buildWhereClause(filters: CausasFilters | IcsapFilters): string {
  const conditions: string[] = [];

  if ("years" in filters && filters.years && filters.years.length > 0) {
    conditions.push(`year IN (${filters.years.join(", ")})`);
  }

  if ("months" in filters && filters.months && filters.months.length > 0) {
    conditions.push(`month IN (${filters.months.join(", ")})`);
  }

  if (filters.ufs && filters.ufs.length > 0) {
    const ufs = filters.ufs.map((u) => `'${u}'`).join(", ");
    conditions.push(`uf IN (${ufs})`);
  }

  if (
    "municipalityCodes" in filters &&
    filters.municipalityCodes &&
    filters.municipalityCodes.length > 0
  ) {
    const codes = filters.municipalityCodes.map((c) => `'${c}'`).join(", ");
    conditions.push(`municipality_code IN (${codes})`);
  }

  if (
    "cidChapters" in filters &&
    filters.cidChapters &&
    filters.cidChapters.length > 0
  ) {
    conditions.push(`cid_chapter IN (${filters.cidChapters.join(", ")})`);
  }

  if ("cidGroups" in filters && filters.cidGroups && filters.cidGroups.length > 0) {
    const groups = filters.cidGroups.map((g) => `'${g}'`).join(", ");
    conditions.push(`cid_group IN (${groups})`);
  }

  if (filters.sex) {
    conditions.push(`sex = '${filters.sex}'`);
  }

  if (filters.ageMin !== undefined) {
    conditions.push(`age >= ${filters.ageMin}`);
  }

  if (filters.ageMax !== undefined) {
    conditions.push(`age <= ${filters.ageMax}`);
  }

  if (filters.races && filters.races.length > 0) {
    const races = filters.races.map((r) => `'${r}'`).join(", ");
    conditions.push(`race IN (${races})`);
  }

  if ("isCsap" in filters && filters.isCsap !== undefined) {
    conditions.push(`is_csap = ${filters.isCsap}`);
  }

  if ("csapGroups" in filters && filters.csapGroups && filters.csapGroups.length > 0) {
    const groups = filters.csapGroups.map((g) => `'${g}'`).join(", ");
    conditions.push(`csap_group IN (${groups})`);
  }

  return conditions.length > 0 ? conditions.join(" AND ") : "1=1";
}

/**
 * Expressão de uma coluna de agrupamento no SELECT e no GROUP BY. `cid_revision`
 * só existe nos cubos do builder >= 2.5.0: os cubos são abertos por glob com
 * `union_by_name`, então um cubo anterior (cache local misto) a traz NULA — e
 * nula significa CID-10 (a coluna é constante 10 em 1998+). A defesa vale só
 * para caches mistos; a série publicada é toda 2.5.0.
 */
/**
 * Soma de `value` como DECIMAL(18,2) e não como DOUBLE: o SUM paralelo de
 * doubles do DuckDB muda o último dígito conforme a ordem em que as threads
 * terminam (golden de 07/09/2026: 9746572.610000005 numa execução,
 * 9746572.61000001 na seguinte); em decimal a soma é exata e determinística.
 * `value` é dinheiro com 2 casas — nada se perde.
 */
function groupSelect(column: string): string {
  return column === "cid_revision" ? "COALESCE(cid_revision, 10) AS cid_revision" : column;
}
function groupKey(column: string): string {
  return column === "cid_revision" ? "COALESCE(cid_revision, 10)" : column;
}

/**
 * ORDER BY determinístico para consultas agrupadas.
 *
 * Sem isto, duas chamadas iguais devolvem respostas diferentes: GROUP BY sem
 * ORDER BY sai na ordem em que as 4 threads do DuckDB terminam, e ORDER BY
 * por métrica empata (dois grupos com o mesmo SUM) sem critério de desempate —
 * medido em 05/09/2026 sobre a fixture: `compare_regions` dava posição 5 a GO
 * numa chamada e a PB na seguinte, `rank_csap_groups` trocava g01 e g13, e
 * qualquer `limit` em cima disso devolvia SUBCONJUNTOS diferentes. O golden
 * das ferramentas (scripts/golden-tools.mjs) foi o que expôs; o conserto é
 * aqui, no funil, e não tool a tool: toda coluna de agrupamento que o chamador
 * não ordenou explicitamente entra como desempate, na ordem do GROUP BY.
 */
function buildOrderBy(orderBy: string | undefined, groupBy: string[]): string {
  const mentioned = new Set(
    (orderBy ?? "")
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean)
  );
  const tieBreak = groupBy.filter((column) => !mentioned.has(column));
  const parts = [orderBy, ...tieBreak].filter((part): part is string => !!part);
  return parts.length > 0 ? ` ORDER BY ${parts.join(", ")}` : "";
}

/**
 * Query no cubo de causas com agregação flexível
 */
export async function queryCausas<T = Record<string, unknown>>(options: {
  filters?: CausasFilters;
  groupBy?: string[];
  metrics?: ("n" | "days" | "value" | "deaths")[];
  orderBy?: string;
  limit?: number;
}): Promise<T[]> {
  const pattern = getParquetPattern("causas");
  const whereClause = buildWhereClause(options.filters || {});

  // Métricas a calcular
  const metricsMap: Record<string, string> = {
    n: "SUM(n) as n_hospitalizations",
    days: "SUM(days) as total_days",
    value: "SUM(CAST(value AS DECIMAL(18,2))) as total_value",
    deaths: "SUM(deaths) as deaths",
  };

  const metrics = options.metrics || ["n"];
  const selectMetrics = metrics.map((m) => metricsMap[m]).join(", ");

  // Group by
  const groupBy = options.groupBy || [];
  const selectGroups = groupBy.length > 0 ? groupBy.map(groupSelect).join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.map(groupKey).join(", ")}` : "";

  let sql = `
    SELECT ${selectGroups}${selectMetrics}
    FROM read_parquet('${pattern}', union_by_name = true)
    WHERE ${whereClause}
    ${groupByClause}
  `;

  sql += buildOrderBy(options.orderBy, groupBy);

  if (options.limit) {
    sql += ` LIMIT ${options.limit}`;
  }

  return query<T>(sql);
}

/**
 * Query no cubo de ICSAP com agregação flexível
 */
export async function queryIcsap<T = Record<string, unknown>>(options: {
  filters?: IcsapFilters;
  groupBy?: string[];
  metrics?: ("n" | "n_total" | "days" | "value" | "deaths")[];
  orderBy?: string;
  limit?: number;
  universe?: IcsapUniverse;
}): Promise<T[]> {
  // 0.9.0: toda agregação do cubo ICSAP passa por icsapAggregateSql (o
  // denominador por estratos distintos); `metrics` fica só pela assinatura —
  // as seis medidas saem sempre.
  return query<T>(icsapAggregateSql(options));
}

/** Chaves do ESTRATO do cubo ICSAP: `n_total` é o total do estrato, repetido em cada linha dele. */
// `exclusion` (builder >= 2.6.0) é chave do estrato: sem ela, dois estratos que
// só diferem no motivo de exclusão e têm o mesmo n_total colapsariam no
// DISTINCT (2023/RR com universe = "all" dava 48.122 em vez de 48.480).
const ICSAP_STRATUM_KEYS = ["year", "uf", "municipality_code", "cid_revision", "sex", "age", "race", "exclusion"];

/**
 * SQL de agregação do cubo ICSAP com o denominador CERTO.
 *
 * O cubo tem uma linha por (estrato × grupo CSAP) e, desde o builder 2.5.0,
 * uma linha por estrato SEM ICSAP (csap_group nulo, n = 0); em todas,
 * `n_total` é o total de internações do estrato (year, uf, municipality_code,
 * cid_revision, sex, age, race). Até a 0.8.0 o servidor somava n_total linha
 * a linha: o denominador saía multiplicado pelo número de grupos CSAP de cada
 * estrato e sem os estratos que não tinham ICSAP nenhuma — 2023/RR dava
 * icsap_percentage 3,65 % quando 9.577/48.480 = 19,75 % (defeito desde a
 * primeira versão do cubo; achado em 07/09/2026 ao provar a era antiga e
 * corrigido aqui, no funil, antes do rebuild dos 34 anos). O denominador é
 * n_total somado sobre os estratos DISTINTOS; o numerador ignora as linhas de
 * grupo nulo; o filtro por grupo CSAP só vale para o numerador (a fração é
 * "internações do grupo / todas as internações do estrato").
 */
/**
 * Universo do % ICSAP. "csapaih" (padrão, 0.10.0): como o pacote R csapAIH,
 * fora do numerador E do denominador as internações com `exclusion` não nula
 * (procedimento obstétrico, parto, longa permanência — builder >= 2.6.0).
 * "all": todas as internações. Cubo anterior a 2.6.0 não tem a coluna: com
 * union_by_name ela vem nula, o que equivale a "all" naquele ano.
 */
export type IcsapUniverse = "csapaih" | "all";

function universeCondition(universe: IcsapUniverse | undefined): string {
  return (universe ?? "csapaih") === "csapaih" ? "AND exclusion IS NULL" : "";
}

function icsapAggregateSql(options: {
  filters?: IcsapFilters;
  groupBy?: string[];
  orderBy?: string;
  limit?: number;
  universe?: IcsapUniverse;
}): string {
  const pattern = getParquetPattern("icsap");
  const { csapGroups, ...strataFilters } = options.filters ?? {};
  const whereStrata = `${buildWhereClause(strataFilters)} ${universeCondition(options.universe)}`;
  const csapCond =
    csapGroups && csapGroups.length > 0 ? `AND csap_group IN (${csapGroups.map((g) => `'${g}'`).join(", ")})` : "";
  const groupBy = options.groupBy ?? [];
  const byGroup = groupBy.includes("csap_group");
  const strataGroup = groupBy.filter((g) => g !== "csap_group");
  const groupClause = (cols: string[]) => (cols.length > 0 ? `GROUP BY ${cols.join(", ")}` : "");
  const joinOn =
    strataGroup.length > 0 ? strataGroup.map((k) => `icsap.${k} IS NOT DISTINCT FROM total.${k}`).join(" AND ") : "TRUE";
  // Sem csap_group no agrupamento, a linha-mestre é a de total: um grupo com
  // estratos mas sem ICSAP ainda aparece, com 0. Com csap_group, é a de ICSAP.
  const fromClause = byGroup ? `icsap JOIN total ON ${joinOn}` : `total LEFT JOIN icsap ON ${joinOn}`;
  const selectCols = groupBy
    .map((g) => (byGroup || g === "csap_group" ? `icsap.${g} AS ${g}` : `total.${g} AS ${g}`))
    .join(", ");
  const strataKeys = ICSAP_STRATUM_KEYS.map(groupSelect);

  let sql = `
    WITH linhas AS (
      SELECT * FROM read_parquet('${pattern}', union_by_name = true)
      WHERE ${whereStrata}
    ),
    estratos AS (SELECT DISTINCT ${strataKeys.join(", ")}, n_total FROM linhas),
    total AS (
      SELECT ${strataGroup.length > 0 ? strataGroup.join(", ") + ", " : ""}SUM(n_total) AS n_total
      FROM estratos ${groupClause(strataGroup)}
    ),
    icsap AS (
      SELECT ${groupBy.length > 0 ? groupBy.map(groupSelect).join(", ") + ", " : ""}SUM(n) AS n_icsap, SUM(days) AS total_days, SUM(CAST(value AS DECIMAL(18,2))) AS total_value, SUM(deaths) AS deaths
      FROM linhas
      WHERE csap_group IS NOT NULL ${csapCond}
      ${groupClause(groupBy.map(groupKey))}
    )
    SELECT ${selectCols}${groupBy.length > 0 ? ", " : ""}
      COALESCE(icsap.n_icsap, 0) AS n_icsap,
      total.n_total AS n_total,
      ROUND(COALESCE(icsap.n_icsap, 0) * 100.0 / NULLIF(total.n_total, 0), 2) AS icsap_percentage,
      COALESCE(icsap.total_days, 0) AS total_days,
      COALESCE(icsap.total_value, 0) AS total_value,
      COALESCE(icsap.deaths, 0) AS deaths
    FROM ${fromClause}
  `;
  sql += buildOrderBy(options.orderBy, groupBy);
  if (options.limit) sql += ` LIMIT ${options.limit}`;
  return sql;
}

/**
 * Query no cubo de séries temporais
 */
export async function querySeries<T = Record<string, unknown>>(options: {
  filters?: SeriesFilters;
  groupBy?: string[];
  orderBy?: string;
}): Promise<T[]> {
  const pattern = getParquetPattern("series");
  const conditions: string[] = [];

  if (options.filters) {
    if (options.filters.yearMonthStart) {
      conditions.push(`year_month >= '${options.filters.yearMonthStart}'`);
    }
    if (options.filters.yearMonthEnd) {
      conditions.push(`year_month <= '${options.filters.yearMonthEnd}'`);
    }
    if (options.filters.ufs && options.filters.ufs.length > 0) {
      const ufs = options.filters.ufs.map((u) => `'${u}'`).join(", ");
      conditions.push(`uf IN (${ufs})`);
    }
    if (options.filters.cidChapters && options.filters.cidChapters.length > 0) {
      conditions.push(`cid_chapter IN (${options.filters.cidChapters.join(", ")})`);
    }
  }

  const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";

  // Group by
  const groupBy = options.groupBy || [];
  const selectGroups = groupBy.length > 0 ? groupBy.map(groupSelect).join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.map(groupKey).join(", ")}` : "";

  let sql = `
    SELECT ${selectGroups}SUM(n) as n, SUM(deaths) as deaths
    FROM read_parquet('${pattern}', union_by_name = true)
    WHERE ${whereClause}
    ${groupByClause}
  `;

  sql += buildOrderBy(options.orderBy, groupBy);

  return query<T>(sql);
}

/**
 * Query para ranking de grupos CSAP
 */
export async function rankCsapGroups<T = Record<string, unknown>>(options: {
  filters?: IcsapFilters;
  metric?: "n" | "days" | "value" | "deaths";
  limit?: number;
  universe?: IcsapUniverse;
}): Promise<T[]> {
  const pattern = getParquetPattern("icsap");
  const whereClause = `${buildWhereClause(options.filters || {})} ${universeCondition(options.universe)}`;
  const metric = options.metric || "n";

  const metricsMap: Record<string, string> = {
    n: "SUM(n)",
    days: "SUM(days)",
    value: "SUM(CAST(value AS DECIMAL(18,2)))",
    deaths: "SUM(deaths)",
  };

  const sql = `
    SELECT
      csap_group,
      ${metricsMap[metric]} as metric_value,
      SUM(n) as n_hospitalizations,
      SUM(days) as total_days,
      SUM(CAST(value AS DECIMAL(18,2))) as total_value,
      SUM(deaths) as deaths
    FROM read_parquet('${pattern}', union_by_name = true)
    WHERE ${whereClause} AND csap_group IS NOT NULL
    GROUP BY csap_group
    ORDER BY metric_value DESC, csap_group
    ${options.limit ? `LIMIT ${options.limit}` : ""}
  `;

  return query<T>(sql);
}

/**
 * Calcula indicadores de ICSAP (percentual)
 */
export async function calculateIcsapIndicators<T = Record<string, unknown>>(options: {
  filters?: IcsapFilters;
  groupBy?: string[];
  universe?: IcsapUniverse;
}): Promise<T[]> {
  // 0.9.0: denominador por estratos distintos (ver icsapAggregateSql)
  return query<T>(icsapAggregateSql({ filters: options.filters, groupBy: options.groupBy, universe: options.universe }));
}

// =============================================================================
// FUNÇÕES DE POPULAÇÃO
// =============================================================================

/**
 * Onde os arquivos de população vivem (0.12.0, sih:populacao-no-canal): a
 * pasta configurada (SIH_DATA_DIR ou data/ do projeto; nunca data/test/) tem
 * precedência sempre que tiver pop_uf.parquet — é o caso da fixture do smoke
 * e do golden e de quem gerou a população à mão; sem nada nela e com o cache
 * ligado, o cache local, que `ensurePopulation()` (src/cache.ts) enche a
 * partir do canal sih/cubos/ (pop_uf, pop_uf_agregado, pop_municipios +
 * pop_provenance.json, assinados no bloco `population` do manifesto).
 */
export function getPopulationDir(): string {
  if (existsSync(join(DATA_DIR, "pop_uf.parquet"))) return DATA_DIR;
  if (CUBES_CACHE_ENABLED) return cubesCacheDir();
  return DATA_DIR;
}

/** Padrão de arquivo para dados populacionais (pasta de getPopulationDir()). */
export function getPopulationPattern(type: "municipios" | "uf" | "uf_agregado"): string {
  const filename = type === "municipios" ? "pop_municipios.parquet" :
                   type === "uf" ? "pop_uf.parquet" :
                   "pop_uf_agregado.parquet";
  return join(getPopulationDir(), filename).replace(/\\/g, "/");
}

/** Verifica se algum arquivo de população está disponível em getPopulationDir(). */
export function hasPopulationData(): boolean {
  try {
    const dir = getPopulationDir();
    if (!existsSync(dir)) return false;
    const files = readdirSync(dir);
    return files.some(f => f.startsWith("pop_") && f.endsWith(".parquet"));
  } catch {
    return false;
  }
}

/** Mensagem única para "sem denominador" — aponta o canal, não um script R. */
export const POPULATION_MISSING_MESSAGE =
  `Dados populacionais não disponíveis: nem pop_uf.parquet na pasta de dados nem no cache local. Com o cache ligado o servidor baixa pop_uf, pop_uf_agregado e pop_municipios de ${CUBES_BASE_URL} (bloco population do manifest.json); confira a rede ou a variável SIH_CUBES_CACHE.`;

/**
 * Interface para filtros de população
 */
export interface PopulationFilters {
  years?: number[];
  ufs?: string[];
  sex?: string;
  ageMin?: number;
  ageMax?: number;
}

/**
 * Constrói cláusula WHERE para população UF
 */
function buildPopulationWhereClause(filters: PopulationFilters): string {
  const conditions: string[] = [];

  if (filters.years && filters.years.length > 0) {
    conditions.push(`year IN (${filters.years.join(", ")})`);
  }

  if (filters.ufs && filters.ufs.length > 0) {
    const ufs = filters.ufs.map((u) => `'${u}'`).join(", ");
    conditions.push(`uf IN (${ufs})`);
  }

  if (filters.sex) {
    conditions.push(`sex = '${filters.sex}'`);
  }

  if (filters.ageMin !== undefined) {
    conditions.push(`age >= ${filters.ageMin}`);
  }

  if (filters.ageMax !== undefined) {
    conditions.push(`age <= ${filters.ageMax}`);
  }

  return conditions.length > 0 ? conditions.join(" AND ") : "1=1";
}

/**
 * Query população por UF (dados com idade simples)
 */
export async function queryPopulationUf<T = Record<string, unknown>>(options: {
  filters?: PopulationFilters;
  groupBy?: string[];
}): Promise<T[]> {
  const pattern = getPopulationPattern("uf");
  const whereClause = buildPopulationWhereClause(options.filters || {});

  const groupBy = options.groupBy || [];
  const selectGroups = groupBy.length > 0 ? groupBy.map(groupSelect).join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.map(groupKey).join(", ")}` : "";

  const sql = `
    SELECT
      ${selectGroups}
      SUM(population) as population
    FROM read_parquet('${pattern}', union_by_name = true)
    WHERE ${whereClause}
    ${groupByClause}${buildOrderBy(undefined, groupBy)}
  `;

  return query<T>(sql);
}

/**
 * Query população agregada por UF (para anos 1991-1999, com faixa etária)
 */
export async function queryPopulationUfAgregado<T = Record<string, unknown>>(options: {
  years?: number[];
  ufs?: string[];
  sex?: string;
  /** Faixas de AGGREGATED_AGE_GROUPS; sem isto, todas — inclusive a idade ignorada (age_group nulo), que faz parte do total. */
  ageGroups?: string[];
  groupBy?: string[];
}): Promise<T[]> {
  const pattern = getPopulationPattern("uf_agregado");
  const conditions: string[] = [];

  if (options.years && options.years.length > 0) {
    conditions.push(`year IN (${options.years.join(", ")})`);
  }

  if (options.ageGroups && options.ageGroups.length > 0) {
    // As linhas de idade ignorada (age_group nulo; POPBR "I000") ficam fora de
    // qualquer recorte etário — e dentro do total, que só bate com a
    // estimativa do IBGE com elas (Brasil 1993: 151.556.521).
    conditions.push(`age_group IN (${options.ageGroups.map((g) => `'${g}'`).join(", ")})`);
  }

  if (options.ufs && options.ufs.length > 0) {
    const ufs = options.ufs.map((u) => `'${u}'`).join(", ");
    conditions.push(`uf IN (${ufs})`);
  }

  if (options.sex) {
    conditions.push(`sex = '${options.sex}'`);
  }

  const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";

  const groupBy = options.groupBy || [];
  const selectGroups = groupBy.length > 0 ? groupBy.map(groupSelect).join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.map(groupKey).join(", ")}` : "";

  const sql = `
    SELECT
      ${selectGroups}
      SUM(population) as population
    FROM read_parquet('${pattern}', union_by_name = true)
    WHERE ${whereClause}
    ${groupByClause}${buildOrderBy(undefined, groupBy)}
  `;

  return query<T>(sql);
}

/**
 * Verifica se pop_uf.parquet existe
 */
function hasPopUf(): boolean {
  const path = join(getPopulationDir(), "pop_uf.parquet");
  return existsSync(path);
}

/** Intervalo de anos de um arquivo de população, lido do próprio arquivo. */
async function yearRangeOf(file: string): Promise<{ first_year: number; last_year: number } | null> {
  const path = join(getPopulationDir(), file);
  if (!existsSync(path)) return null;
  const rows = await query<{ first_year: number; last_year: number }>(
    `SELECT CAST(min(year) AS INTEGER) AS first_year, CAST(max(year) AS INTEGER) AS last_year FROM read_parquet('${path.replace(/\\/g, "/")}')`
  );
  const r = rows[0];
  return r && r.first_year != null && r.last_year != null
    ? { first_year: Number(r.first_year), last_year: Number(r.last_year) }
    : null;
}

/** Faixas etárias quinquenais de pop_uf_agregado.parquet (1991–1999), na ordem. */
export const AGGREGATED_AGE_GROUPS = [
  "0-4", "5-9", "10-14", "15-19", "20-24", "25-29", "30-34", "35-39", "40-44",
  "45-49", "50-54", "55-59", "60-64", "65-69", "70-74", "75-79", "80 e +",
];

/**
 * Faixas de pop_uf_agregado.parquet que cobrem EXATAMENTE [ageMin, ageMax].
 * Devolve null quando o intervalo não cai nos limites das faixas (ex.: 0–14
 * serve, 0–17 não): antes de 2000 só há população por faixa quinquenal, e uma
 * taxa com denominador aproximado seria número errado com cara de certo.
 * Sem filtro de idade devolve undefined (todas as faixas).
 */
export function aggregatedAgeGroupsFor(ageMin?: number, ageMax?: number): string[] | null | undefined {
  if (ageMin === undefined && ageMax === undefined) return undefined;
  const lo = ageMin ?? 0;
  const hi = ageMax ?? Infinity;
  if (lo % 5 !== 0) return null;
  if (hi !== Infinity && hi < 79 && (hi + 1) % 5 !== 0) return null;
  const out: string[] = [];
  for (const g of AGGREGATED_AGE_GROUPS) {
    const start = parseInt(g, 10);
    const end = g === "80 e +" ? Infinity : start + 4;
    if (start >= lo && end <= hi) out.push(g);
    else if (start >= lo && g === "80 e +" && hi >= 80) out.push(g);
  }
  if (hi !== Infinity && hi >= 80 && hi < Infinity && !out.includes("80 e +")) return null;
  return out.length > 0 ? out : null;
}

export interface PopulationCoverage {
  /** União dos dois arquivos: o que as ferramentas de taxa aceitam. */
  first_year: number;
  last_year: number;
  /** pop_uf.parquet — idade simples por UF e sexo (projeções IBGE, 2000+). */
  detailed: { first_year: number; last_year: number; source: string; age: string } | null;
  /** pop_uf_agregado.parquet — faixa etária quinquenal por UF e sexo (1991–1999). */
  aggregated: { first_year: number; last_year: number; source: string; age: string; age_groups: string[] } | null;
}

let popCoverageCache: PopulationCoverage | null | undefined;

/**
 * Esquece a cobertura memoizada — chamada depois que ensurePopulation() baixa
 * algum arquivo: uma chamada anterior pode ter memoizado `null` (sem
 * população) antes do download.
 */
export function resetPopulationCoverageCache(): void {
  popCoverageCache = undefined;
}

/**
 * Cobertura populacional, lida dos próprios arquivos — nunca fixada no código.
 * `first_year`/`last_year` é a união de pop_uf.parquet (idade simples, 2000+;
 * a regra do CONTEXT.md diz que vai até o último ano de cubo FECHADO do SIH,
 * e quem a cumpre é o build-population.R do healthbr-data) e de pop_uf_agregado.parquet
 * (faixa etária, 1991–1999; sih:taxas-1992-1999). Antes de 2000 a taxa por
 * idade só sai nas faixas do arquivo (aggregatedAgeGroupsFor). Devolve null
 * sem nenhum dos dois arquivos.
 */
export async function getPopulationCoverage(): Promise<PopulationCoverage | null> {
  if (popCoverageCache !== undefined) return popCoverageCache;
  const detailed = await yearRangeOf("pop_uf.parquet");
  const aggregated = await yearRangeOf("pop_uf_agregado.parquet");
  if (!detailed && !aggregated) {
    popCoverageCache = null;
    return null;
  }
  const ranges = [detailed, aggregated].filter((r): r is NonNullable<typeof r> => !!r);
  popCoverageCache = {
    first_year: Math.min(...ranges.map((r) => r.first_year)),
    last_year: Math.max(...ranges.map((r) => r.last_year)),
    detailed: detailed ? { ...detailed, source: "pop_uf.parquet", age: "idade simples" } : null,
    aggregated: aggregated
      ? { ...aggregated, source: "pop_uf_agregado.parquet", age: "faixa etária quinquenal", age_groups: AGGREGATED_AGE_GROUPS }
      : null,
  };
  return popCoverageCache;
}

/** Qual arquivo de população serve a um ano (null = nenhum). */
export async function populationSourceFor(year: number): Promise<"detailed" | "aggregated" | null> {
  const c = await getPopulationCoverage();
  if (!c) return null;
  if (c.detailed && year >= c.detailed.first_year && year <= c.detailed.last_year) return "detailed";
  if (c.aggregated && year >= c.aggregated.first_year && year <= c.aggregated.last_year) return "aggregated";
  return null;
}

/**
 * Compatibilidade: o intervalo aceito pelas taxas (união dos dois arquivos).
 * Devolve null sem população.
 */
export async function getPopulationYearRange(): Promise<{ first_year: number; last_year: number } | null> {
  const c = await getPopulationCoverage();
  return c ? { first_year: c.first_year, last_year: c.last_year } : null;
}

/**
 * Query população de pop_municipios.parquet agregando por UF
 */
async function queryPopulationFromMunicipios<T = Record<string, unknown>>(options: {
  years?: number[];
  ufs?: string[];
  sex?: string;
  groupBy?: string[];
}): Promise<T[]> {
  const pattern = getPopulationPattern("municipios");
  const conditions: string[] = [];

  if (options.years && options.years.length > 0) {
    conditions.push(`year IN (${options.years.join(", ")})`);
  }

  if (options.ufs && options.ufs.length > 0) {
    const ufs = options.ufs.map((u) => `'${u}'`).join(", ");
    conditions.push(`uf IN (${ufs})`);
  }

  if (options.sex) {
    conditions.push(`sex = '${options.sex}'`);
  }

  const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";

  const groupBy = options.groupBy || [];
  const selectGroups = groupBy.length > 0 ? groupBy.map(groupSelect).join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.map(groupKey).join(", ")}` : "";

  const sql = `
    SELECT
      ${selectGroups}
      SUM(population) as population
    FROM read_parquet('${pattern}', union_by_name = true)
    WHERE ${whereClause}
    ${groupByClause}${buildOrderBy(undefined, groupBy)}
  `;

  return query<T>(sql);
}

/**
 * Obtém população total para um filtro específico.
 * Hierarquia de fontes:
 *   1. pop_uf.parquet (idade simples, anos >= 2000)
 *   2. pop_uf_agregado.parquet (faixa etária, anos 1991-1999)
 *   3. pop_municipios.parquet (fallback, agregando por UF)
 */
export async function getPopulation(options: {
  year: number;
  uf?: string[];
  sex?: string;
  ageMin?: number;
  ageMax?: number;
}): Promise<number> {
  if (!hasPopulationData()) {
    throw new Error(POPULATION_MISSING_MESSAGE);
  }

  // Tenta pop_uf.parquet para anos >= 2000 (idade simples)
  if (options.year >= 2000 && hasPopUf()) {
    const result = await queryPopulationUf<{ population: number }>({
      filters: {
        years: [options.year],
        ufs: options.uf,
        sex: options.sex,
        ageMin: options.ageMin,
        ageMax: options.ageMax,
      },
    });
    if (result[0]?.population) return result[0].population;
  }

  // pop_uf_agregado.parquet para anos < 2000 (sih:taxas-1992-1999): idade só
  // nas faixas do arquivo — intervalo fora dos limites das faixas é erro, não
  // aproximação; e com filtro de idade não há fallback para os municípios,
  // que não têm idade.
  if (options.year < 2000) {
    const ageGroups = aggregatedAgeGroupsFor(options.ageMin, options.ageMax);
    if (ageGroups === null) {
      throw new Error(
        `Antes de 2000 a população por UF só existe em faixas etárias quinquenais (${AGGREGATED_AGE_GROUPS.join(", ")}): ` +
          `o intervalo de idade ${options.ageMin ?? 0}–${options.ageMax ?? "+"} não cai nos limites das faixas. Use age_min múltiplo de 5 e age_max terminado em 4 ou 9 (ou 80+).`,
      );
    }
    const result = await queryPopulationUfAgregado<{ population: number }>({
      years: [options.year],
      ufs: options.uf,
      sex: options.sex,
      ageGroups,
    });
    if (result[0]?.population) return result[0].population;
    if (ageGroups) return 0;
  }

  // Fallback: pop_municipios.parquet (agregando por UF)
  const result = await queryPopulationFromMunicipios<{ population: number }>({
    years: [options.year],
    ufs: options.uf,
    sex: options.sex,
  });
  return result[0]?.population || 0;
}

/**
 * Obtém população por UF para um ano.
 * Usa pop_uf.parquet se disponível, senão agrega pop_municipios.parquet.
 */
export async function getPopulationByUf(options: {
  year: number;
  sex?: string;
  ageMin?: number;
  ageMax?: number;
}): Promise<Record<string, number>> {
  if (!hasPopulationData()) {
    throw new Error(POPULATION_MISSING_MESSAGE);
  }

  let result: Array<{ uf: string; population: number }>;

  if (options.year >= 2000 && hasPopUf()) {
    result = await queryPopulationUf<{ uf: string; population: number }>({
      filters: {
        years: [options.year],
        sex: options.sex,
        ageMin: options.ageMin,
        ageMax: options.ageMax,
      },
      groupBy: ["uf"],
    });
  } else if (options.year < 2000) {
    const ageGroups = aggregatedAgeGroupsFor(options.ageMin, options.ageMax);
    if (ageGroups === null) {
      throw new Error(
        `Antes de 2000 a população por UF só existe em faixas etárias quinquenais (${AGGREGATED_AGE_GROUPS.join(", ")}): ` +
          `o intervalo de idade ${options.ageMin ?? 0}–${options.ageMax ?? "+"} não cai nos limites das faixas.`,
      );
    }
    try {
      result = await queryPopulationUfAgregado<{ uf: string; population: number }>({
        years: [options.year],
        sex: options.sex,
        ageGroups,
        groupBy: ["uf"],
      });
    } catch {
      if (ageGroups) throw new Error("pop_uf_agregado.parquet indisponível: sem população por faixa etária antes de 2000.");
      // Fallback (sem idade)
      result = await queryPopulationFromMunicipios<{ uf: string; population: number }>({
        years: [options.year],
        sex: options.sex,
        groupBy: ["uf"],
      });
    }
  } else {
    // Fallback: pop_municipios.parquet agregado por UF
    result = await queryPopulationFromMunicipios<{ uf: string; population: number }>({
      years: [options.year],
      sex: options.sex,
      groupBy: ["uf"],
    });
  }

  const byUf: Record<string, number> = {};
  for (const row of result) {
    byUf[row.uf] = row.population;
  }
  return byUf;
}
