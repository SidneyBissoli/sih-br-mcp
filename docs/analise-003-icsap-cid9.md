# ANÁLISE-003 — Lista ICSAP em CID-9 para o SIH de 1992–1997: derivação e validação

**Status:** lista derivada, versionada e validada em 2026-09-07 (34ª sessão), em
`src/data/csap-groups-cid9.json`. Cumpre a decisão (iii) do estudo 1992–1997
(ANÁLISE-002, §5): lista "a mais robusta possível", rastreável, validada nos dados,
**antes** do builder 2.5.0. O builder não mudou; a lista ainda não é lida por nada.
**Pergunta:** a Lista Brasileira de ICSAP (Portaria SAS/MS 221/2008) está em CID-10; o
SIH de 1992–1997 codifica `DIAG_PRINC` em CID-9 (OMS) e não existe lista oficial em CID-9
(Alfradique et al. 2009 converteram as listas internacionais em CID-9-CM para a CID-10 sem
publicar a correspondência). Que lista CID-9 reproduz a Portaria com fidelidade suficiente
para o cubo de 1992–1997 nascer com ICSAP, e com que comparabilidade por grupo?
**Método:** correspondência **manual** por diagnóstico da Portaria (19 grupos, 197 códigos
CID-10) para rubricas CID-9 da OMS, cada uma com fonte e método declarados
(`scripts/estudo-icsap-cid9-derivar.py`); expansão só para os códigos de 6 dígitos que
existem nas tabelas `CID9_*.CNV` do DATASUS; conferência cruzada com as GEMs; peso pelas
12,35 milhões de AIH de 1997; **validação empírica na fronteira 1997/1998** — participação
de cada grupo nas AIH codificadas em CID-9 (esta lista) contra as codificadas em CID-10
(lista oficial), lidas do healthbr-data (`scripts/estudo-icsap-cid9-fronteira.mjs` +
`estudo-icsap-cid9-analise.py`). Nenhum código veio de conversor automático.

## 1. Resultado em uma página

1. **A lista tem 19 grupos, 156 rubricas CID-9 (categorias ou subcategorias) e 439 códigos
   de 6 dígitos**, todos existentes nas tabelas do DATASUS, nenhum em dois grupos. Cada
   rubrica traz `source[]` (fontes abaixo), `method` (`exact` / `category` /
   `approximate`), o rótulo do DATASUS, as AIH de 1997 e, quando o perímetro difere, uma
   nota. Cobre **26,16 % das AIH de 1997** (3.231.302 de 12.351.464); a lista oficial
   cobre 24,98 % das AIH de 1998-03..12. **Razão global 1,05.**
2. **Fontes, por ordem de uso:** correspondência de rubrica homônima CID-9 ↔ CID-10
   conferida nos rótulos do DATASUS (todas as rubricas); Caminal et al. 2004 (a lista de
   origem citada por Alfradique — 61 códigos no núcleo, 90 na ampliada, 23 revisados e
   excluídos: 72 das 156 rubricas aparecem lá); AHRQ PQI v6.0 ICD-9-CM, out/2016 (11
   indicadores; 31 rubricas); CIHI 2008 com coluna ICD-9 (22 rubricas); o par
   `DIAGPACTO9`/`DIAGPACTO` do próprio DATASUS (250.1–250.2 ↔ E1x.0–E1x.1); GEMs FY2018
   só em **uma** rubrica residual (514) e na conferência cruzada.
3. **Validação (1997 CID-9 vs 1998-03..12 CID-10, razão da participação):** 16 grupos
   com comparabilidade **alta** (0,86–1,22), 1 **média** (g06 pneumonias bacterianas,
   0,76) e 2 **baixas** — g05 ouvido/nariz/garganta (4,75) e g03 anemia ferropriva
   (0,21). Nos dois casos a causa está na **prática de codificação**, não na lista: a
   rubrica 465.9 "IVAS de localização NE" tinha 73 mil AIH em 1997 e a J06 caiu a 15 mil
   em 1998 (todo o respiratório alto encolheu pela metade na troca de revisão); a
   anemia carencial era lançada como 281.9 "deficiência NE" (35,7 mil) em 1997 e como
   D50.9 (8,6 mil) / D53.9 (13,7 mil) em 1998. As rubricas CID-9 desses grupos são as
   corretas (280 = D50; 465 = J06); o que muda é o que o codificador escolhia. Os dois
   grupos ficam na lista, marcados `comparability = "baixa"`, e o cubo deve carregar
   a marca (nota nas ferramentas para ano < 1998).
4. **Dois meses de transição:** em 1998-01 e 1998-02 a participação ICSAP total cai a
   19,4 % e 20,3 % e volta a 24,5 % em março (1997 inteiro: 25,7–26,6 %). É efeito da
   mudança de revisão nos primeiros meses de CID-10, não da lista; por isso a razão
   primária exclui esses meses (recorte C').
5. **A validação decidiu duas inclusões:** a rubrica 411 (angina instável, insuficiência
   coronária aguda, Dressler; 16 mil AIH) ficou **fora** da angina — a CIHI a inclui, mas
   pareada com I24, que a Portaria não tem; com ela a razão do g10 vai de 1,14 para 1,44.
   E 8 rubricas "asterisco" específicas (320.4 meningite tuberculosa, 484.0/484.3
   pneumonias do sarampo e da coqueluche, 730.4–730.6 tuberculose óssea, 362.0
   retinopatia e 357.2 polineuropatia diabéticas; 614 AIH) ficaram **dentro** — não
   movem a razão e são o que o codificador de 1997 escreveu para essas doenças.
6. **Não fazer:** aplicar a lista a um código que não esteja em `codes6`; usar
   ICD-9-CM (o 250.x é renumerado: CM 250.4 renal = OMS 250.3); comparar g03 e g05 entre
   as eras sem a marca; tratar a lista como oficial (`not_official: true`).

## 2. A correspondência

### 2.1 Regras

- **Unidade é a rubrica da Portaria.** Cada diagnóstico da lista CID-10 recebe uma ou mais
  rubricas CID-9. Quando a Portaria inclui a categoria inteira (ex.: `A37`) e a CID-9 tem a
  categoria homônima (`033 Coqueluche`), a correspondência é `category` e entram todos os
  códigos válidos da categoria. Quando a Portaria inclui subcategoria (`G00.0`), a CID-9
  responde com subcategoria (`320.0`) e o método é `exact`. Quando a rubrica CID-9 é mais
  larga ou mais estreita, `approximate` com nota do desvio (18 rubricas).
- **Só códigos válidos.** As tabelas do DATASUS listam 8.240 códigos de 6 dígitos, dos
  quais 1.349 são "Código inválido - fora da CID"; nenhum desses tem AIH em 1997 dentro
  das categorias da lista, e nenhum entra. As categorias sem subdivisão na CID-9 (035,
  037, 280, 413, 435, 436, 438, 460, 462, 463, 481, 490, 492, 494, 496, 683, 684, 771…)
  são gravadas no SIH com subcategoria 9 (035 → `003590`); o builder classifica pelo
  código de 6 dígitos exato, então isso é transparente.
- **Códigos adaga/asterisco.** A CID-9 da OMS tem rubricas de manifestação (asterisco)
  que o SIH usava como diagnóstico principal. Entram só as **específicas da condição
  ICSAP** e com peso conhecido (320.4 = 181 AIH, mais que a adaga 013.0 = 96); ficam fora
  as inespecíficas (420.0 pericardite em doenças classificadas em outra parte, 711.4,
  730.8, 443.8 — GEMs as apontam, e o JSON as registra em `gems_not_adopted`).
- **Perímetro da Portaria manda.** O que a Portaria exclui na CID-10 fica fora na CID-9
  mesmo quando as listas de origem incluem: broncopneumonia e pneumonia NE (485/486 =
  J18.0/J18.9, 902 mil AIH — AHRQ e Caminal incluem), pneumonia estafilocócica (482.4),
  Mycoplasma/outros (483), gastroenterite não infecciosa (558 = K52), abscesso renal
  (590.2 = N15.1), hemorragias cerebrais (430/431 = I60/I61), infarto (410), gangrena
  (785.4). A lista completa, com o peso de 1997 e a razão, está em `metadata.excluded`.

### 2.2 Fontes (URLs testadas em 2026-09-07)

| chave | fonte | uso |
|---|---|---|
| `who-rubric` | rubrica CID-9 (OMS 1975) homônima da CID-10, conferida nos rótulos de `CID9_01..17.CNV` | todas as 156 rubricas |
| `caminal2004:core/expanded/reviewed` | Caminal J et al. *Eur J Public Health* 2004;14(3):246-51, doi 10.1093/eurpub/14.3.246 — Tabela 2 (núcleo 61, ampliada 90) e Tabela 3 (revisados/excluídos) | 72 rubricas |
| `ahrq-pqi-v6:PQInn` | AHRQ Prevention Quality Indicators v6.0, ICD-9-CM, out/2016 (última em ICD-9-CM): PQI 01, 03, 05, 07, 08, 10, 11, 12, 14, 15, 16 — `qualityindicators.ahrq.gov/Downloads/Modules/PQI/V60-ICD09/TechSpecs/` | 31 rubricas |
| `cihi-2008` | CIHI, ACSC technical notes (jan/2008), colunas ICD-9/ICD-9-CM/ICD-10-CA, reproduzidas em Statistics Canada 82-622-X nº 007 (2011), Apêndice A | 22 rubricas |
| `datasus-diagpacto9` | `DIAGPACTO9.CNV` (02501, 02502) ↔ `DIAGPACTO.CNV` (E10.0–E14.1) em `TAB_SIH_199201-199712.zip` | 250.1, 250.2 |
| `gems-2018` | CMS General Equivalence Mappings FY2018 (ICD-10-CM → ICD-9-CM; domínio público; aproximadas) | conferência cruzada; residual 514 |

O que **não** serviu: a Portaria 221 na BVS (`bvsms.saude.gov.br/.../prt0221_17_04_2008.html`)
não respondeu (curl 000) — o JSON `csap-groups.json` já a reproduz; a página da CIHI
devolve 403 a qualquer cliente fora do Canadá (usou-se a reprodução da Statistics Canada);
a OMS não tem tabela geral CID-9 → CID-10 (só o capítulo V, 1994); Billings 1993 não
publica tabela de códigos (é a origem conceitual, não de código).

### 2.3 Armadilhas encontradas

- **ICD-9-CM ≠ CID-9 da OMS no 250.x.** O ICD-9-CM inseriu 250.3 "outro coma" e empurrou
  as manifestações: CM 250.4 renal, 250.5 oftálmica, 250.6 neurológica, 250.7 circulatória,
  250.8 outras, 250.9 NE. Na OMS (e nas tabelas do DATASUS): 250.3 renal, 250.4 oftálmica,
  250.5 neurológica, 250.6 circulatória, 250.7 outras, 250.9 NE (não existe 250.8). Copiar
  o AHRQ ao pé da letra colocaria a nefropatia diabética no "coma".
- **320.4 é "meningite tuberculosa" na OMS**, mas o ICD-9-CM redefiniu a rubrica
  ("meningitis in other bacterial diseases"). Vale o rótulo do DATASUS.
- **411 não tem subdivisão na OMS** (o ICD-9-CM tem 411.1 angina instável, 411.8). Sem
  separar a angina instável do resto, a rubrica inteira vai para o que na CID-10 é I24.
- **481 inclui "pneumonia lobar, organismo NE"** (J18.1): a Portaria lista J13 e J18.1
  separadamente; na CID-9 são a mesma rubrica, compartilhada entre os dois diagnósticos.
- **AHRQ e CIHI excluem 401.1 (hipertensão benigna)**; a Portaria inclui I10 inteira, então
  401 entra inteira (1.109 AIH em 401.1).
- **Caminal exclui por critério, não por perímetro:** 033, 055, 056, 072, 461, 462, 472.1,
  260–262, 268.0, 268.1, 250.9, 401.9 estão na Tabela 3 (avaliados e excluídos), mas a
  Portaria os inclui — entram, marcados `caminal2004:reviewed`.

## 3. Peso em 1997 e validação na fronteira

### 3.1 O que se compara

Internações de 1997 estão codificadas em CID-9 (competências 1997) e as faturadas em
1998-01..04 já em CID-10; 1998 inteiro está em CID-10 (ANÁLISE-002 §4). A validação usa a
**participação** de cada grupo no total de AIH (não a contagem), em três recortes:
**A** mesmas internações (DT_INTER em dez/1997) faturadas em 1997-12 vs em 1998-01..04;
**B** competências 1997-10..12 vs 1998-01..03; **C** anos inteiros 1997 vs 1998, e **C'**
1997 vs 1998-03..12 (sem os dois meses de transição). Razão = share CID-9 / share CID-10;
classes fixadas **a priori**: alta 0,80–1,25; média 0,67–1,50; baixa fora disso. A razão
esperada não é exatamente 1: a participação ICSAP total vinha caindo (26,6 % em jan/1997,
25,8 % em dez/1998), logo 1,03–1,10 é o "ruído de tendência".

Os três recortes rodaram (C na sessão; A e B pelo usuário logo depois, 12 s). O recorte
primário é C', porque o lado CID-10 de A e de B cai justamente nos dois meses de transição
(§3.3), e o de A carrega ainda o viés das AIH faturadas tarde (internações longas). A e B
servem para confirmar os desvios de grupo e para ver a transição por UF (§3.4).

### 3.2 Resultado (C': 1997 em CID-9, 12.351.464 AIH, vs 1998-03..12 em CID-10, 10.254.735)

| grupo | descrição | AIH 1997 | % | AIH 1998-03..12 | % | razão | comparabilidade |
|---|---|---:|---:|---:|---:|---:|---|
| g01 | preveníveis por imunização e outras | 58.948 | 0,477 | 44.862 | 0,437 | 1,09 | alta |
| g02 | gastroenterites e desidratação | 721.922 | 5,845 | 527.964 | 5,148 | 1,14 | alta |
| g03 | anemia ferropriva | 2.413 | 0,020 | 9.370 | 0,091 | **0,21** | **baixa** |
| g04 | deficiências nutricionais | 83.436 | 0,676 | 67.746 | 0,661 | 1,02 | alta |
| g05 | ouvido, nariz e garganta | 83.170 | 0,673 | 14.523 | 0,142 | **4,75** | **baixa** |
| g06 | pneumonias bacterianas | 110.975 | 0,898 | 121.104 | 1,181 | 0,76 | média |
| g07 | asma | 390.362 | 3,160 | 325.004 | 3,169 | 1,00 | alta |
| g08 | doenças pulmonares (DPOC, bronquites) | 290.301 | 2,350 | 281.233 | 2,742 | 0,86 | alta |
| g09 | hipertensão | 157.105 | 1,272 | 106.632 | 1,040 | 1,22 | alta |
| g10 | angina | 61.182 | 0,495 | 44.533 | 0,434 | 1,14 | alta |
| g11 | insuficiência cardíaca | 443.471 | 3,590 | 351.245 | 3,425 | 1,05 | alta |
| g12 | cerebrovasculares | 233.054 | 1,887 | 185.054 | 1,805 | 1,05 | alta |
| g13 | diabetes | 117.162 | 0,949 | 90.982 | 0,887 | 1,07 | alta |
| g14 | epilepsias | 55.448 | 0,449 | 40.085 | 0,391 | 1,15 | alta |
| g15 | infecção do rim e trato urinário | 157.718 | 1,277 | 133.783 | 1,305 | 0,98 | alta |
| g16 | pele e subcutâneo | 62.363 | 0,505 | 51.064 | 0,498 | 1,01 | alta |
| g17 | doença inflamatória pélvica | 65.024 | 0,526 | 61.062 | 0,595 | 0,88 | alta |
| g18 | úlcera gastrointestinal | 125.502 | 1,016 | 94.957 | 0,926 | 1,10 | alta |
| g19 | pré-natal e parto | 10.968 | 0,089 | 10.647 | 0,104 | 0,86 | alta |
| **ICSAP** | | **3.230.524** | **26,16** | **2.561.850** | **24,98** | **1,05** | |

(Com 1998 inteiro, recorte C, a razão global é 1,08 e nenhuma classe muda.)

**Variantes testadas** (razão do grupo sem / com o código):

| código(s) | grupo | AIH 1997 | sem | com | decisão |
|---|---|---:|---:|---:|---|
| 411 | g10 | 16.030 | 1,14 | 1,44 | **fora** (↔ I24) |
| 514 | g11 | 164 | 1,05 | 1,05 | dentro, `approximate`, `gems-2018` |
| 320.4, 484.0, 484.3, 730.4–6 | g01 | 271 | 1,09 | 1,10 | dentro |
| 362.0, 357.2 | g13 | 343 | 1,07 | 1,07 | dentro |

**Leitura dos desvios.** g05: a rubrica é correta (465 = J06, 382 = H66, 463 = J03…), mas
em 1998 o volume do respiratório alto encolheu pela metade (464.2 laringotraqueíte 60 mil →
J04.2 30 mil, fora da lista nos dois lados) e a IVAS NE praticamente sumiu (465.9 73 mil →
J06.x 15 mil); 1997-12 tinha 0,66 % e 1998-01 0,11 %, sem gradiente — é troca de prática,
e o grupo fica marcado. g03: 280 (2,4 mil) é a única rubrica de anemia ferropriva na
CID-9; a anemia "carencial NE" ia para 281.9 (35,7 mil, = D53.9) e a "NE" para 285.9
(2,4 mil, = D64.9); em 1998 D50.9 tem 8,6 mil, D53.9 13,7 mil e D64.9 10,9 mil — a massa
migrou de 281.9 para D50.9/D64.9. Incluir 281.9 elevaria o g03 a 38 mil e a razão a 3,5:
pior. g06: 482.9 (108 mil) vs J15.9 (110 mil) batem; a diferença vem de J15.2 (31 mil,
estafilocócica, fora da Portaria mas pareada com 482.4 = 31 mil, também fora) — o que
falta é o crescimento de J18.1 (6 mil, "lobar NE") e J15.8 (17 mil) frente a 481 (1,5 mil)
e 482.8 (1,5 mil): coders de 1998 especificaram mais. g09: 401 (148 mil) vs I10 (96 mil),
402 (9 mil) vs I11 (26 mil) — parte da hipertensão essencial passou a cardiopatia
hipertensiva e a I15 secundária (19 mil, fora); soma do grupo 1,22, dentro da classe alta.

### 3.3 Série mensal da participação ICSAP total (lista CID-9 até 1997-12; oficial depois)

1997: 26,60 · 26,59 · 26,33 · 25,87 · 25,75 · 25,67 · 25,90 · 26,50 · 26,29 · 25,88 ·
26,10 · 26,46 % — 1998: **19,36 · 20,30** · 24,47 · 24,24 · 24,39 · 24,90 · 25,58 · 25,59 ·
25,13 · 24,90 · 24,93 · 25,76 %. A queda em jan–fev/1998 atinge todos os grupos (g02 6,6 →
4,7 %; g09 1,22 → 0,73 %; g11 3,59 → 2,6 %) e volta em março: é a adaptação à CID-10 nos
primeiros meses, com diagnósticos indo para rubricas residuais. Consequência para o cubo
de 1997: as ~686 mil internações de 1997 faturadas em 1998-01..04 (CID-10) terão ICSAP
subestimado nesses dois meses — efeito da fonte, a documentar em `cid_revision`.

### 3.4 Recortes A e B: confirmação e a transição por UF

**A — internações com `DT_INTER` em dez/1997:** 497.893 AIH faturadas em 1997-12 (CID-9,
ICSAP 27,4 %) vs 472.762 faturadas em 1998-01..04 (CID-10, ICSAP **19,4 %**); razão global
1,42. **B — competências 1997-10..12 vs 1998-01..03:** 3,05 M vs 3,05 M AIH, ICSAP 26,1 %
vs 21,4 %, razão 1,22. As duas razões globais medem a queda de jan–fev/1998, não a lista:
em A o lado CID-10 é quase todo faturado nesses dois meses. Por grupo, A e B repetem o
padrão de C': g05 (7,35 em A; 5,65 em B) e g03 (0,19; 0,24) continuam os únicos fora de
qualquer faixa; os demais ficam entre 0,85 e 1,74 em A e entre 0,88 e 1,48 em B, isto é,
em torno da razão global de cada recorte. Em A, g01 cai a 0,57 (tuberculose e febre
reumática são internações longas, sobre-representadas nas AIH faturadas tarde) e g07 asma
sobe a 1,74 (internações curtas, sub-representadas) — é o viés de permanência previsto,
e por isso A não é o recorte primário.

**Transição por UF (recorte A, participação ICSAP total, lado CID-9 → lado CID-10):** a
queda de jan–fev/1998 foi muito desigual — BA 28,2 → 9,5 % (razão 2,97), AC 2,35, SC
2,14, GO e MA 2,03, RJ 1,89, PB 1,87; enquanto PE (1,02), SE (1,01), TO (0,98), ES (0,92),
AL (0,90), PA (0,85) e AM (0,83) não caíram (DF 0,60 e AP 1,63 têm poucas AIH; RR tem 7
AIH na competência 1997-12, a partição é quase vazia). Consequência para o cubo de 1997: o
ICSAP das ~686 mil internações faturadas em 1998-01..04 será subestimado sobretudo em BA,
RJ, SC, GO, MA e PB — vale registrar a marca `cid_revision = 10` por linha (decisão vi)
para que o consumidor possa separar essas AIH.

## 4. Entregáveis e como o builder 2.5.0 deve usar

- `src/data/csap-groups-cid9.json` — `metadata` (fontes, métodos, tabelas, `excluded`,
  `validation` com comparabilidade e razões, `aih_1997`, `not_official`,
  `icsap_list_revision = "cid9-derivada"`) e `groups[]` com `comparability`,
  `share_ratio_1997_1998` e `diagnoses[].cid9[]` (rubrica, rótulo, `codes6`, `source`,
  `method`, `aih_1997`, `note`) + `codes6` consolidados por diagnóstico.
- `scripts/estudo-icsap-cid9-derivar.py` — a correspondência em código, reprodutível a
  partir das tabelas do DATASUS; falha se uma rubrica não existir ou cair em dois grupos.
- `scripts/estudo-icsap-cid9-fronteira.mjs` — recortes A/B/C no healthbr-data (DuckDB).
- `scripts/estudo-icsap-cid9-analise.py` — razões, classes, série mensal, `validation.json`.
- **No builder 2.5.0:** classificar ICSAP por tabela (`codes6` → grupo) quando
  `cid_revision = 9`, e pela lista oficial quando 10; sidecar com
  `icsap_list_revision: "cid9-derivada"` e `icsap_comparability` por grupo; servidor com
  nota em `get_icsap*`/`compare_icsap_trends` para ano < 1998 ("lista derivada, não
  oficial; g03 e g05 não comparáveis com 1998+"). Unificar: a lista CID-10 também deve
  virar tabela lida pelo builder (hoje é código R hardcoded em `classificar_csap()`).

## 5. Reprodução

```powershell
# tabelas do DATASUS (2,9 MB) e GEMs (1,1 MB)
curl -o TAB_SIH_199201-199712.zip ftp://ftp.datasus.gov.br/dissemin/publicos/SIHSUS/199201_200712/Auxiliar/TAB_SIH_199201-199712.zip
curl -L -o gems2018.zip https://www.cms.gov/medicare/coding/icd10/downloads/2018-icd-10-cm-general-equivalence-mappings.zip
# contagem de 1997 por código (≈50 s), listas para a fronteira, recortes e razões
node scripts/estudo-1992-1997.mjs 1997 <pasta>/diag
python scripts/estudo-icsap-cid9-derivar.py --tab <cnv> --diag1997 <pasta>/diag/diag_1997.csv --gems <gems> --lists <pasta>/lists
node scripts/estudo-icsap-cid9-fronteira.mjs <pasta>/lists/icsap_cid9.csv <pasta>/lists/icsap_cid10.csv <pasta>/fronteira ABC
python scripts/estudo-icsap-cid9-analise.py <pasta>/fronteira
# grava o JSON final com a validação embutida
python scripts/estudo-icsap-cid9-derivar.py --tab <cnv> --diag1997 <pasta>/diag/diag_1997.csv --gems <gems> --validation <pasta>/fronteira/validation.json
```

Os CSV intermediários não são versionados. Recorte C: 10 s (1997) + 31 s (1998); A + B:
12 s — lendo só `DIAG_PRINC`, `DT_INTER` e as partições do R2. O `validation.json` guarda
os quatro recortes (`recortes.A`, `A_uf`, `B`, `C`, `C2`), as variantes e a série mensal;
o JSON final embute a comparabilidade e a razão C' por grupo.

## Referências

- Brasil. Ministério da Saúde. Portaria SAS/MS nº 221, de 17 de abril de 2008 — Lista
  Brasileira de Internações por Condições Sensíveis à Atenção Primária.
- Alfradique ME, Bonolo PF, Dourado I, et al. Internações por condições sensíveis à atenção
  primária: a construção da lista brasileira como ferramenta para medir o desempenho do
  sistema de saúde (Projeto ICSAP – Brasil). *Cad Saúde Pública* 2009;25(6):1337-49.
  doi:10.1590/S0102-311X2009000600016.
- Caminal J, Starfield B, Sánchez E, Casanova C, Morales M. The role of primary care in
  preventing ambulatory care sensitive conditions. *Eur J Public Health* 2004;14(3):246-51.
  doi:10.1093/eurpub/14.3.246.
- AHRQ. Prevention Quality Indicators Technical Specifications, v6.0 (ICD-9-CM), October 2016.
- Canadian Institute for Health Information. Ambulatory Care Sensitive Conditions —
  technical notes (2008), in Statistics Canada, *Health Research Working Paper Series*
  82-622-X no. 007 (2011), Appendix A.
- CMS. 2018 ICD-10-CM General Equivalence Mappings (GEMs).
- DATASUS. `TAB_SIH_199201-199712.zip` — tabelas auxiliares do SIH/SUS 1992–1997
  (`CID9_*.CNV`, `DIAGPACTO9.CNV`, `IDB_D14_CID9.CNV`).
- OMS. Classificação Internacional de Doenças, 9ª Revisão (1975); CID-10 (1998, versão do
  DATASUS).
