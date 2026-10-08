# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Versões seguem
o `package.json`, espelhado à mão em `server.json` (raiz e `packages[0]`) e em
`lhm.plugin.json` — este repositório não tem hook `version`, e o `publish.yml` reprova
se divergirem. Uma versão = uma tag `v*`, que dispara a publicação no npm
(`sih-br-mcp`, runtime stdio) e no MCP Registry e o deploy do contêiner em
`https://sih.sidneybissoli.com/mcp`.

**Este arquivo foi reconstruído em 2026-10-08**, porque o repositório não tinha
changelog até então. Fontes: as tags `v*`, as notas das releases do GitHub, as datas
de publicação do npm (`npm view sih-br-mcp time`, que dão a data de cada seção, em UTC) e os
commits de cada intervalo entre tags; o porquê vem das decisões numeradas do
`CONTEXT.md` quando o commit é curto. As 28 versões do npm (0.12.0 a 1.4.2) têm tag;
não há versão no npm anterior à 0.12.0. As versões 0.9.0 a 0.11.0 e a 0.13.0 foram
numeradas no código e nunca publicadas: o trabalho delas está na versão publicada
seguinte. Não tinham release no GitHub em 08/10/2026 (só tag e npm): 0.15.5, 0.15.6,
0.15.7, 0.16.0 e 1.4.2. As tags `cubes-AAAAMMDD-HHMM` (06 a 08/09/2026) marcam reconstruções dos cubos
de dados pelo `rebuild-cubes.yml`, antes de o produtor migrar para o healthbr-data na
0.11.0 — são publicações de dados, não do servidor.

## [Não lançado]

## [1.4.2] — 2026-10-08

A impressão digital da superfície passa a ir **na entrada do MCP Registry**, para o
cliente conferir. **Nenhuma tool, resource, prompt ou resposta muda** — o sha da
superfície declarada é o mesmo travado em 1.4.0 (`873091ada6bf`).

### Adicionado

- `server.json` publica, sob `_meta["io.modelcontextprotocol.registry/publisher-provided"]`,
  o sha256 da superfície declarada e quem responde sem credencial no endpoint publicado
  (forma `mcp-surface/1`, SPEC.md do `@sbissoli/mcp-surface` 0.5.0). Ideia de dois
  leitores do artigo do replay no dev.to (Mike Dabydeen e Valentina Koniukhova). (#51)
- `npm run surface:lock` grava o bloco; o teste da trava reprova `server.json`
  defasado; o `publish.yml` termina com `mcp-surface conferir-registro` (registro × ar,
  como um cliente). (#51)

### Alterado

- Nome completo do autor nos campos públicos de autoria. (#50)

## [1.4.1] — 2026-10-06

Só dependências: SDK do MCP (`@modelcontextprotocol/server`) 2.1.0 → 2.3.0 e
`@modelcontextprotocol/node` 2.1.1. Nenhuma resposta e nenhum esquema mudam (as 30
diferenças do golden são a versão dentro da citação). (#48)

### Segurança

- GHSA-6qxp-vccf-f47h em `@modelcontextprotocol/client`: sobe a 2.3.0 — dependência só
  de testes e scripts, nunca carregada pelo pacote publicado.
- `source-map-js` 1.2.2 nos dois lockfiles (GHSA-68fv-2mgg-jv7q). (#49)

## [1.4.0] — 2026-10-06

### Alterado

- `@sbissoli/mcp-provenance` 0.3.0 e `@sbissoli/mcp-upstream` 0.4.0 — passo 1 do contrato
  de proveniência v1.2, como nos seis irmãos: o esquema de saída passa a DECLARAR a chave
  opcional `field_sources` do bloco conciso, sem emiti-la. O servidor segue emitindo o
  contrato 1.1, byte a byte igual; a diferença de superfície é só aditiva, por isso
  minor. (#47)

## [1.3.0] — 2026-10-06

### Alterado

- **`retrieved_at` passa a ser o download MAIS ANTIGO** entre os `.dbc` das partições
  usadas. Até a 1.2.3 era o máximo dos sidecars (cada um já o máximo das suas
  partições), que escondia o arquivo baixado há mais tempo. A citação passa a dizer
  que os microdados são idênticos aos `.dbc` originais do DATASUS na data do download
  (MD5 registrado), o mais antigo em AAAA-MM-DD. Mudança de valor, não de formato.
  Decisão 51. (#46)

### Adicionado

- Trava da superfície (`surface.lock.json`, `@sbissoli/mcp-surface`): superfície que
  muda sem subir a versão = build vermelho e deploy recusado. (#42)
- Teste de saída com forma de cliente (`@sbissoli/mcp-surface/cliente`). (#43)
- Server card no Worker (`/.well-known/mcp/server-card.json`). (#44)

## [1.2.3] — 2026-10-01

### Corrigido

- Exceção no handler volta a ser erro de verdade: os 9 handlers de dado tinham um
  `try/catch` que devolvia qualquer exceção (falha do DuckDB, cubo ausente, erro do
  canal) como `{ error, data: [] }` num sucesso, e a telemetria registrava `ok`. A
  exceção agora sobe ao `callTool` → `isError` com a classe em `_meta`; erro-mole fica
  só onde é deliberado. (#40)

## [1.2.2] — 2026-10-01

### Corrigido

- Classe do erro na telemetria declarada pelo TIPO em todo erro lançado de `src/`. (#38)

## [1.2.1] — 2026-09-30

Sem mudança na superfície publicada.

### Corrigido

- Classe do erro na telemetria pelo tipo da falha, não pela frase: 4xx do canal, corpo
  inesperado, corpo vazio e falha de tamanho/SHA-256 caíam em `outro` e passam a
  `fonte`. Como as tools rodam no contêiner e a telemetria no Worker, a classe viaja em
  `_meta` (`br.com.sidneybissoli.sih/classe-do-erro`). (#36)
- A fixture congelada de testes se defende por pasta (marcador
  `.fixture-somente-leitura`): uma sonda avulsa tinha baixado o resumo real para dentro
  dela. Produção não é afetada. (#35)

### Alterado

- `wrangler` 4.144.0 no Worker (undici 7.29.1). (#34)

## [1.2.0] — 2026-09-30

### Corrigido

- **`get_hospitalization_rates` punha a taxa em `rate_per_100k` qualquer que fosse
  `rate_per`**: com `rate_per: 1000`, o campo "por 100 mil" carregava a taxa por mil —
  erro de 100× para quem confia no nome. Novo campo obrigatório `rate` (internações por
  `rate_per` habitantes); `rate_per_100k` passa a valer sempre por 100 mil e fica
  `deprecated`. Na base padrão os dois coincidem. Decisão 45. (#33)

### Alterado

- Dependências do grupo minor-and-patch (5 atualizações). (#32)

## [1.1.0] — 2026-09-27

### Adicionado

- **`retrieval` no bloco de proveniência** (contrato v1.1 do `@sbissoli/mcp-provenance`):
  quantas idas ao canal `sih/cubos/` a chamada custou, quantas tentativas e que
  anomalias foram contornadas. Aqui `retrieval: null` significa resposta servida do
  disco. Decisão 44. (#31)
- Ficha do LobeHub derivada da superfície — a listagem estava "Unvalidated" com zero
  tools. (#30)

### Alterado

- Ponto único de rede (`src/upstream.ts`, `@sbissoli/mcp-upstream` 0.3.0) com política
  medida contra o canal: User-Agent, 15 s por tentativa, 2 retries em 429/5xx/rede.
  Antes não havia retry nem User-Agent em nenhum `fetch`. (#31)

### Corrigido

- Worker encaminha `Mcp-Method` e `Mcp-Param-*` ao contêiner — a era moderna do
  protocolo morria na borda. (#28)
- Worker trata todo cabeçalho `mcp-*` por prefixo e alinha o rate limit aos irmãos — o
  auditor tomava 429. (#29)

## [1.0.1] — 2026-09-25

### Corrigido

- Conformidade (mcpscore a 100%): o contêiner atende as duas eras do protocolo
  (`createMcpHandler`), cursor de paginação inválido devolve `-32602` em vez da lista,
  `instructions` no handshake e `server/discover` com a revisão negociada. (#27)

## [1.0.0] — 2026-09-25

**Major sem mudança de ferramenta, esquema ou resposta.** O que o major afirma é
estabilidade: a superfície vira contrato, e quebra de chamador passa a ser major
(superfície que muda segue sendo minor). Decisão 42.

### Adicionado

- Ícone (`/icon.png` no Worker), `websiteUrl` e `icons` no `serverInfo` do handshake e no
  `server.json`, e o endpoint remoto em `remotes`. (#26)

## [0.18.0] — 2026-09-25

### Corrigido

- **A mesma pergunta passa a ter UMA resposta, com ou sem cubo em disco.** Um ano que
  não existe recebia `isError` sem proveniência com o contêiner frio e sucesso honesto
  com `available_sih_years` e `note` com algum cubo em disco — 8 das 8 ferramentas com
  ano divergiam, e o caso frio era o comum. A guarda antiga saiu; a frase vem de uma
  função só; `published_years` (a verdade do canal) entra ao lado de
  `available_sih_years`. Decisão 41. (#25)

## [0.17.0] — 2026-09-24

### Corrigido

- `classify_as_csap` deixa de responder sobre o que não é CID-10: `["ZZZZ"]` devolvia
  `is_csap: false`, uma afirmação clínica sobre uma string que não nomeia condição.
  Agora volta `is_csap: null` com `error`. Decisão 40.
- O ponto trocava a resposta: `J18.1` saía `is_csap: false` e `J181` saía `true`, para a
  mesma pneumonia — o ponto era tirado só do lado da lista. As duas notações agora
  casam. O resumo deixa de contar os não classificados como `non_csap`.

### Adicionado

- Telemetria lê o desfecho e a classe do erro do envelope da resposta. (#24)

### Alterado

- `@duckdb/node-api` 1.5.5-r.5 e dependências de desenvolvimento. (#22, #23)

## [0.16.0] — 2026-09-17

### Adicionado

- **`outputSchema` nas 12 ferramentas**, escrito à mão a partir de 101 chamadas medidas,
  e o gate de contrato de saída: o `structuredContent` é validado contra o esquema lido
  do `tools/list`. Anunciado, não imposto em runtime. Decisão 39. (#21)

## [0.15.7] — 2026-09-16

### Adicionado

- Telemetria com id de sessão (`Mcp-Session-Id`) e nome do cliente.

### Corrigido

- O portão dos estratos pré-assados usa o mesmo critério de frescor do runtime.

## [0.15.6] — 2026-09-14

### Alterado

- Deploy do contêiner por tag, e o Worker entra no CI. (#20)

## [0.15.5] — 2026-09-14

### Corrigido

- **Ano que não existe deixa de ser respondido com zero** em 6 das 8 ferramentas de
  dado: quem pedia um ano fora da série recebia medidas nulas e total 0, sem aviso, e
  passa a receber `{error, available_sih_years, note}`; pedido parcialmente atendível
  traz `years_not_available`. Mudança de comportamento. Decisão 38. (#19)

### Adicionado

- Suíte vitest: decisão de rota e envelope de saída. (#18)

## [0.15.4] — 2026-09-13

### Alterado

- **Contrato de entrada:** os 12 esquemas ganham `additionalProperties: false` e a
  recusa nomeia a chave desconhecida. Antes, `list_csap_groups({group_codes: "g01"})`
  devolvia os 19 grupos como se fosse o pedido.
- README e descrições com o vocabulário das perguntas reais (internações hospitalares,
  AIH, DATASUS, uma linha em inglês): o monitor GEO não achava o servidor em 24 de 24
  sondas.

### Adicionado

- Rota privada do dono, para o uso próprio parar de contar como adoção.

## [0.15.3] — 2026-09-10

### Alterado

- Estratos do grão B (sexo, faixa etária, raça) pré-baixados na imagem do contêiner: a
  série longa com recorte demográfico cai de 14,0 s para 2,8 s. Stdio não é afetado.

## [0.15.2] — 2026-09-10

### Corrigido

- **Contagem dobrada:** o glob `sih_<tipo>_*.parquet` casava também os pré-agregados
  baixados para a mesma pasta, e `get_hospitalizations` por ano e mês devolveu
  26.648.728 internações em 2023, o dobro das 13.324.364 reais. O cubo agora só lê cubo.
  Achado por um usuário na primeira pergunta real ao conector.

## [0.15.1] — 2026-09-10

### Alterado

- Os 34 sidecars de proveniência e os dois resumos pré-agregados vão pré-assados na
  imagem do contêiner (eram 9,7 dos 10,3 MB do custo frio da série de 34 anos).

## [0.15.0] — 2026-09-10

### Alterado

- O cubo de causas, o último caminho caro (1.253 MB nos 34 anos), passa a ser
  respondido pelos pré-agregados do canal (grãos A e B, manifesto 1.4.0). Medido no
  endpoint público: série de 34 anos 54,7 s → 0,6 s; principais capítulos CID 58,7 s →
  0,2 s. PLAN-006.

## [0.14.2] — 2026-09-10

### Corrigido

- As notas de era de 1992–1997 sumiam: o resultado vazio era memoizado (array vazio é
  verdadeiro em JS) e o caminho do resumo não trazia sidecar. Decisão 33.
- Teto de 5.000 linhas por resposta nas 12 ferramentas, com aviso de quantas ficaram de
  fora (`get_icsap` por município × grupo devolvia 83.769 linhas e 17,9 MB).

## [0.14.1] — 2026-09-10

### Corrigido

- "Total do Brasil desde 1992" levava 4 minutos: o cache baixava os três cubos de cada
  ano para consultas que leem um tipo só, `year_start`/`year_end` do trends não era
  reconhecido como ano, e o trends anual lia o cubo de causas onde o de séries tem as
  mesmas medidas. Decisão 32.

## [0.14.0] — 2026-09-09

### Alterado

- Série ICSAP pelos pré-agregados do canal (resumo e estratos, manifesto 1.3.0).
  PLAN-005, decisão 31.

### Segurança

- `sharp` 0.35.4 por override (libheif, alerta high do Dependabot). (#11)

## [0.13.1] — 2026-09-09

Leva também o trabalho da 0.13.0, que nunca foi tagueada nem publicada.

### Adicionado

- **Servidor remoto:** entrada Streamable HTTP, contêiner Cloudflare atrás do Worker de
  borda, em `https://sih.sidneybissoli.com/mcp`. Decisão 30.

### Alterado

- SDK v2, factory `createServer()` e dois transportes sobre o mesmo despacho. A
  validação de entrada passa a valer: `rank_csap_groups({limit: 50})` é recusado com
  `-32602` (o esquema sempre disse no máximo 19). `SERVER_VERSION` passa a ler o
  `package.json` — estava fixo em "0.10.0", e o handshake e a citação anunciavam versão
  errada. Decisão 29.

### Corrigido

- A consulta ICSAP de vários anos estourava a memória do contêiner (ano a ano agora) e o
  `shutdown` esperava o DuckDB fechar no meio da consulta (sai em 5 s).
- Descrição do `server.json` com até 100 caracteres — o registro devolveu 422 na 0.12.1.

## [0.12.1] — 2026-09-08

### Adicionado

- `server.json` e `mcpName`: o servidor passa a existir no MCP Registry como
  `io.github.SidneyBissoli/sih-br-mcp`. A primeira publicação no registro foi recusada
  (descrição acima de 100 caracteres, 422) e refeita por dispatch do `publish.yml`
  depois de encurtar a descrição.

## [0.12.0] — 2026-09-08

Primeira publicação no npm (`npx -y sih-br-mcp`, Node 22+). O pacote não embarca dado:
cubos, tabelas de classificação e população vêm do canal público
`https://data.sidneybissoli.com/sih/cubos/` na primeira chamada, com SHA-256 conferido
contra o manifesto. Leva o trabalho das 0.9.0 a 0.11.0, numeradas e não publicadas.

### Adicionado

- População (IBGE Projeção 2024 e DATASUS) vem do canal como os cubos, com proveniência
  própria.
- Taxas por 100 mil para 1992–1999.
- Era antiga 1992–1997 (CID-9), com a lista ICSAP em CID-9 derivada e validada na
  fronteira 1997/98 (decisões 21 e 22); % ICSAP pelo método do csapAIH (0.10.0).

### Alterado

- Consumidor puro do canal `sih/cubos/`: o produtor dos cubos migrou para o
  healthbr-data (0.11.0).

### Corrigido

- Download com `?v=<sha256>`: a borda do domínio servia o cubo do build anterior.
- Correção do `COD_IDADE` na era antiga (0.9.0).
