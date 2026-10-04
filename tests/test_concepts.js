/* Self-check for concepts.js — run: node test_concepts.js  (ponytail: one runnable check, no framework) */
const assert = require("assert");
const R = require("../web/review.js");
const { create, norm } = require("../web/concepts.js");

// in-memory storage so the tracking logic runs without a browser
const memStorage = (init) => {
  const box = { s: init || {} };
  return { load: () => box.s, save: (x) => { box.s = x; }, dump: () => box.s, _box: box };
};
// pin "today" so scheduling is deterministic
const T = "2026-02-10";
const RD = Object.assign({}, R, { isoDay: () => T });

// ---- keys are the concept's identity: case/whitespace-insensitive, so the same idea collapses ----
assert.equal(norm(" Recall "), "recall");
assert.equal(norm(null), "");
{
  const C = create(RD, memStorage());
  C.grade("Recall", "good");
  assert.ok(C.has("recall"), "'Recall' and 'recall' are the same concept");
  assert.equal(C.get("  recall  ").box, 2, "good on a new concept → box 2");
}

// ---- grade transitions (Leitner), reps, date, first-seen ----
{
  const C = create(RD, memStorage());
  const r1 = C.grade("bm25", "good");
  assert.deepEqual([r1.box, r1.reps, r1.last, r1.grade], [2, 1, T, "good"], "good → box 2, stamped with our clock");
  assert.equal(C.grade("bm25", "shaky").box, 2, "shaky → stay in the same box");
  const r3 = C.grade("bm25", "bad");
  assert.equal(r3.box, 1, "gap → back to box 1");
  assert.equal(r3.reps, 3, "reps accumulate across reviews");
  assert.equal(C.get("bm25").first, T, "first-seen is preserved across grades");
}

// ---- provenance/detail merges without touching the key or the SRS math ----
{
  const C = create(RD, memStorage());
  C.grade("recall", "good", { source: "rag", score: 67 });
  assert.equal(C.get("recall").source, "rag");
  assert.equal(C.get("recall").score, 67);
  assert.equal(C.get("recall").box, 2);
}

// ---- set() patches directly (no SRS transition); remove() forgets ----
{
  const C = create(RD, memStorage());
  C.set("recall", { label: "Recall", box: 4 });
  assert.equal(C.get("recall").box, 4, "set writes raw fields");
  assert.equal(C.get("recall").reps, undefined, "set does NOT run a grade transition");
  C.remove("Recall");
  assert.equal(C.get("recall"), null);
  assert.equal(C.has("recall"), false);
}

// ---- has / all / keys, and all() is a copy (not the live store) ----
{
  const C = create(RD, memStorage());
  C.grade("a", "good"); C.grade("b", "bad");
  assert.deepEqual(C.keys().sort(), ["a", "b"]);
  assert.equal(C.has("a"), true); assert.equal(C.has("z"), false);
  const snap = C.all(); delete snap.a;
  assert.ok(C.has("a"), "all() returns a shallow copy — mutating it can't corrupt the store");
}

// ---- scheduling: never-seen = due now; just-reviewed (box2 = 3 days) = not due today ----
{
  const C = create(RD, memStorage());
  assert.equal(C.isDue("never-seen"), true, "an untracked concept is due");
  C.grade("chunking", "good");
  assert.equal(C.isDue("chunking"), false, "just reviewed → not due today");
  assert.equal(C.dueDate("chunking"), R.addDays(T, 3), "box 2 → due in 3 days");
  assert.equal(typeof C.reason("chunking"), "string");
  assert.ok(C.reason("chunking").length > 0, "reason() gives a human line");
}

// ---- due(): most-overdue first; candidates may include untracked (due-now) keys ----
{
  const store = { a: { box: 1, last: "2026-02-01", grade: "good" }, b: { box: 1, last: "2026-02-09", grade: "good" } };
  const C = create(RD, memStorage(store));
  assert.deepEqual(C.due(["a", "b", "c"]), ["c", "a", "b"], "c never-seen, a overdue 8d, b overdue 0");
}

// ---- due() with no args = every tracked concept that's actually due, filtering the rest ----
{
  const store = { seen: { box: 2, last: T }, overdue: { box: 1, last: "2026-01-01", grade: "bad" } };
  const C = create(RD, memStorage(store));
  assert.deepEqual(C.due(), ["overdue"], "seen-today (box 2 → due T+3) is filtered out");
}

// ---- stats() rollup for a future overview ----
{
  const store = { a: { box: 3, last: "2026-01-01" }, b: { box: 1, last: T } };
  const st = create(RD, memStorage(store)).stats();
  assert.equal(st.total, 2);
  assert.deepEqual([st.boxes[3], st.boxes[1]], [1, 1]);
  assert.equal(st.due, 1, "a (box3, long overdue) due; b (just seen) not");
}

// ---- persistence: grade writes through storage.save; a fresh instance loads it back ----
{
  const s = memStorage();
  create(RD, s).grade("hnsw", "good");
  assert.ok(s.dump().hnsw, "grade persisted via storage.save");
  assert.equal(create(RD, memStorage(s.dump())).get("hnsw").box, 2, "reloads the saved store");
}

// ---- reload(): pick up state changed underneath us (e.g. a fresh sync from state.json) ----
{
  const s = memStorage({ a: { box: 2, last: "2026-02-01" } });
  const C = create(RD, s);
  assert.equal(C.get("a").box, 2);
  s.load = () => ({ a: { box: 5, last: "2026-02-01" }, z: { box: 1 } });   // external change
  C.reload();
  assert.equal(C.get("a").box, 5, "reload() re-reads the store");
  assert.ok(C.has("z"), "reload() sees newly-synced concepts");
}

// ---- browser binding: window.Concepts auto-creates from window.Review and syncs like the app ----
{
  delete require.cache[require.resolve("../web/concepts.js")];
  const ls = {};
  let pushed = 0;
  global.localStorage = { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } };
  global.window = { Review: R, __pushState: () => { pushed++; }, console };
  require("../web/concepts.js");
  const C = global.window.Concepts;
  assert.ok(C, "window.Concepts is created when window.Review is present");
  C.grade("Recall", "good", { source: "rag" });   // one concept, seen in RAG…
  C.grade("recall", "shaky", { source: "ml" });    // …then again from ML → the same record
  assert.equal(C.get("recall").reps, 2, "same key across different sources = one shared record");
  assert.equal(C.get("recall").source, "ml", "latest provenance wins on the shared record");
  assert.ok("concepts-v1" in ls, "persisted into the concepts-v1 bucket");
  assert.ok(pushed > 0, "pushState fired to mirror into state.json");
  delete global.window;
  delete global.localStorage;
}

console.log("concepts.js ok");
