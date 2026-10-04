# interview_prep

Self-hosted **interview-study dashboard** — a single-page app (`roadmap.html` + vanilla JS) served
by a mostly-stdlib Python server (`server.py`; deps: **PyYAML** for content + **numpy/pandas/torch**
for the ML coding katas). No build step, no framework. **Setup and running: see `README.md`** —
`uv sync`, then `make run` → http://127.0.0.1:8081/.

## What it does — the tabs

- **Algorithms** — a LeetCode study roadmap: problems grouped into families/stages as a node map,
  with a daily warm-up, a random pick, and a per-topic side panel. Progress is self-tracked and
  auto-synced from LeetCode (enter a handle → `⟲ Sync`).
- **Solved** — every LeetCode solve, auto-categorized by its topic tags.
- **ML** / **LLM** — spaced-repetition *study decks*: flashcards + coding katas + multiple-choice
  quizzes (see "Study decks"). **The ML deck is coding-katas-only** — its theory moved to the
  `ml-tree` lesson topic; LLM still carries both flashcards and katas.
- **Retrieval-Augmented Generation** — an interactive lesson topic (a separate system authored by
  `seed.py`; see "Authoring content").
- A global **Notes** sidebar (amber tab, left edge) on every tab — a free-text scratchpad, one note
  per tab, saved with your progress.

## Key files

**Layout:** frontend JS lives in `web/` (served at `/web/…`); tests + `conftest.py` in `tests/`.
`server.py`, `roadmap.html`, and the data (`content/`, `state.json`, `progress/`, `lc-tags.json`) stay
at the repo root — the server serves statics from the CWD and reads its data relative to its own dir,
so both must resolve to root.

- `server.py` — the whole backend: serves the static files + a small JSON API (`/api/decks`,
  `/api/quiz`, `/api/card`, `/api/concept`, `/api/quiz/delete`, `/api/run`, `/api/state`, `/api/chat`,
  …). Reads the content tree; runs the local `claude` CLI for the in-app chat. Pure stdlib + PyYAML.
- `roadmap.html` — the shell: the Algorithms tab, tab switching, the localStorage↔`state.json` sync
  (`STATE_KEYS`), and the in-app Git Sync panel. Study-deck tabs are added at runtime by `study.js`.
- `review.js` — `window.Review`: the spaced-repetition kernel (Leitner boxes, due-ness, `recommend`
  = least-recent / most-overdue first, `applyGrade`). Pure, node-requirable, shared by the decks.
- `study.js` — the ML/LLM decks: the browse rail, Study/Test modes, flashcards, katas, and the
  quiz-first retrieval flow.
- `chat.js` — the per-card "✦ Ask Claude" drawer (improve a card via the local `claude` CLI).
  `git.js` — the in-app Git Sync panel. `notes.js` — the per-tab notes sidebar.
- `topic.js` / `concepts.js` — the interactive-lesson (RAG) reader.
- `dashboard.js` — the **Home** tab (the `/` landing): aggregates progress across every silo and
  recommends what to do next. Pure `computeDashboard()` core + DOM render; reuses `review.js`, the
  algorithms pickers, and the `::quiz-srs` stores. No server changes.
- `quizgen.py` — offline generator for the quiz banks. `seed.py` — offline generator for lessons.

**Runtime/data-model reference:** `specs/architecture.md` — the state keys and shapes, the shared
recommendation primitives, the client router/view system, and the non-obvious gotchas. Read it before
touching progress state, the tab router, or anything that recommends "what to do next".

## Content model — a per-concept tree

Study content lives as one directory per concept:

    content/<module>/deck.yaml                # deck config: key, tab, title, eyebrow, order, areas
    content/<module>/<concept-id>/data.yaml   # one card
    content/<module>/<concept-id>/quiz.yaml   # that card's MCQs

- `<module>` is the short deck id (`ml`, `llm`); `deck.yaml.key` is the full SRS key (`ml-srs-v1`).
- Each `data.yaml` has a unique **`id`** (= its folder name) plus `type` (`concept` | `kata`),
  `area`, `order`, and the body — concept: `front` / `back` / `more`; kata: `title` / `prompt` /
  `sig` / `stub` / `reference` / `test`. **`id` is stable — it keys spaced-repetition progress;
  don't rename it.**
- Each `quiz.yaml` is a list of `{id, q, choices[4], answer}`; every question id is unique
  (`<concept-id>-qN`).
- `server.load_decks()` assembles a deck from `deck.yaml` + every `<concept>/data.yaml` (sorted by
  `order`, split into concepts/katas by `type`); `load_quiz()` aggregates the `quiz.yaml`s (and
  injects each concept's label as the question's `term`). The in-app editor writes back to `data.yaml`.
- `content/rag/` and `content/llm-tree/` are a *different* system — interactive-lesson **topics**
  (prerequisite-gated curriculum trees) authored by `seed.py` (`topic.yaml` → generated `graph` /
  `curriculum` / `concepts` / `manifest`), rendered by `topic.js`. Don't confuse a topic with a deck.
  Authoring/maintaining one: see the runbook in `specs/interactive_lesson.md`.

## Study decks — spaced repetition + quiz-first retrieval

ML/LLM cards are scheduled by `review.js` (correct → longer interval, gap → back to daily). Clicking
a concept/kata runs **quiz-first retrieval**: its 3 least-recently-reviewed questions (timed), then
the card reveals with the answer already open (a kata reveals its code editor). Each answer's
correctness + latency is stored per-question in the deck's `…::quiz-srs` state. A **1-hour per-card
cooldown** skips the quiz if you already did it within the hour. "Test" mode drills the whole bank.

## Authoring content

- **Quizzes:** `python3 quizgen.py <module> [concept]` generates MCQs into `quiz.yaml` via the local
  `claude` CLI (no API key). `quizgen.py ml` does the whole deck (skips covered cards);
  `quizgen.py ml ROC-AUC` scopes to one concept (its id or a keyword); `--force` / `--add`
  regenerate or extend. Commit the resulting `quiz.yaml`s.
- **Curriculum trees (topics — `rag`, `llm-tree`):** `make seed TOPIC=<id>` builds a
  prerequisite-gated learning tree from `content/<id>/topic.yaml`. Hand-author
  `content/<id>/graph.json` first to pin the exact prerequisite edges (seed reuses it rather than
  letting the LLM guess). Incremental/resumable; a new topic needs **zero app code**. Full runbook
  (slug ids, preview, `--only`/`--force`, gotchas): `specs/interactive_lesson.md`.
- **Edit a card:** in the app, `✎ edit` or "✦ Ask Claude → Improve card" writes back to its
  `data.yaml`.
- **Refine a lesson page:** on any interactive-lesson concept page, **✦ Refine** opens a chat drawer —
  tell Claude how to change the page, review a red/green diff, refine over a few turns, then Accept to
  write the change straight into `content/<topic>/concepts/<id>.json`, ready to commit. Prose fields
  only (`definition` / `summary` / `objectives` / `lesson` / `examples` / `tradeoffs`); quiz/interview
  are out of scope. **It bumps the concept's `version` but preserves `metadata.inputHash`, so the edit
  survives a later `make seed TOPIC=<id>`** (only `--force`, `--only <id>`, or an input change —
  name/prereqs/constraints/prompt — regenerates over it). The model replies in seed's `@@SECTION`
  grammar, not a ```json block, so fenced code inside a `lesson` can't break parsing. `POST /api/concept`
  writes the file (open to any client, like all content writes); the generate step (`/api/chat`,
  `kind:"concept"`) runs the local `claude` CLI and stays **localhost-only** (a separate, stricter
  gate) — so *editing* prose works from any device, but *generating* it must run on the host itself.
- All authoring runs the local `claude` CLI on your machine; commit the results — they ship like any
  other content.

## Shipping changes

The server serves straight from the working tree: content, `*.js`, and `roadmap.html` are picked up
on the next request; after editing `server.py` or the dependencies, restart it (Ctrl-C, then
`make run`). To version and back up your work, `git commit` (and push to your own remote if you want
an off-box copy).

## State and security

The server reads/writes its own `state.json` and `progress/<user>/<topic>.json` directly — those files
are the single source of truth for progress. (`STATE_BACKEND=http://<host>:<port>` is an optional knob
that proxies a throwaway instance's state to a *different* instance; normal use leaves it unset.)

Content writes go through one chokepoint, `Handler._remote_allowed()`, which **returns `True`
unconditionally** — card/insight/concept edits, `quiz.yaml` deletes, the kata code-runner
(`/api/run`), and git push (`/api/git/commit`) are all accepted from any client that can reach the
port. `/api/run` executes arbitrary Python (`-I` isolation and a 6s timeout — not a sandbox), so
`make run` binds **127.0.0.1** by default; `make run BIND=0.0.0.0` exposes it to your LAN — **only on
a network you trust**. Re-lock by putting an IP check back in that one method. (The LLM chat/generate
endpoints, `/api/chat`, keep a separate, stricter `_localhost_only()` gate — spawning the `claude` CLI
stays host-only.)

Progress is just the localStorage keys listed in `STATE_KEYS` (`roadmap.html`) mirrored into
`state.json`: per-problem status, the SRS boxes (`ml-srs-v1` and its `::quiz-srs`, …), and the
notes. **`state.json` is committed like any other file** (in-app Git Sync, or a plain `git commit`) so
your progress is versioned and backed up. The LeetCode handle is the exception — it lives only in the
browser (`localStorage["lc-handle"]`). `progress/.gitkeep` must stay: Git Sync stages `progress/`, and
`git add` fails on a pathspec that matches nothing. (The test suite doesn't touch `state.json`.)

## Tests

`make test` runs the whole suite (all under `tests/`): **pytest** (`test_server.py`, `test_quizgen.py`,
`test_seed.py`), the node self-checks (`test_review.js`, `test_concepts.js`), and **jsdom** UI tests
(`test_study.mjs`, `test_roadmap.mjs`, `test_dashboard.mjs`). pytest is a `uv` dev-dependency (with
`pythonpath=["."]` in pyproject so `tests/` can import the root modules); the jsdom tests need a one-time
`npm install` (dev-only — the app itself ships no npm deps, and `node_modules` is gitignored).

## Commands

    uv sync                      # one-time: create .venv with the Python deps
    make run                     # http://127.0.0.1:8081/   (PORT=9000 / BIND=0.0.0.0 to change)
    make test                    # full test suite (needs a one-time `npm install`)
    make seed TOPIC=rag          # (re)generate an interactive lesson topic
    python3 quizgen.py ml [id]   # generate/extend a deck's quiz banks (id or keyword; --force/--add)
