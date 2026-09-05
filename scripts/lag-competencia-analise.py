# Análise da janela de competências: lê os CSV gerados por scripts/lag-competencia.mjs
# (um por ano de competência) e imprime as tabelas de docs/analise-001-janela-competencia.md.
# Uso: python scripts/lag-competencia-analise.py <pasta com lag_AAAA.csv>
import csv, glob, os
from collections import defaultdict

import sys
S = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
rows = []
for f in sorted(glob.glob(os.path.join(S, "lag_20??.csv"))):
    if "_RR" in f:
        continue
    with open(f, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            rows.append(r)

def cidx(a, m):  # índice de competência em meses
    return int(a) * 12 + int(m) - 1

MAX_C = max(cidx(r["ano_cmpt"], r["mes_cmpt"]) for r in rows)
max_a, max_m = divmod(MAX_C, 12)
print(f"linhas agregadas: {len(rows)}; competência mais recente: {max_a}-{max_m+1:02d}")

# anomalias
tot = sum(int(r["n"]) for r in rows)
bad_month = sum(int(r["n"]) for r in rows if not (r["mes_inter"].isdigit() and 1 <= int(r["mes_inter"]) <= 12))
bad_year = sum(int(r["n"]) for r in rows if not (r["ano_inter"].isdigit() and 1990 <= int(r["ano_inter"]) <= 2026))
future = sum(int(r["n"]) for r in rows if r["ano_inter"].isdigit() and r["mes_inter"].isdigit() and 1 <= int(r["mes_inter"]) <= 12
             and cidx(r["ano_inter"], r["mes_inter"]) > cidx(r["ano_cmpt"], r["mes_cmpt"]))
print(f"total internações {tot:,}; DT_INTER com mês inválido {bad_month:,}; ano inválido {bad_year:,}; internação DEPOIS da competência {future:,}")

# por ano de internação: n por (competência, uf, mes_inter)
by_year = defaultdict(lambda: defaultdict(int))        # Y -> cidx -> n
by_year_uf = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))  # Y -> uf -> cidx -> n
by_year_mi = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))  # Y -> mes_inter -> cidx -> n
for r in rows:
    if not (r["ano_inter"].isdigit() and r["mes_inter"].isdigit() and 1 <= int(r["mes_inter"]) <= 12):
        continue
    Y = int(r["ano_inter"]); c = cidx(r["ano_cmpt"], r["mes_cmpt"]); n = int(r["n"])
    by_year[Y][c] += n
    by_year_uf[Y][r["uf"]][c] += n
    by_year_mi[Y][int(r["mes_inter"])][c] += n

def cum_share(d, Y, k):
    """share captured by competência <= (Y+1)-k  (k=0 -> até dez/Y)"""
    lim = cidx(Y, 12) + k
    tot = sum(d.values())
    got = sum(n for c, n in d.items() if c <= lim)
    return got / tot if tot else float("nan")

def months_needed(d, Y, target):
    for k in range(0, 40):
        if cum_share(d, Y, k) >= target:
            return k
    return None

YEARS = [y for y in range(2017, 2025)]
print("\n== Cobertura acumulada das internações do ano Y por competência limite (Brasil, todas as UFs) ==")
print("Y     obs.(até %s-%02d)   fup(meses)  dez/Y   +1     +2     +3     +4     +6     +9    +12    +18 | k p/ 99%%  99.5%%  99.9%%  100%%" % (max_a, max_m + 1))
for Y in YEARS:
    d = by_year[Y]; tot = sum(d.values()); fup = MAX_C - cidx(Y, 12)
    shares = [cum_share(d, Y, k) for k in (0, 1, 2, 3, 4, 6, 9, 12, 18)]
    ks = [months_needed(d, Y, t) for t in (0.99, 0.995, 0.999, 1.0)]
    print(f"{Y}  {tot:>12,}   {fup:>6}   " + " ".join(f"{s*100:6.2f}" for s in shares) + " | " + "  ".join(f"{k!s:>5}" for k in ks))

print("\n== Internações de DEZEMBRO de Y: cobertura acumulada por competência limite ==")
print("Y      dez/Y     +1      +2      +3      +4      +6     +12 | k p/ 99%  99.5%  99.9%")
for Y in YEARS:
    d = by_year_mi[Y][12]
    shares = [cum_share(d, Y, k) for k in (0, 1, 2, 3, 4, 6, 12)]
    ks = [months_needed(d, Y, t) for t in (0.99, 0.995, 0.999)]
    print(f"{Y}  " + " ".join(f"{s*100:7.2f}" for s in shares) + " | " + "  ".join(f"{k!s:>5}" for k in ks))

print("\n== Por mês de internação (média 2017–2022): cobertura até dez/Y, +1, +2, +3 ==")
for m in range(1, 13):
    vals = []
    for k in (0, 1, 2, 3):
        vals.append(sum(cum_share(by_year_mi[Y][m], Y, k) for Y in range(2017, 2023)) / 6)
    print(f"mês {m:02d}: " + "  ".join(f"{v*100:6.2f}" for v in vals))

print("\n== Por UF de arquivo: meses do ano seguinte para 99.5% e 99.9% (pior ano entre 2017–2022) ==")
ufs = sorted({u for Y in range(2017, 2023) for u in by_year_uf[Y]})
worst = []
for u in ufs:
    k995 = max(months_needed(by_year_uf[Y][u], Y, 0.995) or 99 for Y in range(2017, 2023))
    k999 = max(months_needed(by_year_uf[Y][u], Y, 0.999) or 99 for Y in range(2017, 2023))
    k99 = max(months_needed(by_year_uf[Y][u], Y, 0.99) or 99 for Y in range(2017, 2023))
    s3 = min(cum_share(by_year_uf[Y][u], Y, 3) for Y in range(2017, 2023))
    worst.append((k995, k999, k99, u, s3))
worst.sort(reverse=True)
print("UF   k99  k99.5  k99.9   min cobertura em +3 (2017–2022)")
for k995, k999, k99, u, s3 in worst:
    print(f"{u}   {k99:>3}  {k995:>5}  {k999:>5}   {s3*100:6.2f}%")

print("\n== Composição da competência-ano Y: de onde vêm as internações (Brasil) ==")
print("Ycmpt   total        ano_inter=Y   Y-1      <Y-1    (shares)")
comp = defaultdict(lambda: defaultdict(int))
for r in rows:
    if not r["ano_inter"].isdigit():
        continue
    comp[int(r["ano_cmpt"])][int(r["ano_inter"])] += int(r["n"])
for Yc in range(2017, 2026):
    d = comp[Yc]; tot = sum(d.values())
    same = d.get(Yc, 0); prev = d.get(Yc - 1, 0); older = tot - same - prev
    print(f"{Yc}  {tot:>12,}   {same/tot*100:6.2f}%   {prev/tot*100:5.2f}%   {older/tot*100:5.2f}%")

print("\n== Cauda longa: share das internações de Y que só aparecem depois de (Y+1)-12 (Brasil) ==")
for Y in range(2017, 2023):
    d = by_year[Y]; tot = sum(d.values())
    late = sum(n for c, n in d.items() if c > cidx(Y + 1, 12))
    late24 = sum(n for c, n in d.items() if c > cidx(Y + 2, 12))
    print(f"{Y}: depois de +12: {late/tot*100:.3f}% ({late:,});  depois de +24: {late24/tot*100:.3f}% ({late24:,})")
