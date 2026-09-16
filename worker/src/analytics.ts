/**
 * Telemetria de tool calls no Analytics Engine — uma linha por chamada, com o
 * contexto da REQUISIÇÃO que o UsageTracker não tem: país, organização do AS
 * (egress de plataformas de IA aparece como a rede delas, ex.: Anthropic/
 * Google Cloud) e o marcador de uso próprio (header secreto configurado só nos
 * clientes MCP do dono — único jeito de separar o uso do dono quando ele chega
 * por conectores hospedados, que egressam de servidores da plataforma).
 *
 * Esquema de blobs CONSISTENTE com o senado-br-mcp-cloudflare (instrument.ts):
 *   index1 = tool | blob1 = tool | blob2 = "ok"/"error" | blob3 = classe de
 *   cache (não medida neste worker — vazio) | blob4 = "self"/"" | blob5 = país
 *   | blob6 = organização do AS | blob7 e blob8 vazios (classe do erro e
 *   parâmetros, não medidos neste worker; posições mantidas iguais à frota) |
 *   blob9 = sessão (id emitido no initialize) | blob10 = cliente
 *   (clientInfo.name, só na linha do initialize) | double1 = flag de erro.
 *
 * Privacidade: nome da tool, desfecho e contexto de rede agregável — nunca
 * argumentos, resultados, IP ou conteúdo de consulta.
 *
 * A escrita pega carona no hook `record` do registerAll, que emite SEMPRE
 * `tool_call` e, sincronamente em seguida (mesmo bloco try/finally), o
 * `tool_error` quando a chamada falhou. `withAnalytics` coalesce o par numa
 * linha só: bufferiza no `tool_call` e descarrega via microtask ("ok") ou no
 * `tool_error` síncrono ("error"). O par é atômico no event loop, então não há
 * risco de interlevar chamadas concorrentes.
 *
 * `writeDataPoint` é síncrono e fire-and-forget no runtime — telemetria nunca
 * entra no caminho crítico; qualquer falha é engolida.
 */

import type { RecordUsage } from "./usage-core.js";

/** Header que os clientes MCP do dono enviam (valor = secret SELF_MARKER). */
export const SELF_HEADER = "x-mcp-self";

/**
 * Rota privada do dono: mesma superficie, mesmo resultado, outro ENDERECO.
 *
 * O marcador por header so funciona em cliente que aceita header custom, e o
 * conector do claude.ai nao aceita — e e por ele que o dono mais usa os
 * proprios servidores. Medido em 28/08/2026: o header pegava UMA chamada por
 * produto por semana; todo o resto do uso proprio saia dos servidores da
 * Anthropic, indistinguivel de terceiro, inflando a adocao.
 *
 * O conector nao manda header, mas aponta para qualquer URL. Entao a
 * separacao vem da ROTA: chamada que chega aqui e uso proprio por construcao.
 *
 * O caminho e adivinhavel de proposito (o dono precisa cola-lo em varios
 * clientes). O risco e um varredor cair aqui e ser contado como dono: sujeira
 * no balde do uso proprio, nao vazamento — a rota serve o mesmo conteudo
 * publico. Detectavel olhando pais/AS das chamadas marcadas.
 */
export const SELF_ROUTE = "/mcp/uso-proprio";

/** Contexto de uma requisição HTTP, calculado uma vez no fetch do Worker. */
export interface RequestTag {
  self: boolean;
  country: string;
  asOrg: string;
  /** Id de sessão (blob9): emitido no initialize, lido do cabeçalho depois; "" sem sessão. */
  sessao: string;
}

/** Extrai país/AS do request.cf e compara o header secreto de uso próprio. */
export function tagRequest(request: Request, selfSecret?: string, sessao = ""): RequestTag {
  const cf = (request as { cf?: IncomingRequestCfProperties }).cf;
  return {
    self:
      (!!selfSecret && request.headers.get(SELF_HEADER) === selfSecret) ||
      new URL(request.url).pathname === SELF_ROUTE,
    country: typeof cf?.country === "string" ? cf.country : "",
    asOrg: typeof cf?.asOrganization === "string" ? cf.asOrganization : "",
    sessao,
  };
}

/**
 * Envolve o registrador de uso: repassa todo evento ao UsageTracker e, para o
 * par tool_call/tool_error, grava UMA linha no Analytics Engine. Sem binding
 * (dev local/testes), devolve o registrador original intacto.
 */
export function withAnalytics(
  record: RecordUsage,
  analytics: AnalyticsEngineDataset | undefined,
  tag: RequestTag,
): RecordUsage {
  if (!analytics) return record;

  let pending: string | null = null;
  const flushOk = () => {
    if (pending !== null) {
      const name = pending;
      pending = null;
      writeToolCall(analytics, name, false, tag);
    }
  };

  return (kind, name) => {
    if (kind === "tool_call" && name) {
      flushOk(); // segurança: nunca deve haver pendente aqui (par é atômico)
      pending = name;
      queueMicrotask(flushOk); // nenhum tool_error síncrono seguiu → foi "ok"
    } else if (kind === "tool_error" && name && pending === name) {
      pending = null;
      writeToolCall(analytics, name, true, tag);
    }
    record(kind, name);
  };
}

function writeToolCall(
  analytics: AnalyticsEngineDataset,
  name: string,
  isError: boolean,
  tag: RequestTag,
  cliente = "",
): void {
  try {
    analytics.writeDataPoint({
      // Índice de baixa cardinalidade → GROUP BY barato no SQL do AE.
      indexes: [name],
      blobs: [
        name,
        isError ? "error" : "ok",
        "", // classe de cache — só o senado mede por chamada
        tag.self ? "self" : "",
        tag.country,
        tag.asOrg,
        "", // classe do erro — não medida neste worker; posição mantida
        "", // nomes dos parâmetros — idem
        tag.sessao,
        cliente,
      ],
      doubles: [isError ? 1 : 0],
    });
  } catch {
    // Falha de telemetria nunca quebra nem atrasa a resposta de uma tool.
  }
}

/**
 * Uma mensagem JSON-RPC (tool ou método de protocolo) → uma linha no AE. É o
 * que o proxy usa: ele vê toda mensagem na borda e não tem hook de tool.
 * `cliente` só vem preenchido na linha do initialize.
 */
export function recordMessage(
  analytics: AnalyticsEngineDataset | undefined,
  name: string,
  isError: boolean,
  tag: RequestTag,
  cliente = "",
): void {
  if (!analytics) return;
  writeToolCall(analytics, name, isError, tag, cliente);
}

/**
 * SESSÃO E CLIENTE (blobs 9 e 10, desde 2026-09-17).
 *
 * O que faltava para o funil de sessão do painel ser um funil de verdade: a
 * telemetria tinha `initialize` e `tools/call` como contagens soltas, sem
 * nada que ligasse duas linhas à mesma sessão — a razão "chamadas por
 * initialize" mistura quantas sessões usaram com quanto cada uma usou, e
 * 2,5 tanto pode ser todo mundo chamando 2 ou 3 vezes quanto 10% chamando 25.
 *
 * O elo é o do próprio protocolo: o servidor devolve `Mcp-Session-Id` na
 * resposta ao `initialize` e o cliente é obrigado a repeti-lo em toda
 * requisição seguinte. O handler continua STATELESS — o transporte do SDK v2
 * não emite id neste modo e, conferido em 16/09/2026 nos sete servidores e
 * no código (`validateSession` retorna sem checar quando não há gerador),
 * também não lê nem valida o que o cliente manda. Então o Worker sorteia o
 * id no `initialize`, devolve no cabeçalho e, nas demais requisições, só lê
 * o que o cliente devolveu e grava. Nada é armazenado; o id é aleatório
 * (UUID v4 do `crypto`) e não identifica pessoa, máquina nem rede — só liga
 * as linhas de um aperto de mão. Colisão de UUID v4 é da ordem de n²/2¹²⁹:
 * não é risco prático.
 *
 * O cliente é o software que se apresentou no `initialize`
 * (`params.clientInfo.name`): claude.ai, Claude Code, Inspector, um scanner
 * com nome próprio. É autodeclarado e descreve o programa, não a pessoa. Vai
 * normalizado (minúsculas, sem versão, vocabulário de caracteres fechado,
 * tamanho limitado) para não virar texto livre na telemetria, e SÓ na linha
 * do `initialize` — as chamadas seguintes chegam ao cliente pela sessão.
 *
 * Id que o cliente manda e não parece um id (fora do vocabulário, comprido
 * demais) é tratado como ausente: continua sem estado, e a telemetria não
 * carrega o que não sabe ler.
 */
export const SESSION_HEADER = "mcp-session-id";
const SESSION_ID_OK = /^[A-Za-z0-9._~-]{1,64}$/;

/** O corpo (mensagem ou lote JSON-RPC) contém um `initialize`? */
export function isInitialize(body: unknown): boolean {
  const itens = Array.isArray(body) ? body : [body];
  return itens.some(
    (m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === "initialize",
  );
}

/**
 * A sessão desta requisição: sorteada no `initialize` (`nova`), lida do
 * cabeçalho nas demais; "" quando não há sessão legível.
 */
export function sessionFromRequest(request: Request, body: unknown): { id: string; nova: boolean } {
  if (isInitialize(body)) return { id: crypto.randomUUID(), nova: true };
  const enviada = request.headers.get(SESSION_HEADER) ?? "";
  return { id: SESSION_ID_OK.test(enviada) ? enviada : "", nova: false };
}

/** Devolve a resposta com o `Mcp-Session-Id` quando a sessão nasceu aqui. */
export function withSessionHeader(response: Response, sessao: { id: string; nova: boolean }): Response {
  if (!sessao.nova || !sessao.id) return response;
  const headers = new Headers(response.headers);
  headers.set(SESSION_HEADER, sessao.id);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Nome do cliente normalizado: minúsculas, caracteres fechados, até 40. */
export function normalizeClientName(x: unknown): string {
  if (typeof x !== "string") return "";
  return x
    .toLowerCase()
    .replace(/[^a-z0-9._+/ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/** `clientInfo.name` do `initialize` (o primeiro, num lote); "" fora dele. */
export function clientNameFromBody(body: unknown): string {
  const itens = Array.isArray(body) ? body : [body];
  for (const m of itens) {
    if (!m || typeof m !== "object") continue;
    const msg = m as { method?: unknown; params?: { clientInfo?: { name?: unknown } } };
    if (msg.method === "initialize") return normalizeClientName(msg.params?.clientInfo?.name);
  }
  return "";
}
