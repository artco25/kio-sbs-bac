-- Fase B: existencias por bodega/producto.
-- Permite asociar productos a bodegas y controlar stock por bodega.

CREATE TABLE IF NOT EXISTS warehouse_stocks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  site_id TEXT REFERENCES sites(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  qty REAL NOT NULL DEFAULT 0,
  min_qty REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_warehouse_stocks_company ON warehouse_stocks(company_id);
CREATE INDEX IF NOT EXISTS ix_warehouse_stocks_wh ON warehouse_stocks(company_id, warehouse_id);
CREATE INDEX IF NOT EXISTS ix_warehouse_stocks_product ON warehouse_stocks(company_id, product_id);
CREATE INDEX IF NOT EXISTS ix_warehouse_stocks_rev ON warehouse_stocks(company_id, rev);
CREATE UNIQUE INDEX IF NOT EXISTS ux_warehouse_stocks_wh_product ON warehouse_stocks(company_id, warehouse_id, product_id) WHERE deleted = 0;

-- Backfill: crear existencias en bodega principal para productos con track_stock.
INSERT INTO warehouse_stocks (id, company_id, site_id, warehouse_id, product_id, qty, min_qty, active, updated_by)
SELECT lower(hex(randomblob(16))), p.company_id, w.site_id, w.id, p.id,
  COALESCE((SELECT SUM(CASE WHEN sm.kind='in' THEN sm.qty WHEN sm.kind='out' THEN -sm.qty WHEN sm.kind='adjust' THEN sm.qty ELSE 0 END)
            FROM stock_moves sm WHERE sm.company_id=p.company_id AND sm.product_id=p.id AND sm.deleted=0), 0),
  COALESCE(p.min_stock, 0), 1, 'migration-0010'
FROM products p
JOIN warehouses w ON w.company_id = p.company_id AND w.is_default = 1 AND w.deleted = 0
WHERE p.deleted = 0
  AND NOT EXISTS (
    SELECT 1 FROM warehouse_stocks ws WHERE ws.company_id=p.company_id AND ws.warehouse_id=w.id AND ws.product_id=p.id AND ws.deleted=0
  );
