import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * A suíte roda SEMPRE contra as fixtures versionadas (tests/fixtures/sih) e
 * NUNCA contra o canal público:
 *
 * - `SIH_DATA_DIR` aponta o DuckDB para os parquets de 2023 já no repositório,
 *   os mesmos que o golden e os scripts de equivalência usam;
 * - `SIH_CUBES_CACHE=off` desliga o download de cubos — sem isto um teste que
 *   pede ano ausente sairia buscando 1,25 GB no data.sidneybissoli.com e o CI
 *   ficaria refém de um portal externo.
 *
 * Ambas as variáveis são lidas na CARGA dos módulos (src/cache.ts:31-32 e
 * src/db/duckdb.ts:28), por isso entram aqui e não dentro de cada teste.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      SIH_DATA_DIR: resolve(import.meta.dirname, "tests/fixtures/sih"),
      SIH_CUBES_CACHE: "off",
    },
    // O DuckDB abre uma conexão de processo compartilhada (src/db/duckdb.ts):
    // arquivos em paralelo brigam pelo mesmo handle e pelas tabelas temporárias
    // de icsapAggregateSql, que têm nome único por CHAMADA, não por processo.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
