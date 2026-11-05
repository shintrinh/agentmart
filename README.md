# AgentMart — Agentic Commerce for Café Restocking

**A small café restocks coffee, tea and gear by talking to an AI agent — the
agent watches stock, warns before anything runs out, sizes the restock by how
fast each item is used, buys from the cheaper supplier when one exists, and
takes it to a real PayPal checkout. The merchant sets a weekly restock plan
once, sees a 14-day forecast of what will run out and when to order, and
follows stock, prices, orders, spend, invoices — and what is owed to each
supplier — on a dashboard, with a running total of what the agent has saved.
The agent also knows when *not* to buy: perishables stocked above their max
spoil a little every day, and the restock never orders above that max.**

AgentMart is a working demo storefront for the PayPal AI Hackathon. A built-in
AI shopping agent can search the catalog, assemble a restock bundle inside a
budget, build your cart and create a real **PayPal Checkout order (sandbox)**
— the buyer only approves the payment on PayPal, and the server captures it
automatically. Shoppers who prefer clicking can also check out manually from
the cart; both paths use the same PayPal Orders API v2 integration. The
merchant dashboard shows all orders in AG Grid and can create PayPal invoices
from any order with the Invoicing API v2.

## Why this exists

Small cafés lose sales to stock-outs and lose hours to manual re-ordering.
The stock-out is usually discovered the worst way — when a customer complains
or the menu changes mid-rush — because a spreadsheet has no reorder point and
no one tracks burn rate. AgentMart shows the agentic-commerce answer for a
real niche: the agent knows what is about to run out, how many days of cover
are left, and the supplier lead time, then sizes the restock from burn rate
× (lead time + 7 days of cover) inside a budget — before the shelf is empty.
The café owner states a restock intent in plain language (“smart restock
under $60”), and the agent executes the whole transaction — discovery, cart,
and payment — with PayPal as the payment center of the experience, while the
merchant keeps a live view of stock, orders, spend and invoices.

## How it maps to the judging criteria

| Criterion | How AgentMart addresses it |
|---|---|
| Technological Implementation | Four PayPal APIs, all server-side on the sandbox: Orders API v2 (create → approve → capture) + Invoicing API v2 (create draft invoice from an order, send it, refresh its live status) + Subscriptions API (catalog product → weekly billing plan → subscription: create / get / suspend / activate / cancel; approve once, bills weekly) + Notifications/Webhooks API (the server self-registers `POST /api/webhooks/paypal`, verifies every event signature against PayPal, and routes events: subscription status sync, invoice → PAID, order auto-capture on approval even if the buyer closes the tab). The agent is a real tool-calling layer (17 tools: `search_products`, `add_to_cart`, `remove_from_cart`, `view_cart`, `create_checkout`, `order_status`, `check_stock`, `smart_restock`, `check_prices`, `check_payables`, `check_savings`, `run_restock_plan`, `create_subscription`, `check_subscriptions`, `cancel_subscription`, `fulfill_subscription`, `check_recent_events`) driven by a real LLM (Muse Spark Open via Baseten, fallback Fireworks, OpenAI-compatible Chat Completions with tool calling), with a deterministic intent engine as fallback; carts/orders/invoices/inventory/price history/payables/restock plans/waste/subscriptions/webhook events persist in SQLite. `smart_restock` is one server-side tool call: it sizes the cart from burn rate × (lead time + 7 days) inside the budget, capped at each item's max stock, picks the best supplier per line (alternate wins when cheaper and no more than 2 days slower), prices each cart line at the chosen supplier, then creates the checkout — designed this way because open-weight models are weak over long tool loops. Capturing an order adds the delivery to stock and creates the payables per supplier (due date = expected delivery + payment terms); a demo helper advances one day of usage, and overstocked perishables spoil a little each simulated day (10% of the excess, recorded in a waste ledger). Every order carries an expected delivery date (today + longest supplier lead time) and a savings record (cheaper-supplier discount + stock-outs prevented). A weekly restock plan (day of week + budget) runs the same smart restock when asked; a 14-day forecast projects each item's stock-out date and order-by date from current stock and daily usage. A weekly restock subscription sizes the same box, bills it weekly on PayPal after one approval, and the agent fulfills each week's box. |
| Design | Complete product experience: storefront with search + category filter, stock badges on every product card (In stock / Low — X days left / Out), substitute suggestions on out-of-stock cards, one-click “Reorder my last order”, a “My orders” history with expected delivery dates, cart drawer with quantity controls, checkout states (success / cancelled / error), an always-available agent chat panel with one-tap prompt chips, and a merchant dashboard (9 AG Grid grids: sort, filter, resize) with inventory grid + low-stock and overstock alerts, supplier price grid + creep alerts, payables grid + overdue flags with mark-as-paid, a forecast grid (stock-out date, order-by date, order-now flag), a waste ledger (total wasted, units spoiled, event log), weekly restock plans (create / run / pause / delete), a subscriptions grid (status, weekly amount, box contents, next billing date, last fulfilled — with Refresh / Fulfill / Suspend / Activate / Cancel), a webhook events grid (what PayPal pushed, when, handled or logged), stocktake adjustment and a demo-reset button, spend stats (this month, top item) and savings stats (total saved, stock-outs prevented), and invoice creation + sending + status refresh with follow-up flags |
| Potential Impact | A specific audience (small cafés) and a specific, recurring pain (weekly restocking) — the demo shows the exact flow a café owner would run every week, and the merchant dashboard is the tool they would keep using after the sale. The inventory model targets the real stock-out cost: a missed sale and a mid-rush menu change, not just “buying is slow”. The price history targets the quiet leak: supplier prices creeping up a few percent at a time. The payables ledger targets the end-of-month chaos: 15–30 suppliers, each with its own terms, paid from memory. The forecast + weekly plan targets the planning time itself: the owner sets the schedule once instead of remembering to order every week. The waste ledger targets the other side of the same money: overbuying perishables that spoil — carrying excess stock costs 25–50% of its value a year. Impact is quantified on the dashboard: dollars saved by cheaper suppliers, stock-outs prevented, and dollars wasted. |
| Innovation / Idea | Not a generic "agent shops" demo: a procurement copilot that restocks *before* the shelf is empty, sized by burn rate and supplier lead time, *decides* who to buy from, closes the loop on money, runs on a schedule the owner sets once, with a forecast that says when to order — and knows when *not* to buy: it caps every restock at the item's max stock and warns when overstock is spoiling — plus a merchant-side workflow (orders → invoices → payables) on the same PayPal account, a weekly restock box that becomes a real PayPal subscription (approve once, bill weekly, agent fulfills each week's box), and PayPal webhooks so the system hears about payments on its own — an approved order is captured even if the buyer closes the tab |
| Presentation | Demo script in `DEVPOST_SUBMISSION.md`, timed under 3 minutes, one continuous end-to-end flow |

## Quick start

```bash
npm install
cp .env.example .env   # fill in your PayPal sandbox app credentials
npm start              # http://localhost:3000
npm test               # unit tests (no PayPal network calls)
```

### Getting PayPal sandbox credentials (free, ~5 minutes)

1. Sign in at <https://developer.paypal.com> with your PayPal account.
2. Dashboard → Apps & Credentials → **Sandbox** → Create App.
3. Copy the **Client ID** and **Secret** into `.env`.
4. Use a sandbox *personal* account (Dashboard → Sandbox → Accounts) to sign in
   as the buyer when approving a payment.

Without credentials the store still runs (catalog, cart, agent chat); checkout
endpoints answer `PAYPAL_NOT_CONFIGURED` and the agent explains what to add.

### LLM for the agent (optional but recommended)

Set `LLM_API_KEY` in `.env` (Baseten Muse Spark Open by default; `LLM_FALLBACK_API_KEY` is the Fireworks fallback key, `LLM_BASE_URL` / `LLM_MODEL` override the provider). With a key, the agent
calls the LLM with tool definitions and executes the tools; without a key it
runs the deterministic intent engine over the same tools, and every agent
reply names the engine that answered it (`llm:baseten:meta-models/muse-spark-open-1026`, `llm:fireworks:accounts/fireworks/models/muse-spark-open`, or
`deterministic`).

### Deploy on Render (free tier)

`render.yaml` is included. Deploy from the repo, then set in the Render
dashboard (Environment → Environment Variables): `PAYPAL_CLIENT_ID`,
`PAYPAL_CLIENT_SECRET` (from a PayPal sandbox app) and optionally
`LLM_API_KEY`. Render sets `RENDER_EXTERNAL_URL` automatically, which the
server uses as its PayPal return URL.

## For judges — how to test in 2 minutes

1. Open the storefront, click the prompt chip **“What am I running out
   of?”** — the agent lists stock with days left and flags matcha as LOW.
2. Ask **“Did any prices go up?”** — the agent reports the creepers
   (Matcha +10.5%, Arabica +9.1% in 3 months) and names the cheaper
   alternate suppliers.
3. Click **“Smart restock under $60”** — the agent sizes the restock from
   burn rate, buys oat milk from Green Valley Farms ($14 instead of $16),
   and creates a PayPal sandbox order ($56: Matcha ×2 + Oat Milk ×1, saved
   $2, expected delivery shown).
4. Approve it on PayPal sandbox with a sandbox personal (buyer) account —
   no real money moves. The server captures it, shows a green banner, and
   adds the delivery to stock.
5. Ask the agent: **“What is the status of order <id>?”** — it reports
   COMPLETED with the total.
6. Open **/dashboard.html**: inventory in AG Grid with low-stock alerts,
   supplier prices with creep alerts and best-buy column, spend stats;
   orders listed with expected delivery dates; payables show what is owed
   per supplier for the captured order(s) — amount, terms, due date —
   mark one as paid; pick a completed order id, enter any email, and
   create (then send) a draft PayPal invoice — then refresh its live
   status from PayPal.
7. Ask the agent: **“What do I owe suppliers?”** and **“How much have you
   saved me?”** — it answers from the payables ledger and the savings
   record on captured orders.
8. Ask the agent: **“When will I run out of everything?”** — it answers
   with the forecast (stock-out date and order-by date per item). Then:
   **“Set up a weekly restock every Monday under $60”** and **“Run my
   weekly restock”** — the agent runs the plan and creates the PayPal
   checkout. The same plan and forecast live on the dashboard.
9. Overbuying demo: on the dashboard, set **Oat Milk stock to 16**
   (above its max of 12), then **Simulate one day of sales** — 1 unit
   spoils ($16) and lands in the waste ledger. Ask the agent **“How much
   am I wasting?”** and **“Am I overstocked?”** — then run **“Smart
   restock under $60”**: oat-milk is left out of the order entirely, and
   matcha is capped at its max stock of 3. **Reset demo to seed state**
   restores the starting stock and clears waste and carts.
10. Subscriptions: ask the agent **“Set up a weekly restock subscription
    under $60”** — it sizes this week's box ($56: Matcha ×2 + Oat Milk ×1)
    and creates a PayPal subscription; approve it on PayPal sandbox and
    the dashboard subscriptions grid shows ACTIVE with the next billing
    date 7 days out. Ask **“What subscriptions do I have?”** to list them,
    and **“Fulfill this week's box”** to run the restock for the active
    subscription. (Sandbox billing runs on the real weekly cycle, so the
    second charge is not visible inside the demo.)
11. Test buyer account (for the approve steps above): no login is needed
    to browse, chat or run the agent — only the PayPal approval needs a
    sandbox buyer account. Create one free in ~2 minutes at
    [developer.paypal.com](https://developer.paypal.com) → Sandbox →
    Accounts → Create Account (Personal, US). No real money moves.
12. Webhooks: after approving an order or a subscription, open
    **/dashboard.html** and look at the Webhook events grid — PayPal pushes
    the event (e.g. `BILLING.SUBSCRIPTION.ACTIVATED`, `CHECKOUT.ORDER.APPROVED`)
    within about a minute, the server verifies the signature and updates the
    subscription/order status on its own. Ask the agent **“Any new
    payments?”** to hear the same events from the log.
12. Local run instead: `npm install && cp .env.example .env` (fill PayPal
    sandbox credentials as above), `npm start`, then the same steps at
    <http://localhost:3000>.

Verified sandbox flows (2026-11-05): agent kit $56 (Arabica $18 + Robusta
$14 + Cold Brew Bottle $24) → PayPal order `19T958561E596930N` → buyer
approved → server captured → status COMPLETED. A draft invoice
`INV2-TSDU-MR7V-HCF6-85CV` was also created from an order with the Invoicing
API v2 (live status refresh confirmed it is still DRAFT). Smart restock v3
(deterministic): Matcha ×2 + Oat Milk ×1 from Green Valley Farms = $56,
saved $2, expected delivery 2026-11-09 → PayPal order `45E60006TY0842152`.
Smart restock v2 (deterministic + live LLM via Fireworks): Matcha ×2 +
Oat Milk ×1 = $58 → PayPal orders `9RU98421263954237` (deterministic) and
`42E68398PS392235D` (live LLM, one `smart_restock` tool call, 2 rounds).
Weekly subscription v7 (live sandbox 2026-11-05): product
`PROD-4JN29518CH501440C` → weekly plan `P-52P66499NP903415PNLWDKNA` ($56)
→ subscription `I-1UGC5UDMPCUT` APPROVAL_PENDING with approve link
(GET 200). Local server: subscription `I-UH1CS723HVM9` ($56 box, same
sizing) created via `POST /api/subscriptions`, listed by the agent and
refreshed live from PayPal; fulfill correctly blocked while pending
(400 SUBSCRIPTION_NOT_ACTIVE). Approve → ACTIVE → fulfill still to be
verified on the hosted demo after deploy (needs a buyer-sandbox approval
click in the browser).
Webhooks v8 (live local 2026-11-05): `POST /api/webhooks/paypal` with a
fake signature → PayPal's verify API rejects it → 401 INVALID_SIGNATURE,
and the fake event is not logged. Missing signature headers → 401
MISSING_SIGNATURE. Boot on localhost correctly skips webhook registration
(PayPal needs a public HTTPS URL). Real signed events still to be verified
on the hosted demo after deploy (approve a subscription → PayPal pushes
`BILLING.SUBSCRIPTION.ACTIVATED`).

## Architecture

```
Browser (storefront + agent chat + merchant dashboard on AG Grid)
   │  /api/products  /api/cart/*  /api/agent  /api/paypal/create-order
   │  /api/orders  /api/invoices  /api/inventory  /api/reorder-last
   │  /dashboard.html
Express server (server.js)
   ├─ Catalog & carts/orders/invoices/inventory persisted in SQLite
   │   (data/agentmart.db; tests use a throwaway DB via AGENTMART_DB_PATH)
   ├─ Inventory model: stock, dailyUse, reorderPoint, leadTimeDays,
   │   supplier per product; daysLeft = stock / dailyUse
   ├─ Agent layer: LLM (Muse Spark tool-calling) → tools over cart/order/
   │   inventory state, deterministic intent engine as fallback
   ├─ PayPal Orders API v2 (OAuth client credentials, sandbox by default)
   ├─ PayPal Invoicing API v2 (create/send invoice from an order)
   ├─ PayPal Subscriptions API (catalog product → weekly billing plan →
   │   subscription; approve once, bills weekly; suspend/activate/cancel)
   └─ PayPal Webhooks API (server self-registers the webhook on boot,
       verifies every event signature, routes subscription/invoice/order
       events; approved orders auto-capture)
PayPal sandbox → buyer approval → /paypal/return → capture
PayPal sandbox → webhook → /api/webhooks/paypal → status sync / auto-capture
```

The tool layer is deliberately model-agnostic: swap the LLM provider by
changing `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` — the tools stay the
same.

## Demo flow (also the video script)

1. "What am I running out of?" → agent reports stock with days left; matcha is LOW (~3 days).
2. "Did any prices go up?" → agent reports the creepers (Matcha +10.5%, Arabica +9.1%) and names the cheaper alternate suppliers.
3. "Smart restock under $60" → agent sizes the restock by burn rate, buys oat milk from Green Valley Farms ($14 instead of $16, saves $2), total $56, expected delivery shown; creates a PayPal order, returns the approval button.
4. Approve in the PayPal sandbox → server captures → success banner + order record; cart clears; stock increases by the delivery.
5. Ask the agent "what is the status of order …?" → it reports the captured order.
6. Merchant dashboard: inventory grid + low-stock alert, supplier price grid + creep alerts, spend stats, payables grid (what is owed, to whom, by when) and savings stats; order appears in AG Grid with its expected delivery date → create and send a draft invoice from it, then refresh its live status.
7. Manual path: add items from the grid → cart drawer → "Checkout with PayPal"; or one-click "Reorder my last order".
8. Out-of-stock handling: asking for an out-of-stock item substitutes the closest same-category in-stock item (e.g. Robusta for Arabica, $4 less), explains the swap and the price difference, and the user can remove it with "remove robusta".

## Notes for reviewers

- Payments run on the PayPal **sandbox**; no real money moves.
- Catalog items and stock / burn-rate / price-history / supplier-terms
  figures are illustrative demo data for one sample café, not a real
  shop's numbers or real supplier quotes.
- Payables only exist for captured orders — an order awaiting approval is
  not money owed yet.
- The forecast is a straight projection from current stock and daily usage
  (demo data), not machine learning. Weekly plans run when you ask (button
  or agent) — there is no background cron on the free demo host, and the
  free tier sleeps after ~15 minutes without traffic.
- Spoilage is a demo simulation: perishables above their max stock lose
  10% of the excess per simulated day, not a sensor reading. Shelf-life
  and max-stock figures are illustrative demo data.
- Order quantities are always whole units: fractional stock (e.g. after the
  “simulate one day” demo helper) is rounded up when sizing a restock, and
  the PayPal item quantity is rounded defensively at checkout.
- All submission text is in English, per the hackathon rules.
- License: MIT (see `LICENSE`).

## Roadmap ideas

- Plug a second LLM provider into the same tool layer for comparison.
- Merchant-side agent: automatic payment reminders for sent invoices; webhooks for asynchronous payment events.
- Recurring restock subscriptions (PayPal Subscriptions API) for weekly café orders.
