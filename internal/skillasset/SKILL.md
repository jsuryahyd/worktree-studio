---
name: worktree-studio
description: How to run and use worktree-studio, a local Go+React tool for managing git worktrees across registered repos (repo registration, worktree create/remove, audit log). Use when asked to start worktree-studio, register a repo with it, or create/remove a worktree through it.
---

# worktree-studio

`worktree-studio` is a small local web tool for managing `git worktree`s across one or more repos: register a repo once, then create/remove worktrees through a dashboard instead of hand-running `git worktree add/remove`. It's meant to be driven by both humans and agents.

**Status as of this section (steps 1–5 of `PLAN.md`): repo registration, worktree create/remove, tmux-backed terminals, spotlight, the dirty/ahead-behind status dashboard, and a CodeMirror-backed in-browser file editor all exist.** The following are explicitly **NOT built yet** — don't assume they exist or try to use them:
- No git diff view or "send comment to agent" flow (planned: step 6 / TODO)
- No engine-picker UI for the editor (the adapter registry supports more than one engine; there's only one registered today and no UI to choose between engines)

Also important: spotlight does **not** install dependencies into a worktree. A freshly created worktree has only what `git worktree add` gives it — if you need `node_modules` there directly (rather than running things from the mirrored root), you still run your own install/build step.

## Installing worktree-studio

There's no installer script today — setup is a few manual commands, and this section exists so an agent can do first-time setup from the skill alone rather than having to separately discover `docs/running-locally.md`.

**Prerequisites** (check before starting; installing them is out of scope for this skill — surface which are missing and stop rather than guessing at install commands for the user's OS):
- Go 1.21+ (`go version`) — the module uses `modernc.org/sqlite`, a pure-Go driver, so no cgo/sqlite3 headers are needed.
- [Bun](https://bun.sh) (`bun --version`) — used as the frontend package manager/runner instead of npm.
- `git` on `PATH` (`git --version`) — every worktree operation shells out to the real binary.
- `tmux` on `PATH` (`tmux -V`) — terminal tabs are real tmux sessions; see "Using terminals" below for why. Without it, terminal creation fails outright (not a soft-degrade like spotlight below).
- Optional: the standalone `spotlight` CLI (`command -v spotlight`, `github.com/JayaSuryaOolio/spotlight`) plus its own `fswatch` dependency. worktree-studio runs fine without it — spotlight's endpoints just report `{"available": false}` / `503` until it's installed. See "Using Spotlight" below.

**First-time setup:**

```bash
cd ~/work/worktree-studio         # or wherever this project's checkout lives
cd web && bun install && bun run build && cd ..   # builds web/dist/, embedded into the Go binary
go build -o worktree-studio ./cmd/worktree-studio
./worktree-studio                 # foreground, so you can see logs and Ctrl-C it — see "Debugging: server logs" below
```

`go build ./...` alone (before the frontend is ever built) still succeeds — `web/dist/` ships a placeholder so the `go:embed` directive always has something, and the server serves a "run `bun run build`" page instead of crashing. You only need the frontend build for the real UI.

Verify it worked: `curl http://localhost:8787/api/repos/` should return `[]` (or your existing registered repos, if `~/.worktree-studio/studio.db` already has data from a prior run — this state persists across restarts by design).

**Put the binary on `PATH` too, not just in this checkout.** `go build -o worktree-studio ./cmd/worktree-studio` only produces a binary in the current directory — running plain `worktree-studio` from anywhere else (e.g. a tmux pane sitting in some worktree's own directory, which is exactly where `open-file` below gets used) fails with a zsh/bash "command not found" until it's actually installed somewhere your shell already searches:

```bash
cp worktree-studio ~/.local/bin/    # or wherever's already on your PATH — check with `echo $PATH`
```

Rebuild-and-recopy after any change to `cmd/worktree-studio/` (this binary also embeds `web/dist`, so also recopy after a frontend rebuild if you want the CLI's copy serving the latest UI too, though for the pure-CLI subcommands below only the Go code matters).

Once the server is running, check dependency status (tmux, spotlight, this skill globally, the claude hook) via the settings modal (gear icon in the sidebar) or `curl http://localhost:8787/api/settings/dependencies` — see "Global settings" and "Claude Code session-tracking hook" below for the two dependencies that are actionable (install/uninstall) directly from there. There's still no automatic report at server startup or a standalone `doctor` CLI — checking is on-demand via that endpoint/UI, not push-notified.

## Starting the server

```bash
cd ~/work/worktree-studio
go run ./cmd/worktree-studio          # dev, or:
go build -o worktree-studio ./cmd/worktree-studio && ./worktree-studio   # built binary
```

Listens on `http://localhost:8787` by default (`WORKTREE_STUDIO_ADDR` env var sets the starting port; if it is busy the server logs it and tries the next ports up, so read the `worktree-studio listening` log line for the real address). The frontend must be built at least once for the real UI to render (`cd web && bun install && bun run build`) — see `docs/running-locally.md`. Until then the server still starts fine and serves a placeholder page telling you to build the frontend.

## Registering a repo

Via the UI: go to `/`, enter an absolute path to an existing git repo, optionally a display name, submit.

Via the API directly (e.g. from a script or agent):

```bash
curl -X POST http://localhost:8787/api/repos/ \
  -H "Content-Type: application/json" \
  -d '{"name": "adelaide", "path": "/Users/you/conductor/workspaces/pos/adelaide"}'
```

The path must be a real directory and a real git working tree (checked via `git rev-parse --is-inside-work-tree`); a repo already registered at that exact path is rejected with 409. The response includes the repo's `id`, which every subsequent worktree call needs.

## Creating a worktree

The create dialog prefills a random **adjective-noun** name (e.g. `amber-ridge`, Docker-container-name style) from `GET /api/repos/:repoId/worktrees/new-name-suggestion` — this is just a convenience default; edit the text field before submitting if you want a different name. Whatever name ends up submitted is slugified and used as **both** the git branch name and the worktree's directory name.

```bash
# get a suggested name (optional — you can pick your own)
curl http://localhost:8787/api/repos/<repoId>/worktrees/new-name-suggestion

# create
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/ \
  -H "Content-Type: application/json" \
  -d '{"name": "amber-ridge"}'
```

This runs `git worktree add -b amber-ridge <path> [startPoint]` against the registered repo, placing the new worktree at `~/.worktree-studio/worktrees/<repoId>/amber-ridge` — **outside** the source repo's own directory tree (deliberate: keeps the main repo's `.gitignore`/tooling from getting confused by a nested worktree). List worktrees for a repo with `GET /api/repos/:repoId/worktrees/`.

**Base branch (`startPoint` above)**: without an explicit start point, git's own default is whatever the main repo checkout's HEAD happens to be at that moment — *not* reliably "the" base branch, since the main checkout could itself be left on a feature branch when a new worktree gets created. To avoid that, `handleCreateWorktree` resolves a start point before calling `AddWorktree`: it uses `Repo.BaseBranch` (an explicit per-repo override) if set, otherwise it auto-detects via `gitops.DetectDefaultBranch` — `origin/HEAD`'s target, else a local `main`, else a local `master`, else "" (falls back to git's implicit-HEAD default, same as before this existed). Set the override from the repo settings page (gear icon on a sidebar repo row → **General** tab), or directly:

```bash
curl -X PUT http://localhost:8787/api/repos/<repoId>/settings \
  -H "Content-Type: application/json" \
  -d '{"base_branch": "develop", "external_worktrees_root": ""}'

# revert to auto-detect
curl -X PUT http://localhost:8787/api/repos/<repoId>/settings \
  -H "Content-Type: application/json" \
  -d '{"base_branch": "", "external_worktrees_root": ""}'
```

This same endpoint also holds `external_worktrees_root` (see "Auto-discovering worktrees from another tool" below) — both fields are always written together from one request body, so a call that means to change only one of them still has to send the other's current value, not omit it (an omitted field decodes to `""` and would silently clear it).

### Creating a worktree from a shell command (e.g. as Claude, without touching the UI)

`worktree-studio create-worktree <name> [--branch <source-branch>] [path]` creates a worktree *through* worktree-studio's own server (same audit logging, same UI list) instead of requiring the repo's id — the same "resolve from a filesystem path" idiom `open-file`/`spotlight` already use:

```bash
worktree-studio create-worktree amber-ridge                   # repo = whichever one cwd is inside
worktree-studio create-worktree amber-ridge /path/to/repo-or-worktree   # or target one by path, from anywhere
worktree-studio create-worktree amber-ridge --branch develop   # branch off something other than the repo's default
```

`path` is optional and defaults to the current working directory (same implicit-cwd convention as `open-file`/`spotlight`); when given, it can be the repo's own root checkout *or* any of its existing worktrees — both are resolvable, since every repo's root checkout is itself tracked as a synthetic worktree row (see `EnsureRootWorktree`). This is what lets an agent already working inside one worktree spin up a sibling worktree of the same repo just by running this from where it already is. Same tolerance as `open-file`/`spotlight`: a path outside every repo/worktree `worktree-studio` tracks is a silent no-op (exit 1, nothing happens), not an error.

## Attaching an existing worktree (no git mutation)

For a worktree created some other way — by hand with `git worktree add`, or by another tool — there's a separate "attach" flow that registers it without running any git command at all. In the UI: the sidebar's per-repo "📂" button (next to the "+" for a new worktree), or "📂 Attach existing worktree in `<repo>`" in the command palette.

```bash
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/import \
  -H "Content-Type: application/json" \
  -d '{"path": "/absolute/path/to/existing/worktree"}'
```

The path must already appear in `git worktree list --porcelain` run from the registered repo's root — anything else is a `400`. A detached-HEAD worktree is also rejected (`400`): most of this app assumes a real branch. Re-importing an already-registered path is a `409`, not a silent no-op. `name` is optional in the request body; when omitted it defaults to `ext_<directory name>` — the `ext_` prefix is deliberate, so an attached worktree is visually distinguishable in the list from one this tool created itself (which is always a bare adjective-noun slug).

## Auto-discovering worktrees from another tool

Attaching one worktree at a time (above) is fine occasionally, but a repo that's actively driven by a second tool creating its own worktrees (e.g. Conductor's `~/conductor/workspaces/<repo>/<name>`) shouldn't need a manual "Attach" click for every single one. Each repo's settings page (gear icon on its sidebar row → General tab) has an **"External worktrees root"** field — an absolute path that other tool's own worktrees for this repo live under. Once set, the frontend calls the discover endpoint for every registered repo right after the repo list loads (`RepoContext.tsx`) — so on every page load, any not-yet-tracked `git worktree` under that path is registered automatically, with no click required.

```bash
# configure the root (send base_branch too — see above: this PUT always writes both fields together)
curl -X PUT http://localhost:8787/api/repos/<repoId>/settings \
  -H "Content-Type: application/json" \
  -d '{"base_branch": "", "external_worktrees_root": "/Users/you/conductor/workspaces/this-repo"}'

# trigger discovery directly (normally the frontend does this on page load)
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/discover
# -> [] if nothing new (also the response when no root is configured at all — a deliberate no-op, not an error)
```

Candidates are found the same way `git worktree list` already reports every worktree of a repo regardless of who created it — this only adds a path-prefix filter (so an unrelated stray worktree elsewhere doesn't get silently onboarded) and does the registration automatically rather than waiting for a click. Same rules as manual import: a candidate outside the configured root is left alone (still shows up in the settings page's "Other git worktrees" attach list instead), a detached-HEAD candidate is skipped rather than failing the whole batch, and an already-registered path is never re-imported — re-running discover is a no-op once everything under the root is known. Onboarded worktrees get `source: "imported"` and the same `ext_<dirname>` naming as a manual attach, and log a `worktree.auto_discover` audit event (vs. manual attach's `worktree.import`) so the per-worktree audit log records which path this actually came from.

## Repairing a worktree whose registered path went stale

A worktree's `path` in the registry can end up pointing at somewhere that no longer exists — the concrete case found live: a worktree's `path` was `/private/tmp/claude-<id>/.../scratchpad/<name>`, a Claude Code session's own scratchpad directory. Scratchpad dirs are explicitly ephemeral (session-scoped cleanup targets, not persistent storage), so once that session ended, the directory — and everything in it — was gone, even though the worktree's DB row and its branch lived on. Symptom: the worktree shows up fine in the list with a plausible-looking path, but nothing in it works (file tree empty/erroring, terminals opening into a directory that doesn't exist). **Never point a worktree at a scratchpad path** — always create it under `~/.worktree-studio/worktrees/<repoId>/<name>` (what `handleCreateWorktree` itself always uses) or import an existing checkout that already lives somewhere real.

Diagnose it directly against the store and git, not by guessing from the UI:

```bash
sqlite3 -separator '|' ~/.worktree-studio/studio.db \
  "SELECT id, repo_id, name, branch, path FROM worktrees WHERE name LIKE '%<hint>%' OR branch LIKE '%<hint>%';"
ls -d "<that path>"                        # confirms it's actually gone
git -C <repo's root path> worktree list    # confirms git itself never tracked that path —
                                            # if the path doesn't appear here at all, it was
                                            # never a real `git worktree add` checkout to begin
                                            # with (e.g. built by hand-placing files in a
                                            # scratchpad rather than through git or this app)
```

If the branch still exists (`git branch -a` in the repo) and isn't checked out elsewhere, the repair is: create a real worktree for that **existing** branch (no `-b`, so it attaches rather than creates a new one — `handleCreateWorktree` can't do this itself, since it always creates a fresh branch and errors if the name already exists), then point the registry row at it:

```bash
git -C <repo path> worktree add ~/.worktree-studio/worktrees/<repoId>/<name> <existing-branch>
sqlite3 ~/.worktree-studio/studio.db \
  "UPDATE worktrees SET path='<new path above>' WHERE id='<worktree id>';"
```

There's deliberately no API endpoint for "just fix this worktree's path" — the direct SQL `UPDATE` above is the actual repair, done in place so the worktree keeps its existing id (audit-log and terminal-session history for it stay attached, unlike a delete-then-reimport, which would hand it a new one). **Don't** reach for the UI's "delete" / `DELETE .../worktrees/<id>` on the broken row to start over instead: `hardRemoveWorktree` runs `git worktree remove --force <path>` on that stale path *first*, and since git never tracked it as a worktree, that command errors outright rather than treating "already gone" as a no-op — the delete never gets far enough to reach the DB row at all.

Check for terminal sessions recorded against the broken worktree too — the tmux session itself doesn't necessarily know its cwd disappeared (tmux keeps a dead-end shell alive; only a fresh `cd`/`ls` inside it would show it's broken), so it can still show as "live" while being just as unusable as the worktree was:

```bash
sqlite3 -separator '|' ~/.worktree-studio/studio.db \
  "SELECT id, tmux_session_name, tab_label FROM terminal_sessions WHERE worktree_id='<worktree id>';"
curl -X DELETE http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/terminals/<terminalId>
```

That goes through `handleDeleteTerminal` (kills the tmux session, removes the row, audit-logged) rather than killing tmux directly — same reasoning as "Cleaning up orphaned tmux sessions" above: prefer the app's own paths over hand-run commands wherever one already exists. Open a fresh terminal tab in the repaired worktree afterward rather than trying to resuscitate the old one.

## Archiving a worktree (not "delete" anymore)

Via the UI: each worktree row's kebab menu ("⋮") has **"Archive"** — this replaced "Delete" as the everyday action. Archiving is a pure visibility flag: it hides the worktree from the normal list, but does **not** touch git at all — the worktree checkout, its branch, and anything recorded against it (a claude session, see below) all stay exactly as they were on disk. There's a confirm prompt explaining this before it happens.

Via the API:

```bash
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/archive
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/unarchive   # reverse it
```

**Pinning a worktree** exempts it from ever being archived — `POST .../archive` returns `409` for a pinned one — and sorts it ahead of every unpinned worktree in its repo, both in the sidebar and in `GET .../worktrees/`. In the UI: the pin icon in a worktree's expanded card (fills solid when on) — nothing shows on the collapsed row; an earlier always-visible glyph there was removed per direct feedback that it took up space and was distracting.

```bash
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/pin
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/unpin   # reverse it
```

Unlike archive, neither direction has a confirm dialog — pinning destroys nothing and is instantly reversible. This is one of a small, deliberately centralized set of "worktree lifecycle rules" (`internal/api/worktree_rules.go` on the backend, `web/src/worktreeRules.ts` on the frontend — see `docs/architecture.md`'s note on the same subject) — a future rule of this shape (another action a worktree can be exempted from, another sort key) belongs in those same two files, not as a new scattered conditional.

There's currently no UI to browse archived worktrees — that's planned as part of a future settings-modal datagrid (bulk-manage worktrees across repos, filtered by repo/status), not built yet. To find one again in the meantime, query the API directly:

```bash
curl http://localhost:8787/api/repos/<repoId>/worktrees/     # active only by default
```

(The store layer supports filtering `ListWorktrees` by any set of statuses, but the REST endpoint doesn't expose a status query param yet — another piece the settings modal will need.)

Real, destructive deletion (`git worktree remove --force` + removing the registry row) still exists at the API layer, it's just not reachable from the kebab menu anymore:

```bash
curl -X DELETE http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>
```

This does not touch the branch itself (only the worktree checkout) and, unlike archive, is not reversible.

## Debugging: server logs

The server logs to stdout/stderr (structured, via `log/slog`) — always run it in a foreground terminal you can see, not backgrounded/detached, so you have the logs and a way to Ctrl-C it. If a request fails ("failed to create git worktree", "failed to save worktree record", etc.), the corresponding `s.Log.Error(...)` line with the real underlying error is right there in that terminal — check it before guessing. If you suspect an orphaned/forgotten instance is running (e.g. an error you can't explain, or the UI behaving as if state exists that you don't recognize): `lsof -iTCP -sTCP:LISTEN | grep 8787` finds it by port; `ps -p <pid> -o command,lstart` shows what it actually is and when it started before you kill it.

## Debugging: the audit log

Every mutating action (repo add, worktree create, worktree remove, and every mutating action added in later steps) writes one JSON line to:

```
~/.worktree-studio/audit.log.jsonl
```

If something happened that you're trying to explain ("did that worktree actually get created?", "when was this repo registered?"), check there first:

```bash
tail -f ~/.worktree-studio/audit.log.jsonl      # watch live
cat ~/.worktree-studio/audit.log.jsonl | jq .    # pretty-print everything
```

Example lines:

```json
{"ts":"2026-08-06T18:36:03.004484Z","event":"worktree.create","repo_id":"97cc943ecf3a0613","worktree_id":"5bb4a682c09f0a28","name":"amber-ridge","branch":"amber-ridge","path":"/Users/you/.worktree-studio/worktrees/97cc943ecf3a0613/amber-ridge"}
```

Other useful local state:
- SQLite registry: `~/.worktree-studio/studio.db`
- Created worktrees: `~/.worktree-studio/worktrees/<repoId>/<name>/`

`rm -rf ~/.worktree-studio` resets all registry/audit state (does not remove worktrees already created on disk — use `git worktree remove` or the UI for those first).

## Using terminals

Click "Open" on a worktree row to get to its detail page (`/repo/:repoId/worktree/:worktreeId`). Terminals are arranged via **dockview**, not a plain tab strip — the toolbar's right-hand cluster has three placement buttons:

- **+ (New terminal tab)** — adds it as a tab within the currently active group; selecting that tab shows it full-size, other tabs in the same group hidden (classic single-visible-at-a-time behavior).
- **Split right** / **Split down** — adds it as a new tile shown *simultaneously* alongside the existing one. Drag the boundary between tiles to resize them (dockview's native split-view behavior).

Each starts a real shell rooted in that worktree's directory — run anything in it, including `claude` itself; there's no special agent framing, it's just a shell. There is deliberately **no OS-level popout** into a separate browser window — that was considered and explicitly ruled out, not deferred.

**Tab labels and app detection**: a tab's label defaults to `"shell"` (or `"claude"` for the auto-started terminal — see the claude session hook section below) via `tab_label` on `POST .../terminals/`; the backend always defaults an empty/omitted `tab_label` to `"shell"`, and the frontend mirrors that same fallback wherever it renders a tab, so a tab title should never render blank. Independently, a tab's icon and displayed title can change live: `web/src/terminalAppDetection.ts` watches the pane's OSC 0/2 window-title escape sequences (relayed through tmux via `set-titles on`, see `internal/term.CreateSession`) for known-app signatures — currently just `claude`, matched on the substring `"Claude Code"` it sets as its own title — and swaps in that app's icon/label while it's running, reverting to the tab's own base label once the title stops matching (e.g. the app exits back to a plain shell). Because tmux only *emits* that title escape sequence to a client on an actual change, not on a fresh attach, `internal/term.CurrentTitle` + `handleTerminalWS` replay the pane's current title as a synthetic escape sequence right after attaching — without this, reloading the page (or navigating back to a worktree) while `claude` is already running inside it would show the generic tab label/icon until something inside the pane happened to touch the title again.

**The arrangement itself persists** — reload the page, or kill and restart the whole worktree-studio server, and the same split/tab layout comes back (verified both ways against a real server). It's saved server-side (`GET/PUT /api/repos/<repoId>/worktrees/<worktreeId>/layout`, debounced ~500ms after any drag/resize/tab-switch), not in browser storage — it'll follow you to a different browser or machine too.

Via the API:

```bash
# create a terminal
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/terminals/ \
  -H "Content-Type: application/json" -d '{"tab_label": "main"}'

# list terminals for a worktree
curl http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/terminals/

# close one (kills the shell inside it)
curl -X DELETE http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/terminals/<terminalId>
```

Each terminal is actually a **tmux session** (named `wts-<terminalId>`) that the server attaches to — not a bare process the server owns directly. The load-bearing consequence: **restarting worktree-studio's server does not kill anything running in a terminal**. A long build, a `claude` session, whatever — it keeps running, and reattaching (reload the tab, or just leave it open through a restart) picks the session back up with scrollback intact. See `docs/session-persistence.md` for the full explanation and a manual restart-survival test you can run yourself.

If you need to poke at a terminal's underlying tmux session directly (e.g. to debug something the UI isn't showing correctly), it's a completely normal tmux session:

```bash
tmux list-sessions | grep wts-
tmux attach -t wts-<terminalId>       # attach from your own real terminal, alongside worktree-studio's ws client
tmux capture-pane -p -t wts-<terminalId>   # dump the current pane contents without attaching
```

### Cleaning up orphaned tmux sessions

A `wts-`-prefixed tmux session with no matching terminal_sessions row (a leaked test session, or one made by hand) is an **orphan** — don't hand-kill these with `tmux kill-session` based on eyeballing `tmux list-sessions`. That was tried exactly once, informally, and it killed real, still-in-use sessions along with the actual leaks, because "looks unattached" and "actually abandoned" aren't the same thing.

```bash
worktree-studio orphans                          # list only, nothing killed — 7-day activity window by default
worktree-studio orphans --kill                   # kill only the ones NOT active in the last 7 days
worktree-studio orphans --kill --min-age=24h      # a different (still real, still enforced) window
```

Every session is checked against tmux's own `#{session_activity}` (last output in any of its panes — covers a `claude` session producing output on its own, not just keystrokes) before anything is killed; anything touched inside the window is reported as `protected` and left alone. There's no flag to bypass this — only to choose a different window, which is a visible, deliberate call at the command line, not a silent one. See `internal/term/orphans.go` for the actual safeguard and why it lives there rather than in the CLI itself. A dead tmux session's **stale DB row** (the opposite mismatch — the row survives after the session itself dies, e.g. `claude` exiting and taking the whole session down with it since it was the pane's only process) is handled separately by `Reconcile` at server startup, not by this command. It's also handled the moment someone actually tries to open that tab: `handleTerminalWS` checks `term.HasSession` before attaching and, if the session's already gone, writes a plain "this session no longer exists, close this tab" message instead of relaying tmux's own `can't find session: ...` stderr through the pty as if it were real pane output (which is what it did before this check existed) — it deliberately doesn't delete the row itself, leaving that to closing the tab (`handleDeleteTerminal`) or the next `Reconcile`, so there's still exactly one path that removes a `terminal_sessions` row.

The "⧉ New tab" button on a worktree's detail page just opens the same page in a new browser tab (`window.open`) — it's the mechanism for the multi-repo story too: open a different repo's workspace in another tab, no special multi-repo UI needed.

**Copy/paste in a terminal panel**: Ctrl+C/Cmd+C copy a selection, Ctrl+V/Cmd+V paste. Drag-to-select-then-release also copies directly (via tmux's own mouse handling + OSC 52), working the same inside a plain shell or inside a program like `claude` that's grabbed its own mouse tracking — tmux's own copy-mode (`Ctrl+b` then `[`, move/select, `Enter`) is a keyboard-only fallback, not required for the normal case anymore. If copy/paste (or link-clicking) seems broken, see `docs/terminal-clipboard.md` — kept as its own doc since it's deep xterm.js/tmux mechanism detail, not something every session needs to read.

## Editing files

Every worktree's detail page has a file tree sidebar (toggle with the "📁 Files" toolbar button) alongside the terminal area. Click a file to open it in a syntax-highlighted CodeMirror editor panel, docked into the same dockview grid as terminals — it can be split/tabbed the same way. This is a **light editor for quick edits**, not an IDE: no autosave (Cmd/Ctrl+S to save explicitly), no multi-cursor-heavy refactoring tools. For anything beyond light editing, click "💻 VS Code" in the toolbar to open the worktree in real VS Code instead (`code <worktree-path>` under the hood) — that button is disabled if the `code` CLI isn't on `PATH` (a one-time manual "Shell Command: Install 'code' command in PATH" step inside VS Code itself; check status the same way as tmux/spotlight, via the settings modal or `curl http://localhost:8787/api/settings/dependencies`, key `vscode_cli`).

If a file changes on disk while it's open (e.g. a `claude` session in the same worktree's terminal edits it, or a `git checkout`), the editor picks that up automatically: silently, if you haven't made unsaved edits; with a "this file changed on disk — Reload / Keep editing" banner if you have.

Via the API:

```bash
# file tree (nested; tracked + untracked-but-not-gitignored files)
curl http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/files/tree

# read/write a file's content (path relative to the worktree root)
curl "http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/files/content?path=src/main.go"
curl -X PUT "http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/files/content?path=src/main.go" \
  -H "Content-Type: application/json" -d '{"content": "new file content\n"}'

# open the worktree in real VS Code
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/open-in-vscode
```

Files over 5MB or that aren't valid UTF-8 text (binaries, images) refuse to open here (`422`) — use VS Code for those. Paths are validated against escaping the worktree root (`../../etc/passwd`-style attempts get a `400`), the same seriousness as the absolute-path rejection on repo registration.

Built as a layered adapter (`web/src/editors/`) rather than hard-wiring CodeMirror everywhere — see `docs/editor.md` and `docs/editor-plan.md` if you need to swap or add an editing engine later; nothing about the file tree, dockview wiring, or save/reload flow needs to change to do that.

## Opening a file from a shell command

`worktree-studio open-file <path>` tells the browser tab that has a worktree open to open a file in its CodeMirror editor — run it from inside that worktree's own directory (e.g. one of its tmux-backed terminal panes, or set as `$EDITOR` so `git commit` and similar tools hand off to it):

```bash
cd ~/.worktree-studio/worktrees/<repoId>/<name>   # or a subdirectory of it
worktree-studio open-file src/main.go             # relative to cwd, or an absolute path
```

Requires the `worktree-studio` binary to be on `PATH` (see "Installing worktree-studio" above) — a zsh `command not found` here means it isn't yet, not that the feature is broken. It also requires the running server (whichever one is already serving the UI you want the file to open in) — this subcommand just POSTs to it, it doesn't start anything itself.

What happens depends on where the target worktree is right now:
- If its detail page is already the open, focused browser tab, the file opens immediately.
- Otherwise the browser navigates there first (or gets a queued instruction, if the tab is open on a different worktree/page) and opens it right after.
- If the shell's current directory isn't inside any worktree `worktree-studio` is tracking, it's a silent no-op (exit 1, nothing happens) — the same "no matching worktree" tolerance the Claude Code hook uses for the same reason: this can be run from anywhere, and a shell outside a tracked worktree is an expected, common case, not an error.

Scope is deliberately worktree-relative: `<path>` must resolve inside the target worktree's root (same `../../etc/passwd`-style escape rejection as the file-editor endpoints above) — opening an arbitrary file anywhere on disk isn't supported (see the open TODO in `PLAN.md`).

## Using Spotlight

Spotlight mirrors a worktree's source files into its repo's **root checkout** — continuously, while active — so you can build/run from the root path (which already has `node_modules`/build output installed) and have it always reflect whichever worktree is "in focus." It does **not** copy dependencies into the worktree itself; see the caveat at the top of this file.

In the UI: the worktree list has a "Spotlight" column per row. "Start" begins mirroring that worktree into its repo's root; once active, the row shows "● in focus — Stop." If a *different* worktree of the same repo is already the active mirror, that row's button reads "Start (will replace active mirror)" — starting one automatically stops the other, matching the underlying tool's own one-at-a-time design.

Via the API:

```bash
curl http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/spotlight/          # status
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/spotlight/start
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/spotlight/stop
```

`start` returns `409` if the repo's root checkout has uncommitted changes — that's the underlying `spotlight` CLI itself refusing, on purpose, so it never clobbers real work sitting in the root. Commit or stash there first, then retry. This is real, unforced behavior: it will happen for genuinely dirty repos, not just in tests.

Requires the standalone `spotlight` CLI to actually be installed (`github.com/JayaSuryaOolio/spotlight`, plus its own `fswatch` dependency) — if it's missing, the status endpoint reports `{"available": false}` rather than erroring, and start/stop return `503`. See `docs/spotlight-sync.md` for the full design (including a correction: this used to be planned backwards before the real tool was found) and for debugging directly against the CLI (`spotlight list`, etc.) if something looks off.

### Starting spotlight from a shell command (e.g. as Claude, without touching the UI)

`worktree-studio spotlight --start|--stop|--status [--stash] [path]` does the same start/stop/status as above, but *through* worktree-studio's own server (same audit logging, same UI status view) rather than by shelling out to the external `spotlight` binary directly — this is what to reach for from inside a terminal panel instead of running `spotlight start` yourself, so the mirror you start still shows up correctly in the worktree list and audit log:

```bash
worktree-studio spotlight --start              # mirrors the worktree cwd is inside of
worktree-studio spotlight --start /path/to/worktree   # or target one by path, from anywhere
worktree-studio spotlight --start --stash       # same as ticking "stash and start anyway" in the UI's confirm dialog
worktree-studio spotlight --status
worktree-studio spotlight --stop
```

`path` is optional and defaults to the current working directory (same implicit-cwd convention as `open-file`); when given, it can be the worktree root or any subdirectory of it, and doesn't require actually being inside it first. Same tolerances as `open-file`: a path outside every tracked worktree is a silent no-op (exit 1, nothing happens), and `--start` on a dirty root refuses with the same message the UI would show, unless `--stash` is also given.

## Monitoring dashboard (dirty / ahead-behind)

Every worktree row has a "Status" column showing whether it's dirty (uncommitted changes/untracked files) and, if its branch has a configured upstream and actually diverges from it, an ahead/behind indicator (e.g. `↑1↓1`). This refreshes automatically every 5 seconds (plain REST polling — there's no websocket push for this) — no manual refresh needed, but also don't expect sub-5-second freshness.

Via the API directly:

```bash
curl http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/status
# {"branch":"amber-ridge","dirty":false,"has_upstream":false,"ahead":0,"behind":0}
```

`has_upstream` is `false` for most freshly created worktrees — `git worktree add -b <branch>` doesn't set up an upstream by itself, so `ahead`/`behind` being `0` in that case doesn't mean "in sync," it means "not tracking anything to compare against." The UI only shows the ahead/behind badge when `has_upstream` is true and there's an actual difference — check `has_upstream` yourself if scripting against this, don't just look at whether ahead/behind are zero.

## UI overhaul: sidebar, command palette, kebab actions

The UI is now built around a persistent left sidebar (not the flat pages described earlier in this file) — every registered repo is listed with its worktrees nested directly underneath, auto-loading whenever the selected repo changes (including a fresh browser tab opened straight at a worktree URL). All per-worktree operational actions (start/stop spotlight, delete) live behind each row's "⋮" kebab menu, not separate always-visible buttons.

**Command palette**: press `Cmd+K` (or `Ctrl+K`) from anywhere in the app to open a fuzzy-searchable palette — jump to any repo or worktree, or trigger "+ Add repo" / "+ New worktree in `<repo>`" without leaving the page you're on. This app is deliberately an SPA in the literal sense: no page-transition navigations for new capability, just modals, dropdowns, and this palette.

Adding a repo or a worktree is a modal now, not a page — reachable via the sidebar's "+" buttons or the command palette, not a separate route.

**Visual design**: see `docs/design-system.md` — the token contract, the seven principles each rule traces back to, and the three themes. `docs/design.md` is now just a pointer to it.

Three selectable themes on two independent axes, both set in the settings modal's **Appearance** tab and stamped on `<html>` as `data-theme` (family) and `data-mode`:

- **Graphite** — modern, the default. Neutral greys, one warm amber accent, no outlines.
- **Ledger** — classic. Warm paper/ink, square corners, deep editor blue.
- **Command Deck** — the pre-redesign theme, kept, mapped onto the same contract.

Mode is **Dark / Light / System**. `data-mode` is always a resolved `dark` or `light` — `system` is storable but resolved in `web/src/theme.ts` and the inline pre-paint snippet in `index.html`, never in CSS. Adding a theme means adding one palette block in `web/src/styles/tokens.css` that defines exactly the same token names as the others; a theme needing a new token is a redesign, not a theme.

**Sidebar behaviour** (all of it persisted in `localStorage`, `web/src/sidebarPreferences.ts`):

- Worktree rows are plain rows — no borders, no cards. Selection is a background wash plus a 2px accent rail, and exactly one row on screen has it.
- Branch names truncate in the **middle** (`web/src/branchLabel.ts`), because branch names are prefix-clustered and the tail is what tells them apart.
- `/` focuses a filter box (matches branch, worktree name and repo name across every repo at once). Escape clears before it blurs.
- Repo groups collapse; a collapsed group still shows its count and an attention dot if anything inside is waiting.
- A "N waiting" count in the sidebar header, rendering nothing at zero; click it to narrow the list to just those worktrees. Rows are deliberately **not** re-sorted attention-first — attention arrives over a websocket, so rows would reorder under the pointer.
- Drag the seam to resize (180–460px, double-click resets). `Cmd/Ctrl+B` hides the sidebar entirely; a 4px strip at the screen edge brings it back.

`/` and `Cmd+B` both go through `web/src/keyboard.ts` rather than binding directly: `/` bails on any text-entry target (xterm reads keys through a hidden textarea, so that check covers the terminal), and `Cmd+B` only honours `Ctrl` outside a terminal, since `Ctrl+B` is tmux's default prefix.

**Deleting a worktree also closes its terminal sessions now** (real tmux kill, not just a DB row disappearing via cascade) — found and fixed while building the dockview arrangement above; before this fix, a deleted worktree's tmux sessions leaked forever with no trace in the DB pointing back to them.

**Creating a worktree auto-starts a `claude` terminal with a known, resumable session id.** Both the sidebar "+"/command-palette flow and the worktree-list "+ New worktree" button create the worktree, then immediately create one terminal in it running `claude --session-id <uuid> -n <name>` as the first command (via `tmux send-keys`, a real argv element — no shell interpolation involved; the uuid is generated client-side via `crypto.randomUUID()` *before* claude ever starts, specifically so it's known and loggable). This also logs a `claude.session.create` audit event with that session id and title — see "Per-worktree audit log" below for why that survives independent of the terminal itself. If the terminal-creation step fails (e.g. tmux unavailable), the worktree itself is still created and usable; you just don't get the auto-started terminal, and the error is logged to the browser console rather than blocking worktree creation. To get the same behavior from the API directly, pass `initial_command` plus the two claude fields when creating a terminal:

```bash
curl -X POST http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/terminals/ \
  -H "Content-Type: application/json" -d '{
    "tab_label": "claude",
    "initial_command": "claude --session-id 11111111-1111-1111-1111-111111111111 -n feature",
    "claude_session_id": "11111111-1111-1111-1111-111111111111",
    "claude_session_title": "feature"
  }'
```

## Per-worktree audit log

Every worktree's kebab menu ("⋮") has a **"View worktree log"** item, and `WorktreeDetail.tsx` (the terminal view) has a "🕐 Log" toolbar button — both open the same dialog: every audit-log event recorded for that specific worktree (worktree create/remove/archive/unarchive, branch checkouts — see "Branch-tracking git hook" below, terminal open/close, spotlight start/stop, claude session started), newest first, with a friendly label/icon and a one-line summary (branch name, terminal tab label, claude session id). Click "raw" on any entry to see the full JSON line as actually written to `~/.worktree-studio/audit.log.jsonl`.

**Resuming a claude session later**: find its `claude.session.create` entry in this log (or grep the JSONL file directly for `claude_session_id`), then in a terminal inside that worktree run `claude --resume <the-id>`. There's no one-click "Resume" button yet — this is a manually-actionable record, not an automated flow (see the TODO in `PLAN.md`). This only works if the worktree itself hasn't actually been deleted (archiving is fine — see "Archiving a worktree" above — but real delete removes the git checkout `claude --resume` would need).

This view survives the worktree itself being deleted — it's driven by the worktree id, not a live DB row, so it's a real record of "what happened to this piece of work" independent of whether the worktree/terminal sessions behind it are still alive. Useful as a lightweight checkpoint trail: e.g. confirm exactly when a worktree was created, or when its last terminal was closed, without digging through the raw JSONL by hand.

## Claude Code session-tracking hook (more reliable than the launch-time id above)

The launch-time `--session-id`/`claude.session.create` logging above has two real gaps: it only sees sessions worktree-studio itself starts, and the auto-started terminal doesn't always actually get created (an observed race). A real Claude Code `SessionStart` hook fixes both — it fires for *every* claude session on the machine, including ones started by hand in a plain shell, and doesn't depend on worktree-studio's own terminal-creation flow succeeding.

The same "Claude session-tracking hook" dependency also installs a **`Notification` hook** — fires when a claude session is blocked on a permission prompt or has gone idle waiting for input. Instead of an audit-log entry, this marks the resolved worktree "pending" and pushes it to every open browser tab over `/ws/attention`: the sidebar shows a persistent amber pulsing dot on that worktree's row, and if you're not currently looking at it (a different worktree/route is open, or the browser window itself isn't focused) you also get a short sound and — desktop notifications are **on by default** (the app requests browser permission proactively on load; turn it off in the settings modal's Appearance tab if you don't want it) — a real desktop notification, clicking which jumps straight to that worktree. The dot clears itself the moment you open that worktree's detail page. See `internal/attention` and `docs/architecture.md`'s "Claude Code Notification hook + attention badges" section for the full design. **Not yet built** (needs a design pass first, see `PLAN.md`'s TODO): answering Claude's prompt directly from the notification itself, without switching to the terminal.

**Install it** from the settings modal (gear icon in the sidebar → Installation tab → "Install" next to "Claude session-tracking hook"), or directly via the API — this one action installs both hooks together:

```bash
curl -X POST http://localhost:8787/api/settings/dependencies/claude-hook/install
curl -X POST http://localhost:8787/api/settings/dependencies/claude-hook/uninstall   # reverse it
```

This is the one action in this whole tool that edits a file outside `~/.worktree-studio/` — your real, global `~/.claude/settings.json`, shared with every other tool that registers a Claude Code hook. It's safe to run: it only ever merges one clearly-marked entry into each of `hooks.SessionStart` and `hooks.Notification` (never touches any other key or any other tool's hooks), backs the file up to `~/.worktree-studio/backups/claude-settings-<timestamp>.json` before every write, and is idempotent (installing twice doesn't duplicate either entry; a partial install — e.g. only one of the two survived a hand-edit — self-heals the missing half on the next install rather than needing an uninstall first).

Once installed, a `claude.session.create` entry with `"source": "hook"` appears in a worktree's audit log automatically the next time a claude session starts with that worktree's path as its cwd — no title is logged up front for these (unlike the launch-time ones), but the audit log viewer fetches one live from the session's own transcript (see `GET /api/claude-sessions/:id/title`, backed by `~/.claude/projects/`). That endpoint reads through to a small SQLite-backed cache: a successful live read is stored, and if a later lookup's transcript is gone (Claude Code prunes old session transcripts on its own schedule, unrelated to anything worktree-studio does) the cached title is served instead of the request silently falling back to a bare session id.

## Branch-tracking git hook

A worktree's audit log also records `worktree.branch_change` — every real `git checkout`/`git switch` onto a different branch inside it, not just the branch it was created with — via a real `post-checkout` git hook (see `internal/githook`). Because every worktree of a repo shares one physical `.git/hooks/` directory (`git worktree` doesn't support per-worktree hooks), this installs **once per repo**, not per worktree.

**Install it** from that repo's settings page (`/repo/:repoId/settings`, gear icon on the repo's sidebar row → General tab → "Branch-tracking git hook"), or directly via the API:

```bash
curl -X POST http://localhost:8787/api/repos/<repoId>/git-hook/install
curl -X POST http://localhost:8787/api/repos/<repoId>/git-hook/uninstall   # reverse it
curl http://localhost:8787/api/repos/<repoId>/git-hook/                   # {"installed": true|false}
```

Like the claude-hook above, this is the one other action that edits something outside `~/.worktree-studio/` — the registered repo's own shared `.git/hooks/post-checkout`. It's additive, not destructive: if that repo already has a post-checkout hook doing something else, the installed content is appended (backed up first to `~/.worktree-studio/backups/post-checkout-<timestamp>`) rather than overwritten, and uninstalling removes only the marked block it added — leaving any pre-existing hook content, or anything hand-added since, untouched. If our block turns out to be the hook's entire content, uninstall removes the file outright rather than leaving a no-op stub behind.

## Global settings

A gear icon in the sidebar header opens a settings modal with three tabs: **Installation** (status for tmux, the spotlight CLI, the globally-installed skill, and the claude hook above, with Install/Uninstall buttons for the latter two), **Appearance** (theme family + dark/light/system mode, and the desktop-notification toggle — all stored in `localStorage`; see "Visual design" above), and **Logs** (this server's own recent `ERROR`-level lines, plus the log file's real path — `~/.worktree-studio/server.log`). Via the API:

```bash
curl http://localhost:8787/api/settings/dependencies   # dependency status
curl http://localhost:8787/api/settings/logs           # recent error lines + log file path
```

Installing the skill globally (`~/.claude/skills/worktree-studio/`, distinct from this project's own `.claude/skills/worktree-studio/`) makes it available from any project, not just when working inside this repo's own checkout:

```bash
curl -X POST http://localhost:8787/api/settings/dependencies/skill/install
```

There's no cross-repo worktree view anymore (removed per direct request — it duplicated each repo's own settings page). Every worktree, including archived ones, is scoped to its repo: see each repo's settings page (gear icon on its sidebar row), whose **Worktrees** tab has Local/Imported/Archived sections, the last with an Unarchive button and a days-until-auto-delete column (archived worktrees are hard-removed — git worktree + DB row, no soft-delete — after 60 days; see `internal/api/archive_sweep.go`).

Via the API directly:

```bash
curl http://localhost:8787/api/repos/<repoId>/worktrees/<worktreeId>/audit-log
# [{"ts":"...","event":"worktree.create","repo_id":"...","worktree_id":"...","name":"...","branch":"..."}, ...]
```

Not yet built (ideas, not commitments): a way to add a free-text checkpoint note manually (e.g. "sent PR link to reviewer"), and event types for repo-hosting-platform actions (branch pushed, PR opened/merged) once any such integration exists — right now every event this log can show is one this tool itself already causes.

<!-- Each later build step (diff/comment-to-agent, etc.) appends its own section here per PLAN.md — this file is a living doc, not written once. The editor's own section is "Editing files" above. -->
