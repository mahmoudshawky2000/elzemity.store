'use strict';
const crypto = require('crypto');
const db = require('./db');
class MysqlRateStore {
  constructor(prefix) { this.prefix = prefix; this.localKeys = false; }
  init(options) { this.windowMs = options.windowMs; }
  keyHash(key) { return crypto.createHash('sha256').update(`${this.prefix}:${key}`).digest('hex'); }
  async increment(key) {
    const hash = this.keyHash(key);
    const ms = Math.max(1000, Number(this.windowMs || 60000));
    // Atomic UPSERT; counts survive Passenger restarts and are shared across workers.
    // DATETIME(3) and UTC_TIMESTAMP(3) are supported on MariaDB 11.4 / MySQL 8.
    await db.query(`INSERT INTO rate_limit_buckets (key_hash, hits, reset_at)
      VALUES (?, 1, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND))
      ON DUPLICATE KEY UPDATE
        hits = IF(reset_at <= UTC_TIMESTAMP(3), 1, hits + 1),
        reset_at = IF(reset_at <= UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND), reset_at)`, [hash, ms * 1000, ms * 1000]);
    const [row] = await db.query('SELECT hits, reset_at FROM rate_limit_buckets WHERE key_hash = ?', [hash]);
    if (!row) throw new Error('Rate limit counter unavailable');
    return { totalHits: Number(row.hits), resetTime: new Date(row.reset_at) };
  }
  async decrement(key) {
    await db.query('UPDATE rate_limit_buckets SET hits = IF(hits > 0, hits - 1, 0) WHERE key_hash = ? AND reset_at > UTC_TIMESTAMP(3)', [this.keyHash(key)]);
  }
  async resetKey(key) { await db.query('DELETE FROM rate_limit_buckets WHERE key_hash = ?', [this.keyHash(key)]); }
}
module.exports = { MysqlRateStore };
