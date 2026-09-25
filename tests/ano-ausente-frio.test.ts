/**
 * A mesma pergunta tem de ter UMA resposta, e o estado do disco não é assunto
 * de quem pergunta.
 *
 * Defeito medido em 24/09/2026, ao conferir em produção o conserto de
 * `sih:classe-de-erro-na-borda`: `get_hospitalizations({year:[1800]})`
 * respondia de DUAS formas conforme houvesse ou não um cubo em disco. Com o
 * contêiner recém-acordado (disco vazio) saía `isError: true`, sem
 * proveniência e sem a nota que ensina o chamador a acertar; com um cubo
 * qualquer em disco saía o funil da decisão 38 — sucesso honesto com `data: []`,
 * `available_sih_years` e `note`. Oito das oito ferramentas que aceitam ano
 * divergiam, e o caso frio era o COMUM: os pré-agregados respondem 34 anos sem
 * deixar cubo no disco, então o contêiner só "esquenta" depois de uma pergunta
 * fina — e volta a esfriar a cada despertar.
 *
 * `tests/ano-ausente.test.ts` afirma os invariantes certos, mas roda com o
 * cache DESLIGADO e a fixture de 2023 no disco — sempre no caso quente. Era o
 * teste dedicado a esta classe, e era cego para metade dela. Este arquivo é a
 * outra metade: cache LIGADO, disco VAZIO, manifesto injetado (a rede nunca é
 * tocada) e um ano que o canal não publica — nada é baixado.
 *
 * Por que as variáveis vêm no topo e os módulos por `import()` dinâmico: as
 * duas são lidas na CARGA de `src/cache.ts` e `src/db/duckdb.ts`, e o
 * `vitest.config.ts` já as fixou para o caso quente. Um arquivo de teste é um
 * módulo isolado, então redefini-las aqui, ANTES de carregar o servidor, vale
 * só para este arquivo.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Disco FRIO: pasta de dados vazia E cache vazio — `getDataDirectory()` cai
// para o cache quando a pasta configurada não tem cubo, e o cache real do
// usuário (~/.cache/sih-br-mcp) pode estar cheio de uma medição anterior.
process.env.SIH_DATA_DIR = mkdtempSync(join(tmpdir(), "sih-frio-dados-"));
process.env.SIH_CACHE_DIR = mkdtempSync(join(tmpdir(), "sih-frio-cache-"));
process.env.SIH_CUBES_CACHE = "on";
process.env.SIH_FRESHNESS_CHECK = "off";
// Porta "discard": se algo tentar a rede, falha na hora em vez de esperar 8 s.
process.env.SIH_CUBES_BASE_URL = "http://127.0.0.1:9/";

/** Ano que não existe em canal nenhum — a série do SIH vai de 1992 em diante. */
const ANO_INEXISTENTE = 2030;

/** O único ano que o manifesto injetado publica. */
const ANO_PUBLICADO = 2023;

let cliente: Client;

async function conectar(): Promise<Client> {
  // O trecho versionado do manifesto tem cabeçalho e tabelas; os ANOS entram
  // aqui, com arquivos que nunca serão baixados (o teste só pede 2030).
  const { setCubesManifestForTests } = await import("../src/cache.js");
  const excerto = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/sih/cubes-manifest-excerpt.json"), "utf8"));
  const arquivo = { name: "nunca-baixado.parquet", size_bytes: 0, sha256: "0".repeat(64) };
  setCubesManifestForTests({
    ...excerto,
    years: {
      [String(ANO_PUBLICADO)]: {
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

  const { createServer } = await import("../src/server.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const { Client } = await import("@modelcontextprotocol/client");
  const server = createServer();
  const [doCliente, doServidor] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "ano-ausente-frio", version: "0.0.0" });
  await Promise.all([server.connect(doServidor), c.connect(doCliente)]);
  return c;
}

beforeAll(async () => {
  cliente = await conectar();
});

afterAll(async () => {
  await cliente.close();
});

/** Os mesmos argumentos mínimos de tests/ano-ausente.test.ts, pelo esquema publicado. */
function argsParaAno(props: Record<string, unknown>, ano: number): Record<string, unknown> | null {
  if ("year" in props) return { year: [ano] };
  if ("year_start" in props && "year_end" in props) return { year_start: ano, year_end: ano };
  if ("start_year" in props && "end_year" in props) {
    return { start_year: ano, end_year: ano, compare_by: "uf", compare_values: ["MG"], indicator: "count" };
  }
  return null;
}

function conteudo(r: unknown): Record<string, unknown> {
  return ((r as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}) as Record<string, unknown>;
}

describe("disco frio: a ausência de ano sai pelo MESMO funil que no disco quente", () => {
  it("toda ferramenta que aceita ano responde sucesso honesto, com proveniência e as duas listas de anos", async () => {
    const { tools } = await cliente.listTools();
    const comAno = tools.filter((t) => argsParaAno((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}, ANO_INEXISTENTE) !== null);
    expect(comAno.length, "nenhuma ferramenta aceita ano?").toBeGreaterThanOrEqual(8);

    for (const t of comAno) {
      const args = argsParaAno((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}, ANO_INEXISTENTE)!;
      const r = await cliente.callTool({ name: t.name, arguments: args });

      // O que divergia: no disco frio saía `isError: true`. Ausência de dado é
      // resposta, não falha (decisão 38) — nos dois estados do disco.
      expect(r.isError, `${t.name} respondeu isError no disco frio`).toBeFalsy();

      const sc = conteudo(r);
      expect(sc.error, `${t.name} sem error`).toBeTypeOf("string");
      expect(String(sc.error)).toContain(String(ANO_INEXISTENTE));

      // As DUAS verdades, nomeadas pelo que são: o que ESTA instância consegue
      // responder agora (pode ser vazio, o disco está frio) e o que o CANAL
      // publica (é o que ensina o chamador a acertar).
      expect(Array.isArray(sc.available_sih_years), `${t.name} sem available_sih_years`).toBe(true);
      expect(sc.published_years, `${t.name} sem published_years`).toContain(ANO_PUBLICADO);
      expect(sc.note, `${t.name} sem note`).toBeTypeOf("string");

      // Sem o envelope de proveniência a resposta não é do contrato.
      expect(sc.provenance, `${t.name} sem proveniência`).toBeDefined();
      expect(sc.attribution, `${t.name} sem attribution`).toBeDefined();

      // E nenhum total zerado com cara de medida.
      expect(sc.summary, `${t.name} devolveu summary para ano inexistente`).toBeUndefined();
    }
  });

  it("nada foi baixado: o ano pedido não está no manifesto, então o disco continua frio", async () => {
    const { readdirSync } = await import("node:fs");
    for (const dir of [process.env.SIH_DATA_DIR!, process.env.SIH_CACHE_DIR!]) {
      expect(readdirSync(dir).filter((f) => f.endsWith(".parquet")), `${dir} recebeu parquet`).toEqual([]);
    }
  });
});
