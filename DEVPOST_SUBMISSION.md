# Devpost submission draft — PayPal AI Hackathon
# (Copy into the Devpost "Enter a Submission" form. Deadline: Nov 12, 2026, 12:00 PM PT.)

## Project name
AgentMart — the AI procurement copilot that restocks your café before you run out, and pays with PayPal

## Tagline / elevator pitch
A Blue Bottle Coffee café in San Francisco restocks by talking to an AI
agent: "smart restock under $60" — the agent knows what is about to run
out, sizes the restock by how fast each item is used, watches supplier
prices (up and down), buys from the cheaper supplier when one exists, takes
it to a real PayPal checkout, and the merchant sets a weekly restock plan
once, sees a 14-day forecast of what will run out and when to order, and
tracks stock, prices, orders, spend, invoices — and what is owed to each
supplier — on a live dashboard, with a running total of what the agent has
saved. The agent also knows when *not* to buy: perishables stocked above
their max spoil a little every day, and the restock never orders above that
max. And when a customer is late paying an invoice, the agent reminds them
on PayPal.

## What it does
AgentMart is a working café-restocking store for a real brand — a Blue
Bottle Coffee café in San Francisco, stocked at Blue Bottle's published
retail prices (verified 2026-11-05 from the brand's public menus; see
README "Demo data sources") — with two ways to buy and one merchant view:
1. **Agent path (the point of the project):** chat with the shopping agent,
   driven by a real LLM (Muse Spark Open via Baseten, fallback Fireworks, tool-calling) over twenty-five tools
   (`search_products`, `add_to_cart`, `remove_from_cart`, `view_cart`, `create_checkout`,
   `order_status`, `check_stock`, `smart_restock`, `check_prices`, `check_price_drops`, `check_payables`,
   `check_overdue_invoices`, `remind_invoice`,
   `check_savings`, `run_restock_plan`, `create_subscription`, `check_subscriptions`,
   `cancel_subscription`, `fulfill_subscription`, `check_recent_events`, `revise_subscription`,
   `create_buying_group`, `join_buying_group`, `check_group_deals`, `place_group_order`). It checks inventory
   (stock on hand, days left at current usage, LOW/OUT alerts), sizes a
   smart restock from burn rate × (supplier lead time + 7 days of cover)
   inside a budget in a single tool call, creates a PayPal Checkout order
   and reports order status after capture. When a requested product is out
   of stock, the agent substitutes the closest same-category in-stock item,
   explains the swap and the price difference, and can remove it on request
   (`remove_from_cart` tool + deterministic remove intent). The agent also
   watches supplier prices (`check_prices` / `check_price_drops` tools): it
   flags prices that crept up more than 5% in 3 months and prices that
   dropped more than 5% — a falling price is a buying opportunity — and
   names the cheaper alternate supplier. Smart restock buys each line from
   the best supplier (the alternate wins when cheaper and no more than 2
   days slower), prices the cart line at that supplier, and every order
   carries an expected delivery date (today + longest supplier lead time).
   On the money side the agent watches for overdue invoices and payables
   (`check_overdue_invoices`) and reminds the payer through PayPal
   (`remind_invoice`, Invoicing remind API) — only SENT invoices can be
   reminded. And the agent buys together: several cafés pool one order to
   unlock a wholesale tier price (`check_group_deals` / `place_group_order`)
   — 5% off at 10+ pooled units, 10% off at 25+ — one PayPal checkout for
   the pooled quantity, and after capture each café owes only its own share.
   The demo group "Bay Area Specialty Cafés" pools matcha to 25 units
   (Tier 2, $36.45 vs $40.50, saves $101.25) and oat milk to 20 units
   (Tier 1, $5.69 vs $5.99, saves $6.00).
2. **Manual path:** classic catalog (search + category filter, stock badges
   on every card) + cart drawer with PayPal checkout + one-click "Reorder
   my last order" and a "My orders" history with expected delivery dates.
3. **Merchant dashboard:** inventory in AG Grid with low-stock and
   overstock alerts, supplier prices in AG Grid with creep and drop alerts
   and a best-buy column, and spend stats (this month, top item by spend);
   all orders in AG Grid (sort, filter, resize) with captured-revenue stats
   and expected delivery dates; a payables ledger in AG Grid — what is
   owed per supplier, with payment terms, due dates, overdue flags and
   mark-as-paid — created automatically when an order is captured; savings
   stats (total saved by cheaper suppliers, stock-outs prevented); a
   14-day forecast grid (stock-out date, order-by date, order-now flag);
   a waste ledger (total wasted, units spoiled, event log) and weekly
   restock plans (create / run / pause / delete, with next-run date);
   stocktake adjustment and a demo-reset button; plus PayPal invoice
   creation, sending and live status refresh from any order (Invoicing API
   v2, NET_30 terms with a due date, overdue flags and a Send reminder
   button per SENT invoice); a subscriptions grid (AG Grid) for the
   weekly restock box — status, weekly amount, box contents, next billing
   date, last fulfilled — with Refresh / Fulfill / Suspend / Activate /
   Cancel actions; and a group-buying grid (AG Grid) — pooled quantity,
   tier price, solo price, saving, members, order status — with a Place
   group order button.

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
  create / get / suspend / activate / cancel / revise) for the weekly restock
  box — the agent re-sizes the box from today's burn rate and revises the
  subscription price on PayPal (a price rise needs buyer approval; a price
  drop applies at once); Notifications / Webhooks API — the server
  self-registers its webhook on boot, verifies every event signature against
  PayPal, and routes events (subscription status sync, invoice → PAID, order
  auto-capture on approval).
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
- Supplier intelligence: a `price_history` table (current prices are Blue
  Bottle's verified published retail prices; the Aug–Oct 2026 points are an
  illustrative demo series built around them) drives creep alerts (>5% up
  in 3 months) and drop alerts (>5% down in 3 months); each product has one
  alternate supplier, and smart restock picks the best per line. Cart lines
  carry a per-line supplier price override so PayPal charges exactly the
  chosen supplier's price — the override survives quantity edits and
  reorders.
- Money view: a `payables` table (supplier, amount, due date = expected
  delivery + payment terms, status) is written when an order is captured
  and backfilled for older captured orders; every order also records what
  it saved vs catalog prices and how many stock-outs it prevented, so the
  dashboard can show the agent's impact in dollars. Invoices are created
  on NET_30 terms with a stored due date (PayPal returns no due_date
  field, so the server computes created + 30 days); the agent and the
  dashboard flag SENT invoices past their due date as overdue and can send
  a PayPal payment reminder (`POST /v2/invoicing/invoices/{id}/remind`,
  204) — only SENT invoices can be reminded, validated server-side
  before any PayPal call.
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
agent, the PayPal Orders + Invoicing + Subscriptions + Webhooks
integrations, the invoice reminders, the group-buying flow, the AG Grid
merchant dashboard and the SQLite persistence — was built in that window.

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
  quantities) still read correctly. Verified (v3 seed): smart restock
  totals $56 with the oat-milk line at $14 from Green Valley Farms; v10
  seed: $58.47 with the oat-milk line at $5.99.
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
  (`NET_7` is invalid) — v10 uses `NET_30`, which gives every invoice a
  real 30-day due date. Sending an invoice with an explicit invoicer email
  fails with 422 USER_NOT_FOUND unless that email is the PayPal account
  that owns the app — the v10 probe caught this (the old hardcoded
  `merchant@agentmart.example` meant "Send invoice" never worked), and the
  fix is to send no invoicer object at all: PayPal defaults the invoicer
  to the API caller (verified: send → 200, remind on a SENT invoice →
  204). Remind on a DRAFT invoice fails with 422 CANNOT_REMIND_INVOICE,
  so the server validates SENT first.
- Judges must be able to run the project with no PayPal account of their
  own: hence the hosted Render demo plus a verified sandbox order id in the
  README.

## What's next
- Scheduled auto-reminders: v10 reminds on demand from chat and the dashboard; the next step is a schedule that reminds automatically when an invoice goes overdue.
- Persistent hosting for the demo database, so the captured-order history survives host restarts (today the free-tier host resets to seed state).

---

## Demo video (final cut v4, 2026-11-06 — 2:44.8, under 3:00, public on YouTube)

Filmed on the live hosted demo (agentmart.fenbig.com) plus one planning
segment filmed on a local seed instance of the same app (identical UI and
numbers, no order id shown). English narration, royalty-free synthesized
ambient bed, no copyrighted music. All numbers below are the real sandbox
figures visible in the video.

- **0:00–0:17 — Cold open.** PayPal receipt: order 8VK52141NX367420D COMPLETED $58.47, expected delivery 2026-11-10; dashboard stats: 1 order, 1 captured, $58.47 captured revenue, $1.20 saved by cheaper suppliers, 1 stock-out prevented.
- **0:17–0:36 — What am I running out of?** The agent lists stock with days left; Craft Matcha is LOW at 1 bag, ~3.3 days. Forecast grid says matcha runs out 2026-11-09, "order now". Weekly plan "Weekly restock — Monday" $60, next run 2026-11-09.
- **0:36–0:56 — Did any prices go up — or down?** The agent reports the creepers (Craft Matcha +11%, Blend Beans +9% in 3 months) and the droppers (Craft Instant Coffee −11.4%, Bright Cold Brew −10.8%) — a falling price is a good time to stock up — and names the cheaper alternate supplier per line.
- **0:56–1:25 — The agent decides.** The agent reasons about the restock: what is running low, which prices crept, who is cheapest for oat milk. Then the status lookup: "Order 8VK52141NX367420D is COMPLETED — total $58.47: matcha ×1 $40.50 (Kyoto Tea Imports), oat-milk ×3 $5.99 (Green Valley Farms)" — answered by llm:baseten:meta-models/muse-spark-open-1026. Caption: "$58.47 · save $1.20".
- **1:25–1:43 — Capture.** A real PayPal sandbox approval page, then the webhook grid: CHECKOUT.ORDER.APPROVED → PAYMENT.CAPTURE.COMPLETED (capture 1XT11946MS782974U) → order COMPLETED $58.47. Caption: "PAID · webhook received".
- **1:43–2:02 — Subscribe once, bill weekly.** Subscription I-XH6YV9BHG1P9 flips from APPROVAL_PENDING to ACTIVE $58.47/week; the webhook grid shows BILLING.SUBSCRIPTION.ACTIVATED pushed by PayPal — the status updated itself, no Refresh click. Next billing date 7 days out. "Approve once — the box bills itself every week."
- **2:02–2:19 — Buy together, pay less ("one more thing").** The Bay Area Specialty Cafés group: matcha pooled to 25 units across 3 cafés → Tier 2, $36.45 instead of $40.50, saves $101.25 vs ordering alone; oat milk pooled to 20 → Tier 1, $5.69 instead of $5.99. Caption: "25 bags · 3 cafés · −10% · save $101.25". (Philz Coffee and Sightglass Coffee are demo members, not real participants — stated on screen.)
- **2:19–2:40 — Merchant dashboard + close.** Inventory all OK after the delivery; supplier price grid with creep and drop alerts and best-buy column; the payables ledger for the suppliers in the order ($40.50 Kyoto Tea Imports + $17.97 Green Valley Farms, Net 7, UNPAID); the forecast grid and the weekly plan; the subscriptions grid with the ACTIVE box. Closing line: "One agent, one catalog, one PayPal checkout — restock at the speed of a sentence, before you run out, from the cheaper supplier, and always know what you owe."
- **2:40–2:45 — End card.** "AgentMart — the café that buys itself." One CTA: "Try the live demo — link in the Devpost description."

Recording notes: sandbox buyer credentials only (never a real account), recorded
at 1080p, no third-party music/trademarks in the video (hackathon rule).
