'use strict';
/** Read-only production preflight: no schema changes, no user/order writes. */
const db = require('../server/lib/db');
const config = require('../server/config');
(async () => {
  try {
    if (!config.sharedHosting) throw new Error('Set HOSTING_MODE=egyhosting to run this check.');
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (nodeMajor < 22 || nodeMajor >= 25) throw new Error(`Node.js ${process.versions.node} is outside the supported 22/24 range.`);
    if (!/^[a-f0-9]{64}$/i.test(config.backup.keyHex)) throw new Error('BACKUP_ENCRYPTION_KEY must be a real 64-hex key before enabling backup jobs.');
    for (const dir of [config.upload.dir, config.logDir, config.backup.dir]) {
      if (/(^|[\\/])public_html([\\/]|$)/i.test(dir)) throw new Error(`Private storage path must be outside public_html: ${dir}`);
    }
    const [v] = await db.query('SELECT VERSION() AS version, DATABASE() AS db_name');
    const rows = await db.query('SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema = DATABASE()');
    const found = new Set(rows.map((r) => r.table_name));
    const required = ['schema_migrations', 'products', 'product_variants', 'orders', 'order_items', 'inventory_movements', 'users', 'sessions', 'shipping_payments', 'audit_logs', 'newsletter_subscribers', 'backup_runs', 'rate_limit_buckets', 'password_reset_tokens', 'order_refunds'];
    const missing = required.filter((t) => !found.has(t));
    console.log(`Database: ${v.db_name}; engine: ${v.version}; tables: ${found.size}`);
    if (missing.length) throw new Error('Missing required tables: ' + missing.join(', '));
    const requiredColumns = {
      users: ['password_hash', 'password_changed_at'],
      products: ['stock_quantity', 'fragrance_notes', 'deleted_at'],
      orders: ['customer_note', 'stock_restored'],
      order_items: ['variant_id'],
      product_variants: ['size_label', 'price', 'is_active'],
      rate_limit_buckets: ['key_hash', 'hits', 'reset_at'],
      password_reset_tokens: ['user_id', 'token_hash', 'expires_at'],
      order_refunds: ['order_id', 'amount', 'method', 'external_reference', 'processed_by'],
    };
    const columns = await db.query('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = DATABASE()');
    const presentColumns = new Set(columns.map((c) => `${c.table_name}.${c.column_name}`));
    const missingColumns = Object.entries(requiredColumns).flatMap(([table, names]) => names.filter((name) => !presentColumns.has(`${table}.${name}`)).map((name) => `${table}.${name}`));
    if (missingColumns.length) throw new Error('Missing required columns: ' + missingColumns.join(', ') + '. Check migrations on staging first.');
    const [m] = await db.query('SELECT COUNT(*) AS n FROM schema_migrations');
    console.log(`Recorded migrations: ${m.n}; required tables and password tracking: OK (2FA is disabled and not required).`);
    const applied = await db.query("SELECT version FROM schema_migrations WHERE version IN ('008','009')");
    const recorded = new Set(applied.map((r) => r.version));
    if (!recorded.has('008') || !recorded.has('009')) console.warn('WARNING: security migrations 008/009 not fully recorded. Existing DB may have been manually patched; do not run blanket npm run migrate.');
    if (!String(v.version).toLowerCase().includes('mariadb')) console.warn('Warning: server is not reporting MariaDB. Confirm database engine with hosting.');
    console.log('READ-ONLY PREFLIGHT PASSED. Still test real order flows on a staging copy before launch.');
  } catch (err) { console.error('PREFLIGHT FAILED:', err.message); process.exitCode = 1; }
  finally { await db.pool.end(); }
})();
