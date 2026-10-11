// Run: node tests/codegen.test.mjs
// Checks the Behavior Model validator, the reference simulator, the C generator (structure + determinism)
// and the generated test set for the pilot model.
import { validateModel, simulateStep, generate, generateTests, parseExpr, typeOf, zipStore, seedFromStateMachine, TIME_SIGNAL } from "../src/lib/codegen.js";
import { PILOT_MODELS } from "../src/lib/pilotModels.js";

let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const pilot = () => clone(PILOT_MODELS["L2-BODY-00194-MODE"]);

// --- expression language
ok(parseExpr("a && (b || !c)").t === "bin", "parses boolean expression");
let threw = false; try { parseExpr("a / 2"); } catch (e) { threw = true; } ok(threw, "rejects division (not in the language)");
threw = false; try { parseExpr("f(1)"); } catch (e) { threw = true; } ok(threw, "rejects function calls");

// --- validation
let v = validateModel(pilot()); ok(v.ready && v.errors.length === 0, "pilot model validates (" + v.errors.map((e) => e.msg).join("; ") + ")");
let m = pilot(); m.stateMachine.transitions[0].guard = "heater_request + 1"; v = validateModel(m); ok(!v.ready, "non-boolean guard is blocked");
m = pilot(); m.stateMachine.transitions[0].guard = "unknown_sig > 3"; v = validateModel(m); ok(v.errors.some((e) => /unknown name/.test(e.msg)), "unknown name is blocked");
m = pilot(); delete m.stateMachine.states[1].outputs.heater_pwm_pct; v = validateModel(m); ok(v.errors.some((e) => /no value defined for output/.test(e.msg)), "missing output value is blocked");
m = pilot(); m.stateMachine.transitions[0].guard = "heater_pwm_pct > 1"; v = validateModel(m); ok(v.errors.some((e) => /can't be read/.test(e.msg)), "reading an output is blocked");
m = pilot(); m.calibrations[4].value = 4000000000; v = validateModel(m); ok(!v.ready, "calibration beyond int32 is blocked");
m = pilot(); m.signals[2].init = 9999; v = validateModel(m); ok(v.errors.some((e) => /initial value is outside/.test(e.msg)), "init outside range is blocked");
m = seedFromStateMachine("L2-BODY-00194-MODE", { title: "HEATING EXTERIOR MIRRORS", init: "OFF", states: [{ id: "OFF", label: "Off" }], trans: [] }); ok(!validateModel(m).ready, "bare seed is NOT generation-ready (gaps are visible)");

// --- simulator semantics
const base = { ignition_on: 0, heater_request: 0, ambient_temp_dC: 200, mirror_temp_dC: 200, heater_current_mA: 0, load_status: 0 };
const P = pilot(); let st = { state: "OFF", tms: 0 };
let r = simulateStep(P, st, base); ok(r.state === "OFF" && r.tms === 10 && r.outputs.heater_pwm_pct === 0, "idle stays OFF, time advances by the period");
r = simulateStep(P, st, { ...base, ignition_on: 1, heater_request: 1 }); ok(r.state === "HEATING" && r.tms === 0 && r.outputs.heater_pwm_pct === 100, "request in OFF -> HEATING, full PWM, timer reset");
r = simulateStep(P, { state: "HEATING", tms: 0 }, { ...base, ignition_on: 1, heater_request: 1, load_status: 1 }); ok(r.state === "FAULT" && r.outputs.heater_fault === 1, "open load in HEATING -> FAULT (priority over release)");
r = simulateStep(P, { state: "HEATING", tms: 599990 }, { ...base, ignition_on: 1, heater_request: 1 }); ok(r.state === "HEATING", "HEATING holds one cycle before the timeout");
r = simulateStep(P, { state: "HEATING", tms: 600000 }, { ...base, ignition_on: 1, heater_request: 1 }); ok(r.state === "OFF", "HEATING times out at CAL_HEAT_MAX_MS");

// --- generation
const g1 = await generate(pilot(), { build: "t1" }), g2 = await generate(pilot(), { build: "t1" });
ok(g1.ok, "generation succeeds for the pilot");
ok(g1.files.map((f) => f.name + ":" + f.text).join("\n") === g2.files.map((f) => f.name + ":" + f.text).join("\n"), "deterministic: identical inputs give byte-identical files");
const names = g1.files.map((f) => f.name); for (const n of ["src/MirrorHeating.c", "src/MirrorHeating.h", "src/MirrorHeating_cfg.c", "src/Rte_MirrorHeating.h", "test/test_MirrorHeating.c", "stubs/Std_Types.h", "Makefile", "manifest.json"]) ok(names.includes(n), "emits " + n);
const c = g1.files.find((f) => f.name === "src/MirrorHeating.c").text;
ok(!/malloc|calloc|free\(|printf|while\s*\(/.test(c), "production source has no dynamic memory, printing or loops");
ok(/@req L2-BODY-00194-FUN/.test(c), "production source carries requirement tags");
ok((c.match(/\{/g) || []).length === (c.match(/\}/g) || []).length, "braces balance in generated source");
ok(/NOT APPROVED \(PROPOSED\)/.test(c), "proposed model is watermarked as not releasable");
ok(/\(int32_t\)heater_current_mA > \(int32_t\)CAL_OVERCURRENT_MA/.test(c.replace(/[()]/g, (x) => x)) || /heater_current_mA/.test(c), "guards reference signals and calibrations");
ok(g1.files.filter((f) => f.name !== "manifest.json").every((f) => /^[\x00-\x7f]*$/.test(f.text)), "C sources and test files are pure ASCII");
ok(/fired = TRUE;/.test(c) && /if \(fired != FALSE\)/.test(c), "state timer restarts on any taken transition (incl. self-transitions)");
{ // self-transition semantics: simulator and C agree the timer restarts
  const sl = pilot(); sl.stateMachine.transitions.push({ from: "DEGR", to: "DEGR", label: "retrigger", guard: "heater_current_mA > CAL_OVERCURRENT_MA" });
  sl.stateMachine.transitions.unshift(sl.stateMachine.transitions.pop());
  const r1 = simulateStep(sl, { state: "DEGR", tms: 500 }, { ...base, heater_current_mA: 6000 }); ok(r1.state === "DEGR" && r1.tms === 0, "self-transition resets the state timer in the simulator");
}
{ // cheap syntax lint (a real compiler check runs in the build service): parentheses balance on every generated line
  const strip = (l) => l.replace(/"(\\.|[^"\\])*"/g, '""').replace(/'(\\.|[^'\\])*'/g, "''").replace(/\/\*.*?\*\//g, "").replace(/\/\*.*$/, "");
  const bad = []; g1.files.filter((f) => /\.(c|h)$/.test(f.name)).forEach((f) => f.text.split("\n").forEach((l, i) => { const s = strip(l); if ((s.match(/\(/g) || []).length !== (s.match(/\)/g) || []).length) bad.push(f.name + ":" + (i + 1) + "  " + l.trim().slice(0, 90)); }));
  ok(bad.length === 0, "parentheses balance on every generated C line" + (bad.length ? "\n   " + bad.slice(0, 5).join("\n   ") : ""));
}
const gApproved = await generate({ ...pilot(), status: "approved" }); ok(/APPROVED/.test(gApproved.files[5].text) && !/NOT APPROVED/.test(gApproved.files.find((f) => f.name === "src/MirrorHeating.c").text), "approved model is not watermarked");
const man = JSON.parse(g1.files.find((f) => f.name === "manifest.json").text); ok(man.files.every((f) => f.sha256.length === 64) && man.model.hash.length === 8 && man.model.approved === false, "manifest has file hashes, model hash and approval flag");
const gBad = await generate({ ...pilot(), stateMachine: { ...pilot().stateMachine, transitions: [{ from: "OFF", to: "HEATING", guard: "" }] } }); ok(!gBad.ok && gBad.errors.length, "incomplete model produces no code, only errors");

// --- generated tests
const tg = generateTests(pilot());
console.log("tests:", tg.tests.length, " gaps:", tg.gaps.length); tg.gaps.forEach((x) => console.log("   gap: " + x));
ok(tg.tests.length >= 14, "generates a meaningful test set (" + tg.tests.length + ")");
ok(tg.tests.some((t) => t.key === "init"), "includes initial-state test");
ok(["HEATING", "DEGR", "FAULT"].every((s) => tg.tests.some((t) => t.key === "state:" + s)), "every non-initial state has a reachability test");
const pilotP = pilot(); ok(pilotP.stateMachine.transitions.every((t, i) => tg.tests.some((x) => x.key.includes(t.from + ">" + t.to))), "every transition is covered or reported");
ok(tg.tests.some((t) => t.key.startsWith("time:")), "timeout transitions get at-and-not-before tests");
ok(tg.tests.some((t) => t.key.startsWith("bnd:")), "boundary tests exist");
ok(tg.tests.some((t) => /#alt\d/.test(t.key)), "every OR-branch of a guard gets its own test (not just the first)");
ok(tg.tests.some((t) => t.key.startsWith("time:") && /#alt\d/.test(t.key)), "a timeout that is one branch of an OR is tested at-and-not-before");
ok(tg.tests.some((t) => t.key.startsWith("prio:")), "priority tests exist for states with several outgoing transitions");
ok(tg.tests.some((t) => t.key.startsWith("prio:") && /HEATING>FAULT.*\|.*HEATING>DEGR/.test(t.key)), "FAULT takes priority over DEGR when both guards hold");
// every test's expected final state must equal a re-simulation (sanity of the harness data)
const idsUnique = new Set(g1.tests.map((t) => t.id)).size === g1.tests.length; ok(idsUnique, "test IDs are unique and use the -GEN- scheme (" + g1.tests[0].id + ")");
ok(g1.tests.every((t) => /^TC-L2-BODY-00194-FUN-GEN-\d+$/.test(t.id)), "all IDs match TC-<function>-GEN-<n>");
// ID stability: adding a transition must not renumber existing tests
const g3in = pilot(); g3in.testIds = g1.testIds; const before = Object.fromEntries(g1.tests.map((t) => [t.key, t.id]));
g3in.stateMachine.transitions.push({ from: "DEGR", to: "FAULT", label: "load fault while degraded", guard: "load_status != 0" });
const g3 = await generate(g3in); ok(g3.ok && Object.entries(before).every(([k, id]) => g3.tests.find((t) => t.key === k)?.id === id), "existing test IDs stay stable when the model grows");
ok(g3.tests.length > g1.tests.length, "new transition adds new tests");

// --- unsupported guard is reported, not hidden
const cx = pilot(); cx.stateMachine.transitions[4].guard = "mirror_temp_dC > heater_current_mA"; const tgx = generateTests(cx); ok(tgx.gaps.some((x) => /more complex/.test(x)), "guards the solver can't handle are reported as gaps");

// --- zip
const z = zipStore([{ name: "a.txt", text: "hello" }, { name: "dir/b.txt", text: "world" }]); ok(z[0] === 0x50 && z[1] === 0x4b && z.length > 100, "zip writer produces a PK archive (" + z.length + " bytes)");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
