import spec from "../../schema/tables.json";
import { nowIso } from "./crypto";

export type Role = "admin" | "contador" | "cajero" | "vendedor";
export const ROLES = spec.roles as Role[];
type ColType = "text" | "int" | "real" | "bool";

export interface TableDef {
  label: string;
  axis: string;
  read: "*" | Role[];
  write: Role[];
  columns: Record<string, ColType>;
}

export const TABLES = spec.tables as unknown as Record<string, TableDef>;
export const TABLE_NAMES = Object.keys(TABLES);
export const isTable = (t: unknown): t is string => typeof t === "string" && Object.hasOwn(TABLES, t);

/** Límite por request de push: D1 (plan free) permite 50 consultas por invocación. */
export const MAX_PUSH = 40;
/** Ventana máxima de revisiones por pull. */
export const MAX_PULL = 1000;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/;
export const APPROVERS: Role[] = ["admin", "contador"];
export const isApprover = (role: Role) => APPROVERS.includes(role);

/** Quién accede: rol base y, si tiene rol personalizado de la empresa, su matriz de permisos. */
export interface Principal {
  role: Role;
  perms?: Record<string, "r" | "w"> | null;
}

export const canRead = (p: Principal, table: string) => {
  if (!isTable(table)) return false;
  if (p.perms) return p.perms[table] === "r" || p.perms[table] === "w";
  const def = TABLES[table];
  return def.read === "*" || def.read.includes(p.role);
};
export const canWrite = (p: Principal, table: string) => {
  if (!isTable(table)) return false;
  if (p.perms) return p.perms[table] === "w";
  return TABLES[table].write.includes(p.role);
};

// ------------------------------------------------------------------ reglas de negocio por rol

/**
 * Para roles que NO aprueban (cajero, vendedor): condición sobre la fila YA guardada (alias `t`)
 * para poder modificarla. Así un documento en estado final no se altera desde un equipo de caja.
 */
const LOCK_FOR_OPERATORS: Record<string, string> = {
  sales: "t.status NOT IN ('confirmada', 'anulada')",
  sale_lines: "NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = t.sale_id AND s.company_id = t.company_id AND s.status IN ('confirmada', 'anulada'))",
  payments: "0",
  stock_moves: "0",
  pos_sessions: "t.status <> 'cerrada'",
  expenses: "t.status IN ('borrador', 'enviada')",
};
/** Columnas que un operador sí puede cambiar aunque el documento esté en estado final (pantalla de cocina). */
const ALWAYS_EDITABLE: Record<string, string[]> = {
  sales: ["kitchen_status", "delivery_status", "delivery_collected_at", "delivery_collected_amount"],
};
/** Columnas que sólo administrador/contador pueden fijar. */
const APPROVER_ONLY: Record<string, string[]> = {
  partners: ["credit_limit", "blocked", "seller_id", "payment_term_days"],
  expenses: ["approved_by", "approved_at"],
  products: [],
};
/** Columnas que el servidor estampa con el usuario autenticado cuando las envía un operador. */
const OWNER_COLS: Record<string, string> = { payments: "user_id", pos_sessions: "user_id", expenses: "requested_by", sales: "seller_id" };
/** Montos que no pueden ser negativos. */
const NON_NEGATIVE: Record<string, string[]> = {
  sales: ["subtotal", "tax_total", "total", "discount_total"],
  sale_lines: ["qty", "price", "subtotal", "tax", "total"],
  payments: ["amount"],
  expenses: ["amount", "tax"],
  products: ["price", "cost"],
  warehouse_stocks: ["qty", "min_qty"],
  partners: ["credit_limit"],
  employees: ["salary"],
};
const TEXT_LIMIT: Record<string, number> = { detail: 100_000, notes: 8_000 };

export interface SyncUser extends Principal {
  id: string;
  company_id: string;
}

export interface PreparedRow {
  table: string;
  values: Record<string, string | number | null>;
  /** Rol de quien escribe: determina las reglas de bloqueo del upsert. */
  role: Role;
}

export interface Rejection {
  table: string;
  id: string | null;
  reason: string;
}

function coerce(type: ColType, v: unknown): string | number | null {
  switch (type) {
    case "text":
      return v === null || v === undefined ? null : String(v);
    case "int": {
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? n : 0;
    }
    case "real": {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    case "bool":
      return v === true || v === 1 || v === "1" || v === "true" ? 1 : 0;
  }
}

/** Sólo marcas ISO con zona (Z u offset). Futuras → ahora (no se puede "ganar" el LWW adelantando el reloj). */
function normTs(v: unknown, fallback: string) {
  if (typeof v !== "string" || !TZ_RE.test(v)) return fallback;
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return fallback;
  return t > Date.now() ? fallback : new Date(t).toISOString();
}

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

/**
 * Desde el POS se permite crear clientes básicos aunque el rol tenga "Contactos" en solo lectura.
 * Sólo vale para filas de cliente (`is_customer=1`, nunca proveedor) y sin campos de cartera/cupo.
 */
function posCustomerWrite(user: SyncUser, table: string, row: Record<string, unknown>) {
  return (
    table === "partners" &&
    !canWrite(user, table) &&
    canWrite(user, "pos_sessions") &&
    truthy(row.is_customer) &&
    !truthy(row.is_supplier) &&
    !truthy(row.deleted) &&
    !("blocked" in row) &&
    !("credit_limit" in row) &&
    !("payment_term_days" in row) &&
    !("seller_id" in row)
  );
}

/** Valida un cambio entrante: tabla, rol, columnas en lista blanca (sólo las presentes) y reglas de negocio. */
export function prepareChange(user: SyncUser, table: string, row: Record<string, unknown>): PreparedRow | Rejection {
  const id = typeof row?.id === "string" ? row.id : null;
  if (!isTable(table)) return { table: String(table).slice(0, 40), id, reason: "Tabla desconocida" };
  const def = TABLES[table];
  const quickCustomer = posCustomerWrite(user, table, row);
  if (!canWrite(user, table) && !quickCustomer) return { table, id, reason: `Tu rol no puede modificar ${def.label}` };
  if (!id || !ID_RE.test(id)) return { table, id, reason: "id inválido" };
  if (quickCustomer) {
    const allowed = new Set(["name", "doc_type", "doc_number", "email", "phone", "address", "city", "is_customer", "is_supplier", "notes", "deleted"]);
    for (const col of Object.keys(row)) {
      if (col in def.columns && !allowed.has(col)) {
        return { table, id, reason: "Desde caja sólo se pueden crear clientes básicos" };
      }
    }
  }

  const approver = isApprover(user.role);
  const now = nowIso();
  const values: PreparedRow["values"] = {
    id,
    company_id: user.company_id, // nunca se confía en el company_id del cliente
    created_at: normTs(row.created_at, now),
    updated_at: normTs(row.updated_at, now),
    updated_by: user.id,
  };
  if ("deleted" in row) values.deleted = coerce("bool", row.deleted);

  // Sólo las columnas que vienen: una app vieja o un cambio parcial no borran columnas que no conoce.
  for (const [col, type] of Object.entries(def.columns)) {
    if (!(col in row)) continue;
    const v = coerce(type, row[col]);
    if (typeof v === "string" && v.length > (TEXT_LIMIT[col] ?? 4000)) return { table, id, reason: `${col} supera el tamaño permitido` };
    values[col] = v;
  }

  for (const col of NON_NEGATIVE[table] ?? []) {
    if (typeof values[col] === "number" && (values[col] as number) < 0) {
      if (table === "payments" && col === "amount" && values.kind === "reembolso") continue;
      return { table, id, reason: `${col} no puede ser negativo` };
    }
  }
  if (table === "sale_lines" && typeof values.discount_pct === "number" && (values.discount_pct < 0 || values.discount_pct > 100)) {
    return { table, id, reason: "El descuento debe estar entre 0 y 100 %" };
  }

  if (!approver) {
    if (table === "expenses" && (values.status === "aprobada" || values.status === "rechazada")) {
      return { table, id, reason: "Sólo administrador o contador aprueban gastos" };
    }
    if (table === "leave_requests" && values.status && values.status !== "solicitada") {
      return { table, id, reason: "Sólo administrador o contador aprueban solicitudes" };
    }
    for (const col of APPROVER_ONLY[table] ?? []) delete values[col];
    const owner = OWNER_COLS[table];
    if (owner && owner in values) values[owner] = user.id;
  } else if (table === "expenses" && values.status === "aprobada" && !values.approved_by) {
    values.approved_by = user.id;
    values.approved_at = now;
  }
  return { table, values, role: user.role };
}

/**
 * Sentencias para un batch transaccional de D1:
 *  1. reserva N revisiones en sync_counter,
 *  2. upsert de cada fila con rev = (contador − offset).
 * Conflictos: cada columna toma el valor entrante sólo si gana el LWW (updated_at más reciente)
 * y la regla de bloqueo del rol lo permite. El rev SIEMPRE avanza, de modo que un cliente cuya
 * escritura perdió recibe la versión ganadora en su próximo pull (no queda divergente).
 * Una fila de otra empresa con el mismo id nunca se toca.
 * Como el batch es atómico, un pull concurrente ve todas las filas o ninguna.
 */
export function upsertStatements(DB: D1Database, companyId: string, rows: PreparedRow[]) {
  const n = rows.length;
  const stmts: D1PreparedStatement[] = [
    DB.prepare(
      "INSERT INTO sync_counter (company_id, value) VALUES (?, ?) ON CONFLICT(company_id) DO UPDATE SET value = value + excluded.value",
    ).bind(companyId, n),
  ];
  rows.forEach((r, i) => {
    const t = r.table;
    const cols = Object.keys(r.values);
    const lww = "excluded.updated_at >= t.updated_at";
    const lock = isApprover(r.role) ? null : LOCK_FOR_OPERATORS[t] ?? null;
    const free = new Set(ALWAYS_EDITABLE[t] ?? []);
    const win = (c: string) => (lock && !free.has(c) ? `(${lww} AND ${lock})` : lww);
    const upd = cols.filter((c) => !["id", "company_id", "created_at", "updated_at", "updated_by"].includes(c));
    const anyWin = lock && free.size ? `(${lww} AND (${lock} OR ${[...free].filter((c) => cols.includes(c)).length ? "1" : "0"}))` : win("_");
    const sets = [
      ...upd.map((c) => `${c} = CASE WHEN ${win(c)} THEN excluded.${c} ELSE t.${c} END`),
      `updated_at = CASE WHEN ${anyWin} THEN excluded.updated_at ELSE t.updated_at END`,
      `updated_by = CASE WHEN ${anyWin} THEN excluded.updated_by ELSE t.updated_by END`,
      "rev = excluded.rev",
    ];
    const sql =
      `INSERT INTO ${t} AS t (${cols.join(", ")}, rev) VALUES (${cols.map(() => "?").join(", ")}, ` +
      `(SELECT value FROM sync_counter WHERE company_id = ?) - ?) ` +
      `ON CONFLICT(id) DO UPDATE SET ${sets.join(", ")} WHERE t.company_id = excluded.company_id`;
    stmts.push(DB.prepare(sql).bind(...cols.map((c) => r.values[c]), companyId, n - 1 - i));
  });
  return stmts;
}

export async function writeRows(DB: D1Database, companyId: string, rows: PreparedRow[]) {
  if (!rows.length) return;
  await DB.batch(upsertStatements(DB, companyId, rows));
}

export async function headRev(DB: D1Database, companyId: string) {
  const r = await DB.prepare("SELECT value FROM sync_counter WHERE company_id = ?").bind(companyId).first<{ value: number }>();
  return r?.value ?? 0;
}

export interface PullResult {
  cursor: number;
  head: number;
  hasMore: boolean;
  reset: boolean;
  changes: { table: string; rows: Record<string, unknown>[] }[];
}

/** Cambios con rev en (since, since+limit] de las tablas que el rol puede leer. */
export async function pullChanges(DB: D1Database, user: SyncUser, since: number, limit: number): Promise<PullResult> {
  const head = await headRev(DB, user.company_id);
  if (since > head) return { cursor: 0, head, hasMore: head > 0, reset: true, changes: [] };
  const upto = Math.min(head, since + Math.max(1, Math.min(limit, MAX_PULL)));
  if (upto <= since) return { cursor: since, head, hasMore: false, reset: false, changes: [] };

  const readable = TABLE_NAMES.filter((t) => canRead(user, t));
  const results = await DB.batch(
    readable.map((t) =>
      DB.prepare(`SELECT * FROM ${t} WHERE company_id = ? AND rev > ? AND rev <= ? ORDER BY rev`).bind(user.company_id, since, upto),
    ),
  );
  const changes = readable
    .map((table, i) => ({ table, rows: (results[i].results ?? []) as Record<string, unknown>[] }))
    .filter((c) => c.rows.length > 0);
  return { cursor: upto, head, hasMore: upto < head, reset: false, changes };
}
