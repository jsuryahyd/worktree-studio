# Running locally

## Prerequisites

- Go 1.21+ (module uses `modernc.org/sqlite`, a pure-Go driver — no cgo/sqlite3 headers needed).
- [Bun](https://bun.sh) (for the Vite/React frontend — used as the package manager/runner instead of npm; `bun install`/`bun run` in place of `npm install`/`npm run`).
- `git` on `PATH` (all worktree operations shell out to the real `git` binary).
- `tmux` on `PATH` (terminal tabs are tmux sessions under the hood — see `docs/session-persistence.md`; `brew install tmux` on macOS).
- The standalone `spotlight` CLI installed (`github.com/JayaSuryaOolio/spotlight`; installs to `~/.local/bin/spotlight` by default), plus its own `fswatch` dependency (`brew install fswatch` on macOS) — see `docs/spotlight-sync.md`. Optional in the sense that worktree-studio still runs fine without it, but spotlight's REST endpoints will report `{"available": false}` / return `503` until it's installed.

## One-shot install / uninstall

```bash
./install/install.sh      # builds frontend + binary -> ~/.worktree-studio/bin/worktree-studio, installs claude hooks + skill
./install/uninstall.sh    # reverses it; leaves ~/.worktree-studio data (db, audit log) alone
```

`install.sh` detects macOS vs Linux and the package manager (brew, apt, dnf, pacman, apk), and offers to install any missing `git`, `tmux`, `go` or `bun` (`WS_YES=1` skips the prompt; bun uses its own installer). `fswatch` and `spotlight` are optional and only warned about. Other OSes (e.g. native Windows) are rejected — use WSL.

## Production-style: one binary

Build the frontend first, then the Go binary embeds it via `go:embed`:

```bash
cd web && bun install && bun run build   # writes web/dist/
cd ..
go build -o worktree-studio ./cmd/worktree-studio
./worktree-studio
```

Server listens on `:8787` by default (change the starting port with `WORKTREE_STUDIO_ADDR=:9000 ./worktree-studio`). If that port is taken it logs each unavailable port and tries the next one up (20 tries), then logs the address it actually bound — check the `worktree-studio listening` line. Note the CLI subcommands, the installed hooks and the Vite proxy (`web/vite.config.ts`) still assume the starting port, so they only find a server that landed on it.

If you run `go build` **before** ever building the frontend, it still succeeds — `web/dist/` ships with a placeholder file so the `go:embed` directive always has something to embed, and the server serves a small "run `bun run build`" page instead of crashing. This lets a fresh checkout compile immediately; you only need the frontend built to get the real UI.

## Development: hot-reloading frontend

Run the API server and the Vite dev server side by side:

```bash
# terminal 1
go run ./cmd/worktree-studio

# terminal 2
cd web
bun install
bun run dev       # http://localhost:5173, proxies /api/* to :8787 (see web/vite.config.ts)
```

Open `http://localhost:5173/` — API calls to `/api/...` are proxied to the Go server.

## Frontend component tests

```bash
cd web && bun run test
```

Uses Vitest + `@testing-library/react` against jsdom (config: `web/vitest.config.ts`). This exists specifically to catch real interaction bugs — event propagation into a parent element, a modal that doesn't actually render its content — by executing the real components, since there's no browser-automation tool available in every environment this project gets worked in. Test files are `*.test.tsx` next to the component they cover, and are excluded from the production `tsc -b` build (see `web/tsconfig.json`'s `exclude`) — they don't need to type-check against the same strictness as shipped code, and `vitest run` doesn't go through `tsc -b` at all.

**Known limitation**: jsdom does not compute layout or paint, so these tests can confirm the right DOM exists and the right event handlers actually ran, but cannot catch a purely-CSS-caused invisibility bug (e.g. text rendering the same color as its background). Treat a passing test suite as "the interaction logic is correct," not "this looks right" — a real visual check (in a browser, or by asking whoever's driving the session to look) is still the only way to confirm actual appearance.

## Data locations

- SQLite registry: `~/.worktree-studio/studio.db`
- Audit log (JSONL, append-only): `~/.worktree-studio/audit.log.jsonl`
- Created worktrees live under: `~/.worktree-studio/worktrees/<repoId>/<worktree-name>/`
- Terminal sessions are tmux sessions named `wts-<terminalId>` — not a file on disk, but visible via `tmux list-sessions`.

None of the above are created by the repo itself — the server creates `~/.worktree-studio/` and its subdirectories on first run if missing.

## Debugging

**Server logs go to stdout/stderr, not a file** — the server logs structured lines (via Go's `log/slog`) for every request (method/path/status, via chi's request logger) and every handler-level error (`s.Log.Error(...)` calls throughout `internal/api`). If you started the server in your own foreground terminal (the normal way — see above), those logs are just... right there in that terminal. If you need to capture them, redirect explicitly: `./worktree-studio 2>&1 | tee server.log`.

Run the server in your own terminal, in the foreground, so you can see its logs directly and stop it with a plain Ctrl-C when you're done. Backgrounding it (`&`, `nohup`, or having something else launch it detached) means you lose both of those — if something goes wrong, you have no logs to check and no easy way to tell it's even still running or stop it. If you ever do end up with an orphaned instance you can't otherwise reach: `lsof -iTCP -sTCP:LISTEN | grep 8787` finds it by port, `kill <pid>` stops it.

```bash
# tail the audit log while poking the UI
tail -f ~/.worktree-studio/audit.log.jsonl

# pretty-print with jq
cat ~/.worktree-studio/audit.log.jsonl | jq .

# confirm git's own view of worktrees for a given repo matches the UI
git -C /path/to/repo worktree list --porcelain
```

## Resetting local state

Local state is disposable (it's not migration data — it's a small registry):

```bash
rm -rf ~/.worktree-studio
```

This clears registered repos, the worktree registry, and the audit log. It does **not** remove any actual git worktrees already created on disk — remove those with `git worktree remove` (or delete them via the UI first).
