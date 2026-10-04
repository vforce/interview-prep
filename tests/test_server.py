"""Tests for the per-concept content tree: server.py's load / assemble / write / delete paths.
Run: `uv run pytest test_server.py` (or `make test`). Uses the `content_tree` fixture in conftest.py."""
import io
import json
import os
import time
import pytest
import yaml
import server


# ---------------- load_decks ----------------

def test_load_decks_ignores_non_deck_dirs(content_tree):
    assert [d["key"] for d in server.load_decks()] == ["ml-srs-v1"]      # rag/ has no deck.yaml → skipped


def test_load_decks_orders_by_order_field_not_alpha(content_tree):
    d = server.load_decks()[0]
    assert [c["id"] for c in d["concepts"]] == ["z-concept", "a-concept"]  # order 0 then 1, not a→z


def test_load_decks_splits_concept_and_kata(content_tree):
    d = server.load_decks()[0]
    assert [c["id"] for c in d["concepts"]] == ["z-concept", "a-concept"]
    assert [k["id"] for k in d["katas"]] == ["kata1"]


def test_load_decks_keeps_kata_test_serverside(content_tree):
    kata = server.load_decks()[0]["katas"][0]
    assert kata["test"] == "assert s(1, 2) == 3"


def test_load_decks_reloads_on_change(content_tree):
    assert server.load_decks()[0]["title"] == "ML"
    time.sleep(0.01)
    with open(f"{content_tree}/ml/deck.yaml", "w") as f:
        f.write("key: ml-srs-v1\ntab: ML\ntitle: Machine Learning\norder: 1\nareas: [Metrics]\n")
    assert server.load_decks()[0]["title"] == "Machine Learning"          # mtime sig busts the cache


def test_decks_for_client_strips_kata_test(content_tree):
    kata = server.decks_for_client()[0]["katas"][0]
    assert "test" not in kata and kata["id"] == "kata1"


# ---------------- load_roadmap ----------------

def test_load_roadmap_sorts_topics_by_order(content_tree):
    r = server.load_roadmap()
    assert [t["id"] for t in r["topics"]] == ["twoptr", "sliding"]         # order 0 then 1, not alpha

def test_load_roadmap_families_and_edges_from_deck(content_tree):
    r = server.load_roadmap()
    assert r["families"]["arrays"]["n"] == "Arrays"
    assert [list(e) for e in r["edges"]] == [["twoptr", "sliding"]]

def test_load_roadmap_is_not_a_study_deck(content_tree):
    assert "algos" not in [d.get("key") for d in server.load_decks()]      # keyless deck.yaml → skipped

def test_load_roadmap_missing_dir_is_empty(content_tree, monkeypatch):
    monkeypatch.setattr(server, "CONTENT_DIR", content_tree + "/nope")
    assert server.load_roadmap() == {"families": {}, "topics": [], "edges": []}

def test_update_topic_writes_insight_preserves_other_fields(content_tree):
    info, err = server.update_topic("sliding", "expand right, shrink left")
    assert err is None and info == {"id": "sliding", "changed": ["insight"]}
    t = next(t for t in server.load_roadmap()["topics"] if t["id"] == "sliding")
    assert t["insight"] == "expand right, shrink left"
    assert t["label"] == "Sliding Window" and t["order"] == 1 and t["probs"][0]["slug"] == "x"

@pytest.mark.parametrize("tid,ins,err", [
    ("sliding", "   ", "insight cannot be empty"),
    ("sliding", 5, "insight cannot be empty"),
    ("../etc/passwd", "x", "bad topic id"),
    ("nope", "x", "unknown topic"),
])
def test_update_topic_guards(content_tree, tid, ins, err):
    assert server.update_topic(tid, ins) == (None, err)


# ---------------- set_prob_premium (roadmap premium-lock toggle) ----------------

def test_set_prob_premium_flags_and_preserves_other_fields(content_tree):
    info, err = server.set_prob_premium("sliding", "x", True)
    assert err is None and info == {"id": "sliding", "slug": "x", "premium": True}
    t = next(t for t in server.load_roadmap()["topics"] if t["id"] == "sliding")
    prob = t["probs"][0]
    assert prob["premium"] is True and prob["slug"] == "x" and prob["n"] == "X"   # flag added, prob intact
    assert t["label"] == "Sliding Window" and t["insight"] == "i"                  # rest of the topic preserved

def test_set_prob_premium_unflag_drops_the_key(content_tree):
    server.set_prob_premium("sliding", "x", True)
    info, err = server.set_prob_premium("sliding", "x", False)
    assert err is None and info["premium"] is False
    prob = next(t for t in server.load_roadmap()["topics"] if t["id"] == "sliding")["probs"][0]
    assert "premium" not in prob                                                   # un-flag removes it (clean diff)

@pytest.mark.parametrize("tid,slug,err", [
    ("../etc/passwd", "x", "bad topic id"),
    ("nope", "x", "unknown topic"),
    ("sliding", "does-not-exist", "unknown problem"),
])
def test_set_prob_premium_guards(content_tree, tid, slug, err):
    assert server.set_prob_premium(tid, slug, True) == (None, err)


# ---------------- POST /api/roadmap/insight (route + _remote_allowed guard) ----------------
# Drive the real Handler through do_POST without a socket: fake the client IP + body, capture the
# status/JSON it writes. This reaches the localhost/ALLOW_REMOTE_GIT matrix a real localhost socket
# (always 127.0.0.1) can't, and covers routing + _save_insight, not just update_topic.
class _FakeReq(server.Handler):
    def __init__(self, ip="127.0.0.1", body=b"{}"):
        self.client_address = (ip, 1234)
        self.path = "/api/roadmap/insight"
        self._b = body if isinstance(body, bytes) else body.encode()
        self.wfile = io.BytesIO()
        self.status = None

    def _body(self): return self._b
    def send_response(self, code): self.status = code
    def send_header(self, *a): pass
    def end_headers(self): pass
    def log_message(self, *a): pass
    def out(self): return json.loads(self.wfile.getvalue() or b"{}")


def _post_insight(ip, payload):
    h = _FakeReq(ip, json.dumps(payload))
    h.do_POST()
    return h.status, h.out()


def _sliding_insight():
    return next(t for t in server.load_roadmap()["topics"] if t["id"] == "sliding")["insight"]


def test_save_insight_localhost_writes(content_tree):
    status, body = _post_insight("127.0.0.1", {"id": "sliding", "insight": "shrink from the left"})
    assert status == 200 and body["ok"] and body["changed"] == ["insight"]
    assert _sliding_insight() == "shrink from the left"

@pytest.mark.parametrize("payload,err", [
    ({"id": "sliding", "insight": "  "}, "insight cannot be empty"),
    ({"id": "../x", "insight": "y"}, "bad topic id"),
    ({"id": "ghost", "insight": "y"}, "unknown topic"),
])
def test_save_insight_guards_return_400(content_tree, payload, err):
    status, body = _post_insight("127.0.0.1", payload)
    assert status == 400 and body["error"] == err

@pytest.mark.parametrize("ip", ["127.0.0.1", "100.100.0.5", "192.168.1.50", "8.8.8.8"])
def test_save_insight_open_to_any_client(content_tree, ip):
    # This host is authoritative: writes are accepted from any client IP — the localhost gate is gone.
    status, body = _post_insight(ip, {"id": "sliding", "insight": f"from {ip}"})
    assert status == 200 and body["ok"]
    assert _sliding_insight() == f"from {ip}"


# ---------------- load_quiz ----------------

def test_load_quiz_aggregates_per_concept(content_tree):
    items = server.load_quiz()["ml-srs-v1"]
    assert {it["id"] for it in items} == {"z-concept-q0", "z-concept-q1"}


def test_load_quiz_injects_term_from_concept(content_tree):
    items = server.load_quiz()["ml-srs-v1"]
    assert all(it["term"] == "Zebra?" for it in items)                    # z-concept's front


def test_load_quiz_skips_malformed_file(content_tree):
    with open(f"{content_tree}/ml/a-concept/quiz.yaml", "w") as f:
        f.write(": : not valid yaml : :\n")
    assert {it["id"] for it in server.load_quiz()["ml-srs-v1"]} == {"z-concept-q0", "z-concept-q1"}


# ---------------- load_topic_quiz (interactive-lesson question bank) ----------------

def _write_topic(root, tid="tq"):
    """A minimal interactive-lesson topic: curriculum + two concept JSONs (aa carries a diagnosticQuiz)."""
    base = f"{root}/{tid}"
    os.makedirs(f"{base}/concepts", exist_ok=True)
    with open(f"{base}/curriculum.json", "w") as f:
        json.dump({"concepts": [{"id": "aa", "title": "Alpha"}, {"id": "bb", "title": "Beta"}]}, f)
    with open(f"{base}/concepts/aa.json", "w") as f:
        json.dump({"diagnosticQuiz": [
            {"q": "Q1?", "choices": ["a", "b", "c", "d"], "answer": 1, "explanation": "why"},
            {"q": "Q2?", "choices": ["a", "b", "c", "d"], "answer": 0},
        ]}, f)
    with open(f"{base}/concepts/bb.json", "w") as f:
        json.dump({"diagnosticQuiz": [{"q": "Q3?", "choices": ["a", "b", "c", "d"], "answer": 2}]}, f)
    return base


def test_load_topic_quiz_aggregates_in_curriculum_order(content_tree):
    _write_topic(content_tree)
    bank = server.load_topic_quiz("tq")
    assert [b["q"] for b in bank] == ["Q1?", "Q2?", "Q3?"]               # flattened, curriculum order
    assert [b["term"] for b in bank] == ["Alpha", "Alpha", "Beta"]      # concept title becomes the label
    assert bank[0]["answer"] == 1 and bank[0]["explanation"] == "why"   # answer/explanation carried through


def test_load_topic_quiz_tolerates_missing_concept_file(content_tree):
    base = _write_topic(content_tree)
    os.remove(f"{base}/concepts/aa.json")                               # an unreadable concept contributes nothing
    assert [b["q"] for b in server.load_topic_quiz("tq")] == ["Q3?"]


def test_load_topic_quiz_rejects_unsafe_id(content_tree):
    assert server.load_topic_quiz("../server") == []                    # path-traversal guard


def test_load_topic_quiz_missing_topic_is_empty(content_tree):
    assert server.load_topic_quiz("nope") == []                         # no curriculum.json → []


# ---------------- update_card ----------------

def test_update_card_writes_and_preserves_other_fields(content_tree):
    info, err = server.update_card("ml-srs-v1", "a-concept", {"back": "An edible fruit."})
    assert err is None and info == {"id": "a-concept", "kind": "concept", "changed": ["back"]}
    got = yaml.safe_load(open(f"{content_tree}/ml/a-concept/data.yaml"))
    assert got["back"] == "An edible fruit."
    assert (got["more"], got["id"], got["order"], got["front"]) == ("Rosaceae.", "a-concept", 1, "Apple?")


def test_update_card_kata_uses_kata_fields(content_tree):
    info, err = server.update_card("ml-srs-v1", "kata1", {"prompt": "add two ints"})
    assert err is None and info["kind"] == "kata"
    assert yaml.safe_load(open(f"{content_tree}/ml/kata1/data.yaml"))["prompt"] == "add two ints"


@pytest.mark.parametrize("deck,cid,fields,expected", [
    ("ml-srs-v1", "a-concept", {"front": "   "}, "field 'front' cannot be empty"),
    ("ml-srs-v1", "../etc/passwd", {"back": "x"}, "bad card id"),
    ("ml-srs-v1", "does-not-exist", {"back": "x"}, "unknown card"),
    ("nope-deck", "a-concept", {"back": "x"}, "unknown deck"),
    ("ml-srs-v1", "a-concept", {"not_a_field": "x"}, "no valid fields to update"),
    ("ml-srs-v1", "kata1", {"back": "x"}, "no valid fields to update"),        # `back` isn't a kata field
])
def test_update_card_guards(content_tree, deck, cid, fields, expected):
    info, err = server.update_card(deck, cid, fields)
    assert info is None and err == expected


def test_update_card_does_not_write_on_reject(content_tree):
    before = open(f"{content_tree}/ml/a-concept/data.yaml").read()
    server.update_card("ml-srs-v1", "a-concept", {"front": "  "})
    assert open(f"{content_tree}/ml/a-concept/data.yaml").read() == before


# ---------------- update_concept (interactive-lesson pages) ----------------

def _seed_concept(content_tree):
    """A minimal git-tracked concept JSON under a topic, like seed.py writes."""
    cdir = f"{content_tree}/rag/concepts"
    os.makedirs(cdir, exist_ok=True)
    p = f"{cdir}/bm25.json"
    with open(p, "w") as f:
        json.dump({"id": "bm25", "title": "BM25", "definition": "Old def.", "summary": "S",
                   "objectives": ["a", "b"], "lesson": "Old lesson.", "examples": "E", "tradeoffs": "T",
                   "diagnosticQuiz": [{"q": "?"}], "version": 5,
                   "metadata": {"inputHash": "KEEPME", "model": "sonnet"}}, f)
    return p


def test_update_concept_writes_bumps_version_preserves_hash(content_tree):
    p = _seed_concept(content_tree)
    info, err = server.update_concept("rag", "bm25",
                                      {"lesson": "New body.\n", "objectives": ["x", "y", "z"],
                                       "diagnosticQuiz": []})           # quiz field ignored — out of scope
    assert err is None
    assert info == {"topic": "rag", "concept": "bm25", "changed": ["lesson", "objectives"]}
    got = json.load(open(p))
    assert got["lesson"] == "New body."                                 # trailing newline stripped
    assert got["objectives"] == ["x", "y", "z"]
    assert got["version"] == 6                                          # bumped
    assert got["metadata"]["inputHash"] == "KEEPME"                     # preserved → hand-edit survives future seed.py
    assert got["diagnosticQuiz"] == [{"q": "?"}]                        # untouched


@pytest.mark.parametrize("topic,cid,fields,expected", [
    ("rag", "bm25", {"lesson": "   "}, "field 'lesson' cannot be empty"),
    ("rag", "bm25", {"objectives": []}, "objectives cannot be empty"),
    ("rag", "../etc", {"lesson": "x"}, "bad id"),                       # concept id traversal
    ("../x", "bm25", {"lesson": "x"}, "bad id"),                        # topic id traversal
    ("rag", "nope", {"lesson": "x"}, "unknown concept"),
    ("rag", "bm25", {"nope": "x"}, "no valid fields to update"),        # unknown field dropped
    ("rag", "bm25", {"objectives": "not a list"}, "no valid fields to update"),
])
def test_update_concept_guards(content_tree, topic, cid, fields, expected):
    _seed_concept(content_tree)
    info, err = server.update_concept(topic, cid, fields)
    assert info is None and err == expected


def test_update_concept_does_not_write_on_reject(content_tree):
    p = _seed_concept(content_tree)
    before = open(p).read()
    server.update_concept("rag", "bm25", {"lesson": "   "})
    assert open(p).read() == before


# ---------------- _safe_id ----------------

@pytest.mark.parametrize("cid,ok", [
    ("m-roc-pr", True), ("kata1", True),
    ("../etc", False), ("a/b", False), ("a\\b", False), ("..", False), ("", False), (None, False),
])
def test_safe_id(cid, ok):
    assert server._safe_id(cid) is ok


# ---------------- delete_quiz ----------------

def test_delete_quiz_removes_one(content_tree):
    assert server.delete_quiz("ml-srs-v1", "z-concept-q0") == (True, None)
    assert {it["id"] for it in server.load_quiz()["ml-srs-v1"]} == {"z-concept-q1"}


def test_delete_quiz_removes_file_when_empty(content_tree):
    server.delete_quiz("ml-srs-v1", "z-concept-q0")
    server.delete_quiz("ml-srs-v1", "z-concept-q1")
    assert not os.path.exists(f"{content_tree}/ml/z-concept/quiz.yaml")


def test_delete_quiz_unknown_id(content_tree):
    assert server.delete_quiz("ml-srs-v1", "z-concept-q9") == (False, "not found")


def test_delete_quiz_unknown_concept(content_tree):
    assert server.delete_quiz("ml-srs-v1", "no-such-q0") == (False, "not found")


# ---------------- LeetCode tag enrichment (_enrich_recent) ----------------

@pytest.fixture
def tag_cache(tmp_path, monkeypatch):
    """Point the lc-tags.json cache at a temp file. Yields its Path."""
    f = tmp_path / "lc-tags.json"
    monkeypatch.setattr(server, "LC_TAGS_FILE", str(f))
    monkeypatch.setattr(server.time, "sleep", lambda _s: None)
    return f


def _stub_gql(monkeypatch, tags_by_slug, calls):
    def fake(_query, variables):
        sl = (variables or {}).get("slug")
        calls.append(sl)
        if sl not in tags_by_slug:
            return {"data": {"question": None}}                  # unknown slug / throttled
        return {"data": {"question": {"title": sl, "difficulty": "Medium",
                                      "topicTags": [{"name": t} for t in tags_by_slug[sl]]}}}
    monkeypatch.setattr(server, "_gql", fake)


def test_enrich_recent_fetches_tags_the_cache_is_missing(tag_cache, monkeypatch):
    # A brand-new solve is exactly the uncached case. Returning empty tags let the client's famOf()
    # resolve "other", so the problem's family kept reporting a stale "practiced N days ago".
    calls = []
    _stub_gql(monkeypatch, {"house-robber": ["Array", "Dynamic Programming"]}, calls)
    out = server._enrich_recent([{"slug": "house-robber", "ts": 1}])
    assert out[0]["tags"] == ["Array", "Dynamic Programming"]
    assert calls == ["house-robber"]
    assert json.loads(tag_cache.read_text())["house-robber"]["tags"] == ["Array", "Dynamic Programming"]


def test_enrich_recent_uses_the_cache_without_calling_leetcode(tag_cache, monkeypatch):
    calls = []
    tag_cache.write_text(json.dumps({"daily-temperatures": {
        "title": "Daily Temperatures", "difficulty": "Medium", "tags": ["Array", "Stack", "Monotonic Stack"]}}))
    _stub_gql(monkeypatch, {}, calls)
    out = server._enrich_recent([{"slug": "daily-temperatures", "ts": 1}])
    assert out[0]["tags"] == ["Array", "Stack", "Monotonic Stack"]
    assert calls == []                                           # cached → no network


def test_enrich_recent_does_not_cache_a_failed_lookup(tag_cache, monkeypatch):
    # Empty tags for this call, but nothing written — else one throttled call pins the slug to
    # "no tags" forever and its family can never be freshened by a sync again.
    calls = []
    _stub_gql(monkeypatch, {}, calls)
    out = server._enrich_recent([{"slug": "brand-new", "ts": 1}])
    assert out[0]["tags"] == []
    assert not tag_cache.exists()


def test_enrich_recent_caps_fetches_and_still_tags_the_cached_rest(tag_cache, monkeypatch):
    calls = []
    _stub_gql(monkeypatch, {f"new-{i}": ["Dynamic Programming"] for i in range(25)}, calls)
    recent = [{"slug": f"new-{i}", "ts": i} for i in range(25)]
    out = server._enrich_recent(recent)
    assert len(calls) == 20                                      # bounded; the rest fill in next sync
    assert [r["tags"] for r in out[:20]] == [["Dynamic Programming"]] * 20
    assert [r["tags"] for r in out[20:]] == [[]] * 5
