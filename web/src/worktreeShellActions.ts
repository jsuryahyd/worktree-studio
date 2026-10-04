import type { NavigateFunction } from "react-router-dom";
import { getActiveWorktreeActions } from "./activeWorktreeActions";
import { setPendingNewTerminal } from "./pendingNewTerminal";

// Named "open/focus a shell in a worktree" use cases, each independently
// callable from anywhere in the app (Sidebar's per-worktree icons, the
// dockview watermark, WorktreeAuditLog's per-session buttons, a future
// command-palette entry, ...) without the caller needing to know whether
// the target worktree's dockview instance is currently mounted:
//
//   - mounted (it's the worktree page already on screen): act directly
//     through activeWorktreeActions.ts's bridge, no navigation.
//   - not mounted: navigate there and leave a pendingNewTerminal.ts
//     instruction (or, for focusTerminalTab, a `?terminal=` deep link)
//     for that page to pick up once its dockview is ready.
//
// This is the one place that decides between those two paths — every
// caller just names the use case it wants.

function openTerminal(
  navigate: NavigateFunction,
  repoId: string,
  worktreeId: string,
  tabLabel?: string,
  initialCommand?: string
) {
  const active = getActiveWorktreeActions();
  if (active?.worktreeId === worktreeId) {
    active.newTerminal(tabLabel, initialCommand);
    return;
  }
  setPendingNewTerminal(worktreeId, { tabLabel, initialCommand });
  navigate(`/repo/${repoId}/worktree/${worktreeId}`);
}

/** Opens a plain shell in worktreeId — same action as the sidebar's "+"
 * terminal icon and the dockview watermark's "Open shell" button. */
export function openShell(navigate: NavigateFunction, repoId: string, worktreeId: string) {
  openTerminal(navigate, repoId, worktreeId);
}

/** Opens a shell running a fresh `claude` — same as the dockview
 * watermark's "Open claude" button. Not tied to any existing session id;
 * it becomes one once the SessionStart hook (or the session itself) says
 * so. */
export function openShellWithClaude(navigate: NavigateFunction, repoId: string, worktreeId: string) {
  openTerminal(navigate, repoId, worktreeId, "claude", "claude");
}

/** Opens a shell running a fresh `agy` — same as the dockview
 * watermark's "Open agy" button. */
export function openShellWithAgy(navigate: NavigateFunction, repoId: string, worktreeId: string) {
  openTerminal(navigate, repoId, worktreeId, "agy", "agy");
}

// claude/agy session ids are either this app's own crypto.randomUUID() or
// whatever the CLI payload reports — always UUID/slug-shaped in
// practice, never free text. initialCommand ends up literally typed into
// a live shell via `tmux send-keys` (see internal/term), not passed as a
// safe exec argv, so this is a real (if narrow) guardrail: refuse to
// build a resume command out of anything that isn't shaped like a session
// id, rather than trust a value that ultimately traces back to an
// audit-log entry.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Opens a shell that resumes an existing claude session by id
 * (`claude --resume <sessionId>`) — for a claude.session.create audit
 * entry whose session isn't confirmed still running in an open terminal.
 * See focusTerminalTab for the "it's still open" case. Silently does
 * nothing for a malformed sessionId (see SESSION_ID_PATTERN) rather than
 * risk it being interpreted as shell input. */
export function openShellWithClaudeResume(
  navigate: NavigateFunction,
  repoId: string,
  worktreeId: string,
  sessionId: string
) {
  if (!SESSION_ID_PATTERN.test(sessionId)) return;
  openTerminal(navigate, repoId, worktreeId, "claude (resumed)", `claude --resume ${sessionId}`);
}

/** Opens a shell that resumes an existing agy session by conversation ID
 * (`agy --conversation <sessionId>`). */
export function openShellWithAgyResume(
  navigate: NavigateFunction,
  repoId: string,
  worktreeId: string,
  sessionId: string
) {
  if (!SESSION_ID_PATTERN.test(sessionId)) return;
  openTerminal(navigate, repoId, worktreeId, "agy (resumed)", `agy --conversation ${sessionId}`);
}

/** Switches to an already-open terminal panel by id — e.g. a
 * claude.session.create entry whose session was started via
 * worktree-studio's own launch-time path and is confirmed still running
 * (see listTerminalsForRepo). Navigates to the worktree first (via the
 * existing `?terminal=` deep link — see WorktreeDetail.tsx) if it isn't
 * the one already on screen; does nothing if the panel turns out not to
 * exist there either. */
export function focusTerminalTab(
  navigate: NavigateFunction,
  repoId: string,
  worktreeId: string,
  terminalId: string
) {
  const active = getActiveWorktreeActions();
  if (active?.worktreeId === worktreeId) {
    active.focusTerminal(terminalId);
    return;
  }
  navigate(`/repo/${repoId}/worktree/${worktreeId}?terminal=${terminalId}`);
}
