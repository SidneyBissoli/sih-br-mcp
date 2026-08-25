/**
 * Utilitários para manipulação de dados populacionais
 *
 * NOTA: Dados populacionais foram adiados para fase futura.
 * Este arquivo contém apenas funções utilitárias de mapeamento.
 */

/**
 * Calcula taxa por 10.000 habitantes
 */
export function calculateRate(
  count: number,
  population: number,
  per: number = 10000
): number {
  if (population === 0) return 0;
  return (count / population) * per;
}

/**
 * Calcula percentual
 */
export function calculatePercentage(
  numerator: number,
  denominator: number
): number {
  if (denominator === 0) return 0;
  return (numerator / denominator) * 100;
}

/**
 * Mapeamento código IBGE UF (2 dígitos) -> Sigla
 */
export const UF_CODE_TO_SIGLA: Record<string, string> = {
  "11": "RO",
  "12": "AC",
  "13": "AM",
  "14": "RR",
  "15": "PA",
  "16": "AP",
  "17": "TO",
  "21": "MA",
  "22": "PI",
  "23": "CE",
  "24": "RN",
  "25": "PB",
  "26": "PE",
  "27": "AL",
  "28": "SE",
  "29": "BA",
  "31": "MG",
  "32": "ES",
  "33": "RJ",
  "35": "SP",
  "41": "PR",
  "42": "SC",
  "43": "RS",
  "50": "MS",
  "51": "MT",
  "52": "GO",
  "53": "DF",
};

/**
 * Mapeamento Sigla UF -> Código IBGE
 */
export const UF_SIGLA_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(UF_CODE_TO_SIGLA).map(([code, sigla]) => [sigla, code])
);

/**
 * Mapeamento UF -> Região
 */
export const UF_TO_REGION: Record<string, string> = {
  AC: "Norte",
  AP: "Norte",
  AM: "Norte",
  PA: "Norte",
  RO: "Norte",
  RR: "Norte",
  TO: "Norte",
  AL: "Nordeste",
  BA: "Nordeste",
  CE: "Nordeste",
  MA: "Nordeste",
  PB: "Nordeste",
  PE: "Nordeste",
  PI: "Nordeste",
  RN: "Nordeste",
  SE: "Nordeste",
  DF: "Centro-Oeste",
  GO: "Centro-Oeste",
  MT: "Centro-Oeste",
  MS: "Centro-Oeste",
  ES: "Sudeste",
  MG: "Sudeste",
  RJ: "Sudeste",
  SP: "Sudeste",
  PR: "Sul",
  RS: "Sul",
  SC: "Sul",
};

/**
 * Lista de UFs por região
 */
export const REGION_UFS: Record<string, string[]> = {
  Norte: ["AC", "AP", "AM", "PA", "RO", "RR", "TO"],
  Nordeste: ["AL", "BA", "CE", "MA", "PB", "PE", "PI", "RN", "SE"],
  "Centro-Oeste": ["DF", "GO", "MT", "MS"],
  Sudeste: ["ES", "MG", "RJ", "SP"],
  Sul: ["PR", "RS", "SC"],
};

/**
 * Extrai código da UF (2 primeiros dígitos) do código do município
 */
export function getUfFromMunicipio(municipioCode: string): string {
  return municipioCode.substring(0, 2);
}

/**
 * Obtém sigla da UF a partir do código do município
 */
export function getUfSiglaFromMunicipio(municipioCode: string): string {
  const ufCode = getUfFromMunicipio(municipioCode);
  return UF_CODE_TO_SIGLA[ufCode] || "";
}
