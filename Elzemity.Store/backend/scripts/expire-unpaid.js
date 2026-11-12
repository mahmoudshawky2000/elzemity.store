'use strict';
/** cPanel Cron: one-shot order expiry and stock restoration. No web request or long-lived process. */
const db = require('../server/lib/db');
const orders = require('../server/services/orders');
const logger = require('../server/lib/logger');

(async () => {
  try {
    const count = await orders.expireUnpaidOrders();
    if (count) logger.info('cron: expired unpaid orders cancelled', { count });
    console.log(`Order expiry check OK (${count} cancelled)`);
  } catch (err) {
    logger.error('cron: order expiry failed', { message: err.message });
    console.error('Order expiry failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
