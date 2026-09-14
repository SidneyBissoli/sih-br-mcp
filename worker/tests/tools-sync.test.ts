/**
 * A lista de ferramentas do Worker é a do servidor, e a identidade é uma só.
 *
 * POR QUE ESTE ARQUIVO EXISTE. O Worker não importa o código da raiz (o
 * servidor roda no container), então `TOOLS` em src/config.ts é uma CÓPIA de
 * nome e título das doze ferramentas de ../src/tools.ts. Cópia sem guarda
 * apodrece em silêncio: uma ferramenta nova entra no servidor, o deploy sai,
 * e a landing e o card estático continuam anunciando doze. O mesmo vale para
 * nome, título e versão — o handshake (../src/server.ts, package.json) e o
 * server.json têm de dizer o que o Worker diz.
 *
 * Nada aqui pina literal: o teste lê o FONTE da raiz e compara.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_CONFIG, TOOLS } from "../src/config.js";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const leia = (f: string) => readFileSync(join(raiz, f), "utf8");

/** Pares name/title do array `tools` de src/tools.ts, na ordem do fonte. */
function ferramentasDaRaiz(): { name: string; title: string }[] {
  const fonte = leia("src/tools.ts");
  const pares: { name: string; title: string }[] = [];
  const re = /^\s+name:\s*"([^"]+)",\s*\n\s+title:\s*"([^"]+)",/gm;
  for (const m of fonte.matchAll(re)) pares.push({ name: m[1]!, title: m[2]! });
  return pares;
}

describe("ferramentas: Worker × src/tools.ts", () => {
  it("o fonte da raiz declara ferramentas com name+title (o parser acha algo)", () => {
    expect(ferramentasDaRaiz().length).toBeGreaterThan(0);
  });

  it("nome e título de cada ferramenta são os do servidor, na mesma ordem", () => {
    expect([...TOOLS]).toEqual(ferramentasDaRaiz());
  });
});

describe("identidade: Worker × handshake × server.json", () => {
  const pkg = JSON.parse(leia("package.json")) as { name: string; version: string };
  const manifesto = JSON.parse(leia("server.json")) as { title?: string; version?: string; description?: string };
  const servidor = leia("src/server.ts");

  it("name e version vêm do package.json da raiz", () => {
    expect(SERVER_CONFIG.name).toBe(pkg.name);
    expect(SERVER_CONFIG.version).toBe(pkg.version);
  });

  it("title é o SERVER_TITLE de src/server.ts e o title do server.json", () => {
    expect(servidor).toContain(`SERVER_TITLE = "${SERVER_CONFIG.title}"`);
    expect(manifesto.title).toBe(SERVER_CONFIG.title);
  });

  it("a rota MCP é a que o container serve (MCP_PATH em src/http.ts)", () => {
    expect(leia("src/http.ts")).toContain(`MCP_PATH = "${SERVER_CONFIG.mcpRoute}"`);
  });

  /**
   * A intenção aqui é "não anunciar contagem DEFASADA", não "anunciar contagem".
   *
   * Até 14/09/2026 o teste exigia a frase `N tools` na descrição do server.json.
   * A ação GEO de 13/09 reescreveu essa descrição para o vocabulário da pergunta
   * ("DATASUS SIH/SUS hospital admissions in Brazil (AIH, 1992-2025)…"), onde a
   * contagem não cabe — ela gasta caracteres de um campo que os diretórios
   * truncam, e não é o que alguém procura. O teste passou a reprovar por uma
   * decisão de produto deliberada, e ficou vermelho sem ninguém ver porque os
   * testes do worker não rodavam no CI.
   *
   * Exigir a frase de volta subordinaria a superfície pública ao teste. O que o
   * teste deve garantir é a CONSISTÊNCIA de uma afirmação, quando ela é feita:
   * se a descrição disser um número de ferramentas, que seja o número real.
   */
  it("se o server.json anuncia contagem de ferramentas, ela é a real", () => {
    const anunciado = /(\d+)\s+tools?\b/i.exec(manifesto.description ?? "");
    if (!anunciado) {
      expect(manifesto.description ?? "").not.toMatch(/\btools?\b.*\d/i);
      return;
    }
    expect(Number(anunciado[1])).toBe(TOOLS.length);
  });
});
