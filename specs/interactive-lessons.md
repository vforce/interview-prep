# Interactive Lessons (the "interactive guide")

A per-topic, self-paced learning mode inside the dashboard: each topic is a **dependency tree of
concepts**, and each concept is a **diagnostic-first lesson** — you test yourself, every answer
reveals a deep-dive, then you read to fill the gaps. It sits alongside the existing Algorithms map
and the ML/LLM flashcard decks as its own tab (piloted on **RAG**).

## The core principle

**AI generates the content once (offline); the runtime only serves it and tracks progress.** The
running server never calls an LLM for a learner — generation is an author-time build step, exactly
like the quiz bank. This keeps the runtime deterministic, fast, and free.

Full design rationale: [`specs/interactive_lesson.md`](../specs/interactive_lesson.md).

## File map

| Path | Role |
|---|---|
| `content/<topic>/topic.yaml` | the ONE human-authored file per topic (id, title, concept list, constraints) |
| `content/<topic>/manifest.json` | `{id, title, version, status, generatedAt, conceptCount, curriculumVersion}` |
| `content/<topic>/graph.json` | dependency graph `{ conceptId: {requires:[ids]} }` (validated acyclic) |
| `content/<topic>/curriculum.json` | topo-ordered list `{concepts:[{id, title, order, difficulty}]}` |
| `content/<topic>/concepts/<id>.json` | one self-contained lesson (schema below) |
| `seed.py` | the offline generator (author phase) |
| `server.py` | runtime: `/api/topics`, per-user progress, static content |
| `topic.js` | the learner UI (tree + reader), registered as a tab |
| `concepts.js` | central concept-progress tracker (see "Progress" below) |
| `test_seed.py`, `test_concepts.js` | self-checks (run via `make test`) |

Everything under `content/<topic>/` is committed and deployed like the YAML decks; nothing there is
generated at runtime.

## Flows

### Author flow — offline, once per content change

```
topic.yaml ──seed.py──▶ graph.json ──▶ curriculum.json ──▶ concepts/<id>.json ──▶ manifest.json
(you write)  claude CLI  prereq DAG      topo order +        definition, lesson,     status:
                         (acyclic)       difficulty          quiz+explanations, …    published
                                                                    │
                    git commit content/<topic>/**  ──▶  served live (no restart)
```

Re-runs are incremental (per-concept `inputHash`). Quiz-only tweaks touch just `diagnosticQuiz`:
`--quiz` replaces it; `--add N [--about "<sub-topic>"]` appends more, deduped.

### Learner flow — a study session, at runtime (NO LLM is ever called)

```
open the topic tab
  │  GET /api/topics                          → the tab exists
  ▼
the MAP ── GET curriculum.json + graph.json + /api/topic/<id>/progress
  │        draws the dependency tree; a concept unlocks once every prerequisite is Mastered
  ▼  click an unlocked concept
the READER ── GET /content/<topic>/concepts/<id>.json   (a static file)
  ├─ Check Yourself  → review.js picks your ~4 most-due questions (spaced retrieval)
  │     └─ answer → verdict + deep-dive reveal → R.applyGrade → save progress
  ├─ read  Lesson · Examples · Tradeoffs · Interview questions
  └─ Mark as learned → progress {mastery:"Mastered"} + Concepts.grade(id,"good")
                     → its dependents unlock on the map
```

### Spaced-retrieval quiz loop — per question, via the shared `review.js`

```
on open :  R.recommend(all questions, srsOf, today)  → due / weakest-first  → take top 4
on answer: correct → R.applyGrade("good") → box ↑  (due again in 3 / 7 / 21 / 60 days)
           wrong   → R.applyGrade("bad")  → box 1  (due again tomorrow)
```

A solved question is scheduled out, so it won't resurface until it's due again. Per-question state
lives in the topic progress under `__quizSrs`, keyed by a content hash of the question text.

### Data & sync flow

```
content/<topic>/**            static, committed, served read-only  (curriculum / graph / concepts)
progress/<user>/<topic>.json  {conceptId:{mastery,score,attempts}} + __quizSrs   (per topic)
state.json › concepts-v1      global per-concept last-learned / SRS  (concepts.js, on review.js)
```

The server owns progress + state directly — one source of truth (`STATE_BACKEND` can proxy them to
another instance); the in-app Git Sync backs them up to origin. The runtime serves published JSON
and never calls an LLM.

## Author phase — `seed.py`

Generation uses the **local `claude` CLI** (no API key) via `server.run_claude`. Prose is generated
in a delimiter format (`@@LESSON` … `@@QUIZ` …), never JSON, so a long markdown lesson can't break
parsing. Quiz choice positions are shuffled (the model biases the correct answer to "A").

```
make seed TOPIC=rag                       # full pipeline (or: uv run seed.py rag)
uv run seed.py rag --force                # regenerate every artifact
uv run seed.py rag --only chunking        # target one concept (with --force/--quiz/--add)
uv run seed.py rag --quiz                 # regenerate ONLY the quizzes (lessons untouched)
uv run seed.py rag --only bm25 --add 5     # APPEND 5 more questions (keeps existing, deduped)
uv run seed.py rag --only bm25 --add 5 --about "the indexing process"   # focus the added questions
```

Pipeline stages (full seed): load+validate `topic.yaml` → dependency graph (acyclic) → curriculum
(topological order + depth→difficulty) → one concept file per concept (one `claude` call each) →
link related/followUps from graph neighbors → validate references → write `manifest.json` + publish.

**Incremental & resumable:** each concept stores `metadata.inputHash`; a re-run regenerates only
concepts whose inputs changed, and `graph.json`/`curriculum.json` are reused. Running the full seed
twice is a no-op. `--quiz` and `--add` are surgical: they touch only the `diagnosticQuiz` field and
bump the concept + manifest version, leaving lessons alone.

### Concept file schema

```
id, title, version
definition            one precise sentence
summary               2–3 sentence overview
objectives            [string]
lesson                the teaching lesson (GitHub-flavored markdown)
examples              worked examples (markdown)
tradeoffs             when-to-use vs avoid (markdown)
diagnosticQuiz        [ {q, choices[4], answer (0–3), explanation} ]   ← explanation = per-question deep-dive
interviewQuestions    [ {q, a} ]
relatedConcepts       [conceptId]   (graph neighbors)
followUps             [conceptId]   (dependents)
metadata              {inputHash, model, generatedAt, quizUpdatedAt?}
```

## Runtime — `server.py`

The runtime adds only what static files can't do; the curriculum/graph/concept JSON are served as
plain static files under `content/<topic>/`.

- `GET /api/topics` → list of **published** manifests (mtime-cached, `load_topics()`).
- `GET/POST /api/topic/<id>/progress?user=<user>` → read/write `progress/<user>/<topic>.json`.
  Proxied to another instance when `STATE_BACKEND` is set, same as `state.json` (one source of
  truth). Backed up by the in-app Git Sync (`progress/` is in `PROGRESS_PATHS`).
- Static: `GET /content/<topic>/{curriculum,graph}.json`, `…/concepts/<id>.json`.

**No `claude` process is ever spawned serving a learner.**

## Learner experience — `topic.js`

Each published topic registers its own tab (`window.registerDeckView`). Two views, scoped under
`.topic-view` (the ML/LLM decks are untouched), themed with the app's own fonts (Bricolage / Hanken
/ IBM Plex) and a violet accent:

- **Map** — the dependency graph drawn as a left-to-right tree (root = topic → foundations →
  advanced), reusing the Algorithms map's node/column/SVG-edge machinery. Concepts are
  **prerequisite-gated**: a concept unlocks once every `requires` is Mastered; locked nodes show
  which prereqs to master first.
- **Reader** — a centered editorial lesson, **diagnostic-first**: title → **Check Yourself** quiz →
  Overview → Objectives → Lesson → Examples → Tradeoffs → Interview questions → **Mark as learned**.
  - **Spaced-retrieval selection:** the quiz shows only your ~4 most-due questions (chosen via the
    shared `review.js` kernel), not the whole bank; answering schedules each question's next review
    so a solved one doesn't resurface immediately. Per-question SRS lives in the topic's progress
    under `__quizSrs`, keyed by a content hash of the question.
  - **Per-question deep-dive reveal:** answering expands a verdict-tinted panel (green = correct,
    coral = wrong) beneath the question with `explanation` — teaching you the instant you commit.
  - **Mark as learned** records `{mastery, score, attempts}` in the topic's progress and calls
    `Concepts.grade(id, "good")` (see below).

## Progress & spaced repetition

Two stores, by design:

1. **Topic progress** — `progress/<user>/<topic>.json`, `{conceptId: {mastery, score, attempts}}`.
   Drives the map's unlock gating and "✓ mastered" badges. Keyed per topic.
2. **Central concept tracker** — `concepts.js` (`window.Concepts`), the ONE place that records how
   well you know a concept, keyed by a **global concept key** so `"recall"` is the same concept
   whether it appears in ML, LLM, or RAG. Spaced-repetition math is delegated to `review.js`
   (Leitner boxes 1→5 = 1/3/7/21/60-day intervals); state lives in a single `concepts-v1` bucket in
   `state.json`. Records carry `{box, reps, last (last-learned), first (first-learned), grade}`.
   Tested by `test_concepts.js`.

   API: `Concepts.grade(key, "good"|"shaky"|"bad", extra?)`, `.get/has/all/keys`,
   `.isDue/.dueDate/.due(keys?)`, `.stats()`, `.reload()`.

   Today only the RAG "Mark as learned" feeds it; routing the ML/LLM decks through `Concepts` too
   would fully unify concept tracking in one place (a planned follow-up).

## Adding a new topic

1. Create `content/<id>/topic.yaml` (see `content/rag/topic.yaml` for the shape):
   ```yaml
   id: <id>
   title: <Title>
   audience: <who it's for>
   difficulty: <Beginner|Intermediate|Advanced>
   concepts: [ Concept One, Concept Two, … ]
   constraints: { interview_style: production, explanation_style: concise, language: Python }
   ```
2. `make seed TOPIC=<id>` — generates the graph, curriculum, and all concept files (a few minutes;
   one `claude` call per concept).
3. `make test` to sanity-check, then commit `content/<id>/**`.

The new topic appears as its own tab automatically (the frontend reads `/api/topics`).

## Shipping

The server serves the working tree: content goes live on the next request; `server.py` changes need a
restart. Generated `content/<topic>/**` is committed like any other content.
