// POST /api/runner — runner-facing job API. Authenticated by a revocable runner token (Authorization: Bearer sdvr_…),
// NOT by a user session and never with a database key. Body: { action, ... }
//   claim      { info? }                          → { job } | { job: null }   (atomic; a job goes to exactly one runner)
//   heartbeat  { id, log? }                       → { cancel: bool }          (every ~20 s while building)
//   complete   { id, status, result, log, files } → { ok }                    (status: passed | failed | errored)
import { db, readJson } from "./_db.js";
import * as svc from "./_buildService.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const runner = await svc.authRunner(db, token);
    if (!runner) { res.status(401).json({ error: "Invalid or revoked runner token." }); return; }
    const body = await readJson(req);
    const act = { claim: svc.runnerClaim, heartbeat: svc.runnerHeartbeat, complete: svc.runnerComplete }[String(body.action || "")];
    if (!act) { res.status(400).json({ error: "Unknown action." }); return; }
    const r = await act(db, runner, body);
    res.status(r.status).json(r.body);
  } catch (e) { res.status(500).json({ error: "Runner API error: " + (e && e.message ? e.message : String(e)) }); }
}
