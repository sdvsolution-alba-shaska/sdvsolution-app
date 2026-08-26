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
2. **Products → Add product**:
   - *SDVsolution Basic* → recurring price **$249 / month**, "Usage: per seat"
     is optional; we pass quantity = editors. Copy the **Price ID** (`price_…`).
   - *SDVsolution Pro* → recurring price **$399 / month**. Copy its **Price ID**.
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
| `STRIPE_PRICE_BASIC` | `price_…` for Basic |
| `STRIPE_PRICE_PRO` | `price_…` for Pro |
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

## Notes / not done yet
- **Only owners/admins** can start checkout or open the portal (enforced in the
  functions).
- **Entitlement enforcement** (blocking a company that exceeds its plan's
  requirement/project/seat limits) isn't wired yet — the plan is stored and shown,
  but caps aren't hard‑enforced in the UI. That's the natural next step.
- The 14‑day trial is applied by Checkout (`trial_period_days: 14`).
