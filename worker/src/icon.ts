/** Ícone do servidor — pictograma chapado (leito hospitalar e uma cruz),
 * 512x512 PNG, embutido em base64. Servido pela rota pública /icon.png do
 * Worker e declarado em server.json (icons[0]) e no serverInfo do handshake
 * (src/server.ts da raiz, que roda no contêiner).
 *
 * ESTE ARQUIVO É A FONTE. Não há cópia em `assets/` de propósito: byte
 * duplicado em dois lugares deriva, e nada avisaria — a rota serviria uma
 * imagem e o manifesto prometeria outra, ambas com 200. Mesmo arranjo do
 * ilo-mcp-server, do uis-mcp-server e do senado-br-mcp-cloudflare.
 *
 * A rota vive no WORKER, não no contêiner: o Worker é o proxy público e é ele
 * quem responde às URLs do domínio; o contêiner só recebe /mcp.
 *
 * POR QUE NÃO É O EMBLEMA DO SUS NEM O DO DATASUS. São marcas de órgão
 * público; este servidor não é afiliado ao Ministério da Saúde nem ao
 * DATASUS, e um emblema oficial sugeriria vínculo que não existe. É a linha
 * que o portfólio já segue: o bcb usa uma cédula e não o logo do Banco
 * Central, o uis um livro e não o emblema da UNESCO.
 *
 * Paleta dos irmãos: figura #30C5CC sobre fundo #083B6A, cantos arredondados.
 * Fonte vetorial: um SVG de 7 retângulos (cabeceira, travesseiro, leito, dois
 * pés, cruz), rasterizado a 512x512 com sharp em 25/09/2026.
 */

export const ICON_PNG_BASE64 =
  "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" +
  "SUVORK5CYII=";
