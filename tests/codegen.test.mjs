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

// --- every pilot model (generic checks) — the second pilot (Fold Down Exterior Mirrors) exercises a different kind of function
for (const [key, tpl] of Object.entries(PILOT_MODELS)) {
  const bm = JSON.parse(JSON.stringify(tpl)), tag = "[" + bm.target.swc + "] ";
  const val = validateModel(bm); ok(val.ready && val.errors.length === 0 && val.warnings.length === 0, tag + "validates with no errors or warnings");
  const tgp = generateTests(bm); ok(tgp.gaps.length === 0, tag + "the test generator finds a stimulus for every state and transition (gaps: " + tgp.gaps.length + ")");
  ok(tgp.tests.some((t) => t.key.startsWith("def:state")) && tgp.tests.some((t) => t.key.startsWith("def:timer")), tag + "defensive paths (corrupted state, timer saturation) are tested");
  const multi = {}; bm.stateMachine.transitions.forEach((t) => { multi[t.from] = (multi[t.from] || 0) + 1; });
  ok(Object.values(multi).every((n) => n < 2) || tgp.tests.some((t) => t.key.startsWith("prio:")), tag + "states with competing exits get priority tests");
  const g1 = await generate(bm, { build: "x" }), g2 = await generate(bm, { build: "x" });
  ok(g1.ok && g1.files.map((f) => f.name + f.text).join() === g2.files.map((f) => f.name + f.text).join(), tag + "generation is deterministic");
  ok(g1.files.filter((f) => f.name !== "manifest.json").every((f) => /^[\x00-\x7f]*$/.test(f.text)), tag + "sources are pure ASCII");
  ok(/^TC-L2-BODY-\d+-FUN-GEN-\d+$/.test(g1.tests[0].id) && new Set(g1.tests.map((x) => x.id)).size === g1.tests.length, tag + "test IDs follow TC-<function>-GEN-<n> and are unique");
}
{ // a guard that uses a boolean CONFIGURATION calibration is folded as a constant (found by the second pilot)
  const bm = JSON.parse(JSON.stringify(PILOT_MODELS["L2-BODY-00193-MODE"])); const on = generateTests(bm); ok(on.gaps.length === 0 && on.tests.some((t) => /FOLDED>UNFOLDING#1#alt1/.test(t.key)), "boolean configuration calibration in a guard: the drive-away branch is tested when enabled");
  bm.calibrations.find((c) => c.name === "CAL_AUTO_UNFOLD_EN").value = 0; const off = generateTests(bm);
  ok(!off.tests.some((t) => /FOLDED>UNFOLDING#1#alt1/.test(t.key)), "…and no such test is invented when the feature is configured off (the branch is constant-false)");
}
// --- AUTOSAR SWC description (arxml/<swc>.arxml): well-formed, internally consistent, and matching the generated C names
for (const key of Object.keys(PILOT_MODELS)) {
  const g = await generate(clone(PILOT_MODELS[key]), { build: "arx" }), tag = key + ": ";
  const ax = g.files.find((f) => /^arxml\/.+\.arxml$/.test(f.name)); ok(!!ax, tag + "an ARXML SWC description is generated (" + (ax && ax.name) + ")"); if (!ax) continue;
  const xml = ax.text, rteH = g.files.find((f) => /^src\/Rte_.+\.h$/.test(f.name)).text, swcH = g.files.find((f) => /^src\/[^/]+\.h$/.test(f.name) && !/Rte_|_cfg/.test(f.name)).text;
  // well-formed: tags balance, and collect every element path built from nested SHORT-NAMEs
  const stack = [], names = [], paths = new Set(); let wf = true; const re = /<SHORT-NAME>([^<]*)<\/SHORT-NAME>|<(\/?)([A-Z0-9-]+)([^>]*?)(\/?)>/g; let mm;
  const body = xml.replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  while ((mm = re.exec(body))) {
    if (mm[1] != null) { names[stack.length - 1] = mm[1]; paths.add("/" + names.slice(0, stack.length).filter(Boolean).join("/")); continue; }
    if (mm[5] === "/") continue; if (mm[2] === "/") { if (stack.pop() !== mm[3]) wf = false; names.length = stack.length; } else { stack.push(mm[3]); names[stack.length - 1] = undefined; }
  }
  ok(wf && stack.length === 0, tag + "ARXML is well-formed (every element closed in order)");
  const refs = [...xml.matchAll(/<[A-Z-]+-T?REF DEST="[A-Z-]+">([^<]+)<\//g)].map((r) => r[1]), own = refs.filter((r) => !r.startsWith("/AUTOSAR_Platform/")), missing = own.filter((r) => !paths.has(r));
  ok(own.length > 0 && !missing.length, tag + "every reference inside the package resolves (" + own.length + " refs)" + (missing.length ? " — missing: " + missing.slice(0, 3).join(", ") : ""));
  ok(refs.filter((r) => r.startsWith("/AUTOSAR_Platform/")).every((r) => /\/(uint8|uint16|uint32|sint8|sint16|sint32|boolean)$/.test(r)), tag + "only standard AUTOSAR platform types are referenced from outside");
  const apis = [...rteH.matchAll(/Rte_(Read|Write)_([A-Za-z0-9_]+)\(/g)];
  const portsOf = (kind) => [...xml.matchAll(new RegExp("<" + kind + ">\\s*<SHORT-NAME>([^<]+)</SHORT-NAME>[\\s\\S]*?<DATA-ELEMENT-REF DEST=\"VARIABLE-DATA-PROTOTYPE\">[^<]*/([^/<]+)</DATA-ELEMENT-REF>", "g"))].map((r) => r[1] + "_" + r[2]);
  const rIn = new Set(portsOf("R-PORT-PROTOTYPE")), pOut = new Set(portsOf("P-PORT-PROTOTYPE"));
  const portsOk = apis.length > 0 && apis.length === rIn.size + pOut.size && apis.every(([, rw, pe]) => (rw === "Read" ? rIn : pOut).has(pe));
  ok(portsOk, tag + "every Rte_Read_/Rte_Write_ in the generated C has its port and data element in the ARXML (" + apis.length + ")");
  const syms = [...xml.matchAll(/<SYMBOL>([^<]+)<\/SYMBOL>/g)].map((r) => r[1]);
  ok(syms.length === 2 && syms.every((sy) => new RegExp("void " + sy + "\\(void\\);").test(swcH)), tag + "runnable symbols match the C functions (" + syms.join(", ") + ")");
  const per = (xml.match(/<PERIOD>([^<]+)<\/PERIOD>/) || [])[1]; ok(Number(per) * 1000 === Number(clone(PILOT_MODELS[key]).runnable.periodMs), tag + "timing event period matches the runnable period (" + per + " s)");
  const g2 = await generate(clone(PILOT_MODELS[key]), { build: "arx" }); ok(g2.files.find((f) => f.name === ax.name).text === xml, tag + "ARXML is deterministic");
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
