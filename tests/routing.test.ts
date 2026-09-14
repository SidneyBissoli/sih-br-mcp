/**
 * Decisão de rota e montagem de SQL — as funções puras de src/db/duckdb.ts.
 *
 * Por que este arquivo existe. Os 11 gates que já rodam no CI provam o
 * RESULTADO (o golden pina valores do caminho feliz; os de equivalência provam
 * que o pré-agregado devolve o mesmo número do cubo longo). Nenhum deles
 * interroga a DECISÃO em si, e é nela que este repositório já se machucou duas
 * vezes: o cache escolheu o cubo errado para a pergunta, e um artefato novo na
 * pasta entrou numa consulta por casar com o padrão do glob. Um teste de
 * equivalência só flagra isso quando os dois caminhos existem e discordam —
 * aqui a regra é interrogada diretamente, sem disco e sem DuckDB.
 *
 * Regra de ouro do PLAN-006, e o que a maior parte destes casos afirma: o
 * roteador é CONSERVADOR. O que não cabe EXATAMENTE no grão do pré-agregado
 * cai no cubo, com o número certo. Errar a rota para o cubo custa tempo; errar
 * para o pré-agregado devolveria número errado com cara de certo.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SummaryState } from "../src/cache.js";

function vazio(): SummaryState {
  return { resumoPath: null, freshYears: new Set<number>(), estratosPaths: new Map<number, string>() };
}

// O estado dos pré-agregados é o que o roteador consulta para saber o que há
// em disco. Ele nasce vazio num processo de teste (nada foi baixado), então o
// único jeito de exercitar os ramos `resumo` e `estratos` é injetá-lo.
const estadoCausas: SummaryState = vazio();
const estadoIcsap: SummaryState = vazio();

vi.mock("../src/cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cache.js")>()),
  causasSummaryState: () => estadoCausas,
  icsapSummaryState: () => estadoIcsap,
}));

const {
  CAUSAS_ESTRATOS_GROUP_COLS,
  CAUSAS_RESUMO_GROUP_COLS,
  aggregatedAgeGroupsFor,
  buildOrderBy,
  buildWhereClause,
  causasRoute,
  groupKey,
  groupSelect,
  resumoEligible,
  universeCondition,
} = await import("../src/db/duckdb.js");

/** Reescreve o estado injetado no lugar — as referências já foram capturadas. */
function comEstado(alvo: SummaryState, novo: Partial<SummaryState>): void {
  alvo.resumoPath = novo.resumoPath ?? null;
  alvo.freshYears = novo.freshYears ?? new Set<number>();
  alvo.estratosPaths = novo.estratosPaths ?? new Map<number, string>();
}

beforeEach(() => {
  comEstado(estadoCausas, {});
  comEstado(estadoIcsap, {});
});

// ---------------------------------------------------------------------------
// WHERE
// ---------------------------------------------------------------------------

describe("buildWhereClause", () => {
  it("sem filtro nenhum devolve 1=1, e não uma cláusula vazia", () => {
    // Vazio concatenado num `WHERE ${...}` produziria SQL inválido.
    expect(buildWhereClause({})).toBe("1=1");
  });

  it("junta as condições com AND, uma por filtro presente", () => {
    const where = buildWhereClause({ years: [2023], ufs: ["MG", "RJ"], sex: "M" });
    expect(where.split(" AND ")).toEqual(["year IN (2023)", "uf IN ('MG', 'RJ')", "sex = 'M'"]);
  });

  it("idade ZERO vira condição — o recém-nascido não pode sumir por ser falsy", () => {
    // `if (filters.ageMin)` deixaria 0 de fora e a resposta traria todas as
    // idades com cara de recorte pedido. A guarda certa é !== undefined.
    expect(buildWhereClause({ ageMin: 0, ageMax: 0 })).toBe("age >= 0 AND age <= 0");
  });

  it("is_csap FALSE vira condição — a mesma armadilha do valor falsy", () => {
    expect(buildWhereClause({ isCsap: false })).toBe("is_csap = false");
  });

  it("lista vazia não vira IN vazio", () => {
    expect(buildWhereClause({ years: [], ufs: [], races: [] })).toBe("1=1");
  });
});

// ---------------------------------------------------------------------------
// ORDER BY determinístico
// ---------------------------------------------------------------------------

describe("buildOrderBy", () => {
  it("sem ordenação e sem agrupamento não emite ORDER BY", () => {
    expect(buildOrderBy(undefined, [])).toBe("");
  });

  it("toda coluna de agrupamento não mencionada entra como desempate, na ordem do GROUP BY", () => {
    // Sem isto o DuckDB devolve os grupos na ordem em que as threads terminam,
    // e um LIMIT em cima disso corta SUBCONJUNTOS diferentes a cada chamada.
    expect(buildOrderBy("total DESC", ["uf", "sex"])).toBe(" ORDER BY total DESC, uf, sex");
  });

  it("coluna já mencionada na ordenação não se repete como desempate", () => {
    expect(buildOrderBy("uf ASC", ["uf", "year"])).toBe(" ORDER BY uf ASC, year");
  });

  it("agrupamento sem ordenação pedida ordena pelas próprias chaves", () => {
    expect(buildOrderBy(undefined, ["year", "uf"])).toBe(" ORDER BY year, uf");
  });
});

// ---------------------------------------------------------------------------
// cid_revision: cubo velho no cache misto traz a coluna NULA
// ---------------------------------------------------------------------------

describe("groupSelect / groupKey", () => {
  it("cid_revision nula é lida como 10 — nula significa CID-10", () => {
    expect(groupSelect("cid_revision")).toBe("COALESCE(cid_revision, 10) AS cid_revision");
    expect(groupKey("cid_revision")).toBe("COALESCE(cid_revision, 10)");
  });

  it("qualquer outra coluna passa intacta", () => {
    for (const col of ["year", "uf", "sex", "cid_chapter"]) {
      expect(groupSelect(col)).toBe(col);
      expect(groupKey(col)).toBe(col);
    }
  });
});

// ---------------------------------------------------------------------------
// Universo do percentual ICSAP
// ---------------------------------------------------------------------------

describe("universeCondition", () => {
  it("o padrão é csapaih — exclusões fora do numerador E do denominador", () => {
    expect(universeCondition(undefined)).toBe("AND exclusion IS NULL");
    expect(universeCondition("csapaih")).toBe("AND exclusion IS NULL");
  });

  it("o universo `all` não impõe condição nenhuma", () => {
    expect(universeCondition("all")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Faixas etárias agregadas (denominador populacional antes de 2000)
// ---------------------------------------------------------------------------

describe("aggregatedAgeGroupsFor", () => {
  it("sem filtro de idade devolve undefined (todas as faixas)", () => {
    expect(aggregatedAgeGroupsFor(undefined, undefined)).toBeUndefined();
  });

  it("recorte alinhado às faixas quinquenais devolve exatamente as faixas", () => {
    expect(aggregatedAgeGroupsFor(0, 14)).toEqual(["0-4", "5-9", "10-14"]);
  });

  it("recorte desalinhado devolve null — taxa com denominador aproximado é número errado", () => {
    expect(aggregatedAgeGroupsFor(0, 17)).toBeNull();
    expect(aggregatedAgeGroupsFor(3, 14)).toBeNull();
  });

  it("60 e mais alcança a faixa aberta 80 e +", () => {
    expect(aggregatedAgeGroupsFor(60, undefined)).toContain("80 e +");
  });
});

// ---------------------------------------------------------------------------
// Roteamento do cubo de CAUSAS (PLAN-006)
// ---------------------------------------------------------------------------

describe("causasRoute", () => {
  const RESUMO = "/cache/sih_causas_resumo.parquet";
  const ESTRATOS_2023 = "/cache/sih_causas_estratos_2023.parquet";

  function comTudoEmDisco(): void {
    comEstado(estadoCausas, {
      resumoPath: RESUMO,
      freshYears: new Set([2023]),
      estratosPaths: new Map([[2023, ESTRATOS_2023]]),
    });
  }

  it("cabendo no grão grosso, vai para o resumo e não toca cubo nenhum", () => {
    comTudoEmDisco();
    const rota = causasRoute({ groupBy: ["year", "uf"] }, [2023]);
    expect(rota.kind).toBe("resumo");
    expect(rota.source).toContain("sih_causas_resumo.parquet");
  });

  it("pedindo sexo ou raça, sobe para os estratos com o ano certo na fonte", () => {
    comTudoEmDisco();
    const rota = causasRoute({ filters: { sex: "M" }, groupBy: ["year"] }, [2023]);
    expect(rota.kind).toBe("estratos");
    expect(rota.source).toContain("sih_causas_estratos_2023.parquet");
  });

  it("a faixa etária vira condição de age_group e o filtro de idade simples é retirado", () => {
    // Os estratos só têm idade em FAIXA: deixar ageMin/ageMax no WHERE
    // filtraria por uma coluna `age` que não existe no pré-agregado.
    comTudoEmDisco();
    const rota = causasRoute({ filters: { ageMin: 0, ageMax: 4 } }, [2023]);
    expect(rota.kind).toBe("estratos");
    expect(rota.filters.ageMin).toBeUndefined();
    expect(rota.filters.ageMax).toBeUndefined();
    expect(rota.extraWhere).toEqual(["age_group IN ('0-4')"]);
  });

  // O coração do desenho: tudo que segue tem de cair no cubo.
  it.each([
    ["mês no filtro", { filters: { months: [1] } }],
    ["categoria CID no filtro", { filters: { cidGroups: ["A09"] } }],
    ["grupo CSAP no filtro", { filters: { csapGroups: ["g01"] } }],
    ["município no filtro", { filters: { municipalityCodes: ["310620"] } }],
    ["agrupar por mês", { groupBy: ["month"] }],
    ["agrupar por categoria CID", { groupBy: ["cid_group"] }],
    ["agrupar por grupo CSAP", { groupBy: ["csap_group"] }],
    ["agrupar por idade simples", { filters: { sex: "M" }, groupBy: ["age"] }],
    ["faixa etária desalinhada", { filters: { ageMin: 0, ageMax: 17 } }],
  ])("cai no cubo: %s", (_caso, options) => {
    comTudoEmDisco();
    expect(causasRoute(options, [2023]).kind).toBe("cubo");
  });

  it("cai no cubo quando o resumo não está em disco", () => {
    comEstado(estadoCausas, { freshYears: new Set([2023]) });
    expect(causasRoute({ groupBy: ["year"] }, [2023]).kind).toBe("cubo");
  });

  it("cai no cubo quando o resumo existe mas NÃO é fresco para o ano pedido", () => {
    // Resumo derivado de um cubo que o canal já republicou responderia número
    // velho — é a versão pré-agregada do defeito de cache de borda.
    comEstado(estadoCausas, { resumoPath: RESUMO, freshYears: new Set([2022]) });
    expect(causasRoute({ groupBy: ["year"] }, [2023]).kind).toBe("cubo");
  });

  it("cai no cubo quando falta o estrato de UM dos anos pedidos", () => {
    comEstado(estadoCausas, {
      resumoPath: RESUMO,
      freshYears: new Set([2022, 2023]),
      estratosPaths: new Map([[2023, ESTRATOS_2023]]),
    });
    expect(causasRoute({ filters: { sex: "M" } }, [2022, 2023]).kind).toBe("cubo");
  });

  it("sem ano nenhum cai no cubo", () => {
    comTudoEmDisco();
    expect(causasRoute({ groupBy: ["year"] }, []).kind).toBe("cubo");
  });

  it("o grão B é o grão A mais sexo e raça — e age NÃO entra", () => {
    // A relação entre os dois conjuntos é o que autoriza o `if` em cascata do
    // roteador; derivar a asserção dos conjuntos, e não de uma lista à mão,
    // faz este teste acompanhar quem editar o grão.
    for (const col of CAUSAS_RESUMO_GROUP_COLS) expect(CAUSAS_ESTRATOS_GROUP_COLS).toContain(col);
    expect([...CAUSAS_ESTRATOS_GROUP_COLS].filter((c) => !CAUSAS_RESUMO_GROUP_COLS.has(c)).sort()).toEqual(["race", "sex"]);
    expect(CAUSAS_ESTRATOS_GROUP_COLS.has("age")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Roteamento do resumo ICSAP (PLAN-005)
// ---------------------------------------------------------------------------

describe("resumoEligible", () => {
  const RESUMO = "/cache/sih_icsap_resumo.parquet";

  it("cabendo no grão, devolve o caminho do resumo", () => {
    comEstado(estadoIcsap, { resumoPath: RESUMO, freshYears: new Set([2023]) });
    expect(resumoEligible({ groupBy: ["year", "uf", "csap_group"] }, [2023])).toBe(RESUMO);
  });

  it.each([
    ["município no filtro", { filters: { municipalityCodes: ["310620"] } }],
    ["sexo no filtro", { filters: { sex: "F" } }],
    ["idade no filtro", { filters: { ageMin: 60 } }],
    ["raça no filtro", { filters: { races: ["1"] } }],
    ["agrupamento fora do grão", { groupBy: ["sex"] }],
  ])("recusa (cai no caminho fino): %s", (_caso, options) => {
    comEstado(estadoIcsap, { resumoPath: RESUMO, freshYears: new Set([2023]) });
    expect(resumoEligible(options, [2023])).toBeNull();
  });

  it("recusa quando o resumo não vale para todos os anos pedidos", () => {
    comEstado(estadoIcsap, { resumoPath: RESUMO, freshYears: new Set([2023]) });
    expect(resumoEligible({ groupBy: ["year"] }, [2022, 2023])).toBeNull();
  });

  it("recusa sem resumo em disco e sem ano", () => {
    comEstado(estadoIcsap, { freshYears: new Set([2023]) });
    expect(resumoEligible({ groupBy: ["year"] }, [2023])).toBeNull();
    comEstado(estadoIcsap, { resumoPath: RESUMO, freshYears: new Set([2023]) });
    expect(resumoEligible({ groupBy: ["year"] }, [])).toBeNull();
  });
});
