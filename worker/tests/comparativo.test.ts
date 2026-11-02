/**
 * A página de comparação diz o que foi medido, e só isso.
 *
 * POR QUE ESTE ARQUIVO EXISTE. A página `/vs-microdatasus-pysus` (02/11/2026,
 * ação `geo:sih-br-mcp`) vive de números: o total que os três caminhos deram, os
 * arquivos e bytes que o microdado exige, o que o PySUS 2.11.7 deixou de ver. Um
 * número digitado direto no texto envelhece sem que nada reprove — foi assim que
 * a contagem de ferramentas apodreceu em prosa noutros produtos. Aqui todo número
 * mora em `MEDIDO` e o teste exige que cada um apareça no HTML; e a afirmação
 * central da página ("o microdatasus e o sih chegam ao mesmo número") é conferida
 * contra os próprios dados, não contra a frase.
 */

import { describe, expect, it } from "vitest";

import { COMPARATIVO_ROUTE, MEDIDO, TITULO, comparativoHtml } from "../src/comparativo.js";
import { sitemapXml } from "../src/discovery.js";
import { landingHtml } from "../src/landing.js";
import { SERVER_CONFIG } from "../src/config.js";

const html = comparativoHtml();
const pt = (n: number, casas = 0): string =>
  n.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
const en = (n: number, casas = 0): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: casas, maximumFractionDigits: casas });

describe("página de comparação", () => {
  it("leva os três nomes no título, nas duas línguas", () => {
    for (const t of [TITULO["pt-BR"], TITULO.en]) {
      for (const nome of ["sih-br-mcp", "microdatasus", "PySUS"]) expect(t).toContain(nome);
    }
    expect(html).toContain(`<title>${TITULO["pt-BR"]}</title>`);
  });

  it("afirma o acordo só porque os dados concordam", () => {
    expect(MEDIDO.microdatasus.internacoes).toBe(MEDIDO.sih.internacoes);
    expect(MEDIDO.microdatasus.obitos).toBe(MEDIDO.sih.obitos);
    // O que falta ao PySUS com group="RD" é exatamente o que está nos arquivos perdidos.
    expect(MEDIDO.pysus.internacoesGroupRd + MEDIDO.pysus.pneumoniasNosPerdidos).toBe(
      MEDIDO.microdatasus.internacoes,
    );
  });

  it("mostra cada número medido, em português e em inglês", () => {
    const inteiros = [
      MEDIDO.sih.internacoes,
      MEDIDO.sih.obitos,
      MEDIDO.microdatasus.mibDbc,
      MEDIDO.microdatasus.registrosLidos,
      MEDIDO.soArquivoDoEs.internacoes,
      MEDIDO.pysus.internacoesGroupRd,
      MEDIDO.pysus.obitosGroupRd,
      MEDIDO.pysus.arquivosRdSemGrupo,
      MEDIDO.pysus.arquivosRdNoCatalogo,
    ];
    for (const n of inteiros) {
      expect(html, `ausente em pt: ${n}`).toContain(pt(n));
      expect(html, `ausente em en: ${n}`).toContain(en(n));
    }
    for (const n of [MEDIDO.volumes.registros, MEDIDO.volumes.internacoes34Anos, MEDIDO.pysus.pneumoniasNosPerdidos]) {
      expect(html, `ausente: ${n}`).toContain(pt(n));
    }
    expect(html).toContain(`${MEDIDO.microdatasus.arquivos} arquivos`);
    expect(html).toContain(`${pt(MEDIDO.microdatasus.minutos, 1)} min`);
    expect(html).toContain(`${pt(MEDIDO.volumes.gibMicrodado, 2)} GiB`);
  });

  it("diz as versões medidas", () => {
    expect(html).toContain(`sih-br-mcp ${MEDIDO.sih.versao}`);
    expect(html).toContain(`microdatasus ${MEDIDO.microdatasus.versao}`);
    expect(html).toContain(`PySUS ${MEDIDO.pysus.versao}`);
  });

  it("tem canonical próprio e entra no sitemap", () => {
    const url = `${SERVER_CONFIG.websiteUrl}${COMPARATIVO_ROUTE}`;
    expect(html).toContain(`<link rel="canonical" href="${url}">`);
    expect(sitemapXml()).toContain(`<loc>${url}</loc>`);
  });

  it("é alcançável a partir da landing", () => {
    expect(landingHtml()).toContain(`href="${COMPARATIVO_ROUTE}"`);
  });

  it("publica dados estruturados que citam as três ferramentas", () => {
    const bruto = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1];
    expect(bruto, "página sem JSON-LD").toBeTruthy();
    const dados = JSON.parse(bruto as string) as { about: { name: string }[] };
    expect(dados.about.map((a) => a.name)).toEqual(["sih-br-mcp", "microdatasus", "PySUS"]);
  });
});
