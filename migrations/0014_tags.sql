CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT,
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_tags_company ON tags(company_id);
CREATE INDEX IF NOT EXISTS ix_tags_rev ON tags(company_id, rev);

CREATE TABLE IF NOT EXISTS product_tags (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_product_tags_company ON product_tags(company_id);
CREATE INDEX IF NOT EXISTS ix_product_tags_product ON product_tags(company_id, product_id);
CREATE INDEX IF NOT EXISTS ix_product_tags_tag ON product_tags(company_id, tag_id);
CREATE INDEX IF NOT EXISTS ix_product_tags_rev ON product_tags(company_id, rev);
CREATE UNIQUE INDEX IF NOT EXISTS ux_product_tags_product_tag ON product_tags(company_id, product_id, tag_id) WHERE deleted = 0;

-- Migrate line1-6 values into tags + product_tags (idempotent, no UNION for D1 compat)
INSERT INTO tags (id, company_id, name, active, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), v.company_id, v.name, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT DISTINCT company_id, trim(line1) AS name FROM products WHERE deleted=0 AND trim(coalesce(line1,''))<>'') v
WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.company_id=v.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(v.name)));
INSERT INTO tags (id, company_id, name, active, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), v.company_id, v.name, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT DISTINCT company_id, trim(line2) AS name FROM products WHERE deleted=0 AND trim(coalesce(line2,''))<>'') v
WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.company_id=v.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(v.name)));
INSERT INTO tags (id, company_id, name, active, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), v.company_id, v.name, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT DISTINCT company_id, trim(line3) AS name FROM products WHERE deleted=0 AND trim(coalesce(line3,''))<>'') v
WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.company_id=v.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(v.name)));
INSERT INTO tags (id, company_id, name, active, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), v.company_id, v.name, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT DISTINCT company_id, trim(line4) AS name FROM products WHERE deleted=0 AND trim(coalesce(line4,''))<>'') v
WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.company_id=v.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(v.name)));
INSERT INTO tags (id, company_id, name, active, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), v.company_id, v.name, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT DISTINCT company_id, trim(line5) AS name FROM products WHERE deleted=0 AND trim(coalesce(line5,''))<>'') v
WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.company_id=v.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(v.name)));
INSERT INTO tags (id, company_id, name, active, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), v.company_id, v.name, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT DISTINCT company_id, trim(line6) AS name FROM products WHERE deleted=0 AND trim(coalesce(line6,''))<>'') v
WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.company_id=v.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(v.name)));

INSERT INTO product_tags (id, company_id, product_id, tag_id, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), p.company_id, p.id, t.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT id, company_id, trim(line1) AS name FROM products WHERE deleted=0 AND trim(coalesce(line1,''))<>'') p
JOIN tags t ON t.company_id=p.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(p.name))
WHERE NOT EXISTS (SELECT 1 FROM product_tags pt WHERE pt.company_id=p.company_id AND pt.product_id=p.id AND pt.tag_id=t.id AND pt.deleted=0);
INSERT INTO product_tags (id, company_id, product_id, tag_id, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), p.company_id, p.id, t.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT id, company_id, trim(line2) AS name FROM products WHERE deleted=0 AND trim(coalesce(line2,''))<>'') p
JOIN tags t ON t.company_id=p.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(p.name))
WHERE NOT EXISTS (SELECT 1 FROM product_tags pt WHERE pt.company_id=p.company_id AND pt.product_id=p.id AND pt.tag_id=t.id AND pt.deleted=0);
INSERT INTO product_tags (id, company_id, product_id, tag_id, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), p.company_id, p.id, t.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT id, company_id, trim(line3) AS name FROM products WHERE deleted=0 AND trim(coalesce(line3,''))<>'') p
JOIN tags t ON t.company_id=p.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(p.name))
WHERE NOT EXISTS (SELECT 1 FROM product_tags pt WHERE pt.company_id=p.company_id AND pt.product_id=p.id AND pt.tag_id=t.id AND pt.deleted=0);
INSERT INTO product_tags (id, company_id, product_id, tag_id, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), p.company_id, p.id, t.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT id, company_id, trim(line4) AS name FROM products WHERE deleted=0 AND trim(coalesce(line4,''))<>'') p
JOIN tags t ON t.company_id=p.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(p.name))
WHERE NOT EXISTS (SELECT 1 FROM product_tags pt WHERE pt.company_id=p.company_id AND pt.product_id=p.id AND pt.tag_id=t.id AND pt.deleted=0);
INSERT INTO product_tags (id, company_id, product_id, tag_id, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), p.company_id, p.id, t.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT id, company_id, trim(line5) AS name FROM products WHERE deleted=0 AND trim(coalesce(line5,''))<>'') p
JOIN tags t ON t.company_id=p.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(p.name))
WHERE NOT EXISTS (SELECT 1 FROM product_tags pt WHERE pt.company_id=p.company_id AND pt.product_id=p.id AND pt.tag_id=t.id AND pt.deleted=0);
INSERT INTO product_tags (id, company_id, product_id, tag_id, created_at, updated_at, deleted, rev)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))), p.company_id, p.id, t.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0
FROM (SELECT id, company_id, trim(line6) AS name FROM products WHERE deleted=0 AND trim(coalesce(line6,''))<>'') p
JOIN tags t ON t.company_id=p.company_id AND t.deleted=0 AND lower(trim(t.name))=lower(trim(p.name))
WHERE NOT EXISTS (SELECT 1 FROM product_tags pt WHERE pt.company_id=p.company_id AND pt.product_id=p.id AND pt.tag_id=t.id AND pt.deleted=0);
