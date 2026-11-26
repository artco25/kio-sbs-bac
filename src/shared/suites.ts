import type { Role } from "./sync";

/**
 * Suites de KIO SBS (equivalente reducido de artix_admin): cada suite agrupa módulos (tablas).
 * Un rol personalizado define a qué suites entra el usuario y, por tabla, si lee ('r') o escribe ('w').
 */
export const SUITES = {
  comercial: { label: "Comercial", tables: ["partners", "products", "categories", "stock_moves", "sales", "sale_lines", "payments"] },
  pos: { label: "Punto de venta", tables: ["pos_sessions", "sales", "sale_lines", "payments", "stock_moves", "products", "categories", "partners", "expenses"] },
  inventario: { label: "Inventario", tables: ["products", "categories", "stock_moves", "warehouse_stocks", "warehouses", "sites"] },
  financiero: { label: "Financiero", tables: ["payments", "expenses", "sales", "sale_lines", "partners"] },
  personal: { label: "Personal y nómina", tables: ["employees", "payroll_novelties", "leave_requests", "payslips", "payroll_params"] },
  sistema: { label: "Sistema", tables: [] as string[] },
} as const;

export type SuiteKey = keyof typeof SUITES;
export const SUITE_KEYS = Object.keys(SUITES) as SuiteKey[];

/** Suites por defecto de los roles base (usuarios sin rol personalizado). */
export const DEFAULT_SUITES: Record<Role, SuiteKey[]> = {
  admin: ["comercial", "pos", "inventario", "financiero", "personal", "sistema"],
  contador: ["comercial", "inventario", "financiero", "personal"],
  cajero: ["pos"],
  vendedor: ["comercial"],
};

export type Perms = Record<string, "r" | "w">;

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
