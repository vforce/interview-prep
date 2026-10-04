/* Study-deck engine — Leitner spaced-repetition flashcards (+ optional coding katas).
   Decks are now DATA, loaded from content/*.yaml via GET /api/decks, so adding a new
   section (e.g. system design) is just dropping in another YAML file — no JS changes.

   window.StudyDeck(cfg) builds one subject deck; the loader at the bottom fetches every
   deck and registers a tab + view. Each rendered card gets an "Ask Claude" button via the
   optional window.CardChat hook (chat.js), so you can chat to improve the content in place. */
(function () {
  "use strict";

  // ---- shared helpers ----
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  // Card body fields are authored in markdown — render them (reusing chat.js's renderer+sanitizer),
  // falling back to plain text if chat.js hasn't loaded yet.
  const mdDiv = (cls, text) => {
    const e = el("div", cls), r = window.CardChat && window.CardChat.renderMd;
    if (r) e.innerHTML = r(text); else e.textContent = text;
    return e;
  };
  const R = window.Review;                 // timed-review kernel (review.js): intervals, due-ness, ranking, grade transitions
  const isoDay = R.isoDay;
  const NEW_PER_DAY = 8;
  const BOX_COLOR = { 0: "var(--faint)", 1: "#f87171", 2: "#fb923c", 3: "#fbbf24", 4: "#a3e635", 5: "#34d399" };
  const GRADE = [["good", "🟢 got it", "#34d399"], ["shaky", "🟡 shaky", "#fbbf24"], ["bad", "🔴 gap", "#f87171"]];
  // Per-deck signature accent [primary, secondary] — themes the whole view via --deck / --deck2.
  // ML runs cool (azure→aqua), LLM runs warm (violet→pink) so the sibling decks read as distinct.
  const DECK_ACCENT = { "ml-srs-v1": ["#38bdf8", "#5eead4"], "llm-srs-v1": ["#c084fc", "#f472b6"], _default: ["#38bdf8", "#5eead4"] };

  async function runKata(id, code, out) {
    out.hidden = false; out.className = "kata-out"; out.textContent = "running…";
    try {
      const res = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, code }) });
      const d = await res.json();
      out.className = "kata-out " + (d.ok ? "ok" : "err");
      out.textContent = d.ok ? ("✓ " + (d.output || "all tests passed")) : ("✗ " + (d.error || d.output || "failed"));
    } catch (_) {
      out.className = "kata-out err";
      out.textContent = "⚠ runner unreachable — start server.py and open via localhost (not file://).";
    }
  }

  // ---- one subject deck ----
  function createDeck(cfg) {
    const KEY = cfg.key, AREAS = cfg.areas, TITLE = cfg.title, EYEBROW = cfg.eyebrow;
    const ACCENT = DECK_ACCENT[KEY] || DECK_ACCENT._default;
    const ITEMS = [...cfg.concepts.map(c => ({ ...c, type: "concept" })), ...(cfg.katas || []).map(k => ({ ...k, type: "kata" }))];
    const srs = JSON.parse(localStorage.getItem(KEY) || "{}");
    const persist = () => { localStorage.setItem(KEY, JSON.stringify(srs)); if (window.__pushState) window.__pushState(); };
    // Test-mode spaced repetition, per question id (same Leitner kernel as the flashcards).
    const QSRS_KEY = KEY + "::quiz-srs";
    const qsrs = (() => { try { return JSON.parse(localStorage.getItem(QSRS_KEY) || "{}"); } catch (_) { return {}; } })();
    const persistQsrs = () => { localStorage.setItem(QSRS_KEY, JSON.stringify(qsrs)); if (window.__pushState) window.__pushState(); };
    const gradeQuiz = (qid, ok) => { qsrs[qid] = R.applyGrade(qsrs[qid], ok ? "good" : "bad"); persistQsrs(); };
    const dueDate = id => R.dueDate(srs[id]);
    const isDue = id => R.isDue(srs[id], isoDay());
    const boxLabel = id => { const s = srs[id]; return s && s.last ? `box ${s.box} · worked ${s.reps || 0}×` : "new"; };
    // Leitner box (0–5) as a 5-segment retention meter — fills red→green as the card matures.
    function retentionMeter(id) {
      const box = srs[id] ? (srs[id].box || 0) : 0;
      const m = el("div", "ml-ret"); m.title = "Leitner box " + box + "/5";
      for (let i = 1; i <= 5; i++) { const s = el("span", "ml-seg" + (i <= box ? " on" : "")); if (i <= box) s.style.setProperty("--sc", BOX_COLOR[i]); m.append(s); }
      return m;
    }
    let session = [], index = 0, container = null, mode = "study", quiz = null, testCur = null;

    // Let chat.js attach an "Ask Claude" button to a freshly-built card. The refresh callback
    // re-renders the current card so an applied improvement shows immediately (item is mutated in place).
    function attachChat(card, item) {
      if (window.CardChat) window.CardChat.attach(card, { deckKey: KEY, deckTitle: TITLE, item, refresh: renderSession });
    }
    // "✎ edit" button — sits in the card's tool bar (shared with Ask Claude) and opens the inline editor.
    function addEditButton(card, item) {
      let bar = card.querySelector(".cc-bar");
      if (!bar) { bar = el("div", "cc-bar"); const m = card.querySelector(".ml-meta"); card.insertBefore(bar, m ? m.nextSibling : card.firstChild); }
      const btn = el("button", "ml-edit-btn", "✎ edit");
      btn.onclick = () => container.querySelector(".deck-session").replaceChildren(editCard(item));
      bar.insertBefore(btn, bar.firstChild);
    }
    // Inline editor: a textarea per editable field, saved back to the YAML via /api/card (same endpoint as the chat flow).
    function editCard(item) {
      const spec = item.type === "kata"
        ? [["title", "Title", 1], ["prompt", "Prompt", 3], ["sig", "Signature", 1], ["stub", "Starter code (stub)", 5], ["reference", "Reference solution", 8]]
        : [["front", "Question (front)", 2], ["back", "Answer (back)", 6], ["more", "Deep dive (more) — optional", 12]];
      const card = el("div", "ml-card ml-edit");
      const meta = el("div", "ml-meta");
      meta.append(el("span", "ml-area", item.area || ""), el("span", "ml-prog", "editing"));
      card.append(meta);
      const inputs = {};
      for (const [key, label, rows] of spec) {
        const wrap = el("div", "ml-ed-field");
        wrap.append(el("label", "ml-ed-label", label));
        const ta = el("textarea", "ml-ed-ta"); ta.value = item[key] || ""; ta.rows = rows; ta.spellcheck = false;
        inputs[key] = ta; wrap.append(ta); card.append(wrap);
      }
      const barEl = el("div", "ml-ed-bar");
      const save = el("button", "ml-ed-save", "Save"), cancel = el("button", "ml-ed-cancel", "Cancel"), msg = el("span", "ml-ed-msg");
      barEl.append(save, cancel, msg); card.append(barEl);
      cancel.onclick = () => renderSession();
      save.onclick = async () => {
        save.disabled = true; msg.className = "ml-ed-msg"; msg.textContent = "saving…";
        const fields = {}; for (const [key] of spec) fields[key] = inputs[key].value;
        try {
          const res = await fetch("/api/card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deck: KEY, id: item.id, fields }) });
          const j = await res.json();
          if (!j.ok) throw new Error(j.error || "save failed");
          for (const [key] of spec) item[key] = inputs[key].value.replace(/\n+$/, "");   // live-update the in-memory card
          renderSession(); renderBrowse();
        } catch (e) {
          save.disabled = false; msg.className = "ml-ed-msg err"; msg.textContent = "⚠ " + (e.message || "save failed");
        }
      };
      return card;
    }

    function grade(id, kind) {
      srs[id] = R.applyGrade(srs[id], kind); persist();               // Leitner transition lives in review.js
    }
    function buildSession() {
      const seen = ITEMS.filter(i => srs[i.id] && srs[i.id].last);
      const seenDue = R.recommend(seen, id => srs[id], isoDay());      // due reviews, most-overdue/weakest first
      const fresh = ITEMS.filter(i => !srs[i.id] || !srs[i.id].last).slice(0, NEW_PER_DAY);
      session = [...seenDue, ...fresh]; index = 0;
    }
    function gradeRow(item) {
      const row = el("div", "ml-grade");
      for (const [k, label, c] of GRADE) {
        const b = el("button", null, label); b.style.setProperty("--gc", c);
        b.onclick = () => { grade(item.id, k); index++; renderSession(); renderBrowse(); renderHead(); };
        row.appendChild(b);
      }
      return row;
    }
    function conceptCard(item, revealed) {
      const card = el("div", "ml-card");
      const meta = el("div", "ml-meta");
      meta.append(el("span", "ml-area", item.area), retentionMeter(item.id), el("span", "ml-prog", `${index + 1}/${session.length} · ${boxLabel(item.id)}`));
      const front = el("div", "ml-front", item.front);
      const answer = el("div", "ml-answer"); answer.hidden = true;
      answer.appendChild(mdDiv("ml-back", item.back));                 // short version
      if (item.more) answer.appendChild(mdDiv("ml-more", item.more));  // extended version below
      const actions = el("div", "ml-actions");
      const show = el("button", "ml-show", "Show answer");
      const doShow = () => { answer.hidden = false; actions.replaceChildren(gradeRow(item)); };
      show.onclick = doShow;
      actions.appendChild(show);
      card.append(meta, front, answer, actions);
      attachChat(card, item); addEditButton(card, item);
      if (revealed) doShow();                                         // arrived via the quiz → content already open, no 2nd click
      return card;
    }
    function kataCard(item) {
      const card = el("div", "ml-card kata");
      const meta = el("div", "ml-meta");
      meta.append(el("span", "ml-area", item.area), retentionMeter(item.id), el("span", "ml-prog", `${index + 1}/${session.length} · ${boxLabel(item.id)}`));
      const title = el("div", "ml-front", "🧪 " + item.title);
      const prompt = el("div", "kata-prompt", item.prompt);
      const sig = el("div", "kata-sig", item.sig);
      const ta = el("textarea", "kata-code"); ta.spellcheck = false; ta.value = item.stub || (item.sig + "\n    pass\n");
      ta.addEventListener("keydown", e => {
        if (e.key !== "Tab") return;
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
        if (e.shiftKey) { const ls = v.lastIndexOf("\n", s - 1) + 1, m = v.slice(ls).match(/^ {1,4}/); if (m) ta.setRangeText("", ls, ls + m[0].length, "start"); }
        else ta.setRangeText("    ", s, en, "end");
      });
      const bar = el("div", "kata-bar");
      const runBtn = el("button", "kata-run", "▶ Run tests");
      const refBtn = el("button", "kata-ref", "Reveal reference");
      bar.append(runBtn, refBtn);
      const out = el("pre", "kata-out"); out.hidden = true;
      const refbox = el("pre", "kata-refbox"); refbox.hidden = true; refbox.textContent = item.reference;
      let getCode = () => ta.value;
      runBtn.onclick = () => runKata(item.id, getCode(), out);
      refBtn.onclick = () => { refbox.hidden = !refbox.hidden; refBtn.textContent = refbox.hidden ? "Reveal reference" : "Hide reference"; };
      const actions = el("div", "ml-actions"); actions.appendChild(gradeRow(item));
      card.append(meta, title, prompt, sig, ta, bar, out, refbox, actions);
      attachChat(card, item); addEditButton(card, item);
      if (window.CodeMirror) requestAnimationFrame(() => {
        const cm = CodeMirror.fromTextArea(ta, { mode: "python", theme: "dracula", lineNumbers: true, indentUnit: 4, tabSize: 4, lineWrapping: false, extraKeys: { Tab: c => c.execCommand("insertSoftTab"), "Shift-Tab": c => c.indentSelection("subtract") } });
        getCode = () => cm.getValue();
      });
      return card;
    }
    function nextDueMsg() {
      const dates = ITEMS.map(i => dueDate(i.id)).filter(d => d && d > isoDay()).sort();
      return dates.length ? "Next due " + dates[0] + "." : "Nothing scheduled — try Review early.";
    }
    // ---- daily picks: a frozen "Today's 3" + a wildcard "Random 3" ----
    // Both are frozen per day so a completed card stays put (and crosses out) instead of being
    // recomputed away the moment it's no longer "due".
    // ---- click a concept/kata → 3 timed-retrieval questions FIRST (least-recent via review.js),
    //      then reveal the flashcard/kata. Each answer's correctness + latency (ms) is saved to qsrs → state.json/git. ----
    const ensureQuiz = () => (quiz === null ? loadQuiz() : Promise.resolve(quiz));
    function conceptQuestions(cid) {                                       // this card's 3 least-recently-reviewed questions (never-seen first)
      const own = quiz.filter(q => String(q.id).startsWith(cid + "-q"));
      const last = q => ((qsrs[q.id] || {}).last) || "";                  // "" (never reviewed) sorts first
      return own.slice().sort((a, b) => last(a).localeCompare(last(b))).slice(0, 3);
    }
    const QUIZ_COOLDOWN_MS = 60 * 60 * 1000;                              // once you've quizzed a card, don't re-quiz it for an hour
    function lastQuizAt(cid) {                                            // most-recent answer time across this card's questions (0 = never)
      return quiz.filter(q => String(q.id).startsWith(cid + "-q"))
        .reduce((mx, q) => Math.max(mx, (qsrs[q.id] || {}).t || 0), 0);
    }
    const gradeQuizTimed = (qid, ok, ms) => { qsrs[qid] = R.applyGrade(qsrs[qid], ok ? "good" : "bad"); qsrs[qid].ms = ms; qsrs[qid].t = Date.now(); persistQsrs(); };
    function runConceptQuiz(item, questions, onDone) {
      const host = container.querySelector(".deck-session");
      const label = item.type === "kata" ? "🧪 " + item.title : (item.front || "");
      let qi = 0, correct = 0, totalMs = 0, t0 = 0, timer = null;
      const render = () => {
        const q = questions[qi], card = el("div", "ml-card ml-quiz");
        const clock = el("span", "ml-quiz-clock", "◷ 0.0s");
        const meta = el("div", "ml-meta");
        meta.append(el("span", "ml-area", label.slice(0, 44)), el("span", "ml-prog", "retrieval · " + (qi + 1) + "/" + questions.length), clock);
        const opts = el("div", "quiz-opts"), foot = el("div", "quiz-foot");
        q.choices.forEach((c, i) => {
          const b = el("button", "quiz-opt");
          b.append(el("span", "quiz-key", String.fromCharCode(65 + i)), el("span", "quiz-txt", c));
          b.onclick = () => {
            if (opts.dataset.done) return;
            opts.dataset.done = "1"; if (timer) clearInterval(timer);
            const ms = Math.round(performance.now() - t0); totalMs += ms;
            const ok = i === q.answer; if (ok) correct++;
            [...opts.children].forEach((btn, j) => btn.classList.add(j === q.answer ? "correct" : (j === i ? "wrong" : "dim")));
            gradeQuizTimed(q.id, ok, ms);
            const lastQ = qi + 1 >= questions.length;                    // last question's button reveals the card directly
            const next = el("button", "quiz-next", lastQ ? (item.type === "kata" ? "Open the kata →" : "Reveal the answer →") : "Next →");
            next.onclick = lastQ ? () => onDone({ correct, total: questions.length, ms: totalMs })
                                 : () => { qi++; render(); };
            foot.replaceChildren(el("span", "quiz-verdict " + (ok ? "ok" : "no"), (ok ? "✓ correct" : "✗ not quite") + " · " + (ms / 1000).toFixed(1) + "s"), next);
          };
          opts.append(b);
        });
        card.append(meta, el("div", "ml-front", q.q), opts, foot);
        host.replaceChildren(card);
        t0 = performance.now();
        timer = setInterval(() => { clock.textContent = "◷ " + ((performance.now() - t0) / 1000).toFixed(1) + "s"; }, 100);
      };
      render();
    }
    function studyOne(it) {
      ensureQuiz().then(() => {
        const qs = conceptQuestions(it.id);
        // reveal straight to the content — answer already open (concept) / full editor (kata), no extra click,
        // with a one-line retrieval score prepended.
        const reveal = (score) => {
          session = [it]; index = 0; renderRec(); renderRand();
          const host = container.querySelector(".deck-session");
          host.replaceChildren(it.type === "kata" ? kataCard(it) : conceptCard(it, !!score));  // answer pre-open only after a quiz
          if (score) host.firstChild.insertBefore(
            el("div", "ml-quiz-note", `◷ Retrieval — ${score.correct}/${score.total} correct · ${(score.ms / 1000).toFixed(1)}s`),
            host.firstChild.firstChild);
          host.scrollIntoView({ block: "center", behavior: "smooth" });
        };
        if (!qs.length || Date.now() - lastQuizAt(it.id) < QUIZ_COOLDOWN_MS) return reveal();  // no quiz, or already quizzed within the hour
        container.querySelector(".deck-session").scrollIntoView({ block: "center", behavior: "smooth" });
        runConceptQuiz(it, qs, reveal);
      });
    }
    function recRow(it, badge, sub, done) {
      const row = el("div", "ml-rec-row" + (done ? " done" : ""));
      const q = it.type === "kata" ? it.title : (it.front || "");           // full question, no truncation
      const top = el("div", "ml-rec-top");
      top.append(el("span", "ml-rec-i", badge), el("span", "ml-rec-q", q));
      row.append(top, el("span", "ml-rec-r", sub));                          // meta (reason / category) below
      row.onclick = () => studyOne(it);
      return row;
    }
    // One date-stamped, frozen set per key per day; pushed so it syncs across devices.
    const TOP_KEY = KEY + "::top", RAND_KEY = KEY + "::rand";
    function dayPicks(key, reroll, compute) {
      let s = null; try { s = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) {}
      const valid = s && s.date === isoDay() && Array.isArray(s.ids) && s.ids.every(id => ITEMS.some(i => i.id === id));  // [] is valid (caught up)
      if (reroll || !valid) { s = { date: isoDay(), ids: compute() }; localStorage.setItem(key, JSON.stringify(s)); if (window.__pushState) window.__pushState(); }
      return s.ids.map(id => ITEMS.find(i => i.id === id)).filter(Boolean);
    }
    function computeTop3() {                                                  // most-overdue/weakest first, then fresh
      const seen = ITEMS.filter(i => srs[i.id] && srs[i.id].last);
      const fresh = ITEMS.filter(i => !srs[i.id] || !srs[i.id].last);
      return [...R.recommend(seen, id => srs[id], isoDay()), ...fresh].slice(0, 3).map(i => i.id);
    }
    const top3Items = () => dayPicks(TOP_KEY, false, computeTop3);
    function renderRec() {
      const host = container.querySelector(".deck-rec"); if (!host) return;
      const today = isoDay(), picks = top3Items();
      host.replaceChildren();
      const head = el("div", "ml-rec-h"); head.append(el("span", null, "☀ Today's 3 — study these first"));
      const more = el("button", "ml-rand-reroll", "review more"); more.title = "pull a fresh set";
      more.onclick = e => { e.stopPropagation(); dayPicks(TOP_KEY, true, computeTop3); renderRec(); };  // recompute → done cards drop, next priorities fill
      head.append(more); host.append(head);
      if (!picks.length) { host.append(el("div", "ml-rec-empty", "✓ all caught up — nothing more due today")); return; }
      const list = el("div", "ml-rec-list");
      picks.forEach((it, k) => {
        const done = srs[it.id] && srs[it.id].last === today;
        list.append(recRow(it, done ? "✓" : String(k + 1), done ? "done today" : R.reason(srs[it.id], today), done));
      });
      host.append(list);
    }
    function pickRandom() {                                                   // uniformly random, excluding Today's 3
      const ex = new Set(top3Items().map(i => i.id));
      const pool = ITEMS.filter(i => !ex.has(i.id));
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      return pool.slice(0, 3).map(i => i.id);
    }
    function renderRand() {
      const host = container.querySelector(".deck-rand"); if (!host) return;
      host.replaceChildren();
      const items = dayPicks(RAND_KEY, false, pickRandom);
      if (!items.length) return;
      const head = el("div", "ml-rec-h"); head.append(el("span", null, "⚄ Random 3 — wildcard"));
      const reroll = el("button", "ml-rand-reroll", "↻"); reroll.title = "shuffle";
      reroll.onclick = e => { e.stopPropagation(); dayPicks(RAND_KEY, true, pickRandom); renderRand(); };
      head.append(reroll); host.append(head);
      const list = el("div", "ml-rec-list");
      items.forEach(it => list.append(recRow(it, "⚄", it.area, false)));
      host.append(list);
    }
    function renderSession() {
      renderRec();
      renderRand();
      const host = container.querySelector(".deck-session");
      if (index >= session.length) { host.replaceChildren(el("div", "ml-done", session.length ? `✓ Session done — ${session.length} reviewed. ${nextDueMsg()}` : `✓ All caught up for today. ${nextDueMsg()}`)); return; }
      const item = session[index];
      host.replaceChildren(item.type === "kata" ? kataCard(item) : conceptCard(item));
    }
    function renderBrowse() {
      const host = container.querySelector(".deck-browse"); host.replaceChildren();
      for (const area of AREAS) {
        const col = el("div", "ml-col");
        col.appendChild(el("div", "ml-col-head", area));
        for (const i of ITEMS.filter(x => x.area === area)) {
          const chip = el("div", "ml-chip");
          chip.style.setProperty("--bx", BOX_COLOR[srs[i.id] ? srs[i.id].box : 0]);
          if (isDue(i.id)) chip.classList.add("due");
          chip.appendChild(el("span", "ml-pip"));
          chip.appendChild(el("span", "ml-chip-l", (i.type === "kata" ? "🧪 " : "") + (i.front ? i.front.replace(/—.*/, "").slice(0, 42) : i.title)));
          const cs = srs[i.id]; if (cs && cs.reps) chip.appendChild(el("span", "ml-chip-n", "×" + cs.reps));
          chip.title = i.type === "kata" ? i.title : i.front;
          chip.onclick = () => studyOne(i);                              // quiz-first, then reveal the card
          col.appendChild(chip);
        }
        host.appendChild(col);
      }
    }
    function renderHead() {
      const due = ITEMS.filter(i => isDue(i.id)).length;
      const mastered = ITEMS.filter(i => srs[i.id] && srs[i.id].box >= 5).length;
      const s = container.querySelector(".deck-stat");
      if (s) s.innerHTML = `<b>${due}</b> due · <b>${mastered}</b>/${ITEMS.length} mastered`;
    }
    // ---- test mode: multiple-choice quiz from this deck's bank (content/<module>/<concept>/quiz.yaml) ----
    function setMode(m) {
      mode = m;
      container.querySelectorAll(".ml-mode").forEach(b => b.classList.toggle("active", b.dataset.mode === m));
      const test = m === "test";
      for (const sel of [".ml-layout", ".deck-rec", ".deck-rand", ".deck-early", ".deck-reset"]) {
        const n = container.querySelector(sel); if (n) n.style.display = test ? "none" : "";
      }
      container.querySelector(".deck-test").style.display = test ? "" : "none";
      if (test) { if (quiz === null) loadQuiz().then(renderTest); else renderTest(); }
    }
    async function loadQuiz() {
      try { const d = await (await fetch("/api/quiz")).json(); quiz = (d && d[KEY]) || []; }
      catch (_) { quiz = []; }
      return quiz;
    }
    function nextQuestion() {                                          // due/weakest first, then unseen (SRS order)
      if (!quiz || !quiz.length) { testCur = null; return; }
      const seen = quiz.filter(q => qsrs[q.id] && qsrs[q.id].last);
      const pool = [...R.recommend(seen, id => qsrs[id], R.isoDay()), ...quiz.filter(q => !qsrs[q.id] || !qsrs[q.id].last)];
      if (!pool.length) { testCur = null; return; }                    // all reviewed & not due → caught up
      testCur = (pool.length > 1 && testCur && pool[0].id === testCur.id) ? pool[1] : pool[0];
    }
    const qStat = () => quiz.length + " in bank · " + quiz.filter(q => R.isDue(qsrs[q.id], R.isoDay())).length + " due";
    function renderTest() {
      const host = container.querySelector(".deck-test"); host.replaceChildren();
      if (!quiz || !quiz.length) {
        host.append(el("div", "ml-done", `No quiz questions in this deck yet. Generate them offline: python3 quizgen.py ${KEY.split("-")[0]} — one quiz.yaml per concept, checked into git.`));
        return;
      }
      if (!testCur || !quiz.some(x => x.id === testCur.id)) nextQuestion();
      if (!testCur) {                                                  // caught up for today
        const done = el("div", "ml-done", "✓ Quiz reviews caught up for today — nothing due. ");
        const again = el("button", "quiz-next", "Practice anyway →");
        again.onclick = () => { testCur = quiz[Math.floor(Math.random() * quiz.length)]; renderTest(); };
        done.append(again); host.append(done); return;
      }
      const q = testCur, st = qsrs[q.id], card = el("div", "ml-card ml-quiz");
      const meta = el("div", "ml-meta");
      meta.append(el("span", "ml-area", q.term || "quiz"), el("span", "ml-prog", qStat() + " · " + (st && st.last ? "box " + st.box : "new")));
      const del = el("button", "quiz-del", "✕"); del.title = "remove this question";
      del.onclick = async () => {
        if (!confirm("Remove this question from the bank?")) return;
        try {
          const j = await (await fetch("/api/quiz/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deck: KEY, id: q.id }) })).json();
          if (!j.ok) throw new Error(j.error || "failed");
          quiz = quiz.filter(x => x.id !== q.id); delete qsrs[q.id]; persistQsrs(); nextQuestion(); renderTest();
        } catch (e) { alert("Delete failed: " + e.message); }
      };
      const qEl = el("div", "ml-front", q.q);
      const opts = el("div", "quiz-opts"), foot = el("div", "quiz-foot");
      q.choices.forEach((c, i) => {
        const b = el("button", "quiz-opt");
        b.append(el("span", "quiz-key", String.fromCharCode(65 + i)), el("span", "quiz-txt", c));
        b.onclick = () => {
          if (opts.dataset.done) return;
          opts.dataset.done = "1";
          [...opts.children].forEach((btn, j) => btn.classList.add(j === q.answer ? "correct" : (j === i ? "wrong" : "dim")));
          const ok = i === q.answer;
          gradeQuiz(q.id, ok);                                         // correct → advance box, wrong → back to 1
          const next = el("button", "quiz-next", "Next question →");
          next.onclick = () => { nextQuestion(); renderTest(); };
          foot.replaceChildren(el("span", "quiz-verdict " + (ok ? "ok" : "no"), (ok ? "✓ correct" : "✗ not quite") + " · box " + qsrs[q.id].box), next);
        };
        opts.append(b);
      });
      card.append(del, meta, qEl, opts, foot);
      host.append(card);
    }
    function init(host) {
      container = host;
      host.style.setProperty("--deck", ACCENT[0]); host.style.setProperty("--deck2", ACCENT[1]);
      host.innerHTML = `
        <div class="ml-top">
          <div class="ml-head-l">
            <div class="ml-eyebrow">${EYEBROW}</div>
            <h2 class="ml-title">${TITLE}<span class="ml-dot">.</span></h2>
            <div class="ml-stat deck-stat"></div>
            <div class="ml-rec deck-rec"></div>
            <div class="ml-rec deck-rand"></div>
          </div>
          <div class="ml-head-actions"><span class="ml-modes"><button class="ml-mode active" data-mode="study">Study</button><button class="ml-mode" data-mode="test">Test</button></span><button class="ml-mini deck-early">review early</button><button class="ml-mini deck-reset">reset ${TITLE}</button></div>
          <svg class="ml-trace" viewBox="0 0 260 60" preserveAspectRatio="none" aria-hidden="true"><path d="M2,50 C16,50 18,14 32,14 C46,14 44,44 60,44 C76,44 76,18 92,18 C108,18 108,40 124,40 C140,40 140,22 156,22 C172,22 172,35 188,35 C206,35 206,26 224,26 C242,26 244,30 258,30"/></svg>
        </div>
        <div class="ml-layout">
          <aside class="ml-side"><div class="ml-browse-head">All topics — tap any to study</div><div class="ml-browse deck-browse"></div></aside>
          <main class="ml-main deck-session"></main>
        </div>
        <section class="deck-test" style="display:none"></section>`;
      host.querySelector(".deck-early").onclick = () => { session = ITEMS.slice(); index = 0; renderSession(); };
      host.querySelector(".deck-reset").onclick = () => {
        if (!confirm(`Reset all ${TITLE} spaced-repetition progress?`)) return;
        for (const k in srs) delete srs[k]; for (const k in qsrs) delete qsrs[k];
        localStorage.removeItem(KEY); localStorage.removeItem(RAND_KEY); localStorage.removeItem(TOP_KEY); localStorage.removeItem(QSRS_KEY); if (window.__pushState) window.__pushState();
        buildSession(); renderSession(); renderBrowse(); renderHead();
      };
      host.querySelectorAll(".ml-mode").forEach(b => b.onclick = () => setMode(b.dataset.mode));
      buildSession(); renderSession(); renderBrowse(); renderHead();
      (window.__viewOpeners = window.__viewOpeners || {})[KEY] = (id) => {   // dashboard deep-link → open this card directly
        const it = ITEMS.find((i) => i.id === id); if (it) { setMode("study"); studyOne(it); }
      };
    }
    return { init };
  }
  window.StudyDeck = createDeck;

  // ---- styles (injected once; themed via the page's :root vars) ----
  const css = `
    .deck-view{--deck:#38bdf8;--deck2:#5eead4;background-image:radial-gradient(760px 440px at 16% -14%,color-mix(in srgb,var(--deck) 9%,transparent),transparent 60%)}

    /* ---------- header ---------- */
    .ml-top{position:relative;display:flex;align-items:flex-start;justify-content:space-between;gap:18px 24px;flex-wrap:wrap;margin-bottom:32px;overflow:hidden}
    .ml-head-l{position:relative;z-index:2;flex:1 1 440px;min-width:0}
    .ml-eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--muted);animation:ml-rise .5s both}
    .ml-title{font-family:var(--display);font-weight:800;font-size:40px;line-height:.92;letter-spacing:-.035em;margin:9px 0 0;color:var(--text);animation:ml-rise .5s .05s both}
    .ml-dot{color:var(--deck);text-shadow:0 0 22px color-mix(in srgb,var(--deck) 70%,transparent)}
    .ml-stat{font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:12px;animation:ml-rise .5s .1s both}
    .ml-stat b{color:var(--text)}
    .ml-trace{position:absolute;right:0;top:2px;width:min(48%,400px);height:74px;z-index:1;pointer-events:none;opacity:.6}
    .ml-trace path{fill:none;stroke:var(--deck);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 5px color-mix(in srgb,var(--deck) 65%,transparent));stroke-dasharray:760;stroke-dashoffset:760;animation:ml-draw 1.6s .25s cubic-bezier(.45,.05,.15,1) forwards}
    @keyframes ml-draw{to{stroke-dashoffset:0}}
    @keyframes ml-rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}

    /* ---------- daily picks ---------- */
    .ml-rec{margin-top:18px;max-width:900px;position:relative;z-index:2;animation:ml-rise .5s .14s both}
    .ml-rec-h{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--deck);margin-bottom:9px}
    .deck-rand .ml-rec-h{color:var(--deck2)}
    .ml-rec-h::before{content:"";width:15px;height:1.5px;border-radius:2px;background:currentColor;opacity:.7}
    .ml-rand-reroll{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:7px;padding:1px 9px;cursor:pointer;letter-spacing:0;transition:.16s}
    .ml-rand-reroll:hover{color:var(--text);border-color:color-mix(in srgb,var(--deck) 45%,var(--faint))}
    .ml-rec-list{display:flex;flex-direction:column;gap:7px}
    .ml-rec-row{display:flex;flex-direction:column;gap:5px;padding:11px 13px;border:1px solid var(--line);border-radius:11px;background:color-mix(in srgb,var(--surface) 82%,transparent);cursor:pointer;transition:.16s}
    .ml-rec-row:hover{border-color:color-mix(in srgb,var(--deck) 42%,var(--line));transform:translateY(-1px);box-shadow:0 12px 28px -22px var(--deck)}
    .ml-rec-row.done{opacity:.5}
    .ml-rec-top{display:flex;gap:9px;align-items:flex-start}
    .ml-rec-i{flex:none;width:19px;height:19px;border-radius:6px;background:var(--surface2);color:var(--muted);font-family:var(--mono);font-size:11px;display:flex;align-items:center;justify-content:center}
    .deck-rec .ml-rec-row:not(.done) .ml-rec-i{background:color-mix(in srgb,var(--deck) 18%,var(--surface));color:var(--deck)}
    .ml-rec-row.done .ml-rec-i{background:color-mix(in srgb,var(--ok) 20%,var(--surface));color:var(--ok)}
    .ml-rec-q{flex:1;min-width:0;font-size:13px;line-height:1.35;color:var(--text)}
    .ml-rec-r{font-family:var(--mono);font-size:10.5px;color:var(--faint);padding-left:28px}
    .ml-rec-empty{font-family:var(--mono);font-size:11.5px;color:var(--deck)}

    /* ---------- inline editor ---------- */
    .ml-edit-btn{font-family:var(--mono);font-size:11px;letter-spacing:.03em;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer;transition:.16s;margin-right:7px}
    .ml-edit-btn:hover{color:var(--text);border-color:var(--faint)}
    .ml-ed-field{margin-bottom:14px}
    .ml-ed-label{display:block;font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin-bottom:6px}
    .ml-ed-ta{display:block;width:100%;font-family:var(--mono);font-size:12.5px;line-height:1.55;color:var(--text);background:#0b0f17;border:1px solid var(--line);border-radius:9px;padding:10px 12px;resize:vertical;outline:none}
    .ml-ed-ta:focus{border-color:var(--deck)}
    .ml-ed-bar{display:flex;align-items:center;gap:10px;margin-top:4px}
    .ml-ed-save{font-family:var(--mono);font-size:12px;font-weight:600;color:#08110b;background:var(--ok);border:1px solid var(--ok);border-radius:9px;padding:9px 18px;cursor:pointer}
    .ml-ed-save:disabled{opacity:.6;cursor:default}
    .ml-ed-cancel{font-family:var(--mono);font-size:12px;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:9px 16px;cursor:pointer}
    .ml-ed-cancel:hover{color:var(--text);border-color:var(--faint)}
    .ml-ed-msg{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
    .ml-ed-msg.err{color:var(--bad)}

    /* ---------- mode toggle + header actions ---------- */
    .ml-head-actions{display:flex;gap:8px;position:relative;z-index:2;flex-wrap:wrap;animation:ml-rise .5s .1s both}
    .ml-modes{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;margin-right:4px;background:var(--surface)}
    .ml-mode{font-family:var(--mono);font-size:11px;color:var(--muted);background:transparent;border:0;padding:8px 15px;cursor:pointer;transition:.16s}
    .ml-mode:hover{color:var(--text)}
    .ml-mode.active{background:color-mix(in srgb,var(--deck) 15%,var(--surface2));color:var(--text);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--deck) 42%,transparent)}
    .ml-mini{font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:8px 12px;cursor:pointer;transition:.16s}
    .ml-mini:hover{color:var(--text);border-color:var(--faint)}

    /* ---------- quiz / test ---------- */
    .ml-quiz{position:relative}
    .ml-quiz-note{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--deck);margin-bottom:14px}
    .ml-quiz-clock{font-family:var(--mono);font-size:11px;color:var(--warn);white-space:nowrap;font-variant-numeric:tabular-nums}
    .quiz-opts{display:flex;flex-direction:column;gap:9px;margin-top:20px;max-width:720px}
    .quiz-opt{display:flex;align-items:center;gap:12px;text-align:left;font-size:14px;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:13px 15px;cursor:pointer;transition:.14s}
    .quiz-opt:hover{border-color:color-mix(in srgb,var(--deck) 42%,var(--line));background:color-mix(in srgb,var(--deck) 6%,var(--surface))}
    .quiz-txt{flex:1}
    .quiz-key{flex:none;width:23px;height:23px;border-radius:7px;background:var(--surface2);color:var(--muted);font-family:var(--mono);font-size:12px;display:flex;align-items:center;justify-content:center;transition:.14s}
    .quiz-opt:hover .quiz-key{color:var(--deck)}
    .quiz-opt.correct{border-color:color-mix(in srgb,var(--ok) 55%,var(--line));background:color-mix(in srgb,var(--ok) 12%,var(--surface))}
    .quiz-opt.correct .quiz-key{background:var(--ok);color:#08110b}
    .quiz-opt.wrong{border-color:color-mix(in srgb,var(--bad) 55%,var(--line));background:color-mix(in srgb,var(--bad) 12%,var(--surface))}
    .quiz-opt.wrong .quiz-key{background:var(--bad);color:#1a0b0b}
    .quiz-opt.dim{opacity:.4}
    .quiz-foot{display:flex;align-items:center;gap:14px;margin-top:20px;min-height:20px}
    .quiz-verdict{font-family:var(--mono);font-size:13px}
    .quiz-verdict.ok{color:var(--ok)}.quiz-verdict.no{color:var(--bad)}
    .quiz-next{font-family:var(--mono);font-size:12px;color:var(--text);background:color-mix(in srgb,var(--deck) 14%,var(--surface2));border:1px solid color-mix(in srgb,var(--deck) 40%,var(--line));border-radius:9px;padding:9px 16px;cursor:pointer;transition:.16s}
    .quiz-next:hover{box-shadow:0 0 0 1px color-mix(in srgb,var(--deck) 45%,transparent)}
    .quiz-del{position:absolute;top:12px;right:12px;font-family:var(--mono);font-size:12px;color:var(--faint);background:transparent;border:1px solid var(--line);border-radius:7px;padding:2px 9px;cursor:pointer;z-index:1}
    .quiz-del:hover{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,var(--line))}
    @media (min-width:861px){.ml-rec-list{flex-direction:row;align-items:stretch;gap:8px}.ml-rec-row{flex:1;min-width:0}}

    /* ---------- layout ---------- */
    .ml-layout{display:flex;gap:34px;align-items:flex-start}
    .ml-side{width:290px;flex:none;animation:ml-rise .55s .18s both}
    .ml-main{flex:1;min-width:0;max-width:1060px;animation:ml-rise .55s .22s both}

    /* ---------- flash card (hero) ---------- */
    .ml-card{position:relative;z-index:0;background:linear-gradient(180deg,var(--surface2),var(--surface));border:1px solid var(--line);border-radius:18px;padding:26px 28px;box-shadow:0 26px 60px -34px #000;overflow:hidden;animation:ml-card-in .32s ease both}
    @keyframes ml-card-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    .ml-card::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;z-index:-1;background:linear-gradient(90deg,var(--deck),color-mix(in srgb,var(--deck2) 85%,transparent) 42%,transparent)}
    .ml-card::after{content:"";position:absolute;top:-38%;right:-8%;width:340px;height:340px;z-index:-1;pointer-events:none;background:radial-gradient(circle,color-mix(in srgb,var(--deck) 13%,transparent),transparent 66%)}
    .ml-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--faint);margin-bottom:16px}
    .ml-area{color:var(--muted)}
    .ml-prog{white-space:nowrap}
    .ml-ret{display:inline-flex;gap:3px;align-items:center}
    .ml-seg{width:15px;height:5px;border-radius:2px;background:color-mix(in srgb,#fff 8%,transparent);transition:.2s}
    .ml-seg.on{background:var(--sc);box-shadow:0 0 7px -1px var(--sc)}
    .ml-front{font-family:var(--display);font-weight:700;font-size:25px;line-height:1.2;letter-spacing:-.018em;color:var(--text)}
    .ml-back{font-size:14px;line-height:1.65;color:#cdd6e2;margin-top:18px;padding-top:18px;border-top:1px solid var(--line);max-width:720px}
    .ml-more{font-size:13px;line-height:1.6;color:var(--muted);margin-top:16px;padding-top:14px;border-top:1px dashed var(--line);max-width:720px}
    .ml-more::before{content:"DEEP DIVE";display:block;font-family:var(--mono);font-size:9.5px;letter-spacing:.18em;color:var(--deck2);margin-bottom:8px}
    /* rendered markdown inside card body fields */
    .ml-back>:first-child,.ml-more>:first-child{margin-top:0}
    .ml-back>:last-child,.ml-more>:last-child{margin-bottom:0}
    .ml-back p,.ml-more p{margin:9px 0}
    .ml-back ul,.ml-back ol,.ml-more ul,.ml-more ol{margin:8px 0;padding-left:20px}
    .ml-back li,.ml-more li{margin:3px 0}
    .ml-back h1,.ml-more h1,.ml-back h2,.ml-more h2,.ml-back h3,.ml-more h3,.ml-back h4,.ml-more h4{font-family:var(--display);font-weight:700;line-height:1.25;color:var(--text);margin:15px 0 7px}
    .ml-back h2,.ml-more h2{font-size:15px}.ml-back h3,.ml-more h3{font-size:13.5px}.ml-back h4,.ml-more h4{font-size:12.5px}
    .ml-back code,.ml-more code{font-family:var(--mono);font-size:12px;background:color-mix(in srgb,#fff 8%,transparent);padding:1px 5px;border-radius:5px}
    .ml-back pre,.ml-more pre{font-family:var(--mono);font-size:12px;line-height:1.5;background:#0b0f17;border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:9px 0;overflow:auto;white-space:pre}
    .ml-back pre code,.ml-more pre code{background:none;padding:0}
    .ml-back hr,.ml-more hr{border:0;border-top:1px solid var(--line);margin:13px 0}
    .ml-back strong,.ml-more strong,.ml-back b,.ml-more b{color:#eaf2ff;font-weight:700}
    .ml-back table,.ml-more table{border-collapse:collapse;margin:10px 0;font-size:12.5px;display:block;max-width:100%;overflow:auto}
    .ml-back th,.ml-more th,.ml-back td,.ml-more td{border:1px solid var(--line);padding:5px 9px;text-align:left;white-space:nowrap}
    .ml-back th,.ml-more th{background:var(--surface2);color:var(--text)}
    .ml-actions{margin-top:22px}
    .ml-show{font-family:var(--mono);font-size:12px;letter-spacing:.02em;color:var(--text);background:color-mix(in srgb,var(--deck) 14%,var(--surface2));border:1px solid color-mix(in srgb,var(--deck) 42%,var(--line));border-radius:10px;padding:11px 20px;cursor:pointer;transition:.16s}
    .ml-show:hover{background:color-mix(in srgb,var(--deck) 22%,var(--surface2));box-shadow:0 0 0 1px color-mix(in srgb,var(--deck) 45%,transparent)}
    .ml-grade{display:flex;gap:9px;max-width:540px}
    .ml-grade button{flex:1;font-family:var(--mono);font-size:12.5px;color:var(--gc);background:color-mix(in srgb,var(--gc) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--gc) 40%,var(--line));border-radius:10px;padding:12px 0;cursor:pointer;transition:.16s}
    .ml-grade button:hover{background:color-mix(in srgb,var(--gc) 22%,var(--surface));transform:translateY(-1px)}
    .kata-prompt{font-size:14px;line-height:1.55;color:#cdd6e2;margin:8px 0 16px;max-width:720px}
    /* signature + editor read as one integrated code panel (sig is the panel's header bar) */
    .kata-sig{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--deck2);background:var(--surface2);border:1px solid var(--line);border-bottom:0;border-radius:11px 11px 0 0;padding:9px 14px;margin:0;max-width:760px;overflow:auto;white-space:nowrap}
    .kata-sig::after{content:"python";margin-left:auto;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint)}
    .kata-code{display:block;width:100%;min-height:220px;max-width:760px;font-family:var(--mono);font-size:13px;line-height:1.5;color:var(--text);background:#0b0f17;border:1px solid var(--line);border-top:0;border-radius:0 0 11px 11px;padding:14px;resize:vertical;outline:none;tab-size:4}
    .kata-code:focus{border-color:var(--deck)}
    .ml-card .CodeMirror{height:auto;min-height:220px;max-width:760px;border:1px solid var(--line);border-top:0;border-radius:0 0 11px 11px;font-family:var(--mono);font-size:13px;line-height:1.55;background:#0b0f17!important;color:#cdd6e2}
    .ml-card .CodeMirror-focused{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--deck) 45%,transparent)}
    /* retint the dracula base into the deck's cool palette (dracula sets its chrome !important, so match it;
       the scrollbar/gutter fillers + hidden input textarea default to white and must be knocked out) */
    .ml-card .CodeMirror-scroll{background:#0b0f17}
    .ml-card .CodeMirror-scrollbar-filler,.ml-card .CodeMirror-gutter-filler{background:#0b0f17!important}
    .ml-card .CodeMirror textarea{background:transparent!important}
    /* .CodeMirror-scroll has overflow:scroll; the OS draws a WHITE native track even with no overflow
       (invisible to JS, but it shows as a band) — dark-style the webkit scrollbars so it blends in */
    .ml-card .CodeMirror-scroll::-webkit-scrollbar,.ml-card .kata-code::-webkit-scrollbar{width:10px;height:10px}
    .ml-card .CodeMirror-scroll::-webkit-scrollbar-track,.ml-card .kata-code::-webkit-scrollbar-track{background:#0b0f17}
    .ml-card .CodeMirror-scroll::-webkit-scrollbar-thumb,.ml-card .kata-code::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--line) 85%,var(--faint));border-radius:6px;border:2px solid #0b0f17}
    .ml-card .CodeMirror-scroll::-webkit-scrollbar-corner,.ml-card .kata-code::-webkit-scrollbar-corner{background:#0b0f17}
    .ml-card .cm-s-dracula .CodeMirror-gutters{background:#0b0f17!important;border-right:1px solid var(--line)}
    .ml-card .cm-s-dracula .CodeMirror-linenumber{color:var(--faint)}
    .ml-card .cm-s-dracula .CodeMirror-cursor{border-left:1.6px solid var(--deck)!important}
    .ml-card .cm-s-dracula .CodeMirror-selected{background:color-mix(in srgb,var(--deck) 22%,transparent)!important}
    .ml-card .cm-s-dracula .CodeMirror-activeline-background{background:color-mix(in srgb,#fff 3%,transparent)}
    .ml-card .cm-s-dracula .cm-keyword{color:var(--deck)}
    .ml-card .cm-s-dracula .cm-def{color:var(--deck2)}
    .ml-card .cm-s-dracula .cm-builtin,.ml-card .cm-s-dracula .cm-property{color:#7dd3fc}
    .ml-card .cm-s-dracula .cm-variable{color:#e7edf5}
    .ml-card .cm-s-dracula .cm-variable-2{color:#cbd5e1}
    .ml-card .cm-s-dracula .cm-operator{color:#8b97a8}
    .ml-card .cm-s-dracula .cm-string,.ml-card .cm-s-dracula .cm-string-2{color:#5eead4}
    .ml-card .cm-s-dracula .cm-number{color:var(--warn)}
    .ml-card .cm-s-dracula .cm-comment{color:var(--faint);font-style:italic}
    .ml-card .cm-s-dracula .cm-matchingbracket{color:var(--deck)!important;text-decoration:none;background:color-mix(in srgb,var(--deck) 18%,transparent)}
    .kata-bar{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
    .kata-run{font-family:var(--mono);font-size:12px;font-weight:600;color:#04121e;background:var(--deck);border:1px solid var(--deck);border-radius:9px;padding:10px 18px;cursor:pointer;transition:.16s}
    .kata-run:hover{filter:brightness(1.08)}
    .kata-ref{font-family:var(--mono);font-size:12px;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:10px 16px;cursor:pointer;transition:.16s}
    .kata-ref:hover{color:var(--text);border-color:var(--faint)}
    .kata-out,.kata-refbox{white-space:pre-wrap;font-family:var(--mono);font-size:12px;line-height:1.5;margin-top:10px;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:#0b0f17;overflow:auto;max-width:760px}
    .kata-out.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,var(--line))}
    .kata-out.err{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,var(--line))}
    .kata-refbox{color:#cdd6e2}
    .ml-done{font-family:var(--mono);font-size:14px;color:var(--ok);background:linear-gradient(135deg,color-mix(in srgb,var(--ok) 12%,var(--surface2)),var(--surface));border:1px solid color-mix(in srgb,var(--ok) 28%,var(--line));border-radius:16px;padding:30px 24px;text-align:center}
    .ml-browse-head{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);margin:0 0 14px}
    .ml-browse{display:block}
    .ml-col{margin-bottom:20px}
    .ml-col-head{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
    .ml-col-head::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
    .ml-chip{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);margin-bottom:7px;cursor:pointer;font-size:12.5px;color:var(--text);transition:.14s}
    .ml-chip:hover{border-color:color-mix(in srgb,var(--deck) 40%,var(--line));transform:translateX(3px);background:color-mix(in srgb,var(--deck) 6%,var(--surface))}
    .ml-chip.due{box-shadow:inset 2px 0 0 var(--warn)}
    .ml-pip{width:8px;height:8px;border-radius:2px;background:var(--bx);flex:none;box-shadow:0 0 6px -1px var(--bx)}
    .ml-chip-l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ml-chip-n{flex:none;font-family:var(--mono);font-size:10.5px;color:var(--faint)}
    @media (max-width:860px){
      .ml-layout{flex-direction:column;gap:22px}
      .ml-side{width:100%;position:static;max-height:none;order:2}
      .ml-main{order:1;width:100%;max-width:none}
      .ml-browse{display:grid;grid-template-columns:1fr 1fr;gap:0 20px}
      .ml-trace{display:none}
      .ml-title{font-size:32px}
    }
    @media (max-width:560px){
      .ml-browse{grid-template-columns:1fr}
      .ml-front{font-size:19px}
      .ml-card{padding:18px}
      .ml-grade{max-width:none}
      .ml-title{font-size:27px}
    }`;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));

  // ---- loader: fetch every deck from the server and register a tab + view ----
  function initDecks() {
    if (typeof window.registerDeckView !== "function") return;   // algorithms-only page / older host
    fetch("/api/decks").then(r => r.json()).then(decks => {
      if (!Array.isArray(decks)) return;
      for (const cfg of decks) {
        if (!cfg || !cfg.key || !Array.isArray(cfg.concepts)) continue;
        const app = createDeck(cfg);
        window.registerDeckView(cfg.key, cfg.tab || cfg.title || cfg.key, host => app.init(host));
      }
    }).catch(() => { /* server not running / file:// — algorithms tab still works */ });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initDecks);
  else initDecks();
})();
