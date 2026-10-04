/* Concepts — the ONE place that tracks how well you know a concept, keyed by a global concept
   KEY (e.g. "recall"), independent of where it shows up (ML, LLM, RAG, a future topic…). Same
   key ⇒ same concept ⇒ same record, so mastery follows the idea, not the page it appeared on.
   The key IS the identity; wiring concepts into a knowledge graph is a later, separate concern.

   This module owns the STATE and the tracking logic in one spot instead of it being reimplemented
   in study.js / topic.js. Spaced-repetition scheduling is delegated to review.js (window.Review);
   state lives in a single bucket, persisted to localStorage["concepts-v1"] and mirrored to
   state.json (the server's single source of truth) via the app's pushState.

     Browser:  Concepts.grade("recall", "good")   ·   Concepts.due()   ·   Concepts.get("recall")
     Node:     const { create } = require("./concepts.js"); create(Review, storage)   // for tests

   A record is review.js's SRS shape {box, reps, last, grade} + {first} + any caller `extra`. */
(function (root) {
  "use strict";
  const STORAGE_KEY = "concepts-v1";
  const norm = (k) => String(k == null ? "" : k).trim().toLowerCase();   // keys are case/space-insensitive

  // The logic, with its two dependencies injected — so it runs headless in node tests with fakes.
  function create(Review, storage) {
    let store = storage.load() || {};
    const persist = () => storage.save(store);
    const today = () => Review.isoDay();
    const rec = (k) => store[k] || null;

    return {
      // ---- read ----
      get(key) { return rec(norm(key)); },
      has(key) { return norm(key) in store; },
      all() { return Object.assign({}, store); },
      keys() { return Object.keys(store); },

      // ---- record a review outcome ("good" | "shaky" | "bad") ----
      // Advances the Leitner box and stamps the date via review.js. `extra` merges arbitrary fields
      // onto the record (e.g. {source:"rag", score:67}) — provenance/detail without changing the key.
      grade(key, kind, extra) {
        const k = norm(key);
        const next = Review.applyGrade(store[k], kind, today()); // {box, reps, last, grade} — stamp with our clock
        store[k] = Object.assign({ first: today() }, store[k], next, extra || {});
        persist();
        return store[k];
      },

      // patch a record directly (metadata / seeding) — no SRS transition
      set(key, patch) { const k = norm(key); store[k] = Object.assign({}, store[k], patch); persist(); return store[k]; },
      remove(key) { delete store[norm(key)]; persist(); },

      // ---- scheduling (delegated to review.js). An untracked key = "due now" (never reviewed). ----
      isDue(key) { return Review.isDue(rec(norm(key)), today()); },
      dueDate(key) { return Review.dueDate(rec(norm(key))); },
      reason(key) { return Review.reason(rec(norm(key)), today()); },

      // concepts due for review, most-overdue / weakest first. Pass candidate keys, or omit for all.
      due(keys) {
        const ks = (keys || Object.keys(store)).map(norm);
        return Review.recommend(ks.map((id) => ({ id })), (id) => store[id], today()).map((x) => x.id);
      },

      // rollup for a future overview screen
      stats() {
        const ks = Object.keys(store), boxes = {};
        let due = 0;
        for (const k of ks) { const s = store[k]; boxes[s.box || 0] = (boxes[s.box || 0] || 0) + 1; if (Review.isDue(s, today())) due++; }
        return { total: ks.length, due, boxes };
      },

      reload() { store = storage.load() || {}; return store; },   // re-read after an external state sync
    };
  }

  // Browser storage: the "concepts-v1" bucket, mirrored to state.json via pushState (its key is in
  // STATE_KEYS in roadmap.html). The load side is handled by roadmap's boot XHR (state.json → localStorage).
  function browserStorage() {
    return {
      load() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (_) { return {}; } },
      save(store) { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); if (root && root.__pushState) root.__pushState(); },
    };
  }

  if (root) {
    if (root.Review) { root.Concepts = create(root.Review, browserStorage()); root.Concepts.create = create; }
    else if (root.console) root.console.warn("concepts.js: window.Review missing — load review.js first");
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { create, norm, STORAGE_KEY };
})(typeof window !== "undefined" ? window : null);
