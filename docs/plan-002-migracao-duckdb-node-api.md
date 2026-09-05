# PLAN-002 — Migrar do `duckdb` legado para `@duckdb/node-api`

> Plano de execução, escrito em 04/09/2026 ao fim da sessão que zerou os 72
> alertas do Dependabot. Quem retomar o trabalho começa AQUI: os fatos abaixo
> foram medidos nesta máquina e no CI, não são hipótese. Dimensão estimada:
> **uma sessão** (duas se a fase 3 achar diferença de valor que exija decisão).

## 1. Por que

O binding Node legado `duckdb` (1.4.4, último publicado em 30/01/2026) declara
`node-gyp ^9` em `dependencies`. Isso arrasta make-fetch-happen 10, cacache 16,
tar 6, glob 7, minimatch 3 e brace-expansion 1 para o lock de runtime — era a
origem de 60 dos 72 alertas, inclusive o critical. Em 04/09 isso foi contido
com `overrides.node-gyp: ^12.4.0` no package.json, mas override é remendo:
vive fora do controle do Dependabot e volta a envelhecer quando o node-gyp 12
sair de manutenção. O conserto estrutural é o cliente oficial atual,
`@duckdb/node-api` ("Node Neo"): binários pré-compilados por plataforma como
`optionalDependencies` de `@duckdb/node-bindings`, **zero node-gyp, zero tar**
na árvore (medido: `npm ls --all | grep -c "node-gyp\|tar@"` → 0).

## 2. Fatos medidos (04/09/2026)

| Fato | Valor |
|---|---|
| Versão nova | `@duckdb/node-api@1.5.5-r.4` → engine DuckDB **v1.5.5** (o legado roda 1.4.4: há salto de engine) |
| Plataformas com binário | linux-x64, win32-x64, darwin-x64/arm64, linux-arm64, win32-arm64, musl — cobre a máquina do autor e o CI (ubuntu) |
| Superfície da API antiga em uso | **só 5 chamadas, todas em `src/db/duckdb.ts`**: `new duckdb.Database(":memory:", cb)`, `db.connect()`, `conn.run("SET threads TO 4", cb)`, `connection.all(sql, cb)`, `db.close(cb)` |
| Funil de SQL | `query(sql)` (linha ~165) é o ÚNICO ponto que toca a conexão; as 16 funções de consulta passam por ele. Nenhum outro arquivo importa `duckdb` |
| BigInt | já existe `convertBigIntToNumber` no funil — a API nova devolve `BIGINT`/`HUGEINT` como `bigint` em `getRowObjects()`, exatamente o que a função já trata |
| Sondagem feita | `DuckDBInstance.create(":memory:")` → `connect()` → `run("SET threads TO 4")` → `runAndReadAll(sql)` → `getRowObjects()` rodou sobre `tests/fixtures/sih/sih_causas_2023.parquet` nesta máquina: `{ year: 2022, n: 998n, s: 5884n, v: 8109.83…, d: 50779 }`, tipos `INTEGER, BIGINT, HUGEINT, DOUBLE, DOUBLE` |
| Alternativas de leitura | `getRowObjectsJS()` (tipos JS nativos) e `getRowObjectsJson()` (BigInt vira STRING — não serve sem adaptar) |
| Fechamento | `connection.closeSync()` / `instance.closeSync()` (sem callback) |
| Gate existente | `npm run smoke:stdio` (superfície das 12 tools vs `baselines/surface-stdio.json` + `list_csap_groups`, `get_available_years`, `rank_csap_groups` sobre a fixture); passo do CI em Node 22 e 24 |
| O que o gate NÃO cobre | valores das outras 9 tools; as 2 tools de taxa (`get_hospitalization_rates`, `compare_icsap_trends`) precisam de `pop_*.parquet`, que não está na fixture |
| Curiosidade a checar | a fixture `sih_causas_2023.parquet` tem linhas com `year = 2022`; `getAvailableYears()` deriva o ano do NOME do arquivo. Não é da migração, mas a fase 1 vai expor — anotar, não consertar junto |

Mapeamento API antiga → nova:

| Legado (`duckdb`) | Neo (`@duckdb/node-api`) |
|---|---|
| `new duckdb.Database(":memory:", cb)` | `await DuckDBInstance.create(":memory:")` |
| `db.connect()` | `await instance.connect()` |
| `conn.run(sql, cb)` | `await connection.run(sql)` |
| `conn.all(sql, cb)` → rows | `(await connection.runAndReadAll(sql)).getRowObjects()` |
| `db.close(cb)` | `connection.closeSync(); instance.closeSync()` |
| `InstanceType<typeof duckdb.Database>` / `Connection` | `DuckDBInstance` / `DuckDBConnection` (exportados) |

## 3. Fases — nesta ordem, cada uma com critério de saída

### Fase 1 — Golden das 12 tools ANTES de mexer (é o que torna a fase 2 medível)

1. Completar a fixture com `pop_uf.parquet` (≈500 KB) e `pop_uf_agregado.parquet`
   (≈50 KB) de `data/` → `tests/fixtures/sih/`. O `pop_municipios.parquet` (13 MB)
   fica fora: é fallback (`getPopulationByUf`, item 3 da hierarquia) e as tools
   de taxa por UF resolvem em `pop_uf`. Atualizar o README da fixture.
2. Escrever `scripts/golden-tools.mjs`, no molde do `smoke-stdio.mjs` (sobe o
   dist com `SIH_DATA_DIR`, cliente stdio do SDK): chama **cada uma das 12
   tools** com um conjunto FIXO de argumentos (2–3 casos por tool; ano vem de
   `get_available_years`, não de literal) e grava `baselines/golden-tools.json`
   (`{tool, args, structuredContent|text}` ordenado). `--baseline` compara
   byte a byte e, ao divergir, imprime a PRIMEIRA diferença por tool.
3. Rodar com o binding LEGADO e commitar o golden. Adicionar
   `npm run golden:tools` ao CI logo depois do smoke.
   **Saída:** CI verde com golden gravado pelo código antigo.

### Fase 2 — Trocar o binding (código pequeno, de propósito)

1. `package.json`: `-duckdb`, `+@duckdb/node-api@^1.5.5-r.4`; **remover
   `overrides.node-gyp`** (não sobra quem o traga). Versão 0.1.0 → 0.2.0
   (privado, sem npm — só marca a fronteira).
2. `src/db/duckdb.ts`: reescrever `getDatabase`, `closeDatabase` e `query`
   pelo mapeamento acima. Manter `convertBigIntToNumber` no funil. Nada mais
   muda: SQL, filtros, funções de consulta ficam intactos.
3. `rm -rf node_modules dist && npm ci && npm run build && npm audit` → 0.
   `npm ls --all | grep -c "node-gyp\|tar@"` → 0.
   **Saída:** compila de árvore limpa, audit zero, sem toolchain nativo no lock.

### Fase 3 — Provar que nada mudou para o cliente

1. `npm run smoke:stdio` (superfície idêntica) e `npm run golden:tools`
   (valores idênticos aos gravados pelo legado).
2. Se o golden divergir, classificar ANTES de aceitar: (a) representação
   (`bigint` vs `number`, `-0`, precisão de DOUBLE em `avg`) → ajustar no funil
   e manter o golden; (b) valor de fato diferente → é o salto de engine
   1.4.4 → 1.5.5 falando: investigar a query, decidir com o usuário, e SÓ então
   regravar o golden com justificativa no commit.
3. Push → CI verde em Node 22 e 24 (o binário linux-x64 é baixado pelo npm;
   se o `optionalDependencies` falhar no runner, o erro aparece aqui e não na
   máquina do autor).
   **Saída:** CI verde, golden intacto ou regravado com motivo escrito.

### Fase 4 — Fechar o rastro

1. `CONTEXT.md`: seção "Decisões Arquiteturais" ganha a linha do cliente
   DuckDB (Neo, motivo, data). `.github/dependabot.yml`: apagar o parágrafo
   sobre `overrides.node-gyp`. `ci.yml`: ajustar o cabeçalho que cita o duckdb
   pinando node-gyp (vira passado).
2. portfolio-monitor: item `sih:duckdb-node-api` em TAREFAS.md marcado `[x]`
   com o balanço; `refresh_pendencias.R` (o Dependabot do sih deve seguir 0) e
   `scripts/publicar-painel.ps1`.
3. Memória: RETOMADA do `portfolio-monitor.md` e a nota
   `duckdb-node-gyp-e-fixture-no-ci.md` (override deixou de existir).

## 4. Riscos conhecidos e o que fazer com cada um

- **Salto de engine 1.4.4 → 1.5.5.** As queries são agregações simples sobre
  parquet (SUM/COUNT/AVG, GROUP BY, filtros). Diferença de valor é improvável;
  diferença de TIPO de retorno é provável (HUGEINT em `sum` de INTEGER). O
  golden da fase 1 é a rede.
- **`SET threads TO 4`** existe na 1.5.x; se falhar, o legado já engolia o erro
  com aviso — manter o mesmo comportamento.
- **Binário não baixado no CI** (`optionalDependencies` ignorado por
  `--omit=optional` ou cache). O `npm ci` do CI não usa `--omit`; se aparecer
  "Could not find native bindings", é isso.
- **`data/test/sih_causas_2024.parquet` local** tem esquema antigo (age_group,
  sem month) — lixo gitignored; não é lido por smoke nem golden (`SIH_DATA_DIR`
  aponta para a fixture). Ignorar.

## 5. Fora de escopo, de propósito

Migrar para `@duckdb/node-api` **não** é montar a suíte vitest
(`campanha:contrato-vitest` continua aberto), não muda ferramenta nenhuma, não
publica no npm (`private: true`) e não abre o repositório. Se a fase 1 revelar
defeito nas tools (a curiosidade do `year = 2022`, por exemplo), anotar no
TAREFAS.md e seguir — corrigir junto contaminaria o golden.
