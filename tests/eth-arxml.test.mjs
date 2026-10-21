// Run: node tests/eth-arxml.test.mjs
// Backbone ARXML generated from the ETH K-Matrix: structure, AUTOSAR start-position semantics, ECU extract,
// and — when the Python package autosar-data is installed — a strict schema parse with reference check.
import { spawnSync } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { toBackboneArxml, expandIpv6 } from "../src/lib/ethArxml.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };

const eth = { valueTables: { Lamp: { 0: "off", 1: "on", "36028797018963968": "flag55" } } /* quoted: as a JS number this key would lose precision */,
  nodes: [{ name: "CZC_1", ecu: "ECU-CZM", mcu: "A", mac: "02:00:00:00:00:01", ipv6: "fd00::1" }, { name: "XMM", ecu: "ECU-CCU", mac: "02:00:00:00:00:02", ipv4: "10.0.0.2", ipv6: "fd00::2" }, { name: "ADAS_Basic", ecu: "ECU-ADAS", ipv6: "fd00::3" }],
  pdus: [
    { id: 0x10, name: "Zonal_Status", sender: "CZC_1", receivers: ["XMM"], cycleMs: 100, frame: { payloadBytes: 8 }, signals: [
      { name: "Lamp", startBit: 0, length: 2, type: "unsigned", vt: "Lamp", roles: {} },
      { name: "Speed", startBit: 2, length: 12, type: "unsigned", factor: 0.01, offset: -5, roles: {} },
      { name: "Moving", startBit: 24, length: 2, type: "unsigned", byteOrder: "motorola", roles: {} },
      { name: "Volt", startBit: 32, length: 32, type: "float", roles: {} },
      { name: "Zonal_Status_crc", startBit: null, length: null, roles: {} }] },
    { id: 0x20, name: "Status", sender: "ADAS_Basic", receivers: ["XMM"], frame: {}, signals: [{ name: "Speed", startBit: 0, length: 8, type: "signed", roles: {} }] },
    { id: 0x21, name: "Status", sender: "XMM", receivers: ["CZC_1"], frame: {}, signals: [] }] };

ok(expandIpv6("fd53:7cb8:383:0::1f3") === "fd53:7cb8:383:0:0:0:0:1f3" && expandIpv6("::1") === "0:0:0:0:0:0:0:1" && expandIpv6("1:2:3:4:5:6:7:8") === "1:2:3:4:5:6:7:8", "IPv6 addresses are fully expanded for AUTOSAR");
const { xml, stats } = toBackboneArxml(eth);
ok(stats.pdus === 3 && stats.signals === 5 && stats.ecuInstances === 3 && stats.skippedNoLayout === 1, "stats: PDUs, signals with a layout, ECU instances; signals without a bit position are left out and counted");
ok(/<I-SIGNAL-TO-I-PDU-MAPPING><SHORT-NAME>Moving<\/SHORT-NAME>.*?<PACKING-BYTE-ORDER>MOST-SIGNIFICANT-BYTE-FIRST<\/PACKING-BYTE-ORDER><START-POSITION>24<\/START-POSITION>/.test(xml), "big-endian signal: MOST-SIGNIFICANT-BYTE-FIRST with the MSB as start position (AUTOSAR)");
ok(/<SHORT-NAME>Zonal_Status__Speed<\/SHORT-NAME>.*?MOST-SIGNIFICANT-BYTE-LAST<\/PACKING-BYTE-ORDER><START-POSITION>2</.test(xml) && /<SHORT-NAME>Status__Speed<\/SHORT-NAME>/.test(xml), "little-endian start position = LSB; a signal name used in two PDUs gets PDU-qualified names");
ok(/<SHORT-NAME>Status<\/SHORT-NAME>/.test(xml) && /<SHORT-NAME>Status_0x21<\/SHORT-NAME>/.test(xml), "duplicate PDU names are made unique with the message ID");
ok(/<CATEGORY>SCALE_LINEAR_AND_TEXTTABLE<\/CATEGORY>|<CATEGORY>LINEAR<\/CATEGORY>/.test(xml) && /<V>-5<\/V><V>0\.01<\/V>/.test(xml) && /<LOWER-LIMIT INTERVAL-TYPE="CLOSED">36028797018963968<\/LOWER-LIMIT>/.test(xml), "compu methods: linear factor/offset and value tables (large flag keys kept exact)");
ok(/<BASE-TYPE-ENCODING>IEEE754<\/BASE-TYPE-ENCODING>/.test(xml) && /<BASE-TYPE-ENCODING>2C<\/BASE-TYPE-ENCODING>/.test(xml), "network base types: IEEE float and two's-complement signed");
ok(/<IPV-6-ADDRESS>fd00:0:0:0:0:0:0:1<\/IPV-6-ADDRESS>/.test(xml) && /<MAC-UNICAST-ADDRESS>02:00:00:00:00:01<\/MAC-UNICAST-ADDRESS>/.test(xml), "network endpoints and MAC addresses");
ok(/<PDU-TRIGGERING><SHORT-NAME>PT_Zonal_Status<\/SHORT-NAME><I-PDU-PORT-REFS><I-PDU-PORT-REF DEST="I-PDU-PORT">\/SDV_Backbone\/EcuInstances\/CZC_1\/CZC_1_Connector\/Tx_Zonal_Status<\/I-PDU-PORT-REF><I-PDU-PORT-REF DEST="I-PDU-PORT">\/SDV_Backbone\/EcuInstances\/XMM\/XMM_Connector\/Rx_Zonal_Status</.test(xml), "PDU triggering links the sender's OUT port and the receivers' IN ports");
ok(/<TIME-PERIOD><VALUE>0\.1<\/VALUE><\/TIME-PERIOD>/.test(xml), "cycle time in seconds");
const ex = toBackboneArxml(eth, { ecu: "ECU-CZM" });
ok(ex.stats.pdus === 2 && !/Message ID 0x20</.test(ex.xml) && /Message ID 0x21</.test(ex.xml) && /Message ID 0x10</.test(ex.xml) && !/<SHORT-NAME>ADAS_Basic<\/SHORT-NAME>/.test(ex.xml), "ECU extract keeps only PDUs the ECU sends or receives, and only the nodes involved");

const py = spawnSync("python3", ["-c", "import autosar_data"], { encoding: "utf8" });
if (py.status !== 0) console.log("skip strict AUTOSAR parse (python package autosar-data not installed)");
else for (const [label, text] of [["backbone", xml], ["CZM extract", ex.xml]]) {
  const f = path.join(os.tmpdir(), "sdv_eth_" + label.replace(/\W/g, "") + ".arxml"); fs.writeFileSync(f, text);
  const r = spawnSync("python3", ["-c", "import sys, autosar_data as ad\nm = ad.AutosarModel()\nm.load_file(sys.argv[1], strict=True)\nprint(len(m.check_references()))", f], { encoding: "utf8" });
  ok(r.status === 0 && r.stdout.trim() === "0", "strict AUTOSAR parse of the " + label + " with every reference resolved" + (r.status ? " — " + (r.stderr || "").split("\n").slice(-2).join(" ") : ""));
}
console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
