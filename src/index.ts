#!/usr/bin/env node

/**
 * Entrada stdio (o `bin` do pacote npm: `npx -y sih-br-mcp`).
 *
 * A construção do servidor vive em src/server.ts (factory sem efeito
 * colateral); aqui só se liga ao transporte. stdout é o canal do protocolo,
 * então todo log vai para o stderr. A entrada HTTP é src/http.ts.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { closeDatabase } from "./db/duckdb.js";
import { startFreshnessCheck } from "./freshness.js";
import { createServer } from "./server.js";

serveStdio(() => createServer(), {
  onerror: (error) => console.error("Transport error:", error),
});
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
