-- =============================================================================
-- KIO SBS — Roles personalizados por empresa con acceso por suite (estilo artix_admin)
--
-- * Cada empresa crea sus roles: suites a las que entra el usuario (comercial, pos, financiero,
--   personal, sistema) y permiso por tabla: 'r' (consultar) o 'w' (crear/editar).
-- * base_role (admin|contador|cajero|vendedor) define aprobaciones y bloqueos de documentos.
-- * users.role_id NULL = el usuario usa los permisos de su rol base (users.role).
-- =============================================================================
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  description TEXT,
  base_role TEXT NOT NULL DEFAULT 'vendedor' CHECK (base_role IN ('admin', 'contador', 'cajero', 'vendedor')),
  suites TEXT NOT NULL DEFAULT '[]',
  permissions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_roles_company_name ON roles(company_id, name COLLATE NOCASE);

ALTER TABLE users ADD COLUMN role_id TEXT;
CREATE INDEX IF NOT EXISTS ix_users_role ON users(company_id, role_id);
