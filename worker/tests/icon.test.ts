/**
 * O ícone do servidor é declarado em TRÊS lugares que não podem discordar:
 *
 *   1. `worker/src/icon.ts` — os bytes, em base64, servidos pela rota pública
 *      `/icon.png` do Worker. É a FONTE: não há cópia em `assets/`;
 *   2. `src/server.ts` (raiz, roda no contêiner) — `serverInfo.icons`, o que
 *      todo cliente MCP vê no handshake;
 *   3. `server.json` (raiz) — o que o MCP Registry publica e o que os
 *      diretórios espelham (`icons[0]`).
 *
 * POR QUE ISTO EXISTE. Até 25/09/2026 este era o único servidor do portfólio
 * sem ícone: a landing já apontava `/icon.png` e o Worker respondia 404, o
 * `server.json` não declarava `icons` nem `websiteUrl`, e o mcpindex descontava
 * 10 pontos de completeness por isso (85 contra 95–100 dos irmãos). Com os três
 * lugares preenchidos, o modo de falha inverte: alguém edita um deles e não os
 * outros, e o handshake passa a anunciar uma imagem diferente da dos
 * diretórios. Nenhum lado dá erro; eles só discordam em silêncio.
 *
 * `mimeType` e `sizes` são conferidos contra o cabeçalho IHDR REAL do PNG. Um
 * manifesto que anuncia 512x512 servindo outra coisa é a mesma classe de
 * mentira que o output-contract pega nas respostas das tools. Nada aqui pina
 * literal além da URL pública, que é o que o manifesto promete a terceiros.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ICON_PNG_BASE64 } from "../src/icon.js";

const raizDoWorker = join(__dirname, "..");
const raizDoRepo = join(raizDoWorker, "..");

// Uint8Array + DataView, e não Buffer: este pacote é um Worker, e o `Buffer`
// que o TypeScript resolve aqui não tem os métodos do Node.
const bytesDoIcone = (): Uint8Array =>
  Uint8Array.from(atob(ICON_PNG_BASE64), (c) => c.charCodeAt(0));

const ASSINATURA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Dimensões lidas do cabeçalho IHDR do PNG — sem dependência de imagem. */
function dimensoesPng(buf: Uint8Array): { largura: number; altura: number } {
  if (!ASSINATURA_PNG.every((b, i) => buf[i] === b)) {
    throw new Error("não é um PNG");
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { largura: dv.getUint32(16), altura: dv.getUint32(20) };
}

interface ManifestoIcone {
  src: string;
  mimeType?: string;
  sizes?: string[];
}
interface Manifesto {
  websiteUrl?: string;
  icons?: ManifestoIcone[];
  remotes?: { type: string; url: string }[];
}

const manifesto = (): Manifesto =>
  JSON.parse(readFileSync(join(raizDoRepo, "server.json"), "utf8")) as Manifesto;

describe("ícone do servidor: bytes × serverInfo × manifesto × rota", () => {
  it("os bytes embutidos são um PNG válido, e são a única cópia", () => {
    expect(() => dimensoesPng(bytesDoIcone())).not.toThrow();
    for (const copia of [join(raizDoRepo, "assets", "icon.png"), join(raizDoWorker, "assets", "icon.png")]) {
      expect(
        () => readFileSync(copia),
        "existe uma segunda cópia do ícone — worker/src/icon.ts é a fonte única",
      ).toThrow();
    }
  });

  it("server.json declara websiteUrl, icons e remotes — os campos que os diretórios pontuam", () => {
    const m = manifesto();
    expect(m.websiteUrl, "server.json precisa declarar websiteUrl").toBe("https://sih.sidneybissoli.com");
    expect(m.icons?.[0], "server.json precisa declarar icons").toBeDefined();
    expect(m.remotes?.[0]?.url, "server.json precisa declarar o remoto streamable-http").toBe(
      "https://sih.sidneybissoli.com/mcp",
    );
  });

  it("server.json e o serverInfo do contêiner declaram a MESMA URL de ícone e de site", () => {
    const m = manifesto();
    const serverTs = readFileSync(join(raizDoRepo, "src", "server.ts"), "utf8");
    // O src/server.ts monta a URL a partir de SERVER_WEBSITE_URL; conferir as
    // duas metades é conferir a URL inteira.
    expect(serverTs, "serverInfo.websiteUrl e server.json apontam para sites diferentes").toContain(
      `SERVER_WEBSITE_URL = "${m.websiteUrl}"`,
    );
    expect(m.icons![0]!.src).toBe(`${m.websiteUrl}/icon.png`);
    expect(serverTs).toContain("icons: [{ src: `${SERVER_WEBSITE_URL}/icon.png`");
  });

  it("a URL declarada é servida pelo próprio domínio, em rota pública do Worker", () => {
    expect(manifesto().icons![0]!.src).toBe("https://sih.sidneybissoli.com/icon.png");
    const indexTs = readFileSync(join(raizDoWorker, "src", "index.ts"), "utf8");
    // Pública e ANTES de qualquer auth: quem busca o ícone é o crawler do
    // diretório, nunca um cliente autenticado.
    const rota = indexTs.indexOf('url.pathname === "/icon.png"');
    const auth = indexTs.indexOf("checkAuth(");
    expect(rota).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(-1);
    expect(rota, "a rota do ícone tem de vir ANTES da auth").toBeLessThan(auth);
  });

  it("mimeType e sizes descrevem a imagem que existe, não uma promessa", () => {
    const { largura, altura } = dimensoesPng(bytesDoIcone());
    const icone = manifesto().icons![0]!;
    expect(icone.mimeType).toBe("image/png");
    expect(icone.sizes).toEqual([`${largura}x${altura}`]);
    const serverTs = readFileSync(join(raizDoRepo, "src", "server.ts"), "utf8");
    expect(serverTs).toContain(`sizes: ["${largura}x${altura}"]`);
  });

  it("o ícone cabe no teto de 1 MB do Smithery", () => {
    expect(bytesDoIcone().byteLength).toBeLessThan(1024 * 1024);
  });
});
