/**
 * `retrieved_at` do bloco SIH = download MAIS ANTIGO entre as partições usadas
 * (decisão 51 do CONTEXT.md, pedido do dono em 05/10/2026: "não interessa
 * quando foi baixado; interessa se é IGUAL ao original").
 *
 * Até a 1.2.3 era o MAX dos `retrieved_at` de topo dos sidecars, que já são o
 * MAX das partições de cada cubo: um MAX de MAX. Os casos abaixo foram
 * montados para que as duas implementações erradas mais prováveis falhem:
 * o MIN dos TOPOS (não desce às partições) e a ordenação sem normalizar o
 * `processing_timestamp` ("AAAA-MM-DD HH:MM:SS.ffffff": o espaço ordena antes
 * do "T" do ISO).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { isoUtc, oldestDownload, type SihSidecar } from "../src/provenance.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/sih");
const real = JSON.parse(readFileSync(resolve(FIXTURE, "sih_provenance_2023.json"), "utf8")) as SihSidecar;

function sidecar(ano: number, topo: string, processados: string[]): SihSidecar {
  return {
    ...real,
    cube_year: ano,
    retrieved_at: topo,
    partitions: processados.map((ts, i) => ({ ...real.partitions[0]!, partition: `p${i}`, processing_timestamp: ts })),
  };
}

describe("isoUtc", () => {
  it("converte o processing_timestamp do manifesto como o iso_utc() do builder R", () => {
    expect(isoUtc("2026-03-09 03:05:34.463049")).toBe("2026-03-09T03:05:34Z");
    expect(isoUtc("2026-03-09 03:05:34")).toBe("2026-03-09T03:05:34Z");
    expect(isoUtc("2026-03-09T04:02:47Z")).toBe("2026-03-09T04:02:47Z");
  });

  it("o MAX das partições da fixture reproduz o retrieved_at de topo gravado pelo builder", () => {
    const max = real.partitions.map((p) => isoUtc(p.processing_timestamp)).sort().at(-1);
    expect(max).toBe(real.retrieved_at);
  });
});

describe("oldestDownload", () => {
  it("fixture 2023/RR: a 1ª das 16 partições, não o topo", () => {
    expect(real.partitions).toHaveLength(16);
    expect(oldestDownload([real])).toBe("2026-03-09T03:05:34Z");
    expect(real.retrieved_at).toBe("2026-03-09T04:02:47Z");
  });

  it("desce às partições: o MIN dos topos daria outra resposta", () => {
    const a = sidecar(2022, "2026-05-01T00:00:00Z", ["2026-05-01 00:00:00.1", "2026-02-01 12:00:00.5"]);
    const b = sidecar(2023, "2026-03-15T00:00:00Z", ["2026-03-15 00:00:00.0"]);
    expect([a.retrieved_at, b.retrieved_at].sort()[0]).toBe("2026-03-15T00:00:00Z");
    expect(oldestDownload([a, b])).toBe("2026-02-01T12:00:00Z");
  });

  it("normaliza antes de comparar: sem isso o espaço ordena antes do T", () => {
    const comParticao = sidecar(2022, "2026-03-09T10:00:00Z", ["2026-03-09 10:00:00.0"]);
    const semParticao = sidecar(2023, "2026-03-09T05:00:00Z", []);
    expect(["2026-03-09 10:00:00.0", "2026-03-09T05:00:00Z"].sort()[0]).toBe("2026-03-09 10:00:00.0");
    expect(oldestDownload([comParticao, semParticao])).toBe("2026-03-09T05:00:00Z");
  });
});

describe("sihProvenance sobre a fixture", () => {
  const envOriginal = { ...process.env };
  afterAll(() => {
    for (const k of Object.keys(process.env)) if (!(k in envOriginal)) delete process.env[k];
    Object.assign(process.env, envOriginal);
    vi.resetModules();
  });

  it("retrieved_at e citação levam o download mais antigo e a frase de identidade com o original", async () => {
    Object.assign(process.env, { SIH_DATA_DIR: FIXTURE, SIH_CUBES_CACHE: "off", SIH_FRESHNESS_CHECK: "off" });
    vi.resetModules();
    const { sihProvenance, resetSidecars } = await import("../src/provenance.js");
    resetSidecars();
    const bloco = sihProvenance([2023]) as unknown as { retrieved_at: string; citation: string };
    expect(bloco.retrieved_at).toBe("2026-03-09T03:05:34Z");
    expect(bloco.citation).toContain("idênticos aos .dbc originais do DATASUS na data do download");
    expect(bloco.citation).toContain("o mais antigo em 2026-03-09");
  });
});
