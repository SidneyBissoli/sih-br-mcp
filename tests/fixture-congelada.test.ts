/**
 * A fixture versionada não recebe download, quem quer que aponte para ela.
 *
 * Incidente de 30/09/2026: um probe avulso rodou com
 * `SIH_DATA_DIR=tests/fixtures/sih` e o cache no padrão (ligado). Como a pasta
 * tem cubo, `getDataDirectory()` a escolhe e `ensureCausasSummary()` baixa o
 * grão A PARA ELA, por desenho (é assim que `data/` e o contêiner se
 * completam). Ficou lá o `sih_causas_resumo.parquet` real, de 1992 a 2025:
 * na máquina local, as chamadas cobertas pelo resumo passavam a ler 34 anos,
 * e no CI só a fixture de 2023. Os scripts versionados já se protegiam com
 * `SIH_CUBES_CACHE=off`, um por um. O processo avulso não.
 *
 * A defesa é da PASTA: `.fixture-somente-leitura` desliga o cache
 * (src/cache.ts, FROZEN_DATA_DIR_MARKER). Este arquivo reproduz o incidente
 * numa CÓPIA da fixture (uma falha não suja a verdadeira), com o cache ligado
 * e um canal local que publica um resumo. Traz também o controle: sem o
 * marcador, o download TEM de acontecer. Sem ele, o teste passaria mesmo com
 * uma guarda que nunca dispara.
 *
 * `CUBES_CACHE_ENABLED` é lido na CARGA de src/cache.ts, então cada cenário
 * recarrega os módulos (`vi.resetModules()`) depois de montar o ambiente.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const FIXTURE = resolve(import.meta.dirname, "fixtures/sih");
const MARCADOR = ".fixture-somente-leitura";
const RESUMO = "sih_causas_resumo.parquet";

const corpo = Buffer.from("resumo publicado pelo canal local do teste");
const arquivo = (name: string) => ({ name, size_bytes: corpo.length, sha256: createHash("sha256").update(corpo).digest("hex") });

let canal: Server;

beforeAll(async () => {
  canal = createServer((req, res) => {
    // O download pede `<nome>?v=<sha>` (quebra o cache da borda): casar pelo caminho.
    if (new URL(req.url ?? "/", "http://x").pathname.endsWith(RESUMO)) {
      res.writeHead(200, { "content-length": corpo.length });
      res.end(corpo);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((ok) => canal.listen(0, "127.0.0.1", ok));
  const porta = (canal.address() as { port: number }).port;

  process.env.SIH_CUBES_CACHE = "on";
  process.env.SIH_FRESHNESS_CHECK = "off";
  process.env.SIH_CUBES_BASE_URL = `http://127.0.0.1:${porta}/`;
  process.env.SIH_CACHE_DIR = mkdtempSync(join(tmpdir(), "sih-congelada-cache-"));
});

afterAll(async () => {
  await new Promise<void>((ok) => canal.close(() => ok()));
});

/** Sobe o servidor contra `dir`, faz a pergunta que o grão A cobre e devolve o que apareceu na pasta. */
async function perguntarContra(dir: string): Promise<{ cacheLigado: boolean; novos: string[] }> {
  const antes = new Set(readdirSync(dir));
  process.env.SIH_DATA_DIR = dir;
  vi.resetModules();

  const cache = await import("../src/cache.js");
  cache.setCubesManifestForTests({
    manifest_version: "1.4.0",
    dataset: "sih/cubos",
    generated_at: "2026-09-30T00:00:00Z",
    base_url: process.env.SIH_CUBES_BASE_URL!,
    years: {},
    causas_summary: {
      built_at: null,
      builder_version: null,
      derived_from: {},
      files: { resumo: arquivo(RESUMO), estratos: {}, provenance: arquivo("sih_causas_resumo_provenance.json") },
    },
  } as unknown as Parameters<typeof cache.setCubesManifestForTests>[0]);

  const { createServer: servidorMcp } = await import("../src/server.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const { Client } = await import("@modelcontextprotocol/client");
  const [doCliente, doServidor] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: "fixture-congelada", version: "0.0.0" });
  await Promise.all([servidorMcp().connect(doServidor), cliente.connect(doCliente)]);
  try {
    await cliente.callTool({ name: "get_hospitalizations", arguments: { year: [2023] } });
  } finally {
    await cliente.close();
  }
  return { cacheLigado: cache.CUBES_CACHE_ENABLED, novos: readdirSync(dir).filter((f) => !antes.has(f)) };
}

function copiaDaFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sih-congelada-dados-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe("fixture congelada: nada é baixado para a pasta que tem o marcador", () => {
  it("a fixture versionada carrega o marcador", () => {
    expect(existsSync(join(FIXTURE, MARCADOR))).toBe(true);
  });

  it("controle: SEM o marcador, a mesma pergunta baixa o resumo para a pasta de dados", async () => {
    const dir = copiaDaFixture();
    rmSync(join(dir, MARCADOR));
    const { cacheLigado, novos } = await perguntarContra(dir);
    expect(cacheLigado).toBe(true);
    expect(novos).toContain(RESUMO);
  });

  it("COM o marcador, o cache fica desligado e a pasta não ganha arquivo nenhum", async () => {
    const dir = copiaDaFixture();
    const { cacheLigado, novos } = await perguntarContra(dir);
    expect(cacheLigado).toBe(false);
    expect(novos).toEqual([]);
  });
});
