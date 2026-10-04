/* Timed-review kernel — shared spaced-repetition scheduling, ranking & grade transitions.
   Pure (no DOM); loaded before study.js and used by the ml/llm decks. The algorithms
   warm-up (roadmap.html) could adopt recommend()/dueDate() too. Also node-requirable for tests.

   A card's review state is {box, reps, last, grade}; box picks the Leitner interval. */
(function (root) {
  "use strict";
  const BOX_DAYS = { 1: 1, 2: 3, 3: 7, 4: 21, 5: 60 };          // box -> days until due again
  const GRADE_RANK = { bad: 0, shaky: 1, good: 2 };             // worst surfaces first when ranking

  const isoDay = () => new Date().toISOString().slice(0, 10);
  const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };  // UTC throughout, matches isoDay()
  const dueDate = s => (s && s.last) ? addDays(s.last, BOX_DAYS[s.box] || 1) : "";        // "" = never reviewed → due now
  const overdueDays = (s, today) => { const dd = dueDate(s); return dd === "" ? Infinity : Math.round((Date.parse(today) - Date.parse(dd)) / 86400000); };
  const isDue = (s, today) => { const dd = dueDate(s); return dd === "" || dd <= today; };

  // Apply a grade, returning the new state — the Leitner transition lives here, not in the UI.
  function applyGrade(state, kind, today) {
    const s = Object.assign({ box: 1, reps: 0 }, state);
    if (kind === "bad") s.box = 1;                               // gap → back to daily
    else if (kind === "good") s.box = Math.min(5, (s.box || 1) + 1);  // got it → longer interval
    // shaky → keep current box
    s.last = today || isoDay(); s.reps = (s.reps || 0) + 1; s.grade = kind;
    return s;
  }

  // The "study first" order: the due items, most-overdue first, then weakest last grade.
  // items: [{id,...}]; srsOf(id) -> state|undefined.
  function recommend(items, srsOf, today) {
    today = today || isoDay();
    return items
      .filter(i => isDue(srsOf(i.id), today))
      .map(i => ({ item: i, s: srsOf(i.id), over: overdueDays(srsOf(i.id), today) }))
      .sort((a, b) => b.over - a.over
        || (GRADE_RANK[(a.s || {}).grade] ?? 3) - (GRADE_RANK[(b.s || {}).grade] ?? 3))
      .map(x => x.item);
  }

  // One-line "why this first" for the banner.
  function reason(s, today) {
    today = today || isoDay();
    if (!s || !s.last) return "new — never reviewed";
    const over = overdueDays(s, today);
    const g = s.grade === "bad" ? "🔴 was a gap" : s.grade === "shaky" ? "🟡 was shaky" : "🟢 had it";
    return (over > 0 ? `overdue ${over}d` : "due today") + " · " + g;
  }

  const Review = { BOX_DAYS, isoDay, addDays, dueDate, overdueDays, isDue, applyGrade, recommend, reason };
  if (typeof module !== "undefined" && module.exports) module.exports = Review;
  if (root) root.Review = Review;
})(typeof window !== "undefined" ? window : null);
