-- Plataforma: super-admin cross-company (dueño KIO/SaaS)
ALTER TABLE users ADD COLUMN platform_role TEXT CHECK (platform_role IN ('owner', 'admin', 'viewer'));
CREATE INDEX IF NOT EXISTS ix_users_platform_role ON users(platform_role);

-- Marcar admin principal como owner de plataforma (ajustar email si aplica)
UPDATE users SET platform_role = 'owner' WHERE email = 'admin@artix.co' AND platform_role IS NULL;
