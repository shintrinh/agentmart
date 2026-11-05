'use strict';
/*
 * AgentMart - agentic commerce for café restocking, built for the PayPal AI
 * Hackathon. Niche: a small café restocks coffee, tea and gear by talking to
 * an AI agent instead of re-ordering by hand — the agent builds the restock
 * cart inside a budget and takes it to a real PayPal checkout.
 *
 * What this server does:
 *  - Serves a small storefront (catalog, cart) + a merchant dashboard
 *    (/dashboard.html) built on AG Grid.
 *  - Integrates PayPal (sandbox by default):
 *      Orders API v2: create order -> buyer approves -> server capture.
 *      Invoicing API v2: merchant creates/sends an invoice for an order.
 *  - Tracks café inventory in SQLite: every product has stock on hand,
 *    a daily usage rate, a reorder point, a supplier lead time and a
 *    supplier. daysLeft = stock / dailyUse drives LOW/OUT alerts.
 *    Capturing a restock order adds the delivered quantities to stock;
 *    POST /api/inventory/simulate-day advances one day of demo usage.
 *  - Exposes an AI shopping agent at POST /api/agent. The agent is a
 *    tool-calling layer (search_products, add_to_cart, view_cart,
 *    create_checkout, order_status, check_stock, smart_restock) driven
 *    by a real LLM (Muse Spark, OpenAI-compatible Chat Completions
 *    with tool calling) when an LLM key is configured, with the
 *    deterministic intent engine as a fallback so the demo still
 *    works with no LLM key. smart_restock sizes the cart from burn
 *    rate x (lead time + 7 days) inside the budget, in one server-side
 *    calculation, then creates the PayPal checkout.
 *  - Persists carts, orders, invoices and inventory in SQLite
 *    (data/agentmart.db), so they survive a server restart.
 *
 * LLM chain (see .env.example): primary Baseten Muse Spark Open, fallback
 * Fireworks Muse Spark Open, then the deterministic intent engine. Meta
 * muse-spark-1.3 can be swapped in as primary via LLM_BASE_URL/LLM_MODEL.
 * Live test 2026-11-05: Baseten and Fireworks both answer and emit tool
 * calls, but both wander in a multi-step loop (Baseten: five rounds, one
 * item added, no checkout; Fireworks: five rounds, two items added,
 * $50 cart, no checkout). The agent loop therefore allows 8 rounds and
 * the system prompt caps searching at two calls before adding items.
 * Config: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=sandbox|live,
 * BASE_URL, PORT, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL,
 * LLM_FALLBACK_API_KEY, LLM_FALLBACK_BASE_URL, LLM_FALLBACK_MODEL.
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const PAYPAL_ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const PAYPAL_BASE = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const paypalConfigured = Boolean(CLIENT_ID && CLIENT_SECRET);

// LLM chain: primary Baseten Muse Spark Open (key expires soon, use first),
// fallback Fireworks Muse Spark Open, then deterministic engine.
// Meta muse-spark-1.3 can be swapped in as primary via LLM_BASE_URL/LLM_MODEL.
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://inference.baseten.co/v1').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'meta-models/muse-spark-open-1026';
const LLM_FALLBACK_API_KEY = process.env.LLM_FALLBACK_API_KEY || '';
const LLM_FALLBACK_BASE_URL = (process.env.LLM_FALLBACK_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/$/, '');
const LLM_FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL || 'accounts/fireworks/models/muse-spark-open';
const llmProviders = [
  ...(LLM_API_KEY ? [{ name: 'baseten', baseUrl: LLM_BASE_URL, model: LLM_MODEL, apiKey: LLM_API_KEY }] : []),
  ...(LLM_FALLBACK_API_KEY ? [{ name: 'fireworks', baseUrl: LLM_FALLBACK_BASE_URL, model: LLM_FALLBACK_MODEL, apiKey: LLM_FALLBACK_API_KEY }] : []),
];
const llmConfigured = llmProviders.length > 0;

/* ------------------------------------------------------------------ catalog */
// Demo inventory for one sample café. stock = units on hand, dailyUse =
// units used per day, reorderPoint = order when stock hits this level,
// leadTimeDays = supplier delivery time. These are demo figures for the
// sample café in this hackathon demo, not a real shop's numbers.
const PRODUCTS = [
  { id: 'arabica-beans',   name: 'Arabica Coffee Beans · 1kg',  price: 18.00, emoji: '☕', tag: 'coffee', blurb: 'Single-origin highland arabica, medium roast, whole bean.', stock: 4,    dailyUse: 0.5,  reorderPoint: 2, leadTimeDays: 3, shelfLifeDays: 90,  maxStock: 8,  supplier: 'Highland Roasters', altSupplier: { name: 'Andean Direct', price: 19.00, leadTimeDays: 4 } },
  { id: 'robusta-beans',   name: 'Robusta Coffee Beans · 1kg',  price: 14.00, emoji: '☕', tag: 'coffee', blurb: 'Bold, high-caffeine robusta - the espresso blend backbone.', stock: 6,    dailyUse: 0.4,  reorderPoint: 2, leadTimeDays: 3, shelfLifeDays: 90,  maxStock: 10, supplier: 'Highland Roasters', altSupplier: { name: 'Andean Direct', price: 13.50, leadTimeDays: 4 } },
  { id: 'pourover-set',    name: 'Ceramic Pour-Over Set',       price: 32.00, emoji: '🍶', tag: 'gear',   blurb: 'Dripper, glass server and bamboo collar for slow coffee.', stock: 3,    dailyUse: 0.1,  reorderPoint: 1, leadTimeDays: 5, shelfLifeDays: null, maxStock: null, supplier: 'Brew Gear Co.', altSupplier: { name: 'Kitchen Supply Hub', price: 30.00, leadTimeDays: 6 } },
  { id: 'coldbrew-bottle', name: 'Cold Brew Bottle · 750ml',   price: 24.00, emoji: '🧊', tag: 'gear',   blurb: 'Built-in filter bottle for 12-hour cold brew.', stock: 2,    dailyUse: 0.15, reorderPoint: 1, leadTimeDays: 5, shelfLifeDays: null, maxStock: null, supplier: 'Brew Gear Co.', altSupplier: { name: 'Kitchen Supply Hub', price: 26.00, leadTimeDays: 5 } },
  { id: 'matcha',          name: 'Ceremonial Matcha · 500g',    price: 21.00, emoji: '🍵', tag: 'tea',    blurb: 'Stone-milled ceremonial grade matcha, vibrant and smooth.', stock: 1,    dailyUse: 0.3,  reorderPoint: 1, leadTimeDays: 4, shelfLifeDays: 60,  maxStock: 3,  supplier: 'Kyoto Tea Imports', altSupplier: { name: 'Uji Tea Trading', price: 22.00, leadTimeDays: 5 } },
  { id: 'sugar-syrup',     name: 'Brown Sugar Syrup · 750ml',   price: 9.00,  emoji: '🍯', tag: 'pantry', blurb: 'Slow-cooked brown sugar syrup for milk teas and lattes.', stock: 5,    dailyUse: 0.25, reorderPoint: 2, leadTimeDays: 3, shelfLifeDays: 180, maxStock: 8,  supplier: 'Pantry Wholesale', altSupplier: { name: 'Sweet Source Co.', price: 8.00, leadTimeDays: 4 } },
  { id: 'oat-milk',        name: 'Oat Milk · 1L × 6',           price: 16.00, emoji: '🥛', tag: 'pantry', blurb: 'Barista-edition oat milk, steams and froths cleanly.', stock: 8,    dailyUse: 1.2,  reorderPoint: 3, leadTimeDays: 2, shelfLifeDays: 14,  maxStock: 12, supplier: 'Dairy & Pantry Co.', altSupplier: { name: 'Green Valley Farms', price: 14.00, leadTimeDays: 3 } },
  { id: 'barista-scale',   name: 'Digital Barista Scale',       price: 27.00, emoji: '⚖️', tag: 'gear',   blurb: '0.1g precision, timer built in, USB-C rechargeable.', stock: 2,    dailyUse: 0.05, reorderPoint: 1, leadTimeDays: 5, shelfLifeDays: null, maxStock: null, supplier: 'Brew Gear Co.', altSupplier: { name: 'Kitchen Supply Hub', price: 29.00, leadTimeDays: 5 } },
];
// Demo price history: monthly supplier prices Aug–Oct 2026 for the sample
// café. Illustrative demo data, not real supplier quotes.
const PRICE_HISTORY_SEED = {
  'arabica-beans':   [['2026-08-05', 16.50], ['2026-09-05', 17.00], ['2026-10-05', 17.50]],
  'robusta-beans':   [['2026-08-05', 13.00], ['2026-09-05', 13.50], ['2026-10-05', 14.00]],
  'pourover-set':    [['2026-08-05', 32.00], ['2026-09-05', 32.00], ['2026-10-05', 32.00]],
  'coldbrew-bottle': [['2026-08-05', 24.00], ['2026-09-05', 24.00], ['2026-10-05', 24.00]],
  'matcha':          [['2026-08-05', 19.00], ['2026-09-05', 20.00], ['2026-10-05', 21.00]],
  'sugar-syrup':     [['2026-08-05', 9.00], ['2026-09-05', 9.00], ['2026-10-05', 9.00]],
  'oat-milk':        [['2026-08-05', 15.00], ['2026-09-05', 15.50], ['2026-10-05', 16.00]],
  'barista-scale':   [['2026-08-05', 27.00], ['2026-09-05', 27.00], ['2026-10-05', 27.00]],
};
const productById = (id) => PRODUCTS.find((p) => p.id === id);
const money = (n) => `$${n.toFixed(2)}`;

/* -------------------------------------------------------------------- state */
const { DatabaseSync } = require('node:sqlite');
const DB_PATH = process.env.AGENTMART_DB_PATH || path.join(__dirname, 'data', 'agentmart.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS carts (session TEXT PRIMARY KEY, items TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, sessionId TEXT, items TEXT NOT NULL, total REAL NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, orderId TEXT, invoiceId TEXT NOT NULL, status TEXT NOT NULL, recipient TEXT, total REAL NOT NULL, createdAt TEXT NOT NULL, invoiceUrl TEXT);
CREATE TABLE IF NOT EXISTS inventory (productId TEXT PRIMARY KEY, stock REAL NOT NULL);
CREATE TABLE IF NOT EXISTS price_history (productId TEXT NOT NULL, price REAL NOT NULL, recordedAt TEXT NOT NULL, source TEXT NOT NULL, UNIQUE(productId, recordedAt));
CREATE TABLE IF NOT EXISTS payables (id TEXT PRIMARY KEY, orderId TEXT NOT NULL, supplier TEXT NOT NULL, amount REAL NOT NULL, dueDate TEXT NOT NULL, terms TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS restock_plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, dayOfWeek INTEGER NOT NULL, budget REAL NOT NULL, active INTEGER NOT NULL, lastRunAt TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS waste (id INTEGER PRIMARY KEY AUTOINCREMENT, productId TEXT NOT NULL, qty REAL NOT NULL, cost REAL NOT NULL, wastedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscription_plans (amount REAL PRIMARY KEY, planId TEXT NOT NULL, productId TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, planId TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL, boxItems TEXT NOT NULL, createdAt TEXT NOT NULL, lastFulfilledAt TEXT, nextBillingDate TEXT);`);
// Orders gained columns in v3/v4; add them to older databases.
for (const col of ['expectedDelivery TEXT', 'saved REAL', 'preventedStockouts INTEGER']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* already there */ }
}

const carts = new Map();  // sessionId -> Map(productId -> qty)
const orders = new Map(); // paypalOrderId -> { sessionId, items, total, status, createdAt }
const invoices = new Map(); // localId -> { orderId, invoiceId, status, recipient, total, createdAt, invoiceUrl }

function saveCart(session) {
  const items = JSON.stringify([...getCart(session)]);
  db.prepare('INSERT INTO carts (session, items) VALUES (?, ?) ON CONFLICT(session) DO UPDATE SET items=excluded.items').run(session, items);
}
function deleteCartRow(session) {
  db.prepare('DELETE FROM carts WHERE session=?').run(session);
}
function saveOrder(id, rec) {
  db.prepare('INSERT INTO orders (id, sessionId, items, total, status, createdAt, expectedDelivery, saved, preventedStockouts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, items=excluded.items, total=excluded.total, expectedDelivery=excluded.expectedDelivery, saved=excluded.saved, preventedStockouts=excluded.preventedStockouts').run(id, rec.sessionId, JSON.stringify(rec.items), rec.total, rec.status, rec.createdAt, rec.expectedDelivery || null, rec.saved || 0, rec.preventedStockouts || 0);
}
function saveInvoice(id, rec) {
  db.prepare('INSERT INTO invoices (id, orderId, invoiceId, status, recipient, total, createdAt, invoiceUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, invoiceUrl=excluded.invoiceUrl').run(id, rec.orderId, rec.invoiceId, rec.status, rec.recipient || '', rec.total, rec.createdAt, rec.invoiceUrl || '');
}
// Subscriptions (v7): a weekly restock box billed by PayPal Subscriptions.
// The subscription itself lives on PayPal; we cache its id, plan, amount,
// status and the box snapshot sized at setup. Render free has no persistent
// disk, so after a redeploy these rows reset — the subscription on PayPal
// survives and can be re-fetched by id (see refreshSubscription).
const subscriptions = new Map(); // paypalSubscriptionId -> { planId, amount, status, boxItems, createdAt, lastFulfilledAt, nextBillingDate }
const subscriptionPlans = new Map(); // amount -> { planId, productId, createdAt }
function saveSubscription(id, rec) {
  db.prepare('INSERT INTO subscriptions (id, planId, amount, status, boxItems, createdAt, lastFulfilledAt, nextBillingDate) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, lastFulfilledAt=excluded.lastFulfilledAt, nextBillingDate=excluded.nextBillingDate').run(id, rec.planId, rec.amount, rec.status, JSON.stringify(rec.boxItems), rec.createdAt, rec.lastFulfilledAt || null, rec.nextBillingDate || null);
}
function subscriptionView(id, rec) {
  return { id, planId: rec.planId, amount: rec.amount, status: rec.status, box: rec.boxItems, createdAt: rec.createdAt, lastFulfilledAt: rec.lastFulfilledAt || null, nextBillingDate: rec.nextBillingDate || null };
}
// Load persisted state on startup so orders/carts survive a restart.
for (const row of db.prepare('SELECT session, items FROM carts').all()) {
  carts.set(row.session, new Map(JSON.parse(row.items)));
}
for (const row of db.prepare('SELECT * FROM orders ORDER BY createdAt DESC').all()) {
  orders.set(row.id, { sessionId: row.sessionId, items: JSON.parse(row.items), total: row.total, status: row.status, createdAt: row.createdAt, expectedDelivery: row.expectedDelivery || null, saved: row.saved || 0, preventedStockouts: row.preventedStockouts || 0 });
}
for (const row of db.prepare('SELECT * FROM invoices ORDER BY createdAt DESC').all()) {
  invoices.set(row.id, { orderId: row.orderId, invoiceId: row.invoiceId, status: row.status, recipient: row.recipient, total: row.total, createdAt: row.createdAt, invoiceUrl: row.invoiceUrl });
}
for (const row of db.prepare('SELECT * FROM subscription_plans').all()) {
  subscriptionPlans.set(row.amount, { planId: row.planId, productId: row.productId, createdAt: row.createdAt });
}
for (const row of db.prepare('SELECT * FROM subscriptions ORDER BY createdAt DESC').all()) {
  subscriptions.set(row.id, { planId: row.planId, amount: row.amount, status: row.status, boxItems: JSON.parse(row.boxItems), createdAt: row.createdAt, lastFulfilledAt: row.lastFulfilledAt || null, nextBillingDate: row.nextBillingDate || null });
}
// Payables: what the café owes each supplier for captured orders.
const payables = new Map(); // payableId -> { orderId, supplier, amount, dueDate, terms, status }
function savePayable(row) {
  db.prepare('INSERT OR IGNORE INTO payables (id, orderId, supplier, amount, dueDate, terms, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.orderId, row.supplier, row.amount, row.dueDate, row.terms, row.status);
}
for (const row of db.prepare('SELECT * FROM payables').all()) {
  payables.set(row.id, { orderId: row.orderId, supplier: row.supplier, amount: row.amount, dueDate: row.dueDate, terms: row.terms, status: row.status });
}
function createPayablesForOrder(orderId) {
  const rec = orders.get(orderId);
  if (!rec || rec.status !== 'COMPLETED') return [];
  const rows = payablesForOrder(rec, orderId);
  for (const row of rows) {
    // Never overwrite an existing row: a PAID payable stays PAID.
    if (!payables.has(row.id)) {
      payables.set(row.id, row);
      savePayable(row);
    }
  }
  return rows;
}
// Inventory: seed from the catalog defaults on first run, then persist.
const inventory = new Map(); // productId -> stock on hand
for (const p of PRODUCTS) {
  db.prepare('INSERT OR IGNORE INTO inventory (productId, stock) VALUES (?, ?)').run(p.id, p.stock);
}
for (const row of db.prepare('SELECT productId, stock FROM inventory').all()) {
  inventory.set(row.productId, row.stock);
}
function saveStock(productId) {
  db.prepare('INSERT INTO inventory (productId, stock) VALUES (?, ?) ON CONFLICT(productId) DO UPDATE SET stock=excluded.stock').run(productId, inventory.get(productId));
}
function daysLeft(p) {
  const stock = inventory.get(p.id) ?? p.stock;
  return p.dailyUse > 0 ? stock / p.dailyUse : Infinity;
}
function stockStatus(p) {
  const stock = inventory.get(p.id) ?? p.stock;
  if (stock <= 0) return 'OUT';
  if (stock <= p.reorderPoint || daysLeft(p) <= p.leadTimeDays) return 'LOW';
  return 'OK';
}
function inventoryView() {
  return PRODUCTS.map((p) => {
    const stock = inventory.get(p.id) ?? p.stock;
    const dl = daysLeft(p);
    const status = stockStatus(p);
    const excess = p.maxStock != null ? Math.max(0, Math.round((stock - p.maxStock) * 100) / 100) : 0;
    const row = { id: p.id, name: p.name, emoji: p.emoji, tag: p.tag, price: p.price, supplier: p.supplier, stock, dailyUse: p.dailyUse, reorderPoint: p.reorderPoint, leadTimeDays: p.leadTimeDays, shelfLifeDays: p.shelfLifeDays, maxStock: p.maxStock, excess, wasteRisk: excess > 0, daysLeft: Math.round(dl * 10) / 10, status };
    if (status === 'OUT') {
      const sub = findSubstitute(p);
      if (sub) row.substitute = { id: sub.id, name: sub.name, emoji: sub.emoji, price: sub.price };
    }
    return row;
  });
}
// Substitute: the closest same-category item still in stock, when a
// product is OUT. Prefer OK over LOW, then the lowest price — the answer
// to a supply disruption ("we are out of arabica, what can we use?").
function findSubstitute(p) {
  const cands = PRODUCTS.filter((x) => x.id !== p.id && x.tag === p.tag && (inventory.get(x.id) ?? x.stock) > 0);
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const sa = stockStatus(a); const sb = stockStatus(b);
    if (sa !== sb) return sa === 'OK' ? -1 : 1;
    return a.price - b.price;
  });
  return cands[0];
}
// Add to cart with automatic substitution: if the requested product is
// OUT of stock and a same-category substitute is in stock, add the
// substitute instead and report the swap. Shared by the LLM tool and the
// deterministic engine so both paths behave identically.
function addToCartWithSubstitute(session, productId, qty) {
  const p = productById(productId);
  if (!p) return { error: 'UNKNOWN_PRODUCT' };
  const q = Math.max(1, Math.min(99, Math.round(Number(qty || 1))));
  if (stockStatus(p) === 'OUT') {
    const sub = findSubstitute(p);
    if (!sub) return { outOfStock: p, added: null, swappedFrom: null, qty: 0, cart: cartView(session) };
    cartAdd(session, sub.id, q);
    return { outOfStock: p, added: sub, swappedFrom: p, qty: q, cart: cartView(session) };
  }
  cartAdd(session, p.id, q);
  return { outOfStock: null, added: p, swappedFrom: null, qty: q, cart: cartView(session) };
}
// Smart restock: for items that will run out within lead time + 7 days of
// cover (or already at/below the reorder point), size the order to cover
// lead time + 7 days, then fill greedily by urgency inside the budget.
function smartRestockPlan(budget) {
  const rows = inventoryView()
    .filter((r) => r.status !== 'OK' || r.daysLeft <= r.leadTimeDays + 7)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const plan = [];
  let spent = 0; let saved = 0;
  for (const r of rows) {
    const p = productById(r.id);
    const best = bestSupplier(p);
    // Ceiling: never buy above the item's max stock — overbuying perishables
    // turns into waste. Items already at/above max are skipped entirely.
    const target = Math.min(Math.ceil(r.dailyUse * (best.leadTimeDays + 7)), p.maxStock ?? Infinity);
    // Stock can be fractional after simulated usage; order quantities
    // must be whole units (PayPal rejects fractional quantities).
    let qty = Math.max(0, Math.ceil(target - r.stock));
    if (!qty) continue;
    while (qty > 0 && spent + best.price * qty > budget) qty -= 1;
    if (!qty) continue;
    const lineTotal = best.price * qty;
    const lineSaved = (p.price - best.price) * qty;
    saved += Math.max(0, lineSaved);
    plan.push({ id: r.id, name: r.name, emoji: r.emoji, price: best.price, qty, lineTotal, daysLeft: r.daysLeft, supplier: best.name, supplierIsAlt: best.isAlt, leadTimeDays: best.leadTimeDays, saved: Math.max(0, Math.round(lineSaved * 100) / 100), reason: `only ${r.daysLeft} days left (lead time ${best.leadTimeDays}d${best.isAlt ? `, from ${best.name}` : ''})` });
    spent += lineTotal;
  }
  return { plan, total: spent, saved: Math.round(saved * 100) / 100 };
}

// Price history (seeded demo data) + supplier choice + delivery estimate.
for (const [pid, points] of Object.entries(PRICE_HISTORY_SEED)) {
  for (const [date, price] of points) {
    db.prepare('INSERT OR IGNORE INTO price_history (productId, price, recordedAt, source) VALUES (?, ?, ?, ?)').run(pid, price, date, 'demo-seed');
  }
}
function priceTrend(p) {
  const rows = db.prepare('SELECT price, recordedAt FROM price_history WHERE productId=? ORDER BY recordedAt ASC').all(p.id);
  const current = p.price;
  const oldest = rows.length ? rows[0].price : current;
  const lastMonth = rows.length > 1 ? rows[rows.length - 1].price : current;
  const pct = (from) => (from ? ((current - from) / from) * 100 : 0);
  return {
    id: p.id, name: p.name, emoji: p.emoji, tag: p.tag, current,
    threeMonthsAgo: oldest, changePct3mo: Math.round(pct(oldest) * 10) / 10,
    lastMonth, changePct1mo: Math.round(pct(lastMonth) * 10) / 10,
    creep: pct(oldest) > 5,
    history: [...rows.map((r) => ({ date: r.recordedAt, price: r.price })), { date: '2026-11-05', price: current }],
  };
}
// Best supplier: the alternate wins when it is cheaper AND its lead time
// is no more than 2 days slower than the main supplier.
function bestSupplier(p) {
  const main = { name: p.supplier, price: p.price, leadTimeDays: p.leadTimeDays, isAlt: false };
  const alt = p.altSupplier;
  if (alt && alt.price < p.price && alt.leadTimeDays <= p.leadTimeDays + 2) {
    return { name: alt.name, price: alt.price, leadTimeDays: alt.leadTimeDays, isAlt: true };
  }
  return main;
}
function expectedDeliveryDate(items) {
  const maxLead = Math.max(0, ...items.map((i) => i.leadTimeDays ?? productById(i.id)?.leadTimeDays ?? 0));
  const d = new Date();
  d.setDate(d.getDate() + maxLead);
  return d.toISOString().slice(0, 10);
}
// Forecast: projected stock-out date and the date to order by, per item.
// 14-day view: anything that runs out later is "beyond the forecast".
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function nextRunDate(dayOfWeek, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + ((dayOfWeek - d.getDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}
function forecastView() {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  return inventoryView().map((r) => {
    if (!isFinite(r.daysLeft)) return { ...r, stockoutDate: null, orderByDate: null, orderNow: false };
    const stockout = new Date(today);
    stockout.setDate(stockout.getDate() + Math.floor(r.daysLeft));
    const orderBy = new Date(stockout);
    orderBy.setDate(orderBy.getDate() - r.leadTimeDays);
    return { ...r, stockoutDate: iso(stockout), orderByDate: iso(orderBy), orderNow: iso(orderBy) <= iso(today) };
  });
}
// Restock plans: "every Monday, $60". Plans only run when asked (button
// or agent) — Render's free tier sleeps, so no background cron is claimed.
const plans = new Map(); // planId -> { name, dayOfWeek, budget, active, lastRunAt, createdAt }
function savePlan(plan) {
  db.prepare('INSERT INTO restock_plans (id, name, dayOfWeek, budget, active, lastRunAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, dayOfWeek=excluded.dayOfWeek, budget=excluded.budget, active=excluded.active, lastRunAt=excluded.lastRunAt').run(plan.id, plan.name, plan.dayOfWeek, plan.budget, plan.active ? 1 : 0, plan.lastRunAt || null, plan.createdAt);
}
function planView(p) { return { ...p, nextRun: nextRunDate(p.dayOfWeek) }; }
function createPlan({ name, dayOfWeek, budget }) {
  const plan = { id: `plan-${Date.now().toString(36)}`, name, dayOfWeek, budget, active: true, lastRunAt: null, createdAt: new Date().toISOString() };
  plans.set(plan.id, plan);
  savePlan(plan);
  return plan;
}
for (const row of db.prepare('SELECT * FROM restock_plans').all()) {
  plans.set(row.id, { id: row.id, name: row.name, dayOfWeek: row.dayOfWeek, budget: row.budget, active: !!row.active, lastRunAt: row.lastRunAt, createdAt: row.createdAt });
}
// Savings ledger: totals over captured orders. Shared by the deterministic
// intent and the LLM check_savings tool, so both answer from the same data.
function savingsSummary() {
  const done = [...orders.values()].filter((o) => o.status === 'COMPLETED');
  const totalSaved = Math.round(done.reduce((s, o) => s + (o.saved || 0), 0) * 100) / 100;
  const preventedStockouts = done.reduce((s, o) => s + (o.preventedStockouts || 0), 0);
  return { capturedOrders: done.length, totalSaved, preventedStockouts };
}
// Waste: perishables stocked above maxStock spoil a little every simulated
// day (10% of the excess, at least 1 unit). Demo simulation, labeled so in
// the UI — it models the carrying cost of overbuying, not a sensor.
function wasteSummary() {
  const events = db.prepare('SELECT * FROM waste ORDER BY wastedAt DESC, id DESC').all()
    .map((r) => ({ id: r.id, productId: r.productId, name: productById(r.productId)?.name || r.productId, emoji: productById(r.productId)?.emoji || '', qty: r.qty, cost: r.cost, wastedAt: r.wastedAt }));
  const totalQty = Math.round(events.reduce((s, e) => s + e.qty, 0) * 100) / 100;
  const totalCost = Math.round(events.reduce((s, e) => s + e.cost, 0) * 100) / 100;
  return { events, totalQty, totalCost };
}
function spoilExcess() {
  const today = new Date().toISOString().slice(0, 10);
  const spoiled = [];
  for (const p of PRODUCTS) {
    if (p.shelfLifeDays == null || p.maxStock == null) continue;
    const stock = inventory.get(p.id) ?? p.stock;
    const excess = stock - p.maxStock;
    if (excess < 1) continue;
    const qty = Math.min(excess, Math.max(1, Math.ceil(excess * 0.10)));
    const cost = Math.round(qty * p.price * 100) / 100;
    db.prepare('INSERT INTO waste (productId, qty, cost, wastedAt) VALUES (?, ?, ?, ?)').run(p.id, qty, cost, today);
    inventory.set(p.id, Math.round((stock - qty) * 100) / 100);
    saveStock(p.id);
    spoiled.push({ id: p.id, name: p.name, emoji: p.emoji, qty, cost });
  }
  return spoiled;
}

async function runPlan(session, plan) {
  const { plan: items, total, saved } = smartRestockPlan(plan.budget);
  if (!items.length) return { reply: `Nothing needs restocking right now — your "${plan.name}" plan found all stock healthy.`, items, total: 0, saved: 0 };
  for (const item of items) cartAdd(session, item.id, item.qty, { price: item.price, supplier: item.supplier, leadTimeDays: item.leadTimeDays });
  const r = await agentTools.create_checkout(session);
  const rec = orders.get(r.orderId);
  plan.lastRunAt = new Date().toISOString();
  savePlan(plan);
  const savedLine = saved > 0 ? ` Saved ${money(saved)} by buying from cheaper alternate suppliers.` : '';
  const deliveryLine = rec?.expectedDelivery ? ` Expected delivery by ${rec.expectedDelivery}.` : '';
  return { reply: `Ran "${plan.name}" (budget ${money(plan.budget)}):\n${items.map((i) => `${i.emoji} ${i.qty}× ${i.name} — ${money(i.lineTotal)} (${i.reason})`).join('\n')}\nRestock total: ${money(total)}.${savedLine}${deliveryLine}\n\n${r.reply}`, checkoutUrl: r.checkoutUrl, orderId: r.orderId, cart: cartView(session), items, total, saved };
}
// Supplier payment terms (demo seed): produce is COD, broadline Net 7,
// equipment Net 30 — the classic A/P mix a small café juggles.
const SUPPLIER_TERMS = {
  'Highland Roasters': { terms: 'Net 7', days: 7 },
  'Andean Direct': { terms: 'COD', days: 0 },
  'Brew Gear Co.': { terms: 'Net 30', days: 30 },
  'Kitchen Supply Hub': { terms: 'Net 7', days: 7 },
  'Kyoto Tea Imports': { terms: 'Net 7', days: 7 },
  'Uji Tea Trading': { terms: 'COD', days: 0 },
  'Pantry Wholesale': { terms: 'Net 7', days: 7 },
  'Sweet Source Co.': { terms: 'COD', days: 0 },
  'Dairy & Pantry Co.': { terms: 'Net 7', days: 7 },
  'Green Valley Farms': { terms: 'Net 7', days: 7 },
};
function supplierTerms(name) { return SUPPLIER_TERMS[name] || { terms: 'Net 7', days: 7 }; }
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// Payables for one captured order, split per supplier: amount owed,
// due date = expected delivery + payment terms. Pure function (testable).
function payablesForOrder(rec, orderId) {
  const bySupplier = new Map();
  for (const item of rec.items || []) {
    const p = productById(item.id);
    const supplier = item.supplier || p?.supplier || 'Unknown supplier';
    bySupplier.set(supplier, (bySupplier.get(supplier) || 0) + item.price * item.qty);
  }
  const base = rec.expectedDelivery || new Date().toISOString().slice(0, 10);
  return [...bySupplier.entries()].map(([supplier, amount]) => {
    const t = supplierTerms(supplier);
    return { id: `pay-${orderId}-${supplier.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, orderId, supplier, amount: Math.round(amount * 100) / 100, dueDate: addDays(base, t.days), terms: t.terms, status: 'UNPAID' };
  });
}

function getCart(session) {
  if (!carts.has(session)) carts.set(session, new Map());
  return carts.get(session);
}
// Cart entries are plain qty numbers, or {qty, price, supplier,
// leadTimeDays} when a line was priced by a chosen supplier (smart
// restock). Readers tolerate both shapes, so old persisted carts keep
// working.
function cartEntryQty(e) { return typeof e === 'number' ? e : (e.qty || 0); }
function cartEntryPrice(p, e) { return typeof e === 'number' ? p.price : (e.price ?? p.price); }
function cartEntrySupplier(e) { return typeof e === 'number' ? null : (e.supplier || null); }
function cartEntryLead(e, p) { return typeof e === 'number' ? p.leadTimeDays : (e.leadTimeDays ?? p.leadTimeDays); }
function cartAdd(session, pid, qty, pricing) {
  const c = getCart(session);
  const cur = c.get(pid);
  const newQty = (cur === undefined ? 0 : cartEntryQty(cur)) + Math.max(1, Math.min(99, Math.round(Number(qty || 1))));
  if (pricing) {
    // First price wins for a line already in the cart.
    const keep = cur !== undefined && typeof cur === 'object' && cur !== null;
    c.set(pid, keep ? { qty: newQty, price: cur.price, supplier: cur.supplier, leadTimeDays: cur.leadTimeDays } : { qty: newQty, ...pricing });
  } else if (cur !== undefined && typeof cur === 'object' && cur !== null) {
    c.set(pid, { qty: newQty, price: cur.price, supplier: cur.supplier, leadTimeDays: cur.leadTimeDays });
  } else {
    c.set(pid, newQty);
  }
  saveCart(session);
}
function cartView(session) {
  const items = [];
  let total = 0; let count = 0;
  for (const [pid, entry] of getCart(session)) {
    const p = productById(pid);
    if (!p) continue;
    const qty = cartEntryQty(entry);
    const price = cartEntryPrice(p, entry);
    const supplier = cartEntrySupplier(entry);
    const leadTimeDays = cartEntryLead(entry, p);
    const lineTotal = price * qty;
    items.push({ id: p.id, name: p.name, emoji: p.emoji, price, qty, lineTotal, ...(supplier ? { supplier } : {}), leadTimeDays });
    total += lineTotal; count += qty;
  }
  return { items, total, count };
}

/* ------------------------------------------------------------- PayPal calls */
async function paypalAccessToken() {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function createPayPalOrder(session) {
  const view = cartView(session);
  if (!view.items.length) throw new Error('CART_EMPTY');
  const token = await paypalAccessToken();
  const total = view.total.toFixed(2);
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: `agentmart-${session}`,
      description: 'AgentMart order (placed by AI shopping agent)',
      amount: {
        currency_code: 'USD',
        value: total,
        breakdown: { item_total: { currency_code: 'USD', value: total } },
      },
      items: view.items.map((i) => ({
        name: i.name.slice(0, 127),
        unit_amount: { currency_code: 'USD', value: i.price.toFixed(2) },
        // PayPal requires whole-unit quantities; round defensively so a
        // fractional quantity persisted in an old cart can never break checkout.
        quantity: String(Math.max(1, Math.round(i.qty))),
      })),
    }],
    application_context: {
      brand_name: 'AgentMart',
      user_action: 'PAY_NOW',
      return_url: `${BASE_URL}/paypal/return`,
      cancel_url: `${BASE_URL}/paypal/cancel`,
    },
  };
  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PayPal create order failed (${res.status}): ${await res.text()}`);
  const order = await res.json();
  const approveUrl = (order.links || []).find((l) => l.rel === 'approve')?.href;
  // Savings ledger, computed at order time: what the chosen suppliers
  // saved vs catalog prices, and how many stock-outs this order prevents
  // (items that are LOW/OUT right now).
  const saved = Math.round(view.items.reduce((s, i) => {
    const p = productById(i.id);
    return s + Math.max(0, (p?.price ?? i.price) - i.price) * i.qty;
  }, 0) * 100) / 100;
  const preventedStockouts = view.items.filter((i) => {
    const p = productById(i.id);
    return p && (stockStatus(p) === 'LOW' || stockStatus(p) === 'OUT');
  }).length;
  const rec = {
    sessionId: session,
    items: view.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, price: i.price, ...(i.supplier ? { supplier: i.supplier } : {}), leadTimeDays: i.leadTimeDays })),
    expectedDelivery: expectedDeliveryDate(view.items),
    total: view.total,
    status: 'CREATED',
    createdAt: new Date().toISOString(),
    saved,
    preventedStockouts,
  };
  orders.set(order.id, rec);
  saveOrder(order.id, rec);
  return { orderId: order.id, approveUrl };
}

async function capturePayPalOrder(orderId) {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`PayPal capture failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const rec = orders.get(orderId);
  if (rec) {
    const wasCaptured = rec.status !== 'COMPLETED';
    rec.status = data.status || 'COMPLETED';
    saveOrder(orderId, rec);
    carts.delete(rec.sessionId);
    deleteCartRow(rec.sessionId);
    // A captured restock order means the delivery arrived: add the
    // delivered quantities to stock (once per order).
    if (wasCaptured && rec.status === 'COMPLETED') {
      for (const item of rec.items || []) {
        const p = productById(item.id) || PRODUCTS.find((x) => x.name === item.name);
        if (!p) continue;
        inventory.set(p.id, (inventory.get(p.id) ?? p.stock) + item.qty);
        saveStock(p.id);
      }
      // A captured order is money owed: create the payables per supplier.
      createPayablesForOrder(orderId);
    }
  }
  return data;
}

/* ---------------------------------------------------------- PayPal invoicing */
async function createPayPalInvoice(orderId, recipientEmail) {
  const rec = orders.get(orderId);
  if (!rec) throw new Error('ORDER_NOT_FOUND');
  const token = await paypalAccessToken();
  const body = {
    detail: {
      invoice_number: `AM-${orderId.slice(-6)}`,
      reference: `AgentMart order ${orderId}`,
      currency_code: 'USD',
      note: 'AgentMart café restock invoice — created by the merchant from a completed agent order.',
      payment_term: { term_type: 'DUE_ON_RECEIPT' },
    },
    invoicer: { name: { given_name: 'AgentMart', surname: 'Merchant' }, email_address: 'merchant@agentmart.example' },
    primary_recipients: [{ billing_info: { email_address: recipientEmail } }],
    items: rec.items.map((i) => ({
      name: i.name.slice(0, 200),
      quantity: String(i.qty),
      unit_amount: { currency_code: 'USD', value: i.price.toFixed(2) },
    })),
  };
  const res = await fetch(`${PAYPAL_BASE}/v2/invoicing/invoices`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PayPal create invoice failed (${res.status}): ${await res.text()}`);
  const inv = await res.json();
  const href = (inv.links || []).find((l) => l.rel === 'self')?.href || '';
  const localId = `inv-${inv.id}`;
  const stored = { orderId, invoiceId: inv.id, status: inv.status || 'DRAFT', recipient: recipientEmail, total: rec.total, createdAt: new Date().toISOString(), invoiceUrl: href };
  invoices.set(localId, stored);
  saveInvoice(localId, stored);
  return stored;
}

async function sendPayPalInvoice(invoiceId) {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v2/invoicing/invoices/${invoiceId}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ send_to_recipient: true, send_to_invoicer: false }),
  });
  if (!res.ok) throw new Error(`PayPal send invoice failed (${res.status}): ${await res.text()}`);
  for (const [id, rec] of invoices) {
    if (rec.invoiceId === invoiceId) { rec.status = 'SENT'; saveInvoice(id, rec); }
  }
  return { invoiceId, status: 'SENT' };
}

async function getPayPalInvoice(invoiceId) {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v2/invoicing/invoices/${invoiceId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`PayPal get invoice failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/* ------------------------------------------- PayPal Subscriptions (v7) */
// Weekly Restock Box: one catalog product, one billing plan per price, one
// subscription per café. Schema verified live on sandbox 2026-11-05: product
// is {name, description, type: 'SERVICE'} — a category value is rejected
// with 400, so none is sent. Plan is weekly, fixed price, infinite cycles.
async function ensureSubscriptionProduct() {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get('paypal_product_id');
  if (row) return row.value;
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v1/catalogs/products`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AgentMart Weekly Restock Box', description: 'Weekly cafe restock box sized by the AgentMart agent', type: 'SERVICE' }),
  });
  if (!res.ok) throw new Error(`PayPal create product failed (${res.status}): ${await res.text()}`);
  const product = await res.json();
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('paypal_product_id', product.id);
  return product.id;
}

async function ensureSubscriptionPlan(amount) {
  const cached = subscriptionPlans.get(amount);
  if (cached) return cached.planId;
  const productId = await ensureSubscriptionProduct();
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v1/billing/plans`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_id: productId,
      name: `Weekly Restock Box - ${money(amount)}`,
      description: 'Weekly restock box, billed every week',
      billing_cycles: [{ frequency: { interval_unit: 'WEEK', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: amount.toFixed(2), currency_code: 'USD' } } }],
      payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CONTINUE', payment_failure_threshold: 3 },
    }),
  });
  if (!res.ok) throw new Error(`PayPal create plan failed (${res.status}): ${await res.text()}`);
  const plan = await res.json();
  const rec = { planId: plan.id, productId, createdAt: new Date().toISOString() };
  subscriptionPlans.set(amount, rec);
  db.prepare('INSERT INTO subscription_plans (amount, planId, productId, createdAt) VALUES (?, ?, ?, ?)').run(amount, plan.id, productId, rec.createdAt);
  return plan.id;
}

async function createSubscription(amount) {
  const { plan: box, total } = smartRestockPlan(amount);
  if (!box.length) throw new Error('NOTHING_TO_RESTOCK');
  const planId = await ensureSubscriptionPlan(total);
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plan_id: planId,
      application_context: { brand_name: 'AgentMart', locale: 'en-US', return_url: `${BASE_URL}/subscription/return`, cancel_url: `${BASE_URL}/subscription/cancel`, user_action: 'SUBSCRIBE_NOW' },
    }),
  });
  if (!res.ok) throw new Error(`PayPal create subscription failed (${res.status}): ${await res.text()}`);
  const sub = await res.json();
  const approveUrl = (sub.links || []).find((l) => l.rel === 'approve')?.href || '';
  const rec = { planId, amount: total, status: sub.status || 'APPROVAL_PENDING', boxItems: box, createdAt: new Date().toISOString(), lastFulfilledAt: null, nextBillingDate: null };
  subscriptions.set(sub.id, rec);
  saveSubscription(sub.id, rec);
  return { subscriptionId: sub.id, approveUrl, amount: total, items: box, status: rec.status };
}

async function refreshSubscription(id) {
  const rec = subscriptions.get(id);
  if (!rec) throw new Error('NOT_FOUND');
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`PayPal get subscription failed (${res.status}): ${await res.text()}`);
  const sub = await res.json();
  rec.status = sub.status || rec.status;
  rec.nextBillingDate = sub.billing_info?.next_billing_time || rec.nextBillingDate;
  saveSubscription(id, rec);
  return subscriptionView(id, rec);
}

async function setSubscriptionStatus(id, action, reason) {
  const rec = subscriptions.get(id);
  if (!rec) throw new Error('NOT_FOUND');
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions/${id}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason || `Merchant ${action} from AgentMart dashboard` }),
  });
  if (!res.ok) throw new Error(`PayPal ${action} subscription failed (${res.status}): ${await res.text()}`);
  return refreshSubscription(id);
}

async function fulfillSubscription(id, session) {
  const rec = subscriptions.get(id);
  if (!rec) throw new Error('NOT_FOUND');
  if (rec.status !== 'ACTIVE') throw new Error('SUBSCRIPTION_NOT_ACTIVE');
  const { plan, total, saved } = smartRestockPlan(rec.amount);
  if (!plan.length) return { message: 'Nothing needs restocking this week — all stock is above its reorder point.' };
  for (const item of plan) cartAdd(session, item.id, item.qty, { price: item.price, supplier: item.supplier, leadTimeDays: item.leadTimeDays });
  const r = await agentTools.create_checkout(session);
  const order = orders.get(r.orderId);
  rec.lastFulfilledAt = new Date().toISOString();
  saveSubscription(id, rec);
  return { subscriptionId: id, plan, total, saved, expectedDelivery: order?.expectedDelivery, orderId: r.orderId, checkoutUrl: r.checkoutUrl, reply: r.reply };
}

/* -------------------------------------------------------------- agent tools */
function searchProducts(query, maxPrice) {
  const q = (query || '').toLowerCase();
  const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  let hits = PRODUCTS.map((p) => {
    const hay = `${p.name} ${p.tag} ${p.blurb}`.toLowerCase();
    const score = tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
    return { p, score };
  }).filter((h) => h.score > 0);
  if (!hits.length) hits = PRODUCTS.map((p) => ({ p, score: 0 }));
  hits.sort((a, b) => b.score - a.score);
  let out = hits.map((h) => h.p);
  if (typeof maxPrice === 'number') out = out.filter((p) => p.price <= maxPrice);
  return out.slice(0, 5);
}
function matchOneProduct(text) {
  const hits = searchProducts(text);
  if (!hits.length) return null;
  const t = text.toLowerCase();
  const exact = hits.find((p) => t.includes(p.name.split('·')[0].trim().toLowerCase().split(' ')[0]) && p.tag && t.includes(p.id.split('-')[0]));
  return exact || hits[0];
}
const fmtList = (items) => items.map((p) => `${p.emoji} ${p.name} — ${money(p.price)}`).join('\n');

const agentTools = {
  async create_checkout(session) {
    if (!paypalConfigured) {
      return { reply: 'I have your cart ready, but PayPal sandbox is not configured on this server yet. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env (free at developer.paypal.com) and I can complete the checkout end-to-end.' };
    }
    const { orderId, approveUrl } = await createPayPalOrder(session);
    const view = orders.get(orderId);
    return {
      reply: `Done — I created PayPal order ${orderId} for ${money(view.total)}. Tap the button below to approve the payment in the PayPal sandbox; I will capture it automatically when you return.`,
      checkoutUrl: approveUrl,
      orderId,
    };
  },
};

/* ------------------------------------------------------------ LLM agent (real) */
const LLM_TOOLS = [
  { type: 'function', function: { name: 'search_products', description: 'Search the café catalog by keyword, optionally under a max price.', parameters: { type: 'object', properties: { query: { type: 'string' }, maxPrice: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'add_to_cart', description: 'Add a product to the cart by product id.', parameters: { type: 'object', properties: { productId: { type: 'string' }, qty: { type: 'number' } }, required: ['productId'] } } },
  { type: 'function', function: { name: 'remove_from_cart', description: 'Remove a product from the cart by product id.', parameters: { type: 'object', properties: { productId: { type: 'string' } }, required: ['productId'] } } },
  { type: 'function', function: { name: 'view_cart', description: 'Show the current cart with items and total.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'create_checkout', description: 'Create a PayPal Checkout order for the current cart and return the approval URL.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'order_status', description: 'Look up an order by its PayPal order id.', parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] } } },
  { type: 'function', function: { name: 'check_stock', description: 'Check café inventory: stock on hand, days left at current usage, and LOW/OUT alerts. Use when the user asks what they are running out of.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'smart_restock', description: 'Build a restock cart from the items that will run out soon, sized by burn rate, and create the PayPal checkout in one step. Use when the user asks to restock before running out.', parameters: { type: 'object', properties: { budget: { type: 'number' } } } } },
  { type: 'function', function: { name: 'check_prices', description: 'Check supplier price history: current price, change over 3 months and 1 month, and which prices crept up more than 5%. Use when the user asks about prices going up.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'check_payables', description: 'Check what the café owes suppliers: unpaid payables per supplier, amounts, due dates and overdue flags. Use when the user asks what they owe.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'check_savings', description: 'Check how much the agent has saved the café: total dollars saved by buying from cheaper alternate suppliers, stock-outs prevented, and number of captured orders. Use when the user asks how much you have saved them.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_restock_plan', description: 'Run the active weekly restock plan (or the named plan): smart restock within the plan budget and create the PayPal checkout. Use when the user asks to run their weekly restock.', parameters: { type: 'object', properties: { name: { type: 'string' } } } } },
  { type: 'function', function: { name: 'create_subscription', description: 'Set up a weekly restock subscription (PayPal Subscriptions): size this week\'s restock box within the budget, create the weekly billing plan and subscription, and return the PayPal approval URL. Use when the user asks to subscribe or set up a weekly restock subscription.', parameters: { type: 'object', properties: { budget: { type: 'number' } } } } },
  { type: 'function', function: { name: 'check_subscriptions', description: 'List the café\'s weekly restock subscriptions with their PayPal status, amount, box contents and next billing date. Use when the user asks what subscriptions they have.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'cancel_subscription', description: 'Cancel a weekly restock subscription on PayPal (by subscription id, or the latest one if omitted). Use when the user asks to cancel their subscription.', parameters: { type: 'object', properties: { subscriptionId: { type: 'string' } } } } },
  { type: 'function', function: { name: 'fulfill_subscription', description: 'Fulfill this week\'s box for an ACTIVE weekly restock subscription: smart restock within the subscription amount and create the PayPal checkout. Use when the user asks to fulfill this week\'s subscription box.', parameters: { type: 'object', properties: { subscriptionId: { type: 'string' } } } } },
];
const LLM_SYSTEM = `You are the AgentMart shopping agent for a small café restocking coffee, tea and gear. You must use the provided tools to act — never invent products, prices or order ids. Products come only from search_products. When the user asks what they are running out of, call check_stock first. When the user asks to restock before running out, call smart_restock once (it sizes the cart and creates the checkout) instead of searching and adding item by item. When the user asks for a kit/bundle under a budget: search at most twice, then immediately add items one by one staying inside the budget, then call create_checkout exactly once and tell the user the order id, total and to approve on PayPal sandbox. Do not keep searching once you have seen products that fit the budget. When the user asks for an order status, call order_status with the id from their message. When the user asks about prices going up or supplier prices, call check_prices first and name the items that crept up more than 5% in 3 months. When the user asks what they owe suppliers, call check_payables first and list the unpaid amounts, due dates and anything overdue. When the user asks how much you have saved them, call check_savings first and report the total saved, the stock-outs prevented and the number of captured orders — never say savings are not tracked when the tool returns a number, even if it is zero. When the user asks to run their weekly restock, call run_restock_plan once. When the user asks to set up a weekly restock subscription, call create_subscription once and tell them the box contents, the weekly amount and to approve on PayPal sandbox — the subscription bills weekly after approval. When the user asks what subscriptions they have, call check_subscriptions first. When the user asks to cancel a subscription, call cancel_subscription once. When the user asks to fulfill this week's subscription box, call fulfill_subscription once. When the user asks when things will run out, call check_stock first and answer with the forecast dates (stock-out date and order-by date). If a product the user wants is out of stock, the add_to_cart tool automatically substitutes the closest same-category in-stock item and tells you in its result — explain the swap and the price difference to the user, and offer to remove it with remove_from_cart. Answer in English, concisely, with prices in USD.`;

async function executeLlmTool(session, name, args) {
  if (name === 'search_products') {
    const hits = searchProducts(args.query || '', typeof args.maxPrice === 'number' ? args.maxPrice : undefined);
    return { products: hits.map((p) => ({ id: p.id, name: p.name, price: p.price, tag: p.tag, blurb: p.blurb })) };
  }
  if (name === 'add_to_cart') {
    const r = addToCartWithSubstitute(session, args.productId, args.qty);
    if (r.error) return { error: r.error };
    // Tell the model exactly what happened so it can explain the swap.
    return {
      cart: r.cart,
      added: r.added ? { id: r.added.id, name: r.added.name, price: r.added.price, qty: r.qty } : null,
      substituted: r.swappedFrom ? { requested: { id: r.swappedFrom.id, name: r.swappedFrom.name }, reason: 'OUT_OF_STOCK' } : null,
      outOfStockNoSubstitute: !r.added && r.outOfStock ? { id: r.outOfStock.id, name: r.outOfStock.name } : null,
    };
  }
  if (name === 'remove_from_cart') {
    const p = productById(args.productId);
    if (!p) return { error: 'UNKNOWN_PRODUCT' };
    const c = getCart(session);
    const had = c.delete(p.id);
    saveCart(session);
    return { cart: cartView(session), removed: had ? { id: p.id, name: p.name } : null };
  }
  if (name === 'view_cart') return { cart: cartView(session) };
  if (name === 'create_checkout') {
    const r = await agentTools.create_checkout(session);
    return { orderId: r.orderId, checkoutUrl: r.checkoutUrl, reply: r.reply };
  }
  if (name === 'order_status') {
    const rec = orders.get(args.orderId);
    if (!rec) return { error: 'NOT_FOUND' };
    return { orderId: args.orderId, status: rec.status, total: rec.total, items: rec.items };
  }
  if (name === 'check_stock') {
    return { inventory: inventoryView(), forecast: forecastView(), waste: wasteSummary() };
  }
  if (name === 'check_savings') {
    return savingsSummary();
  }
  if (name === 'run_restock_plan') {
    const all = [...plans.values()].filter((p) => p.active);
    const plan = args.name
      ? all.find((p) => p.name.toLowerCase().includes(String(args.name).toLowerCase()))
      : all[0];
    if (!plan) return { message: 'No active restock plan. Ask me to set one up first, for example "set up a weekly restock every Monday under $60".' };
    const out = await runPlan(session, plan);
    return { plan: planView(plan), ...out };
  }
  if (name === 'smart_restock') {
    const budget = typeof args.budget === 'number' && args.budget > 0 ? args.budget : 60;
    const { plan, total, saved } = smartRestockPlan(budget);
    if (!plan.length) return { message: 'Nothing needs restocking right now — all stock is above its reorder point with enough days of cover.' };
    for (const item of plan) cartAdd(session, item.id, item.qty, { price: item.price, supplier: item.supplier, leadTimeDays: item.leadTimeDays });
    const r = await agentTools.create_checkout(session);
    const rec = orders.get(r.orderId);
    return { plan, total, saved, expectedDelivery: rec?.expectedDelivery, orderId: r.orderId, checkoutUrl: r.checkoutUrl, reply: r.reply };
  }
  if (name === 'check_prices') {
    return { prices: PRODUCTS.map((p) => priceTrend(p)) };
  }
  if (name === 'check_payables') {
    const today = new Date().toISOString().slice(0, 10);
    const list = [...payables.entries()].map(([id, r]) => ({ id, ...r, overdue: r.status === 'UNPAID' && r.dueDate < today })).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const unpaid = list.filter((r) => r.status === 'UNPAID');
    return { payables: list, totalUnpaid: Math.round(unpaid.reduce((s, r) => s + r.amount, 0) * 100) / 100, overdue: unpaid.filter((r) => r.overdue) };
  }
  if (name === 'create_subscription') {
    const budget = typeof args.budget === 'number' && args.budget > 0 ? args.budget : 60;
    return createSubscription(budget);
  }
  if (name === 'check_subscriptions') {
    return { subscriptions: [...subscriptions.entries()].map(([id, rec]) => subscriptionView(id, rec)) };
  }
  if (name === 'cancel_subscription') {
    const id = args.subscriptionId || [...subscriptions.keys()].pop();
    if (!id) return { message: 'No subscriptions yet — set one up first, for example "set up a weekly restock subscription under $60".' };
    return setSubscriptionStatus(id, 'cancel', 'Cancelled by the merchant from AgentMart');
  }
  if (name === 'fulfill_subscription') {
    const id = args.subscriptionId || [...subscriptions.entries()].find(([, r]) => r.status === 'ACTIVE')?.[0];
    if (!id) return { message: 'No ACTIVE subscription to fulfill — set one up and approve it on PayPal first.' };
    return fulfillSubscription(id, session);
  }
  return { error: 'UNKNOWN_TOOL' };
}

async function runLlmAgent(session, rawMessage, provider) {
  const messages = [
    { role: 'system', content: LLM_SYSTEM },
    { role: 'user', content: rawMessage },
  ];
  let checkoutUrl; let orderId;
  for (let round = 0; round < 8; round++) {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: provider.model, messages, tools: LLM_TOOLS, tool_choice: 'auto', temperature: 0.2 }),
    });
    if (!res.ok) throw new Error(`LLM call failed (${provider.name} ${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const choice = data.choices?.[0]?.message;
    if (!choice) throw new Error('LLM returned no choice');
    messages.push(choice);
    const calls = choice.tool_calls || [];
    if (!calls.length) {
      return { reply: choice.content || '', checkoutUrl, orderId, cart: cartView(session), engine: `llm:${provider.name}:${provider.model}` };
    }
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
      const result = await executeLlmTool(session, call.function.name, args);
      if (result.checkoutUrl) checkoutUrl = result.checkoutUrl;
      if (result.orderId) orderId = result.orderId;
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { reply: 'I completed the requested actions — check your cart for the result.', checkoutUrl, orderId, cart: cartView(session), engine: `llm:${provider.name}:${provider.model}` };
}

async function runAgent(session, rawMessage) {
  const message = (rawMessage || '').trim();
  // Real LLM first when configured: Baseten, then Fireworks fallback.
  // Fall back to the deterministic engine on any LLM error so the demo
  // never dies in front of a judge.
  for (const provider of llmProviders) {
    try {
      return await runLlmAgent(session, message, provider);
    } catch (e) {
      console.error(`LLM agent failed on ${provider.name}, trying next provider:`, e.message);
    }
  }
  const msg = message.toLowerCase();
  const cart = () => cartView(session);
  const cartSuffix = () => {
    const v = cart();
    return v.count ? `\n\n🧺 Your cart: ${v.count} item(s), total ${money(v.total)}.` : '';
  };

  // Order status
  const idMatch = message.match(/\b[A-Z0-9]{12,}\b/);
  if ((msg.includes('order') && (msg.includes('status') || msg.includes('track'))) || (idMatch && msg.includes('status'))) {
    const rec = idMatch && orders.get(idMatch[0]);
    if (rec) return { reply: `Order ${idMatch[0]}: status ${rec.status}, total ${money(rec.total)} (${rec.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}).` };
    return { reply: 'I could not find that order in this demo session. Orders I place for you appear here as soon as I create them.' };
  }

  // Checkout
  if (/(checkout|check out|pay now|thanh toán|thanh toan)/.test(msg)) {
    if (!cart().items.length) return { reply: 'Your cart is empty — tell me what to add first, e.g. "add 2 arabica beans".' };
    const r = await agentTools.create_checkout(session);
    return { ...r, cart: cart() };
  }

  // View cart
  if (/\bcart\b|giỏ|gio hang|what's in/.test(msg)) {
    const v = cart();
    if (!v.items.length) return { reply: 'Your cart is empty. Ask me to find something — try "show me coffee under $20".' };
    return { reply: `Here is your cart:\n${v.items.map((i) => `${i.emoji} ${i.qty}× ${i.name} — ${money(i.lineTotal)}`).join('\n')}\nTotal: ${money(v.total)}\nSay "checkout" and I will pay with PayPal for you.`, cart: v };
  }

  // Low stock / running out: "what am I running out of?"
  if (/(running out|low stock|low on|almost out|hết hàng|het hang|sắp hết|sap het)/.test(msg)) {
    const rows = inventoryView();
    const low = rows.filter((r) => r.status !== 'OK');
    const lines = rows.map((r) => `${r.emoji} ${r.name} — ${r.stock} left, ~${r.daysLeft} days (${r.status})`).join('\n');
    const warn = low.length
      ? `\n\n⚠️ Running low: ${low.map((r) => `${r.name} (~${r.daysLeft} days)`).join(', ')}. Say "smart restock" and I will order exactly what you need before you run out.`
      : '\n\nEverything is above its reorder point. Say "smart restock" any time and I will double-check.';
    return { reply: `Here is your stock:\n${lines}${warn}` };
  }

  // Payables: "what do I owe?" / "nợ bao nhiêu?"
  if (/(owe|payable|unpaid|what.*due|\bnợ\b)/.test(msg)) {
    const today = new Date().toISOString().slice(0, 10);
    const list = [...payables.entries()].map(([id, r]) => ({ id, ...r, overdue: r.status === 'UNPAID' && r.dueDate < today })).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const unpaid = list.filter((r) => r.status === 'UNPAID');
    if (!list.length) return { reply: 'No payables on the books yet — nothing is owed to any supplier. Place and capture a restock order first.' };
    const total = unpaid.reduce((s, r) => s + r.amount, 0);
    const lines = list.map((r) => `${r.supplier} — ${money(r.amount)} (order ${r.orderId}, ${r.terms}, due ${r.dueDate}) — ${r.status}${r.overdue ? ' ⚠️ OVERDUE' : ''}`).join('\n');
    return { reply: `You owe ${money(total)} across ${unpaid.length} unpaid payable(s):\n${lines}${unpaid.some((r) => r.overdue) ? '\n\n⚠️ Something is overdue — pay it before the supplier holds your next delivery.' : ''}` };
  }

  // Savings ledger: "how much have you saved me?"
  if (/(how much.*(sav|save)|what.*(sav|save)|savings|tiết kiệm|tiet kiem)/.test(msg)) {
    const s = savingsSummary();
    if (!s.capturedOrders) return { reply: 'No captured orders yet, so no savings recorded. Run a smart restock and approve it — I will track every dollar the cheaper suppliers save you.' };
    return { reply: `Across ${s.capturedOrders} captured order(s), I have saved you ${money(s.totalSaved)} by buying from cheaper alternate suppliers, and prevented ${s.preventedStockouts} stock-out(s) by restocking before items ran out.` };
  }

  // Subscriptions (v7): "set up a weekly subscription" / "what subscriptions
  // do I have?" / "cancel my subscription" / "fulfill this week's box".
  if (/(subscription|subscribe|đăng ký|dang ky)/.test(msg)) {
    const list = [...subscriptions.entries()].map(([id, rec]) => subscriptionView(id, rec));
    if (/(cancel|hủy|huy)/.test(msg)) {
      const idMatch = message.match(/\bI-[A-Z0-9]+\b/);
      const id = idMatch?.[0] || [...subscriptions.keys()].pop();
      if (!id) return { reply: 'No subscriptions yet — set one up first, for example "set up a weekly restock subscription under $60".' };
      const view = await setSubscriptionStatus(id, 'cancel', 'Cancelled by the merchant from AgentMart');
      return { reply: `Subscription ${id} is now ${view.status} — PayPal will not bill the weekly ${money(view.amount)} anymore.` };
    }
    if (/(fulfill|fulfil|giao hàng|giao hang)/.test(msg)) {
      const id = [...subscriptions.entries()].find(([, r]) => r.status === 'ACTIVE')?.[0];
      if (!id) return { reply: 'No ACTIVE subscription to fulfill — set one up and approve it on PayPal first.' };
      const out = await fulfillSubscription(id, session);
      if (out.message) return { reply: out.message };
      return { ...out, reply: `This week's box is on its way: ${out.plan.map((i) => `${i.qty}× ${i.name}`).join(', ')} — total ${money(out.total)} (saved ${money(out.saved)}), expected delivery ${out.expectedDelivery}. PayPal order ${out.orderId} — please approve on PayPal sandbox.` };
    }
    if (/(what|list|show|have|status|nào|nao)/.test(msg)) {
      if (!list.length) return { reply: 'No subscriptions yet — set one up with "set up a weekly restock subscription under $60" and PayPal will bill the box weekly after you approve it once.' };
      const lines = list.map((s) => `${s.id} — ${money(s.amount)}/week, ${s.status}${s.nextBillingDate ? `, next billing ${s.nextBillingDate.slice(0, 10)}` : ''} (box: ${s.box.map((i) => `${i.qty}× ${i.name}`).join(', ')})`).join('\n');
      return { reply: `Your weekly restock subscriptions:\n${lines}` };
    }
    const budgetMatch = msg.match(/\$?\s*(\d+(?:\.\d+)?)/);
    const budget = budgetMatch ? Number(budgetMatch[1]) : 60;
    try {
      const sub = await createSubscription(budget);
      return { reply: `Weekly restock subscription set up — box: ${sub.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}, ${money(sub.amount)} every week. PayPal subscription ${sub.subscriptionId} is waiting for approval:\n${sub.approveUrl}\nApprove it once on PayPal sandbox and it bills weekly on its own.` };
    } catch (e) {
      if (e.message === 'NOTHING_TO_RESTOCK') return { reply: 'Nothing needs restocking right now — all stock is above its reorder point, so there is no box to subscribe to yet.' };
      throw e;
    }
  }

  // Waste / overstock: "how much am I wasting?" / "am I overstocked?"
  if (/(wast|spoil|overstock|thừa|thua|hỏng|hong)/.test(msg)) {
    const w = wasteSummary();
    const over = inventoryView().filter((r) => r.wasteRisk);
    const lines = [];
    if (w.events.length) {
      lines.push(`Wasted so far: ${money(w.totalCost)} across ${w.totalQty} unit(s):`);
      lines.push(w.events.slice(0, 5).map((e) => `${e.emoji} ${e.qty}× ${e.name} — ${money(e.cost)} (${e.wastedAt})`).join('\n'));
    } else {
      lines.push('Nothing wasted so far.');
    }
    if (over.length) {
      lines.push(`Overstocked right now: ${over.map((r) => `${r.emoji} ${r.name} — ${r.stock} on hand, max ${r.maxStock} (${r.excess} excess, shelf life ${r.shelfLifeDays}d)`).join('; ')}. The excess spoils a little every simulated day, and smart restock will not buy more of these until stock falls.`);
    } else {
      lines.push('Nothing is overstocked right now.');
    }
    return { reply: lines.join('\n\n') };
  }

  // Forecast: "when will I run out of everything?" / "when will matcha run out?"
  if (/(when will|when.*run out|forecast|dự báo|du bao)/.test(msg)) {
    const rows = forecastView().sort((a, b) => (a.stockoutDate || '9999').localeCompare(b.stockoutDate || '9999'));
    // Only match a product when the question actually names one: a lone
    // letter like "I" would otherwise substring-match a product name.
    const stripped = msg.replace(/(when will|when|will|run out|of|forecast|everything|dự báo|du bao)/gi, ' ');
    const p = stripped.replace(/[^a-z]/gi, '').length >= 3 ? matchOneProduct(stripped) : null;
    const show = p ? rows.filter((r) => r.id === p.id) : rows;
    if (!show.length) return { reply: 'I could not tell which product you mean. Try "when will I run out of everything?"' };
    const lines = show.map((r) => {
      if (!r.stockoutDate) return `${r.emoji} ${r.name} — no usage, no stock-out in sight.`;
      return `${r.emoji} ${r.name} — ~${r.daysLeft} days left, runs out ~${r.stockoutDate} (${r.status})${r.orderNow ? ` — ⚠️ order by ${r.orderByDate} has passed, order now` : `, order by ${r.orderByDate}`}`;
    }).join('\n');
    const urgent = rows.filter((r) => r.orderNow);
    return { reply: `Forecast (at current usage):\n${lines}${!p && urgent.length ? `\n\n⚠️ Order now: ${urgent.map((r) => r.name).join(', ')} — the order-by date has already passed.` : ''}` };
  }

  // Run the weekly restock plan: "run my weekly restock"
  // (Checked before the set-up intent: "run my weekly restock" also
  // contains "weekly restock".)
  if (/(run|execute|start).*(weekly|plan|restock)/.test(msg)) {
    const all = [...plans.values()].filter((p) => p.active);
    if (!all.length) return { reply: 'No active restock plan yet. Say "set up a weekly restock every Monday under $60" and I will create one.' };
    const out = await runPlan(session, all[0]);
    return { reply: out.reply, checkoutUrl: out.checkoutUrl, orderId: out.orderId, cart: cart() };
  }

  // Set up a weekly restock plan: "set up a weekly restock every Monday under $60"
  if (/(set up|setup|schedule|create).*(plan|weekly|every)/.test(msg)) {
    const dayMatch = msg.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
    const budgetMatch = msg.match(/(?:under|below|\$)\s*\$?(\d+)/);
    if (!dayMatch) return { reply: 'Which day should the weekly restock run? For example: "set up a weekly restock every Monday under $60".' };
    const dayName = dayMatch[1];
    const day = DAY_NAMES.findIndex((d) => d.toLowerCase() === dayName);
    const budget = budgetMatch ? Number(budgetMatch[1]) : 60;
    const plan = createPlan({ name: `Weekly restock — ${DAY_NAMES[day]}`, dayOfWeek: day, budget });
    return { reply: `Done — weekly restock plan "${plan.name}" created: every ${DAY_NAMES[day]}, budget ${money(budget)}. Next run: ${planView(plan).nextRun}. Say "run my weekly restock" any time and I will execute it. (Plans run when you ask — there is no background cron on the free demo host.)` };
  }

  // Price creep: "did any prices go up?" / "giá có tăng không?"
  if (/(price.*(up|rose|ris|increase|creep|higher)|giá.*(tăng|tang|len)|did.*price|price check|supplier.*price)/.test(msg)) {
    const trends = PRODUCTS.map((p) => priceTrend(p));
    const creep = trends.filter((t) => t.creep).sort((a, b) => b.changePct3mo - a.changePct3mo);
    const lines = trends.map((t) => `${t.emoji} ${t.name} — ${money(t.current)} (${t.changePct3mo >= 0 ? '+' : ''}${t.changePct3mo}% in 3 months${t.creep ? ', ⚠️ creep' : ''})`).join('\n');
    const warn = creep.length
      ? `\n\n⚠️ Prices creeping up (>5% in 3 months): ${creep.map((t) => `${t.name} +${t.changePct3mo}%`).join(', ')}. Biggest riser is ${creep[0].name}. Ask for a smart restock and I will buy from the cheaper alternate supplier where one exists.`
      : '\n\nNo supplier price has crept up more than 5% in 3 months.';
    return { reply: `Supplier prices (demo history, Aug–Nov 2026):\n${lines}${warn}` };
  }

  // Smart restock: "restock me before Friday" / "smart restock under $60"
  if (/(smart restock|restock me|reorder what.*(low|need)|don.*run out)/.test(msg)) {
    const budgetMatch = msg.match(/(?:under|below|\$)\s*\$?(\d+)/);
    const budget = budgetMatch ? Number(budgetMatch[1]) : 60;
    const { plan, total, saved } = smartRestockPlan(budget);
    if (!plan.length) return { reply: 'Nothing needs restocking right now — all stock is above its reorder point with enough days of cover.' };
    for (const item of plan) cartAdd(session, item.id, item.qty, { price: item.price, supplier: item.supplier, leadTimeDays: item.leadTimeDays });
    const r = await agentTools.create_checkout(session);
    const rec = orders.get(r.orderId);
    const savedLine = saved > 0 ? `\n💰 Saved ${money(saved)} by buying from cheaper alternate suppliers.` : '';
    const deliveryLine = rec?.expectedDelivery ? `\n📦 Expected delivery by ${rec.expectedDelivery}.` : '';
    return { reply: `Smart restock within ${money(budget)} — sized by how fast you use each item:\n${plan.map((i) => `${i.emoji} ${i.qty}× ${i.name} — ${money(i.lineTotal)} (${i.reason})`).join('\n')}\nRestock total: ${money(total)}.${savedLine}${deliveryLine}\n\n${r.reply}`, checkoutUrl: r.checkoutUrl, orderId: r.orderId, cart: cart() };
  }

  // Reorder last order: "reorder my last order"
  if (/(reorder|order again|same (order|as last)|mua lại|mua lai)/.test(msg)) {
    const last = [...orders.values()].filter((o) => o.sessionId === session).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
    if (!last) return { reply: 'You have no previous order in this session yet. Build a kit first and I will remember it for one-click reordering.' };
    const added = [];
    for (const item of last.items || []) {
      const p = productById(item.id) || PRODUCTS.find((x) => x.name === item.name);
      if (!p) continue;
      // Reorder at the same supplier price the last order used.
      cartAdd(session, p.id, item.qty, { price: item.price, supplier: item.supplier || p.supplier, leadTimeDays: item.leadTimeDays ?? p.leadTimeDays });
      added.push(`${item.qty}× ${p.name}`);
    }
    if (!added.length) return { reply: 'Your last order had no items I can still find in the catalog.' };
    const r = await agentTools.create_checkout(session);
    return { reply: `Reordered your last order:\n${added.join('\n')}\nTotal: ${money(last.total)}.\n\n${r.reply}`, checkoutUrl: r.checkoutUrl, orderId: r.orderId, cart: cart() };
  }

  // Starter kit / restock flow (the demo moment): "restock coffee under $60"
  if (/(kit|combo|bundle|starter|set me up|restock)/.test(msg)) {
    const budgetMatch = msg.match(/(?:under|below|dưới|duoi|\$)\s*\$?(\d+)/) || msg.match(/\$(\d+)/);
    const budget = budgetMatch ? Number(budgetMatch[1]) : 60;
    const theme = msg.includes('tea') ? 'tea' : 'coffee';
    const pool = PRODUCTS.filter((p) => p.tag === theme || (theme === 'coffee' && p.tag === 'gear'));
    let spent = 0; const added = [];
    for (const p of pool) {
      if (spent + p.price > budget) continue;
      cartAdd(session, p.id, 1);
      spent += p.price; added.push(p);
    }
    if (!added.length) return { reply: `Nothing fits a ${money(budget)} budget in the ${theme} range. Try a higher budget.` };
    const r = await agentTools.create_checkout(session);
    return { reply: `I built you a ${theme} starter kit within ${money(budget)}:\n${fmtList(added)}\nKit total: ${money(spent)}.\n\n${r.reply}`, checkoutUrl: r.checkoutUrl, orderId: r.orderId, cart: cart() };
  }

  // Price filter search: "coffee under $20"
  const underMatch = msg.match(/(?:under|below|max|dưới|duoi)\s*\$?(\d+)/);
  if (underMatch || /^(show|find|search|list|tìm|tim|có|co)\b/.test(msg)) {
    const maxPrice = underMatch ? Number(underMatch[1]) : undefined;
    const hits = searchProducts(msg.replace(/(show|find|search|list|me|under|below|max|\$\d+|\d+)/g, ' '), maxPrice);
    if (!hits.length) return { reply: `No products match that${maxPrice ? ` under ${money(maxPrice)}` : ''}. The catalog has coffee, tea, gear and pantry items.` };
    return { reply: `Here is what I found${maxPrice ? ` under ${money(maxPrice)}` : ''}:\n${fmtList(hits)}\nSay "add <item>" and I will put it in your cart.${cartSuffix()}`, cart: cart() };
  }

  // Remove from cart: "remove robusta", "take out the oat milk"
  if (/^(remove|take out|delete|bỏ|bo|xóa|xoá)\b/.test(msg) || msg.includes('remove ')) {
    const p = matchOneProduct(msg.replace(/^(remove|take out|delete|bỏ|bo|xóa|xoá)\s+/, '').replace(/^(the|a|an)\s+/, ''));
    if (!p) return { reply: 'I could not tell which product to remove. Try "remove robusta".' };
    const c = getCart(session);
    const had = c.delete(p.id);
    saveCart(session);
    if (!had) return { reply: `${p.emoji} ${p.name} is not in your cart.${cartSuffix()}` };
    return { reply: `Removed ${p.emoji} ${p.name} from your cart.${cartSuffix()}`, cart: cart() };
  }

  // Substitute: "what can I use instead of arabica?" / "thay thế matcha bằng gì?"
  if (/(instead of|substitute|replacement|thay thế|thay the|thay cho)/.test(msg)) {
    const p = matchOneProduct(msg.replace(/(instead of|substitute|replacement|thay thế|thay the|thay cho|what can i use|what|use|can|có|co|gì|gi|bằng|bang)/gi, ' '));
    if (!p) return { reply: 'Tell me which product you need a substitute for — for example "what can I use instead of arabica?"' };
    const sub = findSubstitute(p);
    if (!sub) return { reply: `${p.emoji} ${p.name} has no in-stock substitute in the same category right now. Your best move is a smart restock so it is back on the shelf.` };
    const diff = sub.price - p.price;
    const diffText = diff === 0 ? 'the same price' : diff > 0 ? `${money(diff)} more` : `${money(-diff)} less`;
    return { reply: `Instead of ${p.emoji} ${p.name} (${money(p.price)}), use ${sub.emoji} ${sub.name} (${money(sub.price)}) — same category, in stock, ${diffText}. Say "add ${sub.name.split('·')[0].trim()}" and I will put it in your cart.` };
  }

  // Add to cart: "add 2 arabica", "buy matcha", "thêm 1 matcha"
  if (/^(add|buy|get|thêm|them|mua)\b/.test(msg) || msg.includes('add ')) {
    const qtyMatch = msg.match(/(\d+)\s*(?:x|×)?\s/);
    const qty = qtyMatch ? Math.max(1, Math.min(99, Number(qtyMatch[1]))) : 1;
    const p = matchOneProduct(msg.replace(/^(add|buy|get|thêm|them|mua)\s+/, '').replace(/\d+/g, ' '));
    if (!p) return { reply: 'I could not tell which product you mean. Try "show me coffee" first, then "add arabica".' };
    const r = addToCartWithSubstitute(session, p.id, qty);
    if (!r.added) return { reply: `${p.emoji} ${p.name} is out of stock and there is no in-stock substitute in the same category right now. Say "smart restock" and I will order it back before you run out for good.`, cart: cart() };
    if (r.swappedFrom) {
      const diff = r.added.price - r.swappedFrom.price;
      const diffText = diff === 0 ? 'the same price' : diff > 0 ? `${money(diff)} more` : `${money(-diff)} less`;
      return { reply: `${r.swappedFrom.emoji} ${r.swappedFrom.name} is out of stock, so I added ${qty}× ${r.added.emoji} ${r.added.name} instead — same category, in stock, ${diffText} (${money(r.added.price)} each). Say "remove ${r.added.name.split('·')[0].trim()}" if you would rather wait for ${r.swappedFrom.name.split('·')[0].trim()}.${cartSuffix()}`, cart: cart() };
    }
    return { reply: `Added ${qty}× ${p.emoji} ${p.name} (${money(p.price)} each).${cartSuffix()}\nSay "checkout" whenever you are ready — I will create the PayPal order for you.`, cart: cart() };
  }

  // Greeting / help
  if (/(hello|hi|hey|help|xin chào|chao)/.test(msg)) {
    return { reply: 'Hi! I am the AgentMart shopping agent. I can search the catalog, build your cart and check out with PayPal — all from chat. Try:\n• "Show me coffee under $20"\n• "Add 2 arabica beans"\n• "Build me a coffee starter kit under $60"\n• "What am I running out of?"\n• "Smart restock under $60"\n• "Did any prices go up?"\n• "What do I owe suppliers?"\n• "How much have you saved me?"\n• "When will I run out of everything?"\n• "Am I overstocked?"\n• "Set up a weekly restock subscription under $60"\n• "Checkout"' };
  }

  // Default: treat as a search
  const hits = searchProducts(msg);
  return { reply: `Here are the closest matches:\n${fmtList(hits)}\nSay "add <item>" to buy, or "build me a starter kit" and I will do everything, including PayPal checkout.${cartSuffix()}`, cart: cart() };
}

/* ------------------------------------------------------------------- routes */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/ag-grid-community', express.static(path.join(__dirname, 'node_modules', 'ag-grid-community', 'dist')));
app.use('/vendor/ag-grid-community/styles', express.static(path.join(__dirname, 'node_modules', 'ag-grid-community', 'styles')));

app.get('/health', (req, res) => res.json({ ok: true, paypalConfigured, llmConfigured }));
app.get('/api/config', (req, res) => res.json({ paypalConfigured, env: PAYPAL_ENV, llmConfigured, llmModel: LLM_MODEL, engine: llmConfigured ? `llm:${LLM_MODEL}` : 'deterministic' }));
app.get('/api/products', (req, res) => res.json(PRODUCTS));
app.get('/api/orders', (req, res) => {
  const session = req.query.session ? String(req.query.session) : null;
  let list = [...orders.entries()].map(([id, r]) => ({ id, ...r }));
  if (session) list = list.filter((o) => o.sessionId === session);
  list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json(list);
});
app.get('/api/inventory', (req, res) => res.json(inventoryView()));
app.get('/api/forecast', (req, res) => res.json(forecastView()));
app.get('/api/plans', (req, res) => res.json([...plans.values()].map(planView)));
app.post('/api/plans', (req, res) => {
  const { name, dayOfWeek, budget } = req.body || {};
  const day = Number(dayOfWeek);
  const b = Number(budget);
  if (!name || typeof name !== 'string' || !Number.isInteger(day) || day < 0 || day > 6 || !(b > 0)) {
    return res.status(400).json({ error: 'INVALID_INPUT', message: 'name, dayOfWeek (0=Sunday..6=Saturday) and a budget above 0 are required.' });
  }
  res.status(201).json(planView(createPlan({ name: name.slice(0, 80), dayOfWeek: day, budget: b })));
});
app.post('/api/plans/:id/run', async (req, res) => {
  const plan = plans.get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!plan.active) return res.status(400).json({ error: 'PLAN_INACTIVE', message: 'This plan is paused. Activate it first.' });
  try {
    const out = await runPlan(sessionOf(req), plan);
    res.json({ plan: planView(plan), ...out });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'RUN_FAILED', message: e.message });
  }
});
app.post('/api/plans/:id/toggle', (req, res) => {
  const plan = plans.get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'NOT_FOUND' });
  plan.active = !plan.active;
  savePlan(plan);
  res.json(planView(plan));
});
app.delete('/api/plans/:id', (req, res) => {
  if (!plans.has(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  plans.delete(req.params.id);
  db.prepare('DELETE FROM restock_plans WHERE id=?').run(req.params.id);
  res.json({ deleted: req.params.id });
});

// Subscriptions (v7): weekly restock box billed by PayPal Subscriptions.
app.get('/api/subscriptions', (req, res) => res.json([...subscriptions.entries()].map(([id, rec]) => subscriptionView(id, rec))));
app.post('/api/subscriptions', async (req, res) => {
  const b = Number(req.body?.budget);
  const budget = Number.isFinite(b) && b > 0 ? b : 60;
  if (req.body?.budget !== undefined && !(Number.isFinite(b) && b > 0)) {
    return res.status(400).json({ error: 'INVALID_INPUT', message: 'budget must be a number above 0.' });
  }
  try {
    res.status(201).json(await createSubscription(budget));
  } catch (e) {
    console.error(e);
    if (e.message === 'NOTHING_TO_RESTOCK') return res.status(400).json({ error: 'NOTHING_TO_RESTOCK', message: 'Nothing needs restocking right now.' });
    res.status(502).json({ error: 'SUBSCRIPTION_FAILED', message: e.message });
  }
});
app.post('/api/subscriptions/:id/refresh', async (req, res) => {
  try {
    res.json(await refreshSubscription(req.params.id));
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    console.error(e);
    res.status(502).json({ error: 'REFRESH_FAILED', message: e.message });
  }
});
app.post('/api/subscriptions/:id/cancel', async (req, res) => {
  try {
    res.json(await setSubscriptionStatus(req.params.id, 'cancel', 'Cancelled by the merchant from AgentMart'));
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    console.error(e);
    res.status(502).json({ error: 'CANCEL_FAILED', message: e.message });
  }
});
app.post('/api/subscriptions/:id/suspend', async (req, res) => {
  try {
    res.json(await setSubscriptionStatus(req.params.id, 'suspend', 'Suspended by the merchant from AgentMart'));
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    console.error(e);
    res.status(502).json({ error: 'SUSPEND_FAILED', message: e.message });
  }
});
app.post('/api/subscriptions/:id/activate', async (req, res) => {
  try {
    res.json(await setSubscriptionStatus(req.params.id, 'activate', 'Reactivated by the merchant from AgentMart'));
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    console.error(e);
    res.status(502).json({ error: 'ACTIVATE_FAILED', message: e.message });
  }
});
app.post('/api/subscriptions/:id/fulfill', async (req, res) => {
  try {
    res.json(await fulfillSubscription(req.params.id, sessionOf(req)));
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    if (e.message === 'SUBSCRIPTION_NOT_ACTIVE') return res.status(400).json({ error: 'SUBSCRIPTION_NOT_ACTIVE', message: 'Only an ACTIVE subscription can be fulfilled.' });
    console.error(e);
    res.status(502).json({ error: 'FULFILL_FAILED', message: e.message });
  }
});
app.get('/api/payables', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const list = [...payables.entries()].map(([id, r]) => ({ id, ...r, overdue: r.status === 'UNPAID' && r.dueDate < today })).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  res.json(list);
});
app.post('/api/payables/:id/pay', (req, res) => {
  const rec = payables.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'NOT_FOUND' });
  rec.status = 'PAID';
  db.prepare('UPDATE payables SET status=? WHERE id=?').run('PAID', req.params.id);
  res.json({ id: req.params.id, ...rec });
});
app.get('/api/prices', (req, res) => res.json(PRODUCTS.map((p) => {
  const t = priceTrend(p);
  const best = bestSupplier(p);
  return { ...t, supplier: p.supplier, altSupplier: p.altSupplier, bestSupplier: best.name, bestPrice: best.price, bestLeadTimeDays: best.leadTimeDays, bestIsAlt: best.isAlt };
})));
app.post('/api/inventory/simulate-day', (req, res) => {
  // Demo helper: advance one day of café usage so the low-stock flow can
  // be shown without waiting a real day. Labeled as simulation in the UI.
  for (const p of PRODUCTS) {
    const stock = Math.max(0, (inventory.get(p.id) ?? p.stock) - p.dailyUse);
    inventory.set(p.id, Math.round(stock * 100) / 100);
    saveStock(p.id);
  }
  // Overstocked perishables spoil a little each simulated day.
  const spoiled = spoilExcess();
  res.json({ inventory: inventoryView(), spoiled });
});
app.get('/api/waste', (req, res) => res.json(wasteSummary()));
app.post('/api/inventory/:id/adjust', (req, res) => {
  // Stocktake: correct the recorded stock to what was actually counted.
  const p = productById(req.params.id);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
  const stock = Number(req.body?.stock);
  if (!Number.isFinite(stock) || stock < 0 || stock > 999) {
    return res.status(400).json({ error: 'INVALID_INPUT', message: 'stock must be a number between 0 and 999.' });
  }
  inventory.set(p.id, Math.round(stock * 100) / 100);
  saveStock(p.id);
  res.json(inventoryView().find((r) => r.id === p.id));
});
app.post('/api/demo/reset', (req, res) => {
  // Reset the demo to its seed state before filming: stock back to seed,
  // waste and carts cleared. Orders, payables and plans are real records
  // and are kept.
  for (const p of PRODUCTS) {
    inventory.set(p.id, p.stock);
    saveStock(p.id);
  }
  db.prepare('DELETE FROM waste').run();
  db.prepare('DELETE FROM carts').run();
  res.json({ inventory: inventoryView(), waste: wasteSummary() });
});
app.post('/api/reorder-last', async (req, res) => {
  const session = sessionOf(req);
  const last = [...orders.values()].filter((o) => o.sessionId === session).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
  if (!last) return res.status(404).json({ error: 'NO_PREVIOUS_ORDER' });
  for (const item of last.items || []) {
    const p = productById(item.id) || PRODUCTS.find((x) => x.name === item.name);
    if (!p) continue;
    cartAdd(session, p.id, item.qty, { price: item.price, supplier: item.supplier || p.supplier, leadTimeDays: item.leadTimeDays ?? p.leadTimeDays });
  }
  res.json({ cart: cartView(session), lastOrderId: [...orders.entries()].find(([, o]) => o === last)?.[0] });
});
app.get('/api/invoices', (req, res) => {
  const list = [...invoices.entries()].map(([id, r]) => ({ id, ...r })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json(list);
});
app.post('/api/invoices', async (req, res) => {
  if (!paypalConfigured) return res.status(503).json({ error: 'PAYPAL_NOT_CONFIGURED' });
  const { orderId, recipientEmail } = req.body || {};
  if (!orderId || !recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return res.status(400).json({ error: 'INVALID_INPUT', message: 'orderId and a valid recipientEmail are required.' });
  }
  try {
    const inv = await createPayPalInvoice(orderId, recipientEmail);
    res.json({ id: `inv-${inv.invoiceId}`, ...inv });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'PAYPAL_ERROR', message: e.message });
  }
});
app.post('/api/invoices/:id/send', async (req, res) => {
  if (!paypalConfigured) return res.status(503).json({ error: 'PAYPAL_NOT_CONFIGURED' });
  const rec = invoices.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    const out = await sendPayPalInvoice(rec.invoiceId);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'PAYPAL_ERROR', message: e.message });
  }
});
app.post('/api/invoices/:id/refresh', async (req, res) => {
  if (!paypalConfigured) return res.status(503).json({ error: 'PAYPAL_NOT_CONFIGURED' });
  const rec = invoices.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    const inv = await getPayPalInvoice(rec.invoiceId);
    rec.status = inv.status || rec.status;
    saveInvoice(req.params.id, rec);
    res.json({ id: req.params.id, ...rec });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'PAYPAL_ERROR', message: e.message });
  }
});

const sessionOf = (req) => String(req.body?.session || req.query?.session || 'guest').slice(0, 64);

app.get('/api/cart', (req, res) => res.json(cartView(sessionOf(req))));
app.post('/api/cart/add', (req, res) => {
  const session = sessionOf(req);
  const r = addToCartWithSubstitute(session, req.body.productId, req.body.qty);
  if (r.error) return res.status(400).json({ error: r.error });
  if (!r.added) return res.status(409).json({ error: 'OUT_OF_STOCK', product: { id: r.outOfStock.id, name: r.outOfStock.name } });
  const view = cartView(session);
  if (r.swappedFrom) view.substituted = { requested: { id: r.swappedFrom.id, name: r.swappedFrom.name }, added: { id: r.added.id, name: r.added.name, price: r.added.price } };
  res.json(view);
});
app.post('/api/cart/set', (req, res) => {
  const session = sessionOf(req);
  const c = getCart(session);
  const qty = Math.round(Number(req.body.qty || 0));
  if (qty <= 0) {
    c.delete(req.body.productId);
  } else {
    const cur = c.get(req.body.productId);
    // Preserve a supplier-priced line when only the quantity changes.
    if (cur !== undefined && typeof cur === 'object' && cur !== null) {
      c.set(req.body.productId, { qty: Math.min(99, qty), price: cur.price, supplier: cur.supplier, leadTimeDays: cur.leadTimeDays });
    } else {
      c.set(req.body.productId, Math.min(99, qty));
    }
  }
  saveCart(session);
  res.json(cartView(session));
});

app.post('/api/paypal/create-order', async (req, res) => {
  if (!paypalConfigured) {
    return res.status(503).json({ error: 'PAYPAL_NOT_CONFIGURED', message: 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (PayPal sandbox) and restart the server.' });
  }
  try {
    const { orderId, approveUrl } = await createPayPalOrder(sessionOf(req));
    res.json({ orderId, approveUrl });
  } catch (e) {
    if (e.message === 'CART_EMPTY') return res.status(400).json({ error: 'CART_EMPTY' });
    console.error(e);
    res.status(502).json({ error: 'PAYPAL_ERROR', message: e.message });
  }
});

app.get('/paypal/return', async (req, res) => {
  const orderId = req.query.token;
  if (!orderId) return res.redirect('/?error=missing_order');
  try {
    await capturePayPalOrder(orderId);
    res.redirect(`/?paid=${encodeURIComponent(orderId)}`);
  } catch (e) {
    console.error(e);
    res.redirect(`/?error=capture_failed`);
  }
});
app.get('/paypal/cancel', (req, res) => res.redirect('/?cancelled=1'));
app.get('/subscription/return', async (req, res) => {
  const subId = req.query.subscription_id;
  if (!subId) return res.redirect('/?error=missing_subscription');
  try {
    await refreshSubscription(subId);
    res.redirect(`/?subscribed=${encodeURIComponent(subId)}`);
  } catch (e) {
    console.error(e);
    res.redirect('/?error=subscription_failed');
  }
});
app.get('/subscription/cancel', (req, res) => res.redirect('/?cancelled=1'));

app.get('/api/orders/:id', (req, res) => {
  const rec = orders.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ id: req.params.id, ...rec });
});

app.post('/api/agent', async (req, res) => {
  try {
    const session = sessionOf(req);
    const out = await runAgent(session, req.body?.message || '');
    if (!out.engine) out.engine = 'deterministic';
    try { saveCart(session); } catch { /* cart may be empty/cleared */ }
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ reply: `Something went wrong on my side: ${e.message}` });
  }
});

// Backfill: captured orders from before payables existed still get rows.
// Runs here (not at the top) because it needs SUPPLIER_TERMS, a const
// initialized further down the file.
for (const [orderId, rec] of orders) {
  if (rec.status === 'COMPLETED') createPayablesForOrder(orderId);
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AgentMart running at ${BASE_URL} (PayPal env: ${PAYPAL_ENV}, configured: ${paypalConfigured}, LLM: ${llmConfigured ? LLM_MODEL : 'deterministic fallback'})`);
  });
}
module.exports = { app, searchProducts, cartView, runAgent, llmConfigured, paypalConfigured, inventoryView, smartRestockPlan, findSubstitute, addToCartWithSubstitute, bestSupplier, priceTrend, expectedDeliveryDate, cartAdd, payablesForOrder, supplierTerms, forecastView, nextRunDate, createPlan, wasteSummary, spoilExcess, savingsSummary, llmTools: LLM_TOOLS, subscriptionView, createSubscription, refreshSubscription };
