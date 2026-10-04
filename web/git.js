/* Git Sync — a fixed, glassy control in the bottom-right that shows this repo's
   progress status and lets you commit your study progress + push, straight from
   the dashboard. Mirrors the legend's bottom-left presence.

   Scope: it only ever stages/commits state.json + content/ (your progress and study
   decks). Unrelated working changes are reported as an "N other" note and left alone.

   Talks to the server:
     GET  /api/git/status   snapshot (branch, in-scope changed files, ahead/behind, last commit)
     POST /api/git/commit   stage scope -> commit scope -> pull --rebase -> push   (localhost only)

   It only means anything where the .git lives (your local machine). On the rsync-
   deployed mirror there's no repo, so the server returns {repo:false} and the
   widget stays hidden. No-op on file:// since it needs the server. */
(function () {
  "use strict";
  if (location.protocol === "file:") return;            // needs server.py

  // ---------------------------------------------------------------- styles
  const css = `
    #gitsync{position:fixed;right:18px;bottom:16px;z-index:9;width:300px;max-width:calc(100vw - 36px);
      font-family:var(--mono);color:var(--text);
      background:color-mix(in srgb,var(--bg2) 82%,transparent);
      backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      border:1px solid color-mix(in srgb,var(--ga,var(--line)) 30%,var(--line));border-radius:13px;overflow:hidden;
      box-shadow:0 18px 50px -28px rgba(0,0,0,.85), 0 0 26px -20px var(--ga,transparent);
      transition:opacity .3s, transform .34s cubic-bezier(.2,.7,.2,1), border-color .25s, box-shadow .25s;}
    #gitsync[data-state="hidden"]{opacity:0;transform:translateY(16px) scale(.98);pointer-events:none}
    #gitsync[data-state="clean"]{opacity:.72}
    #gitsync[data-state="clean"]:hover{opacity:1}

    .gs-head{display:flex;align-items:stretch}
    .gs-bar{flex:1;min-width:0;display:flex;align-items:center;gap:9px;padding:11px 13px;
      background:none;border:0;cursor:pointer;text-align:left;font-family:var(--mono);color:inherit}
    /* mobile: notes.js (✎) and topic.js (✦) inject their buttons here, so every bottom-bar action shares ONE bar */
    .gs-actions{display:flex;align-items:center;gap:2px;padding:0 5px 0 3px}
    .gs-actions:empty{display:none}
    .gs-actions:not(:empty){border-left:1px solid var(--line)}
    .gs-actions>button{position:relative;flex:none;top:auto;left:auto;right:auto;bottom:auto;transform:none;
      width:40px;height:40px;padding:0;margin:0;border:0;border-radius:9px;background:transparent;box-shadow:none;
      display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;line-height:1;
      transition:background .15s,transform .1s}
    .gs-actions>button:hover{background:var(--surface2)}
    .gs-actions>button:active{transform:scale(.9)}
    .gs-dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--ga,var(--faint));
      box-shadow:0 0 9px -1px var(--ga,transparent)}
    #gitsync[data-state="dirty"] .gs-dot,
    #gitsync[data-state="ahead"] .gs-dot{animation:gspulse 1.7s cubic-bezier(.4,0,.6,1) infinite}
    @keyframes gspulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ga) 55%,transparent)}
      70%,100%{box-shadow:0 0 0 6px transparent}}
    .gs-label{flex:1;min-width:0;font-size:11.5px;letter-spacing:.01em;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .gs-branch{flex:none;font-size:10px;color:var(--muted);background:var(--surface);
      border:1px solid var(--line);border-radius:6px;padding:2px 7px;max-width:96px;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .gs-branch:empty{display:none}
    .gs-caret{flex:none;font-size:10px;color:var(--faint);transition:transform .24s}
    #gitsync.open .gs-caret{transform:rotate(180deg)}

    .gs-body{max-height:0;overflow:hidden;transition:max-height .3s ease}
    #gitsync.open .gs-body{max-height:64vh}
    .gs-inner{padding:3px 13px 13px;border-top:1px solid var(--line)}

    .gs-files{max-height:148px;overflow:auto;display:flex;flex-direction:column;gap:5px;margin:10px 0 2px}
    .gs-file{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted);line-height:1.3}
    .gs-tag{flex:none;width:16px;text-align:center;font-weight:600;font-size:9.5px;border-radius:4px;padding:2px 0}
    .gs-tag.t-M{color:var(--warn);background:color-mix(in srgb,var(--warn) 16%,transparent)}
    .gs-tag.t-A{color:var(--ok);background:color-mix(in srgb,var(--ok) 16%,transparent)}
    .gs-tag.t-D{color:var(--bad);background:color-mix(in srgb,var(--bad) 16%,transparent)}
    .gs-tag.t-R{color:#4aa3ff;background:color-mix(in srgb,#4aa3ff 16%,transparent)}
    .gs-tag.t-q{color:var(--faint);background:color-mix(in srgb,var(--faint) 24%,transparent)}
    .gs-fpath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    .gs-note{font-size:10.5px;color:var(--muted);margin:6px 0 0}
    .gs-last{font-size:10px;color:var(--faint);margin:7px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

    .gs-input{width:100%;margin-top:10px;font-family:var(--mono);font-size:11.5px;color:var(--text);
      background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 10px;outline:none;transition:.16s}
    .gs-input:focus{border-color:var(--ga,#4aa3ff)}
    .gs-input::placeholder{color:var(--faint)}

    .gs-push{width:100%;margin-top:10px;font-family:var(--mono);font-size:11.5px;font-weight:600;letter-spacing:.03em;
      color:#08110b;background:var(--ga,var(--ok));border:1px solid var(--ga,var(--ok));border-radius:9px;
      padding:9px 12px;cursor:pointer;transition:filter .16s,opacity .16s;display:flex;align-items:center;justify-content:center;gap:7px}
    .gs-push:hover:not(:disabled){filter:brightness(1.08)}
    .gs-push:disabled{opacity:.6;cursor:default}
    .gs-spin{display:inline-block;animation:gsspin .9s linear infinite}
    @keyframes gsspin{to{transform:rotate(360deg)}}

    .gs-msg{font-size:11px;line-height:1.5;margin-top:9px;display:none;word-wrap:break-word;overflow-wrap:anywhere}
    .gs-msg.show{display:block}
    .gs-msg.ok{color:var(--ok)}
    .gs-msg.err{color:var(--bad)}

    @media (max-width:560px){
      #gitsync{right:10px;left:10px;bottom:10px;width:auto;max-width:none}
      .gs-bar{padding:10px 11px}
      .gs-branch{display:none}                          /* free up the row for the action icons; branch shows on desktop */
      #gitsync.open .gs-body{max-height:50vh}          /* even expanded, leave the reading area breathing room */
      .gs-files{max-height:120px}
    }`;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));

  // ------------------------------------------------------------------ DOM
  const root = document.createElement("div");
  root.id = "gitsync";
  root.dataset.state = "hidden";
  root.innerHTML = `
    <div class="gs-head">
      <button class="gs-bar" type="button" title="git status">
        <span class="gs-dot"></span>
        <span class="gs-label">checking…</span>
        <span class="gs-branch"></span>
        <span class="gs-caret">▾</span>
      </button>
      <div class="gs-actions"></div>
    </div>
    <div class="gs-body"><div class="gs-inner">
      <div class="gs-files"></div>
      <div class="gs-note"></div>
      <div class="gs-last"></div>
      <input class="gs-input" type="text" maxlength="200" spellcheck="false"
             autocomplete="off" placeholder="commit message (optional)"/>
      <button class="gs-push" type="button">⬆ Commit &amp; push</button>
      <div class="gs-msg"></div>
    </div></div>`;
  document.body.appendChild(root);

  const $ = s => root.querySelector(s);
  const labelEl = $(".gs-label"), branchEl = $(".gs-branch"), filesEl = $(".gs-files"),
        noteEl = $(".gs-note"), lastEl = $(".gs-last"), inputEl = $(".gs-input"),
        pushBtn = $(".gs-push"), msgEl = $(".gs-msg");

  const ACCENT = { clean: "var(--ok)", dirty: "var(--warn)", ahead: "#4aa3ff",
                   working: "#4aa3ff", err: "var(--bad)" };
  const TAGCLS = { M: "t-M", A: "t-A", D: "t-D", R: "t-R", C: "t-A", U: "t-D", "?": "t-q" };

  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const setOpen = open => root.classList.toggle("open", !!open);
  const setAccent = s => root.style.setProperty("--ga", ACCENT[s] || "var(--ok)");
  const isMobile = () => matchMedia("(max-width:560px)").matches;   // phones: don't auto-expand the big panel

  let busy = false;          // a commit/push is in flight — don't let polling repaint over it
  let override = null;       // null = auto open/collapse; true/false = the user clicked the bar
  let lastStatus = null;

  // -------------------------------------------------------------- rendering
  function render(st) {
    lastStatus = st;
    if (!st || !st.repo) { root.dataset.state = "hidden"; setOpen(false); return; }

    const files = st.files || [];
    let state, text;
    if (files.length)      { state = "dirty"; text = files.length + " uncommitted change" + (files.length > 1 ? "s" : ""); }
    else if (st.ahead > 0) { state = "ahead"; text = st.ahead + " commit" + (st.ahead > 1 ? "s" : "") + " to push"; }
    else                   { state = "clean"; text = "In sync"; }

    root.dataset.state = state;
    setAccent(state);
    labelEl.textContent = text;
    branchEl.textContent = st.branch ? "⎇ " + st.branch : "";

    filesEl.innerHTML = files.map(f => {
      const tag = f.tag || "?";
      return `<div class="gs-file"><span class="gs-tag ${TAGCLS[tag] || "t-q"}">${esc(tag)}</span>` +
             `<span class="gs-fpath">${esc(f.path)}</span></div>`;
    }).join("");
    filesEl.style.display = files.length ? "" : "none";

    const notes = [];
    if (st.behind > 0) notes.push("↓ " + st.behind + " behind — push rebases onto remote first");
    else if (!st.has_upstream) notes.push("no upstream yet — push sets origin/" + (st.branch || ""));
    if (st.other > 0) notes.push("• " + st.other + " other change" + (st.other > 1 ? "s" : "") +
                                 " outside state/content — left untouched");
    noteEl.innerHTML = notes.map(n => `<div>${esc(n)}</div>`).join("");
    noteEl.style.display = notes.length ? "" : "none";

    lastEl.textContent = st.last ? `last · ${st.last.hash} · ${st.last.when}` : "";
    lastEl.style.display = st.last ? "" : "none";

    const canAct = files.length > 0 || st.ahead > 0 || st.behind > 0;
    pushBtn.style.display = canAct ? "" : "none";
    pushBtn.textContent = files.length ? "⬆ Commit & push" : "⬆ Push";
    inputEl.style.display = files.length ? "" : "none";

    // Auto-expand on desktop when there's something to do; on phones stay collapsed to the slim status
    // bar (tap to expand + commit) so the panel never swallows the screen. User's explicit toggle wins.
    setOpen(override === null ? (canAct && !isMobile()) : override);
  }

  function flash(kind, text) { msgEl.className = "gs-msg show " + kind; msgEl.textContent = text; }
  function clearMsg() { msgEl.className = "gs-msg"; msgEl.textContent = ""; }

  // ---------------------------------------------------------------- polling
  async function refresh() {
    try {
      const r = await fetch("/api/git/status", { cache: "no-store" });
      const st = await r.json();
      if (!busy) render(st);                 // never clobber the in-flight working state
    } catch (_) { /* server down / offline — keep last paint, retry next tick */ }
  }

  // ---------------------------------------------------------- commit + push
  async function commit() {
    if (busy) return;
    const hadFiles = !!(lastStatus && lastStatus.files && lastStatus.files.length);
    busy = true; override = true; setOpen(true); clearMsg();
    root.dataset.state = "working"; setAccent("working");
    pushBtn.disabled = true;
    pushBtn.innerHTML = `<span class="gs-spin">⟳</span>${hadFiles ? "Committing…" : "Pushing…"}`;
    try {
      const r = await fetch("/api/git/commit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: inputEl.value.trim() })
      });
      const res = await r.json();
      busy = false; pushBtn.disabled = false;
      if (res.ok) {
        inputEl.value = "";
        flash("ok", "✓ " + (res.committed ? "committed " + res.committed + " · " : "") + "pushed to remote");
        override = true;                                   // keep open so the ✓ is readable
        render(res.status || lastStatus);
        setTimeout(() => { override = null; clearMsg(); refresh(); }, 3400);
      } else {
        flash("err", "⚠ " + (res.error || "commit / push failed"));
        if (res.status) render(res.status); else await refresh();
        root.dataset.state = "err"; setAccent("err");     // hold the red until the next poll/refresh
        override = true; setOpen(true);
      }
    } catch (e) {
      busy = false; pushBtn.disabled = false;
      flash("err", "⚠ " + (e && e.message ? e.message : "request failed"));
      refresh();
    }
  }

  // --------------------------------------------------------------- wiring
  $(".gs-bar").onclick = () => { override = !root.classList.contains("open"); setOpen(override); };
  pushBtn.onclick = commit;
  inputEl.onclick = e => e.stopPropagation();
  inputEl.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); commit(); } };

  refresh();                                                       // initial paint
  setInterval(() => { if (!busy && !document.hidden) refresh(); }, 10000);  // catches progress writes
  addEventListener("focus", () => { if (!busy) refresh(); });
  document.addEventListener("visibilitychange", () => { if (!busy && !document.hidden) refresh(); });
})();
