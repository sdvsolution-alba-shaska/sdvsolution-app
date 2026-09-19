// ReqIF round-trip test — proves export → (edit in an external tool) → import
// recovers ForeignIDs, statements, and the L1→L2 parent hierarchy.
//
// The in-app ReqIF import uses the browser DOMParser, which Node lacks, so this
// test ships a tiny XML-DOM shim that implements just the API parseReqIFText
// uses, then runs the REAL functions extracted from ../src/App.jsx.
//
// Run:  node tests/reqif.roundtrip.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ---------- minimal XML → DOM shim (enough for parseReqIFText) ---------- */
const decode = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
class El {
  constructor(tag, attrs) { this.nodeName = tag; this.localName = tag.replace(/^.*:/, ""); this._attrs = attrs || {}; this.children = []; this._text = ""; }
  getAttribute(n) { return this._attrs[n] !== undefined ? this._attrs[n] : null; }
  get textContent() { let t = this._text || ""; for (const c of this.children) t += c.textContent; return t; }
  getElementsByTagName(name) { const out = []; const rec = (n) => { for (const c of n.children) { if (name === "*" || c.localName === name) out.push(c); rec(c); } }; rec(this); return out; }
}
function parseXML(xml) {
  xml = xml.replace(/<\?xml[^?]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const doc = new El("#document"); let cur = doc; const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) { cur._text += decode(m[5]); continue; }
    const closing = m[1] === "/", tag = m[2], attrStr = m[3] || "", self = m[4] === "/";
    if (closing) { cur = stack.pop() || doc; continue; }
    const attrs = {}; const ar = /([\w:.-]+)\s*=\s*"([^"]*)"/g; let am;
    while ((am = ar.exec(attrStr))) attrs[am[1]] = decode(am[2]);
    const el = new El(tag, attrs); cur.children.push(el);
    if (!self) { stack.push(cur); cur = el; }
  }
  doc.getElementsByTagName = El.prototype.getElementsByTagName.bind(doc);
  return doc;
}
globalThis.DOMParser = class { parseFromString(text) { return parseXML(text); } };

/* ---------- pull the real functions out of src/App.jsx ---------- */
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "src", "App.jsx"), "utf8");
const slice = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("marker not found: " + a); return src.slice(i, j); };
const code = slice("function xmlEscReqif(", "function buildDcmFlArxml() {");
const { reqAoaToReqIF, parseReqIFText } = (new Function(code + "\nreturn { reqAoaToReqIF, parseReqIFText };"))();

/* ---------- the test ---------- */
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓ " + msg); } else { fail++; console.log("  ✗ " + msg); } };

// 1) Export a small requirement tree (L1 with two L2 children, + a second L1)
const aoa = [
  ["Level", "No.", "ID", "Title / Aspect", "Statement", "ECU", "Safety", "Regulations", "System"],
  ["L1", "1.1", "L1-BODY-00187", "Adjusting Exterior Mirrors", "When the driver adjusts, the system shall move the mirror.", "DCM_FL", "ASIL A", "FMVSS 111", "Occupant Visibility"],
  ["L2", "1.1.1", "L2-AEM-1", "Functional", "The system shall drive the mirror motor to the target position.", "", "", "", ""],
  ["L2", "1.1.2", "L2-AEM-2", "Interface", "The system shall expose the TargetPos signal.", "", "", "", ""],
  ["L1", "1.2", "L1-BODY-00193", "Fold Down Exterior Mirrors", "When locked, fold within 3 s.", "DCM_FL", "QM", "", "Occupant Visibility"],
];
const xml = reqAoaToReqIF(aoa, "Platform X");
console.log("Export:");
ok(/<REQ-IF\b/.test(xml), "produces a REQ-IF document");
ok((xml.match(/<SPEC-OBJECT /g) || []).length === 4, "emits 4 SPEC-OBJECTs");

// 2) Parse it back
let recs = parseReqIFText(xml);
console.log("Parse (round-trip):");
ok(recs.length === 4, "recovers 4 requirements");
const byId = Object.fromEntries(recs.map((r) => [r.id, r]));
ok(byId["L1-BODY-00187"] && /move the mirror/.test(byId["L1-BODY-00187"].text), "recovers L1 ForeignID + statement");
ok(byId["L2-AEM-1"] && byId["L2-AEM-1"].parentId === "L1-BODY-00187", "L2 child's parentId resolves to its L1 (hierarchy intact)");
ok(byId["L2-AEM-2"] && byId["L2-AEM-2"].parentId === "L1-BODY-00187", "second L2 also parented to the L1");

// 3) Simulate editing the file in DOORS/Polarion/Codebeamer: change one statement, re-import
const edited = xml.replace("The system shall drive the mirror motor to the target position.", "The system shall drive the mirror motor to the commanded target position within 200 ms.");
recs = parseReqIFText(edited);
const e = Object.fromEntries(recs.map((r) => [r.id, r]));
console.log("Edit + re-import:");
ok(/within 200 ms/.test(e["L2-AEM-1"].text), "edited statement is carried under the SAME ForeignID (update path)");
ok(e["L1-BODY-00187"].text === byId["L1-BODY-00187"].text, "untouched requirements are unchanged");

// 4) A brand-new child added externally keeps its parent lineage
const withNew = edited.replace(
  '<CHILDREN><SPEC-HIERARCHY IDENTIFIER="SH-1"',
  '<CHILDREN><SPEC-HIERARCHY IDENTIFIER="SH-NEW"><OBJECT><SPEC-OBJECT-REF>SO-NEW</SPEC-OBJECT-REF></OBJECT></SPEC-HIERARCHY><SPEC-HIERARCHY IDENTIFIER="SH-1"'
).replace(
  "</SPEC-OBJECTS>",
  '<SPEC-OBJECT IDENTIFIER="SO-NEW"><VALUES>' +
  '<ATTRIBUTE-VALUE-STRING THE-VALUE="NEW-1"><DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>AD-ID</ATTRIBUTE-DEFINITION-STRING-REF></DEFINITION></ATTRIBUTE-VALUE-STRING>' +
  '<ATTRIBUTE-VALUE-STRING THE-VALUE="Added externally"><DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>AD-NAME</ATTRIBUTE-DEFINITION-STRING-REF></DEFINITION></ATTRIBUTE-VALUE-STRING>' +
  '<ATTRIBUTE-VALUE-STRING THE-VALUE="The system shall log the adjustment."><DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>AD-TEXT</ATTRIBUTE-DEFINITION-STRING-REF></DEFINITION></ATTRIBUTE-VALUE-STRING>' +
  "</VALUES><TYPE><SPEC-OBJECT-TYPE-REF>ST-REQ</SPEC-OBJECT-TYPE-REF></TYPE></SPEC-OBJECT></SPEC-OBJECTS>"
);
recs = parseReqIFText(withNew);
const n = recs.find((r) => r.id === "NEW-1");
console.log("New child placement:");
ok(!!n, "new requirement is parsed");
ok(n && n.parentId === "L1-BODY-00187", "new child's parentId points at its L1 (so import places it under that function)");

console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
