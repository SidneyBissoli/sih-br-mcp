/**
 * Exceções com a CLASSE de telemetria declarada pelo TIPO (30/09/2026).
 *
 * A tool roda no container e a telemetria no Worker, que só lê a resposta: a
 * classe viaja em `_meta[CLASSE_DO_ERRO_META]` (ver src/upstream.ts), e o
 * `catch` final de `callTool` só a põe lá quando `classeDaExcecao` reconhece a
 * exceção. Um `throw new Error(...)` genérico saía sem `_meta`, e a borda caía
 * na FRASE ("Erro ao executar X: …") — medido: "Erro na query: <mensagem do
 * DuckDB>" virava `contrato`, `nao_encontrado` ou `outro` conforme a frase do
 * motor (e o SQL ecoado interpola valores do usuário, que também casavam).
 *
 * Regra do repositório (guardada por tests/guarda-classe-do-erro.test.ts):
 * em `src/db/`, `src/tools.ts` e `src/cache.ts`, todo erro lançado é de um
 * destes tipos (ou o `OrigemError`, que já declara a sua). O texto que o
 * cliente lê não muda: só o tipo diz a classe.
 */

/** Vocabulário fechado da telemetria (`outro` não se declara: é a falta de classe). */
export type ClasseDoErro = "contrato" | "nao_encontrado" | "fonte" | "defeito";

/** Base: uma exceção que diz a própria classe. Prefira os tipos nomeados abaixo. */
export class ErroComClasse extends Error {
  constructor(
    message: string,
    public readonly classe: ClasseDoErro,
  ) {
    super(message);
    this.name = "ErroComClasse";
  }
}

/** Bug ou configuração nossa (SQL que o motor recusou, pasta sem dado com o cache desligado, ramo inalcançável). */
export class ErroInterno extends ErroComClasse {
  constructor(message: string) {
    super(message, "defeito");
    this.name = "ErroInterno";
  }
}

/** Culpa de quem chamou: argumento inválido, fora do que o dado suporta. */
export class ErroDeContrato extends ErroComClasse {
  constructor(message: string) {
    super(message, "contrato");
    this.name = "ErroDeContrato";
  }
}

/** A origem falhou: dado que deveria ter chegado do canal e não chegou. */
export class FalhaDaFonte extends ErroComClasse {
  constructor(message: string) {
    super(message, "fonte");
    this.name = "FalhaDaFonte";
  }
}
