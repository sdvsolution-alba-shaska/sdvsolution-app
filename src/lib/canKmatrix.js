// Released CAN / CAN FD K-Matrix workbooks (e.g. CenterDoorCANFD.xlsx) -> the app's CAN K-Matrix store (KM_STORE).
// Layout: group-heading row ("Messages · Signals · Value Range · Sender - Receiver"), a header row (Message,
// Identifier [hex], …, Signal, Start Byte, Start Bit, Signal Length [Bits], MUX Signal, MUX Group, …, one column per
// node), and a sub-header row naming the Value Range columns (Min/Max Raw, Unit, Offset, Scaling, Raw Value [dec],
// Description). Every signal row repeats its message's columns. Nodes hold S (sends) / R (receives) per signal row.
// Store shapes: msg { name, id, ext, fd, dlc, cyc, sendType, sender, recv[], dir, sig: [[name, startBit, lenBits, cm, mux?]], src }
//               lin [[cmName, factor, offset, unit]], txt [[cmName, { raw: label }]].
// Start Byte is 1-based; start bit = (StartByte-1)*8 + StartBit (LSB, Intel) — the convention the store already uses.

const s = (v) => (v == null ? "" : String(v).trim());
const norm = (v) => s(v).toLowerCase().replace(/\s+/g, " ");

// Released node names -> the SDVsolution names the store uses (KM_SHORT_TO_ECU maps these to Topology ECUs).
export const CAN_NODE_MAP = { CZC_1: "CZM", CZC_2: "CZM", CZC_Switch: "CZM", BZC: "CZM", TSG_FS: "DCM_FL", TSG_BFS: "DCM_FR", TSG_HFS: "DCM_RL", TSG_HBFS: "DCM_RR", TSG_H: "RRDCU", TestTool: "Tester",
  // Door drive units (Tuer_Antrieb, power door drives) and their door sensors (Tuer_Sensor) — Secondary ECUs, supplier Kostal.
  // VL/VR/HL/HR = front-left / front-right / rear-left / rear-right. Each drive also sits on the Center Door CAN.
  Tuer_Antrieb_VL: "DDU_FL", Tuer_Antrieb_VR: "DDU_FR", Tuer_Antrieb_HL: "DDU_RL", Tuer_Antrieb_HR: "DDU_RR",
  // IVI CAN FD (released XMM_IVI_CANFD): XMM is the CCU in the SDVsolution model; CI_Disp is the Center Display Module.
  XMM3_SAIL: "CCU", XMM: "CCU", CI_Disp: "CDM", BKE: "FCP", PI_Disp: "PDM", CeCoUnit: "CCP", KPH: "RCP", LSR: "LSR", HUD: "HUD",
  // Rear tire / road CAN FD (released RearTireRoadCANFD): RDK = tire pressure monitoring, ELPS_OBD = electric park lock.
  RDK: "TPMS", ELPS_OBD: "EPL",
  Tuer_Sensor_VL: "DSU_FL", Tuer_Sensor_VR: "DSU_FR", Tuer_Sensor_HL: "DSU_RL", Tuer_Sensor_HR: "DSU_RR" };

// The bus a released sheet describes. Several buses reuse the same frame names and IDs (the four door sub-CANs are
// identical apart from their nodes), so every imported frame carries its bus and merges only within it.
const DOOR_POS = { VL: "FL", VR: "FR", HL: "RL", HR: "RR" };
export function releasedBusName(sheet, nodes = []) {
  const sn = s(sheet), drive = nodes.map((n) => /^Tuer_Sensor_(VL|VR|HL|HR)$/.exec(n)).find(Boolean);
  if (drive || /SUBCAN/i.test(sn)) { const pos = drive ? DOOR_POS[drive[1]] : null; if (pos) return "DDU_" + pos + "_SUBCAN01"; }
  const ta = /Tueraktor([1-4])/i.exec(sn); if (ta) return "DDU_" + ["FL", "FR", "RL", "RR"][ta[1] - 1] + "_SUBCAN01"; // file order 1-4 = VL, VR, HL, HR
  if (/center_?door/i.test(sn)) return "Center_DOOR_CAN01";
  if (/rear_?tail_?gate/i.test(sn)) return "Rear_TAILGATE_CAN01";
  if (/rear_?tire_?road/i.test(sn)) return "Rear_TIREROAD_CAN01";
  if (/(XMM|CCU)_?IVI/i.test(sn)) return "CCU_IVI_CAN01";
  return sn.replace(/[^A-Za-z0-9_]/g, "_") || "CAN";
}

export function isReleasedCanLayout(aoa) {
  const rows = (aoa || []).slice(0, 4).map((r) => (r || []).map(norm));
  return rows.some((r) => r.includes("signal") && r.some((c) => /identifier/.test(c))) && rows.some((r) => r.includes("scaling") || r.includes("raw value [dec]")) && rows.some((r) => r.some((c) => /sender\s*-\s*receiver/.test(c)) || false);
}

// XMM is called CCU everywhere in SDVsolution: "XMM3_SAIL_Heartbeat" -> "CCU_Heartbeat", "..._XMM_IVI_CANFD" -> "..._CCU_IVI_CANFD".
export const xmmToCcu = (t) => String(t).replace(/XMM3_SAIL/g, "CCU").replace(/XMMDROID/g, "CCU").replace(/XMM/g, "CCU");
export function parseReleasedCanKm(aoa, opts = {}) {
  const map = { ...CAN_NODE_MAP, ...(opts.nodeMap || {}) }, rename = (n) => map[n] || n, scrub0 = opts.scrub || ((x) => x), scrub = (x) => xmmToCcu(scrub0(x));
  const warnings = [];
  let h = -1; for (let i = 0; i < Math.min(6, aoa.length); i++) { const r = (aoa[i] || []).map(norm); if (r.includes("signal") && r.some((c) => /identifier/.test(c))) { h = i; break; } }
  if (h < 0) return { msgs: [], lin: [], txt: [], nodes: [], warnings: ["No header row with Message / Identifier / Signal found."] };
  const top = aoa[h] || [], sub = aoa[h + 1] || [], width = Math.max(top.length, sub.length);
  const H = []; for (let i = 0; i < width; i++) H.push(norm(sub[i]) || norm(top[i]));
  const col = (...names) => { for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; } for (const n of names) { const i = H.findIndex((x) => x.startsWith(n)); if (i >= 0) return i; } return -1; };
  const C = { msg: col("message"), idHex: col("identifier [hex]", "identifier"), proto: col("protocol"), dlc: col("message length [byte]", "message length"), cyc: col("cycle time normal [ms]", "cycle time normal", "cycle time"),
    sendType: col("genmsgsendtype", "send type"), mtype: col("message type"), sig: col("signal"), sByte: col("start byte"), sBit: col("start bit"), len: col("signal length [bits]", "signal length"),
    muxSig: col("mux signal"), muxGrp: col("mux group"), init: col("init value raw [dec]", "init value"), sign: col("sign"), min: col("min raw value [dec]"), max: col("max row value [dec]", "max raw value [dec]"),
    unit: col("unit"), offset: col("offset"), factor: col("scaling", "factor"), raw: col("raw value [dec]"), desc: col("description") };
  // Node columns: header text after the last known column, with S/R codes in the data.
  const last = Math.max(...Object.values(C)); const nodeCols = [];
  for (let i = last + 1; i < width; i++) { const n = s(top[i]); if (n) nodeCols.push([n, i]); }
  if (!nodeCols.length) warnings.push("No Sender - Receiver node columns found.");
  const linMap = new Map(), txtMap = new Map(), lin = [], txt = []; let li = 0, ti = 0; const pre = opts.cmPrefix || "CM_rel";
  const linCM = (f, o, u) => { const k = f + "|" + o + "|" + u; if (!linMap.has(k)) { const n = pre + "_lin" + (++li); linMap.set(k, n); lin.push([n, f, o, u]); } return linMap.get(k); };
  const txtCM = (m) => { const k = JSON.stringify(m); if (!txtMap.has(k)) { const n = pre + "_enum" + (++ti); txtMap.set(k, n); txt.push([n, m]); } return txtMap.get(k); };
  const msgs = [], byName = new Map(), G = (r, c) => (c >= 0 ? r[c] : "");
  for (let i = h + 2; i < aoa.length; i++) {
    const r = aoa[i] || [], name = scrub(s(G(r, C.msg))); if (!name) continue;
    let m = byName.get(name);
    if (!m) {
      const id = parseInt(s(G(r, C.idHex)).replace(/^0x/i, ""), 16);
      if (!Number.isFinite(id)) { warnings.push("Message " + name + ": no identifier — skipped."); byName.set(name, { skip: true }); continue; }
      const cyc = Number(G(r, C.cyc));
      m = { name, id, ext: id > 0x7FF, fd: /fd/i.test(s(G(r, C.proto))), dlc: Number(G(r, C.dlc)) || 8, cyc: s(G(r, C.cyc)) === "" || !Number.isFinite(cyc) ? null : cyc, sendType: s(G(r, C.sendType)), sender: "", recv: [], sig: [], src: xmmToCcu(opts.source || "released K-Matrix") };
      msgs.push(m); byName.set(name, m);
    }
    if (m.skip) continue;
    // sender / receivers (union over the message's signal rows)
    nodeCols.forEach(([n, ci]) => { const v = s(r[ci]).toUpperCase(); if (v === "S" || v === "S*") { if (!m.sender) m.sender = rename(n); else if (m.sender !== rename(n)) m.extraSenders = [...new Set([...(m.extraSenders || []), rename(n)])]; } else if (v === "R" || v === "R*") { if (!m.recv.includes(rename(n))) m.recv.push(rename(n)); } });
    const sn = scrub(s(G(r, C.sig))); if (!sn || /^void$/i.test(sn) || m.sig.some((x) => x[0] === sn)) continue; // "void" rows are reserved gaps, not signals
    const sb = Number(G(r, C.sByte)), bit = Number(G(r, C.sBit)) || 0, len = Number(G(r, C.len)) || 0;
    if (!Number.isFinite(sb) || !len) { warnings.push(name + " / " + sn + ": no start byte or length — skipped."); continue; }
    const start = (sb - 1) * 8 + bit;
    // value table: parallel "Raw Value [dec]" and "Description" lists, or "0 = text" lines
    let cm = null; const rawV = s(G(r, C.raw)), desc = s(G(r, C.desc));
    if (rawV !== "" && desc !== "") { const ks = rawV.split(/\r?\n/).map((x) => x.trim()), vs = desc.split(/\r?\n/).map((x) => x.trim()); const vt = {}; ks.forEach((k, j) => { if (/^-?\d+$/.test(k) && vs[j] != null) vt[k] = opts.scrubTable ? xmmToCcu(vs[j]) : scrub(vs[j]); }); if (Object.keys(vt).length) cm = txtCM(opts.scrubTable ? opts.scrubTable(vt) : vt); }
    if (!cm) { const f = s(G(r, C.factor)), o = s(G(r, C.offset)), u = s(G(r, C.unit)); if (f !== "" && Number.isFinite(Number(f)) && (Number(f) !== 1 || (o !== "" && Number(o) !== 0) || u)) cm = linCM(Number(f), Number(o) || 0, u); }
    const ms = s(G(r, C.muxSig)), mg = s(G(r, C.muxGrp));
    const sig = [sn, start, len, cm]; if (ms !== "" && ms !== "0") sig[4] = "M"; else if (mg !== "" && Number.isFinite(Number(mg))) sig[4] = Number(mg);
    m.sig.push(sig);
  }
  msgs.forEach((m) => { m.dir = m.sender === "DCM_FL" ? "Tx" : "Rx"; if (m.extraSenders) warnings.push(m.name + ": more than one sender (" + [m.sender, ...m.extraSenders].join(", ") + ") — kept " + m.sender + "."); });
  const nodes = nodeCols.map(([n]) => n), bus = opts.bus || releasedBusName(opts.sheet || "", nodes);
  msgs.forEach((m) => { m.bus = bus; });
  return { msgs, lin, txt, nodes, bus, renamed: nodes.filter((n) => map[n]).map((n) => n + "→" + map[n]), warnings };
}

// Merge a parsed release into the store. The release is authoritative for the messages it contains (layout, timing,
// sender/receivers); messages only the store has (SDVsolution-defined) are kept and listed. CM names are made unique
// against the store, and identical CMs are reused.
export function mergeReleasedCan(K, rel, opts = {}) {
  const out = JSON.parse(JSON.stringify(K || { msgs: [], lin: [], txt: [] })); out.msgs = out.msgs || []; out.lin = out.lin || []; out.txt = out.txt || [];
  const cmRename = new Map(), taken = new Set([...out.lin.map((x) => x[0]), ...out.txt.map((x) => x[0])]);
  const uniq = (n) => { let k = n, i = 2; while (taken.has(k)) k = n + "_" + i++; taken.add(k); return k; };
  rel.lin.forEach(([n, f, o, u]) => { const ex = out.lin.find((x) => x[1] === f && x[2] === o && x[3] === u); if (ex) cmRename.set(n, ex[0]); else { const nn = uniq(n); cmRename.set(n, nn); out.lin.push([nn, f, o, u]); } });
  rel.txt.forEach(([n, m]) => { const k = JSON.stringify(m), ex = out.txt.find((x) => JSON.stringify(x[1]) === k); if (ex) cmRename.set(n, ex[0]); else { const nn = uniq(n); cmRename.set(n, nn); out.txt.push([nn, m]); } });
  // Frames imported before frames carried a bus: recover it from the sheet named in their source ("file (sheet)").
  // opts.legacyBus: { frameName: bus } for SDVsolution seed frames known to belong to a bus (no source recorded).
  out.msgs.forEach((m) => { if (!m.bus && !m.src && opts.legacyBus && opts.legacyBus[m.name]) m.bus = opts.legacyBus[m.name]; });
  out.msgs.forEach((m) => { if (!m.bus && m.src) { const sh = /\(([^()]+)\)\s*$/.exec(m.src); if (sh) m.bus = releasedBusName(sh[1]); } });
  const bus = rel.bus || (rel.msgs[0] && rel.msgs[0].bus) || "", sameFrame = (m, x) => (m.id === x.id && !!m.ext === !!x.ext) || String(m.name).toLowerCase() === String(x.name).toLowerCase();
  const report = { bus, added: 0, updated: 0, signals: 0, keptOnlyInStore: [] }, seen = new Set();
  for (const nm of rel.msgs) {
    const msg = { ...nm, sig: nm.sig.map((g) => { const c = [...g]; if (c[3]) c[3] = cmRename.get(c[3]) || c[3]; return c; }) }; report.signals += msg.sig.length;
    // same bus: match by ID or name; a frame with no bus (SDVsolution-defined) is adopted only on an exact ID + name match
    const ex = out.msgs.find((m) => !seen.has(m) && (m.bus || "") === bus && sameFrame(m, msg))
      || out.msgs.find((m) => !seen.has(m) && !m.bus && m.id === msg.id && !!m.ext === !!msg.ext && String(m.name).toLowerCase() === String(msg.name).toLowerCase());
    if (ex) { const keep = { l1: ex.l1, note: ex.note }; Object.assign(ex, msg, { l1: keep.l1 || msg.l1 || "", note: keep.note || "" }); seen.add(ex); report.updated++; }
    else { out.msgs.push({ ...msg, l1: "", note: "" }); seen.add(out.msgs[out.msgs.length - 1]); report.added++; }
  }
  report.keptOnlyInStore = out.msgs.filter((m) => !seen.has(m) && (m.bus || "") === bus).map((m) => m.name);
  report.otherBuses = [...new Set(out.msgs.filter((m) => !seen.has(m) && m.bus && m.bus !== bus).map((m) => m.bus))];
  report.noBus = out.msgs.filter((m) => !m.bus).length;
  return { K: out, report };
}

/* ---------- CAN / CAN FD cluster ARXML (AUTOSAR R4 System Description) from the K-Matrix store ----------
   CAN cluster + physical channel, CAN frames (ID, standard/extended, CAN FD or 2.0 frame behaviour, length) with one
   I-SIGNAL-I-PDU each, I-SIGNAL-TO-I-PDU-MAPPINGs (LSB start position, little endian), frame / PDU / I-signal
   triggerings, frame ports per ECU (OUT for the sender, IN for receivers), I-SIGNALs, SYSTEM-SIGNALs, COMPU-METHODs
   (linear / text table) and units. Multiplexed signals are mapped as plain signals (overlapping) and the PDU says so;
   MULTIPLEXED-I-PDUs are not generated yet. */
const xe = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ident = (v) => { let t = String(v || "x").replace(/[^A-Za-z0-9_]/g, "_"); if (!/^[A-Za-z]/.test(t)) t = "X_" + t; return t.slice(0, 120); };
const namer = () => { const used = new Set(); return (want, alt) => { let n = ident(want); if (used.has(n) && alt) n = ident(alt); const base = n; let k = 2; while (used.has(n)) n = base.slice(0, 114) + "_" + k++; used.add(n); return n; }; };
const hexs = (n) => "0x" + Number(n).toString(16).toUpperCase();

export function canBuses(K) { return [...new Set((K.msgs || []).map((m) => m.bus).filter(Boolean))].sort(); }
export function toCanClusterArxml(K, opts = {}) {
  const cluster = ident(opts.cluster || opts.bus || "CAN_Cluster"), R = "/SDV_" + cluster, msgs = (K.msgs || []).filter((m) => Number.isFinite(m.id) && (!opts.bus || m.bus === opts.bus)).sort((a, b) => a.id - b.id);
  const fd = opts.fd != null ? opts.fd : msgs.some((m) => m.fd || m.dlc > 8);
  const nodes = [...new Set(msgs.flatMap((m) => [m.sender, ...(m.recv || [])]).filter(Boolean))].sort();
  const nFr = namer(), nSig = namer(), nEcu = namer(), nCm = namer(), nUnit = namer();
  const frName = new Map(msgs.map((m) => [m, nFr(m.name, m.name + "_" + hexs(m.id))])), ecuName = new Map(nodes.map((n) => [n, nEcu(n)]));
  const linBy = Object.fromEntries((K.lin || []).map(([n, f, o, u]) => [n, { f, o, u }])), txtBy = Object.fromEntries((K.txt || []).map(([n, t]) => [n, t]));
  const usedCm = new Set(msgs.flatMap((m) => m.sig.map((g) => g[3]).filter(Boolean)));
  const cmName = new Map([...usedCm].filter((c) => linBy[c] || txtBy[c]).map((c) => [c, nCm(c)]));
  const units = new Map(); [...usedCm].forEach((c) => { const u = linBy[c] && linBy[c].u; if (u && !units.has(u)) units.set(u, nUnit(/^%$/.test(u) ? "percent" : u, "unit_" + u)); });
  const counts = {}; msgs.forEach((m) => m.sig.forEach((g) => { counts[g[0]] = (counts[g[0]] || 0) + 1; }));
  const rows = []; msgs.forEach((m) => m.sig.forEach((g) => { if (!(g[2] > 0)) return; rows.push({ m, g, name: nSig(counts[g[0]] > 1 ? frName.get(m) + "__" + g[0] : g[0], frName.get(m) + "__" + g[0]) }); }));
  const byMsg = new Map(); rows.forEach((r) => { if (!byMsg.has(r.m)) byMsg.set(r.m, []); byMsg.get(r.m).push(r); });
  const ch = R + "/Clusters/" + cluster + "/" + cluster + "_Channel";
  const o = [], w = (t) => o.push(t);
  w('<?xml version="1.0" encoding="UTF-8"?>');
  w('<AUTOSAR xmlns="http://autosar.org/schema/r4.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://autosar.org/schema/r4.0 AUTOSAR_00048.xsd">');
  w('<AR-PACKAGES><AR-PACKAGE><SHORT-NAME>SDV_' + cluster + '</SHORT-NAME><DESC><L-2 L="EN">' + xe(cluster) + ' system description generated by SDVsolution from the K-Matrix (' + msgs.length + ' frames, ' + rows.length + ' signals, ' + nodes.length + ' ECU instances).' + (opts.baudrate ? '' : ' Bit rates are not stated in the source K-Matrix, so BAUDRATE / CAN-FD-BAUDRATE are left out.') + ' Regenerate instead of editing.</L-2></DESC><AR-PACKAGES>');
  if (units.size) { w('<AR-PACKAGE><SHORT-NAME>Units</SHORT-NAME><ELEMENTS>'); for (const [u, n] of units) w('<UNIT><SHORT-NAME>' + n + '</SHORT-NAME><DISPLAY-NAME>' + xe(u) + '</DISPLAY-NAME></UNIT>'); w('</ELEMENTS></AR-PACKAGE>'); }
  if (cmName.size) {
    w('<AR-PACKAGE><SHORT-NAME>CompuMethods</SHORT-NAME><ELEMENTS>');
    for (const [c, n] of cmName) {
      if (txtBy[c]) { w('<COMPU-METHOD><SHORT-NAME>' + n + '</SHORT-NAME><CATEGORY>TEXTTABLE</CATEGORY><COMPU-INTERNAL-TO-PHYS><COMPU-SCALES>'); Object.entries(txtBy[c]).filter(([k]) => /^-?\d+$/.test(k)).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([k, t]) => w('<COMPU-SCALE><LOWER-LIMIT INTERVAL-TYPE="CLOSED">' + k + '</LOWER-LIMIT><UPPER-LIMIT INTERVAL-TYPE="CLOSED">' + k + '</UPPER-LIMIT><COMPU-CONST><VT>' + xe(t) + '</VT></COMPU-CONST></COMPU-SCALE>')); w('</COMPU-SCALES></COMPU-INTERNAL-TO-PHYS></COMPU-METHOD>'); }
      else { const l = linBy[c]; w('<COMPU-METHOD><SHORT-NAME>' + n + '</SHORT-NAME><CATEGORY>LINEAR</CATEGORY>' + (l.u && units.has(l.u) ? '<UNIT-REF DEST="UNIT">' + R + '/Units/' + units.get(l.u) + '</UNIT-REF>' : '') + '<COMPU-INTERNAL-TO-PHYS><COMPU-SCALES><COMPU-SCALE><COMPU-RATIONAL-COEFFS><COMPU-NUMERATOR><V>' + (Number(l.o) || 0) + '</V><V>' + Number(l.f) + '</V></COMPU-NUMERATOR><COMPU-DENOMINATOR><V>1</V></COMPU-DENOMINATOR></COMPU-RATIONAL-COEFFS></COMPU-SCALE></COMPU-SCALES></COMPU-INTERNAL-TO-PHYS></COMPU-METHOD>'); }
    }
    w('</ELEMENTS></AR-PACKAGE>');
  }
  w('<AR-PACKAGE><SHORT-NAME>SystemSignals</SHORT-NAME><ELEMENTS>');
  rows.forEach((r) => w('<SYSTEM-SIGNAL><SHORT-NAME>' + r.name + '</SHORT-NAME><DYNAMIC-LENGTH>false</DYNAMIC-LENGTH>' + (r.g[3] && cmName.has(r.g[3]) ? '<PHYSICAL-PROPS><SW-DATA-DEF-PROPS-VARIANTS><SW-DATA-DEF-PROPS-CONDITIONAL><COMPU-METHOD-REF DEST="COMPU-METHOD">' + R + '/CompuMethods/' + cmName.get(r.g[3]) + '</COMPU-METHOD-REF></SW-DATA-DEF-PROPS-CONDITIONAL></SW-DATA-DEF-PROPS-VARIANTS></PHYSICAL-PROPS>' : '') + '</SYSTEM-SIGNAL>'));
  w('</ELEMENTS></AR-PACKAGE><AR-PACKAGE><SHORT-NAME>ISignals</SHORT-NAME><ELEMENTS>');
  rows.forEach((r) => w('<I-SIGNAL><SHORT-NAME>' + r.name + '</SHORT-NAME><DATA-TYPE-POLICY>LEGACY</DATA-TYPE-POLICY><LENGTH>' + r.g[2] + '</LENGTH><SYSTEM-SIGNAL-REF DEST="SYSTEM-SIGNAL">' + R + '/SystemSignals/' + r.name + '</SYSTEM-SIGNAL-REF></I-SIGNAL>'));
  w('</ELEMENTS></AR-PACKAGE><AR-PACKAGE><SHORT-NAME>Pdus</SHORT-NAME><ELEMENTS>');
  for (const m of msgs) {
    const rs = byMsg.get(m) || [], mux = m.sig.some((g) => g[4] !== undefined && g[4] !== "M");
    w('<I-SIGNAL-I-PDU><SHORT-NAME>' + frName.get(m) + '</SHORT-NAME>' + (mux ? '<DESC><L-2 L="EN">Multiplexed: signals of different multiplexer groups share bit positions; multiplexor ' + xe((m.sig.find((g) => g[4] === "M") || [""])[0]) + '.</L-2></DESC>' : '') + '<LENGTH>' + (m.dlc || 8) + '</LENGTH>');
    if (m.cyc > 0) w('<I-PDU-TIMING-SPECIFICATIONS><I-PDU-TIMING><TRANSMISSION-MODE-DECLARATION><TRANSMISSION-MODE-TRUE-TIMING><CYCLIC-TIMING><TIME-PERIOD><VALUE>' + m.cyc / 1000 + '</VALUE></TIME-PERIOD></CYCLIC-TIMING></TRANSMISSION-MODE-TRUE-TIMING></TRANSMISSION-MODE-DECLARATION></I-PDU-TIMING></I-PDU-TIMING-SPECIFICATIONS>');
    if (rs.length) { w('<I-SIGNAL-TO-PDU-MAPPINGS>'); rs.forEach((r) => w('<I-SIGNAL-TO-I-PDU-MAPPING><SHORT-NAME>' + r.name + '</SHORT-NAME><I-SIGNAL-REF DEST="I-SIGNAL">' + R + '/ISignals/' + r.name + '</I-SIGNAL-REF><PACKING-BYTE-ORDER>MOST-SIGNIFICANT-BYTE-LAST</PACKING-BYTE-ORDER><START-POSITION>' + r.g[1] + '</START-POSITION></I-SIGNAL-TO-I-PDU-MAPPING>')); w('</I-SIGNAL-TO-PDU-MAPPINGS>'); }
    w('<UNUSED-BIT-PATTERN>0</UNUSED-BIT-PATTERN></I-SIGNAL-I-PDU>');
  }
  w('</ELEMENTS></AR-PACKAGE><AR-PACKAGE><SHORT-NAME>Frames</SHORT-NAME><ELEMENTS>');
  for (const m of msgs) w('<CAN-FRAME><SHORT-NAME>' + frName.get(m) + '</SHORT-NAME><FRAME-LENGTH>' + (m.dlc || 8) + '</FRAME-LENGTH><PDU-TO-FRAME-MAPPINGS><PDU-TO-FRAME-MAPPING><SHORT-NAME>' + frName.get(m) + '</SHORT-NAME><PACKING-BYTE-ORDER>MOST-SIGNIFICANT-BYTE-LAST</PACKING-BYTE-ORDER><PDU-REF DEST="I-SIGNAL-I-PDU">' + R + '/Pdus/' + frName.get(m) + '</PDU-REF><START-POSITION>0</START-POSITION></PDU-TO-FRAME-MAPPING></PDU-TO-FRAME-MAPPINGS></CAN-FRAME>');
  w('</ELEMENTS></AR-PACKAGE>');
  const port = (node, m, dir) => R + '/EcuInstances/' + ecuName.get(node) + '/' + ecuName.get(node) + '_Connector/' + (dir === "OUT" ? "Tx_" : "Rx_") + frName.get(m);
  w('<AR-PACKAGE><SHORT-NAME>EcuInstances</SHORT-NAME><ELEMENTS>');
  for (const n of nodes) {
    const en = ecuName.get(n), tx = msgs.filter((m) => m.sender === n), rx = msgs.filter((m) => (m.recv || []).includes(n));
    w('<ECU-INSTANCE><SHORT-NAME>' + en + '</SHORT-NAME><COMM-CONTROLLERS><CAN-COMMUNICATION-CONTROLLER><SHORT-NAME>' + en + '_CanCtrl</SHORT-NAME></CAN-COMMUNICATION-CONTROLLER></COMM-CONTROLLERS>');
    w('<CONNECTORS><CAN-COMMUNICATION-CONNECTOR><SHORT-NAME>' + en + '_Connector</SHORT-NAME><COMM-CONTROLLER-REF DEST="CAN-COMMUNICATION-CONTROLLER">' + R + '/EcuInstances/' + en + '/' + en + '_CanCtrl</COMM-CONTROLLER-REF>');
    if (tx.length || rx.length) { w('<ECU-COMM-PORT-INSTANCES>'); tx.forEach((m) => w('<FRAME-PORT><SHORT-NAME>Tx_' + frName.get(m) + '</SHORT-NAME><COMMUNICATION-DIRECTION>OUT</COMMUNICATION-DIRECTION></FRAME-PORT>')); rx.forEach((m) => w('<FRAME-PORT><SHORT-NAME>Rx_' + frName.get(m) + '</SHORT-NAME><COMMUNICATION-DIRECTION>IN</COMMUNICATION-DIRECTION></FRAME-PORT>')); w('</ECU-COMM-PORT-INSTANCES>'); }
    w('</CAN-COMMUNICATION-CONNECTOR></CONNECTORS></ECU-INSTANCE>');
  }
  w('</ELEMENTS></AR-PACKAGE>');
  w('<AR-PACKAGE><SHORT-NAME>Clusters</SHORT-NAME><ELEMENTS><CAN-CLUSTER><SHORT-NAME>' + cluster + '</SHORT-NAME><CAN-CLUSTER-VARIANTS><CAN-CLUSTER-CONDITIONAL>' + (opts.baudrate ? '<BAUDRATE>' + opts.baudrate + '</BAUDRATE>' : '') + '<PHYSICAL-CHANNELS><CAN-PHYSICAL-CHANNEL><SHORT-NAME>' + cluster + '_Channel</SHORT-NAME>');
  w('<COMM-CONNECTORS>' + nodes.map((n) => '<COMMUNICATION-CONNECTOR-REF-CONDITIONAL><COMMUNICATION-CONNECTOR-REF DEST="CAN-COMMUNICATION-CONNECTOR">' + R + '/EcuInstances/' + ecuName.get(n) + '/' + ecuName.get(n) + '_Connector</COMMUNICATION-CONNECTOR-REF></COMMUNICATION-CONNECTOR-REF-CONDITIONAL>').join("") + '</COMM-CONNECTORS>');
  w('<FRAME-TRIGGERINGS>');
  for (const m of msgs) {
    const ports = [...(m.sender && ecuName.has(m.sender) ? [port(m.sender, m, "OUT")] : []), ...(m.recv || []).filter((r) => ecuName.has(r)).map((r) => port(r, m, "IN"))], beh = (m.fd || (fd && m.dlc > 8)) ? "CAN-FD" : "CAN-20";
    w('<CAN-FRAME-TRIGGERING><SHORT-NAME>FT_' + frName.get(m) + '</SHORT-NAME>' + (ports.length ? '<FRAME-PORT-REFS>' + ports.map((x) => '<FRAME-PORT-REF DEST="FRAME-PORT">' + x + '</FRAME-PORT-REF>').join("") + '</FRAME-PORT-REFS>' : '') + '<FRAME-REF DEST="CAN-FRAME">' + R + '/Frames/' + frName.get(m) + '</FRAME-REF><PDU-TRIGGERINGS><PDU-TRIGGERING-REF-CONDITIONAL><PDU-TRIGGERING-REF DEST="PDU-TRIGGERING">' + ch + '/PT_' + frName.get(m) + '</PDU-TRIGGERING-REF></PDU-TRIGGERING-REF-CONDITIONAL></PDU-TRIGGERINGS><CAN-ADDRESSING-MODE>' + (m.ext ? "EXTENDED" : "STANDARD") + '</CAN-ADDRESSING-MODE><CAN-FRAME-RX-BEHAVIOR>' + beh + '</CAN-FRAME-RX-BEHAVIOR><CAN-FRAME-TX-BEHAVIOR>' + beh + '</CAN-FRAME-TX-BEHAVIOR><IDENTIFIER>' + m.id + '</IDENTIFIER></CAN-FRAME-TRIGGERING>');
  }
  w('</FRAME-TRIGGERINGS>');
  if (rows.length) { w('<I-SIGNAL-TRIGGERINGS>'); rows.forEach((r) => w('<I-SIGNAL-TRIGGERING><SHORT-NAME>ST_' + r.name + '</SHORT-NAME><I-SIGNAL-REF DEST="I-SIGNAL">' + R + '/ISignals/' + r.name + '</I-SIGNAL-REF></I-SIGNAL-TRIGGERING>')); w('</I-SIGNAL-TRIGGERINGS>'); }
  w('<PDU-TRIGGERINGS>');
  for (const m of msgs) w('<PDU-TRIGGERING><SHORT-NAME>PT_' + frName.get(m) + '</SHORT-NAME><I-PDU-REF DEST="I-SIGNAL-I-PDU">' + R + '/Pdus/' + frName.get(m) + '</I-PDU-REF>' + ((byMsg.get(m) || []).length ? '<I-SIGNAL-TRIGGERINGS>' + byMsg.get(m).map((r) => '<I-SIGNAL-TRIGGERING-REF-CONDITIONAL><I-SIGNAL-TRIGGERING-REF DEST="I-SIGNAL-TRIGGERING">' + ch + '/ST_' + r.name + '</I-SIGNAL-TRIGGERING-REF></I-SIGNAL-TRIGGERING-REF-CONDITIONAL>').join("") + '</I-SIGNAL-TRIGGERINGS>' : '') + '</PDU-TRIGGERING>');
  w('</PDU-TRIGGERINGS></CAN-PHYSICAL-CHANNEL></PHYSICAL-CHANNELS>' + (fd && opts.fdBaudrate ? '<CAN-FD-BAUDRATE>' + opts.fdBaudrate + '</CAN-FD-BAUDRATE>' : '') + '</CAN-CLUSTER-CONDITIONAL></CAN-CLUSTER-VARIANTS></CAN-CLUSTER></ELEMENTS></AR-PACKAGE>');
  w('</AR-PACKAGES></AR-PACKAGE></AR-PACKAGES></AUTOSAR>');
  return { xml: o.join("\n") + "\n", stats: { frames: msgs.length, signals: rows.length, ecuInstances: nodes.length, compuMethods: cmName.size } };
}
