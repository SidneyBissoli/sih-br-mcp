/**
 * Server card (src/card.ts): vem do container quando ele responde — e então é
 * a MESMA superfície da trava (sha256 da seção `declarada`) —, e da lista
 * estática quando não, na mesma forma, sem 500 e sem cachear o fallback.
 *
 * O "container" aqui roda o handler real em processo (o `createServer` do
 * build da raiz, `../../dist`, como em tests/surface-lock.test.ts): um dublê
 * escrito à mão provaria só que o card copia o dublê. Pede `npm run build` na
 * raiz antes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { impressaoDigital, lerTrava, normalizarSuperficie } from "@sbissoli/mcp-surface";
import { superficieDoCard } from "@sbissoli/mcp-surface/card";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../dist/server.js";
import { _resetServerCard, getServerCard } from "../src/card.js";
import { SERVER_CONFIG, TOOLS } from "../src/config.js";

afterEach(() => _resetServerCard());

const raiz = fileURLToPath(new URL("../../", import.meta.url).href);
const caminhoDaTrava = `${raiz}surface.lock.json`;
const versao = (JSON.parse(readFileSync(`${raiz}package.json`, "utf8")) as { version: string }).version;

const handler = createMcpHandler(() => createServer(), { legacy: "stateless", responseMode: "sse" });
const container = (req: Request) => handler.fetch(req);

describe("getServerCard — container respondendo", () => {
  it("serverInfo é o do initialize real, com a versão do package.json", async () => {
    const card = JSON.parse(await getServerCard(container)) as Record<string, unknown>;
    const serverInfo = card.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe(SERVER_CONFIG.name);
    expect(serverInfo.version).toBe(versao);
    expect(card.authentication).toEqual({ required: false });
    expect(card.source).toBeUndefined();
    expect((card.tools as { name: string }[]).map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  }, 60_000);

  it("o card normalizado tem o MESMO sha256 da seção declarada da trava", async () => {
    const card = JSON.parse(await getServerCard(container)) as Record<string, unknown>;
    expect(impressaoDigital(normalizarSuperficie(superficieDoCard(card)))).toBe(lerTrava(caminhoDaTrava).declarada?.sha256);
  }, 60_000);

  it("cacheia o card do container: a segunda chamada não bate no container", async () => {
    let chamadas = 0;
    const f = (req: Request) => {
      chamadas++;
      return container(req);
    };
    await getServerCard(f);
    const depoisDaPrimeira = chamadas;
    expect(depoisDaPrimeira).toBeGreaterThan(0);
    await getServerCard(f);
    expect(chamadas).toBe(depoisDaPrimeira);
  }, 60_000);
});

describe("getServerCard — container fora", () => {
  it("cai na lista estática, na forma da Smithery, e diz isso", async () => {
    const card = JSON.parse(
      await getServerCard(() => Promise.reject(new Error("cold start estourou"))),
    ) as Record<string, unknown>;
    expect(card.serverInfo).toEqual({
      name: SERVER_CONFIG.name,
      version: SERVER_CONFIG.version,
      websiteUrl: SERVER_CONFIG.websiteUrl,
    });
    expect(card.authentication).toEqual({ required: false });
    expect(card.tools).toEqual(TOOLS.map((t) => ({ name: t.name, title: t.title })));
    expect(card.source).toBe("static");
    expect(card).not.toHaveProperty("name");
    expect(card).not.toHaveProperty("version");
  });

  it("erro JSON-RPC no initialize também cai no fallback", async () => {
    const card = JSON.parse(
      await getServerCard(async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "x" } }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as Record<string, unknown>;
    expect(card.source).toBe("static");
  });

  it("NÃO cacheia o fallback: quando o container voltar, o card volta com ele", async () => {
    let fora = true;
    const f = (req: Request) => (fora ? Promise.reject(new Error("fora")) : container(req));
    expect(JSON.parse(await getServerCard(f)).source).toBe("static");
    fora = false;
    const card = JSON.parse(await getServerCard(f)) as Record<string, unknown>;
    expect(card.source).toBeUndefined();
    expect((card.serverInfo as Record<string, unknown>).version).toBe(versao);
  }, 60_000);
});
