// Verificações comuns aos smokes de transporte (stdio e HTTP): a superfície
// derivada do tools/list, a comparação/gravação do baseline e as três chamadas
// de ponta a ponta. Um único lugar, para que os dois transportes sejam
// medidos pela MESMA régua — é o que prova que trocar o transporte não muda o
// que o cliente vê (PLAN-004).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Superfície canônica: nome + descrição + inputSchema, ordenada por nome. */
export function surfaceOf(tools) {
  if (!Array.isArray(tools) || tools.length === 0) throw new Error("tools/list vazio");
  for (const t of tools) {
    if (!t.inputSchema || t.inputSchema.type !== "object")
      throw new Error(`ferramenta ${t.name} sem inputSchema de objeto`);
  }
  const surface = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return JSON.stringify(surface, null, 2) + "\n";
}

/** Compara com `baseline` e/ou grava em `writeTo`. Lança com mensagem legível. */
export function checkSurface(surfaceJson, { baseline, writeTo } = {}) {
  if (baseline) {
    // Forma canônica LF: num checkout Windows com autocrlf (i/lf w/crlf) o
    // baseline chega com CRLF e a comparação byte a byte reprovava sem a
    // superfície ter mudado (mesma classe do tables-check, 2026-09-08).
    const expected = readFileSync(baseline, "utf8").replace(/\r\n/g, "\n");
    if (expected !== surfaceJson) {
      const surface = JSON.parse(surfaceJson);
      const before = new Set(JSON.parse(expected).map((t) => t.name));
      const after = new Set(surface.map((t) => t.name));
      const gone = [...before].filter((n) => !after.has(n));
      const novo = [...after].filter((n) => !before.has(n));
      throw new Error(
        `superfície difere do baseline ${baseline}` +
          (gone.length ? ` | sumiram: ${gone.join(", ")}` : "") +
          (novo.length ? ` | novas: ${novo.join(", ")}` : "") +
          (!gone.length && !novo.length ? " | mesmos nomes, descrição ou schema mudou" : ""),
      );
    }
    console.log(`superfície == ${baseline}`);
  }
  if (writeTo) {
    mkdirSync(dirname(writeTo), { recursive: true });
    writeFileSync(writeTo, surfaceJson);
    console.log(`superfície gravada em ${writeTo}`);
  }
}

/**
 * Anotações exigidas pelo review de conectores do claude.ai (08/09/2026):
 * toda ferramenta com `title` e `readOnlyHint: true`. Não entram no baseline
 * de superfície (que é só o que o 0.12.1 já expunha), mas são gate.
 */
export function checkAnnotations(tools) {
  const sem = tools.filter((t) => !t.title || t.annotations?.readOnlyHint !== true).map((t) => t.name);
  if (sem.length) throw new Error(`sem title/readOnlyHint: ${sem.join(", ")}`);
  console.log(`anotações: ${tools.length} ferramentas com title e readOnlyHint`);
}

/** As três chamadas de ponta a ponta: metadados, anos e um ranking pelo DuckDB. */
export async function threeCalls(client) {
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} devolveu isError: ${JSON.stringify(res.content).slice(0, 300)}`);
    const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (!text.trim()) throw new Error(`${name} devolveu conteúdo vazio`);
    console.log(`${name}: ok (${text.length} chars)`);
    return text;
  };

  const csap = await call("list_csap_groups");
  if (!/g01/i.test(csap)) throw new Error("list_csap_groups não menciona g01");

  const yearsText = await call("get_available_years");
  // Lê o campo estrutural `years`; o texto inteiro não serve porque o bloco de
  // proveniência traz outros anos (safra, citação) e o regex pegaria o maior.
  let yearsJson = null;
  try { yearsJson = JSON.parse(yearsText); } catch { /* texto não JSON: cai no regex */ }
  const years = Array.isArray(yearsJson?.years)
    ? yearsJson.years.map(Number).filter(Number.isInteger)
    : [...yearsText.matchAll(/(19|20)\d{2}/g)].map((m) => Number(m[0]));
  if (years.length === 0) throw new Error("get_available_years não devolveu nenhum ano");
  const year = Math.max(...years);

  const rank = await call("rank_csap_groups", { year: [year], limit: 3 });
  if (!/g\d{2}/i.test(rank)) throw new Error(`rank_csap_groups(${year}) não devolveu grupo nenhum`);
  return year;
}
