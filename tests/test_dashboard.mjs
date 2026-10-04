// Unit tests for the Home dashboard's pure aggregation core (dashboard.js → computeDashboard).
// No DOM/jsdom needed: computeDashboard is IO-free — it takes normalized data and returns a view model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// A DOM must exist BEFORE requiring dashboard.js so its browser render layer runs and exposes moduleCard.
const dom = new JSDOM("<!doctype html><body></body>");
global.window = dom.window; global.document = dom.window.document;
const { computeDashboard, openWhenReady, moduleCard } = require("../web/dashboard.js");   // CommonJS; pulls in review.js

const TODAY = "2026-07-10";
const mlDeck = (extra) => Object.assign({ key: "ml-srs-v1", module: "ml", moduleLabel: "ML", title: "ML", items: [], srs: {}, qsrs: {} }, extra);

test("wrong answers group by module → concept, most-overdue first, with question text", () => {
  const decks = [mlDeck({
    items: [{ id: "a", label: "Concept A" }, { id: "c", label: "Concept C" }, { id: "b", label: "Concept B" }],
    qsrs: {
      "a-q1": { box: 1, reps: 1, last: "2026-07-05", grade: "bad" },   // due 07-06 → overdue 4
      "c-q0": { box: 1, reps: 1, last: "2026-07-03", grade: "bad" },   // due 07-04 → overdue 6
      "b-q0": { box: 2, reps: 2, last: "2026-07-06", grade: "good" },  // right answer → not a gap
    },
  })];
  const r = computeDashboard({ today: TODAY, decks, topics: [], quizText: { "a-q1": "What is precision?", "c-q0": "Define AUC" } });
  assert.equal(r.wrong.length, 1);
  assert.equal(r.wrong[0].moduleLabel, "ML");
  assert.deepEqual(r.wrong[0].concepts.map(c => c.cid), ["c", "a"]);   // most-overdue gap first
  assert.equal(r.wrong[0].concepts[0].concept, "Concept C");
  assert.deepEqual(r.wrong[0].concepts[0].questions, ["Define AUC"]);
  assert.equal(r.modules[0].missed, 2);
});

test("deck next-step: an open gap (wrong answer) is prioritized over due reviews", () => {
  const decks = [mlDeck({
    items: [{ id: "a", label: "Concept A" }, { id: "b", label: "Concept B" }],
    srs: { a: { box: 1, reps: 1, last: "2026-07-01", grade: "good" } },   // a is an overdue review
    qsrs: { "b-q0": { box: 1, reps: 1, last: "2026-07-05", grade: "bad" } },   // b is a gap
  })];
  const ml = computeDashboard({ today: TODAY, decks, topics: [], quizText: {} }).modules[0];
  assert.equal(ml.next.title, "Concept B");         // the gap, not a's review
  assert.equal(ml.next.id, "b");                    // carries the card id for deep-linking
  assert.match(ml.next.sub, /revisit/);
});

test("deck next-step: falls back to most-overdue review, then to a fresh card; box 5 = mastered", () => {
  const withReviews = [mlDeck({
    items: [{ id: "a", label: "Concept A" }, { id: "b", label: "Concept B" }, { id: "fresh", label: "Fresh One" }],
    srs: { a: { box: 1, reps: 1, last: "2026-07-01", grade: "good" },    // overdue 8
           b: { box: 1, reps: 1, last: "2026-07-08", grade: "shaky" } }, // overdue 1
  })];
  assert.equal(computeDashboard({ today: TODAY, decks: withReviews, topics: [], quizText: {} }).modules[0].next.title, "Concept A");

  const caughtUp = [mlDeck({
    items: [{ id: "a", label: "Concept A" }, { id: "fresh", label: "Fresh One" }],
    srs: { a: { box: 5, reps: 6, last: "2026-07-09", grade: "good" } },  // mastered, not due
  })];
  const m = computeDashboard({ today: TODAY, decks: caughtUp, topics: [], quizText: {} }).modules[0];
  assert.equal(m.next.title, "Fresh One");
  assert.equal(m.next.sub, "new — never studied");
  assert.equal(m.done, 1);   // box 5 counts as mastered
});

test("topic next-step: the next unlocked & unmastered concept by order", () => {
  const base = {
    id: "rag", title: "RAG", total: 3,
    concepts: [{ id: "root", title: "Root", order: 1 }, { id: "mid", title: "Mid", order: 2 }, { id: "adv", title: "Adv", order: 3 }],
    graph: { root: { requires: [] }, mid: { requires: ["root"] }, adv: { requires: ["mid"] } },
    progress: { root: { mastery: "Mastered" } },   // root done → mid unlocked, adv still locked
    quizSrs: {},
  };
  const t = computeDashboard({ today: TODAY, decks: [], topics: [base], quizText: {} }).modules[0];
  assert.equal(t.next.title, "Mid");
  assert.equal(t.next.id, "mid");                   // carries the concept id for deep-linking
  assert.equal(t.next.sub, "next unlocked");
  assert.equal(t.done, 1);
  assert.equal(t.total, 3);
});

// The bug this pins: a topic's quiz bank only grows, so if a due review outranked the next lesson,
// "Next up" would stay stuck on an already-mastered concept and finishing lessons would never move it.
test("topic next-step: an overdue quiz review does NOT hijack Next up — the next lesson still wins", () => {
  const topic = {
    id: "rag", title: "RAG", total: 3,
    concepts: [{ id: "root", title: "Root", order: 1 }, { id: "mid", title: "Mid", order: 2 }, { id: "adv", title: "Adv", order: 3 }],
    graph: { root: { requires: [] }, mid: { requires: ["root"] }, adv: { requires: ["mid"] } },
    progress: { root: { mastery: "Mastered" } },
    quizSrs: { "root#h": { box: 1, reps: 1, last: "2026-07-01", grade: "shaky" } },   // long overdue, already mastered
  };
  const t = computeDashboard({ today: TODAY, decks: [], topics: [topic], quizText: {} }).modules[0];
  assert.equal(t.next.id, "mid", "advances to the next lesson, not back to the mastered one");
  assert.equal(t.next.sub, "next unlocked");
  assert.equal(t.due, 1, "the review backlog still surfaces via the `N due` chip");

  // mastering `mid` advances Next up again — the thing that used to be impossible
  topic.progress.mid = { mastery: "Mastered" };
  assert.equal(computeDashboard({ today: TODAY, decks: [], topics: [topic], quizText: {} }).modules[0].next.id, "adv");
});

test("topic next-step: falls back to the most-overdue review once every concept is mastered", () => {
  const topic = {
    id: "rag", title: "RAG", total: 2,
    concepts: [{ id: "root", title: "Root", order: 1 }, { id: "mid", title: "Mid", order: 2 }],
    graph: { root: { requires: [] }, mid: { requires: ["root"] } },
    progress: { root: { mastery: "Mastered" }, mid: { mastery: "Mastered" } },
    quizSrs: { "root#h": { box: 1, reps: 1, last: "2026-07-01", grade: "shaky" } },
  };
  const t = computeDashboard({ today: TODAY, decks: [], topics: [topic], quizText: {} }).modules[0];
  assert.equal(t.next.sub, "review due");
  assert.equal(t.next.id, "root");
  assert.ok(t.next.over > 0, "carries overdue days so pickHero can rank it");
});

test("openWhenReady: calls the view opener with the id once it registers, then stops polling", () => {
  const openers = {}, calls = [], queue = [];
  let t = 0;
  // a deck/topic view hasn't registered its opener yet (async first-init)
  openWhenReady("ml-srs-v1", "confusion_matrix", { getOpener: (k) => openers[k], schedule: (fn) => queue.push(fn), now: () => t, budget: 500 });
  assert.equal(calls.length, 0);        // opener absent → not called
  assert.equal(queue.length, 1);        // …a retry is scheduled
  openers["ml-srs-v1"] = (id) => calls.push(id);   // view finishes init and registers its opener
  t = 200; queue.shift()();             // the scheduled retry runs
  assert.deepEqual(calls, ["confusion_matrix"]);   // opened the exact card
  assert.equal(queue.length, 0);        // found it → no further polling
});

test("openWhenReady: gives up after the budget without throwing or looping forever", () => {
  const queue = []; let t = 0, iters = 0;
  openWhenReady("never", "x", { getOpener: () => undefined, schedule: (fn) => queue.push(fn), now: () => t, budget: 250 });
  while (queue.length) { t += 100; iters++; queue.shift()(); if (iters > 50) throw new Error("did not stop"); }
  assert.ok(iters <= 3);                // 0/100/200 < 250 reschedule; 300 ≥ 250 stops
});

test("openWhenReady: opener already present → opens immediately, no polling", () => {
  const calls = [], queue = [];
  openWhenReady("rag", "bm25", { getOpener: () => (id) => calls.push(id), schedule: (fn) => queue.push(fn), now: () => 0, budget: 500 });
  assert.deepEqual(calls, ["bm25"]);
  assert.equal(queue.length, 0);
});

test("hero priority: overdue review → gap → warm-up → new material", () => {
  const review = computeDashboard({ today: TODAY, topics: [], decks: [mlDeck({ items: [{ id: "a", label: "A" }], srs: { a: { box: 1, reps: 1, last: "2026-07-01", grade: "good" } } })] });
  assert.equal(review.hero.verb, "Review");
  assert.equal(review.hero.title, "A");

  const gap = computeDashboard({ today: TODAY, topics: [], quizText: {}, decks: [mlDeck({ items: [{ id: "a", label: "A" }], qsrs: { "a-q0": { box: 1, reps: 1, last: "2026-07-05", grade: "bad" } } })] });
  assert.equal(gap.hero.verb, "Revisit");

  const warm = computeDashboard({ today: TODAY, decks: [], topics: [], algo: { done: 1, total: 10, warmupDone: false, next: { navKey: "algorithms", title: "Two Sum", sub: "arrays", href: "x" }, pool: [] } });
  assert.equal(warm.hero.verb, "Solve");
  assert.equal(warm.hero.title, "Two Sum");

  const fresh = computeDashboard({ today: TODAY, decks: [], topics: [{ id: "rag", title: "RAG", total: 1, concepts: [{ id: "root", title: "Root", order: 1 }], graph: { root: { requires: [] } }, progress: {}, quizSrs: {} }] });
  assert.equal(fresh.hero.verb, "Learn");
  assert.equal(fresh.hero.title, "Root");
});

test("modules report the attempted / in-progress count (studied but not mastered)", () => {
  const decks = [mlDeck({
    items: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }],
    srs: { a: { box: 5, reps: 6, last: "2026-07-09", grade: "good" },   // mastered
           b: { box: 2, reps: 2, last: "2026-07-08", grade: "shaky" },  // in progress
           c: { box: 1, reps: 1, last: "2026-07-07", grade: "bad" } },  // in progress (d is untouched)
  })];
  const topic = {
    id: "rag", title: "RAG", total: 3,
    concepts: [{ id: "x", title: "X", order: 1 }, { id: "y", title: "Y", order: 2 }, { id: "z", title: "Z", order: 3 }],
    graph: { x: { requires: [] }, y: { requires: [] }, z: { requires: [] } },
    progress: { x: { mastery: "Mastered" }, y: { mastery: "Learning" } }, quizSrs: {},   // 1 mastered, 1 learning, 1 untouched
  };
  const r = computeDashboard({ today: TODAY, decks, topics: [topic], algo: { done: 30, attempted: 12, total: 116, warmupDone: true, next: null, pool: [] } });
  const byKind = k => r.modules.find(m => m.kind === k);
  assert.equal(byKind("deck").done, 1);
  assert.equal(byKind("deck").attempted, 2);   // b + c studied, not mastered
  assert.equal(byKind("topic").done, 1);
  assert.equal(byKind("topic").attempted, 1);  // y is "Learning"
  assert.equal(byKind("algo").attempted, 12);  // passed through from buildAlgo
});

// ---- render layer (jsdom): a module card's header links to that module's tab ----
const mkModule = o => Object.assign({ key: "k", kind: "deck", navKey: "k", title: "T", done: 0, total: 1, due: 0, missed: 0, next: null, pool: [] }, o);

test("module card header is an accessible link to the module's own tab (never external)", () => {
  const nav = []; let opened = 0;
  window.switchTab = k => nav.push(k);
  window.open = () => { opened++; return null; };
  const algo = moduleCard(mkModule({ key: "algorithms", kind: "algo", navKey: "algorithms", title: "Algorithms" }));
  const deck = moduleCard(mkModule({ key: "ml-srs-v1", kind: "deck", navKey: "ml-srs-v1", title: "ML" }));
  const topic = moduleCard(mkModule({ key: "rag", kind: "topic", navKey: "rag", title: "RAG" }));
  const head = c => c.querySelector(".dash-phead");
  assert.equal(head(algo).getAttribute("role"), "link");   // focusable link semantics
  assert.equal(head(algo).tabIndex, 0);
  head(algo).click(); head(deck).click(); head(topic).click();
  assert.deepEqual(nav, ["algorithms", "ml-srs-v1", "rag"]);   // each header → its module's tab
  assert.equal(opened, 0);                                     // header nav is in-app, never opens LeetCode
});

test("module card header activates with the keyboard (Enter)", () => {
  const nav = []; window.switchTab = k => nav.push(k);
  const card = moduleCard(mkModule({ key: "mcp", kind: "topic", navKey: "mcp", title: "MCP" }));
  card.querySelector(".dash-phead").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(nav, ["mcp"]);
});

test("module card legend shows mastered / in-progress / to-start counts", () => {
  const card = moduleCard(mkModule({ key: "ml-srs-v1", kind: "deck", navKey: "k", title: "ML", done: 3, attempted: 5, total: 20 }));
  assert.equal(card.querySelector(".dash-lg-done b").textContent, "3");
  assert.equal(card.querySelector(".dash-lg-wip b").textContent, "5");     // the "in progress" bucket the user asked for
  assert.equal(card.querySelector(".dash-lg-todo b").textContent, "12");   // 20 − 3 − 5 untouched
});
