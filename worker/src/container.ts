/**
 * O Durable Object que governa o container do servidor MCP.
 *
 * `Container` (@cloudflare/containers) estende DurableObject: o DO cuida de
 * rotear, acordar e dormir o processo; a imagem (../Dockerfile, na raiz do
 * repositório) roda dist/http.js, que expõe POST/GET/DELETE /mcp e GET /healthz
 * na porta 8080. API conferida em
 * https://developers.cloudflare.com/containers/reference/container-class/ (09/09/2026):
 * `defaultPort`, `sleepAfter`, hooks `onStart`/`onStop`/`onError`, `fetch()`
 * encaminha ao defaultPort e acorda o container se preciso, `getContainer()`
 * devolve o stub por nome.
 */

import { Container } from "@cloudflare/containers";

import { logger } from "./logger.js";
import type { Env } from "./types.js";

/** Forma do JSON que dist/http.js devolve em GET /healthz. */
export interface ContainerHealth {
  status: string;
  server: string;
  version: string;
  cached_years: number[];
}

/** O que GET /health do Worker relata sobre o container. */
export type ContainerProbe =
  | { container: "up"; health: ContainerHealth }
  | { container: "asleep" }
  | { container: "down"; error: string };

export class SihContainer extends Container<Env> {
  /** Porta em que dist/http.js escuta (PORT no container). */
  defaultPort = 8080;
  /**
   * Uma hora sem requisições e o container dorme. O disco é EFÊMERO: ao
   * dormir, o cache de cubos some e a próxima chamada paga cold start (1–3 s)
   * mais o download do ano pedido — por isso mais que o padrão de 10 min
   * (PLAN-004 §3). Toda requisição encaminhada renova o relógio.
   */
  sleepAfter = "1h";

  override onStart(): void {
    logger.info("container_start", { instance: this.ctx.id.toString() });
  }

  override onStop(params: { exitCode: number; reason: string }): void {
    logger.info("container_stop", { exitCode: params.exitCode, reason: params.reason });
  }

  override onError(error: unknown): void {
    logger.error("container_error", { err: String(error) });
  }

  /**
   * Sonda para GET /health do Worker. Chamada por RPC no stub, NÃO por fetch:
   * `fetch()` acorda o container, e uma sonda que acorda o que sondava
   * manteria a instância ligada para sempre (todo monitor externo bate no
   * /health). Se o processo não está rodando, responde "asleep" sem ligá-lo;
   * se está, pergunta ao /healthz com o timeout dado.
   */
  async probe(timeoutMs: number): Promise<ContainerProbe> {
    if (!this.ctx.container?.running) return { container: "asleep" };
    // Timeout em duas camadas: o AbortSignal no request e uma corrida com o
    // relógio — a biblioteca pode reconstruir o Request e perder o signal.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const relogio = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`healthz sem resposta em ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const res = await Promise.race([
        this.containerFetch(
          new Request("http://container/healthz", { signal: AbortSignal.timeout(timeoutMs) }),
          this.defaultPort,
        ),
        relogio,
      ]);
      if (!res.ok) return { container: "down", error: `healthz HTTP ${res.status}` };
      return { container: "up", health: (await res.json()) as ContainerHealth };
    } catch (e) {
      return { container: "down", error: String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
