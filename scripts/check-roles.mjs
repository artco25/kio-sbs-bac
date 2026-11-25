#!/usr/bin/env node
// Verifica auto-registro, roles personalizados por empresa y acceso por suite (API + sync).
//   node scripts/check-roles.mjs
import { randomUUID } from "node:crypto";

const API = process.env.API ?? "http://127.0.0.1:8797";
const SYNC = process.env.SYNC ?? "http://127.0.0.1:8798";
const IP = `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(url, query, variables = {}, token) {
  const r = await fetch(`${url}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}
const ok = (m) => console.log("✅", m);
const fail = (m, x) => {
  console.error("❌", m, JSON.stringify(x));
  process.exit(1);
};

const stamp = Date.now();
const pass = "RolesKio2026";
const ME = "me { user { id role roleName } company { id name } suites roleName permissions }";

let r = await call(API, "{ signupEnabled }");
if (r.data?.signupEnabled !== true) fail("signupEnabled", r);

r = await call(API, `mutation($i:SignupInput!){ signup(input:$i){ token ${ME} } }`, {
  i: { companyName: `Tienda Registro ${stamp}`, nit: "901000111-2", city: "Pereira", name: "Dueña Tienda", email: `dueña+${stamp}@kio-sbs.test`.replace("ñ", "n"), password: pass },
});
const owner = r.data?.signup;
if (!owner?.token || owner.me.suites.length !== 5) fail("signup", r);
ok(`auto-registro: empresa "${owner.me.company.name}" con admin y ${owner.me.suites.length} suites`);

r = await call(API, `mutation($i:SignupInput!){ signup(input:$i){ token } }`, { i: { companyName: "Otra", name: "X", email: `dueña+${stamp}@kio-sbs.test`.replace("ñ", "n"), password: pass } });
if (r.errors?.[0]?.extensions?.code !== "CONFLICT") fail("correo duplicado", r);
ok("auto-registro rechaza correo existente");

r = await call(API, "{ suites { key label tables } }", {}, owner.token);
if (r.data?.suites?.length !== 5) fail("catálogo de suites", r);

r = await call(
  API,
  "mutation($i:RoleInput!){ saveRole(input:$i){ id name baseRole suites permissions userCount } }",
  {
    i: {
      name: "Cajero mostrador",
      description: "Sólo caja POS",
      baseRole: "cajero",
      suites: ["pos"],
      permissions: { pos_sessions: "w", sales: "w", sale_lines: "w", payments: "w", stock_moves: "w", products: "r", categories: "r", partners: "r" },
    },
  },
  owner.token,
);
const role = r.data?.saveRole;
if (!role?.id || role.suites[0] !== "pos") fail("saveRole", r);
ok(`rol personalizado "${role.name}" (suite POS)`);

const cashierEmail = `caja+${stamp}@kio-sbs.test`;
r = await call(API, "mutation($i:UserInput!){ createUser(input:$i){ id role roleId roleName } }", { i: { name: "Caja Mostrador", email: cashierEmail, password: pass, role: "vendedor", roleId: role.id } }, owner.token);
if (r.data?.createUser?.roleName !== "Cajero mostrador" || r.data.createUser.role !== "cajero") fail("createUser con rol", r);
ok("usuario creado con el rol personalizado (rol base alineado a cajero)");

r = await call(API, `mutation($e:String!,$p:String!){ login(email:$e,password:$p){ token ${ME} } }`, { e: cashierEmail, p: pass });
const cashier = r.data?.login;
if (!cashier || JSON.stringify(cashier.me.suites) !== '["pos"]' || cashier.me.roleName !== "Cajero mostrador") fail("login cajero", r);
if (cashier.me.permissions.employees.read || cashier.me.permissions.products.write || !cashier.me.permissions.sales.write) fail("permisos efectivos", cashier.me.permissions);
ok("el cajero entra sólo a la suite POS con permisos del rol");

r = await call(API, "{ employees { id } }", {}, cashier.token);
if (r.errors?.[0]?.extensions?.code !== "FORBIDDEN") fail("cajero ve empleados", r);
r = await call(API, "mutation($c:[RecordInput!]!){ saveRecords(changes:$c) }", { c: [{ table: "products", row: { id: randomUUID(), name: "hack", price: 1 } }] }, cashier.token);
if (r.errors?.[0]?.extensions?.code !== "FORBIDDEN") fail("cajero crea productos", r);
r = await call(API, "mutation($c:[RecordInput!]!){ saveRecords(changes:$c) }", { c: [{ table: "pos_sessions", row: { id: randomUUID(), number: "CAJA-X-1", terminal: "X", status: "abierta", opening_cash: 0 } }] }, cashier.token);
if (!r.data?.saveRecords) fail("cajero abre caja", r);
ok("API: no ve nómina ni crea productos; sí abre caja");

r = await call(SYNC, "{ status { role tables } }", {}, cashier.token);
const tables = r.data?.status?.tables ?? [];
if (tables.includes("employees") || !tables.includes("pos_sessions")) fail("sync tablas", r);
ok(`sync: el equipo del cajero sólo baja ${tables.length} tablas (${tables.join(", ")})`);

r = await call(API, "mutation($id:ID!){ deleteRole(id:$id) }", { id: role.id }, owner.token);
if (!r.errors) fail("borrar rol con usuarios", r);
r = await call(API, "{ roles { name userCount } }", {}, owner.token);
if (r.data?.roles?.[0]?.userCount !== 1) fail("roles", r);
ok("no se puede borrar un rol con usuarios asignados");
console.log("🎉 Roles, suites y auto-registro OK");
