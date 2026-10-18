// Ethernet backbone K-Matrix (ETH): nodes, PDUs (messages), frames and signals.
// Pure functions shared by the app (registered as window.__sdvEthKm in main.jsx) and the tests.
// The workbook layout follows the released ETH K-Matrix: Legend · Nodes · Messages · BackboneETH.
// The matrix is built up over time: partial workbooks are MERGED (never overwrite what is there; differences are
// reported as conflicts), and signals are added as Behavior Models define what crosses the backbone.

export const ROLE_CODES = ["S", "S*", "0", "0*", "R", "R*"];
export const LEGEND = [
  ["S", "The signal is sent by this node (actively supported)."],
  ["S*", "The signal is routed by this node from another bus segment and is supported by at least one node in the vehicle."],
  ["0", "The signal cannot be actively operated in this vehicle and is sent with 0 or its initial value."],
  ["0*", "The signal is routed by this node from another bus segment but cannot be actively operated; it is sent with 0 or its initial value."],
  ["R", "The signal is received and evaluated by this node (it may also route it)."],
  ["R*", "The signal is routed by this node to another bus segment (no internal use)."],
];

export const emptyEth = () => ({ nodes: [], pdus: [] });

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
const str = (v) => (v == null ? "" : String(v).trim());
const numOrNull = (v) => { const t = str(v); if (t === "") return null; const n = Number(t); return isFinite(n) ? n : null; };
export function parseId(v) {
  const t = str(v); if (!t) return null;
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  const n = Number(t); return Number.isInteger(n) && n >= 0 ? n : null;
}
export const fmtId = (n) => (n == null ? "" : "0x" + Number(n).toString(16).toUpperCase());
const splitList = (v) => str(v).split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

/* ---------- reading workbooks ---------- */
const NODE_COLS = { name: ["name", "node"], mac: ["macaddress", "mac"], ipv4: ["ipv4address", "ipv4"], ipv6: ["ipv6address", "ipv6"], rxPort: ["receiveport", "rxport"], txPort: ["transmitport", "txport"] };
const MSG_COLS = { id: ["messageid", "pduid"], name: ["pduname", "pdutype", "messagename", "pdu", "name"], sendType: ["sendtype"], cycleMs: ["cycletime", "cycle"], sender: ["sender", "transmitter"], receivers: ["receiver", "receivers"] };
const FRAME_COLS = { id: ["messageid", "pduid", "id"], frame: ["frame", "framename"], frameType: ["frametype"], cycleMs: ["cycletime"], layout: ["framelayout", "transport", "protocol"],
  srcIp: ["sourceipaddress", "sourceip"], srcPort: ["sourceserviceport", "sourceport"], dstIp: ["destipaddress", "destinationipaddress", "destip"], dstPort: ["destserviceport", "destinationserviceport", "destport"],
  ipType: ["ipaddresstype", "iptype"], payloadBytes: ["headerpayloadbyte", "headerpayload", "payloadbyte", "payload"], pdu: ["pdus", "pdu"], signal: ["signal", "signals", "signalname"],
  startBit: ["startbit", "bitposition", "startbyte"], length: ["bitlength", "lengthbit", "length"], factor: ["factor", "scale"], offset: ["offset"], min: ["min", "minimum"], max: ["max", "maximum"], unit: ["unit"], init: ["initvalue", "initialvalue", "init"] };

// Finds the header row (within the first rows) and maps each wanted field to a column. Exact normalized matches win
// over prefix matches, so "Frame" does not grab "Frame Type".
function mapHeader(aoa, spec, minHits = 2) {
  for (let r = 0; r < Math.min(aoa.length, 8); r++) {
    const row = (aoa[r] || []).map(norm), map = {}, used = new Set();
    for (const [field, aliases] of Object.entries(spec)) {
      let idx = -1;
      for (const a of aliases) { idx = row.findIndex((h, i) => !used.has(i) && h === a); if (idx >= 0) break; }
      if (idx < 0) for (const a of aliases) { idx = row.findIndex((h, i) => !used.has(i) && h && h.startsWith(a)); if (idx >= 0) break; }
      if (idx >= 0) { map[field] = idx; used.add(idx); }
    }
    if (Object.keys(map).length >= minHits) return { row: r, map, header: aoa[r] || [] };
  }
  return null;
}
const findSheet = (sheets, re) => Object.keys(sheets).find((n) => re.test(n));

// sheets: { [sheetName]: array-of-arrays }. Returns { eth, warnings }.
export function parseWorkbook(sheets) {
  const eth = emptyEth(), warnings = [];
  const nodeSheet = findSheet(sheets, /node/i), msgSheet = findSheet(sheets, /message/i), frameSheet = findSheet(sheets, /backbone|eth|frame/i);
  if (nodeSheet) {
    const h = mapHeader(sheets[nodeSheet], NODE_COLS);
    if (!h || h.map.name == null) warnings.push("Sheet “" + nodeSheet + "”: no Name column found.");
    else sheets[nodeSheet].slice(h.row + 1).forEach((r) => { const name = str(r[h.map.name]); if (!name) return;
      eth.nodes.push({ name, mac: str(r[h.map.mac]).toUpperCase(), ipv4: str(r[h.map.ipv4]), ipv6: str(r[h.map.ipv6]).toLowerCase(), rxPort: numOrNull(r[h.map.rxPort]), txPort: numOrNull(r[h.map.txPort]) }); });
  }
  const pduById = new Map();
  const pduFor = (id, name) => { const key = id != null ? "id:" + id : "name:" + name; if (!pduById.has(key)) { const p = { id, name: name || fmtId(id), sendType: "", cycleMs: null, sender: "", receivers: [], frame: {}, signals: [] }; pduById.set(key, p); eth.pdus.push(p); } return pduById.get(key); };
  if (msgSheet) {
    const h = mapHeader(sheets[msgSheet], MSG_COLS);
    if (!h || (h.map.id == null && h.map.name == null)) warnings.push("Sheet “" + msgSheet + "”: no Message ID or PDU column found.");
    else sheets[msgSheet].slice(h.row + 1).forEach((r) => { const id = parseId(r[h.map.id]), name = str(r[h.map.name]); if (id == null && !name) return;
      const p = pduFor(id, name); p.name = name || p.name; p.sendType = str(r[h.map.sendType]).toLowerCase(); p.cycleMs = numOrNull(r[h.map.cycleMs]); p.sender = str(r[h.map.sender]); p.receivers = splitList(r[h.map.receivers]); });
  }
  if (frameSheet && frameSheet !== msgSheet && frameSheet !== nodeSheet) {
    const aoa = sheets[frameSheet], h = mapHeader(aoa, FRAME_COLS, 3);
    if (!h) warnings.push("Sheet “" + frameSheet + "”: header row not recognised.");
    else {
      const nodeNames = new Set(eth.nodes.map((n) => n.name));
      const roleCols = (h.header || []).map((t, i) => [str(t), i]).filter(([t, i]) => nodeNames.has(t) && !Object.values(h.map).includes(i));
      aoa.slice(h.row + 1).forEach((r) => {
        const id = parseId(r[h.map.id]), pname = str(r[h.map.pdu]) || str(r[h.map.frame]); if (id == null && !pname) return;
        const p = pduFor(id, pname); if (!p.name || p.name === fmtId(id)) p.name = pname || p.name;
        const f = p.frame, set = (k, v) => { if (v !== "" && v != null && (f[k] == null || f[k] === "")) f[k] = v; };
        set("name", str(r[h.map.frame])); set("type", str(r[h.map.frameType])); set("layout", str(r[h.map.layout]).toUpperCase());
        set("srcIp", str(r[h.map.srcIp]).toLowerCase()); set("srcPort", numOrNull(r[h.map.srcPort])); set("dstIp", str(r[h.map.dstIp]).toLowerCase()); set("dstPort", numOrNull(r[h.map.dstPort]));
        set("ipType", str(r[h.map.ipType])); set("payloadBytes", numOrNull(r[h.map.payloadBytes]));
        if (p.cycleMs == null) p.cycleMs = numOrNull(r[h.map.cycleMs]);
        const sname = str(r[h.map.signal]); if (!sname) return;
        if (p.signals.some((s) => s.name === sname)) return;
        const roles = {}; roleCols.forEach(([node, i]) => { const v = str(r[i]).toUpperCase(); if (ROLE_CODES.includes(v)) roles[node] = v; });
        p.signals.push({ name: sname, startBit: numOrNull(r[h.map.startBit]), length: numOrNull(r[h.map.length]), factor: numOrNull(r[h.map.factor]), offset: numOrNull(r[h.map.offset]),
          min: numOrNull(r[h.map.min]), max: numOrNull(r[h.map.max]), unit: str(r[h.map.unit]), init: numOrNull(r[h.map.init]), roles });
      });
    }
  }
  if (!nodeSheet && !msgSheet && !frameSheet) warnings.push("No Nodes, Messages or BackboneETH sheet found.");
  return { eth, warnings };
}

/* ---------- merging a (partial) workbook into the matrix ---------- */
const blank = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);
const same = (a, b) => (Array.isArray(a) ? JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()) : String(a) === String(b));
// Fills blanks from `inc`; where both hold a value and they differ, keeps `base` and records a conflict.
function mergeFields(base, inc, fields, where, report) {
  let changed = false;
  for (const k of fields) {
    if (blank(inc[k])) continue;
    if (blank(base[k])) { base[k] = Array.isArray(inc[k]) ? [...inc[k]] : inc[k]; changed = true; }
    else if (!same(base[k], inc[k])) report.conflicts.push({ where, field: k, kept: base[k], incoming: inc[k] });
  }
  return changed;
}
export function mergeEth(base, incoming) {
  const out = JSON.parse(JSON.stringify(base || emptyEth())), inc = incoming || emptyEth();
  const report = { added: { nodes: 0, pdus: 0, signals: 0 }, filled: 0, conflicts: [] };
  for (const n of inc.nodes || []) {
    const ex = out.nodes.find((x) => x.name === n.name);
    if (!ex) { out.nodes.push(JSON.parse(JSON.stringify(n))); report.added.nodes++; }
    else if (mergeFields(ex, n, ["mac", "ipv4", "ipv6", "rxPort", "txPort"], "Node " + n.name, report)) report.filled++;
  }
  for (const p of inc.pdus || []) {
    const ex = out.pdus.find((x) => (p.id != null && x.id === p.id) || (p.id == null && x.name === p.name));
    if (!ex) { out.pdus.push(JSON.parse(JSON.stringify(p))); report.added.pdus++; report.added.signals += (p.signals || []).length; continue; }
    const where = "PDU " + fmtId(ex.id) + " " + ex.name;
    if (mergeFields(ex, p, ["name", "sendType", "cycleMs", "sender", "receivers"], where, report)) report.filled++;
    ex.frame = ex.frame || {}; if (mergeFields(ex.frame, p.frame || {}, ["name", "type", "layout", "srcIp", "srcPort", "dstIp", "dstPort", "ipType", "payloadBytes"], where + " (frame)", report)) report.filled++;
    for (const s of p.signals || []) {
      const es = ex.signals.find((x) => x.name === s.name);
      if (!es) { ex.signals.push(JSON.parse(JSON.stringify(s))); report.added.signals++; continue; }
      if (mergeFields(es, s, ["startBit", "length", "factor", "offset", "min", "max", "unit", "init"], where + " / " + s.name, report)) report.filled++;
      es.roles = es.roles || {}; for (const [node, r] of Object.entries(s.roles || {})) { if (!es.roles[node]) es.roles[node] = r; else if (es.roles[node] !== r) report.conflicts.push({ where: where + " / " + s.name, field: "role " + node, kept: es.roles[node], incoming: r }); }
    }
  }
  return { eth: out, report };
}

/* ---------- consistency checks ---------- */
export function checkEth(eth) {
  const f = [], E = (msg) => f.push({ sev: "error", msg }), W = (msg) => f.push({ sev: "warning", msg });
  const nodes = eth.nodes || [], pdus = eth.pdus || [], names = new Set(nodes.map((n) => n.name));
  const dup = (key, label) => { const by = {}; nodes.forEach((n) => { const v = str(n[key]).toLowerCase(); if (v) (by[v] = by[v] || []).push(n.name); }); Object.entries(by).forEach(([v, ns]) => { if (ns.length > 1) W(label + " " + (key === "mac" ? v.toUpperCase() : v) + " is used by " + ns.join(", ") + " — confirm this is the same device, or correct it."); }); };
  dup("mac", "MAC"); dup("ipv4", "IPv4"); dup("ipv6", "IPv6");
  const nameCount = {}; nodes.forEach((n) => { nameCount[n.name] = (nameCount[n.name] || 0) + 1; }); Object.entries(nameCount).forEach(([n, c]) => { if (c > 1) E("Node " + n + " is defined " + c + " times."); });
  nodes.forEach((n) => { if (n.mac && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(n.mac)) E("Node " + n.name + ": MAC “" + n.mac + "” is not six hex bytes.");
    if (n.ipv4 && !/^(\d{1,3}\.){3}\d{1,3}$/.test(n.ipv4)) E("Node " + n.name + ": IPv4 “" + n.ipv4 + "” is malformed.");
    [["rxPort", "receive"], ["txPort", "transmit"]].forEach(([k, l]) => { if (n[k] != null && !(n[k] > 0 && n[k] < 65536)) E("Node " + n.name + ": " + l + " port " + n[k] + " is out of range."); }); });
  const ids = {}; pdus.forEach((p) => { if (p.id != null) (ids[p.id] = ids[p.id] || []).push(p.name); }); Object.entries(ids).forEach(([id, ns]) => { if (ns.length > 1) E("Message ID " + fmtId(Number(id)) + " is used by " + ns.join(", ") + "."); });
  pdus.forEach((p) => {
    const tag = "PDU " + fmtId(p.id) + " " + p.name;
    if (p.id == null) W(tag + ": no message ID.");
    if (!p.sender) W(tag + ": no sender."); else if (!names.has(p.sender)) W(tag + ": sender " + p.sender + " is not in the Nodes sheet.");
    if (!(p.receivers || []).length) W(tag + ": no receivers.");
    (p.receivers || []).filter((r) => !names.has(r)).forEach((r) => W(tag + ": receiver " + r + " is not in the Nodes sheet."));
    if (/cyclic/.test(p.sendType || "") && !(p.cycleMs > 0)) W(tag + ": cyclic but no cycle time.");
    const sigs = (p.signals || []).filter((s) => s.startBit != null && s.length != null);
    const bits = (p.frame && p.frame.payloadBytes) ? p.frame.payloadBytes * 8 : null;
    sigs.forEach((s) => { if (s.length <= 0) E(tag + " / " + s.name + ": length must be positive."); if (bits != null && s.startBit + s.length > bits) E(tag + " / " + s.name + ": ends at bit " + (s.startBit + s.length) + ", beyond the " + bits + "-bit payload."); });
    const sorted = [...sigs].sort((a, b) => a.startBit - b.startBit);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].startBit < sorted[i - 1].startBit + sorted[i - 1].length) E(tag + ": signals " + sorted[i - 1].name + " and " + sorted[i].name + " overlap.");
    (p.signals || []).forEach((s) => { const senders = Object.entries(s.roles || {}).filter(([, r]) => r === "S").map(([n]) => n); if (senders.length > 1) E(tag + " / " + s.name + ": sent (S) by " + senders.join(" and ") + "."); });
  });
  return f;
}

/* ---------- writing the workbook (released layout) ---------- */
export function toWorkbook(eth) {
  const nodes = eth.nodes || [], pdus = [...(eth.pdus || [])].sort((a, b) => (a.id ?? 1e12) - (b.id ?? 1e12));
  const legend = [["Legend"], ...LEGEND.map(([c, t]) => [c, t])];
  const nodeRows = [["Name", "Mac address", "IPv4 address", "IPv6 address", "Receive Port", "Transmit Port", "ECU", "Chip"],
    ...nodes.map((n) => [n.name, n.mac || "", n.ipv4 || "", n.ipv6 || "", n.rxPort ?? "", n.txPort ?? "", n.ecu || "", n.mcu || ""])];
  const msgRows = [["Message ID", "PDU name", "Send type", "Cycle time", "Sender", "Receiver"],
    ...pdus.map((p) => [fmtId(p.id), p.name, p.sendType || "", p.cycleMs ?? "", p.sender || "", (p.receivers || []).join(",")])];
  const head = ["ID", "Frame", "Frame Type", "Cycle Time", "Frame Layout", "Source IP Address", "Source Service Port", "Dest IP Address", "Dest Service Port", "IP Address Type", "Header + Payload (Byte)",
    "PDUs", "Signal", "Start bit", "Length (bit)", "Factor", "Offset", "Min", "Max", "Unit", "Init value", ...nodes.map((n) => n.name)];
  const frameRows = [head];
  pdus.forEach((p) => { const f = p.frame || {}, base = [fmtId(p.id), f.name || p.name, f.type || "", p.cycleMs ?? "", f.layout || "", f.srcIp || "", f.srcPort ?? "", f.dstIp || "", f.dstPort ?? "", f.ipType || "", f.payloadBytes ?? "", p.name];
    if (!(p.signals || []).length) frameRows.push([...base, "", "", "", "", "", "", "", "", "", ...nodes.map(() => "")]);
    (p.signals || []).forEach((s) => frameRows.push([...base, s.name, s.startBit ?? "", s.length ?? "", s.factor ?? "", s.offset ?? "", s.min ?? "", s.max ?? "", s.unit || "", s.init ?? "", ...nodes.map((n) => (s.roles || {})[n.name] || "")])); });
  return { Legend: legend, Nodes: nodeRows, Messages: msgRows, BackboneETH: frameRows };
}

export const ethStats = (eth) => ({ nodes: (eth.nodes || []).length, pdus: (eth.pdus || []).length, signals: (eth.pdus || []).reduce((n, p) => n + (p.signals || []).length, 0), pdusWithSignals: (eth.pdus || []).filter((p) => (p.signals || []).length).length });
