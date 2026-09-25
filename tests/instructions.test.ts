/**
 * As instruções do handshake (SERVER_INSTRUCTIONS em src/server.ts) e o que
 * as mantém verdadeiras.
 *
 * O texto cita as ferramentas pelo nome para dizer o fluxo entre elas. Um nome
 * citado que não existe manda o modelo chamar o que não há; uma ferramenta que
 * existe e não é citada fica sem lugar no fluxo. Os dois lados são medidos
 * contra `tools`, o catálogo real — nunca contra uma lista copiada aqui.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import { tools } from "../src/tools.js";

/** Tokens com cara de nome de ferramenta: minúsculas e sublinhado, com pelo menos um sublinhado. */
const nomesCitados = (texto: string): string[] => [...new Set(texto.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? [])];

describe("SERVER_INSTRUCTIONS", () => {
  const catalogo = new Set(tools.map((t) => t.name));

  it("todo nome de ferramenta citado existe no catálogo", () => {
    for (const nome of nomesCitados(SERVER_INSTRUCTIONS)) {
      expect(catalogo.has(nome), `instructions citam "${nome}", que não é ferramenta`).toBe(true);
    }
  });

  it("toda ferramenta do catálogo é citada — ferramenta nova precisa de lugar no fluxo", () => {
    const citados = new Set(nomesCitados(SERVER_INSTRUCTIONS));
    for (const nome of catalogo) {
      expect(citados.has(nome), `a ferramenta "${nome}" não aparece nas instructions`).toBe(true);
    }
  });

  it("diz quando NÃO usar o servidor (critério de review de conectores)", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Do not use this server/);
  });
});

describe("o handshake carrega as instruções", () => {
  let client: Client;

  beforeAll(async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "instructions", version: "0.0.0" });
    await Promise.all([createServer().connect(st), client.connect(ct)]);
  });
  afterAll(async () => {
    await client.close();
  });

  it("initialize.result.instructions é o mesmo texto de src/server.ts", () => {
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });
});
