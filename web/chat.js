/* Per-card "Ask Claude" chat — talks to your LOCAL Claude Code session (no API key) via the
   server's /api/chat (streamed) and /api/card (write-back). Exposes window.CardChat:
     attach(cardEl, ctx)  — add an "Ask Claude" button to a study card. ctx = {deckKey, deckTitle, item, refresh}
   Free chat gives examples / hints / simpler explanations; "Improve card" proposes new field
   values you can apply, which the server saves straight back into content/<deck>.yaml. */
(function () {
  "use strict";

  // ---------- markdown rendering (marked if loaded, else a simple offline fallback) ----------
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let markedReady = false;
  function ensureMarked() {
    if (markedReady || !window.marked) return markedReady;
    try { window.marked.setOptions({ gfm: true, breaks: true }); markedReady = true; } catch (_) {}
    return markedReady;
  }
  // strip the obvious XSS vectors from rendered HTML (local tool, but cheap defense in depth)
  function sanitize(html) {
    const t = document.createElement("template");
    t.innerHTML = html;
    t.content.querySelectorAll("script,style,iframe,object,embed,link,meta,form").forEach(n => n.remove());
    t.content.querySelectorAll("*").forEach(n => {
      [...n.attributes].forEach(a => {
        const name = a.name.toLowerCase();
        if (name.startsWith("on") || (["href", "src"].includes(name) && /^\s*javascript:/i.test(a.value)))
          n.removeAttribute(a.name);
      });
    });
    return t.innerHTML;
  }
  function renderMd(text) {
    if (ensureMarked()) {
      try { return sanitize((window.marked.parse || window.marked)(text)); } catch (_) {}
    }
    return simpleMd(text);
  }
  function simpleMd(text) {                                  // used only if marked failed to load (offline)
    return text.split(/```/).map((b, i) => {
      if (i % 2) return `<pre>${esc(b.replace(/^[a-zA-Z]*\n/, ""))}</pre>`;
      return esc(b)
        .replace(/^#{1,6}\s+(.*)$/gm, "<b>$1</b>")
        .replace(/^\s*---\s*$/gm, "<hr>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/^\s*[-*]\s+(.*)$/gm, "• $1")
        .replace(/\n/g, "<br>");
    }).join("");
  }
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  // ---------- streaming reader for /api/chat ----------
  async function stream(body, onStatus, onDelta) {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      let msg = "chat failed (" + res.status + ")";
      try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx).replace(/^data: ?/, ""); buf = buf.slice(idx + 2);
        if (!raw) continue;
        let o; try { o = JSON.parse(raw); } catch (_) { continue; }
        if (o.error) throw new Error(o.error);
        if (o.status) onStatus && onStatus(o.status);
        else if (o.delta != null) { full += o.delta; onDelta && onDelta(full); }
        else if (o.done) return o.full != null ? o.full : full;
      }
    }
    return full;
  }

  // ---------- drawer ----------
  let drawer, msgsEl, inputEl, sendBtn, titleEl, subEl, previewEl;
  let ctx = null, messages = [], busy = false;

  function ensureDrawer() {
    if (drawer) return;
    drawer = el("aside", "cc-drawer");
    drawer.innerHTML = `
      <div class="cc-head">
        <div class="cc-htext"><div class="cc-eyebrow">✦ Ask Claude · <span class="cc-deck"></span></div><div class="cc-title"></div></div>
        <button class="cc-x" title="close (Esc)">✕</button>
      </div>
      <div class="cc-msgs"></div>
      <div class="cc-preview" hidden></div>
      <div class="cc-quick">
        <button data-q="Give me a concrete example.">＋ example</button>
        <button data-q="Give me a hint without the full answer.">💡 hint</button>
        <button data-q="Explain this more simply.">🪶 simpler</button>
        <button class="cc-improve" data-mode="improve">✨ Improve card</button>
      </div>
      <div class="cc-input">
        <textarea class="cc-ta" rows="1" placeholder="Ask anything about this card…" spellcheck="false"></textarea>
        <button class="cc-send" title="send (Enter)">➤</button>
      </div>`;
    document.body.appendChild(drawer);
    msgsEl = drawer.querySelector(".cc-msgs");
    previewEl = drawer.querySelector(".cc-preview");
    inputEl = drawer.querySelector(".cc-ta");
    sendBtn = drawer.querySelector(".cc-send");
    titleEl = drawer.querySelector(".cc-title");
    subEl = drawer.querySelector(".cc-deck");
    drawer.querySelector(".cc-x").onclick = close;
    sendBtn.onclick = () => send(inputEl.value);
    inputEl.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(inputEl.value); } });
    inputEl.addEventListener("input", () => { inputEl.style.height = "auto"; inputEl.style.height = Math.min(120, inputEl.scrollHeight) + "px"; });
    drawer.querySelectorAll(".cc-quick button").forEach(b => b.onclick = () => {
      if (b.dataset.mode === "improve") improve();
      else send(b.dataset.q);
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && drawer.classList.contains("open")) close(); });
  }

  function open(c) {
    ensureDrawer();
    ctx = c; messages = []; busy = false;
    previewEl.hidden = true; previewEl.innerHTML = "";
    const concept = c.kind === "concept";
    subEl.textContent = c.deckTitle || "";
    titleEl.textContent = concept ? (c.concept.title || "this page") : (c.item.front || c.item.title || "this card");
    drawer.querySelector(".cc-quick").hidden = concept;                       // concept mode: every message IS a refine
    inputEl.placeholder = concept ? "Tell Claude how to change this page…" : "Ask anything about this card…";
    msgsEl.replaceChildren(el("div", "cc-hint", concept
      ? "Refine this page with your local Claude Code session — no API key. Describe a change (e.g. “add a paragraph on " +
        "perplexity score”); Claude proposes a diff you can review, refine, then save back into the concept file."
      : "Chat uses your local Claude Code session — no API key. Ask for an example, a hint, or a clearer explanation. " +
        "Use <b>✨ Improve card</b> to rewrite it and save back to the YAML."));
    drawer.classList.add("open");
    setTimeout(() => inputEl.focus(), 60);
  }
  function close() { if (drawer) drawer.classList.remove("open"); }

  function bubble(role, html) {
    const b = el("div", "cc-msg cc-" + role, html);
    msgsEl.appendChild(b);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return b;
  }
  function setBusy(on) { busy = on; sendBtn.disabled = on; drawer.querySelectorAll(".cc-quick button").forEach(b => b.disabled = on); }

  async function converse(userText, mode) {
    if (busy || !ctx) return;
    const concept = ctx.kind === "concept";
    if (mode !== "improve") {
      bubble("user", esc(userText));
      messages.push({ role: "user", content: userText });
    }
    const out = bubble("assistant", '<span class="cc-dots"><i></i><i></i><i></i></span>');
    setBusy(true);
    try {
      const body = concept
        ? { kind: "concept", topic: ctx.topic, concept: ctx.concept.id, mode: "refine", messages }
        : { deck: ctx.deckKey, id: ctx.item.id, mode: mode || "chat", messages };
      const full = await stream(body,
        () => {},                                            // "thinking" — dots already shown
        partial => { out.innerHTML = renderMd(partial); msgsEl.scrollTop = msgsEl.scrollHeight; }
      );
      out.innerHTML = renderMd(full);
      if (concept) { messages.push({ role: "assistant", content: full }); onConceptRefineReply(full, out); }
      else if (mode === "improve") onImproveReply(full, out);
      else { messages.push({ role: "assistant", content: full }); addToCard(full, out); }
    } catch (e) {
      out.classList.add("cc-err");
      out.innerHTML = "⚠ " + esc(e.message || "chat failed") +
        '<br><span class="cc-errsub">Make sure you ran <code>make run</code> and are logged into Claude Code.</span>';
    } finally {
      setBusy(false); msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  }
  function send(text) {
    text = (text || "").trim(); if (!text) return;
    inputEl.value = ""; inputEl.style.height = "auto";
    converse(text, ctx && ctx.kind === "concept" ? "refine" : "chat");
  }
  function improve() {
    bubble("user", "✨ Improve this card");
    converse(null, "improve");
  }

  // ---------- append a reply (e.g. an example) to the card's deep field and save ----------
  function addToCard(text, bubbleEl) {
    const field = ctx.item.type === "kata" ? "reference" : "more";
    const btn = el("button", "cc-addbtn", "＋ Add to card · " + field);
    bubbleEl.appendChild(el("div", "cc-add")).appendChild(btn);
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = "saving…";
      const prev = (ctx.item[field] || "").replace(/\n+$/, "");
      const merged = prev ? prev + "\n\n" + text.trim() : text.trim();
      try {
        const res = await fetch("/api/card", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deck: ctx.deckKey, id: ctx.item.id, fields: { [field]: merged } }) });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || "save failed");
        ctx.item[field] = merged;                 // live-update the in-memory card
        if (ctx.refresh) ctx.refresh();
        btn.textContent = "✓ Added to " + field;
      } catch (e) {
        btn.disabled = false; btn.textContent = "＋ Add to card · " + field;
        btn.after(el("div", "cc-errsub", "⚠ " + esc(e.message)));
      }
    };
  }

  // ---------- improve → preview → apply ----------
  function onImproveReply(full, bubbleEl) {
    const m = full.match(/```json\s*([\s\S]*?)```/);
    let fields = null;
    if (m) { try { fields = JSON.parse(m[1].trim()); } catch (_) {} }
    if (!fields || typeof fields !== "object") {
      bubbleEl.innerHTML += '<div class="cc-errsub">Couldn’t read a structured suggestion — try “Improve card” again.</div>';
      return;
    }
    const allowed = ctx.item.type === "kata"
      ? ["title", "prompt", "reference"] : ["front", "back", "more"];
    const changes = {};
    for (const k of allowed) if (typeof fields[k] === "string" && fields[k].trim()) changes[k] = fields[k];
    if (!Object.keys(changes).length) return;

    previewEl.hidden = false;
    previewEl.innerHTML = `<div class="cc-pv-head">Proposed update — review, then save to <code>content/${deckFile()}</code></div>`;
    for (const k in changes) {
      const blk = el("div", "cc-pv-field");
      blk.appendChild(el("div", "cc-pv-label", esc(k)));
      blk.appendChild(el("pre", "cc-pv-val", esc(changes[k])));
      previewEl.appendChild(blk);
    }
    const row = el("div", "cc-pv-actions");
    const apply = el("button", "cc-apply", "✓ Apply &amp; save");
    const discard = el("button", "cc-discard", "Discard");
    row.append(apply, discard);
    previewEl.appendChild(row);
    previewEl.scrollIntoView({ block: "nearest" });
    discard.onclick = () => { previewEl.hidden = true; previewEl.innerHTML = ""; };
    apply.onclick = async () => {
      apply.disabled = discard.disabled = true; apply.textContent = "saving…";
      try {
        const res = await fetch("/api/card", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deck: ctx.deckKey, id: ctx.item.id, fields: changes }) });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || "save failed");
        for (const k in changes) ctx.item[k] = changes[k].replace(/\n+$/, "");   // live-update the in-memory card
        if (ctx.refresh) ctx.refresh();
        previewEl.innerHTML = `<div class="cc-saved">✓ Saved to content/${deckFile()} · the card now shows your update.</div>`;
        messages.push({ role: "assistant", content: full });
      } catch (e) {
        apply.disabled = discard.disabled = false; apply.textContent = "✓ Apply & save";
        previewEl.appendChild(el("div", "cc-errsub", "⚠ " + esc(e.message)));
      }
    };
  }
  function deckFile() {
    if (ctx && ctx.kind === "concept") return `${ctx.topic}/concepts/${ctx.concept.id}.json`;
    const k = (ctx && ctx.deckKey) || "";
    const module = k.split("-")[0] || "deck";       // ml-srs-v1 → ml
    const id = (ctx && ctx.item && ctx.item.id) || "…";
    return `${module}/${id}/data.yaml`;             // content/ml/m-roc-pr/data.yaml (display hint only)
  }

  // ---------- concept "Refine": @@SECTION reply → per-field line diff → save to /api/concept ----------
  // splitSections mirrors seed._split_sections (its grammar is server-tested); robust to ``` fences in a lesson.
  function splitSections(text) {
    const out = {}; let cur = null, buf = [];
    for (const line of String(text).split("\n")) {
      const m = line.match(/^\s*@@\s*([A-Za-z]+)\s*$/);
      if (m) { if (cur) out[cur] = buf.join("\n").trim(); const n = m[1].toUpperCase(); cur = n === "END" ? null : n; buf = []; }
      else if (cur) buf.push(line);
    }
    if (cur) out[cur] = buf.join("\n").trim();
    return out;
  }
  const SEC2FIELD = { DEFINITION: "definition", SUMMARY: "summary", OBJECTIVES: "objectives",
                      LESSON: "lesson", EXAMPLES: "examples", TRADEOFFS: "tradeoffs" };

  function refineFields(full) {                     // {field: string | list} of CHANGED prose only
    const secs = splitSections(full), fields = {};
    for (const name in secs) {
      const f = SEC2FIELD[name]; if (!f) continue;  // unknown / out-of-scope section (e.g. QUIZ) → dropped
      if (f === "objectives") {
        const items = secs[name].split("\n").map(l => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
        if (items.length) fields[f] = items;
      } else if (secs[name].trim()) {
        fields[f] = secs[name].trim();
      }
    }
    return fields;
  }

  // line-level LCS diff → a <pre> of +/-/context rows. No deps; a lesson is ~40 lines so O(n·m) is nothing.
  function diffLines(oldT, newT) {
    const a = String(oldT || "").split("\n"), b = String(newT || "").split("\n"), n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const pre = el("pre", "cc-diff"); let i = 0, j = 0;
    const row = (kind, sign, t) => { const d = el("div", "cc-dl cc-diff-" + kind); d.textContent = sign + t; pre.appendChild(d); };
    while (i < n && j < m) {
      if (a[i] === b[j]) { row("ctx", "  ", a[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { row("del", "- ", a[i++]); }
      else { row("add", "+ ", b[j++]); }
    }
    while (i < n) row("del", "- ", a[i++]);
    while (j < m) row("add", "+ ", b[j++]);
    return pre;
  }
  const fieldText = (field) => {                    // current on-disk value as text (the diff's "old" side)
    const v = ctx.data ? ctx.data[field] : "";
    return field === "objectives" ? (v || []).map(o => "- " + o).join("\n") : (v || "");
  };

  function onConceptRefineReply(full, bubbleEl) {
    const fields = refineFields(full);
    if (!Object.keys(fields).length) {
      bubbleEl.innerHTML += '<div class="cc-errsub">Couldn’t read a structured change — tell Claude what to change and try again.</div>';
      return;
    }
    const parts = String(full).split(/^\s*@@\s*END\s*$/m);   // keep only the trailing one-line summary in the bubble
    bubbleEl.innerHTML = renderMd((parts.length > 1 ? parts.pop().trim() : "") || "Proposed a change — review the diff below.");

    previewEl.hidden = false;
    previewEl.innerHTML = `<div class="cc-pv-head">Proposed change — review, then save to <code>content/${deckFile()}</code></div>`;
    for (const f in fields) {
      const shown = f === "objectives" ? fields[f].map(o => "- " + o).join("\n") : fields[f];
      const blk = el("div", "cc-pv-field");
      blk.appendChild(el("div", "cc-pv-label", esc(f)));
      blk.appendChild(diffLines(fieldText(f), shown));
      previewEl.appendChild(blk);
    }
    const actions = el("div", "cc-pv-actions");
    const apply = el("button", "cc-apply", "✓ Accept &amp; save");
    const discard = el("button", "cc-discard", "Discard");
    actions.append(apply, discard);
    previewEl.appendChild(actions);
    previewEl.scrollIntoView({ block: "nearest" });
    discard.onclick = () => { previewEl.hidden = true; previewEl.innerHTML = ""; };
    apply.onclick = async () => {
      apply.disabled = discard.disabled = true; apply.textContent = "saving…";
      try {
        const res = await fetch("/api/concept", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: ctx.topic, concept: ctx.concept.id, fields }) });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || "save failed");
        for (const f in fields) ctx.data[f] = fields[f];   // live-update the in-memory concept
        if (ctx.refresh) ctx.refresh();
        previewEl.innerHTML = `<div class="cc-saved">✓ Saved to content/${deckFile()} · the page now shows your update.</div>`;
      } catch (e) {
        apply.disabled = discard.disabled = false; apply.textContent = "✓ Accept & save";
        previewEl.appendChild(el("div", "cc-errsub", "⚠ " + esc(e.message)));
      }
    };
  }

  // ---------- public: attach an "Ask Claude" button to a card ----------
  function attach(cardEl, c) {
    if (cardEl.querySelector(".cc-bar")) return;
    const bar = el("div", "cc-bar");
    const btn = el("button", "cc-ask", "✦ Ask Claude");
    btn.onclick = () => open(c);
    bar.appendChild(btn);
    const meta = cardEl.querySelector(".ml-meta");
    if (meta && meta.nextSibling) cardEl.insertBefore(bar, meta.nextSibling);
    else cardEl.appendChild(bar);
  }
  // ---------- public: open the drawer to refine an interactive-lesson concept page ----------
  function openConceptRefine(p) {                          // p = {topic, concept:{id,title,…}, data, deckTitle, refresh}
    open({ kind: "concept", topic: p.topic, concept: p.concept, data: p.data, deckTitle: p.deckTitle, refresh: p.refresh });
  }
  window.CardChat = { attach, open, openConceptRefine, close, renderMd };   // renderMd reused by study.js to render card markdown

  // ---------- styles ----------
  const css = `
    .cc-bar{display:flex;justify-content:flex-end;margin:-6px 0 10px}
    .cc-ask{font-family:var(--mono);font-size:11px;letter-spacing:.03em;color:#cdd6e2;background:color-mix(in srgb,#a78bfa 14%,var(--surface));
      border:1px solid color-mix(in srgb,#a78bfa 42%,var(--line));border-radius:8px;padding:6px 12px;cursor:pointer;transition:.16s}
    .cc-ask:hover{color:#fff;border-color:#a78bfa;box-shadow:0 0 0 1px color-mix(in srgb,#a78bfa 35%,transparent)}
    .cc-drawer{position:fixed;top:0;right:0;height:100%;width:min(460px,100vw);z-index:60;display:flex;flex-direction:column;
      background:color-mix(in srgb,var(--bg2) 94%,transparent);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
      border-left:1px solid var(--line);box-shadow:-34px 0 70px -34px rgba(0,0,0,.85);
      transform:translateX(100%);transition:transform .32s cubic-bezier(.36,.66,.04,1)}
    .cc-drawer.open{transform:none}
    .cc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:20px 20px 14px;border-bottom:1px solid var(--line)}
    .cc-eyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#a78bfa}
    .cc-title{font-family:var(--display);font-weight:600;font-size:16px;line-height:1.25;margin-top:6px;color:var(--text)}
    .cc-x{flex:none;width:30px;height:30px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--muted);cursor:pointer;font-size:14px;transition:.16s}
    .cc-x:hover{color:var(--text);border-color:var(--faint)}
    .cc-msgs{flex:1;overflow:auto;padding:18px 20px;display:flex;flex-direction:column;gap:12px}
    .cc-hint{font-size:12.5px;line-height:1.55;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:12px 14px}
    .cc-hint b{color:#cdd6e2}
    .cc-msg{font-size:13.5px;line-height:1.6;border-radius:13px;padding:11px 14px;max-width:90%;word-wrap:break-word;overflow-wrap:anywhere}
    .cc-user{align-self:flex-end;background:color-mix(in srgb,#4aa3ff 18%,var(--surface));border:1px solid color-mix(in srgb,#4aa3ff 38%,var(--line));color:#eaf2ff}
    .cc-assistant{align-self:flex-start;background:var(--surface);border:1px solid var(--line);color:#cdd6e2}
    .cc-assistant.cc-err{border-color:color-mix(in srgb,var(--bad) 45%,var(--line));color:var(--bad)}
    .cc-msg code{font-family:var(--mono);font-size:12px;background:color-mix(in srgb,#fff 8%,transparent);padding:1px 5px;border-radius:5px}
    .cc-code{font-family:var(--mono);font-size:12px;line-height:1.5;background:#0b0f17;border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:8px 0;overflow:auto;white-space:pre-wrap}
    /* rendered markdown inside an assistant bubble */
    .cc-msg>:first-child{margin-top:0}.cc-msg>:last-child{margin-bottom:0}
    .cc-msg h1,.cc-msg h2,.cc-msg h3,.cc-msg h4{font-family:var(--display);font-weight:700;line-height:1.25;margin:15px 0 7px}
    .cc-msg h1{font-size:17px}.cc-msg h2{font-size:15.5px}.cc-msg h3{font-size:14px}.cc-msg h4{font-size:12.5px;color:var(--muted)}
    .cc-msg p{margin:8px 0}
    .cc-msg ul,.cc-msg ol{margin:7px 0;padding-left:20px}
    .cc-msg li{margin:3px 0}
    .cc-msg li>p{margin:2px 0}
    .cc-msg hr{border:0;border-top:1px solid var(--line);margin:13px 0}
    .cc-msg pre{font-family:var(--mono);font-size:12px;line-height:1.5;background:#0b0f17;border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:9px 0;overflow:auto;white-space:pre}
    .cc-msg pre code{background:none;padding:0;border-radius:0;font-size:12px}
    .cc-msg blockquote{border-left:3px solid var(--line);margin:8px 0;padding:1px 0 1px 12px;color:var(--muted)}
    .cc-msg table{border-collapse:collapse;margin:10px 0;font-size:12.5px;display:block;max-width:100%;overflow:auto}
    .cc-msg th,.cc-msg td{border:1px solid var(--line);padding:5px 9px;text-align:left;white-space:nowrap}
    .cc-msg th{background:var(--surface2);color:var(--text);font-family:var(--mono);font-size:11px;letter-spacing:.02em}
    .cc-msg strong,.cc-msg b{color:#eaf2ff;font-weight:700}
    .cc-msg a{color:#7cc4ff}
    .cc-errsub{display:block;margin-top:7px;font-size:11.5px;color:var(--muted)}
    .cc-add{margin-top:10px}
    .cc-addbtn{font-family:var(--mono);font-size:11px;color:#cdd6e2;background:color-mix(in srgb,var(--ok) 13%,var(--surface));border:1px solid color-mix(in srgb,var(--ok) 38%,var(--line));border-radius:8px;padding:6px 11px;cursor:pointer;transition:.14s}
    .cc-addbtn:hover:not(:disabled){filter:brightness(1.12)}
    .cc-addbtn:disabled{opacity:.6;cursor:default}
    .cc-dots i{display:inline-block;width:6px;height:6px;margin-right:4px;border-radius:50%;background:var(--faint);animation:ccb 1s infinite}
    .cc-dots i:nth-child(2){animation-delay:.18s}.cc-dots i:nth-child(3){animation-delay:.36s}
    @keyframes ccb{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
    .cc-preview{margin:0 20px 12px;border:1px solid color-mix(in srgb,var(--ok) 30%,var(--line));border-radius:13px;background:color-mix(in srgb,var(--ok) 7%,var(--surface));padding:14px;max-height:46vh;overflow:auto}
    .cc-pv-head{font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:10px}
    .cc-pv-head code,.cc-saved code{color:#cdd6e2}
    .cc-pv-field{margin-bottom:10px}
    .cc-pv-label{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:4px}
    .cc-pv-val{white-space:pre-wrap;font-size:12.5px;line-height:1.55;color:#cdd6e2;background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:9px 11px;margin:0;max-height:200px;overflow:auto}
    .cc-diff{font-family:var(--mono);font-size:12px;line-height:1.5;color:#cdd6e2;background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:8px 4px;margin:0;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word}
    .cc-dl{padding:0 7px;border-radius:3px}
    .cc-diff-add{background:color-mix(in srgb,var(--ok) 18%,transparent);color:#c7f2d8}
    .cc-diff-del{background:color-mix(in srgb,var(--bad) 15%,transparent);color:#f2c2c2}
    .cc-diff-ctx{color:var(--muted)}
    .cc-pv-actions{display:flex;gap:8px;margin-top:6px}
    .cc-apply{font-family:var(--mono);font-size:12px;font-weight:600;color:#08110b;background:var(--ok);border:1px solid var(--ok);border-radius:9px;padding:9px 16px;cursor:pointer}
    .cc-apply:hover{filter:brightness(1.08)}.cc-apply:disabled{opacity:.5;cursor:default}
    .cc-discard{font-family:var(--mono);font-size:12px;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:9px 14px;cursor:pointer}
    .cc-discard:hover{color:var(--text);border-color:var(--faint)}
    .cc-saved{font-family:var(--mono);font-size:12px;color:var(--ok)}
    .cc-quick{display:flex;flex-wrap:wrap;gap:7px;padding:10px 20px 0}
    .cc-quick button{font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 11px;cursor:pointer;transition:.14s}
    .cc-quick button:hover:not(:disabled){color:var(--text);border-color:var(--faint)}
    .cc-quick button:disabled{opacity:.45;cursor:default}
    .cc-improve{color:#cdd6e2 !important;background:color-mix(in srgb,#a78bfa 14%,var(--surface)) !important;border-color:color-mix(in srgb,#a78bfa 42%,var(--line)) !important}
    .cc-input{display:flex;gap:8px;padding:14px 20px 18px;border-top:1px solid var(--line)}
    .cc-ta{flex:1;resize:none;font-family:var(--body);font-size:13.5px;line-height:1.5;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:10px 13px;outline:none;transition:.16s}
    .cc-ta:focus{border-color:#a78bfa}
    .cc-send{flex:none;width:42px;border:1px solid #a78bfa;border-radius:11px;background:#a78bfa;color:#0b0f17;font-size:15px;cursor:pointer;transition:.16s}
    .cc-send:hover{filter:brightness(1.08)}.cc-send:disabled{opacity:.5;cursor:default}
    @media (max-width:560px){ .cc-drawer{width:100vw} }`;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));
})();
