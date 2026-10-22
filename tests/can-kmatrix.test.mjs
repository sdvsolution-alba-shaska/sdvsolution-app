import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { isReleasedCanLayout, parseReleasedCanKm, mergeReleasedCan, toCanClusterArxml } from "../src/lib/canKmatrix.js";

// Same three-row heading as the released workbooks: group row, header row, Value Range sub-header row.
const G0 = ["Messages", "", "", "", "", "Signals", "", "", "", "", "", "Value Range", "", "", "", "", "Sender - Receiver", ""];
const H1 = ["Message", "Identifier [hex]", "Protocol", "Message Length [Byte]", "Cycle Time normal [ms]", "Signal", "Start Byte", "Start Bit", "Signal Length [Bits]", "MUX Signal", "MUX Group", "", "", "", "", "", "CZC_1", "TSG_FS"];
const H2 = ["", "", "", "", "", "", "", "", "", "", "", "Unit", "Offset", "Scaling", "Raw Value [dec]", "Description", "", ""];
const row = (m, sig, sb, bit, len, ms, mg, u, o, f, raw, desc, czc, fs) => [m[0], m[1], m[2], m[3], m[4], sig, sb, bit, len, ms, mg, u, o, f, raw, desc, czc, fs];
const A = ["Door_Status_FL", "120", "CAN FD", 8, 100], B = ["Door_Cmd", "18DA0001", "CAN FD", 16, ""];
const aoa = [G0, H1, H2,
  row(A, "Door_Open", 1, 0, 1, 0, "", "", 0, 1, "0\n1", "closed\nopen", "R", "S"),
  row(A, "Window_Pos", 1, 1, 7, 0, "", "%", 0, 1, "", "", "R", "S"),
  row(A, "void", 2, 0, 8, 0, "", "", "", "", "", "", "", ""),
  row(B, "Cmd_Mux", 1, 0, 8, 1, "", "", 0, 1, "", "", "S", "R"),
  row(B, "Cmd_A", 2, 0, 8, 0, 1, "", 0, 1, "", "", "S", "R"),
  row(B, "Cmd_B", 2, 0, 8, 0, 2, "V", -10, 0.5, "", "", "S", "R")];

let n = 0; const t = (name, f) => { f(); n++; console.log("ok -", name); };
let rel;
t("detects the released layout", () => assert.equal(isReleasedCanLayout(aoa), true));
t("parses frames, signals, mux and value tables", () => {
  rel = parseReleasedCanKm(aoa, { source: "synthetic" });
  assert.equal(rel.msgs.length, 2);
  const a = rel.msgs.find((m) => m.name === "Door_Status_FL");
  assert.equal(a.id, 0x120); assert.equal(a.sender, "DCM_FL"); assert.deepEqual(a.recv, ["CZM"]);
  assert.equal(a.sig.length, 2, "void row skipped");
  assert.equal(a.sig[1][1], 1);
  const b = rel.msgs.find((m) => m.name === "Door_Cmd");
  assert.equal(b.ext, true); assert.equal(b.sig.find((g) => g[0] === "Cmd_Mux")[4], "M");
  assert.ok(rel.txt.length >= 1 && rel.lin.length >= 1);
});
t("merge keeps store-only messages and updates by id", () => {
  const K = { msgs: [{ name: "Old_Local", id: 0x7FF, dlc: 8, sig: [], recv: [] }, { name: "Door_Status_FL", id: 0x120, dlc: 8, sig: [], recv: [], l1: "L1-X" }], lin: [], txt: [] };
  const { K: M, report } = mergeReleasedCan(K, rel);
  assert.equal(report.added, 1); assert.equal(report.updated, 1); assert.deepEqual(report.keptOnlyInStore, ["Old_Local"]);
  assert.equal(M.msgs.find((m) => m.id === 0x120).l1, "L1-X");
});
t("CAN cluster ARXML is well formed and strict-valid when autosar_data is present", () => {
  const { K } = mergeReleasedCan({ msgs: [], lin: [], txt: [] }, rel);
  const { xml, stats } = toCanClusterArxml(K, { cluster: "Test_CANFD" });
  assert.equal(stats.frames, 2); assert.ok(xml.includes("<CAN-ADDRESSING-MODE>EXTENDED</CAN-ADDRESSING-MODE>"));
  assert.ok(xml.includes("CAN-COMMUNICATION-CONNECTOR") && xml.includes("xsi:schemaLocation"));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "canarx-")), "t.arxml"); fs.writeFileSync(f, xml);
  try { execFileSync("python3", ["-c", "import autosar_data"], { stdio: "ignore" }); } catch { console.log("  (autosar_data not installed, strict check skipped)"); return; }
  const out = execFileSync("python3", ["-c", "import sys,autosar_data as a;m=a.AutosarModel();m.load_file(sys.argv[1],strict=True);print(len(m.check_references()))", f]).toString().trim();
  assert.equal(out, "0");
});
console.log(`${n} passed`);
