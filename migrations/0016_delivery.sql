ALTER TABLE sales ADD COLUMN delivery_user_id TEXT;
ALTER TABLE sales ADD COLUMN delivery_address TEXT;
ALTER TABLE sales ADD COLUMN delivery_status TEXT;
ALTER TABLE sales ADD COLUMN delivery_collected_at TEXT;
ALTER TABLE sales ADD COLUMN delivery_collected_amount REAL NOT NULL DEFAULT 0;
