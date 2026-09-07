"""Deriva a Lista Brasileira de ICSAP (Portaria SAS/MS 221/2008, CID-10) para a
CID-9 usada pelo SIH/SUS em 1992–1997 e grava src/data/csap-groups-cid9.json.

A correspondência é MANUAL e rastreável: para cada diagnóstico da lista
CID-10 (src/data/csap-groups.json, 19 grupos, 197 códigos) declara-se a(s)
rubrica(s) CID-9 (OMS) com fonte e método. O script só expande as rubricas
para os códigos de 6 dígitos que existem nas tabelas CID9_*.CNV do DATASUS,
confere unicidade, pesa com as AIH de 1997 e cruza com as GEMs para apontar
divergências — não inventa nada (docs/analise-003-icsap-cid9.md).

Uso:
  python scripts/estudo-icsap-cid9-derivar.py --tab <pasta com CID9_*.CNV>
      [--csap src/data/csap-groups.json] [--out src/data/csap-groups-cid9.json]
      [--diag1997 <diag_1997.csv>] [--gems <pasta com 2018_I10gem.txt>]
      [--validation <validation.json>] [--lists <pasta>]
  --tab: conteúdo de TAB_SIH_199201-199712.zip (ftp.datasus.gov.br/dissemin/
         publicos/SIHSUS/199201_200712/Auxiliar/), CNV em Latin-1.
  --diag1997: saída de scripts/estudo-1992-1997.mjs 1997 (DIAG_PRINC × n).
  --gems: CMS General Equivalence Mappings FY2018 (domínio público).
  --validation: saída de scripts/estudo-icsap-cid9-analise.py.
  --lists: grava icsap_cid9.csv / icsap_cid10.csv para o script da fronteira.
"""
import argparse, csv, json, os, re, sys
from collections import Counter, defaultdict
from datetime import date

ap = argparse.ArgumentParser()
ap.add_argument("--tab", required=True)
ap.add_argument("--csap", default="src/data/csap-groups.json")
ap.add_argument("--out", default="src/data/csap-groups-cid9.json")
ap.add_argument("--diag1997")
ap.add_argument("--gems")
ap.add_argument("--validation")
ap.add_argument("--lists")
args = ap.parse_args()

# ---------------------------------------------------------------- tabelas
def parse_cnv(path):
    with open(path, encoding="latin-1") as fh:
        lines = fh.read().splitlines()
    for ln in lines[1:]:
        m = re.match(r"^\s*(\d+)\s+(.*?)\s+((?:[0-9]{4,6}(?:-[0-9]{4,6})?,?\s*)+|,)$", ln)
        if m:
            yield int(m.group(1)), m.group(2).strip(), (m.group(3) or "").strip()

rows = []   # dict(code6, rubric, label, chapter, valid)
files = [(f"CID9_{i:02d}.CNV", str(i)) for i in range(1, 18)] + [("CID9_SUP.CNV", "V")]
for fname, chap in files:
    for _, label, codes in parse_cnv(os.path.join(args.tab, fname)):
        for c in [x.strip() for x in codes.split(",") if x.strip()]:
            if not re.fullmatch(r"\d{6}", c):
                continue
            m = re.match(r"^(V?\d{2,3}\.\d)\s+(.*)$", label)
            rubric = m.group(1) if m else label.split()[0]
            lab = m.group(2) if m else re.sub(r"^\S+\s*-\s*", "", label)
            valid = not ("inv" in lab.lower() and "fora da cid" in lab.lower())
            rows.append({"code6": c, "rubric": rubric, "label": lab, "chapter": chap, "valid": valid})
if len(rows) != 8240:
    print(f"AVISO: {len(rows)} códigos nas tabelas (esperados 8.240)", file=sys.stderr)
by_rubric = defaultdict(list)
by_cat = defaultdict(list)
for r in rows:
    by_rubric[r["rubric"]].append(r)
    by_cat[r["rubric"].split(".")[0]].append(r)

def expand(spec):
    """'035' → todos os códigos válidos da categoria; '070.2' → o da subcategoria."""
    hits = by_rubric.get(spec, []) if "." in spec else by_cat.get(spec, [])
    return [h for h in hits if h["valid"]]

n97 = {}
if args.diag1997:
    n97 = {r["diag"]: int(r["n"]) for r in csv.DictReader(open(args.diag1997, encoding="utf-8"))}

csap = json.load(open(args.csap, encoding="utf-8"))
norm = lambda s: re.sub(r"\s+", " ", s.strip())

# ---------------------------------------------------------------- fontes
SOURCES = {
    "who-rubric": {
        "title": "Correspondência de rubrica entre a CID-9 (OMS, 1975) e a CID-10 do mesmo nome, conferida nos rótulos das tabelas CID9_*.CNV do DATASUS",
        "note": "Método principal quando a Portaria inclui a categoria inteira e a CID-9 tem categoria homônima (ex.: A37 Coqueluche ↔ 033 Coqueluche).",
    },
    "caminal2004": {
        "title": "Caminal J, Starfield B, Sánchez E, Casanova C, Morales M. The role of primary care in preventing ambulatory care sensitive conditions. Eur J Public Health 2004;14(3):246-51 — Tabela 2 (núcleo, 61 códigos ICD-9-CM; ampliada, 90) e Tabela 3 (códigos revisados e excluídos)",
        "doi": "10.1093/eurpub/14.3.246",
        "url": "https://academic.oup.com/eurpub/article/14/3/246/507541",
        "note": "É a lista de origem citada por Alfradique et al. 2009 para a Lista Brasileira. 'core' = núcleo; 'expanded' = só na ampliada; 'reviewed' = avaliado e excluído por Caminal, mas presente na Portaria.",
    },
    "ahrq-pqi-v6": {
        "title": "AHRQ Quality Indicators — Prevention Quality Indicators v6.0, ICD-9-CM technical specifications (out/2016; última versão em ICD-9-CM): PQI 01, 03, 05, 07, 08, 10, 11, 12, 14, 15, 16",
        "url": "https://qualityindicators.ahrq.gov/Downloads/Modules/PQI/V60-ICD09/TechSpecs/",
        "note": "Códigos ICD-9-CM (5º dígito americano) truncados à subcategoria da OMS. ATENÇÃO: o ICD-9-CM renumerou 250.x — CM 250.3 = 'outro coma', CM 250.4 renal … CM 250.8 outras, CM 250.9 NE; na OMS/DATASUS 250.3 é renal, 250.4 oftálmica, 250.5 neurológica, 250.6 circulatória, 250.7 outras, 250.9 NE.",
    },
    "cihi-2008": {
        "title": "CIHI. Ambulatory Care Sensitive Conditions — technical notes (jan/2008), com colunas ICD-9, ICD-9-CM e ICD-10-CA; reproduzidas em Statistics Canada 82-622-X no. 007 (2011), Apêndice A",
        "url": "https://www150.statcan.gc.ca/n1/pub/82-622-x/82-622-x2011007-eng.pdf",
    },
    "datasus-diagpacto9": {
        "title": "DATASUS, TAB_SIH_199201-199712.zip: DIAGPACTO9.CNV (CID-9: 02501, 02502) pareado com DIAGPACTO.CNV (CID-10: E10.0–E14.1) — indicador do Pacto",
        "url": "ftp://ftp.datasus.gov.br/dissemin/publicos/SIHSUS/199201_200712/Auxiliar/TAB_SIH_199201-199712.zip",
    },
    "gems-2018": {
        "title": "CMS General Equivalence Mappings FY2018 (2018_I10gem.txt: ICD-10-CM → ICD-9-CM), aproximadas, um-para-muitos",
        "url": "https://www.cms.gov/medicare/coding/icd10/downloads/2018-icd-10-cm-general-equivalence-mappings.zip",
        "license": "domínio público (obra do governo dos EUA)",
        "note": "Usadas só para conferência cruzada e no resíduo (rubrica sem outra fonte), sempre marcadas.",
    },
}
METHODS = {
    "exact": "a rubrica CID-9 tem o mesmo conteúdo da(s) rubrica(s) CID-10",
    "category": "categoria(s) CID-9 inteira(s) ↔ categoria(s) CID-10 inteira(s) da Portaria, com o mesmo perímetro",
    "approximate": "a rubrica CID-9 é mais larga ou mais estreita que a CID-10 correspondente (o desvio está na nota)",
}

# ------------------------------------------------- correspondência manual
# (grupo, nome do diagnóstico como no JSON) -> [(rubrica CID-9, fontes, método, nota)]
W, C_CORE, C_EXP, C_REV = "who-rubric", "caminal2004:core", "caminal2004:expanded", "caminal2004:reviewed"
MAP = {
 ("g01", "Coqueluche"): [("033", [W, C_REV], "category", None),
                         ("484.3", [W], "approximate", "Pneumonia na coqueluche (rubrica asterisco); A37 inclui a coqueluche com pneumonia (J17.0*).")],
 ("g01", "Difteria"): [("032", [W, C_CORE], "category", None)],
 ("g01", "Tétano"): [("037", [W, C_CORE], "category", "037 cobre A34 (obstétrico) e A35; a CID-9 não separa o obstétrico."),
                     ("771.3", [W], "exact", "Tétano neonatal = A33.")],
 ("g01", "Parotidite"): [("072", [W, C_REV], "category", None)],
 ("g01", "Rubéola"): [("056", [W, C_REV], "category", None)],
 ("g01", "Sarampo"): [("055", [W, C_REV], "category", None),
                      ("484.0", [W], "approximate", "Pneumonia no sarampo (asterisco); B05.2 está em B05.")],
 ("g01", "Febre Amarela"): [("060", [W], "category", None)],
 ("g01", "Hepatite B"): [("070.2", [W], "approximate", "B16 é hepatite B AGUDA; 070.2/070.3 incluem a crônica (B18.1, fora da lista)."),
                         ("070.3", [W], "approximate", "Idem.")],
 ("g01", "Meningite por Haemophilus"): [("320.0", [W, C_CORE], "exact", None)],
 ("g01", "Meningite Tuberculosa"): [("013.0", [W, C_CORE], "exact", "Código adaga."),
                                    ("320.4", [W], "exact", "Rubrica asterisco 'Meningite tuberculosa' na CID-9 da OMS (o ICD-9-CM a redefine); é a mais usada nos dados de 1997.")],
 ("g01", "Tuberculose miliar"): [("018", [W, C_CORE], "category", None)],
 ("g01", "Tuberculose Pulmonar"): [("010", [W], "exact", "Infecção tuberculosa primária = A15.7/A16.7 (tuberculose respiratória primária)."),
                                   ("011", [W, C_EXP], "category", "Tuberculose pulmonar = A15.0–A15.3, A16.0–A16.2."),
                                   ("012", [W, C_CORE], "category", "Outras tuberculoses respiratórias (pleuris, gânglios intratorácicos, laringe) = A15.4–A15.6, A15.8, A16.3–A16.5, A16.8."),
                                   ("013.1", [W, C_CORE], "exact", "Tuberculoma das meninges = A17.1."),
                                   ("013.8", [W, C_CORE], "exact", "Outras tuberculoses do SNC = A17.8."),
                                   ("013.9", [W, C_CORE], "exact", "Tuberculose do SNC NE = A17.9.")],
 ("g01", "Outras Tuberculoses"): [("014", [W, C_CORE], "category", "A18.3."), ("015", [W, C_CORE], "category", "A18.0."),
                                  ("016", [W, C_CORE], "category", "A18.1."), ("017", [W, C_CORE], "category", "A18.2, A18.4–A18.8."),
                                  ("730.4", [W], "exact", "Tuberculose da coluna vertebral (asterisco de 015.0)."),
                                  ("730.5", [W], "exact", "Tuberculose dos ossos dos membros (asterisco)."),
                                  ("730.6", [W], "exact", "Tuberculose de outros ossos (asterisco).")],
 ("g01", "Febre reumática"): [("390", [W, C_CORE], "category", "I00."), ("391", [W, C_CORE], "category", "I01."), ("392", [W], "category", "I02.")],
 ("g01", "Sífilis"): [("091", [W], "category", "A51 (precoce sintomática)."), ("092", [W], "category", "A51.5 (precoce latente)."),
                      ("093", [W], "category", "A52.0 (cardiovascular)."), ("094", [W], "category", "A52.1–A52.3 (neurossífilis)."),
                      ("095", [W], "category", "A52.7."), ("096", [W], "category", "A52.8."), ("097", [W], "category", "A52.9, A53.")],
 ("g01", "Malária"): [("084", [W], "category", "B50–B54.")],
 ("g01", "Ascaridíase"): [("127.0", [W], "exact", None)],
 ("g02", "Desidratação"): [("276.5", [W, "ahrq-pqi-v6:PQI10", C_CORE], "exact", "Depleção de volume = E86.")],
 ("g02", "Gastroenterites"): [(c, [W] + (["ahrq-pqi-v6:PQI10"] if c in ("008", "009") else []), "category",
                               None if c != "009" else "009.0–009.3 = A09 (diarreia e gastroenterite de origem infecciosa presumível); a não infecciosa (558 = K52) fica fora, como na Portaria.")
                              for c in ["001", "002", "003", "004", "005", "006", "007", "008", "009"]],
 ("g03", "Anemia por deficiência de ferro"): [("280", [W, C_EXP], "category", "D50. Em 1997 a prática codificava a anemia carencial NE em 281.9 (35,7 mil AIH) — ver comparabilidade.")],
 ("g04", "Kwashiorkor e outras formas de desnutrição protéico-calórica"): [("260", [W, C_REV], "category", "E40."), ("261", [W, C_REV], "category", "E41."),
                                                                          ("262", [W, C_REV], "category", "E43."), ("263", [W], "category", "E44–E46.")],
 ("g04", "Outras deficiências nutricionais"): [("264", [W], "category", "E50."), ("265", [W], "category", "E51–E52."), ("266", [W], "category", "E53."),
                                                ("267", [W], "category", "E54."), ("268", [W, C_REV], "category", "E55, E64.3."), ("269", [W], "category", "E56, E58–E61, E63, E64.")],
 ("g05", "Otite média supurativa"): [("382", [W, C_EXP], "category", "H66 (supurativa e NE) = 382 (supurativa e NE).")],
 ("g05", "Nasofaringite aguda (resfriado comum)"): [("460", [W], "category", None)],
 ("g05", "Sinusite aguda"): [("461", [W, C_REV], "category", None)],
 ("g05", "Faringite aguda"): [("462", [W, C_REV], "category", None)],
 ("g05", "Amigdalite aguda"): [("463", [W, C_EXP], "category", None),
                               ("034.0", [W], "exact", "Angina estreptocócica = J02.0 (faringite estreptocócica) + J03.0 (amigdalite estreptocócica).")],
 ("g05", "Infecção aguda das vias aéreas superiores"): [("465", [W, C_EXP], "category", "J06. Ver comparabilidade: 465.9 tinha 73 mil AIH em 1997 e J06 caiu a ~15 mil em 1998.")],
 ("g05", "Rinite, nasofaringite e faringite crônicas"): [("472", [W, C_REV], "category", "J31.")],
 ("g06", "Pneumonia Pneumocócica"): [("481", [W, "ahrq-pqi-v6:PQI11", C_EXP], "approximate", "481 inclui 'pneumonia lobar, organismo NE' (J18.1) — compartilhada com o diagnóstico seguinte.")],
 ("g06", "Pneumonia por Haemophilus influenzae"): [("482.2", [W, "ahrq-pqi-v6:PQI11", C_CORE], "exact", None)],
 ("g06", "Pneumonia por Streptococcus"): [("482.3", [W, "ahrq-pqi-v6:PQI11", C_CORE], "exact", "J15.3–J15.4.")],
 ("g06", "Pneumonia bacteriana não especificada"): [("482.8", [W], "approximate", "Outras bactérias especificadas; na CID-10 J15.5 (E. coli) e J15.6 (outras gram-negativas) ficaram FORA da Portaria e aqui não se separam."),
                                                    ("482.9", [W, "ahrq-pqi-v6:PQI11", C_EXP], "exact", "J15.9.")],
 ("g06", "Pneumonia lobar não especificada"): [("481", [W, "gems-2018"], "approximate", "Sem rubrica própria na CID-9: a lobar NE está dentro de 481 (GEMs J18.1 → 481).")],
 ("g07", "Asma"): [("493", [W, "ahrq-pqi-v6:PQI05", "ahrq-pqi-v6:PQI15", "cihi-2008", C_EXP], "category", "J45–J46.")],
 ("g08", "Bronquite aguda"): [("466", [W, "cihi-2008", C_EXP], "category", "J20–J21 (bronquite e bronquiolite agudas).")],
 ("g08", "Bronquite não especificada como aguda ou crônica"): [("490", [W, C_EXP], "category", "J40.")],
 ("g08", "Bronquite crônica simples e mucopurulenta"): [("491.0", [W, "ahrq-pqi-v6:PQI05", "cihi-2008", C_EXP], "exact", "J41.0."),
                                                        ("491.1", [W, "ahrq-pqi-v6:PQI05", "cihi-2008", C_EXP], "exact", "J41.1.")],
 ("g08", "Bronquite crônica não especificada"): [("491.8", [W, "ahrq-pqi-v6:PQI05", "cihi-2008", C_EXP], "approximate", "Outras bronquites crônicas (J41.8/J42)."),
                                                 ("491.9", [W, "ahrq-pqi-v6:PQI05", "cihi-2008", C_EXP], "exact", "J42.")],
 ("g08", "Enfisema"): [("492", [W, "ahrq-pqi-v6:PQI05", "cihi-2008", C_EXP], "category", "J43.")],
 ("g08", "Bronquiectasia"): [("494", [W, "ahrq-pqi-v6:PQI05", "cihi-2008", C_EXP], "category", "J47.")],
 ("g08", "Outras doenças pulmonares obstrutivas crônicas"): [("491.2", [W, "ahrq-pqi-v6:PQI05", "cihi-2008", C_EXP], "exact", "Bronquite crônica obstrutiva = J44.8."),
                                                             ("496", [W, "ahrq-pqi-v6:PQI05", "cihi-2008", C_EXP], "category", "J44.")],
 ("g09", "Hipertensão essencial"): [("401", [W, "ahrq-pqi-v6:PQI07", "cihi-2008", C_CORE], "category", "I10. AHRQ e CIHI listam 401.0 e 401.9 e deixam de fora 401.1 (benigna); a Portaria inclui I10 inteira, logo 401 inteira.")],
 ("g09", "Doença cardíaca hipertensiva"): [("402", [W, "ahrq-pqi-v6:PQI07", "cihi-2008", C_CORE], "category", "I11.")],
 ("g10", "Angina pectoris"): [("413", [W, "cihi-2008", C_CORE], "category", "I20. A 411 (outras formas agudas/subagudas de doença isquêmica — angina instável, insuficiência coronária aguda, Dressler) ficou FORA: na CID-10 vai sobretudo para I24 (fora da Portaria) e a fronteira 1997/98 confirma (razão 1,14 sem 411, 1,44 com).")],
 ("g11", "Insuficiência cardíaca"): [("428", [W, "ahrq-pqi-v6:PQI08", "cihi-2008", C_CORE], "category", "I50.")],
 ("g11", "Edema agudo de pulmão"): [("518.4", [W, "cihi-2008", C_CORE], "exact", "J81."),
                                    ("514", ["gems-2018"], "approximate", "Congestão e hipostase pulmonares: inclui edema pulmonar NE (J81) e pneumonia hipostática (J18.2, fora). 164 AIH em 1997.")],
 ("g12", "Doenças cerebrovasculares"): [("433", [W], "category", "I65 (oclusão de artérias pré-cerebrais); com infarto = I63."),
                                        ("434", [W], "category", "I66 (oclusão de artérias cerebrais); com infarto = I63."),
                                        ("435", [W], "category", "G45 (isquemia cerebral transitória)."),
                                        ("436", [W, C_CORE], "category", "I64 (AVC agudo mal definido)."),
                                        ("437", [W], "category", "I67 (outras cerebrovasculares; 437.2 encefalopatia hipertensiva = I67.4, listada por Caminal no núcleo) e G46 (síndromes vasculares cerebrais)."),
                                        ("438", [W], "category", "I69 (sequelas). Hemorragias 430–432 = I60–I62 ficam fora, como na Portaria.")],
 ("g13", "Com coma ou cetoacidose"): [("250.1", [W, "datasus-diagpacto9", "ahrq-pqi-v6:PQI01", "cihi-2008", C_CORE], "exact", "Cetoacidose = E1x.1."),
                                      ("250.2", [W, "datasus-diagpacto9", "ahrq-pqi-v6:PQI01", "cihi-2008", C_CORE], "exact", "Coma = E1x.0.")],
 ("g13", "Com complicações"): [("250.3", [W, "ahrq-pqi-v6:PQI03", C_CORE], "exact", "Renais = E1x.2 (OMS 250.3 = CM 250.4)."),
                               ("250.4", [W, "ahrq-pqi-v6:PQI03"], "exact", "Oftálmicas = E1x.3."),
                               ("250.5", [W, "ahrq-pqi-v6:PQI03"], "exact", "Neurológicas = E1x.4."),
                               ("250.6", [W, "ahrq-pqi-v6:PQI03"], "exact", "Circulatórias periféricas = E1x.5."),
                               ("250.7", [W, "ahrq-pqi-v6:PQI03", "cihi-2008", C_EXP], "exact", "Outras manifestações especificadas = E1x.6–E1x.7."),
                               ("250.9", [W, "ahrq-pqi-v6:PQI03", C_REV], "exact", "Complicações NE = E1x.8."),
                               ("362.0", [W], "approximate", "Retinopatia diabética (asterisco de 250.4; H36.0* na CID-10, cujo principal seria E1x.3)."),
                               ("357.2", [W], "approximate", "Polineuropatia diabética (asterisco de 250.5; G63.2*).")],
 ("g13", "Sem complicações específicas"): [("250.0", [W, "ahrq-pqi-v6:PQI14", "cihi-2008", C_EXP], "exact", "E1x.9.")],
 ("g14", "Epilepsias"): [("345", [W, "cihi-2008", C_EXP], "category", "G40–G41.")],
 ("g15", "Nefrite túbulo-intersticial aguda"): [("590.1", [W, "ahrq-pqi-v6:PQI12", C_CORE], "exact", "Pielonefrite aguda = N10.")],
 ("g15", "Nefrite túbulo-intersticial crônica"): [("590.0", [W, C_EXP], "exact", "Pielonefrite crônica = N11.")],
 ("g15", "Nefrite túbulo-intersticial não especificada"): [("590.3", [W, "ahrq-pqi-v6:PQI12"], "approximate", "Pieloureterite cística (N28.8 na CID-10) — 428 AIH."),
                                                            ("590.8", [W, "ahrq-pqi-v6:PQI12", C_EXP], "exact", "Pielonefrite NE = N12."),
                                                            ("590.9", [W, "ahrq-pqi-v6:PQI12"], "approximate", "Infecção do rim NE (N15.9 na CID-10, fora da Portaria; aqui incluída por ser a NE da categoria). 590.2 (abscesso renal = N15.1) ficou FORA.")],
 ("g15", "Cistite"): [("595", [W, "ahrq-pqi-v6:PQI12"], "category", "N30.")],
 ("g15", "Uretrite"): [("597", [W], "category", "N34 (uretrite não venérea e síndrome uretral).")],
 ("g15", "Infecção do trato urinário de localização não especificada"): [("599.0", [W, "ahrq-pqi-v6:PQI12", C_EXP], "exact", "N39.0.")],
 ("g16", "Erisipela"): [("035", [W], "category", "A46.")],
 ("g16", "Impetigo"): [("684", [W], "category", "L01.")],
 ("g16", "Abscesso cutâneo, furúnculo e carbúnculo"): [("680", [W], "approximate", "Furúnculo e carbúnculo = L02; o abscesso cutâneo está em 682 (diagnóstico seguinte, mesmo grupo).")],
 ("g16", "Celulite"): [("682", [W, C_EXP], "approximate", "Outras celulites e abscessos = L03 + abscesso de L02."),
                       ("681", [W, C_EXP], "exact", "Celulite e abscesso de dedos = L03.0.")],
 ("g16", "Linfadenite aguda"): [("683", [W, C_EXP], "category", "L04.")],
 ("g16", "Outras infecções localizadas na pele e tecido subcutâneo"): [("686", [W, C_EXP], "category", "L08.")],
 ("g17", "Salpingite e ooforite"): [("614.0", [W, C_CORE], "exact", "N70.0."), ("614.1", [W, C_CORE], "exact", "N70.1."), ("614.2", [W, C_CORE], "exact", "N70.9.")],
 ("g17", "Doença inflamatória do útero, exceto o colo"): [("615", [W], "category", "N71.")],
 ("g17", "Doença inflamatória do colo do útero"): [("616.0", [W], "exact", "N72.")],
 ("g17", "Outras doenças inflamatórias pélvicas femininas"): [(f"614.{i}", [W, C_CORE], "exact", "N73.") for i in range(3, 10)],
 ("g17", "Doenças da glândula de Bartholin"): [("616.2", [W], "exact", "N75.0."), ("616.3", [W], "exact", "N75.1.")],
 ("g17", "Outras afecções inflamatórias da vagina e da vulva"): [("616.1", [W], "exact", "N76.0–N76.1."), ("616.4", [W], "exact", "N76.4."),
                                                                 ("616.5", [W], "exact", "N76.6."), ("616.8", [W], "exact", "N76.8."), ("616.9", [W], "exact", "N76.8/N76.9.")],
 ("g18", "Úlcera gástrica"): [("531", [W, C_CORE], "category", "K25 (Caminal só lista as hemorrágicas/perfuradas .0, .2, .4, .6; a Portaria inclui K25 inteira).")],
 ("g18", "Úlcera duodenal"): [("532", [W, C_CORE], "category", "K26.")],
 ("g18", "Úlcera péptica de localização não especificada"): [("533", [W, C_CORE], "category", "K27.")],
 ("g18", "Úlcera gastrojejunal"): [("534", [W], "category", "K28.")],
 ("g18", "Hematêmese"): [("578.0", [W], "exact", "K92.0.")],
 ("g18", "Melena"): [("578.1", [W], "exact", "K92.1.")],
 ("g18", "Hemorragia gastrointestinal não especificada"): [("578.9", [W], "exact", "K92.2.")],
 ("g19", "Infecção do trato urinário na gravidez"): [("646.6", [W], "approximate", "Infecções do trato geniturinário na gravidez = O23; a CID-9 inclui também as do puerpério (O86.1–O86.2, fora)."),
                                                     ("646.5", [W], "exact", "Bacteriúria assintomática na gravidez = O23.4 (5 AIH).")],
 ("g19", "Sífilis congênita"): [("090", [W, C_CORE], "category", "A50.")],
 ("g19", "Síndrome da rubéola congênita"): [("771.0", [W], "exact", "P35.0.")],
}

# Exclusões deliberadas (documentadas com o peso de 1997)
EXCLUDED = [
    ("411", "Outras formas agudas e subagudas de doença isquêmica do coração", "g10", "Na CID-10 vai sobretudo para I24 (fora da Portaria); CIHI a inclui, mas pareada com I24. Fronteira: razão do g10 1,14 sem / 1,44 com."),
    ("485", "Broncopneumonia por microorganismo não especificado", "g06", "= J18.0, fora da Portaria (AHRQ e Caminal a incluem)."),
    ("486", "Pneumonia por microorganismo não especificado", "g06", "= J18.9, fora da Portaria (AHRQ e Caminal a incluem)."),
    ("482.4", "Pneumonia devida a Staphylococcus", "g06", "= J15.2, fora da Portaria (AHRQ a inclui)."),
    ("483", "Pneumonia por outros microorganismos especificados", "g06", "= J15.7 (Mycoplasma), J16 — fora da Portaria (AHRQ e Caminal a incluem)."),
    ("558", "Outras gastroenterites e colites não infecciosas", "g02", "= K52, fora da Portaria (AHRQ PQI10 e Caminal incluem 558.9)."),
    ("590.2", "Abscesso renal e perinefrético", "g15", "= N15.1, fora da Portaria (AHRQ PQI12 a inclui)."),
    ("281.9", "Anemias por deficiências não especificadas", "g03", "= D53.9, fora da Portaria; explica a baixa comparabilidade do g03 (a prática de 1997 usava 281.9 onde 1998 usa D50.9)."),
    ("320.5", "Meningite meningocócica", "g01", "= A39, fora da Portaria."),
    ("430", "Hemorragia subaracnóidea", "g12", "= I60, fora da Portaria (Caminal a inclui)."),
    ("431", "Hemorragia intracerebral", "g12", "= I61, fora da Portaria (Caminal a inclui)."),
    ("099.4", "Outras uretrites não gonocócicas", "g15", "Rubrica venérea; N34.1 diz 'não venérea'. 0 AIH em 1997."),
    ("410", "Infarto agudo do miocárdio", "g10", "= I21, fora da Portaria (Caminal lista 410–414 no núcleo)."),
    ("443.8", "Outras doenças vasculares periféricas", "g13", "Asterisco não específico (angiopatia diabética entre outras); I79.2*/I73.8 fora."),
    ("785.4", "Gangrena", "g13", "= R02, fora da Portaria (Caminal usa 785.4+250.7)."),
]

# ---------------------------------------------------------------- GEMs
gem_rows = []
if args.gems:
    for ln in open(os.path.join(args.gems, "2018_I10gem.txt")):
        p = ln.split()
        if len(p) >= 3:
            gem_rows.append((p[0], p[1]))
def gem_targets(cid10):
    k = cid10.replace(".", "")
    out = set()
    for i10, i9 in gem_rows:
        if i10.startswith(k) and i9 != "NoDx":
            out.add(i9[:3] + ("." + i9[3] if len(i9) > 3 else ""))
    return out

# ------------------------------------------------------------ derivação
validation = json.load(open(args.validation, encoding="utf-8")) if args.validation else None
groups_out = []
seen = {}
problems = []
n_rubrics = 0
for g in csap["groups"]:
    diags = []
    g_codes = 0
    for d in g["diagnoses"]:
        key = (g["code"], norm(d["name"]))
        if key not in MAP:
            problems.append(f"sem correspondência: {key}"); continue
        entries = []
        codes6 = []
        for rubric, sources, method, note in MAP[key]:
            hits = expand(rubric)
            if not hits:
                problems.append(f"rubrica {rubric} inexistente nas tabelas ({key})"); continue
            n_rubrics += 1
            lab = hits[0]["label"] if "." in rubric else re.sub(r"^\S+\s*-\s*", "", next((r["label"] for r in by_cat[rubric] if r["rubric"] == rubric), hits[0]["label"]))
            e = {"cid9": rubric, "label": lab, "codes6": [h["code6"] for h in hits], "source": sources, "method": method}
            if n97:
                e["aih_1997"] = sum(n97.get(h["code6"], 0) for h in hits)
            if note:
                e["note"] = note
            entries.append(e)
            for h in hits:
                if h["code6"] in seen and seen[h["code6"]][0] != g["code"]:
                    problems.append(f"{h['code6']} ({rubric}) em dois grupos: {seen[h['code6']]} e {key}")
                seen.setdefault(h["code6"], key)
                if h["code6"] not in codes6:
                    codes6.append(h["code6"])
        dd = {"name": d["name"], "cid10": d["cid10"], "cid9": entries, "codes6": sorted(codes6)}
        if gem_rows:
            # alvos das GEMs que NENHUM diagnóstico do grupo adota (conferência; não é fonte)
            gt = set()
            for c in d["cid10"]:
                gt |= gem_targets(c)
            grp_rubrics = set()
            for k2, entries2 in MAP.items():
                if k2[0] == g["code"]:
                    for rub, *_ in entries2:
                        grp_rubrics.add(rub)
                        grp_rubrics |= {h["rubric"] for h in expand(rub)}
            only_gems = sorted(t for t in gt if t not in grp_rubrics and t.split(".")[0] not in grp_rubrics)
            if only_gems:
                dd["gems_not_adopted"] = only_gems
        diags.append(dd)
        g_codes += len(codes6)
    go = {"code": g["code"], "id": g["id"], "name_pt": g["name_pt"], "diagnoses": diags}
    if validation:
        r = validation["recortes"].get("C2", {}).get(g["code"])
        if r:
            go["comparability"] = validation["comparabilidade"].get(g["code"])
            go["share_ratio_1997_1998"] = round(r["ratio"], 3)
    groups_out.append(go)

if problems:
    print("PROBLEMAS:\n  " + "\n  ".join(problems), file=sys.stderr)
    sys.exit(1)

all6 = sorted(seen)
excluded = []
for rubric, label, grp, reason in EXCLUDED:
    hits = expand(rubric)
    excluded.append({"cid9": rubric, "label": label, "would_be_group": grp, "reason": reason,
                     "aih_1997": sum(n97.get(h["code6"], 0) for h in hits) if n97 else None})

meta = {
    "derived_from": "src/data/csap-groups.json — Lista Brasileira de ICSAP, Portaria SAS/MS nº 221, de 17/04/2008 (CID-10, 19 grupos, 197 códigos)",
    "classification": "CID-9 (OMS, 1975) na codificação do SIH/SUS de 1992–1997: DIAG_PRINC de 6 dígitos = prefixo (0) + categoria (3) + subcategoria (1) + dígito verificador; decodificar por tabela, não por fórmula (docs/analise-002-sih-1992-1997.md)",
    "not_official": True,
    "icsap_list_revision": "cid9-derivada",
    "status": "derivada e validada na fronteira 1997/98 em 2026-09-07; não há lista oficial do MS em CID-9",
    "document": "docs/analise-003-icsap-cid9.md",
    "generated_by": "scripts/estudo-icsap-cid9-derivar.py",
    "generated_at": date.today().isoformat(),
    "tables": "TAB_SIH_199201-199712.zip (DATASUS): CID9_01..17.CNV + CID9_SUP.CNV, 8.240 códigos de 6 dígitos, 6.891 válidos; só códigos válidos entram",
    "matching": "o builder classifica pelo código de 6 dígitos exato (codes6); as rubricas de 3 dígitos sem subdivisão são gravadas no SIH com subcategoria 9 (ex.: 035 → 003590)",
    "sources": SOURCES,
    "methods": METHODS,
    "total_groups": len(groups_out),
    "total_rubrics": n_rubrics,
    "total_codes6": len(all6),
    "excluded": excluded,
}
if n97:
    tot97 = sum(n97.values())
    icsap97 = sum(n97.get(c, 0) for c in all6)
    meta["aih_1997"] = {"total": tot97, "icsap": icsap97, "share": round(icsap97 / tot97, 4)}
if validation:
    meta["validation"] = {
        "method": "participação de cada grupo nas AIH codificadas em CID-9 (esta lista) vs em CID-10 (lista oficial), lida do healthbr-data (scripts/estudo-icsap-cid9-fronteira.mjs + estudo-icsap-cid9-analise.py); razão = share9/share10; classes a priori: alta 0,80–1,25, média 0,67–1,50, baixa fora",
        "recortes_disponiveis": [k for k in validation["recortes"] if not k.endswith("_uf")],
        "primary": "C2 (1997 inteiro vs 1998-03..12, sem os dois meses de transição em que a participação ICSAP total cai a 19–20 %)",
        "icsap_ratio_C2": round(validation["recortes"]["C2"]["icsap"]["ratio"], 3) if "C2" in validation["recortes"] else None,
        "comparability": validation["comparabilidade"],
        "variants_tested": validation.get("variantes"),
    }

out = {"metadata": meta, "groups": groups_out}
os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
json.dump(out, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"{args.out}: {len(groups_out)} grupos, {n_rubrics} rubricas CID-9, {len(all6)} códigos de 6 dígitos" + (f", {meta['aih_1997']['share']*100:.2f} % das AIH de 1997" if n97 else ""))

if args.lists:
    os.makedirs(args.lists, exist_ok=True)
    with open(os.path.join(args.lists, "icsap_cid9.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh); w.writerow(["code6", "cid9", "grp", "diag", "variant"])
        done = set()
        for g in groups_out:
            for d in g["diagnoses"]:
                for e in d["cid9"]:
                    for c in e["codes6"]:
                        if c not in done:
                            done.add(c)
                            w.writerow([c, e["cid9"], g["code"], norm(d["name"]), "" if e["method"] != "approximate" or e["cid9"] in ("481", "482.8", "590.3", "590.9", "646.6", "680", "682", "070.2", "070.3", "491.8") else "vast"])
    with open(os.path.join(args.lists, "icsap_cid10.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh); w.writerow(["prefix", "len", "grp", "diag"])
        for g in csap["groups"]:
            for d in g["diagnoses"]:
                for c in d["cid10"]:
                    p = c.replace(".", ""); w.writerow([p, len(p), g["code"], norm(d["name"])])
    print(f"listas para a fronteira em {args.lists}")
