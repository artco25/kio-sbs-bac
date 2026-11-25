import { env } from "./env";
import type { Ctx } from "./http";
import { TABLES, type PreparedRow, type Role } from "./sync";

export type Row = Record<string, any>;

export async function all<T = Row>(sql: string, ...binds: unknown[]): Promise<T[]> {
  const r = await env.DB.prepare(sql).bind(...binds).all<T>();
  return r.results ?? [];
}
export async function one<T = Row>(sql: string, ...binds: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql).bind(...binds).first<T>();
}

export const limit = (v: unknown, def = 50, max = 500) => Math.min(Math.max(Math.trunc(Number(v)) || def, 1), max);
export const offset = (v: unknown) => Math.max(Math.trunc(Number(v)) || 0, 0);
export const like = (s: unknown) => (typeof s === "string" && s.trim() ? `%${s.trim().replace(/[%_]/g, "")}%` : null);
/** Fecha de hoy en Colombia (UTC−5). */
export const today = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

/** Columnas públicas de usuarios (nunca exponer password_hash ni contadores de bloqueo). */
export const USER_COLS = "id, company_id, name, email, role, employee_id, pos_terminal, active, last_login_at, created_at";

// ------------------------------------------------------------------ loaders por request (evitan N+1)

type Waiter = { ok: (rows: Row[]) => void; fail: (e: unknown) => void };
interface Batch {
  keys: Set<string>;
  waiters: Waiter[];
}
type CtxCache = Ctx & { _cache?: Map<string, Promise<any>>; _batches?: Map<string, Batch> };

const CHUNK = 90; // D1 admite 100 parámetros por sentencia

function batched(ctx: CtxCache, batchKey: string, key: string, run: (keys: string[]) => Promise<Row[]>): Promise<Row[]> {
  ctx._batches ??= new Map();
  let b = ctx._batches.get(batchKey);
  if (!b) {
    const batch: Batch = { keys: new Set(), waiters: [] };
    b = batch;
    ctx._batches.set(batchKey, batch);
    // Los resolvers hermanos se invocan de forma síncrona; se agrupan en una sola consulta.
    Promise.resolve().then(async () => {
      ctx._batches!.delete(batchKey);
      const keys = [...batch.keys];
      const rows: Row[] = [];
      try {
        for (let i = 0; i < keys.length; i += CHUNK) rows.push(...(await run(keys.slice(i, i + CHUNK))));
        batch.waiters.forEach((w) => w.ok(rows));
      } catch (e) {
        // Un fallo de D1 debe verse como error, nunca como "sin líneas / sin pagos".
        batch.waiters.forEach((w) => w.fail(e));
      }
    });
  }
  b.keys.add(key);
  return new Promise((ok, fail) => b!.waiters.push({ ok, fail }));
}

export function cached<T>(ctx: CtxCache, key: string, make: () => Promise<T>): Promise<T> {
  ctx._cache ??= new Map();
  if (!ctx._cache.has(key)) ctx._cache.set(key, make());
  return ctx._cache.get(key)!;
}

const tableOk = (t: string) => t === "users" || !!TABLES[t];

/** Registro por id dentro de la empresa del usuario. */
export function byId(ctx: Ctx, table: string, id: unknown): Promise<Row | null> | null {
  if (!id || typeof id !== "string" || !ctx.user || !tableOk(table)) return null;
  const companyId = ctx.user.company_id;
  // Fuera de admin, de otros usuarios sólo se expone id, nombre y rol.
  const cols = table !== "users" ? "*" : ctx.user.role === "admin" ? USER_COLS : "id, company_id, name, role, 1 AS active";
  const extra = table === "users" ? "" : " AND deleted = 0";
  return cached(ctx as CtxCache, `id:${table}:${id}`, async () => {
    const rows = await batched(ctx as CtxCache, `id:${table}`, id, (ids) =>
      all(`SELECT ${cols} FROM ${table} WHERE company_id = ? AND id IN (${ids.map(() => "?").join(",")})${extra}`, companyId, ...ids),
    );
    const row = rows.find((r) => r.id === id) ?? null;
    if (row && table === "users" && ctx.user!.role !== "admin" && row.id === ctx.user!.id) row.email = ctx.user!.email;
    return row;
  });
}

/** Hijos por llave foránea (ej. sale_lines por sale_id). */
export function children(ctx: Ctx, table: string, fk: string, parentId: string, order = "created_at"): Promise<Row[]> {
  if (!ctx.user || !TABLES[table] || !(fk in TABLES[table].columns)) return Promise.resolve([]);
  const companyId = ctx.user.company_id;
  return cached(ctx as CtxCache, `ch:${table}:${fk}:${parentId}`, async () => {
    const rows = await batched(ctx as CtxCache, `ch:${table}:${fk}`, parentId, (ids) =>
      all(
        `SELECT * FROM ${table} WHERE company_id = ? AND deleted = 0 AND ${fk} IN (${ids.map(() => "?").join(",")}) ORDER BY ${order}`,
        companyId,
        ...ids,
      ),
    );
    return rows.filter((r) => r[fk] === parentId);
  });
}

/** Convierte una fila existente + cambios en PreparedRow (para escribir con revisión de sync). */
export function patchRow(table: string, row: Row, patch: Row, userId: string, role: Role): PreparedRow {
  const def = TABLES[table];
  // Siempre posterior a la versión guardada: una acción del servidor no puede perder el LWW.
  const stamp = Math.max(Date.now(), (Date.parse(row.updated_at) || 0) + 1);
  const values: PreparedRow["values"] = {
    id: row.id,
    company_id: row.company_id,
    created_at: row.created_at,
    updated_at: new Date(stamp).toISOString(),
    updated_by: userId,
    deleted: row.deleted ?? 0,
  };
  for (const col of Object.keys(def.columns)) values[col] = col in patch ? patch[col] : row[col] ?? null;
  return { table, values, role };
}
