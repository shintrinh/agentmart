'use strict';
/* AgentMart tests — run with `npm test`. No PayPal network calls: the
 * agent paths tested here do not create orders, and invoice validation is
 * checked before any PayPal call. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Tests use a throwaway SQLite file so they never mutate the demo database.
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmart-test-')), 'test.db');
process.env.AGENTMART_DB_PATH = tmpDb;
const { app, searchProducts } = require('./server');

let server;
let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function api(path, opts = {}) {
  const res = await fetch(`${base}${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('health and config', async () => {
  const h = await api('/health');
  assert.equal(h.status, 200);
  assert.equal(h.data.ok, true);
  const c = await api('/api/config');
  assert.equal(c.status, 200);
  assert.equal(c.data.env, 'sandbox');
});

test('catalog has 8 café products', async () => {
  const { data } = await api('/api/products');
  assert.equal(data.length, 8);
  assert.ok(data.some((p) => p.id === 'arabica-beans'));
});

test('searchProducts respects max price', () => {
  const hits = searchProducts('coffee', 35);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((p) => p.price <= 35));
});

test('agent search does not need PayPal', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'Show me coffee under $35' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /Arabica|Robusta/);
  assert.ok(data.engine);
});

test('agent reports unknown order', async () => {
  const { data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'what is the status of order ABCDEFGHIJKL?' }),
  });
  assert.match(data.reply, /could not find/i);
});

test('invoice endpoint validates input before PayPal', async () => {
  const r = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ orderId: 'nope', recipientEmail: 'not-an-email' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'INVALID_INPUT');
});

test('orders list endpoint works', async () => {
  const { status, data } = await api('/api/orders');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data));
});

test('inventory reports days left and low stock', async () => {
  const { status, data } = await api('/api/inventory');
  assert.equal(status, 200);
  assert.equal(data.length, 8);
  const matcha = data.find((r) => r.id === 'matcha');
  assert.ok(matcha);
  assert.equal(matcha.status, 'LOW');
  assert.ok(matcha.daysLeft > 0 && matcha.daysLeft < 5);
});

test('smart restock plan fits the budget', () => {
  const { inventoryView, smartRestockPlan } = require('./server');
  const rows = inventoryView();
  assert.ok(rows.some((r) => r.status === 'LOW'));
  const { plan, total } = smartRestockPlan(60);
  assert.ok(plan.length > 0);
  assert.ok(total <= 60);
  assert.ok(plan.every((p) => p.qty >= 1));
});

test('smart restock buys oat milk from the cheaper alternate supplier', () => {
  // Runs on seeded inventory (before the swap test simulates days away).
  // v10 Blue Bottle seed: matcha ×1 at $40.50 + oat-milk ×3 at the
  // alternate $5.99 (vs $6.39) = $58.47, saved $1.20.
  const { smartRestockPlan } = require('./server');
  const { plan, total, saved } = smartRestockPlan(60);
  const oat = plan.find((p) => p.id === 'oat-milk');
  assert.ok(oat);
  assert.equal(oat.price, 5.99);
  assert.equal(oat.supplier, 'Green Valley Farms');
  assert.equal(oat.supplierIsAlt, true);
  assert.equal(total, 58.47);
  assert.equal(saved, 1.2);
});

test('agent answers what is running out', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'What am I running out of?' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /matcha/i);
});

test('findSubstitute picks a same-category in-stock item', () => {
  const { findSubstitute } = require('./server');
  const arabica = { id: 'arabica-beans', tag: 'coffee' };
  const sub = findSubstitute(arabica);
  assert.ok(sub);
  assert.equal(sub.id, 'robusta-beans');
  assert.equal(findSubstitute({ id: 'matcha', tag: 'tea' }), null);
});

test('agent suggests a substitute on request', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'What can I use instead of arabica beans?' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /Robusta/);
  assert.match(data.reply, /instead of/i);
});

test('adding an OUT product swaps in the substitute', async () => {
  // Drive arabica to zero stock: 0.5/day from the seeded 4 = 8 days.
  for (let i = 0; i < 8; i++) {
    await api('/api/inventory/simulate-day', { method: 'POST', body: JSON.stringify({}) });
  }
  const inv = await api('/api/inventory');
  const arabica = inv.data.find((r) => r.id === 'arabica-beans');
  assert.equal(arabica.status, 'OUT');
  assert.ok(arabica.substitute);
  assert.equal(arabica.substitute.id, 'robusta-beans');
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-sub', message: 'Add 1 arabica' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /out of stock/i);
  assert.match(data.reply, /Robusta/);
  assert.ok(data.cart.items.some((i) => i.id === 'robusta-beans'));
  assert.ok(!data.cart.items.some((i) => i.id === 'arabica-beans'));
});

test('agent removes an item from the cart', async () => {
  await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-remove', message: 'Add 1 robusta' }),
  });
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-remove', message: 'Remove robusta' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /Removed/);
  assert.ok(!data.cart.items.some((i) => i.id === 'robusta-beans'));
});

test('bestSupplier picks the cheaper alternate within lead-time tolerance', () => {
  const { bestSupplier } = require('./server');
  const oat = bestSupplier({ id: 'oat-milk', supplier: 'Dairy & Pantry Co.', price: 16, leadTimeDays: 2, altSupplier: { name: 'Green Valley Farms', price: 14, leadTimeDays: 3 } });
  assert.equal(oat.name, 'Green Valley Farms');
  assert.equal(oat.price, 14);
  assert.equal(oat.isAlt, true);
  const arabica = bestSupplier({ id: 'arabica-beans', supplier: 'Highland Roasters', price: 18, leadTimeDays: 3, altSupplier: { name: 'Andean Direct', price: 19, leadTimeDays: 4 } });
  assert.equal(arabica.name, 'Highland Roasters');
  assert.equal(arabica.isAlt, false);
});

test('priceTrend flags creep above 5% in 3 months', () => {
  const { priceTrend } = require('./server');
  // v10 Blue Bottle seed: blend beans $23.40 → $25.50 = +9.0%.
  const arabica = priceTrend({ id: 'arabica-beans', name: 'Blue Bottle Blend Beans · Arabica 12 oz', emoji: '☕', tag: 'coffee', price: 25.50 });
  assert.equal(arabica.changePct3mo, 9.0);
  assert.equal(arabica.creep, true);
  const pourover = priceTrend({ id: 'pourover-set', name: 'Blue Bottle Dripper', emoji: '🍶', tag: 'gear', price: 28 });
  assert.equal(pourover.changePct3mo, 0);
  assert.equal(pourover.creep, false);
});

test('priceTrend flags drops below -5% in 3 months (v10)', () => {
  const { priceTrend } = require('./server');
  // Cold brew $6.49 → $5.79 = -10.8%; instant coffee $3.95 → $3.50 = -11.4%.
  const cold = priceTrend({ id: 'coldbrew-bottle', name: 'Blue Bottle Bright Cold Brew · 8 oz', emoji: '🧊', tag: 'gear', price: 5.79 });
  assert.equal(cold.changePct3mo, -10.8);
  assert.equal(cold.drop, true);
  assert.equal(cold.creep, false);
  const instant = priceTrend({ id: 'instant-coffee', name: 'Blue Bottle Craft Instant Coffee', emoji: '⚡', tag: 'pantry', price: 3.50 });
  assert.equal(instant.changePct3mo, -11.4);
  assert.equal(instant.drop, true);
  const arabica = priceTrend({ id: 'arabica-beans', name: 'Blue Bottle Blend Beans · Arabica 12 oz', emoji: '☕', tag: 'coffee', price: 25.50 });
  assert.equal(arabica.drop, false);
});

test('cart keeps a supplier price override per line', () => {
  const { cartAdd, cartView } = require('./server');
  cartAdd('test-pricing', 'oat-milk', 1, { price: 5.99, supplier: 'Green Valley Farms', leadTimeDays: 3 });
  const view = cartView('test-pricing');
  assert.equal(view.total, 5.99);
  assert.equal(view.items[0].price, 5.99);
  assert.equal(view.items[0].supplier, 'Green Valley Farms');
});

test('prices endpoint lists all products with best buy', async () => {
  const { status, data } = await api('/api/prices');
  assert.equal(status, 200);
  assert.equal(data.length, 8);
  const oat = data.find((r) => r.id === 'oat-milk');
  assert.equal(oat.bestSupplier, 'Green Valley Farms');
  assert.equal(oat.bestPrice, 5.99);
  assert.equal(oat.creep, true);
});

test('prices endpoint flags drops (v10)', async () => {
  const { data } = await api('/api/prices');
  const cold = data.find((r) => r.id === 'coldbrew-bottle');
  assert.equal(cold.drop, true);
  assert.equal(cold.changePct3mo, -10.8);
  const instant = data.find((r) => r.id === 'instant-coffee');
  assert.equal(instant.drop, true);
  const arabica = data.find((r) => r.id === 'arabica-beans');
  assert.equal(arabica.drop, false);
});

test('agent answers the price creep question', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'Did any prices go up?' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /Arabica/);
  assert.match(data.reply, /creep/i);
});

test('agent answers the price drop question (v10)', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'Did any prices go down?' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /Cold Brew|Instant Coffee/);
  assert.match(data.reply, /down/i);
});

test('expectedDeliveryDate uses the longest lead time', () => {
  const { expectedDeliveryDate } = require('./server');
  const d = new Date();
  d.setDate(d.getDate() + 4);
  assert.equal(expectedDeliveryDate([{ leadTimeDays: 3 }, { leadTimeDays: 4 }]), d.toISOString().slice(0, 10));
});

test('invoice refresh validates the id before PayPal', async () => {
  const r = await api('/api/invoices/nope/refresh', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'NOT_FOUND');
});

test('payablesForOrder splits per supplier with terms-based due dates', () => {
  const { payablesForOrder } = require('./server');
  const rec = {
    expectedDelivery: '2026-11-09',
    items: [
      { id: 'matcha', name: 'Blue Bottle Craft Matcha · 100 g', qty: 2, price: 40.50, supplier: 'Kyoto Tea Imports', leadTimeDays: 4 },
      { id: 'oat-milk', name: 'Oatly Barista Oat Milk · 32 oz', qty: 1, price: 5.99, supplier: 'Green Valley Farms', leadTimeDays: 3 },
    ],
  };
  const rows = payablesForOrder(rec, 'TESTORDER123');
  assert.equal(rows.length, 2);
  const kyoto = rows.find((r) => r.supplier === 'Kyoto Tea Imports');
  assert.equal(kyoto.amount, 81);
  assert.equal(kyoto.terms, 'Net 7');
  assert.equal(kyoto.dueDate, '2026-11-16');
  assert.equal(kyoto.status, 'UNPAID');
  const green = rows.find((r) => r.supplier === 'Green Valley Farms');
  assert.equal(green.amount, 5.99);
  assert.equal(green.dueDate, '2026-11-16');
});

test('payables endpoint starts empty and validates pay', async () => {
  const { status, data } = await api('/api/payables');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data));
  const r = await api('/api/payables/nope/pay', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'NOT_FOUND');
});

test('agent reports savings with no captured orders yet', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'How much have you saved me?' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /No captured orders yet/);
});

test('agent answers what is owed with no payables yet', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'What do I owe suppliers?' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /No payables/);
});

test('nextRunDate finds the coming weekday', () => {
  const { nextRunDate } = require('./server');
  // 2026-11-05 is a Thursday.
  assert.equal(nextRunDate(1, new Date('2026-11-05T00:00:00Z')), '2026-11-09');
  assert.equal(nextRunDate(4, new Date('2026-11-05T00:00:00Z')), '2026-11-05');
  assert.equal(nextRunDate(5, new Date('2026-11-05T00:00:00Z')), '2026-11-06');
});

test('forecastView projects stock-out and order-by dates', () => {
  const { forecastView, inventoryView } = require('./server');
  const rows = forecastView();
  assert.equal(rows.length, 8);
  // Expectations computed from live stock, so earlier tests that simulated
  // days away cannot break this test.
  const inv = inventoryView().find((r) => r.id === 'matcha');
  const matcha = rows.find((r) => r.id === 'matcha');
  const today = new Date();
  const stockout = new Date(today); stockout.setDate(stockout.getDate() + Math.floor(inv.daysLeft));
  const orderBy = new Date(stockout); orderBy.setDate(orderBy.getDate() - inv.leadTimeDays);
  assert.equal(matcha.stockoutDate, stockout.toISOString().slice(0, 10));
  assert.equal(matcha.orderByDate, orderBy.toISOString().slice(0, 10));
  assert.equal(matcha.orderNow, orderBy.toISOString().slice(0, 10) <= today.toISOString().slice(0, 10));
});

test('plans validate input and toggle', async () => {
  const bad = await api('/api/plans', { method: 'POST', body: JSON.stringify({ name: 'x', dayOfWeek: 9, budget: 60 }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'INVALID_INPUT');
  const { status, data } = await api('/api/plans', { method: 'POST', body: JSON.stringify({ name: 'Weekly restock — Monday', dayOfWeek: 1, budget: 60 }) });
  assert.equal(status, 201);
  assert.ok(data.id);
  assert.ok(data.nextRun);
  assert.equal(data.active, true);
  const list = await api('/api/plans');
  assert.ok(list.data.some((p) => p.id === data.id));
  const off = await api(`/api/plans/${encodeURIComponent(data.id)}/toggle`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(off.data.active, false);
  const run = await api(`/api/plans/${encodeURIComponent(data.id)}/run`, { method: 'POST', body: JSON.stringify({ session: 'test-unit' }) });
  assert.equal(run.status, 400);
  assert.equal(run.data.error, 'PLAN_INACTIVE');
  const on = await api(`/api/plans/${encodeURIComponent(data.id)}/toggle`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(on.data.active, true);
  const gone = await api(`/api/plans/${encodeURIComponent(data.id)}`, { method: 'DELETE' });
  assert.equal(gone.status, 200);
});

test('forecast endpoint lists all products', async () => {
  const { status, data } = await api('/api/forecast');
  assert.equal(status, 200);
  assert.equal(data.length, 8);
  assert.ok(data.find((r) => r.id === 'matcha').stockoutDate);
});

test('agent answers the forecast question', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'When will I run out of matcha?' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /Matcha|matcha/);
  assert.match(data.reply, /runs out/);
});

test('agent says no plan when asked to run with none', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-noplan', message: 'Run my weekly restock' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /No active restock plan/);
});

test('agent sets up a weekly restock plan', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'Set up a weekly restock every Monday under $60' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /Monday/);
  assert.match(data.reply, /Next run/);
  const list = await api('/api/plans');
  assert.ok(list.data.some((p) => p.name.includes('Monday')));
});

test('waste endpoint starts empty', async () => {
  const { status, data } = await api('/api/waste');
  assert.equal(status, 200);
  assert.equal(data.events.length, 0);
  assert.equal(data.totalCost, 0);
});

test('adjust endpoint validates input and sets stock', async () => {
  const bad = await api('/api/inventory/oat-milk/adjust', { method: 'POST', body: JSON.stringify({ stock: -1 }) });
  assert.equal(bad.status, 400);
  const gone = await api('/api/inventory/nope/adjust', { method: 'POST', body: JSON.stringify({ stock: 5 }) });
  assert.equal(gone.status, 404);
  const { status, data } = await api('/api/inventory/oat-milk/adjust', { method: 'POST', body: JSON.stringify({ stock: 16 }) });
  assert.equal(status, 200);
  assert.equal(data.stock, 16);
  assert.equal(data.excess, 4);
  assert.equal(data.wasteRisk, true);
});

test('overstocked perishable spoils on simulate-day', async () => {
  // Oat-milk is at 16 (max 12) from the adjust test above.
  // v10: one spoiled oat-milk carton costs $6.39 (Blue Bottle seed price).
  const { status, data } = await api('/api/inventory/simulate-day', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(status, 200);
  assert.equal(data.spoiled.length, 1);
  assert.equal(data.spoiled[0].id, 'oat-milk');
  assert.equal(data.spoiled[0].qty, 1);
  assert.equal(data.spoiled[0].cost, 6.39);
  const w = await api('/api/waste');
  assert.equal(w.data.totalCost, 6.39);
  assert.equal(w.data.totalQty, 1);
  const inv = await api('/api/inventory');
  const oat = inv.data.find((r) => r.id === 'oat-milk');
  assert.equal(oat.stock, 13.8);
});

test('agent answers the waste question', async () => {
  const { status, data } = await api('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ session: 'test-unit', message: 'How much am I wasting?' }),
  });
  assert.equal(status, 200);
  assert.match(data.reply, /\$6\.39/);
  assert.match(data.reply, /Overstocked/);
});

test('smart restock never buys above max stock', async () => {
  // Self-contained: reset to seed first, so earlier tests that simulated
  // days away cannot change the outcome.
  await api('/api/demo/reset', { method: 'POST', body: JSON.stringify({}) });
  const { smartRestockPlan } = require('./server');
  // Matcha burn target is ceil(0.3 x (4+7)) = 4, but its max stock is 3:
  // the ceiling binds, so the plan buys 3 - 1 = 2 (not 3).
  const { plan } = smartRestockPlan(1000);
  const matcha = plan.find((i) => i.id === 'matcha');
  assert.ok(matcha);
  assert.equal(matcha.qty, 2);
  // Oat-milk above its max of 12 is skipped entirely.
  await api('/api/inventory/oat-milk/adjust', { method: 'POST', body: JSON.stringify({ stock: 16 }) });
  const { plan: plan2 } = smartRestockPlan(1000);
  assert.ok(!plan2.some((i) => i.id === 'oat-milk'));
});

test('savingsSummary reports zero with no captured orders', () => {
  const { savingsSummary } = require('./server');
  assert.deepEqual(savingsSummary(), { capturedOrders: 0, totalSaved: 0, preventedStockouts: 0 });
});

test('check_savings tool is registered for the LLM', () => {
  const { llmTools } = require('./server');
  const tool = llmTools.find((t) => t.function.name === 'check_savings');
  assert.ok(tool);
  assert.match(tool.function.description, /saved/);
});

test('v7 subscription tools are registered for the LLM', () => {
  const { llmTools } = require('./server');
  for (const name of ['create_subscription', 'check_subscriptions', 'cancel_subscription', 'fulfill_subscription']) {
    assert.ok(llmTools.find((t) => t.function.name === name), `${name} missing`);
  }
});

test('subscriptionView formats a stored subscription', () => {
  const { subscriptionView } = require('./server');
  const v = subscriptionView('I-TEST1', { planId: 'P-X', amount: 56, status: 'APPROVAL_PENDING', boxItems: [{ name: 'Ceremonial Matcha · 500g', qty: 2 }], createdAt: '2026-11-05T00:00:00.000Z', lastFulfilledAt: null, nextBillingDate: null });
  assert.equal(v.id, 'I-TEST1');
  assert.equal(v.amount, 56);
  assert.equal(v.status, 'APPROVAL_PENDING');
  assert.equal(v.box.length, 1);
  assert.equal(v.nextBillingDate, null);
});

test('subscriptions list starts empty; bad budget rejected; unknown ids 404', async () => {
  const list = await api('/api/subscriptions');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data, []);
  const bad = await api('/api/subscriptions', { method: 'POST', body: JSON.stringify({ budget: -5 }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'INVALID_INPUT');
  for (const action of ['refresh', 'cancel', 'suspend', 'activate', 'fulfill']) {
    const r = await api(`/api/subscriptions/I-NOPE/${action}`, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(r.status, 404, action);
  }
});

test('agent reports no subscriptions when none exist', async () => {
  const { data } = await api('/api/agent', { method: 'POST', body: JSON.stringify({ session: 'test-subs', message: 'What subscriptions do I have?' }) });
  assert.match(data.reply, /No subscriptions yet/);
});

test('v8 check_recent_events tool is registered for the LLM', () => {
  const { llmTools } = require('./server');
  assert.ok(llmTools.find((t) => t.function.name === 'check_recent_events'));
});

test('routeWebhookEvent maps every PayPal event type', () => {
  const { routeWebhookEvent } = require('./server');
  const sub = { event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-X', status: 'ACTIVE', billing_info: { next_billing_time: '2026-11-12T00:00:00Z' } } };
  assert.deepEqual(routeWebhookEvent(sub), { kind: 'subscription', id: 'I-X', status: 'ACTIVE', nextBillingDate: '2026-11-12T00:00:00Z', summary: 'Subscription I-X → ACTIVE' });
  assert.equal(routeWebhookEvent({ event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: 'I-X', status: 'CANCELLED' } }).status, 'CANCELLED');
  assert.equal(routeWebhookEvent({ event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', resource: { id: 'I-X' } }).kind, 'subscription-payment-failed');
  assert.equal(routeWebhookEvent({ event_type: 'INVOICING.INVOICE.PAID', resource: { id: 'INV2-A' } }).kind, 'invoice-paid');
  assert.equal(routeWebhookEvent({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: '9SH1' } }).kind, 'order-approved');
  assert.equal(routeWebhookEvent({ event_type: 'CHECKOUT.ORDER.COMPLETED', resource: { id: '9SH1' } }).kind, 'order-completed');
  assert.equal(routeWebhookEvent({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'S-1', billing_agreement_id: 'I-X' } }).subscriptionId, 'I-X');
  assert.equal(routeWebhookEvent({ event_type: 'SOMETHING.ELSE', resource: {} }).kind, 'unknown');
});

test('webhook endpoint rejects unsigned and invalid events; list starts empty', async () => {
  const list = await api('/api/webhook-events');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data, []);
  const noSig = await api('/api/webhooks/paypal', { method: 'POST', body: JSON.stringify({ id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-X' } }) });
  assert.equal(noSig.status, 401);
  assert.equal(noSig.data.error, 'MISSING_SIGNATURE');
  const bad = await api('/api/webhooks/paypal', { method: 'POST', body: JSON.stringify({ hello: 'world' }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'INVALID_EVENT');
});

test('agent reports no webhook events when none arrived', async () => {
  const { data } = await api('/api/agent', { method: 'POST', body: JSON.stringify({ session: 'test-wh', message: 'Any new payments?' }) });
  assert.match(data.reply, /No PayPal webhook events have arrived yet/);
});

test('v9 revise_subscription tool is registered for the LLM', () => {
  const { llmTools } = require('./server');
  assert.ok(llmTools.find((t) => t.function.name === 'revise_subscription'));
  assert.equal(llmTools.length, 25);
});

test('v10 price-drop, overdue and remind tools are registered for the LLM', () => {
  const { llmTools } = require('./server');
  for (const name of ['check_price_drops', 'check_overdue_invoices', 'remind_invoice']) {
    assert.ok(llmTools.find((t) => t.function.name === name), `${name} missing`);
  }
});

test('overdueInvoices flags SENT invoices past their due date (v10)', () => {
  const { overdueInvoices } = require('./server');
  const list = [
    { invoiceId: 'INV2-OLD', status: 'SENT', dueDate: '2026-10-20', total: 40.50 },
    { invoiceId: 'INV2-NEW', status: 'SENT', dueDate: '2026-12-01', total: 10 },
    { invoiceId: 'INV2-DRAFT', status: 'DRAFT', dueDate: '2026-10-01', total: 5 },
    { invoiceId: 'INV2-PAID', status: 'PAID', dueDate: '2026-10-01', total: 5 },
  ];
  const overdue = overdueInvoices(list, '2026-11-05');
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].invoiceId, 'INV2-OLD');
  assert.equal(overdue[0].daysOverdue, 16);
});

test('remind endpoint validates unknown ids and non-SENT invoices (v10)', async () => {
  const missing = await api('/api/invoices/inv-NOPE/remind', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error, 'NOT_FOUND');
  // Seed a DRAFT invoice straight into the in-memory map (no PayPal call):
  // the route must reject it before any PayPal call.
  const { invoices } = require('./server');
  invoices.set('inv-INV2-DRAFT1', { orderId: 'TEST', invoiceId: 'INV2-DRAFT1', status: 'DRAFT', recipient: 'a@b.co', total: 10, createdAt: '2026-11-05T00:00:00.000Z', invoiceUrl: '', dueDate: '2026-12-05', lastRemindedAt: null });
  const draft = await api('/api/invoices/inv-INV2-DRAFT1/remind', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(draft.status, 400);
  assert.equal(draft.data.error, 'INVOICE_NOT_SENT');
});

test('agent reports nothing overdue when no invoice is past due (v10)', async () => {
  const { data } = await api('/api/agent', { method: 'POST', body: JSON.stringify({ session: 'test-unit', message: 'What is overdue?' }) });
  assert.match(data.reply, /Nothing is overdue/);
});

test('agent remind intent reports no SENT invoice when none exists (v10)', async () => {
  const { data } = await api('/api/agent', { method: 'POST', body: JSON.stringify({ session: 'test-unit', message: 'Remind the customer about the invoice' }) });
  assert.match(data.reply, /No SENT invoice to remind/);
});

test('revise endpoint validates input and unknown subscriptions', async () => {
  const bad = await api('/api/subscriptions/I-NOPE/revise', { method: 'POST', body: JSON.stringify({ amount: -5 }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'INVALID_INPUT');
  const missing = await api('/api/subscriptions/I-NOPE/revise', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error, 'NOT_FOUND');
});

test('agent revise intent reports no ACTIVE subscription when none exist', async () => {
  const { data } = await api('/api/agent', { method: 'POST', body: JSON.stringify({ session: 'test-revise', message: 'Revise my subscription' }) });
  assert.match(data.reply, /No ACTIVE subscription to revise/);
});

test('demo reset restores seed stock and clears waste', async () => {
  const { status, data } = await api('/api/demo/reset', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(status, 200);
  const oat = data.inventory.find((r) => r.id === 'oat-milk');
  assert.equal(oat.stock, 8);
  assert.equal(data.waste.events.length, 0);
  assert.equal(data.waste.totalCost, 0);
});

test('simulate-day lowers stock', async () => {
  const before = await api('/api/inventory');
  const totalBefore = before.data.reduce((s, r) => s + r.stock, 0);
  const { status } = await api('/api/inventory/simulate-day', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(status, 200);
  const after = await api('/api/inventory');
  const totalAfter = after.data.reduce((s, r) => s + r.stock, 0);
  assert.ok(totalAfter < totalBefore);
});

/* ---- v11 group buying ---- */
test('v11 group tiers: 0/9 no discount, 10–24 → 5%, 25+ → 10%', () => {
  const { groupTier } = require('./server');
  assert.deepEqual(groupTier(0), { tier: 0, minQty: 0, discountPct: 0 });
  assert.equal(groupTier(9).discountPct, 0);
  assert.equal(groupTier(10).discountPct, 5);
  assert.equal(groupTier(10).tier, 1);
  assert.equal(groupTier(24).discountPct, 5);
  assert.equal(groupTier(25).discountPct, 10);
  assert.equal(groupTier(25).tier, 2);
  assert.equal(groupTier(100).discountPct, 10);
});

test('v11 seed group deals: matcha pooled 25 → Tier 2, oat milk pooled 20 → Tier 1', async () => {
  const { status, data } = await api('/api/groups');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data) && data.length >= 2);
  const matcha = data.find((d) => d.itemId === 'matcha');
  const oat = data.find((d) => d.itemId === 'oat-milk');
  assert.equal(matcha.pooledQty, 25);
  assert.equal(matcha.tier, 2);
  assert.equal(matcha.unitPrice, 36.45); // 40.50 × 0.90
  assert.equal(matcha.savings, 101.25); // (40.50 − 36.45) × 25
  assert.equal(matcha.memberCount, 3);
  assert.equal(oat.pooledQty, 20);
  assert.equal(oat.tier, 1);
  assert.equal(oat.unitPrice, 5.69); // 5.99 × 0.95
  assert.equal(oat.savings, 6.00);
  const ourShare = matcha.shares.find((s) => s.cafe === 'Blue Bottle Coffee — Hayes Valley');
  assert.equal(ourShare.qty, 6);
  assert.equal(ourShare.amount, 218.70); // 6 × 36.45
});

test('v11 create + join buying group via API', async () => {
  const created = await api('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'East Bay Roasters', city: 'Oakland', focus: 'beans' }) });
  assert.equal(created.status, 201);
  assert.ok(created.data.id.startsWith('grp-'));
  assert.deepEqual(created.data.members, ['Blue Bottle Coffee — Hayes Valley']);
  const joined = await api(`/api/groups/${encodeURIComponent(created.data.id)}/join`, { method: 'POST', body: JSON.stringify({ cafeName: 'Timeless Coffee', items: [{ itemId: 'matcha', qty: 4 }] }) });
  assert.equal(joined.status, 200);
  assert.ok(joined.data.members.includes('Timeless Coffee'));
  const deals = await api('/api/groups');
  const deal = deals.data.find((d) => d.groupId === created.data.id && d.itemId === 'matcha');
  assert.ok(deal);
  assert.equal(deal.pooledQty, 4);
  assert.equal(deal.tier, 0);
  const missing = await api('/api/groups/grp-nope/join', { method: 'POST', body: JSON.stringify({ cafeName: 'X' }) });
  assert.equal(missing.status, 404);
  const bad = await api(`/api/groups/${encodeURIComponent(created.data.id)}/join`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(bad.status, 400);
});

test('v11 group order validation does not hit PayPal', async () => {
  const noGroup = await api('/api/groups/grp-nope/order', { method: 'POST', body: JSON.stringify({ itemId: 'matcha' }) });
  assert.equal(noGroup.status, 404);
  const badItem = await api('/api/groups/grp-bay-area/order', { method: 'POST', body: JSON.stringify({ itemId: 'nope' }) });
  assert.equal(badItem.status, 400);
  const noIntent = await api('/api/groups/grp-bay-area/order', { method: 'POST', body: JSON.stringify({ itemId: 'barista-scale' }) });
  assert.equal(noIntent.status, 400);
  assert.equal(noIntent.data.error, 'NO_POOLED_QTY');
});

test('v11 group-buying tools are registered for the LLM', () => {
  const { llmTools } = require('./server');
  for (const name of ['create_buying_group', 'join_buying_group', 'check_group_deals', 'place_group_order']) {
    assert.ok(llmTools.find((t) => t.function.name === name), `${name} missing`);
  }
  assert.equal(llmTools.length, 25);
});

test('v11 agent group-deals intent reports pooled qty, tier and savings', async () => {
  const { data } = await api('/api/agent', { method: 'POST', body: JSON.stringify({ session: 'test-group', message: 'What are the group deals?' }) });
  assert.match(data.reply, /Tier 2/);
  assert.match(data.reply, /25/);
  assert.match(data.reply, /101\.25/);
});

test('v11 agent create + join group intents work end to end', async () => {
  const { data: created } = await api('/api/agent', { method: 'POST', body: JSON.stringify({ session: 'test-group2', message: 'Create a buying group called Test Roasters' }) });
  assert.match(created.reply, /Test Roasters/);
  const { data: joined } = await api('/api/agent', { method: 'POST', body: JSON.stringify({ session: 'test-group2', message: 'Join the buying group as Timeless Coffee with 10 matcha' }) });
  assert.match(joined.reply, /Timeless Coffee/);
  assert.match(joined.reply, /Tier 1/);
});

test('v11 completeGroupOrder splits payables per café and stocks only our share', () => {
  const { completeGroupOrder, createBuyingGroup, joinBuyingGroup, groupOrders, payables, inventoryView } = require('./server');
  // A dedicated group (not the seed group — earlier tests may have joined it).
  const g = createBuyingGroup({ name: 'Test Group', city: 'Test City', focus: 'matcha' });
  joinBuyingGroup(g.id, 'Philz Coffee — Mission', [{ itemId: 'matcha', qty: 10 }]);
  joinBuyingGroup(g.id, 'Sightglass Coffee — SoMa', [{ itemId: 'matcha', qty: 9 }]);
  joinBuyingGroup(g.id, 'Blue Bottle Coffee — Hayes Valley', [{ itemId: 'matcha', qty: 6 }]);
  // A fake CREATED group order, as if PayPal had issued it.
  const id = 'TEST-GROUP-ORDER-1';
  groupOrders.set(id, { groupId: g.id, itemId: 'matcha', pooledQty: 25, tier: 2, unitPrice: 36.45, status: 'CREATED', createdAt: new Date().toISOString(), expectedDelivery: '2026-11-10' });
  const before = inventoryView().find((r) => r.id === 'matcha').stock;
  const out = completeGroupOrder(id);
  assert.ok(out);
  assert.equal(out.ourShareQty, 6);
  assert.equal(out.payables.length, 3);
  const ours = out.payables.find((p) => p.cafeName === 'Blue Bottle Coffee — Hayes Valley');
  assert.equal(ours.amount, 218.70);
  assert.equal(ours.supplier, 'Kyoto Tea Imports');
  assert.ok(payables.has(ours.id));
  const after = inventoryView().find((r) => r.id === 'matcha').stock;
  assert.equal(after, before + 6); // only OUR share, not the pooled 25
  assert.equal(completeGroupOrder(id), null); // idempotent — second call is a no-op
});

test('v11 demo reset restores the seed group intents', async () => {
  const { status } = await api('/api/demo/reset', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(status, 200);
  const { data } = await api('/api/groups');
  const matcha = data.find((d) => d.itemId === 'matcha' && d.groupId === 'grp-bay-area');
  assert.equal(matcha.pooledQty, 25);
  assert.equal(matcha.tier, 2);
});
