#!/usr/bin/env python3
"""Batch-generate multiple-choice quiz questions for a study deck (ML / LLM), grounded in each
card's OWN content, into content/<module>/<concept>/quiz.yaml — the same bank the Test tab reads.

Offline authoring, no API key: reuses server.run_claude (the local `claude` CLI). Mirrors seed.py.
Re-runnable so the bank can grow over time and be committed to git:

  python3 quizgen.py ml                 # 5 per ML card; skip cards already covered
  python3 quizgen.py ml ROC-AUC         # just this concept — 'ROC-AUC' resolves to id m-roc-pr
  python3 quizgen.py ml ROC-AUC --force # regenerate only that concept
  python3 quizgen.py ml m-roc-pr --dry  # show what a selector resolves to; no generation
  python3 quizgen.py ml --add           # generate 5 MORE per card (dedup vs existing)
  python3 quizgen.py ml --limit 2       # smoke-test on the first 2 cards
  python3 quizgen.py --selftest         # exercise the pure logic, no claude

A concept's key IS its `id` in content/<deck>.yaml (e.g. m-roc-pr) — the same stable id that
keys SRS progress and the generated quiz ids (m-roc-pr-q0). The selector matches that id, or a
keyword in the card's label/area, and must resolve to exactly one concept.

Then: git add content/<module>/ && commit — checked in exactly like study progress/content.
"""
import argparse, collections, os, random, re, sys, time
import yaml
import server                      # reuse: run_claude, _extract_json, _chat_env, load_quiz, _write_quiz, _write schema

CONTENT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "content")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def load_deck(deck_id):
    """Assemble a deck from the content/<deck_id>/ tree (via the server's loader). Returns (module, items)."""
    mdir = os.path.join(CONTENT, deck_id)
    if not os.path.exists(os.path.join(mdir, "deck.yaml")):
        avail = ", ".join(n for n, _ in server._module_dirs())
        raise SystemExit(f"no module content/{deck_id}/deck.yaml (available: {avail or 'none'})")
    key = (yaml.safe_load(open(os.path.join(mdir, "deck.yaml"))) or {}).get("key")
    deck = next((d for d in server.load_decks() if d.get("key") == key), None)
    if not deck:
        raise SystemExit(f"deck '{key}' failed to load — check content/{deck_id}/")
    items = list(deck.get("concepts", [])) + list(deck.get("katas", []))
    dupes = [i for i, c in collections.Counter(it["id"] for it in items).items() if c > 1]
    if dupes:                                   # each concept must have a unique key to reference later
        raise SystemExit(f"duplicate concept ids in content/{deck_id}: {dupes}")
    return deck_id, items


def _label(it):
    return it.get("title", "") if it.get("type") == "kata" else it.get("front", "")


def _list(items):
    return "\n".join(f"  {it['id']:<18} {_label(it)[:56]}" for it in items[:40])


def resolve(items, sel):
    """Selector -> matching card(s): exact id wins, else keyword substring over id + label + area."""
    for it in items:
        if it["id"].lower() == sel.lower():
            return [it]
    s = norm(sel)
    return [it for it in items if s and s in norm(f"{it['id']} {_label(it)} {it.get('area','')}")]


def card_context(it):
    """(term-label, grounding-text) — everything the model needs to write faithful questions."""
    if it.get("type") == "kata":
        term = it.get("title", "kata")
        ctx = (f"Coding kata: {it.get('title','')}\n"
               f"Prompt: {it.get('prompt','')}\n"
               f"Signature: {it.get('sig','')}\n"
               f"Reference solution:\n{it.get('reference','')}")
    else:
        front = it.get("front", "")
        term = re.split(r"[—?:]", front)[0].strip()[:52] or front[:52] or "concept"
        ctx = f"Q: {front}\nA: {it.get('back','')}"
        if it.get("more"):
            ctx += f"\nDeep dive: {it['more']}"
    return term, ctx


def gen_prompt(ctx, n):
    return (f"Below is reference material for one interview topic. Using it only as your ground truth, write {n} "
            "small, atomic multiple-choice questions that test genuine understanding of the TOPIC ITSELF.\n\n"
            "Hard rules:\n"
            "- Every question must STAND ALONE — answerable by anyone who knows the topic, without having seen this "
            "material. NEVER mention or allude to 'the card', 'the kata', 'the prompt', 'the reference solution', "
            "'this implementation', 'as described', 'per the …', etc. Ask about the concept, never about the text below.\n"
            "- For a coding kata, quiz the CONCEPT it implements and why the standard approach works (definition, "
            "formula, intuition, when-to-use, a real gotcha) — NOT the reference code's variable names, branch "
            "structure, or Python error messages. A question must make sense to someone who never saw this exact code.\n"
            "- Vary the angle across the set. Ground each question and its correct answer in the material; don't test "
            "facts it doesn't support. Exactly 4 short, unambiguous options, exactly ONE correct.\n\n"
            f"--- REFERENCE MATERIAL ---\n{ctx}\n--- END MATERIAL ---\n\n"
            'Reply with EXACTLY one ```json fenced block holding a JSON array. Each element: '
            '{"q": "the question", "choices": ["A","B","C","D"], "answer": <0-based index of the correct option>}. '
            "No prose outside the code block.")


def valid(items):
    """Keep only well-formed MCQs (4 distinct-ish choices, answer in range)."""
    out = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        q, ch = str(it.get("q", "")).strip(), it.get("choices")
        if not q or not isinstance(ch, list) or len(ch) != 4:
            continue
        try:
            a = int(it.get("answer"))
        except (TypeError, ValueError):
            continue
        if not 0 <= a <= 3:
            continue
        out.append({"q": q, "choices": [str(c).strip() for c in ch], "answer": a})
    return out


def norm(q):
    return re.sub(r"[^a-z0-9]+", " ", q.lower()).strip()


def shuffled(q):
    """Randomise the correct-option position so it isn't always 'A' (LLMs bias to index 0)."""
    idx = list(range(4)); random.shuffle(idx)
    return {"q": q["q"], "choices": [q["choices"][i] for i in idx], "answer": idx.index(q["answer"])}


def generate_for(term, ctx, n, seen_norm):
    """Two tries; return up to n fresh, valid, position-shuffled questions."""
    got = []
    for _ in range(2):
        text, err = server.run_claude(gen_prompt(ctx, n), server._chat_env(), timeout=300)
        if err:
            log(f"    claude: {err}"); continue
        try:
            items = server._extract_json(text)
        except Exception:
            log("    could not parse JSON reply"); continue
        for q in valid(items):
            nq = norm(q["q"])
            if nq in seen_norm:
                continue
            seen_norm.add(nq); got.append(shuffled(q))
            if len(got) >= n:
                return got
    return got


def run(deck_id, concept, n, add, force, only, limit, dry):
    module, items = load_deck(deck_id)
    if concept:                                 # scope to a single concept by id/keyword
        matches = resolve(items, concept)
        if not matches:
            raise SystemExit(f"no '{deck_id}' concept matches {concept!r}. Options:\n" + _list(items))
        if len(matches) > 1:
            raise SystemExit(f"{concept!r} is ambiguous — {len(matches)} matches:\n" + _list(matches) +
                             "\nUse the exact id or a longer keyword.")
        items = matches
    elif only:
        items = [it for it in items if it["id"] in only]
    if limit:
        items = items[:limit]
    if dry:
        log(f"resolves to {len(items)} card(s):")
        for it in items:
            log(f"  {it['id']}  ·  {_label(it)[:60]}")
        return 0
    total_added = 0
    for i, it in enumerate(items, 1):
        cid = it["id"]
        term, ctx = card_context(it)
        qp = os.path.join(CONTENT, module, cid, "quiz.yaml")     # content/<module>/<concept>/quiz.yaml
        existing = []
        if os.path.exists(qp):
            try:
                existing = yaml.safe_load(open(qp)) or []
            except Exception:
                existing = []
        if force:
            existing = []
        elif existing and not add:
            log(f"[{i}/{len(items)}] {cid}: has {len(existing)} — skip (use --add / --force)")
            continue

        seen = {norm(q.get("q", "")) for q in existing}
        log(f"[{i}/{len(items)}] {cid} · {term!r} → generating {n}…")
        fresh = generate_for(term, ctx, n, seen)
        if not fresh:
            log(f"    ✗ nothing generated for {cid}"); continue

        start = len(existing)
        recs = [{"id": f"{cid}-q{start + j}", **q} for j, q in enumerate(fresh)]   # term is injected at read time
        allq = list(existing) + recs
        os.makedirs(os.path.dirname(qp), exist_ok=True)
        server._dump_yaml(qp, allq, "# Quiz questions for this concept — each has a unique id. Generated by quizgen.py.\n\n")
        total_added += len(recs)
        log(f"    ✓ +{len(recs)} → {module}/{cid}/quiz.yaml (now {len(allq)})")

    log(f"\nDone: +{total_added} questions across '{module}'. git add content/{module}/ to check them in.")
    return total_added


def _selftest():
    assert valid([{"q": "x", "choices": ["a", "b", "c", "d"], "answer": 1}]), "valid MCQ dropped"
    assert valid([{"q": "x", "choices": ["a", "b"], "answer": 0}]) == [], "3-choice not rejected"
    assert valid([{"q": "", "choices": ["a", "b", "c", "d"], "answer": 0}]) == [], "empty q not rejected"
    assert valid([{"q": "x", "choices": ["a", "b", "c", "d"], "answer": 9}]) == [], "OOB answer not rejected"
    s = shuffled({"q": "x", "choices": ["A", "B", "C", "D"], "answer": 0})
    assert s["choices"][s["answer"]] == "A", "shuffle broke the correct answer"
    assert norm("What IS  TPR?!") == "what is tpr", norm("What IS  TPR?!")
    fx = [{"id": "m-roc-pr", "type": "concept", "front": "ROC-AUC vs PR-AUC — what each shows", "area": "Classification Metrics"},
          {"id": "m-f1", "type": "concept", "front": "What is the F1 score", "area": "Classification Metrics"}]
    assert [x["id"] for x in resolve(fx, "ROC-AUC")] == ["m-roc-pr"], "keyword resolve failed"
    assert [x["id"] for x in resolve(fx, "m-f1")] == ["m-f1"], "exact-id resolve failed"
    assert resolve(fx, "nonexistent") == [], "bad selector should not match"
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser(description="Batch-generate quiz MCQs into content/<module>/<concept>/quiz.yaml.")
    ap.add_argument("deck", nargs="?", help="deck id: ml | llm (reads content/<deck>.yaml)")
    ap.add_argument("concept", nargs="?", help="scope to one concept: its id or a keyword (e.g. ROC-AUC); omit for the whole deck")
    ap.add_argument("--n", type=int, default=5, help="questions per card (default 5)")
    ap.add_argument("--add", action="store_true", help="generate more even if a card is already covered")
    ap.add_argument("--force", action="store_true", help="drop a card's existing questions and regenerate")
    ap.add_argument("--only", default="", help="comma-separated card ids to restrict to")
    ap.add_argument("--limit", type=int, default=0, help="only the first N cards (smoke test)")
    ap.add_argument("--dry", action="store_true", help="show which card(s) a selector resolves to; no generation")
    ap.add_argument("--selftest", action="store_true", help="exercise pure logic without calling claude")
    a = ap.parse_args()
    if a.selftest:
        return _selftest()
    if not a.deck:
        ap.error("deck is required (e.g. `quizgen.py ml ROC-AUC`)")
    only = {x for x in a.only.split(",") if x}
    run(a.deck, a.concept, a.n, a.add, a.force, only, a.limit, a.dry)


if __name__ == "__main__":
    main()
