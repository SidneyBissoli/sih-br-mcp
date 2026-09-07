"""Consolida as medições de scripts/estudo-1992-1997.mjs (q_, diag_, lag_)
com as tabelas CID-9 do DATASUS (cid9_cnv.py). Imprime as tabelas em
Markdown que vão para docs/analise-002-sih-1992-1997.md."""
import csv, glob, os, sys
from collections import defaultdict, Counter

H = os.path.dirname(os.path.abspath(__file__))
MED = os.path.join(H, "med")
anos = sorted(int(os.path.basename(f)[2:6]) for f in glob.glob(os.path.join(MED, "q_*.csv")))

def rd(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))

def pct(a, b):
    return f"{100*a/b:.1f}" if b else "-"

def num(x):
    return int(x) if x not in ("", "NA", None) else 0

# ---------- 1. qualidade por ano ----------
print("## Qualidade por ano (todas as UFs, todas as competências)\n")
print("| ano | partições | AIH | DT_INTER vazio % | DT_INTER inválido % | MUNIC_RES vazio % | UF_ZI vazio % | idade ignorada % | DIAG vazio % | DIAG não-6 % | DV errado % | óbitos | VAL_TOT médio (jan / dez) |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
Q = {}
for y in anos:
    rows = rd(os.path.join(MED, f"q_{y}.csv"))
    Q[y] = rows
    n = sum(num(r["n"]) for r in rows)
    s = lambda k: sum(num(r[k]) for r in rows)
    mun = "NA" if rows[0]["munic_res_vazio"] == "NA" else pct(s("munic_res_vazio"), n)
    jan = [r for r in rows if r["mes"] == "1" or r["mes"] == "01"]
    dez = [r for r in rows if r["mes"] == "12"]
    def vm(rs):
        tot = sum(num(r["n"]) for r in rs)
        return sum(float(r["val_tot_medio"] or 0) * num(r["n"]) for r in rs) / tot if tot else 0
    print(f"| {y} | {len(rows)} | {n:,} | {pct(s('dt_inter_vazio'), n)} | {pct(s('dt_inter_invalido'), n)} | {mun} | {pct(s('uf_zi_vazio'), n)} | {pct(s('idade_ignorada'), n)} | {pct(s('diag_vazio'), n)} | {pct(s('diag_nao6'), n)} | {pct(s('diag_dv_errado'), n)} | {s('obitos'):,} | {vm(jan):,.0f} / {vm(dez):,.0f} |".replace(",", "."))

# ---------- 2. DT_INTER vazio por competência ----------
print("\n## DT_INTER vazio: partições (mês × UF) com 100 % vazio, e AIH afetadas, por competência\n")
print("| competência | partições | 100 % vazias | parcialmente vazias (>0) | AIH vazias | AIH total | % |")
print("|---|---|---|---|---|---|---|")
vazias_lista = defaultdict(list)
for y in anos:
    bym = defaultdict(list)
    for r in Q[y]:
        bym[int(r["mes"])].append(r)
    for m in sorted(bym):
        rs = bym[m]
        n = sum(num(r["n"]) for r in rs)
        v = sum(num(r["dt_inter_vazio"]) for r in rs)
        full = [r["uf"] for r in rs if num(r["dt_inter_vazio"]) == num(r["n"]) and num(r["n"]) > 0]
        part = [r["uf"] for r in rs if 0 < num(r["dt_inter_vazio"]) < num(r["n"])]
        if v > 0:
            print(f"| {y}-{m:02d} | {len(rs)} | {len(full)} | {len(part)} | {v:,} | {n:,} | {pct(v, n)} |".replace(",", "."))
        if full:
            vazias_lista[(y, m)] = full
print("\nUFs com DT_INTER 100 % vazio por competência:")
for (y, m), ufs in sorted(vazias_lista.items()):
    print(f"- {y}-{m:02d}: {', '.join(sorted(ufs))}")
# partial ones with share
print("\nPartições com DT_INTER parcialmente vazio (>=1 %):")
for y in anos:
    for r in Q[y]:
        n, v = num(r["n"]), num(r["dt_inter_vazio"])
        if 0 < v < n and v / n >= 0.01:
            print(f"- {y}-{int(r['mes']):02d} {r['uf']}: {pct(v, n)} % ({v:,}/{n:,})".replace(",", "."))

# ---------- 3. MUNIC_RES vazio por ano/mês (1994+) ----------
print("\n## MUNIC_RES vazio ou 000000 por competência (1994+)\n")
for y in anos:
    if Q[y][0]["munic_res_vazio"] == "NA":
        continue
    bym = defaultdict(lambda: [0, 0])
    for r in Q[y]:
        bym[int(r["mes"])][0] += num(r["munic_res_vazio"]); bym[int(r["mes"])][1] += num(r["n"])
    print(f"- {y}: " + " ".join(f"{m:02d}={pct(a, b)}%" for m, (a, b) in sorted(bym.items())))
    # UFs piores no ano
    byuf = defaultdict(lambda: [0, 0])
    for r in Q[y]:
        byuf[r["uf"]][0] += num(r["munic_res_vazio"]); byuf[r["uf"]][1] += num(r["n"])
    worst = sorted(byuf.items(), key=lambda kv: -kv[1][0] / max(kv[1][1], 1))[:6]
    print("  piores UFs: " + ", ".join(f"{u} {pct(a, b)}%" for u, (a, b) in worst))

# ---------- 4. DIAG_PRINC contra as tabelas CID-9 ----------
codes = {r["code6"]: r for r in rd(os.path.join(H, "cid9_codes.csv"))}
xinv = set(open(os.path.join(H, "cid9_xinv.txt")).read().split())
cats = {r["cat4"]: r for r in rd(os.path.join(H, "cid9_cats.csv"))}

def dv(code5):
    s = sum(int(d) * w for d, w in zip(code5, (6, 5, 4, 3, 2)))
    r = (11 - s % 11) % 11
    return 0 if r == 10 else r

CAP9 = [(1, 1, 139), (2, 140, 239), (3, 240, 279), (4, 280, 289), (5, 290, 319), (6, 320, 389),
        (7, 390, 459), (8, 460, 519), (9, 520, 579), (10, 580, 629), (11, 630, 676), (12, 680, 709),
        (13, 710, 739), (14, 740, 759), (15, 760, 779), (16, 780, 799), (17, 800, 999)]
ROM = {1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI", 7: "VII", 8: "VIII", 9: "IX", 10: "X", 11: "XI",
       12: "XII", 13: "XIII", 14: "XIV", 15: "XV", 16: "XVI", 17: "XVII"}
# mapa proposto CID-9 -> CID-10 (capítulo), por categoria
def cap10(prefix, cat):
    if prefix == "2":
        return "XXI"
    if prefix == "1":
        return "XX"
    if prefix != "0":
        return None
    c = int(cat)
    if 1 <= c <= 139: return "III" if c == 135 else "I"
    if 140 <= c <= 239: return "II"
    if 240 <= c <= 279: return "III" if c == 279 else "IV"
    if 280 <= c <= 289: return "III"
    if 290 <= c <= 319: return "V"
    if 320 <= c <= 359: return "VI"
    if 360 <= c <= 379: return "VII"
    if 380 <= c <= 389: return "VIII"
    if 390 <= c <= 459: return "XIII" if c == 446 else "IX"
    if 460 <= c <= 519: return "X"
    if 520 <= c <= 579: return "XI"
    if 580 <= c <= 629: return "XIV"
    if 630 <= c <= 676: return "XV"
    if 680 <= c <= 709: return "XII"
    if 710 <= c <= 739: return "XIII"
    if 740 <= c <= 759: return "XVII"
    if 760 <= c <= 779: return "XVI"
    if 780 <= c <= 799: return "XVIII"
    if 800 <= c <= 999: return "XIX"
    return None

def cap9(prefix, cat):
    if prefix == "2": return "supl. V"
    if prefix == "1": return "XVII (E)"
    if prefix != "0": return None
    c = int(cat)
    for k, a, b in CAP9:
        if a <= c <= b: return ROM[k]
    return None

print("\n## DIAG_PRINC: classificação dos códigos contra as tabelas do DATASUS\n")
print("| ano | AIH | válido (CID9_01..17/SUP) % | 'inválido - fora da CID' nas tabelas % | só em CID9XINV % | 6 dígitos mas fora de toda tabela % | DV errado % | não numérico/vazio % | códigos distintos | distintos fora de tabela |")
print("|---|---|---|---|---|---|---|---|---|---|")
D = {}
cap_by_year = {}
cap10_by_year = {}
top_by_year = {}
fora = Counter()
excecoes = defaultdict(Counter)
for y in anos:
    rows = rd(os.path.join(MED, f"diag_{y}.csv"))
    D[y] = rows
    n = sum(num(r["n"]) for r in rows)
    c = Counter()
    dist = Counter()
    capc = Counter(); cap10c = Counter()
    for r in rows:
        code, k = r["diag"], num(r["n"])
        if not code or not code.isdigit() or len(code) != 6:
            c["naonum"] += k; continue
        if dv(code[:5]) != int(code[5]):
            c["dv"] += k
        if code in codes:
            c["valido" if codes[code]["kind"] == "valido" else "invalido_tab"] += k
            dist["tab"] += 1
        elif code in xinv:
            c["xinv"] += k; dist["xinv"] += 1
        else:
            c["fora"] += k; dist["fora"] += 1; fora[code] += k
        p, cat = code[0], code[1:4]
        capc[cap9(p, cat) or "?"] += k
        c10 = cap10(p, cat)
        cap10c[c10 or "?"] += k
        if p == "0" and int(cat) in (135, 279, 446):
            excecoes[y][cat] += k
    print(f"| {y} | {n:,} | {pct(c['valido'], n)} | {pct(c['invalido_tab'], n)} | {pct(c['xinv'], n)} | {pct(c['fora'], n)} | {pct(c['dv'], n)} | {pct(c['naonum'], n)} | {len(rows):,} | {dist['fora']:,} |".replace(",", "."))
    cap_by_year[y] = (capc, n); cap10_by_year[y] = (cap10c, n)
    top_by_year[y] = sorted(rows, key=lambda r: -num(r["n"]))[:15]

print("\nCódigos de 6 dígitos mais frequentes fora de qualquer tabela (soma 1992–1997):")
for code, k in fora.most_common(15):
    p, cat = code[0], code[1:4]
    lab = cats.get(("0" + cat) if p == "0" else ("1" + cat if p == "1" else "2" + cat), {}).get("label", "")
    print(f"- {code} (prefixo {p}, categoria {cat}{' ' + lab if lab else ''}, DV {'ok' if dv(code[:5]) == int(code[5]) else 'ERRADO'}): {k:,}".replace(",", "."))

print("\n## Distribuição por capítulo CID-9 (% das AIH)\n")
order9 = [ROM[i] for i in range(1, 18)] + ["XVII (E)", "supl. V", "?"]
print("| capítulo CID-9 | " + " | ".join(str(y) for y in anos) + " |")
print("|---|" + "---|" * len(anos))
for cp in order9:
    vals = [pct(cap_by_year[y][0].get(cp, 0), cap_by_year[y][1]) for y in anos]
    if any(v not in ("0.0", "-") for v in vals):
        print(f"| {cp} | " + " | ".join(vals) + " |")

print("\n## Distribuição por capítulo CID-10 equivalente (mapa proposto; % das AIH)\n")
order10 = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX", "XXI", "?"]
print("| capítulo CID-10 | " + " | ".join(str(y) for y in anos) + " |")
print("|---|" + "---|" * len(anos))
for cp in order10:
    vals = [pct(cap10_by_year[y][0].get(cp, 0), cap10_by_year[y][1]) for y in anos]
    if any(v not in ("0.0", "-") for v in vals):
        print(f"| {cp} | " + " | ".join(vals) + " |")
print("\nPeso das categorias que mudam de capítulo entre CID-9 e CID-10 (135, 279, 446), AIH por ano:")
for y in anos:
    print(f"- {y}: " + ", ".join(f"{cat}={k:,}".replace(",", ".") for cat, k in sorted(excecoes[y].items())) + f" (de {cap_by_year[y][1]:,})".replace(",", "."))

print("\n## 15 diagnósticos mais frequentes por ano\n")
for y in anos:
    n = cap_by_year[y][1]
    print(f"**{y}** (n = {n:,}):".replace(",", "."))
    for r in top_by_year[y]:
        code = r["diag"]
        c = codes.get(code)
        lab = f"{c['cid9']} {c['label']}" if c else ("(só em CID9XINV)" if code in xinv else "(fora das tabelas)")
        print(f"- {code} {lab}: {num(r['n']):,} ({pct(num(r['n']), n)} %)".replace(",", "."))

# ---------- 5. lag: competência x ano de internação ----------
print("\n## Atraso de faturamento: de que ano de internação são as AIH de cada competência\n")
L = {}
print("| competência | AIH | DT_INTER vazio/inválido % | mesmo ano % | ano anterior % | 2+ anos antes % | ano posterior (erro) % |")
print("|---|---|---|---|---|---|---|")
for y in anos:
    rows = rd(os.path.join(MED, f"lag_{y}.csv"))
    L[y] = rows
    n = sum(num(r["n"]) for r in rows)
    c = Counter()
    yy = y % 100
    for r in rows:
        k = num(r["n"])
        if r["ano_inter"] == "":
            c["vazio"] += k; continue
        ai = int(r["ano_inter"])
        ai = ai + 1900 if ai >= 50 else ai + 2000
        if ai == y: c["mesmo"] += k
        elif ai == y - 1: c["ant1"] += k
        elif ai < y - 1: c["ant2"] += k
        else: c["post"] += k
    print(f"| {y} | {n:,} | {pct(c['vazio'], n)} | {pct(c['mesmo'], n)} | {pct(c['ant1'], n)} | {pct(c['ant2'], n)} | {pct(c['post'], n)} |".replace(",", "."))

# cobertura acumulada das internações do ano Y por competência limite (como analise-001)
print("\n## Cobertura acumulada das internações do ano Y (só AIH com DT_INTER válido) por competência limite\n")
print("| limite | " + " | ".join(str(y) for y in anos if y + 1 in L) + " |")
print("|---|" + "---|" * len([y for y in anos if y + 1 in L]))
cov = {}
for y in anos:
    if y + 1 not in L: continue
    tot = Counter()  # (comp_year, comp_month) -> n of internações do ano y
    for cy in (y, y + 1):
        for r in L[cy]:
            if r["ano_inter"] == "": continue
            ai = int(r["ano_inter"]); ai = ai + 1900 if ai >= 50 else ai + 2000
            if ai == y:
                tot[(cy, int(r["mes"]))] += num(r["n"])
    total = sum(tot.values())  # observado até (y+1)-12
    cov[y] = {}
    acc = 0
    for cy in (y, y + 1):
        for m in range(1, 13):
            acc += tot.get((cy, m), 0)
            cov[y][(cy, m)] = acc / total if total else 0
lims = [("dez/Y", 0), ("+1", 1), ("+2", 2), ("+3", 3), ("+4", 4), ("+6", 6), ("+12", 12)]
for lab, k in lims:
    vals = []
    for y in anos:
        if y + 1 not in L: continue
        key = (y, 12) if k == 0 else (y + 1, k)
        vals.append(f"{100*cov[y][key]:.2f}")
    print(f"| {lab} | " + " | ".join(vals) + " |")
print("\n(dezembro de Y só)")
for y in anos:
    if y + 1 not in L: continue
    tot = Counter()
    for cy in (y, y + 1):
        for r in L[cy]:
            if r["ano_inter"] == "" : continue
            ai = int(r["ano_inter"]); ai = ai + 1900 if ai >= 50 else ai + 2000
            if ai == y and int(r["mes_inter"]) == 12:
                tot[(cy, int(r["mes"]))] += num(r["n"])
    total = sum(tot.values()); acc = 0; out = []
    for cy in (y, y + 1):
        for m in range(1, 13):
            acc += tot.get((cy, m), 0)
            if (cy, m) in [(y, 12), (y + 1, 1), (y + 1, 2), (y + 1, 3), (y + 1, 4), (y + 1, 6)]:
                out.append(f"{100*acc/total:.1f}" if total else "-")
    print(f"- {y}: dez {out[0]} · +1 {out[1]} · +2 {out[2]} · +3 {out[3]} · +4 {out[4]} · +6 {out[5]}")
