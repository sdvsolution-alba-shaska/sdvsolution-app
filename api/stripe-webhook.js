// POST /api/stripe-webhook — receive Stripe events and update the company's plan
// in Supabase. Configure this URL in Stripe → Developers → Webhooks, and put the
// signing secret in STRIPE_WEBHOOK_SECRET.
//
// Signature verification needs the RAW body, so body parsing is disabled here.
import { stripe, admin, planFromPrice } from "./_billing.js";

export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function applySubscription(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const priceId = item && item.price && item.price.id;
  const seats = (item && item.quantity) || 1;
  const status = sub.status; // trialing | active | past_due | canceled | unpaid | incomplete
  const period_end = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
  const patch = { stripe_subscription_id: sub.id, seats, plan_status: status, current_period_end: period_end };
  if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") patch.plan = "trial";
  else { const p = planFromPrice(priceId); if (p) patch.plan = p; }

  const orgId = sub.metadata && sub.metadata.org_id;
  let q = admin.from("organizations").update(patch);
  q = orgId ? q.eq("id", orgId) : q.eq("stripe_customer_id", sub.customer);
  await q;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  let event;
  try {
    const raw = await readRaw(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET || "");
  } catch (e) {
    res.status(400).send("Webhook signature verification failed: " + (e && e.message ? e.message : e));
    return;
  }
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        if (s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          if (s.metadata && s.metadata.org_id && !(sub.metadata && sub.metadata.org_id)) {
            sub.metadata = Object.assign({}, sub.metadata, { org_id: s.metadata.org_id });
          }
          await applySubscription(sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await applySubscription(event.data.object);
        break;
      }
      default:
        break;
    }
    res.status(200).json({ received: true });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
