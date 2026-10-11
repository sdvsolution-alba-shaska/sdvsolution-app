// SDVsolution — Behavior Model validation, deterministic C generator and unit-test generator (Phase 1).
//
// Pure functions, no React / DOM dependency, so the same module runs in the browser (via
// window.__sdvCodegen, registered in main.jsx), in Node tests, and later inside the build runner.
//
// DESIGN RULES (see SDVsolution_Phase1_Generator_and_Build_Design.md)
//   * Deterministic: same Behavior Model + same GENERATOR_VERSION => byte-identical output.
//   * No AI here. AI may *propose* model content; this module only consumes it.
//   * Everything that can't be generated or tested automatically is reported, never hidden.

export const GENERATOR_VERSION = "0.1.0";
export const TIME_SIGNAL = "state_time_ms"; // built-in: ms spent in the current state (read-only)
const INT32_MAX = 2147483647;

export const TYPES = {
  uint8: { c: "uint8_t", min: 0, max: 255 }, uint16: { c: "uint16_t", min: 0, max: 65535 }, uint32: { c: "uint32_t", min: 0, max: 4294967295 },
  sint8: { c: "int8_t", min: -128, max: 127 }, sint16: { c: "int16_t", min: -32768, max: 32767 }, sint32: { c: "int32_t", min: -2147483648, max: 2147483647 },
  boolean: { c: "boolean", min: 0, max: 1 },
};
const C_KEYWORDS = new Set("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while TRUE FALSE NULL".split(" "));
const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

/* ===================== expression language ===================== */
// Integers, true/false, identifiers; ! - unary; * + - ; < <= > >= ; == != ; && ||. No division, calls, loops or pointers.
export function tokenize(src) {
  const out = []; let i = 0; const s = String(src);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch)) { let j = i; while (j < s.length && /[0-9]/.test(s[j])) j++; if (/[A-Za-z_.]/.test(s[j] || "")) throw new Error("bad number near '" + s.slice(i, j + 1) + "' (integers only)"); out.push({ t: "num", v: parseInt(s.slice(i, j), 10) }); i = j; continue; }
    if (/[A-Za-z_]/.test(ch)) { let j = i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++; out.push({ t: "id", v: s.slice(i, j) }); i = j; continue; }
    const two = s.slice(i, i + 2);
    if (["&&", "||", "==", "!=", "<=", ">="].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("!<>+-*()".includes(ch)) { out.push({ t: "op", v: ch }); i++; continue; }
    throw new Error("unexpected character '" + ch + "'");
  }
  return out;
}
export function parseExpr(src) {
  const tk = tokenize(src); let p = 0;
  const peek = () => tk[p], isOp = (v) => tk[p] && tk[p].t === "op" && tk[p].v === v;
  const eat = (v) => { if (!isOp(v)) throw new Error("expected '" + v + "'"); p++; };
  function prim() {
    const t = tk[p]; if (!t) throw new Error("unexpected end of expression");
    if (t.t === "num") { p++; return { t: "num", v: t.v }; }
    if (t.t === "id") { p++; if (t.v === "true") return { t: "bool", v: true }; if (t.v === "false") return { t: "bool", v: false }; return { t: "id", n: t.v }; }
    if (isOp("(")) { p++; const e = or(); eat(")"); return e; }
    if (isOp("!")) { p++; return { t: "un", op: "!", a: prim() }; }
    if (isOp("-")) { p++; return { t: "un", op: "-", a: prim() }; }
    throw new Error("unexpected '" + t.v + "'");
  }
  const lvl = (next, ops) => () => { let a = next(); while (peek() && peek().t === "op" && ops.includes(peek().v)) { const op = tk[p++].v; a = { t: "bin", op, a, b: next() }; } return a; };
  const mul = lvl(prim, ["*"]), add = lvl(mul, ["+", "-"]), rel = lvl(add, ["<", "<=", ">", ">="]), eq = lvl(rel, ["==", "!="]), and = lvl(eq, ["&&"]), or = lvl(and, ["||"]);
  if (!tk.length) throw new Error("empty expression");
  const ast = or(); if (p < tk.length) throw new Error("unexpected '" + tk[p].v + "'");
  return ast;
}
export function idsOf(ast, acc = new Set()) { if (!ast) return acc; if (ast.t === "id") acc.add(ast.n); if (ast.a) idsOf(ast.a, acc); if (ast.b) idsOf(ast.b, acc); return acc; }

// env: { kind(name) -> 'bool' | 'num' | null }
export function typeOf(ast, env) {
  switch (ast.t) {
    case "num": return "num"; case "bool": return "bool";
    case "id": { const k = env.kind(ast.n); if (!k) throw new Error("unknown name '" + ast.n + "'"); return k; }
    case "un": { const a = typeOf(ast.a, env); if (ast.op === "!") { if (a !== "bool") throw new Error("'!' needs a boolean"); return "bool"; } if (a !== "num") throw new Error("'-' needs a number"); return "num"; }
    case "bin": {
      const a = typeOf(ast.a, env), b = typeOf(ast.b, env), op = ast.op;
      if (op === "&&" || op === "||") { if (a !== "bool" || b !== "bool") throw new Error("'" + op + "' needs booleans"); return "bool"; }
      if (op === "==" || op === "!=") { if (a !== b) throw new Error("'" + op + "' compares a " + a + " with a " + b); return "bool"; }
      if (["<", "<=", ">", ">="].includes(op)) { if (a !== "num" || b !== "num") throw new Error("'" + op + "' needs numbers"); return "bool"; }
      if (a !== "num" || b !== "num") throw new Error("'" + op + "' needs numbers"); return "num";
    }
    default: throw new Error("bad expression");
  }
}
export function evalAst(ast, vars) {
  switch (ast.t) {
    case "num": return ast.v; case "bool": return ast.v;
    case "id": { const v = vars[ast.n]; if (v === undefined) throw new Error("no value for '" + ast.n + "'"); return v; }
    case "un": { const a = evalAst(ast.a, vars); return ast.op === "!" ? !a : -a; }
    case "bin": {
      const a = evalAst(ast.a, vars);
      if (ast.op === "&&") return a && evalAst(ast.b, vars);
      if (ast.op === "||") return a || evalAst(ast.b, vars);
      const b = evalAst(ast.b, vars);
      switch (ast.op) { case "+": return a + b; case "-": return a - b; case "*": return a * b; case "<": return a < b; case "<=": return a <= b; case ">": return a > b; case ">=": return a >= b; case "==": return a === b; case "!=": return a !== b; }
    }
  }
  throw new Error("bad expression");
}
// Interval of a numeric expression (overflow check). env.range(name) -> [lo, hi]
function interval(ast, env) {
  switch (ast.t) {
    case "num": return [ast.v, ast.v];
    case "id": return env.range(ast.n);
    case "un": { const [l, h] = interval(ast.a, env); return [-h, -l]; }
    case "bin": {
      const [al, ah] = interval(ast.a, env), [bl, bh] = interval(ast.b, env);
      if (ast.op === "+") return [al + bl, ah + bh]; if (ast.op === "-") return [al - bh, ah - bl];
      if (ast.op === "*") { const c = [al * bl, al * bh, ah * bl, ah * bh]; return [Math.min(...c), Math.max(...c)]; }
    }
  }
  return [0, 0];
}
function cExpr(ast, env) {
  switch (ast.t) {
    case "num": return "(int32_t)" + (ast.v < 0 ? "(" + ast.v + ")" : ast.v);
    case "bool": return ast.v ? "TRUE" : "FALSE";
    case "id": return env.kind(ast.n) === "bool" ? "(" + ast.n + " != 0u)" : "(int32_t)" + ast.n;
    case "un": return ast.op === "!" ? "(!" + cExpr(ast.a, env) + ")" : "(-" + cExpr(ast.a, env) + ")";
    case "bin": return "(" + cExpr(ast.a, env) + " " + ast.op + " " + cExpr(ast.b, env) + ")";
  }
  return "0";
}
export function exprToString(ast) {
  switch (ast.t) {
    case "num": return String(ast.v); case "bool": return String(ast.v); case "id": return ast.n;
    case "un": return ast.op + exprToString(ast.a);
    case "bin": return "(" + exprToString(ast.a) + " " + ast.op + " " + exprToString(ast.b) + ")";
  }
  return "?";
}

/* ===================== model helpers ===================== */
const clone = (o) => JSON.parse(JSON.stringify(o));
const sigByName = (bm) => Object.fromEntries((bm.signals || []).map((s) => [s.name, s]));
const calByName = (bm) => Object.fromEntries((bm.calibrations || []).map((c) => [c.name, c]));
function makeEnv(bm) {
  const S = sigByName(bm), C = calByName(bm);
  return {
    kind: (n) => { if (n === TIME_SIGNAL) return "num"; const d = S[n] || C[n]; return d ? (d.baseType === "boolean" ? "bool" : "num") : null; },
    range: (n) => { if (n === TIME_SIGNAL) return [0, INT32_MAX]; if (S[n]) return [Number(S[n].min), Number(S[n].max)]; if (C[n]) return [Number(C[n].value), Number(C[n].value)]; return [0, 0]; },
  };
}
export const camel = (s) => String(s || "").replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^[a-z]/, (c) => c.toUpperCase());
export const swcName = (bm) => (bm.target && bm.target.swc) || camel(bm.title) || "Function";
export const portFor = (s) => s.port || ((s.dir === "out" ? "Pp_" : "Rp_") + s.name);
export const elementFor = (s) => s.element || s.name;
export const stateEnum = (bm, id) => swcName(bm) + "_STATE_" + String(id).toUpperCase();

// Stable content hash for the traceability manifest (FNV-1a 32-bit; cheap, sync).
export function modelHash(bm) {
  const keep = { function: bm.function, implements: bm.implements, target: bm.target, signals: bm.signals, calibrations: bm.calibrations, runnable: bm.runnable, stateMachine: bm.stateMachine };
  const str = JSON.stringify(keep); let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ("00000000" + h.toString(16)).slice(-8);
}
export async function sha256Hex(text) {
  const c = globalThis.crypto && globalThis.crypto.subtle; if (!c) return "";
  const buf = await c.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ===================== validation / completeness ===================== */
// Returns { errors: [{path,msg}], warnings: [...], ready: bool }. Errors block generation; warnings don't.
export function validateModel(bm) {
  const errors = [], warnings = []; const E = (path, msg) => errors.push({ path, msg }), W = (path, msg) => warnings.push({ path, msg });
  if (!bm) return { errors: [{ path: "model", msg: "no model" }], warnings, ready: false };
  if (!(bm.implements || []).length) E("implements", "Link at least one requirement this function implements.");
  const swc = swcName(bm); if (!IDENT.test(swc)) E("target.swc", "Component name must be a C identifier.");
  if (!(bm.signals || []).some((s) => s.dir === "in")) E("signals", "Define at least one input signal.");
  if (!(bm.signals || []).some((s) => s.dir === "out")) E("signals", "Define at least one output signal.");
  const S = sigByName(bm), C = calByName(bm), names = new Set();
  (bm.signals || []).forEach((s, i) => {
    const p = "signals[" + i + "]";
    if (!IDENT.test(s.name || "") || C_KEYWORDS.has(s.name) || s.name === TIME_SIGNAL || /^CAL_/.test(s.name)) E(p + ".name", "'" + (s.name || "") + "' is not a valid signal name (C identifier, not reserved, not CAL_*, not " + TIME_SIGNAL + ").");
    if (names.has(s.name)) E(p + ".name", "Duplicate name '" + s.name + "'."); names.add(s.name);
    if (s.dir !== "in" && s.dir !== "out") E(p + ".dir", s.name + ": direction must be in or out.");
    const T = TYPES[s.baseType]; if (!T) { E(p + ".baseType", s.name + ": choose a base type."); return; }
    const mn = Number(s.min), mx = Number(s.max), iv = Number(s.init);
    if (s.min === "" || s.min == null || s.max === "" || s.max == null || isNaN(mn) || isNaN(mx)) E(p + ".range", s.name + ": min and max are required.");
    else { if (mn > mx) E(p + ".range", s.name + ": min is above max."); if (mn < T.min || mx > T.max) E(p + ".range", s.name + ": range exceeds " + s.baseType + "."); if (T.max > INT32_MAX && mx > INT32_MAX) E(p + ".range", s.name + ": values above 2147483647 aren't supported."); }
    if (s.init === "" || s.init == null || isNaN(iv)) E(p + ".init", s.name + ": initial value is required."); else if (!isNaN(mn) && !isNaN(mx) && (iv < mn || iv > mx)) E(p + ".init", s.name + ": initial value is outside min..max.");
    if (s.invalid !== "" && s.invalid != null && !isNaN(Number(s.invalid)) && (Number(s.invalid) < mn || Number(s.invalid) > mx)) E(p + ".invalid", s.name + ": invalid-substitute is outside min..max.");
    if (!s.unit && s.baseType !== "boolean") W(p + ".unit", s.name + ": no unit given.");
  });
  (bm.calibrations || []).forEach((c, i) => {
    const p = "calibrations[" + i + "]";
    if (!/^CAL_[A-Z0-9_]+$/.test(c.name || "")) E(p + ".name", "Calibration '" + (c.name || "") + "' must look like CAL_NAME.");
    if (names.has(c.name)) E(p + ".name", "Duplicate name '" + c.name + "'."); names.add(c.name);
    const T = TYPES[c.baseType]; if (!T) { E(p + ".baseType", c.name + ": choose a base type."); return; }
    const v = Number(c.value); if (c.value === "" || c.value == null || isNaN(v) || !Number.isInteger(v)) E(p + ".value", c.name + ": integer value required."); else if (v < T.min || v > T.max) E(p + ".value", c.name + ": value outside " + c.baseType + ".");
    else if (v > INT32_MAX) E(p + ".value", c.name + ": values above 2147483647 aren't supported.");
    if (!c.source) W(p + ".source", c.name + ": no source/justification recorded.");
  });
  const r = bm.runnable || {}; if (!(Number(r.periodMs) > 0) || !Number.isInteger(Number(r.periodMs))) E("runnable.periodMs", "Runnable period must be a positive whole number of ms.");
  const sm = bm.stateMachine || {}; const states = sm.states || [], ids = new Set(states.map((s) => s.id));
  if (!states.length) E("stateMachine", "Add at least one state."); else if (!ids.has(sm.init)) E("stateMachine.init", "Initial state '" + sm.init + "' isn't one of the states.");
  states.forEach((s, i) => { if (!IDENT.test(s.id || "")) E("stateMachine.states[" + i + "].id", "State id '" + s.id + "' must be a C identifier."); });
  const env = makeEnv(bm);
  const checkExpr = (path, src, want) => {
    if (!String(src || "").trim()) { E(path, "Missing expression."); return null; }
    let ast; try { ast = parseExpr(src); } catch (e) { E(path, "Can't parse '" + src + "': " + e.message); return null; }
    try { const t = typeOf(ast, env); if (want && t !== want) E(path, "Expression is a " + t + ", expected a " + want + "."); } catch (e) { E(path, e.message); return null; }
    idsOf(ast).forEach((n) => { if (S[n] && S[n].dir === "out") E(path, "Output '" + n + "' can't be read in an expression."); });
    try { const [lo, hi] = interval(ast, env); if (lo < -INT32_MAX || hi > INT32_MAX) E(path, "Possible 32-bit overflow in '" + src + "'."); } catch (e) { /* bool expr */ }
    return ast;
  };
  (sm.transitions || []).forEach((t, i) => {
    const p = "stateMachine.transitions[" + i + "]";
    if (!ids.has(t.from)) E(p + ".from", "Unknown source state '" + t.from + "'."); if (!ids.has(t.to)) E(p + ".to", "Unknown target state '" + t.to + "'.");
    checkExpr(p + ".guard", t.guard, "bool");
  });
  const outs = (bm.signals || []).filter((s) => s.dir === "out");
  states.forEach((st, i) => {
    outs.forEach((o) => {
      const e = st.outputs && st.outputs[o.name];
      if (e == null || String(e).trim() === "") E("stateMachine.states[" + i + "].outputs." + o.name, "State " + st.id + ": no value defined for output " + o.name + ".");
      else checkExpr("stateMachine.states[" + i + "].outputs." + o.name, e, o.baseType === "boolean" ? "bool" : "num");
    });
  });
  // reachability + shadowing (warnings)
  if (ids.has(sm.init)) {
    const seen = new Set([sm.init]), q = [sm.init];
    while (q.length) { const s = q.shift(); (sm.transitions || []).forEach((t) => { if (t.from === s && ids.has(t.to) && !seen.has(t.to)) { seen.add(t.to); q.push(t.to); } }); }
    states.forEach((s) => { if (!seen.has(s.id)) W("stateMachine.states." + s.id, "State " + s.id + " isn't reachable from " + sm.init + "."); });
  }
  states.forEach((s) => {
    let alwaysSeen = null;
    (sm.transitions || []).filter((t) => t.from === s.id).forEach((t) => { if (alwaysSeen) W("stateMachine.transitions", "In " + s.id + ", the transition to " + t.to + " is shadowed by an earlier always-true transition to " + alwaysSeen + "."); if (String(t.guard || "").trim() === "true") alwaysSeen = t.to; });
  });
  if (!bm.title) W("title", "No title.");
  return { errors, warnings, ready: errors.length === 0 };
}

/* ===================== reference simulator ===================== */
// Defines the exact semantics the generated C must match.
//   each Run: evaluate the current state's transitions in order, first enabled wins;
//   state_time_ms is the time already spent in the state (0 on the first Run after entering);
//   outputs are the NEW state's Moore outputs, evaluated with this cycle's inputs.
export function simulateStep(bm, st, inputs) {
  const sm = bm.stateMachine, P = Number(bm.runnable.periodMs), C = calByName(bm);
  const vars = {}; (bm.signals || []).forEach((s) => { vars[s.name] = s.baseType === "boolean" ? !!inputs[s.name] : Number(inputs[s.name]); });
  Object.values(C).forEach((c) => { vars[c.name] = c.baseType === "boolean" ? !!Number(c.value) : Number(c.value); });
  vars[TIME_SIGNAL] = st.tms;
  const trs = (sm.transitions || []).filter((t) => t.from === st.state);
  let next = st.state, fired = null;
  for (const t of trs) { if (evalAst(parseExpr(t.guard), vars)) { fired = t; next = t.to; break; } }
  const tms = fired ? 0 : Math.min(st.tms + P, INT32_MAX);
  const ns = (sm.states || []).find((s) => s.id === next); const outputs = {};
  (bm.signals || []).filter((s) => s.dir === "out").forEach((o) => { const v = evalAst(parseExpr(ns.outputs[o.name]), vars); outputs[o.name] = typeof v === "boolean" ? (v ? 1 : 0) : v; });
  return { state: next, tms, fired, outputs };
}
const initInputs = (bm) => Object.fromEntries((bm.signals || []).filter((s) => s.dir === "in").map((s) => [s.name, Number(s.init)]));

/* ===================== guard solver (test vectors) ===================== */
// Handles guards built from comparisons of ONE input signal (or state_time_ms) against a constant/calibration expression.
// Anything richer is reported as "not covered automatically" instead of being guessed.
const INF = Infinity;
function constFold(ast, bm) {
  if (idsOf(ast).size && [...idsOf(ast)].some((n) => !calByName(bm)[n])) return null;
  const vars = {}; Object.values(calByName(bm)).forEach((c) => { vars[c.name] = Number(c.value); });
  try { return evalAst(ast, vars); } catch (e) { return null; }
}
function negate(ast) {
  if (ast.t === "bool") return { t: "bool", v: !ast.v };
  if (ast.t === "un" && ast.op === "!") return ast.a;
  if (ast.t === "id") return { t: "un", op: "!", a: ast };
  if (ast.t === "bin") {
    const flip = { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!=", "!=": "==" };
    if (ast.op === "&&") return { t: "bin", op: "||", a: negate(ast.a), b: negate(ast.b) };
    if (ast.op === "||") return { t: "bin", op: "&&", a: negate(ast.a), b: negate(ast.b) };
    if (flip[ast.op]) return { t: "bin", op: flip[ast.op], a: ast.a, b: ast.b };
  }
  return null;
}
// returns array of alternatives; each alternative = { sig: {lo,hi} }. null = unsupported.
function solve(ast, bm) {
  const S = sigByName(bm);
  const isInput = (n) => n === TIME_SIGNAL || (S[n] && S[n].dir === "in");
  const atom = (n, lo, hi) => [{ [n]: { lo, hi } }];
  if (ast.t === "bool") return ast.v ? [{}] : [];
  if (ast.t === "id") return isInput(ast.n) && S[ast.n] && S[ast.n].baseType === "boolean" ? atom(ast.n, 1, 1) : null;
  if (ast.t === "un" && ast.op === "!" && ast.a.t === "id") return isInput(ast.a.n) && S[ast.a.n] && S[ast.a.n].baseType === "boolean" ? atom(ast.a.n, 0, 0) : null;
  if (ast.t === "un" && ast.op === "!") { const n = negate(ast.a); return n ? solve(n, bm) : null; }
  if (ast.t === "bin" && (ast.op === "&&" || ast.op === "||")) {
    const A = solve(ast.a, bm), B = solve(ast.b, bm); if (!A || !B) return null;
    if (ast.op === "||") return A.concat(B);
    const out = []; A.forEach((a) => B.forEach((b) => { const m = { ...a }; let ok = true; Object.keys(b).forEach((k) => { const x = m[k] || { lo: -INF, hi: INF }; const lo = Math.max(x.lo, b[k].lo), hi = Math.min(x.hi, b[k].hi); if (lo > hi) ok = false; m[k] = { lo, hi }; }); if (ok) out.push(m); }));
    return out.slice(0, 16);
  }
  if (ast.t === "bin" && ["<", "<=", ">", ">=", "==", "!="].includes(ast.op)) {
    let l = ast.a, r = ast.b, op = ast.op;
    const flipSide = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" };
    const lc = constFold(l, bm), rc = constFold(r, bm);
    if (lc != null && rc == null) { [l, r] = [r, l]; op = flipSide[op]; }
    const K = constFold(r, bm); if (K == null || l.t !== "id" || !isInput(l.n)) return null;
    const n = l.n;
    if (op === ">") return atom(n, K + 1, INF); if (op === ">=") return atom(n, K, INF);
    if (op === "<") return atom(n, -INF, K - 1); if (op === "<=") return atom(n, -INF, K);
    if (op === "==") return atom(n, K, K); if (op === "!=") return atom(n, -INF, K - 1).concat(atom(n, K + 1, INF));
  }
  return null;
}
function domainOf(bm, n) { if (n === TIME_SIGNAL) return [0, INT32_MAX]; const s = sigByName(bm)[n]; return [Number(s.min), Number(s.max)]; }
// pick the value in the constraint closest to its boundary, within the signal's domain
function pick(bm, n, c) {
  const [dl, dh] = domainOf(bm, n); const lo = Math.max(c.lo, dl), hi = Math.min(c.hi, dh); if (lo > hi) return null;
  return c.lo > -INF && c.lo >= dl ? lo : (c.hi < INF && c.hi <= dh ? hi : (lo > -INF ? lo : 0));
}
// Concrete (overrides, timeMs) options that make `ast` true, with one-step-off variants per bound for boundary tests.
function vectorsFor(bm, ast) {
  const alts = solve(ast, bm); if (!alts) return null;
  const out = [];
  alts.forEach((a, ai) => {
    const over = {}; let time = 0, ok = true;
    Object.keys(a).forEach((n) => { const v = pick(bm, n, a[n]); if (v == null) { ok = false; return; } if (n === TIME_SIGNAL) time = v; else over[n] = v; });
    if (!ok) return;
    const variants = [];
    Object.keys(a).forEach((n) => {
      const [dl, dh] = domainOf(bm, n);
      if (a[n].lo > -INF && a[n].lo > dl) variants.push({ sig: n, to: a[n].lo - 1 });   // just below the lower bound
      if (a[n].hi < INF && a[n].hi < dh) variants.push({ sig: n, to: a[n].hi + 1 });    // just above the upper bound
    });
    out.push({ over, time, variants, alt: ai });
  });
  return out;
}

/* ===================== test generation ===================== */
const runsFor = (time, P) => (time > 0 ? Math.ceil(time / P) + 1 : 1); // run n sees state_time_ms=(n-1)*P

function runScenario(bm, steps) {
  // steps: [{ inputs (full), runs }] ; returns trace of final state after each step + per-run states for the last step
  let st = { state: bm.stateMachine.init, tms: 0 }, last = null, perRun = [];
  steps.forEach((s, si) => { perRun = []; for (let i = 0; i < s.runs; i++) { last = simulateStep(bm, st, s.inputs); st = { state: last.state, tms: last.tms }; perRun.push(last); } });
  return { st, last, perRun };
}

export function generateTests(bm) {
  const sm = bm.stateMachine, P = Number(bm.runnable.periodMs), gaps = [], tests = [];
  const base = initInputs(bm), full = (extra) => ({ ...base, ...extra });
  const trs = sm.transitions || [];
  const pairKey = (t, k) => t.from + ">" + t.to + "#" + k; const seenPair = {};
  const keyed = trs.map((t) => { const k = (seenPair[t.from + ">" + t.to] = (seenPair[t.from + ">" + t.to] || 0) + 1); return { t, key: pairKey(t, k) }; });

  // 1) paths: shortest scenario from init to each state, found by BFS with simulator-verified hop vectors
  const path = { [sm.init]: [] }, queue = [sm.init], hopFor = {};
  // All simulator-verified stimuli that make transition kt fire (one per OR-branch of its guard, where one exists).
  const hopsFor = (kt, priorSteps) => {
    const t = kt.t; let ast; try { ast = parseExpr(t.guard); } catch (e) { return []; }
    const cands = vectorsFor(bm, ast); if (!cands) return { unsupported: true };
    const prevInputs = priorSteps.length ? priorSteps[priorSteps.length - 1].inputs : base;
    const hops = [], seen = new Set();
    cands.forEach((c, ci) => {
      for (const bs of [prevInputs, base]) {
        const inputs = { ...bs, ...c.over }, runs = runsFor(c.time, P);
        const sc = runScenario(bm, priorSteps.concat([{ inputs, runs }]));
        const pr = sc.perRun; // must fire exactly on the last run of this step
        const firedAtEnd = pr.length && pr[pr.length - 1].fired === t && pr.slice(0, -1).every((x) => !x.fired);
        const sig = JSON.stringify([inputs, runs]);
        if (firedAtEnd) { if (!seen.has(sig)) { seen.add(sig); hops.push({ inputs, runs, cand: c, base: bs, alt: ci }); } break; }
      }
    });
    return hops;
  };
  const tryHop = (from, kt, priorSteps) => { const h = hopsFor(kt, priorSteps); if (h && h.unsupported) return h; return h && h.length ? h[0] : null; };
  while (queue.length) {
    const s = queue.shift();
    keyed.filter((kt) => kt.t.from === s && path[kt.t.to] === undefined).forEach((kt) => {
      const hop = tryHop(s, kt, path[s]); if (!hop || hop.unsupported) return;
      path[kt.t.to] = path[s].concat([{ inputs: hop.inputs, runs: hop.runs }]); queue.push(kt.t.to);
    });
  }
  const expectOf = (steps) => { const sc = runScenario(bm, steps); return { state: sc.st.state, outputs: sc.last ? sc.last.outputs : null }; };
  const addTest = (key, req, title, exp, steps, checks) => tests.push({ key, req, title, exp, steps, checks });
  const mkChecks = (steps) => { const sc = runScenario(bm, steps); return sc.last ? { state: sc.st.state, outputs: sc.last.outputs } : { state: sm.init, outputs: null }; };

  // 2) initial state + outputs
  { const steps = [{ inputs: full({}), runs: 1 }]; const c = mkChecks(steps);
    addTest("init", bm.function, "Initial state is " + sm.init, "After initialisation and one cycle with default inputs the machine is in " + c.state + " with its defined outputs.", steps, c); }
  // 3) every state reachable
  (sm.states || []).forEach((s) => {
    if (s.id === sm.init) return;
    if (path[s.id] === undefined) { gaps.push("State " + s.id + ": no automatic path found from " + sm.init + " (guards too complex or unreachable) — add a manual test."); return; }
    const steps = path[s.id]; const c = mkChecks(steps);
    addTest("state:" + s.id, bm.function, "State " + s.id + " is reachable and sets its outputs", "From " + sm.init + " the machine reaches " + c.state + " and its outputs match the model.", steps, c);
  });
  // 4) every transition + boundary pairs
  keyed.forEach((kt) => {
    const t = kt.t; if (path[t.from] === undefined) { gaps.push("Transition " + t.from + " → " + t.to + ": source state not reachable automatically — add a manual test."); return; }
    const hops = hopsFor(kt, path[t.from]);
    if (hops && hops.unsupported) { gaps.push("Transition " + t.from + " → " + t.to + ": guard '" + t.guard + "' is more complex than the solver handles — add a manual test."); return; }
    if (!hops || !hops.length) { gaps.push("Transition " + t.from + " → " + t.to + ": couldn't build a stimulus that fires it first (earlier transitions or conflicting inputs) — add a manual test."); return; }
    const pre = path[t.from];
    hops.forEach((hop, hi) => {
      // The first OR-branch keeps the original key (stable IDs); every further branch gets its own test (#altN),
      // so each way of taking a transition is exercised — not just the first one the solver finds.
      const kk = kt.key + (hi === 0 ? "" : "#alt" + hi), alt = hops.length > 1 ? " [branch " + (hi + 1) + " of " + hops.length + "]" : "";
      const main = { inputs: hop.inputs, runs: hop.runs };
      if (main.runs > 1) {
        // timeout: must NOT fire one run early, must fire exactly at the threshold
        const early = pre.concat([{ inputs: main.inputs, runs: main.runs - 1 }]); const ec = mkChecks(early);
        addTest("time:" + kk, bm.function, "Transition " + t.from + " → " + t.to + " waits for its time condition" + alt, "With the stimulus held, the machine stays in " + ec.state + " until the time condition is met, then moves to " + t.to + " on the next cycle.",
          pre.concat([{ inputs: main.inputs, runs: main.runs - 1, check: ec }, { inputs: main.inputs, runs: 1 }]), mkChecks(pre.concat([main])));
      } else {
        const steps = pre.concat([main]); const c = mkChecks(steps);
        addTest("trans:" + kk, bm.function, "Transition " + t.from + " → " + t.to + (t.label ? " (" + t.label + ")" : "") + alt, "In " + t.from + ", when '" + t.guard + "' holds, the machine moves to " + t.to + " and sets the outputs of " + t.to + ".", steps, c);
      }
      // boundary: flip each bound by one step
      const seenV = new Set();
      (hop.cand.variants || []).forEach((v) => {
        if (v.sig === TIME_SIGNAL) return; // covered by the timeout test above
        const vk = v.sig + "=" + v.to; if (seenV.has(vk)) return; seenV.add(vk);
        const inputs = { ...main.inputs, [v.sig]: v.to }; const steps = pre.concat([{ inputs, runs: main.runs }]);
        const sc = runScenario(bm, steps); if (sc.perRun.some((x) => x.fired === t)) return; // not a real "off" side
        const c = mkChecks(steps);
        addTest("bnd:" + kk + ":" + v.sig + ":" + v.to, bm.function, "Boundary: " + t.from + " → " + t.to + " does not fire with " + v.sig + " = " + v.to + alt, "Just outside the threshold for '" + t.guard + "', the machine does not take this transition (ends in " + c.state + ").", steps, c);
      });
    });
  });
  // 5) priority: where two transitions out of one state are both enabled, the earlier one in the list must win
  const guardHolds = (t, st, inputs) => { const vars = {}; (bm.signals || []).forEach((s) => { vars[s.name] = s.baseType === "boolean" ? !!inputs[s.name] : Number(inputs[s.name]); }); (bm.calibrations || []).forEach((c) => { vars[c.name] = c.baseType === "boolean" ? !!Number(c.value) : Number(c.value); }); vars[TIME_SIGNAL] = st.tms; return !!evalAst(parseExpr(t.guard), vars); };
  (sm.states || []).forEach((s) => {
    const list = keyed.filter((k) => k.t.from === s.id); if (list.length < 2 || path[s.id] === undefined) return;
    const pre = path[s.id], prev = pre.length ? pre[pre.length - 1].inputs : base;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const E = list[i], Tj = list[j]; let ce, ct; try { ce = vectorsFor(bm, parseExpr(E.t.guard)); ct = vectorsFor(bm, parseExpr(Tj.t.guard)); } catch (e) { continue; }
      if (!ce || !ct) continue; let found = null;
      outer: for (const bs of [prev, base]) for (const a of ce) for (const b of ct) {
        const over = { ...a.over }; let clash = false; Object.keys(b.over).forEach((k) => { if (k in over && over[k] !== b.over[k]) clash = true; over[k] = b.over[k]; }); if (clash) continue;
        const inputs = { ...bs, ...over }, runs = runsFor(Math.max(a.time, b.time), P);
        const sc = runScenario(bm, pre.concat([{ inputs, runs }])), pr = sc.perRun, lastRun = pr[pr.length - 1];
        const before = runScenario(bm, pre.concat(runs > 1 ? [{ inputs, runs: runs - 1 }] : [])).st;
        if (lastRun && lastRun.fired === E.t && pr.slice(0, -1).every((x) => !x.fired) && guardHolds(Tj.t, before, inputs)) { found = { inputs, runs }; break outer; }
      }
      if (!found) continue;
      const steps = pre.concat([found]);
      addTest("prio:" + E.key + "|" + Tj.key, bm.function, "Priority in " + s.id + ": → " + E.t.to + " wins over → " + Tj.t.to + " when both guards hold", "With both '" + E.t.guard + "' and '" + Tj.t.guard + "' true in " + s.id + ", the earlier transition (to " + E.t.to + ") is taken.", steps, mkChecks(steps));
    }
  });
  return { tests, gaps, path };
}

/* ===================== C generation ===================== */
const hdr = (bm, file, desc, status) => [
  "/* " + file, " * " + desc, " * GENERATED by SDVsolution codegen v" + GENERATOR_VERSION + " — do not edit by hand; change the Behavior Model instead.",
  " * Behavior Model: " + (bm.id || bm.function) + "  rev " + (bm.rev || 1) + "  hash " + modelHash(bm),
  " * Status: " + (status === "approved" ? "APPROVED" : "NOT APPROVED (" + String(status || "draft").toUpperCase() + ") — not releasable"),
  " * @req " + (bm.implements || []).join(", "), " */"].join("\n");

export async function generate(bm, opts = {}) {
  const v = validateModel(bm);
  if (!v.ready) return { ok: false, errors: v.errors, warnings: v.warnings, files: [], tests: [], gaps: [], manifest: null };
  const swc = swcName(bm), P = Number(bm.runnable.periodMs), env = makeEnv(bm), sm = bm.stateMachine, status = bm.status || "draft";
  const sigs = bm.signals, ins = sigs.filter((s) => s.dir === "in"), outs = sigs.filter((s) => s.dir === "out"), cals = bm.calibrations || [];
  const T = (s) => TYPES[s.baseType].c;
  const NL = "\n"; const files = [];
  // C sources stay pure ASCII (comments can carry units/labels typed in the editor).
  const ascii = (t) => t.replace(/°/g, "deg").replace(/[—–]/g, "-").replace(/→/g, "->").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x00-\x7f]/g, "?");
  const add = (name, text) => files.push({ name, text: (/\.json$/.test(name) ? text : ascii(text)).replace(/\r?\n/g, "\n") });
  const statesList = sm.states.map((s) => s.id);

  // --- Std_Types.h (host stub for the AUTOSAR header) ---
  add("stubs/Std_Types.h", [hdr(bm, "Std_Types.h", "HOST STUB of the AUTOSAR Std_Types.h — replaced by the real BSW header on target.", status),
    "#ifndef STD_TYPES_H", "#define STD_TYPES_H", "#include <stdint.h>", "typedef uint8_t boolean;", "typedef uint8_t Std_ReturnType;",
    "#define TRUE ((boolean)1u)", "#define FALSE ((boolean)0u)", "#define E_OK ((Std_ReturnType)0u)", "#define E_NOT_OK ((Std_ReturnType)1u)", "#endif", ""].join(NL));
  // --- Rte_<swc>.h (port API) ---
  add("src/Rte_" + swc + ".h", [hdr(bm, "Rte_" + swc + ".h", "Port access API used by " + swc + " (AUTOSAR RTE naming). Implemented by the RTE on target, by a stub on host.", status),
    "#ifndef RTE_" + swc.toUpperCase() + "_H", "#define RTE_" + swc.toUpperCase() + "_H", '#include "Std_Types.h"',
    ...ins.map((s) => "Std_ReturnType Rte_Read_" + portFor(s) + "_" + elementFor(s) + "(" + T(s) + " *data);"),
    ...outs.map((s) => "Std_ReturnType Rte_Write_" + portFor(s) + "_" + elementFor(s) + "(" + T(s) + " data);"), "#endif", ""].join(NL));
  // --- cfg ---
  add("src/" + swc + "_cfg.h", [hdr(bm, swc + "_cfg.h", "Calibration parameters.", status), "#ifndef " + swc.toUpperCase() + "_CFG_H", "#define " + swc.toUpperCase() + "_CFG_H", '#include "Std_Types.h"',
    ...cals.map((c) => "extern const " + TYPES[c.baseType].c + " " + c.name + "; /* " + (c.unit || "-") + " */"), "#endif", ""].join(NL));
  add("src/" + swc + "_cfg.c", [hdr(bm, swc + "_cfg.c", "Calibration values (single definition point). Source/justification per value below.", status), '#include "' + swc + '_cfg.h"',
    ...cals.map((c) => { const n = Number(c.value); const lit = n < 0 ? "(" + TYPES[c.baseType].c + ")(" + n + ")" : (c.baseType === "boolean" ? (n ? "TRUE" : "FALSE") : n + "u"); const note = ((c.unit || "-") + " | source: " + (c.source || "not recorded")).replace(/\*\//g, "* /"); return "const " + TYPES[c.baseType].c + " " + c.name + " = " + lit + "; /* " + note + " */"; }), ""].join(NL));
  // --- component header ---
  const E = (id) => swc + "_STATE_" + id.toUpperCase();
  add("src/" + swc + ".h", [hdr(bm, swc + ".h", "Public interface of " + swc + " (" + bm.title + ").", status), "#ifndef " + swc.toUpperCase() + "_H", "#define " + swc.toUpperCase() + "_H", '#include "Std_Types.h"',
    "#define " + swc.toUpperCase() + "_PERIOD_MS (" + P + "u)", "typedef enum {", ...statesList.map((id, i) => "    " + E(id) + " = " + i + (i < statesList.length - 1 ? "," : "")), "} " + swc + "_StateType;",
    "void " + swc + "_Init(void);", "void " + swc + "_Run(void); /* runnable, period " + P + " ms */", swc + "_StateType " + swc + "_GetState(void);", "uint32_t " + swc + "_GetStateTimeMs(void);", "#endif", ""].join(NL));
  // --- component source ---
  const L = [];
  L.push(hdr(bm, swc + ".c", "Behavior of " + swc + " (" + bm.title + ") as a table of states, guarded transitions and Moore outputs.", status));
  L.push('#include "' + swc + '.h"', '#include "' + swc + '_cfg.h"', '#include "Rte_' + swc + '.h"', "", "#define " + swc.toUpperCase() + "_TIME_MAX (2147483647u)", "",
    "static " + swc + "_StateType " + swc + "_state;", "static uint32_t " + swc + "_stateTimeMs;", "",
    "void " + swc + "_Init(void)", "{", "    " + swc + "_state = " + E(sm.init) + ";", "    " + swc + "_stateTimeMs = 0u;", "}", "",
    swc + "_StateType " + swc + "_GetState(void) { return " + swc + "_state; }", "uint32_t " + swc + "_GetStateTimeMs(void) { return " + swc + "_stateTimeMs; }", "",
    "/* @req " + (bm.implements || []).join(", ") + " */", "void " + swc + "_Run(void)", "{");
  L.push("    " + swc + "_StateType next = " + swc + "_state;", "    boolean fired = FALSE;", "    uint32_t state_time_ms = " + swc + "_stateTimeMs;", "    (void)state_time_ms; /* referenced only by guards that use state_time_ms */");
  sigs.forEach((s) => { const init = s.dir === "in" && s.invalid !== "" && s.invalid != null && !isNaN(Number(s.invalid)) ? Number(s.invalid) : Number(s.init); L.push("    " + T(s) + " " + s.name + " = (" + T(s) + ")" + (init < 0 ? "(" + init + ")" : init) + "; /* " + (s.dir === "in" ? "input, " + (s.invalid !== "" && s.invalid != null && !isNaN(Number(s.invalid)) ? "invalid-substitute" : "fallback = initial value") : "output") + (s.unit ? ", " + s.unit : "") + " */"); });
  L.push("", "    /* read inputs (a failed read keeps the fallback above) */");
  ins.forEach((s) => L.push("    (void)Rte_Read_" + portFor(s) + "_" + elementFor(s) + "(&" + s.name + ");"));
  L.push("", "    /* transitions: evaluated in listed order, first enabled wins */", "    switch (" + swc + "_state)", "    {");
  statesList.forEach((id) => {
    L.push("    case " + E(id) + ":");
    const out = sm.transitions.filter((t) => t.from === id);
    if (!out.length) L.push("        /* no outgoing transitions */");
    out.forEach((t, k) => {
      const pre = k === 0 ? "        if " : "        else if ";
      L.push(pre + "(" + cExpr(parseExpr(t.guard), env) + ")", "        {", "            /* " + t.from + " -> " + t.to + (t.label ? " : " + String(t.label).replace(/\*\//g, "* /") : "") + "  @req " + (t.req || bm.function) + " */", "            next = " + E(t.to) + ";", "            fired = TRUE;", "        }");
    });
    if (out.length) L.push("        else", "        {", "            /* no transition: remain in " + id + " */", "        }");
    L.push("        break;");
  });
  L.push("    default:", "        next = " + E(sm.init) + "; /* defensive: unknown state */", "        break;", "    }", "",
    "    /* state bookkeeping (a taken transition always restarts the state timer, even a self-transition) */", "    if (fired != FALSE)", "    {", "        " + swc + "_state = next;", "        " + swc + "_stateTimeMs = 0u;", "    }",
    "    else if (" + swc + "_stateTimeMs <= (" + swc.toUpperCase() + "_TIME_MAX - " + swc.toUpperCase() + "_PERIOD_MS))", "    {", "        " + swc + "_stateTimeMs += " + swc.toUpperCase() + "_PERIOD_MS;", "    }",
    "    else", "    {", "        " + swc + "_stateTimeMs = " + swc.toUpperCase() + "_TIME_MAX;", "    }", "");
  L.push("    /* outputs of the (new) state — Moore */", "    switch (" + swc + "_state)", "    {");
  sm.states.forEach((st) => {
    L.push("    case " + E(st.id) + ":");
    outs.forEach((o) => { const ast = parseExpr(st.outputs[o.name]); const val = o.baseType === "boolean" ? (ast.t === "bool" ? (ast.v ? "TRUE" : "FALSE") : "(" + cExpr(ast, env) + " ? TRUE : FALSE)") : "(" + T(o) + ")" + cExpr(ast, env); L.push("        " + o.name + " = " + val + ";"); });
    L.push("        break;");
  });
  L.push("    default:", "        break;", "    }", "");
  outs.forEach((o) => L.push("    (void)Rte_Write_" + portFor(o) + "_" + elementFor(o) + "(" + o.name + ");"));
  L.push("}", "");
  add("src/" + swc + ".c", L.join(NL));

  // --- tests ---
  const tg = generateTests(bm);
  const idMap = { ...(bm.testIds || {}) }; let maxN = Object.values(idMap).reduce((a, b) => Math.max(a, b), 0);
  tg.tests.forEach((t) => { if (!idMap[t.key]) idMap[t.key] = ++maxN; t.id = "TC-" + bm.function + "-GEN-" + idMap[t.key]; });
  tg.tests.sort((a, b) => idMap[a.key] - idMap[b.key]);
  // RTE stub (host)
  add("test/Rte_" + swc + "_stub.h", [hdr(bm, "Rte_" + swc + "_stub.h", "Host test stub of the RTE: lets tests drive inputs and observe outputs.", status), "#ifndef RTE_" + swc.toUpperCase() + "_STUB_H", "#define RTE_" + swc.toUpperCase() + "_STUB_H", '#include "Std_Types.h"',
    "void RteStub_Reset(void);", ...ins.map((s) => "void RteStub_Set_" + s.name + "(" + T(s) + " v);"), ...outs.map((s) => T(s) + " RteStub_Get_" + s.name + "(void);"), "#endif", ""].join(NL));
  add("test/Rte_" + swc + "_stub.c", [hdr(bm, "Rte_" + swc + "_stub.c", "Host test stub of the RTE.", status), '#include "Rte_' + swc + '.h"', '#include "Rte_' + swc + '_stub.h"', "",
    ...sigs.map((s) => "static " + T(s) + " stub_" + s.name + " = (" + T(s) + ")" + (Number(s.init) < 0 ? "(" + Number(s.init) + ")" : Number(s.init)) + ";"), "",
    "void RteStub_Reset(void)", "{", ...sigs.map((s) => "    stub_" + s.name + " = (" + T(s) + ")" + (Number(s.init) < 0 ? "(" + Number(s.init) + ")" : Number(s.init)) + ";"), "}", "",
    ...ins.map((s) => "void RteStub_Set_" + s.name + "(" + T(s) + " v) { stub_" + s.name + " = v; }\nStd_ReturnType Rte_Read_" + portFor(s) + "_" + elementFor(s) + "(" + T(s) + " *data) { *data = stub_" + s.name + "; return E_OK; }"),
    ...outs.map((s) => T(s) + " RteStub_Get_" + s.name + "(void) { return stub_" + s.name + "; }\nStd_ReturnType Rte_Write_" + portFor(s) + "_" + elementFor(s) + "(" + T(s) + " data) { stub_" + s.name + " = data; return E_OK; }"), ""].join(NL));
  // test source
  const cv = (s, x) => "(" + T(s) + ")" + (x < 0 ? "(" + x + ")" : x);
  const stepLines = (st) => { const o = []; ins.forEach((s) => o.push("    RteStub_Set_" + s.name + "(" + cv(s, st.inputs[s.name]) + ");")); o.push("    for (i = 0u; i < " + st.runs + "u; i++) { " + swc + "_Run(); }"); return o; };
  const checkLines = (c) => { const o = ["    CHECK_STATE(" + E(c.state) + ");"]; if (c.outputs) outs.forEach((s) => o.push("    CHECK_EQ(\"" + s.name + "\", (int32_t)RteStub_Get_" + s.name + "(), " + c.outputs[s.name] + ");")); return o; };
  const TL = [hdr(bm, "test_" + swc + ".c", "Unit tests generated from the Behavior Model (state, transition, boundary and timeout coverage). Emits JUnit XML.", status),
    "#include <stdio.h>", "#include <stdlib.h>", "#include <string.h>", '#include "' + swc + '.h"', '#include "Rte_' + swc + '_stub.h"', "",
    "static int g_failed;", "static char g_msg[160];",
    "#define CHECK_STATE(exp) do { if (" + swc + "_GetState() != (exp)) { if (!g_failed) { (void)snprintf(g_msg, sizeof g_msg, \"state %d, expected %d\", (int)" + swc + "_GetState(), (int)(exp)); } g_failed = 1; } } while (0)",
    "#define CHECK_EQ(name, got, exp) do { if ((got) != (exp)) { if (!g_failed) { (void)snprintf(g_msg, sizeof g_msg, \"%s = %ld, expected %ld\", name, (long)(got), (long)(exp)); } g_failed = 1; } } while (0)", ""];
  tg.tests.forEach((t, n) => {
    TL.push("/* " + t.id + " — " + t.title.replace(/\*\//g, "* /") + " @req " + t.req + " */", "static void tc_" + (n + 1) + "(void)", "{", "    uint32_t i;", "    (void)i;", "    " + swc + "_Init();", "    RteStub_Reset();");
    t.steps.forEach((st) => { TL.push(...stepLines(st)); if (st.check) TL.push(...checkLines(st.check)); });
    TL.push(...checkLines(t.checks), "}", "");
  });
  TL.push("typedef struct { const char *id; const char *req; const char *title; void (*fn)(void); } TestEntry;", "static const TestEntry g_tests[] = {",
    ...tg.tests.map((t, n) => '    { "' + t.id + '", "' + t.req + '", "' + t.title.replace(/"/g, "'") + '", tc_' + (n + 1) + " },"), "};", "",
    "int main(int argc, char **argv)", "{", "    FILE *out = stdout;", "    unsigned n; unsigned failed = 0u;", "    const char *build = getenv(\"SDV_BUILD\");",
    "    if (argc > 1) { out = fopen(argv[1], \"w\"); if (out == NULL) { return 2; } }",
    "    n = (unsigned)(sizeof g_tests / sizeof g_tests[0]);",
    "    (void)fprintf(out, \"<?xml version=\\\"1.0\\\" encoding=\\\"UTF-8\\\"?>\\n<testsuites><testsuite name=\\\"" + swc + "\\\" tests=\\\"%u\\\">\\n<properties>\\n<property name=\\\"tool\\\" value=\\\"SDVsolution codegen v" + GENERATOR_VERSION + "\\\"/>\\n<property name=\\\"build\\\" value=\\\"%s\\\"/>\\n<property name=\\\"model\\\" value=\\\"" + modelHash(bm) + "\\\"/>\\n</properties>\\n\", n, (build != NULL) ? build : \"\");",
    "    {", "        unsigned k;", "        for (k = 0u; k < n; k++)", "        {", "            g_failed = 0; g_msg[0] = '\\0';", "            g_tests[k].fn();",
    "            (void)fprintf(out, \"<testcase classname=\\\"" + swc + "\\\" name=\\\"%s\\\"><properties><property name=\\\"tc_id\\\" value=\\\"%s\\\"/><property name=\\\"requirement\\\" value=\\\"%s\\\"/></properties>\", g_tests[k].id, g_tests[k].id, g_tests[k].req);",
    "            if (g_failed) { failed++; (void)fprintf(out, \"<failure message=\\\"%s\\\"/>\", g_msg); }", "            (void)fprintf(out, \"</testcase>\\n\");", "        }", "    }",
    "    (void)fprintf(out, \"</testsuite></testsuites>\\n\");", "    if (out != stdout) { (void)fclose(out); }", "    (void)printf(\"%u tests, %u failed\\n\", n, failed);", "    return (failed == 0u) ? 0 : 1;", "}", "");
  add("test/test_" + swc + ".c", TL.join(NL));
  // Makefile (host SIL build)
  add("Makefile", ["# Host (SIL) build of the generated unit tests. Not the target build.", "CC ?= gcc", "CFLAGS ?= -std=c99 -Wall -Wextra -Wconversion -Werror -O0 -g -Isrc -Istubs -Itest", "SRC = src/" + swc + ".c src/" + swc + "_cfg.c test/Rte_" + swc + "_stub.c test/test_" + swc + ".c",
    "test_" + swc + ": $(SRC)", "\t$(CC) $(CFLAGS) -o $@ $(SRC)", "run: test_" + swc, "\t./test_" + swc + " results.xml", "clean:", "\trm -f test_" + swc + " results.xml", ""].join(NL));

  // manifest
  const fileInfo = []; for (const f of files) fileInfo.push({ name: f.name, sha256: await sha256Hex(f.text), bytes: f.text.length, implements: /^(src|test)\//.test(f.name) ? bm.implements : [] });
  const manifest = { generator: { name: "SDVsolution codegen", version: GENERATOR_VERSION }, model: { id: bm.id || null, function: bm.function, rev: bm.rev || 1, hash: modelHash(bm), status, approved: status === "approved" },
    target: { ecu: (bm.target && bm.target.ecu) || "", swc }, build: opts.build || "", implements: bm.implements, files: fileInfo,
    tests: { count: tg.tests.length, ids: tg.tests.map((t) => t.id), gaps: tg.gaps }, warnings: v.warnings.map((w) => w.msg) };
  add("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  const testCases = tg.tests.map((t) => ({ id: t.id, reqId: t.req, stage: "SWE.4", method: "Unit (SIL)", title: t.title, exp: t.exp, generated: true, key: t.key }));
  return { ok: true, errors: [], warnings: v.warnings, files, tests: testCases, gaps: tg.gaps, manifest, testIds: idMap };
}

/* ===================== build gate ===================== */
// The single rulebook for "may this model be built?" — used by the API (authoritative), the runner (re-checked) and the UI
// (to explain why a button is disabled). A build must start from a BASELINE that contains an APPROVED, QM-confirmed model.
export function checkBuildable(model, baseline) {
  const reasons = [];
  if (!baseline) reasons.push("Choose a baseline: builds always start from a frozen baseline (SUP.8), never from the live editor.");
  if (!model) { reasons.push(baseline ? "The selected baseline does not contain this Behavior Model." : "No Behavior Model."); return { ok: false, reasons }; }
  if (model.status !== "approved") reasons.push("The model in this baseline is " + (model.status || "draft") + ", not approved. Only approved models can be built.");
  if (!model.qmConfirmed) reasons.push("QM classification was not confirmed in this baseline's model (Phase 1 builds QM software only).");
  const v = validateModel(model); if (!v.ready) reasons.push("The model has " + v.errors.length + " blocking issue(s): " + v.errors.slice(0, 2).map((e) => e.msg).join(" · "));
  return { ok: reasons.length === 0, reasons };
}

/* ===================== zip (store) ===================== */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zipStore(files) {
  const enc = new TextEncoder(), chunks = [], central = []; let off = 0;
  const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  files.forEach((f) => {
    const nm = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    const lh = new Uint8Array([0x50, 0x4b, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0x21, 0, 0, ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nm.length), 0, 0, ...nm]);
    chunks.push(lh, data);
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0x21, 0, 0, ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nm.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(off), ...nm]));
    off += lh.length + data.length;
  });
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), 0, 0]);
  const all = [...chunks, ...central, end]; const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0)); let p = 0; all.forEach((c) => { out.set(c, p); p += c.length; });
  return out;
}

/* ===================== seeding ===================== */
// Skeleton Behavior Model from an existing state machine (structure only — types, guards, outputs are left for review).
export function seedFromStateMachine(smId, sm, ctx = {}) {
  const fnId = smId.replace(/-MODE$/, "-FUN");
  return {
    id: "BM-" + smId.replace(/-MODE$/, ""), function: fnId, title: sm.title, implements: ctx.implements && ctx.implements.length ? ctx.implements : [fnId],
    target: { ecu: "ECU-CZM", swc: camel(sm.title.toLowerCase()) }, signals: [], calibrations: [],
    runnable: { name: "Run", periodMs: ctx.periodMs || 10 },
    stateMachine: { init: sm.init, states: sm.states.map((s) => ({ id: s.id, label: s.label, outputs: {} })), transitions: sm.trans.map((t) => ({ from: t.from, to: t.to, label: t.label, guard: "" })) },
    status: "draft", rev: 1, testIds: {}, seededFrom: smId,
  };
}
