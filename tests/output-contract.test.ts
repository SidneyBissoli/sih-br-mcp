/**
 * Contrato de saída: o `structuredContent` obedece ao `outputSchema` que o
 * `tools/list` publica — e o ENVELOPE que as doze ferramentas devolvem.
 *
 * Duas metades, na ordem em que nasceram. A segunda (14/09/2026, decisão 37)
 * é o envelope implícito que TODA resposta de sucesso carrega, montado num
 * funil só (src/provenance.ts, withProvenance) e aplicado num ponto só
 * (src/tools.ts, callTool):
 *
 *   { ...dados, provenance, attribution }  +  content[0].text === o JSON disso
 *
 * A primeira (16/09/2026, 0.16.0) é o gate do ilo ao pé da letra
 * (ilo-mcp-server/tests/output-contract.test.ts): o SDK v2 exige
 * `structuredContent` em todo sucesso de tool com `outputSchema`; a spec exige
 * que o conteúdo OBEDEÇA ao esquema, e cliente que valida — o MCP Inspector
 * valida — rejeita a resposta INTEIRA quando não obedece. Rodar o Inspector em
 * `tools/list` não pega nada: só `tools/call` expõe. Os esquemas são escritos à
 * mão (src/output-schemas.ts) a partir das formas MEDIDAS, então o caminho
 * feliz passa mesmo com um esquema desonesto; o defeito mora onde a fonte
 * OMITE um campo ou o anula — por isso cada ferramenta tem caso CHEIO e caso
 * MAGRO.
 *
 * Desde 04/10/2026 o teste tem FORMA DE CLIENTE (ideia de leitor,
 * https://dev.to/arhancanli/comment/3g4i4): o servidor de verdade
 * (`createServer`, o mesmo que os transportes montam) é interrogado pelo
 * `Client` do SDK, que faz `tools/list` e `tools/call` e reprova o resultado
 * contra o schema LISTADO — sem validador escolhido por nós (antes era o
 * `CfWorkerJsonSchemaValidator`, o mesmo do servidor; o Inspector usa outro).
 * O teste falha como a sessão do usuário falharia. Aqui isso pesa: o servidor
 * ANUNCIA o `outputSchema` mas não o impõe (validador permissivo em
 * src/server.ts), então só o cliente pega um schema desonesto. O circuito é o
 * `@sbissoli/mcp-surface/cliente`, comum aos sete servidores: lista antes de
 * chamar (sem `tools/list` o `Client` não valida nada) e passa cada mensagem
 * do servidor por JSON, como a rede.
 *
 * Três defeitos reais deste portfólio vivem no envelope, e nenhum dos gates
 * de baseline os alcança:
 *
 * 1. CAMINHO RÁPIDO QUE PULA O FUNIL. Uma rota curta que devolve cedo sai sem
 *    proveniência — já aconteceu aqui, quando o atalho cortou o sidecar dos
 *    avisos e a série de 34 anos passou a responder sem dizer que 1992–1997
 *    usa lista CID-9 derivada.
 * 2. CHAVE QUE SOME NO FIO. `JSON.stringify` apaga a chave cujo valor é
 *    `undefined`; o transporte em memória não serializa, então o circuito do
 *    cliente serializa cada mensagem, e o conferidor ainda compara os dois
 *    lados por conta própria.
 * 3. TEXTO E ESTRUTURA DISCORDANDO. Cliente que só lê texto tem de receber a
 *    mesma resposta do cliente que lê estrutura.
 *
 * O golden (scripts/golden-tools.mjs) pina VALORES do caminho feliz, com
 * fixture cheia. Aqui cada ferramenta tem um caso CHEIO e um caso MAGRO — a
 * resposta com os campos opcionais AUSENTES, que é onde o defeito mora — e o
 * que se afirma são INVARIANTES, não números: nada aqui quebra quando o canal
 * republicar um cubo.
 *
 * O servidor é o de verdade (createServer), pelo transporte em memória, contra
 * as fixtures versionadas. A rede nunca é tocada (vitest.config.ts desliga o
 * cache de cubos e aponta o DuckDB para tests/fixtures/sih; nada aqui grava
 * nessa pasta).
 */

import type { Client } from "@modelcontextprotocol/client";
import type { InMemoryTransport } from "@modelcontextprotocol/server";
import { chamarComoCliente, conectarComoCliente, controlesNegativos } from "@sbissoli/mcp-surface/cliente";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";

type ServidorReal = ReturnType<typeof createServer>;
type FerramentaListada = { name: string; outputSchema?: unknown };

/**
 * Servidor de verdade cujo `tools/list` sai ADULTERADO a caminho do cliente
 * (o resultado de `tools/call`, não). Serve à prova pelo lado do schema: o
 * helper comum só mexe no resultado de `tools/call`. Clona antes de mexer —
 * o objeto da mensagem pode ser o mesmo que o servidor registrou.
 */
function comListagemAdulterada(server: ServidorReal, adulterar: (tools: FerramentaListada[]) => void) {
  return {
    connect(transporte: InMemoryTransport): Promise<void> {
      const enviar = transporte.send.bind(transporte);
      transporte.send = async (mensagem, extra) => {
        const r = (mensagem as { result?: { tools?: unknown } }).result;
        if (r && Array.isArray(r.tools)) {
          const copia = JSON.parse(JSON.stringify(mensagem)) as typeof mensagem;
          adulterar((copia as unknown as { result: { tools: FerramentaListada[] } }).result.tools);
          return enviar(copia, extra);
        }
        return enviar(mensagem, extra);
      };
      return server.connect(transporte);
    },
  };
}

// ---------------------------------------------------------------------------
// O conferidor do envelope
//
// Deliberadamente escrito de fora, sem importar nada de src/provenance.ts: uma
// guarda que reusa o padrão daquilo que vigia concorda com o defeito. Ele
// devolve a LISTA de violações (e não um booleano) por duas razões: a mensagem
// de falha nomeia o que quebrou, e o teste do fim do arquivo consegue provar
// que o portão reprova de verdade.
// ---------------------------------------------------------------------------

const CAMPOS_DE_PROVENIENCIA = ["source", "source_url", "retrieved_at", "citation", "license"] as const;

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function conferirEnvelope(resultado: unknown): string[] {
  const faltas: string[] = [];
  if (!ehObjeto(resultado)) return ["resposta não é objeto"];

  const sc = resultado.structuredContent;
  if (!ehObjeto(sc)) return ["sem structuredContent (o funil de withProvenance foi pulado)"];

  // -- proveniência: uma ou várias, cada uma completa -------------------------
  const blocos = Array.isArray(sc.provenance) ? sc.provenance : [sc.provenance];
  if (sc.provenance === undefined) faltas.push("sem provenance");
  else if (blocos.length === 0) faltas.push("provenance vazia");
  else
    blocos.forEach((bloco, i) => {
      if (!ehObjeto(bloco)) return faltas.push(`provenance[${i}] não é objeto`);
      for (const campo of CAMPOS_DE_PROVENIENCIA) {
        if (typeof bloco[campo] !== "string" || (bloco[campo] as string).length === 0) {
          faltas.push(`provenance[${i}].${campo} ausente ou vazio`);
        }
      }
    });

  // -- atribuição -------------------------------------------------------------
  if (!Array.isArray(sc.attribution) || sc.attribution.length === 0) faltas.push("attribution ausente ou vazia");

  // -- o texto é o JSON da estrutura, e sobrevive ao fio ----------------------
  const partes = resultado.content;
  if (!Array.isArray(partes) || partes.length !== 1) {
    faltas.push(`content deveria ter exatamente uma parte, tem ${Array.isArray(partes) ? partes.length : "nenhuma"}`);
  } else {
    const parte = partes[0] as { type?: string; text?: string };
    if (parte.type !== "text") faltas.push(`content[0].type = ${String(parte.type)}`);
    else {
      let doTexto: unknown;
      try {
        doTexto = JSON.parse(parte.text ?? "");
      } catch {
        return [...faltas, "content[0].text não é JSON — cliente que só lê texto recebe prosa"];
      }
      // `structuredContent` atravessa o fio como JSON, e JSON.stringify apaga
      // chave cujo valor é `undefined`. O transporte em memória não serializa,
      // então a serialização acontece aqui — é o cliente real sendo imitado.
      const noFio = JSON.parse(JSON.stringify(sc)) as unknown;
      if (JSON.stringify(doTexto) !== JSON.stringify(noFio)) {
        faltas.push("content[0].text e structuredContent discordam");
      }
    }
  }

  return faltas;
}

// ---------------------------------------------------------------------------
// Os casos: um CHEIO e um MAGRO por ferramenta
//
// MAGRO aqui não quer dizer "erro": quer dizer resposta legítima em que os
// campos opcionais NÃO aparecem — recorte sem nenhuma linha, código fora da
// lista, ano que a fixture não tem, detalhe não pedido.
// ---------------------------------------------------------------------------

interface Caso {
  nome: string;
  cobre: string;
  magro: boolean;
  args: Record<string, unknown>;
}

const CASOS: Caso[] = [
  // -- metadados, sem parâmetro ----------------------------------------------
  { nome: "list_cid_chapters", cobre: "os capítulos CID", magro: false, args: {} },
  { nome: "get_available_years", cobre: "os anos da fixture", magro: false, args: {} },

  // -- metadados com parâmetro -----------------------------------------------
  { nome: "list_csap_groups", cobre: "os 19 grupos com os códigos CID", magro: false, args: { include_cid_codes: true } },
  { nome: "list_csap_groups", cobre: "um grupo só, sem a lista de códigos", magro: true, args: { group_code: "g01" } },

  { nome: "classify_as_csap", cobre: "códigos que classificam", magro: false, args: { cid_codes: ["J45", "I10", "A09"] } },
  { nome: "classify_as_csap", cobre: "código que não é CID-10 (não classificado)", magro: true, args: { cid_codes: ["ZZZZ"] } },

  // -- internações gerais ----------------------------------------------------
  { nome: "get_hospitalizations", cobre: "ano cheio agrupado por UF", magro: false, args: { year: [2023], group_by: ["uf"] } },
  {
    nome: "get_hospitalizations",
    cobre: "recorte sem nenhuma linha — as medidas vêm NULAS",
    magro: true,
    args: { year: [2023], uf: ["RR"], sex: "F", age_min: 0, age_max: 0, cid_chapter: [22] },
  },

  { nome: "get_hospitalization_trends", cobre: "série mensal de um ano cheio", magro: false, args: { year_start: 2023, year_end: 2023, granularity: "monthly" } },
  {
    nome: "get_hospitalization_trends",
    cobre: "série de um capítulo sem movimento na UF",
    magro: true,
    args: { year_start: 2023, year_end: 2023, uf: ["RR"], cid_chapter: 22 },
  },

  { nome: "compare_regions", cobre: "ranking das UFs", magro: false, args: { year: [2023], compare_by: "uf" } },
  { nome: "compare_regions", cobre: "ranking de um capítulo sem movimento", magro: true, args: { year: [2023], cid_chapter: 22, limit: 1 } },

  // -- ICSAP -----------------------------------------------------------------
  { nome: "get_icsap", cobre: "ICSAP do ano por grupo", magro: false, args: { year: [2023], group_by: ["csap_group"] } },
  {
    nome: "get_icsap",
    cobre: "recorte demográfico sem nenhuma linha",
    magro: true,
    args: { year: [2023], uf: ["RR"], csap_group: ["g19"], sex: "F", age_min: 0, age_max: 0 },
  },

  { nome: "get_icsap_indicators", cobre: "indicadores do ano por UF", magro: false, args: { year: [2023], group_by: ["uf"] } },
  { nome: "get_icsap_indicators", cobre: "indicadores de um recorte vazio", magro: true, args: { year: [2023], uf: ["RR"], sex: "F", age_min: 0, age_max: 0 } },

  { nome: "rank_csap_groups", cobre: "os grupos ordenados por internação", magro: false, args: { year: [2023] } },
  { nome: "rank_csap_groups", cobre: "ranking de um recorte vazio", magro: true, args: { year: [2023], uf: ["RR"], sex: "F", age_min: 0, age_max: 0, limit: 1 } },

  // -- ferramentas com denominador populacional -------------------------------
  { nome: "get_hospitalization_rates", cobre: "taxa bruta do ano", magro: false, args: { year: [2023], group_by: ["uf"] } },
  {
    nome: "get_hospitalization_rates",
    cobre: "ano SEM dado de internação — a resposta diz isso, e mesmo assim é envelopada",
    magro: true,
    args: { year: [1995], uf: ["RR"], age_min: 0, age_max: 4 },
  },

  {
    nome: "compare_icsap_trends",
    cobre: "duas UFs no ano cheio",
    magro: false,
    args: { start_year: 2023, end_year: 2023, compare_by: "uf", compare_values: ["MG", "RJ"], indicator: "percentage" },
  },
  {
    nome: "compare_icsap_trends",
    cobre: "UF sem movimento no recorte",
    magro: true,
    args: { start_year: 2023, end_year: 2023, compare_by: "uf", compare_values: ["RR"], indicator: "count" },
  },
];

/** Ferramentas sem parâmetro nenhum: não há caso magro a construir. */
const SEM_PARAMETRO = new Set(["list_cid_chapters", "get_available_years"]);

// ---------------------------------------------------------------------------

/**
 * Uma conexão no percurso do cliente para a suíte inteira: o `Client` lista
 * uma vez e, a partir daí, reprova todo `tools/call` cujo `structuredContent`
 * não obedeça ao schema listado. `chamarComoCliente` lança nesse caso e também
 * quando a ferramenta responde `isError`.
 */
let cliente: Client;

beforeAll(async () => {
  cliente = await conectarComoCliente(createServer());
});

afterAll(async () => {
  await cliente.close();
});

describe("toda resposta de sucesso sai envelopada e obedece ao outputSchema anunciado", () => {
  it.each(CASOS.map((c) => [`${c.nome} — ${c.magro ? "MAGRO" : "cheio"} — ${c.cobre}`, c] as const))("%s", async (_titulo, caso) => {
    const resultado = await chamarComoCliente(cliente, caso.nome, caso.args);
    expect(conferirEnvelope(resultado), `${caso.nome} (${caso.cobre})`).toEqual([]);
  });

  /**
   * O caminho de ERRO-MOLE também é sucesso — resposta sem `isError`, com
   * `structuredContent`, que carrega `error` em vez dos dados (decisão 38: "ano
   * sem dado" sai do funil como sucesso honesto, não como falha). Cliente que
   * valida recebe essa resposta como qualquer outra, então o esquema tem de
   * prevê-la: é o segundo ramo do `anyOf` de cada ferramenta de dado.
   */
  it.each([
    ["get_hospitalizations", { year: [2030] }],
    ["get_hospitalization_trends", { year_start: 2029, year_end: 2030 }],
    ["compare_regions", { year: [2030] }],
    ["get_icsap", { year: [2030] }],
    ["get_icsap_indicators", { year: [2030] }],
    ["rank_csap_groups", { year: [2030] }],
    ["get_hospitalization_rates", { year: [2030] }],
    ["compare_icsap_trends", { start_year: 2029, end_year: 2030 }],
    ["list_csap_groups", { group_code: "g99" }],
  ] as const)("erro-mole de %s obedece ao esquema", async (nome, args) => {
    const resultado = await chamarComoCliente(cliente, nome, args as Record<string, unknown>);
    const sc = resultado.structuredContent as Record<string, unknown>;
    expect(typeof sc.error).toBe("string");
  });

  /**
   * Um portão que não pode reprovar não vale nada — e um esquema em que tudo é
   * opcional passaria qualquer coisa. Prova pelo lado do SCHEMA: o servidor
   * responde certo, mas o `tools/list` que chega ao cliente ANUNCIA uma
   * mentira — `csap_group` como `string`, quando a fonte o anula (código fora
   * da lista). É a mentira exata que este arquivo existe para pegar, e quem a
   * recusa é o próprio `Client`, nomeando o campo. A prova pelo lado do
   * RESULTADO (resposta mutilada, chave intrusa) está nos controles negativos
   * abaixo.
   */
  it("reprova esquema desonesto (prova de que o portão fecha)", async () => {
    await chamarComoCliente(cliente, "classify_as_csap", { cid_codes: ["ZZZZ"] });

    const desonesto = await conectarComoCliente(comListagemAdulterada(createServer(), (tools) => {
      const t = tools.find((x) => x.name === "classify_as_csap") as {
        outputSchema: { properties: { classifications: { items: { properties: Record<string, unknown> } } } };
      };
      t.outputSchema.properties.classifications.items.properties.csap_group = { type: "string" };
    }));
    try {
      await expect(chamarComoCliente(desonesto, "classify_as_csap", { cid_codes: ["ZZZZ"] })).rejects.toThrow(/csap_group/);
    } finally {
      await desonesto.close();
    }
  });

  /**
   * A cobertura tem de acompanhar a superfície: ferramenta nova entra no
   * `tools/list` e este teste reprova até ganhar os seus casos. Derivar a lista
   * do que o servidor PUBLICA, e não de uma constante escrita à mão, é o que
   * impede a suíte de envelhecer calada.
   */
  it("toda ferramenta publicada declara outputSchema e tem caso cheio e caso magro", async () => {
    const { tools } = await cliente.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      const saida = t.outputSchema as { type?: string; required?: string[]; anyOf?: unknown[] } | undefined;
      expect(saida, `${t.name} sem outputSchema`).toBeDefined();
      expect(saida?.type).toBe("object");
      // O envelope é obrigatório em toda ferramenta: proveniência e atribuição.
      expect(saida?.required).toEqual(expect.arrayContaining(["provenance", "attribution"]));
      expect(Array.isArray(saida?.anyOf) && saida.anyOf.length > 0, `${t.name} sem formas (anyOf)`).toBe(true);
      const meus = CASOS.filter((c) => c.nome === t.name);
      expect(meus.length, `${t.name} sem nenhum caso`).toBeGreaterThan(0);
      if (!SEM_PARAMETRO.has(t.name)) {
        expect(meus.some((c) => c.magro), `${t.name} sem caso MAGRO`).toBe(true);
        expect(meus.some((c) => !c.magro), `${t.name} sem caso cheio`).toBe(true);
      }
    }
    // E o contrário: caso órfão de ferramenta que não existe mais.
    const publicadas = new Set(tools.map((t) => t.name));
    for (const c of CASOS) expect(publicadas.has(c.nome), `caso para ${c.nome}, que não está publicada`).toBe(true);
  });

  /**
   * Um portão que não pode reprovar não vale nada. Aqui uma resposta REAL é
   * mutilada de quatro formas — as quatro que este arquivo existe para pegar —
   * e o conferidor tem de recusar cada uma.
   */
  it("reprova envelope mutilado (prova de que o conferidor do envelope fecha)", async () => {
    const bom = (await chamarComoCliente(cliente, "get_available_years", {})) as Record<string, unknown>;
    expect(conferirEnvelope(bom)).toEqual([]);

    const clonar = () => JSON.parse(JSON.stringify(bom)) as Record<string, unknown>;

    const semEnvelope = clonar();
    delete semEnvelope.structuredContent;
    expect(conferirEnvelope(semEnvelope).join(" ")).toContain("structuredContent");

    const semProveniencia = clonar();
    delete (semProveniencia.structuredContent as Record<string, unknown>).provenance;
    expect(conferirEnvelope(semProveniencia).join(" ")).toContain("provenance");

    const semAtribuicao = clonar();
    delete (semAtribuicao.structuredContent as Record<string, unknown>).attribution;
    expect(conferirEnvelope(semAtribuicao).join(" ")).toContain("attribution");

    const textoDivergente = clonar();
    (textoDivergente.structuredContent as Record<string, unknown>).intruso = 1;
    expect(conferirEnvelope(textoDivergente).join(" ")).toContain("discordam");

    const proveniênciaIncompleta = clonar();
    const p = (proveniênciaIncompleta.structuredContent as Record<string, unknown>).provenance;
    delete (Array.isArray(p) ? (p[0] as Record<string, unknown>) : (p as Record<string, unknown>)).license;
    expect(conferirEnvelope(proveniênciaIncompleta).join(" ")).toContain("license");
  });
});

// ==================== controle negativo, no percurso do cliente ====================
//
// Prova pelo lado do RESULTADO: o servidor responde certo e o resultado é
// quebrado NO FIO, entre servidor e cliente — como chegaria de um servidor com
// defeito. Cada quebra tem de fazer a chamada falhar. As genéricas saem do
// schema listado (structuredContent ausente, cada obrigatório do topo ausente,
// tipo trocado); as duas deste servidor: sem `summary` (obrigatório só dentro
// do ramo do caminho feliz do `anyOf`, que as genéricas não veem — sem ele o
// caminho feliz não fecha e o de erro-mole também não) e a chave intrusa,
// porque o topo é FECHADO (`additionalProperties: false`, afirmado abaixo
// sobre o schema listado, não suposto). O último veredito é a armadilha: sem
// `tools/list` antes, o Client não valida — se o SDK mudar isso, ele acusa.

describe("o validador do cliente reprova resultado quebrado no fio", () => {
  it("get_hospitalizations: toda quebra reprova, e a armadilha se confirma", async () => {
    const { tools } = await cliente.listTools();
    const esquema = tools.find((t) => t.name === "get_hospitalizations")?.outputSchema as { additionalProperties?: unknown } | undefined;
    expect(esquema?.additionalProperties, "topo do outputSchema deixou de ser fechado").toBe(false);

    const vs = await controlesNegativos(() => createServer(), "get_hospitalizations", { year: [2023], group_by: ["uf"] }, [
      {
        descricao: "sem summary (ramo do caminho feliz do anyOf)",
        adulterar: (r) => void delete r.structuredContent?.summary,
      },
      {
        descricao: "campo que o topo fechado proíbe (intruso)",
        adulterar: (r) => {
          if (r.structuredContent) r.structuredContent.intruso = 1;
        },
      },
    ]);
    expect(vs.length).toBeGreaterThanOrEqual(5);
    for (const v of vs) expect(v.obtido, `${v.descricao}: ${v.mensagem ?? ""}`).toBe(v.esperado);
  });
});

/**
 * Contrato de ENTRADA. Fica neste arquivo porque é a outra metade da mesma
 * promessa, e porque o defeito que ele vigia é do mesmo feitio: em 11/09/2026
 * os esquemas ganharam `additionalProperties: false` porque a chave
 * desconhecida era descartada em silêncio, o default do parâmetro que faltou
 * entrava no lugar e a ferramenta respondia OUTRA pergunta com cara de
 * resposta — `list_csap_groups({group_codes: "g01"})`, no plural, devolvia os
 * 19 grupos como se fosse o pedido. A recusa precisa NOMEAR a chave: é o que
 * faz o modelo se corrigir na chamada seguinte em vez de repetir o engano.
 */
describe("contrato de entrada", () => {
  it("toda ferramenta recusa parâmetro que não existe", async () => {
    const { tools } = await cliente.listTools();
    for (const t of tools) {
      const r = await cliente.callTool({ name: t.name, arguments: { parametro_que_nao_existe: 1 } });
      expect(r.isError, `${t.name} ACEITOU chave desconhecida`).toBe(true);
    }
  });

  it("a recusa nomeia a chave errada", async () => {
    const r = await cliente.callTool({ name: "list_csap_groups", arguments: { group_codes: "g01" } });
    const texto = JSON.stringify(r.content);
    expect(r.isError).toBe(true);
    expect(texto).toContain("group_codes");
  });

  it("o esquema publicado fecha para chave extra", async () => {
    const { tools } = await cliente.listTools();
    for (const t of tools) {
      expect((t.inputSchema as { additionalProperties?: unknown }).additionalProperties, `${t.name} aberta`).toBe(false);
    }
  });
});
