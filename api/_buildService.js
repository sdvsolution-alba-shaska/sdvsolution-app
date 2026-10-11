// Build-job rules, independent of how data is stored. The real API handlers pass a Supabase-backed `db`
// (api/_db.js); the tests pass an in-memory one (tests/memdb.mjs) — so the end-to-end test exercises THESE rules.
//
// db interface (all async):
//   getWorkspace(orgId) -> workspace JSON | null          countBuildsSince(orgId, iso) -> number
//   hasLiveCustomerRunner(orgId) -> bool                   insertBuild(row) -> row
//   listBuilds(orgId, { bmId, limit }) -> rows              getBuild(id) -> row | null
//   getBuildFiles(id) -> [{name, content, sha256, bytes}]   cancelBuild(orgId, id) -> row | null
//   requeueStale() -> n                                     claim(runnerId, orgId|null, pool) -> row | null
//   heartbeat(id, runnerId, logAppend) -> { status } | null completeBuild(id, runnerId, patch, files) -> bool
//   createRunner(row) -> row    listRunners(orgId) -> rows   revokeRunner(orgId, id) -> bool
//   runnerByTokenHash(hash) -> runner | null                 touchRunner(id, info) -> void
import crypto from "node:crypto";
import { checkBuildable, modelHash, GENERATOR_VERSION } from "../src/lib/codegen.js";

export const LIMITS = {
  monthlyCap: Number(process.env.BUILD_MONTHLY_CAP || 50), // per-org builds per calendar month (cost guard until Build & Release pricing exists)
  maxFiles: 60, maxBytes: 3000000, maxResultBytes: 60000, maxLogBytes: 200000,
};
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const hashToken = sha256;
export const newToken = () => "sdvr_" + crypto.randomBytes(24).toString("hex");

const fail = (status, error, extra) => ({ status, body: { error, ...(extra || {}) } });
const okr = (body) => ({ status: 200, body });
const canEdit = (role) => role !== "viewer";
const isAdmin = (role) => role === "owner" || role === "admin";
const label = (b) => "B-" + b.build_no;

// What the app is allowed to see about a build: never the frozen model or the runner id.
export function publicBuild(b) {
  if (!b) return null;
  return { id: b.id, buildNo: b.build_no, label: label(b), bmId: b.bm_id, functionId: b.function_id, title: b.title, baselineId: b.baseline_id, baselineName: b.baseline_name,
    status: b.status, pool: b.pool, modelHash: b.model_hash, generatorVersion: b.generator_version, requestedBy: b.requested_email,
    createdAt: b.created_at, startedAt: b.started_at, finishedAt: b.finished_at, attempts: b.attempts, result: b.result || null, log: b.log || "" };
}

/* ------------------------------- app-facing ------------------------------- */
export async function requestBuild(db, caller, body) {
  if (!canEdit(caller.role)) return fail(403, "Viewers can't request builds.");
  const bmId = String(body.bmId || ""), baselineId = String(body.baselineId || "");
  if (!bmId || !baselineId) return fail(400, "bmId and baselineId are required.");
  const ws = await db.getWorkspace(caller.orgId);
  const baseline = ((ws && ws.baselines) || []).find((b) => b && b.id === baselineId);
  if (!baseline) return fail(400, "That baseline isn't in your saved workspace yet. Wait a moment for autosave, then try again.");
  // The build input is the model AS FROZEN IN THE BASELINE — never what the browser sends.
  const model = baseline.snap && baseline.snap.behaviorModels && baseline.snap.behaviorModels[bmId];
  const gate = checkBuildable(model, baseline);
  if (!gate.ok) return fail(422, gate.reasons.join(" "), { reasons: gate.reasons });
  const now = new Date(), monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const used = await db.countBuildsSince(caller.orgId, monthStart);
  if (used >= LIMITS.monthlyCap) return fail(429, "Monthly build limit reached (" + LIMITS.monthlyCap + "). Contact us about the Build & Release plan.");
  const pool = (await db.hasLiveCustomerRunner(caller.orgId)) ? "customer" : "managed";
  const row = await db.insertBuild({
    org_id: caller.orgId, requested_by: caller.userId, requested_email: caller.email, bm_id: bmId, function_id: model.function, title: model.title,
    baseline_id: baseline.id, baseline_name: baseline.name || "", model, model_hash: modelHash(model), generator_version: GENERATOR_VERSION, pool, status: "queued",
  });
  return okr({ build: publicBuild(row) });
}
export async function listBuilds(db, caller, body) {
  const rows = await db.listBuilds(caller.orgId, { bmId: body.bmId || null, limit: Math.min(Number(body.limit) || 30, 100) });
  return okr({ builds: rows.map(publicBuild) });
}
export async function getBuild(db, caller, body) {
  const b = await db.getBuild(String(body.id || ""));
  if (!b || b.org_id !== caller.orgId) return fail(404, "Build not found.");
  const out = { build: publicBuild(b) };
  if (body.files) out.files = await db.getBuildFiles(b.id);
  return okr(out);
}
export async function cancelBuild(db, caller, body) {
  if (!canEdit(caller.role)) return fail(403, "Viewers can't cancel builds.");
  const b = await db.cancelBuild(caller.orgId, String(body.id || ""));
  return b ? okr({ build: publicBuild(b) }) : fail(409, "Build not found or already finished.");
}
export async function createRunner(db, caller, body) {
  const managed = !!body.managed;
  if (managed ? !caller.isOperator : !isAdmin(caller.role)) return fail(403, managed ? "Operator access only." : "Only owners and admins can register runners.");
  const name = String(body.name || "").trim().slice(0, 80) || "runner";
  const token = newToken();
  const row = await db.createRunner({ org_id: managed ? null : caller.orgId, name, token_hash: hashToken(token), created_by: caller.userId });
  return okr({ runner: { id: row.id, name: row.name, managed }, token, note: "Copy this token now — it is shown once and cannot be recovered." });
}
export async function listRunners(db, caller) {
  if (!isAdmin(caller.role)) return fail(403, "Only owners and admins can see runners.");
  const rows = await db.listRunners(caller.orgId);
  return okr({ runners: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at, revoked: !!r.revoked_at, info: r.info || {} })) });
}
export async function revokeRunner(db, caller, body) {
  if (!isAdmin(caller.role)) return fail(403, "Only owners and admins can revoke runners.");
  return (await db.revokeRunner(caller.orgId, String(body.id || ""))) ? okr({ ok: true }) : fail(404, "Runner not found.");
}

/* ------------------------------ runner-facing ------------------------------ */
export async function authRunner(db, token) {
  if (!token) return null;
  const r = await db.runnerByTokenHash(hashToken(token));
  return r && !r.revoked_at ? r : null;
}
export async function runnerClaim(db, runner, body) {
  await db.touchRunner(runner.id, body && body.info);
  await db.requeueStale();
  const job = await db.claim(runner.id, runner.org_id || null, runner.org_id ? "customer" : "managed");
  if (!job) return okr({ job: null });
  return okr({ job: { id: job.id, buildNo: job.build_no, label: label(job), bmId: job.bm_id, functionId: job.function_id, model: job.model, modelHash: job.model_hash, baselineId: job.baseline_id, requestedGenerator: job.generator_version, limits: { logBytes: LIMITS.maxLogBytes, files: LIMITS.maxFiles, bytes: LIMITS.maxBytes } } });
}
export async function runnerHeartbeat(db, runner, body) {
  const r = await db.heartbeat(String(body.id || ""), runner.id, String(body.log || "").slice(-20000));
  if (!r) return fail(409, "You don't hold this job.");
  return okr({ cancel: r.status === "canceled" });
}
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./+-]{0,119}$/;
export async function runnerComplete(db, runner, body) {
  const status = String(body.status || "");
  if (!["passed", "failed", "errored"].includes(status)) return fail(400, "status must be passed, failed or errored.");
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > LIMITS.maxFiles) return fail(413, "Too many files (max " + LIMITS.maxFiles + ").");
  let total = 0; const clean = [];
  for (const f of files) {
    if (!f || typeof f.name !== "string" || typeof f.content !== "string") return fail(400, "Each file needs a name and text content.");
    if (!SAFE_NAME.test(f.name) || f.name.includes("..")) return fail(400, "Unsafe file name: " + f.name);
    total += f.content.length; clean.push({ name: f.name, content: f.content, sha256: sha256(f.content), bytes: f.content.length });
  }
  if (total > LIMITS.maxBytes) return fail(413, "Files too large (max " + LIMITS.maxBytes + " bytes).");
  const result = body.result && typeof body.result === "object" ? body.result : {};
  if (JSON.stringify(result).length > LIMITS.maxResultBytes) return fail(413, "Result too large.");
  const done = await db.completeBuild(String(body.id || ""), runner.id, { status, result, log: String(body.log || "").slice(-LIMITS.maxLogBytes) }, clean);
  return done ? okr({ ok: true }) : fail(409, "You don't hold this job (it may have been canceled or re-queued).");
}
