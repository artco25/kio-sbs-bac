-- Licencias. Dos tipos:
--  · hosted: la empresa vive en ESTE backend (company_id). Una empresa sin licencia es "directa" (sin límites).
--  · remote: un backend esclavo (otro worker clonado) que valida su llave contra este maestro (company_id NULL).
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'hosted' CHECK (kind IN ('hosted', 'remote')),
  company_id TEXT UNIQUE REFERENCES companies(id),
  customer TEXT,             -- nombre del cliente (para licencias remotas)
  license_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  starts_at TEXT,            -- YYYY-MM-DD (NULL = sin fecha de inicio)
  ends_at TEXT,              -- YYYY-MM-DD, inclusive (NULL = sin vencimiento)
  max_devices INTEGER,       -- cajas/equipos; NULL = ilimitado
  max_users INTEGER,         -- NULL = ilimitado
  modules TEXT,              -- JSON con las suites permitidas (NULL = todas)
  notes TEXT,
  last_check_at TEXT,        -- última verificación de un esclavo
  last_usage TEXT,           -- JSON {devices, users, version} informado por el esclavo
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Sólo en un esclavo: última respuesta del maestro (permite operar sin conexión unos días).
CREATE TABLE IF NOT EXISTS license_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  ok_at TEXT NOT NULL
);
