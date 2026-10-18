// Run: node tests/eth-kmatrix.test.mjs
// Ethernet backbone K-Matrix: reading the released workbook layout, merging partial workbooks, checks, and round trip.
import { parseWorkbook, mergeEth, checkEth, toWorkbook, emptyEth, parseId, fmtId, ethStats } from "../src/lib/ethKmatrix.js";

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

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
