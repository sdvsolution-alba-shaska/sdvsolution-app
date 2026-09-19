// POST /api/checkout — start a Stripe Checkout session for the signed-in company.
// Body: { plan: "basic" | "pro", seats: number }. Auth: Bearer <supabase access token>.
import { stripe, admin, PRICE, readJson, getCallerOrg, countMembers, originOf, ok, err } from "./_billing.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return err(res, 405, "Method not allowed");
  if (!process.env.STRIPE_SECRET_KEY) return err(res, 500, "STRIPE_SECRET_KEY not set");
  try {
    const ctx = await getCallerOrg(req);
    if (ctx.error) return err(res, ctx.status, ctx.error);
    const { membership, org } = ctx;
    if (membership.role !== "owner" && membership.role !== "admin") return err(res, 403, "Only an owner or admin can manage billing.");

    const body = await readJson(req);
    const plan = String(body.plan || "").toLowerCase();
    const price = PRICE[plan];
    if (!price) return err(res, 400, "Unknown or unpriced plan: " + plan);

    // Seats are the company's actual team size — not a manual number — so the
    // bill matches who's in the workspace. (At least 1.)
    const seats = await countMembers(org.id);

    // Reuse or create the Stripe customer for this org.
    let customer = org.stripe_customer_id;
    // Self-heal: if the stored customer doesn't exist in THIS Stripe account
    // (e.g. after switching test↔live, or if it was deleted), forget it and make a new one.
    if (customer) {
      try { const c = await stripe.customers.retrieve(customer); if (!c || c.deleted) customer = null; }
      catch (e) { customer = null; }
    }
    if (!customer) {
      const c = await stripe.customers.create({ email: membership.email, name: org.name || org.domain, metadata: { org_id: org.id, domain: org.domain } });
      customer = c.id;
      await admin.from("organizations").update({ stripe_customer_id: customer, stripe_subscription_id: null }).eq("id", org.id);
    }

    const origin = originOf(req);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price, quantity: seats }],
      subscription_data: { trial_period_days: 14, metadata: { org_id: org.id, plan } },
      client_reference_id: org.id,
      metadata: { org_id: org.id, plan },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      // Offer whatever payment methods are enabled on the Stripe account —
      // card AND bank direct debit (ACH for US banks, SEPA for EU). Stripe only
      // shows the ones valid for the price's currency, so we don't hard-code a
      // list (SEPA is EUR-only, ACH USD-only). Enable ACH/SEPA in the Stripe
      // Dashboard → Settings → Payment methods (see BILLING_SETUP.md).
      // 'always' forces the chosen method (incl. a bank account) to be collected
      // even though the first 14 days are free — otherwise there'd be nothing to
      // debit when the trial ends.
      payment_method_collection: "always",
      success_url: origin + "/?billing=success",
      cancel_url: origin + "/?billing=cancel",
    });
    return ok(res, { url: session.url });
  } catch (e) {
    return err(res, 500, e && e.message ? e.message : String(e));
  }
}
