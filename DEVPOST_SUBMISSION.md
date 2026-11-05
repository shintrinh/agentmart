# Devpost submission draft — PayPal AI Hackathon
# (Copy into the Devpost "Enter a Submission" form. Deadline: Nov 12, 2026, 12:00 PM PT.)

## Project name
AgentMart — the AI procurement copilot that restocks your café before you run out, and pays with PayPal

## Tagline / elevator pitch
A small café restocks by talking to an AI agent: "smart restock under $60" —
the agent knows what is about to run out, sizes the restock by how fast each
item is used, watches supplier prices, buys from the cheaper supplier when
one exists, takes it to a real PayPal checkout, and the merchant sets a
weekly restock plan once, sees a 14-day forecast of what will run out and
when to order, and tracks stock, prices, orders, spend, invoices — and what
is owed to each supplier — on a live dashboard, with a running total of what
the agent has saved. The agent also knows when *not* to buy: perishables
stocked above their max spoil a little every day, and the restock never
orders above that max.

## What it does
AgentMart is a working café-restocking store with two ways to buy and one
merchant view:
1. **Agent path (the point of the project):** chat with the shopping agent,
   driven by a real LLM (Muse Spark Open via Baseten, fallback Fireworks, tool-calling) over seventeen tools
   (`search_products`, `add_to_cart`, `remove_from_cart`, `view_cart`, `create_checkout`,
   `order_status`, `check_stock`, `smart_restock`, `check_prices`, `check_payables`,
   `check_savings`, `run_restock_plan`, `create_subscription`, `check_subscriptions`,
   `cancel_subscription`, `fulfill_subscription`, `check_recent_events`). It checks inventory
   (stock on hand, days left at current usage, LOW/OUT alerts), sizes a
   smart restock from burn rate × (supplier lead time + 7 days of cover)
   inside a budget in a single tool call, creates a PayPal Checkout order
   and reports order status after capture. When a requested product is out
   of stock, the agent substitutes the closest same-category in-stock item,
   explains the swap and the price difference, and can remove it on request
   (`remove_from_cart` tool + deterministic remove intent). The agent also
   watches supplier prices (`check_prices` tool): it flags prices that
   crept up more than 5% in 3 months and names the cheaper alternate
   supplier. Smart restock buys each line from the best supplier (the
   alternate wins when cheaper and no more than 2 days slower), prices the
   cart line at that supplier, and every order carries an expected delivery
   date (today + longest supplier lead time).
2. **Manual path:** classic catalog (search + category filter, stock badges
   on every card) + cart drawer with PayPal checkout + one-click "Reorder
   my last order" and a "My orders" history with expected delivery dates.
3. **Merchant dashboard:** inventory in AG Grid with low-stock and
   overstock alerts, supplier prices in AG Grid with creep alerts and a
   best-buy column, and spend stats (this month, top item by spend); all
   orders in AG Grid (sort, filter, resize) with captured-revenue stats
   and expected delivery dates; a payables ledger in AG Grid — what is
   owed per supplier, with payment terms, due dates, overdue flags and
   mark-as-paid — created automatically when an order is captured; savings
   stats (total saved by cheaper suppliers, stock-outs prevented); a
   14-day forecast grid (stock-out date, order-by date, order-now flag);
   a waste ledger (total wasted, units spoiled, event log) and weekly
   restock plans (create / run / pause / delete, with next-run date);
   stocktake adjustment and a demo-reset button; plus PayPal invoice
   creation, sending and live status refresh from any order (Invoicing API
   v2), with a follow-up flag for invoices sent more than 7 days ago; and
   a subscriptions grid (AG Grid) for the weekly restock box — status,
   weekly amount, box contents, next billing date, last fulfilled — with
   Refresh / Fulfill / Suspend / Activate / Cancel actions.

All paths share one cart/order/inventory/price state (persisted in SQLite)
and one PayPal Orders API v2 integration (create → buyer approval →
server-side capture), running on the PayPal sandbox. Capturing a restock
order adds the delivery to stock. A weekly restock plan can also become a
real PayPal subscription (Subscriptions API): the agent sizes the week's
box, creates the weekly billing plan and subscription, the merchant approves
once, and PayPal bills the box every week — the agent fulfills each week's
box from the subscription. Sandbox billing runs on the real weekly cycle,
so the second charge lands 7 days out rather than inside the demo.

## How we built it
- Node.js + Express server; vanilla JS frontend (no build step); SQLite
  persistence (`node:sqlite`).
- PayPal integration: OAuth client-credentials + Orders API v2, server-side
  create/capture, return/cancel URL flow; Invoicing API v2 for merchant
  invoices; Subscriptions API (Catalog Products → Billing Plans → Subscriptions:
  create / get / suspend / activate / cancel) for the weekly restock box;
  Notifications / Webhooks API — the server self-registers its webhook on
  boot, verifies every event signature against PayPal, and routes events
  (subscription status sync, invoice → PAID, order auto-capture on approval).
- The agent calls Muse Spark Open (Baseten first, Fireworks fallback, OpenAI-compatible Chat
  Completions) with tool definitions; a deterministic intent engine over the
  same tools is the fallback when no LLM key is set, and every reply names
  the engine that answered it. `smart_restock` is deliberately one
  server-side tool call (size the cart, then checkout) because open-weight
  models are weak over long tool loops — the live Fireworks test completes
  the smart restock in 2 rounds.
- Inventory model: every product carries stock, daily usage, a reorder
  point, a supplier lead time and a supplier; `daysLeft = stock / dailyUse`.
  Order quantities are always whole units (fractional stock after simulated
  usage is rounded up when sizing a restock).
- Supplier intelligence: a `price_history` table (seeded demo data,
  Aug–Oct 2026) drives creep alerts; each product has one alternate
  supplier, and smart restock picks the best per line. Cart lines carry a
  per-line supplier price override so PayPal charges exactly the chosen
  supplier's price — the override survives quantity edits and reorders.
- Money view: a `payables` table (supplier, amount, due date = expected
  delivery + payment terms, status) is written when an order is captured
  and backfilled for older captured orders; every order also records what
  it saved vs catalog prices and how many stock-outs it prevented, so the
  dashboard can show the agent's impact in dollars.
- Autopilot: a `restock_plans` table (name, day of week, budget, active,
  last run) — the agent creates a plan from one sentence ("set up a weekly
  restock every Monday under $60") and runs it on command
  ("run my weekly restock") through the same smart-restock + checkout path.
  Plans run only when asked: there is no background cron on the free demo
  host, and that is stated in the product. A `forecast` view projects each
  item's stock-out date and order-by date (stock-out minus lead time) from
  current stock and daily usage, and `check_stock` returns it with the
  inventory.
- Don't overbuy: each product has a shelf life and a max stock; the smart
  restock target is capped at the max (matcha's burn-rate target of 4 is
  capped to its max of 3), and items already above max are skipped.
  Overstocked perishables spoil 10% of the excess per simulated day into
  a `waste` table, so the dashboard can show the cost of overbuying — and
  the agent answers "how much am I wasting?" and "am I overstocked?" from
  the same data. A stocktake endpoint corrects recorded stock, and a demo
  reset restores seed stock (orders, payables and plans are kept).
- Merchant dashboard uses AG Grid Community (served locally from npm, no
  CDN dependency at runtime).
- Deployed with `render.yaml` (Render free tier); `GET /health` for the
  Render health check.

## Tools used (for the "Tools" field)
- PayPal Developer Platform — Checkout / Orders API v2, Invoicing API v2, Subscriptions API (Catalog Products, Billing Plans, Subscriptions), Notifications / Webhooks API (signature verification, event routing), sandbox environment
- Muse Spark Open (Baseten meta-models/muse-spark-open-1026, fallback Fireworks accounts/fireworks/models/muse-spark-open) — LLM with tool calling for the shopping agent
- AG Grid Community — merchant dashboard data grid
- Node.js, Express, SQLite (node:sqlite)
- Vanilla JavaScript / HTML / CSS
- Render — hosted demo

## "Significant update" note (existing-project rule)
AgentMart is a new project built for this hackathon during the submission
period (Oct 22 – Nov 12, 2026). Everything in it — the storefront, the LLM
agent, the PayPal Orders + Invoicing integrations, the AG Grid merchant
dashboard and the SQLite persistence — was built in that window.

## Challenges / what we learned
- Making the agent's actions and the manual UI share exactly one source of
  truth (cart + orders) so a conversation and a click never diverge — now
  persisted in SQLite so the truth survives a restart.
- Budget-constrained bundle building: composing a "kit under $60" is a small
  knapsack problem hiding inside a chat message.
- Open-weight models are weak over long tool loops (5 rounds of search → add
  never reached checkout in the first live tests). Fix: the sizing math moved
  into one server-side tool call (`smart_restock`), so the LLM decides once
  and the server executes — the live Fireworks test then finished in 2 rounds.
- Fractional quantities: simulated daily usage makes stock fractional, and
  the first smart-restock plan produced a 3.3-unit quantity that PayPal
  rejected (400). Fix: restock quantities are rounded up to whole units and
  the PayPal item quantity is rounded defensively at checkout.
- A promise the agent could not keep: the first substitution reply told the
  user to say "remove robusta", but no remove intent existed. Caught in
  live testing before it shipped — fixed with a `remove_from_cart` tool and
  a deterministic remove intent, then verified end-to-end (swap → remove →
  empty cart).
- Per-line supplier pricing: the cart used to store only quantities, so a
  cheaper alternate supplier's price had nowhere to live and PayPal would
  have charged the catalog price. Fix: cart entries carry an optional
  `{qty, price, supplier, leadTimeDays}` override; old carts (plain
  quantities) still read correctly. Verified: smart restock totals $56
  with the oat-milk line at $14 from Green Valley Farms.
- A startup crash the tests missed: the payables backfill ran at module
  load, before the `SUPPLIER_TERMS` const it calls was initialized
  (temporal dead zone) — the server crashed on start. Tests missed it
  because the test database has no COMPLETED orders, so the backfill loop
  never ran. Fix: the backfill moved to the end of the file, after all
  top-level definitions. Lesson: startup code paths need realistic seed
  state in tests, not just empty databases.
- A lost record, restored: the very first verified sandbox order
  (`19T958561E596930N`, $56, COMPLETED) was captured before SQLite
  persistence was added, so it lived only in memory and never reached the
  database. It was restored from the documented capture (README) with its
  delivery date reconstructed per the v3 rule — and the payables backfill
  then produced its two rows ($32 Highland Roasters, $24 Brew Gear Co.).
- PayPal Invoicing: the API rejects some `payment_term` values
  (`NET_7` is invalid) — `DUE_ON_RECEIPT` is the correct term type.
- Judges must be able to run the project with no PayPal account of their
  own: hence the hosted Render demo plus a verified sandbox order id in the
  README.

## What's next
- Subscription revise: change the weekly box price when burn rate shifts, without cancelling and re-subscribing.
- Automatic payment reminders for sent invoices.

---

## Demo video script (must stay under 3:00, public on YouTube)

- **0:00–0:20 — Problem.** "A small café loses sales to stock-outs and hours
  to manual re-ordering — and the stock-out is usually discovered when a
  customer complains. Supplier prices creep up a few percent at a time and
  nobody notices. What if restocking happened before the shelf was empty,
  from the cheaper supplier? Meet AgentMart."
- **0:20–0:45 — What am I running out of?** Ask the agent → it lists stock
  with days left; matcha is LOW at ~3 days. Product cards show the same
  stock badges.
- **0:45–1:05 — Did any prices go up?** Ask the agent → it reports the
  creepers (Matcha +10.5%, Arabica +9.1% in 3 months) and names the cheaper
  alternate suppliers.
- **1:05–1:45 — The agentic moment.** Click the prompt chip "Smart restock
  under $60" → agent sizes the restock by burn rate, buys oat milk from
  Green Valley Farms ($14 instead of $16, saves $2), total $56 with an
  expected delivery date; creates a PayPal order, shows the approval
  button. Click it → PayPal sandbox login (buyer test account) → approve.
- **1:45–2:05 — Capture.** Land back on the store with the green "Payment
  captured" banner. Ask the agent: "What is the status of my order?" → it
  reports the captured order and total.
- **2:05–2:25 — Subscribe once, bill weekly.** Ask the agent: "Set up a weekly
  restock subscription under $60" → it sizes this week's box ($56, same
  matcha + oat-milk), creates the PayPal subscription and shows the approve
  link. Approve on PayPal sandbox → land back with the green "subscription
  active" banner; the dashboard subscriptions grid shows ACTIVE with the
  next billing date 7 days out. One line: "Approve once — the box bills
  itself every week." Then glance at the webhook events grid: PayPal already
  pushed `BILLING.SUBSCRIPTION.ACTIVATED` — the status updated itself, no
  Refresh click.
- **2:25–2:55 — Merchant dashboard + close.** Open the dashboard: inventory
  grid with the low-stock alert, supplier price grid with creep alerts and
  best-buy column, spend stats; the order in AG Grid with its expected
  delivery date; the payables ledger for the suppliers in the order (amount,
  terms, due date) and the savings stats; the forecast grid (matcha runs out
  2026-11-08, order by date already passed) and the weekly plan ("Weekly
  restock — Monday", next run 2026-11-09); a 10-second waste beat — set
  oat-milk to 16, simulate one day, $16 spoils into the ledger; create and
  send a draft invoice from the order, then refresh its live status. Closing
  line: "One agent, one catalog, one PayPal checkout — restock at the speed
  of a sentence, before you run out, from the cheaper supplier, and always
  know what you owe — and what not to buy."

Recording notes: use sandbox buyer credentials (never a real account), record
at 1080p, no third-party music/trademarks in the video (hackathon rule).
