#!/usr/bin/env python3
"""Curriculum generator — the AUTHOR phase of specs/interactive_lesson.md.

Reads content/<topic>/topic.yaml and uses the LOCAL `claude` CLI (no API key,
via server.run_claude) to generate, once and offline:

    content/<topic>/graph.json          dependency graph  { id: {requires:[ids]} }
    content/<topic>/curriculum.json     ordered concept list { concepts:[{id,title,order,difficulty}] }
    content/<topic>/concepts/<id>.json  the full lesson per concept
    content/<topic>/manifest.json       { id,title,version,status,generatedAt,conceptCount,curriculumVersion }

The runtime NEVER regenerates these — server.py just serves them as static files.
Re-running is safe and incremental: a concept regenerates only when its inputs
change (see inputHash), so `seed rag` twice in a row does no work.

    uv run seed.py rag                 # generate / refresh
    uv run seed.py rag --force         # regenerate everything
    uv run seed.py rag --only chunking # regenerate just one concept

Stages are resumable: graph.json / concepts/*.json already on disk are reused
unless their inputs changed or --force is given, so an interrupted run continues.
"""
import argparse, hashlib, json, os, random, re, sys, time
import yaml
import server                                  # reuse the no-API-key claude primitive + json extractor

PROMPT_VERSION = 1                             # bump to force every concept to regenerate (prompt changed)


# ---------------- small helpers ----------------
def log(msg):
    print(msg, file=sys.stderr, flush=True)


def _slug(name):
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def _write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)                      # atomic: never leave a half-written artifact


def _gen(prompt, tries=2, timeout=420):
    """One structured generation via the local claude CLI. Retries once on invalid JSON.
    Offline batch → a generous timeout (concept lessons are large outputs)."""
    last = ""
    for _ in range(tries):
        text, err = server.run_claude(prompt, server._chat_env(), timeout=timeout)
        if err:
            last = err
            continue
        try:
            return server._extract_json(text)
        except Exception as e:
            last = f"invalid JSON from model: {e}"
    raise SystemExit(f"generation failed after {tries} tries: {last}")


# ---------------- graph / curriculum (pure logic — see test_seed.py) ----------------
def _toposort(graph):
    """Prerequisites-first order. Raises ValueError on a cycle. Stable (name-sorted)."""
    order, placed, remaining = [], set(), set(graph)
    while remaining:
        ready = sorted(n for n in remaining if all(r in placed for r in graph[n]["requires"]))
        if not ready:
            raise ValueError("dependency cycle among: " + ", ".join(sorted(remaining)))
        for n in ready:
            order.append(n)
            placed.add(n)
            remaining.discard(n)
    return order


def _validate_graph_refs(graph):
    for n, node in graph.items():
        for r in node["requires"]:
            if r not in graph:
                raise ValueError(f"{n} requires unknown concept '{r}'")


def _depths(graph, order):
    depth = {}
    for n in order:                            # order → every prereq's depth is already known
        reqs = graph[n]["requires"]
        depth[n] = 0 if not reqs else 1 + max(depth[r] for r in reqs)
    return depth


def _difficulty(d):
    return "Beginner" if d == 0 else "Intermediate" if d <= 2 else "Advanced"


def gen_graph(topic, concepts):
    """Ask the model for direct prerequisites, then normalize names→ids and assert acyclic."""
    id_by_name = {c["name"]: c["id"] for c in concepts}
    names = [c["name"] for c in concepts]
    prompt = (
        f'You are designing the prerequisite dependency graph for a course on "{topic["title"]}" '
        f'(audience: {topic.get("audience", "learner")}). The concepts are:\n'
        + "\n".join(f"- {n}" for n in names) + "\n\n"
        "For each concept, list which OTHER concepts from THIS list are its DIRECT prerequisites "
        "(must be understood first). Keep it minimal and acyclic — only true direct dependencies, "
        "never transitive ones; foundational concepts have none.\n"
        'Reply with EXACTLY one ```json code block: an object mapping each concept name to an array '
        'of prerequisite concept names, e.g. {"Embeddings": ["Chunking"], "Chunking": []}. '
        "Use the exact names above. No prose outside the block."
    )
    raw = _gen(prompt)
    if not isinstance(raw, dict):
        raise SystemExit("graph generation did not return an object")
    graph = {}
    for c in concepts:
        reqs = raw.get(c["name"], []) if isinstance(raw.get(c["name"]), list) else []
        req_ids = [id_by_name[r] for r in reqs if r in id_by_name and id_by_name[r] != c["id"]]
        graph[c["id"]] = {"requires": sorted(set(req_ids))}
    _validate_graph_refs(graph)
    _toposort(graph)                           # raises on cycle
    return graph


def gen_curriculum(graph, id_to_name, keypoints=None):
    keypoints = keypoints or {}                 # {id: [hover key points]} — authored by keypoints.py, preserved here
    order = _toposort(graph)
    depth = _depths(graph, order)
    concepts = []
    for i, n in enumerate(order):
        c = {"id": n, "title": id_to_name.get(n, n), "order": i + 1, "difficulty": _difficulty(depth[n])}
        if keypoints.get(n):
            c["keyPoints"] = keypoints[n]
        concepts.append(c)
    return {"concepts": concepts}


def link(graph):
    """relatedConcepts = direct prereqs ∪ direct dependents; followUps = direct dependents."""
    dependents = {n: [] for n in graph}
    for n in graph:
        for r in graph[n]["requires"]:
            dependents[r].append(n)
    related = {n: sorted(set(graph[n]["requires"]) | set(dependents[n])) for n in graph}
    follow = {n: sorted(dependents[n]) for n in graph}
    return related, follow


# ---------------- concept generation ----------------
def _input_hash(topic, concept, req_names):
    payload = json.dumps({
        "name": concept["name"], "title": topic.get("title"), "audience": topic.get("audience"),
        "constraints": topic.get("constraints", {}), "requires": sorted(req_names), "pv": PROMPT_VERSION,
    }, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


# Concept generation uses a delimiter format, NOT JSON: prose sections are taken verbatim, so a
# long markdown lesson can never break parsing (the way literal newlines break hand-written JSON).
# Only the quiz/interview use a tiny line grammar that we parse + validate deterministically.
def _concept_prompt(topic, concept, req_names):
    con = topic.get("constraints", {})
    known = f"The learner already knows: {', '.join(req_names)}.\n" if req_names else ""
    return (
        f'Write a complete, self-contained lesson for the concept "{concept["name"]}" in a course on '
        f'"{topic["title"]}" for a {topic.get("audience", "learner")}.\n'
        f'Style: {con.get("explanation_style", "concise")}. Code in {con.get("language", "Python")}. '
        f'Interview framing: {con.get("interview_style", "production")}.\n{known}\n'
        "Output PLAIN TEXT with the sections below, each introduced by its EXACT header line (a line "
        "containing only the @@NAME marker). Do NOT use JSON. Markdown is allowed INSIDE sections "
        "(headings, fenced code, lists) — write it naturally, no escaping.\n\n"
        "@@DEFINITION\nOne precise sentence.\n\n"
        "@@SUMMARY\nTwo or three sentences.\n\n"
        "@@OBJECTIVES\nThree to five lines, each starting with '- '.\n\n"
        "@@LESSON\nA focused teaching lesson (~250-450 words): intuition, a worked example, the key gotcha.\n\n"
        "@@EXAMPLES\nOne or two concrete worked examples in markdown.\n\n"
        "@@TRADEOFFS\nA few sentences on tradeoffs / when to use vs avoid.\n\n"
        "@@QUIZ\nExactly 5 questions, varied in angle (definition, a calculation/formula, intuition, "
        "when-to-use, a common gotcha). Format EACH exactly as (four '- ' choices, the correct letter, then WHY):\n"
        "Q: <question>\n- <choice>\n- <choice>\n- <choice>\n- <choice>\nCORRECT: <A|B|C|D>\n"
        "WHY: <2-4 sentences: why the correct answer is right and the misconception the best wrong option reflects; markdown ok>\n\n"
        "@@INTERVIEW\nExactly 3 items. Format EACH exactly as:\n"
        "Q: <interview question>\nA: <a strong, concise model answer in markdown>\n\n"
        "@@END\n"
    )


def _split_sections(text):
    """{NAME: body} parsed from @@NAME markers. Tolerant of any preamble/fences around them."""
    sections, cur, buf = {}, None, []
    for line in text.splitlines():
        m = re.match(r"^\s*@@\s*([A-Za-z]+)\s*$", line)
        if m:
            if cur is not None:
                sections[cur] = "\n".join(buf).strip()
            name = m.group(1).upper()
            cur, buf = (None if name == "END" else name), []
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        sections[cur] = "\n".join(buf).strip()
    return sections


def _parse_quiz_block(body):
    """Q: / four '- ' choices / CORRECT: / optional WHY: → [{q, choices[4], answer, explanation}].
    Choices are read only from BEFORE the CORRECT line, so a markdown list inside WHY is never mistaken
    for a choice. Malformed questions are dropped."""
    items = []
    for blk in re.split(r"(?m)^\s*Q:\s*", body):
        blk = blk.strip()
        if not blk:
            continue
        cm = re.search(r"(?mi)^\s*CORRECT:\s*([A-D])\b", blk)
        if not cm:
            continue
        head = blk[:cm.start()].splitlines()
        q = head[0].strip() if head else ""
        choices = [re.sub(r"^\s*-\s*", "", l).strip() for l in head if re.match(r"^\s*-\s+", l)]
        wm = re.search(r"(?is)WHY:\s*(.*)$", blk[cm.end():])
        if q and len(choices) == 4:
            items.append({"q": q, "choices": choices, "answer": "ABCD".index(cm.group(1).upper()),
                          "explanation": wm.group(1).strip() if wm else ""})
    return items


def _shuffle_quiz(quiz):
    """Spread the correct answer across positions — models reliably put it first (all 'A'). Kept out of
    the parser so tests stay deterministic; called only on real generation. Index-based, so duplicate
    choice text can't misplace the answer."""
    for q in quiz:
        order = list(range(len(q["choices"])))
        random.shuffle(order)
        q["choices"] = [q["choices"][i] for i in order]
        q["answer"] = order.index(q["answer"])
    return quiz


def _dedup_quiz(existing, fresh):
    """Drop new questions whose stem already appears (normalized), and internal repeats — so appending
    more quiz can't reintroduce a question the learner already has."""
    seen = {q.get("q", "").strip().lower() for q in existing}
    out = []
    for q in fresh:
        k = q.get("q", "").strip().lower()
        if k and k not in seen:
            seen.add(k)
            out.append(q)
    return out


def _parse_interview_block(body):
    """Q: line + a possibly-multiline A: → [{q, a}]. Answer runs until the next Q:."""
    items, q, a = [], None, None
    for line in body.splitlines():
        qm = re.match(r"^\s*Q:\s*(.*)", line)
        am = re.match(r"^\s*A:\s*(.*)", line)
        if qm:
            if q is not None:
                items.append({"q": q, "a": "\n".join(a or []).strip()})
            q, a = qm.group(1).strip(), None
        elif am:
            a = [am.group(1)]
        elif a is not None:
            a.append(line)
    if q is not None:
        items.append({"q": q, "a": "\n".join(a or []).strip()})
    return [it for it in items if it["q"] and it["a"]]


def _parse_concept(cid, name, text):
    s = _split_sections(text)
    objectives = [re.sub(r"^\s*-\s*", "", l).strip()
                  for l in s.get("OBJECTIVES", "").splitlines() if l.strip().startswith("-")]
    return {
        "id": cid, "title": name,
        "definition": s.get("DEFINITION", "").strip(),
        "summary": s.get("SUMMARY", "").strip(),
        "objectives": [o for o in objectives if o],
        "lesson": s.get("LESSON", "").strip(),
        "examples": s.get("EXAMPLES", "").strip(),
        "tradeoffs": s.get("TRADEOFFS", "").strip(),
        "diagnosticQuiz": _parse_quiz_block(s.get("QUIZ", "")),
        "interviewQuestions": _parse_interview_block(s.get("INTERVIEW", "")),
    }


def gen_concept(topic, concept, req_names, tries=2):
    prompt = _concept_prompt(topic, concept, req_names)
    last = ""
    for _ in range(tries):
        text, err = server.run_claude(prompt, server._chat_env(), timeout=420)
        if err:
            last = err
            continue
        c = _parse_concept(concept["id"], concept["name"], text)
        if c["definition"] and c["lesson"] and c["diagnosticQuiz"]:   # got the essentials
            c["diagnosticQuiz"] = _shuffle_quiz(c["diagnosticQuiz"])
            return c
        last = "parsed sections missing definition/lesson/quiz"
    raise SystemExit(f"concept '{concept['name']}' generation failed: {last}")


# ---------------- validation ----------------
def validate_refs(graph, curriculum, cdir):
    ids = {c["id"] for c in curriculum["concepts"]}
    _validate_graph_refs(graph)
    _toposort(graph)                                          # re-assert acyclic
    for cid in graph:
        assert cid in ids, f"graph node {cid} missing from curriculum"
    for cid in ids:
        p = os.path.join(cdir, cid + ".json")
        assert os.path.isfile(p), f"missing concept file for {cid}"
        c = _load(p) or {}
        for r in c.get("relatedConcepts", []) + c.get("followUps", []):
            assert r in ids, f"{cid} references unknown concept '{r}'"


def _validate_config(topic):
    for f in ("id", "title", "concepts"):
        if not topic.get(f):
            raise SystemExit(f"topic.yaml missing required field: {f}")
    if not isinstance(topic["concepts"], list) or not topic["concepts"]:
        raise SystemExit("topic.yaml: 'concepts' must be a non-empty list")


# ---------------- pipeline ----------------
def seed(topic_id, force=False, only=None):
    tdir = os.path.join(server.CONTENT_DIR, topic_id)
    cfg = os.path.join(tdir, "topic.yaml")
    if not os.path.isfile(cfg):
        raise SystemExit(f"no topic config at {cfg}")
    topic = yaml.safe_load(open(cfg)) or {}
    _validate_config(topic)
    concepts = [{"name": n, "id": _slug(n)} for n in topic["concepts"]]
    id_to_name = {c["id"]: c["name"] for c in concepts}
    cdir = os.path.join(tdir, "concepts")

    # --- graph (reuse unless missing/forced; it's the expensive structural call) ---
    graph_path = os.path.join(tdir, "graph.json")
    graph = _load(graph_path)
    graph_changed = False
    if graph is None or force:
        log("· generating dependency graph…")
        graph = gen_graph(topic, concepts)
        _write_json(graph_path, graph)
        graph_changed = True
    else:                                                     # keep graph in sync if concepts were added/removed
        for c in concepts:
            graph.setdefault(c["id"], {"requires": []})
        graph = {cid: node for cid, node in graph.items() if cid in id_to_name}

    # --- curriculum (derived, deterministic) — but preserve hover keyPoints authored by keypoints.py ---
    curr_path = os.path.join(tdir, "curriculum.json")
    prev_kp = {c["id"]: c.get("keyPoints") for c in (_load(curr_path) or {}).get("concepts", []) if c.get("keyPoints")}
    curriculum = gen_curriculum(graph, id_to_name, prev_kp)
    _write_json(curr_path, curriculum)
    related, follow = link(graph)

    # --- concepts (incremental) ---
    n_regen = 0
    for c in concepts:
        cid, cpath = c["id"], os.path.join(cdir, c["id"] + ".json")
        req_names = [id_to_name[r] for r in graph[cid]["requires"]]
        h = _input_hash(topic, c, req_names)
        existing = _load(cpath)
        stale = existing is None or existing.get("metadata", {}).get("inputHash") != h
        targeted = force or (only == cid)
        if only and cid != only and existing is not None:
            stale = False                                     # --only: leave the others exactly as they are
        if not (targeted or stale):
            existing["relatedConcepts"], existing["followUps"] = related[cid], follow[cid]
            _write_json(cpath, existing)                      # links may have shifted; content untouched
            continue
        log(f"· generating concept: {c['name']}…")
        obj = gen_concept(topic, c, req_names)
        obj["version"] = (existing.get("version", 0) + 1) if existing else 1
        obj["relatedConcepts"], obj["followUps"] = related[cid], follow[cid]
        obj["metadata"] = {"inputHash": h, "model": server.CHAT_MODEL, "generatedAt": _now()}
        _write_json(cpath, obj)
        n_regen += 1

    # --- validate references across everything ---
    validate_refs(graph, curriculum, cdir)

    # --- manifest + publish (version bumps only on real change) ---
    mpath = os.path.join(tdir, "manifest.json")
    old = _load(mpath) or {}
    version = old.get("version", 0) + (1 if (n_regen or graph_changed or not old) else 0)
    curr_version = old.get("curriculumVersion", 0) + (1 if (graph_changed or not old) else 0)
    _write_json(mpath, {
        "id": topic_id, "title": topic["title"], "version": version, "status": "published",
        "generatedAt": _now(), "conceptCount": len(concepts), "curriculumVersion": curr_version,
    })
    log(f"✓ {topic_id}: {len(concepts)} concepts, {n_regen} (re)generated — manifest v{version}, "
        f"curriculum v{curr_version}. Published.")


# ---------------- quiz-only regeneration (more questions, from existing lesson content) ----------------
def _quiz_only_prompt(topic, data):
    con = topic.get("constraints", {})
    return (
        f'Here is a lesson on the concept "{data.get("title", "")}" from a course on "{topic["title"]}" '
        f'(audience: {topic.get("audience", "learner")}; code in {con.get("language", "Python")}).\n\n'
        f'DEFINITION: {data.get("definition", "")}\n\nLESSON:\n{data.get("lesson", "")}\n\n'
        f'EXAMPLES:\n{data.get("examples", "")}\n\nTRADEOFFS:\n{data.get("tradeoffs", "")}\n\n'
        "Write EXACTLY 5 multiple-choice questions that test understanding of THIS lesson — ground each in the "
        "material above and vary the angle (definition, a calculation/formula, intuition, when-to-use, a common "
        "gotcha). Output PLAIN TEXT, each question EXACTLY as (four '- ' choices, the correct letter, then a WHY "
        "deep-dive):\n"
        "Q: <question>\n- <choice>\n- <choice>\n- <choice>\n- <choice>\nCORRECT: <A|B|C|D>\n"
        "WHY: <2-4 sentences: why the correct answer is right and the misconception the best wrong option "
        "reflects; markdown ok>\n\n"
        "Exactly 4 choices each, exactly one correct. No prose outside this format."
    )


def gen_quiz(topic, data, tries=2):
    last = ""
    for _ in range(tries):
        text, err = server.run_claude(_quiz_only_prompt(topic, data), server._chat_env(), timeout=300)
        if err:
            last = err
            continue
        quiz = _parse_quiz_block(text)
        if len(quiz) >= 3:
            return _shuffle_quiz(quiz)
        last = f"only {len(quiz)} valid questions parsed"
    raise SystemExit(f"quiz regen for '{data.get('title')}' failed: {last}")


def regen_quiz(topic_id, only=None):
    """Regenerate ONLY the diagnosticQuiz for each concept, from its existing lesson content — the lesson
    and everything else are preserved. Bumps each touched concept's version and the manifest."""
    tdir = os.path.join(server.CONTENT_DIR, topic_id)
    topic = yaml.safe_load(open(os.path.join(tdir, "topic.yaml"))) or {}
    _validate_config(topic)
    cdir = os.path.join(tdir, "concepts")
    n = 0
    for name in topic["concepts"]:
        cid = _slug(name)
        if only and cid != only:
            continue
        cpath = os.path.join(cdir, cid + ".json")
        data = _load(cpath)
        if not data:
            log(f"· skip {name} — no concept file (run a full seed first)")
            continue
        log(f"· regenerating quiz: {name}…")
        data["diagnosticQuiz"] = gen_quiz(topic, data)
        data["version"] = data.get("version", 1) + 1
        data.setdefault("metadata", {})["quizUpdatedAt"] = _now()
        _write_json(cpath, data)
        n += 1
    mpath = os.path.join(tdir, "manifest.json")
    m = _load(mpath) or {}
    if n:
        m["version"] = m.get("version", 0) + 1
        m["generatedAt"] = _now()
        _write_json(mpath, m)
    log(f"✓ {topic_id}: regenerated quizzes for {n} concept(s).")


# ---------------- add MORE quiz (append, keeping the existing questions) ----------------
def _quiz_add_prompt(topic, data, existing, n, about=None):
    con = topic.get("constraints", {})
    stems = "\n".join(f"- {q.get('q', '')}" for q in existing) or "(none yet)"
    focus = (f"EVERY question must focus specifically on: {about}. Keep them accurate to standard "
             f'"{data.get("title", "")}" and use the lesson\'s notation/code where relevant. ') if about else ""
    return (
        f'Here is a lesson on the concept "{data.get("title", "")}" from a course on "{topic["title"]}" '
        f'(code in {con.get("language", "Python")}).\n\n'
        f'DEFINITION: {data.get("definition", "")}\n\nLESSON:\n{data.get("lesson", "")}\n\n'
        f'EXAMPLES:\n{data.get("examples", "")}\n\nTRADEOFFS:\n{data.get("tradeoffs", "")}\n\n'
        f'The learner has ALREADY been quizzed on these — do NOT repeat or lightly reword them:\n{stems}\n\n'
        f'Write EXACTLY {n} NEW multiple-choice questions grounded in the lesson above. {focus}'
        "Each probes a DIFFERENT angle or detail than those already asked. Output PLAIN TEXT, each EXACTLY "
        "as (four '- ' choices, the correct letter, then a WHY deep-dive):\n"
        "Q: <question>\n- <choice>\n- <choice>\n- <choice>\n- <choice>\nCORRECT: <A|B|C|D>\n"
        "WHY: <2-4 sentences: why the correct answer is right and the misconception the best wrong option "
        "reflects; markdown ok>\n\n"
        "Exactly 4 choices each, exactly one correct. No prose outside this format."
    )


def gen_quiz_add(topic, data, existing, n, about=None, tries=2):
    last = ""
    for _ in range(tries):
        text, err = server.run_claude(_quiz_add_prompt(topic, data, existing, n, about), server._chat_env(), timeout=300)
        if err:
            last = err
            continue
        quiz = _parse_quiz_block(text)
        if quiz:
            return _shuffle_quiz(quiz)
        last = "no valid questions parsed"
    raise SystemExit(f"quiz add for '{data.get('title')}' failed: {last}")


def add_quiz(topic_id, n, only=None, about=None):
    """APPEND n more quiz questions (grounded in the lesson, distinct from the existing ones) to each
    targeted concept — optionally all focused on a sub-topic (`about`). Bumps version + manifest."""
    tdir = os.path.join(server.CONTENT_DIR, topic_id)
    topic = yaml.safe_load(open(os.path.join(tdir, "topic.yaml"))) or {}
    _validate_config(topic)
    cdir = os.path.join(tdir, "concepts")
    touched = 0
    for name in topic["concepts"]:
        cid = _slug(name)
        if only and cid != only:
            continue
        cpath = os.path.join(cdir, cid + ".json")
        data = _load(cpath)
        if not data:
            log(f"· skip {name} — no concept file")
            continue
        existing = data.get("diagnosticQuiz", [])
        log(f"· adding {n} quiz to {name} (has {len(existing)})" + (f" about: {about}" if about else "") + "…")
        fresh = _dedup_quiz(existing, gen_quiz_add(topic, data, existing, n, about))
        data["diagnosticQuiz"] = existing + fresh
        data["version"] = data.get("version", 1) + 1
        data.setdefault("metadata", {})["quizUpdatedAt"] = _now()
        _write_json(cpath, data)
        touched += 1
        log(f"  → {name}: {len(existing)} + {len(fresh)} = {len(data['diagnosticQuiz'])} questions")
    mpath = os.path.join(tdir, "manifest.json")
    m = _load(mpath) or {}
    if touched:
        m["version"] = m.get("version", 0) + 1
        m["generatedAt"] = _now()
        _write_json(mpath, m)
    log(f"✓ {topic_id}: added quiz to {touched} concept(s).")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Generate an interactive-lesson topic (author phase).")
    ap.add_argument("topic", help="topic id — the content/<topic>/ directory holding topic.yaml")
    ap.add_argument("--force", action="store_true", help="regenerate every artifact")
    ap.add_argument("--only", help="target just this concept id (with --quiz / --add)")
    ap.add_argument("--quiz", action="store_true", help="regenerate ONLY the quiz per concept (replaces it) from existing lessons")
    ap.add_argument("--add", type=int, metavar="N", help="APPEND N more quiz questions to the concept(s), keeping the existing ones")
    ap.add_argument("--about", help="with --add: focus every new question on this sub-topic (e.g. 'the indexing process')")
    a = ap.parse_args()
    only = _slug(a.only) if a.only else None
    if a.add:
        add_quiz(a.topic, a.add, only=only, about=a.about)
    elif a.quiz:
        regen_quiz(a.topic, only=only)
    else:
        seed(a.topic, force=a.force, only=only)
