// Run: node tests/builds.test.mjs
// Build service rules (api/_buildService.js) on the in-memory db: request gates, tenant isolation, runner auth,
// atomic claim, pool routing, completion limits, cancel and stale-job recovery. No compiler needed.
import * as svc from "../api/_buildService.js";
import { makeMemDb } from "./memdb.mjs";
import { CALLERS, ORG, OTHER_ORG } from "./fake-api.mjs";
import { PILOT_MODELS } from "../src/lib/pilotModels.js";

let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const BM = "BM-L2-BODY-00194";
const approved = () => ({ ...clone(PILOT_MODELS["L2-BODY-00194-MODE"]), status: "approved", qmConfirmed: { by: "safety@acme.test", at: 1 }, approvedBy: "x", approvedAt: 1 });
const seed = (db, models = { [BM]: approved() }, orgId = ORG) => { db._state.workspaces.set(orgId, { baselines: [{ id: "BL-1", name: "Release 1", ts: "2026-10-11", snap: { behaviorModels: models } }] }); };
const fresh = (models) => { const db = makeMemDb(); seed(db, models); return db; };
const req = (db, who, body) => svc.requestBuild(db, CALLERS[who], { bmId: BM, baselineId: "BL-1", ...(body || {}) });

// --- request gates
{
  const db = fresh(); const r = await req(db, "editor");
  ok(r.status === 200 && r.body.build.status === "queued" && r.body.build.label === "B-1", "an editor can queue a build from an approved baseline model (B-1)");
  ok(!("model" in r.body.build) && !("runner_id" in r.body.build), "the app never receives the frozen model or runner id");
  ok((await req(db, "viewer")).status === 403, "viewers can't request builds");
  ok((await req(db, "owner", { baselineId: "BL-NOPE" })).status === 400, "unknown baseline is rejected");
  ok((await req(db, "owner", { bmId: "BM-NOT-THERE" })).status === 422, "a baseline that doesn't contain the model is rejected");
}
{ const m = approved(); m.status = "proposed"; const db = fresh({ [BM]: m }); const r = await req(db, "owner"); ok(r.status === 422 && /not approved/.test(r.body.error), "a model that is only 'proposed' in the baseline can't be built"); }
{ const m = approved(); delete m.qmConfirmed; const db = fresh({ [BM]: m }); const r = await req(db, "owner"); ok(r.status === 422 && /QM classification/.test(r.body.error), "no QM confirmation → no build"); }
{ const m = approved(); m.stateMachine.transitions[0].guard = ""; const db = fresh({ [BM]: m }); const r = await req(db, "owner"); ok(r.status === 422 && /blocking issue/.test(r.body.error), "an incomplete model can't be built even if marked approved"); }
{ // build input comes from the BASELINE, not from anything the browser sends
  const db = fresh(); const evil = approved(); evil.calibrations[0].value = 9999;
  const r = await req(db, "owner", { model: evil }); const row = db._state.builds[0];
  ok(r.status === 200 && row.model.calibrations[0].value === 30, "a model supplied by the client is ignored — the baseline's frozen copy is used");
}
{ const db = fresh(); svc.LIMITS.monthlyCap = 2; await req(db, "owner"); await req(db, "owner"); const r = await req(db, "owner"); svc.LIMITS.monthlyCap = 50; ok(r.status === 429, "monthly build cap is enforced"); }

// --- tenant isolation
{
  const db = fresh(); const b = (await req(db, "owner")).body.build;
  ok((await svc.getBuild(db, CALLERS.other, { id: b.id })).status === 404, "another company can't read your build");
  ok((await svc.cancelBuild(db, CALLERS.other, { id: b.id })).status === 409, "another company can't cancel your build");
  ok((await svc.listBuilds(db, CALLERS.other, {})).body.builds.length === 0, "another company's list is empty");
  ok((await svc.requestBuild(db, CALLERS.other, { bmId: BM, baselineId: "BL-1" })).status === 400, "another company can't build from your baseline");
}

// --- runner registration + auth
{
  const db = fresh();
  ok((await svc.createRunner(db, CALLERS.editor, { name: "r" })).status === 403, "editors can't register runners");
  ok((await svc.createRunner(db, CALLERS.owner, { name: "r", managed: true })).status === 403, "only operators can create managed-fleet runners");
  const c = await svc.createRunner(db, CALLERS.owner, { name: "acme-ci" }); ok(c.status === 200 && /^sdvr_[0-9a-f]{48}$/.test(c.body.token), "owner registers a customer runner and gets a token once");
  const stored = db._state.runners[0]; ok(stored.token_hash && !JSON.stringify(stored).includes(c.body.token), "only the token's hash is stored");
  ok((await svc.authRunner(db, c.body.token)).id === stored.id, "valid token authenticates");
  ok((await svc.authRunner(db, "sdvr_wrong")) === null && (await svc.authRunner(db, "")) === null, "wrong/empty token is rejected");
  ok((await svc.revokeRunner(db, CALLERS.other, { id: stored.id })).status === 404, "another company can't revoke your runner");
  await svc.revokeRunner(db, CALLERS.owner, { id: stored.id }); ok((await svc.authRunner(db, c.body.token)) === null, "a revoked token stops working immediately");
  const op = await svc.createRunner(db, CALLERS.operator, { name: "fleet-1", managed: true }); ok(op.status === 200 && db._state.runners.at(-1).org_id === null, "operator creates a managed runner (org_id null)");
}

// --- claim: atomic, pools, ordering
{
  const db = fresh(); await req(db, "owner");
  const mk = async (managed) => { const c = await svc.createRunner(db, managed ? CALLERS.operator : CALLERS.owner, { name: "r", managed }); return svc.authRunner(db, c.body.token); };
  const r1 = await mk(true), r2 = await mk(true);
  const [a, b] = await Promise.all([svc.runnerClaim(db, r1, {}), svc.runnerClaim(db, r2, {})]);
  ok([a, b].filter((x) => x.body.job).length === 1, "two runners claiming at once: exactly one gets the job");
  const job = (a.body.job || b.body.job); ok(job.label === "B-1" && job.model && job.modelHash && job.functionId === "L2-BODY-00194-FUN", "the job carries the frozen model, its hash and ids");
  ok(db._state.builds[0].status === "running" && db._state.builds[0].attempts === 1, "claimed job is running (attempt 1)");
}
{ // pool routing: customer runner live → build routed to it; the managed fleet never sees it
  const db = fresh(); const c = await svc.createRunner(db, CALLERS.owner, { name: "acme" }); const cust = await svc.authRunner(db, c.body.token);
  await svc.runnerClaim(db, cust, {}); // marks it live (no job yet)
  const b = (await req(db, "owner")).body.build; ok(b.pool === "customer", "with a live customer runner, new builds route to it");
  const m = await svc.createRunner(db, CALLERS.operator, { name: "fleet", managed: true }); const managed = await svc.authRunner(db, m.body.token);
  ok((await svc.runnerClaim(db, managed, {})).body.job === null, "the managed fleet can't claim a customer-pool job");
  ok((await svc.runnerClaim(db, cust, {})).body.job.label === "B-1", "the customer runner gets it");
  // a customer runner of ANOTHER org can't claim it
  const o = await svc.createRunner(db, CALLERS.other, { name: "rival" }); const other = await svc.authRunner(db, o.body.token);
  const db2 = fresh(); await svc.runnerClaim(db2, await svc.authRunner(db2, (await svc.createRunner(db2, CALLERS.owner, { name: "a" })).body.token), {});
  await req(db2, "owner"); const r2 = await svc.createRunner(db2, CALLERS.other, { name: "rival" }); ok((await svc.runnerClaim(db2, await svc.authRunner(db2, r2.body.token), {})).body.job === null, "a different company's customer runner can't claim the job");
}

// --- heartbeat / complete / cancel
{
  const db = fresh(); await req(db, "owner");
  const mk = async () => svc.authRunner(db, (await svc.createRunner(db, CALLERS.operator, { name: "f", managed: true })).body.token);
  const r1 = await mk(), r2 = await mk(); const job = (await svc.runnerClaim(db, r1, {})).body.job;
  ok((await svc.runnerHeartbeat(db, r2, { id: job.id })).status === 409, "a runner that doesn't hold the job can't heartbeat it");
  ok((await svc.runnerComplete(db, r2, { id: job.id, status: "passed" })).status === 409, "a runner that doesn't hold the job can't complete it");
  ok((await svc.runnerComplete(db, r1, { id: job.id, status: "great" })).status === 400, "invalid status is rejected");
  ok((await svc.runnerComplete(db, r1, { id: job.id, status: "passed", files: [{ name: "../evil.c", content: "x" }] })).status === 400, "path traversal in file names is rejected");
  ok((await svc.runnerComplete(db, r1, { id: job.id, status: "passed", files: [{ name: "a.c", content: "x".repeat(svc.LIMITS.maxBytes + 1) }] })).status === 413, "oversized uploads are rejected");
  ok(db._state.builds[0].status === "running", "rejected completions leave the job running");
  const hb = await svc.runnerHeartbeat(db, r1, { id: job.id, log: "hello\n" }); ok(hb.status === 200 && hb.body.cancel === false && /hello/.test(db._state.builds[0].log), "heartbeat appends the log");
  await svc.cancelBuild(db, CALLERS.owner, { id: job.id });
  ok((await svc.runnerHeartbeat(db, r1, { id: job.id })).body.cancel === true, "after a cancel, the runner's next heartbeat tells it to stop");
  ok((await svc.runnerComplete(db, r1, { id: job.id, status: "passed" })).status === 409, "a canceled build can't be completed afterwards");
}
{
  const db = fresh(); await req(db, "owner");
  const r = await svc.authRunner(db, (await svc.createRunner(db, CALLERS.operator, { name: "f", managed: true })).body.token); const job = (await svc.runnerClaim(db, r, {})).body.job;
  const res = await svc.runnerComplete(db, r, { id: job.id, status: "passed", result: { tests: { run: 30, passed: 30, failed: 0 } }, log: "ok", files: [{ name: "src/a.c", content: "int x;" }] });
  const files = (await svc.getBuild(db, CALLERS.owner, { id: job.id, files: true })).body.files;
  ok(res.status === 200 && db._state.builds[0].status === "passed" && files.length === 1 && files[0].sha256.length === 64, "completion stores status, result and hashed files");
  ok((await svc.getBuild(db, CALLERS.owner, { id: job.id })).body.build.result.tests.passed === 30, "the app can read the result");
}

// --- stale jobs: a dead runner's job is requeued, then errors out after 3 attempts
{
  const db = fresh(); db._state.staleMs = 0; await req(db, "owner");
  const r = await svc.authRunner(db, (await svc.createRunner(db, CALLERS.operator, { name: "f", managed: true })).body.token);
  for (let i = 1; i <= 3; i++) { const j = (await svc.runnerClaim(db, r, {})).body.job; ok(!!j && db._state.builds[0].attempts === i, "attempt " + i + " claims the job"); await new Promise((x) => setTimeout(x, 5)); }
  await db.requeueStale(); ok(db._state.builds[0].status === "errored" && /stopped responding/.test(db._state.builds[0].result.error), "after 3 dead attempts the build is marked errored, not hung");
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
