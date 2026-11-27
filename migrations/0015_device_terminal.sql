ALTER TABLE devices ADD COLUMN terminal_code TEXT;
ALTER TABLE devices ADD COLUMN section TEXT;
ALTER TABLE devices ADD COLUMN mac_address TEXT;
ALTER TABLE devices ADD COLUMN hardware_id TEXT;
CREATE INDEX IF NOT EXISTS ix_devices_terminal ON devices(company_id, terminal_code);
