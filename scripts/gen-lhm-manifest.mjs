#!/usr/bin/env node
// Regenera os blocos `tools`, `resources` e `prompts` de lhm.plugin.json (a
// ficha do LobeHub) a partir da superfície REAL do servidor — o tools/list do
// binário compilado, falado por stdio, exatamente como o smoke — e sincroniza
// `version` com o package.json.
//
// POR QUE EXISTE (2026-09-26). O LobeHub NÃO relê o repositório nem o npm: a
// ficha só muda quando `lhm plugin update` publica este manifesto. A ficha do
// sih nasceu de uma leitura automática do repo em 08/09/2026 (0.11.0, método
// de instalação "clonar e compilar", ZERO tools) e ficou "Unvalidated" enquanto
// o produto chegava à 1.0.1 — os cinco irmãos com manifesto tinham letra A.
// Derivar da fonte, nunca copiar para texto: o mesmo desenho que os irmãos
// adotaram em 02/09/2026 (bcb, ilo, medical, senado).
//
// Rodar após mudança de superfície (exige dist/ fresco):
//   npm run build && node scripts/gen-lhm-manifest.mjs
// Depois publicar: npx -y @lobehub/market-cli plugin update --dir .
//
// A suíte (tests/lhm-manifest.test.ts) prende o arquivo à superfície: manifesto
// velho reprova antes do release.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const client = new Client({ name: "gen-lhm-manifest", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "index.js")],
  // Mesmo ambiente do smoke: sem sonda de frescor, sem canal público, fixtures
  // como única fonte — a superfície não depende de rede nem de dado local.
  env: {
    ...getDefaultEnvironment(),
    SIH_FRESHNESS_CHECK: "off",
    SIH_CUBES_CACHE: "off",
    SIH_DATA_DIR: resolve(root, "tests", "fixtures", "sih"),
  },
  stderr: "pipe",
});

await client.connect(transport);
const caps = client.getServerCapabilities() ?? {};
const { tools } = await client.listTools();
const resources = caps.resources ? (await client.listResources()).resources : [];
const prompts = caps.prompts ? (await client.listPrompts()).prompts : [];
await client.close();

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifestPath = join(root, "lhm.plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

manifest.version = version;
manifest.tools = tools;
manifest.resources = resources;
manifest.prompts = prompts;

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `lhm.plugin.json: v${version}, ${tools.length} tools, ` +
    `${resources.length} resources, ${prompts.length} prompts`,
);
