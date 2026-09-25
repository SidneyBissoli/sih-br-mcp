#!/usr/bin/env node

/**
 * Entrada stdio (o `bin` do pacote npm: `npx -y sih-br-mcp`).
 *
 * A construção do servidor vive em src/server.ts (factory sem efeito
 * colateral); aqui só se liga ao transporte. stdout é o canal do protocolo,
 * então todo log vai para o stderr. A entrada HTTP é src/http.ts.
 *
 * O transporte é construído À MÃO e entregue ao `serveStdio` pela opção
 * `transport`, em vez de deixá-lo construir o dele: é a única forma de pôr o
 * guarda de cursor (src/pagination.ts) na frente do `onmessage` SEM abrir mão
 * do `serveStdio` — que é quem atende as duas eras do protocolo (2025 por
 * `initialize`, 2026-07-28 por `server/discover`). `server.connect(transport)`
 * direto atenderia só o ciclo legado e mediria menos regras no mcpscore
 * (armadilha medida no senado em 30/08/2026: 127/144 contra 146/148).
 */
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { closeDatabase } from "./db/duckdb.js";
import { startFreshnessCheck } from "./freshness.js";
import { unknownCursorError } from "./pagination.js";
import { createServer } from "./server.js";

const transport = new StdioServerTransport();
serveStdio(() => createServer(), {
  transport,
  onerror: (error) => console.error("Transport error:", error),
});

// Cursor de paginação inválido → -32602, o mesmo guarda que o contêiner aplica
// no POST (src/pagination.ts). Entra DEPOIS do serveStdio porque é ele que
// instala o `onmessage` do transporte (síncrono, na própria chamada):
// envolvê-lo antes só somaria um ouvinte, sem poder de interromper a entrega.
const entregaAoServidor = transport.onmessage;
transport.onmessage = (message) => {
  const recusa = unknownCursorError(message);
  if (recusa) {
    void transport.send(recusa);
    return;
  }
  entregaAoServidor?.(message);
};

console.error("SIH-BR-MCP Server iniciado");

// Frescor dos cubos: sonda o manifesto do espelho em segundo plano (512
// bytes; só baixa os 10 MB se o manifesto mudou), com timeout curto. Não
// espera — a primeira ferramenta chamada antes do veredito vê `pending`.
void startFreshnessCheck();

// Cleanup ao encerrar
process.on("SIGINT", async () => {
  await closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeDatabase();
  process.exit(0);
});
