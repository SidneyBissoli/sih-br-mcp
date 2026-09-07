"""Consolida a validação empírica da lista ICSAP em CID-9 (docs/analise-003).

Lê as saídas de scripts/estudo-icsap-cid9-fronteira.mjs (A_dez1997.csv,
B_competencias.csv, C_serie.csv — os que existirem) e calcula, por grupo
ICSAP, a participação nas AIH codificadas em CID-9 (lista derivada) e em
CID-10 (lista oficial) e a razão share9/share10. Grava validation.json
(consumido por estudo-icsap-cid9-derivar.py) e imprime tabelas Markdown.

Uso: python scripts/estudo-icsap-cid9-analise.py <pasta_fronteira> [<validation.json>]

Recortes: A = mesmas internações (DT_INTER dez/1997) codificadas nos dois
lados; B = competências 1997-10..12 vs 1998-01..03; C = anos inteiros
1997 vs 1998; C' = 1997 vs 1998-03..12 (sem os dois meses de transição,
em que a participação ICSAP total cai para 19–20 % e volta em março).
A classe de comparabilidade sai de C' (a priori: alta 0,80–1,25; média
0,67–1,50; baixa fora disso) — A e B confirmam ou não.
"""
import csv, json, os, sys
from collections import defaultdict

pasta = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(pasta, "validation.json")
GRUPOS = [f"g{i:02d}" for i in range(1, 20)]


def ler(nome):
    p = os.path.join(pasta, nome)
    if not os.path.exists(p):
        return None
    return list(csv.DictReader(open(p, encoding="utf-8")))


def shares(rows, filtro=lambda r: True, nucleo=True):
    """{lado: (total, {grp: n})}; nucleo=True ignora códigos marcados como variante."""
    tot = defaultdict(int)
    byg = defaultdict(lambda: defaultdict(int))
    for r in rows:
        if not filtro(r):
            continue
        n = int(r["n"])
        tot[r["lado"]] += n
        if r["grp"] != "-" and (not nucleo or r["variant"] == ""):
            byg[r["lado"]][r["grp"]] += n
    return tot, byg


def razoes(tot, byg):
    res = {}
    for g in GRUPOS:
        s9 = byg["cid9"][g] / tot["cid9"] if tot["cid9"] else 0
        s10 = byg["cid10"][g] / tot["cid10"] if tot["cid10"] else 0
        res[g] = {"n9": byg["cid9"][g], "share9": s9, "n10": byg["cid10"][g], "share10": s10,
                  "ratio": (s9 / s10) if s10 else None}
    i9 = sum(byg["cid9"].values()); i10 = sum(byg["cid10"].values())
    res["icsap"] = {"n9": i9, "share9": i9 / tot["cid9"], "n10": i10, "share10": i10 / tot["cid10"],
                    "ratio": (i9 / tot["cid9"]) / (i10 / tot["cid10"])}
    res["_total"] = {"cid9": tot["cid9"], "cid10": tot["cid10"]}
    return res


def classe(ratio):
    if ratio is None:
        return "sem-dados"
    if 0.80 <= ratio <= 1.25:
        return "alta"
    if 0.67 <= ratio <= 1.50:
        return "media"
    return "baixa"


def tabela(titulo, res):
    print(f"\n### {titulo}\n")
    print(f"AIH: CID-9 {res['_total']['cid9']:,} · CID-10 {res['_total']['cid10']:,}\n")
    print("| grupo | n CID-9 | % | n CID-10 | % | razão |")
    print("|---|---:|---:|---:|---:|---:|")
    for g in GRUPOS + ["icsap"]:
        r = res[g]
        rz = f"{r['ratio']:.2f}" if r["ratio"] is not None else "—"
        print(f"| {g} | {r['n9']:,} | {100*r['share9']:.3f} | {r['n10']:,} | {100*r['share10']:.3f} | {rz} |")


val = {"recortes": {}, "variantes": {}, "comparabilidade": {}}

A = ler("A_dez1997.csv")
if A:
    tot, byg = shares(A)
    val["recortes"]["A"] = razoes(tot, byg)
    tabela("A — internações de dez/1997: faturadas em 1997-12 (CID-9) vs em 1998-01..04 (CID-10)", val["recortes"]["A"])
    # por UF: razão da participação ICSAP total
    ufs = sorted({r["uf"] for r in A})
    por_uf = {}
    for uf in ufs:
        t, b = shares(A, lambda r, uf=uf: r["uf"] == uf)
        if t["cid9"] and t["cid10"]:
            i9 = sum(b["cid9"].values()) / t["cid9"]; i10 = sum(b["cid10"].values()) / t["cid10"]
            por_uf[uf] = {"n9": t["cid9"], "n10": t["cid10"], "share9": i9, "share10": i10, "ratio": i9 / i10 if i10 else None}
    val["recortes"]["A_uf"] = por_uf
    print("\n| UF | AIH CID-9 | ICSAP % | AIH CID-10 | ICSAP % | razão |\n|---|---:|---:|---:|---:|---:|")
    for uf, r in por_uf.items():
        print(f"| {uf} | {r['n9']:,} | {100*r['share9']:.1f} | {r['n10']:,} | {100*r['share10']:.1f} | {r['ratio']:.2f} |")

B = ler("B_competencias.csv")
if B:
    tot, byg = shares(B)
    val["recortes"]["B"] = razoes(tot, byg)
    tabela("B — competências 1997-10..12 (CID-9) vs 1998-01..03 (CID-10)", val["recortes"]["B"])

C = ler("C_serie.csv")
if C:
    tot, byg = shares(C)
    val["recortes"]["C"] = razoes(tot, byg)
    tabela("C — ano inteiro: 1997 (CID-9) vs 1998 (CID-10)", val["recortes"]["C"])
    tot2, byg2 = shares(C, lambda r: r["lado"] == "cid9" or int(r["mes"]) >= 3)
    val["recortes"]["C2"] = razoes(tot2, byg2)
    tabela("C' — 1997 (CID-9) vs 1998-03..12 (CID-10), sem os dois meses de transição", val["recortes"]["C2"])
    # variantes: contribuição de cada código marcado e razão do grupo com/sem
    totv, bygv = shares(C, lambda r: r["lado"] == "cid9" or int(r["mes"]) >= 3, nucleo=False)
    var = defaultdict(int)
    for r in C:
        if r["lado"] == "cid9" and r["variant"]:
            var[(r["grp"], r["variant"])] += int(r["n"])
    for (g, v), n in sorted(var.items()):
        base = byg2["cid9"][g]; s10 = byg2["cid10"][g] / tot2["cid10"]
        val["variantes"][f"{g}:{v}"] = {"n9": n, "ratio_sem": (base / tot2["cid9"]) / s10, "ratio_com": ((base + n) / tot2["cid9"]) / s10}
    print("\n| grupo:variante | n CID-9 (1997) | razão sem | razão com |\n|---|---:|---:|---:|")
    for k, r in val["variantes"].items():
        print(f"| {k} | {r['n9']:,} | {r['ratio_sem']:.2f} | {r['ratio_com']:.2f} |")
    # série mensal da participação ICSAP total
    tm = defaultdict(int); im = defaultdict(int)
    for r in C:
        k = f"{r['ano']}-{r['mes']}"; n = int(r["n"]); tm[k] += n
        if r["grp"] != "-" and r["variant"] == "":
            im[k] += n
    val["serie_mensal"] = {k: {"n": tm[k], "icsap_share": im[k] / tm[k]} for k in sorted(tm)}
    print("\n| competência | AIH | ICSAP % |\n|---|---:|---:|")
    for k in sorted(tm):
        print(f"| {k} | {tm[k]:,} | {100*im[k]/tm[k]:.2f} |")
    for g in GRUPOS:
        val["comparabilidade"][g] = classe(val["recortes"]["C2"][g]["ratio"])

json.dump(val, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"\n-> {out}")
