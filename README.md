# interview_prep

A self-hosted **interview-study dashboard**: one web page (`roadmap.html` + vanilla JS) served by a
small Python server (`server.py`). No build step, no framework, no account. Your progress is saved
in plain files in this repo.

- **Home**: what to study next, across everything below.
- **Algorithms**: a LeetCode roadmap of pattern families laid out as a map, with a daily warm-up
  and a random pick. It syncs your recent solves from your LeetCode profile.
- **Solved**: every LeetCode solve, grouped by topic automatically.
- **ML / LLM decks**: spaced-repetition flashcards, coding katas (you write the code in the browser
  and it is run against tests), and multiple-choice quizzes.
- **Interactive lessons**: prerequisite-gated lesson trees on RAG, LLMs, ML, and MCP.
- **Notes**: a scratchpad sidebar (the amber tab on the left edge), one note per tab.
- `RECOVERY.md`: the written companion to the Algorithms tab, with a pattern index, core problems,
  and templates.

## Quick start

Requirements:

- [`uv`](https://docs.astral.sh/uv/). It installs Python and every dependency. Install it with
  `curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`).
- `make`. Optional; the `uv run` command shown below does the same job.

```sh
uv sync      # one-time: creates .venv/ with numpy, pandas, PyYAML, PyTorch (+ pytest)
make run     # serves http://127.0.0.1:8081/ and stays in the foreground; Ctrl-C stops it
```

Then open **http://127.0.0.1:8081/**.

- **Different port:** `make run PORT=9000`.
- **Without make:** `HOST=127.0.0.1 uv run server.py 8081`.
- **First `uv sync`:** it downloads PyTorch, which only the PyTorch katas use. On Linux, PyTorch
  brings its CUDA libraries with it, which makes the download several GB. On macOS it is a small CPU
  build.

### For AI agents starting the app

1. Run `uv sync` and wait for it to finish. On a first run it can take minutes because of PyTorch.
2. Start `make run` as a **background** process. It never exits on its own. On startup it logs
   `Recovery Roadmap  →  http://127.0.0.1:8081/  (bind 127.0.0.1:8081)` and its sync settings.
3. Wait for it to come up. This command prints `up` once the server is serving:
   `curl --retry 60 --retry-connrefused --retry-delay 1 -sf http://127.0.0.1:8081/api/decks >/dev/null && echo up`.
   The first start takes longer while PyTorch warms up.
4. Give the user the URL: http://127.0.0.1:8081/.
5. To stop the server, kill that background process. If port 8081 is taken, use `make run PORT=<free port>`
   and change the URLs above to match.

Don't add `BIND=0.0.0.0` unless the user asks for it (see [Security](#security)). Don't commit
`state.json` or `progress/` unless the user asks. They hold the user's own study progress.

## Using it

### LeetCode sync

Type your LeetCode handle (the `<handle>` in `leetcode.com/u/<handle>/`) in the box next to
**⟲ Sync**, then press Enter. The browser remembers the handle. Sync also runs on page load and
every 5 minutes.

The public profile shows only your ~20 most recent solves. For your **full history**, give the
server your LeetCode session cookie before you start it. The cookie stays in your shell environment
and is never written to disk:

```sh
export LEETCODE_SESSION='...'   # browser DevTools → Application → Cookies → leetcode.com
export LEETCODE_CSRF='...'      # the csrftoken cookie (optional)
make run
```

### AI features (optional)

These features call the local [Claude Code](https://claude.com/claude-code) CLI (`claude`,
installed and logged in). They need no API key. Without `claude`, these buttons show "the `claude`
CLI was not found on PATH", and the rest of the app works as usual:

- **✦ Ask Claude** on a card: explain or improve the card.
- **✦ Refine** on a lesson page: edit the page with a chat and a diff view.
- `python3 quizgen.py <deck> [concept]`: generate quiz questions.
- `make seed TOPIC=<id>`: generate an interactive-lesson topic.
- `python3 keypoints.py <topic>`: generate the hover summaries on lesson maps.

The in-app chat endpoints only answer requests from localhost. Set `CLAUDE_CHAT_MODEL` to choose
the model (default: `sonnet`).

### Your data

| What | Where |
|---|---|
| Algorithms progress, deck/quiz scheduling, notes | `state.json`, mirrored to the browser's localStorage |
| Interactive-lesson progress | `progress/<user>/<topic>.json` |
| Study content (cards, quizzes, lessons) | `content/`. In-app edits (`✎ edit`, ✦ Refine) write here |

`state.json` starts empty (`{}`). To back up your progress, commit it, or use the **Git Sync** panel
in the app. Git Sync commits only `state.json`, `content/` and `progress/`, then pulls and pushes to
your `origin` remote, so point `origin` at a repo of your own first. Keep `progress/.gitkeep`:
Git Sync fails if `progress/` matches no files.

**Start over:** run `echo '{}' > state.json` and `rm -rf progress/*/`, then clear this site's data
in your browser. The browser keeps a copy of the same progress and would write it back.

## Security

The server accepts writes from **any client that can reach its port**. That includes
`/api/run`, which executes Python for the coding katas. Python's `-I` flag and a 6-second timeout
are not a sandbox. The writes also cover content edits and the Git Sync push. For this reason
`make run` listens on **127.0.0.1** only.

To use the app from your phone or another computer, run `make run BIND=0.0.0.0`, and **only on a
network you trust**. Never do it on public Wi-Fi. The AI-chat endpoints only answer requests from
localhost either way. To lock down the kata runner, content edits and Git Sync, add an IP check to
`Handler._remote_allowed()` in `server.py`. All three go through that one method; progress saves
don't.

## Development

```sh
npm install   # one-time, for the jsdom UI tests (dev only; the app ships no npm packages)
make test     # pytest + node self-checks + jsdom UI tests
```

Edits to content, `*.js` and `roadmap.html` show up on the next page load. Restart the server after
you change `server.py` or the dependencies.

- `server.py`: the backend (static files, JSON API, LeetCode proxy, kata runner, git sync).
- `roadmap.html`: the app shell and the Algorithms tab.
- `web/`: the frontend modules (decks, lessons, dashboard, chat, notes, git panel).
- `content/`: the study content. Decks use `content/<deck>/<concept>/{data,quiz}.yaml`; lessons use
  `content/<topic>/`.
- `specs/`: architecture and authoring docs. Start with `specs/architecture.md`.
- `CLAUDE.md`: the project guide that agents read: content model, conventions, gotchas.

## Troubleshooting

- **`address already in use`**: another process is using port 8081. Run `make run PORT=9000`.
- **The first kata run says "infinite loop?"**: the first `import torch` compiles bytecode and can
  take longer than the runner's 6-second limit. `make run` imports torch once at startup to prevent
  this. If you started the server another way, run the kata again.
- **"No LeetCode handle yet"**: type your handle in the box next to ⟲ Sync.
- **"⚠ start the server…"**: the page was opened as a file. Open http://127.0.0.1:8081/ instead.
- **The code editor or chat formatting looks plain**: the page loads CodeMirror and marked from public
  CDNs, so it needs an internet connection.
