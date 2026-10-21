// Backbone ARXML (AUTOSAR R4 System Description) generated from the ETH K-Matrix.
// Contents: Ethernet cluster + physical channel, ECU instances (one per K-Matrix node) with Ethernet controller,
// connector and I-PDU ports, network endpoints (IPv4/IPv6), I-SIGNAL-I-PDUs with I-SIGNAL-TO-I-PDU-MAPPINGs
// (start position + byte order), PDU/I-signal triggerings that tie each PDU to its sender (OUT port) and receivers
// (IN ports), cycle times, I-SIGNALs with network base types, SYSTEM-SIGNALs and COMPU-METHODs (linear / text table).
// Start positions follow AUTOSAR: LSB for little endian (MOST-SIGNIFICANT-BYTE-LAST), MSB for big endian
// (MOST-SIGNIFICANT-BYTE-FIRST), bits counted byte*8 + bit — the same numbering the K-Matrix model uses.
// Not generated yet: SoAd socket connection bundles (which socket carries which PDU) and E2E protection.
import { signalBits } from "./ethKmatrix.js";

const xe = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ident = (s) => { let t = String(s || "x").replace(/[^A-Za-z0-9_]/g, "_"); if (!/^[A-Za-z]/.test(t)) t = "X_" + t; return t.slice(0, 120); };
// AUTOSAR wants IPv6 fully expanded (8 groups, no "::"): fd53:7cb8:383:0::1f3 -> fd53:7cb8:383:0:0:0:0:1f3
export function expandIpv6(a) {
  const t = String(a || "").trim().toLowerCase(); if (!t.includes(":")) return t;
  const [h, tail] = t.split("::"); const head = h ? h.split(":") : [], rest = tail != null ? (tail ? tail.split(":") : []) : null;
  if (rest == null) return head.join(":");
  return [...head, ...Array(Math.max(0, 8 - head.length - rest.length)).fill("0"), ...rest].join(":");
}
const hexId = (n) => "0x" + Number(n).toString(16).toUpperCase();
const num = (v) => { const s = String(v); return /e/i.test(s) ? Number(v).toPrecision(17).replace(/\.?0+$/, "") : s; };

// Unique SHORT-NAMEs within one package.
function namer() { const used = new Set(); return (want, alt) => { let n = ident(want); if (used.has(n) && alt) n = ident(alt); let base = n, k = 2; while (used.has(n)) n = (base.slice(0, 114) + "_" + k++); used.add(n); return n; }; }

export function toBackboneArxml(eth, opts = {}) {
  const ecuOf = (name) => { const n = (eth.nodes || []).find((x) => x.name === name); return n ? n.ecu || null : null; };
  // ECU extract: keep PDUs the ECU sends or receives (any of its K-Matrix nodes), and only the nodes those PDUs involve.
  const forEcu = opts.ecu || null;
  const ecuNodes = forEcu ? new Set((eth.nodes || []).filter((n) => n.ecu === forEcu).map((n) => n.name)) : null;
  const pdus = (eth.pdus || []).filter((p) => p.id != null).filter((p) => !ecuNodes || ecuNodes.has(p.sender) || (p.receivers || []).some((r) => ecuNodes.has(r))).sort((a, b) => a.id - b.id);
  const involved = new Set(pdus.flatMap((p) => [p.sender, ...(p.receivers || [])]).filter(Boolean));
  const nodes = (eth.nodes || []).filter((n) => !ecuNodes || involved.has(n.name) || ecuNodes.has(n.name));
  const sysName = ident(opts.systemName || (forEcu ? "Backbone_" + forEcu.replace(/^ECU-/, "") + "_Extract" : "Backbone_ETH"));
  const R = "/SDV_Backbone"; // root package path
  const vts = eth.valueTables || {};

  // ---- names
  const nPdu = namer(), nSig = namer(), nCm = namer(), nEcu = namer();
  const pduName = new Map(pdus.map((p) => [p.id, nPdu(p.name, p.name + "_" + hexId(p.id))]));
  const ecuName = new Map(nodes.map((n) => [n.name, nEcu(n.name)]));

  // ---- base types (network representation)
  const baseTypes = new Map(); // name -> {bits, enc}
  const baseTypeFor = (s) => {
    let bits, enc;
    if (s.type === "float") { bits = s.length === 64 ? 64 : 32; enc = "IEEE754"; }
    else { bits = s.length <= 8 ? 8 : s.length <= 16 ? 16 : s.length <= 32 ? 32 : 64; enc = s.type === "signed" ? "2C" : "NONE"; }
    const name = (enc === "IEEE754" ? "float" : enc === "2C" ? "sint" : "uint") + bits; baseTypes.set(name, { bits, enc }); return name;
  };

  // ---- compu methods (deduplicated by factor/offset/value table)
  const cms = new Map(); // key -> {name, factor, offset, vt}
  const cmFor = (s) => {
    const f = s.factor == null ? 1 : s.factor, o = s.offset == null ? 0 : s.offset, vt = s.vt && vts[s.vt] ? s.vt : null;
    if (f === 1 && o === 0 && !vt) return null;
    const key = f + "|" + o + "|" + (vt || ""); if (!cms.has(key)) cms.set(key, { name: nCm(vt ? "CM_" + vt : "CM_Lin_" + String(f).replace(/[^0-9]/g, "_") + "_" + String(o).replace(/[^0-9]/g, "_")), factor: f, offset: o, vt });
    return cms.get(key).name;
  };

  // ---- signals: one I-SIGNAL + SYSTEM-SIGNAL per (PDU, signal) with a bit layout
  const sigRows = []; // {pdu, s, name, bt, cm}
  const counts = {}; pdus.forEach((p) => (p.signals || []).forEach((s) => { counts[s.name] = (counts[s.name] || 0) + 1; }));
  pdus.forEach((p) => (p.signals || []).filter((s) => s.startBit != null && s.length > 0).forEach((s) => {
    const name = nSig(counts[s.name] > 1 ? pduName.get(p.id) + "__" + s.name : s.name, pduName.get(p.id) + "__" + s.name);
    sigRows.push({ p, s, name, bt: baseTypeFor(s), cm: cmFor(s) });
  }));
  const skipped = pdus.reduce((n, p) => n + (p.signals || []).filter((s) => !(s.startBit != null && s.length > 0)).length, 0);

  const pduLen = (p) => { const own = p.frame && (p.frame.payloadBytes || p.frame.minPayloadBytes); const need = Math.max(0, ...(p.signals || []).flatMap((s) => signalBits(s)).map((b) => Math.floor(b / 8) + 1)); return Math.max(own || 0, need) || 1; };

  const o = [], w = (s) => o.push(s);
  w('<?xml version="1.0" encoding="UTF-8"?>');
  w('<AUTOSAR xmlns="http://autosar.org/schema/r4.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://autosar.org/schema/r4.0 AUTOSAR_00048.xsd">');
  w('<AR-PACKAGES><AR-PACKAGE><SHORT-NAME>SDV_Backbone</SHORT-NAME>');
  w('<DESC><L-2 L="EN">Ethernet backbone system description generated by SDVsolution from the ETH K-Matrix (' + pdus.length + ' PDUs, ' + sigRows.length + ' signals, ' + nodes.length + ' ECU instances' + (forEcu ? '; extract for ' + xe(forEcu) : '') + '). Regenerate instead of editing.</L-2></DESC>');
  w('<AR-PACKAGES>');

  // BaseTypes
  w('<AR-PACKAGE><SHORT-NAME>BaseTypes</SHORT-NAME><ELEMENTS>');
  for (const [n, b] of [...baseTypes].sort()) w('<SW-BASE-TYPE><SHORT-NAME>' + n + '</SHORT-NAME><CATEGORY>FIXED_LENGTH</CATEGORY><BASE-TYPE-SIZE>' + b.bits + '</BASE-TYPE-SIZE><BASE-TYPE-ENCODING>' + b.enc + '</BASE-TYPE-ENCODING></SW-BASE-TYPE>');
  w('</ELEMENTS></AR-PACKAGE>');

  // CompuMethods
  if (cms.size) {
    w('<AR-PACKAGE><SHORT-NAME>CompuMethods</SHORT-NAME><ELEMENTS>');
    for (const c of cms.values()) {
      const lin = !(c.factor === 1 && c.offset === 0);
      const cat = c.vt && lin ? "SCALE_LINEAR_AND_TEXTTABLE" : c.vt ? "TEXTTABLE" : "LINEAR";
      w('<COMPU-METHOD><SHORT-NAME>' + c.name + '</SHORT-NAME><CATEGORY>' + cat + '</CATEGORY><COMPU-INTERNAL-TO-PHYS><COMPU-SCALES>');
      if (c.vt) Object.entries(vts[c.vt]).filter(([k]) => /^-?\d+$/.test(k)).sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)).forEach(([k, t]) =>
        w('<COMPU-SCALE><LOWER-LIMIT INTERVAL-TYPE="CLOSED">' + k + '</LOWER-LIMIT><UPPER-LIMIT INTERVAL-TYPE="CLOSED">' + k + '</UPPER-LIMIT><COMPU-CONST><VT>' + xe(t) + '</VT></COMPU-CONST></COMPU-SCALE>'));
      if (lin) w('<COMPU-SCALE><COMPU-RATIONAL-COEFFS><COMPU-NUMERATOR><V>' + num(c.offset) + '</V><V>' + num(c.factor) + '</V></COMPU-NUMERATOR><COMPU-DENOMINATOR><V>1</V></COMPU-DENOMINATOR></COMPU-RATIONAL-COEFFS></COMPU-SCALE>');
      w('</COMPU-SCALES></COMPU-INTERNAL-TO-PHYS></COMPU-METHOD>');
    }
    w('</ELEMENTS></AR-PACKAGE>');
  }

  // SystemSignals
  w('<AR-PACKAGE><SHORT-NAME>SystemSignals</SHORT-NAME><ELEMENTS>');
  for (const r of sigRows) w('<SYSTEM-SIGNAL><SHORT-NAME>' + r.name + '</SHORT-NAME><DYNAMIC-LENGTH>false</DYNAMIC-LENGTH>' + (r.cm ? '<PHYSICAL-PROPS><SW-DATA-DEF-PROPS-VARIANTS><SW-DATA-DEF-PROPS-CONDITIONAL><COMPU-METHOD-REF DEST="COMPU-METHOD">' + R + '/CompuMethods/' + r.cm + '</COMPU-METHOD-REF></SW-DATA-DEF-PROPS-CONDITIONAL></SW-DATA-DEF-PROPS-VARIANTS></PHYSICAL-PROPS>' : '') + '</SYSTEM-SIGNAL>');
  w('</ELEMENTS></AR-PACKAGE>');

  // ISignals
  w('<AR-PACKAGE><SHORT-NAME>ISignals</SHORT-NAME><ELEMENTS>');
  for (const r of sigRows) w('<I-SIGNAL><SHORT-NAME>' + r.name + '</SHORT-NAME><DATA-TYPE-POLICY>LEGACY</DATA-TYPE-POLICY><LENGTH>' + r.s.length + '</LENGTH><NETWORK-REPRESENTATION-PROPS><SW-DATA-DEF-PROPS-VARIANTS><SW-DATA-DEF-PROPS-CONDITIONAL><BASE-TYPE-REF DEST="SW-BASE-TYPE">' + R + '/BaseTypes/' + r.bt + '</BASE-TYPE-REF></SW-DATA-DEF-PROPS-CONDITIONAL></SW-DATA-DEF-PROPS-VARIANTS></NETWORK-REPRESENTATION-PROPS><SYSTEM-SIGNAL-REF DEST="SYSTEM-SIGNAL">' + R + '/SystemSignals/' + r.name + '</SYSTEM-SIGNAL-REF></I-SIGNAL>');
  w('</ELEMENTS></AR-PACKAGE>');

  // Pdus
  const byPdu = new Map(); sigRows.forEach((r) => { if (!byPdu.has(r.p.id)) byPdu.set(r.p.id, []); byPdu.get(r.p.id).push(r); });
  w('<AR-PACKAGE><SHORT-NAME>Pdus</SHORT-NAME><ELEMENTS>');
  for (const p of pdus) {
    const rows = byPdu.get(p.id) || [];
    w('<I-SIGNAL-I-PDU><SHORT-NAME>' + pduName.get(p.id) + '</SHORT-NAME><DESC><L-2 L="EN">Message ID ' + hexId(p.id) + (p.sharedBits ? '; ' + p.sharedBits + ' signals share bit positions (multiplexed in the source; multiplexor not defined)' : '') + '</L-2></DESC><LENGTH>' + pduLen(p) + '</LENGTH>');
    if (p.cycleMs > 0) w('<I-PDU-TIMING-SPECIFICATIONS><I-PDU-TIMING><TRANSMISSION-MODE-DECLARATION><TRANSMISSION-MODE-TRUE-TIMING><CYCLIC-TIMING><TIME-PERIOD><VALUE>' + num(p.cycleMs / 1000) + '</VALUE></TIME-PERIOD></CYCLIC-TIMING></TRANSMISSION-MODE-TRUE-TIMING></TRANSMISSION-MODE-DECLARATION></I-PDU-TIMING></I-PDU-TIMING-SPECIFICATIONS>');
    if (rows.length) {
      w('<I-SIGNAL-TO-PDU-MAPPINGS>');
      rows.forEach((r) => w('<I-SIGNAL-TO-I-PDU-MAPPING><SHORT-NAME>' + r.name + '</SHORT-NAME><I-SIGNAL-REF DEST="I-SIGNAL">' + R + '/ISignals/' + r.name + '</I-SIGNAL-REF><PACKING-BYTE-ORDER>' + (r.s.byteOrder === "motorola" ? "MOST-SIGNIFICANT-BYTE-FIRST" : "MOST-SIGNIFICANT-BYTE-LAST") + '</PACKING-BYTE-ORDER><START-POSITION>' + r.s.startBit + '</START-POSITION></I-SIGNAL-TO-I-PDU-MAPPING>'));
      w('</I-SIGNAL-TO-PDU-MAPPINGS>');
    }
    w('<UNUSED-BIT-PATTERN>0</UNUSED-BIT-PATTERN></I-SIGNAL-I-PDU>');
  }
  w('</ELEMENTS></AR-PACKAGE>');

  // ECU instances: controller + connector + I-PDU ports (OUT for PDUs the node sends, IN for PDUs it receives)
  const sends = new Map(), recvs = new Map();
  pdus.forEach((p) => { if (p.sender) (sends.get(p.sender) || sends.set(p.sender, []).get(p.sender)).push(p.id); (p.receivers || []).forEach((r) => (recvs.get(r) || recvs.set(r, []).get(r)).push(p.id)); });
  const portRef = (node, id, dir) => R + '/EcuInstances/' + ecuName.get(node) + '/' + ecuName.get(node) + '_Connector/' + (dir === "OUT" ? "Tx_" : "Rx_") + pduName.get(id);
  w('<AR-PACKAGE><SHORT-NAME>EcuInstances</SHORT-NAME><ELEMENTS>');
  for (const n of nodes) {
    const en = ecuName.get(n.name), tx = (sends.get(n.name) || []), rx = (recvs.get(n.name) || []);
    w('<ECU-INSTANCE><SHORT-NAME>' + en + '</SHORT-NAME><DESC><L-2 L="EN">K-Matrix node ' + xe(n.name) + (n.ecu ? ' — Topology ' + xe(n.ecu) + (n.mcu ? ' (chip ' + xe(n.mcu) + ')' : '') : '') + (n.mac ? '; MAC ' + xe(n.mac) : '') + '</L-2></DESC>');
    w('<COMM-CONTROLLERS><ETHERNET-COMMUNICATION-CONTROLLER><SHORT-NAME>' + en + '_EthCtrl</SHORT-NAME>' + (n.mac ? '<ETHERNET-COMMUNICATION-CONTROLLER-VARIANTS><ETHERNET-COMMUNICATION-CONTROLLER-CONDITIONAL><MAC-UNICAST-ADDRESS>' + xe(n.mac) + '</MAC-UNICAST-ADDRESS></ETHERNET-COMMUNICATION-CONTROLLER-CONDITIONAL></ETHERNET-COMMUNICATION-CONTROLLER-VARIANTS>' : '') + '</ETHERNET-COMMUNICATION-CONTROLLER></COMM-CONTROLLERS>');
    w('<CONNECTORS><ETHERNET-COMMUNICATION-CONNECTOR><SHORT-NAME>' + en + '_Connector</SHORT-NAME><COMM-CONTROLLER-REF DEST="ETHERNET-COMMUNICATION-CONTROLLER">' + R + '/EcuInstances/' + en + '/' + en + '_EthCtrl</COMM-CONTROLLER-REF>');
    if (tx.length || rx.length) { w('<ECU-COMM-PORT-INSTANCES>'); tx.forEach((id) => w('<I-PDU-PORT><SHORT-NAME>Tx_' + pduName.get(id) + '</SHORT-NAME><COMMUNICATION-DIRECTION>OUT</COMMUNICATION-DIRECTION></I-PDU-PORT>')); rx.forEach((id) => w('<I-PDU-PORT><SHORT-NAME>Rx_' + pduName.get(id) + '</SHORT-NAME><COMMUNICATION-DIRECTION>IN</COMMUNICATION-DIRECTION></I-PDU-PORT>')); w('</ECU-COMM-PORT-INSTANCES>'); }
    w('</ETHERNET-COMMUNICATION-CONNECTOR></CONNECTORS></ECU-INSTANCE>');
  }
  w('</ELEMENTS></AR-PACKAGE>');

  // Cluster
  const ch = R + '/Clusters/' + sysName + '/' + sysName + '_Channel';
  w('<AR-PACKAGE><SHORT-NAME>Clusters</SHORT-NAME><ELEMENTS><ETHERNET-CLUSTER><SHORT-NAME>' + sysName + '</SHORT-NAME><ETHERNET-CLUSTER-VARIANTS><ETHERNET-CLUSTER-CONDITIONAL><PHYSICAL-CHANNELS><ETHERNET-PHYSICAL-CHANNEL><SHORT-NAME>' + sysName + '_Channel</SHORT-NAME>');
  w('<COMM-CONNECTORS>' + nodes.map((n) => '<COMMUNICATION-CONNECTOR-REF-CONDITIONAL><COMMUNICATION-CONNECTOR-REF DEST="ETHERNET-COMMUNICATION-CONNECTOR">' + R + '/EcuInstances/' + ecuName.get(n.name) + '/' + ecuName.get(n.name) + '_Connector</COMMUNICATION-CONNECTOR-REF></COMMUNICATION-CONNECTOR-REF-CONDITIONAL>').join("") + '</COMM-CONNECTORS>');
  if (sigRows.length) { w('<I-SIGNAL-TRIGGERINGS>'); sigRows.forEach((r) => w('<I-SIGNAL-TRIGGERING><SHORT-NAME>ST_' + r.name + '</SHORT-NAME><I-SIGNAL-REF DEST="I-SIGNAL">' + R + '/ISignals/' + r.name + '</I-SIGNAL-REF></I-SIGNAL-TRIGGERING>')); w('</I-SIGNAL-TRIGGERINGS>'); }
  const endpoints = nodes.filter((n) => n.ipv4 || n.ipv6);
  if (endpoints.length) {
    w('<NETWORK-ENDPOINTS>');
    endpoints.forEach((n) => w('<NETWORK-ENDPOINT><SHORT-NAME>NE_' + ecuName.get(n.name) + '</SHORT-NAME><NETWORK-ENDPOINT-ADDRESSES>' + (n.ipv4 ? '<IPV-4-CONFIGURATION><IPV-4-ADDRESS>' + xe(n.ipv4) + '</IPV-4-ADDRESS><IPV-4-ADDRESS-SOURCE>FIXED</IPV-4-ADDRESS-SOURCE></IPV-4-CONFIGURATION>' : '') + (n.ipv6 ? '<IPV-6-CONFIGURATION><IPV-6-ADDRESS>' + xe(expandIpv6(n.ipv6)) + '</IPV-6-ADDRESS><IPV-6-ADDRESS-SOURCE>FIXED</IPV-6-ADDRESS-SOURCE></IPV-6-CONFIGURATION>' : '') + '</NETWORK-ENDPOINT-ADDRESSES></NETWORK-ENDPOINT>'));
    w('</NETWORK-ENDPOINTS>');
  }
  w('<PDU-TRIGGERINGS>');
  for (const p of pdus) {
    const pn = pduName.get(p.id), ports = [...(p.sender && ecuName.has(p.sender) ? [portRef(p.sender, p.id, "OUT")] : []), ...(p.receivers || []).filter((r) => ecuName.has(r)).map((r) => portRef(r, p.id, "IN"))];
    w('<PDU-TRIGGERING><SHORT-NAME>PT_' + pn + '</SHORT-NAME>' + (ports.length ? '<I-PDU-PORT-REFS>' + ports.map((x) => '<I-PDU-PORT-REF DEST="I-PDU-PORT">' + x + '</I-PDU-PORT-REF>').join("") + '</I-PDU-PORT-REFS>' : '') + '<I-PDU-REF DEST="I-SIGNAL-I-PDU">' + R + '/Pdus/' + pn + '</I-PDU-REF>' + ((byPdu.get(p.id) || []).length ? '<I-SIGNAL-TRIGGERINGS>' + byPdu.get(p.id).map((r) => '<I-SIGNAL-TRIGGERING-REF-CONDITIONAL><I-SIGNAL-TRIGGERING-REF DEST="I-SIGNAL-TRIGGERING">' + ch + '/ST_' + r.name + '</I-SIGNAL-TRIGGERING-REF></I-SIGNAL-TRIGGERING-REF-CONDITIONAL>').join("") + '</I-SIGNAL-TRIGGERINGS>' : '') + '</PDU-TRIGGERING>');
  }
  w('</PDU-TRIGGERINGS>');
  w('</ETHERNET-PHYSICAL-CHANNEL></PHYSICAL-CHANNELS></ETHERNET-CLUSTER-CONDITIONAL></ETHERNET-CLUSTER-VARIANTS></ETHERNET-CLUSTER></ELEMENTS></AR-PACKAGE>');

  w('</AR-PACKAGES></AR-PACKAGE></AR-PACKAGES></AUTOSAR>');
  return { xml: o.join("\n") + "\n", stats: { pdus: pdus.length, signals: sigRows.length, ecuInstances: nodes.length, compuMethods: cms.size, skippedNoLayout: skipped } };
}
