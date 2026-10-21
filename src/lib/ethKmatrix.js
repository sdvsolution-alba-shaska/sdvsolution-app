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
  ipType: ["ipaddresstype", "iptype"], payloadBytes: ["headerpayloadbyte", "headerpayload", "layer4payloadbyte", "layer4payload", "payloadbyte", "payload"], pdu: ["pdus", "pdu"], signal: ["signal", "signals", "signalname"],
  startBit: ["startbit", "bitposition", "startbyte"], length: ["bitlength", "lengthbit", "length"], factor: ["factor", "scale"], offset: ["offset"], min: ["min", "minimum"], max: ["max", "maximum"], unit: ["unit"], init: ["initvalue", "initialvalue", "init"] };

// Finds the header row (within the first rows) and maps each wanted field to a column. Exact normalized matches win
// over prefix matches, so "Frame" does not grab "Frame Type". The row with the MOST matches wins, so a group-heading
// row above the real header ("Frames … PDUs · Signal … Nodes" in the released layout) is not mistaken for it.
function mapHeader(aoa, spec, minHits = 2) {
  let best = null;
  for (let r = 0; r < Math.min(aoa.length, 8); r++) {
    const row = (aoa[r] || []).map(norm), map = {}, used = new Set();
    for (const [field, aliases] of Object.entries(spec)) {
      let idx = -1;
      for (const a of aliases) { idx = row.findIndex((h, i) => !used.has(i) && h === a); if (idx >= 0) break; }
      if (idx < 0) for (const a of aliases) { idx = row.findIndex((h, i) => !used.has(i) && h && h.startsWith(a)); if (idx >= 0) break; }
      if (idx >= 0) { map[field] = idx; used.add(idx); }
    }
    if (Object.keys(map).length >= minHits && (!best || Object.keys(map).length > Object.keys(best.map).length)) best = { row: r, map, header: aoa[r] || [] };
  }
  return best;
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
      const p = pduFor(id, name); p.name = name || p.name; // a PDU may be listed on several rows (e.g. one per receiver): combine them
      const stp = str(r[h.map.sendType]).toLowerCase(), cyc = numOrNull(r[h.map.cycleMs]), snd = str(r[h.map.sender]);
      if (stp && !p.sendType) p.sendType = stp; if (cyc != null && p.cycleMs == null) p.cycleMs = cyc; if (snd && !p.sender) p.sender = snd;
      p.receivers = [...new Set([...(p.receivers || []), ...splitList(r[h.map.receivers])])]; });
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
  if (inc.valueTables) { out.valueTables = out.valueTables || {}; for (const [k, v] of Object.entries(inc.valueTables)) if (!out.valueTables[k]) out.valueTables[k] = v; }
  for (const p of inc.pdus || []) {
    const ex = out.pdus.find((x) => (p.id != null && x.id === p.id) || (p.id == null && x.name === p.name));
    if (!ex) { out.pdus.push(JSON.parse(JSON.stringify(p))); report.added.pdus++; report.added.signals += (p.signals || []).length; continue; }
    // A dissector's PDU name is generated (often sender-prefixed, e.g. ADAS_Basic_ADAS_DomainNotif); the K-Matrix name
    // (ADAS_DomainNotif) is the official one. Whichever arrives first, the K-Matrix name wins and the other is kept as dissectorName.
    if (ex.nameSource === "dissector" && p.nameSource !== "dissector" && p.name && p.name !== ex.name) { ex.dissectorName = ex.name; ex.name = p.name; delete ex.nameSource; report.renamed = (report.renamed || 0) + 1; }
    else if (p.nameSource === "dissector" && ex.nameSource !== "dissector" && p.name !== ex.name) { if (!ex.dissectorName) ex.dissectorName = p.name; }
    const where = "PDU " + fmtId(ex.id) + " " + ex.name;
    if (mergeFields(ex, p, [...(p.nameSource === "dissector" || ex.dissectorName ? [] : ["name"]), "sendType", "cycleMs", "sender", "receivers"], where, report)) report.filled++;
    if (!ex.senderHint && p.senderHint) ex.senderHint = p.senderHint;
    ex.frame = ex.frame || {}; if (mergeFields(ex.frame, p.frame || {}, ["name", "type", "layout", "srcIp", "srcPort", "dstIp", "dstPort", "ipType", "payloadBytes", "minPayloadBytes"], where + " (frame)", report)) report.filled++;
    for (const s of p.signals || []) {
      const es = ex.signals.find((x) => x.name === s.name);
      if (!es) { ex.signals.push(JSON.parse(JSON.stringify(s))); report.added.signals++; continue; }
      if (mergeFields(es, s, ["startBit", "length", "factor", "offset", "min", "max", "unit", "init", "type", "vt", "byteOrder"], where + " / " + s.name, report)) report.filled++;
      es.roles = es.roles || {}; for (const [node, r] of Object.entries(s.roles || {})) { if (!es.roles[node]) es.roles[node] = r; else if (es.roles[node] !== r) report.conflicts.push({ where: where + " / " + s.name, field: "role " + node, kept: es.roles[node], incoming: r }); }
    }
  }
  return { eth: out, report };
}

/* ---------- topology ----------
   The backbone is the Topology's Ethernet links: topo = { ethLinks: [[ecuA, ecuB, label], ...], names: { ecuId: "CCU" } }.
   Every K-Matrix node is mapped to a Topology ECU (and, for multi-chip ECUs, a chip); every PDU must be able to travel
   from its sender's ECU to each receiver's ECU over Topology Ethernet links. */
export function applyAliases(eth, aliases) { // fills node.ecu / node.mcu from name rules where they are still blank
  let n = 0;
  (eth.nodes || []).forEach((node) => { if (node.ecu) return; const a = (aliases || []).find((x) => x.re.test(node.name)); if (a) { node.ecu = a.ecu; if (a.mcu) node.mcu = a.mcu; node.ecuSource = "alias"; n++; } });
  return n;
}
export function ethPath(topo, from, to) { // BFS over Topology Ethernet links; returns the ECU path or null
  if (from === to) return [from];
  const adj = {}; (topo.ethLinks || []).forEach(([a, b]) => { (adj[a] = adj[a] || new Set()).add(b); (adj[b] = adj[b] || new Set()).add(a); });
  const prev = { [from]: null }, q = [from];
  while (q.length) { const x = q.shift(); for (const y of adj[x] || []) if (!(y in prev)) { prev[y] = x; if (y === to) { const path = [y]; let c = x; while (c != null) { path.unshift(c); c = prev[c]; } return path; } q.push(y); } }
  return null;
}

/* ---------- consistency checks ---------- */

/* Bits a signal occupies (absolute payload bit = byte*8 + bit). Intel: start bit is the LSB, bits run upward.
   Motorola (big-endian, DBC sawtooth): start bit is the MSB; within a byte bits run down, then continue at bit 7 of the next byte. */
export function signalBits(s) {
  const out = []; if (s.startBit == null || !(s.length > 0)) return out;
  if (s.byteOrder !== "motorola") { for (let i = 0; i < s.length; i++) out.push(s.startBit + i); return out; }
  let pos = s.startBit; for (let i = 0; i < s.length; i++) { out.push(pos); pos = pos % 8 === 0 ? pos + 15 : pos - 1; } return out;
}
// Number of signals in a PDU that share at least one bit with another signal (0 = clean layout).
export function sharedBitSignals(signals) {
  const owner = new Map(), hit = new Set();
  (signals || []).forEach((s, i) => signalBits(s).forEach((b) => { if (owner.has(b)) { hit.add(i); hit.add(owner.get(b)); } else owner.set(b, i); }));
  return hit.size;
}
export function checkEth(eth, topo) {
  const f = [], E = (msg) => f.push({ sev: "error", msg }), W = (msg) => f.push({ sev: "warning", msg });
  const nodes = eth.nodes || [], pdus = eth.pdus || [], names = new Set(nodes.map((n) => n.name));
  // Shared addresses are expected when the nodes are endpoints on the SAME ECU (e.g. two services on the CCU host); only flag them otherwise.
  const ecuByName = Object.fromEntries(nodes.map((n) => [n.name, n.ecu || null]));
  const dup = (key, label) => { const by = {}; nodes.forEach((n) => { const v = str(n[key]).toLowerCase(); if (v) (by[v] = by[v] || []).push(n.name); }); Object.entries(by).forEach(([v, ns]) => { const ecus = new Set(ns.map((x) => ecuByName[x])); if (ns.length > 1 && !(ecus.size === 1 && !ecus.has(null))) W(label + " " + (key === "mac" ? v.toUpperCase() : v) + " is used by " + ns.join(", ") + " — confirm this is the same device, or correct it."); }); };
  dup("mac", "MAC"); dup("ipv4", "IPv4"); dup("ipv6", "IPv6");
  const nameCount = {}; nodes.forEach((n) => { nameCount[n.name] = (nameCount[n.name] || 0) + 1; }); Object.entries(nameCount).forEach(([n, c]) => { if (c > 1) E("Node " + n + " is defined " + c + " times."); });
  nodes.forEach((n) => { if (n.mac && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(n.mac)) E("Node " + n.name + ": MAC “" + n.mac + "” is not six hex bytes.");
    if (n.ipv4 && !/^(\d{1,3}\.){3}\d{1,3}$/.test(n.ipv4)) E("Node " + n.name + ": IPv4 “" + n.ipv4 + "” is malformed.");
    [["rxPort", "receive"], ["txPort", "transmit"]].forEach(([k, l]) => { if (n[k] != null && !(n[k] > 0 && n[k] < 65536)) E("Node " + n.name + ": " + l + " port " + n[k] + " is out of range."); }); });
  const ids = {}; pdus.forEach((p) => { if (p.id != null) (ids[p.id] = ids[p.id] || []).push(p.name); }); Object.entries(ids).forEach(([id, ns]) => { if (ns.length > 1) E("Message ID " + fmtId(Number(id)) + " is used by " + ns.join(", ") + "."); });
  pdus.forEach((p) => {
    const tag = "PDU " + fmtId(p.id) + " " + p.name;
    if (p.id == null) W(tag + ": no message ID.");
    if (!p.sender) W(tag + ": no sender." + (p.senderHint ? " (The name suggests " + p.senderHint + ".)" : "")); else if (!names.has(p.sender)) W(tag + ": sender " + p.sender + " is not in the Nodes sheet.");
    if (!(p.receivers || []).length) W(tag + ": no receivers.");
    (p.receivers || []).filter((r) => !names.has(r)).forEach((r) => W(tag + ": receiver " + r + " is not in the Nodes sheet."));
    if (/cyclic/.test(p.sendType || "") && !(p.cycleMs > 0)) W(tag + ": cyclic but no cycle time.");
    const sigs = (p.signals || []).filter((s) => s.startBit != null && s.length != null);
    const bits = (p.frame && p.frame.payloadBytes) ? p.frame.payloadBytes * 8 : null;
    sigs.forEach((s) => { if (s.length <= 0) E(tag + " / " + s.name + ": length must be positive."); const hi = Math.max(-1, ...signalBits(s)) + 1; if (bits != null && hi > bits) E(tag + " / " + s.name + ": ends at bit " + hi + ", beyond the " + bits + "-bit payload."); });
    if (p.sharedBits) W(tag + ": " + p.sharedBits + " signals share bit positions in the imported dissector (probably multiplexed) — define the multiplexor.");
    else { const owner = new Map(); const seen = new Set();
      sigs.forEach((s) => signalBits(s).forEach((b) => { const o = owner.get(b); if (o && o !== s.name) { const k = o + "|" + s.name; if (!seen.has(k)) { seen.add(k); E(tag + ": signals " + o + " and " + s.name + " overlap."); } } else owner.set(b, s.name); })); }
    (p.signals || []).forEach((s) => { const senders = Object.entries(s.roles || {}).filter(([, r]) => r === "S").map(([n]) => n); if (senders.length > 1) E(tag + " / " + s.name + ": sent (S) by " + senders.join(" and ") + "."); });
  });
  if (topo) {
    const onEth = new Set((topo.ethLinks || []).flatMap(([a, b]) => [a, b])), nm = (id) => (topo.names && topo.names[id]) || String(id).replace(/^ECU-/, "");
    const ecuOf = {}; nodes.forEach((n) => { ecuOf[n.name] = n.ecu || null; });
    nodes.forEach((n) => { if (!n.ecu) W("Node " + n.name + " is not mapped to a Topology ECU."); else if (!onEth.has(n.ecu)) E("Node " + n.name + " is mapped to " + nm(n.ecu) + ", which has no Ethernet link in the Topology."); });
    pdus.forEach((p) => { const from = ecuOf[p.sender]; if (!from) return;
      (p.receivers || []).forEach((r) => { const to = ecuOf[r]; if (!to || !onEth.has(from) || !onEth.has(to)) return;
        if (!ethPath(topo, from, to)) E("PDU " + fmtId(p.id) + " " + p.name + ": no Ethernet path in the Topology from " + p.sender + " (" + nm(from) + ") to " + r + " (" + nm(to) + ")."); }); });
  }
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

/* ---------- reading a Wireshark Lua dissector (BackboneETH.lua) ----------
   The generated dissector lists every PDU (message_table[0x..] = function … -- <PDU name>) and, for each signal, the
   payload bytes and bit masks it is assembled from. Each UDP datagram carries PDUs as [4-byte ID][4-byte length][payload],
   so payload byte k is buffer(byte_index + 8 + k). Bit positions here are LSB-first (start bit = lowest bit, Intel).
   The dissector carries layout, types and value tables only — no senders, receivers, cycle times or scaling; those come
   from the K-Matrix workbook. The PDU name prefix (CZC_, FZC_, ADAS_ …) is kept as a sender HINT, never as the sender. */
const ctz = (m) => { let i = 0; while (i < 32 && !((m >>> i) & 1)) i++; return i; };
const popcnt = (m) => { let c = 0; while (m) { c += m & 1; m >>>= 1; } return c; };
const contiguous = (m) => { const lb = ctz(m), n = popcnt(m); return ((m >>> lb) & ((n >= 32 ? 0 : 1 << n) - 1 >>> 0)) === (n >= 32 ? m >>> lb : (1 << n) - 1); };
const typeOfField = (t) => (/^float|^double/.test(t) ? "float" : /^int/.test(t) ? "signed" : /^string|^bytes/.test(t) ? "string" : "unsigned");

export function parseDissector(text) {
  const lines = String(text || "").split(/\r?\n/), warnings = [], valueTables = {}, fieldType = {}, fieldVt = {}, pdus = [];
  let curVt = null, cur = null, sig = null, port = null, proto = null, nonIntel = 0, empty = 0, badMask = 0, badLayout = 0;
  const finishSig = () => {
    if (!sig || !cur) { sig = null; return; }
    const parts = sig.parts;
    if (!parts.length) { empty++; cur.signals.push({ name: sig.name, startBit: null, length: null, type: fieldType[sig.name] ? typeOfField(fieldType[sig.name]) : (sig.float ? "float" : "unsigned"), vt: fieldVt[sig.name] || undefined, roles: {} }); sig = null; return; }
    const segs = parts.map((p) => { const lb = ctz(p.mask), n = popcnt(p.mask); if (!contiguous(p.mask)) badMask++; return { src: (p.byte - 8) * 8 + lb, dest: p.dir === "lshift" ? lb + p.sh : lb - p.sh, n }; }).sort((a, b) => a.dest - b.dest);
    const intel = segs.every((s) => s.src - segs[0].src === s.dest - segs[0].dest);
    const length = segs.reduce((t, s) => t + s.n, 0);
    const ft = fieldType[sig.name], type = sig.float ? "float" : sig.signed ? "signed" : ft && /^string|^bytes/.test(ft) ? "string" : ft && /^int/.test(ft) ? "signed" : "unsigned"; // ProtoField.float on a scaled integer is NOT an IEEE float
    const top = segs[segs.length - 1];
    const s = { name: sig.name, startBit: intel ? segs[0].src : top.src + top.n - 1, length, type, roles: {} };
    if (!intel) { s.byteOrder = "motorola"; nonIntel++;
      const want = new Set(); segs.forEach((g) => { for (let i = 0; i < g.n; i++) want.add(g.src + i); });
      const got = signalBits(s); if (got.length !== want.size || got.some((b) => !want.has(b))) badLayout++; }
    if (sig.factor != null && sig.factor !== 1) s.factor = sig.factor;
    if (sig.offset != null && sig.offset !== 0) s.offset = sig.offset;
    if (sig.vt || fieldVt[sig.name]) s.vt = sig.vt || fieldVt[sig.name];
    cur.signals.push(s); cur._maxByte = Math.max(cur._maxByte || 0, ...parts.map((p) => p.byte - 8 + 1)); sig = null;
  };
  for (const raw of lines) {
    const line = raw;
    if (curVt) {
      const m = /^\s*\[(-?\d+)\]\s*=\s*"((?:[^"\\]|\\.)*)",?\s*$/.exec(line);
      if (m) { valueTables[curVt][m[1]] = m[2]; continue; }
      if (/^\s*\},?\s*$/.test(line)) { curVt = null; continue; }
    }
    let m;
    if ((m = /^\s*"VALS_([^"]+)",\s*\{\s*$/.exec(line)) || (m = /^\s*(?:VALS)?\["([^"]+)"\]\s*=\s*\{\s*$/.exec(line))) { curVt = m[1]; valueTables[curVt] = {}; continue; }
    if ((m = /^([A-Za-z0-9_]+)_field\s*=\s*ProtoField\.([a-z0-9]+)\((.*)\)\s*$/.exec(line)) || (m = /^F\["([^"]+)"\]\s*=\s*ProtoField\.([a-z0-9]+)\((.*)\)\s*$/.exec(line))) {
      fieldType[m[1]] = m[2]; const v = /(?:CONSTANTS\["VALS_|VALS\[")([^"]+)"\]/.exec(m[3]); if (v) fieldVt[m[1]] = v[1]; continue; }
    if ((m = /^message_table\[0x([0-9a-fA-F]+)\]\s*=\s*function/.exec(line))) { finishSig(); cur = { id: parseInt(m[1], 16), name: null, sendType: "", cycleMs: null, sender: "", receivers: [], frame: {}, signals: [] }; pdus.push(cur); continue; }
    if (cur && cur.name == null && (m = /^\s*--\s*(\S+)\s*$/.exec(line))) { cur.name = m[1]; continue; }
    if ((m = /^\S+ = Proto\("([^"]+)"/.exec(line))) { proto = m[1]; continue; }
    if ((m = /^\s*-- Signal (\S+)\s*$/.exec(line))) { finishSig(); sig = { name: m[1], parts: [], float: false }; continue; }
    if (sig) {
      const b = /(rshift|lshift)\(bit\.band\(buffer\(byte_index \+ (\d+), 1\):uint\(\), 0x([0-9A-Fa-f]+)\), (\d+)\)/.exec(line);
      if (b) { sig.parts.push({ dir: b[1], byte: Number(b[2]), mask: parseInt(b[3], 16), sh: Number(b[4]) }); continue; }
      if (/IEEE float support/.test(line)) { sig.float = true; continue; }
      const vtc = /^\s*-- Value table (\S+)/.exec(line); if (vtc) { sig.vt = vtc[1]; continue; }
      if (/Sign extend signed integer/.test(line)) { sig.signed = true; continue; }
      const sc = /(?:msg_tree|t):add(?:_le)?\((?:[A-Za-z0-9_]+_field|F\["[^"]+"\]),\s*\((?:signals\.[A-Za-z0-9_]+|v)\s*\*\s*([-0-9.eE+]+)\)\s*\+\s*([-0-9.eE+]+)\)/.exec(line);
      if (sc) { sig.factor = Number(sc[1]); sig.offset = Number(sc[2]); continue; }
    }
    if ((m = /udp_port:add\((\d+)/.exec(line))) port = Number(m[1]);
    if ((m = /Proto\("([^"]+)"/.exec(line))) proto = m[1];
  }
  finishSig();
  pdus.forEach((p) => { if (!p.name) p.name = "PDU_" + fmtId(p.id); p.nameSource = "dissector"; const pre = /^([A-Za-z0-9]+)_/.exec(p.name); if (pre) p.senderHint = pre[1];
    /* transport (UDP/TCP) and ports are NOT taken from the dissector: it binds one port for decoding, the K-Matrix owns the real frame */ if (p._maxByte) p.frame.minPayloadBytes = p._maxByte; delete p._maxByte; });
  // keep only value tables that a signal uses
  const used = new Set(pdus.flatMap((p) => p.signals.map((s) => s.vt).filter(Boolean)));
  const vts = {}; used.forEach((k) => { if (valueTables[k]) vts[k] = valueTables[k]; });
  if (!pdus.length) warnings.push("No PDUs found — this does not look like a generated backbone dissector.");
  let muxPdus = 0, muxSigs = 0;
  pdus.forEach((p) => { const n = sharedBitSignals(p.signals); if (n) { p.sharedBits = n; muxPdus++; muxSigs += n; } });
  if (nonIntel) warnings.push(nonIntel + " signal(s) are big-endian (Motorola); start bit = most significant bit, as in a DBC." + (badLayout ? " " + badLayout + " of them do not follow the Motorola bit order — check them." : ""));
  if (muxPdus) warnings.push(muxPdus + " PDU(s) have signals that share bit positions (" + muxSigs + " signals) — almost certainly multiplexed in the source database; the dissector decodes every variant. Define the multiplexor when the K-Matrix arrives.");
  if (badMask) warnings.push(badMask + " byte mask(s) have gaps — check those signals.");
  if (empty) warnings.push(empty + " signal(s) had no bit layout in the dissector (e.g. strings) — imported without a position.");
  return { eth: { nodes: [], pdus, valueTables: vts, source: { proto, udpPort: port } }, warnings };
}

/* ---------- compact storage: base64( gzip( JSON ) ) — ~0.5 MB for a full backbone instead of ~4.8 MB ---------- */
const b64 = { enc: (u8) => { if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64"); let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
  dec: (t) => { if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(t, "base64")); const s = atob(t), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; } };
async function pipe(u8, stream) { const out = new Response(new Blob([u8]).stream().pipeThrough(stream)); return new Uint8Array(await out.arrayBuffer()); }
export async function packEth(eth) { return b64.enc(await pipe(new TextEncoder().encode(JSON.stringify(eth || emptyEth())), new CompressionStream("gzip"))); }
export async function unpackEth(text) { if (!text) return emptyEth(); const j = JSON.parse(new TextDecoder().decode(await pipe(b64.dec(text), new DecompressionStream("gzip")))); j.nodes = j.nodes || []; j.pdus = j.pdus || []; return j; }

/* ---------- generating BackboneETH.lua (Wireshark dissector) from the matrix ----------
   Same wire format the backbone uses: each UDP/TCP payload carries PDUs as [4-byte ID][4-byte length][payload].
   Signals are decoded from their bit layout (Intel or Motorola), sign-extended, scaled (factor/offset), IEEE floats
   converted, and enumerations shown through their value tables. Only PDUs with an ID are decodable. */
const luaStr = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
const luaId = (s) => String(s).replace(/[^A-Za-z0-9_]/g, "_").replace(/^([0-9])/, "_$1");
const hex = (n) => "0x" + (n >>> 0).toString(16).toUpperCase();
// Byte/mask/shift steps that assemble a signal's raw value (dest bit 0 = LSB of the value).
function decodeSteps(s) {
  const bits = signalBits(s); if (!bits.length) return [];
  const dest = s.byteOrder === "motorola" ? bits.map((_, i) => bits.length - 1 - i) : bits.map((_, i) => i);
  const groups = [];
  bits.forEach((b, i) => { const byte = Math.floor(b / 8), g = groups[groups.length - 1];
    if (g && g.byte === byte) { g.lo = Math.min(g.lo, b % 8); g.hi = Math.max(g.hi, b % 8); g.dlo = Math.min(g.dlo, dest[i]); }
    else groups.push({ byte, lo: b % 8, hi: b % 8, dlo: dest[i] }); });
  return groups.map((g) => ({ byte: g.byte, mask: ((1 << (g.hi - g.lo + 1)) - 1) << g.lo, shift: g.lo - g.dlo })).sort((a, b) => (a.shift >= 0 ? 0 : -a.shift) - (b.shift >= 0 ? 0 : -b.shift));
}
const fieldKind = (s) => {
  if (s.type === "string") return "string";
  if (s.type === "float" || (s.factor != null && s.factor !== 1) || (s.offset != null && s.offset !== 0)) return "float";
  const L = s.length || 8, w = L <= 8 ? 8 : L <= 16 ? 16 : L < 32 || (L === 32 && s.type === "signed") ? 32 : 64;
  return (s.type === "signed" ? "int" : "uint") + w;
};
export function toDissector(eth, opts = {}) {
  const proto = luaId(opts.protocol || (eth.source && eth.source.proto) || "Backbone_ETH"), P = "backbone_protocol";
  const pdus = (eth.pdus || []).filter((p) => p.id != null).sort((a, b) => a.id - b.id);
  const fields = new Map(); // field name -> signal (first definition wins; same-named signals share a field, as in the source)
  pdus.forEach((p) => (p.signals || []).forEach((s) => { if (s.startBit != null && s.length > 0 && !fields.has(s.name)) fields.set(s.name, s); }));
  const vts = eth.valueTables || {}, usedVt = new Set(pdus.flatMap((p) => (p.signals || []).map((s) => s.vt)).filter((v) => v && vts[v]));
  const L = [];
  L.push("-- BackboneETH.lua — generated by SDVsolution from the ETH K-Matrix (" + pdus.length + " PDUs, " + fields.size + " signal fields).");
  L.push("-- Wire format: each datagram carries PDUs as [4-byte message ID][4-byte length][payload]. Do not edit by hand; regenerate from the K-Matrix.");
  L.push(P + " = Proto(" + luaStr(proto) + ", " + luaStr(proto.replace(/_/g, " ")) + ")", "");
  // Definitions are split into small functions so no single function exceeds a Lua constant limit (LuaJIT: 65,536).
  L.push("local VALS = {}");
  let vg = 0; [...usedVt].sort().forEach((k, i) => { if (i % 400 === 0) L.push((i ? "end\nvals_" + vg + "()\n" : "") + "local function vals_" + (++vg) + "()"); L.push("VALS[" + luaStr(k) + "] = {"); Object.entries(vts[k]).filter(([n]) => /^-?\d+$/.test(n)).sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)).forEach(([n, t]) => L.push("    [" + n + "] = " + luaStr(t) + ",")); /* keys written verbatim: flag values like 2^55 exceed JS number precision */ L.push("}"); });
  if (usedVt.size) L.push("end", "vals_" + vg + "()"); L.push("");
  L.push('local f_message_id = ProtoField.uint32("' + proto + '.message_id", "message_id", base.HEX)', 'local f_message_length = ProtoField.uint32("' + proto + '.message_length", "message_length", base.DEC)');
  const fname = (n) => "F[" + luaStr(n) + "]"; // a table, not locals: Lua allows only 200 locals per chunk
  L.push("local F = {}");
  let fi = 0, fg = 0;
  for (const [n, s] of fields) { if (fi++ % 2000 === 0) L.push((fi > 1 ? "end\nfields_" + fg + "()\n" : "") + "local function fields_" + (++fg) + "()"); const k = fieldKind(s), vt = s.vt && vts[s.vt] ? ", VALS[" + luaStr(s.vt) + "]" : "";
    L.push(fname(n) + " = ProtoField." + (k === "float" ? "double" : k) + "(" + luaStr(proto + "." + n) + ", " + luaStr(n) + (k === "string" ? "" : ", base.DEC" + (k === "float" ? "" : vt)) + ")"); }
  if (fields.size) L.push("end", "fields_" + fg + "()");
  L.push("", "do", "  local list = { f_message_id, f_message_length }", "  for _, f in pairs(F) do list[#list + 1] = f end", "  " + P + ".fields = list", "end", "");
  L.push("local function ieee754_single(u)", "  if u < 0 then u = u + 4294967296 end", "  local sign = (u >= 2147483648) and -1 or 1", "  local e = math.floor(u / 8388608) % 256", "  local m = u % 8388608",
    "  if e == 0 then return sign * m * 2 ^ -149 end", "  if e == 255 then if m == 0 then return sign * math.huge end return 0 / 0 end", "  return sign * (1 + m / 8388608) * 2 ^ (e - 127)", "end", "");
  L.push("local message_table = {}", "");
  for (const p of pdus) {
    const sigs = (p.signals || []).filter((s) => s.startBit != null && s.length > 0);
    L.push("message_table[" + hex(p.id) + "] = function(tree, buffer, byte_index)", "  -- " + p.name, "  local t = tree:add(" + P + ", buffer(byte_index, math.min(buffer:len() - byte_index, 8 + buffer(byte_index + 4, 4):uint())), " + luaStr(p.name) + ")");
    for (const s of sigs) {
      const v = "v", big = s.length > 32 || (s.length === 32 && s.type !== "signed" && s.type !== "float"), /* unsigned 32-bit: 64-bit ops so bit 31 does not turn the value negative */ steps = decodeSteps(s), need = 8 + Math.max(...steps.map((x) => x.byte)) + 1;
      L.push("  -- Signal " + s.name); if (s.vt && vts[s.vt] && fieldKind(s) === "float") L.push("  -- Value table " + s.vt + " (raw values; a scaled field cannot carry a value table in Wireshark)");
      L.push("  if buffer:len() >= byte_index + " + need + " then", "    local " + v + " = " + (big ? "UInt64(0)" : "0"));
      steps.forEach((x) => { const rd = "bit.band(buffer(byte_index + " + (8 + x.byte) + ", 1):uint(), " + hex(x.mask) + ")";
        L.push("    " + v + " = " + (big ? "UInt64.bor(" + v + ", " + (x.shift >= 0 ? "UInt64.rshift(" + rd + ", " + x.shift + ")" : "UInt64.lshift(" + rd + ", " + -x.shift + ")") + ")" : "bit.bor(" + v + ", " + (x.shift >= 0 ? "bit.rshift(" + rd + ", " + x.shift + ")" : "bit.lshift(" + rd + ", " + -x.shift + ")") + ")")); });
      if (s.type === "signed") L.push("    -- Sign extend signed integer");
      if (s.type === "signed" && s.length < 32 && !big) L.push("    if bit.band(" + v + ", " + hex(2 ** (s.length - 1)) + ") > 0 then " + v + " = bit.bor(" + v + ", " + hex((0xFFFFFFFF << s.length) >>> 0) + ") end");
      let val = v;
      if (s.type === "float" && s.length === 32) { val = "ieee754_single(" + v + ")"; L.push("    -- IEEE float support"); }
      else if ((s.factor != null && s.factor !== 1) || (s.offset != null && s.offset !== 0)) val = "(" + v + " * " + (s.factor ?? 1) + ") + " + (s.offset ?? 0);
      L.push("    t:add(" + fname(s.name) + ", " + val + ")", "  end");
    }
    L.push("end", "");
  }
  L.push("function " + P + ".dissector(buffer, pinfo, tree)", "  local length = buffer:len()", "  if length < 8 then return end", "  pinfo.cols.protocol = " + P + ".name", "  local byte_index = 0", "  local names = {}",
    "  while byte_index + 8 <= length do", "    local id = buffer(byte_index, 4):uint()", "    local len = buffer(byte_index + 4, 4):uint()",
    "    local h = tree:add(" + P + ", buffer(byte_index, 8), \"PDU header\")", "    h:add(f_message_id, buffer(byte_index, 4))", "    h:add(f_message_length, buffer(byte_index + 4, 4))",
    "    local f = message_table[id]", "    if f ~= nil then f(tree, buffer, byte_index) end", "    byte_index = byte_index + 8 + len", "  end", "end", "");
  const ports = (layout) => [...new Set(pdus.filter((p) => (p.frame && (p.frame.layout || "").toUpperCase()) === layout).flatMap((p) => [p.frame.dstPort, p.frame.srcPort]).filter((x) => x > 0))].sort((a, b) => a - b);
  const udp = ports("UDP"), tcp = ports("TCP"), defUdp = (eth.source && eth.source.udpPort) || 20000;
  L.push("-- Bind to the service ports used by the backbone frames in the K-Matrix.");
  L.push("local udp_port = DissectorTable.get(\"udp.port\")"); (udp.length ? udp : [defUdp]).forEach((x) => L.push("udp_port:add(" + x + ", " + P + ")"));
  if (tcp.length) { L.push("local tcp_port = DissectorTable.get(\"tcp.port\")"); tcp.forEach((x) => L.push("tcp_port:add(" + x + ", " + P + ")")); }
  return L.join("\n") + "\n";
}

/* ---------- Behavior Model ↔ backbone binding ----------
   For an ECU (e.g. ECU-CZM, i.e. every K-Matrix node mapped to it: CZC_1, CZC_2, CZC_Switch, BZC), list the backbone
   signals it RECEIVES (candidate Behavior Model inputs) or SENDS (candidate outputs), and map one to a Behavior Model
   signal type. Behavior Models are integer-only, so a binding carries the RAW value; factor/offset/unit stay on the
   binding (and in the note) for the engineer to apply in calibrations. */
export function ecuSignals(eth, ecu, dir) {
  const mine = new Set((eth.nodes || []).filter((n) => n.ecu === ecu).map((n) => n.name)), out = [];
  for (const p of eth.pdus || []) {
    if (p.id == null) continue;
    const sends = mine.has(p.sender), recvs = (p.receivers || []).filter((r) => mine.has(r));
    if (dir === "out" ? !sends : !recvs.length) continue;
    for (const s of p.signals || []) if (s.startBit != null && s.length > 0)
      out.push({ key: p.id + "/" + s.name, pduId: p.id, pdu: p.name, signal: s.name, sender: p.sender || "", receivers: p.receivers || [], node: dir === "out" ? p.sender : recvs.join(","), cycleMs: p.cycleMs ?? null,
        startBit: s.startBit, length: s.length, byteOrder: s.byteOrder || "intel", type: s.type || "unsigned", factor: s.factor ?? 1, offset: s.offset ?? 0, unit: s.unit || "", vt: s.vt || null });
  }
  return out;
}
export function bmTypeForBus(b) {
  if (b.type === "float") return { baseType: null, why: "IEEE float — Behavior Models are integer-only; bind it through an integer quantity instead" };
  if (b.length === 1) return { baseType: "boolean", min: 0, max: 1 };
  if (b.type === "signed") { const t = b.length <= 8 ? "sint8" : b.length <= 16 ? "sint16" : b.length <= 32 ? "sint32" : null; if (!t) return { baseType: null, why: "signed wider than 32 bits" }; return { baseType: t, min: -(2 ** (b.length - 1)), max: 2 ** (b.length - 1) - 1 }; }
  const t = b.length <= 8 ? "uint8" : b.length <= 16 ? "uint16" : b.length <= 32 ? "uint32" : null; if (!t) return { baseType: null, why: "wider than 32 bits" };
  return { baseType: t, min: 0, max: 2 ** b.length - 1 };
}
// Is a stored binding still present (same PDU id + signal name) and unchanged in layout?
export function bindingStatus(eth, bus) {
  if (!bus) return null; const p = (eth.pdus || []).find((x) => x.id === bus.pduId); const s = p && (p.signals || []).find((x) => x.name === bus.signal);
  if (!s) return "missing"; if (s.startBit !== bus.startBit || s.length !== bus.length || (s.byteOrder || "intel") !== (bus.byteOrder || "intel") || (s.factor ?? 1) !== (bus.factor ?? 1) || (s.offset ?? 0) !== (bus.offset ?? 0)) return "changed"; return "ok";
}
