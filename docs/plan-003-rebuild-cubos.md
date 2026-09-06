# PLAN-003 — Rebuild automático dos cubos atrás do espelho

Item (b) de `sih:cubos-frescor` no portfolio-monitor. Executado em
2026-09-06, numa sessão, na ordem abaixo. Modelo: PLAN-002 (fatos medidos →
fases com critério de saída → riscos → fora de escopo).

## 1. Por que

O Ministério da Saúde reedita arquivos RD de competências passadas. O
sync-check semanal do healthbr-data detecta (por tamanho do `.dbc`) e
republica a partição; o manifesto do espelho passa a trazer outro
`source_hash_md5` para ela. Os cubos deste servidor foram somados a partir do
arquivo antigo: estão ATRÁS, e desde 0.5.0 o servidor sabe dizer isso
(`src/freshness.ts`, item (a)) — mas só avisa. Sem (b), o aviso vira rotina:
alguém tem de abrir o R, rodar `build_data()`, copiar o sidecar, commitar. A
classe de defeito é a mesma do CI ausente até 31/08: o que ninguém executa,
ninguém vê envelhecer.

## 2. Fatos medidos (05–06/09/2026)

- **Só existe um cubo em produção: 2023, só RR** (16 partições, 48.480
  internações). Nunca houve cubo nacional.
- **Custo de um ano nacional NUNCA tinha sido medido.** Medido em 06/09 com
  2023 e cinco UFs de arquivo (RR, AC, AP, RO, TO; 80 partições, 517.355 AIH
  lidas, 392.972 internações de 2023):
  - build 2.2.0 (antes): **562 s**, 619 MB de pico; a leitura do R2 pelo
    healthbR levou 35 s — os outros ~525 s eram `map_int(cid,
    extrair_capitulo_cid)` e `Vectorize(classificar_csap)`, uma chamada de R
    (com `case_when` dentro) por internação. Extrapolado ao ano nacional de
    2023 (432 partições, 17,97 milhões de AIH na janela): ~5,4 h. Inviável
    num runner.
  - build 2.2.1 (depois, `por_valor_unico()`: classifica os CIDs distintos e
    espalha por `match`): **45,7 s**, 535 MB de pico (31 s de R2). Mesmos
    totais; conteúdo das três tabelas idêntico linha a linha e na mesma
    ordem. Extrapolado ao ano nacional: ~25–30 min de runner, dominado pela
    leitura do R2. Os bytes dos Parquet NÃO eram iguais: o arrow grava
    atributos de R nos metadados, e `uf_map[codigo]` devolvia vetor nomeado
    (um nome por linha) — 5,5 MB de metadado `r` no cubo de causas de 5 UFs
    (2.2.0), 1,5 MB depois de tirar o `Vectorize`, 0 depois de `unname()`.
    2023/RR: causas 598 KB → 242 KB, séries 13 KB → 3 KB, ICSAP 70 KB →
    45 KB, conteúdo idêntico, delta zero pelo `cube-delta.mjs`.
- **O golden e o smoke do CI rodam sobre a FIXTURE** (`tests/fixtures/sih`,
  `SIH_FRESHNESS_CHECK=off`), não sobre `data/`: um cubo real novo não move
  nenhum gate existente. Gate para cubo real tinha de nascer aqui.
- **`npm run freshness` já sai 0/3/2** (current/stale/unknown) e lê a URL do
  manifesto do sidecar (`distributor.manifest_url`); faltava só gravar o
  estado em JSON para um job decidir por ele.
- **healthbR do CRAN (0.3.1) não tem `sih_status()`**; está no `main` do
  GitHub desde 54aea58. As credenciais de LEITURA do R2 são públicas e vivem
  no pacote: o runner instala `SidneyBissoli/healthbR` e lê o espelho **sem
  segredo nenhum**.
- **healthbr-data**: o sync-check roda segunda 03:00 UTC (atrasa até ~6 h),
  por `workflow_dispatch` e por `push` em `data/controle_versao_*.csv` — o
  commit que a VPS faz no FIM da manutenção (~20 h). Depois da manutenção não
  há lista do que mudou: o sinal fiel é o manifesto. `github.token` não
  dispara workflow em outro repositório. Não existia `manifest-summary.json`
  (404); o manifesto tem 10,4 MB sem compressão e o que o frescor lê cabe em
  2,7 MB.
- **`build_data()` engole erro de ano** (retorna FALSE e segue) e tem um
  `readline()` para `> 20 anos × 27 UFs` que travaria um runner.

## 3. Fases — nesta ordem, cada uma com critério de saída

### Fase 0 — Medir antes de decidir o escopo (feito, ver §2)

Critério: saber se um ano nacional cabe no runner. Resposta: com o build
2.2.0, não (5,4 h); o gargalo não era o R2, era classificação linha a linha.
Corrigido em 2.2.1 sem mudar um número (conteúdo idêntico para 2023/RR e
para as cinco UFs; só os metadados do Parquet encolheram). O escopo dos cubos continua sendo decisão do
usuário (item 6 do desenho): este plano NÃO cria cubo nacional, só deixa o
caminho medido e o custo conhecido.

### Fase 1 — Ferramentas de linha de comando (sih)

- `scripts/rebuild-cubes.R`: `--years`, `--ufs` opcional (padrão: as
  `ufs_arquivo` do sidecar do ano — o escopo de cada cubo é explícito e
  sobrevive ao rebuild), `--out` para medir sem tocar `data/`; um
  `build_data()` por ano; **exit 1 se qualquer ano falhar**.
- `build-aggregations.R` 2.2.1: `readline()` só em sessão interativa;
  `por_valor_unico()`.
- `scripts/cube-delta.mjs` (`npm run cube:delta`): sidecar novo × anterior.
  Reprova partição perdida sem `removed` no estado do frescor, queda > 1% de
  `records_in_cube` sem partição retirada, `window.complete` regredido e
  mudança de escopo sem `--allow-scope-change`. Relata reeditadas,
  regeneradas, novas, retiradas e as contagens antes/depois em Markdown e
  JSON. `npm run cube:delta:selftest` (offline, no CI) prova os seis casos
  sobre o sidecar da fixture.
- `scripts/freshness-check.mjs --out <json>`.

Critério: `cube:delta:selftest` verde; sidecar da fixture × `data/` dá
"idêntico"; `rebuild-cubes.R --years 2023` regenera 2023/RR com delta zero.

### Fase 2 — `.github/workflows/rebuild-cubes.yml` (sih)

Gatilho em duas camadas, a barata primeiro: `schedule` terça 06:00 UTC (o
espelho já assentou depois do sync-check de segunda + ~20 h de manutenção),
`repository_dispatch` `healthbr-sih-updated` (latência, não decisão) e
`workflow_dispatch` (`years`, `ufs`, `force`). Job `decide` (Node): `npm run
freshness -- --out` e escolhe os anos — pedidos à mão > `force` (todos os
sidecars) > `stale` (os `behind`) > `current` (nenhum; verde em ~1 min) >
`unknown` (**vermelho**: sem veredito não há rebuild silencioso). Job
`build` (só se há anos): R via `r-lib/actions/setup-r` com PPPM +
`setup-r-dependencies` com a lista explícita de pacotes (não há DESCRIPTION)
e `SidneyBissoli/healthbR` do GitHub; guarda os sidecars anteriores; roda o
wrapper; **gate 2** delta por ano (ano sem sidecar anterior = cubo novo, só
relatado); **gate 3** smoke stdio com `SIH_DATA_DIR=data` (o golden fica de
fora de propósito: é da fixture e não se regrava baseline num workflow);
commita os sidecars no master (`github-actions[bot]`; o CI da fixture segue
verde); release `cubes-AAAAMMDD-HHMM` com cubos + sidecars + delta, via
`GITHUB_TOKEN`. `concurrency: rebuild-cubes` sem cancelar.

Critério: `workflow_dispatch` com `force=true` reconstrói 2023/RR com delta
zero, commita sidecar (só `built_at`/`builder`/`git_commit` mudam) e publica
a release.

### Fase 3 — healthbr-data (PR #2, branch `sih-rebuild-dispatch`)

`scripts/sync/manifest_summary.py` grava `sih/rd/manifest-summary.json` a
cada rodada (mesmo cabeçalho; por partição só MD5, tamanho, timestamp e
SHA-256; contrato = `last_updated` idêntico ao manifesto) e, no evento
`push`, `gh api .../dispatches` com `SIH_DISPATCH_PAT` (pulado sem o secret).
`docs/contract-consumers-pt.md` §4.1.

Critério: PR mesclado pelo usuário (o classificador bloqueia `gh pr merge`),
secret criado na web (`gh secret set` sem `--body` grava vazio), `gh workflow
run sync-check.yml` faz nascer um run de `rebuild-cubes` no sih.

### Fase 4 — `freshness.ts` lê o resumo (sih)

Sonda continua no manifesto (512 bytes, `last_updated`); quando mudou, baixa
`manifest-summary.json` (convenção de caminho, `summaryUrl()`) e o usa se o
`last_updated` bate; senão, o manifesto inteiro. A forma do estado não mudou
(o golden grava o bloco `freshness` desligado). `freshness:selftest` já
exercita a forma do resumo (o trecho da fixture é um subconjunto dela).

Critério: com o sidecar datado de um manifesto antigo, `npm run freshness`
cai em `full` e diz no stderr por que (resumo 404 hoje; resumo em dia depois
do PR #2).

### Fase 5 — Rastro

Este arquivo; CONTEXT.md decisão 14; `tests/fixtures/sih/README.md`; 0.6.0;
TAREFAS.md L104 com "(b) FEITO"; memória.

## 4. Riscos conhecidos e o que fazer com cada um

- **O resumo nasce depois do manifesto.** Entre a republicação (VPS) e a
  rodada do sync-check (push imediato), o resumo está atrás. Por isso a
  sonda é no manifesto e o resumo só vale com `last_updated` igual.
- **`repository_dispatch` só dispara no branch padrão**: o workflow precisa
  estar no master antes do primeiro teste de dispatch.
- **Reedição de 2023/RR no espelho** reprova `freshness:selftest` por
  design: regenerar fixture + excerpt à mão e classificar o diff do golden.
  O workflow não toca na fixture.
- **Cubo novo sem sidecar**: o frescor nunca o vê "atrás" — só nasce por
  dispatch com `years` + `ufs`. Escopo é explícito, sempre.
- **Falha de rede no `decide`**: vermelho, não silêncio. Rodar de novo.
- **Ano nacional**: medido, não decidido. Se o usuário pedir, o caminho é
  dispatch `years=<ano> ufs=all` e olhar o tempo do run.

## 5. Fora de escopo, de propósito

- Cache local de cubos e canal público (`sih/cubos/` no R2) — item (c).
- Regravar golden/baseline no workflow.
- Cubo nacional.
