/* Reusable notes module — a per-tab free-text scratchpad in a left slide-in sidebar.
   Global: works on every tab (Algorithms, Solved, RAG, ML, LLM) by tracking the .active
   button in #tabs. Storage rides the app's existing pipeline: ONE localStorage key
   `recovery-notes` shaped { tabId: {text, updated} } that pushState() bundles into
   state.json — so notes are committed to git exactly like study progress. No new endpoint. */
(function () {
  "use strict";
  var KEY = "recovery-notes";
  var all = (function () { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) { return {}; } })();
  // ponytail: whole-object last-write-wins across devices (the boot pull replaces this key
  // wholesale, like every non-progress key). Fine for a single user; add a per-tab merge
  // branch in roadmap.html's boot XHR if two devices ever edit different tabs' notes live.
  var cur = "algorithms", curLabel = "Algorithms";
  var ta, panel, handle, dot, ctxEl, statusEl, timeEl, countEl, debounce;

  function persist() {
    localStorage.setItem(KEY, JSON.stringify(all));
    if (window.__pushState) window.__pushState();     // → /api/state → state.json → git sync
  }
  function commit() {
    var t = ta.value;
    if (t.trim()) { all[cur] = { text: t, updated: Date.now() }; }
    else { delete all[cur]; }                          // don't store empty notes — keeps state.json tidy
    persist();
    setStatus("saved");
    refreshMeta();
  }
  function setStatus(s) { statusEl.dataset.s = s; statusEl.textContent = s === "saving" ? "saving…" : "saved"; }
  function ago(ts) {
    if (!ts) return "";
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return "just now";
    if (s < 90) return "1 min ago";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 5400) return "1 hr ago";
    if (s < 86400) return Math.round(s / 3600) + " hr ago";
    return Math.round(s / 86400) + " d ago";
  }
  function refreshMeta() {
    var n = all[cur] && all[cur].text ? all[cur].text.trim() : "";
    var words = n ? n.split(/\s+/).length : 0;
    countEl.textContent = words + (words === 1 ? " word" : " words");
    timeEl.textContent = all[cur] && all[cur].updated ? "edited " + ago(all[cur].updated) : "";
    dot.hidden = !n;
  }
  function activeTab() {
    var b = document.querySelector("#tabs button.active");
    return b ? { id: b.dataset.tab || b.textContent.trim(), label: b.textContent.trim() } : { id: "algorithms", label: "Algorithms" };
  }
  function loadTab() {
    ta.value = (all[cur] && all[cur].text) || "";
    ctxEl.textContent = curLabel;
    setStatus("saved");
    refreshMeta();
  }
  function syncTab() {
    var t = activeTab();
    if (t.id === cur) { curLabel = t.label; ctxEl.textContent = curLabel; return; }
    if (debounce) { clearTimeout(debounce); debounce = null; commit(); }   // flush pending edit before switching context
    cur = t.id; curLabel = t.label;
    loadTab();
    ctxEl.classList.remove("flash"); void ctxEl.offsetWidth; ctxEl.classList.add("flash");   // flash so the tab-scoped swap is noticed
  }
  function open() { panel.classList.add("open"); handle.classList.add("hide"); setTimeout(function () { ta.focus(); }, 260); }
  function close() { panel.classList.remove("open"); handle.classList.remove("hide"); }
  function toggle() { panel.classList.contains("open") ? close() : open(); }

  function build() {
    handle = document.createElement("button");
    handle.className = "notes-tab"; handle.type = "button"; handle.setAttribute("aria-label", "Open notes");
    handle.innerHTML = '<span class="notes-tab-dot" hidden></span><span class="nt-ico">✎</span><span class="nt-txt">Notes</span>';
    dot = handle.querySelector(".notes-tab-dot");
    handle.onclick = toggle;

    panel = document.createElement("aside");
    panel.className = "notes-panel"; panel.setAttribute("aria-label", "Notes");
    panel.innerHTML =
      '<div class="notes-head">' +
        '<div class="notes-title"><span class="notes-glyph">✎</span>Notes<span class="notes-ctx"></span></div>' +
        '<button class="notes-x" type="button" aria-label="Close notes">✕</button>' +
      '</div>' +
      '<textarea class="notes-ta" spellcheck="true" ' +
        'placeholder="Jot anything — snippets, gotchas, patterns to revisit…\n\nThis note is scoped to the current tab, and saved to git with your progress."></textarea>' +
      '<div class="notes-foot">' +
        '<span class="notes-status" data-s="saved">saved</span>' +
        '<span class="notes-time"></span>' +
        '<span class="notes-count"></span>' +
      '</div>';
    ta = panel.querySelector(".notes-ta");
    ctxEl = panel.querySelector(".notes-ctx");
    statusEl = panel.querySelector(".notes-status");
    timeEl = panel.querySelector(".notes-time");
    countEl = panel.querySelector(".notes-count");
    panel.querySelector(".notes-x").onclick = close;

    ta.addEventListener("input", function () {
      setStatus("saving"); dot.hidden = !ta.value.trim();
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function () { debounce = null; commit(); }, 450);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panel.classList.contains("open")) close();
    });

    document.body.appendChild(panel);
    var bar = document.querySelector("#gitsync .gs-actions");   // git.js loads first, so the bar exists
    if (matchMedia("(max-width:560px)").matches && bar) bar.appendChild(handle);  // mobile: notes joins the bottom bar
    else document.body.appendChild(handle);                                       // desktop: fixed left-edge tab
    var t = activeTab(); cur = t.id; curLabel = t.label;
    loadTab();
    var tabsEl = document.getElementById("tabs");
    if (tabsEl) new MutationObserver(syncTab).observe(tabsEl, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
    setInterval(function () { if (panel.classList.contains("open")) refreshMeta(); }, 60000);   // keep "edited …" fresh while open
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();

  var css = `
    :root{ --note:#f5b544 }
    .notes-tab{
      position:fixed; left:0; top:50%; transform:translateY(-50%); z-index:39;
      writing-mode:vertical-rl; text-orientation:mixed;
      display:flex; align-items:center; gap:8px;
      font-family:var(--mono); font-size:11px; font-weight:600; letter-spacing:.2em; text-transform:uppercase;
      color:#160f04; background:var(--note); border:0; border-radius:0 12px 12px 0;
      padding:16px 7px; cursor:pointer; box-shadow:0 12px 30px -12px rgba(245,181,68,.55);
      transition:padding .18s, transform .18s, box-shadow .18s;
    }
    .notes-tab:hover{ padding-left:11px; box-shadow:0 14px 36px -12px rgba(245,181,68,.72) }
    .notes-tab.hide{ transform:translateY(-50%) translateX(-130%) }
    .notes-tab-dot{ width:7px; height:7px; border-radius:50%; background:#160f04 }

    .notes-panel{
      position:fixed; top:0; left:0; height:100%; width:min(384px,100vw); z-index:40;
      display:flex; flex-direction:column;
      background:color-mix(in srgb, var(--bg2) 92%, transparent);
      backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
      border-right:1px solid var(--line); box-shadow:30px 0 60px -30px rgba(0,0,0,.85);
      transform:translateX(-100%); transition:transform .34s cubic-bezier(.36,.66,.04,1);
    }
    .notes-panel.open{ transform:none }
    .notes-panel::before{ content:""; position:absolute; top:0; left:0; bottom:0; width:3px;
      background:linear-gradient(180deg, var(--note), color-mix(in srgb, var(--note) 35%, transparent)) }

    .notes-head{ display:flex; align-items:center; justify-content:space-between; gap:12px;
      padding:22px 20px 15px; border-bottom:1px solid var(--line) }
    .notes-title{ display:flex; align-items:center; gap:10px; min-width:0;
      font-family:var(--display); font-weight:700; font-size:20px; letter-spacing:-.015em; color:var(--text) }
    .notes-glyph{ color:var(--note); text-shadow:0 0 18px color-mix(in srgb, var(--note) 65%, transparent) }
    .notes-ctx{ font-family:var(--mono); font-size:9.5px; letter-spacing:.14em; text-transform:uppercase;
      color:var(--note); background:color-mix(in srgb, var(--note) 13%, transparent);
      border:1px solid color-mix(in srgb, var(--note) 32%, var(--line)); border-radius:999px;
      padding:3px 9px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:150px }
    .notes-ctx.flash{ animation:notes-flash .65s ease }
    @keyframes notes-flash{ from{ background:color-mix(in srgb, var(--note) 55%, transparent); color:#160f04 } }
    .notes-x{ flex:none; width:30px; height:30px; border-radius:8px; border:1px solid var(--line);
      background:var(--surface); color:var(--muted); cursor:pointer; font-size:14px; line-height:1; transition:.16s }
    .notes-x:hover{ color:var(--text); border-color:var(--faint) }

    .notes-ta{
      flex:1; width:100%; resize:none; outline:none; border:0;
      font-family:var(--mono); font-size:13.5px; line-height:1.85; color:#e7edf5;
      padding:20px 22px 20px 46px; background-color:transparent; caret-color:var(--note);
      background-image:linear-gradient(90deg, transparent 37px,
        color-mix(in srgb, var(--note) 30%, transparent) 37px,
        color-mix(in srgb, var(--note) 30%, transparent) 38px, transparent 38px);
    }
    .notes-ta::placeholder{ color:var(--faint); line-height:1.7 }
    .notes-ta::-webkit-scrollbar{ width:10px }
    .notes-ta::-webkit-scrollbar-thumb{ background:color-mix(in srgb, var(--line) 85%, var(--faint)); border-radius:6px; border:3px solid transparent; background-clip:padding-box }

    .notes-foot{ display:flex; align-items:center; gap:10px; padding:12px 20px; border-top:1px solid var(--line);
      font-family:var(--mono); font-size:10.5px; color:var(--faint) }
    .notes-status{ display:flex; align-items:center; gap:6px; color:var(--muted) }
    .notes-status::before{ content:""; width:6px; height:6px; border-radius:50%; background:var(--ok); transition:.2s }
    .notes-status[data-s="saving"]{ color:var(--note) }
    .notes-status[data-s="saving"]::before{ background:var(--note); box-shadow:0 0 8px -1px var(--note) }
    .notes-time{ padding-left:10px; border-left:1px solid var(--line) }
    .notes-count{ margin-left:auto }

    /* mobile: the notes button lives in the shared bottom bar (git.js .gs-actions) — git styles size/position;
       here we just make it the amber ✎ icon (label hidden, dot as a corner badge). Desktop keeps the left tab. */
    .gs-actions .notes-tab{ writing-mode:horizontal-tb; color:var(--note) }
    .gs-actions .nt-txt{ display:none }
    .gs-actions .nt-ico{ font-size:18px; line-height:1 }
    .gs-actions .notes-tab-dot{ position:absolute; top:5px; right:6px; background:var(--note) }
    @media (max-width:560px){ .notes-panel{ width:100% } }`;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));
})();
