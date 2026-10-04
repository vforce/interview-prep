// Interaction test for the roadmap panel's "Key insight" inline editor (wireInsight in roadmap.html).
// Extracts the REAL wireInsight source and drives it in jsdom with a stubbed fetch — no server, no
// whole-page boot (the inline script inits every tab at load; we only need this one function, whose
// closure deps are just `panel` + `fetch`). Run: node --test test_roadmap.mjs   (or `make test`).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync(new URL("../roadmap.html", import.meta.url), "utf8");

// Pull just `function wireInsight(p){ … }` out of the inline script.
const wireSrc = (() => {
  const s = HTML.indexOf("function wireInsight(p){");
  const e = HTML.indexOf("function closePanel(){", s);
  if (s < 0 || e < 0) throw new Error("wireInsight not found in roadmap.html");
  return HTML.slice(s, e);
})();
// Guard against openPanel's markup drifting from the ids/classes wireInsight queries.
for (const needle of ['id="edit-insight"', 'id="insight-view"', 'class="insight"'])
  assert.ok(HTML.includes(needle), `roadmap.html openPanel must still render ${needle}`);

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const $ = (d, sel) => d.querySelector(sel);

// A jsdom panel wired to a copy of wireInsight, with fetch/alert stubbed. `ok` picks the fetch outcome.
function setup(insight = "OLD insight", ok = true) {
  const dom = new JSDOM(
    `<!doctype html><body><aside id="panel">
       <div class="lbl">Key insight <button class="mini-edit" id="edit-insight">✎ edit</button></div>
       <div class="insight" id="insight-view">${insight}</div>
     </aside></body>`,
    { url: "http://localhost/", runScripts: "outside-only" });
  const { window } = dom, { document } = window;
  const calls = [];
  window.alert = (m) => calls.push({ alert: m });
  window.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok, json: async () => (ok ? { ok: true } : { error: "server said no" }) };
  };
  window.eval("const panel=document.getElementById('panel');\n" + wireSrc + "\nwindow.__wire=wireInsight;");
  const p = { id: "twoptr", insight };
  window.__wire(p);
  return { document, p, calls, posts: () => calls.filter((c) => c.url) };
}

test("✎ opens a textarea prefilled with the current insight", () => {
  const { document } = setup("converge from both ends");
  $(document, "#edit-insight").click();
  const ta = $(document, "textarea.insight-edit");
  assert.ok(ta, "textarea appears");
  assert.equal(ta.value, "converge from both ends");
  assert.equal($(document, "#insight-view"), null, "read view is swapped out while editing");
});

test("Save POSTs to /api/roadmap/insight and updates the view + in-memory topic", async () => {
  const { document, p, posts } = setup("OLD");
  $(document, "#edit-insight").click();
  $(document, "textarea.insight-edit").value = "NEW body";
  $(document, ".edit-actions .save").click();
  await flush();
  const post = posts()[0];
  assert.equal(post.url, "/api/roadmap/insight");
  assert.equal(post.opts.method, "POST");
  assert.deepEqual(JSON.parse(post.opts.body), { id: "twoptr", insight: "NEW body" });
  assert.equal(p.insight, "NEW body", "byId topic mutated in memory");
  assert.equal($(document, "#insight-view").textContent, "NEW body", "read view restored with new text");
  assert.equal($(document, "textarea.insight-edit"), null, "editor closed after save");
});

test("Save trims and sends the trimmed value", async () => {
  const { document, posts } = setup("x");
  $(document, "#edit-insight").click();
  $(document, "textarea.insight-edit").value = "  padded  ";
  $(document, ".edit-actions .save").click();
  await flush();
  assert.equal(JSON.parse(posts()[0].opts.body).insight, "padded");
});

test("Cancel restores the original insight without POSTing", () => {
  const { document, p, posts } = setup("stays the same");
  $(document, "#edit-insight").click();
  $(document, "textarea.insight-edit").value = "discard me";
  $(document, ".edit-actions .cancel").click();
  assert.equal($(document, "#insight-view").textContent, "stays the same");
  assert.equal(p.insight, "stays the same");
  assert.equal(posts().length, 0, "no network call on cancel");
});

test("empty insight does not POST", () => {
  const { document, posts } = setup("x");
  $(document, "#edit-insight").click();
  $(document, "textarea.insight-edit").value = "   ";
  $(document, ".edit-actions .save").click();
  assert.equal(posts().length, 0);
});

test("a failed Save alerts and keeps the edit open (no data loss)", async () => {
  const { document, p, calls } = setup("keep me", false);
  $(document, "#edit-insight").click();
  $(document, "textarea.insight-edit").value = "attempted";
  $(document, ".edit-actions .save").click();
  await flush();
  assert.ok(calls.some((c) => c.alert), "user is alerted on failure");
  assert.equal(p.insight, "keep me", "in-memory value not clobbered when the save fails");
  assert.ok($(document, "textarea.insight-edit"), "textarea stays so the user can retry");
});

// ---- favorite toggle (toggleFav in roadmap.html) ----
const favSrc = (() => {
  const s = HTML.indexOf("function toggleFav(btn, slug){");
  const e = HTML.indexOf("// Toggle a problem's LeetCode-premium flag", s);
  if (s < 0 || e < 0) throw new Error("toggleFav not found in roadmap.html");
  return HTML.slice(s, e);
})();
// Guard against the panel markup / STATE_KEYS drifting from what favorites need.
for (const needle of ['class="fav', 'querySelectorAll("button.fav")', '"recovery-favorites"'])
  assert.ok(HTML.includes(needle), `roadmap.html must still wire favorites (${needle})`);

function favSetup() {
  const dom = new JSDOM(`<!doctype html><body><button class="fav" data-slug="subarray-sum-equals-k">★</button></body>`, { runScripts: "outside-only" });
  const { window } = dom;
  window.eval("const fav={}; let saved=0; const saveFav=()=>{saved++};\n" + favSrc + "\nwindow.__fav={toggleFav, get:()=>fav, saved:()=>saved};");
  return { api: window.__fav, btn: window.document.querySelector(".fav") };
}

test("★ favorite toggles ON: marks fav, sets .on + aria + title, and persists", () => {
  const { api, btn } = favSetup();
  api.toggleFav(btn, "subarray-sum-equals-k");
  assert.equal(api.get()["subarray-sum-equals-k"], true);
  assert.ok(btn.classList.contains("on"));
  assert.equal(btn.getAttribute("aria-pressed"), "true");
  assert.match(btn.title, /Favorited/);
  assert.equal(api.saved(), 1, "saveFav (→ pushState) called once");
});

test("★ favorite toggles OFF: deletes the slug and clears the button state", () => {
  const { api, btn } = favSetup();
  api.toggleFav(btn, "subarray-sum-equals-k");   // on
  api.toggleFav(btn, "subarray-sum-equals-k");   // off
  assert.equal("subarray-sum-equals-k" in api.get(), false, "slug removed, not left as false");
  assert.equal(btn.classList.contains("on"), false);
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.equal(api.saved(), 2);
});

// ---- related-problem rows: ★ favorite + 🔒 premium lock (renderRelated / toggleRelLock in roadmap.html) ----
const relSrc = (() => {                                   // renderRelated + toggleRelLock + toggleSolved
  const s = HTML.indexOf("function renderRelated(p){");
  const e = HTML.indexOf("function grade(slug, g){", s);
  if (s < 0 || e < 0) throw new Error("renderRelated not found in roadmap.html");
  return HTML.slice(s, e);
})();

// A jsdom #related list rendered by the REAL renderRelated, with its closure deps stubbed.
function relSetup(items, prog = {}, fav = {}) {
  const dom = new JSDOM(`<!doctype html><body><aside id="panel"><div id="rel-head"></div><div id="related"></div></aside></body>`,
    { runScripts: "outside-only" });
  const { window } = dom;
  window.__seed = { items, prog, fav };
  window.eval(
    "const {items, prog, fav} = window.__seed;\n" +
    "const relatedCache = { twoptr: { items, expanded: true } };\n" +
    "let openId = 'twoptr', saves = 0;\n" +
    "const save = () => { saves++ }, saveFav = () => { saves++ }, isoDay = () => '2026-07-11';\n" +
    "const P = [], refreshCard = () => {}, renderStats = () => {}, expandRelated = () => {};\n" +
    favSrc + relSrc +
    "\nconst p = { id: 'twoptr' }; renderRelated(p);\n" +
    "window.__rel = { row: (i=0) => document.querySelectorAll('.rel')[i], prog, fav, saves: () => saves };");
  return window.__rel;
}

test("related rows carry ★ + 🔒, and 🔒 starts ON for a LeetCode-premium problem", () => {
  const api = relSetup([
    { slug: "free-one", title: "Free", difficulty: "Medium", paid: false },
    { slug: "paid-one", title: "Paid", difficulty: "Hard", paid: true },
  ]);
  const free = api.row(0), paid = api.row(1);
  assert.ok(free.querySelector("button.fav"), "★ renders on a related row");
  assert.ok(free.querySelector("button.lock"), "🔒 renders on a related row");
  assert.equal(free.querySelector(".lock").classList.contains("on"), false);
  assert.equal(free.querySelector("a").classList.contains("paid"), false);
  assert.equal(paid.querySelector(".lock").classList.contains("on"), true, "LeetCode's paidOnly shows as locked");
  assert.equal(paid.querySelector("a").classList.contains("paid"), true, "…and greys the link");
});

test("🔒 on a related row persists an override in prog[slug].p", () => {
  const api = relSetup([{ slug: "free-one", title: "Free", difficulty: "Easy", paid: false }]);
  api.row().querySelector(".lock").click();
  assert.equal(api.prog["free-one"].p, true, "locked → override saved");
  assert.equal(api.row().querySelector(".lock").classList.contains("on"), true);
  assert.equal(api.row().querySelector("a").classList.contains("paid"), true, "link greys out");
  api.row().querySelector(".lock").click();
  assert.equal(api.prog["free-one"].p, false, "unlocked → override flipped, not dropped");
  assert.equal(api.row().querySelector(".lock").classList.contains("on"), false);
  assert.ok(api.saves() >= 2, "each toggle persists");
});

test("🔒 override beats LeetCode's paidOnly flag", () => {
  const api = relSetup([{ slug: "paid-one", title: "Paid", difficulty: "Hard", paid: true }], { "paid-one": { p: false } });
  assert.equal(api.row().querySelector(".lock").classList.contains("on"), false, "your unlock survives a re-render");
  assert.equal(api.row().querySelector("a").classList.contains("paid"), false);
});

test("★ on a related row persists to favorites", () => {
  const api = relSetup([{ slug: "free-one", title: "Free", difficulty: "Easy", paid: false }]);
  api.row().querySelector(".fav").click();
  assert.equal(api.fav["free-one"], true);
  assert.equal(api.row().querySelector(".fav").classList.contains("on"), true);
});

// ---- panel close policy (PANEL_IDLE_MS / keepOpen / closePanel / the outside-click listener) ----
const closeSrc = (() => {
  const s = HTML.indexOf("const PANEL_IDLE_MS");
  const e = HTML.indexOf("/* ---------- related problems", s);
  if (s < 0 || e < 0) throw new Error("panel close policy not found in roadmap.html");
  return HTML.slice(s, e);
})();
assert.match(closeSrc, /PANEL_IDLE_MS = 15000/, "the idle auto-close must still be 15s");

// An open panel wired to the REAL close policy. setTimeout is captured, not run — no 15s wall-clock wait.
function panelSetup({ editing = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
      <aside id="panel" class="open"><button id="hit">★</button>${editing ? '<textarea class="insight-edit">draft</textarea>' : ""}</aside>
      <main id="outside">the node map</main></body>`, { runScripts: "outside-only" });
  const { window } = dom, { document } = window;
  const timers = [];
  window.setTimeout = (fn, ms) => timers.push({ fn, ms });          // push() returns the new length → use it as the id
  window.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  window.eval("let openId='twoptr'; const panel=document.getElementById('panel');\n" + closeSrc +
    "\nwindow.__panel={keepOpen, isOpen:()=>panel.classList.contains('open'), openId:()=>openId};");
  const api = window.__panel;
  api.keepOpen();                                                   // openPanel() ends by arming the idle clock
  const armed = () => timers.filter((t) => !t.cleared);
  return { document, window, api, armed, fire: () => armed().at(-1).fn() };
}

test("panel: a click whose handler re-renders its own target does NOT close the panel", () => {
  const { document, api } = panelSetup();
  const btn = document.getElementById("hit");
  btn.onclick = () => { document.getElementById("panel").innerHTML = "<div>re-rendered</div>"; };  // detaches e.target, like grade()/✓/★/🔒 do
  btn.click();
  assert.equal(api.isOpen(), true, "a detached target must not read as a click outside the panel");
  assert.equal(api.openId(), "twoptr");
});

test("panel: a click outside still dismisses it", () => {
  const { document, api } = panelSetup();
  document.getElementById("outside").click();
  assert.equal(api.isOpen(), false);
  assert.equal(api.openId(), null);
});

test("panel: auto-closes once the 15s idle timer fires", () => {
  const { api, armed, fire } = panelSetup();
  assert.equal(armed().length, 1, "opening arms exactly one idle timer");
  assert.equal(armed()[0].ms, 15000);
  fire();
  assert.equal(api.isOpen(), false);
  assert.equal(api.openId(), null);
});

test("panel: interacting inside restarts the 15s clock", () => {
  const { document, window, api, armed } = panelSetup();
  const first = armed()[0];
  document.getElementById("hit").dispatchEvent(new window.Event("pointermove", { bubbles: true }));
  assert.equal(first.cleared, true, "the pending close is cancelled");
  assert.equal(armed().length, 1, "…and replaced by a fresh one");
  assert.equal(armed()[0].ms, 15000);
  assert.equal(api.isOpen(), true);
});

test("panel: never auto-closes over an open insight editor (no lost draft)", () => {
  const { api, armed, fire } = panelSetup({ editing: true });
  fire();
  assert.equal(api.isOpen(), true, "an unsaved edit is not yanked away");
  assert.equal(armed().length, 1, "the clock re-arms instead");
});

// ---- the tab router: which views re-init on activation (deckViews / switchTab / registerDeckView) ----
// Slice stops before the popstate listener, so the trailing applyRoute() boot call isn't in scope — the test
// drives registration itself.
const routerSrc = (() => {
  const s = HTML.indexOf("const deckViews = {};");
  const e = HTML.indexOf('addEventListener("popstate", applyRoute);', s);
  if (s < 0 || e < 0) throw new Error("the tab router not found in roadmap.html");
  return HTML.slice(s, e);
})();

// The REAL router in a jsdom shell holding only the elements it touches. layoutEdges is the one closure dep.
function routerSetup(path = "/") {
  const dom = new JSDOM(`<!doctype html><body>
      <div id="tabs"><button data-tab="algorithms">Algorithms</button></div>
      <div id="map"></div><div id="algo-hud"></div><div id="legend"></div>
      <div class="wrap"></div></body>`, { url: "http://localhost" + path, runScripts: "outside-only" });
  dom.window.eval("const layoutEdges = () => {};\n" + routerSrc + "\nwindow.__router = { switchTab, registerDeckView };");
  return dom.window.__router;
}

test("router: a view inits once — but Home re-inits every time you come back to it", () => {
  const r = routerSetup("/");
  const inits = [];
  r.registerDeckView("home", "Home", () => inits.push("home"));
  assert.deepEqual(inits, ["home"], "landing on / inits the dashboard");

  r.registerDeckView("rag", "RAG", () => inits.push("rag"));     // its applyRoute() re-applies the tab we're already on
  assert.deepEqual(inits, ["home"], "…which must not re-init it once per tab that registers");

  r.switchTab("rag");
  assert.deepEqual(inits, ["home", "rag"]);
  r.switchTab("home");                                           // ← come back after mastering a concept in the topic
  assert.deepEqual(inits, ["home", "rag", "home"], "Home re-aggregates on return, or it shows a stale snapshot");
  r.switchTab("rag");
  assert.deepEqual(inits, ["home", "rag", "home"], "…while a view that owns its own state stays inited");
});

// ---------------------------------------------------------------------------
// famFresh — the "practiced Nd ago" badge on the topic nodes and the legend.
// ---------------------------------------------------------------------------

const freshSrc = (() => {
  const s = HTML.indexOf("const FAM_SLUGS = {};");
  const e = HTML.indexOf("const STATE_KEYS =", s);
  if (s < 0 || e < 0) throw new Error("famFresh not found in roadmap.html");
  return HTML.slice(s, e);
})();
// Guard against the two call sites drifting back to reading the stored map directly.
for (const call of ["famFresh(p.fam)", "famFresh(k)"])
  assert.ok(HTML.includes(call), `roadmap.html must derive node/legend freshness via ${call}`);

// The REAL famFresh over a small two-family roadmap. `topicFresh` = the stored LeetCode-sync
// map (recovery-topics); `prog` = your own per-problem grades (recovery-progress-v2).
function freshSetup(topicFresh = {}, prog = {}) {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  dom.window.__seed = { topicFresh, prog };
  dom.window.eval(
    "const { topicFresh, prog } = window.__seed;\n" +
    "const P = [{ id:'dplinear', fam:'dp',     probs:[{slug:'climbing-stairs'},{slug:'house-robber'}] },\n" +
    "           { id:'dpgrid',   fam:'dp',     probs:[{slug:'unique-paths'}] },\n" +
    "           { id:'twoptr',   fam:'arrays', probs:[{slug:'3sum'}] }];\n" +
    freshSrc + "\nwindow.__famFresh = famFresh;");
  return dom.window.__famFresh;
}

test("famFresh: solving a problem freshens its family even when the sync couldn't tag it", () => {
  // The bug this guards: House Robber solved 2026-08-13, but recovery-topics.dp still read
  // 2026-07-15, so every DP node kept showing "29d". lc-tags.json had no entry for the slug, so
  // the sync handed famOf() empty tags, it resolved "other", and the family was never touched.
  const famFresh = freshSetup({ dp: "2026-07-15" }, { "house-robber": { s: "green", t: "2026-08-13" } });
  assert.equal(famFresh("dp"), "2026-08-13", "your own solve beats the stale synced date");
});

test("famFresh: the stored sync map still counts — it carries solves outside the roadmap", () => {
  const famFresh = freshSetup({ dp: "2026-08-13" }, { "house-robber": { t: "2026-07-15" } });
  assert.equal(famFresh("dp"), "2026-08-13", "an off-roadmap LeetCode solve keeps the family warm");
});

test("famFresh: newest across every node of the family; never practiced reads null", () => {
  const famFresh = freshSetup({}, { "climbing-stairs": { t: "2026-07-01" }, "unique-paths": { t: "2026-08-10" } });
  assert.equal(famFresh("dp"), "2026-08-10", "a family spans more than one node");
  assert.equal(famFresh("arrays"), null, "no solve, no sync date → no badge");
  assert.equal(famFresh("graphs"), null, "unknown family → no badge, no throw");
});

test("famFresh: an entry with no date (a premium lock, say) is not a practice date", () => {
  const famFresh = freshSetup({}, { "house-robber": { p: true }, "3sum": { s: "green" } });
  assert.equal(famFresh("dp"), null);
  assert.equal(famFresh("arrays"), null);
});
