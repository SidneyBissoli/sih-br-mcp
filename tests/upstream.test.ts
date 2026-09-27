/**
 * O ponto único de rede (src/upstream.ts) e o diagnóstico de origem que ele
 * alimenta (contrato v1.1, chave `retrieval` do bloco de proveniência).
 *
 * Sem rede: `globalThis.fetch` é dublado por `Response` de verdade (o pacote
 * lê `headers` e `text()` — objeto solto quebra), o backoff é calado por
 * `upstreamIo.sleep`, e o cache em disco aponta para uma pasta temporária —
 * `loadCubesManifest` grava a cópia do manifesto e `ensureYear` grava o
 * arquivo baixado, e nada disso pode cair no cache real do usuário.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.SIH_CACHE_DIR = mkdtempSync(join(tmpdir(), "sih-upstream-cache-"));
const cacheDir = process.env.SIH_CACHE_DIR;

const upstream = await import("../src/upstream.js");
const cache = await import("../src/cache.js");
const { UpstreamError } = await import("@sbissoli/mcp-upstream");

const { OrigemError, UPSTREAM_POLICY, currentRetrieval, retryCanal, traduzirErro, upstreamCall, upstreamIo, withUpstreamCall } = upstream;
const { CUBES_BASE_URL, ensureYear, loadCubesManifest, setCubesManifestForTests } = cache;

type Fetch = typeof globalThis.fetch;
type Chamada = { url: string; init: RequestInit | undefined };

/** Dublê de fetch que devolve, por ordem, cada resposta da lista (fabricada na hora: `Response` não se reusa). */
function dublar(respostas: Array<() => Response | Error>): { chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const fetchFalso: Fetch = async (input, init) => {
    chamadas.push({ url: String(input), init });
    const proxima = respostas.shift();
    if (!proxima) throw new Error(`dublê sem resposta para ${String(input)}`);
    const r = proxima();
    if (r instanceof Error) throw r;
    return r;
  };
  vi.stubGlobal("fetch", fetchFalso);
  return { chamadas };
}

const manifestoMinimo = JSON.stringify({ years: {}, generated_at: "2026-09-27T00:00:00Z" });
const json = (texto: string, status = 200) => () => new Response(texto, { status, headers: { "content-type": "application/json" } });
const status = (code: number) => () => new Response("", { status: code });
const rede = () => () => Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });

beforeAll(() => {
  upstreamIo.sleep = async () => {};
  upstreamIo.random = () => 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  setCubesManifestForTests(null);
});

describe("política de rede (medida em 27/09/2026 — ver o cabeçalho de src/upstream.ts)", () => {
  it("canal: 15 s por tentativa nos cabeçalhos, 2 retries, orçamento de 60 s; manifesto 8 s e um retry; frescor sem retry", () => {
    expect(UPSTREAM_POLICY.canal).toEqual({ timeoutMs: 15_000, retries: 2, budgetMs: 60_000, backoff: { baseMs: 1_000, maxMs: 4_000, jitterMs: 500 } });
    expect(UPSTREAM_POLICY.manifesto).toEqual({ timeoutMs: 8_000, retries: 1 });
    expect(UPSTREAM_POLICY.frescor).toMatchObject({ probeTimeoutMs: 3_000, fullTimeoutMs: 12_000, retries: 0 });
  });

  it("repete 429, 5xx e rede; não repete timeout, 4xx, 404 nem corpo inesperado", () => {
    const ctx = (kind: Parameters<typeof retryCanal>[0]["kind"], status?: number) =>
      ({ url: "u", attempt: 1, kind, status, response: undefined, body: undefined }) as Parameters<typeof retryCanal>[0];
    expect(retryCanal(ctx("rate_limited", 429))).toBe(true);
    expect(retryCanal(ctx("http_5xx", 503))).toBe(true);
    expect(retryCanal(ctx("network"))).toBe(true);
    expect(retryCanal(ctx("timeout"))).toBe(false);
    expect(retryCanal(ctx("http_4xx", 403))).toBe(false);
    expect(retryCanal(ctx("not_found", 404))).toBe(false);
    expect(retryCanal(ctx("malformed_body", 200))).toBe(false);
  });

  it("identifica-se: User-Agent do servidor em toda ida", async () => {
    const { chamadas } = dublar([json(manifestoMinimo)]);
    await loadCubesManifest();
    expect(chamadas).toHaveLength(1);
    expect(new Headers(chamadas[0]!.init?.headers).get("user-agent")).toMatch(/^sih-br-mcp\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/SidneyBissoli\/sih-br-mcp\)$/);
  });
});

describe("as mensagens que a borda classifica por texto (worker/src/call-shape.ts)", () => {
  const erro = (init: ConstructorParameters<typeof UpstreamError>[0]) => traduzirErro(new UpstreamError(init), "https://x/y");
  it("404 continua 'HTTP 404' (nao_encontrado); 5xx diz 'indisponível' e o status (fonte)", () => {
    const e404 = erro({ url: "https://x/y", kind: "not_found", status: 404, retryable: false, transport: false, attempts: 1 });
    expect(e404).toBeInstanceOf(OrigemError);
    expect(e404.message).toBe("https://x/y: HTTP 404");
    const e503 = erro({ url: "https://x/y", kind: "http_5xx", status: 503, retryable: true, transport: false, attempts: 3 });
    expect(e503.message).toBe("https://x/y: canal indisponível — HTTP 503 após 3 tentativas");
  });
  it("timeout e rede dizem 'timeout' e 'erro de conexão' (fonte), com transporte marcado", () => {
    const t = erro({ url: "https://x/y", kind: "timeout", status: undefined, retryable: true, transport: true, attempts: 1 }) as InstanceType<typeof OrigemError>;
    expect(t.message).toBe("https://x/y: timeout antes da resposta");
    expect(t.transport).toBe(true);
    const r = erro({ url: "https://x/y", kind: "network", status: undefined, retryable: true, transport: true, attempts: 3, cause: rede()() }) as InstanceType<typeof OrigemError>;
    expect(r.message).toBe("https://x/y: erro de conexão com o canal (fetch failed: ECONNREFUSED) após 3 tentativas");
    expect(r.kind).toBe("network");
  });
  it("erro que não é do pacote passa intacto", () => {
    const meu = new Error("outra coisa");
    expect(traduzirErro(meu, "u")).toBe(meu);
  });
});

describe("o coletor da chamada", () => {
  it("fora de uma chamada não há retrieval; dentro, cada ida conta — e o aninhado reusa o coletor de fora", async () => {
    dublar([json(manifestoMinimo), json(manifestoMinimo)]);
    expect(currentRetrieval()).toBeNull();
    const dentro = await withUpstreamCall(async () => {
      await upstreamCall().text(CUBES_BASE_URL + "manifest.json");
      const aninhado = await withUpstreamCall(async () => {
        await upstreamCall().text(CUBES_BASE_URL + "manifest.json");
        return currentRetrieval();
      });
      expect(aninhado).toEqual({ requests: 2, attempts: 2, anomalies: [] });
      return currentRetrieval();
    });
    expect(dentro).toEqual({ requests: 2, attempts: 2, anomalies: [] });
    expect(currentRetrieval()).toBeNull();
  });
});

describe("loadCubesManifest pelo fetch comum", () => {
  it("503 depois 200: um retry, o manifesto chega, e o retrieval conta a anomalia contornada", async () => {
    const { chamadas } = dublar([status(503), json(manifestoMinimo)]);
    const resultado = await withUpstreamCall(async () => {
      const r = await loadCubesManifest();
      return { ...r, retrieval: currentRetrieval() };
    });
    expect(chamadas.map((c) => c.url)).toEqual([CUBES_BASE_URL + "manifest.json", CUBES_BASE_URL + "manifest.json"]);
    expect(resultado.source).toBe("remote");
    expect(resultado.manifest?.years).toEqual({});
    expect(resultado.retrieval).toEqual({ requests: 1, attempts: 2, anomalies: [{ kind: "http_5xx", count: 1 }] });
    expect(existsSync(join(cacheDir, "manifest.json"))).toBe(true);
  });

  it("rede fora: UM retry (política do manifesto), depois cai para o disco sem lançar", async () => {
    const { chamadas } = dublar([rede(), rede(), rede()]);
    const r = await withUpstreamCall(() => loadCubesManifest());
    expect(chamadas).toHaveLength(2);
    // A cópia em disco do teste anterior é o que responde agora.
    expect(r.source).toBe("disk");
    expect(r.manifest?.years).toEqual({});
  });

  it("404 não repete: cai para o disco na hora", async () => {
    const { chamadas } = dublar([status(404)]);
    const r = await withUpstreamCall(() => loadCubesManifest());
    expect(chamadas).toHaveLength(1);
    expect(r.source).toBe("disk");
  });
});

describe("download verificado (ensureYear) pelo fetch comum", () => {
  const corpo = Buffer.from("parquet-de-mentira-para-o-teste-de-download");
  const arquivo = { name: "sih_series_2023.parquet", size_bytes: corpo.length, sha256: createHash("sha256").update(corpo).digest("hex") };
  const manifesto = (f = arquivo) =>
    ({ years: { "2023": { files: { series: f } } } }) as unknown as Parameters<typeof ensureYear>[2];

  it("cabeçalhos pelo pacote (com ?v=sha), corpo em stream para o disco, SHA-256 conferido, retrieval {1,1,[]}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sih-upstream-ano-"));
    const { chamadas } = dublar([() => new Response(corpo, { status: 200 })]);
    const retrieval = await withUpstreamCall(async () => {
      await ensureYear(dir, 2023, manifesto(), () => {}, ["series"]);
      return currentRetrieval();
    });
    expect(chamadas[0]!.url).toBe(`${CUBES_BASE_URL}${arquivo.name}?v=${arquivo.sha256.slice(0, 16)}`);
    expect(existsSync(join(dir, arquivo.name))).toBe(true);
    expect(readdirSync(dir)).toEqual([arquivo.name]); // sem .part sobrando
    expect(retrieval).toEqual({ requests: 1, attempts: 1, anomalies: [] });
  });

  it("5xx repete até o teto do canal (2 retries) e então lança OrigemError 'indisponível' com o status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sih-upstream-ano-"));
    const { chamadas } = dublar([status(502), status(502), status(502)]);
    await expect(ensureYear(dir, 2023, manifesto(), () => {}, ["series"])).rejects.toMatchObject({
      name: "OrigemError",
      kind: "http_5xx",
      status: 502,
      attempts: 3,
      message: expect.stringContaining("canal indisponível — HTTP 502 após 3 tentativas"),
    });
    expect(chamadas).toHaveLength(3);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("corpo que não bate com o manifesto é recusado (verificacao) e não deixa rastro", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sih-upstream-ano-"));
    dublar([() => new Response(Buffer.from("outro conteúdo, mesmo tamanho?"), { status: 200 })]);
    await expect(ensureYear(dir, 2023, manifesto(), () => {}, ["series"])).rejects.toMatchObject({ name: "OrigemError", kind: "verificacao" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("404 do arquivo é erro 'HTTP 404', nunca ausência silenciosa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sih-upstream-ano-"));
    dublar([status(404)]);
    await expect(ensureYear(dir, 2023, manifesto(), () => {}, ["series"])).rejects.toThrow(/HTTP 404$/);
  });
});
