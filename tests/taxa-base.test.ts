/**
 * O nome do campo da taxa não pode afirmar uma base que a resposta não usa.
 *
 * Defeito medido em 29/09/2026 pela leitura do código: `get_hospitalization_rates`
 * devolvia o valor em `rate_per_100k` mesmo com `rate_per` 1000 ou 10000 — o
 * esquema chegava a admitir "o nome do campo é histórico". Quem confia no nome
 * (modelo ou pessoa) publica a taxa com a base errada, por fator de 10 ou 100.
 *
 * O teste prende o PAR `rate_per` × nome do campo, com `rate_per` diferente de
 * 100000 — o único caso em que o defeito aparece. Com a base padrão os dois
 * campos coincidem, e um teste só com o padrão passaria com o defeito de volta.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";

type Linha = { uf: string; population: number; n_hospitalizations: number; rate: number; rate_per: number; rate_per_100k: number };

let cliente: Client;

beforeAll(async () => {
  const server = createServer();
  const [doCliente, doServidor] = InMemoryTransport.createLinkedPair();
  cliente = new Client({ name: "taxa-base", version: "0.0.0" });
  await Promise.all([server.connect(doServidor), cliente.connect(doCliente)]);
});

afterAll(async () => {
  await cliente.close();
});

async function linhas(ratePer: number): Promise<Linha[]> {
  const r = await cliente.callTool({ name: "get_hospitalization_rates", arguments: { year: [2023], group_by: ["uf"], rate_per: ratePer } });
  expect(r.isError).toBeFalsy();
  const data = (r.structuredContent as { data?: Linha[] }).data ?? [];
  expect(data.length).toBeGreaterThan(0);
  return data;
}

describe("get_hospitalization_rates: a base da taxa", () => {
  it.each([1000, 10000])("com rate_per %i, `rate` está nessa base e `rate_per_100k` está por 100 mil", async (ratePer) => {
    for (const l of await linhas(ratePer)) {
      expect(l.rate_per).toBe(ratePer);
      const esperada = (l.n_hospitalizations / l.population) * ratePer;
      expect(l.rate).toBeCloseTo(esperada, 1);
      expect(l.rate_per_100k).toBeCloseTo((l.n_hospitalizations / l.population) * 100000, 1);
      // O par que o defeito quebrava: o nome "por 100 mil" não carrega a taxa em outra base.
      // Só onde a diferença sobrevive às duas casas: na fixture há UF com 2 internações
      // para milhões de habitantes, e aí as duas bases arredondam para 0.
      if (l.rate_per_100k >= 1) expect(l.rate_per_100k).not.toBeCloseTo(l.rate, 2);
    }
  });

  it("`rate_per_100k` não depende da base pedida", async () => {
    const porMil = await linhas(1000);
    const porCemMil = await linhas(100000);
    const indice = new Map(porCemMil.map((l) => [l.uf, l.rate_per_100k]));
    for (const l of porMil) expect(l.rate_per_100k).toBeCloseTo(indice.get(l.uf) as number, 2);
  });

  it("com a base padrão os dois campos coincidem", async () => {
    for (const l of await linhas(100000)) expect(l.rate_per_100k).toBe(l.rate);
  });
});
