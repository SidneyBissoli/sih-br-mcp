/**
 * Server card (src/card.ts): a lista de ferramentas vem do container quando
 * ele responde, e da lista estática quando não — sem 500 e sem cachear o
 * fallback.
 */

import { afterEach, describe, expect, it } from "vitest";

import { _resetServerCard, buildServerCard, getServerCard, readJsonRpcResponse } from "../src/card.js";
import { SERVER_CONFIG, TOOLS } from "../src/config.js";

afterEach(() => _resetServerCard());

const TOOLS_DO_CONTAINER = [{ name: "get_icsap", title: "ICSAP", inputSchema: { type: "object" } }];

/** Container de mentira: responde initialize e tools/list em SSE, como o SDK. */
async function containerFake(req: Request): Promise<Response> {
  const body = (await req.json()) as { id: number; method: string };
  const result =
    body.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: {} }
      : { tools: TOOLS_DO_CONTAINER };
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`;
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("readJsonRpcResponse", () => {
  it("lê JSON direto", async () => {
    const r = await readJsonRpcResponse(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { a: 1 } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(r.result).toEqual({ a: 1 });
  });

  it("lê o evento data de um SSE", async () => {
    const r = await readJsonRpcResponse(
      new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"b":2}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    expect(r.result).toEqual({ b: 2 });
  });
});

describe("buildServerCard", () => {
  it("com o container respondendo, as ferramentas são as dele", async () => {
    const card = JSON.parse(await buildServerCard(containerFake)) as Record<string, unknown>;
    expect(card.name).toBe(SERVER_CONFIG.name);
    expect(card.version).toBe(SERVER_CONFIG.version);
    expect(card.websiteUrl).toBe(SERVER_CONFIG.websiteUrl);
    expect(card.protocolVersion).toBe("2025-06-18");
    expect(card.tools).toEqual(TOOLS_DO_CONTAINER);
    expect(card.source).toBe("container");
  });

  it("com o container fora, cai na lista estática e diz isso", async () => {
    const card = JSON.parse(
      await buildServerCard(() => Promise.reject(new Error("cold start estourou"))),
    ) as Record<string, unknown>;
    expect(card.tools).toEqual(TOOLS.map((t) => ({ name: t.name, title: t.title })));
    expect(card.source).toBe("static");
  });

  it("erro JSON-RPC do container também cai no fallback", async () => {
    const card = JSON.parse(
      await buildServerCard(async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "x" } }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as Record<string, unknown>;
    expect(card.source).toBe("static");
  });
});

describe("getServerCard (cache por isolate)", () => {
  it("cacheia o card do container: a segunda chamada não bate no container", async () => {
    let chamadas = 0;
    const f = (req: Request) => {
      chamadas++;
      return containerFake(req);
    };
    await getServerCard(f);
    expect(chamadas).toBe(2); // initialize + tools/list
    await getServerCard(f);
    expect(chamadas).toBe(2);
  });

  it("NÃO cacheia o fallback: quando o container voltar, o card volta com ele", async () => {
    let fora = true;
    const f = (req: Request) => (fora ? Promise.reject(new Error("fora")) : containerFake(req));
    expect(JSON.parse(await getServerCard(f)).source).toBe("static");
    fora = false;
    expect(JSON.parse(await getServerCard(f)).source).toBe("container");
  });
});
