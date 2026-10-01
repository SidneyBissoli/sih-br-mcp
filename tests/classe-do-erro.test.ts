/**
 * A classe do erro sai do TIPO da falha e viaja até a borda em `_meta`.
 *
 * Medido em 30/09/2026, rodando o classificador da borda
 * (`worker/src/call-shape.ts`) sobre o texto que o container devolve: 4xx do
 * canal ("HTTP 403"), corpo inesperado, "resposta sem corpo" e a verificação
 * de tamanho/SHA-256 caíam em `outro`. O tipo (`OrigemError.kind`) existe no
 * container, mas a telemetria roda no Worker, que só lê a resposta — então a
 * classe tem de ir NELA (`CLASSE_DO_ERRO_META`), e o lado da borda está em
 * `worker/tests/envelope.test.ts`.
 *
 * O teste atravessa o dispatcher de verdade (`callTool`): canal dublado, cubo
 * que não baixa, `catch` final, resultado de erro. Mesmo arranjo de disco frio
 * de tests/ano-ausente-frio.test.ts.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.SIH_DATA_DIR = mkdtempSync(join(tmpdir(), "sih-classe-dados-"));
process.env.SIH_CACHE_DIR = mkdtempSync(join(tmpdir(), "sih-classe-cache-"));
process.env.SIH_CUBES_CACHE = "on";
process.env.SIH_FRESHNESS_CHECK = "off";

const { setCubesManifestForTests } = await import("../src/cache.js");
const { CLASSE_DO_ERRO_META, upstreamIo } = await import("../src/upstream.js");
const { callTool } = await import("../src/tools.js");

const ANO = 2023;

beforeAll(() => {
  upstreamIo.sleep = async () => {};
  upstreamIo.random = () => 0;
  const excerto = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/sih/cubes-manifest-excerpt.json"), "utf8"));
  // Arquivo de tamanho zero: um corpo de 1 byte não confere com o manifesto.
  const arquivo = { name: "cubo-de-teste.parquet", size_bytes: 0, sha256: "0".repeat(64) };
  setCubesManifestForTests({
    ...excerto,
    years: {
      [String(ANO)]: {
        built_at: null,
        builder_version: null,
        records_in_cube: null,
        window_complete: null,
        ufs: null,
        manifest_last_updated: null,
        files: { causas: arquivo, series: arquivo, icsap: arquivo, provenance: arquivo },
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function canal(fn: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fn));
}

/** Uma ferramenta que PRECISA de cubo (sem pré-agregado que a cubra). */
async function chamar() {
  return callTool("get_hospitalization_trends", { year_start: ANO, year_end: ANO, granularity: "month" });
}

function classeNoMeta(r: unknown): unknown {
  return ((r as { _meta?: Record<string, unknown> })._meta ?? {})[CLASSE_DO_ERRO_META];
}

describe("falha do canal é `fonte`, dita pelo tipo", () => {
  it("403 — pela frase ('HTTP 403') caía em `outro`", async () => {
    canal(async () => new Response("", { status: 403 }));
    const r = await chamar();
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("HTTP 403");
    expect(classeNoMeta(r)).toBe("fonte");
  });

  it("verificação de tamanho — caía em `outro`", async () => {
    canal(async () => new Response("x", { status: 200 }));
    const r = await chamar();
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("manifesto diz");
    expect(classeNoMeta(r)).toBe("fonte");
  });

  it("502 (já era `fonte` pela frase; agora pelo tipo)", async () => {
    canal(async () => new Response("", { status: 502 }));
    const r = await chamar();
    expect(classeNoMeta(r)).toBe("fonte");
  });

  it("rede", async () => {
    canal(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    });
    const r = await chamar();
    expect(classeNoMeta(r)).toBe("fonte");
  });
});

describe("404 continua ausência respondida", () => {
  it("404", async () => {
    canal(async () => new Response("", { status: 404 }));
    const r = await chamar();
    expect(r.isError).toBe(true);
    expect(classeNoMeta(r)).toBe("nao_encontrado");
  });
});

// ---------------------------------------------------------------------------
// DEFEITOS (30/09/2026, onda 2): `throw new Error(...)` genérico saía sem
// `_meta`, e a borda caía na FRASE. Cada caso abaixo FALHAVA no código
// anterior (conferido com o src de master): a classe pela frase está no nome.
//
// As variáveis de ambiente são lidas na CARGA dos módulos, então cada caso
// recarrega o grafo (`vi.resetModules`) com a pasta de dados que precisa.
// ---------------------------------------------------------------------------

const FIXTURES = resolve(import.meta.dirname, "fixtures/sih");
const envOriginal = { ...process.env };

async function carregar(env: Record<string, string>) {
  vi.resetModules();
  Object.assign(process.env, { SIH_CUBES_CACHE: "off", SIH_FRESHNESS_CHECK: "off" }, env);
  const tools = await import("../src/tools.js");
  const upstream = await import("../src/upstream.js");
  return { callTool: tools.callTool, classeDaExcecao: upstream.classeDaExcecao };
}

function pastaCom(arquivos: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "sih-classe-defeito-"));
  for (const [nome, corpo] of Object.entries(arquivos)) writeFileSync(join(dir, nome), corpo);
  return dir;
}

describe("defeitos declarados pelo tipo (antes: classe pela frase)", () => {
  afterEach(() => {
    vi.doUnmock("@duckdb/node-api");
    for (const k of Object.keys(process.env)) if (!(k in envOriginal)) delete process.env[k];
    Object.assign(process.env, envOriginal);
  });

  // A cobertura populacional de get_hospitalization_rates roda antes da
  // consulta principal; é por ela que este caso chega ao DuckDB.
  it("'Erro na query' (Parquet que o DuckDB recusa) é `defeito` — pela frase ('Invalid Input Error') era `contrato`", async () => {
    const dir = pastaCom({
      "sih_causas_2023.parquet": readFileSync(join(FIXTURES, "sih_causas_2023.parquet")),
      "pop_uf.parquet": "isto não é parquet",
    });
    const { callTool } = await carregar({ SIH_DATA_DIR: dir });
    const r = await callTool("get_hospitalization_rates", { year: [ANO] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Erro na query");
    expect(classeNoMeta(r)).toBe("defeito");
  });

  it("'Nenhum arquivo SIH Parquet' (cache desligado, pasta vazia) é `defeito` — pela frase era `nao_encontrado`", async () => {
    const dir = pastaCom({});
    const { callTool } = await carregar({ SIH_DATA_DIR: dir });
    const r = await callTool("get_hospitalization_trends", { year_start: ANO, year_end: ANO, granularity: "month" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Nenhum arquivo SIH Parquet");
    expect(classeNoMeta(r)).toBe("defeito");
  });

  it("'Nenhum cubo de series' (tipo de cubo ausente na pasta) é `defeito` — pela frase era `outro`", async () => {
    // Direto na camada de dados, de onde a exceção sai; o caminho pelo
    // handler está na decisão 49, abaixo.
    const dir = pastaCom({ "sih_causas_2023.parquet": readFileSync(join(FIXTURES, "sih_causas_2023.parquet")) });
    const { classeDaExcecao } = await carregar({ SIH_DATA_DIR: dir });
    const { cubeSource } = await import("../src/db/duckdb.js");
    let erro: unknown = null;
    try {
      cubeSource("series");
    } catch (e) {
      erro = e;
    }
    expect(String(erro)).toContain("Nenhum cubo de series");
    expect(classeDaExcecao(erro)).toBe("defeito");
  });

  it("'Erro ao criar banco DuckDB' é `defeito` — pela frase era `outro`", async () => {
    vi.doMock("@duckdb/node-api", async (original) => {
      const mod = (await original()) as Record<string, unknown>;
      return {
        ...mod,
        DuckDBInstance: {
          create: async () => {
            throw new Error("sem memória para a instância");
          },
        },
      };
    });
    const { callTool } = await carregar({ SIH_DATA_DIR: FIXTURES });
    const r = await callTool("get_hospitalization_rates", { year: [ANO] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Erro ao criar banco DuckDB");
    expect(classeNoMeta(r)).toBe("defeito");
  });

  it("'Ferramenta desconhecida' (ramo inalcançável do switch) é `defeito` — pela frase era `contrato`", async () => {
    const { callTool } = await carregar({ SIH_DATA_DIR: FIXTURES });
    const r = await callTool("ferramenta_que_nao_existe", {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Ferramenta desconhecida");
    expect(classeNoMeta(r)).toBe("defeito");
  });

  it("população ausente (POPULATION_MISSING_MESSAGE) é `fonte` — pela frase era `outro`", async () => {
    // Direto na camada de dados; o caminho pelo handler (que agora LANÇA
    // FalhaDaFonte em vez de devolver erro-mole) está na decisão 49, abaixo.
    const dir = pastaCom({ "sih_series_2023.parquet": readFileSync(join(FIXTURES, "sih_series_2023.parquet")) });
    const { classeDaExcecao } = await carregar({ SIH_DATA_DIR: dir });
    const { getPopulation, getPopulationByUf } = await import("../src/db/duckdb.js");
    for (const chamada of [() => getPopulation({ year: ANO }), () => getPopulationByUf({ year: ANO })]) {
      const erro = await chamada().then(
        () => null,
        (e: unknown) => e,
      );
      expect(String(erro)).toContain("Dados populacionais não disponíveis");
      expect(classeDaExcecao(erro)).toBe("fonte");
    }
  });

  it("faixa etária fora das faixas antes de 2000 continua `contrato` (agora declarado)", async () => {
    const { classeDaExcecao } = await carregar({ SIH_DATA_DIR: FIXTURES });
    const { getPopulation } = await import("../src/db/duckdb.js");
    const erro = await getPopulation({ year: 1995, ageMin: 3, ageMax: 7 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(erro)).toContain("só existe em faixas etárias");
    expect(classeDaExcecao(erro)).toBe("contrato");
  });
});

// ---------------------------------------------------------------------------
// Decisão 49 (01/10/2026): o `catch` de cada handler de dado devolvia QUALQUER
// exceção como erro-mole — `{ error, data: [] }` num SUCESSO —, e a telemetria
// contava `ok` uma falha do DuckDB ou do canal. Agora a exceção sobe ao `catch`
// final do dispatcher, que a devolve como erro com a classe pelo tipo. O
// erro-mole fica só para o que é DELIBERADO: ausência ou recusa respondida
// num `return { error }` explícito (pinado em worker/tests/envelope.test.ts).
// ---------------------------------------------------------------------------

describe("exceção no handler é erro de verdade, não erro-mole (decisão 49)", () => {
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in envOriginal)) delete process.env[k];
    Object.assign(process.env, envOriginal);
  });

  it("cubo que o DuckDB recusa, dentro do handler, sai isError com `defeito`", async () => {
    const dir = pastaCom({ "sih_causas_2023.parquet": "isto não é parquet" });
    const { callTool } = await carregar({ SIH_DATA_DIR: dir });
    const r = await callTool("get_hospitalizations", { year: [ANO] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Erro na query");
    expect(classeNoMeta(r)).toBe("defeito");
  });

  it("tipo de cubo ausente, dentro do handler, sai isError com `defeito`", async () => {
    const dir = pastaCom({ "sih_causas_2023.parquet": readFileSync(join(FIXTURES, "sih_causas_2023.parquet")) });
    const { callTool } = await carregar({ SIH_DATA_DIR: dir });
    const r = await callTool("get_hospitalization_trends", { year_start: ANO, year_end: ANO, granularity: "monthly" });
    expect(r.isError).toBe(true);
    expect(classeNoMeta(r)).toBe("defeito");
  });

  it("população ausente no handler de taxas sai isError com `fonte`", async () => {
    const dir = pastaCom({ "sih_causas_2023.parquet": readFileSync(join(FIXTURES, "sih_causas_2023.parquet")) });
    const { callTool } = await carregar({ SIH_DATA_DIR: dir });
    const r = await callTool("get_hospitalization_rates", { year: [ANO] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Dados populacionais não disponíveis");
    expect(classeNoMeta(r)).toBe("fonte");
  });

  it("o erro-mole DELIBERADO continua: ano sem dados é resposta, não erro", async () => {
    const { callTool } = await carregar({ SIH_DATA_DIR: FIXTURES });
    const r = await callTool("get_hospitalizations", { year: [1800] });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).toContain("Nenhum dos anos solicitados");
  });
});
