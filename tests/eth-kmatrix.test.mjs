// Run: node tests/eth-kmatrix.test.mjs
// Ethernet backbone K-Matrix: reading the released workbook layout, merging partial workbooks, checks, and round trip.
import { parseWorkbook, mergeEth, checkEth, toWorkbook, emptyEth, parseId, fmtId, ethStats, applyAliases, ethPath, parseDissector, signalBits, sharedBitSignals, packEth, unpackEth, toDissector, ecuSignals, bmTypeForBus, bindingStatus } from "../src/lib/ethKmatrix.js";

let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };

// A small workbook in the released layout (header rows as in the ETH K-Matrix; values are test data, not vehicle data).
const sheets = {
  Cover: [["ETH K-Matrix"]],
  Nodes: [["Name", "Mac address", "IPv4 address", "IPv6 address", "Receive Port", "Transmit Port"],
    ["NodeA", "02:00:00:00:00:01", "10.0.0.1", "fd00::1", 20000, 20000],
    ["NodeB", "02:00:00:00:00:02", "10.0.0.2", "fd00::2", 20000, 20000],
    ["NodeC", "02:00:00:00:00:02", "10.0.0.2", "fd00::2", 20001, 20001]],
  Messages: [["Message ID", "PDU type", "Send type", "Cycle time", "Sender", "Receiver"],
    ["0x1", "Status_A", "cyclic", 100, "NodeA", "NodeB,NodeC"],
    ["0x2", "Event_B", "spontaneous", "", "NodeB", "NodeA"]],
  BackboneETH: [["", "", "Frames"], ["ID", "Frame", "Frame Type", "Cycle Time", "Frame Layout", "Source IP Address", "Source Service Port", "Dest IP Address", "Dest Service Port", "IP Address Type", "Header + Payload (Byte)", "PDUs", "Signal", "Start bit", "Length (bit)", "NodeA", "NodeB"],
    ["0x1", "Status_A", "Unicast", 100, "UDP", "fd00::1", 20000, "fd00::2", 20000, "IPv6", 16, "Status_A", "speed", 0, 16, "S", "R"],
    ["0x1", "Status_A", "Unicast", 100, "UDP", "fd00::1", 20000, "fd00::2", 20000, "IPv6", 16, "Status_A", "mode", 16, 8, "S", "R"]],
};

// --- ids
ok(parseId("0x1A") === 26 && parseId("7") === 7 && parseId("") === null && fmtId(26) === "0x1A", "message IDs parse as hex or decimal and print as hex");

// --- parsing
const { eth, warnings } = parseWorkbook(sheets);
ok(!warnings.length, "the released layout is recognised without warnings" + (warnings.length ? " — " + warnings.join("; ") : ""));
ok(eth.nodes.length === 3 && eth.nodes[0].mac === "02:00:00:00:00:01" && eth.nodes[0].rxPort === 20000, "Nodes sheet: names, MAC, addresses and ports are read");
const a = eth.pdus.find((p) => p.id === 1);
ok(a && a.name === "Status_A" && a.cycleMs === 100 && a.sender === "NodeA" && a.receivers.join() === "NodeB,NodeC", "Messages sheet: ID, name, cycle, sender and receivers are read");
ok(a.frame.layout === "UDP" && a.frame.dstPort === 20000 && a.frame.payloadBytes === 16 && a.frame.ipType === "IPv6", "BackboneETH sheet: frame layout, ports and payload are read");
ok(a.signals.length === 2 && a.signals[0].name === "speed" && a.signals[0].length === 16 && a.signals[0].roles.NodeA === "S" && a.signals[0].roles.NodeB === "R", "signals and their S/R roles per node are read");
ok(eth.pdus.find((p) => p.id === 2).signals.length === 0, "a PDU without signals yet is kept (signals are added later)");

// --- checks
const f = checkEth(eth);
ok(f.some((x) => /MAC 02:00:00:00:00:02 is used by NodeB, NodeC/.test(x.msg)) && f.some((x) => /IPv4 10\.0\.0\.2/.test(x.msg)), "duplicate MAC / IP addresses are flagged");
ok(f.some((x) => /0x2 Event_B: no message ID/.test(x.msg)) === false && !f.some((x) => x.sev === "error"), "a clean matrix has no errors (only the duplicate-address warnings)");
const bad = JSON.parse(JSON.stringify(eth)); bad.pdus[0].signals[1].startBit = 8; bad.pdus[0].signals[0].length = 200; bad.pdus.push({ id: 1, name: "Clash", sender: "Nobody", receivers: [], signals: [], frame: {} });
const fb = checkEth(bad).map((x) => x.msg).join("\n");
ok(/overlap/.test(fb) && /beyond the 128-bit payload/.test(fb), "overlapping signals and payload overflow are errors");
ok(/Message ID 0x1 is used by Status_A, Clash/.test(fb) && /sender Nobody is not in the Nodes sheet/.test(fb), "duplicate message IDs and unknown senders are flagged");

// --- merging partial workbooks
const part2 = { nodes: [{ name: "NodeA", mac: "02:00:00:00:00:99", ipv4: "", ipv6: "", rxPort: null, txPort: null }, { name: "NodeD", mac: "02:00:00:00:00:04", ipv4: "10.0.0.4", ipv6: "", rxPort: 20000, txPort: 20000 }],
  pdus: [{ id: 2, name: "Event_B", sendType: "", cycleMs: null, sender: "", receivers: [], frame: { payloadBytes: 8 }, signals: [{ name: "flag", startBit: 0, length: 1, roles: { NodeB: "S" } }] },
    { id: 3, name: "New_C", sendType: "cyclic", cycleMs: 20, sender: "NodeD", receivers: ["NodeA"], frame: {}, signals: [] }] };
const { eth: merged, report } = mergeEth(eth, part2);
ok(merged.nodes.length === 4 && report.added.nodes === 1 && report.added.pdus === 1, "merge adds new nodes and PDUs");
ok(merged.pdus.find((p) => p.id === 2).signals.length === 1 && merged.pdus.find((p) => p.id === 2).frame.payloadBytes === 8 && report.added.signals === 1, "merge adds signals to an existing PDU and fills blank frame fields");
ok(merged.nodes.find((n) => n.name === "NodeA").mac === "02:00:00:00:00:01" && report.conflicts.some((c) => c.where === "Node NodeA" && c.field === "mac"), "a differing value is NOT overwritten — it is reported as a conflict");
ok(eth.nodes.length === 3, "merging does not modify the original matrix");
ok(mergeEth(emptyEth(), eth).eth.pdus.length === eth.pdus.length, "merging into an empty matrix imports everything");

// --- round trip through the released layout
const wb = toWorkbook(merged);
ok(["Legend", "Nodes", "Messages", "BackboneETH"].every((k) => Array.isArray(wb[k])), "export writes Legend, Nodes, Messages and BackboneETH sheets");
const back = parseWorkbook(wb).eth;
ok(JSON.stringify(ethStats(back)) === JSON.stringify(ethStats(merged)), "export → import keeps every node, PDU and signal (" + JSON.stringify(ethStats(merged)) + ")");
const sb = back.pdus.find((p) => p.id === 1).signals.find((s) => s.name === "mode");
ok(sb && sb.startBit === 16 && sb.length === 8 && sb.roles.NodeA === "S", "signal layout and roles survive the round trip");

// --- topology: nodes map to Topology ECUs; PDUs must have an Ethernet path
const topo = { ethLinks: [["ECU-CCU", "ECU-CZM"], ["ECU-CZM", "ECU-FZM"], ["ECU-CCU", "ECU-ADAS"]], names: { "ECU-CCU": "CCU", "ECU-CZM": "CZM", "ECU-FZM": "FZM", "ECU-ADAS": "ADAS", "ECU-BEC": "BEC" } };
ok(JSON.stringify(ethPath(topo, "ECU-ADAS", "ECU-FZM")) === JSON.stringify(["ECU-ADAS", "ECU-CCU", "ECU-CZM", "ECU-FZM"]), "an Ethernet path is found through the Topology (ADAS \u2192 CCU \u2192 CZM \u2192 FZM)");
const t1 = JSON.parse(JSON.stringify(eth));
const n = applyAliases(t1, [{ re: /^NodeA$/, ecu: "ECU-CZM", mcu: "A" }, { re: /^NodeB$/, ecu: "ECU-CCU" }, { re: /^NodeC$/, ecu: "ECU-BEC" }]);
ok(n === 3 && t1.nodes[0].ecu === "ECU-CZM" && t1.nodes[0].mcu === "A" && t1.nodes[0].ecuSource === "alias", "name rules map nodes to Topology ECUs and chips");
const ft = checkEth(t1, topo).map((x) => x.msg).join("\n");
ok(/NodeC is mapped to BEC, which has no Ethernet link in the Topology/.test(ft), "a node on an ECU without an Ethernet link is an error");
ok(!/no Ethernet path/.test(ft.split("\n").filter((l) => /Status_A/.test(l)).join()), "a PDU whose sender and receivers are connected passes");
t1.nodes.push({ name: "NodeE", ecu: "ECU-DLC" }); t1.pdus[0].receivers.push("NodeE"); const topo2 = { ...topo, ethLinks: [...topo.ethLinks, ["ECU-X", "ECU-DLC"]] };
ok(/no Ethernet path in the Topology from NodeA \(CZM\) to NodeE/.test(checkEth(t1, topo2).map((x) => x.msg).join("\n")), "a receiver the sender cannot reach over Topology Ethernet links is an error");
ok(checkEth(eth, topo).some((x) => /is not mapped to a Topology ECU/.test(x.msg)), "unmapped nodes are flagged");
applyAliases(t1, [{ re: /^NodeA$/, ecu: "ECU-CCU" }]); ok(t1.nodes[0].ecu === "ECU-CZM", "rules never overwrite a mapping that is already set");


// --- Wireshark dissector import (synthetic example in the generated-dissector style; not vehicle data)
const LUA = [
  'demo_protocol = Proto("Demo_UDP",  "Demo UDP")', 'local CONSTANTS = {', '    "VALS_Lamp", {', '    [0] = "off",', '    [1] = "on",', '    },', '}',
  'Lamp_field = ProtoField.uint8("Demo_UDP.Lamp", "Lamp", base.DEC, CONSTANTS["VALS_Lamp"])',
  'Speed_field = ProtoField.float("Demo_UDP.Speed", "Speed", base.DEC)', 'Temp_field = ProtoField.int16("Demo_UDP.Temp", "Temp", base.DEC)', 'Volt_field = ProtoField.float("Demo_UDP.Volt", "Volt", base.DEC)',
  'Moving_field = ProtoField.uint8("Demo_UDP.Moving", "Moving", base.DEC)', 'MuxA_field = ProtoField.uint8("Demo_UDP.MuxA", "MuxA", base.DEC)', 'MuxB_field = ProtoField.uint8("Demo_UDP.MuxB", "MuxB", base.DEC)',
  'local message_table = {}',
  'message_table[0x00000010] = function(header_tree, pinfo, tree, buffer, byte_index)', '    -- CZC_Demo',
  '      -- Signal Lamp', '      signals.Lamp = bit.bor(signals.Lamp, bit.rshift(bit.band(buffer(byte_index + 8, 1):uint(), 0x3), 0))', '      msg_tree:add_le(Lamp_field, signals.Lamp)',
  '      -- Signal Speed', '      signals.Speed = bit.bor(signals.Speed, bit.rshift(bit.band(buffer(byte_index + 8, 1):uint(), 0xFC), 2))', '      signals.Speed = bit.bor(signals.Speed, bit.lshift(bit.band(buffer(byte_index + 9, 1):uint(), 0x3F), 6))',
  '      msg_tree:add_le(Speed_field, (signals.Speed * 0.01) + -5)',
  '      -- Signal Temp', '      signals.Temp = bit.bor(signals.Temp, bit.rshift(bit.band(buffer(byte_index + 10, 1):uint(), 0xFF), 0))', '      -- Sign extend signed integer', '      msg_tree:add_le(Temp_field, signals.Temp)',
  '      -- Signal Volt', '      signals.Volt = bit.bor(signals.Volt, bit.rshift(bit.band(buffer(byte_index + 12, 1):uint(), 0xFF), 0))', '      signals.Volt = bit.bor(signals.Volt, bit.lshift(bit.band(buffer(byte_index + 13, 1):uint(), 0xFF), 8))',
  '      signals.Volt = bit.bor(signals.Volt, bit.lshift(bit.band(buffer(byte_index + 14, 1):uint(), 0xFF), 16))', '      signals.Volt = bit.bor(signals.Volt, bit.lshift(bit.band(buffer(byte_index + 15, 1):uint(), 0xFF), 24))', '      -- IEEE float support', '    end',
  'message_table[0x00000011] = function(header_tree, pinfo, tree, buffer, byte_index)', '    -- VDM_Demo',
  '      -- Signal Moving', '      signals.Moving = bit.bor(signals.Moving, bit.lshift(bit.band(buffer(byte_index + 11, 1):uint(), 0x1), 1))', '      signals.Moving = bit.bor(signals.Moving, bit.rshift(bit.band(buffer(byte_index + 12, 1):uint(), 0x80), 7))', '      msg_tree:add(Moving_field, signals.Moving)', '    end',
  'message_table[0x00000012] = function(header_tree, pinfo, tree, buffer, byte_index)', '    -- SMD_Mux',
  '      -- Signal MuxA', '      signals.MuxA = bit.bor(signals.MuxA, bit.rshift(bit.band(buffer(byte_index + 9, 1):uint(), 0xFF), 0))',
  '      -- Signal MuxB', '      signals.MuxB = bit.bor(signals.MuxB, bit.rshift(bit.band(buffer(byte_index + 9, 1):uint(), 0xFF), 0))', '    end',
  'local udp_port = DissectorTable.get("udp.port")', 'udp_port:add(20000, demo_protocol)'].join("\n");

// --- released-layout details: a group-heading row above the header, "Layer 4 Payload [Byte]", a PDU listed once per receiver
const rel = parseWorkbook({
  Nodes: [["Name", "Mac address", "IPv4 address", "IPv6 address", "Receive Port", "Transmit Port"], ["A", "02:00:00:00:00:0A", "", "fd00::a", 20000, 20000], ["B", "02:00:00:00:00:0B", "", "fd00::b", 20000, 20000], ["C", "02:00:00:00:00:0C", "", "fd00::c", 20000, 20000]],
  Messages: [["Message ID", "PDU type", "Send type", "Cycle time", "Sender", "Receiver"], ["", "Diag_req", "", "", "A", "B"], ["", "Diag_req", "", "", "A", "C"], ["0x7", "Stat", "cyclic", 50, "A", "B"]],
  BackboneETH: [["Frames", "", "", "", "", "", "", "", "", "", "", "PDUs", "Signal", "Comment", "", "Nodes"], ["ID", "Frame", "Frame Type", "Cycle Time", "Frame Layout", "Source IP Address", "Source Service-Port", "Dest IP Address", "Dest Service Port", "IP Address Type", "Layer 4 Payload [Byte]", "PDU", "Signal", "Comment", "", "A", "B", "C"],
    [], ["0x7", "Stat", "Unicast", 50, "TCP", "fd00::a", 42557, "fd00::b", 42557, "IPv6", 12, "Stat", "flag", "", "", "S", "R", ""]] }).eth;
const st7 = rel.pdus.find((p) => p.id === 7), dq = rel.pdus.find((p) => p.name === "Diag_req");
ok(rel.pdus.length === 2 && st7.frame.layout === "TCP" && st7.frame.dstPort === 42557 && st7.frame.payloadBytes === 12 && st7.signals[0].roles.A === "S", "released layout: the real header is found under a group-heading row; Layer 4 payload and roles are read");
ok(dq.receivers.join() === "B,C" && dq.sender === "A", "a PDU listed on several rows (one per receiver) keeps all its receivers");
const dis = parseDissector(['message_table[0x00000007] = function(header_tree, pinfo, tree, buffer, byte_index)', '    -- A_Stat', '      -- Signal flag', '      signals.flag = bit.bor(signals.flag, bit.rshift(bit.band(buffer(byte_index + 8, 1):uint(), 0x1), 0))', '    end'].join("\n")).eth;
const o1 = mergeEth(mergeEth(emptyEth(), dis).eth, rel), o2 = mergeEth(mergeEth(emptyEth(), rel).eth, dis);
const s1 = o1.eth.pdus.find((p) => p.id === 7), s2 = o2.eth.pdus.find((p) => p.id === 7);
ok(s1.name === "Stat" && s2.name === "Stat" && s1.dissectorName === "A_Stat" && s2.dissectorName === "A_Stat" && !o1.report.conflicts.length && !o2.report.conflicts.length && s1.signals[0].startBit === 0 && s2.signals[0].startBit === 0 && s1.frame.layout === "TCP", "K-Matrix name wins over the generated dissector name in either import order; layout comes from the dissector, transport from the K-Matrix");
const same = JSON.parse(JSON.stringify(rel)); same.nodes.forEach((n) => { n.ecu = "ECU-CCU"; }); same.nodes[1].mac = same.nodes[0].mac;
ok(!checkEth(same).some((x) => /MAC/.test(x.msg)), "a shared MAC on two endpoints of the same ECU is not flagged");
const dz = parseDissector(LUA), dd = dz.eth, P = (id) => dd.pdus.find((p) => p.id === id), S = (id, n) => P(id).signals.find((x) => x.name === n);
ok(dd.pdus.length === 3 && dd.source.udpPort === 20000 && P(0x10).name === "CZC_Demo" && P(0x10).senderHint === "CZC" && P(0x10).frame.dstPort == null && P(0x10).nameSource === "dissector", "dissector: PDUs, names, UDP port and the sender hint (never the sender) are read; frame transport is left to the K-Matrix");
ok(S(0x10, "Lamp").startBit === 0 && S(0x10, "Lamp").length === 2 && S(0x10, "Lamp").vt === "Lamp" && dd.valueTables.Lamp["1"] === "on", "dissector: bit field + value table");
ok(S(0x10, "Speed").startBit === 2 && S(0x10, "Speed").length === 12 && S(0x10, "Speed").factor === 0.01 && S(0x10, "Speed").offset === -5 && S(0x10, "Speed").type === "unsigned", "dissector: multi-byte little-endian signal with factor/offset (a scaled integer is not an IEEE float)");
ok(S(0x10, "Temp").type === "signed" && S(0x10, "Volt").type === "float" && S(0x10, "Volt").startBit === 32 && S(0x10, "Volt").length === 32, "dissector: signed integers and IEEE floats");
const mv = S(0x11, "Moving"); ok(mv.byteOrder === "motorola" && mv.startBit === 24 && mv.length === 2 && signalBits(mv).join() === "24,39", "dissector: big-endian signal gets a DBC-style MSB start bit and the right bit set");
ok(P(0x12).sharedBits === 2 && sharedBitSignals(P(0x10).signals) === 0 && dz.warnings.some((w) => /multiplexed/.test(w)), "dissector: signals sharing bits are flagged as multiplexed, not as overlap errors");
const fz = checkEth(dd).map((x) => x.msg).join("\n"); ok(!/overlap/.test(fz) && /SMD_Mux: 2 signals share bit positions/.test(fz) && /CZC_Demo: no sender\. \(The name suggests CZC\.\)/.test(fz), "checks: shared bits reported once per PDU; missing sender shows the hint");
const bad2 = JSON.parse(JSON.stringify(dd)); bad2.pdus[0].signals[1].startBit = 1; ok(/CZC_Demo: signals Lamp and Speed overlap/.test(checkEth(bad2).map((x) => x.msg).join("\n")), "checks: a real overlap is still an error");
const mz = mergeEth(mergeEth(emptyEth(), dd).eth, dd); ok(mz.report.conflicts.length === 0 && mz.report.added.signals === 0 && mz.eth.valueTables.Lamp, "dissector import merges idempotently and keeps value tables");

// --- generating BackboneETH.lua: the importer reads the generated file back without loss
const genLua = toDissector(dd), backL = parseDissector(genLua).eth, keyS = (s) => [s.name, s.startBit, s.length, s.byteOrder || "intel", s.type, s.factor ?? 1, s.offset ?? 0, s.vt || ""].join("|");
ok(dd.pdus.every((p) => p.signals.filter((s) => s.startBit != null).every((s) => { const b = backL.pdus.find((x) => x.id === p.id).signals.find((x) => x.name === s.name); return b && keyS(b) === keyS(s); })), "generated dissector round-trips every signal (position, byte order, type, scaling, value table)");
ok(/udp_port:add\(20000/.test(genLua) && /-- Sign extend signed integer/.test(genLua) && /ieee754_single\(v\)/.test(genLua) && /F\["Lamp"\] = ProtoField\.uint8\("Demo_UDP\.Lamp", "Lamp", base\.DEC, VALS\["Lamp"\]\)/.test(genLua), "generated dissector: port binding, sign extension, IEEE floats and value tables");
ok(JSON.stringify(backL.valueTables) === JSON.stringify(dd.valueTables), "generated dissector keeps the value tables");

// --- Behavior Model binding: what an ECU receives / sends on the backbone
const bnd = JSON.parse(JSON.stringify(dd)); bnd.nodes = [{ name: "CZC_1", ecu: "ECU-CZM" }, { name: "XMM", ecu: "ECU-CCU" }];
bnd.pdus[0].sender = "CZC_1"; bnd.pdus[0].receivers = ["XMM"]; bnd.pdus[1].sender = "XMM"; bnd.pdus[1].receivers = ["CZC_1"];
const czIn = ecuSignals(bnd, "ECU-CZM", "in"), czOut = ecuSignals(bnd, "ECU-CZM", "out");
ok(czIn.map((x) => x.signal).join() === "Moving" && czOut.some((x) => x.signal === "Speed" && x.factor === 0.01) && !czOut.some((x) => x.signal === "Moving"), "ECU signals: inputs = PDUs the ECU receives, outputs = PDUs it sends");
ok(bmTypeForBus({ length: 1 }).baseType === "boolean" && bmTypeForBus({ length: 12, type: "unsigned" }).max === 4095 && bmTypeForBus({ length: 8, type: "signed" }).min === -128 && bmTypeForBus({ length: 32, type: "float" }).baseType === null, "bus signal -> Behavior Model type (raw range; floats refused)");
const bus = czIn[0]; ok(bindingStatus(bnd, bus) === "ok", "a fresh binding is ok");
const bnd2 = JSON.parse(JSON.stringify(bnd)); bnd2.pdus[1].signals[0].startBit = 30; ok(bindingStatus(bnd2, bus) === "changed", "a binding whose signal layout changed in the K-Matrix is flagged");
bnd2.pdus[1].signals = []; ok(bindingStatus(bnd2, bus) === "missing", "a binding whose signal left the K-Matrix is flagged");
const packed = await packEth(dd); ok(JSON.stringify(await unpackEth(packed)) === JSON.stringify(dd) && packed.length < JSON.stringify(dd).length * 2, "compressed storage round-trips exactly");
console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
