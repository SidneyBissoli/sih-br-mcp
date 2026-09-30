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

import { mkdtempSync, readFileSync } from "node:fs";
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
