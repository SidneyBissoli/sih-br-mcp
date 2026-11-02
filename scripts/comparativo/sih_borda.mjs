// Time the pneumonia question (ES residents, admitted 2024, J12-J18) against
// the public sih-br-mcp endpoint, twice in one session (first call may be cold).
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = "https://sih.sidneybissoli.com/mcp";
const client = new Client({ name: "sih-comparativo-medicao", version: "0.0.0" });
const t0 = performance.now();
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
console.log("connect", ((performance.now() - t0) / 1000).toFixed(1), "s");

const args = { uf: ["ES"], year: [2024], cid_chapter: [10], group_by: ["cid_group"] };
for (const label of ["1st", "2nd"]) {
  const t = performance.now();
  const r = await client.callTool({ name: "get_hospitalizations", arguments: args }, { timeout: 600000 });
  const secs = ((performance.now() - t) / 1000).toFixed(2);
  const data = r.structuredContent?.data ?? JSON.parse(r.content[0].text).data;
  const pneu = data.filter((d) => /^J1[2-8]$/.test(d.cid_group));
  const n = pneu.reduce((s, d) => s + d.n_hospitalizations, 0);
  const deaths = pneu.reduce((s, d) => s + d.deaths, 0);
  const bytes = JSON.stringify(r).length;
  console.log(label, secs, "s | pneumonia", n, "deaths", deaths, "| response bytes", bytes);
  if (label === "1st") console.log(pneu.map((d) => `${d.cid_group}=${d.n_hospitalizations}`).join(" "));
}
const st = await (await fetch("https://sih.sidneybissoli.com/status")).json();
console.log("status", JSON.stringify(st).slice(0, 200));
await client.close();
