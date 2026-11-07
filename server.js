'use strict';
/*
 * AgentMart - agentic commerce for café restocking, built for the PayPal AI
 * Hackathon. Niche: a small café restocks coffee, tea and gear by talking to
 * an AI agent instead of re-ordering by hand — the agent builds the restock
 * cart inside a budget and takes it to a real PayPal checkout.
 *
 * The demo café is a real brand: Blue Bottle Coffee (Hayes Valley,
 * San Francisco, CA). Item prices are Blue Bottle's published retail
 * prices, verified 2026-11-05 from the brand's public menus (DoorDash
 * merchant menus and bluebottlecoffee.com — see README "Demo data sources").
 * Supplier names, payment terms, alternate-supplier prices and the 3-month
 * price history are illustrative demo data, labeled as such. Stock levels,
 * daily usage and reorder points are demo figures for the video, not the
 * café's real numbers.
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
 * LLM chain (see .env.example): primary Fireworks Muse Spark Open, fallback
 * (env-configured, e.g. Baseten), fallback2 (env-configured, intended for
 * Modal), then the deterministic intent engine. Meta muse-spark-1.3 can be
 * swapped in as primary via LLM_BASE_URL/LLM_MODEL. The Baseten model
 * version the chain used to start on was deactivated by the provider on
 * 2026-11-07, so the code default primary is Fireworks now.
 * Live test 2026-11-05: Baseten and Fireworks both answer and emit tool
 * calls, but both wander in a multi-step loop (Baseten: five rounds, one
 * item added, no checkout; Fireworks: five rounds, two items added,
 * $50 cart, no checkout). The agent loop therefore allows 8 rounds and
 * the system prompt caps searching at two calls before adding items.
 * Config: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=sandbox|live,
 * BASE_URL, PORT, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL,
 * LLM_FALLBACK_API_KEY, LLM_FALLBACK_BASE_URL, LLM_FALLBACK_MODEL,
 * LLM_FALLBACK2_API_KEY, LLM_FALLBACK2_BASE_URL, LLM_FALLBACK2_MODEL.
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

// LLM chain (v12): primary Fireworks Muse Spark Open, then an env-configured
// fallback tier, then a second env-configured fallback tier (intended for
// Modal), then the deterministic engine. The provider name is derived from
// the base URL so the engine label in replies stays accurate under any
// override. The old default primary (Baseten) died when the provider
// deactivated that model version on 2026-11-07.
// Meta muse-spark-1.3 can be swapped in as primary via LLM_BASE_URL/LLM_MODEL.
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'accounts/fireworks/models/muse-spark-open';
const LLM_FALLBACK_API_KEY = process.env.LLM_FALLBACK_API_KEY || '';
const LLM_FALLBACK_BASE_URL = (process.env.LLM_FALLBACK_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/$/, '');
const LLM_FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL || 'accounts/fireworks/models/muse-spark-open';
const LLM_FALLBACK2_API_KEY = process.env.LLM_FALLBACK2_API_KEY || '';
const LLM_FALLBACK2_BASE_URL = (process.env.LLM_FALLBACK2_BASE_URL || '').replace(/\/$/, '');
const LLM_FALLBACK2_MODEL = process.env.LLM_FALLBACK2_MODEL || '';
// Provider name from the base URL (not hardcoded per slot): a slot keeps its
// label when the URL is overridden, e.g. LLM_BASE_URL pointed at Baseten
// still reports llm:baseten. Unknown hosts fall back to their hostname.
function providerNameFor(baseUrl, fallback) {
  const u = String(baseUrl || '').toLowerCase();
  if (u.includes('fireworks')) return 'fireworks';
  if (u.includes('baseten')) return 'baseten';
  if (u.includes('modal')) return 'modal';
  if (u.includes('meta')) return 'meta';
  try { return new URL(baseUrl).hostname.split('.')[0] || fallback; } catch { return fallback; }
}
const llmProviders = [
  ...(LLM_API_KEY ? [{ name: providerNameFor(LLM_BASE_URL, 'primary'), baseUrl: LLM_BASE_URL, model: LLM_MODEL, apiKey: LLM_API_KEY }] : []),
  ...(LLM_FALLBACK_API_KEY ? [{ name: providerNameFor(LLM_FALLBACK_BASE_URL, 'fallback'), baseUrl: LLM_FALLBACK_BASE_URL, model: LLM_FALLBACK_MODEL, apiKey: LLM_FALLBACK_API_KEY }] : []),
  // Fallback2 has no default URL/model on purpose: it only activates when
  // the deployer sets all three (key + base URL + model), e.g. a Modal
  // endpoint. A key alone with no URL would call the wrong host.
  ...(LLM_FALLBACK2_API_KEY && LLM_FALLBACK2_BASE_URL ? [{ name: providerNameFor(LLM_FALLBACK2_BASE_URL, 'fallback2'), baseUrl: LLM_FALLBACK2_BASE_URL, model: LLM_FALLBACK2_MODEL || 'muse-spark-open', apiKey: LLM_FALLBACK2_API_KEY }] : []),
];
const llmConfigured = llmProviders.length > 0;

/* ------------------------------------------------------------------ catalog */
// The demo café: Blue Bottle Coffee, Hayes Valley, San Francisco, CA.
// Item prices are Blue Bottle's published retail prices, verified
// 2026-11-05 (see README "Demo data sources"): bean bags and Craft Matcha
// from the brand's DoorDash merchant menus (identical across SF, DC, San
// Diego, Chicago, LA and Palo Alto listings), the Dripper from
// bluebottlecoffee.com, the Cold Brew bottle from NYC grocery menus, the
// Acaia Pearl Scale from acaia.co, and Oatly Barista — Blue Bottle's
// default milk — from FreshDirect (US). The two bean bags are the demo's
// mapping of Blue Bottle's published Blend / Single Origin bags to the
// arabica / robusta varieties the substitute story needs. Stock, dailyUse,
// reorderPoint, leadTimeDays, shelfLifeDays and maxStock are demo figures
// for the video, not the café's real numbers. Suppliers, terms and
// alternate-supplier prices are illustrative demo data.
const CAFE = { name: 'Blue Bottle Coffee', location: 'Hayes Valley, San Francisco, CA', priceSource: 'Blue Bottle public menus (DoorDash merchant menus, bluebottlecoffee.com), verified 2026-11-05' };
const PRODUCTS = [
  { id: 'arabica-beans',   name: 'Blue Bottle Blend Beans · Arabica 12 oz', price: 25.50, emoji: '☕', tag: 'coffee', blurb: 'Blue Bottle’s signature blend of arabica beans, medium roast, whole bean.', stock: 4,    dailyUse: 0.5,  reorderPoint: 2, leadTimeDays: 3, shelfLifeDays: 90,  maxStock: 8,  supplier: 'Highland Roasters', altSupplier: { name: 'Andean Direct', price: 24.50, leadTimeDays: 4 } },
  { id: 'robusta-beans',   name: 'Blue Bottle Single Origin Beans · Robusta 12 oz', price: 31.00, emoji: '☕', tag: 'coffee', blurb: 'A bold single-origin robusta, chocolatey and full-bodied — the espresso blend backbone.', stock: 6,    dailyUse: 0.4,  reorderPoint: 2, leadTimeDays: 3, shelfLifeDays: 90,  maxStock: 10, supplier: 'Highland Roasters', altSupplier: { name: 'Andean Direct', price: 29.50, leadTimeDays: 4 } },
  { id: 'pourover-set',    name: 'Blue Bottle Dripper',       price: 28.00, emoji: '🍶', tag: 'gear',   blurb: 'Blue Bottle’s own pour-over dripper, engineered for a slow, even extraction.', stock: 3,    dailyUse: 0.1,  reorderPoint: 1, leadTimeDays: 5, shelfLifeDays: null, maxStock: null, supplier: 'Brew Gear Co.', altSupplier: { name: 'Kitchen Supply Hub', price: 26.00, leadTimeDays: 6 } },
  { id: 'coldbrew-bottle', name: 'Blue Bottle Bright Cold Brew · 8 oz', price: 5.79, emoji: '🧊', tag: 'gear',   blurb: 'Ready-to-drink bright cold brew, bottled for the grab-and-go shelf.', stock: 2,    dailyUse: 0.15, reorderPoint: 1, leadTimeDays: 5, shelfLifeDays: null, maxStock: null, supplier: 'Brew Gear Co.', altSupplier: { name: 'Kitchen Supply Hub', price: 6.25, leadTimeDays: 5 } },
  { id: 'matcha',          name: 'Blue Bottle Craft Matcha · 100 g', price: 40.50, emoji: '🍵', tag: 'tea',    blurb: 'Ceremonial-grade matcha from Uji, Japan — stone-ground, 15 servings per jar.', stock: 1,    dailyUse: 0.3,  reorderPoint: 1, leadTimeDays: 4, shelfLifeDays: 60,  maxStock: 3,  supplier: 'Kyoto Tea Imports', altSupplier: { name: 'Uji Tea Trading', price: 42.00, leadTimeDays: 5 } },
  { id: 'instant-coffee',  name: 'Blue Bottle Craft Instant Coffee', price: 3.50, emoji: '⚡', tag: 'pantry', blurb: 'Single-origin instant coffee — just add hot water, no brewer needed.', stock: 5,    dailyUse: 0.25, reorderPoint: 2, leadTimeDays: 3, shelfLifeDays: 180, maxStock: 8,  supplier: 'Pantry Wholesale', altSupplier: { name: 'Sweet Source Co.', price: 3.25, leadTimeDays: 4 } },
  { id: 'oat-milk',        name: 'Oatly Barista Oat Milk · 32 oz', price: 6.39, emoji: '🥛', tag: 'pantry', blurb: 'Barista-edition oat milk — Blue Bottle’s default milk, steams and froths cleanly.', stock: 8,    dailyUse: 1.2,  reorderPoint: 3, leadTimeDays: 2, shelfLifeDays: 14,  maxStock: 12, supplier: 'Dairy & Pantry Co.', altSupplier: { name: 'Green Valley Farms', price: 5.99, leadTimeDays: 3 } },
  { id: 'barista-scale',   name: 'Acaia Pearl Scale',       price: 150.00, emoji: '⚖️', tag: 'gear',   blurb: '0.1g precision, timer built in, USB-C rechargeable — the scale on the brew bar.', stock: 2,    dailyUse: 0.05, reorderPoint: 1, leadTimeDays: 5, shelfLifeDays: null, maxStock: null, supplier: 'Brew Gear Co.', altSupplier: { name: 'Kitchen Supply Hub', price: 155.00, leadTimeDays: 5 } },
];
// Demo price history: the CURRENT price of each item is the verified
// Blue Bottle public price (see above); the Aug–Oct 2026 points are an
// illustrative demo series built around it, not real supplier quotes —
// they exist so the creep/drop alerts have something to flag.
const PRICE_HISTORY_SEED = {
  'arabica-beans':   [['2026-08-05', 23.40], ['2026-09-05', 24.25], ['2026-10-05', 25.00]],
  'robusta-beans':   [['2026-08-05', 28.50], ['2026-09-05', 29.50], ['2026-10-05', 30.50]],
  'pourover-set':    [['2026-08-05', 28.00], ['2026-09-05', 28.00], ['2026-10-05', 28.00]],
  'coldbrew-bottle': [['2026-08-05', 6.49], ['2026-09-05', 6.19], ['2026-10-05', 5.99]],
  'matcha':          [['2026-08-05', 36.50], ['2026-09-05', 38.25], ['2026-10-05', 39.50]],
  'instant-coffee':  [['2026-08-05', 3.95], ['2026-09-05', 3.75], ['2026-10-05', 3.60]],
  'oat-milk':        [['2026-08-05', 5.99], ['2026-09-05', 6.19], ['2026-10-05', 6.29]],
  'barista-scale':   [['2026-08-05', 150.00], ['2026-09-05', 150.00], ['2026-10-05', 150.00]],
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
CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, orderId TEXT, invoiceId TEXT NOT NULL, status TEXT NOT NULL, recipient TEXT, total REAL NOT NULL, createdAt TEXT NOT NULL, invoiceUrl TEXT, dueDate TEXT, lastRemindedAt TEXT);
CREATE TABLE IF NOT EXISTS inventory (productId TEXT PRIMARY KEY, stock REAL NOT NULL);
CREATE TABLE IF NOT EXISTS price_history (productId TEXT NOT NULL, price REAL NOT NULL, recordedAt TEXT NOT NULL, source TEXT NOT NULL, UNIQUE(productId, recordedAt));
CREATE TABLE IF NOT EXISTS payables (id TEXT PRIMARY KEY, orderId TEXT NOT NULL, supplier TEXT NOT NULL, amount REAL NOT NULL, dueDate TEXT NOT NULL, terms TEXT NOT NULL, status TEXT NOT NULL, cafeName TEXT);
CREATE TABLE IF NOT EXISTS restock_plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, dayOfWeek INTEGER NOT NULL, budget REAL NOT NULL, active INTEGER NOT NULL, lastRunAt TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS waste (id INTEGER PRIMARY KEY AUTOINCREMENT, productId TEXT NOT NULL, qty REAL NOT NULL, cost REAL NOT NULL, wastedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscription_plans (amount REAL PRIMARY KEY, planId TEXT NOT NULL, productId TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, planId TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL, boxItems TEXT NOT NULL, createdAt TEXT NOT NULL, lastFulfilledAt TEXT, nextBillingDate TEXT);
CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, eventType TEXT NOT NULL, resourceId TEXT, receivedAt TEXT NOT NULL, handled INTEGER NOT NULL, summary TEXT);
CREATE TABLE IF NOT EXISTS buying_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, focus TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS group_members (groupId TEXT NOT NULL, cafeName TEXT NOT NULL, joinedAt TEXT NOT NULL, PRIMARY KEY(groupId, cafeName));
CREATE TABLE IF NOT EXISTS group_intents (groupId TEXT NOT NULL, cafeName TEXT NOT NULL, itemId TEXT NOT NULL, qty INTEGER NOT NULL, PRIMARY KEY(groupId, cafeName, itemId));
CREATE TABLE IF NOT EXISTS group_orders (id TEXT PRIMARY KEY, groupId TEXT NOT NULL, itemId TEXT NOT NULL, pooledQty INTEGER NOT NULL, tier INTEGER NOT NULL, unitPrice REAL NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL);`);
// Orders gained columns in v3/v4; add them to older databases.
for (const col of ['expectedDelivery TEXT', 'saved REAL', 'preventedStockouts INTEGER']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* already there */ }
}
// Invoices gained columns in v10 (due date + last reminder); same pattern.
for (const col of ['dueDate TEXT', 'lastRemindedAt TEXT']) {
  try { db.exec(`ALTER TABLE invoices ADD COLUMN ${col}`); } catch { /* already there */ }
}
// Payables gained a café column in v11 (group-buying shares are owed per café).
try { db.exec('ALTER TABLE payables ADD COLUMN cafeName TEXT'); } catch { /* already there */ }

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
  db.prepare('INSERT INTO invoices (id, orderId, invoiceId, status, recipient, total, createdAt, invoiceUrl, dueDate, lastRemindedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, invoiceUrl=excluded.invoiceUrl, dueDate=excluded.dueDate, lastRemindedAt=excluded.lastRemindedAt').run(id, rec.orderId, rec.invoiceId, rec.status, rec.recipient || '', rec.total, rec.createdAt, rec.invoiceUrl || '', rec.dueDate || null, rec.lastRemindedAt || null);
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
  invoices.set(row.id, { orderId: row.orderId, invoiceId: row.invoiceId, status: row.status, recipient: row.recipient, total: row.total, createdAt: row.createdAt, invoiceUrl: row.invoiceUrl, dueDate: row.dueDate || null, lastRemindedAt: row.lastRemindedAt || null });
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
  db.prepare('INSERT OR IGNORE INTO payables (id, orderId, supplier, amount, dueDate, terms, status, cafeName) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.orderId, row.supplier, row.amount, row.dueDate, row.terms, row.status, row.cafeName || null);
}
for (const row of db.prepare('SELECT * FROM payables').all()) {
  payables.set(row.id, { orderId: row.orderId, supplier: row.supplier, amount: row.amount, dueDate: row.dueDate, terms: row.terms, status: row.status, ...(row.cafeName ? { cafeName: row.cafeName } : {}) });
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
// Upsert (not INSERT OR IGNORE): the seed is authoritative for this table,
// so re-seeding after a catalog price change updates the stored history
// instead of keeping stale prices from an older seed.
for (const [pid, points] of Object.entries(PRICE_HISTORY_SEED)) {
  for (const [date, price] of points) {
    db.prepare('INSERT INTO price_history (productId, price, recordedAt, source) VALUES (?, ?, ?, ?) ON CONFLICT(productId, recordedAt) DO UPDATE SET price=excluded.price, source=excluded.source').run(pid, price, date, 'demo-seed');
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
    // v10: a price DROP of more than 5% in 3 months — the mirror of creep.
    // A falling supplier price is a buying opportunity: smart restock
    // already buys at the current lower price, and the dashboard flags it.
    drop: pct(oldest) < -5,
    history: [...rows.map((r) => ({ date: r.recordedAt, price: r.price })), { date: '2026-11-05', price: current }],
  };
}
// v12 price-drop auto-buy: tracked items whose price fell 10% or more in
// the last 3 months are worth stocking up on while they are cheap. Each
// deal tops the item up toward maxStock (at most 2 extra units), cheapest
// first is NOT assumed — catalog order is kept — and the list never exceeds
// the budget: an item that would break the budget is skipped, not partial.
// Out-of-stock and already-full items are skipped too.
function priceDropDeals(budget) {
  const deals = [];
  let remaining = Number(budget || 0);
  for (const p of PRODUCTS) {
    const t = priceTrend(p);
    if (!t || !t.drop || t.changePct3mo > -10) continue;
    if (p.stock <= 0) continue;
    const headroom = p.maxStock ? p.maxStock - p.stock : 2;
    if (headroom <= 0) continue;
    const qty = Math.min(headroom, 2);
    const cost = Math.round(p.price * qty * 100) / 100;
    if (cost > remaining) continue;
    remaining = Math.round((remaining - cost) * 100) / 100;
    deals.push({ productId: p.id, name: p.name, emoji: p.emoji, price: p.price, qty, cost, changePct3mo: t.changePct3mo, supplier: p.supplier, leadTimeDays: p.leadTimeDays });
  }
  return { deals, totalCost: Math.round(deals.reduce((s, d) => s + d.cost, 0) * 100) / 100 };
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
  // UTC throughout: getDate()/toISOString() mix local and UTC days, so a
  // late-UTC evening shows yesterday's date (and the wrong weekday).
  d.setUTCDate(d.getUTCDate() + maxLead);
  return d.toISOString().slice(0, 10);
}
// Forecast: projected stock-out date and the date to order by, per item.
// 14-day view: anything that runs out later is "beyond the forecast".
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function nextRunDate(dayOfWeek, from = new Date()) {
  const d = new Date(from);
  // UTC throughout (see expectedDeliveryDate): local getDay() with a UTC
  // slice put a Monday plan's next run on a Sunday late in the UTC day.
  d.setUTCDate(d.getUTCDate() + ((dayOfWeek - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}
function forecastView() {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  return inventoryView().map((r) => {
    if (!isFinite(r.daysLeft)) return { ...r, stockoutDate: null, orderByDate: null, orderNow: false };
    const stockout = new Date(today);
    stockout.setUTCDate(stockout.getUTCDate() + Math.floor(r.daysLeft));
    const orderBy = new Date(stockout);
    orderBy.setUTCDate(orderBy.getUTCDate() - r.leadTimeDays);
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
// v12 ROI panel: the same ledger, scaled the way a café owner reads it —
// average saving per captured weekly box, times 52 weeks for the year, plus
// what one pooled group order saves and how many stock-outs were prevented.
// All live data, no PayPal calls, no estimates beyond the ×52 scaling.
function roiSummary() {
  const s = savingsSummary();
  const weeklySaving = s.capturedOrders ? Math.round((s.totalSaved / s.capturedOrders) * 100) / 100 : 0;
  const deals = groupDeals();
  const groupSavingPerOrder = Math.round(deals.reduce((sum, d) => sum + d.savings, 0) * 100) / 100;
  return {
    capturedOrders: s.capturedOrders,
    totalSaved: s.totalSaved,
    weeklySaving,
    yearlySavingPerCafe: Math.round(weeklySaving * 52 * 100) / 100,
    groupSavingPerOrder,
    groupDeals: deals.map((d) => ({ itemName: d.itemName, pooledQty: d.pooledQty, tier: d.tier, discountPct: d.discountPct, unitPrice: d.unitPrice, soloPrice: d.soloPrice, savings: d.savings })),
    stockoutsPrevented: s.preventedStockouts,
  };
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

/* ------------------------------------------- group buying (v11) */
// Several cafés pool one order to unlock a wholesale tier price from the
// supplier. Tiers are per item, on the pooled quantity across all member
// cafés — the discount applies to the best-supplier price the café would
// pay solo, so the saving is real money vs ordering alone.
//   Tier 0: pooled < 10  → no discount
//   Tier 1: pooled 10–24 → 5% off
//   Tier 2: pooled >= 25 → 10% off
const GROUP_TIERS = [
  { tier: 0, minQty: 0, discountPct: 0 },
  { tier: 1, minQty: 10, discountPct: 5 },
  { tier: 2, minQty: 25, discountPct: 10 },
];
const OUR_CAFE = 'Blue Bottle Coffee — Hayes Valley';
function groupTier(pooledQty) {
  let found = GROUP_TIERS[0];
  for (const t of GROUP_TIERS) if (pooledQty >= t.minQty) found = t;
  return found;
}
function groupUnitPrice(product, pooledQty) {
  const base = bestSupplier(product).price;
  const { discountPct } = groupTier(pooledQty);
  return Math.round(base * (1 - discountPct / 100) * 100) / 100;
}

const buyingGroups = new Map(); // groupId -> { name, city, focus, createdAt }
const groupMembers = new Map(); // groupId -> Map(cafeName -> joinedAt)
const groupIntents = new Map(); // groupId -> Map(`${cafeName}|${itemId}` -> qty)
const groupOrders = new Map(); // paypalOrderId -> { groupId, itemId, pooledQty, tier, unitPrice, status, createdAt }
function saveGroup(id, rec) {
  db.prepare('INSERT INTO buying_groups (id, name, city, focus, createdAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, city=excluded.city, focus=excluded.focus').run(id, rec.name, rec.city, rec.focus, rec.createdAt);
}
function saveGroupMember(groupId, cafeName, joinedAt) {
  db.prepare('INSERT OR IGNORE INTO group_members (groupId, cafeName, joinedAt) VALUES (?, ?, ?)').run(groupId, cafeName, joinedAt);
}
function saveGroupIntent(groupId, cafeName, itemId, qty) {
  db.prepare('INSERT INTO group_intents (groupId, cafeName, itemId, qty) VALUES (?, ?, ?, ?) ON CONFLICT(groupId, cafeName, itemId) DO UPDATE SET qty=excluded.qty').run(groupId, cafeName, itemId, qty);
}
function saveGroupOrder(id, rec) {
  db.prepare('INSERT INTO group_orders (id, groupId, itemId, pooledQty, tier, unitPrice, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status').run(id, rec.groupId, rec.itemId, rec.pooledQty, rec.tier, rec.unitPrice, rec.status, rec.createdAt);
}
for (const row of db.prepare('SELECT * FROM buying_groups').all()) {
  buyingGroups.set(row.id, { name: row.name, city: row.city, focus: row.focus, createdAt: row.createdAt });
}
for (const row of db.prepare('SELECT * FROM group_members').all()) {
  if (!groupMembers.has(row.groupId)) groupMembers.set(row.groupId, new Map());
  groupMembers.get(row.groupId).set(row.cafeName, row.joinedAt);
}
for (const row of db.prepare('SELECT * FROM group_intents').all()) {
  if (!groupIntents.has(row.groupId)) groupIntents.set(row.groupId, new Map());
  groupIntents.get(row.groupId).set(`${row.cafeName}|${row.itemId}`, row.qty);
}
for (const row of db.prepare('SELECT * FROM group_orders').all()) {
  groupOrders.set(row.id, { groupId: row.groupId, itemId: row.itemId, pooledQty: row.pooledQty, tier: row.tier, unitPrice: row.unitPrice, status: row.status, createdAt: row.createdAt });
}
// Demo seed group (v11): our café pools matcha and oat milk with two
// other Bay Area specialty cafés. The other members are DEMO members —
// real brand names used illustratively, not real participants (see README).
// Their intents are what make the pooled tiers visible in the demo.
const SEED_GROUP = {
  id: 'grp-bay-area',
  name: 'Bay Area Specialty Cafés',
  city: 'San Francisco Bay Area',
  focus: 'coffee beans & matcha',
  members: [
    { cafe: OUR_CAFE, intents: [{ itemId: 'matcha', qty: 6 }, { itemId: 'oat-milk', qty: 8 }] },
    { cafe: 'Philz Coffee — Mission', intents: [{ itemId: 'matcha', qty: 10 }, { itemId: 'oat-milk', qty: 7 }] },
    { cafe: 'Sightglass Coffee — SoMa', intents: [{ itemId: 'matcha', qty: 9 }, { itemId: 'oat-milk', qty: 5 }] },
  ],
};
function seedGroupMembers() {
  // (Re)create the seed group's members + intents from scratch — used at
  // startup and by the demo reset, so the group deals always come back.
  groupMembers.set(SEED_GROUP.id, new Map());
  groupIntents.set(SEED_GROUP.id, new Map());
  db.prepare('DELETE FROM group_members WHERE groupId=?').run(SEED_GROUP.id);
  db.prepare('DELETE FROM group_intents WHERE groupId=?').run(SEED_GROUP.id);
  const createdAt = new Date().toISOString();
  for (const m of SEED_GROUP.members) {
    groupMembers.get(SEED_GROUP.id).set(m.cafe, createdAt);
    saveGroupMember(SEED_GROUP.id, m.cafe, createdAt);
    for (const it of m.intents) {
      groupIntents.get(SEED_GROUP.id).set(`${m.cafe}|${it.itemId}`, it.qty);
      saveGroupIntent(SEED_GROUP.id, m.cafe, it.itemId, it.qty);
    }
  }
}
function seedBuyingGroups() {
  if (buyingGroups.has(SEED_GROUP.id)) return;
  const createdAt = new Date().toISOString();
  buyingGroups.set(SEED_GROUP.id, { name: SEED_GROUP.name, city: SEED_GROUP.city, focus: SEED_GROUP.focus, createdAt });
  saveGroup(SEED_GROUP.id, buyingGroups.get(SEED_GROUP.id));
  seedGroupMembers();
}
seedBuyingGroups();

// Flat deal rows for the dashboard grid + the agent: one row per
// (group, item) with pooled quantity, tier, unit price, solo price,
// saving vs ordering alone, members, and the latest group-order status.
function groupDeals() {
  const rows = [];
  for (const [groupId, g] of buyingGroups) {
    const members = [...(groupMembers.get(groupId) || new Map()).keys()];
    const intents = groupIntents.get(groupId) || new Map();
    const byItem = new Map();
    for (const [key, qty] of intents) {
      const itemId = key.split('|').slice(1).join('|');
      const cafe = key.slice(0, key.length - itemId.length - 1);
      if (!byItem.has(itemId)) byItem.set(itemId, []);
      byItem.get(itemId).push({ cafe, qty });
    }
    for (const [itemId, shares] of byItem) {
      const p = productById(itemId);
      if (!p) continue;
      const pooledQty = shares.reduce((s, x) => s + x.qty, 0);
      const soloPrice = bestSupplier(p).price;
      const { tier, discountPct } = groupTier(pooledQty);
      const unitPrice = groupUnitPrice(p, pooledQty);
      const latest = [...groupOrders.values()]
        .filter((o) => o.groupId === groupId && o.itemId === itemId)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
      rows.push({
        groupId, groupName: g.name, city: g.city, focus: g.focus,
        itemId, itemName: p.name, emoji: p.emoji,
        pooledQty, tier, discountPct, unitPrice, soloPrice,
        savings: Math.round((soloPrice - unitPrice) * pooledQty * 100) / 100,
        members, memberCount: members.length,
        shares: shares.map((s) => ({ cafe: s.cafe, qty: s.qty, amount: Math.round(s.qty * unitPrice * 100) / 100 })),
        orderStatus: latest ? latest.status : 'OPEN',
        orderId: latest ? [...groupOrders.entries()].find(([, o]) => o === latest)?.[0] || null : null,
      });
    }
  }
  return rows.sort((a, b) => b.savings - a.savings);
}
function createBuyingGroup({ name, city, focus, items }) {
  const id = `grp-${Date.now().toString(36)}`;
  const rec = { name: name.slice(0, 80), city: (city || CAFE.location).slice(0, 80), focus: (focus || 'coffee & tea').slice(0, 80), createdAt: new Date().toISOString() };
  buyingGroups.set(id, rec);
  saveGroup(id, rec);
  groupMembers.set(id, new Map([[OUR_CAFE, rec.createdAt]]));
  saveGroupMember(id, OUR_CAFE, rec.createdAt);
  groupIntents.set(id, new Map());
  if (items) for (const it of items) addGroupIntent(id, OUR_CAFE, it.itemId, it.qty);
  return { id, ...rec, members: [OUR_CAFE] };
}
function addGroupIntent(groupId, cafeName, itemId, qty) {
  const p = productById(itemId);
  const q = Math.max(1, Math.min(999, Math.round(Number(qty || 0))));
  if (!p || !(q > 0)) return false;
  if (!groupIntents.has(groupId)) groupIntents.set(groupId, new Map());
  groupIntents.get(groupId).set(`${cafeName}|${itemId}`, q);
  saveGroupIntent(groupId, cafeName, itemId, q);
  return true;
}
function joinBuyingGroup(groupId, cafeName, items) {
  if (!buyingGroups.has(groupId)) throw new Error('NOT_FOUND');
  const name = String(cafeName || '').trim().slice(0, 80);
  if (!name) throw new Error('INVALID_INPUT');
  const joinedAt = new Date().toISOString();
  if (!groupMembers.has(groupId)) groupMembers.set(groupId, new Map());
  groupMembers.get(groupId).set(name, joinedAt);
  saveGroupMember(groupId, name, joinedAt);
  if (items) for (const it of items) addGroupIntent(groupId, name, it.itemId, it.qty);
  return { groupId, cafeName: name, members: [...groupMembers.get(groupId).keys()] };
}
async function createGroupPayPalOrder(groupId, itemId) {
  if (!buyingGroups.has(groupId)) throw new Error('NOT_FOUND');
  const deal = groupDeals().find((d) => d.groupId === groupId && d.itemId === itemId);
  if (!deal || deal.pooledQty < 1) throw new Error('NO_POOLED_QTY');
  if (!paypalConfigured) throw new Error('PAYPAL_NOT_CONFIGURED');
  const p = productById(itemId);
  const best = bestSupplier(p);
  const token = await paypalAccessToken();
  const total = (deal.unitPrice * deal.pooledQty).toFixed(2);
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: `agentmart-group-${groupId}`,
      description: `AgentMart group order — ${deal.pooledQty}× ${p.name} at the Tier ${deal.tier} group price (${deal.memberCount} cafés)`,
      amount: { currency_code: 'USD', value: total, breakdown: { item_total: { currency_code: 'USD', value: total } } },
      items: [{ name: p.name.slice(0, 127), unit_amount: { currency_code: 'USD', value: deal.unitPrice.toFixed(2) }, quantity: String(deal.pooledQty) }],
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
  if (!res.ok) throw new Error(`PayPal create group order failed (${res.status}): ${await res.text()}`);
  const order = await res.json();
  const approveUrl = (order.links || []).find((l) => l.rel === 'approve')?.href;
  const rec = { groupId, itemId, pooledQty: deal.pooledQty, tier: deal.tier, unitPrice: deal.unitPrice, status: 'CREATED', createdAt: new Date().toISOString(), expectedDelivery: expectedDeliveryDate([{ leadTimeDays: best.leadTimeDays }]) };
  groupOrders.set(order.id, rec);
  saveGroupOrder(order.id, rec);
  // Spread the deal FIRST: it carries orderId: null / orderStatus: 'OPEN'
  // from before the order existed, and must not overwrite the real id.
  return { ...deal, orderId: order.id, approveUrl, expectedDelivery: rec.expectedDelivery, total: Number(total) };
}
// A captured group order means: the pooled delivery arrived. Each member
// café owes its own share to the supplier (payables per café), and OUR
// café's share goes onto our shelf. Idempotent — a second call is a no-op.
function completeGroupOrder(paypalOrderId) {
  const rec = groupOrders.get(paypalOrderId);
  if (!rec || rec.status === 'COMPLETED') return null;
  const p = productById(rec.itemId);
  if (!p) return null;
  rec.status = 'COMPLETED';
  saveGroupOrder(paypalOrderId, rec);
  const deal = groupDeals().find((d) => d.groupId === rec.groupId && d.itemId === rec.itemId);
  const shares = deal ? deal.shares : [];
  const supplier = bestSupplier(p).name;
  const base = rec.expectedDelivery || new Date().toISOString().slice(0, 10);
  const t = supplierTerms(supplier);
  const created = [];
  for (const s of shares) {
    const row = { id: `pay-${paypalOrderId}-${s.cafe.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, orderId: paypalOrderId, supplier, amount: Math.round(s.qty * rec.unitPrice * 100) / 100, dueDate: addDays(base, t.days), terms: t.terms, status: 'UNPAID', cafeName: s.cafe };
    if (!payables.has(row.id)) {
      payables.set(row.id, row);
      savePayable(row);
      created.push(row);
    }
  }
  const ourShare = shares.find((s) => s.cafe === OUR_CAFE);
  if (ourShare) {
    inventory.set(p.id, (inventory.get(p.id) ?? p.stock) + ourShare.qty);
    saveStock(p.id);
  }
  return { groupOrder: rec, payables: created, ourShareQty: ourShare?.qty || 0 };
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
        // The supplier is not stored anywhere on PayPal by default, so
        // write it into the item description — the rehydrate reads it
        // back to keep the payable on the right supplier.
        ...(i.supplier ? { description: `Supplied by ${i.supplier}`.slice(0, 127) } : {}),
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
    if (wasCaptured && rec.status === 'COMPLETED') applyOrderDelivery(orderId, rec);
  }
  // v11: a captured GROUP order completes the pooled delivery — payables
  // per member café, and our café's share goes onto our shelf.
  if (data.status === 'COMPLETED') completeGroupOrder(orderId);
  return data;
}

// Shared by capture and by the webhook auto-capture: a completed order
// means the delivery arrived (add stock) and money is owed (payables).
function applyOrderDelivery(orderId, rec) {
  for (const item of rec.items || []) {
    const p = productById(item.id) || PRODUCTS.find((x) => x.name === item.name);
    if (!p) continue;
    inventory.set(p.id, (inventory.get(p.id) ?? p.stock) + item.qty);
    saveStock(p.id);
  }
  // A captured order is money owed: create the payables per supplier.
  createPayablesForOrder(orderId);
}

/* ---------------------------------------------------------- PayPal invoicing */
async function createPayPalInvoice(orderId, recipientEmail) {
  const rec = orders.get(orderId);
  if (!rec) throw new Error('ORDER_NOT_FOUND');
  const token = await paypalAccessToken();
  const createdAt = new Date().toISOString();
  const body = {
    detail: {
      invoice_number: `AM-${orderId.slice(-6)}`,
      reference: `AgentMart order ${orderId}`,
      currency_code: 'USD',
      note: 'AgentMart café restock invoice — created by the merchant from a completed agent order.',
      // v10: NET_30 instead of DUE_ON_RECEIPT, so the invoice has a real
      // 30-day payment term and the overdue check has a due date to work
      // with. PayPal returns no due_date field on the invoice resource,
      // so the server stores dueDate = created + 30 days locally.
      payment_term: { term_type: 'NET_30' },
    },
    // No invoicer object on purpose (v10 probe 2026-11-05): PayPal then
    // defaults the invoicer to the API caller. Sending an explicit
    // invoicer email fails send with 422 USER_NOT_FOUND unless that
    // email is the PayPal account that owns the app — the old hardcoded
    // merchant@agentmart.example meant "Send invoice" never worked.
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
  const stored = { orderId, invoiceId: inv.id, status: inv.status || 'DRAFT', recipient: recipientEmail, total: rec.total, createdAt, invoiceUrl: href, dueDate: addDays(createdAt.slice(0, 10), 30), lastRemindedAt: null };
  invoices.set(localId, stored);
  saveInvoice(localId, stored);
  return stored;
}

// v10: remind the payer about a SENT invoice — POST
// /v2/invoicing/invoices/{invoice_id}/remind with a notification object.
// PayPal answers 204 (no body). Verified on sandbox 2026-11-05: remind on
// a DRAFT invoice fails with 422 CANNOT_REMIND_INVOICE, so callers must
// validate status SENT first (the route and the agent tool both do).
async function remindPayPalInvoice(invoiceId) {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v2/invoicing/invoices/${invoiceId}/remind`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ notification: { subject: `Reminder: Payment due for invoice ${invoiceId}`, note: 'This is a friendly reminder from AgentMart — your café restock invoice is still unpaid. Please pay before the due date.', send_to_recipient: true, send_to_invoicer: false } }),
  });
  if (!res.ok) throw new Error(`PayPal remind invoice failed (${res.status}): ${await res.text()}`);
  for (const [id, rec] of invoices) {
    if (rec.invoiceId === invoiceId) { rec.lastRemindedAt = new Date().toISOString(); saveInvoice(id, rec); }
  }
  return { invoiceId, remindedAt: new Date().toISOString() };
}

// Overdue invoices: SENT invoices whose due date has passed. Pure
// function (testable): list is [{ invoiceId, status, dueDate, ... }].
function overdueInvoices(list, today = new Date().toISOString().slice(0, 10)) {
  return list
    .filter((r) => r.status === 'SENT' && r.dueDate && r.dueDate < today)
    .map((r) => ({ ...r, daysOverdue: Math.floor((new Date(`${today}T00:00:00Z`) - new Date(`${r.dueDate}T00:00:00Z`)) / 86400000) }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
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
  // A revise approved by the buyer moves the subscription to the new plan;
  // sync plan + amount from PayPal so the DB tells the truth after approval.
  if (sub.plan_id && sub.plan_id !== rec.planId) {
    const cached = [...subscriptionPlans.values()].find((p) => p.planId === sub.plan_id);
    let amount = cached ? [...subscriptionPlans.entries()].find(([, p]) => p.planId === sub.plan_id)?.[0] : null;
    if (amount == null) {
      const planRes = await fetch(`${PAYPAL_BASE}/v1/billing/plans/${sub.plan_id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (planRes.ok) {
        const plan = await planRes.json();
        amount = Number(plan.billing_cycles?.[0]?.pricing_scheme?.fixed_price?.value || 0);
      }
    }
    if (amount) {
      rec.planId = sub.plan_id;
      rec.amount = amount;
    }
  }
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

async function reviseSubscription(id, newAmount) {
  const rec = subscriptions.get(id);
  if (!rec) throw new Error('NOT_FOUND');
  if (rec.status !== 'ACTIVE') throw new Error('SUBSCRIPTION_NOT_ACTIVE');
  // Default: re-size the box from today's burn rate with a generous budget so
  // the true current need shows (capped per item by maxStock, as always).
  let target = newAmount;
  let box = null;
  if (typeof target !== 'number' || !(target > 0)) {
    const sized = smartRestockPlan(Math.max(rec.amount * 3, 60));
    if (!sized.plan.length) return { subscriptionId: id, amount: rec.amount, revised: false, message: 'Nothing needs restocking right now — the box stays as it is.' };
    target = sized.total;
    box = sized.plan;
  }
  target = Math.round(target * 100) / 100;
  if (target === rec.amount) return { subscriptionId: id, amount: rec.amount, revised: false, message: `The box already costs ${money(rec.amount)} at today's burn rate — no revise needed.` };
  const oldAmount = rec.amount;
  const planId = await ensureSubscriptionPlan(target);
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions/${id}/revise`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId }),
  });
  if (!res.ok) throw new Error(`PayPal revise subscription failed (${res.status}): ${await res.text()}`);
  const revised = await res.json();
  const approveUrl = (revised.links || []).find((l) => l.rel === 'approve')?.href || '';
  // A price drop applies at once; a price rise waits for the buyer to
  // approve, so the DB keeps the old plan/amount until then (refresh or a
  // webhook syncs it after approval).
  if (!approveUrl) {
    rec.planId = planId;
    rec.amount = target;
    if (box) rec.boxItems = box;
  }
  let status = rec.status;
  try {
    status = (await refreshSubscription(id)).status;
  } catch { /* report the stored status */ }
  saveSubscription(id, rec);
  return { subscriptionId: id, oldAmount, newAmount: approveUrl ? oldAmount : target, proposedAmount: target, revised: true, needsApproval: Boolean(approveUrl), approveUrl, status, box: box || rec.boxItems };
}

/* ---------------------------------------------- PayPal webhooks (v8) */
// PayPal pushes async events here (subscription approved/cancelled, invoice
// paid, order approved). Every event is verified against PayPal before it
// is trusted, then routed: subscriptions sync their status, invoices flip
// to PAID, and an approved order is captured even if the buyer closed the
// tab instead of returning to the store.
function saveWebhookEvent(event, handled, summary) {
  db.prepare('INSERT OR IGNORE INTO webhook_events (id, eventType, resourceId, receivedAt, handled, summary) VALUES (?, ?, ?, ?, ?, ?)').run(
    event.id, event.event_type, event.resource?.id || null, new Date().toISOString(), handled ? 1 : 0, summary || '');
}
function recentWebhookEvents(limit = 50) {
  return db.prepare('SELECT * FROM webhook_events ORDER BY receivedAt DESC LIMIT ?').all(limit);
}

// Pure router: event -> action descriptors. No I/O, unit-tested.
function routeWebhookEvent(event) {
  const type = event.event_type || '';
  const res = event.resource || {};
  if (type.startsWith('BILLING.SUBSCRIPTION.')) {
    const byType = { 'BILLING.SUBSCRIPTION.CREATED': 'APPROVAL_PENDING', 'BILLING.SUBSCRIPTION.ACTIVATED': 'ACTIVE', 'BILLING.SUBSCRIPTION.SUSPENDED': 'SUSPENDED', 'BILLING.SUBSCRIPTION.RE-ACTIVATED': 'ACTIVE', 'BILLING.SUBSCRIPTION.CANCELLED': 'CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED': 'EXPIRED' };
    if (type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
      return { kind: 'subscription-payment-failed', id: res.id, summary: `Subscription ${res.id} payment failed` };
    }
    return { kind: 'subscription', id: res.id, status: res.status || byType[type] || null, nextBillingDate: res.billing_info?.next_billing_time || null, summary: `Subscription ${res.id} → ${res.status || byType[type] || type}` };
  }
  // Invoicing webhook resources nest the invoice under resource.invoice
  // (resource.id is undefined) — read the nested id.
  const invId = res.invoice?.id || res.id;
  if (type === 'INVOICING.INVOICE.PAID') {
    return { kind: 'invoice-paid', invoiceId: invId, summary: `Invoice ${invId} paid` };
  }
  if (type === 'INVOICING.INVOICE.CREATED' || type === 'INVOICING.INVOICE.SENT') {
    return { kind: 'invoice', invoiceId: invId, summary: `Invoice ${invId} ${type === 'INVOICING.INVOICE.SENT' ? 'sent' : 'created'}` };
  }
  if (type === 'CHECKOUT.ORDER.APPROVED') {
    return { kind: 'order-approved', orderId: res.id, summary: `Order ${res.id} approved — auto-capture` };
  }
  if (type === 'CHECKOUT.ORDER.COMPLETED') {
    return { kind: 'order-completed', orderId: res.id, summary: `Order ${res.id} completed` };
  }
  if (type === 'PAYMENT.SALE.COMPLETED') {
    return { kind: 'sale', saleId: res.id, subscriptionId: res.billing_agreement_id || null, summary: `Sale ${res.id} completed${res.billing_agreement_id ? ` (subscription ${res.billing_agreement_id})` : ''}` };
  }
  if (type.startsWith('PAYMENT.CAPTURE.')) {
    const byType = { 'PAYMENT.CAPTURE.COMPLETED': 'completed', 'PAYMENT.CAPTURE.REFUNDED': 'refunded', 'PAYMENT.CAPTURE.DENIED': 'denied' };
    return { kind: 'capture', captureId: res.id, summary: `Capture ${res.id} ${byType[type] || type}` };
  }
  // v12: a billing plan is PayPal-side config for a subscription — there is
  // nothing local to sync, but the event is expected, not unhandled.
  if (type === 'BILLING.PLAN.CREATED') {
    return { kind: 'plan-created', planId: res.id, summary: `Plan ${res.id} created` };
  }
  return { kind: 'unknown', summary: `Unhandled event ${type}` };
}

async function rehydrateSubscription(id) {
  // A webhook for a subscription we lost (e.g. Render redeploy wiped the
  // DB) re-creates the record from PayPal: status + plan amount.
  const token = await paypalAccessToken();
  const subRes = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!subRes.ok) return null;
  const sub = await subRes.json();
  let amount = 0;
  if (sub.plan_id) {
    const planRes = await fetch(`${PAYPAL_BASE}/v1/billing/plans/${sub.plan_id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (planRes.ok) {
      const plan = await planRes.json();
      amount = Number(plan.billing_cycles?.[0]?.pricing_scheme?.fixed_price?.value || 0);
    }
  }
  const rec = { planId: sub.plan_id || '', amount, status: sub.status || 'APPROVAL_PENDING', boxItems: [], createdAt: new Date().toISOString(), lastFulfilledAt: null, nextBillingDate: sub.billing_info?.next_billing_time || null };
  subscriptions.set(id, rec);
  saveSubscription(id, rec);
  return rec;
}

/* ------------------------------------------- v12 boot rehydrate from PayPal */
// After a Render redeploy wipes the local DB, the subscriptions, orders and
// invoices on PayPal still exist. On startup, list the recent PayPal webhook
// events and re-fetch every subscription / order / invoice id they mention,
// so the dashboard shows the PayPal truth again instead of an empty seed
// state. Never blocks or crashes startup: every PayPal call is guarded and
// every failure is logged and counted, never thrown.
async function listPayPalWebhookEvents() {
  const token = await paypalAccessToken();
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400000);
  // PayPal rejects ISO timestamps with milliseconds on this endpoint
  // (400 VALIDATION_ERROR on start_time) — strip the .xxx before sending.
  const ts = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const url = `${PAYPAL_BASE}/v1/notifications/webhooks-events?start_time=${encodeURIComponent(ts(start))}&end_time=${encodeURIComponent(ts(end))}&page_size=20`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`PayPal list webhook events failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return Array.isArray(data.events) ? data.events : [];
}

// Map a PayPal checkout order to the local order record. Items are matched
// back to the catalog by name so supplier / lead time survive the round
// trip; unknown items keep name, price and quantity only.
function paypalOrderToLocal(live) {
  const pu = live.purchase_units?.[0] || {};
  const items = (pu.items || []).map((it) => {
    const p = PRODUCTS.find((x) => x.name === it.name);
    const price = Number(it.unit_amount?.value || 0);
    const qty = Math.max(1, Math.round(Number(it.quantity || 1)));
    if (!p) return { name: it.name, price, qty };
    // Supplier fidelity: PayPal does not store the supplier, so resolve
    // it (1) from the description written at order time ("Supplied by
    // X"), (2) by price — the alt supplier's price differs from the main
    // price, so a paid price equal to the alt price identifies the alt
    // supplier (this recovers pre-fix orders like the v5 chain),
    // (3) fall back to the catalog main supplier.
    let supplier = p.supplier;
    let leadTimeDays = p.leadTimeDays;
    const alt = p.altSupplier || null;
    const known = (name) => {
      if (name === p.supplier) return { name: p.supplier, leadTimeDays: p.leadTimeDays };
      if (alt && name === alt.name) return { name: alt.name, leadTimeDays: alt.leadTimeDays };
      return null;
    };
    const described = (it.description || '').match(/Supplied by (.+?)\s*$/);
    const fromDesc = described && known(described[1].trim());
    if (fromDesc) { supplier = fromDesc.name; leadTimeDays = fromDesc.leadTimeDays; }
    else if (alt && alt.price !== p.price && price === alt.price) { supplier = alt.name; leadTimeDays = alt.leadTimeDays; }
    return { id: p.id, name: p.name, emoji: p.emoji, price, qty, supplier, leadTimeDays };
  });
  const total = Number(pu.amount?.value || items.reduce((s, i) => s + i.price * i.qty, 0));
  const statusMap = { APPROVED: 'CREATED', COMPLETED: 'COMPLETED' };
  // Savings are not stored on PayPal — recompute them the same way order
  // creation does: main catalog price minus the price actually paid.
  const saved = Math.round(items.reduce((s, i) => {
    const p = PRODUCTS.find((x) => x.name === i.name);
    return s + (p ? Math.max(0, p.price - i.price) * i.qty : 0);
  }, 0) * 100) / 100;
  // Stock-outs prevented, same heuristic as at order time: an item that
  // was LOW/OUT when ordered. Seed stock equals pre-delivery stock
  // (rehydrate never re-applies a delivery), so the current status
  // reproduces the order-time status for a rehydrated order.
  const preventedStockouts = items.filter((i) => {
    const p = PRODUCTS.find((x) => x.name === i.name);
    return p && (stockStatus(p) === 'LOW' || stockStatus(p) === 'OUT');
  }).length;
  return {
    sessionId: 'rehydrated',
    items,
    total: Math.round(total * 100) / 100,
    status: statusMap[live.status] || live.status || 'CREATED',
    createdAt: live.create_time || new Date().toISOString(),
    expectedDelivery: expectedDeliveryDate(items.filter((i) => i.leadTimeDays)),
    saved,
    preventedStockouts,
  };
}

async function rehydrateOrder(orderId) {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const live = await res.json();
  const rec = paypalOrderToLocal(live);
  orders.set(orderId, rec);
  saveOrder(orderId, rec);
  // Money owed is a fact of a completed order: recreate the payables
  // (INSERT OR IGNORE, so a second sweep is a no-op). Stock is NOT
  // re-applied — the delivery already happened before the DB wipe, and
  // re-adding it on top of seed stock would double-count.
  if (rec.status === 'COMPLETED') {
    createPayablesForOrder(orderId);
    // The supplier mapping improved since the first rehydrate: drop UNPAID
    // payables for this order whose supplier is no longer in the
    // recomputed set (e.g. the v5 oat-milk payable first landed on the
    // main supplier). A PAID payable is history — never delete it.
    const keep = new Set(payablesForOrder(rec, orderId).map((r) => r.id));
    for (const [pid, row] of [...payables.entries()]) {
      if (row.orderId === orderId && row.status !== 'PAID' && !keep.has(pid)) {
        payables.delete(pid);
        db.prepare('DELETE FROM payables WHERE id=?').run(pid);
      }
    }
  }
  return rec;
}

async function rehydrateInvoice(invoiceId) {
  let inv;
  try {
    inv = await getPayPalInvoice(invoiceId);
  } catch {
    return null;
  }
  const ref = inv.detail?.reference || '';
  const orderId = (ref.match(/AgentMart order (\S+)/) || [])[1] || '';
  const recipient = inv.primary_recipients?.[0]?.billing_info?.email_address || '';
  const total = Number(inv.amount?.value || 0);
  const createdAt = inv.detail?.invoice_date ? `${inv.detail.invoice_date}T00:00:00.000Z` : new Date().toISOString();
  const localId = `inv-${inv.id}`;
  const stored = {
    orderId,
    invoiceId: inv.id,
    status: inv.status || 'DRAFT',
    recipient,
    total,
    createdAt,
    invoiceUrl: (inv.links || []).find((l) => l.rel === 'self')?.href || '',
    // PayPal returns no due_date on the invoice resource, so (as in
    // createPayPalInvoice) the NET_30 due date is created + 30 days.
    dueDate: addDays(createdAt.slice(0, 10), 30),
    lastRemindedAt: null,
  };
  invoices.set(localId, stored);
  saveInvoice(localId, stored);
  return stored;
}

// Route one webhook event's resource into local state. Pure routing over a
// given event list: each id is re-fetched from PayPal best-effort, and any
// failure is recorded in the summary, never thrown.
async function rehydrateFromEvents(events) {
  const summary = { subscriptions: 0, orders: 0, invoices: 0, skipped: 0, errors: [] };
  const seen = new Set();
  for (const event of events || []) {
    const action = routeWebhookEvent(event);
    const id = action.id || action.orderId || action.invoiceId || action.planId || action.subscriptionId || action.captureId || null;
    if (!id || action.kind === 'unknown' || action.kind === 'plan-created') { summary.skipped += 1; continue; }
    const key = `${action.kind}:${id}`;
    if (seen.has(key)) { summary.skipped += 1; continue; }
    seen.add(key);
    try {
      if (action.kind === 'subscription' || action.kind === 'subscription-payment-failed' || action.kind === 'sale') {
        const subId = action.subscriptionId || action.id;
        if (subscriptions.has(subId)) await refreshSubscription(subId);
        else await rehydrateSubscription(subId);
        summary.subscriptions += 1;
      } else if (action.kind === 'order-approved' || action.kind === 'order-completed') {
        if (await rehydrateOrder(action.orderId)) summary.orders += 1;
      } else if (action.kind === 'invoice-paid' || action.kind === 'invoice') {
        if (await rehydrateInvoice(action.invoiceId)) summary.invoices += 1;
      } else if (action.kind === 'capture') {
        // A capture id is not an order id; the order id rides in
        // supplementary_data.related_ids.order_id when PayPal sends it.
        const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
        if (orderId && await rehydrateOrder(orderId)) summary.orders += 1;
        else summary.skipped += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (e) {
      summary.errors.push(`${action.kind}:${id}: ${e.message}`);
    }
  }
  return summary;
}

async function bootRehydrateFromPayPal() {
  if (!paypalConfigured) {
    console.log('boot rehydrate: PayPal not configured, skipping');
    return { skipped: true, reason: 'PAYPAL_NOT_CONFIGURED', events: 0, subscriptions: 0, orders: 0, invoices: 0, errors: [] };
  }
  try {
    const events = await listPayPalWebhookEvents();
    const summary = await rehydrateFromEvents(events);
    console.log(`boot rehydrate: ${events.length} webhook event(s) listed, rehydrated ${summary.subscriptions} subscription(s), ${summary.orders} order(s), ${summary.invoices} invoice(s)${summary.errors.length ? `, ${summary.errors.length} error(s)` : ''}`);
    return { skipped: false, events: events.length, ...summary };
  } catch (e) {
    console.error('boot rehydrate: PayPal unreachable, continuing with local state:', e.message);
    return { skipped: false, events: 0, subscriptions: 0, orders: 0, invoices: 0, errors: [e.message] };
  }
}

async function handleWebhookEvent(event) {
  const action = routeWebhookEvent(event);
  let handled = false;
  try {
    if (action.kind === 'subscription') {
      let rec = subscriptions.get(action.id);
      if (!rec && action.id) rec = await rehydrateSubscription(action.id);
      if (rec) {
        if (action.status) rec.status = action.status;
        if (action.nextBillingDate) rec.nextBillingDate = action.nextBillingDate;
        saveSubscription(action.id, rec);
        handled = true;
      }
    } else if (action.kind === 'subscription-payment-failed') {
      handled = Boolean(subscriptions.get(action.id));
    } else if (action.kind === 'invoice-paid') {
      for (const [localId, rec] of invoices) {
        if (rec.invoiceId === action.invoiceId) {
          rec.status = 'PAID';
          saveInvoice(localId, rec);
          handled = true;
        }
      }
    } else if (action.kind === 'invoice') {
      handled = true; // logged; invoice state is owned by the create/send API flow
    } else if (action.kind === 'order-approved') {
      const rec = orders.get(action.orderId);
      const groupRec = groupOrders.get(action.orderId);
      if (rec && rec.status === 'CREATED') {
        try {
          await capturePayPalOrder(action.orderId);
          handled = true;
        } catch (e) {
          // The buyer may have completed the order through the return URL
          // first; sync the status from PayPal instead of failing.
          try {
            const token = await paypalAccessToken();
            const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${action.orderId}`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) {
              const live = await res.json();
              if (live.status === 'COMPLETED') {
                rec.status = 'COMPLETED';
                saveOrder(action.orderId, rec);
                applyOrderDelivery(action.orderId, rec);
                handled = true;
              }
            }
          } catch { /* leave for the return-URL flow */ }
        }
      } else if (groupRec && groupRec.status === 'CREATED') {
        // v11: same auto-capture for a pooled group order.
        try {
          await capturePayPalOrder(action.orderId);
          handled = true;
        } catch (e) {
          try {
            const token = await paypalAccessToken();
            const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${action.orderId}`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) {
              const live = await res.json();
              if (live.status === 'COMPLETED') {
                completeGroupOrder(action.orderId);
                handled = true;
              }
            }
          } catch { /* leave for the return-URL flow */ }
        }
      }
      if (!handled && ((rec && rec.status === 'COMPLETED') || (groupRec && groupRec.status === 'COMPLETED'))) {
        // The buyer already finished this order through the return URL
        // before the webhook arrived — the state is already synced, so
        // the event is handled, not unhandled.
        handled = true;
      }
    } else if (action.kind === 'order-completed') {
      const rec = orders.get(action.orderId);
      if (rec && rec.status !== 'COMPLETED') {
        rec.status = 'COMPLETED';
        saveOrder(action.orderId, rec);
        applyOrderDelivery(action.orderId, rec);
        handled = true;
      } else if (rec) {
        // Already completed (e.g. via the return URL) — nothing left to sync.
        handled = true;
      }
    } else if (action.kind === 'sale') {
      handled = true; // logged; the subscription/order handlers own the state
    } else if (action.kind === 'capture') {
      handled = true; // logged; the order handlers own the state
    } else if (action.kind === 'plan-created') {
      handled = true; // a billing plan is PayPal-side config; nothing local to sync
    }
  } catch (e) {
    console.error('webhook handler failed:', e.message);
  }
  saveWebhookEvent(event, handled, action.summary);
  return { handled, summary: action.summary };
}

async function verifyPayPalWebhook(req, event) {
  const webhookIdRow = db.prepare('SELECT value FROM meta WHERE key=?').get('paypal_webhook_id');
  let webhookId = webhookIdRow?.value;
  if (!webhookId) {
    // Fall back to listing webhooks and matching our URL (e.g. the webhook
    // was created in the developer dashboard by hand).
    const token = await paypalAccessToken();
    const list = await fetch(`${PAYPAL_BASE}/v1/notifications/webhooks`, { headers: { Authorization: `Bearer ${token}` } });
    if (list.ok) {
      const data = await list.json();
      const mine = (data.webhooks || []).find((w) => w.url === `${BASE_URL}/api/webhooks/paypal`);
      if (mine) {
        webhookId = mine.id;
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('paypal_webhook_id', webhookId);
      }
    }
  }
  if (!webhookId) return false;
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: req.headers['paypal-auth-algo'],
      cert_url: req.headers['paypal-cert-url'],
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: event,
    }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}

async function registerPayPalWebhook() {
  // Self-register on boot so the hosted demo receives events without a
  // manual dashboard step. Never crashes the server: failures only log.
  if (!paypalConfigured) return;
  const url = `${BASE_URL}/api/webhooks/paypal`;
  if (url.startsWith('http://localhost')) {
    console.log('webhook: skipping registration on localhost (PayPal needs a public HTTPS URL)');
    return;
  }
  try {
    const token = await paypalAccessToken();
    const list = await fetch(`${PAYPAL_BASE}/v1/notifications/webhooks`, { headers: { Authorization: `Bearer ${token}` } });
    if (!list.ok) throw new Error(`list webhooks failed (${list.status})`);
    const data = await list.json();
    const existing = (data.webhooks || []).find((w) => w.url === url);
    if (existing) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('paypal_webhook_id', existing.id);
      console.log(`webhook: already registered (${existing.id})`);
      return;
    }
    const res = await fetch(`${PAYPAL_BASE}/v1/notifications/webhooks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, event_types: [{ name: '*' }] }),
    });
    if (!res.ok) throw new Error(`create webhook failed (${res.status}): ${await res.text()}`);
    const created = await res.json();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('paypal_webhook_id', created.id);
    console.log(`webhook: registered ${created.id} for ${url}`);
  } catch (e) {
    console.error('webhook: registration failed (events will not arrive):', e.message);
  }
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

// v12 price-drop auto-buy, shared by the LLM tool and the deterministic
// engine: buy the >=10% drops inside the budget, then check out through the
// same path as a restock. On a checkout failure the items stay in the cart
// and the summary says so — never a silent partial buy.
async function buyPriceDrops(session, budget) {
  const { deals, totalCost } = priceDropDeals(budget);
  if (!deals.length) return { deals, totalCost: 0, summary: `No tracked item has dropped 10% or more in the last 3 months, so there is nothing to stock up on within $${budget}.` };
  for (const d of deals) cartAdd(session, d.productId, d.qty, { price: d.price, supplier: d.supplier, leadTimeDays: d.leadTimeDays });
  try {
    const r = await agentTools.create_checkout(session);
    const list = deals.map((d) => `${d.qty} × ${d.name} at ${money(d.price)} (${d.changePct3mo}% in 3 months)`).join(', ');
    return { deals, totalCost, orderId: r.orderId, checkoutUrl: r.checkoutUrl, summary: `Bought the price drops — ${list} — total ${money(totalCost)} within your $${budget} budget. Order ${r.orderId} is ready for approval: ${r.checkoutUrl}` };
  } catch (e) {
    const list = deals.map((d) => `${d.qty} × ${d.name} (${d.changePct3mo}%)`).join(', ');
    return { deals, totalCost, error: e.message, summary: `Price drops found — ${list} — total ${money(totalCost)} within $${budget}, but checkout failed (${e.message}). The items are in your cart; try again or check out from the storefront.` };
  }
}

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
  { type: 'function', function: { name: 'check_price_drops', description: 'Check which supplier prices DROPPED more than 5% in 3 months — a buying opportunity: smart restock already buys at the current lower price. Use when the user asks about prices going down or getting cheaper.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'buy_price_drops', description: 'Buy extra stock of items whose price dropped at least 10% in the last 3 months, within a budget (default $60): tops each item up toward max stock, at most 2 extra units, never exceeding the budget, then creates the PayPal checkout. Use when the user asks to buy the price drops, stock up on cheap items, or take advantage of falling prices.', parameters: { type: 'object', properties: { budget: { type: 'number', description: 'Maximum total spend in dollars (default 60).' } }, required: [] } } },
  { type: 'function', function: { name: 'check_payables', description: 'Check what the café owes suppliers: unpaid payables per supplier, amounts, due dates and overdue flags. Use when the user asks what they owe.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'check_overdue_invoices', description: 'Check overdue money: SENT PayPal invoices past their due date (with days overdue) and unpaid supplier payables past their due date. Use when the user asks what is overdue or past due.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'remind_invoice', description: 'Send a PayPal payment reminder for a SENT invoice (by invoice id, or the most overdue SENT invoice when omitted). Only SENT invoices can be reminded. Use when the user asks to remind, nudge or chase a customer about an unpaid invoice.', parameters: { type: 'object', properties: { invoiceId: { type: 'string' } } } } },
  { type: 'function', function: { name: 'check_savings', description: 'Check how much the agent has saved the café: total dollars saved by buying from cheaper alternate suppliers, stock-outs prevented, and number of captured orders. Use when the user asks how much you have saved them.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_restock_plan', description: 'Run the active weekly restock plan (or the named plan): smart restock within the plan budget and create the PayPal checkout. Use when the user asks to run their weekly restock.', parameters: { type: 'object', properties: { name: { type: 'string' } } } } },
  { type: 'function', function: { name: 'create_subscription', description: 'Set up a weekly restock subscription (PayPal Subscriptions): size this week\'s restock box within the budget, create the weekly billing plan and subscription, and return the PayPal approval URL. Use when the user asks to subscribe or set up a weekly restock subscription.', parameters: { type: 'object', properties: { budget: { type: 'number' } } } } },
  { type: 'function', function: { name: 'check_subscriptions', description: 'List the café\'s weekly restock subscriptions with their PayPal status, amount, box contents and next billing date. Use when the user asks what subscriptions they have.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'cancel_subscription', description: 'Cancel a weekly restock subscription on PayPal (by subscription id, or the latest one if omitted). Use when the user asks to cancel their subscription.', parameters: { type: 'object', properties: { subscriptionId: { type: 'string' } } } } },
  { type: 'function', function: { name: 'fulfill_subscription', description: 'Fulfill this week\'s box for an ACTIVE weekly restock subscription: smart restock within the subscription amount and create the PayPal checkout. Use when the user asks to fulfill this week\'s subscription box.', parameters: { type: 'object', properties: { subscriptionId: { type: 'string' } } } } },
  { type: 'function', function: { name: 'check_recent_events', description: 'List recent PayPal webhook events received by the server (subscription activated/cancelled, invoice paid, order approved, sale completed) with their time and whether they were handled. Use when the user asks about recent payments or webhook events.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'revise_subscription', description: 'Revise an ACTIVE weekly restock subscription to a new weekly amount (or re-size the box from today\'s burn rate when no amount is given): create the new billing plan and revise the subscription on PayPal. A price rise needs the buyer to approve via the returned link; a price drop applies at once. Use when the user asks to revise or change their subscription or weekly box price.', parameters: { type: 'object', properties: { subscriptionId: { type: 'string' }, amount: { type: 'number' } } } } },
  { type: 'function', function: { name: 'create_buying_group', description: 'Create a group-buying group: several cafés pool one order to unlock a wholesale tier price (5% off at 10+ units, 10% off at 25+ units per item). Our café joins automatically. Use when the user asks to start or create a buying group.', parameters: { type: 'object', properties: { name: { type: 'string' }, city: { type: 'string' }, focus: { type: 'string' } } } } },
  { type: 'function', function: { name: 'join_buying_group', description: 'Join a buying group as a café, optionally committing to buy quantities of items (the pooled quantity sets the tier price). Use when the user asks for a café to join a buying group.', parameters: { type: 'object', properties: { groupId: { type: 'string' }, cafeName: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { itemId: { type: 'string' }, qty: { type: 'number' } } } } } } } },
  { type: 'function', function: { name: 'check_group_deals', description: 'Check group-buying deals: for each group and item, the pooled quantity across member cafés, the tier price (5% off at 10+, 10% off at 25+), the solo price, and the saving vs ordering alone. Use when the user asks about group deals or group buying prices.', parameters: { type: 'object', properties: { groupId: { type: 'string' } } } } },
  { type: 'function', function: { name: 'place_group_order', description: 'Place a pooled group order on PayPal at the tier price: one PayPal checkout for the pooled quantity, with each member café owing its own share (payables per café). Use when the user asks to place or order the group buy.', parameters: { type: 'object', properties: { groupId: { type: 'string' }, itemId: { type: 'string' } } } } },
];
const LLM_SYSTEM = `You are the AgentMart shopping agent for a small café restocking coffee, tea and gear. You must use the provided tools to act — never invent products, prices or order ids. Products come only from search_products. When the user asks what they are running out of, call check_stock first. When the user asks to restock before running out, call smart_restock once (it sizes the cart and creates the checkout) instead of searching and adding item by item. When the user asks for a kit/bundle under a budget: search at most twice, then immediately add items one by one staying inside the budget, then call create_checkout exactly once and tell the user the order id, total and to approve on PayPal sandbox. Do not keep searching once you have seen products that fit the budget. When the user asks for an order status, call order_status with the id from their message. When the user asks about prices going up or supplier prices, call check_prices first and name the items that crept up more than 5% in 3 months. When the user asks about prices going down or getting cheaper, call check_price_drops first and name the items that dropped more than 5% in 3 months — a falling price is a good time to stock up, and smart restock already buys at the current lower price. When the user asks to buy the price drops or stock up on cheap items, call buy_price_drops once with their budget (default $60) and tell them the items, the total and the PayPal order id to approve. When the user asks what they owe suppliers, call check_payables first and list the unpaid amounts, due dates and anything overdue. When the user asks what is overdue or past due, call check_overdue_invoices first and list the overdue SENT invoices (with days overdue) and the overdue payables. When the user asks to remind, nudge or chase a customer about an unpaid invoice, call remind_invoice once (with the invoice id from their message when given, otherwise the most overdue SENT invoice) and confirm the reminder was sent — only SENT invoices can be reminded, so if there is none, say so instead of inventing one. When the user asks how much you have saved them, call check_savings first and report the total saved, the stock-outs prevented and the number of captured orders — never say savings are not tracked when the tool returns a number, even if it is zero. When the user asks to run their weekly restock, call run_restock_plan once. When the user asks to set up a weekly restock subscription, call create_subscription once and tell them the box contents, the weekly amount and to approve on PayPal sandbox — the subscription bills weekly after approval. When the user asks what subscriptions they have, call check_subscriptions first. When the user asks to cancel a subscription, call cancel_subscription once. When the user asks to fulfill this week's subscription box, call fulfill_subscription once. When the user asks about recent payments or webhook events, call check_recent_events first and report what PayPal pushed to the server. When the user asks to revise or change their subscription or weekly box price, call revise_subscription once and tell them the old and new amounts — and if the price went up, that they must approve the change on PayPal via the returned link. When the user asks about group buying or group deals, call check_group_deals first and report the pooled quantity, the tier price and the saving vs ordering alone for each item. When the user asks to start or create a buying group, call create_buying_group once. When the user asks for a café to join a buying group, call join_buying_group once with the café name and the items and quantities it commits to. When the user asks to place the group order, call place_group_order once and tell them the pooled quantity, the tier price, the PayPal order id and to approve on PayPal sandbox — each member café owes its own share after capture. When the user asks when things will run out, call check_stock first and answer with the forecast dates (stock-out date and order-by date). If a product the user wants is out of stock, the add_to_cart tool automatically substitutes the closest same-category in-stock item and tells you in its result — explain the swap and the price difference to the user, and offer to remove it with remove_from_cart. Answer in English, concisely, with prices in USD.`;

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
  if (name === 'check_price_drops') {
    return { drops: PRODUCTS.map((p) => priceTrend(p)).filter((t) => t.drop).sort((a, b) => a.changePct3mo - b.changePct3mo) };
  }
  if (name === 'buy_price_drops') {
    const budget = typeof args.budget === 'number' && args.budget > 0 ? args.budget : 60;
    const r = await buyPriceDrops(session, budget);
    return { budget, deals: r.deals, totalCost: r.totalCost, orderId: r.orderId, checkoutUrl: r.checkoutUrl, reply: r.summary };
  }
  if (name === 'check_payables') {
    const today = new Date().toISOString().slice(0, 10);
    const list = [...payables.entries()].map(([id, r]) => ({ id, ...r, overdue: r.status === 'UNPAID' && r.dueDate < today })).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const unpaid = list.filter((r) => r.status === 'UNPAID');
    return { payables: list, totalUnpaid: Math.round(unpaid.reduce((s, r) => s + r.amount, 0) * 100) / 100, overdue: unpaid.filter((r) => r.overdue) };
  }
  if (name === 'check_overdue_invoices') {
    const today = new Date().toISOString().slice(0, 10);
    const overdueInv = overdueInvoices([...invoices.values()], today);
    const overduePay = [...payables.entries()]
      .map(([id, r]) => ({ id, ...r, overdue: r.status === 'UNPAID' && r.dueDate < today }))
      .filter((r) => r.overdue);
    return { overdueInvoices: overdueInv, overduePayables: overduePay };
  }
  if (name === 'remind_invoice') {
    const today = new Date().toISOString().slice(0, 10);
    let rec = null;
    if (args.invoiceId) {
      rec = [...invoices.values()].find((r) => r.invoiceId === args.invoiceId || `inv-${r.invoiceId}` === args.invoiceId) || null;
      if (!rec) return { error: 'NOT_FOUND', message: `No invoice ${args.invoiceId} in this demo.` };
    } else {
      const overdue = overdueInvoices([...invoices.values()], today);
      rec = overdue[0] || [...invoices.values()].find((r) => r.status === 'SENT') || null;
      if (!rec) return { message: 'No SENT invoice to remind — create and send an invoice first.' };
    }
    if (rec.status !== 'SENT') return { error: 'INVOICE_NOT_SENT', message: `Invoice ${rec.invoiceId} is ${rec.status}, not SENT — only a SENT invoice can be reminded. Send it first.` };
    const out = await remindPayPalInvoice(rec.invoiceId);
    return { invoiceId: rec.invoiceId, status: 'SENT', remindedAt: out.remindedAt, message: `Reminder sent to ${rec.recipient || 'the customer'} for invoice ${rec.invoiceId} (${money(rec.total)}, due ${rec.dueDate || '—'}).` };
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
  if (name === 'check_recent_events') {
    return { events: recentWebhookEvents(10) };
  }
  if (name === 'revise_subscription') {
    const id = args.subscriptionId || [...subscriptions.entries()].find(([, r]) => r.status === 'ACTIVE')?.[0];
    if (!id) return { message: 'No ACTIVE subscription to revise — set one up and approve it on PayPal first.' };
    const amount = typeof args.amount === 'number' && args.amount > 0 ? args.amount : undefined;
    return reviseSubscription(id, amount);
  }
  if (name === 'create_buying_group') {
    return createBuyingGroup({ name: args.name || 'Bay Area Coffee Buyers', city: args.city, focus: args.focus });
  }
  if (name === 'join_buying_group') {
    const id = args.groupId || [...buyingGroups.keys()][0];
    if (!id) return { message: 'No buying group exists yet — create one first.' };
    if (!args.cafeName) return { message: 'Which café is joining? Give me the café name, for example "join the buying group as Philz Coffee".' };
    return joinBuyingGroup(id, args.cafeName, args.items);
  }
  if (name === 'check_group_deals') {
    const deals = groupDeals();
    return { deals: args.groupId ? deals.filter((d) => d.groupId === args.groupId) : deals };
  }
  if (name === 'place_group_order') {
    const deals = groupDeals();
    const deal = args.groupId && args.itemId
      ? deals.find((d) => d.groupId === args.groupId && d.itemId === args.itemId)
      : args.itemId ? deals.find((d) => d.itemId === args.itemId) : deals[0];
    if (!deal) return { message: 'No group deal to order — check the group deals first.' };
    return createGroupPayPalOrder(deal.groupId, deal.itemId);
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
  // Real LLM first when configured: providers in order (Fireworks primary,
  // then fallback, then fallback2). Fall back to the deterministic engine
  // on any LLM error so the demo never dies in front of a judge.
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

  // Overdue + reminders (v10): "what is overdue?" / "remind the customer
  // about invoice …". Runs BEFORE the payables branch below, whose
  // "what.*due" pattern would otherwise catch "what is overdue".
  if (/(overdue|past due|late payment|quá hạn|qua han)/.test(msg) && !/remind|nudge|chase/.test(msg)) {
    const today = new Date().toISOString().slice(0, 10);
    const overdueInv = overdueInvoices([...invoices.values()], today);
    const overduePay = [...payables.entries()].map(([id, r]) => ({ id, ...r })).filter((r) => r.status === 'UNPAID' && r.dueDate < today);
    if (!overdueInv.length && !overduePay.length) return { reply: 'Nothing is overdue — no SENT invoice is past its due date and no payable is past due.' };
    const lines = [];
    if (overdueInv.length) lines.push(`Overdue invoices:\n${overdueInv.map((r) => `${r.invoiceId} — ${money(r.total)} to ${r.recipient || 'customer'}, due ${r.dueDate} (${r.daysOverdue} day(s) overdue)`).join('\n')}`);
    if (overduePay.length) lines.push(`Overdue payables:\n${overduePay.map((r) => `${r.supplier} — ${money(r.amount)}, due ${r.dueDate}`).join('\n')}`);
    return { reply: `${lines.join('\n\n')}${overdueInv.length ? '\n\nSay "remind the customer about the invoice" and I will send a PayPal payment reminder.' : ''}` };
  }
  if (/(remind|nudge|chase).*(invoice|payment|customer|payer)|send.*(payment )?reminder|nhắc.*(hóa đơn|hoa don|khách|khach)/.test(msg)) {
    const idMatch = message.match(/\bINV2-[A-Z0-9-]+\b/);
    const today = new Date().toISOString().slice(0, 10);
    let rec = null;
    if (idMatch) {
      rec = [...invoices.values()].find((r) => r.invoiceId === idMatch[0]) || null;
      if (!rec) return { reply: `I could not find invoice ${idMatch[0]} in this demo.` };
    } else {
      const overdue = overdueInvoices([...invoices.values()], today);
      rec = overdue[0] || [...invoices.values()].find((r) => r.status === 'SENT') || null;
      if (!rec) return { reply: 'No SENT invoice to remind — create an invoice from an order and send it first, then I can remind the customer.' };
    }
    if (rec.status !== 'SENT') return { reply: `Invoice ${rec.invoiceId} is ${rec.status}, not SENT — only a SENT invoice can be reminded. Send it first.` };
    await remindPayPalInvoice(rec.invoiceId);
    return { reply: `Reminder sent to ${rec.recipient || 'the customer'} for invoice ${rec.invoiceId} (${money(rec.total)}, due ${rec.dueDate || '—'}). PayPal will email them about the unpaid invoice.` };
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

  // Subscription revise (v9): "revise my subscription" / "change my weekly
  // box" — re-size the box from today's burn rate and revise on PayPal.
  // Must run BEFORE the v7 subscription block below, which also matches
  // the word "subscription".
  if (/(revise|change my (weekly )?box|change my subscription|update my subscription|đổi gói|doi goi)/.test(msg)) {
    const idMatch = message.match(/\bI-[A-Z0-9]+\b/);
    const id = idMatch?.[0] || [...subscriptions.entries()].find(([, r]) => r.status === 'ACTIVE')?.[0];
    if (!id) return { reply: 'No ACTIVE subscription to revise — set one up and approve it on PayPal first.' };
    const amountMatch = msg.match(/\$?\s*(\d+(?:\.\d+)?)/);
    try {
      const out = await reviseSubscription(id, amountMatch ? Number(amountMatch[1]) : undefined);
      if (!out.revised) return { reply: out.message };
      if (out.needsApproval) return { reply: `Revision proposed: weekly box ${money(out.oldAmount)} → ${money(out.proposedAmount)} on approval. The price rise needs your approval:\n${out.approveUrl}` };
      return { reply: `Subscription revised: weekly box is now ${money(out.newAmount)} (was ${money(out.oldAmount)}). The new price applies at once — box: ${out.box.map((i) => `${i.qty}× ${i.name}`).join(', ')}.` };
    } catch (e) {
      if (e.message === 'SUBSCRIPTION_NOT_ACTIVE') return { reply: 'That subscription is not ACTIVE, so it cannot be revised — approve it on PayPal first.' };
      throw e;
    }
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

  // Webhook events (v8): "any new payments?" / "did my subscription payment
  // go through?" — answered from the PayPal webhook event log.
  if (/(webhook|new payments|payment go through|payments? (came|arrived)|any (new )?payments)/.test(msg)) {
    const events = recentWebhookEvents(5);
    if (!events.length) return { reply: 'No PayPal webhook events have arrived yet. Approve an order or a subscription and PayPal will push the event here — the dashboard shows the event log live.' };
    const lines = events.map((e) => `${e.receivedAt.slice(0, 19).replace('T', ' ')} — ${e.eventType}${e.resourceId ? ` (${e.resourceId})` : ''} — ${e.handled ? 'handled' : 'logged'}`).join('\n');
    return { reply: `Recent PayPal events:\n${lines}` };
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

  // Group buying (v11): "what are the group deals?" / "create a buying
  // group" / "join the buying group as X" / "place the group order".
  if (/(buying group|group buy|group deal|group order|gộp đơn|gop don)/.test(msg)) {
    const dealsReply = () => {
      const deals = groupDeals();
      if (!deals.length) return 'No buying group exists yet — say "create a buying group" and I will set one up.';
      const lines = deals.map((d) => `${d.emoji} ${d.itemName} — pooled ${d.pooledQty} units across ${d.memberCount} cafés (${d.members.join(', ')}) → Tier ${d.tier} (−${d.discountPct}%), ${money(d.unitPrice)} each instead of ${money(d.soloPrice)} — saves ${money(d.savings)} vs ordering alone${d.orderStatus !== 'OPEN' ? ` — latest group order ${d.orderStatus}` : ''}`).join('\n');
      return `Group-buying deals (5% off at 10+ units, 10% off at 25+):\n${lines}\n\nSay "place the group order for matcha" and I will order the pooled quantity on PayPal — each café owes only its own share.`;
    };
    if (/(place|order|checkout|pay).*(group|pooled)|place the group/.test(msg)) {
      const stripped = msg.replace(/(place|order|checkout|pay|the|group|buying|pooled|for|a|an)/gi, ' ');
      const p = stripped.replace(/[^a-z]/gi, '').length >= 3 ? matchOneProduct(stripped) : null;
      const deals = groupDeals();
      const deal = p ? deals.find((d) => d.itemId === p.id) : deals[0];
      if (!deal) return { reply: 'No group deal to order — check the group deals first.' };
      try {
        const out = await createGroupPayPalOrder(deal.groupId, deal.itemId);
        return { reply: `Group order placed: ${out.pooledQty}× ${out.itemName} at the Tier ${out.tier} price of ${money(out.unitPrice)} (was ${money(out.soloPrice)}), total ${money(out.total)} — saved ${money(out.savings)} vs ordering alone. PayPal order ${out.orderId} — approve it on PayPal sandbox. After capture, each café owes only its own share: ${out.shares.map((s) => `${s.cafe} ${money(s.amount)}`).join(', ')}.`, checkoutUrl: out.approveUrl, orderId: out.orderId };
      } catch (e) {
        if (e.message === 'PAYPAL_NOT_CONFIGURED') return { reply: 'PayPal sandbox is not configured on this server yet.' };
        throw e;
      }
    }
    if (/(create|start|set up|setup|make).*(buying group|group)/.test(msg)) {
      const nameMatch = msg.match(/(?:called|named)\s+["']?([^"']+)/);
      const focusMatch = msg.match(/for\s+(matcha|oat|coffee|tea|beans)/);
      const g = createBuyingGroup({ name: nameMatch ? nameMatch[1].trim().replace(/\b\w/g, (c) => c.toUpperCase()) : 'Bay Area Coffee Buyers', city: CAFE.location, focus: focusMatch ? focusMatch[1] : 'coffee & tea' });
      return { reply: `Buying group "${g.name}" created (${g.city}, focus: ${g.focus}) — ${OUR_CAFE} joined automatically. Other cafés can join with "join the buying group as <café name>" and commit quantities; at 10+ pooled units the price drops 5%, at 25+ it drops 10%.` };
    }
    if (/join/.test(msg)) {
      const afterAs = msg.match(/join(?: the)?(?: buying group)? as\s+(.+)/);
      const cafeName = afterAs ? afterAs[1].replace(/\s+(with|for|buying|to buy|committing)\b.*$/, '').trim() : '';
      if (!cafeName) return { reply: 'Which café is joining? For example: "join the buying group as Philz Coffee with 10 matcha".' };
      const items = [];
      const keywords = { 'arabica-beans': 'arabica', 'robusta-beans': 'robusta', 'pourover-set': 'dripper', 'coldbrew-bottle': 'cold brew', 'matcha': 'matcha', 'instant-coffee': 'instant', 'oat-milk': 'oat', 'barista-scale': 'scale' };
      for (const p of PRODUCTS) {
        const keyword = keywords[p.id] || p.id.split('-')[0];
        const m = msg.match(new RegExp(`(\\d+)\\s*(?:x|×)?\\s*${keyword}`));
        if (m) items.push({ itemId: p.id, qty: Number(m[1]) });
      }
      const id = [...buyingGroups.keys()][0];
      if (!id) return { reply: 'No buying group exists yet — say "create a buying group" first.' };
      const out = joinBuyingGroup(id, cafeName.replace(/\b\w/g, (c) => c.toUpperCase()), items.length ? items : undefined);
      return { reply: `${out.cafeName} joined "${buyingGroups.get(id).name}"${items.length ? `, committing to ${items.map((i) => `${i.qty}× ${productById(i.itemId).name}`).join(', ')}` : ''}. ${dealsReply()}` };
    }
    return { reply: dealsReply() };
  }

  // Price-drop auto-buy (v12): "buy the price drops" / "stock up on the
  // cheap stuff" — must run BEFORE the price-drops question branch below,
  // which also matches "price drop" but only reports.
  if (/(buy|stock up|take advantage|grab).*(price drop|price fall|falling price|dropped price|cheap)|((price drop|price fall|falling price|dropped price).*(buy|stock up|grab))/.test(msg)) {
    const budgetMatch = msg.match(/(?:under|below|within|\$)\s*\$?(\d+(?:\.\d+)?)/);
    const budget = budgetMatch ? Number(budgetMatch[1]) : 60;
    const r = await buyPriceDrops(session, budget);
    return { reply: r.summary, engine: 'deterministic', actions: r.orderId ? [{ type: 'order', id: r.orderId, url: r.checkoutUrl }] : [], meta: { priceDropDeals: r.deals } };
  }

  // Price drops (v10): "did any prices go down?" — must run BEFORE the
  // creep branch below, which also matches "did any prices...".
  if (/(price.*(down|drop|dropped|fell|fall|decrease|decreased|lower|cheaper)|did.*prices? (go )?down|any (price )?drops|giá.*(giảm|giam|xuống|xuong))/.test(msg)) {
    const trends = PRODUCTS.map((p) => priceTrend(p));
    const drops = trends.filter((t) => t.drop).sort((a, b) => a.changePct3mo - b.changePct3mo);
    const lines = trends.map((t) => `${t.emoji} ${t.name} — ${money(t.current)} (${t.changePct3mo >= 0 ? '+' : ''}${t.changePct3mo}% in 3 months${t.drop ? ', 📉 drop' : ''})`).join('\n');
    const note = drops.length
      ? `\n\n📉 Prices down more than 5% in 3 months: ${drops.map((t) => `${t.name} ${t.changePct3mo}%`).join(', ')}. Biggest fall is ${drops[0].name} — a good time to stock up, and a smart restock already buys at the current lower price.`
      : '\n\nNo supplier price has dropped more than 5% in 3 months.';
    return { reply: `Supplier prices (demo history, Aug–Nov 2026):\n${lines}${note}` };
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
  // / "restock before I run out" — the last phrase used to fall through to
  // the kit builder below (its pattern also matches "restock").
  if (/(smart restock|restock me|restock before|reorder what.*(low|need)|don.*run out)/.test(msg)) {
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
    return { reply: 'Hi! I am the AgentMart shopping agent. I can search the catalog, build your cart and check out with PayPal — all from chat. Try:\n• "Show me coffee under $35"\n• "Add 2 arabica beans"\n• "Build me a coffee starter kit under $60"\n• "What am I running out of?"\n• "Smart restock under $60"\n• "Did any prices go up?"\n• "Did any prices go down?"\n• "What do I owe suppliers?"\n• "What is overdue?"\n• "Remind the customer about the invoice"\n• "How much have you saved me?"\n• "When will I run out of everything?"\n• "Am I overstocked?"\n• "Set up a weekly restock subscription under $60"\n• "Any new payments?"\n• "Revise my subscription"\n• "Checkout"' };
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
app.get('/api/config', (req, res) => res.json({ paypalConfigured, env: PAYPAL_ENV, llmConfigured, llmModel: LLM_MODEL, engine: llmConfigured ? `llm:${LLM_MODEL}` : 'deterministic', cafe: CAFE.name, cafeLocation: CAFE.location }));
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
app.post('/api/subscriptions/:id/revise', async (req, res) => {
  const b = Number(req.body?.amount);
  const amount = req.body?.amount === undefined ? undefined : (Number.isFinite(b) && b > 0 ? b : null);
  if (amount === null) return res.status(400).json({ error: 'INVALID_INPUT', message: 'amount must be a number above 0.' });
  try {
    res.json(await reviseSubscription(req.params.id, amount));
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    if (e.message === 'SUBSCRIPTION_NOT_ACTIVE') return res.status(400).json({ error: 'SUBSCRIPTION_NOT_ACTIVE', message: 'Only an ACTIVE subscription can be revised.' });
    console.error(e);
    res.status(502).json({ error: 'REVISE_FAILED', message: e.message });
  }
});

// Webhooks (v8): PayPal pushes async events here. Every event is verified
// against PayPal before it is trusted; unverified requests get 401.
app.post('/api/webhooks/paypal', async (req, res) => {
  const event = req.body || {};
  if (!event.id || !event.event_type) return res.status(400).json({ error: 'INVALID_EVENT' });
  const sigHeaders = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (sigHeaders.some((h) => !req.headers[h])) return res.status(401).json({ error: 'MISSING_SIGNATURE' });
  try {
    const ok = await verifyPayPalWebhook(req, event);
    if (!ok) return res.status(401).json({ error: 'INVALID_SIGNATURE' });
    const out = await handleWebhookEvent(event);
    res.json({ received: true, ...out });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'WEBHOOK_FAILED', message: e.message });
  }
});
app.get('/api/webhook-events', (req, res) => res.json(recentWebhookEvents(50)));
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
app.get('/api/roi', (req, res) => res.json(roiSummary()));
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
// Group buying (v11): flat deal rows for the grid, create/join, and the
// pooled PayPal order (leave it CREATED — the buyer approves on PayPal).
app.get('/api/groups', (req, res) => res.json(groupDeals()));
app.post('/api/groups', (req, res) => {
  const { name, city, focus } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'INVALID_INPUT', message: 'name is required.' });
  res.status(201).json(createBuyingGroup({ name, city, focus }));
});
app.post('/api/groups/:id/join', (req, res) => {
  const { cafeName, items } = req.body || {};
  try {
    res.json(joinBuyingGroup(req.params.id, cafeName, items));
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    if (e.message === 'INVALID_INPUT') return res.status(400).json({ error: 'INVALID_INPUT', message: 'cafeName is required.' });
    console.error(e);
    res.status(502).json({ error: 'JOIN_FAILED', message: e.message });
  }
});
app.post('/api/groups/:id/order', async (req, res) => {
  const { itemId } = req.body || {};
  if (!itemId || !productById(itemId)) return res.status(400).json({ error: 'INVALID_INPUT', message: 'a valid itemId is required.' });
  try {
    res.status(201).json(await createGroupPayPalOrder(req.params.id, itemId));
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    if (e.message === 'NO_POOLED_QTY') return res.status(400).json({ error: 'NO_POOLED_QTY', message: 'No pooled quantity for that item in this group.' });
    if (e.message === 'PAYPAL_NOT_CONFIGURED') return res.status(503).json({ error: 'PAYPAL_NOT_CONFIGURED' });
    console.error(e);
    res.status(502).json({ error: 'GROUP_ORDER_FAILED', message: e.message });
  }
});
app.post('/api/demo/reset', (req, res) => {
  // Reset the demo to its seed state before filming: stock back to seed,
  // waste and carts cleared, and the seed buying group's members + intents
  // restored so the group deals always come back. Orders, payables and
  // plans are real records and are kept.
  for (const p of PRODUCTS) {
    inventory.set(p.id, p.stock);
    saveStock(p.id);
  }
  db.prepare('DELETE FROM waste').run();
  db.prepare('DELETE FROM carts').run();
  seedGroupMembers();
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
// v10: remind the payer about a SENT invoice (PayPal Invoicing remind
// API). Only SENT invoices can be reminded — PayPal answers 422
// CANNOT_REMIND_INVOICE for DRAFT, so the status is validated here,
// before any PayPal call, with a clear error.
app.post('/api/invoices/:id/remind', async (req, res) => {
  if (!paypalConfigured) return res.status(503).json({ error: 'PAYPAL_NOT_CONFIGURED' });
  const rec = invoices.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'NOT_FOUND' });
  if (rec.status !== 'SENT') return res.status(400).json({ error: 'INVOICE_NOT_SENT', message: `Only a SENT invoice can be reminded (this one is ${rec.status}). Send it first.` });
  try {
    const out = await remindPayPalInvoice(rec.invoiceId);
    res.json({ id: req.params.id, invoiceId: rec.invoiceId, status: 'SENT', ...out });
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
    // v8: self-register the PayPal webhook so async events arrive.
    registerPayPalWebhook().catch((e) => console.error('webhook: registration failed:', e.message));
    // v12: rehydrate subscriptions/orders/invoices PayPal still knows
    // about after a DB wipe. Fire-and-forget: it never throws, and the
    // server is already accepting connections when it runs.
    bootRehydrateFromPayPal().catch((e) => console.error('boot rehydrate failed:', e.message));
  });
}
module.exports = { app, searchProducts, cartView, runAgent, llmConfigured, paypalConfigured, inventoryView, smartRestockPlan, findSubstitute, addToCartWithSubstitute, bestSupplier, priceTrend, priceDropDeals, buyPriceDrops, expectedDeliveryDate, cartAdd, payablesForOrder, supplierTerms, forecastView, nextRunDate, createPlan, wasteSummary, spoilExcess, savingsSummary, roiSummary, llmTools: LLM_TOOLS, subscriptionView, createSubscription, refreshSubscription, routeWebhookEvent, recentWebhookEvents, handleWebhookEvent, reviseSubscription, invoices, overdueInvoices, remindPayPalInvoice, CAFE, groupTier, groupDeals, createBuyingGroup, joinBuyingGroup, createGroupPayPalOrder, completeGroupOrder, OUR_CAFE, buyingGroups, groupMembers, groupIntents, groupOrders, payables, orders, subscriptions, providerNameFor, bootRehydrateFromPayPal, rehydrateFromEvents, rehydrateOrder, rehydrateInvoice };
