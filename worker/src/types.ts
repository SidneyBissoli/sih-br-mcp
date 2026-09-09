import type { SihContainer } from "./container.js";
import type { UsageTracker } from "./usage.js";

export interface Env {
  /**
   * O container que roda o servidor MCP (src/container.ts). Opcional só para
   * que testes e typecheck não exijam o binding: sem ele, /mcp responde 503.
   */
  SIH?: DurableObjectNamespace<SihContainer>;
  /** Bearer auth opcional (`wrangler secret put API_KEY`). Ausente = acesso aberto. */
  API_KEY?: string;
  /**
   * Origins de navegador aceitas no /mcp além do próprio host e de localhost
   * (lista separada por vírgula; "*" = qualquer). Requisições sem Origin
   * passam sempre. Ver src/mcp-proxy.ts.
   */
  ALLOWED_ORIGIN?: string;
  /**
   * Durable Object de estatísticas de uso. Opcional para que testes e dev local rodem
   * sem o binding: sem ele, nada é registrado e /metrics responde com aviso.
   */
  USAGE?: DurableObjectNamespace<UsageTracker>;
  /**
   * Binding version_metadata (id/tag/timestamp do deploy). Opcional: GET /status
   * omite o bloco deploy quando ausente (dev local / testes).
   */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  /**
   * Telemetria de tool calls no Analytics Engine (src/analytics.ts). Opcional:
   * sem o binding (dev local / testes), nada é gravado.
   */
  ANALYTICS?: AnalyticsEngineDataset;
  /**
   * Segredo do marcador de uso próprio (`wrangler secret put SELF_MARKER`):
   * requisições com o header x-mcp-self igual a ele ganham blob4="self" na
   * telemetria. Ausente = nenhuma requisição é marcada.
   */
  SELF_MARKER?: string;
}
