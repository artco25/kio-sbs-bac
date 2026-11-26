import { authenticate, gqlError, login, normEmail, requireUser, validatePassword, type AuthUser } from "../shared/auth";
import { parseJson, SUITE_KEYS, SUITES } from "../shared/suites";
import { createTenant } from "./provision";
import { hashPassword, nowIso, uuid, verifyPassword } from "../shared/crypto";
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
const USER_SELECT = `SELECT u.id, u.company_id, u.name, u.email, u.role, u.employee_id, u.pos_terminal, u.active, u.last_login_at, u.created_at, u.platform_role,
       u.role_id, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id AND r.company_id = u.company_id`;

/** CTE de cartera: saldo por venta a crédito confirmada. Parámetro ?1 = company_id. */
const RECV_CTE = `
  WITH paid AS (
    SELECT sale_id, SUM(amount) AS paid FROM payments
     WHERE company_id = ?1 AND deleted = 0 AND sale_id IS NOT NULL AND kind IN ('venta', 'abono') GROUP BY sale_id
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

// ------------------------------------------------------------------ Query

const Query: Record<string, R> = {
  me: async (_s, _a, ctx) => meOf(requireUser(ctx.user)),
  company: async (_s, _a, ctx) => one("SELECT * FROM companies WHERE id = ?", requireUser(ctx.user).company_id),
  users: async (_s, _a, ctx) => {
    const u = requireUser(ctx.user, ["admin"]);
    return all(`${USER_SELECT} WHERE u.company_id = ? ORDER BY u.name`, u.company_id);
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
    const sql = `SELECT p.*, COALESCE(m.qty, 0) AS stock FROM products p
      LEFT JOIN (SELECT product_id, SUM(qty) AS qty FROM stock_moves WHERE company_id = ?1 AND deleted = 0 GROUP BY product_id) m
        ON m.product_id = p.id
      WHERE p.company_id = ?1 AND p.deleted = 0
        AND (?2 IS NULL OR p.name LIKE ?2 OR p.sku LIKE ?2 OR p.barcode LIKE ?2)
        AND (?3 IS NULL OR p.category_id = ?3)
        AND (?4 = 0 OR (p.track_stock = 1 AND COALESCE(m.qty, 0) <= p.min_stock))`;
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
        AND (?6 IS NULL OR s.date >= ?6) AND (?7 IS NULL OR s.date < ?7) AND (?10 IS NULL OR s.pos_session_id = ?10)`;
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
    const [items, agg] = await Promise.all([
      all(
        `SELECT s.*, (SELECT COALESCE(SUM(amount), 0) FROM payments x WHERE x.company_id = s.company_id AND x.sale_id = s.id AND x.deleted = 0) AS paid
         ${sql} ORDER BY s.date DESC, s.id LIMIT ?8 OFFSET ?9`,
        ...binds,
        limit(a.limit),
        offset(a.offset),
        session,
      ),
      one<{ n: number; amount: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN s.status = 'confirmada' THEN s.total END), 0) AS amount ${sql}`,
        ...binds,
        null,
        null,
        session,
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
       FROM pos_sessions ps WHERE ps.company_id = ? AND ps.deleted = 0 AND (? IS NULL OR ps.status = ?)
       ORDER BY ps.opened_at DESC LIMIT ?`,
      u.company_id,
      a.status ?? null,
      a.status ?? null,
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

const Mutation: Record<string, R> = {
  saveRecords: async (_s, a, ctx) => {
    const u = requireUser(ctx.user);
    if (ctx._saved) throw gqlError("Sólo se permite un saveRecords por solicitud");
    ctx._saved = true;
    const prepared = prepareAll(u, a.changes);
    await writeRows(env.DB, u.company_id, prepared);
    return prepared.map((p) => p.values.id);
  },
  deleteRecord: async (_s, a, ctx) => {
    const u = requireUser(ctx.user);
    await writeRows(env.DB, u.company_id, prepareAll(u, [{ table: a.table, row: { id: a.id, deleted: 1 } }]));
    return true;
  },
  login: async (_s, a, ctx) => {
    await loginLimited(ctx, a.email);
    const { token, expiresAt } = await login(a.email, a.password, a.deviceId ?? ctx.deviceId);
    const user = await authenticate(token);
    if (!user) throw gqlError("No se pudo iniciar la sesión");
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
    await createTenant({ name: companyName, nit: s(input.nit, 20), city: s(input.city), phone: s(input.phone, 20), email }, { name, email, password: input.password });
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
    let role = input.role;
    if (input.roleId) {
      const r = await one<{ base_role: string }>("SELECT base_role FROM roles WHERE id = ? AND company_id = ?", input.roleId, u.company_id);
      if (!r) throw gqlError("Rol personalizado no encontrado");
      role = r.base_role;
    }
    const id = uuid();
    await env.DB.prepare(
      "INSERT INTO users (id, company_id, name, email, password_hash, role, role_id, pos_terminal, employee_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, u.company_id, String(input.name).trim(), email, await hashPassword(input.password), role, input.roleId ?? null, input.posTerminal ?? null, input.employeeId ?? null)
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
    stock: async (p, _a, ctx) =>
      p.stock ??
      (
        await one<{ q: number }>(
          "SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves WHERE company_id = ? AND product_id = ? AND deleted = 0",
          ctx.user!.company_id,
          p.id,
        )
      )?.q ??
      0,
    category: (p, _a, ctx) => byId(ctx, "categories", p.category_id),
  },
  Sale: {
    paid: async (s, _a, ctx) => s.paid ?? sumPaid(await children(ctx, "payments", "sale_id", s.id)),
    balance: async (s, _a, ctx) => s.balance ?? s.total - (s.paid ?? sumPaid(await children(ctx, "payments", "sale_id", s.id))),
    partner: (s, _a, ctx) => byId(ctx, "partners", s.partner_id),
    seller: (s, _a, ctx) => byId(ctx, "users", s.seller_id),
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
