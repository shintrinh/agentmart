'use strict';
const money = (n) => `$${Number(n).toFixed(2)}`;
async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

let ordersGridApi;
let invoicesGridApi;
let inventoryGridApi;
let pricesGridApi;
let payablesGridApi;
let forecastGridApi;

async function loadForecast() {
  const { data } = await api('/api/forecast');
  const rows = Array.isArray(data) ? data : [];
  if (forecastGridApi) forecastGridApi.setGridOption('rowData', rows.map((r) => ({
    name: r.name,
    stock: r.stock,
    daysLeft: r.daysLeft,
    status: r.status,
    stockoutDate: r.stockoutDate || '—',
    orderByDate: r.orderByDate || '—',
    orderNow: r.orderNow ? 'Yes — order now' : '—',
  })));
  return rows;
}

async function loadPlans() {
  const { data } = await api('/api/plans');
  const list = Array.isArray(data) ? data : [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  document.getElementById('plansList').innerHTML = list.length ? list.map((p) => `
    <div class="order-row">
      <strong>${p.name}</strong>
      <span>Every ${dayNames[p.dayOfWeek]} · budget ${money(p.budget)}</span>
      <span>Next run: ${p.nextRun}</span>
      <span>${p.lastRunAt ? `Last run: ${p.lastRunAt.slice(0, 10)}` : 'Never run'}</span>
      <span class="stock ${p.active ? 'stock-ok' : 'stock-low'}">${p.active ? 'Active' : 'Paused'}</span>
      <button class="add-btn" data-plan-run="${p.id}">Run now</button>
      <button class="add-btn" data-plan-toggle="${p.id}">${p.active ? 'Pause' : 'Activate'}</button>
      <button class="add-btn" data-plan-del="${p.id}">Delete</button>
    </div>`).join('') : '<p class="empty">No restock plan yet. Create one below, or ask the agent: "set up a weekly restock every Monday under $60".</p>';
  document.querySelectorAll('[data-plan-run]').forEach((b) => b.addEventListener('click', async () => {
    const msg = document.getElementById('planMsg');
    msg.textContent = 'Running plan…';
    const { ok, data } = await api(`/api/plans/${encodeURIComponent(b.dataset.planRun)}/run`, { method: 'POST', body: JSON.stringify({ session: 'dashboard' }) });
    msg.textContent = ok ? (data.orderId ? `Plan ran — PayPal order ${data.orderId} for ${money(data.total)}.` : (data.reply || 'Plan ran — nothing needed restocking.')) : (data.message || 'Could not run the plan.');
    if (ok) loadAll();
  }));
  document.querySelectorAll('[data-plan-toggle]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/plans/${encodeURIComponent(b.dataset.planToggle)}/toggle`, { method: 'POST', body: JSON.stringify({}) });
    loadPlans();
  }));
  document.querySelectorAll('[data-plan-del]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/plans/${encodeURIComponent(b.dataset.planDel)}`, { method: 'DELETE' });
    loadPlans();
  }));
  return list;
}

async function loadPayables() {
  const { data } = await api('/api/payables');
  const rows = Array.isArray(data) ? data : [];
  const unpaid = rows.filter((r) => r.status === 'UNPAID');
  const totalUnpaid = unpaid.reduce((s, r) => s + Number(r.amount || 0), 0);
  const overdue = unpaid.filter((r) => r.overdue);
  document.getElementById('payablesSummary').innerHTML = unpaid.length
    ? `Unpaid: <strong>${money(totalUnpaid)}</strong> across ${unpaid.length} payable(s)${overdue.length ? ` — <strong>${overdue.length} overdue ⚠️</strong>` : ''}.`
    : 'Nothing owed — all payables are paid.';
  if (payablesGridApi) payablesGridApi.setGridOption('rowData', rows);
  return rows;
}

async function loadPrices() {
  const { data } = await api('/api/prices');
  const rows = Array.isArray(data) ? data : [];
  const creep = rows.filter((r) => r.creep);
  const drops = rows.filter((r) => r.drop);
  const alerts = [];
  if (creep.length) alerts.push(`<div class="alert">⚠️ Price creep (&gt;5% in 3 months, demo history Aug–Nov 2026): ${creep.map((r) => `${r.name} +${r.changePct3mo}%`).join('; ')}. Smart restock buys from the cheaper alternate supplier where one exists.</div>`);
  if (drops.length) alerts.push(`<div class="alert">📉 Price drops (&gt;5% down in 3 months): ${drops.map((r) => `${r.name} ${r.changePct3mo}%`).join('; ')}. A falling price is a good time to stock up — smart restock already buys at the current lower price.</div>`);
  document.getElementById('priceAlert').innerHTML = alerts.join('');
  if (pricesGridApi) pricesGridApi.setGridOption('rowData', rows.map((r) => ({
    name: r.name,
    current: r.current,
    threeMonthsAgo: r.threeMonthsAgo,
    changePct3mo: r.changePct3mo,
    changePct1mo: r.changePct1mo,
    supplier: `${r.supplier} — ${money(r.current)}`,
    altSupplier: r.altSupplier ? `${r.altSupplier.name} — ${money(r.altSupplier.price)} (${r.altSupplier.leadTimeDays}d)` : '—',
    best: `${r.bestSupplier} — ${money(r.bestPrice)}${r.bestIsAlt ? ' ✓ cheaper' : ''}`,
  })));
  return rows;
}

function renderStats(orders) {
  const completed = orders.filter((o) => o.status === 'COMPLETED');
  const total = completed.reduce((s, o) => s + Number(o.total || 0), 0);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthTotal = completed.filter((o) => (o.createdAt || '').slice(0, 7) === thisMonth).reduce((s, o) => s + Number(o.total || 0), 0);
  const byTag = {};
  for (const o of completed) for (const i of (o.items || [])) byTag[i.name] = (byTag[i.name] || 0) + Number(i.price) * Number(i.qty);
  const topItem = Object.entries(byTag).sort((a, b) => b[1] - a[1])[0];
  const saved = completed.reduce((s, o) => s + Number(o.saved || 0), 0);
  const prevented = completed.reduce((s, o) => s + Number(o.preventedStockouts || 0), 0);
  document.getElementById('stats').innerHTML = `
    <div class="stat"><strong>${orders.length}</strong><span>orders</span></div>
    <div class="stat"><strong>${completed.length}</strong><span>captured</span></div>
    <div class="stat"><strong>${money(total)}</strong><span>captured revenue (sandbox)</span></div>
    <div class="stat"><strong>${money(monthTotal)}</strong><span>spend this month</span></div>
    <div class="stat"><strong>${orders.filter((o) => o.status === 'CREATED').length}</strong><span>awaiting approval</span></div>
    <div class="stat"><strong>${topItem ? topItem[0].split('·')[0].trim() : '—'}</strong><span>top item by spend${topItem ? ` (${money(topItem[1])})` : ''}</span></div>
    <div class="stat"><strong>${money(saved)}</strong><span>saved by cheaper suppliers</span></div>
    <div class="stat"><strong>${prevented}</strong><span>stock-outs prevented</span></div>`;
}

async function loadInventory() {
  const { data } = await api('/api/inventory');
  const rows = Array.isArray(data) ? data : [];
  const low = rows.filter((r) => r.status !== 'OK');
  const over = rows.filter((r) => r.wasteRisk);
  document.getElementById('lowStockAlert').innerHTML = low.length
    ? `<div class="alert">⚠️ Low stock: ${low.map((r) => `${r.name} — ${r.stock} left, ~${r.daysLeft} days`).join('; ')}. Ask the agent for a smart restock.</div>`
    : '';
  document.getElementById('overstockAlert').innerHTML = over.length
    ? `<div class="alert">⚠️ Overstocked: ${over.map((r) => `${r.name} — ${r.stock} on hand, max ${r.maxStock} (${r.excess} excess)`).join('; ')}. The excess spoils a little every simulated day.</div>`
    : '';
  if (inventoryGridApi) inventoryGridApi.setGridOption('rowData', rows);
  return rows;
}

let wasteGridApi;
async function loadWaste() {
  const { data } = await api('/api/waste');
  const w = data || { events: [], totalQty: 0, totalCost: 0 };
  document.getElementById('wasteStats').innerHTML = `
    <div class="stat"><strong>${money(w.totalCost)}</strong><span>wasted so far</span></div>
    <div class="stat"><strong>${w.totalQty}</strong><span>units spoiled</span></div>
    <div class="stat"><strong>${w.events.length}</strong><span>waste events</span></div>`;
  if (wasteGridApi) wasteGridApi.setGridOption('rowData', w.events.map((e) => ({
    name: e.name, qty: e.qty, cost: Number(e.cost), wastedAt: e.wastedAt,
  })));
  return w;
}

let subsGridApi;
async function loadSubscriptions() {
  const { data } = await api('/api/subscriptions');
  const list = Array.isArray(data) ? data : [];
  if (subsGridApi) subsGridApi.setGridOption('rowData', list.map((s) => ({ ...s, box: s.box.map((i) => `${i.qty}× ${i.name}`).join(', '), nextBilling: s.nextBillingDate ? s.nextBillingDate.slice(0, 10) : '—', lastFulfilled: s.lastFulfilledAt ? s.lastFulfilledAt.slice(0, 10) : '—' })));
  return list;
}

let webhookGridApi;
async function loadWebhookEvents() {
  const { data } = await api('/api/webhook-events');
  const list = Array.isArray(data) ? data : [];
  if (webhookGridApi) webhookGridApi.setGridOption('rowData', list.map((e) => ({ ...e, receivedAt: e.receivedAt.slice(0, 19).replace('T', ' '), handled: e.handled ? 'handled' : 'logged' })));
  return list;
}

async function loadAll() {
  const { data: orders } = await api('/api/orders');
  const list = Array.isArray(orders) ? orders : [];
  renderStats(list);
  const rows = list.map((o) => ({
    id: o.id,
    status: o.status,
    total: Number(o.total),
    items: (o.items || []).map((i) => `${i.qty}× ${i.name}${i.supplier ? ` (${i.supplier})` : ''}`).join(', '),
    expectedDelivery: o.expectedDelivery || '—',
    createdAt: o.createdAt,
  }));
  if (ordersGridApi) ordersGridApi.setGridOption('rowData', rows);
  const { data: invoices } = await api('/api/invoices');
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const invRows = (Array.isArray(invoices) ? invoices : []).map((v) => ({
    id: v.id, invoiceId: v.invoiceId, orderId: v.orderId, status: v.status, recipient: v.recipient, total: Number(v.total), createdAt: v.createdAt,
    dueDate: v.dueDate || '—',
    overdue: v.status === 'SENT' && v.dueDate && v.dueDate < today ? 'Yes — overdue' : '—',
    lastReminded: v.lastRemindedAt ? v.lastRemindedAt.slice(0, 19).replace('T', ' ') : '—',
    followUp: v.status === 'SENT' && now - new Date(v.createdAt).getTime() > 7 * 86400000 ? 'Yes — follow up' : '—',
  }));
  const overdueInv = invRows.filter((r) => r.overdue !== '—');
  document.getElementById('overdueAlert').innerHTML = overdueInv.length
    ? `<div class="alert">⏰ Overdue invoices: ${overdueInv.map((r) => `${r.invoiceId} — ${money(r.total)}, due ${r.dueDate}`).join('; ')}. Send a reminder from the grid or ask the agent.</div>`
    : '';
  if (invoicesGridApi) invoicesGridApi.setGridOption('rowData', invRows);
  await loadInventory();
  await loadPrices();
  await loadPayables();
  await loadForecast();
  await loadPlans();
  await loadWaste();
  await loadSubscriptions();
  await loadWebhookEvents();
}

document.getElementById('adjustForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('adjustMsg');
  const id = document.getElementById('adjustProduct').value;
  const stock = Number(document.getElementById('adjustStock').value);
  const { ok, data } = await api(`/api/inventory/${encodeURIComponent(id)}/adjust`, { method: 'POST', body: JSON.stringify({ stock }) });
  msg.textContent = ok ? `Stock for ${data.name} set to ${data.stock}.` : 'Could not adjust stock.';
  if (ok) { loadInventory(); loadWaste(); }
});

document.getElementById('resetDemoBtn').addEventListener('click', async () => {
  if (!window.confirm('Reset the demo to its seed state? Stock returns to seed values, waste and carts are cleared. Orders, payables and plans are kept.')) return;
  const msg = document.getElementById('resetDemoMsg');
  const { ok } = await api('/api/demo/reset', { method: 'POST', body: JSON.stringify({}) });
  msg.textContent = ok ? 'Demo reset to seed state.' : 'Could not reset the demo.';
  if (ok) loadAll();
});

document.getElementById('planForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('planMsg');
  const name = document.getElementById('planName').value.trim();
  const dayOfWeek = Number(document.getElementById('planDay').value);
  const budget = Number(document.getElementById('planBudget').value);
  const { ok, data } = await api('/api/plans', { method: 'POST', body: JSON.stringify({ name, dayOfWeek, budget }) });
  msg.textContent = ok ? `Plan "${data.name}" created — next run ${data.nextRun}.` : (data.message || 'Could not create the plan.');
  if (ok) loadPlans();
});

document.getElementById('payPayableForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('payPayableMsg');
  const id = document.getElementById('payPayableId').value.trim();
  msg.textContent = 'Marking payable as paid…';
  const { ok, data } = await api(`/api/payables/${encodeURIComponent(id)}/pay`, { method: 'POST', body: JSON.stringify({}) });
  msg.textContent = ok ? `Payable ${id} marked PAID (${data.supplier}, ${money(data.amount)}).` : (data.message || 'Could not mark the payable as paid.');
  if (ok) loadPayables();
});

document.getElementById('simDayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('simDayMsg');
  msg.textContent = 'Simulating one day of sales…';
  const { ok, data } = await api('/api/inventory/simulate-day', { method: 'POST', body: JSON.stringify({}) });
  if (ok) {
    const rows = Array.isArray(data) ? data : (data.inventory || []);
    const low = rows.filter((r) => r.status !== 'OK');
    const spoiled = data.spoiled || [];
    msg.textContent = `One day simulated. ${low.length ? `Now low: ${low.map((r) => r.name).join(', ')}.` : 'Stock still healthy.'}${spoiled.length ? ` Spoiled: ${spoiled.map((s) => `${s.qty}× ${s.name} (${money(s.cost)})`).join(', ')}.` : ''}`;
    await loadInventory();
    await loadWaste();
  } else {
    msg.textContent = 'Could not simulate the day.';
  }
});

document.getElementById('sendInvoiceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('sendInvoiceMsg');
  const invoiceId = document.getElementById('sendInvoiceId').value.trim();
  msg.textContent = 'Sending invoice…';
  const inv = (await api('/api/invoices')).data || [];
  const rec = inv.find((v) => v.invoiceId === invoiceId || v.id === `inv-${invoiceId}`);
  if (!rec) { msg.textContent = 'Invoice not found in this dashboard.'; return; }
  const { ok, data } = await api(`/api/invoices/${encodeURIComponent(rec.id)}/send`, { method: 'POST', body: JSON.stringify({}) });
  msg.textContent = ok ? `Invoice ${invoiceId} sent (${data.status}).` : (data.message || 'Could not send the invoice.');
  if (ok) loadAll();
});

document.getElementById('refreshInvoicesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('refreshInvoicesMsg');
  msg.textContent = 'Refreshing invoice statuses from PayPal…';
  const inv = (await api('/api/invoices')).data || [];
  let done = 0; let failed = 0;
  for (const v of inv) {
    const r = await api(`/api/invoices/${encodeURIComponent(v.id)}/refresh`, { method: 'POST', body: JSON.stringify({}) });
    if (r.ok) done += 1; else failed += 1;
  }
  msg.textContent = `Refreshed ${done} invoice(s)${failed ? `, ${failed} failed` : ''}.`;
  if (done) loadAll();
});

document.getElementById('invoiceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('invoiceMsg');
  msg.textContent = 'Creating invoice…';
  const { ok, data } = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ orderId: document.getElementById('invoiceOrderId').value.trim(), recipientEmail: document.getElementById('invoiceEmail').value.trim() }),
  });
  msg.textContent = ok
    ? `Invoice ${data.invoiceId} created as ${data.status} for ${money(data.total)}.`
    : (data.message || 'Could not create the invoice.');
  if (ok) loadAll();
});

(async function init() {
  const cfg = await api('/api/config');
  const chip = document.getElementById('paypalStatus');
  chip.textContent = cfg.data.paypalConfigured ? `PayPal ${cfg.data.env}: connected ✓` : 'PayPal sandbox: not configured';
  chip.className = `chip ${cfg.data.paypalConfigured ? 'chip-ok' : 'chip-warn'}`;

  const ordersOptions = {
    columnDefs: [
      { field: 'id', headerName: 'Order id', filter: true, flex: 2 },
      { field: 'status', filter: true, flex: 1 },
      { field: 'total', headerName: 'Total (USD)', filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value), flex: 1 },
      { field: 'items', headerName: 'Items', filter: true, flex: 3 },
      { field: 'expectedDelivery', headerName: 'Expected delivery', filter: true, flex: 1 },
      { field: 'createdAt', headerName: 'Created', filter: true, flex: 1 },
    ],
    defaultColDef: { sortable: true, resizable: true },
    rowData: [],
  };
  ordersGridApi = agGrid.createGrid(document.getElementById('ordersGrid'), ordersOptions);

  const pricesOptions = {
    columnDefs: [
      { field: 'name', headerName: 'Product', filter: true, flex: 2 },
      { field: 'current', headerName: 'Now (USD)', filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value), flex: 1 },
      { field: 'threeMonthsAgo', headerName: '3 mo ago (USD)', filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value), flex: 1 },
      { field: 'changePct3mo', headerName: 'Change 3 mo (%)', filter: 'agNumberColumnFilter', flex: 1 },
      { field: 'changePct1mo', headerName: 'Change 1 mo (%)', filter: 'agNumberColumnFilter', flex: 1 },
      { field: 'supplier', headerName: 'Main supplier', filter: true, flex: 2 },
      { field: 'altSupplier', headerName: 'Alternate supplier', filter: true, flex: 2 },
      { field: 'best', headerName: 'Best buy', filter: true, flex: 2 },
    ],
    defaultColDef: { sortable: true, resizable: true },
    rowData: [],
  };
  pricesGridApi = agGrid.createGrid(document.getElementById('pricesGrid'), pricesOptions);

  const inventoryOptions = {
    columnDefs: [
      { field: 'name', headerName: 'Product', filter: true, flex: 2 },
      { field: 'supplier', filter: true, flex: 1 },
      { field: 'stock', headerName: 'Stock', filter: 'agNumberColumnFilter', flex: 1 },
      { field: 'dailyUse', headerName: 'Use / day', filter: 'agNumberColumnFilter', flex: 1 },
      { field: 'daysLeft', headerName: 'Days left', filter: 'agNumberColumnFilter', flex: 1 },
      { field: 'status', filter: true, flex: 1 },
      { field: 'reorderPoint', headerName: 'Reorder at', filter: 'agNumberColumnFilter', flex: 1 },
      { field: 'leadTimeDays', headerName: 'Lead (days)', filter: 'agNumberColumnFilter', flex: 1 },
      { field: 'maxStock', headerName: 'Max stock', filter: 'agNumberColumnFilter', flex: 1, valueFormatter: (p) => p.value == null ? '—' : p.value },
      { field: 'excess', headerName: 'Excess', filter: 'agNumberColumnFilter', flex: 1 },
    ],
    defaultColDef: { sortable: true, resizable: true },
    rowData: [],
  };
  inventoryGridApi = agGrid.createGrid(document.getElementById('inventoryGrid'), inventoryOptions);

  const wasteOptions = {
    columnDefs: [
      { field: 'name', headerName: 'Product', filter: true, flex: 2 },
      { field: 'qty', headerName: 'Units spoiled', filter: 'agNumberColumnFilter', flex: 1 },
      { field: 'cost', headerName: 'Cost (USD)', filter: 'agNumberColumnFilter', flex: 1, valueFormatter: (p) => money(Number(p.value || 0)) },
      { field: 'wastedAt', headerName: 'Date', filter: true, flex: 1 },
    ],
    defaultColDef: { sortable: true, resizable: true },
    rowData: [],
  };
  wasteGridApi = agGrid.createGrid(document.getElementById('wasteGrid'), wasteOptions);

  const forecastOptions = {
    columnDefs: [
      { field: 'name', headerName: 'Product', filter: true, flex: 2 },
      { field: 'stock', headerName: 'Stock', filter: 'agNumberColumnFilter', flex: 1 },
      { field: 'daysLeft', headerName: 'Days left', filter: 'agNumberColumnFilter', flex: 1 },
      { field: 'status', filter: true, flex: 1 },
      { field: 'stockoutDate', headerName: 'Runs out ~', filter: true, flex: 1 },
      { field: 'orderByDate', headerName: 'Order by', filter: true, flex: 1 },
      { field: 'orderNow', headerName: 'Order now?', filter: true, flex: 1 },
    ],
    defaultColDef: { sortable: true, resizable: true },
    rowData: [],
  };
  forecastGridApi = agGrid.createGrid(document.getElementById('forecastGrid'), forecastOptions);

  const payablesOptions = {
    columnDefs: [
      { field: 'id', headerName: 'Payable id', filter: true, flex: 2 },
      { field: 'supplier', filter: true, flex: 2 },
      { field: 'orderId', headerName: 'Order id', filter: true, flex: 2 },
      { field: 'amount', headerName: 'Amount (USD)', filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value), flex: 1 },
      { field: 'terms', filter: true, flex: 1 },
      { field: 'dueDate', headerName: 'Due', filter: true, flex: 1 },
      { field: 'status', filter: true, flex: 1 },
      { field: 'overdue', headerName: 'Overdue?', filter: true, flex: 1 },
    ],
    defaultColDef: { sortable: true, resizable: true },
    rowData: [],
  };
  payablesGridApi = agGrid.createGrid(document.getElementById('payablesGrid'), payablesOptions);

  const invoicesOptions = {
    columnDefs: [
      { field: 'invoiceId', headerName: 'Invoice id', filter: true, flex: 2 },
      { field: 'orderId', headerName: 'Order id', filter: true, flex: 2 },
      { field: 'status', filter: true, flex: 1 },
      { field: 'recipient', filter: true, flex: 2 },
      { field: 'total', headerName: 'Total (USD)', filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value), flex: 1 },
      { field: 'dueDate', headerName: 'Due', filter: true, flex: 1 },
      { field: 'overdue', headerName: 'Overdue?', filter: true, flex: 1 },
      { field: 'lastReminded', headerName: 'Last reminded', filter: true, flex: 1 },
      { field: 'followUp', headerName: 'Follow up?', filter: true, flex: 1 },
      {
        headerName: 'Actions', flex: 1,
        cellRenderer: (p) => (p.data.status === 'SENT'
          ? `<button class="add-btn" data-invoice-remind="${p.data.id}">Send reminder</button>`
          : ''),
      },
    ],
    defaultColDef: { sortable: true, resizable: true },
    rowData: [],
  };
  invoicesGridApi = agGrid.createGrid(document.getElementById('invoicesGrid'), invoicesOptions);

  const subsOptions = {
    columnDefs: [
      { field: 'id', headerName: 'Subscription id', filter: true, flex: 2 },
      { field: 'status', filter: true, flex: 1 },
      { field: 'amount', headerName: 'Per week (USD)', filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value), flex: 1 },
      { field: 'box', headerName: 'Box contents', filter: true, flex: 3 },
      { field: 'nextBilling', headerName: 'Next billing', filter: true, flex: 1 },
      { field: 'lastFulfilled', headerName: 'Last fulfilled', filter: true, flex: 1 },
      {
        headerName: 'Actions', flex: 2,
        cellRenderer: (p) => {
          const id = p.data.id;
          const acts = [['refresh', 'Refresh'], ['fulfill', 'Fulfill box']];
          if (p.data.status === 'ACTIVE') acts.push(['revise', 'Revise to current needs']);
          if (p.data.status === 'ACTIVE') acts.push(['suspend', 'Suspend']);
          if (p.data.status === 'SUSPENDED') acts.push(['activate', 'Activate']);
          if (p.data.status !== 'CANCELLED') acts.push(['cancel', 'Cancel']);
          return acts.map(([a, label]) => `<button class="add-btn" data-sub-action="${a}|${id}">${label}</button>`).join(' ');
        },
      },
    ],
    defaultColDef: { sortable: true, resizable: true },
    rowData: [],
  };
  subsGridApi = agGrid.createGrid(document.getElementById('subsGrid'), subsOptions);

  const webhookOptions = {
    columnDefs: [
      { field: 'eventType', headerName: 'Event', filter: true, flex: 2 },
      { field: 'resourceId', headerName: 'Resource id', filter: true, flex: 2 },
      { field: 'receivedAt', headerName: 'Received', filter: true, flex: 1 },
      { field: 'handled', filter: true, flex: 1 },
      { field: 'summary', filter: true, flex: 3 },
    ],
    defaultColDef: { sortable: true, resizable: true },
    rowData: [],
  };
  webhookGridApi = agGrid.createGrid(document.getElementById('webhookGrid'), webhookOptions);

  document.getElementById('subsGrid').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sub-action]');
    if (!b) return;
    const [action, id] = b.dataset.subAction.split('|');
    const msg = document.getElementById('subMsg');
    msg.textContent = `${action}…`;
    const { ok, data: out } = await api(`/api/subscriptions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify({}) });
    if (ok && action === 'revise') {
      if (!out.revised) msg.textContent = out.message;
      else if (out.needsApproval) msg.innerHTML = `Revision proposed: ${money(out.oldAmount)} → ${money(out.proposedAmount)}/week — <a href="${out.approveUrl}" target="_blank" rel="noopener">approve the price change on PayPal sandbox</a>.`;
      else msg.textContent = `Subscription revised: now ${money(out.newAmount)}/week (was ${money(out.oldAmount)}).`;
    } else {
      msg.textContent = ok ? (out.orderId ? `Fulfilled — PayPal order ${out.orderId} for ${money(out.total)}. Approve it on PayPal sandbox.` : `Subscription ${id} is now ${out.status || action + 'ed'}.`) : (out.message || 'Could not do that.');
    }
    if (ok) loadAll();
  });

  document.getElementById('invoicesGrid').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-invoice-remind]');
    if (!b) return;
    const msg = document.getElementById('refreshInvoicesMsg');
    msg.textContent = 'Sending reminder…';
    const { ok, data } = await api(`/api/invoices/${encodeURIComponent(b.dataset.invoiceRemind)}/remind`, { method: 'POST', body: JSON.stringify({}) });
    msg.textContent = ok ? `Reminder sent for invoice ${data.invoiceId}.` : (data.message || 'Could not send the reminder.');
    if (ok) loadAll();
  });

  document.getElementById('subForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('subMsg');
    const budget = Number(document.getElementById('subBudget').value);
    msg.textContent = 'Setting up the subscription…';
    const { ok, data } = await api('/api/subscriptions', { method: 'POST', body: JSON.stringify({ budget }) });
    if (!ok) { msg.textContent = data.message || 'Could not set up the subscription.'; return; }
    msg.innerHTML = `Subscription ${data.subscriptionId} created (${money(data.amount)}/week) — <a href="${data.approveUrl}" target="_blank" rel="noopener">approve it on PayPal sandbox</a>.`;
    if (ok) loadSubscriptions();
  });

  await loadAll();
})();
