#!/usr/bin/env python3
"""Self-check for seed.py's non-trivial logic — the parts that would silently corrupt a
curriculum if they broke: topological ordering, cycle detection, reference validation, the
difficulty ladder, and the incremental-regen hash. No framework; run it directly:

    uv run test_seed.py        # or: python3 test_seed.py
"""
import seed


def test_slug():
    assert seed._slug("RAG Overview") == "rag-overview"
    assert seed._slug("BM25") == "bm25"


def test_toposort_orders_prereqs_first():
    g = {"a": {"requires": []}, "b": {"requires": ["a"]}, "c": {"requires": ["a", "b"]}}
    order = seed._toposort(g)
    assert order.index("a") < order.index("b") < order.index("c"), order
    assert set(order) == set(g)


def test_toposort_detects_cycle():
    g = {"a": {"requires": ["b"]}, "b": {"requires": ["a"]}}
    try:
        seed._toposort(g)
    except ValueError:
        return
    assert False, "expected a cycle to raise ValueError"


def test_graph_refs_catch_dangling():
    g = {"a": {"requires": ["ghost"]}}
    try:
        seed._validate_graph_refs(g)
    except ValueError:
        return
    assert False, "expected a dangling prerequisite to raise ValueError"


def test_depths_and_difficulty():
    g = {"a": {"requires": []}, "b": {"requires": ["a"]}, "c": {"requires": ["b"]},
         "d": {"requires": ["c"]}}
    depth = seed._depths(g, seed._toposort(g))
    assert depth == {"a": 0, "b": 1, "c": 2, "d": 3}, depth
    assert seed._difficulty(0) == "Beginner"
    assert seed._difficulty(2) == "Intermediate"
    assert seed._difficulty(3) == "Advanced"


def test_link_related_and_followups():
    g = {"a": {"requires": []}, "b": {"requires": ["a"]}}
    related, follow = seed.link(g)
    assert related["a"] == ["b"] and related["b"] == ["a"], related   # symmetric
    assert follow["a"] == ["b"] and follow["b"] == [], follow          # dependents only


def test_curriculum_shape():
    g = {"a": {"requires": []}, "b": {"requires": ["a"]}}
    cur = seed.gen_curriculum(g, {"a": "Alpha", "b": "Beta"})
    assert [c["id"] for c in cur["concepts"]] == ["a", "b"]
    assert cur["concepts"][0] == {"id": "a", "title": "Alpha", "order": 1, "difficulty": "Beginner"}
    assert cur["concepts"][1]["difficulty"] == "Intermediate"


def test_input_hash_stable_and_sensitive():
    topic = {"title": "T", "audience": "eng", "constraints": {"language": "Python"}}
    c = {"name": "Chunking", "id": "chunking"}
    assert seed._input_hash(topic, c, []) == seed._input_hash(topic, c, [])          # deterministic
    assert seed._input_hash(topic, c, []) != seed._input_hash(topic, c, ["Embeddings"])  # inputs matter
    other = {"title": "T2", "audience": "eng", "constraints": {"language": "Python"}}
    assert seed._input_hash(topic, c, []) != seed._input_hash(other, c, [])


def test_split_sections_and_parse_concept():
    text = (
        "preamble to ignore\n"
        "@@DEFINITION\nA precise sentence.\n"
        "@@SUMMARY\nTwo sentences here.\n"
        "@@OBJECTIVES\n- learn a\n- learn b\n"
        "@@LESSON\n## Heading\nBody with a \"quote\" and\nmultiple lines.\n```python\nx = 1\n```\n"
        "@@EXAMPLES\nAn example.\n"
        "@@TRADEOFFS\nSome tradeoffs.\n"
        "@@QUIZ\nQ: what?\n- a\n- b\n- c\n- d\nCORRECT: C\n"
        "@@INTERVIEW\nQ: explain it\nA: a multi-line\nanswer here\n"
        "@@END\n")
    c = seed._parse_concept("x", "X", text)
    assert c["definition"] == "A precise sentence."
    assert c["objectives"] == ["learn a", "learn b"]
    assert "multiple lines" in c["lesson"] and '"quote"' in c["lesson"]   # verbatim, no escaping needed
    assert c["diagnosticQuiz"] == [{"q": "what?", "choices": ["a", "b", "c", "d"], "answer": 2, "explanation": ""}]
    assert c["interviewQuestions"] == [{"q": "explain it", "a": "a multi-line\nanswer here"}]
    assert c["id"] == "x" and c["title"] == "X"


def test_parse_quiz_drops_malformed():
    body = ("Q: good\n- a\n- b\n- c\n- d\nCORRECT: A\n"
            "Q: too few choices\n- a\n- b\nCORRECT: A\n"       # only 2 choices → dropped
            "Q: no correct marker\n- a\n- b\n- c\n- d\n")      # missing CORRECT → dropped
    q = seed._parse_quiz_block(body)
    assert len(q) == 1 and q[0]["q"] == "good" and q[0]["answer"] == 0
    assert q[0]["explanation"] == ""                          # no WHY → empty explanation


def test_parse_quiz_captures_explanation():
    body = ("Q: what does k1 control?\n- IDF\n- saturation\n- length norm\n- cosine\n"
            "CORRECT: B\nWHY: k1 sets how fast term-frequency saturates.\nHigher k1 → slower saturation.\n")
    q = seed._parse_quiz_block(body)
    assert len(q) == 1 and q[0]["answer"] == 1
    assert "saturates" in q[0]["explanation"]
    assert "Higher k1" in q[0]["explanation"]                 # multi-line WHY captured


def test_shuffle_quiz_keeps_answer_correct():
    q = [{"q": "x", "choices": ["W", "X", "Y", "Z"], "answer": 2}]   # Y is the correct choice
    out = seed._shuffle_quiz(q)
    assert out[0]["choices"][out[0]["answer"]] == "Y"               # answer index still points at Y
    assert sorted(out[0]["choices"]) == ["W", "X", "Y", "Z"]        # same choices, just reordered


def test_dedup_quiz_drops_repeats():
    existing = [{"q": "What is BM25?"}]
    fresh = [{"q": "what is bm25?"},          # case-dup of an existing question → dropped
             {"q": "How does k1 work?"},
             {"q": "How does k1 work?"}]       # internal duplicate → only one kept
    out = seed._dedup_quiz(existing, fresh)
    assert [q["q"] for q in out] == ["How does k1 work?"]


def test_parse_quiz_why_bullets_are_not_choices():
    # a markdown list inside WHY must NOT be picked up as extra choices (would break len==4)
    body = "Q: q\n- a\n- b\n- c\n- d\nCORRECT: C\nWHY: two reasons:\n- first\n- second\n"
    q = seed._parse_quiz_block(body)
    assert len(q) == 1 and len(q[0]["choices"]) == 4 and q[0]["answer"] == 2
    assert "first" in q[0]["explanation"] and "second" in q[0]["explanation"]


if __name__ == "__main__":
    tests = sorted((n, f) for n, f in globals().items() if n.startswith("test_") and callable(f))
    for name, fn in tests:
        fn()
        print("ok  " + name)
    print(f"\nall {len(tests)} passed")
