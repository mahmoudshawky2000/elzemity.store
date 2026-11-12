'use strict';
const db = require('../lib/db');

const isoDay = d => d.toISOString().slice(0,10);
const dateUTC = text => new Date(`${text}T00:00:00Z`);
const num = value => Number(value || 0);
const percent = (current, previous) => num(previous) > 0 ? Math.round((num(current)-num(previous))*10000/num(previous))/100 : null;

// Historical orders do not have delivered_at. Audit logs are the only reliable
// delivery timestamps; if an old order has no transition log, fall back to its
// creation date and explicitly report the number of estimated dates.
const deliveryAudit = `(SELECT MIN(a.created_at) FROM audit_logs a
  WHERE a.entity_type='order' AND a.entity_id COLLATE utf8mb4_unicode_ci = CAST(o.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
    AND a.action='order.status_changed'
    AND JSON_UNQUOTE(JSON_EXTRACT(a.details, '$.to'))='delivered')`;
const deliveryDate = `COALESCE(${deliveryAudit}, o.created_at)`;
const deliveredOrders = `SELECT o.id, o.products_total, o.subtotal, ${deliveryDate} AS sales_at
  FROM orders o WHERE o.status='delivered'`;

function chartWindow({ month, chartPeriod, today }) {
  const [year, mm] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year,mm-1,1));
  const next = new Date(Date.UTC(year,mm,1));
  const currentMonth = today.toISOString().slice(0,7);
  const anchorEnd = month === currentMonth ? new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()+1)) : next;
  let start, end, bucket = 'day';
  if (chartPeriod === '6months' || chartPeriod === '12months') {
    start = new Date(Date.UTC(year,mm-(chartPeriod === '6months' ? 6 : 12),1));
    end = next; bucket = 'month';
  } else if (chartPeriod === '7days' || chartPeriod === '30days') {
    end = anchorEnd;
    start = new Date(end.getTime()-(chartPeriod === '7days' ? 7 : 30)*86400000);
  } else {
    start = first; end = anchorEnd;
  }
  return {start,end,bucket};
}

async function getSalesSummary(query = {}, now = new Date()) {
  const currentMonth = now.toISOString().slice(0,7);
  const month = typeof query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month) ? query.month : currentMonth;
  const [year,mm] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = isoDay(new Date(Date.UTC(year,mm,1)));
  const previousMonth = isoDay(new Date(Date.UTC(year,mm-2,1))).slice(0,7);
  const compareStart = `${previousMonth}-01`;
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
  let activeEnd = monthEnd;
  let compareEnd = monthStart;
  if (month === currentMonth) {
    activeEnd = isoDay(new Date(todayUTC.getTime()+86400000));
    const daysInPrevious = new Date(Date.UTC(year,mm-1,0)).getUTCDate();
    const comparedDays = Math.min(now.getUTCDate(),daysInPrevious);
    compareEnd = isoDay(new Date(Date.UTC(year,mm-2,comparedDays+1)));
  }
  const allowed = new Set(['month','7days','30days','6months','12months']);
  const chartPeriod = allowed.has(query.chartPeriod) ? query.chartPeriod : 'month';
  const {start,end,bucket:chartBucket} = chartWindow({month,chartPeriod,today:todayUTC});
  const chartStartText = isoDay(start), chartEndText = isoDay(end);

  const metric = async (from,to) => {
    const [base,sales,units] = await Promise.all([
      db.query(`SELECT COUNT(*) AS orders_count,
        COALESCE(SUM(status NOT IN ('cancelled','returned')),0) AS valid_orders,
        COALESCE(SUM(CASE WHEN shipping_payment_status='confirmed' AND status NOT IN ('cancelled','returned') THEN CASE WHEN payment_mode='full' THEN grand_total ELSE shipping_fee END ELSE 0 END),0) AS shipping_collected,
        COALESCE(SUM(CASE WHEN cod_status='collected' AND status NOT IN ('cancelled','returned') THEN COALESCE(cod_amount_collected,products_total) ELSE 0 END),0) AS cod_collected
        FROM orders WHERE created_at>=? AND created_at<?`,[from,to]),
      db.query(`SELECT COUNT(*) AS delivered_orders, COALESCE(SUM(s.products_total),0) AS sales_total
        FROM (${deliveredOrders}) s WHERE s.sales_at>=? AND s.sales_at<?`,[from,to]),
      db.query(`SELECT COALESCE(SUM(oi.quantity),0) AS units_sold
        FROM (${deliveredOrders}) s JOIN order_items oi ON oi.order_id=s.id
        WHERE s.sales_at>=? AND s.sales_at<?`,[from,to])
    ]);
    const b=base[0]||{}, a=sales[0]||{}, u=units[0]||{};
    return {...b, delivered_orders:num(a.delivered_orders), sales_total:num(a.sales_total), units_sold:num(u.units_sold),
      collected_total:num(b.shipping_collected)+num(b.cod_collected)};
  };

  const [current,previous,inventory,topProducts,lowStock,movements,customers,productsCount,recentProducts,recentOrders,chartRows,categoryRows,orderStatuses,missingHistory] = await Promise.all([
    metric(monthStart,activeEnd),metric(compareStart,compareEnd),
    db.query(`SELECT SUM(is_active=1) AS product_count, COALESCE(SUM(stock_quantity),0) AS units_in_stock, COALESCE(SUM(stock_quantity*price),0) AS stock_retail_value, SUM(stock_quantity=0 AND is_active=1 AND deleted_at IS NULL) AS out_of_stock, SUM(stock_quantity<=CAST(COALESCE((SELECT value FROM settings WHERE key_name='low_stock_threshold'),'5') AS UNSIGNED) AND is_active=1 AND deleted_at IS NULL) AS low_stock FROM products WHERE deleted_at IS NULL`),
    db.query(`SELECT oi.product_id, oi.product_name AS name, SUM(oi.quantity) AS units_sold,
      COALESCE(SUM(CASE WHEN s.subtotal>0 THEN oi.line_total*s.products_total/s.subtotal ELSE 0 END),0) AS sales_value
      FROM (${deliveredOrders}) s JOIN order_items oi ON oi.order_id=s.id
      WHERE s.sales_at>=? AND s.sales_at<? GROUP BY oi.product_id,oi.product_name ORDER BY units_sold DESC,sales_value DESC LIMIT 10`,[monthStart,activeEnd]),
    db.query(`SELECT id,name,stock_quantity,price FROM products WHERE deleted_at IS NULL AND is_active=1 AND stock_quantity<=CAST(COALESCE((SELECT value FROM settings WHERE key_name='low_stock_threshold'),'5') AS UNSIGNED) ORDER BY stock_quantity ASC,name ASC LIMIT 25`),
    db.query(`SELECT COUNT(*) AS movement_count, COALESCE(SUM(CASE WHEN change_qty>0 THEN change_qty ELSE 0 END),0) AS stock_added, COALESCE(SUM(CASE WHEN change_qty<0 THEN -change_qty ELSE 0 END),0) AS stock_removed FROM inventory_movements WHERE created_at>=? AND created_at<?`,[monthStart,activeEnd]),
    db.query(`SELECT COUNT(DISTINCT COALESCE(CONCAT('u',o.user_id),CONCAT('p',o.phone))) AS total FROM orders o WHERE o.status NOT IN ('cancelled','returned')`),
    db.query(`SELECT COUNT(*) AS total FROM products WHERE deleted_at IS NULL AND is_active=1`),
    db.query(`SELECT p.id,p.name,p.image_url,p.price,p.stock_quantity,p.created_at,c.name AS category FROM products p JOIN categories c ON c.id=p.category_id WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC,p.id DESC LIMIT 5`),
    db.query(`SELECT id,order_number,customer_name,created_at,grand_total,status FROM orders ORDER BY created_at DESC,id DESC LIMIT 5`),
    db.query(`SELECT DATE_FORMAT(s.sales_at,'${chartBucket==='month'?'%Y-%m-01':'%Y-%m-%d'}') AS bucket,
      COALESCE(SUM(s.products_total),0) AS sales FROM (${deliveredOrders}) s
      WHERE s.sales_at>=? AND s.sales_at<? GROUP BY bucket ORDER BY bucket`,[chartStartText,chartEndText]),
    // Order-level coupons reduce revenue: allocate the discount proportionally
    // across items, otherwise the donut incorrectly exceeds the sales KPI.
    db.query(`SELECT c.id,c.name,
      COALESCE(SUM(CASE WHEN o.id IS NOT NULL AND o.subtotal>0 THEN oi.line_total*o.products_total/o.subtotal ELSE 0 END),0) AS sales
      FROM categories c LEFT JOIN products p ON p.category_id=c.id
      LEFT JOIN order_items oi ON oi.product_id=p.id
      LEFT JOIN orders o ON o.id=oi.order_id AND o.status='delivered'
        AND ${deliveryDate}>=? AND ${deliveryDate}<?
      GROUP BY c.id,c.name ORDER BY sales DESC,c.sort_order,c.name`,[monthStart,activeEnd]),
    db.query('SELECT status,COUNT(*) AS total FROM orders WHERE created_at>=? AND created_at<? GROUP BY status',[monthStart,activeEnd]),
    db.query(`SELECT COUNT(*) AS total FROM orders o WHERE o.status='delivered'
      AND ${deliveryAudit} IS NULL AND o.created_at>=? AND o.created_at<?`,[monthStart,activeEnd])
  ]);
  const chartMap = new Map(chartRows.map(r=>[String(r.bucket).slice(0,10),num(r.sales)]));
  const chartData=[];
  if (chartBucket==='month') {
    for(let d=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),1));d<end;d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1))) {
      const key=isoDay(d); chartData.push({date:key,sales:chartMap.get(key)||0});
    }
  } else {
    for(let d=new Date(start);d<end;d=new Date(d.getTime()+86400000)) {
      const key=isoDay(d); chartData.push({date:key,sales:chartMap.get(key)||0});
    }
  }
  return {
    month,previousMonth,chartPeriod,chartBucket,chartRange:{from:chartStartText,to:isoDay(new Date(end.getTime()-86400000))},
    salesDateBasis:'delivery-audit-with-created-fallback', estimatedDeliveryDates:num(missingHistory[0]?.total),
    comparisonAvailable:num(previous.sales_total)>0 || num(previous.orders_count)>0,
    comparisonLabel:month===currentMonth?'month-to-date':'full-month', current,previous,
    changes:{sales_total_pct:percent(current.sales_total,previous.sales_total),collected_total_pct:percent(current.collected_total,previous.collected_total),orders_count_pct:percent(current.orders_count,previous.orders_count),units_sold_pct:percent(current.units_sold,previous.units_sold)},
    totals:{customers:num(customers[0]?.total),products:num(productsCount[0]?.total)},
    orderStatuses:Object.fromEntries(orderStatuses.map(r=>[r.status,num(r.total)])),
    chartData,categories:categoryRows.map(r=>({id:r.id,name:r.name,sales:Math.round(num(r.sales)*100)/100})),
    recentProducts,recentOrders,inventory:inventory[0]||{},topProducts,lowStock,movements:movements[0]||{}
  };
}
module.exports={getSalesSummary,chartWindow,deliveryDate,deliveryAudit,percent};
