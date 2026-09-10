#!/usr/bin/env node
// Medição na BORDA da F3 do PLAN-006: as perguntas que o cubo de causas
// respondia caro, agora contra o servidor remoto real (Worker + Container
// `basic`, 1/4 vCPU). Mede o tempo de cada chamada e imprime o número que ela
// devolveu, para comparar com a resposta da versão anterior antes de fechar.
//
// Uso:
//   node scripts/borda-plan-006.mjs [--url https://sih.sidneybissoli.com/mcp]
//
// ATENÇÃO ao que "frio" significa aqui. O disco do container é efêmero, mas
// sobrevive entre chamadas enquanto a instância vive: uma sessão desta sonda
// só é fria se a instância acabou de nascer. Para o custo frio DE VERDADE, sem
// depender do estado da instância, use scripts/frio-local.mjs, que parte de um
// cache vazio contra o canal real.
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : [])).filter((p) => p.length),
);
const url = String(args.url ?? "https://sih.sidneybissoli.com/mcp");

const client = new Client({ name: "sih-borda-plan-006", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

// O padrão do cliente MCP (DEFAULT_REQUEST_TIMEOUT_MSEC) corta em 60 s, e a
// graça da medição é justamente saber quanto custa a pergunta cara na versão
// ANTERIOR — que passa disso. Teto de 15 min.
//
// ATENÇÃO à assinatura: no cliente 2.0.0 é `callTool(params, options)`, com as
// opções na SEGUNDA posição. Passá-las na terceira (como no SDK antigo, que
// tinha `resultSchema` no meio) não dá erro nenhum: elas são ignoradas em
// silêncio e o teto continua em 60 s. Foi o que aconteceu na primeira medição.
const TIMEOUT = { timeout: 15 * 60 * 1000, maxTotalTimeout: 15 * 60 * 1000 };

const anos34 = Array.from({ length: 34 }, (_, i) => 1992 + i);
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("pt-BR") : String(n));

const casos = [
  {
    nome: "gasto, dias e óbitos por ano — 34 anos (1ª da sessão)",
    tool: "get_hospitalizations",
    args: { year: anos34, group_by: ["year"] },
    resumo: (b) => {
      const linhas = b.data ?? [];
      const p = linhas.find((r) => r.year === 1992);
      const u = linhas.find((r) => r.year === 2025);
      return [
        `${linhas.length} anos; ${fmt(b.summary?.total_hospitalizations)} internações`,
        `1992: ${fmt(p?.n_hospitalizations)} internações, valor ${fmt(p?.total_value)}`,
        `2025: ${fmt(u?.n_hospitalizations)} internações, valor ${fmt(u?.total_value)}`,
        `avisos: ${(b.notes ?? []).length}${(b.notes ?? []).some((n) => n.includes("CRUZA a fronteira da moeda")) ? " (inclui o de fronteira da moeda)" : ""}`,
      ];
    },
  },
  {
    nome: "a MESMA pergunta, repetida",
    tool: "get_hospitalizations",
    args: { year: anos34, group_by: ["year"] },
    resumo: (b) => [`${(b.data ?? []).length} anos; ${fmt(b.summary?.total_hospitalizations)} internações`],
  },
  {
    nome: "principais capítulos CID na série longa",
    tool: "get_hospitalizations",
    args: { year: anos34, group_by: ["cid_chapter"], limit: 5 },
    resumo: (b) => (b.data ?? []).map((r) => `capítulo ${r.cid_chapter}: ${fmt(r.n_hospitalizations)} internações`),
  },
  {
    nome: "demográfica de poucos anos (sexo × ano, 2023–2025)",
    tool: "get_hospitalizations",
    args: { year: [2023, 2024, 2025], group_by: ["sex", "year"] },
    resumo: (b) => (b.data ?? []).slice(0, 6).map((r) => `${r.year} ${r.sex}: ${fmt(r.n_hospitalizations)}`),
  },
  {
    nome: "taxa por 100 mil, 60 anos e mais, por UF (2024)",
    tool: "get_hospitalization_rates",
    args: { year: [2024], age_min: 60, group_by: ["uf"] },
    resumo: (b) => (b.data ?? []).slice(0, 3).map((r) => `${r.uf}: ${fmt(r.rate_per_100k)} por 100 mil (${fmt(r.n_hospitalizations)} internações, fonte ${r.population_source})`),
  },
  {
    nome: "recorte etário que NÃO alinha (0–17) — tem de cair no cubo",
    tool: "get_hospitalizations",
    args: { year: [2024], age_min: 0, age_max: 17, group_by: ["uf"] },
    resumo: (b) => [`${(b.data ?? []).length} UFs; ${fmt(b.summary?.total_hospitalizations)} internações`],
  },
];

for (const c of casos) {
  const t0 = Date.now();
  let body;
  try {
    const r = await client.callTool({ name: c.tool, arguments: c.args }, TIMEOUT);
    body = JSON.parse(r.content[0].text);
  } catch (err) {
    console.log(`\n${c.nome}\n  FALHOU em ${((Date.now() - t0) / 1000).toFixed(1)} s: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${c.nome}\n  ${dt} s`);
  if (body.error) console.log(`  ERRO: ${body.error}`);
  else for (const linha of c.resumo(body)) console.log(`  ${linha}`);
}

await client.close();
