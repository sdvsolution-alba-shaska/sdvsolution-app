// Shared helpers for the billing serverless functions.
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Server-side Supabase client with the service_role key (bypasses RLS).
export const admin = createClient(SUPA_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export const PRICE = {
  basic: process.env.STRIPE_PRICE_BASIC || "",
  advance: process.env.STRIPE_PRICE_ADVANCE || "",
  pro: process.env.STRIPE_PRICE_PRO || "",
};

export function planFromPrice(priceId) {
  if (priceId && priceId === process.env.STRIPE_PRICE_BASIC) return "basic";
  if (priceId && priceId === process.env.STRIPE_PRICE_ADVANCE) return "advance";
  if (priceId && priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  return null;
}

// Read + JSON-parse the request body (Vercel may or may not pre-parse).
export async function readJson(req) {
  let b = req.body;
  if (b && typeof b === "object") return b;
  if (typeof b !== "string" || !b) {
    b = await new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
  }
  try { return b ? JSON.parse(b) : {}; } catch (e) { return {}; }
}

// Identify the signed-in user (from the Supabase JWT) and their organization.
export async function getCallerOrg(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: "Not signed in", status: 401 };
  const { data: u, error: uerr } = await admin.auth.getUser(token);
  if (uerr || !u || !u.user) return { error: "Invalid session", status: 401 };
  const { data: mem } = await admin.from("memberships").select("org_id, role, email").eq("user_id", u.user.id).maybeSingle();
  if (!mem) return { error: "No organization for this user", status: 400 };
  const { data: org } = await admin.from("organizations").select("*").eq("id", mem.org_id).maybeSingle();
  if (!org) return { error: "Organization not found", status: 400 };
  return { user: u.user, membership: mem, org };
}

// Count an org's billable members. Every membership is a billed seat (there is
// no free/viewer role), so this is simply the member count (minimum 1).
export async function countMembers(orgId) {
  const { count } = await admin
    .from("memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("org_id", orgId);
  return Math.max(1, count || 1);
}

export function originOf(req) {
  return req.headers.origin || ("https://" + (req.headers.host || "app.sdvsolution.com"));
}

export function ok(res, body) { res.status(200).json(body); }
export function err(res, status, message) { res.status(status).json({ error: message }); }
