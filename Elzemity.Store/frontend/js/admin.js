/* Elzemity admin panel. All authorization is enforced by the API; hiding tabs here is only cosmetic. */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const { t, label } = I18N;
const money = (n) => t("money", { amount: I18N.num(Number(n)) });
const dt = (s) => I18N.dateTime(s);
const S = { user: null, csrf: null, tab: null, orderId: null, status: "", q: "", page: 1, nq: "", npage: 1, ppage: 1, pq: "", securityView: false };
let socket, refreshTimer, toastTimer;

async function api(path, { method = "GET", body, form } = {}) {
  const headers = { Accept: "application/json" }; if (S.csrf && method !== "GET") headers["X-CSRF-Token"] = S.csrf; if (body !== undefined && !form) headers["Content-Type"] = "application/json";
  let res; try { res = await fetch(`/api${path}`, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)), credentials: "same-origin" }); } catch { throw Object.assign(new Error(t("err.NETWORK")), { status: 0 }); }
  let data = null; try { data = await res.json(); } catch { /* */ }
  if (res.status === 401 && S.user && data?.error?.code === "UNAUTHORIZED") { S.user = null; S.csrf = null; render(); toast(t("a.sessionExpired")); }
  if (!res.ok) { const code = data?.error?.code; const base = I18N.lang === "ar" && I18N.has("err." + code) ? t("err." + code) : data?.error?.message || t("err.default"); throw Object.assign(new Error(data?.error?.details?.[0] ? `${base}: ${data.error.details.map((d) => `${d.field} ${d.message}`).join("; ")}` : base), { status: res.status, code }); }
  return data;
}
const toast = (m) => { const el = $("#toast"); el.textContent = m; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3500); };
const can = (...p) => p.some((x) => S.user?.permissions.includes(x));
const pill = (s, ns = "status") => `<span class="pill ${["confirmed", "delivered", "shipped", "processing", "collected"].includes(s) ? "ok" : ["cancelled", "returned", "rejected", "not_collected"].includes(s) ? "bad" : "warn"}">${esc(label(ns, s))}</span>`;
const yesNo = (v) => `<span class="pill ${v ? "ok" : "bad"}">${esc(t(v ? "a.yes" : "a.no"))}</span>`;
// Show useful, localized audit summaries instead of exposing raw JSON to staff.
const auditActionLabels = {
  "auth.staff_login": ["Staff login", "تسجيل دخول موظف"],
  "auth.staff_login_2fa": ["Staff 2FA login", "دخول الموظف بالتحقق الثنائي"],
  "auth.staff_2fa_enabled": ["2FA enabled", "تفعيل التحقق الثنائي"],
  "auth.staff_2fa_disabled": ["2FA disabled", "إيقاف التحقق الثنائي"],
  "auth.password_changed": ["Own password changed", "تغيير كلمة مرور الحساب"],
  "product.created": ["Product added", "إضافة منتج"],
  "product.updated": ["Product updated", "تعديل منتج"],
  "product.deleted": ["Product removed", "حذف منتج"],
  "product.image_uploaded": ["Product image uploaded", "رفع صورة منتج"],
  "inventory.adjusted": ["Stock updated", "تعديل المخزون"],
  "order.created": ["Order placed", "إنشاء طلب"],
  "order.status_changed": ["Order status changed", "تغيير حالة طلب"],
  "order.auto_cancelled": ["Order expired", "إلغاء طلب تلقائي"],
  "order.cod_collected": ["Cash on delivery collected", "تحصيل عند الاستلام"],
  "order.cod_not_collected": ["Cash on delivery not collected", "عدم تحصيل عند الاستلام"],
  "shipping_payment.submitted": ["Transfer submitted", "إرسال إثبات تحويل"],
  "shipping_payment.confirmed": ["Transfer approved", "تأكيد التحويل"],
  "shipping_payment.rejected": ["Transfer rejected", "رفض التحويل"],
  "settings.updated": ["Settings updated", "تعديل الإعدادات"],
  "shipping_zone.updated": ["Shipping updated", "تعديل الشحن"],
  "coupon.created": ["Coupon added", "إضافة كوبون"],
  "coupon.updated": ["Coupon updated", "تعديل كوبون"],
  "user.created": ["User added", "إضافة مستخدم"],
  "user.permissions_changed": ["Permissions updated", "تعديل الصلاحيات"],
  "user.password_reset": ["Password reset", "إعادة تعيين كلمة المرور"],
  "newsletter.exported": ["Subscribers exported", "تصدير المشتركين"],
  "newsletter.removed": ["Subscriber removed", "حذف مشترك"],
};
function auditAction(action) {
  const pair = auditActionLabels[action];
  return pair ? pair[I18N.lang === "ar" ? 1 : 0] : String(action || "").replace(/[._]/g, " ");
}
function auditSummary(details) {
  if (!details) return "—";
  let data = details;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { return "—"; } }
  if (!data || typeof data !== "object" || Array.isArray(data)) return "—";
  const ar = I18N.lang === "ar";
  const fields = [
    ["orderNumber", ar ? "الطلب" : "Order"], ["name", ar ? "الاسم" : "Name"],
    ["from", ar ? "من" : "From"], ["to", ar ? "إلى" : "To"],
    ["amount", ar ? "المبلغ" : "Amount"], ["total", ar ? "الإجمالي" : "Total"],
    ["price", ar ? "السعر" : "Price"], ["stock", ar ? "المخزون" : "Stock"],
    ["reason", ar ? "السبب" : "Reason"], ["note", ar ? "ملاحظة" : "Note"],
  ];
  const entries = fields.filter(([key]) => data[key] !== undefined && data[key] !== null && typeof data[key] !== "object")
    .map(([key, labelText]) => `${labelText}: ${String(data[key])}`);
  return entries.length ? entries.join(" · ") : "—";
}


const TABS = [
  ["orders", "a.tab.orders", () => can("orders.view")], ["reports", "a.tab.reports", () => can("orders.view", "inventory.manage", "products.manage")], ["products", "a.tab.products", () => can("products.manage", "inventory.manage")],
  ["newsletter", "a.tab.newsletter", () => can("newsletter.manage")],
  ["settings", "a.tab.settings", () => can("settings.manage")], ["users", "a.tab.users", () => can("users.manage")], ["audit", "a.tab.audit", () => can("audit.view")], ["system", "a.tab.system", () => can("settings.manage")],
];

async function init() {
  try { const d = await api("/auth/me"); S.user = d.user; S.csrf = d.csrfToken || null; } catch { /* */ }
  render(); startSocket();
}
function renderBar() {
  $("#whoami").innerHTML = S.user ? `${esc(S.user.role === 'admin' ? 'Admin' : S.user.name)} · ${esc(label("role", S.user.role))} ${S.user.role !== "customer" ? `<button id="accountSecurity">${I18N.lang === "ar" ? "أمان الحساب وكلمة المرور" : "Account security & password"}</button>` : ""} <button id="logout">${esc(t("a.logout"))}</button>` : "";
  const toAr = I18N.lang === "en"; const lb = $("#langToggle");
  lb.textContent = toAr ? "العربية" : "English"; lb.lang = toAr ? "ar" : "en";
}
function render() {
  const app = $("#app"); renderBar(); document.title = t("a.title");
  if (!S.user) return (app.innerHTML = `<form class="login-card" id="loginForm"><h1>${esc(t("a.login.title"))}</h1><div class="field"><label for="e">${esc(t("a.email"))}</label><input id="e" name="email" type="email" autocomplete="username" required dir="ltr"></div><br><div class="field"><label for="p">${esc(t("a.password"))}</label><input id="p" name="password" type="password" autocomplete="current-password" required dir="ltr"></div><br><button class="btn" type="submit">${esc(t("a.login.btn"))}</button><p class="err" id="lerr" role="alert"></p></form>`);
  if (S.user.role === "customer") return (app.innerHTML = `<div class="panel"><h2>${esc(t("a.noAccess"))}</h2><p>${esc(t("a.noAccess.text"))}</p></div>`);
  if (S.securityView) { app.innerHTML = `<div class="panel" id="accountSecurityPanel"></div>`; loadAccountSecurity(); return; }
  const tabs = TABS.filter((tb) => tb[2]());
  if (!S.tab || !tabs.some((tb) => tb[0] === S.tab)) S.tab = tabs[0]?.[0];
  app.innerHTML = `<button type="button" id="adminMobileMenu" class="admin-mobile-menu" aria-controls="adminTabs" aria-expanded="false">☰ ${I18N.lang === "ar" ? "الأقسام" : "Sections"}</button><div id="adminTabs" class="admin-tabs" role="tablist">${tabs.map((tb) => `<button role="tab" data-tab="${tb[0]}" aria-selected="${S.tab === tb[0]}">${esc(t(tb[1]))}</button>`).join("")}</div><div id="view"></div>`;
  const menu = $("#adminMobileMenu");
  if (menu) menu.addEventListener("click", () => { const open = $("#adminTabs").classList.toggle("mobile-open"); menu.setAttribute("aria-expanded", String(open)); });
  load();
}
async function load() {
  const v = $("#view"); if (!v) return;
  try { await VIEWS[S.tab]?.(v); } catch (e) { v.innerHTML = `<div class="panel"><p class="err">${esc(e.message)} <button class="btn small ghost" data-act="reload">${esc(t("a.retry"))}</button></p></div>`; }
}
function loadAccountSecurity() {
  const v = $("#accountSecurityPanel"); if (!v) return;
  const ar = I18N.lang === "ar";
  v.innerHTML = `<h2>${ar ? "أمان حساب الإدارة" : "Account security"}</h2>
    <form id="changePasswordForm" autocomplete="off">
      <h3>${ar ? "تغيير كلمة المرور" : "Change password"}</h3>
      <p>${ar ? "اكتب كلمة المرور الحالية ثم الجديدة. بعد الحفظ سيتم تسجيل خروجك من كل الأجهزة." : "Enter your current and new password. Saving signs you out of all devices."}</p>
      <div class="field"><label for="currentPassword">${ar ? "كلمة المرور الحالية" : "Current password"}</label><input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required maxlength="72" dir="ltr"></div>
      <div class="field"><label for="newPassword">${ar ? "كلمة المرور الجديدة (12 حرفًا على الأقل)" : "New password (at least 12 characters)"}</label><input id="newPassword" name="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="72" dir="ltr"></div>
      <div class="field"><label for="confirmPassword">${ar ? "تأكيد كلمة المرور الجديدة" : "Confirm new password"}</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="72" dir="ltr"></div>
      <button class="btn" type="submit">${ar ? "تغيير كلمة المرور وتسجيل الخروج" : "Change password and sign out"}</button>
      <p class="err" id="passwordChangeErr" role="alert"></p>
    </form>
    ${S.user?.role === 'admin' ? `<hr><form id="changeEmailForm" autocomplete="off">
      <h3>${ar ? 'تغيير بريد دخول الأدمن' : 'Change administrator login email'}</h3>
      <p>${ar ? 'ده نفس حساب الأدمن الحالي، مش حساب جديد. هتحتاج كلمة المرور الحالية، وبعد الحفظ هتسجل دخولك بالبريد الجديد.' : 'Keeps the existing admin account and permissions. Confirm your password; sign in with the new email afterwards.'}</p>
      <div class="field"><label for="adminNewEmail">${ar ? 'بريد تسجيل الدخول الجديد' : 'New login email'}</label><input id="adminNewEmail" name="newEmail" type="email" required maxlength="190" dir="ltr" value="${esc(S.user.email === 'admin@elzemity.com' ? S.user.email : 'admin@elzemity.com')}"></div>
      <div class="field"><label for="adminEmailPassword">${ar ? 'كلمة المرور الحالية للتأكيد' : 'Current password to confirm'}</label><input id="adminEmailPassword" name="currentPassword" type="password" required maxlength="72" autocomplete="current-password" dir="ltr"></div>
      <button class="btn" type="submit">${ar ? 'حفظ بريد الدخول وتسجيل الخروج' : 'Save login email and sign out'}</button>
      <p class="err" id="emailChangeErr" role="alert"></p>
    </form>` : ''}
    <button class="btn ghost" id="closeSecurity" type="button">${ar ? "رجوع للوحة التحكم" : "Back to dashboard"}</button>`;
}
function loginFinished(d) {
  S.user = d.user; S.csrf = d.csrfToken; S.securityView = false;
  reconnectSocket(); render();
}
// Never discard an unsaved product form when inventory/order socket events arrive.
// Clicking Save blurs the stock input; focus-only protection was not enough.
const softRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (S.user && !$("#f_stock") && !$("#f_name") && !document.activeElement?.closest("input,textarea,select")) load();
  }, 600);
};
const ORDER_STATUSES = ["awaiting_shipping_payment", "shipping_payment_under_review", "confirmed", "processing", "shipped", "delivered", "cancelled", "returned"];
const th = (...keys) => `<tr>${keys.map((k) => `<th>${esc(k ? t(k) : "")}</th>`).join("")}</tr>`;

/* ---------------- views ---------------- */
const VIEWS = {
  async orders(v) {
    if (S.orderId) return orderDetail(v);
    const qs = new URLSearchParams({ page: S.page, limit: 25 }); if (S.status) qs.set("status", S.status); if (S.q) qs.set("q", S.q);
    const d = await api(`/admin/orders?${qs}`);
    v.innerHTML = `<div class="panel"><h2>${esc(t("a.tab.orders"))} <small class="muted">(${I18N.num(d.total, {})})</small></h2><div class="toolbar"><select id="fStatus"><option value="">${esc(t("a.allStatuses"))}</option>${ORDER_STATUSES.map((s) => `<option value="${s}" ${S.status === s ? "selected" : ""}>${esc(label("status", s))}</option>`).join("")}</select><input id="fQ" placeholder="${esc(t("a.orders.search"))}" value="${esc(S.q)}"><button class="btn small" data-act="filter">${esc(t("a.search"))}</button>${S.page > 1 ? `<button class="btn small ghost" data-act="prev">${esc(t("a.prev"))}</button>` : ""}${d.page * d.limit < d.total ? `<button class="btn small ghost" data-act="next">${esc(t("a.next"))}</button>` : ""}</div>
      <table class="t"><thead>${th("a.o.order", "a.o.customer", "a.o.gov", "a.o.status", "a.o.shipPay", "a.o.cod", "a.o.total", "a.o.created")}</thead><tbody>${d.items.map((o) => `<tr class="click" data-order="${o.id}"><td><strong>${esc(o.orderNumber)}</strong></td><td>${esc(o.customerName)}<br><small class="muted ltr">${esc(o.phone)}</small></td><td>${esc(label("gov", o.governorate))}</td><td>${pill(o.status)}</td><td>${pill(o.shippingPaymentStatus, "sp")}</td><td>${o.paymentMode === "full" ? (o.shippingPaymentStatus === "confirmed" ? `<span class="pill ok">${esc(I18N.lang === "ar" ? "مدفوع بالكامل" : "Paid in full")}</span>` : `<span class="pill warn">${esc(I18N.lang === "ar" ? "بانتظار التحويل" : "Awaiting transfer")}</span>`) : pill(o.codStatus, "cod")}</td><td>${money(o.grandTotal)}</td><td>${dt(o.createdAt)}</td></tr>`).join("") || `<tr><td colspan="8" class="muted">${esc(t("a.o.none"))}</td></tr>`}</tbody></table></div>`;
  },
  async reports(v) {
    const now = new Date(); const defaultMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const month = S.reportMonth || defaultMonth;
    const chartPeriod = S.reportChartPeriod || 'month';
    const d = await api(`/admin/reports/summary?month=${encodeURIComponent(month)}&chartPeriod=${encodeURIComponent(chartPeriod)}`);
    S.reportData = d;
    const ar = I18N.lang === 'ar';
    const tx = (en, arabic) => ar ? arabic : en;
    const n = (x) => I18N.num(Number(x || 0));
    const currency = (x) => money(Number(x || 0));
    const pct = (x) => {
      if (x === null || x === undefined || !Number.isFinite(Number(x))) return `<span class="report-no-compare">${tx('Not enough previous data to compare','لا توجد بيانات سابقة كافية للمقارنة')}</span>`;
      const val = Number(x); const cls = val > 0 ? 'up' : val < 0 ? 'down' : 'flat';
      return `<span class="report-delta ${cls}">${val > 0 ? '↗ +' : val < 0 ? '↘ ' : '→ '}${n(Math.abs(val))}%</span><span class="report-compare-label">${tx('vs previous period','مقارنة بالفترة السابقة')}</span>`;
    };
    const stat = (icon, title, value, change, sub) => `<article class="sales-kpi"><div class="sales-kpi-top"><span>${esc(title)}</span><span class="sales-kpi-icon">${icon}</span></div><strong class="sales-kpi-value">${value}</strong><div class="sales-kpi-foot">${change || ''}</div>${sub ? `<small>${esc(sub)}</small>` : ''}</article>`;
    const dateLabel = (iso) => { const x = new Date(`${iso}T12:00:00Z`); return x.toLocaleDateString(ar ? 'ar-EG' : 'en-GB', { day:'numeric', month:'short', timeZone:'UTC' }); };
    const chartPoints = d.chartData || [];
    const maxSale = Math.max(1, ...chartPoints.map(x => Number(x.sales || 0)));
    const chartW = 640, chartH = 220, left = 16, right = 16, top = 20, bottom = 35;
    const coords = chartPoints.map((x,i) => ({ x: left + (chartPoints.length < 2 ? 0 : i*(chartW-left-right)/(chartPoints.length-1)), y: top + (chartH-top-bottom)*(1-Number(x.sales || 0)/maxSale), ...x }));
    const linePath = coords.map((p,i) => `${i ? 'L':'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L ${coords[coords.length-1]?.x || left} ${chartH-bottom} L ${coords[0]?.x || left} ${chartH-bottom} Z`;
    const chartDateLabel = (iso) => d.chartBucket === 'month' ? new Date(`${iso}T12:00:00Z`).toLocaleDateString(ar ? 'ar-EG' : 'en-GB', { month:'short', year:'2-digit', timeZone:'UTC' }) : dateLabel(iso);
    const chartTitle = ({'month':tx('Selected reporting month','شهر التقرير المحدد'),'7days':tx('Last 7 days','آخر أسبوع'),'30days':tx('Last 30 days','آخر 30 يوم'),'6months':tx('Last 6 months','آخر 6 شهور'),'12months':tx('Last 12 months','آخر 12 شهر')}[chartPeriod] || tx('Sales over time','المبيعات عبر الفترة'));
    const deliveredCount = Number(d.current.delivered_orders || 0);
    const statuses = d.orderStatuses || {};
    const statusSummary = `${tx('Delivered in month','تم تسليمها خلال الشهر')}: ${n(deliveredCount)} · ${tx('Pending / in progress among orders placed this month','قيد الانتظار / التنفيذ من طلبات الشهر')}: ${n(['pending','awaiting_shipping_payment','shipping_payment_under_review','confirmed','processing','shipped'].reduce((sum,k)=>sum+Number(statuses[k]||0),0))} · ${tx('Returned / cancelled among orders placed this month','مرتجعة / ملغاة من طلبات الشهر')}: ${n(Number(statuses.returned||0)+Number(statuses.cancelled||0))}`;
    const deliveryDateNote = Number(d.estimatedDeliveryDates || 0) ? tx(`${n(d.estimatedDeliveryDates)} older delivered order(s) have no delivery log; their creation date is used as an estimate.`,`${n(d.estimatedDeliveryDates)} طلبات مسلّمة قديمة ليس لها سجل بتاريخ التسليم؛ تم استخدام تاريخ إنشاء الطلب كتقدير.`) : '';
    const graphStep = chartPoints.length > 15 ? Math.ceil(chartPoints.length / 7) : 1;
    const chart = `<svg class="sales-line-svg" viewBox="0 0 ${chartW} ${chartH}" role="img" aria-label="${esc(chartTitle)}"> <defs><linearGradient id="salesAreaGradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="var(--gold)" stop-opacity=".28"/><stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/></linearGradient></defs>${[0,1,2,3].map(i=>`<line x1="${left}" x2="${chartW-right}" y1="${top+i*(chartH-top-bottom)/3}" y2="${top+i*(chartH-top-bottom)/3}" class="chart-gridline"/>`).join('')}<path d="${areaPath}" fill="url(#salesAreaGradient)"/><path d="${linePath}" class="sales-line"/>${coords.map((p,i)=>`<circle cx="${p.x}" cy="${p.y}" r="3.5" class="sales-dot"><title>${esc(chartDateLabel(p.date))}: ${esc(currency(p.sales))}</title></circle>${i % graphStep === 0 || i === coords.length-1 ? `<text x="${p.x}" y="${chartH-8}" text-anchor="middle" class="chart-label">${esc(chartDateLabel(p.date))}</text>` : ''}`).join('')}</svg>`;
    const cats = (d.categories || []).filter(x => Number(x.sales) > 0);
    const catTotal = cats.reduce((sum,x)=>sum+Number(x.sales),0);
    const colors = ['#b89b5e','#8d7aa8','#c77e8e','#6caaa1','#c7b58b','#7d8a9b'];
    let cursor = 0;
    const stops = cats.map((c,i)=>{const from=cursor;cursor += catTotal ? Number(c.sales)/catTotal*100 : 0;return `${colors[i%colors.length]} ${from.toFixed(2)}% ${cursor.toFixed(2)}%`;});
    const donut = catTotal ? `<div class="sales-donut" style="background:conic-gradient(${stops.join(',')})"><div class="sales-donut-hole"><strong>${currency(catTotal)}</strong><span>${tx('Sales','المبيعات')}</span></div></div>` : `<div class="sales-donut sales-donut-empty"><div class="sales-donut-hole"><strong>—</strong><span>${tx('No sales yet','لا توجد مبيعات')}</span></div></div>`;
    const categoryLegend = cats.length ? cats.map((c,i)=>`<div class="category-legend-row"><span class="category-dot" style="background:${colors[i%colors.length]}"></span><span class="category-name">${esc(c.name)}</span><strong>${catTotal ? n(Math.round(Number(c.sales)/catTotal*100)) : 0}%</strong><small>${currency(c.sales)}</small></div>`).join('') : `<p class="empty-state">${tx('No category sales recorded for this period.','لا توجد مبيعات مسجلة للفئات خلال هذه الفترة.')}</p>`;
    const productRows = (d.recentProducts || []).map(p=>`<tr><td><div class="report-product"><span class="report-product-image">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '✦'}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.category || '')}</small></span></div></td><td>${currency(p.price)}</td><td><span class="stock-tag ${Number(p.stock_quantity) > 0 ? 'in-stock' : 'out-stock'}">${Number(p.stock_quantity)>0 ? tx('Available','متوفر') : tx('Out of stock','نفد المخزون')} · ${n(p.stock_quantity)}</span></td></tr>`).join('');
    const orderRows = (d.recentOrders || []).map(o=>`<tr class="click" data-order="${o.id}"><td><strong class="order-ref">#${esc(o.order_number)}</strong><small>${esc(dt(o.created_at))}</small></td><td>${esc(o.customer_name)}</td><td>${currency(o.grand_total)}</td><td>${pill(o.status)}</td></tr>`).join('');
    const compareNote = d.comparisonAvailable ? tx(`Compared with ${d.previousMonth} (same elapsed days when viewing the current month).`,`مقارنة بشهر ${d.previousMonth} (بنفس عدد الأيام المنقضية عند عرض الشهر الحالي).`) : tx('Comparison will appear when previous-period order data exists.','هتظهر المقارنة لما تتوفر بيانات طلبات فعلية للفترة السابقة.');
    v.innerHTML = `<div class="sales-dashboard" dir="${ar ? 'rtl' : 'ltr'}">
      <section class="sales-dashboard-heading"><div><div class="eyebrow">ELZEMITY <span>·</span> ${tx('OVERVIEW','نظرة عامة')}</div><h2>${tx('Sales overview','ملخص المبيعات')}</h2><p>${tx('A live summary based on your store records.','ملخص مباشر مبني على بيانات متجرك الفعلية.')}</p></div><div class="sales-controls"><label for="reportMonth">${tx('Reporting month','شهر التقرير')}</label><input type="month" id="reportMonth" max="${esc(defaultMonth)}" value="${esc(d.month)}"><label for="reportChartPeriod">${tx('Chart period','فترة الجراف')}</label><select id="reportChartPeriod"><option value="month" ${chartPeriod==='month'?'selected':''}>${tx('Reporting month','شهر التقرير')}</option><option value="7days" ${chartPeriod==='7days'?'selected':''}>${tx('Last 7 days','آخر أسبوع')}</option><option value="30days" ${chartPeriod==='30days'?'selected':''}>${tx('Last 30 days','آخر شهر')}</option><option value="6months" ${chartPeriod==='6months'?'selected':''}>${tx('Last 6 months','آخر 6 شهور')}</option><option value="12months" ${chartPeriod==='12months'?'selected':''}>${tx('Last 12 months','آخر 12 شهر')}</option></select><button class="btn" data-act="reportfilter">${tx('Apply','تطبيق')}</button><button class="btn ghost" data-act="reportcsv">${tx('Export CSV','تصدير CSV')}</button></div></section>
      <div class="sales-kpi-grid">${stat('ج.م',tx('Total sales','إجمالي المبيعات'),currency(d.current.sales_total),pct(d.changes.sales_total_pct),tx('Delivered orders · product value only','الطلبات المسلّمة · قيمة المنتجات فقط'))}${stat('↗',tx('Total orders','عدد الطلبات'),n(d.current.orders_count),pct(d.changes.orders_count_pct),tx('Orders created in selected period','الطلبات المنشأة خلال الفترة المحددة'))}${stat('♙',tx('Customers','عدد العملاء'),n(d.totals.customers),'',tx('Unique customers who ordered','عملاء مختلفين قدّموا طلبات'))}${stat('✦',tx('Active products','إجمالي المنتجات'),n(d.totals.products),'',tx('Active products in your catalog','المنتجات النشطة في المتجر'))}</div>
      <p class="sales-comparison-note">${esc(statusSummary)}. ${esc(compareNote)}</p>${deliveryDateNote ? `<p class="sales-comparison-note">⚠ ${esc(deliveryDateNote)}</p>` : ''}
      <div class="sales-charts-grid"><section class="sales-card sales-chart-card"><div class="sales-card-heading"><div><h3>${esc(chartTitle)}</h3><p>${tx('Delivered product value by delivery date (estimated for old orders without audit history)','قيمة المنتجات المسلّمة حسب تاريخ التسليم (تقديري للطلبات القديمة بدون سجل)')}</p></div><span class="card-mark">${chartPeriod==='month'?'M':chartPeriod==='7days'?'7D':chartPeriod==='30days'?'30D':chartPeriod==='6months'?'6M':'12M'}</span></div>${chart}<div class="chart-total"><span>${tx('Sales total for selected period','إجمالي مبيعات الفترة المختارة')}</span><strong>${currency(chartPoints.reduce((sum,x)=>sum+Number(x.sales||0),0))}</strong></div></section>
      <section class="sales-card sales-category-card"><div class="sales-card-heading"><div><h3>${tx('Sales by category','توزيع المبيعات حسب الفئة')}</h3><p>${tx('Delivered product sales in reporting month, after proportional coupon discounts','مبيعات المنتجات المسلّمة خلال شهر التقرير بعد توزيع خصومات الكوبونات')}</p></div></div><div class="category-chart-layout">${donut}<div class="category-legend">${categoryLegend}</div></div></section></div>
      <div class="sales-bottom-grid"><section class="sales-card sales-table-card"><div class="sales-card-heading"><div><h3>${tx('Recently added products','أحدث المنتجات المضافة')}</h3><p>${tx('Latest items in your catalog','أحدث المنتجات في متجرك')}</p></div><span class="card-mark">${n((d.recentProducts||[]).length)}</span></div><div class="sales-table-wrap"><table class="sales-table"><thead><tr><th>${tx('Product','المنتج')}</th><th>${tx('Price','السعر')}</th><th>${tx('Stock','المخزون')}</th></tr></thead><tbody>${productRows || `<tr><td colspan="3"><div class="empty-state">${tx('No products found.','لا توجد منتجات مسجلة.')}</div></td></tr>`}</tbody></table></div></section>
      <section class="sales-card sales-table-card"><div class="sales-card-heading"><div><h3>${tx('Latest orders','أحدث الطلبات')}</h3><p>${tx('Most recent orders from your store','أحدث الطلبات المسجلة في المتجر')}</p></div><span class="card-mark">${n((d.recentOrders||[]).length)}</span></div><div class="sales-table-wrap"><table class="sales-table"><thead><tr><th>${tx('Order','الطلب')}</th><th>${tx('Customer','العميل')}</th><th>${tx('Total','الإجمالي')}</th><th>${tx('Status','الحالة')}</th></tr></thead><tbody>${orderRows || `<tr><td colspan="4"><div class="empty-state">${tx('No orders yet.','لا توجد طلبات مسجلة حتى الآن.')}</div></td></tr>`}</tbody></table></div></section></div>
      <p class="sales-footnote">${tx('Sales change when an order is marked Delivered, not when it is placed or paid. Returned orders are excluded. Shipping is excluded. The chart can use a different period from the monthly KPIs when selected.','المبيعات بتتغير لما الطلب يتحول إلى «تم التسليم»، مش بمجرد إنشاء الطلب أو تأكيد الدفع. الطلبات المرتجعة مستبعدة ورسوم الشحن مش محسوبة. لو اخترت فترة مختلفة للجراف، مش لازم إجماليها يساوي ملخص الشهر.')}</p>
    </div>`;
  },
  async products(v) {
    const d = await api(`/admin/products?${new URLSearchParams({ limit: "25", page: String(S.ppage), ...(S.pq ? { q: S.pq } : {}) })}`); const cfg = await (await fetch("/api/config")).json();
    v.innerHTML = `<div class="panel"><h2>${esc(t("a.tab.products"))}</h2>${can("products.manage") ? `<button class="btn small" data-act="newproduct">${esc(t("a.p.new"))}</button>` : ""}<div id="pform"></div>
      <div class="toolbar admin-product-pager"><input id="pQ" type="search" maxlength="80" value="${esc(S.pq)}" placeholder="${I18N.lang === "ar" ? "بحث باسم العطر" : "Search products"}" aria-label="${I18N.lang === "ar" ? "بحث عن العطور" : "Search products"}"><button class="btn small ghost" data-act="pfilter">${esc(t("a.search"))}</button><span class="muted">${I18N.num(d.total, {})} ${I18N.lang === "ar" ? "منتج" : "products"} · ${I18N.lang === "ar" ? "صفحة" : "Page"} ${I18N.num(S.ppage, {})}</span>${S.ppage > 1 ? `<button class="btn small ghost" data-act="pprev">${esc(t("a.prev"))}</button>` : ""}${S.ppage * 25 < d.total ? `<button class="btn small ghost" data-act="pnext">${esc(t("a.next"))}</button>` : ""}</div>
      <table class="t"><thead>${th("a.p.product", "a.p.category", "a.p.price", "a.p.stock", "a.p.active", "")}</thead><tbody>${d.items.map((p) => `<tr><td><strong>${esc(p.name)}</strong><br><small class="muted">${esc((p.variants || []).map(x => `${x.size}: ${money(x.price)}`).join(" · ") || p.sizeLabel || "")}</small></td><td>${esc(label("cat", p.category))}</td><td>${money(p.price)}</td><td><strong>${I18N.num(p.stock, {})}</strong></td><td><label class="active-toggle"><input type="checkbox" data-toggle-product="${p.id}" ${p.isActive ? "checked" : ""} ${can("products.manage") ? "" : "disabled"} aria-label="${esc(p.name)}">${yesNo(p.isActive)}</label></td><td>${can("inventory.manage") ? `<button class="btn small ghost" data-act="stock" data-id="${p.id}" data-name="${esc(p.name)}">${esc(t("a.p.adjust"))}</button> ` : ""}${can("products.manage") ? `<button class="btn small ghost" data-act="editproduct" data-id="${p.id}">${esc(t("a.edit"))}</button> <button class="btn small danger" data-act="delproduct" data-id="${p.id}">${esc(t("a.delete"))}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
    S.products = d.items; S.cats = cfg.categories;
  },
  async newsletter(v) {
    const qs = new URLSearchParams({ page: S.npage, limit: 50 }); if (S.nq) qs.set("q", S.nq);
    const d = await api(`/admin/newsletter?${qs}`);
    v.innerHTML = `<div class="panel"><h2>${esc(t("a.n.title"))} <small class="muted">(${I18N.num(d.total, {})})</small></h2>
      <div class="toolbar"><input id="nQ" type="search" dir="ltr" placeholder="${esc(t("a.n.search"))}" value="${esc(S.nq)}"><button class="btn small" data-act="nfilter">${esc(t("a.search"))}</button>
        <button class="btn small ghost" data-act="ncopy">${esc(t("a.n.copy"))}</button><a class="btn small ghost" href="/api/admin/newsletter/export" download>${esc(t("a.n.export"))}</a>
        ${S.npage > 1 ? `<button class="btn small ghost" data-act="nprev">${esc(t("a.prev"))}</button>` : ""}${d.page * d.limit < d.total ? `<button class="btn small ghost" data-act="nnext">${esc(t("a.next"))}</button>` : ""}</div>
      <p class="hint">${esc(t("a.n.hint"))}</p><p id="nmsg"></p>
      <table class="t"><thead>${th("a.n.email", "a.n.date", "")}</thead><tbody>${d.items.map((r) => `<tr><td class="ltr">${esc(r.email)}</td><td>${dt(r.createdAt)}</td><td><button class="btn small danger" data-act="ndel" data-id="${r.id}">${esc(t("a.delete"))}</button></td></tr>`).join("") || `<tr><td colspan="3" class="muted">${esc(t("a.n.none"))}</td></tr>`}</tbody></table></div>`;
  },
  async settings(v) {
    const [s, z, c] = await Promise.all([api("/admin/settings"), api("/admin/shipping-zones"), api("/admin/coupons")]); const st = s.settings;
    v.innerHTML = `<div class="panel"><h2>${esc(t("a.s.title"))}</h2><div class="grid2"><div class="field"><label>${esc(t("a.s.name"))}</label><input id="s_store_name" value="${esc(st.store_name)}"></div><div class="field"><label>${esc(t("a.s.handle"))}</label><input id="s_instapay_handle" value="${esc(st.instapay_handle)}" dir="ltr"></div><div class="field"><label>${esc(t("a.s.account"))}</label><input id="s_instapay_account_name" value="${esc(st.instapay_account_name)}"></div><div class="field"><label>${esc(t("a.s.window"))}</label><input id="s_shipping_payment_window_hours" type="number" min="1" value="${esc(st.shipping_payment_window_hours)}"></div><div class="field"><label>${esc(t("a.s.low"))}</label><input id="s_low_stock_threshold" type="number" min="0" value="${esc(st.low_stock_threshold)}"></div><div class="field"><label><input id="s_shipping_only_enabled" type="checkbox" ${st.shipping_only_enabled === "1" ? "checked" : ""}> ${I18N.lang === "ar" ? "السماح بدفع الشحن فقط مقدمًا (اختياري؛ الدفع الكامل هو الافتراضي)" : "Allow shipping-only upfront payment (optional; full payment remains default)"}</label></div><div class="field"><label>WhatsApp phone (international format)</label><input id="s_contact_whatsapp" dir="ltr" placeholder="+201xxxxxxxxx" value="${esc(st.contact_whatsapp || "")}"></div><div class="field"><label><input id="s_contact_whatsapp_enabled" type="checkbox" ${st.contact_whatsapp_enabled !== "0" ? "checked" : ""}> Enable WhatsApp contact</label></div><div class="field" style="grid-column:1/-1"><label>Social accounts (one per line: platform | URL | true/false)</label><textarea id="s_social_accounts" rows="5" dir="ltr" placeholder="Instagram | https://instagram.com/your-account | true">${esc(formatSocialAccounts(st.social_accounts))}</textarea><small class="muted">Enter one account per line. Only use official public URLs you control; never enter passwords or private tokens.</small></div></div><div class="row-actions"><button class="btn" data-act="savesettings">${esc(t("a.s.save"))}</button></div><p id="smsg"></p></div>
      <div class="panel"><h2>${esc(t("a.z.title"))}</h2><table class="t"><thead>${th("a.z.gov", "a.z.fee", "a.p.active", "")}</thead><tbody>${z.items.map((x) => `<tr><td>${esc(label("gov", x.governorate))}</td><td><input type="number" min="0" step="0.01" value="${x.fee}" id="zf${x.id}" style="width:100px"></td><td><input type="checkbox" id="za${x.id}" ${x.isActive ? "checked" : ""}></td><td><button class="btn small ghost" data-act="savezone" data-id="${x.id}">${esc(t("a.save"))}</button></td></tr>`).join("")}</tbody></table></div>
      <div class="panel"><h2>${esc(t("a.c.title"))}</h2><div class="toolbar"><input id="c_code" placeholder="${esc(t("a.c.code"))}" dir="ltr"><select id="c_type"><option value="percent">${esc(t("a.c.percent"))}</option><option value="fixed">${esc(t("a.c.fixed"))}</option></select><input id="c_val" type="number" step="0.01" placeholder="${esc(t("a.c.value"))}" style="width:90px"><input id="c_min" type="number" step="0.01" placeholder="${esc(t("a.c.min"))}" style="width:120px"><input id="c_max" type="number" placeholder="${esc(t("a.c.max"))}" style="width:100px"><button class="btn small" data-act="newcoupon">${esc(t("a.add"))}</button></div><p id="cmsg"></p>
      <table class="t"><thead>${th("a.c.code", "a.c.discount", "a.c.minCol", "a.c.used", "a.p.active", "")}</thead><tbody>${c.items.map((x) => `<tr><td class="ltr">${esc(x.code)}</td><td>${x.discount_type === "percent" ? `${I18N.num(x.discount_value)}%` : money(x.discount_value)}</td><td>${money(x.min_subtotal)}</td><td>${I18N.num(x.used_count, {})}${x.max_uses ? ` / ${I18N.num(x.max_uses, {})}` : ""}</td><td>${esc(t(x.is_active ? "a.yes" : "a.no"))}</td><td><button class="btn small ghost" data-act="togglecoupon" data-id="${x.id}" data-active="${x.is_active ? 0 : 1}">${esc(t(x.is_active ? "a.disable" : "a.enable"))}</button></td></tr>`).join("")}</tbody></table></div>`;
  },
  async users(v) {
    const d = await api('/admin/users');
    const ar = I18N.lang === 'ar';
    const tx = (en, arabic) => ar ? arabic : en;
    const customers = d.items.filter(u => u.role === 'customer');
    const staff = d.items.filter(u => u.role !== 'customer');
    const status = u => `<button class="btn small ghost" data-act="toggleuser" data-id="${u.id}" data-active="${u.isActive ? 0 : 1}">${esc(t(u.isActive ? 'a.disable' : 'a.enable'))}</button>`;
    const head = th('a.u.name', 'a.email', 'a.u.role', 'a.p.active', 'a.u.last', '');
    const row = (u, employee) => `<tr><td>${esc(u.name)}</td><td class="ltr">${esc(u.email)}</td><td>${employee && u.role !== 'admin' ? `<select data-act="setrole" data-id="${u.id}">${['order_manager','inventory_manager'].map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${esc(label('role',r))}</option>`).join('')}</select>` : esc(label('role',u.role))}</td><td>${esc(t(u.isActive ? 'a.yes' : 'a.no'))}</td><td>${dt(u.lastLoginAt)}</td><td>${u.id === S.user.id ? '' : status(u)}</td></tr>`;
    v.innerHTML = `<div class="panel"><h2>${tx('Customers', 'العملاء')} (${customers.length})</h2><p class="muted">${tx('Customer accounts cannot be promoted to staff. Orders are managed in the Orders section.', 'حسابات العملاء لا يمكن تحويلها إلى موظفين. الطلبات موجودة في قسم الطلبات.')}</p><table class="t"><thead>${head}</thead><tbody>${customers.map(u => row(u,false)).join('') || `<tr><td colspan="6">${tx('No customers','لا يوجد عملاء')}</td></tr>`}</tbody></table></div>
    <div class="panel"><h2>${tx('Staff and administrator', 'الموظفون والمدير')} (${staff.length})</h2><p class="muted">${tx('Only the administrator can create staff and change staff permissions.', 'الأدمن فقط ينشئ الموظفين ويغير صلاحياتهم.')}</p><div class="toolbar"><input id="u_name" placeholder="${esc(t('a.u.name'))}"><input id="u_email" type="email" dir="ltr" placeholder="${esc(t('a.email'))}"><input id="u_pw" type="password" dir="ltr" placeholder="${esc(t('a.u.pw'))}" autocomplete="new-password"><select id="u_role"><option value="order_manager">${esc(label('role','order_manager'))}</option><option value="inventory_manager">${esc(label('role','inventory_manager'))}</option></select><button class="btn small" data-act="newuser">${esc(t('a.u.create'))}</button></div><p id="umsg"></p><table class="t"><thead>${head}</thead><tbody>${staff.map(u => row(u,true)).join('')}</tbody></table></div>`;
  },
  async audit(v) {
    const d = await api("/admin/audit?limit=100");
    v.innerHTML = `<div class="panel"><h2>${esc(t("a.tab.audit"))}</h2><table class="t"><thead>${th("a.au.when", "a.au.actor", "a.au.action", "a.au.entity", "a.au.details")}</thead><tbody>${d.items.map((a) => `<tr><td>${dt(a.created_at)}</td><td>${esc(a.actor || t("a.au.system"))}</td><td class="ltr">${esc(auditAction(a.action))}</td><td class="ltr">${esc(a.entity_type || "")} ${esc(a.entity_id || "")}</td><td><small class="ltr">${esc(auditSummary(a.details))}</small></td></tr>`).join("")}</tbody></table></div>`;
  },
  async system(v) {
    const d = await api("/admin/system"); const b = d.lastBackup;
    v.innerHTML = `<div class="panel"><h2>${esc(t("a.sys.title"))}</h2><dl class="kv"><dt>${esc(t("a.sys.uptime"))}</dt><dd>${t("a.sys.min", { n: I18N.num(Math.round(d.uptimeSec / 60), {}) })}</dd><dt>Node</dt><dd>${esc(d.node)}</dd><dt>${esc(t("a.sys.memory"))}</dt><dd>${I18N.num(d.memoryMB, {})} MB</dd><dt>${esc(t("a.sys.live"))}</dt><dd>${I18N.num(d.sockets, {})}</dd><dt>${esc(t("a.sys.disk"))}</dt><dd>${d.disk ? `${I18N.num(d.disk.freeGB)} / ${I18N.num(d.disk.totalGB)} GB` : "n/a"}</dd><dt>${esc(t("a.sys.backup"))}</dt><dd>${b ? `${pill(b.status, "bk")} ${dt(b.finished_at || b.started_at)} ${esc(t(b.verified ? "a.sys.verified" : "a.sys.notVerified"))} ${esc(t(b.offsite_copied ? "a.sys.offsite" : "a.sys.noOffsite"))}${b.error ? ` <span class="err">${esc(b.error)}</span>` : ""}` : `<span class="err">${esc(t("a.sys.never"))}</span>`}</dd><dt>${esc(t("a.sys.health"))}</dt><dd>${d.backupStale ? `<span class="err">${esc(t("a.sys.stale"))}</span>` : '<span class="okmsg">OK</span>'}</dd></dl></div>`;
  },
};

async function orderDetail(v) {
  const { order: o } = await api(`/admin/orders/${S.orderId}`); const a = o.amounts; const c = o.customer;
  const pending = o.payments.find((p) => p.status === "submitted");
  v.innerHTML = `<div class="panel"><button class="btn small ghost" data-act="back">${esc(t("a.back"))}</button><h2 style="margin-top:12px"><span class="ltr">${esc(o.orderNumber)}</span> ${pill(o.status)} ${pill(o.shippingPaymentStatus, "sp")}</h2>
    <div class="grid2"><dl class="kv"><dt>${esc(t("a.od.customer"))}</dt><dd>${esc(c.name)}</dd><dt>${esc(t("a.od.phone"))}</dt><dd class="ltr">${esc(c.phone)}</dd><dt>${esc(t("a.email"))}</dt><dd class="ltr">${esc(c.email || "—")}</dd><dt>${esc(t("a.od.address"))}</dt><dd>${esc(label("gov", c.governorate))} · ${esc(c.city)}<br>${esc(c.address)}</dd><dt>${esc(t("a.o.created"))}</dt><dd>${dt(o.createdAt)}</dd></dl>
    <dl class="kv"><dt>${esc(t("a.od.products"))}</dt><dd>${money(a.productsSubtotal)}</dd><dt>${esc(t("a.od.discount"))}</dt><dd>${money(a.discount)} ${o.couponCode ? `(${esc(o.couponCode)})` : ""}</dd><dt>${esc(t("a.od.shipping"))}</dt><dd><strong>${money(a.shippingFee)}</strong></dd><dt>${esc(t("a.od.codAmount"))}</dt><dd><strong>${o.paymentMode === "full" ? money(0) : money(a.productsTotal)}</strong> ${o.paymentMode === "full" ? (o.shippingPaymentStatus === "confirmed" ? `<span class="pill ok">${esc(I18N.lang === "ar" ? "تم تحصيل المبلغ بالكامل" : "Paid in full")}</span>` : `<span class="pill warn">${esc(I18N.lang === "ar" ? "بانتظار مراجعة التحويل الكامل" : "Full payment awaiting review")}</span>`) : pill(o.codStatus, "cod")}</dd><dt>${esc(t("a.od.grand"))}</dt><dd>${money(a.grandTotal)}</dd></dl></div>
    <h3>${esc(t("a.od.items"))}</h3><table class="t"><tbody>${o.items.map((i) => `<tr><td>${esc(i.name)} ${esc(i.size || "")}</td><td>${I18N.num(i.quantity, {})} × ${money(i.unitPrice)}</td><td>${money(i.lineTotal)}</td></tr>`).join("")}</tbody></table>
    <h3>${esc(t("a.od.subs"))}</h3><table class="t"><thead>${th("a.au.when", "a.o.status", "a.od.claimed", "a.od.ref", "a.od.receipt", "a.od.reviewed")}</thead><tbody>${o.payments.map((p) => `<tr><td>${dt(p.submittedAt)}</td><td>${pill(p.status, "sp")}</td><td>${money(p.amountClaimed)}</td><td class="ltr">${esc(p.reference || "—")}</td><td>${p.hasReceipt ? `<a href="/api/admin/shipping-payments/${p.id}/receipt" target="_blank" rel="noopener">${esc(t("a.od.viewImg"))}</a>` : "—"}</td><td>${esc(p.reviewer || "—")} ${p.rejectReason ? `<br><small class="err">${esc(p.rejectReason)}</small>` : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">${esc(t("a.od.nosubs"))}</td></tr>`}</tbody></table>
    ${pending && can("shipping_payments.review") ? `<div class="row-actions"><div class="field"><label>${esc(t("a.od.received"))}</label><input id="payAmt" type="number" step="0.01" value="${o.paymentMode === "full" ? a.grandTotal : a.shippingFee}"></div><button class="btn" data-act="confirmpay">${esc(t("a.od.confirm"))}</button><div class="field"><label>${esc(t("a.od.rejReason"))}</label><input id="rejReason" placeholder="${esc(t("a.od.rejEx"))}"></div><button class="btn danger" data-act="rejectpay">${esc(t("a.od.reject"))}</button></div><p class="muted">${esc(t("a.od.warn"))}</p>` : ""}
    ${can("orders.manage") ? `<h3>${esc(t("a.od.actions"))}</h3><div class="row-actions">${o.allowedNext.map((s) => `<button class="btn ${s === "cancelled" ? "danger" : "ghost"} small" data-act="status" data-to="${s}">${esc(s === "cancelled" ? t("a.od.cancel") : t("a.od.markAs", { s: label("status", s) }))}</button>`).join("") || `<span class="muted">${esc(t("a.od.noMore"))}</span>`}</div>
      ${o.paymentMode !== "full" && o.status === "delivered" && o.codStatus === "pending" ? `<div class="row-actions"><button class="btn" data-act="cod" data-c="1">${esc(t("a.od.collected", { amount: money(a.productsTotal) }))}</button><button class="btn ghost" data-act="cod" data-c="0">${esc(t("a.od.notCollected"))}</button></div>` : ""}
      ${o.status === 'returned' && !o.stockRestored ? `<div class="panel"><strong>${I18N.lang==='ar'?'إرجاع المخزون بعد فحص المرتجع':'Restock after inspection'}</strong><p class="muted">${I18N.lang==='ar'?'لا يتم إرجاع المخزون تلقائيًا. اضغط بعد استلام وفحص المنتجات والتأكد إنها صالحة للبيع.':'Stock is not restored automatically. Confirm only after inspecting resellable returned items.'}</p><input id="returnStockReason" maxlength="255" placeholder="${I18N.lang==='ar'?'نتيجة الفحص / سبب الإرجاع':'Inspection result / reason'}"><button class="btn ghost small" data-act="returnrestock">${I18N.lang==='ar'?'إرجاع الكميات للمخزون':'Restock returned items'}</button></div>` : ''}
      ${['cancelled','returned'].includes(o.status) ? `<div class="panel"><h3>${I18N.lang==='ar'?'تسجيل استرداد مالي':'Record a refund'}</h3><p class="muted">${I18N.lang==='ar'?'تسجيل فقط بعد تحويل المبلغ للعميل فعليًا. النظام لا يحوّل فلوس.':'Only record after actually paying the customer externally. This does not transfer money.'}</p>
      ${!o.refundsReady ? `<p class="err">${I18N.lang==='ar'?'جدول الاستردادات غير مُجهز؛ راجع ملف التحديث الإضافي.':'Refund table not installed; see additive SQL file.'}</p>` : `<p>${I18N.lang==='ar'?'المدفوع المؤكد':'Confirmed paid'}: ${money(o.paidAmount)} · ${I18N.lang==='ar'?'المسترد':'Refunded'}: ${money(o.refundedAmount)} · ${I18N.lang==='ar'?'المتاح':'Available'}: ${money(o.refundableAmount)}</p>
      ${o.refundableAmount>0 ? `<div class="row-actions"><input id="refundAmount" type="number" min="0.01" step="0.01" max="${o.refundableAmount}" value="${o.refundableAmount}"><select id="refundMethod"><option value="instapay">InstaPay</option><option value="bank_transfer">${I18N.lang==='ar'?'تحويل بنكي':'Bank transfer'}</option><option value="cash">${I18N.lang==='ar'?'نقدًا':'Cash'}</option><option value="other">${I18N.lang==='ar'?'أخرى':'Other'}</option></select><input id="refundReference" maxlength="120" placeholder="${I18N.lang==='ar'?'رقم مرجع التحويل':'Transfer reference'}"><input id="refundReason" maxlength="255" placeholder="${I18N.lang==='ar'?'سبب الاسترداد':'Refund reason'}"><button class="btn small" data-act="recordrefund">${I18N.lang==='ar'?'تسجيل المبلغ المسترد':'Record refund'}</button></div>` : ''}
      <table class="t"><tbody>${(o.refunds||[]).map(r=>`<tr><td>${dt(r.createdAt)}</td><td>${money(r.amount)}</td><td>${esc(r.method)}</td><td>${esc(r.reference)}</td><td>${esc(r.actor||'—')}</td></tr>`).join('')}</tbody></table>`}</div>` : ''}` : ''}
    <p id="omsg"></p><h3>${esc(t("a.od.history"))}</h3><table class="t"><tbody>${o.history.map((h) => `<tr><td>${dt(h.at)}</td><td>${esc(h.actor)}</td><td class="ltr">${esc(auditAction(h.action))}</td><td><small class="ltr">${esc(auditSummary(h.details))}</small></td></tr>`).join("")}</tbody></table></div>`;
}

/* ---------------- actions ---------------- */
const val = (id) => $(`#${id}`)?.value.trim();
const formatSocialAccounts = (raw) => { try { const a = JSON.parse(raw || "[]"); return Array.isArray(a) ? a.map(x => `${x.platform} | ${x.url} | ${x.enabled ? "true" : "false"}`).join("\n") : ""; } catch { return ""; } };
const num = (id) => (val(id) === "" ? undefined : Number(val(id)));
// Product sizes are edited in individual rows instead of the old pipe-separated textarea.
// The first row is the default size/price used by the existing product API.
const variantCopy = (ar, en) => I18N.lang === "ar" ? ar : en;
function productVariantRow(v = {}) {
  const size = v.size ?? "";
  const price = v.price ?? "";
  const oldPrice = v.compareAtPrice ?? "";
  return `<div class="product-variant-row">
    <span class="product-variant-index" aria-hidden="true"></span>
    <div class="field"><label>${variantCopy("الحجم *", "Size *")}</label><input class="product-variant-size" type="text" maxlength="40" value="${esc(size)}" placeholder="50 ml" autocomplete="off"></div>
    <div class="field"><label>${variantCopy("السعر (ج.م) *", "Price (EGP) *")}</label><input class="product-variant-price" type="number" min="0" max="99999999.99" step="0.01" value="${esc(price)}" placeholder="550" inputmode="decimal"></div>
    <div class="field"><label>${variantCopy("السعر قبل الخصم (اختياري)", "Old price (optional)")}</label><input class="product-variant-old" type="number" min="0" max="99999999.99" step="0.01" value="${esc(oldPrice)}" placeholder="" inputmode="decimal"></div>
    <button type="button" class="btn small ghost product-variant-remove" data-act="removevariant">${variantCopy("حذف الحجم", "Remove")}</button>
  </div>`;
}
function updateVariantControls() {
  const rows = [...document.querySelectorAll("#f_variants_rows .product-variant-row")];
  rows.forEach((row, i) => {
    row.querySelector(".product-variant-index").textContent = variantCopy(`حجم ${i + 1}${i === 0 ? " · الأساسي" : ""}`, `Size ${i + 1}${i === 0 ? " · default" : ""}`);
    row.querySelector(".product-variant-remove").disabled = rows.length === 1;
  });
  const add = $("#f_add_variant");
  if (add) add.disabled = rows.length >= 30;
}
function readProductVariants() {
  const rows = [...document.querySelectorAll("#f_variants_rows .product-variant-row")];
  if (!rows.length || rows.length > 30) throw new Error(variantCopy("لازم تضيف من حجم واحد إلى 30 حجم.", "Add between 1 and 30 sizes."));
  const seen = new Set();
  return rows.map((row, i) => {
    const sizeInput = row.querySelector(".product-variant-size");
    const priceInput = row.querySelector(".product-variant-price");
    const oldInput = row.querySelector(".product-variant-old");
    const size = sizeInput.value.trim();
    const priceText = priceInput.value.trim();
    const oldText = oldInput.value.trim();
    const invalid = (input, ar, en) => { input.focus(); throw new Error(variantCopy(`الحجم رقم ${i + 1}: ${ar}`, `Size ${i + 1}: ${en}`)); };
    if (!size || size.length > 40) invalid(sizeInput, "اكتب اسم الحجم (مثلاً 50 مل).", "Enter a size (e.g. 50 ml).");
    const key = size.toLocaleLowerCase();
    if (seen.has(key)) invalid(sizeInput, "الحجم ده مكرر. كل حجم لازم يكون مختلف.", "Duplicate size. Each size must be unique.");
    seen.add(key);
    const validMoney = (v) => /^\d+(?:\.\d{1,2})?$/.test(v) && Number(v) <= 99999999.99;
    if (!validMoney(priceText)) invalid(priceInput, "اكتب سعر صحيح (0 أو أكثر، وبحد أقصى رقمين بعد العلامة).", "Enter a valid price (0 or more, up to 2 decimals).");
    if (oldText && !validMoney(oldText)) invalid(oldInput, "السعر القديم لازم يكون رقم صحيح أو اتركه فاضي.", "Enter a valid old price or leave it empty.");
    return { size, price: Number(priceText), compareAtPrice: oldText ? Number(oldText) : null };
  });
}
async function act(el) {
  const a = el.dataset.act; const msg = (text, bad) => { const m = $("#omsg") || $("#nmsg") || $("#smsg") || $("#umsg") || $("#cmsg"); if (m) { m.className = bad ? "err" : "okmsg"; m.textContent = text; } else toast(text); };
  try {
    if (a === "reportfilter") { S.reportMonth = val("reportMonth"); S.reportChartPeriod = val("reportChartPeriod") || S.reportChartPeriod || 'month'; return load(); }
    if (a === "reportcsv") {
      if (!S.reportData) return;
      const d = S.reportData; const rows = [['Metric','Value'],['Month',d.month],['Chart period',d.chartPeriod],['Chart range from',d.chartRange?.from],['Chart range to',d.chartRange?.to],['Delivered product sales EGP (by delivery date)',d.current.sales_total],['Orders placed',d.current.orders_count],['Delivered orders (by delivery date)',d.current.delivered_orders],['Estimated historical delivery dates',d.estimatedDeliveryDates],['Active customers',d.totals.customers],['Active products',d.totals.products],['Comparison available',d.comparisonAvailable ? 'yes' : 'no'],['Previous period',d.previousMonth],[],['Sales by category','Sales EGP'],...(d.categories || []).map(c=>[c.name,c.sales]),[],['Recent order','Customer','Date','Total EGP','Status'],...(d.recentOrders || []).map(o=>[o.order_number,o.customer_name,o.created_at,o.grand_total,o.status])];
      const csv = rows.map(row => row.map(x => `"${String(x ?? '').replace(/"/g,'""')}"`).join(',')).join('\r\n');
      const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8;'}); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href=url; link.download=`elzemity-sales-${d.month}.csv`; link.click(); URL.revokeObjectURL(url); return;
    }
    if (a === "reload") return load();
    if (a === "filter") { S.status = val("fStatus"); S.q = val("fQ"); S.page = 1; return load(); }
    if (a === "prev") { S.page--; return load(); } if (a === "next") { S.page++; return load(); }
    if (a === "pfilter") { S.pq = val("pQ").trim(); S.ppage = 1; return load(); }
    if (a === "pprev") { S.ppage = Math.max(1, S.ppage - 1); return load(); }
    if (a === "pnext") { S.ppage++; return load(); }
    if (a === "nfilter") { S.nq = val("nQ"); S.npage = 1; return load(); }
    if (a === "nprev") { S.npage--; return load(); } if (a === "nnext") { S.npage++; return load(); }
    if (a === "ncopy") { const d = await api("/admin/newsletter/emails"); const text = d.emails.join(", "); try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); } return msg(t("a.n.copied", { n: I18N.num(d.emails.length, {}) }), false); }
    if (a === "ndel") { if (!confirm(t("a.n.confirmDel"))) return; await api(`/admin/newsletter/${el.dataset.id}`, { method: "DELETE" }); toast(t("a.n.deleted")); return load(); }
    if (a === "back") { S.orderId = null; return load(); }
    if (a === "confirmpay") { await api(`/admin/orders/${S.orderId}/shipping-payment/confirm`, { method: "POST", body: { amount: num("payAmt") } }); toast(t("a.t.payConfirmed")); return load(); }
    if (a === "rejectpay") { await api(`/admin/orders/${S.orderId}/shipping-payment/reject`, { method: "POST", body: { reason: val("rejReason") } }); toast(t("a.t.payRejected")); return load(); }
    if (a === "status") { const to = el.dataset.to; const reason = to === "cancelled" ? prompt(t("a.prompt.cancel")) ?? null : undefined; if (to === "cancelled" && reason === null) return; await api(`/admin/orders/${S.orderId}/status`, { method: "POST", body: { status: to, ...(reason ? { reason } : {}) } }); toast(t("a.t.statusUpdated")); return load(); }
    if (a === "returnrestock") {
      const reason = val('returnStockReason');
      if (!reason || reason.length < 3) throw new Error(I18N.lang === 'ar' ? 'اكتب نتيجة فحص المرتجع (3 أحرف على الأقل).' : 'Enter the inspection result.');
      if (!confirm(I18N.lang === 'ar' ? 'متأكد إن كل منتجات الطلب رجعت وصالحة للبيع؟ العملية هتزود المخزون مرة واحدة فقط.' : 'Confirm all items are inspected and resellable? Stock is restored once.')) return;
      await api(`/admin/orders/${S.orderId}/return-restock`, { method:'POST', body:{reason} }); toast(I18N.lang==='ar'?'تم إرجاع المخزون':'Stock restored'); return load();
    }
    if (a === "recordrefund") {
      const amount = num('refundAmount'), method = val('refundMethod'), reference = val('refundReference'), reason = val('refundReason');
      if (!amount || !reference || !reason) throw new Error(I18N.lang==='ar'?'املأ المبلغ والمرجع والسبب.':'Enter amount, reference and reason.');
      if (!confirm(I18N.lang==='ar'?'هل تم تحويل المبلغ فعليًا للعميل؟ التسجيل لا ينفذ تحويل مالي.':'Have you actually refunded the customer externally? This only records it.')) return;
      await api(`/admin/orders/${S.orderId}/refunds`,{method:'POST',body:{amount,method,reference,reason}});
      toast(I18N.lang==='ar'?'تم تسجيل الاسترداد':'Refund recorded');return load();
    }
    if (a === "cod") { const col = el.dataset.c === "1"; const o = (await api(`/admin/orders/${S.orderId}`)).order; await api(`/admin/orders/${S.orderId}/cod`, { method: "POST", body: col ? { collected: true, amount: o.amounts.productsTotal } : { collected: false } }); toast(t("a.t.codRecorded")); return load(); }
    if (a === "newproduct" || a === "editproduct") return productForm(a === "editproduct" ? S.products.find((p) => p.id === Number(el.dataset.id)) : null);
    if (a === "addvariant") {
      const container = $("#f_variants_rows");
      if (!container || container.children.length >= 30) return;
      container.insertAdjacentHTML("beforeend", productVariantRow());
      updateVariantControls();
      container.lastElementChild.querySelector(".product-variant-size").focus();
      return;
    }
    if (a === "removevariant") {
      const container = $("#f_variants_rows");
      if (!container || container.children.length <= 1) return;
      el.closest(".product-variant-row")?.remove();
      updateVariantControls();
      return;
    }
    if (a === "saveproduct") { const id = el.dataset.id; const variants = readProductVariants(); const body = { name: val("f_name"), brand: val("f_brand") || "ELZEMITY", category: val("f_cat"), family: val("f_family") || null, notes: val("f_notes") || null, sizeLabel: variants[0].size, price: variants[0].price, compareAtPrice: variants[0].compareAtPrice, variants, tag: val("f_tag") || null, description: val("f_desc") || null, imageUrl: val("f_img") || null, isActive: $("#f_active").checked }; if (!id) {
        const stockInput = $("#f_stock");
        const rawStock = stockInput?.value.trim();
        if (rawStock === undefined || rawStock === "" || !/^\d+$/.test(rawStock)) {
          return msg(I18N.lang === "ar" ? "اكتب المخزون المبدئي كعدد صحيح (0 أو أكثر)." : "Enter initial stock as a whole number (0 or more).", true);
        }
        const initialStock = Number(rawStock);
        if (!Number.isSafeInteger(initialStock) || initialStock > 100000) {
          return msg(I18N.lang === "ar" ? "المخزون المبدئي لازم يكون من 0 إلى 100000." : "Initial stock must be between 0 and 100000.", true);
        }
        body.stock = initialStock;
      } const file = $("#f_file").files[0]; if (file && file.size > 5 * 1024 * 1024) return msg(t("a.p.imgBig"), true);
      const saved = await api(id ? `/admin/products/${id}` : "/admin/products", { method: id ? "PATCH" : "POST", body });
      if (file) { const fd = new FormData(); fd.append("image", file); await api(`/admin/products/${saved.product.id}/image`, { method: "POST", form: fd }); }
      toast(t("a.t.productSaved")); return load(); }
    if (a === "delproduct") { if (!confirm(t("a.p.confirmDel"))) return; await api(`/admin/products/${el.dataset.id}`, { method: "DELETE" }); toast(t("a.t.productDeleted")); return load(); }
    if (a === "stock") { const d = prompt(t("a.p.stockPrompt", { name: el.dataset.name })); if (!d) return; const n = Number(d); if (!Number.isInteger(n) || n === 0) return toast(t("a.p.stockInt")); const note = prompt(t("a.p.stockReason")); if (!note || note.trim().length < 3) return toast(t("a.p.stockNeedReason")); const r = await api(`/admin/products/${el.dataset.id}/stock`, { method: "POST", body: { mode: "delta", quantity: n, note: note.trim() } }); toast(t("a.t.stockNow", { n: I18N.num(r.quantity, {}) })); return load(); }
    if (a === "savesettings") { const socialAccounts = val("s_social_accounts").split("\n").map(line => line.trim()).filter(Boolean).map(line => { const parts = line.split("|").map(x => x.trim()); if (parts.length < 2 || !parts[0] || !/^https?:\/\//i.test(parts[1])) throw new Error("Each social account must be: platform | https://account-url | true/false"); return { platform: parts[0], url: parts[1], enabled: String(parts[2] || "true").toLowerCase() !== "false" }; }); if (socialAccounts.length > 20) throw new Error("Maximum 20 social accounts"); const body = { store_name: val("s_store_name"), instapay_handle: val("s_instapay_handle"), instapay_account_name: val("s_instapay_account_name"), shipping_payment_window_hours: num("s_shipping_payment_window_hours"), low_stock_threshold: num("s_low_stock_threshold"), shipping_only_enabled: $("#s_shipping_only_enabled").checked, contact_whatsapp: val("s_contact_whatsapp"), contact_whatsapp_enabled: $("#s_contact_whatsapp_enabled").checked, social_accounts: socialAccounts }; await api("/admin/settings", { method: "PUT", body }); return msg(t("a.t.saved"), false); }
    if (a === "savezone") { await api(`/admin/shipping-zones/${el.dataset.id}`, { method: "PATCH", body: { fee: Number($(`#zf${el.dataset.id}`).value), isActive: $(`#za${el.dataset.id}`).checked } }); return toast(t("a.t.zoneSaved")); }
    if (a === "newcoupon") { await api("/admin/coupons", { method: "POST", body: { code: val("c_code"), discountType: val("c_type"), discountValue: num("c_val"), ...(num("c_min") !== undefined ? { minSubtotal: num("c_min") } : {}), ...(num("c_max") !== undefined ? { maxUses: num("c_max") } : {}) } }); toast(t("a.t.couponAdded")); return load(); }
    if (a === "togglecoupon") { await api(`/admin/coupons/${el.dataset.id}`, { method: "PATCH", body: { isActive: el.dataset.active === "1" } }); return load(); }
    if (a === "newuser") { await api("/admin/users", { method: "POST", body: { name: val("u_name"), email: val("u_email"), password: $("#u_pw").value, role: val("u_role") } }); toast(t("a.t.userCreated")); return load(); }
    if (a === "toggleuser") { await api(`/admin/users/${el.dataset.id}`, { method: "PATCH", body: { isActive: el.dataset.active === "1" } }); return load(); }
  } catch (e) { msg(e.message, true); }
}
function productForm(p) {
  const variants = p?.variants?.length ? p.variants : [{ size: p?.sizeLabel || "", price: p?.price ?? "", compareAtPrice: p?.compareAtPrice ?? null }];
  $("#pform").innerHTML = `<div class="panel"><h3>${esc(t(p ? "a.p.edit" : "a.p.newTitle"))}</h3><div class="grid2">
    <div class="field"><label>${esc(t("a.p.fName"))}</label><input id="f_name" value="${esc(p?.name)}"></div><div class="field"><label>${esc(t("a.p.fCat"))}</label><select id="f_cat">${S.cats.map((c) => `<option value="${esc(c)}" ${p?.category === c ? "selected" : ""}>${esc(label("cat", c))}</option>`).join("")}</select></div>
    <div class="field"><label>${esc(t("a.p.fBrand"))}</label><input id="f_brand" value="${esc(p?.brand || "ELZEMITY")}"></div><div class="field"><label>${esc(t("a.p.fFamily"))}</label><input id="f_family" value="${esc(p?.family)}"></div>
    <div class="field"><label>${I18N.lang === "ar" ? "النوتات العطرية (افصل بفواصل)" : "Fragrance notes (comma separated)"}</label><input id="f_notes" value="${esc(p?.notes)}" placeholder="Bergamot, Jasmine, Musk"></div>
    <section class="product-variants-editor" aria-label="${variantCopy("أحجام المنتج وأسعارها", "Product sizes and prices")}">
      <div class="product-variants-heading"><div><h4>${variantCopy("الأحجام والأسعار", "Sizes and prices")}</h4><p class="muted">${variantCopy("اكتب حجم وسعر كل اختيار. لو المنتج حجم واحد، سيب صف واحد فقط. أول حجم هو السعر الأساسي المعروض للمنتج.", "Enter a size and price for each option. Keep one row for a single-size product. The first row sets the product's default price.")}</p></div><button type="button" class="btn small ghost" id="f_add_variant" data-act="addvariant">+ ${variantCopy("إضافة حجم", "Add size")}</button></div>
      <div id="f_variants_rows" class="product-variants-list">${variants.map(productVariantRow).join("")}</div>
    </section>
    <div class="field"><label>${esc(t("a.p.fTag"))}</label><input id="f_tag" value="${esc(p?.tag)}"></div>
    ${p ? "" : `<div class="field"><label>${esc(t("a.p.fStock"))}</label><input id="f_stock" type="number" min="0" value="0"></div>`}<div class="field"><label>${esc(t("a.p.fFile"))}</label><input id="f_file" type="file" accept="image/jpeg,image/png,image/webp"></div>
    <div class="field"><label>${esc(t("a.p.fLink"))}</label><input id="f_img" dir="ltr" value="${esc(p?.imageUrl)}"></div></div>${p?.imageUrl ? `<p class="muted">${esc(t("a.p.curImg"))} <a href="${esc(p.imageUrl)}" target="_blank" rel="noopener">${esc(t("a.p.view"))}</a></p>` : ""}
    <div class="field"><label>${esc(t("a.p.fDesc"))}</label><textarea id="f_desc" rows="3">${esc(p?.description)}</textarea></div><label><input type="checkbox" id="f_active" ${p ? (p.isActive ? "checked" : "") : "checked"}> ${esc(t("a.p.visible"))}</label>
    <div class="row-actions"><button class="btn" data-act="saveproduct" data-id="${p?.id || ""}">${esc(t("a.save"))}</button><button class="btn ghost" data-act="reload">${esc(t("a.cancel"))}</button></div><p id="smsg"></p></div>`;
  updateVariantControls();
}

/* ---------------- realtime ---------------- */
function startSocket() {
  if (typeof io !== "function") return startPolling();
  socket = io({ transports: ["websocket", "polling"] }); let down = false;
  const b = $("#connBanner");
  socket.on("connect", () => { b.hidden = true; if (down) { down = false; softRefresh(); toast(t("a.t.reconnected")); } }); // resync from MySQL via REST
  socket.on("disconnect", () => { down = true; b.hidden = false; b.textContent = t("net.paused"); });
  socket.on("connect_error", () => { down = true; b.hidden = false; b.textContent = "Live updates paused — reconnecting…"; });
  socket.on("order:created", (p) => { toast(t("a.t.newOrder", { n: p.orderNumber })); if (["orders", "reports"].includes(S.tab)) softRefresh(); });
  socket.on("shippingPayment:submitted", (p) => { toast(t("a.t.transfer", { n: p.orderNumber })); if (["orders", "reports"].includes(S.tab)) softRefresh(); });
  socket.on("newsletter:subscribed", () => { toast(t("a.t.newSub")); if (S.tab === "newsletter") softRefresh(); });
  for (const e of ["order:statusChanged", "order:updated", "shippingPayment:confirmed", "shippingPayment:rejected", "inventory:updated"]) socket.on(e, () => { if (["orders", "products", "reports"].includes(S.tab)) softRefresh(); });
}
// Shared hosting: one small, authenticated read-only request every 20 seconds while visible.
// Only changes trigger refresh; unsaved forms are protected by softRefresh().
let pollCursor = null, newsletterCursor = null, pollRunning = false;
function startPolling() {
  async function tick() {
    if (S.user && !document.hidden && navigator.onLine && !pollRunning) {
      pollRunning = true;
      try {
        const q = pollCursor === null ? '' : `?since=${pollCursor}`;
        const d = await api(`/admin/poll${q}`);
        if (pollCursor !== null) {
          let changed = false;
          for (const ev of d.events) {
            changed = true;
            if (ev.action === 'order.created' && ev.orderNumber) toast(t('a.t.newOrder', { n: ev.orderNumber }));
            if (ev.action === 'shipping_payment.submitted' && ev.orderNumber) toast(t('a.t.transfer', { n: ev.orderNumber }));
          }
          if (newsletterCursor !== null && d.newsletterLatest !== null && d.newsletterLatest > newsletterCursor) {
            changed = true; toast(t('a.t.newSub'));
          }
          if (changed && ['orders', 'products', 'newsletter', 'reports', 'system'].includes(S.tab)) softRefresh();
        }
        pollCursor = d.cursor;
        newsletterCursor = d.newsletterLatest;
        const banner = $('#connBanner'); if (banner) banner.hidden = true;
      } catch (err) {
        if (err.status !== 401) { const banner = $('#connBanner'); if (banner) { banner.hidden = false; banner.textContent = t('net.paused'); } }
      } finally { pollRunning = false; }
    }
    setTimeout(tick, 20000);
  }
  tick();
}
function reconnectSocket() {
  if (socket) { socket.disconnect(); socket.connect(); }
  else { pollCursor = null; newsletterCursor = null; } // re-baseline after login/logout
}

document.addEventListener("click", (e) => {
  const tg = e.target; const tab = tg.closest("[data-tab]"); const row = tg.closest("[data-order]"); const a = tg.closest("[data-act]");
  if (tg.id === "accountSecurity") { S.securityView = true; return render(); }
  if (tg.id === "closeSecurity") { S.securityView = false; return render(); }
  if (tg.id === "logout") return api("/auth/logout", { method: "POST" }).finally(() => { S.user = null; S.csrf = null; S.orderId = null; S.securityView = false; render(); reconnectSocket(); });
  if (tab) { S.tab = tab.dataset.tab; S.orderId = null; return render(); }
  if (a && a.tagName !== "SELECT") return act(a);
  if (row) { S.orderId = Number(row.dataset.order); S.tab = "orders"; return render(); }
});
document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset?.toggleProduct) {
    const on = el.checked; el.disabled = true;
    try {
      await api(`/admin/products/${el.dataset.toggleProduct}`, { method: "PATCH", body: { isActive: on } });
      toast(I18N.lang === "ar" ? (on ? "تم تفعيل العطر" : "تم إخفاء العطر من المتجر") : (on ? "Product enabled" : "Product hidden from the store"));
    } catch (err) { toast(err.message); }
    return load();
  }
  if (el.dataset?.act === "setrole") { try { await api(`/admin/users/${el.dataset.id}`, { method: "PATCH", body: { role: el.value } }); toast(t("a.t.roleUpdated")); } catch (err) { toast(err.message); load(); } }
});
document.addEventListener("keydown", (e) => { if (e.target?.id === "pQ" && e.key === "Enter") { e.preventDefault(); S.pq = e.target.value.trim(); S.ppage = 1; load(); } });
document.addEventListener("submit", async (e) => {
  const id = e.target.id;
  if (!["loginForm", "changePasswordForm", "changeEmailForm"].includes(id)) return;
  e.preventDefault(); const f = e.target;
  try {
    if (id === "loginForm") {
      loginFinished(await api("/auth/login", { method: "POST", body: { email: f.elements.email.value, password: f.elements.password.value } }));
    } else if (id === "changeEmailForm") {
      const newEmail = f.elements.newEmail.value.trim().toLowerCase();
      await api('/auth/change-email',{method:'POST',body:{newEmail,currentPassword:f.elements.currentPassword.value}});
      f.reset(); S.user=null;S.csrf=null;S.securityView=false;S.orderId=null;
      reconnectSocket();render();toast(I18N.lang==='ar'?`تم تغيير بريد الأدمن إلى ${newEmail}. سجل الدخول بالبريد الجديد.`:`Administrator email changed to ${newEmail}. Sign in again.`);
    } else if (id === "changePasswordForm") {
      const currentPassword = f.elements.currentPassword.value;
      const newPassword = f.elements.newPassword.value;
      if (newPassword !== f.elements.confirmPassword.value) throw new Error(I18N.lang === "ar" ? "تأكيد كلمة المرور غير مطابق" : "Passwords do not match");
      if (new TextEncoder().encode(newPassword).length > 72) throw new Error(I18N.lang === "ar" ? "كلمة المرور أطول من 72 بايت" : "Password exceeds 72 UTF-8 bytes");
      await api("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
      f.reset();
      S.user = null; S.csrf = null; S.securityView = false; S.orderId = null;
      reconnectSocket(); render(); toast(I18N.lang === "ar" ? "تم تغيير كلمة المرور. سجل الدخول بكلمة المرور الجديدة." : "Password changed. Sign in with your new password.");
    }
  } catch (err) { const el = $(id === "loginForm" ? "#lerr" : id === "changeEmailForm" ? "#emailChangeErr" : "#passwordChangeErr"); if (el) el.textContent = err.message; }
});
$("#langToggle").addEventListener("click", () => I18N.toggle());
I18N.onChange(() => { if (S.user) render(); else { render(); } });
init();
