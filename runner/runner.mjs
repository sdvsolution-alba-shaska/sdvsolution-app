#!/usr/bin/env node
// SDVsolution build runner — claims a build job, regenerates the code from the frozen Behavior Model, compiles it with strict
// flags, runs the generated unit tests and reports the result. The SAME program serves the managed fleet and customer-run runners;
// only where it runs (and which token it holds) differs.
//
//   SDV_API            base URL of the app, e.g. https://app.sdvsolution.com      (required)
//   SDV_RUNNER_TOKEN   runner token from Behavior Models → Build runners          (required)
//   CC                 C compiler (default gcc)
//   SDV_POLL_SEC       idle poll interval in seconds (default 10)
//   flags:  --once  take at most one job and exit      --drain  process queued jobs, then exit
//
// The runner never trusts the queue: it re-checks the model hash and the build gate itself, and a job whose
// model is not approved or has been altered is rejected before any code is generated.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
import { generate, checkBuildable, modelHash, GENERATOR_VERSION } from "../src/lib/codegen.js";

export const RUNNER_VERSION = "0.1.0";
const FLAGS = ["-std=c99", "-Wall", "-Wextra", "-Wconversion", "-Werror", "-O0", "-g", "-Isrc", "-Istubs", "-Itest"];
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StepError extends Error { constructor(msg, kind) { super(msg); this.kind = kind || "failed"; } } // "failed" = a real negative result · "errored" = infrastructure/toolchain problem

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    let out = "", done = false; const cap = 120000;
    // .cmd/.bat compiler wrappers (common for vendor toolchains on Windows) need a shell to start.
    const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, windowsHide: true, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd) });
    const kill = () => { try { p.kill(); } catch (e) { /* already gone */ } };
    const timer = setTimeout(() => { if (!done) { out += "\n[timed out after " + opts.timeoutMs + " ms]"; kill(); } }, opts.timeoutMs || 120000);
    if (opts.signal) opts.signal.addEventListener("abort", kill, { once: true });
    const add = (d) => { if (out.length < cap) out += d.toString(); };
    p.stdout.on("data", add); p.stderr.on("data", add);
    p.on("error", (e) => { done = true; clearTimeout(timer); resolve({ code: -1, out: out + String(e.message), spawnError: true }); });
    p.on("close", (code) => { done = true; clearTimeout(timer); resolve({ code, out }); });
  });
}

export function makeApi(base, token) {
  return async function api(action, body) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(base + "/api/runner", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ action, ...(body || {}) }) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) { const e = new Error("runner token rejected (401) — was it revoked?"); e.fatal = true; throw e; }
        if (r.status >= 500) { lastErr = new Error("server error " + r.status + ": " + (j.error || "")); await sleep(1000 * (attempt + 1)); continue; }
        if (!r.ok) { const e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; throw e; }
        return j;
      } catch (e) { if (e.fatal || e.status) throw e; lastErr = e; await sleep(1000 * (attempt + 1)); }
    }
    throw lastErr;
  };
}

export async function processJob(job, cfg, api) {
  const t0 = Date.now(), steps = [], files = []; let log = "", sent = 0, cancelled = false;
  const L = (s) => { const line = "[" + new Date().toISOString().slice(11, 19) + "] " + s; log += line + "\n"; if (!cfg.quiet) console.log(line); };
  const ac = new AbortController();
  const hb = setInterval(async () => { try { const r = await api("heartbeat", { id: job.id, log: log.slice(sent) }); sent = log.length; if (r.cancel) { cancelled = true; ac.abort(); } } catch (e) { /* retried on next tick */ } }, cfg.heartbeatMs || 20000);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sdv-build-"));
  let status = "passed", result = { label: job.label };
  const step = async (name, fn) => {
    if (cancelled) throw new StepError("canceled", "errored");
    const s0 = Date.now(); L("▶ " + name);
    try { const detail = await fn(); steps.push({ name, status: "passed", ms: Date.now() - s0, detail: detail || "" }); L("✔ " + name + (detail ? " — " + detail : "")); }
    catch (e) { const kind = e instanceof StepError ? e.kind : "errored"; steps.push({ name, status: kind === "failed" ? "failed" : "errored", ms: Date.now() - s0, detail: e.message }); L("✘ " + name + " — " + e.message); throw e instanceof StepError ? e : new StepError(e.message, "errored"); }
  };
  try {
    L("job " + job.label + " · " + job.functionId + " · baseline " + job.baselineId);
    const model = job.model; let gen;
    await step("integrity", async () => {
      if (modelHash(model) !== job.modelHash) throw new StepError("model hash mismatch: the queued model was altered (expected " + job.modelHash + ", got " + modelHash(model) + ")", "errored");
      return "model " + job.modelHash;
    });
    await step("gate", async () => { const g = checkBuildable(model, { id: job.baselineId }); if (!g.ok) throw new StepError(g.reasons.join(" "), "failed"); return "approved, QM confirmed, valid"; });
    await step("generate", async () => {
      gen = await generate(model, { build: job.label });
      if (!gen.ok) throw new StepError("generation blocked: " + gen.errors.slice(0, 3).map((e) => e.msg).join("; "), "failed");
      for (const f of gen.files) { const p = path.join(work, f.name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.text); files.push({ name: f.name, content: f.text }); }
      // The generated test DEFINITIONS (id, title, expectation) travel with the build, so the app can register results for tests
      // it has not generated itself (e.g. built from a baseline, or by a colleague). testIds keeps IDs stable and never reused.
      files.push({ name: "testcases.json", content: JSON.stringify({ model: { id: model.id, hash: job.modelHash }, generator: GENERATOR_VERSION, tests: gen.tests, testIds: gen.testIds }, null, 2) + "\n" });
      return gen.files.length + " files · " + gen.tests.length + " tests · generator " + GENERATOR_VERSION;
    });
    const srcs = gen.files.filter((f) => /\.c$/.test(f.name)).map((f) => f.name);
    const exe = path.join(work, process.platform === "win32" ? "t.exe" : "t");
    await step("compile", async () => {
      const r = await run(cfg.cc, [...FLAGS, "-o", "t", ...srcs], { cwd: work, timeoutMs: 120000, signal: ac.signal });
      if (r.spawnError) throw new StepError("compiler '" + cfg.cc + "' could not be started: " + r.out.trim(), "errored");
      if (r.code !== 0) throw new StepError("compile failed (-Werror):\n" + r.out.trim().slice(0, 1500), "failed");
      return cfg.cc + " " + FLAGS.filter((f) => /^-W/.test(f)).join(" ");
    });
    await step("unit-tests", async () => {
      const r = await run(exe, ["results.xml"], { cwd: work, timeoutMs: 120000, env: { SDV_BUILD: job.label }, signal: ac.signal });
      const xmlPath = path.join(work, "results.xml");
      if (!fs.existsSync(xmlPath)) throw new StepError("the test program produced no results (" + r.out.trim().slice(0, 300) + ")", "errored");
      const xml = fs.readFileSync(xmlPath, "utf8"); files.push({ name: "results.xml", content: xml });
      const total = (xml.match(/<testcase /g) || []).length, failed = (xml.match(/<failure /g) || []).length;
      result.tests = { run: total, passed: total - failed, failed, expected: gen.tests.length };
      if (total !== gen.tests.length) throw new StepError("expected " + gen.tests.length + " tests but results list " + total, "errored");
      if (failed) throw new StepError(failed + " of " + total + " generated tests failed", "failed");
      return total + " tests passed";
    });
    // Planned in item 6 — recorded explicitly so nobody mistakes "not run" for "clean".
    steps.push({ name: "static-analysis", status: "not-run", ms: 0, detail: "planned (item 6) — no MISRA or defect analysis performed" });
    steps.push({ name: "coverage", status: "not-run", ms: 0, detail: "planned (item 6) — statement/branch coverage not measured" });
    await step("package", async () => { const m = files.find((f) => f.name === "manifest.json"); result.manifestSha256 = m ? sha256(m.content) : null; return files.length + " files, manifest " + (result.manifestSha256 || "missing").slice(0, 12); });
  } catch (e) {
    status = e instanceof StepError && e.kind === "failed" ? "failed" : "errored";
    result.error = e.message.split("\n")[0].slice(0, 300);
  } finally { clearInterval(hb); }
  const cv = spawnSync(cfg.cc, ["--version"], { encoding: "utf8" });
  Object.assign(result, { steps, status, durationMs: Date.now() - t0, generator: GENERATOR_VERSION, modelHash: job.modelHash, compiler: ((cv.stdout || "").split("\n")[0] || "unknown").trim(), runner: { version: RUNNER_VERSION, node: process.version, platform: process.platform } });
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* temp cleanup is best effort */ }
  if (cancelled) { L("build was canceled — abandoning (no result sent)"); return { status: "canceled" }; }
  L("finished: " + status);
  try { await api("complete", { id: job.id, status, result, log, files: status === "errored" && !files.length ? [] : files }); }
  catch (e) { L("could not report the result: " + e.message); throw e; }
  return { status, result };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cfg = { api: (env.SDV_API || "").replace(/\/+$/, ""), token: env.SDV_RUNNER_TOKEN || "", cc: env.CC || "gcc", pollMs: (Number(env.SDV_POLL_SEC) || 10) * 1000, once: argv.includes("--once"), drain: argv.includes("--drain"), heartbeatMs: Number(env.SDV_HEARTBEAT_MS) || 20000 };
  if (!cfg.api || !cfg.token) { console.error("SDV_API and SDV_RUNNER_TOKEN are required."); return 2; }
  const api = makeApi(cfg.api, cfg.token);
  const cv = spawnSync(cfg.cc, ["--version"], { encoding: "utf8" });
  const info = { runnerVersion: RUNNER_VERSION, node: process.version, platform: process.platform, compiler: cv.error ? "NOT FOUND (" + cfg.cc + ")" : (cv.stdout || "").split("\n")[0].trim(), generator: GENERATOR_VERSION };
  console.log("runner " + RUNNER_VERSION + " · " + info.compiler + " · " + cfg.api);
  for (;;) {
    let r;
    try { r = await api("claim", { info }); } catch (e) { console.error("claim failed: " + e.message); if (e.fatal || cfg.once || cfg.drain) return e.fatal ? 3 : 2; await sleep(cfg.pollMs); continue; }
    if (r.job) { try { await processJob(r.job, cfg, api); } catch (e) { console.error("job error: " + e.message); } if (cfg.once) return 0; continue; }
    if (cfg.once || cfg.drain) return 0;
    await sleep(cfg.pollMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().then((c) => process.exit(c));
