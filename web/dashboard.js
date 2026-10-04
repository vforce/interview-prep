/* dashboard.js — the "Home" tab: one place that tracks progress across Algorithms, the ML/LLM
   decks, and the lesson topics, and recommends what to do next. It is pure AGGREGATION over data
   and recommendation logic that already exists — review.js (recommend/isDue/reason), the algorithms
   pickers (window.__algoNext), the per-deck ::quiz-srs wrong-answer stores, and topic mastery/gating.
   No new scheduling logic, no server changes. Registered as a client-side deck-view exactly like the
   old Solved tab. computeDashboard() is a pure, node-requirable function so the aggregation is tested. */
(function (root) {
  "use strict";
  const R = (typeof module !== "undefined" && module.exports) ? require("./review.js") : (root && root.Review);

  // ---------------- pure core: normalized data → view model ----------------

  const stripQ = qid => String(qid).replace(/-q\d+$/, "");        // deck qid "m-roc-pr-q1" → concept "m-roc-pr"

  // Concepts with a still-open gap (their most recent quiz grade was "bad"), most-overdue first.
  function wrongConcepts(deck, today) {
    const bad = Object.keys(deck.qsrs || {}).filter(qid => (deck.qsrs[qid] || {}).grade === "bad");
    const byCid = {};
    for (const qid of bad) (byCid[stripQ(qid)] = byCid[stripQ(qid)] || []).push(qid);
    return Object.keys(byCid)
      .map(cid => ({ cid, qids: byCid[cid], over: Math.max(...byCid[cid].map(q => R.overdueDays(deck.qsrs[q], today))) }))
      .sort((a, b) => b.over - a.over);
  }

  function deckModel(deck, today, quizText) {
    const seen = deck.items.filter(i => deck.srs[i.id] && deck.srs[i.id].last);
    const due = R.recommend(seen, id => deck.srs[id], today);                     // reviewed & due, worst first
    const mastered = deck.items.filter(i => (deck.srs[i.id] || {}).box >= 5).length;
    const attempted = deck.items.filter(i => { const s = deck.srs[i.id]; return s && s.last && (s.box || 0) < 5; }).length;   // studied, not yet mastered
    const label = cid => { const it = deck.items.find(i => i.id === cid); return it ? it.label : cid; };
    const wrong = wrongConcepts(deck, today).filter(w => deck.items.some(i => i.id === w.cid));
    let next = null;                                                              // gap → overdue review → a new card
    if (wrong.length) next = { navKey: deck.key, id: wrong[0].cid, title: label(wrong[0].cid), sub: "revisit — you missed a question" };
    else if (due.length) next = { navKey: deck.key, id: due[0].id, title: label(due[0].id), sub: R.reason(deck.srs[due[0].id], today), over: R.overdueDays(deck.srs[due[0].id], today) };
    else { const fresh = deck.items.find(i => !deck.srs[i.id] || !deck.srs[i.id].last); if (fresh) next = { navKey: deck.key, id: fresh.id, title: fresh.label, sub: "new — never studied" }; }
    return {
      kind: "deck", key: deck.key, navKey: deck.key, title: deck.title,
      module: deck.module, moduleLabel: deck.moduleLabel,
      done: mastered, attempted, total: deck.items.length, due: due.length,
      missed: wrong.reduce((a, w) => a + w.qids.length, 0), next,      // total missed questions (not concepts)
      pool: deck.items.map(i => ({ navKey: deck.key, id: i.id, title: i.label })),
      wrong: wrong.map(w => ({ cid: w.cid, concept: label(w.cid), navKey: deck.key, count: w.qids.length,
        questions: w.qids.map(q => quizText && quizText[q]).filter(Boolean) })),
    };
  }

  function topicModel(topic, today) {
    const prog = topic.progress || {}, graph = topic.graph || {}, qs = topic.quizSrs || {};
    const isMastered = id => (prog[id] || {}).mastery === "Mastered";
    const unlocked = id => ((graph[id] && graph[id].requires) || []).every(isMastered);
    const concepts = [...(topic.concepts || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    const titleOf = cid => { const c = concepts.find(x => x.id === cid); return c ? c.title : cid; };
    const mastered = concepts.filter(c => isMastered(c.id)).length;
    const attempted = concepts.filter(c => (prog[c.id] || {}).mastery === "Learning").length;   // started, not yet mastered
    const dueQ = Object.keys(qs).filter(k => R.isDue(qs[k], today)).sort((a, b) => R.overdueDays(qs[b], today) - R.overdueDays(qs[a], today));
    // Next unlocked & unmastered LESSON → else the most-overdue review. Reviews must NOT come first: a topic's
    // quiz bank only grows, so `dueQ` is basically never empty and "Next up" would pin itself to an already-
    // mastered concept forever — finishing a lesson would never advance it. The `N due` chip carries the backlog.
    let next = null;
    const nc = concepts.find(c => unlocked(c.id) && !isMastered(c.id));
    if (nc) next = { navKey: topic.id, id: nc.id, title: nc.title, sub: "next unlocked" };
    else if (dueQ.length) { const cid = dueQ[0].split("#")[0]; next = { navKey: topic.id, id: cid, title: titleOf(cid), sub: "review due", over: R.overdueDays(qs[dueQ[0]], today) }; }
    const openPool = concepts.filter(c => unlocked(c.id) && !isMastered(c.id)).map(c => ({ navKey: topic.id, id: c.id, title: c.title }));
    return {
      kind: "topic", key: topic.id, navKey: topic.id, title: topic.title,
      done: mastered, attempted, total: topic.total || concepts.length, due: dueQ.length, missed: 0, next,
      pool: openPool.length ? openPool : concepts.map(c => ({ navKey: topic.id, id: c.id, title: c.title })),
    };
  }

  function algoModel(algo) {
    if (!algo) return null;
    return { kind: "algo", key: "algorithms", navKey: "algorithms", title: "Algorithms",
      done: algo.done, attempted: algo.attempted || 0, total: algo.total, due: 0, missed: 0, next: algo.next, pool: algo.pool || [], warmupDone: algo.warmupDone };
  }

  // The single "do this next": most-overdue review → an open gap → today's warm-up → new material.
  function pickHero(modules) {
    const reviews = modules.filter(m => m.next && m.next.over > 0).sort((a, b) => b.next.over - a.next.over);
    if (reviews.length) return heroOf(reviews[0], "Review");
    const gap = modules.find(m => m.missed > 0);                                  // deckModel already set next = the gap
    if (gap) return heroOf(gap, "Revisit");
    const warm = modules.find(m => m.kind === "algo" && m.next && !m.warmupDone);
    if (warm) return heroOf(warm, "Solve");
    const any = modules.find(m => m.next);
    if (any) return heroOf(any, any.kind === "topic" ? "Learn" : any.kind === "algo" ? "Solve" : "Study");
    return null;
  }
  function heroOf(m, verb) {
    return { verb, title: m.next ? m.next.title : m.title, module: m.title,
      sub: (m.next && m.next.sub) || "", navKey: m.next ? m.next.navKey : m.navKey, href: m.next && m.next.href, id: m.next && m.next.id };
  }

  function computeDashboard(data) {
    const today = data.today || R.isoDay();
    const deckMs = (data.decks || []).map(d => deckModel(d, today, data.quizText));
    const modules = [algoModel(data.algo), ...deckMs, ...(data.topics || []).map(t => topicModel(t, today))].filter(Boolean);
    const wrong = deckMs.filter(m => m.wrong.length).map(m => ({ module: m.module, moduleLabel: m.moduleLabel, concepts: m.wrong }));
    return { modules, wrong, hero: pickHero(modules) };
  }

  // Views register their opener into `window.__viewOpeners` asynchronously on first activation, so after a
  // switchTab() we poll briefly for it, then call it with the item id (the dashboard's cross-view deep-link).
  // The injectable opts (getOpener/schedule/now/budget) exist only to keep this poll loop node-testable.
  function openWhenReady(nav, id, opts) {
    opts = opts || {};
    const getOpener = opts.getOpener || (k => ((root && root.__viewOpeners) || {})[k]);
    const schedule = opts.schedule || (fn => setTimeout(fn, 100));
    const clock = opts.now || (() => Date.now());
    const budget = opts.budget == null ? 5000 : opts.budget;
    const t0 = clock();
    (function tryOpen() {
      const fn = getOpener(nav);
      if (fn) { try { fn(id); } catch (_) {} return; }
      if (clock() - t0 < budget) schedule(tryOpen);
    })();
  }

  const api = { computeDashboard, openWhenReady };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root) return;                                                              // node (tests) — no DOM below
  root.Dashboard = api;

  // ---------------- browser: data gathering, render, registration ----------------

  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const lcUrl = s => "https://leetcode.com/problems/" + s + "/";
  const readLS = k => { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch (_) { return {}; } };
  const go = (nav, href, id) => {
    if (href) return window.open(href, "_blank", "noopener");   // external (algorithms → LeetCode)
    if (window.switchTab) window.switchTab(nav);
    if (id) openWhenReady(nav, id);                             // switch to the tab, then open the specific card/concept
  };

  // Algorithms summary + next/surprise, reusing the roadmap's own pickers (window.__algoNext).
  function buildAlgo(today) {
    if (!window.ROADMAP || !window.__algoNext) return null;
    const prog = readLS("recovery-progress-v2");
    const slugs = new Set();
    (window.ROADMAP.topics || []).forEach(p => (p.probs || []).forEach(q => slugs.add(q.slug)));
    let solved = 0, attempted = 0; slugs.forEach(s => { const st = (prog[s] || {}).s; if (st === "green") solved++; else if (st) attempted++; });   // green = solved; yellow/red = in progress
    let picks = null; try { picks = window.__algoNext(false); } catch (_) {}
    const pick = picks && picks.daily && (picks.daily.easy || picks.daily.med);
    const next = pick ? { navKey: "algorithms", title: pick.name, href: lcUrl(pick.slug),
      sub: (pick.node || "") + (pick.why ? " · " + pick.why : (prog[pick.slug] ? " · stale" : " · not done yet")) } : null;
    const pool = ((picks && picks.random && picks.random.picks) || []).map(p => ({ navKey: "algorithms", title: p.name, href: lcUrl(p.slug) }));
    return { done: solved, attempted, total: slugs.size, next, pool, warmupDone: pick ? ((prog[pick.slug] || {}).t === today) : true };
  }

  async function init(host) {
    host.replaceChildren(el("div", "dash-load", "building your dashboard…"));
    const today = R.isoDay();
    try {
      const [decksRaw, quizRaw, topicsRaw] = await Promise.all([
        fetch("/api/decks").then(r => r.json()).catch(() => []),
        fetch("/api/quiz").then(r => r.json()).catch(() => ({})),
        fetch("/api/topics").then(r => r.json()).catch(() => []),
      ]);
      const decks = (Array.isArray(decksRaw) ? decksRaw : []).filter(c => c && c.key && Array.isArray(c.concepts)).map(cfg => ({
        key: cfg.key, module: cfg.key.split("-")[0], moduleLabel: (cfg.tab || cfg.key.split("-")[0]).toUpperCase(),
        title: cfg.title || cfg.tab || cfg.key,
        items: [...cfg.concepts.map(c => ({ id: c.id, label: c.front || c.id, type: "concept" })),
                ...((cfg.katas || []).map(k => ({ id: k.id, label: k.title || k.id, type: "kata" })))],
        srs: readLS(cfg.key), qsrs: readLS(cfg.key + "::quiz-srs"),
      }));
      const quizText = {};
      for (const k in quizRaw) for (const q of quizRaw[k] || []) quizText[q.id] = q.q;
      const topics = await Promise.all((Array.isArray(topicsRaw) ? topicsRaw : []).map(async m => {
        const [prog, cur, graph] = await Promise.all([
          fetch("/api/topic/" + m.id + "/progress?user=me").then(r => r.json()).catch(() => ({})),
          fetch("content/" + m.id + "/curriculum.json").then(r => r.ok ? r.json() : { concepts: [] }).catch(() => ({ concepts: [] })),
          fetch("content/" + m.id + "/graph.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
        ]);
        const quizSrs = prog.__quizSrs || {}; const progress = Object.assign({}, prog); delete progress.__quizSrs;
        return { id: m.id, title: m.title || m.id, total: m.conceptCount || (cur.concepts || []).length, concepts: cur.concepts || [], graph, progress, quizSrs };
      }));
      render(host, api.computeDashboard({ today, algo: buildAlgo(today), decks, topics, quizText }));
    } catch (e) {
      host.replaceChildren(el("div", "dash-load", "⚠ " + (e.message || "failed to build the dashboard")));
    }
  }

  const dateStr = () => { try { return new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }); } catch (_) { return ""; } };
  const ACCENTS = ["#2dd4bf", "#38bdf8", "#a78bfa", "#f5b13d", "#fb7185", "#a3e635", "#f0883e"];
  const accentOf = key => ACCENTS[[...String(key)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % ACCENTS.length];
  const KIND = { algo: "Algorithms", deck: "Deck", topic: "Lesson" };
  const scrollToGaps = () => { const w = document.getElementById("dash-wrong"); if (w) w.scrollIntoView({ behavior: "smooth", block: "start" }); };

  function legendRow(value, label, tone) {   // one line of the 3-state progress legend (mastered / in progress / to start)
    const r = el("div", "dash-lg dash-lg-" + tone);
    r.append(el("span", "dash-dot"), el("b", null, String(value)), el("span", null, label)); return r;
  }
  const chip = (text, cls) => el("span", "dash-chip dash-chip-" + cls, text);
  function moduleCard(m) {
    const total = m.total || 0, attempted = m.attempted || 0;
    const pct = total ? Math.round(100 * m.done / total) : 0;                 // mastered %
    const apct = total ? Math.round(100 * attempted / total) : 0;             // in-progress %
    const toStart = Math.max(0, total - m.done - attempted);
    const c = el("article", "dash-panel"); c.style.setProperty("--accent", accentOf(m.key)); c.dataset.kind = m.kind;

    const head = el("div", "dash-phead"); head.tabIndex = 0; head.setAttribute("role", "link"); head.title = "Open " + m.title;
    head.append(el("span", "dash-tag", KIND[m.kind] || "Module"), el("h3", "dash-pname", m.title));
    const openTab = () => go(m.navKey);   // the title opens the module's own tab (Algorithms → the map; decks/topics → their landing)
    head.onclick = openTab;
    head.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTab(); } };
    c.append(head);

    const body = el("div", "dash-pbody");
    const ring = el("div", "dash-ring");                                      // two-segment: mastered (accent) → in progress (faded accent) → to start (grey)
    ring.style.setProperty("--p", pct); ring.style.setProperty("--q", Math.min(100, pct + apct));
    const num = el("div", "dash-ring-num"); num.append(document.createTextNode(String(pct)), el("em", null, "%")); ring.append(num);
    const legend = el("div", "dash-legend");
    legend.append(legendRow(m.done, "mastered", "done"), legendRow(attempted, "in progress", "wip"), legendRow(toStart, "to start", "todo"));
    body.append(ring, legend); c.append(body);
    if (m.due || m.missed) {                                                  // review flags, below the progress legend
      const flags = el("div", "dash-flags");
      if (m.due) flags.append(chip(m.due + " due", "due"));
      if (m.missed) { const ch = chip(m.missed + " missed", "missed"); ch.classList.add("clickable"); ch.onclick = scrollToGaps; ch.title = "see the questions"; flags.append(ch); }
      c.append(flags);
    }

    if (m.next) {
      const ns = el("button", "dash-ns"), nb = el("div", "dash-ns-body");
      nb.append(el("span", "dash-ns-k", "Next up"), el("div", "dash-ns-t", m.next.title), el("div", "dash-ns-s", m.next.sub || ""));
      ns.append(nb, el("span", "dash-ns-arr", "→"));
      ns.onclick = () => go(m.next.navKey, m.next.href, m.next.id); c.append(ns);
    } else c.append(el("div", "dash-ns dash-ns-done", "✓ all caught up"));

    if (m.pool && m.pool.length) {
      const d = el("button", "dash-dice", "⚄"); d.title = "surprise me";
      d.onclick = () => { const p = m.pool[Math.floor(Math.random() * m.pool.length)]; go(p.navKey, p.href, p.id); };
      c.append(d);
    }
    return c;
  }
  function wrongSection(wrong) {
    const sec = el("section", "dash-gaps"); sec.id = "dash-wrong";
    const total = wrong.reduce((a, g) => a + g.concepts.reduce((b, cc) => b + (cc.count || cc.questions.length || 1), 0), 0);
    const head = el("div", "dash-gaps-head");
    head.append(el("span", "dash-kicker bad", "⚑ Review gaps"), el("span", "dash-gaps-sub", total + " question" + (total === 1 ? "" : "s") + " you missed — one tap to revisit"));
    sec.append(head);
    const grid = el("div", "dash-gaps-grid");
    for (const g of wrong) {
      const col = el("div", "dash-gaps-col");
      const n = g.concepts.reduce((a, cc) => a + (cc.count || cc.questions.length || 1), 0);
      col.append(el("div", "dash-gaps-mod", g.moduleLabel + " · " + n + " missed"));
      for (const cc of g.concepts) {
        const item = el("button", "dash-gap"), b = el("div", "dash-gap-body");
        b.append(el("div", "dash-gap-c", cc.concept));
        for (const q of (cc.questions || [])) b.append(el("div", "dash-gap-q", q));
        item.append(el("span", "dash-gap-ico", "↻"), b);
        item.onclick = () => go(cc.navKey, undefined, cc.cid); col.append(item);
      }
      grid.append(col);
    }
    sec.append(grid); return sec;
  }
  function surprise(model) {
    const pools = model.modules.filter(m => m.pool && m.pool.length);
    if (!pools.length) return;
    const m = pools[Math.floor(Math.random() * pools.length)], p = m.pool[Math.floor(Math.random() * m.pool.length)];
    go(p.navKey, p.href, p.id);
  }
  function shuffleBtn(model) {
    const b = el("button", "dash-shuffle"); b.append(el("span", "dash-die", "⚄"), document.createTextNode(" Surprise me"));
    b.onclick = () => surprise(model); return b;
  }
  function render(host, model) {
    host.replaceChildren();
    const wrap = el("div", "dash"); let i = 0;
    const rise = node => { node.style.setProperty("--i", i++); return node; };

    const hero = rise(el("div", "dash-hero"));   // not <header> — the app has a global header{} that would hijack layout
    const meta = el("div", "dash-hero-meta");
    meta.append(el("span", "dash-kicker", "▶ Do this next"), el("span", "dash-date", dateStr()));
    hero.append(meta);
    if (model.hero) {
      const h1 = el("h1", "dash-headline");
      h1.append(el("span", "dash-verb", model.hero.verb + " "), el("span", "dash-obj", model.hero.title));
      hero.append(h1, el("p", "dash-lede", model.hero.module + (model.hero.sub ? "  —  " + model.hero.sub : "")));
      const cta = el("div", "dash-cta");
      const start = el("button", "dash-start"); start.append(document.createTextNode("Start "), el("span", "dash-start-arr", "→"));
      start.onclick = () => go(model.hero.navKey, model.hero.href, model.hero.id);
      cta.append(start, shuffleBtn(model)); hero.append(cta);
    } else {
      const h1 = el("h1", "dash-headline"); h1.append(el("span", "dash-obj", "You're all caught up"));
      hero.append(h1, el("p", "dash-lede", "Nothing is due right now — reroll a surprise or open a module below."));
      const cta = el("div", "dash-cta"); cta.append(shuffleBtn(model)); hero.append(cta);
    }
    wrap.append(hero);

    const lab = el("div", "dash-seclabel");
    lab.append(el("span", null, "Your modules"), el("span", "dash-seccount", model.modules.length + " tracks"));
    wrap.append(lab);
    const grid = el("div", "dash-grid");
    model.modules.forEach(m => grid.append(rise(moduleCard(m))));
    wrap.append(grid);

    if (model.wrong.length) wrap.append(rise(wrongSection(model.wrong)));
    host.append(wrap);
  }

  api.moduleCard = moduleCard;   // exposed for tests (jsdom renders a card and clicks its header)

  function boot() {
    if (typeof window.registerDeckView !== "function") return;                   // algorithms-only host / file://
    window.registerDeckView("home", "Home", init);
    const tabs = document.getElementById("tabs"), btn = tabs && tabs.querySelector('button[data-tab="home"]');
    if (btn && tabs.firstChild !== btn) tabs.insertBefore(btn, tabs.firstChild);  // Home sits leftmost (it's the / landing)
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  const css = `
    #view-home{padding:46px 44px 100px;background-color:var(--bg);
      background-image:
        radial-gradient(1100px 660px at 6% -14%, color-mix(in srgb,#2dd4bf 10%, transparent), transparent 60%),
        radial-gradient(940px 560px at 100% 0%, color-mix(in srgb,#6366f1 9%, transparent), transparent 54%),
        radial-gradient(circle at 1px 1px, color-mix(in srgb,var(--line) 62%, transparent) 1px, transparent 0);
      background-size:auto,auto,26px 26px}
    .dash{max-width:1180px;margin:0 auto}
    .dash-load{color:var(--muted);font-family:var(--mono);font-size:13px;letter-spacing:.04em;padding:64px 6px}

    .dash-hero,.dash-panel,.dash-gaps{opacity:0;transform:translateY(16px);animation:dashrise .6s cubic-bezier(.2,.75,.25,1) forwards;animation-delay:calc(var(--i,0)*48ms)}
    @keyframes dashrise{to{opacity:1;transform:none}}
    @keyframes dashspin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.dash-hero,.dash-panel,.dash-gaps{animation:none;opacity:1;transform:none}}

    .dash-kicker{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.32em;text-transform:uppercase;color:var(--ok)}
    .dash-kicker.bad{color:var(--bad)}

    /* hero / the daily briefing */
    .dash-hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:22px;padding:32px 36px 34px;margin-bottom:40px;
      background:radial-gradient(130% 150% at 0% 0%, color-mix(in srgb,var(--ok) 13%, transparent), transparent 46%),linear-gradient(180deg,var(--surface),color-mix(in srgb,var(--surface) 34%,var(--bg)));
      box-shadow:0 40px 90px -60px #000}
    .dash-hero::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,var(--ok),transparent 78%)}
    .dash-hero-meta{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
    .dash-date{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
    .dash-headline{font-family:var(--display);font-weight:800;font-size:clamp(30px,4.4vw,50px);line-height:1.02;letter-spacing:-.035em;margin:0 0 15px;max-width:22ch}
    .dash-verb{color:var(--ok)}
    .dash-obj{color:var(--text)}
    .dash-lede{font-family:var(--body);font-size:15px;line-height:1.5;color:var(--muted);margin:0 0 27px;max-width:64ch}
    .dash-cta{display:flex;gap:12px;flex-wrap:wrap}
    .dash-start{display:inline-flex;align-items:center;font-family:var(--body);font-weight:700;font-size:15px;color:#04140d;cursor:pointer;border:0;border-radius:13px;
      padding:14px 26px;background:linear-gradient(180deg,#5fe9b6,var(--ok));box-shadow:0 18px 36px -18px color-mix(in srgb,var(--ok) 85%,transparent),inset 0 1px 0 rgba(255,255,255,.4);transition:transform .16s,filter .16s}
    .dash-start:hover{transform:translateY(-2px);filter:brightness(1.05)}
    .dash-start-arr{margin-left:9px;transition:transform .18s}
    .dash-start:hover .dash-start-arr{transform:translateX(4px)}
    .dash-shuffle{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12.5px;letter-spacing:.02em;color:var(--text);cursor:pointer;
      background:color-mix(in srgb,var(--surface2) 66%,transparent);border:1px solid var(--line);border-radius:13px;padding:14px 18px;transition:.16s}
    .dash-shuffle:hover{border-color:var(--faint);background:var(--surface2)}
    .dash-die{display:inline-block;font-size:15px}
    .dash-shuffle:hover .dash-die{animation:dashspin .5s ease}

    .dash-seclabel{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin:0 4px 15px}
    .dash-seclabel>span:first-child{font-family:var(--mono);font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--faint)}
    .dash-seccount{font-family:var(--mono);font-size:11px;color:var(--faint)}

    /* module panels */
    .dash-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(306px,1fr));gap:18px;align-items:stretch}
    .dash-panel{position:relative;display:flex;flex-direction:column;gap:16px;padding:20px 20px 18px;border:1px solid var(--line);border-radius:18px;overflow:hidden;
      background:linear-gradient(180deg,var(--surface),color-mix(in srgb,var(--surface) 60%,var(--bg)));transition:transform .2s,border-color .2s,box-shadow .2s}
    .dash-panel::before{content:"";position:absolute;left:0;top:0;width:100%;height:2px;background:linear-gradient(90deg,var(--accent),transparent 72%);opacity:.55;transition:opacity .2s}
    .dash-panel:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--accent) 48%,var(--line));box-shadow:0 28px 52px -30px color-mix(in srgb,var(--accent) 48%,#000)}
    .dash-panel:hover::before{opacity:1}
    .dash-phead{display:flex;flex-direction:column;gap:3px;padding-right:36px;cursor:pointer;border-radius:8px;outline:none}
    .dash-phead:focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 60%,transparent);outline-offset:4px}
    .dash-tag{font-family:var(--mono);font-size:9.5px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:var(--accent)}
    .dash-pname{font-family:var(--display);font-weight:700;font-size:19px;letter-spacing:-.015em;margin:0;line-height:1.12;color:var(--text);transition:color .16s}
    .dash-phead:hover .dash-pname{color:var(--accent)}
    .dash-pbody{display:flex;align-items:center;gap:18px}
    .dash-ring{--track:color-mix(in srgb,var(--line) 92%,var(--surface));--attempt:color-mix(in srgb,var(--accent) 46%,var(--line));
      flex:none;width:82px;height:82px;border-radius:50%;display:grid;place-items:center;position:relative;
      background:conic-gradient(var(--accent) 0 calc(var(--p,0)*1%), var(--attempt) calc(var(--p,0)*1%) calc(var(--q,0)*1%), var(--track) calc(var(--q,0)*1%) 100%)}
    .dash-ring::before{content:"";position:absolute;inset:7px;border-radius:50%;background:var(--surface)}
    .dash-ring-num{position:relative;font-family:var(--display);font-weight:700;font-size:21px;color:var(--text)}
    .dash-ring-num em{font-style:normal;font-size:11px;color:var(--muted);margin-left:1px}
    .dash-legend{display:flex;flex-direction:column;gap:6px;min-width:0}
    .dash-lg{display:flex;align-items:center;gap:8px}
    .dash-dot{flex:none;width:8px;height:8px;border-radius:50%}
    .dash-lg b{font-family:var(--display);font-weight:700;font-size:15px;color:var(--text);line-height:1;min-width:2.4ch;text-align:right}
    .dash-lg span{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
    .dash-lg-done .dash-dot{background:var(--accent)}
    .dash-lg-wip .dash-dot{background:color-mix(in srgb,var(--accent) 46%,var(--line))}
    .dash-lg-wip b{color:color-mix(in srgb,var(--accent) 82%,var(--text))}
    .dash-lg-todo .dash-dot{background:transparent;box-shadow:inset 0 0 0 1.5px var(--faint)}
    .dash-lg-todo b,.dash-lg-todo span{color:var(--faint)}
    .dash-flags{display:flex;gap:8px;flex-wrap:wrap}
    .dash-chip{font-family:var(--mono);font-size:10px;letter-spacing:.04em;padding:4px 9px;border-radius:8px;border:1px solid transparent}
    .dash-chip-due{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 38%,transparent);background:color-mix(in srgb,var(--warn) 8%,transparent)}
    .dash-chip-missed{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 38%,transparent);background:color-mix(in srgb,var(--bad) 8%,transparent)}
    .dash-chip.clickable{cursor:pointer}
    .dash-chip.clickable:hover{background:color-mix(in srgb,var(--bad) 16%,transparent)}

    .dash-ns{display:flex;align-items:center;gap:12px;text-align:left;width:100%;margin-top:auto;cursor:pointer;
      background:color-mix(in srgb,var(--surface2) 55%,transparent);border:1px solid var(--line);border-radius:13px;padding:11px 14px;transition:.17s}
    .dash-ns:hover{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));background:var(--surface2)}
    .dash-ns-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
    .dash-ns-k{font-family:var(--mono);font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint)}
    .dash-ns-t{font-family:var(--body);font-weight:600;font-size:14.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dash-ns-s{font-family:var(--mono);font-size:10.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dash-ns-arr{flex:none;color:var(--accent);font-size:19px;transition:transform .18s}
    .dash-ns:hover .dash-ns-arr{transform:translateX(4px)}
    .dash-ns-done{color:var(--ok);cursor:default;font-family:var(--mono);font-size:12px}
    .dash-ns-done:hover{border-color:var(--line);background:color-mix(in srgb,var(--surface2) 55%,transparent)}

    .dash-dice{position:absolute;top:16px;right:16px;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-size:14px;cursor:pointer;line-height:1;
      color:var(--muted);background:color-mix(in srgb,var(--surface2) 60%,transparent);border:1px solid var(--line);transition:.16s}
    .dash-dice:hover{color:var(--text);border-color:color-mix(in srgb,var(--accent) 55%,var(--line));transform:rotate(-18deg)}

    /* review gaps */
    .dash-gaps{margin-top:46px;border:1px solid color-mix(in srgb,var(--bad) 22%,var(--line));border-radius:18px;padding:22px 24px 20px;
      background:radial-gradient(120% 150% at 100% 0%, color-mix(in srgb,var(--bad) 9%,transparent), transparent 42%),var(--surface)}
    .dash-gaps-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:16px}
    .dash-gaps-sub{font-family:var(--mono);font-size:11px;color:var(--muted)}
    .dash-gaps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(322px,1fr));gap:14px;align-items:start}
    .dash-gaps-col{border:1px solid var(--line);border-radius:14px;padding:6px;background:color-mix(in srgb,var(--bg) 45%,var(--surface))}
    .dash-gaps-mod{font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--bad);padding:9px 10px 7px}
    .dash-gap{display:flex;gap:10px;width:100%;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:10px;padding:10px;transition:background .15s}
    .dash-gap:hover{background:color-mix(in srgb,var(--bad) 11%,transparent)}
    .dash-gap-ico{flex:none;color:var(--bad);font-size:13px;margin-top:1px}
    .dash-gap-body{min-width:0}
    .dash-gap-c{font-family:var(--body);font-weight:600;font-size:13.5px;color:var(--text)}
    .dash-gap:hover .dash-gap-c{color:var(--bad)}
    .dash-gap-q{font-family:var(--body);font-size:12px;color:var(--muted);margin-top:3px;line-height:1.45}

    @media (max-width:720px){
      #view-home{padding:26px 18px 76px}
      .dash-hero{padding:24px 22px 26px;border-radius:18px}
      .dash-grid,.dash-gaps-grid{grid-template-columns:1fr}
    }`;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));
})(typeof window !== "undefined" ? window : null);
