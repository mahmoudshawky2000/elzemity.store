'use strict';
/** Build TWO synchronized NEW-INSTALL SQL files from immutable migrations.
 * NEVER import either file into an existing production DB.
 * Run from backend/: npm run build:sql
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');
const files = () => fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
const root = path.join(__dirname, '..', 'database');
const migrationFiles = files();
const checksum = (sql) => crypto.createHash('sha256').update(sql).digest('hex');
const schemaMigrations = `CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(20) NOT NULL PRIMARY KEY, name VARCHAR(190) NOT NULL, checksum CHAR(64) NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n`;
let body = schemaMigrations;
for (const file of migrationFiles) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  const version = file.split('_')[0];
  // MariaDB/MySQL refuse to drop uq_order_product while it is the only index serving fk_items_order.
  // Generated NEW-install SQL only: add a plain order_id index first. Migration files stay untouched
  // and the recorded checksum below is still the original file's checksum.
  const installSql = sql.replace('ALTER TABLE order_items DROP INDEX uq_order_product;', 'ALTER TABLE order_items ADD KEY idx_items_order (order_id);\nALTER TABLE order_items DROP INDEX uq_order_product;');
  body += `-- ======== ${file} ========\n${installSql.trimEnd()}\n\n`;
  body += `INSERT INTO schema_migrations (version, name, checksum) VALUES ('${version}','${file}','${checksum(sql)}');\n\n`;
}
const resetSql = fs.readFileSync(path.join(root, '07_password_reset_manual.sql'), 'utf8');
body += `-- ======== password_reset_tokens (existing manual schema; required for reset flow) ========\n${resetSql.trimEnd()}\n`;
// The old 002 migration contains legacy branding; override only in NEW-install SQL.
// Existing stores and their settings are NEVER touched by this generator.
body += `\n-- NEW INSTALL ONLY: default branding; change it from Admin > Settings.\nUPDATE settings SET value = 'ELZEMITY' WHERE key_name = 'store_name' AND value = 'ORIANTAL PERFUMES';\nALTER TABLE products ALTER COLUMN brand SET DEFAULT 'ELZEMITY';\n`;
const cleanHeader = `-- ELZEMITY / EgyHosting CLEAN INSTALL (MySQL 8 / MariaDB 11.x: verify on staging).\n-- For a NEW EMPTY DB only. Select the DB in phpMyAdmin first. NO real products/orders/customers.\n-- Generated from migrations ${migrationFiles[0]} through ${migrationFiles.at(-1)}.\n-- DO NOT import into an existing database.\n\n`;
const fullHeader = `-- ELZEMITY / local NEW INSTALL only. DO NOT import into an existing database.\n-- This file creates/uses oriantal_perfumes; cPanel users should import egyhosting_clean_install.sql instead.\nCREATE DATABASE IF NOT EXISTS \`oriantal_perfumes\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nUSE \`oriantal_perfumes\`;\n\n`;
fs.writeFileSync(path.join(root, 'egyhosting_clean_install.sql'), cleanHeader + body);
fs.writeFileSync(path.join(root, 'oriantal_perfumes_full.sql'), fullHeader + body);
console.log(`Generated synchronized clean/full SQL with ${migrationFiles.length} migrations and password reset table.`);
