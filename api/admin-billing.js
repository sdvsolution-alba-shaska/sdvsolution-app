// GET /api/admin-billing — OPERATOR-ONLY. Returns billing status for every
// organization (company) so SDVsolution staff can see who's paid at a glance,
// without opening the Stripe or Supabase dashboards.
//
// Security: this uses the service_role key (bypasses RLS), so it is gated to
// operators. A caller is an operator if their verified email either ends in
// @sdvsolution.com OR is listed in the ADMIN_EMAILS env var (comma-separated).
// Set in Vercel → Project → Settings → Environment Variables, e.g.:
//   ADMIN_EMAILS = gshaska@gmail.com,ops@sdvsolution.com
import { admin, ok, err } from "./_billing.js";

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

function isOperator(email) {
  const e = String(email || "").toLowerCase();
  if (!e) return false;
  if (/@sdvsolution\.com$/.test(e)) return true;
  return ADMIN_EMAILS.includes(e);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return err(res, 405, "Method not allowed");
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return err(res, 401, "Not signed in");
    const { data: u, error: uerr } = await admin.auth.getUser(token);
    if (uerr || !u || !u.user) return err(res, 401, "Invalid session");
    if (!isOperator(u.user.email)) return err(res, 403, "Operator access only");

    const { data: orgs, error } = await admin
      .from("organizations")
      .select("id, name, domain, plan_status, seats, current_period_end, stripe_customer_id, stripe_subscription_id")
      .order("current_period_end", { ascending: true, nullsFirst: false });
    if (error) return err(res, 500, error.message);

    // Never leak internal ids beyond what the UI needs; keep the customer id so
    // the UI can deep-link to Stripe, but drop nothing sensitive here (no keys).
    const rows = (orgs || []).map((o) => ({
      id: o.id,
      name: o.name || o.domain || "(unnamed)",
      domain: o.domain || "",
      plan_status: o.plan_status || "none",
      seats: o.seats || 0,
      current_period_end: o.current_period_end || null,
      stripe_customer_id: o.stripe_customer_id || null,
      has_subscription: !!o.stripe_subscription_id,
    }));
    return ok(res, { orgs: rows, as_of: new Date().toISOString() });
  } catch (e) {
    return err(res, 500, e && e.message ? e.message : String(e));
  }
}
