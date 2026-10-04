#!/usr/bin/env python3
"""Generate up to 5 hover key-points per concept node in an interactive-lesson topic
(rag / llm-tree / ml-tree / mcp), grounded in each concept's OWN published content, and write them
into content/<topic>/curriculum.json under each concept's `keyPoints`.

curriculum.json is the map's metadata file (topic.js loads it upfront to draw the node graph), so it's
the natural home for node hover text — no extra fetch at hover time. seed.py's gen_curriculum
preserves these on re-seed (they're keyed by concept id).

Offline authoring, no API key: reuses server.run_claude (the local `claude` CLI). Mirrors quizgen.py.
Re-runnable & incremental — skips concepts already covered unless --force:

  python3 keypoints.py rag                 # all rag concepts; skip ones already done
  python3 keypoints.py rag graphrag        # just this concept (its id, or a title keyword)
  python3 keypoints.py rag --force         # regenerate all
  python3 keypoints.py --all               # every topic
  python3 keypoints.py rag --limit 2       # smoke-test on the first 2 concepts
  python3 keypoints.py --selftest          # exercise pure logic, no claude

Then: git add content/<topic>/curriculum.json && commit — checked in like any other content.
"""
import argparse, json, os, re, sys
import server                      # reuse: run_claude, _extract_json, _chat_env, _write_json_atomic

CONTENT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "content")
MAX_POINTS = 5
LESSON_CAP = 6000                  # lesson is the meat; cap so the prompt stays bounded


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def topics():
    """Topic ids = content/<id>/ dirs that have a curriculum.json (interactive lessons, not decks)."""
    return sorted(d for d in os.listdir(CONTENT)
                  if os.path.exists(os.path.join(CONTENT, d, "curriculum.json")))


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def resolve(concepts, sel):
    """Selector -> matching concept(s): exact id wins, else keyword substring over id + title."""
    for c in concepts:
        if c["id"].lower() == sel.lower():
            return [c]
    s = norm(sel)
    return [c for c in concepts if s and s in norm(f"{c['id']} {c.get('title', '')}")]


def grounding(topic, cid):
    """definition + summary + (capped) lesson from the concept's published JSON — its ground truth."""
    path = os.path.join(CONTENT, topic, "concepts", cid + ".json")
    if not os.path.exists(path):
        return None
    d = json.load(open(path))
    parts = []
    if d.get("definition"):
        parts.append("Definition: " + d["definition"])
    if d.get("summary"):
        parts.append("Summary: " + d["summary"])
    if d.get("lesson"):
        parts.append("Lesson:\n" + d["lesson"][:LESSON_CAP])
    return "\n\n".join(parts) if parts else None


def gen_prompt(title, ctx):
    return (f'Below is the reference material for ONE interview concept titled "{title}". Distill it into at '
            f"most {MAX_POINTS} KEY POINTS — the terse, skimmable essence a student sees when hovering this "
            "concept on a map.\n\n"
            "Rules:\n"
            "- Each point is ONE crisp phrase or short clause (aim ≤ 12 words) — a flashcard bullet, not a sentence.\n"
            "- Capture the mechanism / what-it-is / when-to-use / the one key gotcha — the things worth recalling.\n"
            "  Prefer concrete specifics (names, steps, formulas) over vague generalities.\n"
            "- Order them the way you'd teach it: what it is → how it works (in steps) → key tradeoff or gotcha.\n"
            "- Each point STANDS ALONE — never say 'the card', 'this material', 'as described', 'above/below'.\n"
            f"- Give 3 to {MAX_POINTS} points; fewer is fine for a simple concept.\n\n"
            'Example for "GraphRAG":\n'
            '["Extract (entity, relation, entity) triples at index time", "Cluster the graph into communities '
            '(Leiden/Louvain)", "LLM pre-summarizes each community offline", "Global search = map-reduce over '
            'community summaries", "Wins only on corpus-wide / thematic questions"]\n\n'
            f"--- REFERENCE MATERIAL ---\n{ctx}\n--- END MATERIAL ---\n\n"
            "Reply with EXACTLY one ```json fenced block holding a JSON array of 3-"
            f"{MAX_POINTS} short strings. No prose outside the code block.")


def valid(items):
    """Keep non-empty one-line strings, trimmed, deduped, capped at MAX_POINTS."""
    out, seen = [], set()
    for it in items if isinstance(items, list) else []:
        s = " ".join(str(it).split()).strip().rstrip(".")     # collapse whitespace, drop trailing period
        if not s or norm(s) in seen:
            continue
        seen.add(norm(s))
        out.append(s)
        if len(out) >= MAX_POINTS:
            break
    return out


def generate_for(title, ctx):
    """Two tries; return up to MAX_POINTS valid key points (or [] if claude/parsing fails both times)."""
    for _ in range(2):
        text, err = server.run_claude(gen_prompt(title, ctx), server._chat_env(), timeout=300)
        if err:
            log(f"    claude: {err}"); continue
        try:
            pts = valid(server._extract_json(text))
        except Exception:
            log("    could not parse JSON reply"); continue
        if pts:
            return pts
    return []


def run(topic, selector, force, limit, dry):
    cpath = os.path.join(CONTENT, topic, "curriculum.json")
    if not os.path.exists(cpath):
        raise SystemExit(f"no topic content/{topic}/curriculum.json (topics: {', '.join(topics()) or 'none'})")
    curriculum = json.load(open(cpath))
    concepts = curriculum["concepts"]
    todo = concepts
    if selector:
        todo = resolve(concepts, selector)
        if not todo:
            raise SystemExit(f"no '{topic}' concept matches {selector!r}. Options: " +
                             ", ".join(c["id"] for c in concepts))
        if len(todo) > 1:
            raise SystemExit(f"{selector!r} is ambiguous ({len(todo)}): " + ", ".join(c["id"] for c in todo))
    if limit:
        todo = todo[:limit]
    if dry:
        log(f"resolves to {len(todo)} concept(s): " + ", ".join(c["id"] for c in todo))
        return 0

    done = 0
    for i, c in enumerate(todo, 1):
        cid = c["id"]
        if c.get("keyPoints") and not force:
            log(f"[{i}/{len(todo)}] {cid}: has {len(c['keyPoints'])} — skip (use --force)")
            continue
        ctx = grounding(topic, cid)
        if not ctx:
            log(f"[{i}/{len(todo)}] {cid}: ✗ no concept content to ground on — skip"); continue
        log(f"[{i}/{len(todo)}] {cid} · {c.get('title', cid)!r} → generating…")
        pts = generate_for(c.get("title", cid), ctx)
        if not pts:
            log(f"    ✗ nothing generated for {cid}"); continue
        c["keyPoints"] = pts
        server._write_json_atomic(cpath, curriculum)          # persist after each — safe to Ctrl-C and resume
        done += 1
        log(f"    ✓ {len(pts)} points → {topic}/curriculum.json")

    log(f"\nDone: {done} concept(s) updated in '{topic}'. git add content/{topic}/curriculum.json to check in.")
    return done


def _selftest():
    assert valid(["a", "b"]) == ["a", "b"], "basic strings dropped"
    assert valid(["Extract triples.", " extract   triples "]) == ["Extract triples"], "dedup/trim failed"
    assert valid(["x"] * 9) == ["x"], "dedup should collapse identicals"
    assert len(valid([f"point {i}" for i in range(9)])) == MAX_POINTS, "not capped at MAX_POINTS"
    assert valid("not a list") == [], "non-list not handled"
    assert valid([1, 2, 3]) == ["1", "2", "3"], "ints not coerced"
    fx = [{"id": "graphrag", "title": "GraphRAG"}, {"id": "bm25", "title": "BM25"}]
    assert [c["id"] for c in resolve(fx, "graphrag")] == ["graphrag"], "exact-id resolve failed"
    assert [c["id"] for c in resolve(fx, "GRAPH")] == ["graphrag"], "keyword resolve failed"
    assert resolve(fx, "nope") == [], "bad selector should not match"
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser(description="Generate hover key-points into content/<topic>/curriculum.json.")
    ap.add_argument("topic", nargs="?", help="topic id: rag | llm-tree | ml-tree | mcp")
    ap.add_argument("concept", nargs="?", help="scope to one concept: its id or a title keyword; omit for the whole topic")
    ap.add_argument("--all", action="store_true", help="run every topic")
    ap.add_argument("--force", action="store_true", help="regenerate even for concepts already covered")
    ap.add_argument("--limit", type=int, default=0, help="only the first N concepts (smoke test)")
    ap.add_argument("--dry", action="store_true", help="show which concept(s) a selector resolves to; no generation")
    ap.add_argument("--selftest", action="store_true", help="exercise pure logic without calling claude")
    a = ap.parse_args()
    if a.selftest:
        return _selftest()
    if a.all:
        for t in topics():
            log(f"\n=== {t} ===")
            run(t, None, a.force, a.limit, a.dry)
        return
    if not a.topic:
        ap.error("topic is required (e.g. `keypoints.py rag`) — or use --all")
    run(a.topic, a.concept, a.force, a.limit, a.dry)


if __name__ == "__main__":
    main()
