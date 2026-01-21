/**
 * Utilitários para manipulação de faixas etárias
 */

/**
 * Faixas etárias padrão utilizadas no projeto
 */
export const AGE_GROUPS = [
  { code: "<1", label: "Menor de 1 ano", min: 0, max: 0 },
  { code: "1-4", label: "1 a 4 anos", min: 1, max: 4 },
  { code: "5-9", label: "5 a 9 anos", min: 5, max: 9 },
  { code: "10-14", label: "10 a 14 anos", min: 10, max: 14 },
  { code: "15-19", label: "15 a 19 anos", min: 15, max: 19 },
  { code: "20-29", label: "20 a 29 anos", min: 20, max: 29 },
  { code: "30-39", label: "30 a 39 anos", min: 30, max: 39 },
  { code: "40-49", label: "40 a 49 anos", min: 40, max: 49 },
  { code: "50-59", label: "50 a 59 anos", min: 50, max: 59 },
  { code: "60-69", label: "60 a 69 anos", min: 60, max: 69 },
  { code: "70-79", label: "70 a 79 anos", min: 70, max: 79 },
  { code: "80+", label: "80 anos ou mais", min: 80, max: 150 },
] as const;

export type AgeGroupCode = (typeof AGE_GROUPS)[number]["code"];

/**
 * Converte idade em anos para código de faixa etária
 */
export function ageToGroup(age: number): AgeGroupCode {
  if (age < 0) return "<1";
  if (age < 1) return "<1";
  if (age < 5) return "1-4";
  if (age < 10) return "5-9";
  if (age < 15) return "10-14";
  if (age < 20) return "15-19";
  if (age < 30) return "20-29";
  if (age < 40) return "30-39";
  if (age < 50) return "40-49";
  if (age < 60) return "50-59";
  if (age < 70) return "60-69";
  if (age < 80) return "70-79";
  return "80+";
}

/**
 * Retorna informações de uma faixa etária pelo código
 */
export function getAgeGroup(code: string) {
  return AGE_GROUPS.find((g) => g.code === code);
}

/**
 * Valida se um código de faixa etária é válido
 */
export function isValidAgeGroup(code: string): code is AgeGroupCode {
  return AGE_GROUPS.some((g) => g.code === code);
}

/**
 * Retorna faixas etárias para população idosa (60+)
 */
export function getElderlyAgeGroups(): AgeGroupCode[] {
  return ["60-69", "70-79", "80+"];
}

/**
 * Retorna faixas etárias para crianças (0-14)
 */
export function getChildrenAgeGroups(): AgeGroupCode[] {
  return ["<1", "1-4", "5-9", "10-14"];
}

/**
 * Retorna faixas etárias para adultos em idade ativa (15-59)
 */
export function getWorkingAgeGroups(): AgeGroupCode[] {
  return ["15-19", "20-29", "30-39", "40-49", "50-59"];
}

/**
 * Pesos populacionais padrão OMS para ajuste por idade
 * (Distribuição etária padrão mundial 2000-2025)
 */
export const WHO_STANDARD_POPULATION: Record<AgeGroupCode, number> = {
  "<1": 0.0177,
  "1-4": 0.0707,
  "5-9": 0.0879,
  "10-14": 0.0858,
  "15-19": 0.0847,
  "20-29": 0.1620,
  "30-39": 0.1399,
  "40-49": 0.1210,
  "50-59": 0.0905,
  "60-69": 0.0661,
  "70-79": 0.0448,
  "80+": 0.0289,
};

/**
 * Calcula taxa ajustada por idade usando método direto
 * @param ratesByAge Taxas específicas por faixa etária
 * @returns Taxa padronizada (ajustada)
 */
export function calculateAgeAdjustedRate(
  ratesByAge: Record<AgeGroupCode, number>
): number {
  let adjustedRate = 0;

  for (const [ageGroup, weight] of Object.entries(WHO_STANDARD_POPULATION)) {
    const rate = ratesByAge[ageGroup as AgeGroupCode] || 0;
    adjustedRate += rate * weight;
  }

  return adjustedRate;
}
