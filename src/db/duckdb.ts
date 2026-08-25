/**
 * Módulo de conexão DuckDB para consulta aos cubos de dados Parquet
 * Suporta múltiplos arquivos Parquet por ano (sih_causas_YYYY.parquet)
 */

import duckdb from "duckdb";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, readdirSync } from "fs";

// Tipos do DuckDB
type Database = InstanceType<typeof duckdb.Database>;
type Connection = ReturnType<Database["connect"]>;

// Obtém diretório do projeto
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const TEST_DATA_DIR = join(DATA_DIR, "test");

// Singleton do banco de dados
let db: Database | null = null;
let conn: Connection | null = null;

// Detecta se estamos em modo teste (data/test tem arquivos)
let dataDirectory: string | null = null;

/**
 * Determina qual diretório de dados usar.
 * - Padrão: data/ (dados reais)
 * - Teste: data/test/ (somente se SIH_TEST_MODE=1 estiver definido)
 */
function getDataDirectory(): string {
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

  throw new Error(
    `Nenhum arquivo SIH Parquet encontrado em ${DATA_DIR}. Execute os scripts R de agregação primeiro.`
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
export async function getDatabase(): Promise<Connection> {
  if (conn) {
    return conn;
  }

  return new Promise((resolve, reject) => {
    // Usa banco em memória (consultas diretas aos Parquet)
    db = new duckdb.Database(":memory:", (err) => {
      if (err) {
        reject(new Error(`Erro ao criar banco DuckDB: ${err.message}`));
        return;
      }

      conn = db!.connect();

      // Configura DuckDB para melhor performance com Parquet
      conn.run("SET threads TO 4", (err) => {
        if (err) console.error("Aviso: não foi possível configurar threads");
      });

      resolve(conn);
    });
  });
}

/**
 * Fecha conexão com o banco
 */
export async function closeDatabase(): Promise<void> {
  return new Promise((resolve) => {
    if (conn) {
      conn = null;
    }
    if (db) {
      db.close(() => {
        db = null;
        dataDirectory = null; // Reset para próxima conexão
        resolve();
      });
    } else {
      resolve();
    }
  });
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

  return new Promise((resolve, reject) => {
    connection.all(sql, (err, rows) => {
      if (err) {
        reject(new Error(`Erro na query: ${err.message}\nSQL: ${sql}`));
        return;
      }
      // Converte BigInt para Number para serialização JSON
      const convertedRows = convertBigIntToNumber(rows || []) as T[];
      resolve(convertedRows);
    });
  });
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
    value: "SUM(value) as total_value",
    deaths: "SUM(deaths) as deaths",
  };

  const metrics = options.metrics || ["n"];
  const selectMetrics = metrics.map((m) => metricsMap[m]).join(", ");

  // Group by
  const groupBy = options.groupBy || [];
  const selectGroups = groupBy.length > 0 ? groupBy.join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.join(", ")}` : "";

  let sql = `
    SELECT ${selectGroups}${selectMetrics}
    FROM read_parquet('${pattern}')
    WHERE ${whereClause}
    ${groupByClause}
  `;

  if (options.orderBy) {
    sql += ` ORDER BY ${options.orderBy}`;
  }

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
}): Promise<T[]> {
  const pattern = getParquetPattern("icsap");
  const whereClause = buildWhereClause(options.filters || {});

  // Métricas a calcular
  const metricsMap: Record<string, string> = {
    n: "SUM(n) as n_icsap",
    n_total: "SUM(n_total) as n_total",
    days: "SUM(days) as total_days",
    value: "SUM(value) as total_value",
    deaths: "SUM(deaths) as deaths",
  };

  const metrics = options.metrics || ["n", "n_total"];
  const selectMetrics = metrics.map((m) => metricsMap[m]).join(", ");

  // Group by
  const groupBy = options.groupBy || [];
  const selectGroups = groupBy.length > 0 ? groupBy.join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.join(", ")}` : "";

  let sql = `
    SELECT ${selectGroups}${selectMetrics}
    FROM read_parquet('${pattern}')
    WHERE ${whereClause}
    ${groupByClause}
  `;

  if (options.orderBy) {
    sql += ` ORDER BY ${options.orderBy}`;
  }

  if (options.limit) {
    sql += ` LIMIT ${options.limit}`;
  }

  return query<T>(sql);
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
  const selectGroups = groupBy.length > 0 ? groupBy.join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.join(", ")}` : "";

  let sql = `
    SELECT ${selectGroups}SUM(n) as n, SUM(deaths) as deaths
    FROM read_parquet('${pattern}')
    WHERE ${whereClause}
    ${groupByClause}
  `;

  if (options.orderBy) {
    sql += ` ORDER BY ${options.orderBy}`;
  } else if (groupBy.includes("year_month")) {
    sql += ` ORDER BY year_month`;
  }

  return query<T>(sql);
}

/**
 * Query para ranking de grupos CSAP
 */
export async function rankCsapGroups<T = Record<string, unknown>>(options: {
  filters?: IcsapFilters;
  metric?: "n" | "days" | "value" | "deaths";
  limit?: number;
}): Promise<T[]> {
  const pattern = getParquetPattern("icsap");
  const whereClause = buildWhereClause(options.filters || {});
  const metric = options.metric || "n";

  const metricsMap: Record<string, string> = {
    n: "SUM(n)",
    days: "SUM(days)",
    value: "SUM(value)",
    deaths: "SUM(deaths)",
  };

  const sql = `
    SELECT
      csap_group,
      ${metricsMap[metric]} as metric_value,
      SUM(n) as n_hospitalizations,
      SUM(days) as total_days,
      SUM(value) as total_value,
      SUM(deaths) as deaths
    FROM read_parquet('${pattern}')
    WHERE ${whereClause}
    GROUP BY csap_group
    ORDER BY metric_value DESC
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
}): Promise<T[]> {
  const pattern = getParquetPattern("icsap");
  const whereClause = buildWhereClause(options.filters || {});

  const groupBy = options.groupBy || [];
  const selectGroups = groupBy.length > 0 ? groupBy.join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.join(", ")}` : "";

  const sql = `
    SELECT
      ${selectGroups}
      SUM(n) as n_icsap,
      SUM(n_total) as n_total,
      ROUND(SUM(n) * 100.0 / NULLIF(SUM(n_total), 0), 2) as icsap_percentage,
      SUM(days) as total_days,
      SUM(value) as total_value,
      SUM(deaths) as deaths
    FROM read_parquet('${pattern}')
    WHERE ${whereClause}
    ${groupByClause}
  `;

  return query<T>(sql);
}

// =============================================================================
// FUNÇÕES DE POPULAÇÃO
// =============================================================================

/**
 * Retorna padrão de arquivo para dados populacionais.
 * Dados populacionais ficam SEMPRE em data/ (não em data/test/).
 */
export function getPopulationPattern(type: "municipios" | "uf" | "uf_agregado"): string {
  const filename = type === "municipios" ? "pop_municipios.parquet" :
                   type === "uf" ? "pop_uf.parquet" :
                   "pop_uf_agregado.parquet";
  return join(DATA_DIR, filename).replace(/\\/g, "/");
}

/**
 * Verifica se dados populacionais estão disponíveis.
 * Busca em data/ (não data/test/).
 */
export function hasPopulationData(): boolean {
  try {
    if (!existsSync(DATA_DIR)) return false;
    const files = readdirSync(DATA_DIR);
    return files.some(f => f.startsWith("pop_"));
  } catch {
    return false;
  }
}

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
  const selectGroups = groupBy.length > 0 ? groupBy.join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.join(", ")}` : "";

  const sql = `
    SELECT
      ${selectGroups}
      SUM(population) as population
    FROM read_parquet('${pattern}')
    WHERE ${whereClause}
    ${groupByClause}
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
  groupBy?: string[];
}): Promise<T[]> {
  const pattern = getPopulationPattern("uf_agregado");
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
  const selectGroups = groupBy.length > 0 ? groupBy.join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.join(", ")}` : "";

  const sql = `
    SELECT
      ${selectGroups}
      SUM(population) as population
    FROM read_parquet('${pattern}')
    WHERE ${whereClause}
    ${groupByClause}
  `;

  return query<T>(sql);
}

/**
 * Verifica se pop_uf.parquet existe
 */
function hasPopUf(): boolean {
  const path = join(DATA_DIR, "pop_uf.parquet");
  return existsSync(path);
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
  const selectGroups = groupBy.length > 0 ? groupBy.join(", ") + ", " : "";
  const groupByClause = groupBy.length > 0 ? `GROUP BY ${groupBy.join(", ")}` : "";

  const sql = `
    SELECT
      ${selectGroups}
      SUM(population) as population
    FROM read_parquet('${pattern}')
    WHERE ${whereClause}
    ${groupByClause}
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
    throw new Error("Dados populacionais não disponíveis. Execute build_population.R primeiro.");
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

  // Tenta pop_uf_agregado.parquet para anos < 2000
  if (options.year < 2000) {
    try {
      const result = await queryPopulationUfAgregado<{ population: number }>({
        years: [options.year],
        ufs: options.uf,
        sex: options.sex,
      });
      if (result[0]?.population) return result[0].population;
    } catch {
      // Continua para fallback
    }
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
    throw new Error("Dados populacionais não disponíveis. Execute build_population.R primeiro.");
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
    try {
      result = await queryPopulationUfAgregado<{ uf: string; population: number }>({
        years: [options.year],
        sex: options.sex,
        groupBy: ["uf"],
      });
    } catch {
      // Fallback
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
