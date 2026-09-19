// POST /api/sync-seats — make the Stripe subscription quantity match the number
// of members in the caller's company, so the monthly bill always tracks team
// size. Called when someone joins (their app's first load), when a member is
// removed, and on app load as a self-heal. Any signed-in member may call it —
// it can only set the quantity to the company's REAL member count, nothing else.
//
// Behaviour by state:
//   * Active/trialing subscription  -> update the item quantity (prorated).
//   * Trial / no subscription       -> no charge; just record the seat count.
import { stripe, admin, countMembers, getCallerOrg, ok, err } from "./_billing.js";

const BILLABLE_STATUS = new Set(["active", "trialing", "past_due"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return err(res, 405, "Method not allowed");
  if (!process.env.STRIPE_SECRET_KEY) return err(res, 500, "STRIPE_SECRET_KEY not set");
  try {
    const ctx = await getCallerOrg(req);
    if (ctx.error) return err(res, ctx.status, ctx.error);
    const { org } = ctx;

    const seats = await countMembers(org.id);
    let billed = false, quantity = seats;

    if (org.stripe_subscription_id) {
      let sub = null;
      try { sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id); }
      catch (e) { sub = null; } // subscription vanished (e.g. test↔live) — treat as none
      if (sub && BILLABLE_STATUS.has(sub.status)) {
        const item = sub.items && sub.items.data && sub.items.data[0];
        if (item && item.quantity !== seats) {
          await stripe.subscriptions.update(sub.id, {
            items: [{ id: item.id, quantity: seats }],
            proration_behavior: "create_prorations",
          });
        }
        billed = true;
        quantity = seats;
      }
    }

    // Record the current seat count on the org for the UI (the webhook will also
    // set it authoritatively when Stripe emits subscription.updated).
    await admin.from("organizations").update({ seats }).eq("id", org.id);

    return ok(res, { seats, billed, quantity });
  } catch (e) {
    return err(res, 500, e && e.message ? e.message : String(e));
  }
}
