-- Migración inicial KIO SBS
CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO health_checks (service, status) VALUES ('kio-sbs-bk', 'ok');
