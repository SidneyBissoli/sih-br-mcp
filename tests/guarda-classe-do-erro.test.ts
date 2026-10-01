/**
 * GUARDA: todo erro que pode chegar ao `catch` final de `callTool` declara a
 * CLASSE pelo tipo (30/09/2026).
 *
 * O idioma deste repositório é a EXCEÇÃO, não o `isError` literal: os handlers
 * lançam, o `catch` final de `callTool` monta o resultado de erro e põe a
 * classe em `_meta[CLASSE_DO_ERRO_META]` quando `classeDaExcecao` a reconhece
 * (src/upstream.ts). Um `throw new Error(...)` genérico saía sem `_meta`, e a
 * telemetria do Worker caía na FRASE — "Erro na query: <DuckDB>" virava
 * `contrato` por casar "Invalid". Por isso a guarda tem duas metades:
 *
 *  1. `new Error(` é proibido em código de `src/` (fora de comentário): use
 *     `ErroInterno` / `ErroDeContrato` / `FalhaDaFonte` (src/erros.ts) ou o
 *     `OrigemError` do canal. Exceções na lista abaixo, cada uma com o porquê.
 *  2. `isError: true` literal só existe UMA vez em `src/`: no helper
 *     `resultadoDeErro` de src/tools.ts, cuja classe é parâmetro obrigatório.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../src");

/**
 * Onde `new Error(` continua permitido — nenhum destes chega ao `catch` de
 * uma chamada de tool com uma classe a declarar:
 */
const NEW_ERROR_PERMITIDO: Record<string, string> = {
  // Lança na PARTIDA do servidor (patch do SDK que mudou), não numa chamada.
  "discover.ts": "partida do servidor: o SDK mudou; não há chamada de tool",
  // Lança na CARGA do módulo (tool sem esquema de saída), não numa chamada.
  "output-schemas.ts": "carga do módulo: tool sem esquema de saída",
  // `traduzirErro` embrulha um valor lançado que NÃO é Error: não há tipo de
  // onde tirar a classe, e ficar sem `_meta` (a frase como reserva) é o honesto.
  "upstream.ts": "traduzirErro embrulha valor lançado que não é Error (classe desconhecida)",
};

/** Único arquivo com `isError: true` literal (o helper `resultadoDeErro`). */
const IS_ERROR_PERMITIDO = "tools.ts";

function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return arquivosTs(caminho);
    return nome.endsWith(".ts") ? [caminho] : [];
  });
}

/** O código sem comentários (bloco e linha) — a guarda não reprova prosa. */
function semComentarios(fonte: string): string {
  // O bloco vira as quebras de linha que tinha: o número de linha do relato bate.
  return fonte.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, "")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const fontes = arquivosTs(SRC).map((caminho) => ({
  rel: relative(SRC, caminho).split("\\").join("/"),
  codigo: semComentarios(readFileSync(caminho, "utf8")),
}));

describe("guarda: erro com classe declarada em src/", () => {
  it("varre os arquivos certos (sanidade da guarda)", () => {
    const rels = fontes.map((f) => f.rel);
    expect(rels).toContain("tools.ts");
    expect(rels).toContain("db/duckdb.ts");
    expect(rels).toContain("cache.ts");
  });

  it("`new Error(` só nos arquivos permitidos (o resto lança tipo com classe)", () => {
    const ofensores = fontes
      .filter((f) => !(f.rel in NEW_ERROR_PERMITIDO))
      .flatMap((f) =>
        f.codigo
          .split("\n")
          .map((linha, i) => ({ linha, i }))
          .filter(({ linha }) => /\bnew Error\(/.test(linha))
          .map(({ linha, i }) => `${f.rel}:${i + 1}: ${linha.trim()}`),
      );
    expect(ofensores, "use ErroInterno/ErroDeContrato/FalhaDaFonte (src/erros.ts)").toEqual([]);
  });

  it("`isError: true` literal existe uma vez só, no helper resultadoDeErro de tools.ts", () => {
    const ocorrencias = fontes.flatMap((f) =>
      [...f.codigo.matchAll(/isError:\s*true/g)].map(() => f.rel),
    );
    expect(ocorrencias).toEqual([IS_ERROR_PERMITIDO]);
    const tools = fontes.find((f) => f.rel === IS_ERROR_PERMITIDO)!.codigo;
    const helper = tools.slice(tools.indexOf("function resultadoDeErro("));
    expect(helper.slice(0, helper.indexOf("\n}")).includes("isError: true")).toBe(true);
    // A classe é parâmetro obrigatório do helper (o compilador cobra quem chama).
    expect(tools).toMatch(/function resultadoDeErro\(texto: string, classe: ClasseDoErro \| undefined\)/);
  });
});
