/**
 * Ano que não existe não pode ser respondido com zero.
 *
 * Defeito medido em 14/09/2026, varrendo nos sete servidores do portfólio a
 * classe do "zero calado": `get_hospitalizations({year:[2030]})` devolvia uma
 * linha de medidas NULAS e `summary.total_hospitalizations: 0`, **sem `error` e
 * sem nota**. Quem lê entende "não houve internação em 2030", quando a verdade
 * é "não tenho 2030". Seis das oito ferramentas de dado se comportavam assim;
 * só `get_hospitalization_rates` e `compare_icsap_trends` avisavam, porque a
 * guarda nasceu DENTRO delas, na validação do denominador populacional, e nunca
 * subiu para o funil.
 *
 * Zero é a resposta errada mais perigosa que existe aqui: atravessa o esquema,
 * atravessa o golden (que pina o caminho feliz com fixture cheia), atravessa o
 * cliente e chega ao leitor com cara de número medido. Um erro se conserta; um
 * zero calado se cita.
 *
 * O conserto vive no funil (`callTool`), não em cada ferramenta — foi
 * justamente a guarda que morava só em duas delas que deixou as outras seis
 * desprotegidas por meses.
 *
 * O que este arquivo afirma são INVARIANTES derivados do que o servidor
 * PUBLICA: a lista de ferramentas vem do `tools/list`, então uma ferramenta
 * nova que aceite ano entra no teste sozinha e reprova até se defender.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";

/** Ano que não existe em canal nenhum — a série do SIH vai de 1992 em diante. */
const ANO_INEXISTENTE = 2030;

/** A fixture versionada tem só 2023; 2022 serve de "ano ausente" no caso parcial. */
const ANO_DA_FIXTURE = 2023;
const ANO_AUSENTE_VIZINHO = 2022;

let cliente: Client;

async function conectar(): Promise<Client> {
  const server = createServer();
  const [doCliente, doServidor] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "ano-ausente", version: "0.0.0" });
  await Promise.all([server.connect(doServidor), c.connect(doCliente)]);
  return c;
}

beforeAll(async () => {
  cliente = await conectar();
});

afterAll(async () => {
  await cliente.close();
});

/** Monta os argumentos mínimos de uma tool para um ano só, pelo esquema publicado. */
function argsParaAno(nome: string, props: Record<string, unknown>, ano: number): Record<string, unknown> | null {
  if ("year" in props) {
    const extra: Record<string, unknown> = { year: [ano] };
    // compare_icsap_trends exige o par de anos; quem tem `year` não o tem.
    return extra;
  }
  if ("year_start" in props && "year_end" in props) return { year_start: ano, year_end: ano };
  if ("start_year" in props && "end_year" in props) {
    return { start_year: ano, end_year: ano, compare_by: "uf", compare_values: ["MG"], indicator: "count" };
  }
  return null; // não aceita ano: metadados (list_*, classify_as_csap, get_available_years)
}

function conteudo(r: unknown): Record<string, unknown> {
  return ((r as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}) as Record<string, unknown>;
}

describe("nenhum ano atendível: a ferramenta DIZ, em vez de responder zero", () => {
  it("toda ferramenta que aceita ano recusa o ano inexistente, nomeando o que existe", async () => {
    const { tools } = await cliente.listTools();
    const comAno = tools.filter((t) => argsParaAno(t.name, (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}, ANO_INEXISTENTE) !== null);

    // Se este número cair a zero, o teste passa sem medir nada.
    expect(comAno.length, "nenhuma ferramenta aceita ano?").toBeGreaterThanOrEqual(8);

    for (const t of comAno) {
      const args = argsParaAno(t.name, (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}, ANO_INEXISTENTE)!;
      const r = await cliente.callTool({ name: t.name, arguments: args });
      const sc = conteudo(r);

      expect(sc.error, `${t.name} respondeu SEM dizer que o ano não existe`).toBeTypeOf("string");
      expect(String(sc.error)).toContain(String(ANO_INEXISTENTE));
      // Dizer o que NÃO tem sem dizer o que tem deixa quem lê sem saída.
      expect(Array.isArray(sc.available_sih_years), `${t.name} sem available_sih_years`).toBe(true);
      expect(sc.available_sih_years).toContain(ANO_DA_FIXTURE);

      // E o essencial: nenhum total zerado com cara de medida.
      expect(sc.summary, `${t.name} ainda devolve summary para ano inexistente`).toBeUndefined();
    }
  });
});

describe("ano PARCIALMENTE atendível: responde, mas não estreita a pergunta em silêncio", () => {
  it("a série de dois anos, com um ausente, diz qual ficou de fora e o que sobrou", async () => {
    const r = await cliente.callTool({
      name: "get_hospitalization_trends",
      arguments: { year_start: ANO_AUSENTE_VIZINHO, year_end: ANO_DA_FIXTURE, granularity: "yearly" },
    });
    const sc = conteudo(r);

    // Responde: o ano que existe continua sendo medido.
    expect(Array.isArray(sc.series)).toBe(true);

    const aviso = sc.years_not_available as { years?: number[]; note?: string } | undefined;
    expect(aviso, "respondeu só com 2023 e calou sobre 2022").toBeDefined();
    expect(aviso!.years).toEqual([ANO_AUSENTE_VIZINHO]);
    // A nota precisa dizer as DUAS coisas: o que saiu e o que ficou. Só a
    // primeira metade ainda deixa o leitor achar que a série está completa.
    expect(String(aviso!.note)).toContain(String(ANO_AUSENTE_VIZINHO));
    expect(String(aviso!.note)).toContain(String(ANO_DA_FIXTURE));
  });
});

describe("o portão não estraga o caminho que funciona", () => {
  it("ano inteiro presente responde exatamente como antes, sem chave a mais", async () => {
    const r = await cliente.callTool({
      name: "get_hospitalizations",
      arguments: { year: [ANO_DA_FIXTURE], group_by: ["uf"] },
    });
    const sc = conteudo(r);
    expect(sc).not.toHaveProperty("years_not_available");
    expect(sc).not.toHaveProperty("error");
    expect(sc.summary).toBeDefined();
  });

  it("ferramenta de metadados não é afetada por ano nenhum", async () => {
    // `list_csap_groups` e companhia não leem cubo: a guarda tem de ignorá-las,
    // senão um parâmetro que elas nem aceitam passaria a governar a resposta.
    for (const nome of ["list_csap_groups", "list_cid_chapters", "get_available_years"]) {
      const r = await cliente.callTool({ name: nome, arguments: {} });
      const sc = conteudo(r);
      expect(sc.error, `${nome} virou erro`).toBeUndefined();
      expect(sc).not.toHaveProperty("years_not_available");
    }
  });

  it("o zero LEGÍTIMO continua sendo zero: ano que existe, recorte sem nenhuma linha", async () => {
    // A distinção que este arquivo inteiro defende — "não tenho o ano" contra
    // "tenho o ano e o recorte não casou nada". O segundo É uma medição, e tem
    // de continuar respondendo com os números, sem virar erro.
    const r = await cliente.callTool({
      name: "get_hospitalizations",
      arguments: { year: [ANO_DA_FIXTURE], uf: ["RR"], sex: "F", age_min: 0, age_max: 0, cid_chapter: [22] },
    });
    const sc = conteudo(r);
    expect(sc.error, "recorte vazio de ano existente virou erro").toBeUndefined();
    expect(sc).not.toHaveProperty("years_not_available");
    expect(sc.summary).toBeDefined();
  });
});
