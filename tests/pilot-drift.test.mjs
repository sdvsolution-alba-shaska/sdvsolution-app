// Run: node tests/pilot-drift.test.mjs
// A Behavior Model is seeded from the architecture's state machine (STATE_MACHINES in src/App.jsx). If the two disagree, the generated
// code would implement a different machine than the one engineers reviewed in the diagrams. This test fails when a pilot model's states or
// transitions drift from the architecture — in either direction (a transition missing from the model, or one the architecture lacks).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { PILOT_MODELS } from "../src/lib/pilotModels.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "App.jsx"), "utf8");
const a = src.indexOf("const STATE_MACHINES = {"), b = src.indexOf("\n};", a);
const ARCH = new Function("return " + src.slice(a + "const STATE_MACHINES = ".length, b + 3).replace(/;\s*$/, ""))();
ok(Object.keys(ARCH).length >= 9, "architecture state machines parsed (" + Object.keys(ARCH).length + ")");
for (const [key, bm] of Object.entries(PILOT_MODELS)) {
  const arch = ARCH[key], tag = "[" + bm.target.swc + "] "; if (!arch) { ok(false, tag + "has an architecture state machine (" + key + ")"); continue; }
  const aS = arch.states.map((s) => s.id).sort().join(), mS = bm.stateMachine.states.map((s) => s.id).sort().join();
  ok(aS === mS && arch.init === bm.stateMachine.init, tag + "same states and initial state as the architecture (" + mS.replace(/,/g, " ") + ", init " + bm.stateMachine.init + ")");
  const pairs = (list) => list.map((t) => t.from + ">" + t.to).sort();
  const aT = pairs(arch.trans), mT = pairs(bm.stateMachine.transitions);
  const missing = aT.filter((x) => !mT.includes(x)), extra = mT.filter((x) => !aT.includes(x));
  ok(!missing.length, tag + "every architecture transition is in the model" + (missing.length ? " — MISSING: " + missing.join(", ") : ""));
  ok(!extra.length, tag + "the model adds no transition the architecture lacks" + (extra.length ? " — EXTRA: " + extra.join(", ") : ""));
  ok(aT.length === mT.length, tag + "same number of transitions (" + mT.length + ")");
  // wording differences are reported, not failed: they need an engineer's decision (diagram wording vs. model behaviour)
  const lab = bm.stateMachine.transitions.filter((t) => !arch.trans.some((x) => x.from === t.from && x.to === t.to && x.label === t.label));
  console.log(lab.length ? "warn " + tag + "label differs from the architecture: " + lab.map((t) => t.from + ">" + t.to + " [model '" + t.label + "' vs architecture '" + arch.trans.find((x) => x.from === t.from && x.to === t.to).label + "']").join("; ") : "ok   " + tag + "transition labels match the architecture");
}
console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
