// Quality checks for the CURATED requirement sets (Vehicle Platform, Diagnostics, OTA, Security & Privacy, Engineering & Operations).
// Pure functions, shared by the dashboard (Requirements Quality + Gap Analysis) and the tests. Registered in main.jsx as
// window.__sdvReqChecks; the app degrades gracefully (checks skipped) if the module is absent.

const LEAD = /^\s*(when|while|if|where)\b/i;
export const leadWord = (statement) => { const m = String(statement || "").match(LEAD); return m ? m[1].toLowerCase() : ""; };

/* EARS (Easy Approach to Requirements Syntax): the declared pattern must match how the sentence is built.
   Returns null when consistent (or when there's no declared pattern to check), otherwise a short finding. */
export function earsMismatch(statement, pattern) {
  const p = String(pattern || "").toLowerCase(); if (!p.trim()) return null;
  const s = leadWord(statement), st = String(statement || "");
  const say = (name, want, fix) => "Declared “" + name + "” but the wording " + (s ? "starts with “" + s[0].toUpperCase() + s.slice(1) + "”" : "has no leading “" + want + "”") + " — reword (" + fix + ") or change the pattern";
  if (/ubiquit/.test(p)) return s ? "Declared “Ubiquitous” but the wording starts with “" + s[0].toUpperCase() + s.slice(1) + "” — pick the matching pattern, or drop the condition (The <system> shall <response>)" : null;
  if (/event/.test(p)) return s === "when" ? null : say("Event-driven", "When", "When <trigger>, the <system> shall <response>");
  if (/state/.test(p)) return s === "while" ? null : say("State-driven", "While", "While <state>, the <system> shall <response>");
  if (/unwanted|error/.test(p)) return s === "if" && /\bthen\b/i.test(st) ? null : say("Unwanted", "If … then", "If <condition>, then the <system> shall <response>");
  if (/optional/.test(p)) return s === "where" ? null : say("Optional", "Where", "Where <feature>, the <system> shall <response>");
  return null;
}

/* ISO/IEC/IEEE 29148 "singular": one requirement, one "shall". */
export const notSingular = (statement) => (String(statement || "").match(/\bshall\b/gi) || []).length > 1;

/* Attributes a reviewer expects to find. Operational requirements need a verification method and a standard; functional ones need
   a trigger/precondition unless they are Ubiquitous (which has none by definition). Everyone needs an owner and a rationale. */
export function missingAttributes(r) {
  const blank = (v) => !String(v == null ? "" : v).trim(), out = [];
  if (blank(r.owner)) out.push("owner"); if (blank(r.rationale)) out.push("rationale");
  if (r.func) { if (!/ubiquit/i.test(String(r.ears || "")) && blank(r.trigger)) out.push("trigger / precondition"); }
  else { if (blank(r.method)) out.push("verification method"); if (blank(r.std)) out.push("applicable standard"); }
  return out;
}

/* Short human title for lists: the clause after “… shall”, trimmed. */
export function reqTitle(r) {
  let s = String(r.req || "").replace(/^The [^,]*? shall\s+/i, "").replace(/^Every [^,]*? shall\s+/i, "").replace(/^[A-Z][^,]*? shall\s+/i, "");
  s = s.split(/[,;.]/)[0].trim() || r.cat || r.id; if (s.length > 50) s = s.slice(0, 48).trim() + "…";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* Adapt curated requirements ({ subdomain: [req] }) to the shape the gap analysis expects, tagged as curated. */
export function curatedToGapReqs(lists) {
  const out = [];
  Object.keys(lists || {}).forEach((sub) => (lists[sub] || []).forEach((r) => out.push({
    id: r.id, title: reqTitle(r), statement: r.req, criterion: r.ac, method: r.func ? "Test" : (r.method || "Test"),
    owner: r.owner, rationale: r.rationale, ears: r.ears, trigger: r.trigger, std: r.std, func: !!r.func, cat: r.cat,
    curated: true, subdomain: sub, edited: !!r._edited,
  })));
  return out;
}

/* All curated-specific findings for one adapted requirement: [{ cat, msg }]. */
export function curatedFindings(r) {
  const f = [];
  if (r.func) { const m = earsMismatch(r.statement, r.ears); if (m) f.push({ cat: "ears", msg: m }); }
  if (notSingular(r.statement)) f.push({ cat: "ears", msg: "More than one “shall” — split into singular requirements (ISO 29148)" });
  const miss = missingAttributes(r); if (miss.length) f.push({ cat: "attrs", msg: "Missing " + miss.join(", ") });
  return f;
}
