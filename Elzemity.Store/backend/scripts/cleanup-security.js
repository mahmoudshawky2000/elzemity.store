'use strict';
const db = require('../server/lib/db');
(async () => {
  await db.query('DELETE FROM rate_limit_buckets WHERE reset_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)');
  console.log('Expired security rate-limit counters removed.');
})().catch(err => { console.error('Security cleanup failed:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
