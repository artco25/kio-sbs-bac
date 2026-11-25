#!/usr/bin/env node
// Genera la migración D1 y el esquema Dart a partir de schema/tables.json.
//   node scripts/gen-schema.mjs [ruta_dart]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(resolve(root, "schema/tables.json"), "utf8"));
const dartOut = process.argv[2] ?? resolve(root, "../kio-sbs-ft/apps/flutter/lib/data/tables.g.dart");

const SQL_TYPE = { text: "TEXT", int: "INTEGER NOT NULL DEFAULT 0", real: "REAL NOT NULL DEFAULT 0", bool: "INTEGER NOT NULL DEFAULT 0" };
const TS = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const LEGACY = ["payments", "sale_items", "sales", "pos_sessions", "products", "categories", "suite_modules", "suites", "sessions", "users", "companies", "health_checks"];

let sql = `-- =============================================================================
-- KIO SBS v2 — esquema offline-first (GENERADO por scripts/gen-schema.mjs, no editar a mano)
--
-- * IDs TEXT (UUID) generados en el cliente → se pueden crear registros sin internet.
-- * Cada tabla sincronizable lleva updated_at (LWW), deleted (borrado lógico) y
--   rev (secuencia de cambios por empresa, la asigna el servidor desde sync_counter).
-- * Entre tablas sincronizables NO hay FOREIGN KEY: el orden de llegada offline no
--   está garantizado. La integridad se valida en la app y en el endpoint de sync.
-- * Reemplaza las tablas del prototipo (0001-0005), que sólo tenían datos semilla.
-- =============================================================================
PRAGMA defer_foreign_keys = true;

${LEGACY.map((t) => `DROP TABLE IF EXISTS ${t};`).join("\n")}

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nit TEXT,
  address TEXT,
  city TEXT,
  phone TEXT,
  email TEXT,
  currency TEXT NOT NULL DEFAULT 'COP',
  receipt_footer TEXT,
  plan TEXT NOT NULL DEFAULT 'sbs_base',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS}
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (${spec.roles.map((r) => `'${r}'`).join(", ")})),
  employee_id TEXT,
  pos_terminal TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS}
);
CREATE INDEX IF NOT EXISTS ix_users_company ON users(company_id);

-- Sólo se guarda el SHA-256 del token: una fuga de la tabla no permite suplantar sesiones.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  created_at TEXT NOT NULL DEFAULT ${TS},
  last_seen_at TEXT NOT NULL DEFAULT ${TS},
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS sync_counter (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  value INTEGER NOT NULL DEFAULT 0
);

-- Equipos instalados (POS .exe, Linux, móvil): versión, último sync y pendientes.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT,
  name TEXT,
  platform TEXT,
  app_version TEXT,
  last_cursor INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${TS}
);
CREATE INDEX IF NOT EXISTS ix_devices_company ON devices(company_id);
`;

for (const [table, def] of Object.entries(spec.tables)) {
  const cols = Object.entries(def.columns).map(([c, t]) => `  ${c} ${SQL_TYPE[t]}`);
  sql += `
-- ${def.label}
CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
${cols.join(",\n")},
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS},
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_${table}_rev ON ${table}(company_id, rev);
`;
}

// Índices del servidor pensados para las consultas reales (los de "indexes" son para el SQLite local).
sql += `
-- Índices de consulta (parciales: sólo filas vivas)
CREATE INDEX IF NOT EXISTS ix_pay_recv ON payments(company_id, sale_id, amount) WHERE deleted = 0 AND sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_pay_session ON payments(company_id, pos_session_id) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_pay_date ON payments(company_id, date);
CREATE INDEX IF NOT EXISTS ix_sales_recv ON sales(company_id, partner_id, due_date) WHERE deleted = 0 AND status = 'confirmada' AND payment_mode = 'credito';
CREATE INDEX IF NOT EXISTS ix_sales_date ON sales(company_id, date) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_sales_session ON sales(company_id, pos_session_id) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_lines_sale ON sale_lines(company_id, sale_id) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_sm_stock ON stock_moves(company_id, product_id, qty) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_exp_date ON expenses(company_id, date);
CREATE INDEX IF NOT EXISTS ix_slip_emp ON payslips(company_id, employee_id, period);
CREATE INDEX IF NOT EXISTS ix_leave_emp ON leave_requests(company_id, employee_id);
`;
writeFileSync(resolve(root, "migrations/0006_sbs_v2.sql"), sql.replace(/\n{3,}/g, "\n\n"));

// ---------------------------------------------------------------- Dart
const dartType = { text: "ColType.text", int: "ColType.int", real: "ColType.real", bool: "ColType.bool" };
let dart = `// GENERADO por kio-sbs-bk/scripts/gen-schema.mjs desde schema/tables.json — no editar a mano.
// ignore_for_file: constant_identifier_names

enum ColType { text, int, real, bool }

class TableSpec {
  final String name;
  final String label;
  final String axis;
  final Map<String, ColType> columns;
  final List<String> read;
  final List<String> write;
  final List<List<String>> indexes;
  const TableSpec(this.name, this.label, this.axis, this.columns, this.read, this.write, this.indexes);

  bool canRead(String role) => read.contains('*') || read.contains(role);
  bool canWrite(String role) => write.contains(role);
}

const kRoles = <String>[${spec.roles.map((r) => `'${r}'`).join(", ")}];

const kTables = <String, TableSpec>{
`;
for (const [table, def] of Object.entries(spec.tables)) {
  const read = def.read === "*" ? ["*"] : def.read;
  dart += `  '${table}': TableSpec('${table}', '${def.label}', '${def.axis}', {
${Object.entries(def.columns).map(([c, t]) => `    '${c}': ${dartType[t]},`).join("\n")}
  }, [${read.map((r) => `'${r}'`).join(", ")}], [${def.write.map((r) => `'${r}'`).join(", ")}], [${(def.indexes ?? []).map((ix) => `[${ix.map((c) => `'${c}'`).join(", ")}]`).join(", ")}]),
`;
}
dart += "};\n";
try {
  writeFileSync(dartOut, dart);
  console.log("dart  →", dartOut);
} catch (e) {
  console.warn("dart  → omitido:", e.message);
}
console.log("sql   → migrations/0006_sbs_v2.sql");
