'use strict';
const session = (() => {
  let s = localStorage.getItem('agentmart_session');
  if (!s) { s = 's-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('agentmart_session', s); }
  return s;
})();
const $ = (id) => document.getElementById(id);
const money = (n) => `$${Number(n).toFixed(2)}`;

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/* ------------------------------------------------------------------ catalog */
let allProducts = [];
let stockById = {};
async function loadProducts() {
  const { data } = await api('/api/products');
  allProducts = Array.isArray(data) ? data : [];
  const inv = await api('/api/inventory');
  if (Array.isArray(inv.data)) {
    stockById = {};
    for (const r of inv.data) stockById[r.id] = r;
  }
  renderProducts();
}
function stockBadge(p) {
  const r = stockById[p.id];
  if (!r) return '';
  if (r.status === 'OUT') return '<span class="stock stock-out">Out of stock</span>';
  if (r.status === 'LOW') return `<span class="stock stock-low">Low — ~${r.daysLeft} days left</span>`;
  return `<span class="stock stock-ok">In stock — ~${r.daysLeft} days</span>`;
}
function substituteHint(p) {
  const r = stockById[p.id];
  if (!r || r.status !== 'OUT' || !r.substitute) return '';
  const s = r.substitute;
  return `<p class="sub-hint">Out of stock — try ${s.emoji} ${s.name} (${money(s.price)}) instead:
    <button class="add-btn sub-btn" data-add="${s.id}">Add substitute</button></p>`;
}
function renderProducts() {
  const q = ($('searchInput').value || '').toLowerCase();
  const tag = $('tagFilter').value || '';
  const list = allProducts.filter((p) =>
    (!tag || p.tag === tag) &&
    (!q || `${p.name} ${p.tag} ${p.blurb}`.toLowerCase().includes(q)));
  $('grid').innerHTML = list.length ? list.map((p) => `
    <article class="card">
      <div class="card-emoji">${p.emoji}</div>
      <span class="tag">${p.tag}</span>
      <h3>${p.name}</h3>
      <p>${p.blurb}</p>
      ${stockBadge(p)}
      ${substituteHint(p)}
      <div class="card-foot">
        <span class="price">${money(p.price)}</span>
        <button class="add-btn" data-add="${p.id}">Add to cart</button>
      </div>
    </article>`).join('') : '<p class="empty">No products match that search.</p>';
  document.querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => addToCart(b.dataset.add, 1, b)));
}

/* -------------------------------------------------------------- my orders */
async function loadMyOrders() {
  const { data } = await api(`/api/orders?session=${encodeURIComponent(session)}`);
  const list = Array.isArray(data) ? data : [];
  $('myOrders').innerHTML = list.length ? list.map((o) => `
    <div class="order-row">
      <strong>${o.id}</strong>
      <span>${(o.items || []).map((i) => `${i.qty}× ${i.name}${i.supplier ? ` (${i.supplier})` : ''}`).join(', ')}</span>
      <span>${money(o.total)}</span>
      <span>${o.expectedDelivery ? `Delivery by ${o.expectedDelivery}` : ''}</span>
      <span class="stock ${o.status === 'COMPLETED' ? 'stock-ok' : 'stock-low'}">${o.status}</span>
    </div>`).join('') : '<p class="empty">No orders yet in this browser. Ask the agent to restock and approve the PayPal checkout.</p>';
}
async function reorderLast() {
  const { ok, data } = await api('/api/reorder-last', { method: 'POST', body: JSON.stringify({ session }) });
  if (ok && data.cart) { renderCart(data.cart); addMessage('Reordered your last order — the items are back in your cart. Say "checkout" and I will create the PayPal order.', 'agent'); }
  else addMessage('You have no previous order in this session yet.', 'agent');
}
$('searchInput').addEventListener('input', renderProducts);
$('tagFilter').addEventListener('change', renderProducts);

async function addToCart(productId, qty, btn) {
  const { data } = await api('/api/cart/add', { method: 'POST', body: JSON.stringify({ session, productId, qty }) });
  renderCart(data);
  if (btn) { btn.textContent = 'Added ✓'; setTimeout(() => (btn.textContent = 'Add to cart'), 900); }
}

async function setQty(productId, qty) {
  const { data } = await api('/api/cart/set', { method: 'POST', body: JSON.stringify({ session, productId, qty }) });
  renderCart(data);
}

/* --------------------------------------------------------------------- cart */
function renderCart(view) {
  if (!view) return;
  $('cartCount').textContent = view.count;
  $('cartTotal').textContent = money(view.total);
  $('cartItems').innerHTML = view.items.length
    ? view.items.map((i) => `
      <div class="cart-item">
        <span>${i.emoji} ${i.name}</span>
        <span class="qty">
          <button data-dec="${i.id}">−</button> ${i.qty} <button data-inc="${i.id}">+</button>
        </span>
        <strong>${money(i.lineTotal)}</strong>
      </div>`).join('')
    : '<p class="empty">Your cart is empty.</p>';
  document.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', () => {
    const it = view.items.find((i) => i.id === b.dataset.inc); setQty(b.dataset.inc, it.qty + 1);
  }));
  document.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', () => {
    const it = view.items.find((i) => i.id === b.dataset.dec); setQty(b.dataset.dec, it.qty - 1);
  }));
}

async function refreshCart() {
  const { data } = await api(`/api/cart?session=${encodeURIComponent(session)}`);
  renderCart(data);
}

$('cartBtn').addEventListener('click', () => $('drawer').classList.toggle('hidden'));
$('closeDrawer').addEventListener('click', () => $('drawer').classList.add('hidden'));

$('checkoutBtn').addEventListener('click', async () => {
  $('checkoutMsg').textContent = 'Creating your PayPal order…';
  const { ok, data } = await api('/api/paypal/create-order', { method: 'POST', body: JSON.stringify({ session }) });
  if (ok && data.approveUrl) { window.location.href = data.approveUrl; return; }
  $('checkoutMsg').textContent = data.message || 'Could not create the PayPal order. Is your cart empty?';
});

/* -------------------------------------------------------------------- agent */
// Render a chat message: escape HTML first, then render **bold** markers
// (the LLM's replies use markdown emphasis) as <strong> — no literal **.
function renderRich(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function addMessage(text, who, checkoutUrl) {
  const box = $('agentMessages');
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.innerHTML = renderRich(text);
  if (checkoutUrl) {
    const a = document.createElement('a');
    a.href = checkoutUrl; a.target = '_blank'; a.rel = 'noopener';
    a.className = 'pay-link'; a.textContent = 'Approve payment on PayPal →';
    div.appendChild(document.createElement('br')); div.appendChild(a);
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function sendToAgent(text) {
  addMessage(text, 'user');
  const { data } = await api('/api/agent', { method: 'POST', body: JSON.stringify({ session, message: text }) });
  const engine = data.engine ? `\n— answered by ${data.engine}` : '';
  addMessage((data.reply || '…') + engine, 'agent', data.checkoutUrl);
  if (data.cart) renderCart(data.cart);
  if (data.orderId) loadMyOrders();
}

$('agentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('agentInput').value.trim();
  if (!text) return;
  $('agentInput').value = '';
  sendToAgent(text);
});
$('agentToggle').addEventListener('click', () => $('agentBody').classList.toggle('hidden'));
document.querySelectorAll('.prompt-chip').forEach((c) =>
  c.addEventListener('click', () => sendToAgent(c.dataset.prompt)));

/* --------------------------------------------------------------------- init */
(async function init() {
  const cfg = await api('/api/config');
  const chip = $('paypalStatus');
  if (cfg.data.paypalConfigured) {
    chip.textContent = `PayPal ${cfg.data.env}: connected ✓`;
    chip.className = 'chip chip-ok';
  } else {
    chip.textContent = 'PayPal sandbox: not configured (add keys to .env)';
    chip.className = 'chip chip-warn';
  }
  $('envLabel').textContent = cfg.data.env || 'sandbox';

  const params = new URLSearchParams(location.search);
  const banner = $('banner');
  if (params.get('paid')) {
    const ord = await api(`/api/orders/${encodeURIComponent(params.get('paid'))}`);
    banner.className = 'banner banner-ok';
    banner.textContent = ord.ok
      ? `✅ Payment captured! Order ${params.get('paid')} — ${money(ord.data.total)} via PayPal sandbox. The agent has cleared your cart.`
      : `✅ Payment captured for order ${params.get('paid')} (PayPal sandbox).`;
  } else if (params.get('subscribed')) {
    banner.className = 'banner banner-ok';
    banner.textContent = `✅ Weekly restock subscription ${params.get('subscribed')} is active on PayPal sandbox — it bills the box every week. See it on the merchant dashboard.`;
  } else if (params.get('cancelled')) {
    banner.className = 'banner banner-warn';
    banner.textContent = 'Payment was cancelled at PayPal — your cart is untouched.';
  } else if (params.get('error')) {
    banner.className = 'banner banner-warn';
    banner.textContent = `Something went wrong with the payment (${params.get('error')}). Your cart is untouched.`;
  } else {
    banner.classList.add('hidden');
  }

  await loadProducts();
  await refreshCart();
  await loadMyOrders();
  addMessage('Hi! I am the AgentMart shopping agent. I watch your stock, warn you before you run out, and restock inside your budget with PayPal. Try "What am I running out of?" or "Smart restock under $60".', 'agent');
})();
