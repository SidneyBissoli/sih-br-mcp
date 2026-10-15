/**
 * `revision` (contrato de proveniência v1.3), decisão do dono em 08/10/2026:
 * `provisional` quando algum ano usado no bloco tem a janela de competências
 * INCOMPLETA no sidecar (`window.complete === false`); `current` nos demais e
 * quando o sidecar não tem `window`. Desde a 1.7.1 (decisão 56) o servidor
 * emite a 1.3: a chave sai no fio (concise), e as marcas que faziam esse papel
 * no `data_vintage` — "(janela INCOMPLETA)" e "[ATRÁS do espelho…]" — saíram;
 * o "atrás" virou aviso em `notices`, com o texto aprovado pelo dono.
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

describe("sihProvenance: contrato 1.3 no fio (revision, notices, derived)", () => {
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
    const frescor = await import("../src/freshness.js");
    mod.resetSidecars();
    return { bloco: () => mod.sihProvenance(anos), ctx: mod.provenance, frescor, aviso: mod.AVISO_CUBO_ATRAS };
  }

  it("fixture 2023 (janela completa): contrato 1.3; o concise leva revision current e derived, sem notices", async () => {
    const { bloco: gerar, ctx } = await blocoCom(FIXTURE, [2023]);
    const bloco = gerar();
    expect(ctx.contractVersion).toBe("1.3");
    expect(bloco.contract_version).toBe("1.3");
    expect(bloco.field_sources).toBeNull();
    const fio = ctx.render(bloco) as Record<string, unknown>;
    expect(fio.revision).toEqual(bloco.revision);
    expect((fio.revision as { status: string }).status).toBe("current");
    expect(fio.derived).toBe(true);
    expect(String(fio.derivation_note)).toContain("Agregação em cubos");
    // Sem aviso: a chave fica ausente, não vazia.
    expect(fio).not.toHaveProperty("notices");
    expect(renderConcise(bloco)).toEqual(fio);
  });

  it("cópia do sidecar com a janela ABERTA (pasta temporária): provisional no fio, e o vintage sem a marca", async () => {
    temporaria = mkdtempSync(join(tmpdir(), "sih-revisao-"));
    writeFileSync(join(temporaria, "sih_provenance_2023.json"), JSON.stringify(comJanela(2023, false)));
    const { bloco: gerar, ctx } = await blocoCom(temporaria, [2023]);
    const bloco = gerar();
    const esperado = {
      status: "provisional",
      note: "Internações de 2023: competências ainda abertas no SIH; o total ainda pode crescer.",
    };
    expect(bloco.revision).toEqual(esperado);
    expect((ctx.render(bloco) as Record<string, unknown>).revision).toEqual(esperado);
    // Decisão 56: a janela aberta mora em `revision`, não no vintage.
    expect(bloco.data_vintage).toMatch(/^2023: internações de 2023 em competências \d{4}-\d{2} a \d{4}-\d{2}, UF de arquivo /);
    expect(bloco.data_vintage).not.toContain("INCOMPLETA");
  });

  it("cubo ATRÁS do espelho: o aviso aprovado sai em notices, uma vez, e o vintage fica limpo", async () => {
    const { bloco: gerar, ctx, frescor, aviso } = await blocoCom(FIXTURE, [2023]);
    expect(aviso).toBe(
      "Há meses mais recentes já recebidos do DATASUS que ainda não entraram nestes números; a atualização é semanal.",
    );
    const limpo = gerar().data_vintage;
    frescor.setFreshnessForTests({
      ...frescor.getFreshness(),
      status: "stale",
      checked_at: new Date().toISOString(),
      cubes: [
        { cube_year: 2023, reedited: ["RDSP2301"], reprocessed: [], removed: [], new_in_window: ["2024-03"], behind: true },
      ],
    });
    const bloco = gerar();
    expect(bloco.notices).toEqual([aviso]);
    expect((ctx.render(bloco) as Record<string, unknown>).notices).toEqual([aviso]);
    expect(bloco.data_vintage).toBe(limpo);
    expect(bloco.data_vintage).not.toContain("ATRÁS");
  });

  it("frescor em dia (stale em outro ano): sem aviso", async () => {
    const { bloco: gerar, frescor } = await blocoCom(FIXTURE, [2023]);
    frescor.setFreshnessForTests({
      ...frescor.getFreshness(),
      status: "stale",
      checked_at: new Date().toISOString(),
      cubes: [
        { cube_year: 2023, reedited: [], reprocessed: [], removed: [], new_in_window: [], behind: false },
        { cube_year: 2024, reedited: ["RDSP2401"], reprocessed: [], removed: [], new_in_window: [], behind: true },
      ],
    });
    expect(gerar().notices).toEqual([]);
  });
});

describe("o outputSchema LISTADO aceita um bloco 1.3 completo", () => {
  const bloco13 = {
    notices: ["Há meses mais recentes já recebidos do DATASUS que ainda não entraram nestes números; a atualização é semanal."],
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
