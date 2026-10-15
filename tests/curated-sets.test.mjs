// Run: node tests/curated-sets.test.mjs
// Checks the curated requirement sets (OPS_REQS in src/App.jsx). Global rules apply to every set (unique ids, a "shall", an acceptance criterion).
// The sets listed in FULL_BAR are held to the full quality bar (EARS wording, singular, attributes, no vague terms, ASIL marked as proposal).
// Coverage is checked ACROSS the curated sets: every L1 feature of those L0s must be traced by at least one curated requirement somewhere, because
// overlapping features of neighbouring L0s (e.g. the camera views of Camera & Surround View and Driver Assistance) are merged into one requirement
// that traces the L1 features of both.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import * as RC from "../src/lib/reqChecks.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };
const lines = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "App.jsx"), "utf8").split("\n");
const OPS = JSON.parse(lines.find((s) => s.startsWith("const OPS_REQS = ")).replace(/^const OPS_REQS = /, "").replace(/;\s*$/, ""));
const RAW = JSON.parse(lines.find((s) => s.startsWith("const RAW_GRAPH = ")).replace(/^const RAW_GRAPH = /, "").replace(/;\s*$/, ""));
const VAGUE = ["fast", "quick", "quickly", "robust", "user-friendly", "easy", "efficient", "flexible", "approximately", "as appropriate", "etc", "and/or", "minimal", "maximal", "state of the art", "high-quality", "seamless", "optimal", "sufficient"];
const vague = (s) => VAGUE.filter((t) => new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(s));
// the dashboard's own "singular" heuristic: an "and" before the "shall" makes a statement fail Requirements Quality
const dashSingular = (st) => !/\b(and|;|,)\b.*\bshall\b/i.test(st) && (st.match(/\bshall\b/gi) || []).length <= 1;

const all = Object.entries(OPS).flatMap(([sub, rs]) => rs.map((r) => ({ sub, r })));
const ids = all.map((x) => x.r.id); const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
ok(!dup.length, "every curated requirement id is unique across all sets (" + all.length + " requirements, " + Object.keys(OPS).length + " sets)" + (dup.length ? ": " + [...new Set(dup)].join(", ") : ""));
ok(all.every((x) => /\bshall\b/i.test(x.r.req) && String(x.r.ac || "").trim()), "every curated requirement has a 'shall' and an acceptance criterion");

const FULL_BAR = [
  { set: "Driver Assistance", l0: "L0-ADAS-002", l1Count: 53, idRe: /^DA-[A-Z]{3}-\d{2}$/ },
  { set: "Camera & Surround View", l0: "L0-ADAS-001", l1Count: 15, idRe: /^CSV-[A-Z]{3}-\d{2}$/ },
  { set: "Occupant Visibility", l0: "L0-BODY-008", l1Count: 21, idRe: /^OV-[A-Z]{3}-\d{2}$/ },
];
const RETIRED = ["DA-CAM-01", "DA-CAM-02", "DA-CAM-04", "CSV-COL-01", "CSV-DMS-01", "CSV-DMS-02"]; // merged away into the requirements that list them in mergedFrom
const tracedAnywhere = new Set(all.flatMap((x) => x.r.l1 || [])), graphIds = new Set(RAW.nodes.map((n) => n.id));
for (const cfg of FULL_BAR) {
  const S = OPS[cfg.set], tag = cfg.set + ": "; ok(!!S && S.length > 0, "the " + cfg.set + " set exists (" + (S ? S.length : 0) + " requirements)"); if (!S) continue;
  const findings = S.flatMap((r) => RC.curatedFindings(RC.curatedToGapReqs({ x: [r] })[0]).map((f) => r.id + ": " + f.msg));
  ok(!findings.length, tag + "EARS wording matches the declared pattern, singular, attributes complete" + (findings.length ? " — " + findings.join(" | ") : ""));
  const v = S.flatMap((r) => vague(r.req).map((t) => r.id + ": " + t)); ok(!v.length, tag + "no vague terms" + (v.length ? " — " + v.join(", ") : ""));
  const ns = S.filter((r) => !dashSingular(r.req)).map((r) => r.id); ok(!ns.length, tag + "every statement passes the dashboard 'singular' rule (no 'and' before the shall)" + (ns.length ? " — " + ns.join(", ") : ""));
  ok(S.every((r) => r.func === true && r.owner && r.rationale && r.safety), tag + "functional schema with owner, rationale and safety/regulatory field");
  ok(S.every((r) => cfg.idRe.test(r.id)), tag + "ids follow the set's id pattern");
  ok(S.filter((r) => /ASIL/.test(r.safety)).every((r) => /proposed/i.test(r.safety)), tag + "every ASIL level is marked as a proposal (pending HARA)");
  ok(S.filter((r) => /\d/.test(r.ac)).every((r) => /proposal/i.test(r.ac)), tag + "every acceptance criterion with numeric targets says the targets are proposals");
  ok(S.every((r) => (r.l1 || []).length > 0 && r.l1.every((i) => graphIds.has(i))), tag + "every requirement traces at least one L1 feature and every L1 reference exists in the graph");
  ok(S.filter((r) => r.mergedFrom).every((r) => r.mergedFrom.length >= 2 && r.mergedFrom.every((m) => ids.includes(m) || RETIRED.includes(m))), tag + "merged requirements list their sources, each a live or a retired id (" + S.filter((r) => r.mergedFrom).length + " merged)");
  const l1 = RAW.nodes.filter((n) => n.props && n.props.parentL0 === cfg.l0).map((n) => n.id), missing = l1.filter((i) => !tracedAnywhere.has(i));
  ok(l1.length === cfg.l1Count, tag + "the graph has " + cfg.l1Count + " L1 features under " + cfg.l0 + " (found " + l1.length + ")");
  ok(!missing.length, tag + "every L1 feature is traced by at least one curated requirement (in this set or a merged one)" + (missing.length ? " — NOT COVERED: " + missing.join(", ") : ""));
}
// merged-away ids are really gone, and nothing duplicates their behaviour any more
const retired = RETIRED;
ok(retired.every((i) => !ids.includes(i)), "the ids merged away are not in any set any more (" + retired.join(", ") + ")");
console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
