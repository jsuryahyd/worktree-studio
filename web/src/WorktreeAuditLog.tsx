import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuditLogEntry, getClaudeSessionTitle, getWorktreeAuditLog, listTerminalsForRepo } from "./api";
import { AuditEventType } from "./auditEvents";
import { focusTerminalTab, openShellWithAgyResume, openShellWithClaudeResume } from "./worktreeShellActions";

interface Props {
  repoId: string;
  worktreeId: string;
  title: string;
  onClose: () => void;
}

// Human-friendly label + icon per known event type. Keyed by AuditEventType
// (Record<AuditEventType, ...> below) so adding a new audit.Event on the Go
// side without updating auditEvents.ts/this map is a compile error here,
// not a silently-unstyled row — but the lookup at render time still falls
// back gracefully (see EVENT_LABELS[e.event] below) for any event this
// frontend build genuinely doesn't know about yet (an older frontend build
// talking to a newer backend, e.g. mid-deploy).
const EVENT_LABELS: Record<AuditEventType, { icon: string; label: string }> = {
  // Never actually shown here in practice (repo.add carries no
  // worktree_id, so it can't match this view's filter) — included only so
  // Record<AuditEventType, ...> stays exhaustive against auditEvents.ts.
  "repo.add": { icon: "📁", label: "Repo registered" },
  // Also never shown here (no worktree_id) — same reason as repo.add.
  "repo.update_external_worktrees_root": { icon: "🛰️", label: "External worktrees root updated" },
  "worktree.create": { icon: "🌱", label: "Worktree created" },
  "worktree.auto_discover": { icon: "🛰️", label: "Auto-discovered from external root" },
  "worktree.remove": { icon: "🗑️", label: "Worktree removed" },
  "worktree.archive": { icon: "📦", label: "Worktree archived" },
  "worktree.unarchive": { icon: "📤", label: "Worktree unarchived" },
  "worktree.branch_change": { icon: "⎇", label: "Branch checked out" },
  "terminal.create": { icon: "🖥️", label: "Terminal opened" },
  "terminal.close": { icon: "⏹️", label: "Terminal closed" },
  "spotlight.start": { icon: "🔦", label: "Spotlight started" },
  "spotlight.stop": { icon: "🔦", label: "Spotlight stopped" },
  "claude.session.create": { icon: "🤖", label: "Claude session started" },
  "claude.session.context": { icon: "🗿", label: "Context injected into Claude" },
  "agy.session.create": { icon: "🤖", label: "agy session started" },
  "file.write": { icon: "📝", label: "File saved" },
  // Never actually shown here either — same reason as repo.add above: an
  // orphan tmux session by definition has no terminal_sessions row, so
  // there's no worktree_id to filter this view by.
  "orphan_tmux.kill": { icon: "🧹", label: "Orphan tmux session killed" },
};

// A per-worktree checkpoint summary that's worth a glance at without
// opening the raw-JSON details below (branch/path for creation, tab
// label for terminals, etc.) — keeps the common case scannable.
//
// realTitles maps claude_session_id -> a title fetched live from that
// session's own local transcript (see fetchClaudeTitles below) — when
// available, it's a much better label than the one this app itself
// assigned at launch time (which the hook-driven path doesn't even set —
// see internal/claudehook), since it's the session's actual first message
// rather than just the worktree's name repeated back.
function summarize(entry: AuditLogEntry, realTitles: Record<string, string | null>): string | null {
  switch (entry.event) {
    case "worktree.create":
    case "worktree.remove":
    case "worktree.branch_change":
    case "worktree.auto_discover":
      return typeof entry.branch === "string" ? `branch ${entry.branch}` : null;
    case "terminal.create":
    case "terminal.close":
      return typeof entry.tab_label === "string" ? entry.tab_label : null;
    case "file.write":
      return typeof entry.path === "string" ? entry.path : null;
    case "claude.session.create": {
      const id = entry.claude_session_id;
      if (typeof id !== "string") return null;
      const real = realTitles[id];
      const label = real ?? (typeof entry.title === "string" ? entry.title : undefined);
      return label ? `${label} (${id})` : id;
    }
    case "agy.session.create": {
      const id = entry.agy_session_id;
      if (typeof id !== "string") return null;
      const label = typeof entry.title === "string" ? entry.title : undefined;
      return label ? `${label} (${id})` : id;
    }
    default:
      return null;
  }
}

function AgySessionAction({
  repoId,
  worktreeId,
  sessionId,
  terminalId,
  liveTerminalIds,
  navigate,
  onDone,
}: {
  repoId: string;
  worktreeId: string;
  sessionId: string;
  terminalId: string | undefined;
  liveTerminalIds: Set<string>;
  navigate: ReturnType<typeof useNavigate>;
  onDone: () => void;
}) {
  const isLive = terminalId !== undefined && liveTerminalIds.has(terminalId);

  if (isLive) {
    return (
      <button
        type="button"
        className="audit-log-action"
        onClick={() => {
          focusTerminalTab(navigate, repoId, worktreeId, terminalId!);
          onDone();
        }}
      >
        Focus
      </button>
    );
  }

  return (
    <button
      type="button"
      className="audit-log-action"
      onClick={() => {
        openShellWithAgyResume(navigate, repoId, worktreeId, sessionId);
        onDone();
      }}
    >
      Resume
    </button>
  );
}

// The button on a claude.session.create entry: "Focus" if this exact
// session is confirmed still running in an open terminal (terminal_id is
// only ever logged by the launch-time creation path — see
// internal/api/hooks.go — and even then only stays accurate as long as
// that terminal hasn't since been closed, which is why liveTerminalIds is
// checked rather than trusting the stored id on its own), otherwise
// "Resume" — opens a new terminal running `claude --resume <id>`. Either
// way, closes the dialog afterward (onDone) since the action itself
// already navigates/focuses what the user asked for.
function ClaudeSessionAction({
  repoId,
  worktreeId,
  sessionId,
  terminalId,
  liveTerminalIds,
  navigate,
  onDone,
}: {
  repoId: string;
  worktreeId: string;
  sessionId: string;
  terminalId: string | undefined;
  liveTerminalIds: Set<string>;
  navigate: ReturnType<typeof useNavigate>;
  onDone: () => void;
}) {
  const isLive = terminalId !== undefined && liveTerminalIds.has(terminalId);

  if (isLive) {
    return (
      <button
        type="button"
        className="audit-log-action"
        onClick={() => {
          focusTerminalTab(navigate, repoId, worktreeId, terminalId!);
          onDone();
        }}
      >
        Focus
      </button>
    );
  }

  return (
    <button
      type="button"
      className="audit-log-action"
      onClick={() => {
        openShellWithClaudeResume(navigate, repoId, worktreeId, sessionId);
        onDone();
      }}
    >
      Resume
    </button>
  );
}

export default function WorktreeAuditLog({ repoId, worktreeId, title, onClose }: Props) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [realTitles, setRealTitles] = useState<Record<string, string | null>>({});
  // Which terminal ids (repo-wide, not just this worktree — ids are
  // globally unique so an exact match is enough) are currently live, so a
  // claude.session.create entry that happens to carry a terminal_id (only
  // the launch-time creation path logs one — see internal/api/hooks.go)
  // can offer "Focus" instead of "Resume" when that terminal is confirmed
  // still open. Best-effort: a failed fetch just means every entry falls
  // back to "Resume", not an error worth surfacing in a log viewer.
  const [liveTerminalIds, setLiveTerminalIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    getWorktreeAuditLog(repoId, worktreeId)
      .then((es) => {
        if (!cancelled) setEntries(es);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, worktreeId]);

  useEffect(() => {
    if (!entries) return;
    let cancelled = false;
    const ids = entries
      .filter((e) => e.event === "claude.session.create")
      .map((e) => e.claude_session_id)
      .filter((id): id is string => typeof id === "string");
    // Best-effort, one fetch per session id, silently ignoring failures —
    // a missing/unreadable transcript just means this entry falls back to
    // its stored `title` field (or the bare id), not an error worth
    // surfacing in a log viewer.
    for (const id of new Set(ids)) {
      getClaudeSessionTitle(id)
        .then((t) => {
          if (!cancelled) setRealTitles((prev) => ({ ...prev, [id]: t }));
        })
        .catch(() => {
          /* fall back to the stored title/bare id — see summarize() */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [entries]);

  useEffect(() => {
    let cancelled = false;
    listTerminalsForRepo(repoId)
      .then((sessions) => {
        if (!cancelled) setLiveTerminalIds(new Set(sessions.map((s) => s.id)));
      })
      .catch(() => {
        /* every entry falls back to "Resume" — see liveTerminalIds' own comment */
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog audit-log-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Log — {title}</h2>
        {error && <p className="error">{error}</p>}
        {!error && entries === null && <p className="muted">Loading…</p>}
        {!error && entries !== null && entries.length === 0 && (
          <p className="muted">No events recorded yet for this worktree.</p>
        )}
        {!error && entries !== null && entries.length > 0 && (
          <ul className="audit-log-list">
            {entries.map((e, i) => {
              // e.event is `string` (see AuditLogEntry) since the log must
              // render event types this frontend build doesn't know about
              // yet — the cast is safe because of the `?? fallback` right
              // after it, which is what actually handles that case.
              const meta = (EVENT_LABELS as Record<string, { icon: string; label: string }>)[e.event] ?? {
                icon: "•",
                label: e.event,
              };
              const summary = summarize(e, realTitles);
              return (
                <li key={i} className="audit-log-entry">
                  <span className="audit-log-icon" aria-hidden="true">
                    {meta.icon}
                  </span>
                  <span className="audit-log-body">
                    <span className="audit-log-label">{meta.label}</span>
                    {summary && <span className="audit-log-summary"> — {summary}</span>}
                    <span className="audit-log-time muted">
                      {new Date(e.ts).toLocaleString()}
                    </span>
                    {e.event === "claude.session.context" && typeof e.context === "string" && (
                      // Shown inline, not tucked behind "raw" — this is the
                      // actual point of the entry: what Claude was told.
                      // JSON.stringify below would otherwise print this as
                      // one line with literal \n escapes, not real breaks.
                      <pre className="audit-log-context">{e.context}</pre>
                    )}
                    {e.event === "claude.session.create" && typeof e.claude_session_id === "string" && (
                      <ClaudeSessionAction
                        repoId={repoId}
                        worktreeId={worktreeId}
                        sessionId={e.claude_session_id}
                        terminalId={typeof e.terminal_id === "string" ? e.terminal_id : undefined}
                        liveTerminalIds={liveTerminalIds}
                        navigate={navigate}
                        onDone={onClose}
                      />
                    )}
                    {e.event === "agy.session.create" && typeof e.agy_session_id === "string" && (
                      <AgySessionAction
                        repoId={repoId}
                        worktreeId={worktreeId}
                        sessionId={e.agy_session_id}
                        terminalId={typeof e.terminal_id === "string" ? e.terminal_id : undefined}
                        liveTerminalIds={liveTerminalIds}
                        navigate={navigate}
                        onDone={onClose}
                      />
                    )}
                  </span>
                  <details className="audit-log-raw">
                    <summary>raw</summary>
                    <pre>{JSON.stringify(e, null, 2)}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
