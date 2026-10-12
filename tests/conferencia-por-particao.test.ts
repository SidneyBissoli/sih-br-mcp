/**
 * "Conferido igual ao original em X" (healthbr-data S2, provado no ar em
 * 12/10/2026): o sync-check semanal grava em cada partição do índice do
 * espelho `last_checked_at` + `check_method`. A citação do bloco SIH passa a
 * dizer quando os .dbc usados foram conferidos iguais ao FTP do DATASUS — X é
 * o MAIS ANTIGO entre as partições de todos os cubos usados.
 *
 * Os casos negativos cobrem as três formas de afirmar o que não é: marca
 * sobre um .dbc REEDITADO (o espelho conferiu o arquivo novo, o cubo somou o
 * velho), partição sem marca (o MIN não existe) e marca malformada.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { conferenciasDoIndice, setConferenciasForTests, type MirrorManifest } from "../src/freshness.js";
import {
  conferenciaDoCubo,
  sihProvenance,
  trechoConferencia,
  type MarcaDeConferencia,
  type SihSidecar,
} from "../src/provenance.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/sih");
const real = JSON.parse(readFileSync(resolve(FIXTURE, "sih_provenance_2023.json"), "utf8")) as SihSidecar;

/** Índice do espelho com as MESMAS origens do sidecar e uma marca por partição. */
function indiceMarcado(s: SihSidecar, marca: (i: number) => Partial<MarcaDeConferencia>): Record<string, MarcaDeConferencia> {
  return Object.fromEntries(
    s.partitions.map((p, i) => [
      p.partition,
      { source_hash_md5: p.source_hash_md5, source_size_bytes: p.source_size_bytes, ...marca(i) },
    ]),
  );
}

const semanal = (i: number) => ({ last_checked_at: `2026-10-${String(12 + (i % 3)).padStart(2, "0")}T10:32:29Z`, check_method: "size" });

describe("conferenciaDoCubo", () => {
  it("todas as partições marcadas: X é o last_checked_at MAIS ANTIGO", () => {
    expect(real.partitions.length).toBeGreaterThan(2);
    const c = conferenciaDoCubo(real, indiceMarcado(real, semanal));
    expect(c).toEqual({ at: "2026-10-12T10:32:29Z", methods: ["size"] });
  });

  it("junta os métodos (md5 da manutenção + size da semana)", () => {
    const c = conferenciaDoCubo(real, indiceMarcado(real, (i) => ({ ...semanal(i), check_method: i === 0 ? "md5" : "size" })));
    expect(c?.methods).toEqual(["md5", "size"]);
  });

  it("partição REEDITADA no espelho (MD5 diferente): nenhuma afirmação", () => {
    const indice = indiceMarcado(real, semanal);
    const p0 = real.partitions[0]!.partition;
    indice[p0] = { ...indice[p0]!, source_hash_md5: "0".repeat(32) };
    expect(conferenciaDoCubo(real, indice)).toBeNull();
  });

  it("tamanho diferente também é outra origem", () => {
    const indice = indiceMarcado(real, semanal);
    const p0 = real.partitions[0]!.partition;
    indice[p0] = { ...indice[p0]!, source_size_bytes: real.partitions[0]!.source_size_bytes + 1 };
    expect(conferenciaDoCubo(real, indice)).toBeNull();
  });

  it("uma partição sem marca (ainda não conferida) derruba o cubo inteiro", () => {
    const indice = indiceMarcado(real, (i) => (i === 1 ? {} : semanal(i)));
    expect(conferenciaDoCubo(real, indice)).toBeNull();
  });

  it("partição que saiu do índice derruba o cubo", () => {
    const indice = indiceMarcado(real, semanal);
    delete indice[real.partitions[0]!.partition];
    expect(conferenciaDoCubo(real, indice)).toBeNull();
  });

  it("marca malformada (processing_timestamp no lugar do ISO) não conta", () => {
    const indice = indiceMarcado(real, (i) => (i === 0 ? { last_checked_at: "2026-10-12 10:32:29.1", check_method: "size" } : semanal(i)));
    expect(conferenciaDoCubo(real, indice)).toBeNull();
  });

  it("sidecar sem partições: nada a afirmar", () => {
    expect(conferenciaDoCubo({ partitions: [] }, {})).toBeNull();
  });
});

describe("trechoConferencia", () => {
  it("vazio quando algum cubo não tem conferência ou não há cubo", () => {
    expect(trechoConferencia([])).toBe("");
    expect(trechoConferencia([{ at: "2026-10-12T10:32:29Z", methods: ["size"] }, null])).toBe("");
  });

  it("o mais antigo entre os cubos, só a data, método legível", () => {
    expect(
      trechoConferencia([
        { at: "2026-10-19T03:01:00Z", methods: ["size"] },
        { at: "2026-10-12T10:32:29Z", methods: ["md5", "size"] },
      ]),
    ).toBe(", e conferidos iguais ao original no FTP do DATASUS (por MD5 ou tamanho) em 2026-10-12");
  });
});

describe("citação do bloco SIH", () => {
  afterEach(() => setConferenciasForTests(new Map()));

  it("sem conferência (checagem desligada/pendente) a citação não muda — o golden fica byte-idêntico", () => {
    const cit = sihProvenance([2023]).citation;
    expect(cit).toContain("na data do download");
    expect(cit).not.toContain("conferidos");
  });

  it("com o índice marcado, a citação diz quando o original foi conferido", () => {
    const index: MirrorManifest = { partitions: indiceMarcado(real, semanal) };
    setConferenciasForTests(conferenciasDoIndice([real], index));
    const cit = sihProvenance([2023]).citation;
    expect(cit).toContain("na data do download (MD5 de cada arquivo registrado), o mais antigo em ");
    expect(cit).toContain(", e conferidos iguais ao original no FTP do DATASUS (por tamanho) em 2026-10-12; agregados por sih-br-mcp v");
  });

  it("índice com uma partição reeditada: a citação volta a dizer só a data do download", () => {
    const partitions = indiceMarcado(real, semanal);
    const p0 = real.partitions[0]!.partition;
    partitions[p0] = { ...partitions[p0]!, source_hash_md5: "f".repeat(32) };
    setConferenciasForTests(conferenciasDoIndice([real], { partitions }));
    expect(sihProvenance([2023]).citation).not.toContain("conferidos");
  });
});
