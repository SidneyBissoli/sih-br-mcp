/**
 * `revision` (contrato de proveniência v1.3), decisão do dono em 08/10/2026:
 * `provisional` quando algum ano usado no bloco tem a janela de competências
 * INCOMPLETA no sidecar (`window.complete === false`); `current` nos demais e
 * quando o sidecar não tem `window`. O servidor emite o contrato 1.2, então o
 * fio (concise) ainda não leva a chave — a lib a descarta —, mas o canônico
 * já a carrega: é o terreno da 1.3, provado aqui nos dois casos.
 *
 * A fixture congelada só tem 2023, com janela completa. O caso provisório usa
 * uma CÓPIA do sidecar dela numa pasta temporária, com a janela aberta — a
 * fixture não é tocada (decisão 46).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { renderConcise } from "@sbissoli/mcp-provenance";
import { conectarComoCliente, chamarComoCliente } from "@sbissoli/mcp-surface/cliente";
import { afterAll, describe, expect, it, vi } from "vitest";

import { revisionOf, type SihSidecar } from "../src/provenance.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/sih");
const real = JSON.parse(readFileSync(resolve(FIXTURE, "sih_provenance_2023.json"), "utf8")) as SihSidecar;

function comJanela(ano: number, completa: boolean | null): SihSidecar {
  const s: SihSidecar = { ...real, cube_year: ano };
  if (completa === null) delete s.window;
  else s.window = { ...real.window!, complete: completa };
  return s;
}

describe("revisionOf (função pura)", () => {
  it("a fixture 2023 tem janela completa: current, com a nota que as instructions já publicam", () => {
    expect(real.window?.complete).toBe(true);
    const r = revisionOf([real]);
    expect(r.status).toBe("current");
    expect(r.note).toContain("reedita arquivos de competências passadas");
  });

  it("sidecar sem window (builder antigo): current", () => {
    expect(revisionOf([comJanela(2010, null)]).status).toBe("current");
  });

  it("um ano com janela incompleta: provisional, e a nota nomeia o ano", () => {
    expect(revisionOf([comJanela(2025, false)])).toEqual({
      status: "provisional",
      note: "Internações de 2025: competências ainda abertas no SIH; o total ainda pode crescer.",
    });
  });

  it("vários anos: basta UM aberto para o bloco ser provisional; a nota nomeia só os abertos, em ordem", () => {
    const r = revisionOf([comJanela(2025, false), real, comJanela(2024, false), comJanela(2022, null)]);
    expect(r).toEqual({
      status: "provisional",
      note: "Internações de 2024 e 2025: competências ainda abertas no SIH; o total ainda pode crescer.",
    });
  });
});

describe("sihProvenance: o canônico carrega a revision, o fio 1.2 ainda não", () => {
  const envOriginal = { ...process.env };
  let temporaria: string | null = null;
  afterAll(() => {
    for (const k of Object.keys(process.env)) if (!(k in envOriginal)) delete process.env[k];
    Object.assign(process.env, envOriginal);
    if (temporaria) rmSync(temporaria, { recursive: true, force: true });
    vi.resetModules();
  });

  async function blocoCom(pasta: string, anos: number[]) {
    Object.assign(process.env, { SIH_DATA_DIR: pasta, SIH_CUBES_CACHE: "off", SIH_FRESHNESS_CHECK: "off" });
    vi.resetModules();
    const mod = await import("../src/provenance.js");
    mod.resetSidecars();
    return { bloco: mod.sihProvenance(anos), ctx: mod.provenance };
  }

  it("fixture 2023 (janela completa): current no canônico; contrato 1.2; concise sem a chave", async () => {
    const { bloco, ctx } = await blocoCom(FIXTURE, [2023]);
    expect(ctx.contractVersion).toBe("1.2");
    expect(bloco.contract_version).toBe("1.2");
    expect(bloco.revision?.status).toBe("current");
    expect(bloco.field_sources).toBeNull();
    expect(Object.keys(ctx.render(bloco))).not.toContain("revision");
    // Quando o servidor ligar a 1.3, a mesma revision sai no fio — e current não ganha rodapé.
    expect(renderConcise({ ...bloco, contract_version: "1.3" }).revision).toEqual(bloco.revision);
  });

  it("cópia do sidecar com a janela ABERTA (pasta temporária): provisional no canônico", async () => {
    temporaria = mkdtempSync(join(tmpdir(), "sih-revisao-"));
    writeFileSync(join(temporaria, "sih_provenance_2023.json"), JSON.stringify(comJanela(2023, false)));
    const { bloco, ctx } = await blocoCom(temporaria, [2023]);
    expect(bloco.revision).toEqual({
      status: "provisional",
      note: "Internações de 2023: competências ainda abertas no SIH; o total ainda pode crescer.",
    });
    // A marca da janela no vintage continua (o fio não muda neste passo).
    expect(bloco.data_vintage).toContain("(janela INCOMPLETA)");
    expect(Object.keys(ctx.render(bloco))).not.toContain("revision");
    expect(renderConcise({ ...bloco, contract_version: "1.3" }).revision?.status).toBe("provisional");
  });
});

describe("o outputSchema LISTADO já aceita um bloco 1.3 completo (tempo 1 da 1.3 no ar)", () => {
  const bloco13 = {
    notices: ["Cubo 2025 está ATRÁS do espelho healthbr-data."],
    derived: true,
    derivation_note: "Agregação em cubos por ano de internação.",
    revision: { status: "provisional", note: "Internações de 2025: competências ainda abertas no SIH; o total ainda pode crescer." },
  };

  it("structuredContent com as quatro chaves da 1.3 passa pelo validador do cliente", async () => {
    const { createServer } = await import("../src/server.js");
    const cliente = await conectarComoCliente(createServer(), {
      adulterar: (r) => {
        const p = r.structuredContent?.provenance as Record<string, unknown>;
        Object.assign(p, bloco13);
      },
    });
    await cliente.listTools();
    const r = (await chamarComoCliente(cliente, "list_cid_chapters", {})) as { structuredContent: { provenance: Record<string, unknown> } };
    expect(r.structuredContent.provenance.revision).toEqual(bloco13.revision);
    await cliente.close();
  });

  it("e reprova status fora do vocabulário fechado (o portão morde)", async () => {
    const { createServer } = await import("../src/server.js");
    const cliente = await conectarComoCliente(createServer(), {
      adulterar: (r) => {
        const p = r.structuredContent?.provenance as Record<string, unknown>;
        Object.assign(p, { ...bloco13, revision: { status: "definitivo", note: null } });
      },
    });
    await cliente.listTools();
    await expect(chamarComoCliente(cliente, "list_cid_chapters", {})).rejects.toThrow();
    await cliente.close();
  });
});
