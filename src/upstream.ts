/**
 * Ponto ÚNICO de rede do servidor (1.1.0, 2026-09-27) — a ida ao canal
 * `sih/cubos/` do healthbr-data e ao espelho `sih/rd/` passa toda por aqui,
 * pelo fetch comum do portfólio (`@sbissoli/mcp-upstream`): timeout por
 * tentativa, retry com backoff e `Retry-After`, orçamento total, User-Agent, e
 * a CONTAGEM de idas, tentativas e anomalias que alimenta o bloco `retrieval`
 * da proveniência (contrato v1.1 do `@sbissoli/mcp-provenance`).
 *
 * O pacote CLASSIFICA ("a origem respondeu 503", "o fetch lançou"); este
 * módulo DECIDE (o que repete, que mensagem sai) — e o disco continua sendo
 * do `cache.ts`: manifesto em memo, cubo já presente nunca vai à rede.
 *
 * O QUE "IDA À ORIGEM" SIGNIFICA AQUI. Diferente dos irmãos (bcb, ibge, ilo,
 * uis, medical, senado), este servidor não consulta uma API por chamada: o
 * dado vem de ARTEFATOS (Parquet, sidecars, resumos) baixados uma vez para o
 * disco e lidos pelo DuckDB. Numa chamada de tool a rede acontece em, no
 * máximo, três formas — o `manifest.json` do canal (memo de 10 min), os
 * arquivos que ainda não estão no disco (verificados por SHA-256) e, em
 * segundo plano, a checagem de frescor contra o espelho. Por isso o
 * `retrieval` do bloco SIH diz QUAL camada respondeu: `null` = o disco
 * (cache aquecido, memo válido — nenhuma ida); um objeto = o canal HTTP foi
 * consultado nesta chamada, com quantas idas, tentativas e anomalias. A
 * checagem de frescor NÃO entra na contagem da chamada: é um trabalho de
 * fundo com coletor próprio e descartável (`upstreamFrescor`), senão o
 * `retrieval` de uma chamada carregaria idas que não produziram o dado dela.
 *
 * POLÍTICA (`UPSTREAM_POLICY`) — MEDIDA em 27/09/2026 com `curl` e o
 * User-Agent deste servidor, contra `https://data.sidneybissoli.com/sih/cubos/`
 * (R2 atrás da borda da Cloudflare):
 *  - `manifest.json` (60 KB): 0,75 s frio (REVALIDATED), 0,16 s no HIT;
 *  - sidecar de 284 KB 0,51 s; `sih_series_2023` (36 KB) 0,55 s;
 *    `sih_icsap_2023` (15,8 MB) 0,89 s; `sih_causas_2025` (55 MB, o maior
 *    arquivo do canal) **1,2 s** a 45 MB/s — todos com o primeiro byte em
 *    0,43–0,55 s;
 *  - arquivo inexistente: 404 em 0,47 s (página HTML de 27 KB da borda);
 *  - espelho `sih/rd/manifest.json` com `Range: bytes=0-511`: 206 em 0,38 s;
 *    `manifest-summary.json` (2,7 MB) 0,81 s; o `r2.dev` de reserva 0,76 s.
 *
 *  Daí:
 *  - **cabeçalhos** de qualquer ida ao canal: teto de 15 s por tentativa
 *    (a origem responde em menos de 1 s; o teto existe para a conexão
 *    pendurada), 2 retries (3 tentativas), backoff 1 s → 2 s → 4 s + jitter
 *    de até 500 ms, orçamento total de 60 s para essa fase;
 *  - o **corpo** de um download é streamado para o disco FORA do pacote (o
 *    modo `response` entrega a `Response` com o corpo intacto) e continua
 *    coberto pelo prazo que cada chamador já dava — 10 min para cubo e
 *    população, 60 s para sidecar e resumo, 5 min para estratos — agora
 *    como `signal` próprio; falha no meio do corpo NÃO repete (como antes:
 *    um cubo de 55 MB pela metade é caso para a próxima chamada, não para
 *    dobrar a espera desta);
 *  - `manifest.json`: 8 s por tentativa (paridade) e UM retry — é 60 KB e
 *    decide se a chamada inteira anda; a queda para a cópia em disco continua
 *    depois dele (pior caso 17 s em vez de 8 s, só quando a rede falha);
 *  - **frescor** (`upstreamFrescor`): sonda 3 s, índice 12 s, SEM retry — o
 *    caminho já tem a repetição manual domínio → `r2.dev`, e a checagem é de
 *    fundo: atrasar não ajuda ninguém.
 *
 * O QUE REPETE E O QUE NÃO (`retryCanal`):
 *  - 429 (honrando `Retry-After`), 5xx e rede (DNS/TCP/TLS) repetem;
 *  - timeout NÃO repete (a tentativa pendurada já gastou o teto; paridade
 *    com senado/medical/ilo/uis);
 *  - 4xx é resposta da origem: 404 continua sendo erro ("HTTP 404", que a
 *    borda classifica como `nao_encontrado`), nunca ausência silenciosa;
 *  - corpo inesperado (manifesto que não é JSON) não repete — cai para o
 *    disco, como antes.
 *
 * O COLETOR. `callTool` (src/tools.ts) abre UM coletor por chamada de tool
 * (`withUpstreamCall`) e toda ida ao canal, a qualquer profundidade, cai
 * nele; `sihProvenance`/`populationProvenance` leem `currentRetrieval()`.
 * Fora de uma chamada (`warm-cache.mjs` no `docker build`, o `decide` do
 * healthbr-data, testes que chamam `ensure*` direto) a ida ganha um coletor
 * descartável: a política vale igual, a contagem simplesmente não é lida.
 * Limitação declarada: um download deduplicado (`inFlight` — duas chamadas
 * concorrentes pelo mesmo ano) conta no coletor de quem o INICIOU; a que
 * esperou responde `retrieval: null`, embora tenha se beneficiado da ida.
 */

import { createRequire } from "node:module";
import {
  createUpstream,
  UpstreamError as PkgUpstreamError,
  type RetryContext,
  type Upstream,
  type UpstreamCall,
  type UpstreamErrorKind,
} from "@sbissoli/mcp-upstream";
import { currentCall, withCall } from "@sbissoli/mcp-upstream/als";
import type { RetrievalInput } from "@sbissoli/mcp-provenance";
import { ErroComClasse, type ClasseDoErro } from "./erros.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;

/** Identificação nas requisições ao canal e ao espelho (antes da 1.1.0 não havia). */
export const USER_AGENT = `sih-br-mcp/${VERSION} (+https://github.com/SidneyBissoli/sih-br-mcp)`;

/** A política de rede deste servidor (números medidos em 27/09/2026 — ver o cabeçalho). */
export const UPSTREAM_POLICY = {
  /** Idas ao canal `sih/cubos/` (manifesto, cubos, sidecars, resumos, população). */
  canal: {
    /** Teto de UMA tentativa até os cabeçalhos chegarem, em ms. */
    timeoutMs: 15_000,
    /** Retries além da primeira tentativa. */
    retries: 2,
    /** Orçamento TOTAL da fase de cabeçalhos, esperas incluídas. */
    budgetMs: 60_000,
    /** Esperas: 1 s, 2 s, 4 s (teto), mais jitter uniforme de até 500 ms. */
    backoff: { baseMs: 1_000, maxMs: 4_000, jitterMs: 500 },
  },
  /** `manifest.json`: curto e com um retry só — decide se a chamada anda. */
  manifesto: { timeoutMs: 8_000, retries: 1 },
  /** Checagem de frescor contra o espelho `sih/rd/` (segundo plano). */
  frescor: { probeTimeoutMs: 3_000, fullTimeoutMs: 12_000, retries: 0, budgetMs: 12_000 },
} as const;

/**
 * I/O da espera entre tentativas e do jitter, num objeto para os testes
 * trocarem (`upstreamIo.sleep = async () => {}`): um 503 permanente num dublê
 * custaria 3 s de backoff real por ida, e o jitter impediria contar o relógio.
 */
export const upstreamIo = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  random: (): number => Math.random(),
};

/** A decisão de repetir uma tentativa que falhou (o pacote diz a classe). */
export function retryCanal(ctx: RetryContext): boolean {
  switch (ctx.kind) {
    case "rate_limited":
    case "http_5xx":
    case "network":
      console.error(`[rede] repetindo ${ctx.url} (tentativa ${ctx.attempt}: ${ctx.kind}${ctx.status ? ` HTTP ${ctx.status}` : ""})`);
      return true;
    default:
      return false;
  }
}

/**
 * A política no formato do pacote, com ligação TARDIA ao `fetch` global — os
 * testes dublam `globalThis.fetch` depois de este módulo carregar.
 */
export const upstreamCanal: Upstream = createUpstream({
  userAgent: USER_AGENT,
  timeoutMs: UPSTREAM_POLICY.canal.timeoutMs,
  retries: UPSTREAM_POLICY.canal.retries,
  budgetMs: UPSTREAM_POLICY.canal.budgetMs,
  backoff: UPSTREAM_POLICY.canal.backoff,
  honorRetryAfter: true,
  retryOn: retryCanal,
  sleep: (ms) => upstreamIo.sleep(ms),
  random: () => upstreamIo.random(),
  fetchImpl: (input, init) => globalThis.fetch(input, init),
});

/** O espelho `sih/rd/`: sem retry (a repetição manual domínio → r2.dev fica no frescor). */
export const upstreamFrescor: Upstream = createUpstream({
  userAgent: USER_AGENT,
  timeoutMs: UPSTREAM_POLICY.frescor.fullTimeoutMs,
  retries: UPSTREAM_POLICY.frescor.retries,
  budgetMs: UPSTREAM_POLICY.frescor.budgetMs,
  retryOn: () => false,
  fetchImpl: (input, init) => globalThis.fetch(input, init),
});

/**
 * Abre o coletor de UMA chamada de tool e roda `fn` dentro dele — ou reusa o
 * que já está aberto, se `fn` é um passo de uma chamada maior (a tool de fora
 * não pode perder as idas de dentro). Chamado por `callTool`.
 */
export function withUpstreamCall<T>(fn: () => Promise<T>): Promise<T> {
  return currentCall() ? fn() : withCall(upstreamCanal, () => fn());
}

/**
 * O coletor da chamada corrente; fora de uma chamada, um descartável (a ida
 * continua com a política, a contagem simplesmente não é lida).
 */
export function upstreamCall(): UpstreamCall {
  return currentCall() ?? upstreamCanal.call();
}

/**
 * O `retrieval` medido nesta chamada de tool — `null` fora de um coletor ou
 * quando nada foi à rede (disco/memo). É o que os blocos do canal recebem.
 */
export function currentRetrieval(): RetrievalInput | null {
  return currentCall()?.retrieval() ?? null;
}

// ── A classe de erro local ────────────────────────────────────────────────────

/**
 * Falha de uma ida ao canal ou ao espelho, já com a mensagem que este servidor
 * sempre deu — e que a borda classifica por TEXTO (`worker/src/call-shape.ts`):
 * "HTTP 404" → `nao_encontrado`; "timeout", "indisponível", "erro de conexão"
 * e um status 5xx → `fonte`. A mensagem do pacote ("Erro de rede ao acessar a
 * origem") não casava com nenhuma classe, por isso a tradução vive aqui.
 */
export class OrigemError extends Error {
  constructor(
    message: string,
    /** Classe do pacote, ou `stream` (o corpo caiu no meio do download) / `verificacao` (tamanho ou SHA-256 não conferem). */
    public readonly kind: UpstreamErrorKind | "stream" | "verificacao",
    public readonly status: number | undefined = undefined,
    public readonly attempts: number = 1,
    /** True só quando NADA chegou da origem (DNS, TCP, TLS, timeout antes dos cabeçalhos). */
    public readonly transport: boolean = false,
  ) {
    super(message);
    this.name = "OrigemError";
  }

  /**
   * A classe de telemetria pelo TIPO, não pela frase — e é ela que viaja até a
   * borda em `_meta` (ver `CLASSE_DO_ERRO_META` abaixo). Medido em 30/09/2026:
   * pela frase, 4xx ("HTTP 403"), corpo inesperado, "resposta sem corpo" e a
   * verificação de tamanho/SHA-256 caíam em `outro`. 404 continua ausência
   * respondida, como a frase já dava; todo o resto é o canal falhando.
   */
  get classe(): "nao_encontrado" | "fonte" {
    return this.kind === "not_found" ? "nao_encontrado" : "fonte";
  }
}

/**
 * Chave de `_meta` em que o resultado de ERRO leva a classe decidida pelo tipo
 * da exceção até o Worker.
 *
 * Por que no fio. Nos outros seis servidores do portfólio (bcb-br-mcp #45 e
 * seguintes) a classe viaja numa chave-símbolo que o `JSON.stringify` não vê,
 * porque o hook de telemetria roda no MESMO processo que a tool. Aqui não: a
 * tool roda no container e a telemetria no Worker, que só enxerga a resposta
 * JSON (`worker/src/envelope.ts`). O único canal entre os dois é a resposta, e
 * `_meta` é o lugar que a especificação do MCP reserva para metadado que não
 * é conteúdo. Vai só em resultado de erro; o sucesso não muda.
 */
export const CLASSE_DO_ERRO_META = "br.com.sidneybissoli.sih/classe-do-erro";

/**
 * A classe que uma exceção declara pelo TIPO, ou `undefined` (aí a borda
 * classifica pela frase, como sempre). Erro de programa (`TypeError` & cia.)
 * é `defeito`, pelo mesmo critério do `classifyThrown` dos irmãos: pela frase,
 * o texto do motor de JS caía em `outro`. Exceção de `src/erros.ts` traz a
 * classe declarada no tipo.
 */
export function classeDaExcecao(error: unknown): ClasseDoErro | undefined {
  if (error instanceof OrigemError) return error.classe;
  // Os tipos de src/erros.ts declaram a classe na construção (ErroInterno,
  // ErroDeContrato, FalhaDaFonte): é o caminho de todo `throw` de src/db,
  // src/tools.ts e src/cache.ts.
  if (error instanceof ErroComClasse) return error.classe;
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  ) {
    return "defeito";
  }
  return undefined;
}

/** O que o `fetch` ou o parse lançou, em uma linha, sem a pilha. */
function causaCurta(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause;
    const code = inner && typeof inner === "object" && "code" in inner ? String((inner as { code: unknown }).code) : null;
    return code ? `${cause.message}: ${code}` : cause.message;
  }
  return String(cause);
}

/** Traduz o erro do pacote para a classe e as mensagens deste servidor. */
export function traduzirErro(err: unknown, url: string): Error {
  if (err instanceof OrigemError) return err;
  if (!(err instanceof PkgUpstreamError)) return err instanceof Error ? err : new Error(String(err));
  const vezes = err.attempts > 1 ? ` após ${err.attempts} tentativas` : "";
  switch (err.kind) {
    case "timeout":
      return new OrigemError(`${url}: timeout antes da resposta${vezes}`, err.kind, err.status, err.attempts, err.transport);
    case "aborted":
      return new OrigemError(`${url}: tempo esgotado antes da resposta`, err.kind, err.status, err.attempts, err.transport);
    case "network":
      return new OrigemError(`${url}: erro de conexão com o canal (${causaCurta(err.cause)})${vezes}`, err.kind, undefined, err.attempts, true);
    case "rate_limited":
    case "http_5xx":
      return new OrigemError(`${url}: canal indisponível — HTTP ${err.status}${vezes}`, err.kind, err.status, err.attempts, false);
    case "malformed_body":
      return new OrigemError(`${url}: corpo inesperado (não é o JSON esperado)${vezes}`, err.kind, err.status, err.attempts, false);
    case "not_found":
    case "http_4xx":
    default:
      // A forma de sempre: `${url}: HTTP ${status}`.
      return new OrigemError(`${url}: HTTP ${err.status}`, err.kind, err.status, err.attempts, false);
  }
}
