'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../lib/db');
const config = require('../config');
const realtime = require('../lib/realtime');
const { audit } = require('../lib/audit');
const orders = require('../services/orders');
const catalog = require('../services/catalog');
const { sizeKey, visibleVariants, syncProductVariants } = require('../services/product-variants');
const { fromCents, toCents } = require('../lib/money');
const { validate } = require('../middleware/core');
const { requireStaff, requirePermission } = require('../middleware/auth');
const { badRequest, notFound, conflict, unprocessable, AppError } = require('../lib/errors');

const { imageUpload, saveProductImage, removeProductImage, LOCAL_IMG } = require('../middleware/upload');
const router = express.Router();
router.use(requireStaff); // every /api/admin route needs a logged-in non-customer; each route then checks its own permission
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const idParam = (req, res, next) => (/^\d{1,12}$/.test(req.params.id) ? next() : next(badRequest('Invalid id')));
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().trim().max(80).optional(),
  status: z.enum(orders.STATUS_LIST).optional(),
  paymentStatus: z.enum(['unpaid', 'submitted', 'confirmed', 'rejected', 'refunded']).optional(),
  productId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(40).optional(),
});
const money = z.number().min(0).max(99999999.99).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places');
const moneyStr = (n) => n.toFixed(2);

/* Lightweight, permission-scoped REST polling for Passenger/shared hosting.
 * Cursor starts at current audit ID, so login does not replay old notifications.
 * No customer data is exposed; all updates are read from the committed DB. */
router.get('/poll', wrap(async (req, res) => {
  const raw = req.query.since;
  if (raw !== undefined && (typeof raw !== 'string' || !/^(0|[1-9]\d{0,14})$/.test(raw))) throw badRequest('Invalid polling cursor');
  const allowed = new Set();
  const perms = new Set(req.user.permissions);
  if (perms.has('orders.view')) {
    ['order.created', 'order.status_changed', 'order.auto_cancelled', 'order.cod_collected', 'order.cod_not_collected',
      'shipping_payment.submitted', 'shipping_payment.confirmed', 'shipping_payment.rejected'].forEach((a) => allowed.add(a));
  } else if (perms.has('shipping_payments.review')) {
    ['shipping_payment.submitted', 'shipping_payment.confirmed', 'shipping_payment.rejected'].forEach((a) => allowed.add(a));
  }
  if (perms.has('inventory.manage') || perms.has('products.manage')) {
    ['product.created', 'product.updated', 'product.image_uploaded', 'product.deleted', 'inventory.adjusted',
      'order.created', 'order.auto_cancelled', 'order.status_changed'].forEach((a) => allowed.add(a));
  }
  let cursor = 0;
  let events = [];
  if (raw === undefined) {
    const [latest] = await db.query('SELECT COALESCE(MAX(id),0) AS id FROM audit_logs');
    cursor = Number(latest.id);
  } else {
    const rows = await db.query('SELECT id, action, details FROM audit_logs WHERE id > ? ORDER BY id ASC LIMIT 100', [Number(raw)]);
    cursor = rows.length ? Number(rows[rows.length - 1].id) : Number(raw);
    events = rows.filter((r) => allowed.has(r.action)).map((r) => {
      let details = r.details;
      if (typeof details === 'string') { try { details = JSON.parse(details); } catch { details = null; } }
      const orderAccess = perms.has('orders.view') || (perms.has('shipping_payments.review') && r.action.startsWith('shipping_payment.'));
      const action = !orderAccess && r.action.startsWith('order.') ? 'inventory.adjusted' : r.action;
      return { action, orderNumber: orderAccess && typeof details?.orderNumber === 'string' ? details.orderNumber : undefined };
    });
  }
  let newsletterLatest = null;
  if (perms.has('newsletter.manage')) {
    const [n] = await db.query('SELECT COALESCE(MAX(id),0) AS id FROM newsletter_subscribers');
    newsletterLatest = Number(n.id);
  }
  res.set('Cache-Control', 'no-store');
  res.json({ cursor, events, newsletterLatest });
}));

/* ============================ ORDERS ============================ */
router.get('/orders', requirePermission('orders.view'), validate(pageQuery, 'query'), wrap(async (req, res) => {
  res.json(await orders.listOrders(req.query));
}));
router.get('/orders/:id', requirePermission('orders.view'), idParam, wrap(async (req, res) => {
  res.json({ order: await orders.getOrderForStaff(Number(req.params.id)) });
}));
router.post('/orders/:id/status', requirePermission('orders.manage'), idParam,
  validate(z.strictObject({ status: z.enum(orders.STATUS_LIST), reason: z.string().trim().max(255).optional() })),
  wrap(async (req, res) => {
    const r = await orders.changeStatus({ orderId: Number(req.params.id), to: req.body.status, reason: req.body.reason, req });
    res.json({ result: r });
  }));
router.post('/orders/:id/shipping-payment/confirm', requirePermission('shipping_payments.review'), idParam,
  validate(z.strictObject({ amount: money.refine((v) => v > 0, 'Must be greater than zero'), note: z.string().trim().max(255).optional() })),
  wrap(async (req, res) => {
    const r = await orders.confirmShippingPayment({ orderId: Number(req.params.id), amount: moneyStr(req.body.amount), note: req.body.note, req });
    res.json({ result: r });
  }));
router.post('/orders/:id/shipping-payment/reject', requirePermission('shipping_payments.review'), idParam,
  validate(z.strictObject({ reason: z.string().trim().min(3).max(255) })),
  wrap(async (req, res) => {
    const r = await orders.rejectShippingPayment({ orderId: Number(req.params.id), reason: req.body.reason, req });
    res.json({ result: r });
  }));
router.post('/orders/:id/cod', requirePermission('orders.manage'), idParam,
  validate(z.strictObject({ collected: z.boolean(), amount: money.optional() })),
  wrap(async (req, res) => {
    if (req.body.collected && req.body.amount === undefined) throw badRequest('amount is required when collected is true');
    const r = await orders.recordCod({ orderId: Number(req.params.id), collected: req.body.collected, amount: req.body.amount === undefined ? undefined : moneyStr(req.body.amount), req });
    res.json({ result: r });
  }));

// Returned items are restocked only after inspection; refund records reflect external transfers only.
router.post('/orders/:id/return-restock', requirePermission('orders.manage'), idParam,
  validate(z.strictObject({ reason: z.string().trim().min(3).max(255) })),
  wrap(async (req, res) => res.json({ result: await orders.restockReturnedOrder({ orderId: Number(req.params.id), reason: req.body.reason, req }) })));
router.post('/orders/:id/refunds', requirePermission('orders.manage'), idParam,
  validate(z.strictObject({ amount: money.refine(v => v > 0), method: z.enum(['instapay', 'bank_transfer', 'cash', 'other']), reference: z.string().trim().min(3).max(120), reason: z.string().trim().min(3).max(255) })),
  wrap(async (req, res) => res.status(201).json({ result: await orders.recordRefund({ orderId: Number(req.params.id), ...req.body, amount: moneyStr(req.body.amount), req }) })));

// Receipt images are private: only reviewers can fetch them, never publicly served.
router.get('/shipping-payments/:id/receipt', requirePermission('shipping_payments.review'), idParam, wrap(async (req, res) => {
  const [p] = await db.query('SELECT receipt_file, receipt_mime FROM shipping_payments WHERE id = ?', [Number(req.params.id)]);
  if (!p || !p.receipt_file) throw notFound('Receipt not found');
  const file = path.join(config.upload.dir, path.basename(p.receipt_file));
  if (!fs.existsSync(file)) throw notFound('Receipt file is missing');
  res.set({ 'Content-Type': p.receipt_mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' });
  fs.createReadStream(file).pipe(res);
}));

/* ============================ PRODUCTS ============================ */
const productBase = z.strictObject({
  name: z.string().trim().min(2).max(160),
  brand: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(60),
  family: z.string().trim().max(160).nullable(),
  notes: z.string().trim().max(1000).nullable(),
  sizeLabel: z.string().trim().max(40).nullable(),
  price: money,
  compareAtPrice: money.nullable(),
  tag: z.string().trim().max(40).nullable(),
  description: z.string().trim().max(5000).nullable(),
  imageUrl: z.string().trim().max(500).refine((u) => /^https:\/\/[^\s"'<>]+$/.test(u) || LOCAL_IMG.test(u), 'Image URL must be an https:// URL (or use the upload button)').nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(-100000).max(100000),
  variants: z.array(z.strictObject({ size: z.string().trim().min(1).max(40), price: money, compareAtPrice: money.nullable().optional() })).min(1).max(30).refine(v => new Set(v.map(x => sizeKey(x.size))).size === v.length, 'Variant sizes must be unique').optional(),
});
const productCreate = productBase.partial({ brand: true, family: true, notes: true, sizeLabel: true, compareAtPrice: true, tag: true, description: true, imageUrl: true, isActive: true, sortOrder: true })
  .extend({ stock: z.number().int().min(0).max(100000).default(0) });
const productUpdate = productBase.partial(); // stock is NOT editable here: stock changes go through /stock so they are logged as movements

const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
async function categoryId(name) {
  const [c] = await db.query('SELECT id FROM categories WHERE name = ?', [name]);
  if (!c) throw unprocessable(`Unknown category "${name}"`, 'UNKNOWN_CATEGORY');
  return c.id;
}
const productRow = async (id) => {
  const [r] = await db.query('SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?', [id]);
  return r;
};
const adminProduct = (r, variants = []) => ({ id: Number(r.id), slug: r.slug, name: r.name, brand: r.brand, category: r.category_name, family: r.family, notes: r.fragrance_notes, sizeLabel: r.size_label, price: Number(r.price), compareAtPrice: r.compare_at_price === null ? null : Number(r.compare_at_price), tag: r.tag, description: r.description, imageUrl: r.image_url, stock: r.stock_quantity, isActive: !!r.is_active, sortOrder: r.sort_order, deleted: !!r.deleted_at, variants: visibleVariants(variants).map(v => ({ id: Number(v.id), size: v.size_label, price: Number(v.price), compareAtPrice: v.compare_at_price == null ? null : Number(v.compare_at_price) })) });
const variantsFor = async (ids, conn = null) => { if (!ids.length) return []; const sql = `SELECT * FROM product_variants WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order, id`; const [rows] = conn ? await conn.execute(sql, ids) : [await db.query(sql, ids)]; return rows; };
const adminProductWithVariants = async (r) => adminProduct(r, await variantsFor([r.id]));

router.get('/products', requirePermission('products.manage', 'inventory.manage'), validate(pageQuery, 'query'), wrap(async (req, res) => {
  const { q, page = 1, limit = 50 } = req.query;
  const params = []; let where = 'p.deleted_at IS NULL';
  if (q) { where += ' AND (p.name LIKE ? OR p.slug LIKE ?)'; const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`; params.push(like, like); }
  const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM products p WHERE ${where}`, params);
  const rows = await db.query(`SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id WHERE ${where} ORDER BY p.sort_order, p.id LIMIT ${Number(limit)} OFFSET ${Number((page - 1) * limit)}`, params);
  const variants = await variantsFor(rows.map(r => r.id)); const byProduct = new Map(); for (const v of variants) { const k = Number(v.product_id); if (!byProduct.has(k)) byProduct.set(k, []); byProduct.get(k).push(v); }
  res.json({ items: rows.map(r => adminProduct(r, byProduct.get(Number(r.id)) || [])), page, limit, total: Number(total) });
}));

router.post('/products', requirePermission('products.manage'), validate(productCreate), wrap(async (req, res) => {
  const b = req.body;
  const catId = await categoryId(b.category);
  const base = slugify(b.name) || 'product';
  let id;
  for (let i = 0; i < 6 && !id; i++) {
    const slug = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      id = await db.withTransaction(async (conn) => {
        const [ins] = await conn.execute(
          'INSERT INTO products (slug, name, brand, category_id, family, fragrance_notes, size_label, price, compare_at_price, tag, description, image_url, stock_quantity, is_active, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [slug, b.name, b.brand ?? 'ELZEMITY', catId, b.family ?? null, b.notes ?? null, b.sizeLabel ?? null, moneyStr(b.price), b.compareAtPrice == null ? null : moneyStr(b.compareAtPrice), b.tag ?? null, b.description ?? null, b.imageUrl ?? null, b.stock, b.isActive === false ? 0 : 1, b.sortOrder ?? 0]);
        const variantRows = b.variants?.length ? b.variants : [{ size: b.sizeLabel || 'Standard', price: b.price, compareAtPrice: b.compareAtPrice ?? null }];
        for (let vi = 0; vi < variantRows.length; vi++) { const v = variantRows[vi]; await conn.execute('INSERT INTO product_variants (product_id, size_label, price, compare_at_price, sort_order) VALUES (?,?,?,?,?)', [ins.insertId, v.size, moneyStr(v.price), v.compareAtPrice == null ? null : moneyStr(v.compareAtPrice), vi]); }
        if (b.stock > 0) {
          await conn.execute("INSERT INTO inventory_movements (product_id, change_qty, quantity_after, reason, reference_type, reference_id, note, user_id) VALUES (?,?,?,'initial','product',?,?,?)", [ins.insertId, b.stock, b.stock, ins.insertId, 'initial stock', req.user.id]);
        }
        await audit(req, 'product.created', 'product', ins.insertId, { name: b.name, price: moneyStr(b.price), stock: b.stock }, conn);
        return ins.insertId;
      });
    } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
  }
  if (!id) throw conflict('Could not generate a unique slug');
  realtime.emit('public', 'product:updated', { productId: id });
  realtime.emit('staff:inventory', 'inventory:updated', { productId: id, quantity: b.stock });
  res.status(201).json({ product: await adminProductWithVariants(await productRow(id)) });
}));

router.patch('/products/:id', requirePermission('products.manage'), idParam, validate(productUpdate), wrap(async (req, res) => {
  const id = Number(req.params.id); const b = req.body;
  if (!Object.keys(b).length) throw badRequest('No fields to update');
  const map = { name: 'name', brand: 'brand', family: 'family', notes: 'fragrance_notes', sizeLabel: 'size_label', price: 'price', compareAtPrice: 'compare_at_price', tag: 'tag', description: 'description', imageUrl: 'image_url', isActive: 'is_active', sortOrder: 'sort_order' }; // allowlist of columns
  const sets = []; const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] === undefined) continue;
    let v = b[k];
    if (k === 'price' || (k === 'compareAtPrice' && v !== null)) v = moneyStr(v);
    if (k === 'isActive') v = v ? 1 : 0;
    sets.push(`${col} = ?`); params.push(v);
  }
  if (b.category !== undefined) { sets.push('category_id = ?'); params.push(await categoryId(b.category)); }
  await db.withTransaction(async (conn) => {
    const [[old]] = await conn.execute('SELECT price, is_active, name FROM products WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!old) throw notFound('Product not found');
    if (sets.length) await conn.execute(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    if (b.variants) {
      const sizes = b.variants.map(v => v.size); if (new Set(sizes.map(sizeKey)).size !== sizes.length) throw badRequest('Variant sizes must be unique');
      await syncProductVariants(conn, id, b.variants, moneyStr);
    }
    await audit(req, 'product.updated', 'product', id, { fields: Object.keys(b), oldPrice: old.price, newPrice: b.price === undefined ? undefined : moneyStr(b.price), oldActive: !!old.is_active, newActive: b.isActive }, conn);
  });
  realtime.emit('public', 'product:updated', { productId: id });
  res.json({ product: await adminProductWithVariants(await productRow(id)) });
}));

router.post('/products/:id/image', requirePermission('products.manage'), idParam, (req, res, next) => imageUpload(req, res, next), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!req.file) throw badRequest('Choose an image file (field name: image)');
  const [p] = await db.query('SELECT image_url FROM products WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!p) throw notFound('Product not found');
  const saved = await saveProductImage(req.file);
  try {
    await db.withTransaction(async (conn) => {
      await conn.execute('UPDATE products SET image_url = ? WHERE id = ?', [saved.url, id]);
      await audit(req, 'product.image_uploaded', 'product', id, { file: saved.name }, conn);
    });
  } catch (e) { await removeProductImage(saved.url); throw e; }
  await removeProductImage(p.image_url); // old uploaded file is no longer referenced
  realtime.emit('public', 'product:updated', { productId: id });
  res.json({ imageUrl: saved.url });
}));

router.delete('/products/:id', requirePermission('products.manage'), idParam, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.query('UPDATE products SET deleted_at = UTC_TIMESTAMP(), is_active = 0 WHERE id = ? AND deleted_at IS NULL', [id]);
  if (u.affectedRows !== 1) throw notFound('Product not found');
  await audit(req, 'product.deleted', 'product', id, { soft: true });
  realtime.emit('public', 'product:updated', { productId: id });
  res.json({ ok: true });
}));

/* ============================ INVENTORY ============================ */
router.post('/products/:id/stock', requirePermission('inventory.manage'), idParam,
  validate(z.strictObject({ mode: z.enum(['delta', 'set']), quantity: z.number().int().min(-100000).max(100000), note: z.string().trim().min(3).max(255) })),
  wrap(async (req, res) => {
    const id = Number(req.params.id); const { mode, quantity, note } = req.body;
    if (mode === 'set' && quantity < 0) throw badRequest('Stock cannot be negative');
    const result = await db.withTransaction(async (conn) => {
      const [[p]] = await conn.execute('SELECT id, stock_quantity FROM products WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
      if (!p) throw notFound('Product not found');
      const target = mode === 'set' ? quantity : p.stock_quantity + quantity;
      if (target < 0) throw unprocessable(`Stock cannot go below zero (current: ${p.stock_quantity})`, 'NEGATIVE_STOCK');
      const change = target - p.stock_quantity;
      if (change === 0) return { quantity: target, change };
      const [u] = await conn.execute('UPDATE products SET stock_quantity = ? WHERE id = ? AND stock_quantity = ?', [target, id, p.stock_quantity]);
      if (u.affectedRows !== 1) throw conflict('Stock changed concurrently, retry');
      await conn.execute("INSERT INTO inventory_movements (product_id, change_qty, quantity_after, reason, reference_type, reference_id, note, user_id) VALUES (?,?,?,'manual_adjust','adjust',0,?,?)", [id, change, target, note, req.user.id]);
      await audit(req, 'inventory.adjusted', 'product', id, { from: p.stock_quantity, to: target, note }, conn);
      return { quantity: target, change };
    });
    if (result.change !== 0) orders.emitStock(id, result.quantity);
    res.json({ productId: id, ...result });
  }));

router.get('/reports/summary', requirePermission('orders.view', 'inventory.manage', 'products.manage'), wrap(async (req, res) => {
  res.json(await require('../services/sales-report').getSalesSummary(req.query));
}));

router.get('/inventory/movements', requirePermission('inventory.manage', 'products.manage'), validate(pageQuery, 'query'), wrap(async (req, res) => {
  const { productId, page = 1, limit = 50 } = req.query;
  const params = []; let where = '1=1';
  if (productId) { where += ' AND m.product_id = ?'; params.push(productId); }
  const rows = await db.query(`SELECT m.id, m.product_id, p.name AS product, m.change_qty, m.quantity_after, m.reason, m.reference_type, m.reference_id, m.note, u.name AS actor, m.created_at FROM inventory_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id WHERE ${where} ORDER BY m.id DESC LIMIT ${Number(limit)} OFFSET ${Number((page - 1) * limit)}`, params);
  res.json({ items: rows, page, limit });
}));

/* ============================ SETTINGS / ZONES / COUPONS ============================ */
const settingsSchema = z.strictObject({
  store_name: z.string().trim().min(1).max(60),
  instapay_handle: z.string().trim().max(100),
  instapay_account_name: z.string().trim().max(100),
  shipping_payment_window_hours: z.number().int().min(1).max(720).transform(String),
  low_stock_threshold: z.number().int().min(0).max(100).transform(String),
  full_advance_enabled: z.boolean().transform(v => v ? '1' : '0'),
  shipping_only_enabled: z.boolean().transform(v => v ? '1' : '0'),
  contact_whatsapp: z.string().trim().max(30).refine(v => !v || /^[+0-9()\s-]{8,30}$/.test(v), 'Invalid WhatsApp number'),
  contact_whatsapp_enabled: z.boolean().transform(v => v ? '1' : '0'),
  social_accounts: z.array(z.strictObject({ platform: z.string().trim().min(2).max(30), url: z.string().trim().max(500).url().refine(u => /^https?:\/\//i.test(u), 'Only HTTP/HTTPS URLs are allowed'), enabled: z.boolean() })).max(20).transform(v => JSON.stringify(v)),
}).partial();
router.get('/settings', requirePermission('settings.manage'), wrap(async (req, res) => res.json({ settings: await catalog.getSettings() })));
router.put('/settings', requirePermission('settings.manage'), validate(settingsSchema), wrap(async (req, res) => {
  const entries = Object.entries(req.body);
  if (!entries.length) throw badRequest('No settings supplied');
  await db.withTransaction(async (conn) => {
    for (const [k, v] of entries) await conn.execute('INSERT INTO settings (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [k, v]);
    await audit(req, 'settings.updated', 'settings', null, req.body, conn);
  });
  res.json({ settings: await catalog.getSettings() });
}));

router.get('/shipping-zones', requirePermission('settings.manage'), wrap(async (req, res) => {
  const rows = await db.query('SELECT id, governorate, fee, is_active FROM shipping_zones ORDER BY governorate');
  res.json({ items: rows.map((z) => ({ id: z.id, governorate: z.governorate, fee: Number(z.fee), isActive: !!z.is_active })) });
}));
router.patch('/shipping-zones/:id', requirePermission('settings.manage'), idParam,
  validate(z.strictObject({ fee: money.optional(), isActive: z.boolean().optional() })), wrap(async (req, res) => {
    const { fee, isActive } = req.body;
    if (fee === undefined && isActive === undefined) throw badRequest('Nothing to update');
    const [old] = await db.query('SELECT fee, is_active FROM shipping_zones WHERE id = ?', [Number(req.params.id)]);
    if (!old) throw notFound('Zone not found');
    await db.query('UPDATE shipping_zones SET fee = COALESCE(?, fee), is_active = COALESCE(?, is_active) WHERE id = ?', [fee === undefined ? null : moneyStr(fee), isActive === undefined ? null : (isActive ? 1 : 0), Number(req.params.id)]);
    await audit(req, 'shipping_zone.updated', 'shipping_zone', req.params.id, { oldFee: old.fee, newFee: fee, isActive });
    res.json({ ok: true });
  }));

const couponBase = z.strictObject({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: money.refine((v) => v > 0, 'Must be greater than zero'),
  minSubtotal: money,
  maxUses: z.number().int().min(1).max(10000000).nullable(),
  expiresAt: z.iso.datetime().nullable(),
  isActive: z.boolean(),
});
router.get('/coupons', requirePermission('settings.manage'), wrap(async (req, res) => res.json({ items: await db.query('SELECT id, code, discount_type, discount_value, min_subtotal, max_uses, used_count, expires_at, is_active FROM coupons ORDER BY id DESC LIMIT 200') })));
router.post('/coupons', requirePermission('settings.manage'),
  validate(couponBase.partial({ minSubtotal: true, maxUses: true, expiresAt: true, isActive: true })), wrap(async (req, res) => {
    const b = req.body;
    if (b.discountType === 'percent' && b.discountValue > 100) throw unprocessable('Percent discount cannot exceed 100', 'INVALID_COUPON');
    try {
      const r = await db.query('INSERT INTO coupons (code, discount_type, discount_value, min_subtotal, max_uses, expires_at, is_active) VALUES (?,?,?,?,?,?,?)',
        [b.code, b.discountType, moneyStr(b.discountValue), moneyStr(b.minSubtotal ?? 0), b.maxUses ?? null, b.expiresAt ? new Date(b.expiresAt) : null, b.isActive === false ? 0 : 1]);
      await audit(req, 'coupon.created', 'coupon', r.insertId, { code: b.code, type: b.discountType, value: b.discountValue });
      res.status(201).json({ id: r.insertId });
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('Coupon code already exists'); throw e; }
  }));
router.patch('/coupons/:id', requirePermission('settings.manage'), idParam,
  validate(z.strictObject({ isActive: z.boolean().optional(), maxUses: z.number().int().min(1).nullable().optional(), expiresAt: z.iso.datetime().nullable().optional() })), wrap(async (req, res) => {
    const b = req.body; const sets = []; const params = [];
    if (b.isActive !== undefined) { sets.push('is_active = ?'); params.push(b.isActive ? 1 : 0); }
    if (b.maxUses !== undefined) { sets.push('max_uses = ?'); params.push(b.maxUses); }
    if (b.expiresAt !== undefined) { sets.push('expires_at = ?'); params.push(b.expiresAt ? new Date(b.expiresAt) : null); }
    if (!sets.length) throw badRequest('Nothing to update');
    const u = await db.query(`UPDATE coupons SET ${sets.join(', ')} WHERE id = ?`, [...params, Number(req.params.id)]);
    if (!u.affectedRows) throw notFound('Coupon not found');
    await audit(req, 'coupon.updated', 'coupon', req.params.id, b);
    res.json({ ok: true });
  }));

/* ============================ USERS / ROLES ============================ */
const requireAdminAccount = (req, res, next) => req.user?.role === 'admin' ? next() : next(new AppError(403, 'ADMIN_ONLY', 'Administrator only'));
const staffRoles = ['inventory_manager', 'order_manager']; // only the administrator creates staff; no customer promotions
router.get('/users', requireAdminAccount, wrap(async (req, res) => {
  const rows = await db.query('SELECT u.id, u.name, u.email, u.is_active, u.last_login_at, u.created_at, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id DESC LIMIT 200');
  res.json({ items: rows.map((u) => ({ id: Number(u.id), name: u.name, email: u.email, role: u.role, isActive: !!u.is_active, lastLoginAt: u.last_login_at, createdAt: u.created_at })) });
}));
router.post('/users', requireAdminAccount,
  validate(z.strictObject({ name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().pipe(z.email().max(190)), password: z.string().min(10).max(72), role: z.enum(staffRoles) })),
  wrap(async (req, res) => {
    const { name, email, password, role } = req.body;
    const hash = await bcrypt.hash(password, config.bcryptCost);
    try {
      const r = await db.query('INSERT INTO users (email, name, password_hash, role_id) VALUES (?,?,?, (SELECT id FROM roles WHERE name = ?))', [email, name, hash, role]);
      await audit(req, 'user.created', 'user', r.insertId, { email, role });
      res.status(201).json({ id: r.insertId });
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EMAIL_TAKEN', 'Email already in use'); throw e; }
  }));
router.patch('/users/:id', requireAdminAccount, idParam,
  validate(z.strictObject({ role: z.enum(staffRoles).optional(), isActive: z.boolean().optional() })), wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw unprocessable('You cannot change your own role or active status', 'SELF_CHANGE');
    const { role, isActive } = req.body;
    if (role === undefined && isActive === undefined) throw badRequest('Nothing to update');
    const [old] = await db.query('SELECT u.is_active, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', [id]);
    if (!old) throw notFound('User not found');
    if (role !== undefined && (old.role === 'customer' || old.role === 'admin')) throw new AppError(403, 'ROLE_PROTECTED', 'Customer and administrator roles cannot be changed here');
    await db.withTransaction(async (conn) => {
      if (role !== undefined) await conn.execute('UPDATE users SET role_id = (SELECT id FROM roles WHERE name = ?) WHERE id = ?', [role, id]);
      if (isActive !== undefined) await conn.execute('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
      await conn.execute('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [id]); // permissions changed => force re-login
      await audit(req, 'user.permissions_changed', 'user', id, { oldRole: old.role, newRole: role, oldActive: !!old.is_active, newActive: isActive }, conn);
    });
    realtime.disconnectUser(id);
    res.json({ ok: true });
  }));
router.post('/users/:id/password', requireAdminAccount, idParam,
  validate(z.strictObject({ password: z.string().min(10).max(72) })), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const [target] = await db.query('SELECT r.name AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?', [id]);
    if (!target) throw notFound('User not found');
    if (target.role === 'customer' || target.role === 'admin') throw new AppError(403, 'PASSWORD_PROTECTED', 'Use the account password reset flow');
    const hash = await bcrypt.hash(req.body.password, config.bcryptCost);
    const u = await db.query('UPDATE users SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(), failed_logins = 0, locked_until = NULL WHERE id = ?', [hash, id]);
    if (!u.affectedRows) throw notFound('User not found');
    await db.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [id]);
    await audit(req, 'user.password_reset', 'user', id, {});
    realtime.disconnectUser(id);
    res.json({ ok: true });
  }));

/* ============================ NEWSLETTER SUBSCRIBERS ============================ */
// Emails collected by the storefront "Join" form (POST /api/newsletter). Only staff with newsletter.manage can read them.
const escapeLike = (v) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
// CSV cell: always quoted, and a leading = + - @ is neutralised so Excel never treats an email as a formula.
const csvCell = (v) => `"${(/^[=+\-@\t\r]/.test(String(v)) ? `'${v}` : String(v)).replace(/"/g, '""')}"`;
router.get('/newsletter', requirePermission('newsletter.manage'), validate(pageQuery, 'query'), wrap(async (req, res) => {
  const { page = 1, limit = 50, q } = req.query;
  const params = []; let where = '1=1';
  if (q) { where += ' AND email LIKE ?'; params.push(`%${escapeLike(q)}%`); }
  const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM newsletter_subscribers WHERE ${where}`, params);
  const rows = await db.query(`SELECT id, email, created_at FROM newsletter_subscribers WHERE ${where} ORDER BY id DESC LIMIT ${Number(limit)} OFFSET ${(Number(page) - 1) * Number(limit)}`, params);
  res.json({ items: rows.map((r) => ({ id: Number(r.id), email: r.email, createdAt: r.created_at })), total: Number(total), page, limit });
}));
router.get('/newsletter/emails', requirePermission('newsletter.manage'), wrap(async (req, res) => {
  const rows = await db.query('SELECT email FROM newsletter_subscribers ORDER BY id DESC LIMIT 50000');
  res.json({ emails: rows.map((r) => r.email) });
}));
router.get('/newsletter/export', requirePermission('newsletter.manage'), wrap(async (req, res) => {
  const rows = await db.query('SELECT email, created_at FROM newsletter_subscribers ORDER BY id DESC LIMIT 50000');
  const csv = `\uFEFFemail,subscribed_at\r\n${rows.map((r) => `${csvCell(r.email)},${csvCell(new Date(r.created_at).toISOString())}`).join('\r\n')}\r\n`;
  await audit(req, 'newsletter.exported', 'newsletter', null, { count: rows.length });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="newsletter-subscribers.csv"' });
  res.send(csv);
}));
router.delete('/newsletter/:id', requirePermission('newsletter.manage'), idParam, wrap(async (req, res) => {
  const r = await db.query('DELETE FROM newsletter_subscribers WHERE id = ?', [Number(req.params.id)]);
  if (!r.affectedRows) throw notFound('Subscriber not found');
  await audit(req, 'newsletter.removed', 'newsletter', req.params.id, {});
  res.json({ ok: true });
}));

/* ============================ AUDIT / SYSTEM ============================ */
router.get('/audit', requirePermission('audit.view'), validate(pageQuery, 'query'), wrap(async (req, res) => {
  const { page = 1, limit = 50, action, entityType } = req.query;
  const params = []; let where = '1=1';
  if (action) { where += ' AND a.action = ?'; params.push(action); }
  if (entityType) { where += ' AND a.entity_type = ?'; params.push(entityType); }
  const rows = await db.query(`SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.ip, a.request_id, a.created_at, u.name AS actor FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.id DESC LIMIT ${Number(limit)} OFFSET ${Number((page - 1) * limit)}`, params);
  res.json({ items: rows, page, limit });
}));

router.get('/system', requirePermission('settings.manage'), wrap(async (req, res) => {
  const [backup] = await db.query("SELECT status, started_at, finished_at, file_name, size_bytes, verified, offsite_copied, error FROM backup_runs ORDER BY id DESC LIMIT 1");
  const [lastOk] = await db.query("SELECT finished_at FROM backup_runs WHERE status = 'success' AND verified = 1 ORDER BY id DESC LIMIT 1");
  let disk = null;
  try { const s = fs.statfsSync(config.root); disk = { freeGB: +(s.bavail * s.bsize / 1e9).toFixed(2), totalGB: +(s.blocks * s.bsize / 1e9).toFixed(2) }; } catch { /* not supported */ }
  const lastOkAt = lastOk?.finished_at ? new Date(lastOk.finished_at) : null;
  res.json({ uptimeSec: Math.round(process.uptime()), node: process.version, memoryMB: Math.round(process.memoryUsage().rss / 1e6), loadAvg: os.loadavg()[0], disk, lastBackup: backup || null, lastVerifiedBackupAt: lastOkAt, backupStale: !lastOkAt || (Date.now() - lastOkAt.getTime()) > 36 * 3600 * 1000, sockets: realtime.getIO()?.engine?.clientsCount ?? 0 });
}));

module.exports = router;
