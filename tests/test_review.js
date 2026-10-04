/* Self-check for review.js — run: node test_review.js  (ponytail: one runnable check, no framework) */
const assert = require("assert");
const R = require("../web/review.js");

// grade transitions (Leitner)
assert.equal(R.applyGrade({ box: 2, reps: 1 }, "good", "2026-01-01").box, 3);   // got it → up a box
assert.equal(R.applyGrade({ box: 4, reps: 1 }, "bad", "2026-01-01").box, 1);    // gap → back to 1
assert.equal(R.applyGrade({ box: 3, reps: 1 }, "shaky", "2026-01-01").box, 3);  // shaky → stay
assert.equal(R.applyGrade(undefined, "good", "2026-01-01").reps, 1);            // first-ever review

// due-ness
assert.equal(R.dueDate({ box: 1, last: "2026-01-01" }), "2026-01-02");
assert.equal(R.isDue({ box: 1, last: "2026-01-01" }, "2026-01-01"), false);
assert.equal(R.isDue({ box: 1, last: "2026-01-01" }, "2026-01-02"), true);
assert.equal(R.isDue(undefined, "2026-01-01"), true);                           // never seen → due now

// ranking: most overdue first, ties broken by worst grade
const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
const srs = {
  a: { box: 1, last: "2026-01-09", grade: "good" },   // overdue 0
  b: { box: 1, last: "2026-01-01", grade: "good" },   // overdue 8  -> first
  c: { box: 1, last: "2026-01-09", grade: "bad" },    // overdue 0, gap -> before a
};
assert.deepEqual(R.recommend(items, id => srs[id], "2026-01-10").map(x => x.id), ["b", "c", "a"]);

console.log("review.js ok");
