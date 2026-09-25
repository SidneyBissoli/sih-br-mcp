/**
 * `server/discover` anuncia TODAS as revisões que o servidor atende, não só as
 * modernas.
 *
 * O ACHADO. O `mcpscore` reprovava `protocol_version_supported_versions_include_negotiated`:
 * o servidor negocia 2025-11-25 pelo handshake `initialize` — é a revisão que o
 * próprio auditor negocia, e a que a maioria dos clientes fala hoje — mas o
 * `server/discover` anunciava só `["2026-07-28"]`. A mensagem do auditor é
 * explícita sobre as duas saídas: "add it to supportedVersions, or disable the
 * legacy lifecycle". Desligar o ciclo legado trocaria 1 ponto por uma regressão
 * de compatibilidade com quase todos os clientes; sobra anunciar a verdade.
 *
 * NO SIH, A REGRA SÓ APARECE DEPOIS DA OUTRA. Até 25/09/2026 o contêiner
 * atendia o HTTP por `server.connect(transport)` + `handleRequest`, o caminho
 * LEGADO do SDK: não havia `server/discover` nenhum (HTTP 400 "Unsupported
 * protocol version: 2026-07-28"), e o auditor reprovava a regra de cima,
 * `protocol_version_latest` (MEDIUM, 2 pontos, `modern_lifecycle_support:
 * false`). A entrada passou a ser `createMcpHandler` + `toNodeHandler`
 * (src/http.ts), que serve as duas eras — e aí o discover existe, anuncia só a
 * moderna, e este módulo completa o anúncio. No stdio o `serveStdio` já era
 * dual-era, e a regra reprovava exatamente como no ilo.
 *
 * POR QUE O SDK NÃO FAZ ISSO. O `_ondiscover()` do
 * `@modelcontextprotocol/server` 2.0.0 devolve
 * `modernProtocolVersions(this._supportedProtocolVersions)`, um filtro que
 * descarta por desenho toda revisão pré-2026 ("2025-era versions are negotiated
 * via `initialize`"). Não há opção que o desligue. É uma leitura mais estrita
 * que a do auditor, que se apoia em Basic §Versioning — onde o exemplo de
 * `UnsupportedProtocolVersionError` lista revisões legadas em `supported`.
 *
 * POR QUE PATCH DE MÉTODO, E NÃO TROCA DE HANDLER. Registrar o nosso próprio
 * handler de `server/discover` não gruda: a entrada HTTP do SDK instala
 * `() => server._ondiscover()` na instância que a factory devolve, A CADA
 * REQUEST, depois da nossa factory. Como o que ela instala é uma closure que
 * chama o MÉTODO, trocar o método vale para os dois caminhos — o handler do
 * construtor e o reinstalado — e sobrevive à reinstalação.
 *
 * A GUARDA. Isto mexe em `_ondiscover`, que é interno do SDK. O risco de um
 * patch assim é virar silêncio: o SDK renomeia o método, o patch não aplica
 * nada e ninguém percebe. Por isso `announceServedVersions` FALHA ALTO se a
 * forma esperada não estiver lá — o servidor nem constrói — em vez de seguir
 * com o anúncio antigo. `tests/discover.test.ts` prende o comportamento, e a
 * catraca do mcpscore no CI (.github/workflows/mcpscore.yml) pega a regressão
 * pelo lado de fora. Transplantado do ilo-mcp-server, a implementação de
 * referência do portfólio (mesmo SDK 2.0.0).
 */

import type { McpServer } from "@modelcontextprotocol/server";

/** A forma interna do SDK da qual este módulo depende — declarada, não suposta. */
interface ServidorComDiscover {
  _ondiscover(): { supportedVersions?: unknown };
  _supportedProtocolVersions?: unknown;
}

/**
 * Ordena revisões datadas da mais nova para a mais antiga. São strings
 * `AAAA-MM-DD`, então a ordem lexicográfica É a cronológica.
 */
export function maisNovaPrimeiro(versoes: readonly string[]): string[] {
  return [...new Set(versoes)].sort().reverse();
}

/**
 * Troca o `_ondiscover` da instância por um que anuncia todas as revisões
 * atendidas. Só a lista muda: capacidades e instruções continuam vindo do
 * cálculo do próprio SDK.
 */
export function announceServedVersions(server: McpServer): void {
  const low = server.server as unknown as ServidorComDiscover;

  if (typeof low._ondiscover !== "function") {
    throw new Error(
      "SDK mudou: Server._ondiscover sumiu — o anúncio de versões em src/discover.ts " +
        "deixaria de aplicar em silêncio. Reveja o módulo contra a versão nova do " +
        "@modelcontextprotocol/server antes de seguir.",
    );
  }
  if (
    !Array.isArray(low._supportedProtocolVersions) ||
    low._supportedProtocolVersions.some((v) => typeof v !== "string")
  ) {
    throw new Error(
      "SDK mudou: Server._supportedProtocolVersions não é mais uma lista de strings — " +
        "src/discover.ts não tem de onde tirar as revisões atendidas.",
    );
  }

  const original = low._ondiscover.bind(low);
  low._ondiscover = () => {
    const base = original();
    // LER NA HORA DA CHAMADA, não aqui na aplicação do patch. O
    // `installDiscoverHandler` do SDK ACRESCENTA as revisões modernas a
    // `_supportedProtocolVersions` por REATRIBUIÇÃO, já com o servidor
    // construído: uma referência capturada agora ficaria presa ao array
    // anterior. Foi o que aconteceu na primeira versão deste módulo no ilo — o
    // anúncio saiu com as cinco revisões legadas e SEM a 2026-07-28, e a regra
    // do auditor passou assim mesmo, porque ela só confere se a negociada está
    // na lista. Trocar uma omissão por outra não é corrigir.
    const agora = low._supportedProtocolVersions;
    if (!Array.isArray(agora) || agora.some((v) => typeof v !== "string")) return base;
    // A lista vem do próprio SDK, nunca de literais nossas: anunciar uma
    // revisão que o servidor não atende seria a mentira simétrica da que este
    // módulo corrige.
    return { ...base, supportedVersions: maisNovaPrimeiro(agora as string[]) };
  };
}
