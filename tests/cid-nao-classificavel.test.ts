/**
 * `classify_as_csap` respondia sobre código que não é CID nenhum.
 *
 * Medido em 24/09/2026 (item `mcp:ausencia-com-200` do portfólio):
 * `classify_as_csap(["ZZZZ"])` devolvia `is_csap: false`, `csap_group: null`.
 * Lido por quem pergunta, isso é uma afirmação clínica — "essa condição não é
 * sensível à atenção primária" — sobre uma string que não nomeia condição
 * alguma. É a mesma família da ausência com HTTP 200 dos servidores irmãos: a
 * diferença é que aqui não há fonte na rede, e sim pertinência a uma tabela
 * local. A defesa fica igual — na borda, ANTES de classificar.
 *
 * `is_csap: null` é a terceira resposta, e existe para separar duas perguntas
 * que o `false` respondia junto: "não é sensível" e "isto não é uma doença".
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { ehCodigoCid10 } from "../src/tools.js";

let cliente: Client;

beforeAll(async () => {
  const server = createServer();
  const [doCliente, doServidor] = InMemoryTransport.createLinkedPair();
  cliente = new Client({ name: "cid-nao-classificavel", version: "0.0.0" });
  await Promise.all([server.connect(doServidor), cliente.connect(doCliente)]);
});

afterAll(async () => {
  await cliente.close();
});

interface Classificacao {
  cid: string;
  is_csap: boolean | null;
  csap_group: string | null;
  csap_name: string | null;
  error?: string;
}

async function classificar(cid_codes: string[]) {
  const r = await cliente.callTool({ name: "classify_as_csap", arguments: { cid_codes } });
  return r.structuredContent as unknown as {
    classifications: Classificacao[];
    summary: { total: number; csap: number; non_csap: number; not_classified?: number };
    error?: string;
  };
}

describe("ehCodigoCid10: o universo vem da tabela de capítulos, não de uma lista à mão", () => {
  it("aceita as três formas que o SIH e a OMS escrevem", () => {
    expect(ehCodigoCid10("J18")).toBe(true); // categoria
    expect(ehCodigoCid10("J18.0")).toBe(true); // com ponto (OMS)
    expect(ehCodigoCid10("J180")).toBe(true); // sem ponto (SIH)
    expect(ehCodigoCid10("j18")).toBe(true); // minúscula
    expect(ehCodigoCid10(" J18 ")).toBe(true); // com espaço
  });

  it("recusa o que não tem forma de CID-10", () => {
    for (const lixo of ["ZZZZ", "banana", "", "J", "J1", "18J", "J18.00", "123", "J-18"]) {
      expect(ehCodigoCid10(lixo), lixo).toBe(false);
    }
  });

  it("recusa a forma válida que nenhum capítulo contém", () => {
    // Forma perfeita, letra existente, e mesmo assim fora da classificação: os
    // capítulos param em D48 e recomeçam em D50; o XX começa em V01, não V00.
    expect(ehCodigoCid10("D49")).toBe(false);
    expect(ehCodigoCid10("V00")).toBe(false);
    expect(ehCodigoCid10("H96")).toBe(false); // VIII vai até H95
  });

  it("aceita as bordas dos capítulos (a comparação é lexicográfica de propósito)", () => {
    expect(ehCodigoCid10("A00")).toBe(true); // início do I
    expect(ehCodigoCid10("B99")).toBe(true); // fim do I
    expect(ehCodigoCid10("V01")).toBe(true); // início do XX
    expect(ehCodigoCid10("Y98")).toBe(true); // fim do XX
    expect(ehCodigoCid10("W50")).toBe(true); // meio do XX, letra intermediária
    expect(ehCodigoCid10("Z99")).toBe(true); // fim do XXI
  });
});

describe("classify_as_csap: código que não é CID-10 não recebe resposta clínica", () => {
  it("ZZZZ sai como não classificado, nunca como `is_csap: false`", async () => {
    const r = await classificar(["ZZZZ"]);
    const [c] = r.classifications;
    expect(c?.is_csap).toBeNull();
    expect(c?.is_csap).not.toBe(false);
    expect(c?.error).toContain("não é um código CID-10 válido");
    expect(r.summary).toEqual({ total: 1, csap: 0, non_csap: 0, not_classified: 1 });
    expect(r.error).toContain("1 de 1");
  });

  it("CID-10 de verdade que não é sensível continua `false` — a distinção é o conserto", async () => {
    // S72.0 (fratura de colo de fêmur) é código CID-10 legítimo e não é CSAP.
    const r = await classificar(["S72.0"]);
    const [c] = r.classifications;
    expect(c?.is_csap).toBe(false);
    expect(c?.csap_group).toBeNull();
    expect(c?.error).toBeUndefined();
    expect(r.summary).toEqual({ total: 1, csap: 0, non_csap: 1 });
    expect(r).not.toHaveProperty("error");
  });

  it("CID-10 sensível segue classificando", async () => {
    const r = await classificar(["A09"]);
    const [c] = r.classifications;
    expect(c?.is_csap).toBe(true);
    expect(c?.csap_group).toBe("g02");
    expect(r.summary.csap).toBe(1);
  });

  it("lista MISTA: cada entrada com a sua resposta, e o resumo não mistura as três", async () => {
    const r = await classificar(["A09", "S72.0", "ZZZZ", "banana"]);
    expect(r.classifications.map((c) => c.is_csap)).toEqual([true, false, null, null]);
    expect(r.summary).toEqual({ total: 4, csap: 1, non_csap: 1, not_classified: 2 });
    // O erro do topo existe para o cliente que só lê o resumo não concluir que
    // os 4 foram classificados.
    expect(r.error).toContain("2 de 4");
  });

  it("a ordem informada é preservada e o `cid` volta como veio", async () => {
    const r = await classificar([" a09 ", "ZZZZ"]);
    expect(r.classifications.map((c) => c.cid)).toEqual([" a09 ", "ZZZZ"]);
  });
});

/**
 * O ponto é NOTAÇÃO, não dado. Achado em 24/09/2026 enquanto se consertava o
 * `ZZZZ`, e mais grave que ele: o ponto era removido só do lado da LISTA, então
 * entrada dotada nunca casava com código de 4 caracteres. `J18.1` — que ESTÁ na
 * Portaria 221/2008, grupo g06 — saía `is_csap: false`, e `J181` saía `true`.
 * Falso negativo clínico e plausível: não parece errado, e a forma dotada é
 * justamente a que a OMS escreve e a que `cid10_lookup` devolve.
 */
describe("a mesma condição não pode depender de o chamador escrever o ponto", () => {
  const PARES: Array<[string, string, string]> = [
    ["J18.1", "J181", "g06"], // pneumonia bacteriana
    ["J15.3", "J153", "g06"],
    ["E10.2", "E102", "g13"], // diabetes com complicação renal
  ];

  it("forma da OMS e forma do SIH dão a MESMA resposta", async () => {
    for (const [comPonto, semPonto, grupo] of PARES) {
      const r = await classificar([comPonto, semPonto]);
      const [a, b] = r.classifications;
      expect(a?.is_csap, comPonto).toBe(true);
      expect(b?.is_csap, semPonto).toBe(true);
      expect(a?.csap_group, comPonto).toBe(grupo);
      expect(a?.csap_group).toBe(b?.csap_group);
      expect(r.summary.csap).toBe(2);
    }
  });

  it("e o ponto não transforma em sensível o que não é", async () => {
    const r = await classificar(["S72.0", "S720"]);
    expect(r.classifications.map((c) => c.is_csap)).toEqual([false, false]);
  });
});
