# ANÁLISE-001 — Janela de competências dos cubos por ano de internação

**Status:** decidido e implementado em 2026-09-05 (build-aggregations.R v2.1.0)
**Pergunta:** o cubo do ano Y deve conter as internações iniciadas em Y. Como a AIH é
publicada pela competência de faturamento, que vem depois da alta, quantos meses de
Y+1 é preciso ler para fechar as internações de Y?
**Método:** medido nos dados, não em hipótese. Agregação de todas as AIH-RD do
healthbr-data (espelho Parquet do FTP do DATASUS) por competência × UF de arquivo ×
ano e mês de internação (`DT_INTER`), competências 2016-01 a 2026-06, 27 UFs,
131,8 milhões de internações. Script: `scripts/lag-competencia.mjs` (DuckDB
sobre o R2, ~25 s por ano de competência) e `scripts/lag-competencia-analise.py`.
Anos de internação analisados: 2017 a 2024 (2017–2022 com 42 a 102 meses de
acompanhamento; 2023 com 30; 2024 com 18). Nenhuma AIH com `DT_INTER` inválido,
nenhuma com internação posterior à competência.

## Resultado

**Brasil, cobertura acumulada das internações do ano Y** (share do total observado
até 2026-06 que já apareceu até a competência limite):

| limite | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|---|---|---|---|
| dez/Y | 93,96 | 93,86 | 93,94 | 93,16 | 93,05 | 93,63 | 93,94 | 94,32 |
| +1 (jan) | 97,71 | 97,67 | 97,67 | 97,35 | 97,27 | 97,50 | 97,68 | 97,93 |
| +2 (fev) | 99,04 | 99,04 | 99,05 | 99,04 | 98,99 | 99,08 | 99,19 | 99,25 |
| +3 (mar) | 99,59 | 99,64 | 99,61 | 99,69 | 99,74 | 99,77 | 99,82 | 99,85 |
| **+4 (abr)** | **99,69** | **99,75** | **99,71** | **99,80** | **99,84** | **99,87** | **99,90** | **99,93** |
| +6 (jun) | 99,74 | 99,80 | 99,75 | 99,84 | 99,87 | 99,91 | 99,93 | 99,95 |
| +12 (dez) | 99,81 | 99,84 | 99,81 | 99,88 | 99,91 | 99,94 | 99,95 | 99,98 |

**Internações de dezembro** (o mês mais exposto): dez/Y 50–55%; +1 79–83%; +2 91–93%;
+3 98,4–98,9%; **+4 99,3–99,7%**; +6 99,6–99,9%. Janeiro a julho já estão em 99,7%+
dentro do próprio ano; agosto 99,4%; setembro 98,5%; outubro 91,9%; novembro 81,1%.

**Por UF de arquivo, pior ano entre 2017 e 2022:** 21 das 27 UFs chegam a 99,5% com
3 meses; RN, SE e TO precisam de 4; GO, RJ e SP não chegam a 99,5% em nenhuma janela
razoável (GO 2018: 99,01% em +4 e 99,39% em +24; RJ 2017: 98,78% em +4 e 99,54% em
+24; SP 2019: 99,21% em +4 e 99,59% em +24). Nessas três a cauda não é um pico numa
competência: são algumas centenas de AIH por mês reapresentadas durante anos
(RJ 2017: 375, 347, 325 AIH em jul, ago e set de 2018, e assim por diante).

**Cauda longa nacional:** 0,06% a 0,19% das internações de Y só aparecem depois de
(Y+1)-12; 0,03% a 0,13% depois de (Y+2)-12. Nenhuma janela fecha isso, e é o que
define a regra de fechamento abaixo.

**O outro lado, que o cubo antigo carregava:** 5,4% a 6,8% das AIH de uma
competência-ano pertencem a internações do ano anterior, e 0,2% a 0,7% a anos mais
antigos. Com o cubo por ano de internação isso deixa de contaminar o ano consultado.

## Decisão

**Janela = competências Y-01 a Y-12 mais os 4 primeiros meses de Y+1, filtrando
`DT_INTER` no ano Y** (`MESES_SEGUINTES <- 4L`).

Por quê 4 e não 3 ou 6: o ganho marginal do 4º mês é o último relevante. De +3 para
+4 dezembro sobe 0,9 ponto (98,6% → 99,5%) e o ano 0,1 ponto; de +4 para +6 o ano
ganha 0,04 e dezembro 0,3; de +6 para +12 o ano ganha 0,05. O 4º mês custa 4 partições
a mais por UF (16 em vez de 12) e adia o fechamento do cubo de Y em um mês. Com 4
meses todas as UFs passam de 99,3% no pior ano, exceto a cauda estrutural de GO, RJ
e SP, que +12 também não resolve.

Consequências registradas:

- **O cubo de Y fecha quando a competência (Y+1)-04 é publicada.** Partições
  posteriores não o alteram por construção; só a reedição de uma partição dentro
  da janela justifica rebuild (regra que `sih:cubos-frescor` deve seguir). Como o
  MS publica com 2 a 3 meses de atraso, o cubo de Y fica completo por volta de
  julho de Y+1.
- **Cubo com janela incompleta é marcado** (`window.complete = false` no sidecar;
  "janela INCOMPLETA" no `data_vintage` da proveniência). É o caso do ano corrente
  e do anterior enquanto (Y+1)-04 não sai.
- **`year` no cubo é sempre o ano do arquivo**; `month` vai de 1 a 12 e não há
  mais linhas do ano anterior. `sih_causas_2023` passou de 45.354 AIH de
  competência 2023 (incluindo 5.884 internações de 2022) para as internações de
  2023 de fato, incluindo as faturadas em jan–abr/2024.

## Como reproduzir

```
for y in 2016 2017 … 2026; do node scripts/lag-competencia.mjs $y "" lag_$y.csv; done
python scripts/lag-competencia-analise.py <pasta com os lag_*.csv>
```

Os agregados brutos (118 mil linhas, competência × UF × ano e mês de internação)
não estão no repositório; regeneram-se em cerca de 5 minutos.

## Saída integral da análise (2026-09-05)

```
linhas agregadas: 118177; competência mais recente: 2026-06
total internações 131,820,744; DT_INTER com mês inválido 0; ano inválido 0; internação DEPOIS da competência 0

== Cobertura acumulada das internações do ano Y por competência limite (Brasil, todas as UFs) ==
Y     obs.(até 2026-06)   fup(meses)  dez/Y   +1     +2     +3     +4     +6     +9    +12    +18 | k p/ 99%  99.5%  99.9%  100%
2017    11,663,891      102    93.96  97.71  99.04  99.59  99.69  99.74  99.78  99.81  99.84 |     2      3     33   None
2018    11,983,253       90    93.86  97.67  99.04  99.64  99.75  99.80  99.82  99.84  99.87 |     2      3     25   None
2019    12,324,245       78    93.94  97.67  99.05  99.61  99.71  99.75  99.78  99.81  99.84 |     2      3     30   None
2020    10,636,941       66    93.16  97.35  99.04  99.69  99.80  99.84  99.86  99.88  99.90 |     2      3     18   None
2021    11,673,610       54    93.05  97.27  98.99  99.74  99.84  99.87  99.89  99.91  99.93 |     3      3     11   None
2022    12,471,337       42    93.63  97.50  99.08  99.77  99.87  99.91  99.92  99.94  99.96 |     2      3      6   None
2023    13,337,603       30    93.94  97.68  99.19  99.82  99.90  99.93  99.94  99.95  99.97 |     2      3      4     30
2024    14,138,242       18    94.32  97.93  99.25  99.85  99.93  99.95  99.97  99.98 100.00 |     2      3      4     18

== Internações de DEZEMBRO de Y: cobertura acumulada por competência limite ==
Y      dez/Y     +1      +2      +3      +4      +6     +12 | k p/ 99%  99.5%  99.9%
2017    54.41   83.36   93.00   98.57   99.40   99.67   99.76 |     4      5   None
2018    53.02   82.47   92.32   98.38   99.29   99.64   99.71 |     4      5   None
2019    53.68   82.74   92.81   98.58   99.41   99.68   99.76 |     4      5     37
2020    50.16   80.37   92.25   98.62   99.56   99.84   99.90 |     4      4     13
2021    50.01   79.20   91.20   98.70   99.63   99.83   99.88 |     4      4     16
2022    53.77   80.68   91.62   98.70   99.63   99.87   99.92 |     4      4      9
2023    54.68   81.47   92.22   98.92   99.72   99.87   99.92 |     4      4      9
2024    55.45   83.16   92.37   98.91   99.74   99.91   99.97 |     4      4      6

== Por mês de internação (média 2017–2022): cobertura até dez/Y, +1, +2, +3 ==
mês 01:  99.68   99.69   99.70   99.72
mês 02:  99.79   99.80   99.81   99.82
mês 03:  99.75   99.76   99.77   99.78
mês 04:  99.83   99.84   99.85   99.86
mês 05:  99.81   99.82   99.83   99.84
mês 06:  99.81   99.83   99.84   99.85
mês 07:  99.73   99.79   99.81   99.82
mês 08:  99.37   99.62   99.69   99.71
mês 09:  98.50   99.51   99.75   99.81
mês 10:  91.88   98.45   99.44   99.67
mês 11:  81.12   92.17   98.56   99.56
mês 12:  52.51   81.47   92.20   98.59

== Por UF de arquivo: meses do ano seguinte para 99.5% e 99.9% (pior ano entre 2017–2022) ==
UF   k99  k99.5  k99.9   min cobertura em +3 (2017–2022)
GO     4     34     99    98.84%
RJ     8     23     99    98.63%
SP     3     18     99    99.16%
RN     3      4     24    99.44%
SE     3      4     18    99.47%
TO     3      4      4    99.41%
AL     3      3     31    99.62%
MA     2      3     29    99.72%
PI     2      3     27    99.70%
SC     3      3     19    99.76%
MG     3      3     14    99.74%
BA     3      3     12    99.56%
PB     2      3      8    99.73%
RS     3      3      5    99.68%
PR     3      3      5    99.67%
CE     3      3      5    99.66%
AC     3      3      5    99.77%
RR     3      3      4    99.76%
RO     3      3      4    99.80%
MT     3      3      4    99.83%
MS     3      3      4    99.58%
ES     3      3      4    99.87%
DF     3      3      4    99.75%
PA     2      3      4    99.87%
AP     3      3      3    99.92%
AM     3      3      3    99.93%
PE     2      2     23    99.80%

== Composição da competência-ano Y: de onde vêm as internações (Brasil) ==
Ycmpt   total        ano_inter=Y   Y-1      <Y-1    (shares)
2017    11,675,269    93.87%    5.44%    0.69%
2018    12,000,838    93.72%    5.68%    0.60%
2019    12,356,283    93.69%    5.80%    0.51%
2020    10,688,203    92.71%    6.77%    0.52%
2021    11,629,005    93.41%    6.15%    0.44%
2022    12,520,914    93.26%    6.39%    0.35%
2023    13,355,814    93.81%    5.89%    0.29%
2024    14,171,364    94.10%    5.66%    0.24%
2025    14,645,700    94.31%    5.47%    0.22%

== Cauda longa: share das internações de Y que só aparecem depois de (Y+1)-12 (Brasil) ==
2017: depois de +12: 0.194% (22,601);  depois de +24: 0.130% (15,161)
2018: depois de +12: 0.157% (18,862);  depois de +24: 0.102% (12,278)
2019: depois de +12: 0.193% (23,843);  depois de +24: 0.124% (15,307)
2020: depois de +12: 0.122% (13,015);  depois de +24: 0.076% (8,068)
2021: depois de +12: 0.092% (10,753);  depois de +24: 0.051% (5,961)
2022: depois de +12: 0.062% (7,730);  depois de +24: 0.028% (3,529)

== Detalhe das UFs com cauda (cobertura em +3 / +4 / +6 / +12 / +24) ==
== GO: cobertura em +3 / +4 / +6 / +12 / +24 por ano de internação
  2017:  99.38   99.44   99.47   99.52   99.60
  2018:  98.84   99.01   99.15   99.24   99.39
  2019:  99.25   99.38   99.48   99.54   99.64
  2020:  99.38   99.52   99.58   99.62   99.72
  2021:  99.66   99.76   99.82   99.85   99.90
  2022:  99.65   99.74   99.79   99.83   99.90
  2023:  99.53   99.62   99.72   99.80   99.94
  pior ano 2018: competências tardias com mais AIH: 2019-07 (53), 2019-10 (52), 2019-08 (52)
== RJ: cobertura em +3 / +4 / +6 / +12 / +24 por ano de internação
  2017:  98.63   98.78   98.92   99.20   99.54
  2018:  99.31   99.43   99.53   99.65   99.81
  2019:  98.97   99.13   99.25   99.47   99.73
  2020:  99.26   99.41   99.49   99.63   99.78
  2021:  99.43   99.54   99.61   99.72   99.86
  2022:  99.48   99.61   99.70   99.83   99.93
  2023:  99.76   99.83   99.87   99.92   99.98
  pior ano 2017: competências tardias com mais AIH: 2018-07 (375), 2018-08 (347), 2018-09 (325)
== SP: cobertura em +3 / +4 / +6 / +12 / +24 por ano de internação
  2017:  99.31   99.38   99.47   99.59   99.70
  2018:  99.37   99.44   99.49   99.58   99.72
  2019:  99.16   99.21   99.27   99.40   99.59
  2020:  99.50   99.56   99.62   99.69   99.80
  2021:  99.59   99.65   99.69   99.77   99.87
  2022:  99.66   99.74   99.80   99.86   99.93
  2023:  99.75   99.80   99.83   99.89   99.97
  pior ano 2019: competências tardias com mais AIH: 2020-07 (643), 2020-08 (612), 2020-09 (566)
== RN: cobertura em +3 / +4 / +6 / +12 / +24 por ano de internação
  2017:  99.44   99.67   99.73   99.82   99.90
  2018:  99.67   99.84   99.89   99.96   99.99
  2019:  99.82   99.98   99.99   99.99  100.00
  2020:  99.71   99.86   99.91   99.96   99.97
  2021:  99.70   99.76   99.80   99.85   99.90
  2022:  99.80   99.90   99.93   99.96   99.99
  2023:  99.85   99.92   99.94   99.97   99.99
  pior ano 2017: competências tardias com mais AIH: 2018-07 (30), 2018-08 (28), 2018-09 (23)
== SE: cobertura em +3 / +4 / +6 / +12 / +24 por ano de internação
  2017:  99.53   99.90   99.98  100.00  100.00
  2018:  99.55   99.82   99.86   99.91   99.95
  2019:  99.55   99.82   99.85   99.89   99.93
  2020:  99.47   99.65   99.71   99.83   99.96
  2021:  99.73   99.83   99.88   99.93   99.97
  2022:  99.60   99.82   99.87   99.92   99.99
  2023:  99.66   99.88   99.90   99.94   99.99
  pior ano 2020: competências tardias com mais AIH: 2021-08 (20), 2021-07 (20), 2021-09 (17)
== TO: cobertura em +3 / +4 / +6 / +12 / +24 por ano de internação
  2017:  99.96  100.00  100.00  100.00  100.00
  2018:  99.41   99.93  100.00  100.00  100.00
  2019:  99.70  100.00  100.00  100.00  100.00
  2020:  99.66   99.99  100.00  100.00  100.00
  2021:  99.42   99.99  100.00  100.00  100.00
  2022:  99.73  100.00  100.00  100.00  100.00
  2023:  99.86   99.99  100.00  100.00  100.00
  pior ano 2017: competências tardias com mais AIH: 
== PE: cobertura em +3 / +4 / +6 / +12 / +24 por ano de internação
  2017:  99.80   99.82   99.84   99.87   99.90
  2018:  99.94   99.95   99.96   99.98  100.00
  2019:  99.92   99.95   99.96   99.97   99.99
  2020:  99.86   99.89   99.93   99.95   99.98
  2021:  99.93   99.96   99.97   99.98   99.99
  2022:  99.91   99.93   99.97   99.98   99.99
  2023:  99.87   99.92   99.93   99.96   99.99
  pior ano 2017: competências tardias com mais AIH: 2018-07 (30), 2018-08 (29), 2018-09 (28)
```
