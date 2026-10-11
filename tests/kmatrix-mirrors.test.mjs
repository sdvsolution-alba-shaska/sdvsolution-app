// Run: node tests/kmatrix-mirrors.test.mjs
// The mirror functions run on the CZM, so every input and output of their Behavior Models must travel on the bus. This test checks that each
// model signal is mapped to a K-matrix signal, that the mapped signal is wide enough for the model's range, that the sender/receiver direction
// is right, and that the frames are well formed (no overlapping bits, unique IDs, value tables defined).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { PILOT_MODELS } from "../src/lib/pilotModels.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "App.jsx"), "utf8");
const a = src.indexOf("const DCMFL_KM = {"), b = src.indexOf("\n};", a);
const KM = new Function("return " + src.slice(a + "const DCMFL_KM = ".length, b + 3))();
const sendTbl = src.slice(src.indexOf("const SEND = {"), src.indexOf("const L1MAP"));
const sender = (n) => (sendTbl.match(new RegExp(n + ': \\["(\\w+)", \\[([^\\]]*)\\]')) || []);
const msg = (n) => KM.msgs.find((m) => m.name === n), sig = (n) => { for (const m of KM.msgs) { const s = m.sig.find((x) => x[0] === n); if (s) return { m, s }; } return null; };
const lin = Object.fromEntries(KM.lin.map((x) => [x[0], x])), txt = Object.fromEntries(KM.txt.map((x) => [x[0], x[1]]));

// model signal -> [bus signal, sender, receiver]. "local" = produced/consumed inside the CZM, "platform" = a signal that is already on the platform bus.
const MAP = {
  "L2-BODY-00193-MODE": {
    fold_request: ["FT_SW_FoldHold", "DCM_FL", "CZM"], unfold_request: ["FT_SW_Unfold", "DCM_FL", "CZM"],
    vehicle_speed_kph: ["Vehicle_Speed", "CCU", "CZM"], fold_position_pct: ["FT_ASP_Fold_Position", "DCM_FL", "CZM"],
    position_valid: ["FT_ASP_Fold_PosValid", "DCM_FL", "CZM"], motor_current_mA: ["FT_ASP_Fold_MotorCurrent", "DCM_FL", "CZM"],
    motor_cmd: [["SP_FoldIn", "SP_FoldOut"], "CZM", "DCM_FL"], fold_status: "local", fold_fault: "local",
    door_can_timeout: "local" /* derived on the CZM by alive / E2E supervision of Fold_Status_01 / _02 (no bus signal) */ },
  "L2-BODY-00194-MODE": {
    ignition_on: ["Ignition_Mode", "CCU", "CZM"], heater_request: ["FT_SW_HeaterReq", "DCM_FL", "CZM"],
    ambient_temp_dC: ["Ambient_Temp", "CCU", "CZM"], mirror_temp_dC: ["FT_ASP_Mirror_Temp", "DCM_FL", "CZM"],
    heater_current_mA: ["FT_ASP_Heating_Current", "DCM_FL", "CZM"], load_status: ["SSA_FT_ASP_Heating_Fault", "DCM_FL", "CZM"],
    heater_pwm_pct: ["SP_Heating_Duty", "CZM", "DCM_FL"], heater_fault: "local",
    door_can_timeout: "local" /* derived on the CZM by alive / E2E supervision of Heat_Status_01 / _02 (no bus signal) */ },
};
const bitsOf = (s) => s[2];
const rawMax = (s) => 2 ** bitsOf(s) - 1;
for (const [key, map] of Object.entries(MAP)) {
  const bm = PILOT_MODELS[key], tag = "[" + bm.target.swc + "] ";
  const names = bm.signals.map((s) => s.name);
  ok(names.every((n) => n in map) && Object.keys(map).every((n) => names.includes(n)), tag + "every model signal has a bus mapping (" + names.length + ")");
  for (const s of bm.signals) {
    const mp = map[s.name]; if (mp === "local") continue;
    const [bus, snd, rcv] = mp; const list = Array.isArray(bus) ? bus : [bus];
    const found = list.map(sig); ok(found.every(Boolean), tag + s.name + " -> " + list.join(" + ") + " exists on the bus");
    if (!found.every(Boolean)) continue;
    const info = sender(found[0].m.name); const okDir = info[1] === snd && new RegExp('"' + rcv + '"').test(info[2] || "");
    ok(okDir, tag + s.name + ": " + found[0].m.name + " goes " + snd + " -> " + rcv + (okDir ? "" : " (table says " + info[1] + " -> " + info[2] + ")"));
    if (list.length === 1 && s.baseType !== "boolean" && s.dir === "in" || (list.length === 1 && s.dir === "out" && s.baseType !== "boolean")) {
      const bs = found[0].s, L = lin[bs[3]] || [bs[3], 1, 0], scale = L[1], off = L[2], lo = off, hi = rawMax(bs) * scale + off;
      const mn = Number(s.min), mx = Number(s.max), f = /dC$/.test(s.name) ? 0.1 : 1; // dC = tenths of a degree
      ok(mn * f >= lo - 1e-9 && mx * f <= hi + 1e-9, tag + s.name + " range " + mn * f + ".." + mx * f + " fits " + bs[0] + " (" + bitsOf(bs) + " bit, " + lo.toFixed(1) + ".." + hi.toFixed(1) + (L[3] ? " " + L[3] : "") + ")");
    }
  }
}
// well-formedness
const ids = KM.msgs.map((m) => m.id); ok(new Set(ids).size === ids.length, "frame IDs are unique (" + ids.length + " frames)");
const bad = []; for (const m of KM.msgs) { const used = new Set(); for (const s of m.sig) for (let i = s[1]; i < s[1] + s[2]; i++) { if (i >= m.dlc * 8 || used.has(i)) bad.push(m.name + "." + s[0]); used.add(i); } }
ok(!bad.length, "no frame has overlapping or out-of-frame bits" + (bad.length ? ": " + bad.join(", ") : ""));
const mirrorFrames = KM.msgs.filter((m) => /Fold|Heat|Ambient/.test(m.name));
const missingVt = []; for (const m of mirrorFrames) for (const s of m.sig) if (s[3] && !lin[s[3]] && !txt[s[3]]) missingVt.push(s[3]);
ok(!missingVt.length, "every value table / scaling used by the mirror frames is defined" + (missingVt.length ? ": " + [...new Set(missingVt)].join(", ") : ""));
ok(txt.CM_MirHeatFault && Object.keys(txt.CM_MirHeatFault).length === 4 && txt.CM_FoldFault && Object.keys(txt.CM_FoldFault).length === 4, "heating load-status and fold-fault tables have all 4 codes");
for (const n of ["Fold_Cmd_01", "Fold_Status_01", "Heat_Cmd_01", "Heat_Status_01"]) ok(msg(n).cyc <= 20, n + " cycle time " + msg(n).cyc + " ms (model task is 10 ms)");
console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
