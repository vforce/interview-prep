.PHONY: run seed test

# Serve the dashboard on http://127.0.0.1:8081/ (setup: README.md). The server owns state.json +
# content directly. BIND=0.0.0.0 exposes it to other devices on your LAN — trusted networks only:
# anyone who can reach the port can run Python through the kata runner (README → Security).
# Optional, for full-history LeetCode sync:  export LEETCODE_SESSION=...
BIND ?= 127.0.0.1
PORT ?= 8081
run:
	@uv run python -c "import torch, pandas, numpy" 2>/dev/null || true   # warm the .pyc cache: after a fresh `uv sync` the first import of torch (~7s) or pandas (~2s) compiles bytecode and can blow the kata runner's 6s cap — the user then sees a bogus "infinite loop?" timeout
	HOST=$(BIND) PYTHONUNBUFFERED=1 uv run server.py $(PORT)   # unbuffered: the startup banner reaches redirected logs

# ---- author phase: generate a topic's interactive lessons offline (specs/interactive_lesson.md) ----
# Reads content/$(TOPIC)/topic.yaml, generates the curriculum + concept files via the LOCAL claude
# CLI (no API key), and writes them under content/$(TOPIC)/. Re-run-safe: only changed concepts
# regenerate. Runtime never does this. Then commit the generated content.
#   make seed TOPIC=rag        make seed TOPIC=rag ARGS=--force
seed:
	@test -n "$(TOPIC)" || { echo "usage: make seed TOPIC=<id>   (e.g. make seed TOPIC=rag)"; exit 2; }
	uv run seed.py $(TOPIC) $(ARGS)

# ---- run the whole test suite: pytest (server/quizgen/seed) + node self-checks + jsdom UI tests ----
# jsdom-based UI tests need a one-time `npm install` (dev only; the app ships no npm deps).
test:
	uv run --group dev pytest
	node tests/test_review.js
	node tests/test_concepts.js
	node --test tests/test_study.mjs
	node --test tests/test_roadmap.mjs
	node --test tests/test_dashboard.mjs
