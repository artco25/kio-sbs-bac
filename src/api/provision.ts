import type { Express, Request, Response } from "express";
import { validatePassword } from "../shared/auth";
import { constantTimeEqual, hashPassword, nowIso, sha256Hex, uuid } from "../shared/crypto";
import { one } from "../shared/data";
import { env } from "../shared/env";
import { prepareChange, upsertStatements, type PreparedRow, type Role } from "../shared/sync";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Parámetros de nómina 2026 (Decreto 1470 de 2025 y Ley 2466 de 2025). Editables desde la app. */
const PAYROLL_2026 = {
  year: 2026,
  smmlv: 1_750_905,
  transport_aid: 249_095,
  uvt: 52_374,
  health_pct: 0.04,
  pension_pct: 0.04,
  hours_divisor: 210, // jornada de 42 h/semana desde el 15-jul-2026
  sunday_surcharge: 0.9, // recargo dominical/festivo 90 % desde el 1-jul-2026
  notes: "SMMLV y auxilio: Decreto 1470/2025. Verificar UVT con la resolución DIAN vigente.",
};

function demoRows(adminId: string) {
  const id = () => uuid();
  const cats = [
    { id: id(), name: "Bebidas", color: "#4A9FD8", sequence: 1 },
    { id: id(), name: "Panadería", color: "#E0A33C", sequence: 2 },
    { id: id(), name: "Abarrotes", color: "#24A756", sequence: 3 },
  ];
  const products = [
    ["Café americano", 0, 4500, 1500, "CAF-01", "7701000000011"],
    ["Jugo natural", 0, 7000, 2500, "JUG-01", "7701000000028"],
    ["Agua 600 ml", 0, 2500, 900, "AGU-01", "7701000000035"],
    ["Pan de masa madre", 1, 14000, 5200, "PAN-01", "7701000000042"],
    ["Croissant de mantequilla", 1, 4800, 1800, "PAN-02", "7701000000059"],
    ["Arroz 1 kg", 2, 5200, 3900, "ARR-01", "7701000000066"],
    ["Aceite 1 L", 2, 12900, 9800, "ACE-01", "7701000000073"],
  ].map(([name, c, price, cost, sku, barcode]) => ({
    id: id(),
    name,
    category_id: cats[c as number].id,
    price,
    cost,
    sku,
    barcode,
    unit: "unidad",
    tax_rate: 0.19,
    track_stock: 1,
    min_stock: 5,
    available_pos: 1,
    active: 1,
  }));
  const moves = products.map((p) => ({ id: id(), product_id: p.id, qty: 50, kind: "ajuste", date: nowIso().slice(0, 10), unit_cost: p.cost, notes: "Inventario inicial" }));
  const partners = [
    { id: id(), name: "Consumidor final", doc_type: "CC", doc_number: "222222222222", is_customer: 1, payment_term_days: 0 },
    { id: id(), name: "Distribuidora La 14 S.A.S.", doc_type: "NIT", doc_number: "900123456-7", city: "Cali", is_customer: 1, credit_limit: 5_000_000, payment_term_days: 30, seller_id: adminId },
    { id: id(), name: "Panificadora Andina Ltda.", doc_type: "NIT", doc_number: "800987654-3", city: "Bogotá", is_supplier: 1, payment_term_days: 30 },
  ];
  const employees = [
    { id: id(), name: "Laura Gómez", doc_type: "CC", doc_number: "1010101010", position: "Cajera", department: "Punto de venta", salary: 1_750_905, start_date: "2025-02-01", contract_type: "indefinido", pay_frequency: "mensual", transport_aid: 1, eps: "Sura", afp: "Porvenir", arl_risk: 1, active: 1 },
    { id: id(), name: "Andrés Rojas", doc_type: "CC", doc_number: "1020202020", position: "Vendedor", department: "Comercial", salary: 2_300_000, start_date: "2024-06-15", contract_type: "indefinido", pay_frequency: "quincenal", transport_aid: 1, eps: "Sanitas", afp: "Protección", arl_risk: 1, active: 1 },
  ];
  return [
    ...cats.map((r) => ["categories", r]),
    ...products.map((r) => ["products", r]),
    ...moves.map((r) => ["stock_moves", r]),
    ...partners.map((r) => ["partners", r]),
    ...employees.map((r) => ["employees", r]),
  ] as [string, Record<string, unknown>][];
}

/**
 * POST /provision — crea una empresa (tenant) con su administrador.
 * Protegido con el secreto PROVISION_TOKEN (header X-Provision-Token). No hay usuarios por defecto.
 */
export function mountProvision(app: Express) {
  app.post("/provision", async (req: Request, res: Response) => {
    const expected = env.PROVISION_TOKEN;
    const given = String(req.headers["x-provision-token"] ?? "");
    const ok =
      !!expected &&
      expected.length >= 24 &&
      constantTimeEqual(new TextEncoder().encode(await sha256Hex(given)), new TextEncoder().encode(await sha256Hex(expected)));
    if (!ok) {
      res.status(401).json({ error: "Token de aprovisionamiento inválido" });
      return;
    }

    const { company, admin, demo } = req.body ?? {};
    const companyName = String(company?.name ?? "").trim();
    const email = String(admin?.email ?? "").trim().toLowerCase();
    if (!companyName || !String(admin?.name ?? "").trim() || !EMAIL_RE.test(email)) {
      res.status(400).json({ error: "company.name, admin.name y admin.email (válido) son obligatorios" });
      return;
    }
    try {
      validatePassword(admin?.password);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    if (await one("SELECT id FROM users WHERE email = ?", email)) {
      res.status(409).json({ error: "Ya existe un usuario con ese correo" });
      return;
    }

    const t = await createTenant({ ...company, name: companyName }, { name: String(admin.name).trim(), email, password: admin.password }, !!demo);
    res.status(201).json({ company: { id: t.companyId, name: companyName }, admin: { id: t.adminId, email }, rows: t.rows });
  });
}

/**
 * Crea una empresa (tenant) con su administrador, contador de sync, parámetros de nómina vigentes
 * y, opcionalmente, datos demo. Lo usan /provision y el auto-registro (mutación signup).
 * El llamador valida datos, unicidad del correo y la contraseña.
 */
export async function createTenant(
  company: { name: string; nit?: string | null; city?: string | null; phone?: string | null; email?: string | null; address?: string | null; businessType?: string | null; hasCedi?: boolean; storeCount?: number },
  admin: { name: string; email: string; password: string },
  demo = false,
) {
  const companyId = uuid();
  const adminId = uuid();
  const sysUser = { id: adminId, company_id: companyId, role: "admin" as Role };
  const now = nowIso();
  const settings = JSON.stringify({ businessType: company.businessType ?? null, hasCedi: !!company.hasCedi, storeCount: company.storeCount ?? 1, onboardingAt: now });
  // id determinista por año y empresa (pp-<año>-<empresa>): dos equipos no pueden crear dos juegos de parámetros del mismo año.
  const rows: [string, Record<string, unknown>][] = [["payroll_params", { id: `pp-${PAYROLL_2026.year}-${companyId}`, ...PAYROLL_2026 }]];
  if (demo) rows.push(...demoRows(adminId));
  const prepared = rows.map(([t, r]) => prepareChange(sysUser, t, r)).filter((r): r is PreparedRow => "values" in r);

  const storeCount = Math.max(1, Math.min(50, Number(company.storeCount ?? 1) || 1));
  const stmts: any[] = [
    env.DB.prepare("INSERT INTO companies (id, name, nit, address, city, phone, email, settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
      companyId,
      company.name,
      company.nit ?? null,
      company.address ?? null,
      company.city ?? null,
      company.phone ?? null,
      company.email ?? null,
      settings,
    ),
    env.DB.prepare("INSERT INTO sync_counter (company_id, value) VALUES (?, 0)").bind(companyId),
    env.DB.prepare("INSERT INTO users (id, company_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, 'admin')").bind(
      adminId,
      companyId,
      admin.name,
      admin.email,
      await hashPassword(admin.password),
    ),
  ];

  const mkId = () => uuid();
  const bType = company.businessType ?? 'full';
  for (let i = 0; i < storeCount; i++) {
    const siteId = mkId();
    const whId = mkId();
    const name = i === 0 ? 'Sede principal' : `Tienda ${i + 1}`;
    const code = `SEDE-${String(i + 1).padStart(2, '0')}`;
    stmts.push(env.DB.prepare("INSERT INTO sites (id, company_id, name, code, kind, business_type, catalog_mode, address, city, active, is_default, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(siteId, companyId, name, code, 'store', bType, 'mixed', company.address ?? null, company.city ?? null, 1, i === 0 ? 1 : 0, 'signup'));
    stmts.push(env.DB.prepare("INSERT INTO warehouses (id, company_id, site_id, name, code, kind, active, is_default, updated_by) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(whId, companyId, siteId, i === 0 ? 'Bodega principal' : `Bodega ${name}`, `BOD-${String(i + 1).padStart(2, '0')}`, 'store', 1, i === 0 ? 1 : 0, 'signup'));
  }
  if (company.hasCedi) {
    const siteId = mkId();
    const whId = mkId();
    stmts.push(env.DB.prepare("INSERT INTO sites (id, company_id, name, code, kind, business_type, catalog_mode, address, city, active, is_default, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(siteId, companyId, 'CEDI', 'CEDI-01', 'cedi', bType, 'mixed', company.address ?? null, company.city ?? null, 1, 0, 'signup'));
    stmts.push(env.DB.prepare("INSERT INTO warehouses (id, company_id, site_id, name, code, kind, active, is_default, updated_by) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(whId, companyId, siteId, 'Bodega CEDI', 'BOD-CEDI', 'main', 1, 0, 'signup'));
  }

  stmts.push(...upsertStatements(env.DB, companyId, prepared));
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  return { companyId, adminId, rows: prepared.length };
}
