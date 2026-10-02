/**
 * Impressão digital da superfície DECLARADA (@sbissoli/mcp-surface): mudou sem
 * subir a versão = vermelho, e o deploy não roda (deploy-container.yml roda os
 * testes antes do wrangler). Captura o `createServer` — o MESMO que o stdio e o
 * container HTTP (`src/http.ts`) usam; a borda (`worker/`) não monta servidor,
 * só repassa, e `worker/tests/surface-lock.test.ts` mede o que ela deixa passar
 * sem token.
 *
 * Ao mudar a superfície: `npm version <nível> --no-git-tag-version` e
 * `npm run surface:lock`. A trava recusa regravar sob a versão antiga.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { capturarSuperficie, conferirSecao } from "@sbissoli/mcp-surface";
import { describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";

const raiz = fileURLToPath(new URL("../", import.meta.url));
const versao = (JSON.parse(readFileSync(`${raiz}package.json`, "utf8")) as { version: string }).version;

describe("surface.lock.json — superfície declarada", () => {
  it("bate com a trava, ou a versão subiu junto", async () => {
    const v = conferirSecao(`${raiz}surface.lock.json`, "declarada", await capturarSuperficie(createServer()), versao);
    expect(v.ok, v.mensagem).toBe(true);
  });
});
