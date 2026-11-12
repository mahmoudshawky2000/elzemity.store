'use strict';
/** Restore a backup into a SEPARATE database and sanity-check it.
 *  node scripts/restore.js <file.sql.gz.enc> --target-db <name>
 *  Refuses to touch the live database unless --overwrite-production is given. */
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const mysql = require('mysql2/promise');
const config = require('../server/config');
const { decryptToSqlStream, verifyBackup } = require('./backup-lib');
const { assertEmptyTarget, assertProductionRestoreAllowed } = require('./restore-guard');

async function restore(file, target, { overwriteProduction = false } = {}) {
  if (!/^[A-Za-z0-9_]+$/.test(target)) throw new Error('Invalid target database name');
  assertProductionRestoreAllowed(target, config.db.database, overwriteProduction, process.env.ALLOW_PRODUCTION_RESTORE);
  console.log('Verifying backup integrity...'); const v = await verifyBackup(file); console.log(`  OK (${v.tables} tables, sha256 ${v.sha256.slice(0, 12)}…)`);
  const admin = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password });
  if (config.sharedHosting) {
    // cPanel owns database creation. Only import into an EXISTING EMPTY staging DB.
    const result = await admin.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [target]);
    try { assertEmptyTarget(result); } catch (err) { await admin.end(); throw err; }
    // Verify database exists; missing DB must not be silently created.
    try { const check = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: target }); await check.end(); }
    catch (err) { await admin.end(); throw new Error(`Create and grant access to staging DB in cPanel first: ${err.message}`); }
  } else {
    // Never drop an existing staging DB implicitly. Reusing a non-empty DB is unsafe.
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const result = await admin.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [target]);
    try { assertEmptyTarget(result); } catch (err) { await admin.end(); throw err; }
  }
  const cli = spawn(process.env.MYSQL_BIN || 'mysql', ['-h', config.db.host, '-P', String(config.db.port), '-u', config.db.user, '--default-character-set=utf8mb4', target], { env: { ...process.env, MYSQL_PWD: config.db.password }, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = ''; cli.stderr.on('data', (d) => { err += d; });
  const done = new Promise((res, rej) => { cli.on('error', rej); cli.on('close', (c) => (c === 0 ? res() : rej(new Error(`mysql client failed: ${err.slice(0, 300)}`)))); });
  await Promise.all([pipeline(decryptToSqlStream(file), cli.stdin), done]);

  // integrity checks on the restored copy
  const db = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: target });
  const report = {};
  for (const t of ['users', 'products', 'orders', 'order_items', 'inventory_movements', 'shipping_payments', 'audit_logs']) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); report[t] = Number(r.n); }
  const checks = {
    orphan_order_items: 'SELECT COUNT(*) n FROM order_items i LEFT JOIN orders o ON o.id = i.order_id WHERE o.id IS NULL',
    negative_stock: 'SELECT COUNT(*) n FROM products WHERE stock_quantity < 0',
    order_total_mismatch: 'SELECT COUNT(*) n FROM orders WHERE ABS(products_total + shipping_fee - grand_total) > 0.001',
    item_total_mismatch: 'SELECT COUNT(*) n FROM order_items WHERE ABS(unit_price * quantity - line_total) > 0.001',
    order_subtotal_mismatch: 'SELECT COUNT(*) n FROM orders o WHERE ABS(o.subtotal - (SELECT COALESCE(SUM(line_total),0) FROM order_items i WHERE i.order_id = o.id)) > 0.001',
    confirmed_without_confirmed_payment: "SELECT COUNT(*) n FROM orders o WHERE o.status IN ('confirmed','processing','shipped','delivered') AND o.shipping_payment_status <> 'confirmed'",
  };
  const problems = [];
  for (const [k, sql] of Object.entries(checks)) { const [[r]] = await db.query(sql); if (Number(r.n)) problems.push(`${k}: ${r.n}`); }
  await db.end(); await admin.end();
  return { counts: report, problems };
}
module.exports = { restore };
if (require.main === module) {
  const args = process.argv.slice(2); const file = args.find((a) => !a.startsWith('--') && a !== args[args.indexOf('--target-db') + 1]);
  const ti = args.indexOf('--target-db'); const target = ti >= 0 ? args[ti + 1] : null;
  if (!file || !target) { console.error('Usage: node scripts/restore.js <backup-file> --target-db <new_db_name> [--overwrite-production]'); process.exit(2); }
  restore(path.resolve(file), target, { overwriteProduction: args.includes('--overwrite-production') })
    .then((r) => { console.log('Row counts:', r.counts); if (r.problems.length) { console.error('INTEGRITY PROBLEMS:', r.problems); process.exit(1); } console.log(`Restore OK into "${target}". Integrity checks passed.`); })
    .catch((e) => { console.error('RESTORE FAILED:', e.message); process.exit(1); });
}
