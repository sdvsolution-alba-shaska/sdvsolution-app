// Run: node tests/review.test.mjs — review lifecycle rules for curated requirements and Behavior Models.
import { transition, revokeOnEdit, modelReviewStatus, frozenModelHashes, rollup, statusOfRec, ORDER } from "../src/lib/reviewLifecycle.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL: " + m); } else console.log("ok   " + m); };
const T = "2026-10-12";

ok(ORDER.join() === "Draft,In Review,Approved,Baselined" && statusOfRec(undefined) === "Draft" && statusOfRec({ status: "nonsense" }) === "Draft", "same four statuses as the existing board; unknown values read as Draft");
// leaving Draft needs a reviewer
let r = transition({}, "In Review", T); ok(!r.ok && /who is reviewing/.test(r.reason), "Draft → In Review without a reviewer is refused");
r = transition({}, "In Review", T, { reviewer: " ann@acme.test " }); ok(r.ok && r.rec.status === "In Review" && r.rec.reviewer === "ann@acme.test" && r.rec.date === T, "with a reviewer it moves (name trimmed, dated)");
// approving needs an approver
r = transition(r.rec, "Approved", T); ok(!r.ok && /approver/.test(r.reason), "In Review → Approved without an approver is refused");
const inRev = { status: "In Review", reviewer: "ann@acme.test" };
r = transition(inRev, "Approved", T, { approver: "bob@acme.test" }); ok(r.ok && r.rec.status === "Approved" && r.rec.approver === "bob@acme.test" && !r.selfApproved && !r.rec.selfApproved, "reviewer and a different approver → Approved, not flagged as self-approved");
r = transition(inRev, "Approved", T, { approver: "ANN@acme.test" }); ok(r.ok && r.selfApproved === true && r.rec.selfApproved === true, "approver == reviewer (any case) is allowed but recorded as self-approved");
ok(!transition({ status: "Draft" }, "Approved", T, { approver: "x" }).ok, "cannot jump Draft → Approved without a reviewer on record");
r = transition({ status: "Draft" }, "Approved", T, { reviewer: "a", approver: "b" }); ok(r.ok, "naming both at once is enough (bulk path)");
// going back
const appr = { status: "Approved", reviewer: "ann", approver: "bob", date: "x" };
r = transition(appr, "In Review", T); ok(r.ok && r.rec.reviewer === "ann" && !("approver" in r.rec), "reopening to In Review withdraws the approval but keeps the reviewer");
r = transition(appr, "Draft", T); ok(r.ok && !("approver" in r.rec) && !("reviewer" in r.rec), "back to Draft starts a new cycle (reviewer and approver cleared)");
r = transition(appr, "Baselined", T); ok(r.ok && r.rec.status === "Baselined" && r.rec.approver === "bob", "Approved → Baselined keeps the approval");
ok(!transition({}, "Frozen", T).ok, "unknown target status is refused");
const before = Object.freeze({ status: "In Review", reviewer: "a" }); transition(before, "Approved", T, { approver: "b" }); ok(before.status === "In Review", "the input record is never mutated");

// editing approved content
let v = revokeOnEdit(appr, T); ok(v.changed && v.from === "Approved" && v.rec.status === "In Review" && v.rec.reviewer === "ann" && !("approver" in v.rec) && v.rec.revokedAt === T, "editing an Approved requirement sends it back to In Review (approval withdrawn, date recorded)");
v = revokeOnEdit({ status: "Baselined", reviewer: "a", approver: "b" }, T); ok(v.changed && v.from === "Baselined", "a Baselined requirement is also pulled back when edited");
ok(!revokeOnEdit({ status: "Draft" }, T).changed && !revokeOnEdit({ status: "In Review", reviewer: "a" }, T).changed && !revokeOnEdit(undefined, T).changed, "Draft / In Review / no record are unaffected by edits");
r = transition(v.rec, "In Review", T); ok(r.ok && !("revokedAt" in r.rec), "the revoke marker clears on the next transition");

// models
const hash = (m) => m.id + "@" + m.rev;
const m1 = { id: "BM-A", rev: 2, status: "approved" }, m2 = { id: "BM-B", rev: 1, status: "proposed" }, m3 = { id: "BM-C", rev: 1, status: "draft" };
const frozen = frozenModelHashes([{ snap: { behaviorModels: { "BM-A": { id: "BM-A", rev: 2, status: "approved" }, "BM-B": { id: "BM-B", rev: 1, status: "proposed" } } } }], hash);
ok(frozen.has("BM-A@2") && !frozen.has("BM-B@1"), "only APPROVED models count as frozen in a baseline");
ok(modelReviewStatus(m1, frozen, hash) === "Baselined", "an approved model frozen unchanged in a baseline is Baselined");
ok(modelReviewStatus({ ...m1, rev: 3 }, frozen, hash) === "Approved", "…but once changed after the baseline it is only Approved");
ok(modelReviewStatus(m2, frozen, hash) === "In Review" && modelReviewStatus(m3, frozen, hash) === "Draft" && modelReviewStatus(null, frozen, hash) === "Draft", "proposed → In Review, draft → Draft");
ok(modelReviewStatus(m1, new Set(), hash) === "Approved" && modelReviewStatus(m1, undefined, undefined) === "Approved", "no baselines → Approved");

// rollup
const ru = rollup(["Draft", "Draft", "In Review", "Approved", "Baselined", "bogus"]);
ok(ru.total === 6 && ru.counts.Draft === 3 && ru.approved === 2 && ru.baselined === 1 && ru.inReview === 1 && ru.approvedPct === 33, "rollup: Approved+Baselined count as approved (unknown → Draft): " + ru.approvedPct + "%");
ok(rollup([]).approvedPct === 0 && rollup(undefined).total === 0, "rollup of nothing is 0%, not NaN");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
