#!/usr/bin/env node
// Autoteste OFFLINE do cache de cubos (src/cache.ts → dist/cache.js): sobe um
// servidor HTTP local com um manifesto e arquivos de mentira e prova que
//   1. ensureYears() baixa um ano inteiro e aceita quando tamanho e SHA-256 batem;
//   2. arquivo adulterado no canal é RECUSADO e não sobra nada na pasta;
//   3. sem rede, o manifesto vem da cópia em disco (source = "disk");
//   4. yearsFromArgs() lê year/years/start_year..end_year e devolve null sem ano;
//   5. ensurePopulation() (0.12.0) baixa os três pop_*.parquet + pop_provenance.json
//      do bloco `population`, é idempotente, RECUSA arquivo adulterado e responde
//      available=false quando o manifesto não tem o bloco (canal anterior a 1.2.0);
//   6. ensureSidecars() confere o sidecar já presente por SHA-256, e não só pelo
//      tamanho: desde 10/09/2026 os 34 sidecars vêm PRÉ-ASSADOS na imagem do
//      container, e um sidecar reescrito por um rebuild que por acaso mantenha o
//      mesmo número de bytes passaria batido pela checagem de tamanho — a
//      resposta sairia com a nota de era do build anterior.
// Sem tocar em data.sidneybissoli.com — o CI roda isto sem rede externa.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

const site = mkdtempSync(join(tmpdir(), "sih-canal-"));
const cache = mkdtempSync(join(tmpdir(), "sih-cache-"));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const files = {};
const mk = (name, content) => {
  const buf = Buffer.from(content);
  writeFileSync(join(site, name), buf);
  files[name] = { name, size_bytes: buf.length, sha256: sha(buf) };
};
mk("sih_causas_2001.parquet", "causas-2001");
mk("sih_series_2001.parquet", "series-2001");
mk("sih_icsap_2001.parquet", "icsap-2001");
mk("sih_provenance_2001.json", JSON.stringify({ cube_year: 2001 }));
mk("sih_causas_2002.parquet", "causas-2002");
mk("sih_series_2002.parquet", "series-2002");
mk("sih_icsap_2002.parquet", "icsap-2002");
mk("sih_provenance_2002.json", JSON.stringify({ cube_year: 2002 }));
mk("pop_uf.parquet", "pop-uf");
mk("pop_uf_agregado.parquet", "pop-uf-agregado");
mk("pop_municipios.parquet", "pop-municipios");
mk("pop_provenance.json", JSON.stringify({ built_at: "2026-09-08T00:00:00Z", last_year: 2025 }));
const manifest = {
  manifest_version: "1.2.0",
  dataset: "sih/cubos",
  generated_at: new Date().toISOString(),
  base_url: "http://local/",
  population: {
    built_at: "2026-09-08T00:00:00Z", builder_version: "1.0.0", last_year: 2025,
    files: { pop_uf: files["pop_uf.parquet"], pop_uf_agregado: files["pop_uf_agregado.parquet"], pop_municipios: files["pop_municipios.parquet"], provenance: files["pop_provenance.json"] },
  },
  years: {
    2001: { built_at: null, builder_version: "t", records_in_cube: 1, window_complete: true, ufs: 1, manifest_last_updated: null,
      files: { causas: files["sih_causas_2001.parquet"], series: files["sih_series_2001.parquet"], icsap: files["sih_icsap_2001.parquet"], provenance: files["sih_provenance_2001.json"] } },
    2002: { built_at: null, builder_version: "t", records_in_cube: 1, window_complete: true, ufs: 1, manifest_last_updated: null,
      files: { causas: files["sih_causas_2002.parquet"], series: files["sih_series_2002.parquet"], icsap: files["sih_icsap_2002.parquet"], provenance: files["sih_provenance_2002.json"] } },
  },
};
// 2002 sai adulterado no "canal": MESMO tamanho (11 bytes), conteúdo diferente —
// só o SHA-256 pega (o tamanho é a primeira barreira, esta prova a segunda)
writeFileSync(join(site, "sih_causas_2002.parquet"), "causas-2OO2");
writeFileSync(join(site, "manifest.json"), JSON.stringify(manifest));

const server = createServer((req, res) => {
  // o cliente anexa ?v=<sha256> (chave de cache por versão) — o "canal" ignora a query
  const name = decodeURIComponent((req.url ?? "/").replace(/^\/+/, "").replace(/\?.*$/, ""));
  const p = join(site, name);
  if (!existsSync(p)) { res.statusCode = 404; return res.end("nao existe"); }
  res.end(readFileSync(p));
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
process.env.SIH_CUBES_BASE_URL = `http://127.0.0.1:${port}/`;
process.env.SIH_CACHE_DIR = cache;
delete process.env.SIH_CUBES_CACHE;

const mod = await import(new URL("../dist/cache.js", import.meta.url).href);

// 4. yearsFromArgs
ok(JSON.stringify(mod.yearsFromArgs({ year: [2023, 2019] })) === "[2019,2023]", "yearsFromArgs: year[]");
ok(JSON.stringify(mod.yearsFromArgs({ start_year: 2020, end_year: 2022 })) === "[2020,2021,2022]", "yearsFromArgs: start..end");
ok(JSON.stringify(mod.yearsFromArgs({ years: 2021 })) === "[2021]", "yearsFromArgs: years escalar");
ok(mod.yearsFromArgs({ uf: ["RR"] }) === null, "yearsFromArgs: sem ano = null");

// 1. download íntegro
const r1 = await mod.ensureYears(cache, [2001]);
ok(JSON.stringify(r1.downloaded) === "[2001]", "ensureYears baixou 2001");
ok(["sih_causas_2001.parquet", "sih_series_2001.parquet", "sih_icsap_2001.parquet", "sih_provenance_2001.json"].every((f) => existsSync(join(cache, f))), "2001: quatro arquivos no cache");
ok(JSON.stringify(mod.yearsPresent(cache)) === "[2001]", "yearsPresent vê 2001");
const r1b = await mod.ensureYears(cache, [2001]);
ok(r1b.downloaded.length === 0, "segunda chamada não baixa de novo");

// 2. adulterado é recusado
let erro = null;
try { await mod.ensureYears(cache, [2002]); } catch (e) { erro = String(e.message ?? e); }
ok(erro !== null && /SHA-256/.test(erro), `2002 adulterado recusado: ${erro}`);
ok(!existsSync(join(cache, "sih_causas_2002.parquet")) && !readdirSync(cache).some((f) => f.includes(".part-")), "2002: nada ficou no cache (nem .part)");

// ano fora do canal
const r3 = await mod.ensureYears(cache, [1999]);
ok(JSON.stringify(r3.unavailable) === "[1999]", "ano fora do canal vai para unavailable");

// 4b. cache ciente do TIPO (0.14.1): pedir só séries baixa só séries + sidecar
const cacheKinds = mkdtempSync(join(tmpdir(), "sih-cache-kinds-"));
const rk = await mod.ensureYears(cacheKinds, [2001], undefined, ["series"]);
ok(JSON.stringify(rk.downloaded) === "[2001]", "kinds=[series]: baixou 2001");
ok(existsSync(join(cacheKinds, "sih_series_2001.parquet")) && existsSync(join(cacheKinds, "sih_provenance_2001.json")), "kinds=[series]: série + sidecar presentes");
ok(!existsSync(join(cacheKinds, "sih_causas_2001.parquet")) && !existsSync(join(cacheKinds, "sih_icsap_2001.parquet")), "kinds=[series]: causas e icsap NÃO baixados");
ok(JSON.stringify(mod.yearsPresent(cacheKinds, ["series"])) === "[2001]" && JSON.stringify(mod.yearsPresent(cacheKinds)) === "[]", "yearsPresent por tipo: série sim, os três não");
const rk2 = await mod.ensureYears(cacheKinds, [2001], undefined, ["series"]);
ok(rk2.downloaded.length === 0, "kinds=[series]: segunda chamada não baixa de novo");
const rk3 = await mod.ensureYears(cacheKinds, [2001], undefined, ["icsap"]);
ok(rk3.downloaded.length === 1 && existsSync(join(cacheKinds, "sih_icsap_2001.parquet")), "kinds=[icsap] depois: completa só o icsap");
rmSync(cacheKinds, { recursive: true, force: true });

// 6. sidecars: o que já está na pasta é conferido por SHA-256, não só por tamanho
const cacheSide = mkdtempSync(join(tmpdir(), "sih-cache-side-"));
const s1 = await mod.ensureSidecars(cacheSide, [2001]);
ok(JSON.stringify(s1.downloaded) === "[2001]", "sidecars: pasta vazia baixa o ano");
const s2 = await mod.ensureSidecars(cacheSide, [2001]);
ok(s2.downloaded.length === 0, "sidecars: segunda chamada não baixa de novo");
// PRÉ-ASSADO E VELHO: mesmo TAMANHO (18 bytes), conteúdo diferente. Só o
// SHA-256 pega; com a checagem de tamanho, a nota de era sairia do build velho.
const cacheAssado = mkdtempSync(join(tmpdir(), "sih-cache-assado-"));
const bom = JSON.stringify({ cube_year: 2001 });
const velho = '{"cube_year":2OO1}';
ok(velho.length === bom.length, `sidecar adulterado tem o mesmo tamanho (${velho.length} bytes)`);
writeFileSync(join(cacheAssado, "sih_provenance_2001.json"), velho);
const s3 = await mod.ensureSidecars(cacheAssado, [2001]);
ok(JSON.stringify(s3.downloaded) === "[2001]", "sidecar pré-assado VELHO é recusado e rebaixado do canal");
ok(readFileSync(join(cacheAssado, "sih_provenance_2001.json"), "utf8") === bom, "sidecar pré-assado velho foi SUBSTITUÍDO pelo do canal");
const s4 = await mod.ensureSidecars(cacheAssado, [2001]);
ok(s4.downloaded.length === 0, "sidecar já conferido não é baixado a cada chamada");
rmSync(cacheSide, { recursive: true, force: true });
rmSync(cacheAssado, { recursive: true, force: true });

// 7. DESSINCRONIA CUBO × SIDECAR (decisão 57, 1.8.0). O ano é a unidade: o
// bloco de proveniência sai do sidecar, a soma sai do cubo, e os dois têm de
// ser do MESMO build. Até a 1.7.1 o cache não atualizava cubo presente
// (yearsPresent só olhava existência; ensureYear, só tamanho), enquanto
// ensureSidecars rebaixava o sidecar quando o sha mudava — depois de um
// rebuild, a chamada pelo resumo trazia o sidecar novo (T1) e a chamada pelo
// cubo somava o cubo velho (T0) publicando a proveniência de T1.
const cacheSync = mkdtempSync(join(tmpdir(), "sih-cache-sync-"));
const m0 = await mod.loadCubesManifest();
await mod.ensureYears(cacheSync, [2001], undefined, ["series"]);
await mod.ensureYears(cacheSync, [2001], undefined, ["icsap"]);
const icsapT0 = readFileSync(join(cacheSync, "sih_icsap_2001.parquet"), "utf8");
// Rebuild no canal: 2001 muda (série com OUTRO tamanho, icsap com o MESMO
// tamanho — só o SHA-256 pega —, sidecar novo); 2002 não existe neste cache.
const rebuild = (name, content) => {
  const buf = Buffer.from(content);
  writeFileSync(join(site, name), buf);
  return { name, size_bytes: buf.length, sha256: sha(buf) };
};
const t1 = structuredClone(m0.manifest);
t1.years[2001].files.series = rebuild("sih_series_2001.parquet", "series-2001-T1");
t1.years[2001].files.icsap = rebuild("sih_icsap_2001.parquet", "icsap-20O1");
t1.years[2001].files.provenance = rebuild("sih_provenance_2001.json", JSON.stringify({ cube_year: 2001, build: "T1" }));
ok(t1.years[2001].files.icsap.size_bytes === Buffer.byteLength(icsapT0), "icsap de T1 tem o mesmo tamanho do de T0");
mod.setCubesManifestForTests(t1);
// Caminho do resumo primeiro (só o sidecar), depois o caminho do cubo.
await mod.ensureSidecars(cacheSync, [2001]);
const rs = await mod.ensureYears(cacheSync, [2001], undefined, ["series"]);
ok(JSON.stringify(rs.downloaded) === "[2001]", "cubo de série mudou na fonte: ensureYears rebaixa o ano");
ok(readFileSync(join(cacheSync, "sih_series_2001.parquet"), "utf8") === "series-2001-T1", "série no cache = a de T1 (mesmo build do sidecar)");
const ri = await mod.ensureYears(cacheSync, [2001], undefined, ["icsap"]);
ok(JSON.stringify(ri.downloaded) === "[2001]" && readFileSync(join(cacheSync, "sih_icsap_2001.parquet"), "utf8") === "icsap-20O1", "cubo de mesmo TAMANHO e outro SHA-256 também é rebaixado");
ok(JSON.parse(readFileSync(join(cacheSync, "sih_provenance_2001.json"), "utf8")).build === "T1", "sidecar no cache = T1");
const rq = await mod.ensureYears(cacheSync, [2001], undefined, ["series", "icsap"]);
ok(rq.downloaded.length === 0, "ano já conferido contra o manifesto não é baixado de novo");
// Ordem inversa: o caminho do cubo traz o PAR, não só o cubo.
const cacheSync2 = mkdtempSync(join(tmpdir(), "sih-cache-sync2-"));
mod.setCubesManifestForTests(m0.manifest);
writeFileSync(join(site, "sih_series_2001.parquet"), "series-2001");
writeFileSync(join(site, "sih_provenance_2001.json"), JSON.stringify({ cube_year: 2001 }));
await mod.ensureYears(cacheSync2, [2001], undefined, ["series"]);
writeFileSync(join(site, "sih_series_2001.parquet"), "series-2001-T1");
writeFileSync(join(site, "sih_provenance_2001.json"), JSON.stringify({ cube_year: 2001, build: "T1" }));
mod.setCubesManifestForTests(t1);
await mod.ensureYears(cacheSync2, [2001], undefined, ["series"]);
ok(JSON.parse(readFileSync(join(cacheSync2, "sih_provenance_2001.json"), "utf8")).build === "T1", "caminho do cubo rebaixa o sidecar junto (o par)");
rmSync(cacheSync, { recursive: true, force: true });
rmSync(cacheSync2, { recursive: true, force: true });
// devolve o canal a T0 para os casos seguintes
writeFileSync(join(site, "sih_series_2001.parquet"), "series-2001");
writeFileSync(join(site, "sih_icsap_2001.parquet"), "icsap-2001");
writeFileSync(join(site, "sih_provenance_2001.json"), JSON.stringify({ cube_year: 2001 }));
mod.setCubesManifestForTests(m0.manifest);

// 5. população: baixa os quatro, idempotente, verifica SHA-256, e "sem bloco" = available=false
ok(mod.populationPresent(cache) === false, "populationPresent: cache sem população");
const p1 = await mod.ensurePopulation(cache);
ok(p1.available === true && p1.downloaded.length === 4, `ensurePopulation baixou 4 arquivos (${p1.downloaded.join(", ")})`);
ok(["pop_uf.parquet", "pop_uf_agregado.parquet", "pop_municipios.parquet", "pop_provenance.json"].every((f) => existsSync(join(cache, f))), "população: quatro arquivos no cache");
ok(mod.populationPresent(cache) === true, "populationPresent vê os três Parquet");
const p2 = await mod.ensurePopulation(cache);
ok(p2.downloaded.length === 0 && p2.available === true, "segunda chamada não baixa a população de novo");
// adulterado no canal: MESMO tamanho (6 bytes), conteúdo diferente; apaga a cópia local para forçar o download
writeFileSync(join(site, "pop_uf.parquet"), "pop-Uf");
rmSync(join(cache, "pop_uf.parquet"));
let erroPop = null;
try { await mod.ensurePopulation(cache); } catch (e) { erroPop = String(e.message ?? e); }
ok(erroPop !== null && /SHA-256/.test(erroPop), `pop_uf adulterado recusado: ${erroPop}`);
ok(!existsSync(join(cache, "pop_uf.parquet")) && !readdirSync(cache).some((f) => f.includes(".part-")), "pop_uf: nada ficou no cache (nem .part)");
// manifesto sem o bloco (canal anterior à população): não é erro
mod.setCubesManifestForTests({ ...manifest, population: null });
const p3 = await mod.ensurePopulation(cache);
ok(p3.available === false && p3.downloaded.length === 0, "manifesto sem population → available=false, sem download");
mod.setCubesManifestForTests(null);
await mod.loadCubesManifest();

// 3. sem rede: manifesto da cópia em disco
server.close();
await new Promise((r) => setTimeout(r, 100));
mod.setCubesManifestForTests(null);
const m3 = await mod.loadCubesManifest({ timeoutMs: 1500 });
ok(m3.source === "disk" && m3.manifest && Object.keys(m3.manifest.years).length === 2, `sem rede: manifesto do disco (source=${m3.source})`);

rmSync(site, { recursive: true, force: true });
rmSync(cache, { recursive: true, force: true });
console.log(failures === 0 ? "CACHE SELFTEST OK" : `CACHE SELFTEST FALHOU: ${failures} caso(s)`);
process.exit(failures === 0 ? 0 : 1);
