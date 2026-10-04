## As-built (implemented 2026-07-03)

This design shipped, adapted to the existing lean stack (stdlib Python + PyYAML, single-file
`server.py`, static SPA). What maps directly, and where it differs:

- **Author CLI** → `make seed TOPIC=rag` (wraps `uv run seed.py rag`). No `interview`/`npm` binary —
  this repo is stdlib Python, so a make target is the native equivalent. `--force` regenerates all;
  `--only <id>` targets one concept.
- **Pipeline** (`seed.py`) → load+validate `topic.yaml` → dependency `graph.json` (acyclic, validated)
  → `curriculum.json` (topological order + depth→difficulty) → one **concept file per concept**
  (a single structured `claude` call covers the metadata/lesson/quiz/interview stages) → link
  related/followUps from graph neighbors → validate references → `manifest.json` + publish.
  Generation reuses the app's existing no-API-key local-CLI primitive (`server.run_claude`).
- **Incremental / resumable** → each concept stores `metadata.inputHash`; a rerun regenerates only
  concepts whose inputs changed. `graph.json`/`curriculum.json` are reused if present. Running the
  seed twice is a no-op.
- **Versioning** → `manifest.version` / `curriculumVersion` / per-concept `version` bump on change;
  git carries the real history. Progress keys on concept **id**, so it survives regenerations.
- **Storage** → per-topic `content/<id>/{topic.yaml, manifest.json, graph.json, curriculum.json,
  concepts/*.json}`, exactly as below. `topic.yaml` is the only human-authored file.
- **Runtime** → the curriculum/graph/concept JSON are **static files** served by the existing
  handler (no per-concept endpoint needed — they're published, non-secret). The server adds only
  `GET /api/topics` (list published manifests) and `GET/POST /api/topic/<id>/progress?user=`.
  **No LLM is called at runtime.**
- **Progress** → `progress/<user>/<topic>.json` holding `{mastery,score,attempts}` — one source of
  truth, proxied to another instance when `STATE_BACKEND` is set (same as `state.json`), and
  backed up by the in-app Git Sync.
- **Learner UX** (`topic.js`) → each published topic gets its own tab; the concept list is
  **prerequisite-gated** (a concept unlocks once every `requires` is Mastered); opening a concept
  runs the guided Learn flow: objectives → lesson → examples → tradeoffs → diagnostic quiz →
  interview questions → **Mark learned** (persists progress, unlocks dependents).

## Authoring a curriculum tree — runbook (for the next agent)

A **topic** is a prerequisite-gated learning tree (e.g. `rag`, `llm-tree`) — distinct from an ML/LLM
flashcard **deck** (`deck.yaml` + `study.js`). The runtime is topic-agnostic: **a new topic needs
zero app code** — `server.load_topics()` scans `content/*/manifest.json` and `topic.js` registers a
tab per published topic + renders the gated map and lesson reader. To add or maintain a tree:

1. **`content/<id>/topic.yaml`** — the one required human file: a *flat list of concept names* plus
   `id` / `title` / `audience` / `difficulty` / `constraints`. Mirror `content/rag/topic.yaml`.

2. **`content/<id>/graph.json` — hand-author it to pin the exact prerequisite tree.** `seed.py` asks
   the LLM to *infer* edges only when this file is missing (or `--force`); writing it first makes
   seed reuse it verbatim. This is how `llm-tree` guarantees its designed tree instead of an LLM
   guess. Shape: `{ "<id>": {"requires": ["<id>", …]}, … }`. Gotchas:
   - **ids are slugified concept names** — `_slug()` = lowercase, each non-`[a-z0-9]` run → `-`,
     trimmed ("Self-Attention" → `self-attention`). These are NOT the deck's `t-`/`l-`/`k-` ids.
   - Must be an acyclic, fully-connected DAG; every `requires` target must be a real node. A single
     root (one node with `requires: []`) gives the cleanest "start here" entry point.
   - **Validate offline before the slow generation:** `import seed; seed._validate_graph_refs(g);
     seed._toposort(g)` catches typo'd ids and cycles in a second (also cross-check the graph ids
     equal `{_slug(n) for n in topic["concepts"]}`).

3. **Generate:** `make seed TOPIC=<id>` (= `uv run seed.py <id>`). With `graph.json` present it
   derives `curriculum.json` (topological order + depth→difficulty), generates one
   `concepts/<id>.json` lesson per concept via the local `claude` CLI (≈ one call each — budget
   several minutes for a large tree), validates references, and writes `manifest.json` (published).

4. **Incremental / resumable — a killed run just resumes.** Each concept stores `metadata.inputHash`
   (name + title + audience + constraints + `requires` + prompt version); re-running regenerates
   only missing or changed concepts. `manifest.json` is written **last** (after all concepts +
   validation), so a SIGTERM'd/partial run never publishes a broken topic — just run seed again.
   One concept: `uv run seed.py <id> --only <concept-id>`. Everything: `--force`. Editing the graph
   later re-generates only concepts whose `requires` changed (inputHash includes it).

5. **Preview before all lessons exist:** a topic appears only once `manifest.json` is
   `status:"published"` (seed writes it at the very end). To eyeball a partial tree, hand-write a
   temporary manifest — `{id,title,version:1,status:"published",conceptCount,curriculumVersion:1}` —
   which seed later overwrites (version bumps) on completion. Ungenerated concepts sit deep in the
   tree and are prereq-locked anyway, so they aren't reachable yet. Serve locally with a bare
   `uv run server.py 8082` and open `/roadmap.html` → the topic tab. (Opening a lesson writes
   `progress/me/<id>.json` — a local artifact; don't commit it.)

6. **Mastery is per-topic, keyed by slug id** — separate from the flashcard decks' SRS (which key by
   `t-`/`l-`/`k-` ids). A tree and a deck don't share progress unless they reuse ids. **Difficulty**
   is just a depth bucket (`_difficulty`: 0 → Beginner, ≤2 → Intermediate, else Advanced), so a deep
   single-root chain reads mostly "Advanced" — cosmetic (gating/layout use real depth); retune the
   thresholds in `seed.py` if it matters.

7. **Ship:** commit all of `content/<id>/` (`topic.yaml`, `graph.json`, `curriculum.json`,
   `concepts/*.json`, `manifest.json`); the running server picks it up on the next request.

8. **Fix a page without re-seeding — in-app `✦ Refine`.** Each concept page has a **✦ Refine** button:
   chat with Claude to change the prose, review a diff, Accept → it writes the edited
   `concepts/<id>.json` (prose fields only), ready to commit. It **bumps `version` but keeps
   `metadata.inputHash`**, which is exactly why the hand edit survives future `seed.py <id>` runs (the
   staleness check keys on inputHash, not the body — see point 4 / the as-built note above). So Refine is
   the fast path for small corrections; re-seed (`--only`/`--force`) only when you want a full
   regeneration. Reply contract reuses `_split_sections`' `@@SECTION` markers; write-back is
   `server.update_concept` → `POST /api/concept`. (Also in CLAUDE.md → "Authoring content".)

Key code (`seed.py`): `_slug` (35), `_toposort` (76), `_depths`/`_difficulty` (97/105), `gen_graph`
(109), `gen_curriculum` (137), `seed()` (334). Renderer: `topic.js`. In-app edit: `server.update_concept`
+ `_build_refine_prompt`, `chat.js` (`openConceptRefine`). Topic list: `server.load_topics()`.

---

The original proposal follows, unchanged.

---

I would actually go one step further. The app should have two distinct phases:

1. Content Generation (offline/admin) → AI generates and persists a curriculum.
2. Content Delivery (runtime/user) → The web app only serves persisted content and tracks progress.

This separation makes the system much simpler, faster, cheaper, and deterministic. Users never wait for AI to generate lessons while learning.

I’d update the spec with the following architecture.

⸻

Content Lifecycle

The system has two independent modes.

                AUTHOR
      Create Topic
            │
            ▼
     Define Concepts
            │
            ▼
     Generate Curriculum
      (Claude Code)
            │
            ▼
 Persist Generated Content
            │
            ▼
      Review & Edit
            │
            ▼
         Publish
            │
──────────────────────────────────────
            │
            ▼
          LEARNER
     Load Published Topic
            │
            ▼
      Resume Progress
            │
            ▼
     Complete Concepts
            │
            ▼
     Persist Progress Only

At runtime, the application should never regenerate curriculum.

⸻

Content Generation Pipeline

Generation should be a repeatable pipeline.

Topic
↓
Concept List
↓
Generate Dependency Graph
↓
Generate Curriculum
↓
Generate Individual Concepts
↓
Generate Quizzes
↓
Generate Interview Questions
↓
Validate
↓
Persist
↓
Ready to Serve

Each stage should be independently rerunnable.

⸻

Seed Command

Curriculum generation should be treated like a database migration or seed.

Example CLI

interview seed rag

or

npm run seed rag

This command should:

* Read topic definition
* Read concept list
* Invoke Claude Code
* Generate curriculum
* Generate all concept files
* Validate references
* Save everything to disk/database

Running the seed twice should be safe.

Only changed concepts should regenerate.

⸻

Content Storage

Everything required to serve learners should already exist after seeding.

content/
    rag/
        manifest.json
        curriculum.json
        graph.json
        concepts/
            rag.json
            chunking.json
            embeddings.json
            bm25.json
            reranking.json
            ...

Nothing in this directory is generated during runtime.

⸻

Manifest

Every topic has one manifest.

Example

{
  "id": "rag",
  "title": "Retrieval-Augmented Generation",
  "version": 4,
  "status": "published",
  "generatedAt": "...",
  "conceptCount": 42,
  "curriculumVersion": 3
}

This allows easy upgrades later.

⸻

Curriculum

Curriculum becomes a persisted artifact.

Example

{
  "concepts": [
    {
      "id": "chunking",
      "order": 1,
      "difficulty": "Beginner"
    },
    {
      "id": "embeddings",
      "order": 2,
      "difficulty": "Intermediate"
    }
  ]
}

The frontend simply loads this.

No AI required.

⸻

Concept File

Each concept is self-contained.

embeddings.json
definition
summary
objectives
examples
diagnosticQuiz
lesson
tradeoffs
interviewQuestions
followUps
relatedConcepts
metadata

Everything needed to render the page.

⸻

Progress Storage

Progress is entirely separate.

progress/
    user123/
        rag.json

Example

{
  "chunking": {
    "mastery": "Mastered",
    "score": 100,
    "attempts": 2
  },
  "embeddings": {
    "mastery": "Learning",
    "score": 65
  }
}

No content duplication.

⸻

Incremental Generation

Claude should never regenerate everything.

Instead:

Concept Added
↓
Generate New Concept
↓
Update Graph
↓
Update Curriculum
↓
Done

If only one concept changes

Only regenerate affected nodes.

⸻

Example

Human adds

ColBERT

Pipeline

Read graph
↓
Determine dependencies
↓
Generate ColBERT
↓
Update graph
↓
Update curriculum
↓
Done

Not

Delete everything
Generate all again

⸻

Content Versioning

Every artifact has a version.

Embeddings
v1
↓
Human edits
↓
v2
↓
Regenerated
↓
v3

Old progress remains valid.

⸻

Seed Configuration

Every topic should contain a single configuration file.

Example

id: rag
title: Retrieval-Augmented Generation
audience:
  Senior ML Engineer
difficulty:
  Intermediate
concepts:
  - Chunking
  - Embeddings
  - BM25
  - Hybrid Search
  - HNSW
  - GraphRAG
constraints:
  interview_style:
    production
  explanation_style:
    concise
  language:
    Python

This is the only human-authored file required to bootstrap a new topic.

⸻

Seed Pipeline

The generator should execute approximately:

Load Config
↓
Validate
↓
Generate Dependency Graph
↓
Generate Curriculum
↓
Generate Concept Metadata
↓
Generate Lessons
↓
Generate Quiz
↓
Generate Interview Questions
↓
Link Related Concepts
↓
Validate References
↓
Write Files
↓
Publish

Each step should be resumable.

⸻

Runtime Responsibilities

The runtime application should never call an LLM for standard learning.

Its responsibilities are limited to:

* Load published curriculum
* Load concept files
* Track learner progress
* Unlock concepts based on prerequisites
* Evaluate quizzes (using stored answers or an optional grading service)
* Display interview sessions
* Persist progress

The runtime should remain deterministic, fast, and inexpensive.

⸻

Admin Responsibilities

The admin interface (or CLI) is responsible for:

* Creating topics
* Editing concept lists
* Regenerating concepts
* Publishing new curriculum versions
* Reviewing generated content
* Resolving validation errors
* Managing overrides

⸻

Overall Architecture

                   Author
                     │
                     ▼
             topic.yaml
                     │
                     ▼
            Claude Seed Pipeline
                     │
     ┌───────────────┼────────────────┐
     ▼               ▼                ▼
 curriculum.json  graph.json   concept/*.json
     │               │                │
     └───────────────┴────────────────┘
                     │
              Published Content
                     │
══════════════════════════════════════════════
                     │
                     ▼
               Web Application
                     │
         Load Persisted Curriculum
                     │
                     ▼
          Track User Progress Only
                     │
                     ▼
              progress/<user>.json

Design Principle

The guiding principle is:

AI generates content once; the application serves it many times.

Generation is an administrative, versioned, repeatable build step. Runtime is a pure content delivery system with progress tracking. This separation makes the platform scalable, testable, cache-friendly, and easy to extend with new interview domains by adding a single topic configuration and running the seed pipeline.
