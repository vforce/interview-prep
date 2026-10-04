#!/usr/bin/env python3
"""Local server for the Recovery Roadmap.

Serves roadmap.html, proxies LeetCode server-side, runs the coding katas, and —
new — powers the per-card "Ask Claude" chat that uses your LOCAL Claude Code
session (no API key) to progressively improve the study content.

    python3 server.py            # → http://localhost:8000/  (bare root serves the app)
    python3 server.py 9000       # custom port

Study content (ML/LLM/… decks) lives in content/*.yaml — that's the source of
truth, edited by hand AND written back by the in-app "improve this card" flow.
Adding a new section (e.g. system design) is just dropping in another YAML file.

Stdlib only, plus PyYAML for the content files (pip3 install pyyaml).

LeetCode sync: by default it can only see your ~20 most recent solves (public
profile). For your FULL solved history, drop in your session cookie (stays in
your shell env, never written to disk):

    export LEETCODE_SESSION='...'   # DevTools → Application → Cookies → leetcode.com
    export LEETCODE_CSRF='...'      # the csrftoken cookie (optional)
    python3 server.py

Local-Claude chat: shells out to the `claude` CLI in print mode, authenticated
via your existing session — no API key. It runs against an isolated config dir
(.cc-chat/) holding only your apiKeyHelper, so it skips hooks/plugins and stays
fast. Override the model with CLAUDE_CHAT_MODEL (default: sonnet).
"""
import json, os, re, subprocess, sys, urllib.request, getpass, shutil, time
from types import SimpleNamespace
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote

try:
    import yaml
except ImportError:
    sys.exit("This server needs PyYAML for the study-content files.\n  pip3 install pyyaml")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONTENT_DIR = os.path.join(BASE_DIR, "content")
STATE_FILE = os.path.join(BASE_DIR, "state.json")  # durable, port-independent progress
# Unified state: if STATE_BACKEND is set (e.g. the local dev server points at the always-on host),
# /api/state is proxied there — ONE source of truth, no cross-machine divergence. The host itself
# leaves it unset and owns the file; the local file becomes an offline read-cache.
STATE_BACKEND = os.environ.get("STATE_BACKEND", "").rstrip("/")


def read_state():
    if STATE_BACKEND:
        try:
            with urllib.request.urlopen(STATE_BACKEND + "/api/state", timeout=6) as r:
                data = r.read()
            remote = json.loads(data)
            with open(STATE_FILE, "wb") as f:              # refresh the offline cache
                f.write(data)
            return remote
        except Exception:
            pass                                           # backend down → serve the last cached snapshot
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def write_state(data):
    """data = already-validated raw JSON bytes. Returns (ok, error)."""
    if STATE_BACKEND:
        try:
            req = urllib.request.Request(STATE_BACKEND + "/api/state", data=data,
                                         headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=6) as r:
                r.read()
            return True, None
        except Exception as e:
            return False, "state backend unreachable: " + str(e)   # browser keeps localStorage, retries next change
    with open(STATE_FILE, "wb") as f:
        f.write(data)
    return True, None


# ---- per-user, per-topic learner progress (interactive lessons) ----
# Same "single source of truth" discipline as state.json: when STATE_BACKEND is set the
# dev server proxies to the host; the host owns the files under progress/<user>/<topic>.json.
PROGRESS_DIR = os.path.join(BASE_DIR, "progress")


def _progress_path(user, topic):
    safe = lambda s: re.sub(r"[^A-Za-z0-9_-]", "", s or "")     # no path traversal
    return os.path.join(PROGRESS_DIR, safe(user) or "me", (safe(topic) or "topic") + ".json")


def _progress_url(user, topic):
    return f"{STATE_BACKEND}/api/topic/{quote(topic)}/progress?user={quote(user)}"


def read_progress(user, topic):
    if STATE_BACKEND:
        try:
            with urllib.request.urlopen(_progress_url(user, topic), timeout=6) as r:
                return json.loads(r.read())
        except Exception:
            pass                                               # backend down → local cache
    try:
        with open(_progress_path(user, topic)) as f:
            return json.load(f)
    except Exception:
        return {}


def write_progress(user, topic, data):
    """data = already-validated raw JSON bytes. Returns (ok, error)."""
    if STATE_BACKEND:
        try:
            req = urllib.request.Request(_progress_url(user, topic), data=data,
                                         headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=6) as r:
                r.read()
            return True, None
        except Exception as e:
            return False, "progress backend unreachable: " + str(e)
    path = _progress_path(user, topic)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)                                      # atomic
    return True, None


# ---- local-Claude chat config ----
CHAT_MODEL = os.environ.get("CLAUDE_CHAT_MODEL", "sonnet")
CHAT_CONFIG_DIR = os.environ.get("CLAUDE_CHAT_CONFIG_DIR", os.path.join(BASE_DIR, ".cc-chat"))
CLAUDE_BIN = shutil.which("claude") or "claude"
TUTOR_SYS = (
    "You are an expert technical interview-prep tutor. The user is studying a flashcard "
    "(machine learning, large language models, and CS interview topics). Be accurate, concrete, "
    "and concise — short paragraphs, small worked examples, and real intuition, no filler. "
    "Never invent facts; if you are unsure, say so plainly. Do not use tools.\n"
    "Format with GitHub-flavored markdown. Put code, equations, traces, and ASCII diagrams or tables "
    "inside fenced ``` code blocks so they stay monospaced and aligned; use real markdown tables only for "
    "tabular data. Keep it focused — don't pad."
)

SESSION = os.environ.get("LEETCODE_SESSION", "")
CSRF = os.environ.get("LEETCODE_CSRF", "")
UA = "Mozilla/5.0 (recovery-roadmap)"
LEVELS = {1: "Easy", 2: "Medium", 3: "Hard"}


# ==================== study-content decks (content/*.yaml) ====================
_deck_cache = {"sig": None, "decks": [], "paths": {}}


def _module_dirs():
    """content/<module>/ dirs that hold a deck.yaml — one per study deck (ml, llm, …)."""
    out = []
    if os.path.isdir(CONTENT_DIR):
        for name in sorted(os.listdir(CONTENT_DIR)):
            d = os.path.join(CONTENT_DIR, name)
            if os.path.isdir(d) and os.path.exists(os.path.join(d, "deck.yaml")):
                out.append((name, d))
    return out


def _content_sig():
    sig = []
    for name, d in _module_dirs():
        sig.append((name, os.path.getmtime(os.path.join(d, "deck.yaml"))))
        for concept in sorted(os.listdir(d)):
            dp = os.path.join(d, concept, "data.yaml")
            if os.path.exists(dp):
                sig.append((name + "/" + concept, os.path.getmtime(dp)))
    return tuple(sig)


def load_decks():
    """Assemble each deck from content/<module>/deck.yaml + every <concept>/data.yaml, re-read
    whenever a file changes. Output shape matches the old single-file decks, so clients don't change."""
    sig = _content_sig()
    if sig != _deck_cache["sig"]:
        decks, paths = [], {}
        for name, mdir in _module_dirs():
            try:
                deck = yaml.safe_load(open(os.path.join(mdir, "deck.yaml"))) or {}
            except Exception as e:
                print(f"  ! skipping {name}/deck.yaml: {e}")
                continue
            if not deck.get("key"):
                continue
            concepts, katas = [], []
            for concept in sorted(os.listdir(mdir)):
                dp = os.path.join(mdir, concept, "data.yaml")
                if not os.path.exists(dp):
                    continue
                try:
                    card = yaml.safe_load(open(dp)) or {}
                except Exception as e:
                    print(f"  ! skipping {name}/{concept}/data.yaml: {e}")
                    continue
                (katas if card.get("type") == "kata" else concepts).append(card)
            deck["concepts"] = sorted(concepts, key=lambda c: c.get("order", 99))
            deck["katas"] = sorted(katas, key=lambda c: c.get("order", 99))
            decks.append(deck)
            paths[deck["key"]] = mdir                       # module dir → target for card/quiz writes
        decks.sort(key=lambda d: (d.get("order", 99), d.get("title", "")))
        _deck_cache.update(sig=sig, decks=decks, paths=paths)
    return _deck_cache["decks"]


def decks_for_client():
    """Decks for the browser: drop private keys and the server-only kata test harnesses."""
    out = []
    for d in load_decks():
        d2 = {k: v for k, v in d.items() if not k.startswith("_")}
        if d2.get("katas"):
            d2["katas"] = [{k: v for k, v in kata.items() if k != "test"} for kata in d2["katas"]]
        out.append(d2)
    return out


# ==================== algorithms roadmap (content/algos/) ====================
# Same content convention as the decks (deck.yaml + per-topic data.yaml), but it's a prerequisite
# node map, not an SRS deck — its deck.yaml has no `key`, so load_decks() skips it. Served to the
# browser as `window.ROADMAP` by /api/roadmap.js so roadmap.html's synchronous init needs no fetch.
def load_roadmap():
    """Assemble the algorithms roadmap: content/algos/deck.yaml (families + prerequisite edges) plus
    every <topic>/data.yaml, sorted by `order`. Shape matches the old inline FAM / P / E literals."""
    adir = os.path.join(CONTENT_DIR, "algos")                 # read CONTENT_DIR fresh, like load_decks
    if not os.path.isdir(adir):
        return {"families": {}, "topics": [], "edges": []}
    cfg = yaml.safe_load(open(os.path.join(adir, "deck.yaml"))) or {}
    topics = []
    for name in sorted(os.listdir(adir)):                     # ponytail: re-reads each call; ~40 tiny
        dp = os.path.join(adir, name, "data.yaml")            # YAMLs read once per page load — fine
        if os.path.exists(dp):
            topics.append(yaml.safe_load(open(dp)) or {})
    topics.sort(key=lambda t: t.get("order", 99))
    return {"families": cfg.get("families", {}), "topics": topics, "edges": cfg.get("edges", [])}


_ALGOS_HEADER = "# One algorithms-roadmap topic. `id` is stable — it keys progress. Don't rename it.\n\n"


def update_topic(topic_id, insight):
    """Rewrite one algorithms topic's `insight` in content/algos/<id>/data.yaml, preserving every other
    field. Returns (info, error). Uses the same seeded flow-style so the diff is just the insight line."""
    if not _safe_id(topic_id):
        return None, "bad topic id"
    if not isinstance(insight, str) or not insight.strip():
        return None, "insight cannot be empty"
    dp = os.path.join(CONTENT_DIR, "algos", topic_id, "data.yaml")
    if not os.path.exists(dp):
        return None, "unknown topic"
    try:
        topic = yaml.safe_load(open(dp)) or {}
    except Exception as e:
        return None, f"could not read topic: {e}"
    topic["insight"] = insight.rstrip("\n")
    _dump_yaml(dp, topic, _ALGOS_HEADER, default_flow_style=None)
    return {"id": topic_id, "changed": ["insight"]}, None


def set_prob_premium(topic_id, slug, premium):
    """Flag/unflag one roadmap problem as LeetCode-premium in content/algos/<id>/data.yaml, preserving
    every other field (and the seeded inline flow-style). Absent field == not premium, so un-flagging
    drops the key entirely for a clean diff. Returns (info, error)."""
    if not _safe_id(topic_id):
        return None, "bad topic id"
    dp = os.path.join(CONTENT_DIR, "algos", topic_id, "data.yaml")
    if not os.path.exists(dp):
        return None, "unknown topic"
    try:
        topic = yaml.safe_load(open(dp)) or {}
    except Exception as e:
        return None, f"could not read topic: {e}"
    prob = next((q for q in topic.get("probs", []) if q.get("slug") == slug), None)
    if prob is None:
        return None, "unknown problem"
    if premium:
        prob["premium"] = True
    else:
        prob.pop("premium", None)
    _dump_yaml(dp, topic, _ALGOS_HEADER, default_flow_style=None)
    return {"id": topic_id, "slug": slug, "premium": bool(premium)}, None


def find_card(deck_key, card_id):
    for d in load_decks():
        if d.get("key") != deck_key:
            continue
        for c in d.get("concepts", []):
            if c.get("id") == card_id:
                return d, "concept", c
        for k in d.get("katas", []):
            if k.get("id") == card_id:
                return d, "kata", k
    return None, None, None


def kata_test(card_id):
    for d in load_decks():
        for k in d.get("katas", []):
            if k.get("id") == card_id:
                return k.get("test")
    return None


# ---- write a card edit back to its YAML, atomically and with minimal diff ----
ALLOWED_FIELDS = {"concept": ("front", "back", "more"),
                  "kata": ("title", "prompt", "sig", "stub", "reference")}
REQUIRED = {"front", "back", "title", "prompt", "sig", "reference"}


class _BlockDumper(yaml.SafeDumper):
    pass


def _str_rep(dumper, data):
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_BlockDumper.add_representer(str, _str_rep)


_CARD_HEADER = "# One study card. `id` is stable — it keys spaced-repetition progress. Don't rename it.\n\n"


def _safe_id(cid):                        # card/concept ids become path components — keep them harmless
    return isinstance(cid, str) and bool(cid) and "/" not in cid and "\\" not in cid and ".." not in cid


def _dump_yaml(path, obj, header="", default_flow_style=False):
    """Atomic YAML write with block scalars for multiline strings (readable, minimal diff).
    default_flow_style=None keeps leaf collections inline (roadmap topics — matches how they were seeded)."""
    body = yaml.dump(obj, Dumper=_BlockDumper, sort_keys=False, allow_unicode=True,
                     width=4096, default_flow_style=default_flow_style)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(header + body)
    os.replace(tmp, path)                 # atomic: never leaves a half-written content file


def update_card(deck_key, card_id, fields):
    """Apply field edits to one card and rewrite its content/<module>/<id>/data.yaml. Returns (info, error)."""
    load_decks()
    mdir = _deck_cache["paths"].get(deck_key)
    if not mdir:
        return None, "unknown deck"
    if not _safe_id(card_id):
        return None, "bad card id"
    dp = os.path.join(mdir, card_id, "data.yaml")
    if not os.path.exists(dp):
        return None, "unknown card"
    try:
        card = yaml.safe_load(open(dp)) or {}
    except Exception as e:
        return None, f"could not read card: {e}"
    kind = card.get("type", "concept")
    changed = {}
    for f, v in (fields or {}).items():
        if f not in ALLOWED_FIELDS.get(kind, ()) or not isinstance(v, str):
            continue
        v = v.rstrip("\n")
        if f in REQUIRED and not v.strip():
            return None, f"field '{f}' cannot be empty"
        card[f] = v
        changed[f] = v
    if not changed:
        return None, "no valid fields to update"
    _dump_yaml(dp, card, _CARD_HEADER)
    _deck_cache["sig"] = None             # force a reload on next read
    return {"id": card_id, "kind": kind, "changed": list(changed)}, None


# ============ interactive-lesson concept edits (content/<topic>/concepts/<id>.json) ============
# A concept page's prose is markdown inside a git-tracked JSON file authored offline by seed.py.
# The in-app "✦ Refine" flow edits it here — the topic-system analog of update_card. Bump `version`
# but leave metadata.inputHash alone: inputHash keys on name/prereqs/prompt (not prose), so a later
# `seed.py <topic>` still sees the concept as up-to-date and won't clobber the hand edit.
CONCEPT_PROSE = ("definition", "summary", "lesson", "examples", "tradeoffs")   # strings; `objectives` is a list


def _write_json_atomic(path, obj):
    """Atomic JSON write matching seed._write_json's format (indent=2) for a minimal git diff."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)                 # never leave a half-written content file


def _concept_path(topic, cid):
    """content/<topic>/concepts/<cid>.json, or None if either id is unsafe as a path component."""
    if not (_safe_id(topic) and _safe_id(cid)):
        return None
    return os.path.join(CONTENT_DIR, topic, "concepts", cid + ".json")


def update_concept(topic, cid, fields):
    """Apply prose edits to one concept page and rewrite its JSON. Returns (info, error)."""
    p = _concept_path(topic, cid)
    if not p:
        return None, "bad id"
    if not os.path.isfile(p):
        return None, "unknown concept"
    try:
        data = json.load(open(p))
    except Exception as e:
        return None, f"could not read concept: {e}"
    changed = []
    for f, v in (fields or {}).items():
        if f == "objectives":
            if not isinstance(v, list):
                continue
            items = [str(x).strip() for x in v if str(x).strip()]
            if not items:
                return None, "objectives cannot be empty"
            data["objectives"] = items
            changed.append(f)
        elif f in CONCEPT_PROSE and isinstance(v, str):
            v = v.rstrip("\n")
            if not v.strip():
                return None, f"field '{f}' cannot be empty"
            data[f] = v
            changed.append(f)
    if not changed:
        return None, "no valid fields to update"
    data["version"] = (data.get("version", 0) or 0) + 1   # metadata (incl. inputHash) untouched
    _write_json_atomic(p, data)
    return {"topic": topic, "concept": cid, "changed": changed}, None


# ==================== quiz bank (per-concept content/<module>/<concept>/quiz.yaml) ====================
# Each concept dir holds quiz.yaml = [ {id, q, choices[4], answer} ]. Generated offline by quizgen.py
# (git-tracked); runtime only reads them + deletes single questions. Test mode aggregates per deck.
def _quiz_path(deck_key, concept_id):
    mdir = _deck_cache["paths"].get(deck_key)
    return os.path.join(mdir, concept_id, "quiz.yaml") if mdir and _safe_id(concept_id) else None


def load_quiz():
    """Aggregate every content/<module>/<concept>/quiz.yaml into {deck_key: [questions]}, injecting
    each concept's label as `term` (the Test-tab meta line reads q.term)."""
    store = {}
    for d in load_decks():
        key, mdir = d["key"], _deck_cache["paths"].get(d["key"])
        bucket = store.setdefault(key, [])
        if not mdir:
            continue
        label = {c["id"]: c.get("front", "") for c in d.get("concepts", [])}
        label.update({k["id"]: k.get("title", "") for k in d.get("katas", [])})
        for concept in sorted(os.listdir(mdir)):
            qp = os.path.join(mdir, concept, "quiz.yaml")
            if not os.path.exists(qp):
                continue
            try:
                items = yaml.safe_load(open(qp)) or []
            except Exception:
                continue
            for it in items if isinstance(items, list) else []:
                if isinstance(it, dict) and it.get("q"):
                    bucket.append({**it, "term": it.get("term") or label.get(concept, concept)})
    return store


def load_topic_quiz(topic):
    """Aggregate an interactive-lesson topic's per-concept `diagnosticQuiz` into one flat bank — the
    topic-system analog of load_quiz() for decks. Each item carries its concept id + title so the drill
    can label questions and the client can key spaced-repetition state by (cid, question), sharing the
    reader's `__quizSrs` store. Reads live from content/<topic>/concepts/*.json, ordered by curriculum."""
    if not _safe_id(topic):
        return []
    base = os.path.join(CONTENT_DIR, topic)
    try:
        concepts = json.load(open(os.path.join(base, "curriculum.json"))).get("concepts", [])
    except Exception:
        return []
    bank = []
    for c in concepts:
        cid = c.get("id")
        if not _safe_id(cid or ""):
            continue
        try:
            d = json.load(open(os.path.join(base, "concepts", cid + ".json")))
        except Exception:
            continue                                       # a missing/unreadable concept just contributes nothing
        for q in (d.get("diagnosticQuiz") or []):
            if q.get("q"):
                bank.append({"cid": cid, "term": c.get("title", cid), "q": q["q"],
                             "choices": q.get("choices"), "answer": q.get("answer"),
                             "explanation": q.get("explanation")})
    return bank


def _extract_json(text):
    """Pull a JSON value from a model reply that may wrap it in a ```json fence. Reused by seed.py + quizgen.py."""
    m = re.search(r"```json\s*(.*?)```", text, re.S) or re.search(r"```\s*(.*?)```", text, re.S)
    return json.loads((m.group(1) if m else text).strip())


def delete_quiz(deck_key, qid):
    """Remove one question from its concept's quiz.yaml (concept = qid minus its -qN suffix).
    Returns (ok, error); removes the file once it empties out."""
    load_decks()
    qp = _quiz_path(deck_key, str(qid).rsplit("-", 1)[0])
    if not qp or not os.path.exists(qp):
        return False, "not found"
    try:
        items = yaml.safe_load(open(qp)) or []
    except Exception:
        return False, "could not read quiz.yaml"
    kept = [q for q in items if q.get("id") != qid]
    if len(kept) == len(items):
        return False, "not found"
    if kept:
        _dump_yaml(qp, kept, "# Quiz questions for this concept — each has a unique id.\n\n")
    else:
        os.remove(qp)
    _deck_cache["sig"] = None
    return True, None


# ==================== interactive-lesson topics (content/<id>/manifest.json) ====================
# Author-once/serve-many (specs/interactive_lesson.md). seed.py generates the per-topic artifacts
# offline; runtime only lists published manifests here — the curriculum/graph/concept JSON are
# plain static files under content/<id>/, served by the base handler. No LLM at runtime.
_topic_cache = {"sig": None, "list": []}


def _topics_sig():
    sig = []
    try:
        for name in sorted(os.listdir(CONTENT_DIR)):
            mpath = os.path.join(CONTENT_DIR, name, "manifest.json")
            if os.path.isfile(mpath):
                sig.append((name, os.path.getmtime(mpath)))
    except FileNotFoundError:
        pass
    return tuple(sig)


def load_topics():
    """Published topic manifests, mtime-cached (mirrors load_decks)."""
    sig = _topics_sig()
    if _topic_cache["sig"] == sig:
        return _topic_cache["list"]
    out = []
    for name, _ in sig:
        try:
            m = json.load(open(os.path.join(CONTENT_DIR, name, "manifest.json")))
        except Exception:
            continue
        if m.get("status") == "published":
            out.append(m)
    out.sort(key=lambda m: m.get("title", m.get("id", "")))
    _topic_cache.update(sig=sig, list=out)
    return out


# ==================== local Claude Code chat (no API key) ====================
def _api_key_helper():
    """The apiKeyHelper from the user's real settings — this is what authenticates the CLI."""
    try:
        s = json.load(open(os.path.expanduser("~/.claude/settings.json")))
        h = s.get("apiKeyHelper")
        return h.replace("$(whoami)", getpass.getuser()) if h else None
    except Exception:
        return None


def _chat_env():
    """Env for the claude subprocess. If an apiKeyHelper exists we point CLAUDE_CONFIG_DIR at an
    isolated dir holding ONLY that helper — authenticated, but no hooks/plugins, so it stays fast
    and clean. Otherwise we fall back to the default config (slower, but always works)."""
    env = os.environ.copy()
    helper = _api_key_helper()
    if helper:
        try:
            os.makedirs(CHAT_CONFIG_DIR, exist_ok=True)
            want = json.dumps({"apiKeyHelper": helper})
            sp = os.path.join(CHAT_CONFIG_DIR, "settings.json")
            if not os.path.exists(sp) or open(sp).read() != want:
                open(sp, "w").write(want)
            env["CLAUDE_CONFIG_DIR"] = CHAT_CONFIG_DIR
        except Exception:
            pass
    return env


def _card_context(deck, kind, card):
    title = deck.get("title", "")
    if kind == "kata":
        return (f"Subject: {title} (coding kata)\nKata: {card.get('title', '')}\n"
                f"Prompt: {card.get('prompt', '')}\nSignature: {card.get('sig', '')}\n"
                f"Reference solution:\n{card.get('reference', '')}")
    parts = [f"Subject: {title}",
             f"Question (front): {card.get('front', '')}",
             f"Current answer (back):\n{card.get('back', '')}"]
    if card.get("more"):
        parts.append(f"Deeper notes (more):\n{card.get('more')}")
    return "\n\n".join(parts)


def _build_prompt(deck, kind, card, messages, mode):
    ctx = _card_context(deck, kind, card)
    convo = "\n\n".join(("User" if m.get("role") == "user" else "Assistant") + ": " + (m.get("content") or "")
                        for m in (messages or []))
    base = f"Here is the flashcard the user is reviewing:\n\n----- CARD -----\n{ctx}\n----- END CARD -----\n\n"
    if mode == "improve":
        keys = "front, back, more" if kind != "kata" else "title, prompt, reference"
        if convo:
            base += f"Conversation so far:\n{convo}\n\n"
        return base + (
            "The user wants to IMPROVE this card. Propose a better version — more correct, clearer, with a "
            "concrete example where it helps — keeping the same concise study-card style.\n"
            f"Reply with EXACTLY one fenced ```json code block containing only the fields you want to change "
            f"(allowed keys: {keys}); keep newlines as \\n inside the strings. After the code block, add ONE "
            "short sentence on what you improved. No other commentary before the block.")
    return base + f"Conversation:\n{convo}\n\nRespond as the tutor to the latest user message."


# Concept "Refine" chat: like _build_prompt's improve mode, but for a topic concept page. The model
# replies in seed.py's @@SECTION grammar (robust to markdown/code fences — see seed._split_sections)
# with ONLY the changed sections; the client parses those into fields and POSTs /api/concept.
_SECTION_OF = {"definition": "DEFINITION", "summary": "SUMMARY", "objectives": "OBJECTIVES",
               "lesson": "LESSON", "examples": "EXAMPLES", "tradeoffs": "TRADEOFFS"}


def _build_refine_prompt(topic, data, messages):
    def section(f):
        body = ("\n".join("- " + o for o in (data.get("objectives") or []))
                if f == "objectives" else str(data.get(f) or "").strip())
        return f"@@{_SECTION_OF[f]}\n{body}"
    current = "\n\n".join(section(f) for f in _SECTION_OF)
    convo = "\n\n".join(("User" if m.get("role") == "user" else "Assistant") + ": " + (m.get("content") or "")
                        for m in (messages or []))
    base = (f'The user is refining one concept page ("{data.get("title", "")}") from the interactive '
            f'lesson on "{topic}". Here is its current editable content:\n\n'
            f"----- CURRENT -----\n{current}\n----- END -----\n\n")
    if convo:
        base += f"Conversation so far:\n{convo}\n\n"
    return base + (
        "Apply the user's latest instruction to this page. Output ONLY the sections you are CHANGING, each "
        "introduced by its EXACT @@NAME marker line (allowed: @@DEFINITION, @@SUMMARY, @@OBJECTIVES, @@LESSON, "
        "@@EXAMPLES, @@TRADEOFFS), then a final @@END. Re-emit each changed section's FULL new text (not a diff), "
        "cumulatively re-including earlier changes you still want to keep. Markdown/fenced code is allowed inside "
        "sections — write it naturally, no JSON, no escaping. @@OBJECTIVES: three to five lines each starting with "
        "'- '. No prose before the first marker; after @@END add ONE short sentence on what you changed.")


def run_claude(prompt, env, timeout=180):
    """Run the local claude CLI in print mode. Returns (text, error).
    timeout defaults to 180s for interactive chat; the offline seed passes more (bigger outputs)."""
    try:
        p = subprocess.run(
            [CLAUDE_BIN, "-p", "--model", CHAT_MODEL, "--system-prompt", TUTOR_SYS,
             "--disallowed-tools", "Bash", "Edit", "Write", "NotebookEdit",
             "--output-format", "json"],
            input=prompt, capture_output=True, text=True, timeout=timeout, env=env)
    except FileNotFoundError:
        return None, "the `claude` CLI was not found on PATH"
    except subprocess.TimeoutExpired:
        return None, f"claude timed out ({timeout}s)"
    if p.returncode != 0:
        return None, (p.stderr.strip() or f"claude exited {p.returncode}")
    try:
        data = json.loads(p.stdout)
    except Exception:
        return None, "could not parse claude output"
    res = None
    if isinstance(data, list):
        for o in data:
            if isinstance(o, dict) and o.get("type") == "result":
                res = o
    elif isinstance(data, dict):
        res = data
    if not res:
        return None, "no result from claude"
    if res.get("is_error"):
        return None, (res.get("result") or "claude reported an error")
    return (res.get("result") or ""), None


# ==================== LeetCode proxy (unchanged) ====================
def _get(url, headers, data=None):
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def authed_progress():
    """Full solved set for the logged-in user (legacy REST endpoint + cookie)."""
    cookie = f"LEETCODE_SESSION={SESSION}" + (f"; csrftoken={CSRF}" if CSRF else "")
    data = _get("https://leetcode.com/api/problems/all/",
                {"Cookie": cookie, "Referer": "https://leetcode.com", "User-Agent": UA})
    solved, counts = [], {"Easy": 0, "Medium": 0, "Hard": 0}
    for p in data.get("stat_status_pairs", []):
        if p.get("status") == "ac":
            solved.append(p["stat"]["question__title_slug"])
            counts[LEVELS.get(p["difficulty"]["level"], "Easy")] += 1
    return {"user": data.get("user_name") or "(you)", "authed": True, "counts": counts,
            "solved": sorted(set(solved)), "recent": _enrich_recent(recent_solves(data.get("user_name") or ""))}


PROFILE_Q = """query($u:String!){
  matchedUser(username:$u){ submitStatsGlobal{ acSubmissionNum{ difficulty count } } }
  recentAcSubmissionList(username:$u, limit:20){ titleSlug timestamp }
}"""


def public_progress(user):
    """Counts + ~20 most recent solves from the public profile (no cookie)."""
    if not user:
        return {"error": "No LeetCode handle yet — type yours in the box next to ⟲ Sync "
                         "(or set LEETCODE_SESSION for cookie-based sync)."}
    body = json.dumps({"query": PROFILE_Q, "variables": {"u": user}}).encode()
    d = _get("https://leetcode.com/graphql",
             {"Content-Type": "application/json", "Referer": "https://leetcode.com", "User-Agent": UA},
             data=body).get("data") or {}
    mu = d.get("matchedUser")
    if not mu:
        return {"error": f"No public profile for handle '{user}'. Use your LeetCode handle "
                         "(the slug in leetcode.com/u/<handle>/), not your email — "
                         "or set LEETCODE_SESSION for cookie-based sync."}
    counts = {x["difficulty"]: x["count"] for x in mu["submitStatsGlobal"]["acSubmissionNum"]}
    counts.pop("All", None)
    recent = [{"slug": s["titleSlug"], "ts": int(s["timestamp"])} for s in (d.get("recentAcSubmissionList") or [])]
    return {"user": user, "authed": False, "counts": counts,
            "solved": [r["slug"] for r in recent], "recent": _enrich_recent(recent),
            "note": "Public mode: only the ~20 most recent solves. Set LEETCODE_SESSION for full history."}


SIMILAR_Q = "query($slug:String!){ question(titleSlug:$slug){ similarQuestions } }"
RECENT_Q = "query($u:String!){ recentAcSubmissionList(username:$u, limit:20){ titleSlug timestamp } }"


def _gql(query, variables):
    body = json.dumps({"query": query, "variables": variables}).encode()
    return _get("https://leetcode.com/graphql",
                {"Content-Type": "application/json", "Referer": "https://leetcode.com", "User-Agent": UA}, data=body)


def recent_solves(user):
    """Recent accepted submissions with timestamps (≤20). Public; in authed mode pass the resolved username."""
    if not user:
        return []
    try:
        d = _gql(RECENT_Q, {"u": user}).get("data") or {}
        return [{"slug": s["titleSlug"], "ts": int(s["timestamp"])} for s in (d.get("recentAcSubmissionList") or [])]
    except Exception:
        return []


DIFF_ORDER = {"Easy": 0, "Medium": 1, "Hard": 2}


def related(slugs):
    """Union LeetCode's curated 'Similar Questions' across one or more seed problems.
    (LeetCode's bulk topic-tag query returns 400 publicly, so we widen via the similar-graph instead.)"""
    seen = {}
    for sl in slugs:
        raw = (((_gql(SIMILAR_Q, {"slug": sl}).get("data") or {}).get("question") or {}).get("similarQuestions")) or "[]"
        for s in json.loads(raw):
            seen.setdefault(s["titleSlug"], {"slug": s["titleSlug"], "title": s["title"],
                                             "difficulty": s["difficulty"], "paid": s.get("paidOnly", False)})
    return {"items": sorted(seen.values(), key=lambda x: DIFF_ORDER.get(x["difficulty"], 3)), "total": len(seen)}


# ---- solved problems + their topic tags, so the client can auto-categorize any LC solve ----
LC_TAGS_FILE = os.path.join(BASE_DIR, "lc-tags.json")   # local cache: {slug: {title, difficulty, tags}}
TAGS_Q = "query($slug:String!){ question(titleSlug:$slug){ title difficulty topicTags{ name } } }"

def _load_tags():
    try:
        return json.load(open(LC_TAGS_FILE))
    except Exception:
        return {}

def _save_tags(cache):
    try:
        tmp = LC_TAGS_FILE + ".tmp"; json.dump(cache, open(tmp, "w")); os.replace(tmp, LC_TAGS_FILE)
    except Exception:
        pass

def _fetch_tags(slug):
    """One problem's title/difficulty/topic tags from LeetCode. None if it didn't come back — the
    caller must not cache that, or a throttled call would pin the slug to 'no tags' forever."""
    try:
        q = ((_gql(TAGS_Q, {"slug": slug}).get("data") or {}).get("question")) or {}
        if not q:
            return None
        return {"title": q.get("title") or slug, "difficulty": q.get("difficulty") or "",
                "tags": [t["name"] for t in (q.get("topicTags") or [])]}
    except Exception:
        return None

def _enrich_recent(recent):
    """Attach topic tags to each recent solve so the client can mark the right topic practiced.
    Fetches the ones the cache doesn't have yet: a *new* solve is precisely the uncached case, and
    handing the client empty tags is what left its family stuck reading 'practiced N days ago'.
    The list is ~20 long and nearly all of it is cached, so this is a couple of calls at most."""
    cache, fetched = _load_tags(), 0
    for r in recent:
        meta = cache.get(r["slug"])
        if meta is None and fetched < 20:
            meta = _fetch_tags(r["slug"])
            if meta:
                cache[r["slug"]] = meta; fetched += 1
                time.sleep(0.08)                         # be gentle with LeetCode
        r["tags"] = (meta or {}).get("tags", [])
    if fetched:
        _save_tags(cache)
    return recent

def solved_with_tags(user):
    prog = authed_progress() if SESSION else public_progress(user)
    if "error" in prog:
        return prog
    cache, fetched, out = _load_tags(), 0, []
    for sl in prog.get("solved", []):
        meta = cache.get(sl)
        if meta is None and fetched < 50:               # cap new fetches/call; the rest fill in on the next sync
            meta = _fetch_tags(sl)
            if meta:
                cache[sl] = meta; fetched += 1
                time.sleep(0.08)                         # be gentle with LeetCode
        out.append({"slug": sl, **meta} if meta else {"slug": sl, "title": sl, "difficulty": "", "tags": [], "pending": True})
    if fetched:
        _save_tags(cache)
    return {"user": prog.get("user"), "authed": prog.get("authed", False),
            "solved": out, "pending": sum(1 for x in out if x.get("pending")), "note": prog.get("note")}


# ==================== git: status + commit/push your progress ====================
# The commit button is intentionally scoped: it only ever stages your progress + study
# content, never unrelated working changes (a half-edited server.py, etc.). Anything
# outside these paths is reported as an "other" count but left untouched.
PROGRESS_PATHS = ["state.json", "content", "progress"]


def _in_scope(path):
    return (path in ("state.json", "content", "progress")
            or path.startswith("content/") or path.startswith("progress/"))


def _git(args, timeout=30):
    """Run a git command inside the repo. Returns a CompletedProcess-like object even on failure."""
    try:
        return subprocess.run(["git", "-C", BASE_DIR, *args],
                              capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return SimpleNamespace(returncode=127, stdout="", stderr="git not found on PATH")
    except subprocess.TimeoutExpired:
        return SimpleNamespace(returncode=124, stdout="", stderr=f"git {args[0]} timed out")


def _porcelain_tag(code):
    """Collapse a 2-char `git status --porcelain` XY code to one display letter (M/A/D/R/?)."""
    if code == "??":
        return "?"
    for ch in code:
        if ch != " ":
            return ch
    return "?"


def git_status():
    """Working-tree snapshot for the dashboard. Returns {'repo': False} when there's no git
    checkout here (e.g. the rsync-deployed mirror, which is intentionally .git-less)."""
    inside = _git(["rev-parse", "--is-inside-work-tree"], timeout=10)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return {"repo": False}
    branch = _git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    files, other = [], 0                            # in-scope changes the button commits, + a count of the rest
    for line in _git(["status", "--porcelain"]).stdout.splitlines():
        if not line.strip():
            continue
        code, path = line[:2], line[3:]
        if " -> " in path:                          # renames: show the destination path
            path = path.split(" -> ", 1)[1]
        if _in_scope(path):
            files.append({"code": code, "tag": _porcelain_tag(code), "path": path})
        else:
            other += 1
    up = _git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    has_upstream = up.returncode == 0
    ahead = behind = 0
    if has_upstream:
        lr = _git(["rev-list", "--left-right", "--count", "@{u}...HEAD"])
        parts = lr.stdout.split()
        if lr.returncode == 0 and len(parts) == 2:
            behind, ahead = int(parts[0]), int(parts[1])
    last = None
    raw = _git(["log", "-1", "--format=%h%x09%s%x09%cr"]).stdout.strip()
    if "\t" in raw:
        h, subj, when = (raw.split("\t") + ["", "", ""])[:3]
        last = {"hash": h, "subject": subj, "when": when}
    return {"repo": True, "branch": branch, "files": files, "dirty": bool(files), "other": other,
            "ahead": ahead, "behind": behind, "has_upstream": has_upstream,
            "remote": up.stdout.strip() if has_upstream else None, "last": last,
            "clean": not files and ahead == 0}


def _default_commit_msg():
    solved = 0
    try:
        prog = (json.load(open(STATE_FILE)) or {}).get("recovery-progress-v2", {})
        solved = sum(1 for v in prog.values() if isinstance(v, dict) and v.get("s") == "green")
    except Exception:
        pass
    tail = f" — {solved} solved" if solved else ""
    return "Update study progress" + tail + time.strftime(" (%Y-%m-%d %H:%M)")


def git_sync(message=None):
    """Stage + commit ONLY the progress/content paths (PROGRESS_PATHS), then pull --rebase
    and push. Unrelated working changes are deliberately left alone. Always returns a dict;
    `ok` carries success and `error` the first failure. `status` holds the post-op
    git_status() so the UI can repaint from one round-trip."""
    if not git_status().get("repo"):
        return {"ok": False, "error": "not a git repository"}
    log, committed = [], None
    if _git(["status", "--porcelain", "--", *PROGRESS_PATHS]).stdout.strip():   # anything in scope to commit?
        add = _git(["add", "-A", "--", *PROGRESS_PATHS])                        # stage scope (incl. new/deleted)
        if add.returncode != 0:
            return {"ok": False, "error": "git add failed: " + (add.stderr.strip() or "unknown")}
        msg = (message or "").strip() or _default_commit_msg()
        c = _git(["commit", "-m", msg, "--", *PROGRESS_PATHS])                  # pathspec: commit scope only,
        if c.returncode != 0:                                                  # even if other files were pre-staged
            return {"ok": False, "error": "commit failed: " + (c.stderr.strip() or c.stdout.strip() or "unknown")}
        committed = _git(["rev-parse", "--short", "HEAD"]).stdout.strip()
        log.append("committed " + committed)
    st = git_status()
    if not st.get("has_upstream"):                  # first push on this branch: set the upstream
        p = _git(["push", "-u", "origin", st["branch"]], timeout=150)
        if p.returncode != 0:
            return {"ok": False, "committed": committed, "pushed": False, "log": log,
                    "status": git_status(), "error": "push failed: " + (p.stderr.strip() or "unknown")}
        log.append(f"pushed origin/{st['branch']} (upstream set)")
        return {"ok": True, "committed": committed, "pushed": True, "log": log, "status": git_status()}
    pull = _git(["pull", "--rebase", "--autostash"], timeout=150)   # always pull before pushing
    if pull.returncode != 0:
        _git(["rebase", "--abort"])                 # don't leave the repo mid-rebase
        return {"ok": False, "committed": committed, "pushed": False, "log": log, "status": git_status(),
                "error": "pull --rebase failed — resolve in a terminal: "
                         + (pull.stderr.strip() or pull.stdout.strip() or "conflict")}
    push = _git(["push"], timeout=150)
    if push.returncode != 0:
        return {"ok": False, "committed": committed, "pushed": False, "log": log,
                "status": git_status(), "error": "push failed: " + (push.stderr.strip() or "unknown")}
    log.append("pushed to " + (st.get("remote") or "origin"))
    return {"ok": True, "committed": committed, "pushed": True, "log": log, "status": git_status()}


# ==================== HTTP handler ====================
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # This box serves straight from the working tree ("on disk = live"), so a browser must never serve a
        # stale cached copy of content/*.json, *.js, or roadmap.html after an edit. SimpleHTTPRequestHandler
        # sends Last-Modified but no Cache-Control, which lets browsers *heuristically* cache and skip
        # revalidation — that's how freshly-generated curriculum keyPoints failed to appear. no-cache =
        # "revalidate every time" (cheap 304s for unchanged static files, since If-Modified-Since is honored).
        # Skip if a handler already set its own Cache-Control (e.g. the SSE stream) to avoid a duplicate.
        if not any(h.lower().startswith(b"cache-control:") for h in getattr(self, "_headers_buffer", [])):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/progress":
            user = (parse_qs(u.query).get("user") or [""])[0]
            try:
                payload = authed_progress() if SESSION else public_progress(user)
                code = 404 if "error" in payload else 200
            except Exception as e:                       # network / LeetCode hiccup
                payload, code = {"error": str(e)}, 502
            self._json(payload, code)
        elif u.path == "/api/related":
            try:
                payload, code = related(parse_qs(u.query).get("slug", [])), 200
            except Exception as e:
                payload, code = {"error": str(e)}, 502
            self._json(payload, code)
        elif u.path == "/api/decks":
            try:
                self._json(decks_for_client())
            except Exception as e:
                self._json({"error": str(e)}, 500)
        elif u.path == "/api/roadmap.js":                     # algorithms roadmap as `window.ROADMAP`
            try:
                b = ("window.ROADMAP=" + json.dumps(load_roadmap()) + ";").encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
            except Exception as e:
                self._json({"error": str(e)}, 500)
        elif u.path == "/api/state":
            self._json(read_state())
        elif u.path == "/api/git/status":
            try:
                self._json(git_status())
            except Exception as e:
                self._json({"repo": False, "error": str(e)})
        elif u.path == "/api/quiz":
            self._json(load_quiz())
        elif u.path == "/api/topics":
            try:
                self._json(load_topics())
            except Exception as e:
                self._json({"error": str(e)}, 500)
        elif u.path.startswith("/api/topic/") and u.path.endswith("/quiz"):
            self._json(load_topic_quiz(u.path[len("/api/topic/"):-len("/quiz")]))
        elif u.path.startswith("/api/topic/") and u.path.endswith("/progress"):
            topic = u.path[len("/api/topic/"):-len("/progress")]
            user = (parse_qs(u.query).get("user") or ["me"])[0]
            self._json(read_progress(user, topic))
        elif u.path == "/api/solved":
            try:
                user = (parse_qs(u.query).get("user") or [""])[0]
                self._json(solved_with_tags(user))
            except Exception as e:
                self._json({"error": str(e)}, 502)
        else:
            # ponytail: SPA fallback lives in do_GET only — the app never issues HEAD, so /ml etc.
            # 404 on HEAD but serve on GET. Add the same rewrite to do_HEAD if a HEAD client ever appears.
            if u.path == "/":                             # bare root → the app
                self.path = "/roadmap.html"
            elif (not os.path.exists(self.translate_path(u.path))
                  and "." not in os.path.basename(u.path)):  # /ml, /rag … tab deep-links → the app
                self.path = "/roadmap.html"               # (dotted paths e.g. /x.js still 404 normally)
            super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/state":                          # durable progress → the single source of truth
            try:
                data = self._body()
                json.loads(data)                          # validate before writing
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 400)
            ok, err = write_state(data)
            self._json({"ok": True} if ok else {"ok": False, "error": err}, 200 if ok else 502)
            return
        if path == "/api/run":
            return self._run_kata()
        if path == "/api/card":
            return self._save_card()
        if path == "/api/roadmap/insight":
            return self._save_insight()
        if path == "/api/roadmap/premium":
            return self._save_prob_premium()
        if path == "/api/concept":
            return self._save_concept()
        if path == "/api/chat":
            return self._chat()
        if path == "/api/git/commit":
            return self._git_commit()
        if path == "/api/quiz/delete":
            return self._quiz_delete()
        if path.startswith("/api/topic/") and path.endswith("/progress"):
            topic = path[len("/api/topic/"):-len("/progress")]
            user = (parse_qs(urlparse(self.path).query).get("user") or ["me"])[0]
            try:
                data = self._body()
                json.loads(data)                              # validate before writing
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 400)
            ok, err = write_progress(user, topic, data)       # open like /api/state: learner-owned progress
            return self._json({"ok": True} if ok else {"ok": False, "error": err}, 200 if ok else 502)
        self.send_response(404)
        self.end_headers()

    # ---- kata runner: append the YAML test harness after the user's code, run isolated ----
    def _run_kata(self):
        if not self._remote_allowed():                    # code exec → localhost + trusted tailnet (ALLOW_REMOTE_GIT), runs -I isolated w/ 6s timeout
            return
        try:
            req = json.loads(self._body() or b"{}")
        except Exception:
            return self._json({"ok": False, "error": "bad request"}, 400)
        test = kata_test(req.get("id"))
        if not test:
            return self._json({"ok": False, "error": "unknown kata id"}, 404)
        program = (req.get("code") or "") + "\n\n" + test
        try:
            p = subprocess.run([sys.executable, "-I", "-c", program],
                               capture_output=True, text=True, timeout=6)
            ok = p.returncode == 0
            self._json({"ok": ok, "output": p.stdout.strip(),
                        "error": "" if ok else (p.stderr.strip() or "failed")})
        except subprocess.TimeoutExpired:
            self._json({"ok": False, "error": "timed out after 6s (infinite loop?)"})

    # ---- write an edited card back to its YAML ----
    def _save_card(self):
        if not self._remote_allowed():                    # disk write → localhost or trusted tailnet
            return
        try:
            req = json.loads(self._body() or b"{}")
        except Exception:
            return self._json({"ok": False, "error": "bad request"}, 400)
        info, err = update_card(req.get("deck"), req.get("id"), req.get("fields"))
        if err:
            return self._json({"ok": False, "error": err}, 400)
        self._json({"ok": True, **info})

    def _save_insight(self):
        if not self._remote_allowed():                    # disk write → localhost or trusted tailnet
            return
        try:
            req = json.loads(self._body() or b"{}")
        except Exception:
            return self._json({"ok": False, "error": "bad request"}, 400)
        info, err = update_topic(req.get("id"), req.get("insight"))
        if err:
            return self._json({"ok": False, "error": err}, 400)
        self._json({"ok": True, **info})

    # ---- toggle a roadmap problem's LeetCode-premium flag → rewrites content/algos/<id>/data.yaml ----
    def _save_prob_premium(self):
        if not self._remote_allowed():
            return
        try:
            req = json.loads(self._body() or b"{}")
        except Exception:
            return self._json({"ok": False, "error": "bad request"}, 400)
        info, err = set_prob_premium(req.get("id"), req.get("slug"), bool(req.get("premium")))
        if err:
            return self._json({"ok": False, "error": err}, 400)
        self._json({"ok": True, **info})

    # ---- write an edited interactive-lesson concept back to its JSON ----
    def _save_concept(self):
        if not self._remote_allowed():                    # disk write → localhost or trusted tailnet
            return
        try:
            req = json.loads(self._body() or b"{}")
        except Exception:
            return self._json({"ok": False, "error": "bad request"}, 400)
        info, err = update_concept(req.get("topic"), req.get("concept"), req.get("fields"))
        if err:
            return self._json({"ok": False, "error": err}, 400)
        self._json({"ok": True, **info})

    # ---- quiz bank: delete one question from its concept's quiz.yaml ----
    def _quiz_delete(self):
        if not self._remote_allowed():                    # content write → localhost or trusted tailnet
            return
        try:
            req = json.loads(self._body() or b"{}")
        except Exception:
            return self._json({"ok": False, "error": "bad request"}, 400)
        ok, err = delete_quiz(req.get("deck"), req.get("id"))
        self._json({"ok": True} if ok else {"ok": False, "error": err}, 200 if ok else 404)

    # ---- commit your study progress and push (localhost only: runs git + a network push) ----
    def _git_commit(self):
        if not self._remote_allowed():
            return
        try:
            req = json.loads(self._body() or b"{}")
        except Exception:
            req = {}
        try:
            res = git_sync(req.get("message"))
        except Exception as e:
            res = {"ok": False, "error": str(e)}
        self._json(res)

    # ---- stream a chat reply from the local claude CLI (SSE-style over a chunked response) ----
    def _chat(self):
        if not self._localhost_only():                    # spawns claude → localhost only
            return
        try:
            req = json.loads(self._body() or b"{}")
        except Exception:
            return self._json({"error": "bad request"}, 400)
        if req.get("kind") == "concept":                  # interactive-lesson page "Refine" (see topic.js)
            p = _concept_path(req.get("topic"), req.get("concept"))
            try:
                data = json.load(open(p)) if p and os.path.isfile(p) else None
            except Exception:
                data = None
            if not data:
                return self._json({"error": "unknown concept"}, 404)
            prompt = _build_refine_prompt(req.get("topic"), data, req.get("messages"))
        else:
            deck, kind, card = find_card(req.get("deck"), req.get("id"))
            if not card:
                return self._json({"error": "unknown card"}, 404)
            prompt = _build_prompt(deck, kind, card, req.get("messages"), req.get("mode") or "chat")

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(obj):
            self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")
            self.wfile.flush()

        try:
            emit({"status": "thinking"})
            text, err = run_claude(prompt, _chat_env(),
                                   timeout=300 if req.get("kind") == "concept" else 180)  # lessons are larger
            if err:
                emit({"error": err})
                return
            for i in range(0, len(text), 24):             # typewriter: stream it out so you watch it type
                emit({"delta": text[i:i + 24]})
                time.sleep(0.012)
            emit({"done": True, "full": text})
        except (BrokenPipeError, ConnectionResetError):
            return                                        # client closed the chat; nothing to do
        except Exception as e:
            try:
                emit({"error": str(e)})
            except Exception:
                pass

    # ---- helpers ----
    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) or b"{}"

    def _localhost_only(self):
        if self.client_address[0] not in ("127.0.0.1", "::1", "localhost"):
            self._json({"error": "this endpoint is restricted to localhost"}, 403)
            return False
        return True

    # This server owns state.json, and every mutating request is ACCEPTED regardless of client IP —
    # there is no localhost/LAN gate (`make run` binds 127.0.0.1 unless you pass BIND=0.0.0.0).
    # WARNING: that includes /api/run, which executes Python (sandboxed `-I`, 6s timeout), plus
    # card/insight edits and git push. Only bind this on a network you trust. To re-lock, put an IP
    # check back in this one method — every writer already routes through it.
    def _remote_allowed(self):
        return True

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):   # quiet
        pass


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")   # `make run BIND=0.0.0.0` exposes it on the LAN
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    mode = "FULL history (session cookie set)" if SESSION else "public only — set LEETCODE_SESSION for full history"
    shown = "localhost" if host in ("", "0.0.0.0") else host
    decks = load_decks()
    print(f"Recovery Roadmap  →  http://{shown}:{port}/  (bind {host}:{port})")
    print(f"Study decks: {', '.join(d.get('tab', d['key']) for d in decks) or '(none — check content/*.yaml)'}")
    print(f"Local-Claude chat: {CLAUDE_BIN}  ·  model {CHAT_MODEL}")
    _gs = git_status()
    print(f"Git sync: {'on · branch ' + _gs.get('branch', '?') if _gs.get('repo') else 'off (no .git here)'}")
    print(f"LeetCode sync: {mode}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
