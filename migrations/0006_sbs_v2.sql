-- =============================================================================
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

DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS sale_items;
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS pos_sessions;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS suite_modules;
DROP TABLE IF EXISTS suites;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS health_checks;

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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'contador', 'cajero', 'vendedor')),
  employee_id TEXT,
  pos_terminal TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_users_company ON users(company_id);

-- Sólo se guarda el SHA-256 del token: una fuga de la tabla no permite suplantar sesiones.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_devices_company ON devices(company_id);

-- Contactos
CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT,
  doc_type TEXT,
  doc_number TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  is_customer INTEGER NOT NULL DEFAULT 0,
  is_supplier INTEGER NOT NULL DEFAULT 0,
  credit_limit REAL NOT NULL DEFAULT 0,
  payment_term_days INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  seller_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_partners_rev ON partners(company_id, rev);

-- Categorías
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT,
  color TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_categories_rev ON categories(company_id, rev);

-- Productos
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT,
  sku TEXT,
  barcode TEXT,
  category_id TEXT,
  unit TEXT,
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  track_stock INTEGER NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  available_pos INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_products_rev ON products(company_id, rev);

-- Movimientos de inventario
CREATE TABLE IF NOT EXISTS stock_moves (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  product_id TEXT,
  qty REAL NOT NULL DEFAULT 0,
  kind TEXT,
  ref_id TEXT,
  date TEXT,
  unit_cost REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_stock_moves_rev ON stock_moves(company_id, rev);

-- Sesiones de caja
CREATE TABLE IF NOT EXISTS pos_sessions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  number TEXT,
  terminal TEXT,
  user_id TEXT,
  opened_at TEXT,
  closed_at TEXT,
  opening_cash REAL NOT NULL DEFAULT 0,
  expected_cash REAL NOT NULL DEFAULT 0,
  counted_cash REAL NOT NULL DEFAULT 0,
  difference REAL NOT NULL DEFAULT 0,
  status TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_pos_sessions_rev ON pos_sessions(company_id, rev);

-- Ventas y pedidos
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  number TEXT,
  channel TEXT,
  partner_id TEXT,
  seller_id TEXT,
  pos_session_id TEXT,
  date TEXT,
  due_date TEXT,
  status TEXT,
  payment_mode TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  kitchen_status TEXT,
  table_ref TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sales_rev ON sales(company_id, rev);

-- Líneas de venta
CREATE TABLE IF NOT EXISTS sale_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  sale_id TEXT,
  product_id TEXT,
  name TEXT,
  qty REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sale_lines_rev ON sale_lines(company_id, rev);

-- Pagos y recibos de caja
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  number TEXT,
  kind TEXT,
  sale_id TEXT,
  partner_id TEXT,
  pos_session_id TEXT,
  date TEXT,
  method TEXT,
  amount REAL NOT NULL DEFAULT 0,
  reference TEXT,
  user_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_payments_rev ON payments(company_id, rev);

-- Caja menor y gastos
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  number TEXT,
  date TEXT,
  concept TEXT,
  category TEXT,
  amount REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  partner_id TEXT,
  pos_session_id TEXT,
  status TEXT,
  requested_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  receipt_ref TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_expenses_rev ON expenses(company_id, rev);

-- Empleados
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT,
  doc_type TEXT,
  doc_number TEXT,
  email TEXT,
  phone TEXT,
  position TEXT,
  department TEXT,
  salary REAL NOT NULL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  contract_type TEXT,
  pay_frequency TEXT,
  transport_aid INTEGER NOT NULL DEFAULT 0,
  integral_salary INTEGER NOT NULL DEFAULT 0,
  eps TEXT,
  afp TEXT,
  arl_risk INTEGER NOT NULL DEFAULT 0,
  bank_name TEXT,
  bank_account TEXT,
  user_id TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_employees_rev ON employees(company_id, rev);

-- Novedades de nómina
CREATE TABLE IF NOT EXISTS payroll_novelties (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  employee_id TEXT,
  period TEXT,
  date TEXT,
  type TEXT,
  quantity REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  payslip_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_payroll_novelties_rev ON payroll_novelties(company_id, rev);

-- Vacaciones y permisos
CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  employee_id TEXT,
  type TEXT,
  date_from TEXT,
  date_to TEXT,
  days REAL NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  approved_by TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_leave_requests_rev ON leave_requests(company_id, rev);

-- Desprendibles de nómina
CREATE TABLE IF NOT EXISTS payslips (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  number TEXT,
  employee_id TEXT,
  period TEXT,
  date_from TEXT,
  date_to TEXT,
  days REAL NOT NULL DEFAULT 0,
  basic REAL NOT NULL DEFAULT 0,
  transport REAL NOT NULL DEFAULT 0,
  overtime REAL NOT NULL DEFAULT 0,
  other_earnings REAL NOT NULL DEFAULT 0,
  total_earnings REAL NOT NULL DEFAULT 0,
  health REAL NOT NULL DEFAULT 0,
  pension REAL NOT NULL DEFAULT 0,
  solidarity REAL NOT NULL DEFAULT 0,
  other_deductions REAL NOT NULL DEFAULT 0,
  total_deductions REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0,
  employer_cost REAL NOT NULL DEFAULT 0,
  status TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_payslips_rev ON payslips(company_id, rev);

-- Parámetros de nómina
CREATE TABLE IF NOT EXISTS payroll_params (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  year INTEGER NOT NULL DEFAULT 0,
  smmlv REAL NOT NULL DEFAULT 0,
  transport_aid REAL NOT NULL DEFAULT 0,
  uvt REAL NOT NULL DEFAULT 0,
  health_pct REAL NOT NULL DEFAULT 0,
  pension_pct REAL NOT NULL DEFAULT 0,
  hours_divisor REAL NOT NULL DEFAULT 0,
  sunday_surcharge REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_payroll_params_rev ON payroll_params(company_id, rev);

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
