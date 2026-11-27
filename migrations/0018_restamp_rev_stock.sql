-- Las escrituras SQL directas del worker API dejaron filas con rev=0 o desactualizado en tablas de stock,
-- así que los POS nunca las descargaron. Se reasignan revisiones nuevas (por encima del contador actual)
-- para que todos los equipos las reciban en su próximo pull.
UPDATE warehouse_stocks SET rev = (SELECT value FROM sync_counter c WHERE c.company_id = warehouse_stocks.company_id)
  + (SELECT COUNT(*) FROM warehouse_stocks w WHERE w.company_id = warehouse_stocks.company_id AND w.rowid <= warehouse_stocks.rowid)
  WHERE company_id IN (SELECT company_id FROM sync_counter);
UPDATE stock_moves SET rev = (SELECT value FROM sync_counter c WHERE c.company_id = stock_moves.company_id)
  + (SELECT COUNT(*) FROM stock_moves w WHERE w.company_id = stock_moves.company_id AND w.rowid <= stock_moves.rowid)
  WHERE rev = 0 AND company_id IN (SELECT company_id FROM sync_counter);
UPDATE requisitions SET rev = (SELECT value FROM sync_counter c WHERE c.company_id = requisitions.company_id)
  + (SELECT COUNT(*) FROM requisitions w WHERE w.company_id = requisitions.company_id AND w.rowid <= requisitions.rowid)
  WHERE company_id IN (SELECT company_id FROM sync_counter);
UPDATE requisition_lines SET rev = (SELECT value FROM sync_counter c WHERE c.company_id = requisition_lines.company_id)
  + (SELECT COUNT(*) FROM requisition_lines w WHERE w.company_id = requisition_lines.company_id AND w.rowid <= requisition_lines.rowid)
  WHERE company_id IN (SELECT company_id FROM sync_counter);
-- Contador por encima de la mayor revisión asignada arriba (cota superior: suma de filas).
UPDATE sync_counter SET value = value
  + (SELECT COUNT(*) FROM warehouse_stocks w WHERE w.company_id = sync_counter.company_id)
  + (SELECT COUNT(*) FROM stock_moves w WHERE w.company_id = sync_counter.company_id)
  + (SELECT COUNT(*) FROM requisitions w WHERE w.company_id = sync_counter.company_id)
  + (SELECT COUNT(*) FROM requisition_lines w WHERE w.company_id = sync_counter.company_id);
