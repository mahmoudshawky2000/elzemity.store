'use strict';

// Keep historical variant IDs intact: order_items.variant_id may reference them.
// The product row is locked by the caller before this function is invoked, so
// concurrent admin edits of the same product are serialized.
const sizeKey = (size) => String(size || '').toLowerCase().replace(/\s+/g, '');

function visibleVariants(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!row.is_active || row.deleted_at) return false;
    const key = sizeKey(row.size_label);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function syncProductVariants(conn, productId, variants, moneyStr) {
  // SELECT * supports both the original migration schema (no deleted_at) and
  // older deployed databases that have deleted_at and stock_quantity columns.
  const [existing] = await conn.execute(
    'SELECT * FROM product_variants WHERE product_id = ? ORDER BY id FOR UPDATE',
    [productId]
  );

  const bySize = new Map();
  for (const row of existing) {
    if (row.deleted_at) continue; // Never resurrect a soft-deleted historical variant.
    const key = sizeKey(row.size_label);
    const prior = bySize.get(key);
    if (!prior || (!prior.is_active && row.is_active)) bySize.set(key, row);
  }

  const keptIds = [];
  for (const [sortOrder, variant] of variants.entries()) {
    const old = bySize.get(sizeKey(variant.size));
    const price = moneyStr(variant.price);
    const compareAtPrice = variant.compareAtPrice == null ? null : moneyStr(variant.compareAtPrice);
    if (old) {
      // UPDATE the existing ID instead of inserting a duplicate. Keep variant
      // stock and historical order references untouched.
      await conn.execute(
        'UPDATE product_variants SET size_label = ?, price = ?, compare_at_price = ?, is_active = 1, sort_order = ? WHERE id = ? AND product_id = ?',
        [variant.size, price, compareAtPrice, sortOrder, old.id, productId]
      );
      keptIds.push(old.id);
    } else {
      const [created] = await conn.execute(
        'INSERT INTO product_variants (product_id, size_label, price, compare_at_price, is_active, sort_order) VALUES (?,?,?,?,1,?)',
        [productId, variant.size, price, compareAtPrice, sortOrder]
      );
      keptIds.push(created.insertId);
    }
  }

  // Retain duplicates and historical IDs for old orders, but stop displaying
  // them and stop accepting them for new checkout transactions.
  await conn.execute(
    `UPDATE product_variants SET is_active = 0 WHERE product_id = ? AND is_active <> 0 AND id NOT IN (${keptIds.map(() => '?').join(',')})`,
    [productId, ...keptIds]
  );
  return keptIds;
}

module.exports = { sizeKey, visibleVariants, syncProductVariants };
