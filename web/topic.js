/* Interactive-lesson topics — the LEARNER phase of specs/interactive_lesson.md.

   Author-once/serve-many: everything rendered here is STATIC content generated offline by
   seed.py (content/<id>/{manifest,curriculum,graph,concepts/*}.json). No LLM at runtime — this
   only fetches published JSON, draws the concept graph, gates concepts by prerequisite, and
   tracks {mastery,score,attempts} progress via /api/topic/<id>/progress.

   Two views, both scoped under .topic-view so the ML/LLM decks are untouched:
   • a MAP — the dependency graph as a left-to-right tree (root = topic → foundations →
     advanced), reusing the Algorithms map's node/column/SVG-edge machinery;
   • a READER — a centered technical-editorial lesson (masthead, standfirst, sectioned prose,
     quiz, interview accordion) built on the app's own type system (Bricolage / Hanken / Plex). */
(function () {
  "use strict";
  const USER = "me";
  const ACCENT = "#a78bfa", ROOT_COLOR = "#c4b5fd";           // RAG's signature violet (node bars + edges)

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const mdDiv = (cls, text) => {
    const e = el("div", cls), r = window.CardChat && window.CardChat.renderMd;
    if (r) e.innerHTML = r(text || ""); else e.textContent = text || "";
    return e;
  };
  // cache:"no-cache" → always revalidate with the server (conditional GET; cheap 304 when unchanged). This box
  // edits content live on disk, so a heuristically-cached curriculum/concept must never mask a fresh one.
  const jget = async (url) => { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(url + " → " + r.status); return r.json(); };
  const R = window.Review;                                    // shared timed-retrieval kernel (review.js)
  // On phones the ✦ Refine action lives in the shared bottom bar (git.js .gs-actions), not the reader. Because
  // that bar is outside the topic view, we inject/drop it explicitly per-concept and on any tab switch.
  const onPhone = () => matchMedia("(max-width:560px)").matches;
  const barActions = () => document.querySelector("#gitsync .gs-actions");
  const removeBarRefine = () => { const b = barActions(); if (b) b.querySelectorAll(".topic-refine").forEach((e) => e.remove()); };
  const hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };  // stable per-question key

  const STYLE = `
    .topic-view{--rag:#a78bfa;--rag-soft:rgba(167,139,250,.12)}
    @keyframes topic-rise{from{opacity:0;transform:translateY(13px)}to{opacity:1;transform:none}}

    /* ---------------- the map (dependency tree) ---------------- */
    .topic-view:has(.topic-map){overflow:hidden;display:flex;flex-direction:column;position:relative}  /* map view: fixed header + ONE scrolling canvas (kills the nested deck-view/map double scrollbar); reader view has no .topic-map so it still scrolls normally */
    .topic-map{position:relative;flex:1;min-height:0;overflow:auto;padding:22px 22px 54px;cursor:grab;
      scrollbar-width:none}                                    /* no bars — you pan by dragging; cursor:grab is the affordance */
    .topic-map::-webkit-scrollbar{width:0;height:0}
    .topic-map .cols{align-items:center;gap:54px}
    /* zoom: the tree is a map, not a document. CSS zoom (not transform) so the scroll box resizes with
       the content — native scrolling keeps panning, and edges stay laid out in unzoomed px (no redraw). */
    .topic-map .stage{position:relative;width:max-content}
    .topic-map.grabbing{cursor:grabbing;user-select:none}
    .topic-zoom{position:absolute;right:20px;top:13px;z-index:12;display:flex;align-items:center;gap:1px;
      border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:3px;box-shadow:0 10px 26px -18px #000}
    .topic-zoom button{font-family:var(--mono);font-size:12px;color:var(--muted);background:none;border:0;
      border-radius:7px;padding:5px 9px;cursor:pointer;line-height:1}
    .topic-zoom button:hover{background:var(--rag-soft);color:var(--text)}
    .topic-zoom .z-pc{min-width:46px;font-variant-numeric:tabular-nums}
    .topic-maphead{padding:2px 2px 10px;max-width:620px}
    .topic-kicker{font-family:var(--mono);font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--rag)}
    .topic-mapstat{font-family:var(--display);font-weight:700;font-size:23px;letter-spacing:-.015em;margin:11px 0 7px;color:var(--text)}
    .topic-hint{font-size:13px;line-height:1.55;color:var(--faint)}
    .topic-node .l{font-family:var(--display);font-weight:700;letter-spacing:-.01em;font-size:14px}
    .topic-node .m{font-family:var(--mono)}
    .topic-root{cursor:default;border-color:color-mix(in srgb,var(--fam) 60%,var(--line));
      box-shadow:0 0 0 1px color-mix(in srgb,var(--fam) 28%,transparent),0 16px 38px -14px color-mix(in srgb,var(--fam) 60%,transparent)}
    .topic-root .l{font-size:16.5px;line-height:1.12}
    .topic-locked{opacity:.5;cursor:default}
    .topic-locked:hover{transform:none;box-shadow:none;border-color:var(--line)}

    /* module-level question bank — a slim violet-rail strip above the map (echoes the key-points spec card).
       Sits in the fixed header zone (outside .topic-map), so the tree stays the one scrolling canvas. */
    .topic-bank{display:flex;align-items:center;gap:clamp(14px,2.4vw,30px);flex-wrap:wrap;margin:12px 22px 2px;
      border-radius:4px 13px 13px 4px;border:1px solid color-mix(in srgb,var(--rag) 20%,var(--line));border-left:3px solid var(--rag);
      background:linear-gradient(110deg,rgba(167,139,250,.09),rgba(167,139,250,.02));padding:11px 16px}
    .topic-bank .tb-lead{display:flex;flex-direction:column;gap:2px}
    .topic-bank .tb-eyebrow{font-family:var(--mono);font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:color-mix(in srgb,var(--rag) 82%,#fff)}
    .topic-bank .tb-count{font-family:var(--display);font-weight:800;font-size:19px;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums}
    .topic-bank .tb-count small{font-family:var(--mono);font-size:10px;font-weight:500;color:var(--muted);margin-left:6px;letter-spacing:.01em}
    .topic-bank .tb-meter{flex:1 1 170px;min-width:150px;max-width:340px}
    .topic-bank .tb-bar{display:flex;height:8px;border-radius:20px;overflow:hidden;background:#0c0913;border:1px solid var(--line)}
    .topic-bank .tb-bar span{display:block;height:100%}
    .topic-bank .s-mast{background:linear-gradient(90deg,#22c55e,#34d399)}
    .topic-bank .s-learn{background:linear-gradient(90deg,#8b6ff0,#a78bfa)}
    .topic-bank .s-new{background:#26304060}
    .topic-bank .tb-legend{display:flex;gap:12px;margin-top:7px;flex-wrap:wrap}
    .topic-bank .tb-legend div{font-family:var(--mono);font-size:10px;color:var(--muted);display:flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums}
    .topic-bank .tb-legend i{width:8px;height:8px;border-radius:2px}
    .topic-bank .tb-legend b{color:var(--text);font-weight:600}
    .topic-bank .tb-actions{display:flex;gap:9px;align-items:center;margin-left:auto}
    .topic-bank .tb-due{font-family:var(--mono);font-size:11px;font-weight:600;color:#0a0713;background:linear-gradient(180deg,#bca9f9,#8b6ff0);border-radius:20px;padding:4px 11px;white-space:nowrap}
    .topic-bank .tb-start{font-family:var(--body);font-weight:700;font-size:13px;color:#0a0713;cursor:pointer;border:0;border-radius:10px;
      padding:10px 18px;background:linear-gradient(180deg,#bca9f9,#8b6ff0);box-shadow:0 10px 24px -12px rgba(139,111,240,.8);transition:transform .15s,filter .15s;white-space:nowrap}
    .topic-bank .tb-start:hover{transform:translateY(-1px);filter:brightness(1.06)}
    .topic-bank .tb-ghost{font-family:var(--mono);font-size:11.5px;color:#cdd6e2;cursor:pointer;border-radius:10px;padding:9px 13px;
      background:color-mix(in srgb,var(--rag) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--rag) 38%,var(--line));white-space:nowrap;transition:filter .15s}
    .topic-bank .tb-ghost:hover{filter:brightness(1.12)}
    @media (max-width:560px){
      .topic-bank{margin:10px 6px 2px;gap:12px}
      .topic-bank .tb-meter{flex-basis:100%;max-width:none;order:5}
      .topic-bank .tb-actions{margin-left:0;order:4;flex:1 1 100%}
      .topic-bank .tb-actions .tb-start{flex:1}
    }

    /* hover key-points popover — a crisp "spec card": position:fixed on <body> so the scrolling map can't
       clip it; near-opaque so the busy graph never bleeds through (the old translucent tint hurt legibility).
       Numbered beats (echoing .topic-goals) read as the ordered mechanism the points describe. */
    .topic-kp{position:fixed;z-index:60;width:max-content;max-width:332px;pointer-events:none;
      opacity:0;transform:translateY(7px) scale(.985);transition:opacity .16s ease,transform .18s cubic-bezier(.2,.75,.2,1);
      background:linear-gradient(158deg,#191324,#100c19 62%);
      border:1px solid color-mix(in srgb,var(--rag) 26%,#2a2338);border-left:3px solid var(--rag);
      border-radius:4px 15px 15px 4px;padding:15px 18px 16px;
      box-shadow:0 26px 62px -18px rgba(0,0,0,.9),0 0 0 1px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.055)}
    .topic-kp.show{opacity:1;transform:none}
    .topic-kp .kp-t{font-family:var(--mono);font-size:9.5px;letter-spacing:.22em;text-transform:uppercase;
      color:color-mix(in srgb,var(--rag) 82%,#fff);margin:0 0 12px;display:flex;align-items:center;gap:9px}
    .topic-kp .kp-t::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,color-mix(in srgb,var(--rag) 38%,transparent),transparent)}
    .topic-kp ul{list-style:none;margin:0;padding:0;counter-reset:kp;display:flex;flex-direction:column;gap:11px}
    .topic-kp li{position:relative;counter-increment:kp;padding-left:26px;font-size:13px;line-height:1.5;color:#eaedf4;font-family:var(--body)}
    .topic-kp li::before{content:counter(kp);position:absolute;left:0;top:.02em;width:16px;height:16px;
      display:grid;place-items:center;border-radius:5px;font-family:var(--mono);font-size:10px;font-weight:600;
      color:color-mix(in srgb,var(--rag) 88%,#fff);background:color-mix(in srgb,var(--rag) 15%,transparent);
      border:1px solid color-mix(in srgb,var(--rag) 34%,transparent)}
    .topic-kp .kp-lock{margin-top:14px;padding-top:12px;border-top:1px solid color-mix(in srgb,var(--rag) 16%,#2a2338);
      font-size:11px;line-height:1.5;color:#a2a8b6}
    .topic-kp .kp-lock b{color:#cbbcf6;font-weight:600}

    /* ---------------- the reader (a lesson) ---------------- */
    .topic-reader{max-width:770px;margin:0 auto;padding-bottom:32px}
    .topic-reader > *{animation:topic-rise .5s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0)*.045s)}
    .topic-back{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;color:var(--muted);background:transparent;
      border:0;cursor:pointer;padding:4px 0;margin-bottom:22px;display:inline-flex;align-items:center;gap:9px;transition:color .16s}
    .topic-back:hover{color:var(--rag)}
    .topic-back .a{display:inline-block;transition:transform .18s}
    .topic-back:hover .a{transform:translateX(-4px)}

    .topic-lede{border-bottom:1px solid var(--line);padding-bottom:32px}
    .topic-eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.26em;text-transform:uppercase;color:var(--rag);display:flex;gap:10px;align-items:center}
    .topic-eyebrow .mast{color:var(--ok)}
    .topic-title{font-family:var(--display);font-weight:800;font-size:clamp(31px,4.4vw,46px);line-height:1.02;letter-spacing:-.028em;margin:16px 0 0;color:var(--text)}
    .topic-standfirst{font-size:19px;line-height:1.62;color:var(--muted);margin:20px 0 0;max-width:62ch}

    .topic-section{margin-top:2px}
    .topic-label{display:flex;align-items:center;gap:13px;margin:40px 0 17px;font-family:var(--mono);font-size:11px;
      letter-spacing:.24em;text-transform:uppercase;color:var(--muted)}
    .topic-label::before{content:"";width:22px;height:2px;border-radius:2px;background:var(--rag);box-shadow:0 0 11px -1px var(--rag)}
    .topic-label::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
    .topic-quiznote{font-size:13.5px;color:var(--muted);margin:-7px 0 15px;line-height:1.5}

    .topic-goals{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
    .topic-goals li{position:relative;padding-left:32px;line-height:1.55;color:#ccd5e2}
    .topic-goals li::before{content:"";position:absolute;left:0;top:.18em;width:17px;height:17px;border-radius:6px;
      border:1.5px solid color-mix(in srgb,var(--rag) 55%,var(--line));background:var(--rag-soft)}
    .topic-goals li::after{content:"→";position:absolute;left:4px;top:.02em;font-size:11px;color:var(--rag)}

    .topic-prose{font-size:15.5px;line-height:1.76;color:#ccd5e2}
    .topic-prose>*:first-child{margin-top:0}.topic-prose>*:last-child{margin-bottom:0}
    .topic-prose p{margin:0 0 15px}
    .topic-prose h2,.topic-prose h3{font-family:var(--display);color:var(--text);letter-spacing:-.012em;line-height:1.25;margin:28px 0 11px}
    .topic-prose h2{font-size:21px}.topic-prose h3{font-size:17px}
    .topic-prose strong{color:var(--text);font-weight:600}
    .topic-prose em{color:#bcc6d4}
    .topic-prose a{color:var(--rag);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--rag) 40%,transparent)}
    .topic-prose code{font-family:var(--mono);font-size:.85em;background:var(--rag-soft);color:#d6ccfb;padding:.13em .42em;border-radius:5px}
    .topic-prose pre{background:#11161f;border:1px solid #303d50;border-radius:13px;padding:15px 17px;overflow-x:auto;margin:2px 0 16px;box-shadow:0 14px 34px -22px rgba(0,0,0,.95),inset 0 1px 0 rgba(255,255,255,.03)}
    .topic-prose pre code{background:none;color:#cdd7e5;font-size:12.75px;padding:0;line-height:1.62}
    .topic-prose ul,.topic-prose ol{margin:0 0 15px;padding-left:22px}
    .topic-prose li{margin:6px 0}
    .topic-prose blockquote{margin:0 0 16px;padding:11px 17px;border-left:2px solid var(--rag);background:var(--rag-soft);border-radius:0 9px 9px 0;color:var(--muted)}
    .topic-prose table{border-collapse:collapse;width:100%;margin:0 0 16px;font-size:14px}
    .topic-prose th,.topic-prose td{border:1px solid var(--line);padding:8px 11px;text-align:left}
    .topic-prose th{background:var(--surface);font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}

    .topic-callout{border:1px solid color-mix(in srgb,var(--rag) 22%,var(--line));
      background:linear-gradient(180deg,rgba(167,139,250,.07),rgba(167,139,250,.02));border-radius:15px;padding:18px 21px}

    /* quiz — reuse study.js's option grader, only fit it to the reader */
    .topic-view .ml-quiz{background:var(--surface2);border:1px solid var(--line);border-radius:14px;padding:17px 19px;margin:0 0 12px}
    .topic-view .ml-quiz .ml-front{font-weight:600;font-size:15px;margin-bottom:12px}
    /* per-question deep-dive: expands beneath the question the moment you answer */
    .quiz-reveal{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .34s cubic-bezier(.2,.7,.2,1),opacity .3s ease}
    .quiz-reveal.open{grid-template-rows:1fr;opacity:1}
    .quiz-reveal-inner{overflow:hidden;min-height:0}
    .quiz-reveal-panel{margin-top:13px;padding:13px 16px;border-radius:0 12px 12px 0;border-left:2px solid var(--rag);
      background:linear-gradient(100deg,rgba(167,139,250,.09),rgba(167,139,250,.02))}
    .quiz-reveal.ok .quiz-reveal-panel{border-left-color:#34d399;background:linear-gradient(100deg,rgba(52,211,153,.10),rgba(52,211,153,.02))}
    .quiz-reveal.no .quiz-reveal-panel{border-left-color:#f87171;background:linear-gradient(100deg,rgba(248,113,113,.10),rgba(248,113,113,.02))}
    .quiz-reveal-head{display:flex;align-items:center;gap:11px;margin-bottom:7px}
    .quiz-reveal-badge{font-family:var(--mono);font-size:11.5px;font-weight:600;letter-spacing:.03em}
    .quiz-reveal.ok .quiz-reveal-badge{color:#34d399}
    .quiz-reveal.no .quiz-reveal-badge{color:#f87171}
    .quiz-reveal-ans{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);border:1px solid var(--line);border-radius:5px;padding:2px 7px}
    .quiz-reveal-body{font-size:14px;line-height:1.65;color:#c7d0dd}
    .quiz-reveal-body p{margin:0 0 8px}.quiz-reveal-body>*:last-child{margin-bottom:0}
    .quiz-reveal-body code{font-size:.85em}

    /* interview — native <details> accordion */
    .topic-qa{border:1px solid var(--line);border-radius:13px;margin:0 0 11px;overflow:hidden;background:color-mix(in srgb,var(--surface) 60%,transparent)}
    .topic-qa+.topic-qa{margin-top:-1px}
    .topic-qa summary{list-style:none;cursor:pointer;padding:16px 19px;display:flex;align-items:flex-start;gap:13px;font-weight:600;font-size:15px;color:var(--text);transition:background .16s}
    .topic-qa summary::-webkit-details-marker{display:none}
    .topic-qa summary::before{content:"›";color:var(--rag);font-size:21px;line-height:1;margin-top:-1px;transition:transform .2s}
    .topic-qa[open] summary::before{transform:rotate(90deg)}
    .topic-qa summary:hover{background:rgba(255,255,255,.025)}
    .topic-qa .topic-prose{padding:2px 20px 17px 45px;font-size:15px;color:var(--muted)}

    .topic-cta{margin-top:44px;display:flex;justify-content:center}
    /* fixed middle-right floating action button — sits above the page, below the chat drawer (z 60) */
    /* animation:none — it's a direct child of .topic-reader, but topic-rise's both-fill ends on
       transform:none, which would clobber this button's translateY(-50%) centering; opt it out. */
    .topic-refine{position:fixed;right:22px;top:50%;transform:translateY(-50%);z-index:50;animation:none;
      display:inline-flex;align-items:center;gap:7px;
      font-family:var(--mono);font-size:12.5px;letter-spacing:.02em;color:#cdd6e2;cursor:pointer;border-radius:13px;
      padding:13px 18px;background:color-mix(in srgb,#a78bfa 16%,var(--surface));border:1px solid color-mix(in srgb,#a78bfa 46%,var(--line));
      box-shadow:0 12px 34px -12px rgba(0,0,0,.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
      transition:filter .15s,border-color .15s,box-shadow .15s}
    .topic-refine .tr-ico{font-size:14px;line-height:1}
    .topic-refine:hover{filter:brightness(1.12);border-color:#a78bfa;box-shadow:0 16px 40px -12px rgba(139,111,250,.5)}
    @media (max-width:560px){
      /* reclaim vertical space on phones: tighter map + a compact masthead */
      /* top-align columns (desktop centers them, which strands the root node mid-screen on a tall phone) */
      .topic-map .cols{align-items:flex-start;gap:30px}
      .topic-map{padding:12px 6px 46px}
      .topic-maphead{max-width:100%;padding:0 0 4px}
      .topic-kicker{font-size:10px;letter-spacing:.22em}
      .topic-mapstat{font-size:17px;margin:7px 0 5px;line-height:1.15}
      .topic-hint{font-size:12px;line-height:1.5}
      .topic-lede{padding-bottom:20px}
      .topic-title{font-size:27px;margin-top:9px}
      .topic-standfirst{font-size:16px;margin-top:13px;line-height:1.55}
      .topic-label{margin:28px 0 13px}
    }
    /* On phones Refine joins the shared bottom bar (git.js .gs-actions), beside notes ✎ and the commit status —
       a violet ✦ icon. renderConcept/renderGraph inject & drop it per-concept. Desktop keeps the middle-right pill. */
    .gs-actions .topic-refine{color:#a78bfa}
    .gs-actions .topic-refine .tr-txt{display:none}
    .gs-actions .topic-refine .tr-ico{font-size:16px}
    .topic-mark{font-family:var(--body);font-weight:600;font-size:15px;color:#0a0713;cursor:pointer;border:0;border-radius:13px;
      padding:14px 30px;background:linear-gradient(180deg,#bca9f9,#8b6ff0);box-shadow:0 12px 32px -12px rgba(139,111,240,.75);
      transition:transform .15s,box-shadow .15s,filter .15s}
    .topic-mark:hover{transform:translateY(-2px);filter:brightness(1.05);box-shadow:0 18px 42px -12px rgba(139,111,240,.85)}
    .topic-mark.mastered{color:#04140a;background:linear-gradient(180deg,#5ae59a,#22c55e);box-shadow:0 12px 32px -12px rgba(34,197,94,.6)}

    .topic-loading{font-family:var(--mono);font-size:12px;letter-spacing:.1em;color:var(--faint);padding:30px 4px}
  `;
  function injectStyle() {
    if (document.getElementById("topic-css")) return;
    const s = el("style"); s.id = "topic-css"; s.textContent = STYLE; document.head.appendChild(s);
  }

  // ---- one topic ----
  function createTopic(manifest) {
    const TID = manifest.id;
    let curriculum = null, graph = null, progress = {}, container = null, bank = [];

    const node = (id) => graph[id] || { requires: [] };
    const prog = (id) => progress[id] || null;
    const isMastered = (id) => (prog(id) || {}).mastery === "Mastered";
    const unlocked = (id) => node(id).requires.every(isMastered);
    const concept = (id) => (curriculum.concepts || []).find((c) => c.id === id) || { id, title: id };
    const titleOf = (id) => concept(id).title;

    async function saveProgress() {
      try {
        await fetch(`/api/topic/${TID}/progress?user=${USER}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(progress),
        });
      } catch (_) { /* offline → keep in-memory; next save retries the whole object */ }
    }

    // ---- the dependency tree (root → foundations → advanced), prereq-gated ----
    function renderGraph() {
      removeBarRefine();                          // back to the map → drop this concept's ✦ from the bottom bar
      container.replaceChildren();
      const mastered = curriculum.concepts.filter((c) => isMastered(c.id)).length;
      const head = el("div", "topic-maphead");
      head.append(
        el("div", "topic-kicker", "Interactive lessons"),
        el("div", "topic-mapstat", `${mastered} of ${curriculum.concepts.length} concepts mastered`),
        el("div", "topic-hint", "Start at the root and work outward — each concept unlocks once its prerequisites are mastered."),
      );
      container.append(head);
      const strip = bankStrip(); if (strip) container.append(strip);   // module-level quiz bank, above the map

      const ROOT = "__topic__";
      const nodes = [{ id: ROOT, label: manifest.title, root: true }]
        .concat(curriculum.concepts.map((c) => ({ id: c.id, label: c.title, difficulty: c.difficulty, keyPoints: c.keyPoints })));
      const edges = [];
      for (const c of curriculum.concepts) {
        const reqs = node(c.id).requires;
        if (!reqs.length) edges.push([ROOT, c.id]);
        for (const r of reqs) edges.push([r, c.id]);
      }

      // layered longest-path depth (Kahn) — the Algorithms map's layout
      const ids = nodes.map((n) => n.id), indeg = {}, adj = {}, depth = {};
      ids.forEach((id) => { indeg[id] = 0; adj[id] = []; });
      edges.forEach(([a, b]) => { adj[a].push(b); indeg[b]++; });
      const queue = ids.filter((id) => indeg[id] === 0); queue.forEach((id) => { depth[id] = 0; });
      while (queue.length) {
        const u = queue.shift();
        for (const v of adj[u]) { depth[v] = Math.max(depth[v] == null ? 0 : depth[v], depth[u] + 1); if (--indeg[v] === 0) queue.push(v); }
      }
      const maxD = Math.max(0, ...Object.values(depth));

      const mapEl = el("div", "topic-map");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "edges");
      const colsEl = el("div", "cols");
      const stage = el("div", "stage");                 // the zoomable canvas: edges + node columns together
      stage.append(svg, colsEl);
      mapEl.append(stage);
      const cardEl = {};
      const hlEdges = (id, on) => svg.querySelectorAll("path").forEach((p) => {
        if (p.dataset.from === id || p.dataset.to === id) p.classList.toggle("hl", on);
      });

      // hover key-points popover (singleton on <body>; fixed-positioned so the map's overflow:auto can't clip it)
      let kp = document.getElementById("topic-kp-pop");
      if (!kp) { kp = el("div", "topic-kp"); kp.id = "topic-kp-pop"; document.body.appendChild(kp); }
      const hideKP = () => kp.classList.remove("show");
      const showKP = (n, card, open) => {
        let html = `<div class="kp-t">Key points</div><ul>${n.keyPoints.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
        if (!open) html += `<div class="kp-lock">🔒 Unlock by mastering <b>${esc(node(n.id).requires.map(titleOf).join(", "))}</b></div>`;
        kp.innerHTML = html;
        kp.classList.add("show");                                    // show first so offsetWidth/Height measure the laid-out box
        const r = card.getBoundingClientRect(), gap = 12, kw = kp.offsetWidth, kh = kp.offsetHeight;
        let x = r.right + gap; if (x + kw > innerWidth - 8) x = r.left - gap - kw;   // flip left if it'd overflow the viewport
        kp.style.left = Math.max(8, x) + "px";
        kp.style.top = Math.min(Math.max(8, r.top + r.height / 2 - kh / 2), innerHeight - kh - 8) + "px";
      };
      mapEl.addEventListener("scroll", hideKP);                      // scrolling the map moves the node out from under a fixed popover
      for (let d = 0; d <= maxD; d++) {
        const col = el("div", "col"); col.style.setProperty("--i", d);
        for (const n of nodes.filter((x) => depth[x.id] === d)) {
          const open = n.root || unlocked(n.id), mast = !n.root && isMastered(n.id);
          const card = el("button", "node topic-node" + (n.root ? " topic-root" : "") + (open ? "" : " topic-locked"));
          card.style.setProperty("--fam", n.root ? ROOT_COLOR : ACCENT);
          if (mast) card.dataset.st = "green";
          const meta = n.root ? `${curriculum.concepts.length} concepts`
            : n.difficulty + (mast ? " · ✓ mastered" : open ? "" : " · 🔒");
          card.innerHTML = `<span class="l">${esc(n.label)}</span><span class="m"><i class="pip"></i><span>${esc(meta)}</span></span>`;
          if (!n.root && open) card.onclick = () => { hideKP(); openConcept(concept(n.id)); };
          const hasKP = !n.root && n.keyPoints && n.keyPoints.length;
          if (!n.root && !open && !hasKP) card.title = "Locked — first master: " + node(n.id).requires.map(titleOf).join(", ");
          card.onmouseenter = () => { hlEdges(n.id, true); if (hasKP) showKP(n, card, open); };
          card.onmouseleave = () => { hlEdges(n.id, false); if (hasKP) hideKP(); };
          cardEl[n.id] = card;
          col.append(card);
        }
        colsEl.append(col);
      }
      container.append(mapEl);

      // ---- zoom + drag-pan (ponytail: no minimap, no inertia — ⌘/ctrl-wheel, drag, and Fit cover it) ----
      const stored = localStorage.getItem("topic-zoom");
      let z = +stored || 1;
      stage.style.zoom = z;
      const pcEl = el("button", "z-pc"); pcEl.title = "Reset to 100%"; pcEl.onclick = () => setZoom(1);
      // ox/oy = the anchor point (map-relative px) to hold still while scaling; defaults to the viewport centre
      const setZoom = (nz, ox, oy) => {
        nz = Math.min(2.5, Math.max(0.2, +nz.toFixed(2)));
        const ax = ox == null ? mapEl.clientWidth / 2 : ox, ay = oy == null ? mapEl.clientHeight / 2 : oy;
        const cx = (mapEl.scrollLeft + ax) / z, cy = (mapEl.scrollTop + ay) / z;
        z = nz; stage.style.zoom = z; pcEl.textContent = Math.round(z * 100) + "%";
        localStorage.setItem("topic-zoom", z); hideKP();
        mapEl.scrollLeft = cx * z - ax; mapEl.scrollTop = cy * z - ay;
      };
      const fit = () => {
        const r = stage.getBoundingClientRect();
        setZoom(Math.min(1, (mapEl.clientWidth - 46) / (r.width / z), (mapEl.clientHeight - 46) / (r.height / z)));
      };
      mapEl.addEventListener("wheel", (e) => {
        if (!e.ctrlKey && !e.metaKey) return;                       // plain wheel keeps native scrolling (= pan)
        e.preventDefault();                                          // trackpad pinch arrives as ctrl+wheel
        const r = mapEl.getBoundingClientRect();
        setZoom(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      mapEl.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button")) return;    // dragging off a node card would eat its click
        const sx = e.clientX, sy = e.clientY, l = mapEl.scrollLeft, t = mapEl.scrollTop;
        mapEl.classList.add("grabbing");
        const mv = (m) => { mapEl.scrollLeft = l - (m.clientX - sx); mapEl.scrollTop = t - (m.clientY - sy); };
        const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); mapEl.classList.remove("grabbing"); };
        addEventListener("pointermove", mv); addEventListener("pointerup", up);   // on window: the drag survives leaving the map
      });
      const zc = el("div", "topic-zoom");
      const zb = (t, title, fn) => { const b = el("button", null, t); b.title = title; b.onclick = fn; return b; };
      zc.append(zb("−", "Zoom out", () => setZoom(z / 1.2)), pcEl, zb("+", "Zoom in", () => setZoom(z * 1.2)),
                zb("⤢", "Fit to screen", fit));
      pcEl.textContent = Math.round(z * 100) + "%";
      container.append(zc);

      const draw = () => {
        if (mapEl.offsetParent === null) return;
        const sr = stage.getBoundingClientRect(), W = sr.width / z, H = sr.height / z;   // unzoomed layout px
        svg.setAttribute("width", W); svg.setAttribute("height", H); svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        const ctr = (e) => { const r = e.getBoundingClientRect(); return { x: (r.left - sr.left) / z, y: (r.top - sr.top) / z, w: r.width / z, h: r.height / z }; };
        let s = "";
        for (const [from, to] of edges) {
          const a = cardEl[from], b = cardEl[to]; if (!a || !b) continue;
          const ca = ctr(a), cb = ctr(b);
          const x1 = ca.x + ca.w, y1 = ca.y + ca.h / 2, x2 = cb.x, y2 = cb.y + cb.h / 2, dx = Math.max(34, (x2 - x1) * 0.5);
          s += `<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" stroke="${ACCENT}" data-from="${from}" data-to="${to}"></path>`;
        }
        svg.innerHTML = s; svg.classList.add("ready");
      };
      requestAnimationFrame(() => requestAnimationFrame(() => { if (stored == null) fit(); draw(); }));  // first visit: shrink-to-fit once, then remember whatever you set
      let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (mapEl.isConnected) draw(); }, 120); });
    }

    // ---- module-level question bank: a slim strip above the map + a spaced-retrieval drill ----
    // The bank is every concept's diagnosticQuiz, aggregated by the server (/api/topic/<id>/quiz). It shares
    // the reader's per-question SRS (progress.__quizSrs, keyed cid#hash) — a question answered here won't
    // resurface in that concept's reader today, and vice-versa. No new progress store, no concept-mastery side effects.
    const qKey = (it) => it.cid + "#" + hashStr(it.q);
    const bankBox = (it) => { const s = (progress.__quizSrs || {})[qKey(it)]; return !s || !s.last ? "new" : (s.box || 1) >= 4 ? "mast" : "learn"; };
    function drillPool(dueOnly) {
      const qsrs = progress.__quizSrs || (progress.__quizSrs = {});
      const withId = bank.map((it) => ({ ...it, id: qKey(it) }));
      const dueFirst = R ? R.recommend(withId, (id) => qsrs[id], R.isoDay()) : withId;   // due, most-overdue first
      if (dueOnly) return dueFirst;
      const seen = new Set(dueFirst.map((x) => x.id));
      return dueFirst.concat(withId.filter((x) => !seen.has(x.id)));                     // full bank, due questions first
    }

    function bankStrip() {
      if (!bank.length) return null;
      const qsrs = progress.__quizSrs || (progress.__quizSrs = {});
      const today = R ? R.isoDay() : "";
      const due = R ? bank.filter((it) => R.isDue(qsrs[qKey(it)], today)).length : bank.length;
      const cnt = { mast: 0, learn: 0, new: 0 };
      bank.forEach((it) => cnt[bankBox(it)]++);
      const total = bank.length, pc = (n) => (100 * n / total).toFixed(2) + "%";
      const strip = el("div", "topic-bank");
      strip.innerHTML =
        `<div class="tb-lead"><div class="tb-eyebrow">Question bank</div>` +
        `<div class="tb-count">${total}<small>question${total > 1 ? "s" : ""} · spaced</small></div></div>` +
        `<div class="tb-meter"><div class="tb-bar">` +
        `<span class="s-mast" style="width:${pc(cnt.mast)}"></span>` +
        `<span class="s-learn" style="width:${pc(cnt.learn)}"></span>` +
        `<span class="s-new" style="width:${pc(cnt.new)}"></span></div>` +
        `<div class="tb-legend">` +
        `<div><i style="background:#34d399"></i><b>${cnt.mast}</b>&nbsp;mastered</div>` +
        `<div><i style="background:#a78bfa"></i><b>${cnt.learn}</b>&nbsp;learning</div>` +
        `<div><i style="background:#2a3444"></i><b>${cnt.new}</b>&nbsp;new</div></div></div>` +
        `<div class="tb-actions">${due ? `<span class="tb-due">${due} due</span>` : ""}` +
        `<button class="tb-start">▸ Start drill</button>` +
        `${due ? `<button class="tb-ghost">Review due →</button>` : ""}</div>`;
      strip.querySelector(".tb-start").onclick = () => renderDrill(drillPool(false), "Full bank");
      const rv = strip.querySelector(".tb-ghost");
      if (rv) rv.onclick = () => renderDrill(drillPool(true), "Due review");
      return strip;
    }

    // The drill: one question at a time (reader's quizCard grader, reveal + explanation), then a summary.
    // A view-swap like the reader — Back returns to the map. Grading updates the shared __quizSrs only.
    function renderDrill(pool, label) {
      container.replaceChildren();
      removeBarRefine();
      const reader = el("div", "topic-reader");
      let i = 0; const push = (n) => { n.style.setProperty("--i", i++); reader.append(n); };

      const back = el("button", "topic-back");
      back.append(el("span", "a", "←"), el("span", null, "Back to map"));
      back.onclick = renderGraph; push(back);

      const lede = el("div", "topic-lede");
      lede.append(
        el("div", "topic-eyebrow", `Question bank · ${label}`),
        el("h1", "topic-title", "Spaced-retrieval drill"),
        el("p", "topic-standfirst", pool.length
          ? `${pool.length} question${pool.length > 1 ? "s" : ""}, weakest and most-overdue first. Each answer schedules its next review.`
          : "Nothing due right now — the bank is caught up by spaced retrieval. Come back later, or run a full drill from the map."));
      push(lede);

      const host = el("div"); push(host);
      const qsrs = progress.__quizSrs || (progress.__quizSrs = {});
      const score = { correct: 0, total: 0 };
      let qi = 0;

      function showQ() {
        host.replaceChildren();
        if (qi >= pool.length) return showSummary();
        const it = pool[qi];
        const note = el("p", "topic-quiznote", `${it.term} · ${qi + 1} of ${pool.length}`);
        const nav = el("div", "topic-cta");
        const next = el("button", "topic-mark", qi < pool.length - 1 ? "Next →" : "Finish");
        next.style.visibility = "hidden";                    // appears only once this question is answered
        next.onclick = () => { qi++; showQ(); };
        nav.append(next);
        const card = quizCard(it, (ok) => {
          score.total++; if (ok) score.correct++;
          if (R) { qsrs[it.id] = R.applyGrade(qsrs[it.id], ok ? "good" : "bad"); saveProgress(); }
          next.style.visibility = "";
        });
        host.append(note, card, nav);
      }
      function showSummary() {
        const box = el("div", "topic-callout");
        box.append(el("p", "topic-prose", score.total
          ? `You reviewed ${score.total} question${score.total > 1 ? "s" : ""} — ${score.correct} correct (${Math.round(100 * score.correct / score.total)}%). Spacing updated.`
          : "No questions were reviewed."));
        const cta = el("div", "topic-cta");
        const b = el("button", "topic-mark", "Back to map"); b.onclick = renderGraph;
        cta.append(b);
        host.replaceChildren(box, cta);
      }
      showQ();
      container.append(reader);
      container.scrollTop = 0;
    }

    // ---- one concept: the guided reader ----
    async function openConcept(c) {
      let data;
      try { data = await jget(`/content/${TID}/concepts/${c.id}.json`); }
      catch (e) { alert("Could not load concept: " + e.message); return; }
      if (!isMastered(c.id) && !prog(c.id)) {
        progress[c.id] = { mastery: "Learning", score: 0, attempts: 0 };
        saveProgress();
      }
      renderConcept(c, data);
    }

    function quizCard(q, onAnswer) {
      const card = el("div", "ml-card ml-quiz");
      card.append(el("div", "ml-front", q.q));
      const opts = el("div", "quiz-opts"), foot = el("div", "quiz-foot");
      q.choices.forEach((ch, i) => {
        const b = el("button", "quiz-opt");
        b.append(el("span", "quiz-key", String.fromCharCode(65 + i)), el("span", "quiz-txt", ch));
        b.onclick = () => {
          if (opts.dataset.done) return;
          opts.dataset.done = "1";
          [...opts.children].forEach((btn, j) => btn.classList.add(j === q.answer ? "correct" : (j === i ? "wrong" : "dim")));
          const ok = i === q.answer;
          onAnswer(ok);                                          // caller scores + grades this question's SRS
          // reveal: a deep-dive panel expands beneath the question the instant you commit to an answer
          const rv = el("div", "quiz-reveal " + (ok ? "ok" : "no"));
          const inner = el("div", "quiz-reveal-inner");
          const panel = el("div", "quiz-reveal-panel");
          const head = el("div", "quiz-reveal-head");
          head.append(el("span", "quiz-reveal-badge", ok ? "✓ Correct" : "✗ Not quite"),
                      el("span", "quiz-reveal-ans", "Answer " + String.fromCharCode(65 + q.answer)));
          panel.append(head);
          if (q.explanation) panel.append(mdDiv("topic-prose quiz-reveal-body", q.explanation));
          inner.append(panel); rv.append(inner); foot.append(rv);
          requestAnimationFrame(() => rv.classList.add("open"));   // trigger the grid-rows expand
        };
        opts.append(b);
      });
      card.append(opts, foot);
      return card;
    }

    function iqCard(iq) {
      const d = el("details", "topic-qa");
      const sum = el("summary"); sum.append(el("span", null, iq.q));   // ::before chevron is CSS
      d.append(sum, mdDiv("topic-prose", iq.a));
      return d;
    }

    function renderConcept(c, d) {
      container.replaceChildren();
      const reader = el("div", "topic-reader");
      let i = 0;
      const push = (node) => { node.style.setProperty("--i", i++); reader.append(node); };
      const section = (label, ...kids) => { const s = el("section", "topic-section"); s.append(labelEl(label), ...kids); return s; };
      const labelEl = (t) => el("div", "topic-label", t);

      const back = el("button", "topic-back");
      back.append(el("span", "a", "←"), el("span", null, "Back to map"));
      back.onclick = renderGraph;
      push(back);

      // masthead (a div, NOT <header> — the app has a global header{display:flex} that would hijack it)
      const lede = el("div", "topic-lede");
      const cur = concept(c.id), mast = isMastered(c.id);
      const eyebrow = el("div", "topic-eyebrow");
      eyebrow.append(el("span", null, `${cur.difficulty || "Concept"} · ${cur.order || "?"} / ${curriculum.concepts.length}`));
      if (mast) eyebrow.append(el("span", "mast", "✓ Mastered"));
      lede.append(eyebrow, el("h1", "topic-title", d.title || c.title));
      if (d.definition) lede.append(el("p", "topic-standfirst", d.definition));
      push(lede);

      // ✦ Refine — chat with Claude to edit this page, review a diff, save back to the concept JSON.
      // Generic across every topic (no per-topic code); d is mutated in place on Accept → refresh re-renders it.
      // Direct child of .topic-reader (NOT nested in the masthead, whose entrance animation would capture the
      // position:fixed). Desktop: floats middle-right. Phones: a static inline chip right under the masthead —
      // clear of the prose, the notes tab, and the full-width git bar.
      if (window.CardChat && window.CardChat.openConceptRefine) {
        const refine = el("button", "topic-refine");
        refine.title = "Refine this page with Claude";
        refine.setAttribute("aria-label", "Refine this page with Claude");
        refine.innerHTML = '<span class="tr-ico">✦</span><span class="tr-txt">Refine</span>';
        refine.onclick = () => window.CardChat.openConceptRefine({
          topic: TID, concept: c, data: d, deckTitle: manifest.title, refresh: () => renderConcept(c, d),
        });
        const bar = barActions();
        if (onPhone() && bar) { removeBarRefine(); bar.appendChild(refine); }   // phones: into the shared bottom bar
        else reader.append(refine);                                             // desktop: fixed middle-right pill
      }

      // diagnostic quiz FIRST — but only the few that are DUE by spaced retrieval (shared review.js kernel),
      // weakest/most-overdue first. Answering grades the question so a solved one won't resurface today.
      // Per-question SRS lives in the topic's own progress (keyed by a content hash, stable across reorders).
      const QUIZ_BATCH = 4;
      const qsrs = progress.__quizSrs || (progress.__quizSrs = {});
      const allQ = (d.diagnosticQuiz || []).map((q) => ({ id: c.id + "#" + hashStr(q.q), q }));
      const dueQ = (R ? R.recommend(allQ, (id) => qsrs[id], R.isoDay()) : allQ).slice(0, QUIZ_BATCH);
      const score = { correct: 0, total: dueQ.length };
      if (dueQ.length) {
        const note = el("p", "topic-quiznote",
          `Spaced-retrieval check — your ${dueQ.length} most-due of ${allQ.length} question${allQ.length > 1 ? "s" : ""}. Answering schedules the next review.`);
        const wrap = el("div");
        dueQ.forEach(({ id, q }) => wrap.append(quizCard(q, (ok) => {
          if (ok) score.correct++;
          if (R) { qsrs[id] = R.applyGrade(qsrs[id], ok ? "good" : "bad"); saveProgress(); }   // not due again today
        })));
        push(section("Check yourself", note, wrap));
      } else if (allQ.length) {
        push(section("Check yourself",
          el("p", "topic-quiznote", "✓ Quiz caught up — nothing due right now by spaced retrieval. Read on, or come back later.")));
      }

      if (d.summary) push(section("Overview", mdDiv("topic-prose", d.summary)));
      if ((d.objectives || []).length) {
        const ul = el("ul", "topic-goals"); d.objectives.forEach((o) => ul.append(el("li", null, o)));
        push(section("Objectives", ul));
      }
      if (d.lesson) push(section("Lesson", mdDiv("topic-prose", d.lesson)));
      if (d.examples) push(section("Examples", mdDiv("topic-prose", d.examples)));
      if (d.tradeoffs) { const cb = el("div", "topic-callout"); cb.append(mdDiv("topic-prose", d.tradeoffs)); push(section("Tradeoffs", cb)); }

      if ((d.interviewQuestions || []).length) {
        const wrap = el("div"); d.interviewQuestions.forEach((iq) => wrap.append(iqCard(iq)));
        push(section("Interview questions", wrap));
      }

      const cta = el("div", "topic-cta");
      const done = el("button", "topic-mark" + (mast ? " mastered" : ""), mast ? "✓ Mastered — revisit" : "Mark as learned");
      done.onclick = () => {
        const prev = prog(c.id) || { attempts: 0 };
        const pct = score.total ? Math.round(100 * score.correct / score.total) : (prev.score || 100);
        progress[c.id] = { mastery: "Mastered", score: pct, attempts: (prev.attempts || 0) + 1 };
        saveProgress();
        // Record the learning event in the ONE central concept tracker: stamps last-learned (+ first-learned)
        // and advances the Leitner box, keyed by the global concept id so "bm25" is the same concept anywhere.
        if (window.Concepts) window.Concepts.grade(c.id, "good", { source: TID, score: pct });
        renderGraph();
      };
      cta.append(done); push(cta);

      container.append(reader);
      container.scrollTop = 0;
    }

    return async function init(host) {
      container = host; host.classList.add("topic-view"); injectStyle();
      host.replaceChildren(el("div", "topic-loading", "Loading lessons…"));
      try {
        const [cur, g, p, q] = await Promise.all([
          jget(`/content/${TID}/curriculum.json`),
          jget(`/content/${TID}/graph.json`),
          jget(`/api/topic/${TID}/progress?user=${USER}`),
          jget(`/api/topic/${TID}/quiz`).catch(() => []),   // module-level question bank; empty is fine
        ]);
        curriculum = cur; graph = g; progress = p && typeof p === "object" ? p : {};
        bank = Array.isArray(q) ? q : [];
        renderGraph();
        (window.__viewOpeners = window.__viewOpeners || {})[TID] = (id) => {   // dashboard deep-link → open this concept directly
          const c = (curriculum.concepts || []).find((x) => x.id === id); if (c) openConcept(c);
        };
      } catch (e) {
        host.replaceChildren(el("div", "topic-loading", "⚠ Could not load topic: " + e.message));
      }
    };
  }

  async function boot() {
    if (!window.registerDeckView) return;
    let topics;
    try { topics = await jget("/api/topics"); } catch (_) { return; }
    if (!Array.isArray(topics)) return;
    for (const m of topics) window.registerDeckView(m.id, m.title, createTopic(m));
  }
  const _tabs = document.getElementById("tabs");
  if (_tabs) _tabs.addEventListener("click", removeBarRefine);   // switching tabs → drop the bar ✦ (concept-only action)
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
