/**
 * A FORMA da chamada, nunca o conteúdo dela — versão da BORDA.
 *
 * POR QUE ESTE ARQUIVO EXISTE AQUI, E POR QUE ELE É DIFERENTE DOS SEIS IRMÃOS.
 *
 * Nos outros seis servidores o `call-shape.ts` mora ao lado do handler: o hook
 * `record` do `registerAll` envolve a execução da tool, vê a exceção que ela
 * lançou e classifica com o objeto do erro na mão. Aqui não dá: o servidor MCP
 * do `sih` roda num CONTAINER e este Worker é um PROXY — ele só vê o envelope
 * HTTP e o corpo passando em stream.
 *
 * O que ele vê, porém, os seis NÃO veem. Medido em 23-24/09/2026 contra a
 * produção, pela rota privada do dono:
 *
 *   - nos seis, uma recusa de ESQUEMA (zod do SDK, antes do handler) não gera
 *     linha nenhuma de telemetria — a tool nunca roda, o hook nunca acorda;
 *   - no `sih`, ela chega até aqui como `isError: true` dentro de um HTTP 200,
 *     e até 24/09/2026 era gravada como `ok`. Quatro de quatro falhas viravam
 *     acerto na série: a contagem estava TORTA, não só sem classe.
 *
 * Decisão do dono em 24/09/2026, ao abrir a sessão: **a recusa é gravada como
 * falha, com a classe `contrato`** — e o painel já exclui `contrato` da taxa de
 * erro (`eh_recusa_de_contrato()` em collect_cloudflare.R), porque ferramenta
 * que recusa chamada malformada está FUNCIONANDO. Contar aqui, portanto, não
 * mexe na fila de saúde nem faz o `sih` parecer pior que os irmãos: só deixa
 * registrado quais ferramentas as pessoas erram ao chamar, que é o material
 * para melhorar descrição e mensagem.
 *
 * O VOCABULÁRIO é o mesmo da frota, de propósito: `classifyError` e
 * `errorText` são cópia do `src/call-shape.ts` dos seis (a guarda que varre as
 * mensagens de cada servidor está em tests/call-shape.test.ts, aqui com as
 * mensagens DESTE produto). Duas coisas são só daqui: `classeDoErroRpc`, que
 * lê o código JSON-RPC do protocolo — sinal que os seis não têm —, e a
 * ausência de `classifyThrown`, que não faz sentido sem o objeto da exceção.
 */

/** Vocabulário FECHADO. Nada aqui carrega valor vindo do usuário. */
export type ErrorClass =
  /** Regra de contrato: chamada malformada, parâmetro que falta, combinação proibida, tool que não existe. */
  | "contrato"
  /** A fonte respondeu, e respondeu que não existe: 404, vazio, sem registros. */
  | "nao_encontrado"
  /** A fonte falhou ou demorou: 5xx, timeout, payload grande demais. */
  | "fonte"
  /** Erro interno escapando: é bug NOSSO, não condição da fonte. */
  | "defeito"
  /** Falhou por outro motivo — se esta classe crescer, é sinal de que falta uma classe. */
  | "outro";

/**
 * Classifica pela mensagem de erro, que é NOSSA. A ordem importa: "não
 * encontrado" e "vazio" são mais específicos que "erro da fonte", e um 404
 * casaria com os dois.
 *
 * Cópia fiel do classificador da frota (ilo-mcp-server/src/call-shape.ts, que
 * é a implementação varrida contra as mensagens do bcb, do senado, do ibge, do
 * uis e do medical). Mantido IDÊNTICO de propósito: classe medida por servidor
 * com classificador diferente não é comparável, e comparar os sete é a razão
 * de existir da seção de saúde do painel.
 */
export function classifyError(message: string): ErrorClass {
  const m = message.toLowerCase();
  // A fronteira de palavra vai só no INÍCIO. Os padrões são RADICAIS
  // ("vazi", "obrigatóri", "indisponív") justamente porque a flexão muda o
  // fim. "desconhecido"/"unknown" só é sinal de contrato quando qualifica um
  // VALOR que o chamador passou ("Ferramenta desconhecida: X") — "Erro
  // desconhecido" é o oposto, é justamente o caso sem classe.
  const valorDesconhecido =
    /\b(desconhecid|unknown)/.test(m) && !/\b(erro desconhecid|unknown error)/.test(m);
  if (
    valorDesconhecido ||
    /\b(obrigatóri|obrigatori|exige|requer|required|inválid|invalid|validation error|não aceita|nao aceita|no máximo|no maximo|só existe|so existe|recusad)/.test(
      m,
    ) ||
    /\b(empty query|not part of|too broad|too many|maximum|narrow (it|the|your)|has no codelist|has no enumerated)/.test(
      m,
    )
  ) {
    return "contrato";
  }
  if (
    /\b(não encontrad|nao encontrad|não existe|nao existe|does ?n[o']t exist|not.?found|inexistent|vazi|empty response|empty result|returned empty|sem registros|não retornou dados|nao retornou dados|não publica|nao publica|404)/.test(
      m,
    ) ||
    /\bnenhum[ao]?s?\b[\s\S]{0,40}\b(encontrad|resultado|registro|dado)/.test(m)
  ) {
    return "nao_encontrado";
  }
  // "Informe X ou Y" é a mensagem canônica de parâmetro que falta. Fica DEPOIS
  // de "não encontrado" de propósito: é o sinal mais fraco dos dois.
  if (/\binforme\b/.test(m)) return "contrato";
  // `\b5\d\d\b` e não `5\d\d`: sem a fronteira final, qualquer número com um 5
  // seguido de dois dígitos casava — a intenção sempre foi o status HTTP.
  if (
    /\b(timeout|tempo esgotado|tempo de resposta excedid|excedeu o tempo|indisponív|indisponiv|manutenç|manutenc|erro de conexão|erro de conexao|erro interno do servidor|internal server error|upstream|\b5\d\d\b|payload|too large|grande demais|limite de tamanho)/.test(
      m,
    )
  ) {
    return "fonte";
  }
  return "outro";
}

/**
 * Classe de um erro JSON-RPC do PROTOCOLO, pelo código antes da mensagem.
 *
 * Este é o sinal que só a borda tem. Os códigos reservados pela especificação
 * JSON-RPC 2.0 dizem, sem ambiguidade de idioma, de quem é o conserto:
 *
 *  - −32700 parse error, −32600 invalid request, −32601 method not found e
 *    −32602 invalid params são o CHAMADOR mandando algo que o protocolo
 *    recusa. É `contrato`. No `sih` isto cobre os dois casos mais comuns de
 *    varredura de catálogo: ferramenta que não existe (−32602, "Tool X not
 *    found") e método que não existe (−32601);
 *  - −32603 internal error é erro NOSSO, que escapou do lado de lá. É
 *    `defeito`, e tem de aparecer na fila.
 *
 * Código fora dessa faixa (erro definido pelo servidor, −32000 e abaixo) cai
 * na mensagem, que é o caminho dos seis irmãos.
 */
export function classeDoErroRpc(code: number | undefined, message: string): ErrorClass {
  if (code === -32700 || code === -32600 || code === -32601 || code === -32602) return "contrato";
  if (code === -32603) return "defeito";
  return classifyError(message);
}

/**
 * Texto de erro de um resultado de tool, para classificar. Vazio quando não há.
 *
 * Lê o CAMPO `error` do envelope, não o payload serializado inteiro — a lição
 * do senado em 10/09/2026, onde o `hint` de formulário ("a fonte oficial pode
 * estar indisponível") arrastava todo erro não recuperável para `fonte`.
 *
 * No `sih` os três formatos medidos em 24/09/2026 são: texto cru
 * ("Input validation error: ...", "Ferramenta desconhecida: X",
 * "Erro ao executar X: ..."), e JSON com campo `error` ("Nenhum dos anos
 * solicitados (...) tem dados SIH disponíveis.").
 */
export function errorText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as {
    content?: Array<{ text?: unknown }>;
    structuredContent?: { error?: unknown };
  };
  const estruturado = r.structuredContent?.error;
  if (typeof estruturado === "string") return estruturado;
  const t = Array.isArray(r.content) ? r.content[0]?.text : undefined;
  if (typeof t !== "string") return "";
  try {
    const j = JSON.parse(t) as { error?: unknown };
    if (typeof j.error === "string") return j.error;
  } catch {
    // Não é o envelope JSON — vale o texto cru.
  }
  return t;
}
