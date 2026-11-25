#!/usr/bin/env node
// Verifica las operaciones que usa el admin web: saveRecords, deleteRecord, categorías, inventario y dashboard.
//   node scripts/check-web-api.mjs   (usa DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD de .dev.vars)
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const API = process.env.API ?? "http://127.0.0.1:8797";
const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
let token = null;
async function gql(query, variables = {}) {
  const r = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.1.2.3", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
const ok = (m) => console.log("✅", m);

const login = await gql("mutation($e:String!,$p:String!){ login(email:$e,password:$p){ token } }", { e: vars.DEV_ADMIN_EMAIL, p: vars.DEV_ADMIN_PASSWORD });
token = login.login.token;
ok("login");

const id = randomUUID();
const saved = await gql("mutation($c:[RecordInput!]!){ saveRecords(changes:$c) }", { c: [{ table: "categories", row: { id, name: "Prueba web", color: "#6366F1", sequence: 9 } }] });
if (saved.saveRecords[0] !== id) throw new Error("saveRecords no devolvió el id");
ok("saveRecords crea categoría");

const d = await gql(`{ categories { id name productCount } stockMoves(limit: 3) { qty kind product { name } }
  dashboard { daily { date sales orders } heatmap { weekday hour amount count } byMethod { method amount } recent { number total } kpis { key value } } }`);
if (!d.categories.some((c) => c.id === id)) throw new Error("categoría no listada");
ok(`categorías con conteo: ${d.categories.map((c) => `${c.name}(${c.productCount})`).join(", ")}`);
ok(`inventario: ${d.stockMoves.length} movimientos · dashboard: ${d.dashboard.daily.length} días, ${d.dashboard.heatmap.length} celdas heatmap, ${d.dashboard.recent.length} recientes`);

await gql("mutation($t:String!,$id:ID!){ deleteRecord(table:$t, id:$id) }", { t: "categories", id });
const after = await gql("{ categories { id } }");
if (after.categories.some((c) => c.id === id)) throw new Error("deleteRecord no borró");
ok("deleteRecord (borrado lógico)");

try {
  await gql("mutation($c:[RecordInput!]!){ saveRecords(changes:$c) }", { c: [{ table: "__proto__", row: { id: randomUUID() } }] });
  throw new Error("debió rechazar");
} catch (e) {
  if (!String(e).includes("Tabla desconocida")) throw e;
  ok("saveRecords rechaza tablas desconocidas");
}
