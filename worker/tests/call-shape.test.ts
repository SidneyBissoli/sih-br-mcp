/**
 * GUARDA DO VOCABULÁRIO — as mensagens de erro DESTE produto, varridas contra
 * o classificador, como nos seis irmãos (a receita está na memória
 * "vocabulário da classe medido por servidor": classificador da frota é o
 * mesmo em todo lugar, mas as mensagens que ele precisa entender são as de
 * cada servidor).
 *
 * Toda mensagem abaixo foi colhida do código do container (src/tools.ts,
 * src/db, src/utils) ou medida na produção em 24/09/2026. Se alguém mudar uma
 * mensagem de erro e ela passar a cair noutra classe, é aqui que aparece.
 *
 * O LIMITE DESTA CAMADA está registrado no fim do arquivo, e não é acidente:
 * a borda vê a MENSAGEM, não a exceção. Os seis irmãos têm `classifyThrown`,
 * que olha o TIPO do erro (TypeError, RangeError...) e devolve `defeito`; aqui
 * o handler roda do outro lado do container e o que chega é texto. As
 * mensagens do `catch` genérico ("Erro ao executar X: ...") caem em `outro`
 * de propósito — `outro` é o sinal honesto de "falhou e a borda não sabe
 * dizer o quê", e é exatamente o que instrumentar o container compraria.
 */

import { describe, expect, it } from "vitest";

import { classeDoErroRpc, classifyError, errorText, type ErrorClass } from "../src/call-shape.js";

/** Mensagens reais do produto → classe esperada. */
const MENSAGENS: Array<[string, ErrorClass]> = [
  // --- contrato: o chamador mandou a chamada errada ---
  [
    'Input validation error: Invalid arguments for tool get_hospitalizations: #: Property "year" does not match schema.; #/year: Instance type "string" is invalid. Expected "array".',
    "contrato",
  ],
  ["Ferramenta desconhecida: get_coisa_nenhuma", "contrato"],

  // --- nao_encontrado: chamou certo, o valor não existe ---
  [
    "Ano(s) 2030 não publicado(s) no canal de cubos (https://healthbr-data.sidneybissoli.com/sih/cubos/) e nenhum cubo local.",
    "nao_encontrado",
  ],
  ["Nenhum dos anos solicitados (1800) tem dados SIH disponíveis.", "nao_encontrado"],
  ["Grupo CSAP inexistente: grupo_que_nao_existe", "nao_encontrado"],

  // --- fonte: a fonte falhou, demorou ou não publica ---
  ["HTTP 503 em https://healthbr-data.sidneybissoli.com/sih/cubos/manifest.json", "fonte"],
  [
    "manifesto dos cubos indisponível (https://healthbr-data.sidneybissoli.com/sih/cubos/) e sem cópia local",
    "fonte",
  ],
  [
    "pop_uf_agregado.parquet indisponível: sem população por faixa etária antes de 2000.",
    "fonte",
  ],

  // --- outro: a borda não tem como saber (ver o cabeçalho deste arquivo) ---
  ["Erro ao executar get_icsap: Erro na query (ano 2023): Binder Error\nSQL: SELECT 1", "outro"],
  ["Erro ao executar get_hospitalizations: Erro ao criar banco DuckDB: out of memory", "outro"],
  ["sih_2023.parquet: SHA-256 não confere com o manifesto", "outro"],
  ["sih_2023.parquet: 10 bytes recebidos, manifesto diz 20", "outro"],
];

describe("classifyError — mensagens do sih-br-mcp", () => {
  it.each(MENSAGENS)("%s", (mensagem, classe) => {
    expect(classifyError(mensagem)).toBe(classe);
  });

  it("o vocabulário é fechado: nada sai fora dele", () => {
    const fechado = new Set(["contrato", "nao_encontrado", "fonte", "defeito", "outro"]);
    for (const [mensagem] of MENSAGENS) expect(fechado.has(classifyError(mensagem))).toBe(true);
  });

  it('"erro desconhecido" NÃO é contrato — é o caso sem classe, não um valor recusado', () => {
    expect(classifyError("Erro desconhecido ao consultar o canal de cubos")).toBe("outro");
    expect(classifyError("Ferramenta desconhecida: x")).toBe("contrato");
  });
});

describe("classeDoErroRpc — o sinal que só a borda tem", () => {
  it("códigos reservados do JSON-RPC dizem de quem é o conserto, sem depender do idioma", () => {
    expect(classeDoErroRpc(-32700, "Parse error")).toBe("contrato");
    expect(classeDoErroRpc(-32600, "Invalid Request")).toBe("contrato");
    expect(classeDoErroRpc(-32601, "Method not found")).toBe("contrato");
    expect(classeDoErroRpc(-32602, "Tool ferramenta_que_nao_existe not found")).toBe("contrato");
    expect(classeDoErroRpc(-32603, "Internal error")).toBe("defeito");
  });

  it("código do servidor (fora da faixa reservada) ou ausente cai na mensagem", () => {
    expect(classeDoErroRpc(-32000, "Tempo de resposta excedido")).toBe("fonte");
    expect(classeDoErroRpc(undefined, "Ano não encontrado")).toBe("nao_encontrado");
    expect(classeDoErroRpc(undefined, "")).toBe("outro");
  });
});

describe("errorText — de onde sai o texto que se classifica", () => {
  it("lê o campo error do envelope JSON, não o payload inteiro", () => {
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Nenhum dos anos solicitados (1800) tem dados SIH disponíveis.",
            hint: "a fonte oficial pode estar indisponível",
          }),
        },
      ],
    };
    // Sem esta regra, o "indisponível" do hint de formulário arrastaria a
    // mensagem para `fonte` — foi o que aconteceu no senado em 10/09/2026.
    expect(classifyError(errorText(result))).toBe("nao_encontrado");
  });

  it("texto cru vale quando não é o envelope JSON", () => {
    expect(errorText({ content: [{ type: "text", text: "Ferramenta desconhecida: x" }] })).toBe(
      "Ferramenta desconhecida: x",
    );
  });

  it("structuredContent.error tem precedência", () => {
    expect(
      errorText({ structuredContent: { error: "Ano não encontrado" }, content: [{ text: "outra coisa" }] }),
    ).toBe("Ano não encontrado");
  });

  it("resultado sem texto de erro devolve vazio, e vazio é `outro`", () => {
    expect(errorText({})).toBe("");
    expect(errorText(null)).toBe("");
    expect(errorText({ content: [] })).toBe("");
    expect(classifyError("")).toBe("outro");
  });
});
