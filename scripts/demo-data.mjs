#!/usr/bin/env node
// Genera ~3 meses de operación de ejemplo para la empresa del admin de desarrollo (D1 LOCAL vía API).
//   node scripts/demo-data.mjs            (usa DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD de .dev.vars)
// Crea clientes, ventas POS y pedidos (con líneas, pagos y movimientos de inventario), cartera vencida,
// gastos de caja menor, sesiones de caja, novedades y solicitudes de vacaciones.
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
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.7.7.7", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
const save = async (changes) => {
  for (let i = 0; i < changes.length; i += 40) {
    await gql("mutation($c:[RecordInput!]!){ saveRecords(changes:$c) }", { c: changes.slice(i, i + 40) });
  }
};

// Aleatorio reproducible
let seed = 20261125;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pad = (n) => String(n).padStart(2, "0");
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const day = (d) => local(d).slice(0, 10);
const iso = () => new Date().toISOString();

const login = await gql("mutation($e:String!,$p:String!){ login(email:$e,password:$p){ token me{ user{ id } company{ name } } } }", {
  e: vars.DEV_ADMIN_EMAIL,
  p: vars.DEV_ADMIN_PASSWORD,
});
token = login.login.token;
const me = login.login.me.user.id;
console.log(`Empresa: ${login.login.me.company.name}`);

const base = await gql("{ products(limit:500){ items{ id name price cost taxRate trackStock } } partners(limit:500){ items{ id name isCustomer creditLimit } } employees{ id name } }");
const products = base.products.items;
if (!products.length) throw new Error("No hay productos: ejecuta primero scripts/dev-seed.sh");

// Clientes adicionales
const NEW_CLIENTS = [
  ["Café La Ventana", "NIT", "901555123-4", "Bogotá", 3_000_000],
  ["Restaurante El Fogón", "NIT", "900777321-9", "Medellín", 6_000_000],
  ["Hotel Plaza Real", "NIT", "800444222-1", "Cali", 10_000_000],
  ["María Fernanda López", "CC", "52123987", "Bogotá", 0],
  ["Supermercado Don Pepe", "NIT", "901888456-2", "Barranquilla", 8_000_000],
  ["Panadería San Jorge", "NIT", "900321654-7", "Bucaramanga", 2_500_000],
];
const clients = NEW_CLIENTS.map(([name, doc_type, doc_number, city, credit_limit]) => ({
  id: randomUUID(),
  name,
  doc_type,
  doc_number,
  city,
  credit_limit,
  is_customer: 1,
  payment_term_days: 30,
  email: `${name.toLowerCase().normalize("NFD").replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")}@ejemplo.co`,
  phone: `3${Math.floor(100000000 + rnd() * 899999999)}`,
}));
await save(clients.map((row) => ({ table: "partners", row })));
const creditClients = [...clients.filter((c) => c.credit_limit > 0), ...base.partners.items.filter((p) => p.creditLimit > 0).map((p) => ({ id: p.id }))];
console.log(`+ ${clients.length} clientes`);

// Sesiones de caja (una por semana) y ventas
const now = new Date();
const docs = [];
let nPos = 0, nPed = 0;
const sessions = [];
for (let w = 12; w >= 0; w--) {
  const open = new Date(now);
  open.setDate(now.getDate() - w * 7);
  open.setHours(7, 0, 0, 0);
  sessions.push({
    id: randomUUID(),
    number: `CAJA-C1-${pad(100 - w)}`,
    terminal: "C1",
    user_id: me,
    opened_at: local(open),
    opening_cash: 200000,
    status: w === 0 ? "abierta" : "cerrada",
    closed_at: w === 0 ? null : local(new Date(open.getTime() + 6 * 86_400_000 + 13 * 3_600_000)),
  });
}

for (let back = 88; back >= 0; back--) {
  const perDay = 2 + Math.floor(rnd() * (back < 30 ? 6 : 4)) + ([5, 6].includes(new Date(now.getTime() - back * 86_400_000).getDay()) ? 3 : 0);
  for (let k = 0; k < perDay; k++) {
    const d = new Date(now);
    d.setDate(now.getDate() - back);
    // Horas pico: mañana y tarde
    const hour = pick([7, 8, 8, 9, 10, 11, 12, 12, 13, 15, 16, 17, 17, 18, 18, 19, 20]);
    d.setHours(hour, Math.floor(rnd() * 60), 0, 0);
    if (d > now) continue;
    const pos = rnd() < 0.78;
    const credit = !pos && rnd() < 0.75;
    const partner = pos ? (rnd() < 0.3 ? pick(clients).id : null) : pick(creditClients).id;
    const nLines = 1 + Math.floor(rnd() * 3);
    const saleId = randomUUID();
    const lines = [];
    let sub = 0, tax = 0;
    for (let l = 0; l < nLines; l++) {
      const p = pick(products);
      const qty = pos ? 1 + Math.floor(rnd() * 3) : 5 + Math.floor(rnd() * 20);
      const s = qty * p.price;
      const t = s * p.taxRate;
      sub += s;
      tax += t;
      lines.push({ p, qty, s, t });
    }
    const total = Math.round(sub + tax);
    const session = sessions.find((ss) => ss.opened_at <= local(d) && (!ss.closed_at || ss.closed_at >= local(d)));
    const due = new Date(d.getTime() + 30 * 86_400_000);
    const changes = [
      {
        table: "sales",
        row: {
          id: saleId,
          number: pos ? `POS-C1-${pad(++nPos).padStart(5, "0")}` : `PED-C1-${pad(++nPed).padStart(5, "0")}`,
          channel: pos ? "pos" : "pedido",
          partner_id: partner,
          seller_id: me,
          pos_session_id: pos ? session?.id ?? null : null,
          date: local(d),
          due_date: credit ? day(due) : null,
          status: "confirmada",
          payment_mode: credit ? "credito" : "contado",
          subtotal: sub,
          discount_total: 0,
          tax_total: tax,
          total,
          updated_at: iso(),
        },
      },
      ...lines.map((l, i) => ({
        table: "sale_lines",
        row: { id: randomUUID(), sale_id: saleId, product_id: l.p.id, name: l.p.name, qty: l.qty, price: l.p.price, discount_pct: 0, tax_rate: l.p.taxRate, subtotal: l.s, tax: l.t, total: l.s + l.t, sequence: i + 1 },
      })),
      ...lines
        .filter((l) => l.p.trackStock)
        .map((l) => ({ table: "stock_moves", row: { id: randomUUID(), product_id: l.p.id, qty: -l.qty, kind: "venta", ref_id: saleId, date: day(d), unit_cost: l.p.cost } })),
    ];
    if (!credit) {
      changes.push({
        table: "payments",
        row: { id: randomUUID(), number: `RC-C1-${saleId.slice(0, 6).toUpperCase()}`, kind: "venta", sale_id: saleId, partner_id: partner, pos_session_id: pos ? session?.id ?? null : null, date: local(d), method: pick(["efectivo", "efectivo", "efectivo", "tarjeta", "nequi", "transferencia"]), amount: total, user_id: me },
      });
    } else if (back > 20 && rnd() < 0.55) {
      // Abono parcial o total a pedidos antiguos
      const abono = rnd() < 0.5 ? total : Math.round(total * (0.3 + rnd() * 0.4));
      const pd = new Date(d.getTime() + (10 + Math.floor(rnd() * 20)) * 86_400_000);
      changes.push({
        table: "payments",
        row: { id: randomUUID(), number: `RC-W-${saleId.slice(0, 6).toUpperCase()}`, kind: "abono", sale_id: saleId, partner_id: partner, date: local(pd > now ? now : pd), method: pick(["transferencia", "transferencia", "efectivo"]), amount: abono, user_id: me },
      });
    }
    docs.push(changes);
  }
}

// Reposición de inventario (entradas) para que no quede negativo
const restock = products
  .filter((p) => p.trackStock)
  .flatMap((p) =>
    [80, 60, 40].map((back, i) => {
      const d = new Date(now.getTime() - back * 86_400_000);
      return { table: "stock_moves", row: { id: randomUUID(), product_id: p.id, qty: 700 + i * 150, kind: "compra", date: day(d), unit_cost: p.cost, notes: "Compra a proveedor" } };
    }),
  );

// Agrupa documentos en lotes de ≤ 40 sin partir una venta
const batches = [];
let cur = [...sessions.map((row) => ({ table: "pos_sessions", row: { ...row, expected_cash: 0, counted_cash: 0, difference: row.status === "cerrada" ? pick([0, 0, 0, -2000, 1500]) : 0 } })), ...restock];
for (const ch of docs) {
  if (cur.length + ch.length > 40) {
    batches.push(cur);
    cur = [];
  }
  cur.push(...ch);
}
if (cur.length) batches.push(cur);
const flat = [];
for (const b of batches) {
  for (let i = 0; i < b.length; i += 40) flat.push(b.slice(i, i + 40));
}
for (const b of flat) await gql("mutation($c:[RecordInput!]!){ saveRecords(changes:$c) }", { c: b });
console.log(`+ ${docs.length} ventas (${nPos} POS, ${nPed} pedidos), ${sessions.length} sesiones de caja, ${restock.length} entradas de inventario`);

// Gastos de caja menor
const CONCEPTS = [
  ["Domicilio de harina", "transporte", 18000],
  ["Papelería y facturas", "papeleria", 42000],
  ["Productos de aseo", "aseo", 65000],
  ["Mantenimiento horno", "mantenimiento", 280000],
  ["Recibo de energía", "servicios", 520000],
  ["Taxi entrega pedido", "transporte", 24000],
  ["Café y azúcar oficina", "aseo", 38000],
  ["Compra de bolsas", "compras", 90000],
];
const expenses = [];
for (let back = 85; back >= 0; back -= 3) {
  const [concept, category, amount] = pick(CONCEPTS);
  const d = new Date(now.getTime() - back * 86_400_000);
  const status = back < 4 ? pick(["enviada", "borrador"]) : back < 10 ? pick(["enviada", "aprobada"]) : rnd() < 0.9 ? "aprobada" : "rechazada";
  expenses.push({
    table: "expenses",
    row: {
      id: randomUUID(),
      number: `CM-C1-${pad(expenses.length + 1).padStart(4, "0")}`,
      date: day(d),
      concept,
      category,
      amount: Math.round(amount * (0.8 + rnd() * 0.5)),
      status,
      requested_by: me,
      ...(status === "aprobada" ? { approved_by: me, approved_at: iso() } : {}),
    },
  });
}
await save(expenses);
console.log(`+ ${expenses.length} gastos de caja menor`);

// Personal: novedades y solicitudes
const emps = base.employees;
if (emps.length) {
  const ym = day(now).slice(0, 7);
  await save([
    { table: "payroll_novelties", row: { id: randomUUID(), employee_id: emps[0].id, period: ym, date: `${ym}-08`, type: "HED", quantity: 6, amount: 0, notes: "Inventario de fin de mes" } },
    { table: "payroll_novelties", row: { id: randomUUID(), employee_id: emps[0].id, period: ym, date: `${ym}-14`, type: "RDF", quantity: 8, amount: 0, notes: "Domingo de feria" } },
    { table: "payroll_novelties", row: { id: randomUUID(), employee_id: emps[emps.length - 1].id, period: ym, date: `${ym}-10`, type: "comision", quantity: 0, amount: 180000, notes: "Comisión ventas institucionales" } },
    { table: "leave_requests", row: { id: randomUUID(), employee_id: emps[0].id, type: "vacaciones", date_from: day(new Date(now.getTime() + 12 * 86_400_000)), date_to: day(new Date(now.getTime() + 18 * 86_400_000)), days: 5, paid: 1, status: "solicitada", notes: "Vacaciones de diciembre" } },
    { table: "leave_requests", row: { id: randomUUID(), employee_id: emps[emps.length - 1].id, type: "permiso", date_from: day(new Date(now.getTime() - 20 * 86_400_000)), date_to: day(new Date(now.getTime() - 20 * 86_400_000)), days: 1, paid: 1, status: "aprobada", approved_by: me, notes: "Cita médica" } },
  ]);
  console.log("+ novedades y solicitudes de personal");
}
console.log("✅ Datos demo listos");
