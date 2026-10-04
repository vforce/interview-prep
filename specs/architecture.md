# Runtime architecture & data model

*Complements `CLAUDE.md` (which covers the tabs, content model, and authoring). This is the
**runtime / data layer**: where progress lives, its exact shapes, the recommendation primitives, and
the client wiring — the load-bearing, non-obvious things that aren't clear from a first read. References
are by file/function name (durable) rather than line number. As-built 2026-07-06 (routing + Home
dashboard work); accurate to that point, verify before relying on a specific field.*

## Progress lives in localStorage, mirrored to `state.json`

All user progress is a set of `localStorage` keys enumerated in **`STATE_KEYS`** (`roadmap.html`),
debounce-mirrored (~400 ms) to the server as **one JSON blob** via `window.__pushState()` →
`POST /api/state` → `state.json`. On load, a *synchronous blocking* `GET /api/state` at the top of
`roadmap.html` hydrates localStorage before any app code runs: `recovery-progress-v2` is merged
**per-slug (server wins)** so a different origin can't wipe marks; every other key is overwritten
wholesale. `state.json` is a single-line blob (so `git diff state.json` shows the whole object) and is
committed like any file.

| Key | Shape | Meaning |
|---|---|---|
| `recovery-progress-v2` | `{slug:{s,a,t,lc}}` | Algorithms per-problem. `s` = `green`(solved) / `yellow`(shaky) / `red`(gap) or **absent = never graded**; `a` attempts; `t` last-done isoDay; `lc` = mark came from LeetCode sync (expired after 30d) |
| `ml-srs-v1`, `llm-srs-v1` | `{cardId:{box,reps,last,grade}}` | Deck flashcard/kata SRS (Leitner). `grade`∈`bad`/`shaky`/`good`. **`box>=5` ≈ mastered.** `cardId` = the concept/kata `id` |
| `<deckKey>::quiz-srs` | `{qid:{box,reps,last,grade,ms?,t?}}` | Per-question quiz SRS. **`grade:"bad"` = answered wrong.** `qid` = `<cardId>-q<N>` (strip `/-q\d+$/` → cardId). `ms`(latency)/`t`(epoch) only on the timed retrieval path |
| `<deckKey>::top`, `::rand` | `{date,ids}` | Frozen daily "Today's 3" / "Random 3" picks — **regenerable cache** |
| `recovery-daily`, `recovery-random` | `{date,easy,med}` / `{date,picks}` | Algorithms daily warm-up / random picks — **regenerable cache** |
| `recovery-topics` | `{family:isoDay}` | Per-family last-practiced date (freshness badges) |
| `concepts-v1` | `{conceptKey:{box,reps,last,grade,first,source,score}}` | Global, cross-topic idea-level SRS (`window.Concepts`) |
| `recovery-notes` | per-tab text | The amber Notes sidebar |

**Interactive-lesson topic progress is separate** — one file per user+topic,
`progress/<user>/<topic>.json` = `{conceptId:{mastery,score,attempts}, __quizSrs:{"<cid>#<hash>":{box,reps,last,grade}}}`.
`mastery`∈ absent / `"Learning"` / `"Mastered"` (there is no `"due"` state — due-ness is computed).
Read/written via `GET/POST /api/topic/<id>/progress?user=me`. **Note the `__quizSrs` key format is
`cid#hash`, not the decks' `cid-qN`.** Two SRS trackers coexist: the per-topic `__quizSrs` drives the
topic map; global `concepts-v1` drives cross-topic "due for review"; they're bridged only when a concept
is marked learned (`topic.js` → `Concepts.grade`).

## Recommendation primitives — reuse these, don't rebuild

- **`review.js`** (`window.Review`; pure, node-requirable): the Leitner kernel. `BOX_DAYS={1:1,2:3,3:7,4:21,5:60}`;
  `dueDate` / `overdueDays` (`Infinity` if never reviewed) / `isDue`; `applyGrade(state,kind)` (bad→box1,
  good→+1 capped 5, shaky→unchanged); **`recommend(items, id=>srs[id], today)`** → the due items, most-overdue
  then weakest-grade first; `reason(s)` → `"overdue 3d · 🔴 was a gap"`. Never-reviewed = due now, sorts first.
- **Algorithms pickers** (`roadmap.html`): `computeDaily()` (stalest Easy + a Medium that builds on a recently-done
  Easy) and `computeRandom()` (Fisher–Yates over unsolved E/M). Both **exclude `q.premium`**. Cached in
  `recovery-daily`/`recovery-random`; exposed for reuse as **`window.__algoNext(reroll) → {daily,random}`**.
- **Deck picks** (`study.js`): `computeTop3()` = `recommend(seen)` + never-reviewed, sliced to 3; `buildSession()`
  = due reviews + `NEW_PER_DAY` fresh.
- **Topic gating** (`topic.js`): `unlocked(id) = graph[id].requires.every(isMastered)`; the "next" concept is the
  first unlocked-and-unmastered by curriculum order. No LLM at runtime — the prereq graph is the hand-authored
  `content/<id>/graph.json`.
- **`window.Concepts.stats()`** → `{total,due,boxes}` — a ready cross-topic rollup.
- **`dashboard.js`** `computeDashboard(data)` aggregates all of the above into the Home view; pure + node-tested
  (`test_dashboard.mjs`).

## Client architecture — one page, swappable views, path routing

Single page (`roadmap.html`); no framework, no build.

- **View registration**: `window.registerDeckView(key, label, init)` creates a hidden `<section id="view-<key>">`
  + a tab button, and **lazily calls `init(section)` on first activation**. Callers register on `DOMContentLoaded`
  (the inline script defines `registerDeckView` later in the document): `study.js` → decks (key = the **SRS key**,
  e.g. `ml-srs-v1`), `topic.js` → topics (key = clean id, e.g. `rag`), `dashboard.js` → `home` (prepended so it's
  leftmost).
- **Routing** (path-based): `switchTab(name, push)` toggles views and pushes `/<slug>`; `slugOf(key)` strips the
  `-srs-vN` suffix so deck `ml-srs-v1` → `/ml` (topics are already clean). `tabForSlug` maps path→tab: bare `/` →
  `home`, `/algorithms` is special (hardcoded tab, not in `deckViews`), decks matched by stripped slug. `applyRoute()`
  runs on load, on `popstate`, and inside `registerDeckView` (so async-registered tabs still deep-link). Server
  SPA-fallback (`server.py` `do_GET`): `/` and extensionless non-file paths serve `roadmap.html`. **GET-only —
  a HEAD to a tab path 404s (no HEAD client in the app).**
- **Global vs inline**: global = `window.ROADMAP` (`{families,topics,edges}` from `/api/roadmap.js`), the localStorage
  keys, and the exposed hooks (`__pushState`, `switchTab`, `__algoNext`). **NOT global**: the algorithms inline locals
  (`prog`, `P`, `computeDaily`, `isDoneToday`) — a new view reads `window.ROADMAP` + localStorage instead.
- **Script load order** (`roadmap.html`, all served from `/web/`): `review.js` → `concepts.js` → `study.js`
  → `chat.js` → `git.js` → `topic.js` → `notes.js` → `dashboard.js` → `/api/roadmap.js`, then the inline app script.

## Server endpoints a client view can read

`GET /api/decks` → `[{key,tab,title,areas,concepts[],katas[]}]`; `GET /api/quiz` →
`{deckKey:[{id,q,choices,answer,term}]}` (`term` = the concept label); `GET /api/topics` → manifests
`[{id,title,conceptCount,…}]`; `GET/POST /api/topic/<id>/progress?user=me`; `GET/POST /api/state`;
`GET /api/roadmap.js` → `window.ROADMAP`; `GET /api/solved` / `/api/progress` / `/api/related` → LeetCode.
Content statics: `content/<id>/{curriculum,graph,manifest}.json`. Content/state writes go through
`Handler._remote_allowed()` (returns `True` — open to any client); only the LLM chat/generate endpoints
(`/api/chat`) keep a stricter localhost-only gate.

## Gotchas (things that bit me building the above)

- **A deck's tab key is its SRS key, not its module id** — the ML tab registers as `ml-srs-v1`, not `ml`. The URL
  slug drops `-srs-vN` to get `/ml`. Don't assume a `ml` key exists.
- **The ML deck is katas-only now** (theory moved to the `ml-tree` topic). Orphaned `ml-srs-v1::quiz-srs` entries
  exist for concepts no longer in the deck — filter wrong-answer joins to `items.some(i => i.id === cid)`.
- **Premium lock rides on content, not state**: `q.premium` on the `ROADMAP` problem object (persisted to
  `content/algos/<id>/data.yaml` via `POST /api/roadmap/premium`), never in localStorage. The daily/random pickers
  did not exclude it until the dashboard work.
- **The server serves the working tree**: content / `*.js` / `roadmap.html` go live on the next request;
  `server.py`/dependency changes require a server restart (Ctrl-C, then `make run`).
- **Regenerable vs real progress**: `recovery-daily/random` and `<deck>::top/::rand` are date-stamped caches — merely
  opening a tab rewrites them. Real progress is `recovery-progress-v2`, the `*-srs-v1*` stores, `concepts-v1`, and the
  `progress/**` topic files. Keep that in mind before committing `state.json` churn from a test run.
