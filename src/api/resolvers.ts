import { authenticate, gqlError, licenseState, login, normEmail, requireUser, validatePassword, type AuthUser } from "../shared/auth";
import { parseJson, SUITE_KEYS, SUITES } from "../shared/suites";
import { createTenant } from "./provision";
import { hashPassword, nowIso, randomHex, sha256Hex, uuid, verifyPassword } from "../shared/crypto";
import { all, byId, cached, children, like, limit, offset, one, patchRow, today, USER_COLS, type Row } from "../shared/data";
import { env } from "../shared/env";
import type { Ctx } from "../shared/http";
import { canRead, canWrite, MAX_PUSH, prepareChange, ROLES, TABLE_NAMES, writeRows, type PreparedRow, type Role } from "../shared/sync";

type R = (src: any, args: any, ctx: Ctx) => unknown;

const FINANCE: Role[] = ["admin", "contador"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const guardRead = (ctx: Ctx, table: string) => {
  const u = requireUser(ctx.user);
  if (!canRead(u, table)) throw gqlError("No tienes permiso para consultar esta información", "FORBIDDEN");
  return u;
};
const guardWrite = (ctx: Ctx, table: string) => {
  const u = requireUser(ctx.user);
  if (!canWrite(u, table)) throw gqlError("No tienes permiso para modificar esta información", "FORBIDDEN");
  return u;
};

const meOf = async (user: AuthUser) => ({
  user: await one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, user.id),
  company: await one("SELECT * FROM companies WHERE id = ?", user.company_id),
  permissions: Object.fromEntries(TABLE_NAMES.map((t) => [t, { read: canRead(user, t), write: canWrite(user, t) }])),
  suites: user.suites,
  roleName: user.role_name,
  platformRole: user.platform_role,
});

const roleOut = (r: Row) => ({
  ...r,
  base_role: r.base_role,
  suites: parseJson<string[]>(r.suites, []),
  permissions: parseJson<Record<string, string>>(r.permissions, {}),
  user_count: r.user_count ?? 0,
});
const USER_SELECT = `SELECT u.id, u.company_id, u.name, u.email, u.role, u.employee_id, u.pos_terminal, u.active, u.last_login_at, u.created_at, u.platform_role, u.site_id,
       u.role_id, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id AND r.company_id = u.company_id`;

/** CTE de cartera: saldo por venta a crédito confirmada. Parámetro ?1 = company_id. */
const RECV_CTE = `
  WITH paid AS (
    SELECT sale_id, SUM(amount) AS paid FROM payments
     WHERE company_id = ?1 AND deleted = 0 AND sale_id IS NOT NULL AND kind IN ('venta', 'abono', 'reembolso') GROUP BY sale_id
  ), recv AS (
    SELECT s.id, s.partner_id, NULLIF(s.due_date, '') AS due_date, s.total - COALESCE(paid.paid, 0) AS balance
      FROM sales s LEFT JOIN paid ON paid.sale_id = s.id
     WHERE s.company_id = ?1 AND s.deleted = 0 AND s.status = 'confirmada' AND s.payment_mode = 'credito'
  )`;

const boolArg = (v: unknown) => (v === true ? 1 : v === false ? 0 : null);
const dayAfter = (d: string) => new Date(new Date(`${d}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const PLATFORM_RANK: Record<string, number> = { viewer: 1, admin: 2, owner: 3 };
function requirePlatform(user: AuthUser | null, min: 'viewer' | 'admin' | 'owner' = 'viewer'): AuthUser {
  const u = requireUser(user);
  const rank = u.platform_role ? (PLATFORM_RANK[u.platform_role] ?? 0) : 0;
  if (rank < PLATFORM_RANK[min]) throw gqlError('No tienes acceso a la plataforma', 'FORBIDDEN');
  return u;
}


// ------------------------------------------------------------------ Licencias (plataforma)

const newLicenseKey = () => {
  const h = randomHex(12).toUpperCase();
  return `KIO-${h.slice(0, 6)}-${h.slice(6, 12)}-${h.slice(12, 18)}-${h.slice(18, 24)}`;
};

const licenseOut = async (r: Row) => {
  const state = licenseState({ status: String(r.status), starts_at: (r.starts_at as string) ?? null, ends_at: (r.ends_at as string) ?? null });
  let devicesUsed: number | null = null;
  let usersUsed: number | null = null;
  if (r.company_id) {
    devicesUsed = (await one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE company_id = ?", r.company_id))?.n ?? 0;
    usersUsed = (await one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = 1 AND platform_role IS NULL", r.company_id))?.n ?? 0;
  } else {
    const usage = parseJson<{ devices?: number; users?: number }>(r.last_usage, {});
    devicesUsed = usage.devices ?? null;
    usersUsed = usage.users ?? null;
  }
  return {
    ...r,
    modules: r.modules ? parseJson<string[]>(r.modules, []) : null,
    state: state ? state.code.replace("LICENSE_", "").toLowerCase() : "active",
    state_message: state?.message ?? null,
    devices_used: devicesUsed,
    users_used: usersUsed,
  };
};

const LICENSE_SELECT = `SELECT l.*, c.name AS company_name FROM licenses l LEFT JOIN companies c ON c.id = l.company_id`;

function licenseFields(input: any) {
  const date = (v: unknown, label: string) => {
    if (v == null || v === "") return null;
    if (!isDate(v)) throw gqlError(`${label} inválida (usa AAAA-MM-DD)`);
    return v;
  };
  const int = (v: unknown, label: string) => {
    if (v == null || v === "") return null;
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > 100000) throw gqlError(`${label} debe ser un número mayor a 0`);
    return n;
  };
  const startsAt = date(input.startsAt, "La fecha de inicio");
  const endsAt = date(input.endsAt, "La fecha de fin");
  if (startsAt && endsAt && endsAt < startsAt) throw gqlError("La fecha de fin no puede ser anterior a la de inicio");
  let modules: string | null = null;
  if (Array.isArray(input.modules) && input.modules.length) {
    const m = [...new Set(input.modules as string[])];
    if (m.some((x) => !SUITE_KEYS.includes(x as never))) throw gqlError("Módulo no válido en la licencia");
    modules = JSON.stringify(m);
  }
  return {
    startsAt,
    endsAt,
    maxDevices: int(input.maxDevices, "El máximo de cajas"),
    maxUsers: int(input.maxUsers, "El máximo de usuarios"),
    modules,
    notes: input.notes == null ? null : String(input.notes).slice(0, 500),
    status: input.status === "suspended" ? "suspended" : "active",
  };
}

// ------------------------------------------------------------------ Query

const Query: Record<string, R> = {
  me: async (_s, _a, ctx) => meOf(requireUser(ctx.user)),
  company: async (_s, _a, ctx) => one("SELECT * FROM companies WHERE id = ?", requireUser(ctx.user).company_id),
  users: async (_s, _a, ctx) => {
    const u = requireUser(ctx.user, ["admin"]);
    return all(`${USER_SELECT} WHERE u.company_id = ? ORDER BY u.name`, u.company_id);
  },
  // Para el POS: sólo nombre/rol, sin correo ni datos sensibles.
  posUsers: async (_s, _a, ctx) => {
    const u = requireUser(ctx.user);
    return all("SELECT id, name, role FROM users WHERE company_id = ? AND active = 1 ORDER BY name", u.company_id);
  },
  roles: async (_s, _a, ctx) => {
    const u = requireUser(ctx.user, ["admin"]);
    const rows = await all(
      `SELECT r.*, (SELECT COUNT(*) FROM users x WHERE x.role_id = r.id AND x.company_id = r.company_id) AS user_count
         FROM roles r WHERE r.company_id = ? ORDER BY r.name`,
      u.company_id,
    );
    return rows.map(roleOut);
  },
  suites: () => SUITE_KEYS.map((key) => ({ key, label: SUITES[key].label, tables: SUITES[key].tables })),
  signupEnabled: () => env.ALLOW_SIGNUP === "true",
  devices: async (_s, _a, ctx) => {
    const u = requireUser(ctx.user, ["admin"]);
    return all("SELECT * FROM devices WHERE company_id = ? ORDER BY last_sync_at DESC", u.company_id);
  },
  sites: async (_s, _a, ctx) => {
    const u = guardRead(ctx, "sites");
    return all("SELECT * FROM sites WHERE company_id = ? AND deleted = 0 ORDER BY is_default DESC, name", u.company_id);
  },
  warehouses: async (_s, a, ctx) => {
    const u = guardRead(ctx, "warehouses");
    return all(
      "SELECT * FROM warehouses WHERE company_id = ? AND deleted = 0 AND (? IS NULL OR site_id = ?) ORDER BY is_default DESC, name",
      u.company_id,
      a.siteId ?? null,
      a.siteId ?? null,
    );
  },
  warehouseStocks: async (_s, a, ctx) => {
    const u = guardRead(ctx, "warehouse_stocks");
    return all(
      `SELECT * FROM warehouse_stocks
       WHERE company_id = ? AND deleted = 0
         AND (? IS NULL OR warehouse_id = ?)
         AND (? IS NULL OR product_id = ?)
         AND (? IS NULL OR site_id = ?)
       ORDER BY updated_at DESC`,
      u.company_id,
      a.warehouseId ?? null, a.warehouseId ?? null,
      a.productId ?? null, a.productId ?? null,
      a.siteId ?? null, a.siteId ?? null,
    );
  },
  requisitions: async (_s, a, ctx) => {
    const u = guardRead(ctx, "requisitions");
    return all(
      `SELECT * FROM requisitions WHERE company_id = ? AND deleted = 0
         AND (? IS NULL OR status = ?)
         AND (? IS NULL OR site_id = ?)
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      u.company_id,
      a.status ?? null, a.status ?? null,
      a.siteId ?? null, a.siteId ?? null,
    );
  },
  requisition: async (_s, a, ctx) => (guardRead(ctx, "requisitions"), byId(ctx, "requisitions", a.id)),
  platformCompanies: async (_s, _a, ctx) => {
    requirePlatform(ctx.user, 'viewer');
    return all(`
      SELECT c.id, c.name, c.nit, c.email, c.phone, c.city, c.plan, c.active, c.created_at,
             (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS users_count,
             (SELECT COUNT(*) FROM sales s WHERE s.company_id = c.id AND s.deleted = 0) AS sales_count,
             (SELECT COALESCE(SUM(s.total), 0) FROM sales s WHERE s.company_id = c.id AND s.deleted = 0 AND s.status = 'confirmada') AS sales_total,
             (SELECT MAX(x.ts) FROM (
                SELECT updated_at AS ts FROM sales WHERE company_id = c.id
                UNION ALL SELECT updated_at AS ts FROM payments WHERE company_id = c.id
                UNION ALL SELECT last_sync_at AS ts FROM devices WHERE company_id = c.id
                UNION ALL SELECT created_at AS ts FROM users WHERE company_id = c.id
             ) x) AS last_activity_at
        FROM companies c
       ORDER BY c.created_at DESC
    `);
  },
  licenses: async (_s, _a, ctx) => {
    requirePlatform(ctx.user, 'viewer');
    const rows = await all(`${LICENSE_SELECT} ORDER BY l.created_at DESC`);
    return Promise.all(rows.map(licenseOut));
  },
  platformUsers: async (_s, _a, ctx) => {
    requirePlatform(ctx.user, 'viewer');
    return all(`SELECT ${USER_COLS} FROM users WHERE platform_role IS NOT NULL ORDER BY 
      CASE platform_role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, name`);
  },

  partners: async (_s, a, ctx) => {
    const u = guardRead(ctx, "partners");
    const where = `p.company_id = ?1 AND p.deleted = 0
      AND (?3 IS NULL OR p.name LIKE ?3 OR p.doc_number LIKE ?3 OR p.email LIKE ?3)
      AND (?4 IS NULL OR p.is_customer = ?4) AND (?5 IS NULL OR p.is_supplier = ?5)`;
    const binds = [u.company_id, today(), like(a.search), boolArg(a.customers), boolArg(a.suppliers)];
    // HAVING sobre la suma (no sobre la columna r.balance de una fila cualquiera del grupo).
    const having = a.withBalance ? "HAVING SUM(CASE WHEN r.balance > 0.5 THEN r.balance END) > 0" : "";
    const sql = `${RECV_CTE}
      SELECT p.*, COALESCE(SUM(CASE WHEN r.balance > 0.5 THEN r.balance END), 0) AS balance,
             COALESCE(SUM(CASE WHEN r.balance > 0.5 AND r.due_date < ?2 THEN r.balance END), 0) AS overdue
        FROM partners p LEFT JOIN recv r ON r.partner_id = p.id
       WHERE ${where} GROUP BY p.id ${having}`;
    const [items, total] = await Promise.all([
      all(`${sql} ORDER BY p.name, p.id LIMIT ?6 OFFSET ?7`, ...binds, limit(a.limit), offset(a.offset)),
      one<{ n: number }>(`SELECT COUNT(*) AS n FROM (${sql})`, ...binds),
    ]);
    return { total: total?.n ?? 0, items };
  },
  partner: async (_s, a, ctx) => (guardRead(ctx, "partners"), byId(ctx, "partners", a.id)),
  categories: async (_s, _a, ctx) => {
    const u = guardRead(ctx, "categories");
    return all(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.company_id = c.company_id AND p.category_id = c.id AND p.deleted = 0) AS product_count
         FROM categories c WHERE c.company_id = ? AND c.deleted = 0 ORDER BY c.sequence, c.name`,
      u.company_id,
    );
  },
  tags: async (_s, _a, ctx) => {
    const u = guardRead(ctx, "tags");
    return all(`SELECT * FROM tags WHERE company_id = ? AND deleted = 0 ORDER BY name`, u.company_id);
  },
  productTags: async (_s, a, ctx) => {
    const u = guardRead(ctx, "product_tags");
    return all(
      `SELECT pt.* FROM product_tags pt WHERE pt.company_id = ? AND pt.deleted = 0 AND (? IS NULL OR pt.product_id = ?) ORDER BY pt.created_at`,
      u.company_id, a.productId ?? null, a.productId ?? null,
    );
  },
  stockMoves: async (_s, a, ctx) => {
    const u = guardRead(ctx, "stock_moves");
    return all(
      `SELECT * FROM stock_moves WHERE company_id = ? AND deleted = 0 AND (? IS NULL OR product_id = ?) AND (? IS NULL OR kind = ?)
        ORDER BY created_at DESC, id LIMIT ?`,
      u.company_id,
      a.productId ?? null,
      a.productId ?? null,
      a.kind ?? null,
      a.kind ?? null,
      limit(a.limit, 100),
    );
  },
  products: async (_s, a, ctx) => {
    const u = guardRead(ctx, "products");
    const stockExpr = `CASE WHEN ws.product_id IS NOT NULL THEN COALESCE(ws.qty, 0) ELSE COALESCE(m.qty, 0) END`;
    const sql = `SELECT p.*, ${stockExpr} AS stock FROM products p
      LEFT JOIN (SELECT product_id, SUM(qty) AS qty FROM stock_moves WHERE company_id = ?1 AND deleted = 0 GROUP BY product_id) m
        ON m.product_id = p.id
      LEFT JOIN (SELECT product_id, SUM(qty) AS qty FROM warehouse_stocks WHERE company_id = ?1 AND deleted = 0 GROUP BY product_id) ws
        ON ws.product_id = p.id
      WHERE p.company_id = ?1 AND p.deleted = 0
        AND (?2 IS NULL OR p.name LIKE ?2 OR p.sku LIKE ?2 OR p.barcode LIKE ?2)
        AND (?3 IS NULL OR p.category_id = ?3)
        AND (?4 = 0 OR (p.track_stock = 1 AND ${stockExpr} <= p.min_stock))`;
    const binds = [u.company_id, like(a.search), a.categoryId ?? null, a.lowStock ? 1 : 0];
    const [items, total] = await Promise.all([
      all(`${sql} ORDER BY p.name, p.id LIMIT ?5 OFFSET ?6`, ...binds, limit(a.limit), offset(a.offset)),
      one<{ n: number }>(`SELECT COUNT(*) AS n FROM (${sql})`, ...binds),
    ]);
    return { total: total?.n ?? 0, items };
  },
  product: async (_s, a, ctx) => (guardRead(ctx, "products"), byId(ctx, "products", a.id)),

  sales: async (_s, a, ctx) => {
    const u = guardRead(ctx, "sales");
    const sql = `FROM sales s LEFT JOIN partners pt ON pt.id = s.partner_id AND pt.company_id = s.company_id
      WHERE s.company_id = ?1 AND s.deleted = 0
        AND (?2 IS NULL OR s.number LIKE ?2 OR pt.name LIKE ?2)
        AND (?3 IS NULL OR s.channel = ?3) AND (?4 IS NULL OR s.status = ?4) AND (?5 IS NULL OR s.partner_id = ?5)
        AND (?6 IS NULL OR s.date >= ?6) AND (?7 IS NULL OR s.date < ?7) AND (?10 IS NULL OR s.pos_session_id = ?10)
        AND (?11 IS NULL OR s.site_id = ?11)`;
    const binds = [
      u.company_id,
      like(a.search),
      a.channel ?? null,
      a.status ?? null,
      a.partnerId ?? null,
      isDate(a.from) ? a.from : null,
      isDate(a.to) ? dayAfter(a.to) : null,
    ];
    const session = a.posSessionId ?? null;
    const siteId = a.siteId ?? null;
    const [items, agg] = await Promise.all([
      all(
        `SELECT s.*, (SELECT COALESCE(SUM(amount), 0) FROM payments x WHERE x.company_id = s.company_id AND x.sale_id = s.id AND x.deleted = 0) AS paid
         ${sql} ORDER BY s.date DESC, s.id LIMIT ?8 OFFSET ?9`,
        ...binds,
        limit(a.limit),
        offset(a.offset),
        session,
        siteId,
      ),
      one<{ n: number; amount: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN s.status = 'confirmada' THEN s.total END), 0) AS amount ${sql}`,
        ...binds,
        null,
        null,
        session,
        siteId,
      ),
    ]);
    return { total: agg?.n ?? 0, amount: agg?.amount ?? 0, items };
  },
  sale: async (_s, a, ctx) => (guardRead(ctx, "sales"), byId(ctx, "sales", a.id)),
  receivables: async (_s, a, ctx) => {
    const u = guardRead(ctx, "sales");
    return all(
      `${RECV_CTE}
       SELECT s.*, r.balance, s.total - r.balance AS paid FROM recv r JOIN sales s ON s.id = r.id
        WHERE r.balance > 0.5 AND (?2 IS NULL OR r.partner_id = ?2) AND (?3 = 0 OR r.due_date < ?4)
        ORDER BY r.due_date, s.id LIMIT 500`,
      u.company_id,
      a.partnerId ?? null,
      a.overdueOnly ? 1 : 0,
      today(),
    );
  },

  posSessions: async (_s, a, ctx) => {
    const u = guardRead(ctx, "pos_sessions");
    return all(
      `SELECT ps.*,
         (SELECT COALESCE(SUM(total), 0) FROM sales x WHERE x.company_id = ps.company_id AND x.pos_session_id = ps.id AND x.deleted = 0 AND x.status = 'confirmada') AS sales_total,
         (SELECT COUNT(*) FROM sales x WHERE x.company_id = ps.company_id AND x.pos_session_id = ps.id AND x.deleted = 0 AND x.status = 'confirmada') AS sales_count
       FROM pos_sessions ps WHERE ps.company_id = ? AND ps.deleted = 0
         AND (? IS NULL OR ps.status = ?)
         AND (? IS NULL OR ps.terminal = ?)
       ORDER BY ps.opened_at DESC LIMIT ?`,
      u.company_id,
      a.status ?? null,
      a.status ?? null,
      a.terminal ?? null,
      a.terminal ?? null,
      limit(a.limit, 30, 200),
    );
  },
  posSession: async (_s, a, ctx) => (guardRead(ctx, "pos_sessions"), byId(ctx, "pos_sessions", a.id)),

  payments: async (_s, a, ctx) => {
    const u = guardRead(ctx, "payments");
    return all(
      `SELECT * FROM payments WHERE company_id = ? AND deleted = 0 AND (? IS NULL OR kind = ?)
         AND (? IS NULL OR date >= ?) AND (? IS NULL OR date < ?) ORDER BY date DESC LIMIT ?`,
      u.company_id,
      a.kind ?? null,
      a.kind ?? null,
      isDate(a.from) ? a.from : null,
      isDate(a.from) ? a.from : null,
      isDate(a.to) ? dayAfter(a.to) : null,
      isDate(a.to) ? dayAfter(a.to) : null,
      limit(a.limit, 100),
    );
  },
  expenses: async (_s, a, ctx) => {
    const u = guardRead(ctx, "expenses");
    return all(
      `SELECT * FROM expenses WHERE company_id = ? AND deleted = 0 AND (? IS NULL OR status = ?)
         AND (? IS NULL OR date >= ?) AND (? IS NULL OR date < ?) ORDER BY date DESC LIMIT ?`,
      u.company_id,
      a.status ?? null,
      a.status ?? null,
      isDate(a.from) ? a.from : null,
      isDate(a.from) ? a.from : null,
      isDate(a.to) ? dayAfter(a.to) : null,
      isDate(a.to) ? dayAfter(a.to) : null,
      limit(a.limit, 100),
    );
  },

  employees: async (_s, a, ctx) => {
    const u = guardRead(ctx, "employees");
    const active = boolArg(a.active);
    return all("SELECT * FROM employees WHERE company_id = ? AND deleted = 0 AND (? IS NULL OR active = ?) ORDER BY name", u.company_id, active, active);
  },
  employee: async (_s, a, ctx) => (guardRead(ctx, "employees"), byId(ctx, "employees", a.id)),
  payslips: async (_s, a, ctx) => {
    const u = guardRead(ctx, "payslips");
    return all(
      `SELECT * FROM payslips WHERE company_id = ? AND deleted = 0 AND (? IS NULL OR period = ?) AND (? IS NULL OR employee_id = ?)
       ORDER BY period DESC, number LIMIT 500`,
      u.company_id,
      a.period ?? null,
      a.period ?? null,
      a.employeeId ?? null,
      a.employeeId ?? null,
    );
  },
  leaveRequests: async (_s, a, ctx) => {
    const u = guardRead(ctx, "leave_requests");
    return all(
      "SELECT * FROM leave_requests WHERE company_id = ? AND deleted = 0 AND (? IS NULL OR status = ?) ORDER BY date_from DESC LIMIT 500",
      u.company_id,
      a.status ?? null,
      a.status ?? null,
    );
  },
  novelties: async (_s, a, ctx) => {
    const u = guardRead(ctx, "payroll_novelties");
    return all(
      `SELECT * FROM payroll_novelties WHERE company_id = ? AND deleted = 0
         AND (? IS NULL OR period = ?) AND (? IS NULL OR employee_id = ?) AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?)
       ORDER BY date DESC, id LIMIT 1000`,
      u.company_id,
      a.period ?? null,
      a.period ?? null,
      a.employeeId ?? null,
      a.employeeId ?? null,
      isDate(a.from) ? a.from : null,
      isDate(a.from) ? a.from : null,
      isDate(a.to) ? a.to : null,
      isDate(a.to) ? a.to : null,
    );
  },
  payrollParams: async (_s, a, ctx) => {
    const u = guardRead(ctx, "payroll_params");
    const year = Number(a.year) || Number(today().slice(0, 4));
    return one(
      "SELECT * FROM payroll_params WHERE company_id = ? AND deleted = 0 AND year <= ? ORDER BY year DESC LIMIT 1",
      u.company_id,
      year,
    );
  },

  dashboard: async (_s, a, ctx) => dashboard(requireUser(ctx.user, FINANCE), a.from, a.to),
};

// ------------------------------------------------------------------ Panel KIO

async function dashboard(u: AuthUser, fromArg?: string, toArg?: string) {
  const to = isDate(toArg) ? toArg : today();
  const from = isDate(fromArg) ? fromArg : `${to.slice(0, 7)}-01`;
  const spanDays = Math.max(1, Math.round((Date.parse(dayAfter(to)) - Date.parse(from)) / 86_400_000));
  const prevFrom = new Date(Date.parse(from) - spanDays * 86_400_000).toISOString().slice(0, 10);
  const cid = u.company_id;
  const end = dayAfter(to);

  const salesAgg = (a: string, b: string) =>
    one<{ total: number; n: number }>(
      "SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n FROM sales WHERE company_id = ? AND deleted = 0 AND status = 'confirmada' AND date >= ? AND date < ?",
      cid,
      a,
      b,
    );
  const expAgg = (a: string, b: string) =>
    one<{ total: number }>(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE company_id = ? AND deleted = 0 AND status = 'aprobada' AND date >= ? AND date < ?",
      cid,
      a,
      b,
    );
  const payrollAgg = (a: string, b: string) =>
    one<{ total: number }>(
      "SELECT COALESCE(SUM(net), 0) AS total FROM payslips WHERE company_id = ? AND deleted = 0 AND status = 'confirmada' AND date_to >= ? AND date_to < ?",
      cid,
      a,
      b,
    );
  const monthsFrom = `${new Date(Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 12, 1)).toISOString().slice(0, 7)}-01`;

  const [daily, dailyExp, heat, byMethod, recent] = await Promise.all([
    all<{ date: string; sales: number; orders: number }>(
      `SELECT substr(date, 1, 10) AS date, SUM(total) AS sales, COUNT(*) AS orders FROM sales
        WHERE company_id = ? AND deleted = 0 AND status = 'confirmada' AND date >= ? AND date < ? GROUP BY 1`,
      cid,
      from,
      end,
    ),
    all<{ date: string; total: number }>(
      `SELECT substr(date, 1, 10) AS date, SUM(amount) AS total FROM expenses
        WHERE company_id = ? AND deleted = 0 AND status = 'aprobada' AND date >= ? AND date < ? GROUP BY 1`,
      cid,
      from,
      end,
    ),
    all(
      `SELECT CAST(strftime('%w', date) AS INTEGER) AS weekday, (CAST(strftime('%H', date) AS INTEGER) / 2) * 2 AS hour,
              SUM(total) AS amount, COUNT(*) AS count
         FROM sales WHERE company_id = ? AND deleted = 0 AND status = 'confirmada' AND date >= ? AND date < ? AND length(date) >= 13
        GROUP BY 1, 2`,
      cid,
      from,
      end,
    ),
    all(
      `SELECT method, SUM(amount) AS amount, COUNT(*) AS count FROM payments
        WHERE company_id = ? AND deleted = 0 AND date >= ? AND date < ? GROUP BY method ORDER BY amount DESC`,
      cid,
      from,
      end,
    ),
    all(
      `SELECT s.*, (SELECT COALESCE(SUM(amount), 0) FROM payments x WHERE x.company_id = s.company_id AND x.sale_id = s.id AND x.deleted = 0) AS paid
         FROM sales s WHERE s.company_id = ? AND s.deleted = 0 ORDER BY s.date DESC, s.id LIMIT 8`,
      cid,
    ),
  ]);
  const days: { date: string; sales: number; orders: number; expenses: number }[] = [];
  for (let t = Date.parse(from); t < Date.parse(end) && days.length < 400; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const s = daily.find((x) => x.date === d);
    days.push({ date: d, sales: s?.sales ?? 0, orders: s?.orders ?? 0, expenses: dailyExp.find((x) => x.date === d)?.total ?? 0 });
  }

  const [cur, prev, exp, expPrev, pay, payPrev, aging, salesMonths, expMonths, top] = await Promise.all([
    salesAgg(from, end),
    salesAgg(prevFrom, from),
    expAgg(from, end),
    expAgg(prevFrom, from),
    payrollAgg(from, end),
    payrollAgg(prevFrom, from),
    all<{ bucket: string; amount: number; count: number }>(
      `${RECV_CTE}
       SELECT CASE WHEN due_date IS NULL OR due_date >= ?2 THEN 'Corriente'
                   WHEN julianday(?2) - julianday(due_date) <= 30 THEN '1-30'
                   WHEN julianday(?2) - julianday(due_date) <= 60 THEN '31-60'
                   WHEN julianday(?2) - julianday(due_date) <= 90 THEN '61-90'
                   ELSE '+90' END AS bucket,
              SUM(balance) AS amount, COUNT(*) AS count
         FROM recv WHERE balance > 0.5 GROUP BY bucket`,
      cid,
      today(),
    ),
    all<{ month: string; total: number }>(
      "SELECT substr(date, 1, 7) AS month, SUM(total) AS total FROM sales WHERE company_id = ? AND deleted = 0 AND status = 'confirmada' AND date >= ? GROUP BY month",
      cid,
      monthsFrom,
    ),
    all<{ month: string; total: number }>(
      "SELECT substr(date, 1, 7) AS month, SUM(amount) AS total FROM expenses WHERE company_id = ? AND deleted = 0 AND status = 'aprobada' AND date >= ? GROUP BY month",
      cid,
      monthsFrom,
    ),
    all(
      `SELECT l.product_id, l.name, SUM(l.qty) AS qty, SUM(l.total) AS total
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id AND s.company_id = l.company_id
        WHERE l.company_id = ? AND l.deleted = 0 AND s.deleted = 0 AND s.status = 'confirmada' AND s.date >= ? AND s.date < ?
        GROUP BY l.product_id, l.name ORDER BY total DESC LIMIT 5`,
      cid,
      from,
      end,
    ),
  ]);

  const order = ["Corriente", "1-30", "31-60", "61-90", "+90"];
  const agingFull = order.map((b) => aging.find((x) => x.bucket === b) ?? { bucket: b, amount: 0, count: 0 });
  const receivable = agingFull.reduce((s, b) => s + b.amount, 0);
  const overdue = agingFull.filter((b) => b.bucket !== "Corriente").reduce((s, b) => s + b.amount, 0);

  const months = Array.from({ length: 12 }, (_, i) => {
    // Date.UTC usa meses base 0: (mes_actual - 12 + i) recorre de hace 11 meses al mes actual.
    const m = new Date(Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 12 + i, 1)).toISOString().slice(0, 7);
    return {
      month: m,
      sales: salesMonths.find((x) => x.month === m)?.total ?? 0,
      expenses: expMonths.find((x) => x.month === m)?.total ?? 0,
    };
  });

  const avg = (t?: { total: number; n: number } | null) => (t && t.n ? t.total / t.n : 0);
  return {
    from,
    to,
    kpis: [
      { key: "ventas", label: "Ventas", value: cur?.total ?? 0, previous: prev?.total ?? 0 },
      { key: "pedidos", label: "Número de ventas", value: cur?.n ?? 0, previous: prev?.n ?? 0 },
      { key: "ticket", label: "Ticket medio", value: avg(cur), previous: avg(prev) },
      { key: "cartera", label: "Cartera por cobrar", value: receivable, previous: 0 },
      { key: "vencida", label: "Cartera vencida", value: overdue, previous: 0 },
      { key: "gastos", label: "Gastos aprobados", value: exp?.total ?? 0, previous: expPrev?.total ?? 0 },
      { key: "nomina", label: "Nómina neta", value: pay?.total ?? 0, previous: payPrev?.total ?? 0 },
    ],
    months,
    aging: agingFull,
    topProducts: top,
    daily: days,
    heatmap: heat,
    byMethod,
    recent,
  };
}

// ------------------------------------------------------------------ Mutation

type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> };

/** Dos llaves: IP+correo (adivinar una clave) e IP sola (probar una clave contra muchos correos). */
async function rateLimited(...keys: string[]) {
  const limiter = (env as unknown as { LOGIN_LIMITER?: Limiter }).LOGIN_LIMITER;
  if (!limiter) {
    console.warn("[kio-sbs-api] LOGIN_LIMITER no configurado");
    return;
  }
  for (const key of keys) {
    if (!(await limiter.limit({ key })).success) throw gqlError("Demasiados intentos. Espera un minuto.", "RATE_LIMITED");
  }
}
const loginLimited = (ctx: Ctx, email: string) => rateLimited(`ip:${ctx.ip ?? "?"}`, `login:${ctx.ip ?? "?"}:${normEmail(email)}`);

function prepareAll(u: AuthUser, changes: { table: string; row: Record<string, unknown> }[]) {
  if (!Array.isArray(changes) || changes.length === 0) throw gqlError("No hay cambios para guardar");
  if (changes.length > MAX_PUSH) throw gqlError(`Máximo ${MAX_PUSH} registros por operación`);
  const prepared: PreparedRow[] = [];
  for (const ch of changes) {
    const row = ch.row && typeof ch.row === "object" && !Array.isArray(ch.row) ? ch.row : {};
    const r = prepareChange(u, ch.table, row);
    if (!("values" in r)) throw gqlError(r.reason, "FORBIDDEN");
    prepared.push(r);
  }
  return prepared;
}

/** Evita ventas que superen las existencias operativas por bodega/sede. */
async function assertSaleStock(u: AuthUser, prepared: PreparedRow[], changes: { table: string; row: Record<string, unknown> }[]) {
  type Need = { productId: string; warehouseId: string | null; siteId: string | null; qty: number };
  const needs = new Map<string, Need>();
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    if (p.table !== "stock_moves") continue;
    const input = (changes[i]?.row ?? {}) as Row;
    if (input.deleted || p.values.deleted) continue;
    const kind = String(p.values.kind ?? "");
    if (kind !== "venta" && kind !== "pedido") continue;
    const qty = Number(p.values.qty || 0);
    if (qty >= 0) continue;
    const productId = String(p.values.product_id || "");
    if (!productId) continue;
    const warehouseId = p.values.warehouse_id ? String(p.values.warehouse_id) : null;
    const siteId = p.values.site_id ? String(p.values.site_id) : null;
    const key = `${warehouseId ?? ""}|${siteId ?? ""}|${productId}`;
    const prev = needs.get(key);
    if (prev) prev.qty += -qty;
    else needs.set(key, { productId, warehouseId, siteId, qty: -qty });
  }
  if (!needs.size) return;

  const ids = [...new Set([...needs.values()].map((n) => n.productId))];
  const names = new Map<string, string>();
  if (ids.length) {
    const rows = await all<Row>(
      `SELECT id, name FROM products WHERE company_id = ? AND deleted = 0 AND id IN (${ids.map(() => "?").join(",")})`,
      u.company_id,
      ...ids,
    );
    for (const r of rows) names.set(String(r.id), String(r.name ?? "Producto"));
  }

  for (const need of needs.values()) {
    let available = 0;
    if (need.warehouseId) {
      const r = await one<{ q: number }>(
        "SELECT COALESCE(qty,0) AS q FROM warehouse_stocks WHERE company_id = ? AND warehouse_id = ? AND product_id = ? AND deleted = 0",
        u.company_id,
        need.warehouseId,
        need.productId,
      );
      available = Number(r?.q ?? 0);
    } else if (need.siteId) {
      const r = await one<{ q: number }>(
        "SELECT COALESCE(SUM(qty),0) AS q FROM warehouse_stocks WHERE company_id = ? AND site_id = ? AND product_id = ? AND deleted = 0",
        u.company_id,
        need.siteId,
        need.productId,
      );
      available = Number(r?.q ?? 0);
    } else {
      const r = await one<{ q: number }>(
        "SELECT COALESCE(SUM(qty),0) AS q FROM warehouse_stocks WHERE company_id = ? AND product_id = ? AND deleted = 0",
        u.company_id,
        need.productId,
      );
      available = Number(r?.q ?? 0);
    }
    if (need.qty > available + 1e-6) {
      const name = names.get(need.productId) ?? "Producto";
      throw gqlError(`Stock insuficiente para ${name}: disponible ${available}, solicitado ${need.qty}`);
    }
  }
}

/** Asigna una nueva revisión de sync a una fila escrita con SQL directo, para que los POS la reciban en su próximo pull. */
async function bump(companyId: string, table: string, ...ids: string[]) {
  for (const id of ids) {
    if (!id) continue;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sync_counter (company_id, value) VALUES (?, 1) ON CONFLICT(company_id) DO UPDATE SET value = value + 1").bind(companyId),
      env.DB.prepare(`UPDATE ${table} SET rev = (SELECT value FROM sync_counter WHERE company_id = ?) WHERE id = ? AND company_id = ?`).bind(companyId, id, companyId),
    ]);
  }
}

const Mutation: Record<string, R> = {
  saveRecords: async (_s, a, ctx) => {
    const u = requireUser(ctx.user);
    if (ctx._saved) throw gqlError("Sólo se permite un saveRecords por solicitud");
    ctx._saved = true;
    const prepared = prepareAll(u, a.changes);
    await assertSaleStock(u, prepared, a.changes);
    // Capture old stock_moves before upsert so we can compute deltas correctly.
    const oldMoves = new Map<string, Row | null>();
    for (const c of a.changes) {
      if (c.table !== "stock_moves" || !c.row?.id) continue;
      oldMoves.set(String(c.row.id), await one<Row>("SELECT * FROM stock_moves WHERE id = ? AND company_id = ? AND deleted = 0", c.row.id, u.company_id));
    }
    try {
      await writeRows(env.DB, u.company_id, prepared);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes("UNIQUE constraint failed: warehouse_stocks")) {
        throw gqlError("Este producto ya está asociado a esa bodega. Edita la existencia existente.");
      }
      if (msg.includes("UNIQUE constraint failed")) throw gqlError("Ya existe un registro con esos datos.");
      throw gqlError("Error interno al guardar. " + msg.slice(0, 120), "INTERNAL");
    }
    // Sync stock_moves -> warehouse_stocks (create/update)
    try {
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        const inputRow = (a.changes[i]?.row ?? {}) as Row;
        if (p.table !== "stock_moves") continue;
        const whId = p.values["warehouse_id"] as string | null;
        const prodId = p.values["product_id"] as string | null;
        const qtyVal = Number(p.values["qty"] || 0);
        if (!prodId) continue;
        const now = nowIso();
        const applyWs = async (warehouseId: string, productId: string, delta: number) => {
          if (!warehouseId || !productId || !delta) return;
          const existing = await one<Row>(
            "SELECT id FROM warehouse_stocks WHERE company_id = ? AND warehouse_id = ? AND product_id = ? AND deleted = 0",
            u.company_id, warehouseId, productId,
          );
          if (existing) {
            await env.DB.prepare(
              "UPDATE warehouse_stocks SET qty = qty + ?, updated_at = ?, updated_by = ? WHERE id = ? AND company_id = ?",
            ).bind(delta, now, u.id, existing.id, u.company_id).run();
            await bump(u.company_id, "warehouse_stocks", String(existing.id));
          } else {
            const anyWs = await one<{ c: number }>("SELECT COUNT(*) AS c FROM warehouse_stocks WHERE company_id = ? AND product_id = ? AND deleted = 0", u.company_id, productId);
            const initialQty = (anyWs?.c ?? 0) === 0
              ? ((await one<{ q: number }>("SELECT COALESCE(SUM(qty),0) AS q FROM stock_moves WHERE company_id = ? AND product_id = ? AND deleted = 0", u.company_id, productId))?.q ?? delta)
              : delta;
            const wsId = crypto.randomUUID();
            const prod = await one<Row>("SELECT min_stock FROM products WHERE id = ? AND company_id = ?", productId, u.company_id);
            const wh = await one<Row>("SELECT site_id FROM warehouses WHERE id = ? AND company_id = ?", warehouseId, u.company_id);
            await env.DB.prepare(
              "INSERT INTO warehouse_stocks (id, company_id, site_id, warehouse_id, product_id, qty, min_qty, active, created_at, updated_at, updated_by, deleted, rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)",
            ).bind(wsId, u.company_id, wh?.site_id ?? null, warehouseId, productId, initialQty, Number(prod?.min_stock ?? 0), 1, now, now, u.id, 0).run();
            await bump(u.company_id, "warehouse_stocks", wsId);
          }
        };

        const old = inputRow.id ? oldMoves.get(String(inputRow.id)) : null;
        const oldSyncedLocally = String(old?.notes ?? "").includes("ws_synced=1");
        if (old && !old.deleted && !oldSyncedLocally) {
          if (old.warehouse_id && old.product_id) await applyWs(String(old.warehouse_id), String(old.product_id), -Number(old.qty || 0));
        }
        // El POS ya descontó warehouse_stocks localmente; el backend sólo audita el movimiento.
        if (whId && !String(p.values.notes ?? "").includes("ws_synced=1")) await applyWs(whId, prodId, qtyVal);
      }
    } catch (e: any) {
      throw gqlError("Error sincronizando inventario: " + String(e?.message || e).slice(0, 140), "INTERNAL");
    }
    return prepared.map((p) => p.values.id);
  },
  deleteRecord: async (_s, a, ctx) => {
    const u = requireUser(ctx.user);
    const prepared = prepareAll(u, [{ table: a.table, row: { id: a.id, deleted: 1 } }]);
    const p = prepared[0];
    const now = nowIso();
    // Reverse stock_moves impact on warehouse_stocks before soft delete
    if (p.table === "stock_moves") {
      const mv = await one<Row>("SELECT * FROM stock_moves WHERE id = ? AND company_id = ? AND deleted = 0", a.id, u.company_id);
      if (mv?.warehouse_id && mv?.product_id) {
        const delta = -Number(mv.qty || 0);
        if (delta) {
          await env.DB.prepare(
            "UPDATE warehouse_stocks SET qty = qty + ?, updated_at = ?, updated_by = ? WHERE company_id = ? AND warehouse_id = ? AND product_id = ? AND deleted = 0",
          ).bind(delta, now, u.id, u.company_id, mv.warehouse_id, mv.product_id).run();
          const wsRow = await one<Row>("SELECT id FROM warehouse_stocks WHERE company_id = ? AND warehouse_id = ? AND product_id = ? AND deleted = 0", u.company_id, mv.warehouse_id, mv.product_id);
          if (wsRow) await bump(u.company_id, "warehouse_stocks", String(wsRow.id));
        }
      }
    }
    // Soft delete directo: evita fallar por NOT NULL en INSERT de tablas con columnas requeridas.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sync_counter (company_id, value) VALUES (?, 1) ON CONFLICT(company_id) DO UPDATE SET value = value + 1").bind(u.company_id),
      env.DB.prepare(
        `UPDATE ${p.table} SET deleted = 1, updated_at = ?, updated_by = ?, rev = (SELECT value FROM sync_counter WHERE company_id = ?) WHERE id = ? AND company_id = ?`,
      ).bind(now, u.id, u.company_id, a.id, u.company_id),
    ]);
    return true;
  },
  processRequisition: async (_s, a, ctx) => {
    const u = requireUser(ctx.user);
    guardWrite(ctx, "requisitions");
    const req = await one<Row>("SELECT * FROM requisitions WHERE id = ? AND company_id = ? AND deleted = 0", a.id, u.company_id);
    if (!req) throw gqlError("Requisición no encontrada", "NOT_FOUND");
    const action = String(a.action || "").toLowerCase();
    const role = u.role;
    if (action === "approve" && !["admin", "contador"].includes(role)) throw gqlError("Solo admin o contador puede aprobar requisiciones.");
    if (action === "dispatch" && !["admin", "contador"].includes(role)) throw gqlError("Solo admin o contador puede despachar requisiciones.");
    if (action === "receive" && !["admin", "contador", "cajero", "vendedor"].includes(role)) throw gqlError("No tienes permiso para recibir requisiciones.");
    if (action === "cancel" && !["admin", "contador"].includes(role)) throw gqlError("Solo admin o contador puede cancelar requisiciones.");
    const now = nowIso();
    const lines = await all<Row>("SELECT * FROM requisition_lines WHERE requisition_id = ? AND company_id = ? AND deleted = 0", a.id, u.company_id);
    if (!lines.length && action !== "cancel") throw gqlError("La requisición no tiene líneas.");

    const setStatus = async (status: string, extra: Record<string, unknown> = {}) => {
      const fields = ["status = ?", "updated_at = ?", "updated_by = ?"];
      const binds: unknown[] = [status, now, u.id];
      for (const [k, v] of Object.entries(extra)) { fields.push(`${k} = ?`); binds.push(v); }
      binds.push(a.id, u.company_id);
      await env.DB.prepare(`UPDATE requisitions SET ${fields.join(", ")} WHERE id = ? AND company_id = ?`).bind(...binds).run();
      await bump(u.company_id, "requisitions", String(a.id));
    };

    const ensureWs = async (warehouseId: string, productId: string) => {
      let ws = await one<Row>("SELECT id, qty FROM warehouse_stocks WHERE company_id = ? AND warehouse_id = ? AND product_id = ? AND deleted = 0", u.company_id, warehouseId, productId);
      if (ws) return ws;
      const anyWs = await one<{ c: number }>("SELECT COUNT(*) AS c FROM warehouse_stocks WHERE company_id = ? AND product_id = ? AND deleted = 0", u.company_id, productId);
      const initialQty = (anyWs?.c ?? 0) === 0
        ? ((await one<{ q: number }>("SELECT COALESCE(SUM(qty),0) AS q FROM stock_moves WHERE company_id = ? AND product_id = ? AND deleted = 0", u.company_id, productId))?.q ?? 0)
        : 0;
      const id = crypto.randomUUID();
      const prod = await one<Row>("SELECT min_stock FROM products WHERE id = ? AND company_id = ?", productId, u.company_id);
      const wh = await one<Row>("SELECT site_id FROM warehouses WHERE id = ? AND company_id = ?", warehouseId, u.company_id);
      await env.DB.prepare("INSERT INTO warehouse_stocks (id, company_id, site_id, warehouse_id, product_id, qty, min_qty, active, created_at, updated_at, updated_by, deleted, rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)")
        .bind(id, u.company_id, wh?.site_id ?? null, warehouseId, productId, initialQty, Number(prod?.min_stock ?? 0), 1, now, now, u.id, 0).run();
      await bump(u.company_id, "warehouse_stocks", id);
      return { id, qty: initialQty };
    };

    if (action === "request") {
      if (!["draft"].includes(req.status)) throw gqlError("Solo se puede solicitar una requisición en borrador.");
      await setStatus("requested", { requested_at: now, requested_by: u.id });
    } else if (action === "approve") {
      if (!["requested", "draft"].includes(req.status)) throw gqlError("La requisición no puede aprobarse en este estado.");
      await setStatus("approved", { approved_at: now, approved_by: u.id, requested_at: req.requested_at ?? now, requested_by: req.requested_by ?? u.id });
    } else if (action === "dispatch") {
      if (!["approved", "requested"].includes(req.status)) throw gqlError("La requisición debe estar aprobada/solicitada para despachar.");
      for (const ln of lines) {
        const qty = Number(ln.qty_dispatched || ln.qty_requested || 0);
        if (qty <= 0) continue;
        const ws = await one<Row>("SELECT qty FROM warehouse_stocks WHERE company_id = ? AND warehouse_id = ? AND product_id = ? AND deleted = 0", u.company_id, req.from_warehouse_id, ln.product_id);
        const available = Number(ws?.qty ?? 0);
        if (qty > available) {
          const prod = await one<Row>("SELECT name, sku FROM products WHERE id = ? AND company_id = ?", ln.product_id, u.company_id);
          throw gqlError(`Stock insuficiente para ${prod?.name ?? ln.product_id}: disponible ${available}, solicitado ${qty}.`);
        }
      }
      for (const ln of lines) {
        const qty = Number(ln.qty_dispatched || ln.qty_requested || 0);
        if (qty <= 0) continue;
        await env.DB.prepare("UPDATE requisition_lines SET qty_dispatched = ?, updated_at = ?, updated_by = ? WHERE id = ? AND company_id = ?")
          .bind(qty, now, u.id, ln.id, u.company_id).run();
        await bump(u.company_id, "requisition_lines", String(ln.id));
        const ws = await ensureWs(req.from_warehouse_id, ln.product_id);
        await env.DB.prepare("UPDATE warehouse_stocks SET qty = qty - ?, updated_at = ?, updated_by = ? WHERE id = ? AND company_id = ?")
          .bind(qty, now, u.id, ws.id, u.company_id).run();
        await bump(u.company_id, "warehouse_stocks", String(ws.id));
        const moveId = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO stock_moves (id, company_id, product_id, qty, kind, ref_id, date, unit_cost, notes, site_id, warehouse_id, warehouse_to_id, created_at, updated_at, updated_by, deleted, rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)")
          .bind(moveId, u.company_id, ln.product_id, -qty, "traslado_salida", req.id, today(), 0, `Despacho requisición ${req.id.slice(0,8)}`, req.site_id ?? null, req.from_warehouse_id, req.to_warehouse_id, now, now, u.id, 0).run();
        await bump(u.company_id, "stock_moves", moveId);
      }
      await setStatus("dispatched", { dispatched_at: now });
    } else if (action === "receive") {
      if (!["dispatched"].includes(req.status)) throw gqlError("La requisición debe estar despachada para recibirla.");
      for (const ln of lines) {
        const qty = Number(ln.qty_received || ln.qty_dispatched || ln.qty_requested || 0);
        if (qty <= 0) continue;
        await env.DB.prepare("UPDATE requisition_lines SET qty_received = ?, updated_at = ?, updated_by = ? WHERE id = ? AND company_id = ?")
          .bind(qty, now, u.id, ln.id, u.company_id).run();
        await bump(u.company_id, "requisition_lines", String(ln.id));
        const ws = await ensureWs(req.to_warehouse_id, ln.product_id);
        await env.DB.prepare("UPDATE warehouse_stocks SET qty = qty + ?, updated_at = ?, updated_by = ? WHERE id = ? AND company_id = ?")
          .bind(qty, now, u.id, ws.id, u.company_id).run();
        await bump(u.company_id, "warehouse_stocks", String(ws.id));
        const moveId = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO stock_moves (id, company_id, product_id, qty, kind, ref_id, date, unit_cost, notes, site_id, warehouse_id, warehouse_to_id, created_at, updated_at, updated_by, deleted, rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)")
          .bind(moveId, u.company_id, ln.product_id, qty, "traslado_entrada", req.id, today(), 0, `Recepción requisición ${req.id.slice(0,8)}`, req.site_id ?? null, req.to_warehouse_id, req.from_warehouse_id, now, now, u.id, 0).run();
        await bump(u.company_id, "stock_moves", moveId);
      }
      await setStatus("received", { received_at: now });
    } else if (action === "cancel") {
      if (["received"].includes(req.status)) throw gqlError("No se puede cancelar una requisición recibida.");
      await setStatus("cancelled");
    } else {
      throw gqlError("Acción inválida. Usa: request, approve, dispatch, receive, cancel");
    }
    return byId(ctx, "requisitions", a.id);
  },
  login: async (_s, a, ctx) => {
    await loginLimited(ctx, a.email);
    const { token, expiresAt } = await login(a.email, a.password, a.deviceId ?? ctx.deviceId);
    const user = await authenticate(token);
    if (!user) throw gqlError("No se pudo iniciar la sesión");
    requireUser(user); // licencia suspendida/vencida → LICENSE_* (los dueños de plataforma entran siempre)
    return { token, expiresAt, me: await meOf(user) };
  },
  signup: async (_s, { input }, ctx) => {
    if (env.ALLOW_SIGNUP !== "true") throw gqlError("El registro de empresas no está habilitado. Contacta a soporte.", "FORBIDDEN");
    await rateLimited(`signup:${ctx.ip ?? "?"}`, `ip:${ctx.ip ?? "?"}`);
    const email = normEmail(input.email);
    const companyName = String(input.companyName ?? "").trim();
    const name = String(input.name ?? "").trim();
    if (!companyName || companyName.length > 120) throw gqlError("Escribe el nombre de tu empresa");
    if (!name) throw gqlError("Escribe tu nombre");
    if (!EMAIL_RE.test(email)) throw gqlError("Correo inválido");
    validatePassword(input.password);
    // Mismo mensaje exista o no el correo sería ideal, pero el usuario necesita saber que ya tiene cuenta.
    if (await one("SELECT id FROM users WHERE email = ?", email)) throw gqlError("Ya existe una cuenta con ese correo. Inicia sesión.", "CONFLICT");
    const s = (v: unknown, n = 60) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, n));
    const storeCount = Math.max(1, Math.min(50, Number(input.storeCount ?? 1) || 1));
    await createTenant(
      { name: companyName, nit: s(input.nit, 20), city: s(input.city), phone: s(input.phone, 20), email, address: s(input.address, 120), businessType: s(input.businessType, 40), hasCedi: !!input.hasCedi, storeCount },
      { name, email, password: input.password },
    );
    const { token, expiresAt } = await login(email, input.password, ctx.deviceId);
    const user = await authenticate(token);
    return { token, expiresAt, me: await meOf(user!) };
  },
  saveRole: async (_s, { input }, ctx) => {
    const u = requireUser(ctx.user, ["admin"]);
    const name = String(input.name ?? "").trim().slice(0, 60);
    if (!name) throw gqlError("El nombre del rol es obligatorio");
    if (!ROLES.includes(input.baseRole)) throw gqlError(`Rol base inválido. Usa: ${ROLES.join(", ")}`);
    const suites = [...new Set((input.suites ?? []) as string[])];
    if (!suites.length || suites.some((x) => !SUITE_KEYS.includes(x as never))) throw gqlError("Selecciona al menos una suite válida");
    const perms: Record<string, "r" | "w"> = {};
    for (const [t, v] of Object.entries((input.permissions ?? {}) as Record<string, unknown>)) {
      if (!TABLE_NAMES.includes(t)) throw gqlError(`Módulo desconocido: ${t}`);
      if (v === "r" || v === "w") perms[t] = v;
    }
    const id = input.id ?? uuid();
    if (input.id && !(await one("SELECT id FROM roles WHERE id = ? AND company_id = ?", input.id, u.company_id))) throw gqlError("Rol no encontrado", "NOT_FOUND");
    if (await one("SELECT id FROM roles WHERE company_id = ? AND lower(name) = lower(?) AND id <> ?", u.company_id, name, id)) {
      throw gqlError("Ya existe un rol con ese nombre", "CONFLICT");
    }
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, company_id, name, description, base_role, suites, permissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, base_role = excluded.base_role,
           suites = excluded.suites, permissions = excluded.permissions, updated_at = excluded.updated_at
         WHERE roles.company_id = excluded.company_id`,
      ).bind(id, u.company_id, name, input.description ?? null, input.baseRole, JSON.stringify(suites), JSON.stringify(perms), now, now),
      // El rol base de los usuarios con este rol se mantiene alineado
      env.DB.prepare("UPDATE users SET role = ?, updated_at = ? WHERE role_id = ? AND company_id = ?").bind(input.baseRole, now, id, u.company_id),
    ]);
    const row = await one(
      `SELECT r.*, (SELECT COUNT(*) FROM users x WHERE x.role_id = r.id) AS user_count FROM roles r WHERE r.id = ?`,
      id,
    );
    return roleOut(row!);
  },
  deleteRole: async (_s, { id }, ctx) => {
    const u = requireUser(ctx.user, ["admin"]);
    const n = await one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND company_id = ?", id, u.company_id);
    if ((n?.n ?? 0) > 0) throw gqlError(`El rol tiene ${n!.n} usuario(s) asignado(s). Cámbialos de rol primero.`);
    await env.DB.prepare("DELETE FROM roles WHERE id = ? AND company_id = ?").bind(id, u.company_id).run();
    return true;
  },
  logout: async (_s, _a, ctx) => {
    const u = requireUser(ctx.user);
    const ops = [
      env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(u.session_id),
    ];
    if (u.device_id) {
      ops.push(env.DB.prepare("UPDATE devices SET last_sync_at = NULL, updated_at = ? WHERE id = ? AND company_id = ?").bind(nowIso(), u.device_id, u.company_id));
    }
    await env.DB.batch(ops);
    return true;
  },
  changePassword: async (_s, a, ctx) => {
    const u = requireUser(ctx.user);
    await rateLimited(`pw:${u.id}`);
    const row = await one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", u.id);
    if (!row || !(await verifyPassword(a.current, row.password_hash))) throw gqlError("La contraseña actual no es correcta");
    validatePassword(a.next);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(a.next), nowIso(), u.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").bind(u.id, u.session_id),
    ]);
    return true;
  },
  createUser: async (_s, { input }, ctx) => {
    const u = requireUser(ctx.user, ["admin"]);
    const email = String(input.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw gqlError("Correo inválido");
    if (!ROLES.includes(input.role)) throw gqlError(`Rol inválido. Usa: ${ROLES.join(", ")}`);
    if (!String(input.name ?? "").trim()) throw gqlError("El nombre es obligatorio");
    validatePassword(input.password);
    if (await one("SELECT id FROM users WHERE email = ?", email)) throw gqlError("Ya existe un usuario con ese correo", "CONFLICT");
    if (u.license?.max_users != null) {
      const n = await one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = 1 AND platform_role IS NULL", u.company_id);
      if ((n?.n ?? 0) >= u.license.max_users) throw gqlError(`Tu licencia permite ${u.license.max_users} usuario(s). Contacta a soporte para ampliarla.`, "LICENSE_LIMIT");
    }
    let role = input.role;
    if (input.roleId) {
      const r = await one<{ base_role: string }>("SELECT base_role FROM roles WHERE id = ? AND company_id = ?", input.roleId, u.company_id);
      if (!r) throw gqlError("Rol personalizado no encontrado");
      role = r.base_role;
    }
    let siteId: string | null = input.siteId ?? null;
    if (siteId) {
      const s = await one("SELECT id FROM sites WHERE id = ? AND company_id = ? AND deleted = 0", siteId, u.company_id);
      if (!s) throw gqlError("Sede no encontrada");
    }
    const id = uuid();
    await env.DB.prepare(
      "INSERT INTO users (id, company_id, name, email, password_hash, role, role_id, pos_terminal, employee_id, site_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, u.company_id, String(input.name).trim(), email, await hashPassword(input.password), role, input.roleId ?? null, input.posTerminal ?? null, input.employeeId ?? null, siteId)
      .run();
    return one(`${USER_SELECT} WHERE u.id = ?`, id);
  },
  updateUser: async (_s, { id, input }, ctx) => {
    const u = requireUser(ctx.user, ["admin"]);
    const target = await one<Row>(`SELECT ${USER_COLS} FROM users WHERE id = ? AND company_id = ?`, id, u.company_id);
    if (!target) throw gqlError("Usuario no encontrado", "NOT_FOUND");
    if (id === u.id && (input.active === false || (input.role && input.role !== "admin"))) {
      throw gqlError("No puedes desactivarte ni quitarte el rol de administrador");
    }
    if (input.role && !ROLES.includes(input.role)) throw gqlError("Rol inválido");
    const sets: string[] = [];
    const binds: unknown[] = [];
    const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), binds.push(v));
    if (input.name != null) set("name", String(input.name).trim());
    if (input.roleId !== undefined) {
      if (id === u.id && input.roleId) throw gqlError("No puedes asignarte un rol personalizado a ti mismo");
      if (input.roleId) {
        const r = await one<{ base_role: string }>("SELECT base_role FROM roles WHERE id = ? AND company_id = ?", input.roleId, u.company_id);
        if (!r) throw gqlError("Rol personalizado no encontrado");
        set("role_id", input.roleId);
        set("role", r.base_role);
      } else set("role_id", null);
    }
    if (input.role && !input.roleId) set("role", input.role);
    if (input.active != null) set("active", input.active ? 1 : 0);
    if (input.posTerminal !== undefined) set("pos_terminal", input.posTerminal);
    if (input.employeeId !== undefined) set("employee_id", input.employeeId);
    if (input.siteId !== undefined) {
      if (input.siteId) {
        const s = await one("SELECT id FROM sites WHERE id = ? AND company_id = ? AND deleted = 0", input.siteId, u.company_id);
        if (!s) throw gqlError("Sede no encontrada");
        set("site_id", input.siteId);
      } else set("site_id", null);
    }
    if (input.password) {
      validatePassword(input.password);
      set("password_hash", await hashPassword(input.password));
      set("failed_logins", 0);
      set("locked_until", null);
    }
    if (!sets.length) return target;
    set("updated_at", nowIso());
    const stmts = [env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id)];
    // Desactivar, cambiar rol o restablecer clave cierra sus sesiones abiertas.
    if (input.active === false || input.password) stmts.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
    await env.DB.batch(stmts);
    return one(`${USER_SELECT} WHERE u.id = ?`, id);
  },
  assignDeviceSite: async (_s, { id, siteId }, ctx) => {
    const u = requireUser(ctx.user, ["admin"]);
    const dev = await one<Row>("SELECT * FROM devices WHERE id = ? AND company_id = ?", id, u.company_id);
    if (!dev) throw gqlError("Dispositivo no encontrado", "NOT_FOUND");
    let sid: string | null = siteId ?? null;
    if (sid) {
      const s = await one("SELECT id FROM sites WHERE id = ? AND company_id = ? AND deleted = 0", sid, u.company_id);
      if (!s) throw gqlError("Sede no encontrada");
    }
    await env.DB.prepare("UPDATE devices SET site_id = ?, updated_at = ? WHERE id = ? AND company_id = ?")
      .bind(sid, nowIso(), id, u.company_id).run();
    return one("SELECT * FROM devices WHERE id = ? AND company_id = ?", id, u.company_id);
  },
  saveLicense: async (_s, { input }, ctx) => {
    requirePlatform(ctx.user, 'admin');
    const f = licenseFields(input);
    const now = nowIso();
    let id = input.id as string | undefined;
    if (id) {
      const cur = await one<{ id: string; kind: string }>("SELECT id, kind FROM licenses WHERE id = ?", id);
      if (!cur) throw gqlError("Licencia no encontrada", "NOT_FOUND");
      await env.DB.prepare(
        `UPDATE licenses SET status = ?, starts_at = ?, ends_at = ?, max_devices = ?, max_users = ?, modules = ?, notes = ?,
                customer = COALESCE(?, customer), license_key = CASE WHEN ? = 1 THEN ? ELSE license_key END, updated_at = ? WHERE id = ?`,
      ).bind(f.status, f.startsAt, f.endsAt, f.maxDevices, f.maxUsers, f.modules, f.notes, input.customer ?? null, input.regenerateKey ? 1 : 0, newLicenseKey(), now, id).run();
    } else {
      const kind = input.kind === "remote" ? "remote" : "hosted";
      if (kind === "hosted") {
        if (!input.companyId || !(await one("SELECT id FROM companies WHERE id = ?", input.companyId))) throw gqlError("Selecciona una empresa válida", "NOT_FOUND");
        if (await one("SELECT id FROM licenses WHERE company_id = ?", input.companyId)) throw gqlError("Esa empresa ya tiene licencia", "CONFLICT");
      } else if (!String(input.customer ?? "").trim()) throw gqlError("Escribe el nombre del cliente");
      id = uuid();
      await env.DB.prepare(
        `INSERT INTO licenses (id, kind, company_id, customer, license_key, status, starts_at, ends_at, max_devices, max_users, modules, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, kind, kind === "hosted" ? input.companyId : null, kind === "remote" ? String(input.customer).trim().slice(0, 120) : null, newLicenseKey(), f.status, f.startsAt, f.endsAt, f.maxDevices, f.maxUsers, f.modules, f.notes, now, now).run();
    }
    return licenseOut((await one(`${LICENSE_SELECT} WHERE l.id = ?`, id))!);
  },
  setLicenseStatus: async (_s, { id, active }, ctx) => {
    requirePlatform(ctx.user, 'admin');
    const r = await env.DB.prepare("UPDATE licenses SET status = ?, updated_at = ? WHERE id = ?").bind(active ? "active" : "suspended", nowIso(), id).run();
    if (!r.meta.changes) throw gqlError("Licencia no encontrada", "NOT_FOUND");
    return licenseOut((await one(`${LICENSE_SELECT} WHERE l.id = ?`, id))!);
  },
  deleteLicense: async (_s, { id }, ctx) => {
    requirePlatform(ctx.user, 'owner');
    await env.DB.prepare("DELETE FROM licenses WHERE id = ?").bind(id).run();
    return true;
  },
  /** Crea una empresa nueva en este backend con su administrador y su licencia (cliente alojado en el maestro). */
  createLicensedCompany: async (_s, { input }, ctx) => {
    requirePlatform(ctx.user, 'admin');
    const email = normEmail(input.adminEmail);
    const companyName = String(input.companyName ?? "").trim();
    if (!companyName || companyName.length > 120) throw gqlError("Escribe el nombre de la empresa");
    if (!String(input.adminName ?? "").trim()) throw gqlError("Escribe el nombre del administrador");
    if (!EMAIL_RE.test(email)) throw gqlError("Correo del administrador inválido");
    validatePassword(input.adminPassword);
    if (await one("SELECT id FROM users WHERE email = ?", email)) throw gqlError("Ya existe un usuario con ese correo", "CONFLICT");
    const f = licenseFields(input);
    const s = (v: unknown, n = 60) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, n));
    const { companyId } = await createTenant(
      { name: companyName, nit: s(input.nit, 20), city: s(input.city), phone: s(input.phone, 20), email: s(input.email, 80) ?? email, storeCount: 1 },
      { name: String(input.adminName).trim(), email, password: input.adminPassword },
    );
    const id = uuid();
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO licenses (id, kind, company_id, license_key, status, starts_at, ends_at, max_devices, max_users, modules, notes, created_at, updated_at)
       VALUES (?, 'hosted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, companyId, newLicenseKey(), f.status, f.startsAt, f.endsAt, f.maxDevices, f.maxUsers, f.modules, f.notes, now, now).run();
    return licenseOut((await one(`${LICENSE_SELECT} WHERE l.id = ?`, id))!);
  },
  createPlatformUser: async (_s, { input }, ctx) => {
    const u = requirePlatform(ctx.user, 'admin');
    const pr = String(input.platformRole);
    if (!PLATFORM_RANK[pr]) throw gqlError('platformRole inválido (owner|admin|viewer)');
    if (PLATFORM_RANK[pr] > PLATFORM_RANK[u.platform_role!]) throw gqlError('No puedes crear un usuario con más privilegios que tú', 'FORBIDDEN');
    const email = String(input.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw gqlError('Correo inválido');
    if (!String(input.name ?? '').trim()) throw gqlError('El nombre es obligatorio');
    validatePassword(input.password);
    if (await one('SELECT id FROM users WHERE email = ?', email)) throw gqlError('Ya existe un usuario con ese correo', 'CONFLICT');
    const companyId = input.companyId ? String(input.companyId) : u.company_id;
    const company = await one('SELECT id FROM companies WHERE id = ?', companyId);
    if (!company) throw gqlError('Empresa no encontrada');
    const id = uuid();
    await env.DB.prepare(
      'INSERT INTO users (id, company_id, name, email, password_hash, role, active, platform_role) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    ).bind(id, companyId, String(input.name).trim(), email, await hashPassword(input.password), 'admin', pr).run();
    return one(`${USER_SELECT} WHERE u.id = ?`, id);
  },
  updatePlatformUser: async (_s, { id, input }, ctx) => {
    const u = requirePlatform(ctx.user, 'admin');
    const target = await one<Row>(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id);
    if (!target) throw gqlError('Usuario no encontrado', 'NOT_FOUND');
    if (!target.platform_role) throw gqlError('El usuario no es de plataforma');
    if (PLATFORM_RANK[target.platform_role] > PLATFORM_RANK[u.platform_role!]) throw gqlError('No puedes modificar un usuario con más privilegios que tú', 'FORBIDDEN');
    if (input.platformRole) {
      if (!PLATFORM_RANK[input.platformRole]) throw gqlError('platformRole inválido');
      if (PLATFORM_RANK[input.platformRole] > PLATFORM_RANK[u.platform_role!]) throw gqlError('No puedes asignar más privilegios que los tuyos', 'FORBIDDEN');
    }
    if (id === u.id && (input.active === false || (input.platformRole && input.platformRole !== 'owner'))) {
      throw gqlError('No puedes degradarte ni desactivarte a ti mismo');
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), binds.push(v));
    if (input.name != null) set('name', String(input.name).trim());
    if (input.platformRole) set('platform_role', input.platformRole);
    if (input.active != null) set('active', input.active ? 1 : 0);
    if (input.password) {
      validatePassword(input.password);
      set('password_hash', await hashPassword(input.password));
      set('failed_logins', 0);
      set('locked_until', null);
    }
    if (!sets.length) return one(`${USER_SELECT} WHERE u.id = ?`, id);
    set('updated_at', nowIso());
    const stmts = [env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id)];
    if (input.active === false || input.password) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
    await env.DB.batch(stmts);
    return one(`${USER_SELECT} WHERE u.id = ?`, id);
  },
  deleteCompany: async (_s, { id }, ctx) => {
    requirePlatform(ctx.user, 'owner');
    const company = await one<Row>('SELECT id, name FROM companies WHERE id = ?', id);
    if (!company) throw gqlError('Empresa no encontrada', 'NOT_FOUND');
    const tables = await all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND sql LIKE '%company_id%' ORDER BY name",
    );
    const names = tables.map((t) => t.name).filter((n) => n !== 'companies');
    const userIds = (await all<{ id: string }>('SELECT id FROM users WHERE company_id = ?', id)).map((r) => r.id);
    const stmts: any[] = [env.DB.prepare('PRAGMA defer_foreign_keys=ON')];
    for (const uid of userIds) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid));
    for (const n of names) stmts.push(env.DB.prepare(`DELETE FROM ${n} WHERE company_id = ?`).bind(id));
    stmts.push(env.DB.prepare('DELETE FROM sync_counter WHERE company_id = ?').bind(id));
    stmts.push(env.DB.prepare('DELETE FROM companies WHERE id = ?').bind(id));
    for (let i = 0; i < stmts.length; i += 80) {
      const chunk = stmts.slice(i, i + 80);
      if (i > 0) chunk.unshift(env.DB.prepare('PRAGMA defer_foreign_keys=ON'));
      await env.DB.batch(chunk);
    }
    return true;
  },
  switchCompany: async (_s, { companyId }, ctx) => {
    const u = requirePlatform(ctx.user, 'owner');
    const company = await one<Row>('SELECT id, name, active FROM companies WHERE id = ?', companyId);
    if (!company || !company.active) throw gqlError('Empresa no encontrada o inactiva', 'NOT_FOUND');
    const target = await one<Row & { password_hash: string }>(
      "SELECT u.*, c.name AS company_name FROM users u JOIN companies c ON c.id=u.company_id WHERE u.company_id=? AND u.active=1 AND u.role='admin' ORDER BY u.created_at ASC LIMIT 1",
      companyId,
    );
    if (!target) throw gqlError('La empresa no tiene un usuario admin activo');
    const token = randomHex(32);
    const now = nowIso();
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, device_id, expires_at) VALUES (?, ?, ?, ?, ?)').bind(
        uuid(), target.id, await sha256Hex(token), `platform:${u.id}`.slice(0, 64), expiresAt,
      ),
      env.DB.prepare('UPDATE users SET last_login_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').bind(now, target.id),
    ]);
    const user = await authenticate(token);
    if (!user) throw gqlError('No se pudo iniciar la sesión en la empresa');
    return { token, expiresAt, me: await meOf(user) };
  },
  updateCompany: async (_s, { input }, ctx) => {
    const u = requireUser(ctx.user, ["admin"]);
    const map: Record<string, string> = { name: "name", nit: "nit", address: "address", city: "city", phone: "phone", email: "email", receiptFooter: "receipt_footer" };
    const keys = Object.keys(input).filter((k) => k in map && input[k] !== undefined);
    if (keys.some((k) => k === "name") && !String(input.name ?? "").trim()) throw gqlError("El nombre es obligatorio");
    if (keys.length) {
      await env.DB.prepare(`UPDATE companies SET ${keys.map((k) => `${map[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...keys.map((k) => (input[k] == null ? null : String(input[k]).slice(0, 500))), nowIso(), u.company_id)
        .run();
    }
    return one("SELECT * FROM companies WHERE id = ?", u.company_id);
  },
  approveExpense: async (_s, a, ctx) => {
    const u = requireUser(ctx.user, FINANCE);
    const row = await one<Row>("SELECT * FROM expenses WHERE id = ? AND company_id = ? AND deleted = 0", a.id, u.company_id);
    if (!row) throw gqlError("Gasto no encontrado", "NOT_FOUND");
    if (!["borrador", "enviada"].includes(row.status)) throw gqlError(`El gasto ya está ${row.status}`);
    const patch: Row = { status: a.approve ? "aprobada" : "rechazada", approved_by: u.id, approved_at: nowIso() };
    if (a.notes) patch.notes = [row.notes, a.notes].filter(Boolean).join("\n");
    await writeRows(env.DB, u.company_id, [patchRow("expenses", row, patch, u.id, u.role)]);
    return one("SELECT * FROM expenses WHERE id = ?", a.id);
  },
  approveLeave: async (_s, a, ctx) => {
    const u = requireUser(ctx.user, FINANCE);
    const row = await one<Row>("SELECT * FROM leave_requests WHERE id = ? AND company_id = ? AND deleted = 0", a.id, u.company_id);
    if (!row) throw gqlError("Solicitud no encontrada", "NOT_FOUND");
    if (row.status !== "solicitada") throw gqlError(`La solicitud ya está ${row.status}`);
    const patch: Row = { status: a.approve ? "aprobada" : "rechazada", approved_by: u.id };
    if (a.notes) patch.notes = [row.notes, a.notes].filter(Boolean).join("\n");
    await writeRows(env.DB, u.company_id, [patchRow("leave_requests", row, patch, u.id, u.role)]);
    return one("SELECT * FROM leave_requests WHERE id = ?", a.id);
  },
};

// ------------------------------------------------------------------ Tipos anidados

const sumPaid = (rows: Row[]) => rows.reduce((s, p) => s + (Number(p.amount) || 0), 0);

export const resolvers: Record<string, Record<string, R>> = {
  Query,
  Mutation,
  Partner: {
    balance: async (p, _a, ctx) => (p.balance ?? (await partnerBalance(ctx, p.id)).balance),
    overdue: async (p, _a, ctx) => (p.overdue ?? (await partnerBalance(ctx, p.id)).overdue),
    availableCredit: async (p, _a, ctx) => {
      if (!(p.credit_limit > 0)) return null;
      const bal = p.balance ?? (await partnerBalance(ctx, p.id)).balance;
      return p.credit_limit - bal;
    },
    seller: (p, _a, ctx) => byId(ctx, "users", p.seller_id),
    sales: async (p, a, ctx) =>
      canRead(requireUser(ctx.user), "sales")
        ? (await children(ctx, "sales", "partner_id", p.id, "date DESC")).slice(0, limit(a.limit, 20, 100))
        : [],
  },
  Category: {
    productCount: async (c, _a, ctx) =>
      c.product_count ??
      (await one<{ n: number }>("SELECT COUNT(*) AS n FROM products WHERE company_id = ? AND category_id = ? AND deleted = 0", ctx.user!.company_id, c.id))?.n ??
      0,
  },
  StockMove: { product: (m, _a, ctx) => byId(ctx, "products", m.product_id) },
  Product: {
    stock: async (p, _a, ctx) => {
      if (p.stock != null) return p.stock;
      const cid = ctx.user!.company_id;
      const ws = await one<{ q: number; c: number }>(
        "SELECT COALESCE(SUM(qty),0) AS q, COUNT(*) AS c FROM warehouse_stocks WHERE company_id = ? AND product_id = ? AND deleted = 0",
        cid, p.id,
      );
      if ((ws?.c ?? 0) > 0) return ws?.q ?? 0;
      return (await one<{ q: number }>(
        "SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves WHERE company_id = ? AND product_id = ? AND deleted = 0",
        cid, p.id,
      ))?.q ?? 0;
    },
    category: (p, _a, ctx) => byId(ctx, "categories", p.category_id),
    tags: async (p, _a, ctx) => {
      const cid = ctx.user!.company_id;
      return all(
        `SELECT t.* FROM tags t JOIN product_tags pt ON pt.tag_id = t.id AND pt.company_id = t.company_id AND pt.deleted = 0
         WHERE pt.product_id = ? AND t.company_id = ? AND t.deleted = 0 ORDER BY t.name`,
        p.id, cid,
      );
    },
  },
  ProductTag: {
    tag: (pt, _a, ctx) => byId(ctx, "tags", pt.tag_id),
  },
  Sale: {
    paid: async (s, _a, ctx) => s.paid ?? sumPaid(await children(ctx, "payments", "sale_id", s.id)),
    balance: async (s, _a, ctx) => s.balance ?? s.total - (s.paid ?? sumPaid(await children(ctx, "payments", "sale_id", s.id))),
    partner: (s, _a, ctx) => byId(ctx, "partners", s.partner_id),
    seller: (s, _a, ctx) => byId(ctx, "users", s.seller_id),
    site: (s, _a, ctx) => byId(ctx, "sites", s.site_id),
    lines: (s, _a, ctx) => children(ctx, "sale_lines", "sale_id", s.id, "sequence"),
    payments: (s, _a, ctx) => children(ctx, "payments", "sale_id", s.id, "date"),
  },
  PosSession: {
    salesTotal: async (ps, _a, ctx) => ps.sales_total ?? (await sessionTotals(ctx, ps.id)).total,
    salesCount: async (ps, _a, ctx) => ps.sales_count ?? (await sessionTotals(ctx, ps.id)).n,
    user: (ps, _a, ctx) => byId(ctx, "users", ps.user_id),
    byMethod: (ps, _a, ctx) =>
      all(
        "SELECT method, SUM(amount) AS amount, COUNT(*) AS count FROM payments WHERE company_id = ? AND pos_session_id = ? AND deleted = 0 GROUP BY method ORDER BY amount DESC",
        ctx.user!.company_id,
        ps.id,
      ),
  },
  Payment: {
    partner: (p, _a, ctx) => byId(ctx, "partners", p.partner_id),
    sale: (p, _a, ctx) => byId(ctx, "sales", p.sale_id),
  },
  Expense: {
    partner: (e, _a, ctx) => byId(ctx, "partners", e.partner_id),
    requestedBy: (e, _a, ctx) => byId(ctx, "users", e.requested_by),
    approvedBy: (e, _a, ctx) => byId(ctx, "users", e.approved_by),
  },
  Employee: {
    user: (e, _a, ctx) => (e.user_id ? byId(ctx, "users", e.user_id) : null),
    payslips: (e, a, ctx) =>
      all(
        "SELECT * FROM payslips WHERE company_id = ? AND employee_id = ? AND deleted = 0 ORDER BY period DESC LIMIT ?",
        ctx.user!.company_id,
        e.id,
        limit(a.limit, 12, 60),
      ),
    leaveRequests: (e, _a, ctx) => children(ctx, "leave_requests", "employee_id", e.id, "date_from DESC"),
  },
  Payslip: {
    employee: (p, _a, ctx) => byId(ctx, "employees", p.employee_id),
    detail: (p) => {
      try {
        return p.detail ? JSON.parse(p.detail) : null;
      } catch {
        return null;
      }
    },
  },
  LeaveRequest: { employee: (l, _a, ctx) => byId(ctx, "employees", l.employee_id) },
  Novelty: { employee: (n, _a, ctx) => byId(ctx, "employees", n.employee_id) },
  Device: { user: (d, _a, ctx) => byId(ctx, "users", d.user_id) },
  Warehouse: { site: (w, _a, ctx) => byId(ctx, "sites", w.site_id) },
  WarehouseStock: {
    warehouse: (r, _a, ctx) => byId(ctx, "warehouses", r.warehouse_id),
    product: (r, _a, ctx) => byId(ctx, "products", r.product_id),
  },
  Requisition: {
    fromWarehouse: (r, _a, ctx) => byId(ctx, "warehouses", r.from_warehouse_id),
    toWarehouse: (r, _a, ctx) => byId(ctx, "warehouses", r.to_warehouse_id),
    lines: (r, _a, ctx) => children(ctx, "requisition_lines", "requisition_id", r.id, "created_at"),
  },
  RequisitionLine: {
    product: (l, _a, ctx) => byId(ctx, "products", l.product_id),
  },
};

function partnerBalance(ctx: Ctx, partnerId: string) {
  return cached(ctx as never, `bal:${partnerId}`, () => partnerBalanceQuery(ctx, partnerId));
}

async function partnerBalanceQuery(ctx: Ctx, partnerId: string) {
  const r = await one<{ balance: number; overdue: number }>(
    `${RECV_CTE}
     SELECT COALESCE(SUM(balance), 0) AS balance, COALESCE(SUM(CASE WHEN due_date < ?3 THEN balance END), 0) AS overdue
       FROM recv WHERE partner_id = ?2 AND balance > 0.5`,
    ctx.user!.company_id,
    partnerId,
    today(),
  );
  return r ?? { balance: 0, overdue: 0 };
}

async function sessionTotals(ctx: Ctx, sessionId: string) {
  const r = await one<{ total: number; n: number }>(
    "SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n FROM sales WHERE company_id = ? AND pos_session_id = ? AND deleted = 0 AND status = 'confirmada'",
    ctx.user!.company_id,
    sessionId,
  );
  return r ?? { total: 0, n: 0 };
}
