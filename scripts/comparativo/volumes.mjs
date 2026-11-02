// Measure the published volumes: raw SIH-RD mirror and the aggregated cubes.
const get = async (u) => (await fetch(u)).json();

const rd = await get("https://data.sidneybissoli.com/sih/rd/manifest.json");
// partitions is an object keyed "YYYY-MM-UF"
const parts = Object.entries(rd.partitions).map(([k, v]) => {
  const [y, m, uf] = k.split("-");
  return { ...v, year: y, month: m, uf };
});
let recs = 0;
for (const p of parts) recs += Number(p.total_records ?? 0);
console.log("rd total records", recs);
let tot = 0;
const byYear = new Map();
const byKey = new Map();
for (const p of parts) {
  const b = Number(p.source_size_bytes ?? 0);
  tot += b;
  const y = Number(p.year ?? p.partition?.year);
  byYear.set(y, (byYear.get(y) ?? 0) + b);
}
const years = [...byYear.keys()].sort();
console.log("rd last_updated", rd.last_updated, "partitions", parts.length, "years", years[0], "-", years.at(-1));
console.log("rd total GiB", (tot / 2 ** 30).toFixed(2));
console.log("rd 2024 MiB", (byYear.get(2024) / 2 ** 20).toFixed(0));

// Files needed for "ES residents admitted in 2024": competences 2024-01..2025-04, all UFs
let n = 0, b16 = 0;
for (const p of parts) {
  const y = Number(p.year), m = Number(p.month);
  if ((y === 2024) || (y === 2025 && m <= 4)) { n++; b16 += Number(p.source_size_bytes ?? 0); }
}
console.log("window 2024-01..2025-04: files", n, "MiB", (b16 / 2 ** 20).toFixed(0));
let es = 0, esb = 0;
for (const p of parts) {
  const y = Number(p.year), m = Number(p.month);
  if (p.uf === "ES" && ((y === 2024) || (y === 2025 && m <= 4))) { es++; esb += Number(p.source_size_bytes ?? 0); }
}
console.log("ES file only, same window: files", es, "MiB", (esb / 2 ** 20).toFixed(1));

const cu = await get("https://data.sidneybissoli.com/sih/cubos/manifest.json");
// Walk every object that has a file name + size, wherever it sits in the manifest
const found = [];
const walk = (o, where) => {
  if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${where}[${i}]`));
  if (o && typeof o === "object") {
    const size = o.size_bytes ?? o.size ?? o.bytes;
    const name = o.file ?? o.path ?? o.name ?? o.filename;
    if (typeof size === "number" && typeof name === "string") found.push({ name, size, where });
    for (const [k, v] of Object.entries(o)) walk(v, `${where}.${k}`);
  }
};
walk(cu, "$");
console.log("cubos generated", cu.generated_at, "years", Object.keys(cu.years ?? {}).length);
const uniq = new Map(found.map((f) => [f.name, f]));
let ct = 0;
for (const f of uniq.values()) ct += f.size;
console.log("cubos files", uniq.size, "GiB", (ct / 2 ** 30).toFixed(2));
for (const f of uniq.values()) if (/resumo|estrato|summary/i.test(f.name)) console.log("  ", f.name, f.size);
console.log("sample", JSON.stringify([...uniq.values()].slice(0, 3)));
