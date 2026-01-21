/**
 * Módulo de conexão DuckDB para consulta aos cubos de dados Parquet
 */

import duckdb from "duckdb";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

// Tipos do DuckDB
type Database = InstanceType<typeof duckdb.Database>;
type Connection = ReturnType<Database["connect"]>;

// Obtém diretório do projeto
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(PROJECT_ROOT, "data");

// Singleton do banco de dados
let db: Database | null = null;
let conn: Connection | null = null;

// Caminhos dos arquivos Parquet
export const PARQUET_FILES = {
  causas: join(DATA_DIR, "sih_causas.parquet"),
  series: join(DATA_DIR, "sih_series.parquet"),
  icsap: join(DATA_DIR, "sih_icsap.parquet"),
  populacao: join(DATA_DIR, "populacao_municipios.parquet"),
};

/**
 * Verifica se os arquivos Parquet existem
 */
export function checkDataFiles(): { available: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const [name, path] of Object.entries(PARQUET_FILES)) {
    if (!existsSync(path)) {
      missing.push(name);
    }
  }

  return {
    available: missing.length === 0,
    missing,
  };
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
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * Executa query SQL e retorna resultados
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const connection = await getDatabase();

  return new Promise((resolve, reject) => {
    connection.all(sql, ...params, (err, rows) => {
      if (err) {
        reject(new Error(`Erro na query: ${err.message}`));
        return;
      }
      resolve(rows as T[]);
    });
  });
}

/**
 * Executa query no cubo de causas (sih_causas.parquet)
 */
export async function queryCausas<T = Record<string, unknown>>(
  whereClause: string = "",
  groupBy: string[] = [],
  orderBy: string = "",
  limit?: number
): Promise<T[]> {
  const { available, missing } = checkDataFiles();
  if (!available) {
    throw new Error(`Arquivos Parquet não encontrados: ${missing.join(", ")}`);
  }

  let sql = `SELECT * FROM read_parquet('${PARQUET_FILES.causas}')`;

  if (whereClause) {
    sql += ` WHERE ${whereClause}`;
  }

  if (groupBy.length > 0) {
    sql += ` GROUP BY ${groupBy.join(", ")}`;
  }

  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }

  if (limit) {
    sql += ` LIMIT ${limit}`;
  }

  return query<T>(sql);
}

/**
 * Executa query no cubo de séries temporais (sih_series.parquet)
 */
export async function querySeries<T = Record<string, unknown>>(
  whereClause: string = "",
  orderBy: string = "year_month ASC"
): Promise<T[]> {
  const { available, missing } = checkDataFiles();
  if (!available) {
    throw new Error(`Arquivos Parquet não encontrados: ${missing.join(", ")}`);
  }

  let sql = `SELECT * FROM read_parquet('${PARQUET_FILES.series}')`;

  if (whereClause) {
    sql += ` WHERE ${whereClause}`;
  }

  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }

  return query<T>(sql);
}

/**
 * Executa query no cubo de ICSAP (sih_icsap.parquet)
 */
export async function queryIcsap<T = Record<string, unknown>>(
  whereClause: string = "",
  groupBy: string[] = [],
  orderBy: string = ""
): Promise<T[]> {
  const { available, missing } = checkDataFiles();
  if (!available) {
    throw new Error(`Arquivos Parquet não encontrados: ${missing.join(", ")}`);
  }

  let sql = `SELECT * FROM read_parquet('${PARQUET_FILES.icsap}')`;

  if (whereClause) {
    sql += ` WHERE ${whereClause}`;
  }

  if (groupBy.length > 0) {
    sql += ` GROUP BY ${groupBy.join(", ")}`;
  }

  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }

  return query<T>(sql);
}

/**
 * Consulta população por município/UF/ano
 */
export async function queryPopulacao<T = Record<string, unknown>>(
  whereClause: string = ""
): Promise<T[]> {
  const { available, missing } = checkDataFiles();
  if (!available) {
    throw new Error(`Arquivos Parquet não encontrados: ${missing.join(", ")}`);
  }

  let sql = `SELECT * FROM read_parquet('${PARQUET_FILES.populacao}')`;

  if (whereClause) {
    sql += ` WHERE ${whereClause}`;
  }

  return query<T>(sql);
}

/**
 * Calcula agregações customizadas no cubo de causas
 */
export async function aggregateCausas(options: {
  select: string[];
  where?: string;
  groupBy?: string[];
  having?: string;
  orderBy?: string;
  limit?: number;
}): Promise<Record<string, unknown>[]> {
  const { available, missing } = checkDataFiles();
  if (!available) {
    throw new Error(`Arquivos Parquet não encontrados: ${missing.join(", ")}`);
  }

  const selectClause = options.select.join(", ");
  let sql = `SELECT ${selectClause} FROM read_parquet('${PARQUET_FILES.causas}')`;

  if (options.where) {
    sql += ` WHERE ${options.where}`;
  }

  if (options.groupBy && options.groupBy.length > 0) {
    sql += ` GROUP BY ${options.groupBy.join(", ")}`;
  }

  if (options.having) {
    sql += ` HAVING ${options.having}`;
  }

  if (options.orderBy) {
    sql += ` ORDER BY ${options.orderBy}`;
  }

  if (options.limit) {
    sql += ` LIMIT ${options.limit}`;
  }

  return query(sql);
}

/**
 * Calcula taxa de internação (por 10.000 hab)
 */
export async function calculateRate(options: {
  year: number;
  uf?: string[];
  municipio?: string;
  sex?: string;
  ageGroup?: string[];
}): Promise<{ n: number; population: number; rate: number }[]> {
  const { available, missing } = checkDataFiles();
  if (!available) {
    throw new Error(`Arquivos Parquet não encontrados: ${missing.join(", ")}`);
  }

  // Constrói condições WHERE
  const conditions: string[] = [`year = ${options.year}`];

  if (options.uf && options.uf.length > 0) {
    const ufs = options.uf.map((u) => `'${u}'`).join(", ");
    conditions.push(`uf IN (${ufs})`);
  }

  if (options.municipio) {
    conditions.push(`municipality_code = '${options.municipio}'`);
  }

  if (options.sex) {
    conditions.push(`sex = '${options.sex}'`);
  }

  if (options.ageGroup && options.ageGroup.length > 0) {
    const ages = options.ageGroup.map((a) => `'${a}'`).join(", ");
    conditions.push(`age_group IN (${ages})`);
  }

  const whereClause = conditions.join(" AND ");

  // Query para internações
  const internacoes = await query<{ total: number }>(`
    SELECT SUM(n) as total
    FROM read_parquet('${PARQUET_FILES.causas}')
    WHERE ${whereClause}
  `);

  // Query para população
  const populacao = await query<{ total: number }>(`
    SELECT SUM(population) as total
    FROM read_parquet('${PARQUET_FILES.populacao}')
    WHERE ${whereClause.replace("municipality_code", "municipality_code")}
  `);

  const n = internacoes[0]?.total || 0;
  const pop = populacao[0]?.total || 1;
  const rate = (n / pop) * 10000;

  return [{ n, population: pop, rate }];
}
