-- =============================================================================
-- Fase 1: sedes, bodegas y alcance por sede/bodega
-- - Crea sites y warehouses
-- - Agrega configuración de negocio en companies
-- - Agrega site_id/warehouse_id en tablas operativas
-- - Backfill: crea sede y bodega principal por empresa y asigna datos existentes
-- =============================================================================

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  code TEXT,
  kind TEXT NOT NULL DEFAULT 'store', -- store|restaurant|salon|warehouse|cedi|mixed
  business_type TEXT NOT NULL DEFAULT 'full', -- retail|restaurant|service|full
  catalog_mode TEXT NOT NULL DEFAULT 'mixed', -- product|service|mixed
  address TEXT,
  city TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sites_company ON sites(company_id);
CREATE INDEX IF NOT EXISTS ix_sites_rev ON sites(company_id, rev);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  site_id TEXT REFERENCES sites(id),
  name TEXT NOT NULL,
  code TEXT,
  kind TEXT NOT NULL DEFAULT 'store', -- main|store|transit|virtual|returns
  active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_warehouses_company ON warehouses(company_id);
CREATE INDEX IF NOT EXISTS ix_warehouses_site ON warehouses(site_id);
CREATE INDEX IF NOT EXISTS ix_warehouses_rev ON warehouses(company_id, rev);

-- Configuración de negocio en empresa
ALTER TABLE companies ADD COLUMN business_types_enabled TEXT NOT NULL DEFAULT '["retail","restaurant","service","full"]';
ALTER TABLE companies ADD COLUMN catalog_mode_default TEXT NOT NULL DEFAULT 'mixed';
ALTER TABLE companies ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';

-- Alcance por sede
ALTER TABLE users ADD COLUMN site_id TEXT REFERENCES sites(id);
ALTER TABLE devices ADD COLUMN site_id TEXT REFERENCES sites(id);

CREATE INDEX IF NOT EXISTS ix_users_site ON users(company_id, site_id);
CREATE INDEX IF NOT EXISTS ix_devices_site ON devices(company_id, site_id);
CREATE INDEX IF NOT EXISTS ix_pos_sessions_site ON pos_sessions(company_id, site_id);
CREATE INDEX IF NOT EXISTS ix_sales_site ON sales(company_id, site_id);
CREATE INDEX IF NOT EXISTS ix_payments_site ON payments(company_id, site_id);
CREATE INDEX IF NOT EXISTS ix_expenses_site ON expenses(company_id, site_id);
CREATE INDEX IF NOT EXISTS ix_stock_moves_site ON stock_moves(company_id, site_id);
CREATE INDEX IF NOT EXISTS ix_stock_moves_wh ON stock_moves(company_id, warehouse_id);

-- Backfill: sede y bodega principal por empresa
INSERT INTO sites (id, company_id, name, code, kind, business_type, catalog_mode, city, active, is_default, updated_by)
SELECT lower(hex(randomblob(16))), c.id, 'Sede principal', 'SEDE-01', 'mixed', 'full', 'mixed', c.city, 1, 1, 'migration-0009'
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM sites s WHERE s.company_id = c.id AND s.is_default = 1);

INSERT INTO warehouses (id, company_id, site_id, name, code, kind, active, is_default, updated_by)
SELECT lower(hex(randomblob(16))), s.company_id, s.id, 'Bodega principal', 'BOD-01', 'main', 1, 1, 'migration-0009'
FROM sites s
WHERE s.is_default = 1
  AND NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.company_id = s.company_id AND w.is_default = 1);

-- Asignar sede default a datos operativos existentes
UPDATE users SET site_id = (SELECT s.id FROM sites s WHERE s.company_id = users.company_id AND s.is_default = 1 LIMIT 1)
WHERE site_id IS NULL;

UPDATE devices SET site_id = (SELECT s.id FROM sites s WHERE s.company_id = devices.company_id AND s.is_default = 1 LIMIT 1)
WHERE site_id IS NULL;

UPDATE pos_sessions SET site_id = (SELECT s.id FROM sites s WHERE s.company_id = pos_sessions.company_id AND s.is_default = 1 LIMIT 1)
WHERE site_id IS NULL;

UPDATE sales SET site_id = (SELECT s.id FROM sites s WHERE s.company_id = sales.company_id AND s.is_default = 1 LIMIT 1)
WHERE site_id IS NULL;

UPDATE sale_lines SET site_id = (SELECT s.id FROM sites s WHERE s.company_id = sale_lines.company_id AND s.is_default = 1 LIMIT 1)
WHERE site_id IS NULL;

UPDATE payments SET site_id = (SELECT s.id FROM sites s WHERE s.company_id = payments.company_id AND s.is_default = 1 LIMIT 1)
WHERE site_id IS NULL;

UPDATE expenses SET site_id = (SELECT s.id FROM sites s WHERE s.company_id = expenses.company_id AND s.is_default = 1 LIMIT 1)
WHERE site_id IS NULL;

UPDATE stock_moves SET site_id = (SELECT s.id FROM sites s WHERE s.company_id = stock_moves.company_id AND s.is_default = 1 LIMIT 1)
WHERE site_id IS NULL;

UPDATE stock_moves SET warehouse_id = (SELECT w.id FROM warehouses w WHERE w.company_id = stock_moves.company_id AND w.is_default = 1 LIMIT 1)
WHERE warehouse_id IS NULL;
