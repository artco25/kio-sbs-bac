-- Agregar columnas de estilo a suites y suite_modules
ALTER TABLE suites ADD COLUMN color TEXT NOT NULL DEFAULT '#214F76';
ALTER TABLE suites ADD COLUMN icon TEXT NOT NULL DEFAULT 'layout-grid';
ALTER TABLE suites ADD COLUMN sequence INTEGER NOT NULL DEFAULT 10;
ALTER TABLE suites ADD COLUMN en_pie INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suite_modules ADD COLUMN icon TEXT NOT NULL DEFAULT 'layout-grid';

-- Limpiar datos anteriores
DELETE FROM suite_modules;
DELETE FROM suites;

-- Suites al estilo KIO
INSERT INTO suites (id, company_id, name, code, color, icon, sequence, en_pie, active) VALUES
  (1, 1, 'Inicio', 'inicio', '#214F76', 'layout-dashboard', 0, 0, 1),
  (2, 1, 'Comercial', 'comercial', '#E8577E', 'shopping-bag', 10, 0, 1),
  (3, 1, 'Operaciones', 'operaciones', '#8B6FD6', 'package', 20, 0, 1),
  (4, 1, 'Finanzas y personas', 'finanzas-personas', '#2FD9F4', 'landmark', 30, 0, 1),
  (5, 1, 'Sistema', 'sistema', '#6b7482', 'settings', 99, 1, 1);

INSERT INTO suite_modules (suite_id, module_key, name, icon, enabled) VALUES
  (1, 'dashboard', 'Dashboard', 'layout-dashboard', 1),
  (2, 'crm', 'CRM', 'target', 1),
  (2, 'ventas', 'Ventas', 'shopping-bag', 1),
  (2, 'pos', 'POS', 'store', 1),
  (2, 'website', 'Sitio web', 'globe', 1),
  (2, 'encuestas', 'Encuestas', 'clipboard-list', 1),
  (3, 'compras', 'Compras', 'shopping-cart', 1),
  (3, 'inventario', 'Inventario', 'package', 1),
  (3, 'manufactura', 'Manufactura', 'factory', 1),
  (3, 'proyectos', 'Proyectos', 'square-kanban', 1),
  (4, 'contabilidad', 'Contabilidad', 'receipt-text', 1),
  (4, 'contactos', 'Contactos', 'contact', 1),
  (4, 'rrhh', 'RRHH', 'id-card', 1),
  (5, 'administracion', 'Administración', 'settings', 1),
  (5, 'gestion', 'Gestión', 'blocks', 1);
