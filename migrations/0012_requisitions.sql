-- Requisiciones / traslados entre bodegas
CREATE TABLE IF NOT EXISTS requisitions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  site_id TEXT REFERENCES sites(id),
  from_warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  to_warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'draft', -- draft, requested, approved, dispatched, received, cancelled
  requested_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  notes TEXT,
  requested_at TEXT,
  approved_at TEXT,
  dispatched_at TEXT,
  received_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_requisitions_company ON requisitions(company_id);
CREATE INDEX IF NOT EXISTS ix_requisitions_status ON requisitions(company_id, status);
CREATE INDEX IF NOT EXISTS ix_requisitions_rev ON requisitions(company_id, rev);

CREATE TABLE IF NOT EXISTS requisition_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  requisition_id TEXT NOT NULL REFERENCES requisitions(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  qty_requested REAL NOT NULL DEFAULT 0,
  qty_dispatched REAL NOT NULL DEFAULT 0,
  qty_received REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_requisition_lines_company ON requisition_lines(company_id);
CREATE INDEX IF NOT EXISTS ix_requisition_lines_req ON requisition_lines(company_id, requisition_id);
CREATE INDEX IF NOT EXISTS ix_requisition_lines_rev ON requisition_lines(company_id, rev);
