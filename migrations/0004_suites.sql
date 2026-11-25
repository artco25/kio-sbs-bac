CREATE TABLE IF NOT EXISTS suites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, code),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS suite_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id INTEGER NOT NULL,
  module_key TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(suite_id, module_key),
  FOREIGN KEY (suite_id) REFERENCES suites(id)
);

INSERT OR IGNORE INTO suites (id, company_id, name, code, active) VALUES
  (1, 1, 'KIO Suite Principal', 'kio-principal', 1);

INSERT OR IGNORE INTO suite_modules (suite_id, module_key, name, enabled) VALUES
  (1, 'financiero', 'Financiero', 1),
  (1, 'comercial', 'Comercial', 1),
  (1, 'pos', 'POS', 1),
  (1, 'admin_personal', 'Admin personal', 1);
