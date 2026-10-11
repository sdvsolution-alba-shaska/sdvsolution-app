// In-memory implementation of the `db` interface from api/_buildService.js — same semantics as the SQL
// (claim = atomic, heartbeat/complete only for the holding runner, stale builds requeue then error out).
import crypto from "node:crypto";

export function makeMemDb() {
  const db = { workspaces: new Map(), builds: [], files: new Map(), runners: [], seq: 0, staleMs: 5 * 60 * 1000 };
  const nowIso = () => new Date().toISOString();
  const copy = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
  const api = {
    _state: db,
    async getWorkspace(orgId) { return copy(db.workspaces.get(orgId) || null); },
    async countBuildsSince(orgId, iso) { return db.builds.filter((b) => b.org_id === orgId && b.created_at >= iso).length; },
    async hasLiveCustomerRunner(orgId) { const since = Date.now() - 10 * 60 * 1000; return db.runners.some((r) => r.org_id === orgId && !r.revoked_at && r.last_seen_at && Date.parse(r.last_seen_at) >= since); },
    async insertBuild(row) { const b = { id: crypto.randomUUID(), build_no: ++db.seq, attempts: 0, created_at: nowIso(), claimed_at: null, started_at: null, finished_at: null, last_heartbeat: null, runner_id: null, result: null, log: "", ...copy(row) }; db.builds.push(b); return copy(b); },
    async listBuilds(orgId, { bmId, limit }) { return copy(db.builds.filter((b) => b.org_id === orgId && (!bmId || b.bm_id === bmId)).sort((a, b) => b.build_no - a.build_no).slice(0, limit || 30)); },
    async getBuild(id) { return copy(db.builds.find((b) => b.id === id) || null); },
    async getBuildFiles(id) { return copy(db.files.get(id) || []); },
    async cancelBuild(orgId, id) { const b = db.builds.find((x) => x.id === id && x.org_id === orgId && ["queued", "running"].includes(x.status)); if (!b) return null; b.status = "canceled"; b.finished_at = nowIso(); return copy(b); },
    async requeueStale() { let n = 0; for (const b of db.builds) if (b.status === "running" && Date.now() - Date.parse(b.last_heartbeat) > db.staleMs) { n++; if (b.attempts < 3) { b.status = "queued"; b.runner_id = null; } else { b.status = "errored"; b.finished_at = nowIso(); b.result = { error: "runner stopped responding (3 attempts)" }; } } return n; },
    async claim(runnerId, orgId, pool) { const b = db.builds.filter((x) => x.status === "queued" && x.pool === pool && (!orgId || x.org_id === orgId)).sort((a, c) => Date.parse(a.created_at) - Date.parse(c.created_at) || a.build_no - c.build_no)[0]; if (!b) return null; Object.assign(b, { status: "running", runner_id: runnerId, claimed_at: nowIso(), started_at: nowIso(), last_heartbeat: nowIso(), attempts: b.attempts + 1 }); return copy(b); },
    async heartbeat(id, runnerId, logAppend) { const b = db.builds.find((x) => x.id === id); if (!b || b.runner_id !== runnerId) return null; if (b.status !== "running") return { status: b.status }; b.last_heartbeat = nowIso(); b.log = ((b.log || "") + (logAppend || "")).slice(-200000); return { status: "running" }; },
    async completeBuild(id, runnerId, patch, files) { const b = db.builds.find((x) => x.id === id && x.runner_id === runnerId && x.status === "running"); if (!b) return false; Object.assign(b, patch, { finished_at: nowIso(), last_heartbeat: nowIso() }); db.files.set(id, copy(files)); return true; },
    async createRunner(row) { const r = { id: crypto.randomUUID(), created_at: nowIso(), last_seen_at: null, revoked_at: null, info: {}, ...row }; db.runners.push(r); return copy(r); },
    async listRunners(orgId) { return copy(db.runners.filter((r) => r.org_id === orgId)); },
    async revokeRunner(orgId, id) { const r = db.runners.find((x) => x.id === id && x.org_id === orgId && !x.revoked_at); if (!r) return false; r.revoked_at = nowIso(); return true; },
    async runnerByTokenHash(h) { return copy(db.runners.find((r) => r.token_hash === h) || null); },
    async touchRunner(id, info) { const r = db.runners.find((x) => x.id === id); if (r) { r.last_seen_at = nowIso(); if (info && typeof info === "object") r.info = info; } },
  };
  return api;
}
