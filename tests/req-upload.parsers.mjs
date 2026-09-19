// Unit tests for the requirement-upload parsers (Excel/CSV → records).
// Extracts the REAL csvToAoa + aoaToReqRecords from ../src/App.jsx.
// Run:  node tests/req-upload.parsers.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "src", "App.jsx"), "utf8");
const code = src.slice(src.indexOf("function csvToAoa("), src.indexOf("async function docxToAoa("));
const { csvToAoa, aoaToReqRecords } = (new Function(code + "\nreturn { csvToAoa, aoaToReqRecords };"))();

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ✓ " : "  ✗ ") + m); };

// Our own export layout (Level · No. · ID · Title/Aspect · Statement · ECU · Safety · …)
const aoa = [
  ["Level", "No.", "ID", "Title / Aspect", "Statement", "ECU", "Safety", "Regulations", "System"],
  ["L1", "1.1", "L1-BODY-00187", "Adjust Mirror", "The system shall move the mirror.", "DCM_FL", "ASIL A", "FMVSS 111", "Occupant Visibility"],
  ["L2", "1.1.1", "L2-AEM-1", "Functional", "The system shall drive the motor.", "", "", "", ""],
  ["L2", "1.1.2", "L2-AEM-2", "Interface", "The system shall expose TargetPos.", "", "", "", ""],
  ["L1", "1.2", "L1-BODY-00193", "Fold Mirror", "When locked, fold within 3 s.", "DCM_FL", "QM", "", ""],
];
const recs = aoaToReqRecords(aoa);
const byId = Object.fromEntries(recs.map((r) => [r.id, r]));
ok(recs.length === 4, "parses 4 rows");
ok(byId["L1-BODY-00187"] && /move the mirror/.test(byId["L1-BODY-00187"].text), "recovers L1 id + statement");
ok(byId["L1-BODY-00187"].Safety === "ASIL A", "maps Safety/ASIL column");
ok(byId["L2-AEM-1"].parentId === "L1-BODY-00187", "L2 parented to preceding L1");
ok(byId["L2-AEM-2"].parentId === "L1-BODY-00187", "second L2 parented to same L1");

// CSV with quoted commas
const csv = 'Level,No.,ID,Title / Aspect,Statement,ECU,Safety,Regulations,System\n"L1","1.1","L1-X-1","T","The system shall, with commas, work.","","QM","",""\n';
const rows = csvToAoa(csv);
ok(rows.length === 2, "CSV parses to 2 rows");
const cr = aoaToReqRecords(rows);
ok(cr.length === 1 && cr[0].id === "L1-X-1", "CSV record id");
ok(/with commas/.test(cr[0].text), "CSV preserves quoted commas");

// Foreign header order (a spreadsheet not produced by us)
const aoa2 = [["ID", "Requirement", "ASIL"], ["REQ-9", "The unit shall boot in 200 ms.", "QM"]];
const r2 = aoaToReqRecords(aoa2);
ok(r2.length === 1 && r2[0].id === "REQ-9" && /boot in 200/.test(r2[0].text), "maps reordered/renamed headers");

console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
