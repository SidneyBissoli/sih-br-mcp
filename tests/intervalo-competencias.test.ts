/**
 * O intervalo de competências do `data_vintage` é o mínimo e o máximo, venha o
 * sidecar em que ordem vier. Até a 1.5.0 eram as pontas da lista, e só
 * acertavam porque o sidecar vem ordenado — o ibge errava o mesmo intervalo
 * ordenando rótulos por extenso ("abril 2024–setembro 2024" para jan–dez).
 */
import { describe, expect, it } from "vitest";
import { intervaloDeCompetencias } from "../src/provenance.js";

describe("intervaloDeCompetencias", () => {
  it("é o mínimo e o máximo com a lista embaralhada, atravessando o ano", () => {
    expect(intervaloDeCompetencias(["2024-02", "2023-11", "2024-04", "2023-01"])).toEqual({
      first: "2023-01",
      last: "2024-04",
    });
  });

  it("uma competência só é início e fim", () => {
    expect(intervaloDeCompetencias(["2023-07"])).toEqual({ first: "2023-07", last: "2023-07" });
  });
});
