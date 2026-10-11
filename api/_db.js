// Supabase-backed implementation of the `db` interface used by _buildService.js (service-role client; bypasses RLS,
// so every query below filters by org / runner explicitly).
import { createClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const admin = createClient(SUPA_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const LIST_COLS = "id,build_no,org_id,bm_id,function_id,title,baseline_id,baseline_name,model_hash,generator_version,requested_email,pool,status,attempts,created_at,started_at,finished_at,result";
const GET_COLS = LIST_COLS + ",log";   // never select `model` (large, and the app has no need for it)
const must = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };

export const db = {
  async getWorkspace(orgId) { const d = must(await admin.from("workspaces").select("data").eq("org_id", orgId).maybeSingle()); return d ? d.data : null; },
  async countBuildsSince(orgId, iso) { const r = await admin.from("builds").select("id", { count: "exact", head: true }).eq("org_id", orgId).gte("created_at", iso); if (r.error) throw new Error(r.error.message); return r.count || 0; },
  async hasLiveCustomerRunner(orgId) { const since = new Date(Date.now() - 10 * 60 * 1000).toISOString(); const r = await admin.from("runners").select("id", { count: "exact", head: true }).eq("org_id", orgId).is("revoked_at", null).gte("last_seen_at", since); if (r.error) throw new Error(r.error.message); return (r.count || 0) > 0; },
  async insertBuild(row) { return must(await admin.from("builds").insert(row).select(LIST_COLS).single()); },
  async listBuilds(orgId, { bmId, limit }) { let q = admin.from("builds").select(LIST_COLS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(limit || 30); if (bmId) q = q.eq("bm_id", bmId); return must(await q) || []; },
  async getBuild(id) { if (!/^[0-9a-f-]{36}$/i.test(id)) return null; return must(await admin.from("builds").select(GET_COLS).eq("id", id).maybeSingle()); },
  async getBuildFiles(id) { return must(await admin.from("build_files").select("name,content,sha256,bytes").eq("build_id", id).order("name")) || []; },
  async cancelBuild(orgId, id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = must(await admin.from("builds").update({ status: "canceled", finished_at: new Date().toISOString() }).eq("id", id).eq("org_id", orgId).in("status", ["queued", "running"]).select(LIST_COLS));
    return rows && rows[0] ? rows[0] : null;
  },
  async requeueStale() { const r = await admin.rpc("requeue_stale_builds", { p_minutes: 5 }); return r.error ? 0 : r.data; },
  async claim(runnerId, orgId, pool) { const r = await admin.rpc("claim_build", { p_runner: runnerId, p_org: orgId, p_pool: pool }); if (r.error) throw new Error(r.error.message); return Array.isArray(r.data) && r.data[0] ? r.data[0] : null; },
  async heartbeat(id, runnerId, logAppend) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const b = must(await admin.from("builds").select("id,runner_id,status,log").eq("id", id).maybeSingle());
    if (!b || b.runner_id !== runnerId) return null;
    if (b.status !== "running") return { status: b.status };
    const log = ((b.log || "") + (logAppend || "")).slice(-200000);
    must(await admin.from("builds").update({ last_heartbeat: new Date().toISOString(), log }).eq("id", id).eq("runner_id", runnerId));
    return { status: "running" };
  },
  async completeBuild(id, runnerId, patch, files) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const rows = must(await admin.from("builds").update({ ...patch, finished_at: new Date().toISOString(), last_heartbeat: new Date().toISOString() }).eq("id", id).eq("runner_id", runnerId).eq("status", "running").select("id"));
    if (!rows || !rows[0]) return false;
    if (files.length) must(await admin.from("build_files").upsert(files.map((f) => ({ build_id: id, ...f })), { onConflict: "build_id,name" }));
    return true;
  },
  async createRunner(row) { return must(await admin.from("runners").insert(row).select("id,name,org_id").single()); },
  async listRunners(orgId) { return must(await admin.from("runners").select("id,name,created_at,last_seen_at,revoked_at,info").eq("org_id", orgId).order("created_at", { ascending: false })) || []; },
  async revokeRunner(orgId, id) { if (!/^[0-9a-f-]{36}$/i.test(id)) return false; const rows = must(await admin.from("runners").update({ revoked_at: new Date().toISOString() }).eq("id", id).eq("org_id", orgId).is("revoked_at", null).select("id")); return !!(rows && rows[0]); },
  async runnerByTokenHash(hash) { return must(await admin.from("runners").select("id,org_id,name,revoked_at").eq("token_hash", hash).maybeSingle()); },
  async touchRunner(id, info) { const patch = { last_seen_at: new Date().toISOString() }; if (info && typeof info === "object") patch.info = info; await admin.from("runners").update(patch).eq("id", id); },
};

// Identify the signed-in user (Supabase JWT) and their organization + role.
export async function getCaller(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: "Not signed in", status: 401 };
  const { data: u, error } = await admin.auth.getUser(token);
  if (error || !u || !u.user) return { error: "Invalid session", status: 401 };
  const { data: mem } = await admin.from("memberships").select("org_id, role, email").eq("user_id", u.user.id).maybeSingle();
  if (!mem) return { error: "No organization for this user", status: 400 };
  const email = String(u.user.email || "").toLowerCase();
  const ops = (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return { caller: { userId: u.user.id, email, orgId: mem.org_id, role: mem.role === "member" ? "editor" : mem.role, isOperator: /@sdvsolution\.com$/.test(email) || ops.includes(email) } };
}

export async function readJson(req) {
  let b = req.body; if (b && typeof b === "object") return b;
  if (typeof b !== "string" || !b) b = await new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
  try { return b ? JSON.parse(b) : {}; } catch (e) { return {}; }
}
