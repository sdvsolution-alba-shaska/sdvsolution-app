// Run: node tests/mutation.mjs [pilotKey|all] [--concurrency=4] [--list]
// Automatic MUTATION TESTING of generated code. For each pilot Behavior Model it generates the C + unit tests, derives mutants from the
// generated production source (a single small defect each), builds every mutant and runs the model's own generated tests against it.
// A mutant is KILLED if the tests notice (a test fails, or the program hangs); it SURVIVES if every test still passes.
// A survivor is either an EQUIVALENT mutant (the change can't alter behaviour — list it in tests/mutation.equivalent.json with a reason)
// or a real GAP in the generated tests. The run fails on any survivor that is not on that list.
// Needs a C compiler on PATH (CC to override); skips cleanly without one.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { generate } from "../src/lib/codegen.js";
import { PILOT_MODELS } from "../src/lib/pilotModels.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CC = process.env.CC || "gcc";
const args = process.argv.slice(2);
const conc = Number((args.find((a) => a.startsWith("--concurrency=")) || "").split("=")[1]) || 4;
const pick = args.find((a) => !a.startsWith("--")) || "all";
const probe = spawnSync(CC, ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) { console.log("SKIPPED: no C compiler found (" + CC + ")."); process.exit(0); }
const EQUIV = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, "mutation.equivalent.json"), "utf8")); } catch (e) { return {}; } })();

/* ---------- mutant derivation (operates on the generated production source) ---------- */
const REL = { ">=": ">", ">": ">=", "<=": "<", "<": "<=", "==": "!=", "!=": "==" };
const allMatches = (s, re) => { const out = []; let m; const r = new RegExp(re.source, "g"); while ((m = r.exec(s))) out.push({ i: m.index, t: m[0], g: m }); return out; };
export function deriveMutants(files, swc) {
  const src = files.find((f) => f.name === "src/" + swc + ".c").text, lines = src.split("\n"), cfg = files.find((f) => f.name === "src/" + swc + "_cfg.c").text;
  const find = (needle, from = 0) => { for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i; return -1; };
  const gS = find("/* transitions: evaluated in listed order"), gE = find("/* state bookkeeping"), oS = find("/* outputs of the (new) state"), oE = find("(void)Rte_Write_");
  const enums = [...new Set((src.match(new RegExp(swc + "_STATE_[A-Z0-9_]+", "g")) || []))];
  const ms = [];
  const addLine = (id, desc, ln, newLine) => ms.push({ id, desc: desc + "  [" + "src/" + swc + ".c:" + (ln + 1) + "]", file: "src/" + swc + ".c", apply: (t) => { const L = t.split("\n"); L[ln] = newLine; return L.join("\n"); } });
  for (let ln = gS; ln < gE; ln++) {
    const L = lines[ln];
    const g = L.match(/^(\s+)(else )?if \((.*)\)$/);
    if (g) {
      const [, ind, els, cond] = g, rebuild = (c) => ind + (els || "") + "if (" + c + ")";
      allMatches(cond, / (>=|<=|>|<|==|!=) /).forEach((m, k) => { const op = m.g[1]; addLine("rel@" + ln + "." + k, "guard: '" + op + "' becomes '" + REL[op] + "'", ln, rebuild(cond.slice(0, m.i) + " " + REL[op] + " " + cond.slice(m.i + m.t.length))); });
      allMatches(cond, / (&&|\|\|) /).forEach((m, k) => { const to = m.g[1] === "&&" ? "||" : "&&"; addLine("log@" + ln + "." + k, "guard: '" + m.g[1] + "' becomes '" + to + "'", ln, rebuild(cond.slice(0, m.i) + " " + to + " " + cond.slice(m.i + m.t.length))); });
      allMatches(cond, /\(!(?=[(A-Za-z])/).forEach((m, k) => addLine("neg@" + ln + "." + k, "guard: a negation is dropped", ln, rebuild(cond.slice(0, m.i) + "(" + cond.slice(m.i + 2))));
      allMatches(cond, /\(int32_t\)(\d+)/).forEach((m, k) => addLine("lit@" + ln + "." + k, "guard: literal " + m.g[1] + " becomes " + (Number(m.g[1]) + 1), ln, rebuild(cond.slice(0, m.i) + "(int32_t)" + (Number(m.g[1]) + 1) + cond.slice(m.i + m.t.length))));
      // ATOM STUCK: one single condition of the guard is forced true / false (this is what MC/DC-style coverage asks the tests to rule out).
      // Atoms: a boolean test "(name != 0u)" or a comparison of two simple operands "((int32_t)a OP (int32_t)b)".
      [...allMatches(cond, /\([A-Za-z_]\w* != 0u\)/).map((m) => ({ ...m, kind: "flag" })), ...allMatches(cond, /\(\(int32_t\)[A-Za-z_]\w* (?:>=|<=|>|<|==|!=) (?:\(int32_t\)[A-Za-z_]\w*|\(int32_t\)\d+)\)/).map((m) => ({ ...m, kind: "cmp" }))]
        .forEach((m, k) => ["0", "1"].forEach((v) => addLine("atom" + v + "@" + ln + "." + k, "guard: condition " + m.t.replace(/\(int32_t\)/g, "") + " stuck " + (v === "1" ? "TRUE" : "FALSE"), ln, rebuild(cond.slice(0, m.i) + v + cond.slice(m.i + m.t.length)))));
      addLine("stuckF@" + ln, "guard stuck FALSE (transition can never fire)", ln, rebuild("0")); addLine("stuckT@" + ln, "guard stuck TRUE (transition always fires)", ln, rebuild("1"));
    }
    const tg = L.match(/^(\s+next = )(\w+)(;.*)$/);
    if (tg) { const k = (enums.indexOf(tg[2]) + 1) % enums.length; addLine("tgt@" + ln, "transition target " + tg[2].replace(swc + "_STATE_", "") + " becomes " + enums[k].replace(swc + "_STATE_", ""), ln, tg[1] + enums[k] + tg[3]); }
  }
  // PRIORITY: swap two competing transitions of one state (the whole branch: guard + target). Only matters where both guards can hold at once.
  { const blocks = []; // { start, end, els }
    for (let ln = gS; ln < gE; ln++) { const g = lines[ln].match(/^(\s+)(else )?if \(/); if (!g) continue; let end = ln + 1; while (end < gE && lines[end] !== g[1] + "}") end++; blocks.push({ start: ln, end, els: !!g[2] }); }
    for (let k = 0; k + 1 < blocks.length; k++) {
      const A = blocks[k], B = blocks[k + 1]; if (!B.els || B.start !== A.end + 1) continue; // adjacent branches of the same if / else-if chain
      const la = lines.slice(A.start, A.end + 1), lb = lines.slice(B.start, B.end + 1);
      const head = (l, els) => l.replace(/^(\s+)(else )?if /, "$1" + (els ? "else " : "") + "if ");
      const tgt = (blk) => (blk.find((x) => /next = /.test(x)) || "").trim().replace(/^next = /, "").replace(/;.*/, "").replace(swc + "_STATE_", "");
      const newBlock = [head(lb[0], A.els), ...lb.slice(1), head(la[0], true), ...la.slice(1)];
      ms.push({ id: "prio@" + A.start, desc: "priority: the branches to " + tgt(la) + " and " + tgt(lb) + " swap order [src/" + swc + ".c:" + (A.start + 1) + "]", file: "src/" + swc + ".c", apply: (txt) => { const L = txt.split("\n"); L.splice(A.start, B.end - A.start + 1, ...newBlock); return L.join("\n"); } });
    } }
  for (let ln = oS; ln < oE; ln++) {
    const o = lines[ln].match(/^(\s+)(\w+) = (.*);$/); if (!o) continue;
    const [, ind, name, rhs] = o, mk = (r) => ind + name + " = " + r + ";";
    allMatches(rhs, /\(int32_t\)(\d+)/).forEach((m, k) => addLine("outlit@" + ln + "." + k, "output " + name + ": literal " + m.g[1] + " becomes " + (Number(m.g[1]) + 1), ln, mk(rhs.slice(0, m.i) + "(int32_t)" + (Number(m.g[1]) + 1) + rhs.slice(m.i + m.t.length))));
    allMatches(rhs, /\(int32_t\)(CAL_[A-Z0-9_]+)/).forEach((m, k) => addLine("outcal@" + ln + "." + k, "output " + name + ": calibration " + m.g[1] + " replaced by 0", ln, mk(rhs.slice(0, m.i) + "(int32_t)0" + rhs.slice(m.i + m.t.length))));
    if (/^(TRUE|FALSE)$/.test(rhs)) addLine("outbool@" + ln, "output " + name + ": " + rhs + " flipped", ln, mk(rhs === "TRUE" ? "FALSE" : "TRUE"));
  }
  const rep = (id, desc, from, to) => { const i = src.indexOf(from); if (i >= 0) ms.push({ id, desc, file: "src/" + swc + ".c", apply: (t) => t.replace(from, to) }); };
  rep("timer0", "state timer never advances", swc + "_stateTimeMs += " + swc.toUpperCase() + "_PERIOD_MS;", swc + "_stateTimeMs += 0u;");
  rep("sat0", "timer saturation resets to 0 (wraps)", swc + "_stateTimeMs = " + swc.toUpperCase() + "_TIME_MAX;", swc + "_stateTimeMs = 0u;");
  rep("recover", "corrupted state is not recovered", "/* defensive: unknown state, recover to the initial state */\n        fired = TRUE;", "/* defensive: unknown state, recover to the initial state */");
  rep("firedGate", "a taken transition no longer restarts the timer", "if (fired != FALSE)", "if (next != " + swc + "_state)");
  // calibration values (cfg): every threshold must matter to at least one test. Each value is defined once, as a *_DEFAULT macro.
  cfg.split("\n").forEach((l, ln) => { const mm = l.match(/^(#define (CAL_\w+)_DEFAULT )(.+?)( \/\*.*)?$/); if (!mm) return; const v = mm[3]; let nv;
    if (v === "TRUE") nv = "FALSE"; else if (v === "FALSE") nv = "TRUE"; else nv = v.replace(/-?\d+/, (d) => String(Number(d) + 1));
    ms.push({ id: "cal@" + mm[2], desc: "calibration " + mm[2] + ": " + v + " -> " + nv, file: "src/" + swc + "_cfg.c", apply: (t) => { const L2 = t.split("\n"); L2[ln] = mm[1] + nv + (mm[4] || ""); return L2.join("\n"); } }); });
  return ms;
}

/* ---------- build + run ---------- */
const run = (cmd, a, o) => new Promise((resolve) => { let out = ""; const p = spawn(cmd, a, { cwd: o.cwd, env: { ...process.env, ...(o.env || {}) } }); const to = setTimeout(() => { out += "[timeout]"; p.kill(); }, o.timeoutMs || 60000); p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.on("error", (e) => { clearTimeout(to); resolve({ code: -1, out: String(e) }); }); p.on("close", (code) => { clearTimeout(to); resolve({ code, out, timedOut: /\[timeout\]$/.test(out) }); }); });
const FLAGS = ["-std=c99", "-O0", "-DSDV_UNIT_TEST", "-Isrc", "-Istubs", "-Itest"];
async function check(dir, swc) {
  const c = await run(CC, [...FLAGS, "-o", "t", "src/" + swc + ".c", "src/" + swc + "_cfg.c", "test/Rte_" + swc + "_stub.c", "test/test_" + swc + ".c"], { cwd: dir });
  if (c.code !== 0) return { state: "invalid", why: c.out.slice(0, 200) };
  const r = await run(path.resolve(dir, process.platform === "win32" ? "t.exe" : "t"), ["r.xml"], { cwd: dir, timeoutMs: 90000 });
  if (r.timedOut) return { state: "killed", how: "hang (timeout)" };
  const m = r.out.match(/(\d+) tests, (\d+) failed/); if (!m) return { state: "killed", how: "crash/no result" };
  return Number(m[2]) > 0 ? { state: "killed", how: m[2] + " test(s) failed" } : { state: "survived" };
}
async function pool(items, n, fn) { const res = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } })); return res; }

let fails = 0;
const keys = pick === "all" ? Object.keys(PILOT_MODELS) : [pick];
for (const key of keys) {
  const bm = JSON.parse(JSON.stringify(PILOT_MODELS[key])); if (!bm) { console.error("unknown pilot " + key); process.exit(2); }
  const g = await generate(bm, { build: "mutation" }); if (!g.ok) { console.error(key + ": generation failed"); fails++; continue; }
  const swc = bm.target.swc, base = fs.mkdtempSync(path.join(os.tmpdir(), "sdv-mut-" + swc + "-"));
  for (const f of g.files) { const p = path.join(base, "orig", f.name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.text); }
  const good = await check(path.join(base, "orig"), swc);
  console.log("\n=== " + key + " (" + swc + "): " + g.tests.length + " generated tests; unmutated build: " + (good.state === "survived" ? "all pass" : "PROBLEM " + JSON.stringify(good)));
  if (good.state !== "survived") { fails++; continue; }
  const mutants = deriveMutants(g.files, swc);
  if (args.includes("--list")) { mutants.forEach((m) => console.log("   " + m.id + "  " + m.desc)); continue; }
  const results = await pool(mutants, conc, async (m, k) => {
    const dir = path.join(base, "m" + k); fs.cpSync(path.join(base, "orig"), dir, { recursive: true });
    const fp = path.join(dir, m.file); fs.writeFileSync(fp, m.apply(fs.readFileSync(fp, "utf8")));
    const r = await check(dir, swc); fs.rmSync(dir, { recursive: true, force: true }); return { m, ...r };
  });
  const killed = results.filter((r) => r.state === "killed"), surv = results.filter((r) => r.state === "survived"), inval = results.filter((r) => r.state === "invalid");
  const valid = killed.length + surv.length, score = valid ? Math.round((1000 * killed.length) / valid) / 10 : 0;
  console.log("    mutants: " + mutants.length + " · invalid (did not compile): " + inval.length + " · killed: " + killed.length + " · survived: " + surv.length + " · MUTATION SCORE " + score + "%");
  const unexplained = surv.filter((r) => !EQUIV[key + "|" + r.m.id]), explained = surv.length - unexplained.length;
  if (explained) console.log("    (" + explained + " survivor(s) are documented as equivalent in tests/mutation.equivalent.json)");
  unexplained.forEach((r) => console.log("    SURVIVED  " + r.m.id.padEnd(14) + r.m.desc));
  inval.slice(0, 3).forEach((r) => console.log("    invalid   " + r.m.id + " " + r.why.replace(/\n/g, " ").slice(0, 120)));
  if (unexplained.length) fails += unexplained.length;
  fs.rmSync(base, { recursive: true, force: true });
}
console.log(fails ? "\n" + fails + " problem(s): surviving mutants are gaps in the generated tests (or need an entry in tests/mutation.equivalent.json with a reason)" : "\nall mutants killed (or documented as equivalent)");
process.exit(fails ? 1 : 0);
