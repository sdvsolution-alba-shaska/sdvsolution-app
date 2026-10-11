// Run: node tests/reqchecks.test.mjs
// Quality checks for the curated requirement sets: unit cases, plus runs over the REAL curated requirements in src/App.jsx.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { earsMismatch, notSingular, missingAttributes, reqTitle, curatedToGapReqs, curatedFindings, leadWord } from "../src/lib/reqChecks.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };

// --- EARS pattern vs wording
ok(earsMismatch("When a user enters the vehicle, the system shall load the profile.", "Event-driven") === null, "Event-driven + leading When → consistent");
ok(/Event-driven.*When/.test(earsMismatch("The system shall react when a user enters the vehicle.", "Event-driven")), "Event-driven without a leading When → mismatch, with a rewording hint");
ok(earsMismatch("While the vehicle is parked, the system shall hold the lock.", "State-driven") === null, "State-driven + leading While → consistent");
ok(/State-driven/.test(earsMismatch("When parked, the system shall hold the lock.", "State-driven")) && /starts with “When”/.test(earsMismatch("When parked, the system shall hold the lock.", "State-driven")), "State-driven but starts with When → mismatch names the actual lead word");
ok(earsMismatch("If the heater overheats, then the system shall switch it off.", "Unwanted (error)") === null, "Unwanted needs 'If …, then …'");
ok(/Unwanted/.test(earsMismatch("If the heater overheats the system shall switch it off.", "Unwanted (error)")), "Unwanted without 'then' → mismatch");
ok(earsMismatch("Where a trailer is attached, the system shall show the trailer view.", "Optional") === null, "Optional + leading Where → consistent");
ok(earsMismatch("The system shall log every update.", "Ubiquitous") === null, "Ubiquitous without a condition → consistent");
ok(/Ubiquitous/.test(earsMismatch("When an update starts, the system shall log it.", "Ubiquitous")), "Ubiquitous but starts with When → mismatch");
ok(earsMismatch("anything", "") === null && earsMismatch("anything", undefined) === null && earsMismatch("anything", "Complex") === null, "no declared pattern, or an unknown one → nothing to check");
ok(leadWord("  while x") === "while" && leadWord("The system") === "", "lead-word detection");

// --- singular, attributes, titles
ok(notSingular("The system shall A and shall B.") && !notSingular("The system shall A and B."), "singular: more than one 'shall' is flagged, 'and' alone is not");
ok(missingAttributes({ func: true, ears: "Ubiquitous", owner: "x", rationale: "y" }).length === 0, "functional Ubiquitous needs no trigger");
ok(missingAttributes({ func: true, ears: "Event-driven", owner: "x", rationale: "y" }).join() === "trigger / precondition", "functional Event-driven without a trigger is flagged");
ok(missingAttributes({ func: false, owner: "x", rationale: "y", method: "Test", std: "ISO 14229" }).length === 0, "operational with owner, rationale, method and standard is complete");
ok(missingAttributes({ func: false, owner: " ", rationale: "", method: "", std: "" }).join() === "owner,rationale,verification method,applicable standard", "operational: all four missing attributes are listed (blank = missing)");
ok(reqTitle({ req: "The vehicle shall support end-of-line reprogramming of every ECU, via DoIP.", id: "X" }) === "Support end-of-line reprogramming of every ECU", "title = the clause after 'shall'");
ok(reqTitle({ req: "A".repeat(10) + " shall " + "b".repeat(80), id: "X" }).length <= 50, "long titles are shortened");
const ad = curatedToGapReqs({ "Sub A": [{ id: "A-1", req: "The x shall y.", ac: "ok", owner: "o", rationale: "r", func: true, ears: "Ubiquitous", cat: "C" }, { id: "A-2", req: "The x shall z.", ac: "ok", method: "Audit", std: "S", owner: "o", rationale: "r", cat: "C", _edited: true }] });
ok(ad.length === 2 && ad.every((r) => r.curated && r.subdomain === "Sub A") && ad[0].method === "Test" && ad[1].method === "Audit" && ad[1].edited === true, "adapter: curated flag, subdomain, functional defaults to 'Test', operational keeps its method, edit flag carried");
ok(curatedFindings({ statement: "The x shall a and shall b.", func: true, ears: "Ubiquitous", owner: "o", rationale: "r" }).map((f) => f.cat).join() === "ears", "findings: a non-singular statement → one 'ears' finding");

// --- the real curated requirements
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "App.jsx"), "utf8");
const OPS = JSON.parse(src.match(/const OPS_REQS = (\{.*\});/)[1]);
const all = curatedToGapReqs(OPS);
ok(all.length >= 200 && Object.keys(OPS).length === 11, "the real curated set is loaded (" + all.length + " requirements in " + Object.keys(OPS).length + " subdomains)");
ok(all.every((r) => r.id && r.title && r.statement), "every curated requirement adapts to id + title + statement");
const byId = Object.fromEntries(all.map((r) => [r.id, r]));
ok(curatedFindings(byId["VP-ID-01"]).filter((f) => f.cat === "ears").length === 0, "VP-ID-01 ('When a user enters the vehicle, …') is consistent with Event-driven");
ok(curatedFindings(byId["VP-ID-02"]).some((f) => f.cat === "ears" && /Event-driven/.test(f.msg)), "VP-ID-02 ('The system shall allow …') is flagged: declared Event-driven but not worded as When …");
const mism = all.filter((r) => r.func && earsMismatch(r.statement, r.ears)); ok(mism.length > 0 && mism.length < all.filter((r) => r.func).length, "some, but not all, functional requirements have a pattern mismatch (" + mism.length + " of " + all.filter((r) => r.func).length + ")");
ok(all.every((r) => missingAttributes(r).length === 0), "every curated requirement currently has an owner, rationale and the attributes its layout needs");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
