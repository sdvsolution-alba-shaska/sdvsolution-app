// Run: node tests/runner.e2e.mjs        (needs a C compiler on PATH; skips the process tests if there is none)
// End to end: user requests a build over HTTP -> the real runner process claims it, regenerates the code, compiles with
// strict flags, runs the generated tests and reports -> the app side reads status, steps and files back.
// Also proves the runner does not trust the queue: tampered or unapproved jobs are stopped before any code is generated.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { startFakeApi, CALLERS, ORG } from "./fake-api.mjs";
import { makeMemDb } from "./memdb.mjs";
import { PILOT_MODELS } from "../src/lib/pilotModels.js";
import * as svc from "../api/_buildService.js";

const HERE = path.dirname(fileURLToPath(import.meta.url)), RUNNER = path.join(HERE, "..", "runner", "runner.mjs");
const CC = process.env.CC || "gcc";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const BM = "BM-L2-BODY-00194";
const approved = () => ({ ...clone(PILOT_MODELS["L2-BODY-00194-MODE"]), status: "approved", qmConfirmed: { by: "safety@acme.test", at: 1 } });

const has = spawnSync(CC, ["--version"], { encoding: "utf8" });
if (has.error || has.status !== 0) { console.log("SKIPPED: no C compiler (" + CC + ") — the runner process tests need one. Service rules are covered by tests/builds.test.mjs."); process.exit(0); }
console.log("compiler: " + has.stdout.split("\n")[0]);

const xml0 = (files) => [...files.find((f) => f.name === "results.xml").content.matchAll(/<testcase [^>]*name="([^"]+)"/g)].map((m) => m[1]);
const call = async (url, who, body) => { const r = await fetch(url + "/api/builds", { method: "POST", headers: { "content-type": "application/json", "x-test-caller": who }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
function runRunner(url, token, extraEnv, args = ["--drain"]) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, ...args], { env: { ...process.env, SDV_API: url, SDV_RUNNER_TOKEN: token, SDV_HEARTBEAT_MS: "500", ...(extraEnv || {}) } });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.on("close", (code) => resolve({ code, out }));
  });
}
async function setup(models) {
  const db = makeMemDb(); db._state.workspaces.set(ORG, { baselines: [{ id: "BL-1", name: "Release 1", ts: "2026-10-11", snap: { behaviorModels: models || { [BM]: approved() } } }] });
  const api = await startFakeApi({ db });
  const token = (await svc.createRunner(db, CALLERS.operator, { name: "fleet", managed: true })).body.token;
  return { db, api, token };
}

// 1) the happy path
{
  const { db, api, token } = await setup();
  const rq = await call(api.url, "editor", { action: "request", bmId: BM, baselineId: "BL-1" });
  ok(rq.status === 200 && rq.body.build.status === "queued", "build requested over HTTP and queued");
  const t0 = Date.now(); const r = await runRunner(api.url, token);
  ok(r.code === 0, "the runner exits cleanly after draining the queue (exit " + r.code + ")");
  const got = (await call(api.url, "editor", { action: "get", id: rq.body.build.id, files: true })).body;
  const b = got.build;
  ok(b.status === "passed", "build status is 'passed' (" + b.status + ")" + (b.status === "passed" ? "" : "\n" + (b.result && b.result.error) + "\n" + r.out.slice(-800)));
  ok(b.result.tests && b.result.tests.run === 38 && b.result.tests.passed === 38 && b.result.tests.failed === 0, "38 of 38 generated tests ran and passed on the runner");
  ok(["integrity", "gate", "generate", "compile", "unit-tests", "static-analysis", "coverage", "package"].every((n, i) => b.result.steps[i] && b.result.steps[i].name === n && b.result.steps[i].status === "passed"), "all eight steps ran and passed, in order (incl. static-analysis and coverage)");
  const A = b.result.analysis, C = b.result.coverage;
  ok(A && A.status === "clean" && A.total === 0 && A.tools[0].name === "gcc" && A.tools[0].warnings >= 15, "static analysis: clean — gcc with a wide warning set (" + (A && A.tools[0].version) + ")");
  ok(A && A.misra.status === "not-run" && /checker/.test(A.misra.reason), "MISRA is recorded as NOT RUN with the reason — a clean analysis never implies MISRA compliance");
  ok(C && C.lines.pct === 100 && C.branches.pct === 100 && C.complete === true && C.policy === "informational", "coverage: 100% of lines and branches of the generated production code (" + (C && C.lines.covered + "/" + C.lines.total) + " lines, " + (C && C.branches.covered + "/" + C.branches.total) + " branches)");
  const gccMajor = Number(((A && A.tools[0].version.match(/\)\s+(\d+)\./)) || [])[1] || 0);
  ok(gccMajor < 14 ? C.conditions === null : (C.conditions && C.conditions.pct === 100), "condition (MC/DC-style) coverage: " + (C && C.conditions ? C.conditions.pct + "%" : "unavailable on this compiler") + " (gcc " + gccMajor + ")");
  ok(C && C.files.length >= 1 && C.files.some((f) => f.file === "src/MirrorHeating.c") && C.files.every((f) => /^src\//.test(f.file)) && C.files.every((f) => !f.functionsNeverRun.length), "only production sources are measured, and every production function ran");
  const names = got.files.map((f) => f.name);
  ok(["src/MirrorHeating.c", "src/MirrorHeating.h", "src/MirrorHeating_cfg.c", "test/test_MirrorHeating.c", "manifest.json", "results.xml", "testcases.json", "analysis.json", "coverage.json"].every((n) => names.includes(n)), "generated sources, manifest, results, test definitions, analysis.json and coverage.json were uploaded (" + names.length + " files)");
  const xml = got.files.find((f) => f.name === "results.xml").content;
  ok(/name="build" value="B-1"/.test(xml), "the test results carry the build ID B-1 (traceable to the build)");
  ok(got.files.every((f) => f.sha256.length === 64), "every uploaded file has a server-computed SHA-256");
  const tcj = got.files.find((f) => f.name === "testcases.json"); const tcd = tcj ? JSON.parse(tcj.content) : null;
  ok(tcd && tcd.tests.length === 38 && tcd.tests.every((t) => /^TC-L2-BODY-00194-FUN-GEN-\d+$/.test(t.id) && t.title && t.exp), "testcases.json carries all 38 generated test definitions (id, title, expectation)");
  ok(tcd && Object.keys(tcd.testIds).length === 38 && tcd.tests.every((t) => tcd.testIds[t.key] && t.id.endsWith("-GEN-" + tcd.testIds[t.key])), "…with the key→number map, so the app registers IDs consistently and never reuses them");
  const resIds = [...xml0(got.files)].sort().join(); ok(resIds === tcd.tests.map((t) => t.id).sort().join(), "the result IDs in results.xml are exactly the IDs defined in testcases.json");
  ok(/compile/.test(b.log) && /finished: passed/.test(b.log), "the runner log was stored");
  ok(b.result.compiler && /GCC|gcc/.test(b.result.compiler) && b.result.runner.version && b.result.generator, "the result records compiler, generator and runner versions");
  ok(db._state.runners[0].info && db._state.runners[0].info.compiler, "the runner reported its toolchain when it connected");
  console.log("     (job took " + (Date.now() - t0) + " ms)");
  await api.close();
}

// 2) the runner does not trust the queue
{ // tampered after queuing: change a calibration in the stored model, keep the old hash
  const { db, api, token } = await setup();
  const rq = await call(api.url, "owner", { action: "request", bmId: BM, baselineId: "BL-1" });
  db._state.builds[0].model.calibrations[1].value = 9999;
  await runRunner(api.url, token);
  const b = (await call(api.url, "owner", { action: "get", id: rq.body.build.id })).body.build;
  ok(b.status === "errored" && b.result.steps[0].name === "integrity" && /hash mismatch/.test(b.result.error), "a model altered after queuing is rejected by the integrity check");
  ok(!b.result.steps.some((s) => s.name === "generate" || s.name === "compile"), "…and nothing was generated or compiled");
  await api.close();
}
{ // an unapproved model that somehow reached the queue (bypassing the server gate)
  const m = approved(); m.status = "proposed";
  const { db, api, token } = await setup({ [BM]: m });
  const { modelHash } = await import("../src/lib/codegen.js");
  db._state.builds.push({ id: "11111111-1111-1111-1111-111111111111", build_no: 99, org_id: ORG, bm_id: BM, function_id: m.function, title: m.title, baseline_id: "BL-1", model: m, model_hash: modelHash(m), pool: "managed", status: "queued", attempts: 0, created_at: new Date().toISOString(), runner_id: null, log: "" });
  await runRunner(api.url, token);
  const b = (await call(api.url, "owner", { action: "get", id: "11111111-1111-1111-1111-111111111111" })).body.build;
  ok(b.status === "failed" && b.result.steps.find((s) => s.name === "gate" && s.status === "failed") && /not approved/.test(b.result.steps.find((s) => s.name === "gate").detail), "the runner re-checks the gate itself: an unapproved model fails at 'gate'");
  ok(!b.result.steps.some((s) => s.name === "generate"), "…and no code is generated for it");
  await api.close();
}

// 3) toolchain problems are 'errored', not 'failed'
{
  const { api, token } = await setup();
  const rq = await call(api.url, "owner", { action: "request", bmId: BM, baselineId: "BL-1" });
  await runRunner(api.url, token, { CC: "no-such-compiler-xyz" });
  const b = (await call(api.url, "owner", { action: "get", id: rq.body.build.id })).body.build;
  ok(b.status === "errored" && /could not be started/.test(b.result.steps.find((s) => s.name === "compile").detail), "a missing compiler is reported as 'errored' (infrastructure), not as a failed build");
  await api.close();
}

// 4) a genuinely failing generated test makes the build 'failed' (not 'errored'). We wrap the compiler so it injects a real
//    defect into the generated C before compiling (> becomes >= in the over-current guard) — the generated tests must catch it.
{
  const fs = await import("node:fs"), os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdv-ccw-"));
  fs.writeFileSync(path.join(dir, "mut.mjs"), 'import fs from "node:fs"; const p = "src/MirrorHeating.c"; const t = fs.readFileSync(p, "utf8"); const a = "(int32_t)heater_current_mA > (int32_t)CAL_OVERCURRENT_MA"; if (!t.includes(a)) { console.error("mutation target not found"); process.exit(9); } fs.writeFileSync(p, t.replace(a, "(int32_t)heater_current_mA >= (int32_t)CAL_OVERCURRENT_MA"));\n');
  const wrapper = path.join(dir, process.platform === "win32" ? "cc-mut.cmd" : "cc-mut.sh");
  fs.writeFileSync(wrapper, process.platform === "win32" ? '@echo off\r\nnode "%~dp0mut.mjs" || exit /b 9\r\n' + CC + " %*\r\n" : '#!/bin/sh\nnode "$(dirname "$0")/mut.mjs" || exit 9\nexec ' + CC + ' "$@"\n', { mode: 0o755 });
  const { api, token } = await setup();
  const rq = await call(api.url, "owner", { action: "request", bmId: BM, baselineId: "BL-1" });
  await runRunner(api.url, token, { CC: wrapper });
  const got = (await call(api.url, "owner", { action: "get", id: rq.body.build.id, files: true })).body, b = got.build;
  ok(b.status === "failed", "a build whose generated tests catch a defect is 'failed' (" + b.status + ")" + (b.status === "failed" ? "" : " — " + (b.result && b.result.error)));
  ok(b.result.tests && b.result.tests.failed >= 1 && b.result.tests.run === 38, "the result says " + b.result.tests.failed + " of 38 tests failed");
  ok(b.result.steps.find((s) => s.name === "compile").status === "passed" && b.result.steps.find((s) => s.name === "unit-tests").status === "failed", "compile passed, unit-tests failed");
  ok(!b.result.steps.some((s) => s.name === "package" || s.name === "static-analysis" || s.name === "coverage"), "a failed build is not packaged and gathers no further evidence");
  const xml = got.files.find((f) => f.name === "results.xml"); ok(xml && /<failure /.test(xml.content), "the failing results.xml is still uploaded as evidence");
  fs.rmSync(dir, { recursive: true, force: true }); await api.close();
}

// 4b) static analysis catches what the build flags don't: a shadowed variable + a function without a prototype.
//     The build (compile, unit-tests) still passes — only the wider analysis flags see it — so the build fails at 'static-analysis'.
async function wrapperFor(mutationJs) {
  const fs2 = await import("node:fs"), os2 = await import("node:os");
  const dir = fs2.mkdtempSync(path.join(os2.tmpdir(), "sdv-ccw-"));
  fs2.writeFileSync(path.join(dir, "mut.mjs"), 'import fs from "node:fs"; const p = "src/MirrorHeating.c"; let t = fs.readFileSync(p, "utf8"); if (!t.includes("SDV_MUTANT")) { ' + mutationJs + ' fs.writeFileSync(p, t); }\n');
  const w = path.join(dir, process.platform === "win32" ? "cc-mut.cmd" : "cc-mut.sh");
  fs2.writeFileSync(w, process.platform === "win32" ? '@echo off\r\nnode "%~dp0mut.mjs" || exit /b 9\r\n' + CC + " %*\r\n" : '#!/bin/sh\nnode "$(dirname "$0")/mut.mjs" || exit 9\nexec ' + CC + ' "$@"\n', { mode: 0o755 });
  return { w, cleanup: () => fs2.rmSync(dir, { recursive: true, force: true }) };
}
{
  const { w, cleanup } = await wrapperFor('t += "\\n/* SDV_MUTANT */\\nint sdv_bad(int a)\\n{\\n    int b = a;\\n    { int b = 1; a += b; }\\n    return b + a;\\n}\\n";');
  const { api, token } = await setup(); const rq = await call(api.url, "owner", { action: "request", bmId: BM, baselineId: "BL-1" });
  await runRunner(api.url, token, { CC: w }); const got = (await call(api.url, "owner", { action: "get", id: rq.body.build.id, files: true })).body, b = got.build;
  const sa = b.result.steps.find((s) => s.name === "static-analysis");
  ok(b.status === "failed" && sa && sa.status === "failed", "static analysis fails the build when it finds a defect (" + b.status + ")");
  ok(["compile", "unit-tests"].every((n) => b.result.steps.find((s) => s.name === n && s.status === "passed")), "…even though compile and unit tests passed (the wider analysis flags caught it)");
  ok(b.result.analysis.total >= 2 && b.result.analysis.findings.some((f) => f.rule === "-Wshadow" && /shadows/.test(f.message)) && b.result.analysis.findings.some((f) => f.rule === "-Wmissing-prototypes"), "findings are recorded with rule and message (" + b.result.analysis.findings.map((f) => f.rule).join(", ") + ")");
  ok(b.result.analysis.findings.every((f) => /^src\//.test(f.file) && f.line > 0), "each finding has a project-relative file and a line number");
  ok(got.files.some((f) => f.name === "analysis.json"), "analysis.json is stored as evidence even for a failed analysis");
  ok(!b.result.steps.some((s) => s.name === "coverage" || s.name === "package"), "a build that fails analysis is not packaged and gathers no coverage");
  cleanup(); await api.close();
}
// 4c) coverage tells the truth: an extra function no test exercises makes coverage INCOMPLETE and names the uncovered code.
//     Coverage is informational in Phase 1, so the build still passes — but the evidence must say it is not complete.
{
  const { w, cleanup } = await wrapperFor('t += "\\n/* SDV_MUTANT */\\nint sdv_extra(void);\\nint sdv_extra(void)\\n{\\n    return 42;\\n}\\n";');
  const { api, token } = await setup(); const rq = await call(api.url, "owner", { action: "request", bmId: BM, baselineId: "BL-1" });
  await runRunner(api.url, token, { CC: w }); const b = (await call(api.url, "owner", { action: "get", id: rq.body.build.id })).body.build; const C = b.result.coverage;
  ok(b.status === "passed" && C && C.complete === false, "unexercised code → build still passes (informational policy) but coverage is flagged INCOMPLETE");
  ok(C.lines.covered < C.lines.total && C.uncovered.some((u) => /return 42/.test(u.text) && u.kind === "line"), "the uncovered line is named, with its source text ('return 42;')");
  ok(C.files.find((f) => f.file === "src/MirrorHeating.c").functionsNeverRun.includes("sdv_extra"), "the function that never ran is named");
  cleanup(); await api.close();
}

// 4d) the SECOND pilot through the whole chain: request -> runner -> compile -> tests -> static analysis -> coverage
{
  const BM2 = "BM-L2-BODY-00193", m2 = { ...JSON.parse(JSON.stringify(PILOT_MODELS["L2-BODY-00193-MODE"])), status: "approved", qmConfirmed: { by: "safety@acme.test", at: 1 } };
  const { api, token } = await setup({ [BM2]: m2 }); const rq = await call(api.url, "owner", { action: "request", bmId: BM2, baselineId: "BL-1" });
  await runRunner(api.url, token); const got = (await call(api.url, "owner", { action: "get", id: rq.body.build.id, files: true })).body, b = got.build;
  ok(b.status === "passed" && b.result.tests && b.result.tests.run === 43 && b.result.tests.failed === 0, "[MirrorFold] the second pilot builds on the runner: " + b.status + ", " + (b.result.tests && b.result.tests.passed + "/" + b.result.tests.run) + " tests" + (b.status === "passed" ? "" : " — " + b.result.error));
  ok(b.result.analysis && b.result.analysis.status === "clean" && b.result.coverage && b.result.coverage.lines.pct === 100 && b.result.coverage.branches.pct === 100 && b.result.coverage.complete === true && (!b.result.coverage.conditions || b.result.coverage.conditions.pct === 100), "[MirrorFold] static analysis clean; coverage COMPLETE (lines, branches, conditions where supported) — 100% line + branch coverage (" + (b.result.coverage && b.result.coverage.lines.covered + "/" + b.result.coverage.lines.total) + " lines)");
  ok(got.files.some((f) => f.name === "src/MirrorFold.c") && got.files.some((f) => f.name === "results.xml"), "[MirrorFold] generated sources and results were stored");
  await api.close();
}

// 5) auth// 5) auth
{
  const { api, token } = await setup();
  const r = await runRunner(api.url, "sdvr_not_a_real_token", {}, ["--once"]);
  ok(r.code === 3 && /401|rejected/.test(r.out), "a bad runner token is rejected and the runner exits with an auth error (exit " + r.code + ")");
  const revoked = (await call(api.url, "owner", { action: "runner_create", name: "tmp" })).body;
  await call(api.url, "owner", { action: "runner_revoke", id: revoked.runner.id });
  const r2 = await runRunner(api.url, revoked.token, {}, ["--once"]);
  ok(r2.code === 3, "a revoked token can no longer claim jobs (exit " + r2.code + ")");
  const idle = await runRunner(api.url, token, {}, ["--drain"]); ok(idle.code === 0 && /claim/.test(idle.out) === false, "an idle runner with a valid token and an empty queue exits 0");
  await api.close();
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
