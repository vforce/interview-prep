// Interaction tests for the ML-tab quiz-first flow in study.js — clicking a concept/kata runs
// its retrieval quiz, then reveals the card. Drives the REAL study.js inside jsdom (stubbing
// fetch/localStorage/Review/CodeMirror). Run: node --test test_study.mjs   (or `make test`).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const Review = require("../web/review.js");                 // the real spaced-repetition kernel
const STUDY_SRC = readFileSync(new URL("../web/study.js", import.meta.url), "utf8");

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

// Build a jsdom window with study.js loaded and a one-deck study view initialised.
function setup({ conceptQuiz = 4, kataQuiz = 3, noQuizConcept = false, preseedQsrs = null } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const document = window.document;

  window.Review = Review;
  const pushCalls = { n: 0 };
  window.__pushState = () => { pushCalls.n++; };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  if (!window.performance) window.performance = { now: () => Date.now() };
  window.setInterval = () => 0; window.clearInterval = () => {};       // no live clock in tests

  const quiz = { "ml-srs-v1": [
    ...Array.from({ length: conceptQuiz }, (_, i) => ({ id: `c1-q${i}`, q: `CQ${i}?`, choices: ["a", "b", "c", "d"], answer: i % 4, term: "Front C1?" })),
    ...Array.from({ length: kataQuiz }, (_, i) => ({ id: `k1-q${i}`, q: `KQ${i}?`, choices: ["a", "b", "c", "d"], answer: 0, term: "Kata One" })),
  ] };
  window.fetch = async (url) => ({ json: async () => (String(url).includes("/api/quiz") ? quiz : { ok: true }) });

  if (preseedQsrs) window.localStorage.setItem("ml-srs-v1::quiz-srs", JSON.stringify(preseedQsrs));

  window.eval(STUDY_SRC);                                              // defines window.StudyDeck; initDecks no-ops (no registerDeckView)

  const cfg = {
    key: "ml-srs-v1", title: "ML", eyebrow: "e", areas: ["Metrics"],
    concepts: [
      { id: "c1", area: "Metrics", front: "Front C1?", back: "Back C1 answer.", more: "More C1." },
      ...(noQuizConcept ? [{ id: "c2", area: "Metrics", front: "Front C2 no quiz?", back: "Back C2." }] : []),
    ],
    katas: [{ id: "k1", area: "Metrics", title: "Kata One", prompt: "do it", sig: "def f():", stub: "    pass", reference: "return 1" }],
  };
  const host = document.createElement("div"); host.className = "deck-view"; document.body.appendChild(host);
  window.StudyDeck(cfg).init(host);
  return { window, document, host, quiz, pushCalls };
}

const sess = host => host.querySelector(".deck-session");
const chipFor = (host, text) => [...host.querySelectorAll(".deck-browse .ml-chip")].find(c => c.textContent.includes(text));
// answer the currently-shown question (click option `optIndex`) and advance; returns the question text seen.
function answerAndAdvance(host, optIndex = 0) {
  const qText = sess(host).querySelector(".ml-front").textContent;
  sess(host).querySelectorAll(".quiz-opt")[optIndex].click();
  sess(host).querySelector(".quiz-next").click();
  return qText;
}

test("clicking a concept starts a 3-question retrieval quiz, not the flashcard", async () => {
  const { host } = setup();
  chipFor(host, "Front C1").click();
  await flush();
  assert.equal(sess(host).querySelector(".ml-back"), null, "should not jump straight to the flashcard answer");
  assert.match(sess(host).querySelector(".ml-prog").textContent, /retrieval · 1\/3/);
  assert.equal(sess(host).querySelectorAll(".quiz-opt").length, 4);
});

test("answering all 3 reveals the concept card with the answer already open (no 2nd click)", async () => {
  const { host } = setup();
  chipFor(host, "Front C1").click();
  await flush();
  for (let i = 0; i < 3; i++) { answerAndAdvance(host); await flush(1); }
  const s = sess(host);
  assert.ok(s.querySelector(".ml-back"), "answer body rendered");
  assert.equal(s.querySelector(".ml-answer").hidden, false, "answer is visible immediately");
  assert.equal(s.querySelector(".ml-show"), null, "no redundant 'Show answer' button");
  assert.ok(s.querySelector(".ml-grade"), "self-grade buttons present");
  assert.match(s.querySelector(".ml-quiz-note").textContent, /Retrieval —/, "retrieval score shown");
});

test("each answer records correctness + latency into qsrs and pushes state", async () => {
  const { host, window, pushCalls } = setup();
  chipFor(host, "Front C1").click();
  await flush();
  sess(host).querySelectorAll(".quiz-opt")[0].click();                // c1-q0 answer is 0 → correct
  const qsrs = JSON.parse(window.localStorage.getItem("ml-srs-v1::quiz-srs"));
  const st = qsrs["c1-q0"];
  assert.ok(st, "qsrs entry written for the answered question");
  assert.equal(st.grade, "good");
  assert.ok(st.box >= 2, "correct answer advanced the Leitner box");
  assert.equal(typeof st.ms, "number", "answer latency (ms) recorded");
  assert.ok(pushCalls.n > 0, "state pushed to the server");
});

test("questions are served least-recently-reviewed first (unseen before seen)", async () => {
  // c1-q0 reviewed most recently, c1-q1 earlier; c1-q2/q3 never seen.
  const { host } = setup({ conceptQuiz: 4, preseedQsrs: {
    "c1-q0": { box: 3, last: "2099-01-02", reps: 1 },
    "c1-q1": { box: 2, last: "2099-01-01", reps: 1 },
  } });
  chipFor(host, "Front C1").click();
  await flush();
  const seen = [];
  for (let i = 0; i < 3; i++) { seen.push(answerAndAdvance(host)); await flush(1); }
  assert.deepEqual(seen, ["CQ2?", "CQ3?", "CQ1?"], "unseen first, then the older-reviewed; most-recent (q0) excluded");
});

test("clicking a kata runs the quiz then opens the kata editor, not a flashcard", async () => {
  const { host } = setup();
  chipFor(host, "Kata One").click();
  await flush();
  assert.match(sess(host).querySelector(".ml-prog").textContent, /retrieval · 1\/3/);
  for (let i = 0; i < 3; i++) { answerAndAdvance(host); await flush(1); }
  const s = sess(host);
  assert.ok(s.querySelector(".kata-code"), "kata code editor rendered");
  assert.ok([...s.querySelectorAll("button")].some(b => /Run tests/.test(b.textContent)), "Run-tests button present");
  assert.equal(s.querySelector(".ml-back"), null, "a kata reveal is not a flashcard answer");
});

test("a concept with no quiz opens the flashcard normally (Show answer, not pre-opened)", async () => {
  const { host } = setup({ noQuizConcept: true });
  chipFor(host, "Front C2").click();
  await flush();
  const s = sess(host);
  assert.equal(s.querySelector(".quiz-opt"), null, "no retrieval quiz when the concept has none");
  assert.ok(s.querySelector(".ml-show"), "normal 'Show answer' button");
  assert.equal(s.querySelector(".ml-answer").hidden, true, "answer stays hidden until Show answer");
});

test("re-clicking within an hour of a quiz skips it and opens the card directly", async () => {
  const recent = { box: 2, last: "2099-01-01", ms: 500, t: Date.now() };
  const { host } = setup({ conceptQuiz: 4, preseedQsrs: { "c1-q0": recent, "c1-q1": recent, "c1-q2": recent, "c1-q3": recent } });
  chipFor(host, "Front C1").click();
  await flush();
  const s = sess(host);
  assert.equal(s.querySelector(".quiz-opt"), null, "quiz is skipped within the 1h cooldown");
  assert.ok(s.querySelector(".ml-show"), "the card opens directly");
});

test("after the 1h cooldown has passed, clicking runs the quiz again", async () => {
  const stale = { box: 2, last: "2099-01-01", ms: 500, t: Date.now() - 2 * 60 * 60 * 1000 };
  const { host } = setup({ conceptQuiz: 4, preseedQsrs: { "c1-q0": stale, "c1-q1": stale, "c1-q2": stale, "c1-q3": stale } });
  chipFor(host, "Front C1").click();
  await flush();
  assert.match(sess(host).querySelector(".ml-prog").textContent, /retrieval/, "quiz runs once the cooldown has passed");
});
