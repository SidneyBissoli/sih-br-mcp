/**
 * O guarda de cursor (src/pagination.ts) e a PREMISSA que o sustenta.
 *
 * A recusa "todo cursor é inválido" só é honesta enquanto nenhuma lista deste
 * servidor paginar. Por isso o primeiro bloco não testa o guarda: testa o
 * servidor REAL, pelo transporte em memória, para ver se a lista de
 * ferramentas passou a devolver `nextCursor` — e se o servidor passou a
 * declarar resources ou prompts, que teriam listas próprias. No dia em que
 * passar, este teste quebra e o guarda tem de mudar junto — em vez de recusar
 * em silêncio a segunda página que o próprio servidor emitiu.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import {
  INVALID_PARAMS,
  PAGINATED_LIST_METHODS,
  unknownCursorError,
  unknownCursorErrorFromText,
} from "../src/pagination.js";
import { createServer } from "../src/server.js";

describe("premissa: nenhuma lista deste servidor pagina", () => {
  let client: Client;

  beforeAll(async () => {
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "pagination", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });
  afterAll(async () => {
    await client.close();
  });

  it("tools/list cabe numa página só — não devolve nextCursor", async () => {
    const pagina = await client.listTools();
    expect(
      (pagina as { nextCursor?: string }).nextCursor,
      "tools/list passou a paginar — a recusa de src/pagination.ts deixou de valer",
    ).toBeUndefined();
    expect(pagina.tools.length).toBeGreaterThan(0);
  });

  it("o servidor não declara resources nem prompts — as outras três listas não existem aqui", () => {
    const capacidades = client.getServerCapabilities() ?? {};
    expect(capacidades.resources, "resources entraram: rever a premissa do guarda de cursor").toBeUndefined();
    expect(capacidades.prompts, "prompts entraram: rever a premissa do guarda de cursor").toBeUndefined();
  });
});

describe("unknownCursorError", () => {
  const requisicao = (method: string, params?: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 7,
    method,
    ...(params ? { params } : {}),
  });

  it("recusa os quatro métodos de lista com -32602, preservando o id", () => {
    for (const method of PAGINATED_LIST_METHODS) {
      const erro = unknownCursorError(requisicao(method, { cursor: "invalido" }));
      expect(erro?.error.code).toBe(INVALID_PARAMS);
      expect(erro?.id).toBe(7);
      expect(erro?.error.message).toContain(method);
    }
  });

  it("deixa passar a lista sem cursor — o caso normal", () => {
    for (const method of PAGINATED_LIST_METHODS) {
      expect(unknownCursorError(requisicao(method))).toBeUndefined();
      expect(unknownCursorError(requisicao(method, {}))).toBeUndefined();
    }
  });

  it("cursor vazio ou nulo também é cursor: recusado, não ignorado", () => {
    expect(unknownCursorError(requisicao("tools/list", { cursor: "" }))?.error.code).toBe(INVALID_PARAMS);
    expect(unknownCursorError(requisicao("tools/list", { cursor: null }))?.error.code).toBe(INVALID_PARAMS);
  });

  it("não se mete com o que não é requisição de lista", () => {
    expect(unknownCursorError(requisicao("tools/call", { cursor: "x" }))).toBeUndefined();
    expect(unknownCursorError(requisicao("initialize", { cursor: "x" }))).toBeUndefined();
    // Notificação (sem id): não há resposta a devolver.
    expect(unknownCursorError({ jsonrpc: "2.0", method: "tools/list", params: { cursor: "x" } })).toBeUndefined();
    // Lote e lixo ficam com o SDK, que já tem erro próprio para eles.
    expect(unknownCursorError([requisicao("tools/list", { cursor: "x" })])).toBeUndefined();
    expect(unknownCursorError("tools/list")).toBeUndefined();
    expect(unknownCursorError(null)).toBeUndefined();
    expect(unknownCursorError({ id: 1, method: "tools/list", params: { cursor: "x" } })).toBeUndefined();
  });
});

describe("unknownCursorErrorFromText (borda HTTP do contêiner)", () => {
  it("decide sobre o corpo JSON do POST", () => {
    const corpo = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "x" } });
    expect(unknownCursorErrorFromText(corpo)?.error.code).toBe(INVALID_PARAMS);
    expect(unknownCursorErrorFromText(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).toBeUndefined();
  });

  it("corpo que não é JSON não é assunto deste guarda — o SDK responde por ele", () => {
    expect(unknownCursorErrorFromText("nao e json")).toBeUndefined();
    expect(unknownCursorErrorFromText("")).toBeUndefined();
  });
});
