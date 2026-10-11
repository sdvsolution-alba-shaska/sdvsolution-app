// Parsers for the evidence the runner collects: static-analysis findings (GCC diagnostics / cppcheck XML) and
// coverage (gcov JSON). Pure functions — no process spawning — so they are unit-tested against real tool output
// (tests/fixtures/*).

/* ------------------------------ GCC diagnostics ------------------------------ */
// Handles Windows drive-letter paths (C:\…), CWE tags ("[CWE-476] [-Wanalyzer-null-dereference]") and ignores "note:" lines.
export function parseGccDiagnostics(text, { root = "" } = {}) {
  const findings = [], seen = new Set(); const rootN = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = raw.match(/^(.*?):(\d+):(\d+): (warning|error|fatal error): (.*)$/); if (!m) continue;
    let file = m[1].replace(/\\/g, "/"); if (rootN && file.startsWith(rootN + "/")) file = file.slice(rootN.length + 1);
    let msg = m[5], rule = "", cwe = "";
    const tags = [...msg.matchAll(/\s\[([^\]]+)\]/g)].map((x) => x[1]);
    tags.forEach((tg) => { if (/^CWE-\d+$/.test(tg)) cwe = tg; else if (/^-W/.test(tg)) rule = tg; });
    msg = msg.replace(/(\s\[[^\]]+\])+\s*$/, "");
    const f = { tool: "gcc", severity: m[4] === "warning" ? "warning" : "error", file, line: Number(m[2]), col: Number(m[3]), rule, ...(cwe ? { cwe } : {}), message: msg.trim() };
    const key = [f.file, f.line, f.col, f.rule, f.message].join("|"); if (seen.has(key)) continue; seen.add(key); findings.push(f);
  }
  return findings;
}

/* ------------------------------ cppcheck (optional adapter) ------------------------------ */
// cppcheck --xml (version 2): <error id=".." severity="error|warning|style|performance|portability|information" msg=".." cwe="476"><location file=".." line=".." column=".."/></error>
export function parseCppcheckXml(xml) {
  const out = []; const re = /<error\b([^>]*?)(\/>|>([\s\S]*?)<\/error>)/g; let m;
  const attr = (s, k) => { const a = s.match(new RegExp("\\b" + k + '="([^"]*)"')); return a ? a[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : ""; };
  while ((m = re.exec(String(xml || "")))) {
    const a = m[1], body = m[3] || ""; const loc = body.match(/<location\b([^>]*?)\/?>/);
    const sev = attr(a, "severity"); const cwe = attr(a, "cwe");
    out.push({ tool: "cppcheck", severity: sev === "error" ? "error" : sev === "information" ? "info" : "warning", file: loc ? attr(loc[1], "file").replace(/\\/g, "/") : "", line: loc ? Number(attr(loc[1], "line")) || 0 : 0, col: loc ? Number(attr(loc[1], "column")) || 0 : 0, rule: attr(a, "id"), ...(cwe ? { cwe: "CWE-" + cwe } : {}), message: attr(a, "msg") });
  }
  return out;
}

/* ------------------------------ coverage (gcov JSON) ------------------------------ */
const pct = (c, t) => (t ? Math.round((1000 * c) / t) / 10 : null);
// gcov --json-format --stdout prints one JSON document per .gcda; documents may share a file (merge by name).
export function parseGcovJson(text, { only = /^src\// } = {}) {
  const byFile = new Map(); let version = "";
  for (const chunk of String(text || "").split(/\r?\n/)) {
    const s = chunk.trim(); if (!s || s[0] !== "{") continue;
    let doc; try { doc = JSON.parse(s); } catch (e) { continue; }
    version = version || doc.gcc_version || "";
    for (const f of doc.files || []) {
      const name = String(f.file || "").replace(/\\/g, "/"); if (!only.test(name)) continue;
      const cur = byFile.get(name) || { file: name, lines: new Map(), functions: new Map() };
      for (const l of f.lines || []) {
        const e = cur.lines.get(l.line_number) || { line: l.line_number, count: 0, branches: [], conditions: [] };
        e.count += l.count || 0;
        (l.branches || []).forEach((b, i) => { e.branches[i] = { count: ((e.branches[i] || {}).count || 0) + (b.count || 0) }; });
        (l.conditions || []).forEach((c, i) => { const p = e.conditions[i]; e.conditions[i] = p ? { count: c.count, covered: Math.max(p.covered, c.covered) } : { count: c.count, covered: c.covered }; });
        cur.lines.set(l.line_number, e);
      }
      for (const fn of f.functions || []) cur.functions.set(fn.name, (cur.functions.get(fn.name) || 0) + (fn.execution_count || 0));
      byFile.set(name, cur);
    }
  }
  const files = [...byFile.values()].map((f) => {
    const lines = [...f.lines.values()].sort((a, b) => a.line - b.line);
    const lt = lines.length, lc = lines.filter((l) => l.count > 0).length;
    const br = lines.flatMap((l) => l.branches), bt = br.length, bc = br.filter((b) => b.count > 0).length;
    const cd = lines.flatMap((l) => l.conditions), hasCond = cd.length > 0; const ct = cd.reduce((a, c) => a + c.count, 0), cc = cd.reduce((a, c) => a + c.covered, 0);
    return { file: f.file, lines: { covered: lc, total: lt, pct: pct(lc, lt) }, branches: { covered: bc, total: bt, pct: pct(bc, bt) }, conditions: hasCond ? { covered: cc, total: ct, pct: pct(cc, ct) } : null,
      uncoveredLines: lines.filter((l) => l.count === 0).map((l) => l.line),
      uncoveredBranchLines: lines.filter((l) => l.branches.some((b) => b.count === 0)).map((l) => l.line),
      uncoveredConditionLines: lines.filter((l) => l.conditions.some((c) => c.covered < c.count)).map((l) => l.line),
      functionsNeverRun: [...f.functions.entries()].filter(([, n]) => n === 0).map(([n]) => n) };
  });
  const sum = (k) => files.reduce((a, f) => ({ covered: a.covered + (f[k] ? f[k].covered : 0), total: a.total + (f[k] ? f[k].total : 0) }), { covered: 0, total: 0 });
  const L = sum("lines"), B = sum("branches"), C = sum("conditions"), anyCond = files.some((f) => f.conditions);
  return { version, files, totals: { lines: { ...L, pct: pct(L.covered, L.total) }, branches: { ...B, pct: pct(B.covered, B.total) }, conditions: anyCond ? { ...C, pct: pct(C.covered, C.total) } : null } };
}

// Turn a parsed coverage report into the compact record stored with the build, attaching the source text of
// uncovered lines (so a reviewer sees WHAT is not exercised) and an overall "complete" flag.
export function summarizeCoverage(parsed, sources = {}, { cap = 40 } = {}) {
  const uncovered = [];
  for (const f of parsed.files) {
    const text = String(sources[f.file] || "").split(/\r?\n/);
    const add = (lines, kind) => lines.forEach((ln) => { if (uncovered.length < cap) uncovered.push({ file: f.file, line: ln, kind, text: (text[ln - 1] || "").trim().slice(0, 120) }); });
    add(f.uncoveredLines, "line"); add(f.uncoveredBranchLines.filter((l) => !f.uncoveredLines.includes(l)), "branch"); add(f.uncoveredConditionLines.filter((l) => !f.uncoveredLines.includes(l)), "condition");
  }
  const t = parsed.totals; const full = (x) => !x || x.total === 0 || x.covered === x.total;
  return { tool: "gcov " + parsed.version, lines: t.lines, branches: t.branches, conditions: t.conditions, complete: full(t.lines) && full(t.branches) && full(t.conditions), policy: "informational",
    files: parsed.files.map((f) => ({ file: f.file, lines: f.lines, branches: f.branches, conditions: f.conditions, functionsNeverRun: f.functionsNeverRun })), uncovered, uncoveredTruncated: parsed.files.reduce((a, f) => a + f.uncoveredLines.length + f.uncoveredBranchLines.length + f.uncoveredConditionLines.length, 0) > uncovered.length };
}
