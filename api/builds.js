// POST /api/builds — app-facing build API (signed-in users). Body: { action, ... }
//   request   { bmId, baselineId }   queue a build from a baseline (server re-checks the gate)
//   list      { bmId?, limit? }      your company's builds
//   get       { id, files? }         one build (+ its generated files when files:true)
//   cancel    { id }                 cancel a queued/running build
//   runner_create { name, managed? } register a runner → returns its token ONCE (owner/admin; managed = operators only)
//   runner_list / runner_revoke { id }
// Needs the phase5_builds.sql migration. Optional env: BUILD_MONTHLY_CAP (default 50 builds / org / month).
import { db, getCaller, readJson } from "./_db.js";
import * as svc from "./_buildService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const who = await getCaller(req);
    if (who.error) { res.status(who.status).json({ error: who.error }); return; }
    const body = await readJson(req); const caller = who.caller;
    const act = {
      request: svc.requestBuild, list: svc.listBuilds, get: svc.getBuild, cancel: svc.cancelBuild,
      runner_create: svc.createRunner, runner_list: svc.listRunners, runner_revoke: svc.revokeRunner,
    }[String(body.action || "")];
    if (!act) { res.status(400).json({ error: "Unknown action." }); return; }
    const r = await act(db, caller, body);
    res.status(r.status).json(r.body);
  } catch (e) { res.status(500).json({ error: "Build API error: " + (e && e.message ? e.message : String(e)) }); }
}
