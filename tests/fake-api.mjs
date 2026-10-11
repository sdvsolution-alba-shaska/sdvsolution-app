// A local stand-in for /api/builds and /api/runner that runs the REAL service logic (api/_buildService.js)
// on an in-memory database. Used by the end-to-end test and for demoing the UI without Supabase.
//   node tests/fake-api.mjs [port]      (default 5301; CORS open; the caller is a fixed demo user)
import http from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";
import * as svc from "../api/_buildService.js";
import { makeMemDb } from "./memdb.mjs";

export const ORG = "00000000-0000-0000-0000-00000000000a", OTHER_ORG = "00000000-0000-0000-0000-00000000000b";
export const CALLERS = {
  owner: { userId: "u-owner", email: "owner@acme.test", orgId: ORG, role: "owner", isOperator: false },
  editor: { userId: "u-editor", email: "editor@acme.test", orgId: ORG, role: "editor", isOperator: false },
  viewer: { userId: "u-viewer", email: "viewer@acme.test", orgId: ORG, role: "viewer", isOperator: false },
  other: { userId: "u-other", email: "other@rival.test", orgId: OTHER_ORG, role: "owner", isOperator: false },
  operator: { userId: "u-op", email: "ops@sdvsolution.com", orgId: ORG, role: "owner", isOperator: true },
};

export function startFakeApi({ db = makeMemDb(), port = 0 } = {}) {
  const server = http.createServer(async (req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST,OPTIONS" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json", ...cors }); res.end(JSON.stringify(body)); };
    if (req.method !== "POST") return send(405, { error: "Method not allowed" });
    let raw = ""; for await (const c of req) raw += c; let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return send(400, { error: "bad json" }); }
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    try {
      // demo-only: lets a browser harness stand in for the app's workspace autosave (the real app saves to Supabase)
      if (req.url === "/__ws") { db._state.workspaces.set(ORG, body.doc); return send(200, { ok: true }); }
      if (req.url === "/api/runner") {
        const runner = await svc.authRunner(db, token); if (!runner) return send(401, { error: "Invalid or revoked runner token." });
        const fn = { claim: svc.runnerClaim, heartbeat: svc.runnerHeartbeat, complete: svc.runnerComplete }[body.action]; if (!fn) return send(400, { error: "Unknown action." });
        const r = await fn(db, runner, body); return send(r.status, r.body);
      }
      if (req.url === "/api/builds") {
        const who = CALLERS[req.headers["x-test-caller"] || "owner"]; if (!who) return send(401, { error: "Not signed in" });
        const fn = { request: svc.requestBuild, list: svc.listBuilds, get: svc.getBuild, cancel: svc.cancelBuild, runner_create: svc.createRunner, runner_list: svc.listRunners, runner_revoke: svc.revokeRunner }[body.action]; if (!fn) return send(400, { error: "Unknown action." });
        const r = await fn(db, who, body); return send(r.status, r.body);
      }
      send(404, { error: "not found" });
    } catch (e) { send(500, { error: String(e && e.message || e) }); }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ url: "http://127.0.0.1:" + server.address().port, port: server.address().port, db, close: () => new Promise((r) => server.close(r)) })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const s = await startFakeApi({ port: Number(process.argv[2]) || 5301 });
  const tok = (await svc.createRunner(s.db, CALLERS.operator, { name: "demo-fleet", managed: true })).body.token;
  console.log("fake build API on " + s.url + " (demo only — in-memory)"); console.log("RUNNER_TOKEN=" + tok);
}
