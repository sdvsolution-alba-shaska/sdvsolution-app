// POST /api/portal — open the Stripe billing portal for the signed-in company
// (update card, change quantity, view invoices, cancel). Auth: Bearer token.
import { stripe, getCallerOrg, originOf, ok, err } from "./_billing.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return err(res, 405, "Method not allowed");
  if (!process.env.STRIPE_SECRET_KEY) return err(res, 500, "STRIPE_SECRET_KEY not set");
  try {
    const ctx = await getCallerOrg(req);
    if (ctx.error) return err(res, ctx.status, ctx.error);
    const { membership, org } = ctx;
    if (membership.role !== "owner" && membership.role !== "admin") return err(res, 403, "Only an owner or admin can manage billing.");
    if (!org.stripe_customer_id) return err(res, 400, "No subscription yet — choose a plan first.");

    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: originOf(req),
    });
    return ok(res, { url: session.url });
  } catch (e) {
    return err(res, 500, e && e.message ? e.message : String(e));
  }
}
