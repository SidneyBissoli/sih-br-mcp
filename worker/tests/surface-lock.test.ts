/**
 * A metade da impressão digital que só a borda sabe medir: QUAIS MÉTODOS
 * RESPONDEM SEM CREDENCIAL, em `/mcp` e na rota privada do dono, com
 * `API_KEY` ausente (produção) e presente — a seção `semToken` do
 * `surface.lock.json`, sob a regra da trava: mudou sem subir a versão =
 * vermelho, e o deploy não roda.
 *
 * Aqui a borda NÃO monta servidor MCP: ela valida Host, Origin, auth e rate
 * limit e repassa ao container Node (`src/http.ts`), que não autentica nada.
 * O container entra como dublê que roda o handler real em processo, então o
 * que se mede é o que um cliente sem token recebe de ponta a ponta. A
 * superfície que ele serve é a do `createServer`, travada na raiz
 * (`tests/surface-lock.test.ts`). Pede o build da raiz antes (`dist/`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CABECALHOS_MCP,
  comHost,
  conferirSecao,
  corpoDoPedido,
  ipDaSonda,
  medirSemToken,
  sondaSemToken,
} from "@sbissoli/mcp-surface";
import { describe, expect, it, vi } from "vitest";

// O container de verdade é um Durable Object com um processo Node dentro,
// servindo `createMcpHandler(() => createServer(), …)` (src/http.ts). O dublê
// roda ESSE MESMO handler em processo (do build da raiz, `../../dist`): um
// dublê que respondesse `result` a tudo diria que `prompts/list` responde, e
// este servidor não serve prompts — foi o que a primeira versão desta trava
// gravou, e a conferência no ar desmentiu.
vi.mock("@cloudflare/containers", async () => {
  const { createMcpHandler } = await import("@modelcontextprotocol/server");
  const { createServer } = await import("../../dist/server.js");
  const handler = createMcpHandler(() => createServer(), { legacy: "stateless", responseMode: "sse" });
  return { Container: class {}, getContainer: () => ({ fetch: (req: Request) => handler.fetch(req) }) };
});

// A borda repassa o corpo como STREAM (`body: request.body`). O workerd aceita;
// o `Request` do Node (undici) exige `duplex: "half"` nesse caso e lança. É
// diferença de runtime, não da borda — o dublê só acrescenta a opção.
const RequestDoNode = globalThis.Request;
vi.stubGlobal(
  "Request",
  class extends RequestDoNode {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init?.body instanceof ReadableStream ? { ...init, duplex: "half" } as RequestInit : init);
    }
  },
);

const { SELF_ROUTE } = await import("../src/analytics.js");
const { default: worker } = await import("../src/index.js");
type Env = import("../src/types.js").Env;

// `.href`: o URL das workers-types não é o do node:url para o compilador.
const raiz = fileURLToPath(new URL("../../", import.meta.url).href);
const trava = `${raiz}surface.lock.json`;
const versao = (JSON.parse(readFileSync(`${raiz}package.json`, "utf8")) as { version: string }).version;

const HOST = "sih.sidneybissoli.com";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const SIH = {} as Env["SIH"];
const envs: Record<string, Env> = {
  apiKeyAusente: { SIH } as Env,
  apiKeyPresente: { SIH, API_KEY: "chave-da-sonda" } as Env,
};

// Tabela empacotada (TOOLS_WITHOUT_CUBES): no ar, `tools/call` sem ir aos cubos.
const sonda = sondaSemToken({ name: "list_cid_chapters", arguments: {} });

const medirBorda = () =>
  medirSemToken(Object.keys(envs), ["POST /mcp", `POST ${SELF_ROUTE}`], sonda, (config, rota, pedido) =>
    worker.fetch(
      comHost(
        new Request(`https://${HOST}${rota.slice("POST ".length)}`, {
          method: "POST",
          headers: { ...CABECALHOS_MCP, "CF-Connecting-IP": ipDaSonda() },
          body: corpoDoPedido(pedido),
        }),
        HOST,
      ),
      envs[config]!,
      ctx,
    ),
  );

describe("surface.lock.json — borda", () => {
  it("quem responde sem token bate com a trava, ou a versão subiu junto", async () => {
    const m = await medirBorda();
    // Sanidade ANTES de conferir — e, no modo de escrita, antes de GRAVAR: uma
    // sonda quebrada (tudo false, ou tudo true) não pode virar trava. Já
    // aconteceu: com o dublê errado, `npm run surface:lock` gravou tudo false
    // e só o teste seguinte, rodando depois da gravação, reclamou.
    const aberta = m["apiKeyAusente"]?.["POST /mcp"];
    const fechada = m["apiKeyPresente"]?.["POST /mcp"];
    expect(aberta?.["tools/list"], "sonda quebrada: sem API_KEY, tools/list tem de responder").toBe(true);
    expect(aberta?.["tools/call"], "sonda quebrada: sem API_KEY, a tool local tem de responder").toBe(true);
    expect(fechada?.["tools/list"], "sonda quebrada: com API_KEY e sem token, tools/list não pode responder").toBe(false);
    const v = conferirSecao(trava, "semToken", m, versao);
    expect(v.ok, v.mensagem).toBe(true);
  }, 60_000);
});
