# SDVsolution — Billing setup (Stripe)

Real per‑company subscriptions: a signed‑in owner picks Basic or Pro, pays via
Stripe Checkout, and a webhook writes the plan back to their company row in
Supabase. Test everything in Stripe **test mode** first, then flip to live.

## What's already in the code
- `api/checkout.js` — starts a Stripe Checkout session for the signed‑in company.
- `api/portal.js` — opens Stripe's billing portal (card, invoices, seats, cancel).
- `api/stripe-webhook.js` — updates the company's `plan`, `seats`, `plan_status`.
- App: **Billing** button (top bar) → Plan & Pricing + Account & Billing. Website
  "Choose Basic/Pro" send people to the app (`/?plan=basic|pro`), which opens the
  plan picker after they sign in.
- `supabase/phase3_billing.sql` — billing columns on `organizations`.

## Part 1 — Supabase
1. Supabase → SQL Editor → run **`supabase/phase3_billing.sql`**.
2. Project Settings → API → copy the **service_role** key (secret — server only).

## Part 2 — Stripe products & prices (test mode)
1. Create a Stripe account → toggle **Test mode** (top right).
2. **Products → Add product** (three paid tiers):
   - *SDVsolution Basic* → recurring **$249 / month**. Copy the **Price ID** (`price_…`).
   - *SDVsolution Advance* → recurring **$399 / month**. Copy its **Price ID**.
   - *SDVsolution Pro* → recurring **$499 / month**. Copy its **Price ID**.
   (We pass quantity = number of editors.)
3. **Developers → API keys** → copy the **Secret key** (`sk_test_…`).

## Part 3 — Stripe webhook
1. **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://app.sdvsolution.com/api/stripe-webhook`
3. Events to send: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`.
4. Copy the **Signing secret** (`whsec_…`).

## Part 4 — Vercel environment variables
Vercel → project → Settings → Environment Variables (Production). Add:

| Key | Value |
|-----|-------|
| `STRIPE_SECRET_KEY` | `sk_test_…` (Secret) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` (Secret) |
| `STRIPE_PRICE_BASIC` | `price_…` for Basic ($249) |
| `STRIPE_PRICE_ADVANCE` | `price_…` for Advance ($399) |
| `STRIPE_PRICE_PRO` | `price_…` for Pro ($499) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (Secret) |
| `SUPABASE_URL` | your `https://<ref>.supabase.co` (or it reuses `VITE_SUPABASE_URL`) |

Then **redeploy** (env vars are baked in at deploy time).

## Part 5 — Test the flow (test mode)
1. Sign in to the app → **Billing → Plan & Pricing → Upgrade** on Basic.
2. Stripe Checkout opens. Use test card **4242 4242 4242 4242**, any future
   expiry, any CVC/ZIP. Complete.
3. You're redirected back to `/?billing=success`. Within a few seconds the
   webhook updates the company; the plan chip should read **Basic**.
4. Supabase → Table Editor → `organizations`: the row now has
   `stripe_customer_id`, `stripe_subscription_id`, `plan=basic`, `plan_status`.
5. **Account & Billing → Manage billing** opens the Stripe portal.

## Part 6 — Go live
1. In Stripe, switch to **Live mode**, recreate the two products/prices, add a
   **live** webhook endpoint (same URL + events), and get **live** keys.
2. Update the six Vercel env vars with the **live** values, redeploy.
3. Connect your **bank account** in Stripe → Settings → Payouts (your
   SDVsolution business account) so funds settle to you.

## Seats follow the team automatically (Phase 4)
The monthly bill tracks company size — there's no manual seat number to keep in
sync. `api/sync-seats.js` sets the Stripe subscription quantity to the org's
member count and Stripe prorates the change:
- **A teammate accepts an invite** → their first app load calls `sync-seats`,
  which bumps the quantity (the company is charged for the new seat, prorated).
- **A member is removed** (Team tab) → `sync-seats` lowers the quantity.
- **Checkout** uses the current member count as the initial quantity.
- **Trial companies** can invite freely; there's no charge until they subscribe,
  at which point they're billed for their current team size.

No extra env vars or Stripe config are needed — it reuses the existing keys.

## Pay by bank account (ACH / SEPA direct debit)
Companies can pay from a **bank account**, not just a card — lower fees, better
for larger teams. Checkout already offers whatever methods your Stripe account
has enabled and forces the method to be collected during the trial
(`payment_method_collection: "always"`), so the only setup is a Dashboard toggle:

1. Stripe Dashboard → **Settings → Payment methods**.
2. Turn on **ACH Direct Debit** (US bank accounts). Turn on **SEPA Direct Debit**
   too if you sell to EU companies. (Leave card on for smaller teams.)
3. Do this in **both** Test and Live mode (top-left toggle) — they're separate.

That's it — no code or env changes. At checkout the company will now see
"US bank account / SEPA" next to card and can link their bank (instantly via
Stripe Financial Connections, or by micro-deposits). Stripe then auto-debits the
monthly bill from that account, and the seat-sync keeps the amount matching the
team size.

Notes: ACH is USD-only and SEPA is EUR-only, so Stripe shows each only when the
plan's currency matches. Bank verification via micro-deposits can take 1–2 days
the first time; instant verification is offered in Checkout when the bank
supports it. ACH payments can take a few business days to clear and can fail/return
later, which Stripe reports via the same subscription webhooks you already handle.

## Notes / not done yet
- **Only owners/admins** can start checkout, open the portal, or manage the team
  (enforced in the functions + RLS). Any member may trigger a seat re-sync, but
  it can only set the quantity to the real member count.
- **Entitlement enforcement** (blocking a company that exceeds its plan's
  requirement/project/seat limits) isn't wired yet — the plan is stored and shown,
  but caps aren't hard‑enforced in the UI. That's the natural next step.
- The 14‑day trial is applied by Checkout (`trial_period_days: 14`).
