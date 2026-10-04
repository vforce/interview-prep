"""Shared pytest fixtures for the content-tree tests."""
import os
import pytest
import server
import quizgen


def _w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


@pytest.fixture
def content_tree(tmp_path, monkeypatch):
    """A throwaway content/ tree and `server`/`quizgen` pointed at it (cache reset).

    ml deck: two concepts (dirs deliberately out of alpha order to prove `order` sorting) + one
    kata; only `z-concept` ships a quiz.yaml. A sibling `rag/` dir (no deck.yaml) must be ignored.
    Yields the content root path.
    """
    root = str(tmp_path / "content")
    _w(f"{root}/ml/deck.yaml", "key: ml-srs-v1\ntab: ML\ntitle: ML\norder: 1\nareas: [Metrics]\n")
    _w(f"{root}/ml/z-concept/data.yaml",
       "id: z-concept\ntype: concept\narea: Metrics\norder: 0\nfront: Zebra?\nback: A striped horse.\n")
    _w(f"{root}/ml/a-concept/data.yaml",
       "id: a-concept\ntype: concept\narea: Metrics\norder: 1\nfront: Apple?\nback: A fruit.\nmore: Rosaceae.\n")
    _w(f"{root}/ml/kata1/data.yaml",
       "id: kata1\ntype: kata\narea: Metrics\norder: 2\ntitle: Sum\nprompt: add\n"
       "sig: 'def s(a, b):'\nstub: pass\nreference: return a + b\ntest: assert s(1, 2) == 3\n")
    _w(f"{root}/ml/z-concept/quiz.yaml",
       "- {id: z-concept-q0, q: 'Q0?', choices: [a, b, c, d], answer: 1}\n"
       "- {id: z-concept-q1, q: 'Q1?', choices: [a, b, c, d], answer: 0}\n")
    _w(f"{root}/rag/topic.yaml", "id: rag\ntitle: RAG\n")          # non-deck dir → ignored by the loader
    # algos roadmap: deck.yaml (no `key` → not an SRS deck) + two topics written out of `order` to
    # prove the loader sorts by it, not alpha.
    _w(f"{root}/algos/deck.yaml",
       "families: {arrays: {n: Arrays, c: '#4aa3ff'}}\nedges: [[twoptr, sliding]]\n")
    _w(f"{root}/algos/sliding/data.yaml",
       "id: sliding\nfam: arrays\nlabel: Sliding Window\norder: 1\ntrigger: t\ninsight: i\nprobs: [{n: X, slug: x, d: E}]\n")
    _w(f"{root}/algos/twoptr/data.yaml",
       "id: twoptr\nfam: arrays\nlabel: Two Pointers\norder: 0\ntrigger: t\ninsight: i\nprobs: [{n: Y, slug: y, d: M}]\n")

    monkeypatch.setattr(server, "CONTENT_DIR", root)
    monkeypatch.setattr(quizgen, "CONTENT", root)
    server._deck_cache["sig"] = None
    yield root
    server._deck_cache["sig"] = None                              # let later tests re-read the real dir
