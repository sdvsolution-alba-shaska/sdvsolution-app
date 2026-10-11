// Run: node tests/analysis.test.mjs
// Parsers for static-analysis findings and coverage, tested against REAL tool output captured in tests/fixtures
// (GCC 16.2 diagnostics and gcov JSON from the generated pilot code), plus the cppcheck XML format.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { parseGccDiagnostics, parseCppcheckXml, parseGcovJson, summarizeCoverage } from "../runner/analysis.mjs";
const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures"); const read = (n) => fs.readFileSync(path.join(FX, n), "utf8");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };

// --- GCC diagnostics (real output, Windows paths, CWE tags)
{
  const f = parseGccDiagnostics(read("gcc-diagnostics.txt"));
  ok(f.length === 3, "finds the 3 real warnings and ignores notes / 'In function' lines (" + f.length + ")");
  const sh = f.find((x) => x.rule === "-Wshadow"), sw = f.find((x) => x.rule === "-Wswitch-default"), nd = f.find((x) => x.rule === "-Wanalyzer-null-dereference");
  ok(sh && sh.line === 7 && sh.col === 11 && /shadows a previous local/.test(sh.message), "shadowed declaration: line, column, rule and message");
  ok(sh && /bad\.c$/.test(sh.file) && !/^[A-Za-z]:/.test(sh.file.split("/").slice(-1)[0]), "Windows drive-letter paths parse correctly (the colon in C:\\ doesn't confuse it)");
  ok(sw && sw.severity === "warning" && sw.line === 22, "missing switch default is reported");
  ok(nd && nd.cwe === "CWE-476" && /dereference of NULL/.test(nd.message) && !/\[/.test(nd.message), "the analyzer's null dereference carries CWE-476, and the tags are stripped from the message");
  ok(parseGccDiagnostics("").length === 0 && parseGccDiagnostics(null).length === 0, "empty output means no findings");
  const rel = parseGccDiagnostics("/work/job1/src/A.c:3:1: warning: x [-Wall]\n", { root: "/work/job1" }); ok(rel[0].file === "src/A.c", "paths are made relative to the job directory");
  ok(parseGccDiagnostics("src/A.c:3:1: warning: x [-Wall]\nsrc/A.c:3:1: warning: x [-Wall]\n").length === 1, "duplicate diagnostics are collapsed");
  ok(parseGccDiagnostics("src/A.c:9:5: error: unknown type name 'foo'\n")[0].severity === "error", "errors are flagged as errors");
}

// --- cppcheck XML (format v2)
{
  const xml = '<?xml version="1.0"?><results version="2"><cppcheck version="2.13.0"/><errors>' +
    '<error id="nullPointer" severity="error" msg="Null pointer dereference: p" verbose="..." cwe="476"><location file="src/A.c" line="13" column="12"/></error>' +
    '<error id="unreadVariable" severity="style" msg="Variable &apos;q&apos; is assigned a value that is never used."><location file="src\\A.c" line="17" column="9"/></error>' +
    '<error id="checkersReport" severity="information" msg="Active checkers: 30"/></errors></results>';
  const f = parseCppcheckXml(xml);
  ok(f.length === 3 && f[0].severity === "error" && f[0].cwe === "CWE-476" && f[0].line === 13 && f[0].rule === "nullPointer", "cppcheck error with CWE and location");
  ok(f[1].severity === "warning" && f[1].file === "src/A.c" && /'q'/.test(f[1].message), "style finding: backslash path normalised, XML entities decoded");
  ok(f[2].severity === "info" && f[2].line === 0, "information entries without a location are tolerated (and not counted as problems)");
}

// --- gcov JSON (real output)
{
  const full = parseGcovJson(read("gcov-full.json"));
  ok(full.version === "16.2.0" && full.files.length === 1 && full.files[0].file === "src/MirrorHeating.c", "full coverage fixture: one production file, version read");
  ok(full.totals.lines.covered === 77 && full.totals.lines.total === 77 && full.totals.lines.pct === 100, "lines 77/77 = 100%");
  ok(full.totals.branches.covered === 43 && full.totals.branches.total === 43, "branches 43/43");
  ok(full.totals.conditions && full.totals.conditions.covered === 38 && full.totals.conditions.total === 38, "conditions (MC/DC-style) 38/38");
  ok(full.files[0].uncoveredLines.length === 0 && full.files[0].functionsNeverRun.length === 0, "nothing uncovered, every function ran");
  const s = summarizeCoverage(full, {}); ok(s.complete === true && s.uncovered.length === 0 && s.policy === "informational", "summary: complete, nothing listed, policy is informational");

  const part = parseGcovJson(read("gcov-partial.json"));
  ok(part.totals.lines.covered === 75 && part.totals.lines.total === 82, "partial fixture: 75/82 lines (" + part.totals.lines.covered + "/" + part.totals.lines.total + ")");
  ok(part.totals.conditions === null, "no --conditions data → conditions reported as unavailable (null), not as 100% or 0%");
  ok(part.files[0].uncoveredLines.join() === "24,113,114,115,130,152,153", "the uncovered lines are exactly the ones from the real run");
  ok(part.files[0].functionsNeverRun.join() === "MirrorHeating_GetStateTimeMs", "the never-executed function is named");
  const src = Array.from({ length: 160 }, (_, i) => "source line " + (i + 1)).join("\n");
  const sp = summarizeCoverage(part, { "src/MirrorHeating.c": src }); ok(sp.complete === false && sp.uncovered.some((u) => u.line === 113 && u.text === "source line 113" && u.kind === "line"), "summary: incomplete, and uncovered lines carry their source text");
  ok(sp.uncovered.some((u) => u.kind === "branch"), "summary also lists lines whose branches are untaken");
  ok(summarizeCoverage(part, {}, { cap: 3 }).uncovered.length === 3 && summarizeCoverage(part, {}, { cap: 3 }).uncoveredTruncated === true, "long lists are capped and flagged as truncated");
  ok(parseGcovJson(read("gcov-full.json") + "\n" + read("gcov-partial.json")).files.length === 1, "documents for the same file merge (several .gcda inputs)");
  ok(parseGcovJson(read("gcov-full.json").replace(/"file": "src\//g, '"file": "test/')).files.length === 0, "only production sources (src/) are counted — tests and stubs are excluded");
  ok(parseGcovJson("garbage\n{not json}\n").files.length === 0, "garbage input yields an empty report, not a crash");
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
