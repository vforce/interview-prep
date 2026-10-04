"""Tests for quizgen.py: the pure MCQ helpers, concept resolution, and the generation loop
(with the local `claude` CLI mocked out). Run: `uv run pytest test_quizgen.py` (or `make test`)."""
import json
import os
import pytest
import yaml
import server
import quizgen


# ---------------- pure helpers ----------------

@pytest.mark.parametrize("item,kept", [
    ({"q": "x", "choices": ["a", "b", "c", "d"], "answer": 1}, 1),
    ({"q": "x", "choices": ["a", "b", "c"], "answer": 0}, 0),          # not exactly 4 choices
    ({"q": "", "choices": ["a", "b", "c", "d"], "answer": 0}, 0),      # empty question
    ({"q": "x", "choices": ["a", "b", "c", "d"], "answer": 9}, 0),     # answer out of range
    ({"q": "x", "choices": ["a", "b", "c", "d"], "answer": "n"}, 0),   # non-int answer
    ("not-a-dict", 0),
])
def test_valid(item, kept):
    assert len(quizgen.valid([item])) == kept


def test_valid_normalizes_choice_whitespace():
    out = quizgen.valid([{"q": " x ", "choices": [" a ", "b", "c", "d"], "answer": 0}])
    assert out[0]["q"] == "x" and out[0]["choices"][0] == "a"


@pytest.mark.parametrize("s,expected", [
    ("What IS  TPR?!", "what is tpr"),
    ("ROC-AUC", "roc auc"),
    ("  a__b  ", "a b"),
])
def test_norm(s, expected):
    assert quizgen.norm(s) == expected


def test_shuffled_preserves_correct_answer():
    q = {"q": "x", "choices": ["A", "B", "C", "D"], "answer": 0}
    for i in range(50):                                               # index varies by design; the value must not
        s = quizgen.shuffled(q)
        assert s["choices"][s["answer"]] == "A"
        assert sorted(s["choices"]) == ["A", "B", "C", "D"]


# ---------------- resolve ----------------

ITEMS = [
    {"id": "m-roc-pr", "type": "concept", "front": "ROC-AUC vs PR-AUC — what each shows", "area": "Metrics"},
    {"id": "m-f1", "type": "concept", "front": "What is the F1 score", "area": "Metrics"},
    {"id": "ml-gboost", "type": "concept", "front": "Gradient boosting basics", "area": "Trees"},
    {"id": "kata1", "type": "kata", "title": "Softmax kata", "area": "Losses"},
]


@pytest.mark.parametrize("sel,expected_ids", [
    ("m-roc-pr", ["m-roc-pr"]),          # exact id
    ("ROC-AUC", ["m-roc-pr"]),           # keyword in front
    ("Softmax", ["kata1"]),              # keyword in kata title
    ("gradient", ["ml-gboost"]),         # single keyword hit
    ("f1", ["m-f1"]),
    ("nonexistent", []),                 # no match
])
def test_resolve(sel, expected_ids):
    assert [it["id"] for it in quizgen.resolve(ITEMS, sel)] == expected_ids


def test_resolve_ambiguous_returns_all_matches():
    items = ITEMS + [{"id": "m-metrics", "type": "concept", "front": "Metrics overview", "area": "Metrics"}]
    assert len(quizgen.resolve(items, "metrics")) >= 2       # area 'Metrics' matches several → caller disambiguates


# ---------------- card_context / gen_prompt ----------------

def test_card_context_concept_and_kata():
    term, ctx = quizgen.card_context({"type": "concept", "front": "Precision vs recall — define", "back": "TP/(TP+FP)"})
    assert term == "Precision vs recall" and "TP/(TP+FP)" in ctx
    kterm, kctx = quizgen.card_context({"type": "kata", "title": "Softmax", "prompt": "impl", "reference": "e^x/Σ"})
    assert kterm == "Softmax" and "e^x/Σ" in kctx


def test_gen_prompt_mentions_count_and_grounds_in_card():
    p = quizgen.gen_prompt("CARDBODY", 5)
    assert "5" in p and "CARDBODY" in p and "json" in p.lower()


# ---------------- load_deck ----------------

def test_load_deck_reads_tree(content_tree):
    module, items = quizgen.load_deck("ml")
    assert module == "ml"
    assert {it["id"] for it in items} == {"z-concept", "a-concept", "kata1"}


def test_load_deck_unknown_module_exits(content_tree):
    with pytest.raises(SystemExit):
        quizgen.load_deck("does-not-exist")


# ---------------- run() with the claude call mocked ----------------

def _mock_claude(monkeypatch, questions):
    """Make server.run_claude return a fixed ```json``` block; keep _chat_env hermetic."""
    payload = "```json\n" + json.dumps(questions) + "\n```"
    monkeypatch.setattr(server, "run_claude", lambda *a, **k: (payload, None))
    monkeypatch.setattr(server, "_chat_env", lambda: {})


def _questions(prefix, k):
    return [{"q": f"{prefix} Q{i}?", "choices": ["a", "b", "c", "d"], "answer": i % 4} for i in range(k)]


def _quiz(content_tree, cid):
    return yaml.safe_load(open(f"{content_tree}/ml/{cid}/quiz.yaml"))


def test_run_generates_and_writes_ids(content_tree, monkeypatch):
    _mock_claude(monkeypatch, _questions("A", 5))
    added = quizgen.run("ml", "a-concept", n=5, add=False, force=False, only=set(), limit=0, dry=False)
    assert added == 5
    items = _quiz(content_tree, "a-concept")
    assert [it["id"] for it in items] == [f"a-concept-q{i}" for i in range(5)]
    assert all(set(it) == {"id", "q", "choices", "answer"} for it in items)   # no `term` in quiz.yaml


def test_run_skips_already_covered(content_tree, monkeypatch):
    _mock_claude(monkeypatch, _questions("A", 5))
    quizgen.run("ml", "a-concept", n=5, add=False, force=False, only=set(), limit=0, dry=False)
    added2 = quizgen.run("ml", "a-concept", n=5, add=False, force=False, only=set(), limit=0, dry=False)
    assert added2 == 0
    assert len(_quiz(content_tree, "a-concept")) == 5


def test_run_force_regenerates(content_tree, monkeypatch):
    _mock_claude(monkeypatch, _questions("A", 5))
    quizgen.run("ml", "a-concept", n=5, add=False, force=False, only=set(), limit=0, dry=False)
    _mock_claude(monkeypatch, _questions("B", 5))
    added = quizgen.run("ml", "a-concept", n=5, add=False, force=True, only=set(), limit=0, dry=False)
    items = _quiz(content_tree, "a-concept")
    assert added == 5 and len(items) == 5
    assert items[0]["q"].startswith("B")                              # replaced, not appended


def test_run_add_appends_new_and_continues_ids(content_tree, monkeypatch):
    _mock_claude(monkeypatch, _questions("A", 3))
    quizgen.run("ml", "a-concept", n=3, add=False, force=False, only=set(), limit=0, dry=False)
    _mock_claude(monkeypatch, _questions("B", 2))                     # different text → not deduped away
    added = quizgen.run("ml", "a-concept", n=2, add=True, force=False, only=set(), limit=0, dry=False)
    ids = [it["id"] for it in _quiz(content_tree, "a-concept")]
    assert added == 2 and ids == ["a-concept-q0", "a-concept-q1", "a-concept-q2", "a-concept-q3", "a-concept-q4"]


def test_run_add_dedups_identical_questions(content_tree, monkeypatch):
    _mock_claude(monkeypatch, _questions("A", 3))
    quizgen.run("ml", "a-concept", n=3, add=False, force=False, only=set(), limit=0, dry=False)
    added = quizgen.run("ml", "a-concept", n=3, add=True, force=False, only=set(), limit=0, dry=False)  # same text
    assert added == 0 and len(_quiz(content_tree, "a-concept")) == 3
