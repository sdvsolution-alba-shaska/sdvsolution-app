// Run: node tests/verify-generated-c.mjs      (CC=gcc by default; set CC to use another compiler)
// Generates the pilot Behavior Model, compiles the generated C with strict flags, runs the generated unit tests and
// checks that the JUnit XML names every generated test. Then injects deliberate bugs ("mutants") into the generated
// source and checks the generated tests catch each one. Skips cleanly (exit 0) if no C compiler is on PATH.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { generate } from "../src/lib/codegen.js";
import { PILOT_MODELS } from "../src/lib/pilotModels.js";

const CC = process.env.CC || "gcc";
const has = spawnSync(CC, ["--version"], { encoding: "utf8" });
if (has.error || has.status !== 0) { console.log("SKIPPED: no C compiler found (" + CC + "). Install GCC/Clang or set CC."); process.exit(0); }
console.log("compiler: " + has.stdout.split("\n")[0]);

const FLAGS = ["-std=c99", "-Wall", "-Wextra", "-Wconversion", "-Werror", "-O0", "-g", "-DSDV_UNIT_TEST", "-Isrc", "-Istubs", "-Itest"];
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };
const bm = JSON.parse(JSON.stringify(PILOT_MODELS["L2-BODY-00194-MODE"]));
const g = await generate(bm, { build: "verify" }); if (!g.ok) { console.error("generation failed", g.errors); process.exit(1); }
const swc = "MirrorHeating", exeName = process.platform === "win32" ? "t.exe" : "t";

function build(dir, mutate) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of g.files) { const p = path.join(dir, f.name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.text); }
  if (mutate) { const p = path.join(dir, "src", swc + ".c"); const t = fs.readFileSync(p, "utf8"); if (!t.includes(mutate[0])) return { skipped: true }; fs.writeFileSync(p, t.replace(mutate[0], mutate[1])); }
  const src = ["src/" + swc + ".c", "src/" + swc + "_cfg.c", "test/Rte_" + swc + "_stub.c", "test/test_" + swc + ".c"];
  const c = spawnSync(CC, [...FLAGS, "-o", "t", ...src], { cwd: dir, encoding: "utf8" });
  if (c.status !== 0) return { compile: false, out: (c.stderr || "").slice(0, 600) };
  const r = spawnSync(path.resolve(dir, exeName), ["results.xml"], { cwd: dir, encoding: "utf8", env: { ...process.env, SDV_BUILD: "verify" } });
  if (r.error) return { compile: true, ran: false, out: "could not run: " + r.error.message };
  return { compile: true, ran: true, status: r.status, out: (r.stdout || "").trim(), xml: fs.existsSync(path.join(dir, "results.xml")) ? fs.readFileSync(path.join(dir, "results.xml"), "utf8") : "" };
}

const base = path.join(os.tmpdir(), "sdv-verify-" + process.pid);
const r0 = build(path.join(base, "good"));
ok(r0.compile, "generated C compiles with " + FLAGS.filter((f) => /^-W/.test(f)).join(" ") + (r0.compile ? "" : "\n" + r0.out));
ok(r0.ran && r0.status === 0 && /^\d+ tests, 0 failed/.test(r0.out), "all generated tests pass on the generated code (" + r0.out + ")");
ok(g.tests.every((t) => (r0.xml || "").includes('name="' + t.id + '"')), "JUnit XML lists every generated test ID (" + g.tests.length + ")");
ok(!/<failure/.test(r0.xml || ""), "no failures in the JUnit XML");

const MUTANTS = [
  ["boundary: over-current > becomes >=", "(int32_t)heater_current_mA > (int32_t)CAL_OVERCURRENT_MA", "(int32_t)heater_current_mA >= (int32_t)CAL_OVERCURRENT_MA"],
  ["timeout: heat timeout >= becomes >", "(int32_t)state_time_ms >= (int32_t)CAL_HEAT_MAX_MS", "(int32_t)state_time_ms > (int32_t)CAL_HEAT_MAX_MS"],
  ["output: DEGR PWM uses the wrong calibration", "heater_pwm_pct = (uint8_t)(int32_t)CAL_PWM_DERATE_PCT;", "heater_pwm_pct = (uint8_t)(int32_t)CAL_PWM_FULL_PCT;"],
  ["priority: open-load ignored while over-current", "if ((((int32_t)load_status != (int32_t)0) || (door_can_timeout != 0u)))", "if (((((int32_t)load_status != (int32_t)0) && ((int32_t)heater_current_mA <= (int32_t)CAL_OVERCURRENT_MA)) || (door_can_timeout != 0u)))"],
  ["timer never advances", "MirrorHeating_stateTimeMs += MIRRORHEATING_PERIOD_MS;", "MirrorHeating_stateTimeMs += 0u;"],
  ["auto-on < becomes <=", "(int32_t)ambient_temp_dC < (int32_t)CAL_AUTO_ON_TEMP_DC", "(int32_t)ambient_temp_dC <= (int32_t)CAL_AUTO_ON_TEMP_DC"],
  ["hysteresis minus becomes plus", "(int32_t)CAL_OVERTEMP_DC - (int32_t)CAL_TEMP_HYST_DC", "(int32_t)CAL_OVERTEMP_DC + (int32_t)CAL_TEMP_HYST_DC"],
  ["ignition-off release removed", "(!(ignition_on != 0u)) || ", ""],
  ["FAULT retry timeout removed", " && ((int32_t)state_time_ms >= (int32_t)CAL_FAULT_RETRY_MS)", ""],
  ["fault flag never raised", "heater_fault = TRUE;", "heater_fault = FALSE;"],
  ["defensive: corrupted state is not recovered", "/* defensive: unknown state, recover to the initial state */\n        fired = TRUE;", "/* defensive: unknown state, recover to the initial state */"],
  ["defensive: state timer wraps instead of saturating", "MirrorHeating_stateTimeMs = MIRRORHEATING_TIME_MAX;", "MirrorHeating_stateTimeMs = 0u;"],
  ["output: wrong output in the last state", "heater_fault = TRUE;\n    }", "heater_fault = FALSE;\n    }"],
];
MUTANTS.forEach((m, i) => {
  const r = build(path.join(base, "m" + i), [m[1], m[2]]);
  if (r.skipped) { ok(false, "mutant pattern not found (generator output changed?): " + m[0]); return; }
  ok(r.compile && r.ran && r.status === 1 && /^\d+ tests, [1-9]\d* failed/.test(r.out), "mutant caught (tests ran and reported failures): " + m[0] + (r.compile ? " (" + r.out + ")" : " — did not compile"));
});
// every OTHER pilot: strict compile + all of its generated tests pass (the explicit mutants above are specific to the first pilot;
// tests/mutation.mjs derives mutants automatically for all of them)
for (const [key, tpl] of Object.entries(PILOT_MODELS)) {
  if (key === "L2-BODY-00194-MODE") continue;
  const bm2 = JSON.parse(JSON.stringify(tpl)); const g2 = await generate(bm2, { build: "verify" }); const sw2 = bm2.target.swc;
  const d2 = path.join(base, "p-" + sw2); for (const f of g2.files) { const p = path.join(d2, f.name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.text); }
  const cc = spawnSync(CC, [...FLAGS, "-o", "t", "src/" + sw2 + ".c", "src/" + sw2 + "_cfg.c", "test/Rte_" + sw2 + "_stub.c", "test/test_" + sw2 + ".c"], { cwd: d2, encoding: "utf8" });
  ok(cc.status === 0, "[" + sw2 + "] compiles with " + FLAGS.filter((f) => /^-W/.test(f)).join(" ") + (cc.status === 0 ? "" : "\n" + (cc.stderr || "").slice(0, 500)));
  const rr = cc.status === 0 ? spawnSync(path.resolve(d2, exeName), ["results.xml"], { cwd: d2, encoding: "utf8", env: { ...process.env, SDV_BUILD: "verify" } }) : { status: -1, stdout: "" };
  ok(rr.status === 0 && new RegExp("^" + g2.tests.length + " tests, 0 failed").test((rr.stdout || "").trim()), "[" + sw2 + "] all " + g2.tests.length + " generated tests pass (" + (rr.stdout || "").trim() + ")");
}
fs.rmSync(base, { recursive: true, force: true });
console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
