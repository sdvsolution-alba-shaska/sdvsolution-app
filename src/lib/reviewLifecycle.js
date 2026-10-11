// Review lifecycle rules (ASPICE SUP.4 joint review / SUP.8-10 baselines) for the CURATED requirements and Behavior Models.
// Pure functions shared by the Review Board, the requirement cards, the dashboard and the tests; registered in main.jsx as
// window.__sdvReview. A review record is { status, reviewer, approver, date } — the same shape the Review Board already stores in reqStatus.

export const ORDER = ["Draft", "In Review", "Approved", "Baselined"];
const rank = (s) => ORDER.indexOf(s);
export const statusOfRec = (rec) => (rec && ORDER.includes(rec.status) ? rec.status : "Draft");
const clean = (v) => String(v == null ? "" : v).trim();
const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase() && clean(a) !== "";

/* Move a record to a new status. Rules:
     - leaving Draft needs a named REVIEWER (who is reviewing it);
     - Approved / Baselined need a named APPROVER;
     - going back below Approved withdraws the approval (approver cleared); going back to Draft starts a new cycle (reviewer cleared too);
     - approver == reviewer is allowed but recorded (selfApproved), so the audit trail shows it was not a two-person review.
   Returns { ok:true, rec, selfApproved } or { ok:false, reason }. */
export function transition(rec, to, today, who = {}) {
  if (!ORDER.includes(to)) return { ok: false, reason: "Unknown status “" + to + "”." };
  const next = { ...(rec || {}) };
  if (clean(who.reviewer)) next.reviewer = clean(who.reviewer);
  if (clean(who.approver)) next.approver = clean(who.approver);
  if (rank(to) >= rank("In Review") && !clean(next.reviewer)) return { ok: false, reason: "Record who is reviewing it before it can leave Draft." };
  if (rank(to) >= rank("Approved") && !clean(next.approver)) return { ok: false, reason: "Record the approver before approving." };
  if (rank(to) < rank("Approved")) { delete next.approver; delete next.selfApproved; }
  if (to === "Draft") delete next.reviewer;
  const selfApproved = rank(to) >= rank("Approved") && same(next.reviewer, next.approver);
  if (selfApproved) next.selfApproved = true; else delete next.selfApproved;
  next.status = to; next.date = today; delete next.revokedAt;
  return { ok: true, rec: next, selfApproved };
}

/* Content changed after review: an Approved/Baselined record falls back to In Review (the reviewer stays, the approval is withdrawn). */
export function revokeOnEdit(rec, today) {
  const cur = statusOfRec(rec);
  if (cur !== "Approved" && cur !== "Baselined") return { changed: false, rec };
  const next = { ...rec, status: "In Review", date: today, revokedAt: today }; delete next.approver; delete next.selfApproved;
  return { changed: true, rec: next, from: cur };
}

/* A Behavior Model's review status is derived from its own approval flow (QM confirmation + approval happen in the Behavior Models panel):
   draft -> Draft · proposed -> In Review · approved -> Approved · approved AND frozen unchanged in a baseline -> Baselined. */
export function modelReviewStatus(model, frozenHashes, hashFn) {
  if (!model) return "Draft";
  if (model.status === "approved") return frozenHashes && hashFn && frozenHashes.has(hashFn(model)) ? "Baselined" : "Approved";
  return model.status === "proposed" ? "In Review" : "Draft";
}
/* Hashes of the APPROVED models frozen in the given baselines. */
export function frozenModelHashes(baselines, hashFn) {
  const s = new Set();
  (baselines || []).forEach((b) => Object.values((b && b.snap && b.snap.behaviorModels) || {}).forEach((m) => { if (m && m.status === "approved") s.add(hashFn(m)); }));
  return s;
}

/* Counts for the dashboard / Review Board from a list of statuses. */
export function rollup(statuses) {
  const c = { "Draft": 0, "In Review": 0, "Approved": 0, "Baselined": 0 }; (statuses || []).forEach((s) => { c[ORDER.includes(s) ? s : "Draft"]++; });
  const total = (statuses || []).length, approved = c["Approved"] + c["Baselined"];
  return { total, counts: c, approved, baselined: c["Baselined"], inReview: c["In Review"], draft: c["Draft"], approvedPct: total ? Math.round((100 * approved) / total) : 0 };
}
