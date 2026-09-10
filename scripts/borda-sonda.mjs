#!/usr/bin/env node
// Sonda mínima da borda: uma chamada, com timeout e relato do que voltou.
// Uso: node scripts/borda-sonda.mjs <tool> '<json dos args>' [segundos]
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const [tool, argsJson, secs = "180"] = process.argv.slice(2);
const url = process.env.SIH_MCP_URL ?? "https://sih.sidneybissoli.com/mcp";
const client = new Client({ name: "sih-borda-sonda", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const t0 = Date.now();
try {
  const r = await client.callTool(
    { name: tool, arguments: JSON.parse(argsJson) },
    { timeout: Number(secs) * 1000, maxTotalTimeout: Number(secs) * 1000 },
  );
  const bruto = r.content[0].text;
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  // Nem todo servidor responde JSON: o ibge devolve markdown. Assumir JSON
  // fazia a sonda "falhar" numa chamada que tinha dado certo.
  let b;
  try {
    b = JSON.parse(bruto);
  } catch {
    console.log(`${dt} s | resposta em TEXTO (${bruto.length} chars)`);
    console.log("  " + bruto.slice(0, 300).split("\n").join("\n  "));
    await client.close();
    process.exit(0);
  }
  const linhas = b.data ?? b.ranking ?? b.series ?? [];
  console.log(`${dt} s | ${Array.isArray(linhas) ? linhas.length : "?"} linhas | erro: ${b.error ?? "nenhum"}`);
  console.log(`  summary: ${JSON.stringify(b.summary ?? null)}`);
  console.log(`  1ª linha: ${JSON.stringify(Array.isArray(linhas) ? linhas[0] : null)}`);
  console.log(`  notas: ${(b.notes ?? []).length}`);
  for (const n of b.notes ?? []) console.log(`    - ${n.slice(0, 150)}`);
} catch (err) {
  console.log(`FALHOU em ${((Date.now() - t0) / 1000).toFixed(1)} s: ${err instanceof Error ? err.message : String(err)}`);
}
await client.close();
