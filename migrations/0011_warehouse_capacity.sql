-- Capacidad de almacenamiento por bodega/tienda.
ALTER TABLE warehouses ADD COLUMN storage_capacity REAL NOT NULL DEFAULT 0;
