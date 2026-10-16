/**
 * Arredondamento das taxas por população (1.8.0, ROADMAP "duas casas decimais
 * zeram taxa pequena"). Até a 1.7.1, `Math.round(x * 100) / 100` zerava toda
 * taxa abaixo de 0,005 na base pedida: SP com 2 internações para 45,8 M de
 * habitantes saía `rate: 0`. Medido em 15/10/2026 com a ferramenta real:
 * 135 de 5.586 estratos ano × UF × capítulo (2015–2024) zerados por mil.
 */
import { describe, expect, it } from "vitest";
import { arredondarTaxa } from "../src/tools.js";

const antigo = (x: number) => Math.round(x * 100) / 100;

describe("arredondarTaxa", () => {
  it("taxa pequena não vira zero (controle negativo: o arredondamento antigo zera)", () => {
    const sp = (2 / 45_800_000) * 100_000;
    expect(antigo(sp)).toBe(0);
    expect(arredondarTaxa(sp)).toBe(0.00437);
    expect(arredondarTaxa(0.0217391)).toBe(0.0217);
    expect(arredondarTaxa(0.123456)).toBe(0.123);
  });

  it("taxa ≥ 1 sai como antes (duas casas)", () => {
    for (const x of [1, 5.4321, 12.345678, 6543.2109, 98765.4321]) expect(arredondarTaxa(x)).toBe(antigo(x));
  });

  it("zero é zero", () => {
    expect(arredondarTaxa(0)).toBe(0);
  });
});
