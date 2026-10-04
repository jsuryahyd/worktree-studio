import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  DockviewApi,
  DockviewDefaultTab,
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import {
  ClaudeSessionSummary,
  createTerminal,
  deleteTerminal,
  getDependencyStatus,
  getTerminalCwd,
  getWorktreeClaudeSessions,
  getWorktreeLayout,
  listTerminals,
  openInVSCode,
  saveWorktreeLayout,
  TerminalSession,
} from "./api";
import Terminal from "./Terminal";
import WorktreeAuditLog from "./WorktreeAuditLog";
import FileTree from "./FileTree";
import EditorPanel, { EditorPanelParams } from "./EditorPanel";
import { useRepoContext } from "./RepoContext";
import ClaudeIcon from "./icons/ClaudeIcon";
import AgyIcon from "./icons/AgyIcon";
import { PanelSideIcon } from "./icons/FileTreeIcons";
import { registerActiveFileOpener } from "./activeWorktreeFileOpener";
import { takePendingFileOpen } from "./pendingFileOpen";
import { takePendingNewTerminal } from "./pendingNewTerminal";
import { registerActiveWorktreeActions } from "./activeWorktreeActions";
import { openShellWithClaudeResume } from "./worktreeShellActions";
import { detectTerminalApp, TerminalAppKind } from "./terminalAppDetection";
import { isRootWorktreeId } from "./rootWorktree";
import { formatBytes, formatDateTime } from "./format";
import {
  clampFilesPanelWidth,
  FILES_PANEL_DEFAULT_WIDTH,
  FILES_PANEL_MAX_WIDTH,
  FILES_PANEL_MIN_WIDTH,
  getStoredFilesOpen,
  getStoredFilesWidth,
  setStoredFilesOpen,
  setStoredFilesWidth,
  useFilesPanelSide,
} from "./filesPanelPreference";
import { useWorktreeSummary } from "./useWorktreeSummary";

interface TerminalPanelParams {
  terminalId: string;
  repoId: string;
  worktreeId: string;
  // The worktree's own path, for TerminalPanel's one-shot cwd-mismatch
  // check below — undefined only in the brief window before the root
  // worktree's repo has loaded (see WorktreeDetailInner's worktreePath).
  worktreePath: string | undefined;
  // What the tab reverts to once the pane's title no longer matches a
  // known app — the tab_label this terminal was created with (see
  // createTerminal/handleNewTerminal), not something recomputed later.
  baseLabel: string;
  // Set once a known interactive app is detected running in this pane
  // (see terminalAppDetection.ts) — drives which icon TerminalTab shows.
  // Undefined until/unless a matching title arrives, and cleared again if
  // the title stops matching (e.g. the app exits back to a plain shell).
  appKind?: TerminalAppKind;
}

// Icon shown in a terminal tab once its pane is known to be running that
// app (see terminalAppDetection.ts) — kept separate from that module so
// terminalAppDetection.ts itself stays framework-free. New entries here
// are how this grows to cover more "persisting" apps beyond claude later.
const TERMINAL_APP_ICONS: Record<TerminalAppKind, (props: { size?: number }) => JSX.Element> = {
  claude: ClaudeIcon,
  agy: AgyIcon,
};

// A thin wrapper so dockview can host the existing Terminal component as a
// panel. Terminal.tsx itself needs no changes — dockview panels are just
// React components in the tree; adding/splitting/resizing panels doesn't
// touch this component's mount state, so the xterm/websocket lifecycle in
// Terminal.tsx's own useEffect is unaffected.
//
// Also wires Terminal's onTitleChange to this panel's own dockview tab:
// detects a known app from the pane's title and, if it changed, updates
// both the tab's label (api.setTitle) and its params (api.updateParameters)
// so TerminalTab below knows which icon to render. Reverts to baseLabel
// with no icon once the title stops matching anything known (e.g. the app
// exited back to a plain shell).
//
// The .terminal-panel-inset wrapper below gives every pane its own inset,
// not just the whole dockview area's outer edge (.terminal-area's padding
// in style.css) — without it, a pane created via split-right/split-down
// sits flush against the internal sash with zero left/top padding, since
// that boundary is an internal dockview split, not the outer container edge.
function TerminalPanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  const { terminalId, repoId, worktreeId, worktreePath } = props.params;
  // A one-shot check (not polled — see getTerminalCwd's own doc comment):
  // null until fetched, then true/false. Left null (no border either way)
  // on a fetch failure or while worktreePath itself isn't known yet,
  // rather than guessing.
  const [cwdMismatch, setCwdMismatch] = useState<boolean | null>(null);

  useEffect(() => {
    if (!worktreePath) return;
    let cancelled = false;
    getTerminalCwd(repoId, worktreeId, terminalId)
      .then(({ cwd }) => {
        if (cancelled) return;
        setCwdMismatch(!(cwd === worktreePath || cwd.startsWith(worktreePath + "/")));
      })
      .catch(() => {
        // Best-effort: a lookup failure just means no border either way,
        // same as this check never having run.
      });
    return () => {
      cancelled = true;
    };
    // terminalId alone identifies this pane for the lifetime of the
    // component; repoId/worktreeId/worktreePath are constant for as long
    // as this panel exists (its parent WorktreeDetailInner instance is
    // itself remounted whole on worktree switch — see WorktreeDetail's own
    // doc comment on why).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  function handleTitleChange(title: string) {
    const app = detectTerminalApp(title);
    if (props.params.appKind !== app?.kind) {
      props.api.updateParameters({ ...props.params, appKind: app?.kind });
    }
    // Falls back to "shell" (not an empty string) if this pane's baseLabel
    // is itself blank — e.g. a terminal_sessions row from before the
    // backend started defaulting an empty tab_label to "shell" on create
    // (internal/api/terminals.go), which would otherwise render as a
    // blank tab title forever once the pane's OSC title stops matching a
    // known app.
    props.api.setTitle(app ? app.label : props.params.baseLabel || "shell");
  }

  return (
    <div
      className={cwdMismatch ? "terminal-panel-inset cwd-mismatch" : "terminal-panel-inset"}
      title={cwdMismatch ? "This shell's directory is outside the worktree" : undefined}
    >
      <Terminal terminalId={terminalId} onTitleChange={handleTitleChange} />
    </div>
  );
}

// Renders the same look as dockview's own default tab, plus a leading
// app icon when TerminalPanel above has detected one. Delegating to
// DockviewDefaultTab (rather than reimplementing the tab's close button
// etc. from scratch) is what keeps this in sync with dockview's own
// look/behavior for free.
function TerminalTab(props: IDockviewPanelHeaderProps<TerminalPanelParams>) {
  const Icon = props.params.appKind ? TERMINAL_APP_ICONS[props.params.appKind] : null;
  return (
    <div className="terminal-tab-with-icon">
      {Icon && <Icon size={13} />}
      <DockviewDefaultTab {...props} />
    </div>
  );
}

const tabComponents = { "terminal-tab": TerminalTab };

const components = { terminal: TerminalPanel, editor: EditorPanel };

// dockview's watermarkComponent (like `components` above) is read once at
// construction, not re-passed fresh on every render — so it can't close
// over WorktreeDetailInner's own handleNewTerminal directly the way an
// inline function would, the same reason `components` is a stable
// module-level object instead of built fresh per render. This tiny
// context is the bridge: dockview-react renders panels/watermark via a
// shared "ReactPortalStore" that's still part of the normal React tree
// (that's what lets Terminal.tsx/EditorPanel.tsx work as plain components
// at all), so context set up in WorktreeDetailInner's render still reaches
// this module-scope Watermark component through the portal.
const DockviewActionsContext = createContext<{
  repoId: string;
  worktreeId: string;
  onOpenShell: () => void;
  onOpenClaude: () => void;
  onOpenAgy: () => void;
} | null>(null);

// How many past-session cards the welcome screen shows at once — a
// worktree that's had claude running in it for months could have dozens
// of transcripts on disk, and this is meant to help someone pick up a
// *recent* thread, not be a full archive browser (there's no "load more"
// here; the audit log's raw JSONL is still there for anything older).
const MAX_WELCOME_SESSIONS = 12;

// The dockview empty-state: quick actions, plus (once fetched) up to
// MAX_WELCOME_SESSIONS past claude sessions for this exact worktree path
// as clickable cards — letting someone resume a recent conversation
// instead of only ever starting fresh. Sourced from
// ~/.claude/projects/ directly (see internal/claudehook.ListSessionsForCwd),
// independent of the audit log/DB, so it also surfaces sessions started by
// hand outside worktree-studio entirely.
function Watermark() {
  const actions = useContext(DockviewActionsContext);
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<ClaudeSessionSummary[] | null>(null);

  useEffect(() => {
    if (!actions) return;
    let cancelled = false;
    getWorktreeClaudeSessions(actions.repoId, actions.worktreeId)
      .then((s) => {
        if (!cancelled) setSessions(s);
      })
      .catch(() => {
        if (!cancelled) setSessions([]); // best-effort — an empty list just means no cards, not an error worth surfacing here
      });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the primitive ids, not the actions object
    // itself: DockviewActionsContext.Provider's value below is a fresh
    // object literal every WorktreeDetailInner render (same as
    // activeWorktreeActions.ts's registration), so depending on `actions`
    // directly would refetch on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions?.repoId, actions?.worktreeId]);

  return (
    <div className="dockview-watermark">
      <p>Nothing open in this worktree yet.</p>
      {actions && (
        <div className="dockview-watermark-actions">
          <button type="button" onClick={actions.onOpenShell}>
            Open shell
          </button>
          <button type="button" onClick={actions.onOpenClaude}>
            Open claude
          </button>
          <button type="button" onClick={actions.onOpenAgy}>
            Open agy
          </button>
        </div>
      )}
      {actions && sessions && sessions.length > 0 && (
        <div className="dockview-welcome-sessions">
          <h3>Past claude sessions</h3>
          <div className="claude-session-cards">
            {sessions.slice(0, MAX_WELCOME_SESSIONS).map((s) => (
              <button
                key={s.session_id}
                type="button"
                className="claude-session-card"
                title={s.preview || s.session_id}
                onClick={() => openShellWithClaudeResume(navigate, actions.repoId, actions.worktreeId, s.session_id)}
              >
                <span className="claude-session-card-preview">{s.preview || s.session_id}</span>
                <span className="claude-session-card-meta">
                  <span>{formatDateTime(s.updated_at)}</span>
                  <span>{formatBytes(s.size_bytes)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// A "+" pinned to the far left of the tab strip (dockview's
// prefixHeaderActionsComponent, which mounts into dv-pre-actions-container
// — the first child, before any tabs; leftHeaderActionsComponent despite
// its name renders AFTER the tabs, not before them). This is the one way
// to open another shell once at least one panel already exists — the
// per-worktree "new terminal" icon used to live in this component's own
// toolbar, but that moved to the sidebar's expandable worktree card, which
// the synthetic root worktree (a repo's own checkout) has no row/card for
// at all. Reuses DockviewActionsContext (same bridge Watermark uses above)
// since dockview-react renders this via the same portal-based tree.
function NewTerminalPrefixAction() {
  const actions = useContext(DockviewActionsContext);
  if (!actions) return null;
  return (
    <button
      type="button"
      className="dockview-prefix-new-terminal"
      title="New terminal tab"
      onClick={actions.onOpenShell}
    >
      +
    </button>
  );
}

type PlacementDirection = "within" | "right" | "below";

// Debounce layout saves — dockview's onDidLayoutChange fires on every
// drag/resize/tab-switch, and a save on every single event would hammer
// the DB for no benefit (the layout is a single opaque JSON blob per
// worktree, upserted wholesale, not something worth writing 30 times a
// second while someone drags a sash).
const LAYOUT_SAVE_DEBOUNCE_MS = 500;

// How often the worktree header re-checks its branch/PR. One `gh pr view`
// a minute for the single worktree you're looking at is nothing against
// GitHub's rate limit, and it's the interval at which "I just pushed a PR"
// shows up without you having to reload the page.
const SUMMARY_POLL_MS = 60_000;

// react-router reuses the same WorktreeDetail component instance across
// navigations between /repo/:repoId/worktree/:w1 and .../w2 (same route
// element — it re-renders with new params rather than unmounting), but
// the *whole point* of the inner component is a long-lived dockview
// instance whose panels persist across renders. Left unguarded, that
// means switching worktrees left every previous worktree's terminal
// panels sitting in the shared dockview grid, and a since-corrupted mix
// of "layouts" from multiple worktrees fighting over the same instance
// (which is also why saved layouts looked like they weren't restoring —
// fromJSON was reconciling against already-populated state, not a clean
// one). Forcing a full remount via `key` on worktreeId is the standard
// fix: a real bug found from a user report, not a hypothetical.
export default function WorktreeDetail() {
  const { repoId, worktreeId } = useParams<{
    repoId: string;
    worktreeId: string;
  }>();
  if (!repoId || !worktreeId) return null;
  return <WorktreeDetailInner key={`${repoId}:${worktreeId}`} repoId={repoId} worktreeId={worktreeId} />;
}

function WorktreeDetailInner({ repoId, worktreeId }: { repoId: string; worktreeId: string }) {
  const { repos, worktreesByRepo } = useRepoContext();
  const worktree = worktreesByRepo[repoId]?.find((w) => w.id === worktreeId);
  // The synthetic root worktree (see rootWorktree.ts) is never in
  // worktreesByRepo — it's not a real git worktree, so the backend excludes
  // it from the normal per-repo listing; its path is the repo's own path
  // instead of a worktree's. TerminalPanel uses this to flag (a faint red
  // border) a shell whose cwd has drifted outside it.
  const repo = repos.find((r) => r.id === repoId);
  const worktreePath = isRootWorktreeId(worktreeId) ? repo?.path : worktree?.path;
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  // Distinguishes "haven't fetched terminals yet" from "fetched, there are
  // none" — the initial-layout effect below must not run until this is
  // true, or it can seed panels from a still-empty `terminals` and then
  // never get another chance (see that effect's own doc comment for why).
  const [terminalsLoaded, setTerminalsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const deepLinkTerminalId = searchParams.get("terminal");
  const deepLinkAppliedRef = useRef(false);
  const [logOpen, setLogOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(getStoredFilesOpen);
  const [filesWidth, setFilesWidth] = useState(getStoredFilesWidth);
  const [vscodeAvailable, setVscodeAvailable] = useState(false);
  const [vscodeError, setVscodeError] = useState<string | null>(null);
  const [branchCopied, setBranchCopied] = useState(false);
  const branchCopiedTimeoutRef = useRef<number | undefined>(undefined);
  // The header is the one place that polls (see useWorktreeSummary's
  // pollMs doc): it names the branch you're on and links its PR, and both
  // of those change from inside a shell in this very worktree — a checkout,
  // a `gh pr create` — with nothing to tell the page about it.
  const { summary, refresh: refreshSummary } = useWorktreeSummary(repoId, worktreeId, true, {
    pollMs: SUMMARY_POLL_MS,
  });
  const filesSide = useFilesPanelSide();
  // The live branch, not the one the registry recorded when the worktree
  // was created: a checkout inside one of these shells moves it, and the
  // synthetic root worktree (a repo's own checkout) has no registry row
  // here at all — `worktree?.branch` was simply blank for it. Falls back
  // to the recorded name only until the first summary lands.
  const branch = summary?.branch || worktree?.branch || "";
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  // State (not a ref) deliberately: the effect that applies the initial
  // saved layout needs to re-run once this becomes available, and refs
  // don't trigger effect re-runs when mutated.
  const [dockviewApi, setDockviewApi] = useState<DockviewApi | null>(null);
  // undefined = not fetched yet, null = fetched, nothing saved.
  const [savedLayout, setSavedLayout] = useState<unknown | null | undefined>(undefined);
  const initialLayoutAppliedRef = useRef(false);
  const saveDebounceRef = useRef<number | undefined>(undefined);
  // onDockviewReady below subscribes handlePanelClosed to dockview's
  // onDidRemovePanel exactly once (dockview-react only calls onReady
  // once per instance) — a plain read of the `terminals` state variable
  // inside that closure would be frozen at whatever `terminals` was
  // during that one render (likely still `[]`, since the terminals fetch
  // is async and hasn't resolved yet at that point), silently breaking
  // every future terminal-close call. This ref is kept current via the
  // effect below and is what handlePanelClosed actually reads.
  const terminalsRef = useRef<TerminalSession[]>([]);

  useEffect(() => {
    listTerminals(repoId, worktreeId)
      .then(setTerminals)
      .catch((err) => setError(err.message))
      .finally(() => setTerminalsLoaded(true));
    // repoId/worktreeId never change within this component's lifetime —
    // the outer WorktreeDetail remounts a fresh instance (new `key`) per
    // worktree instead. Empty deps: this is mount-only, deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);

  // Fetch the saved layout (if any) for this worktree — mount-only, same
  // reasoning as above.
  useEffect(() => {
    getWorktreeLayout(repoId, worktreeId)
      .then(setSavedLayout)
      .catch(() => setSavedLayout(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Gates the "Open in VS Code" button — `code` requires a one-time manual
  // install step even when VS Code itself is installed, so this can be
  // false on an otherwise normal machine. See settings.go's checkOnPath
  // for "code" and SettingsModal.tsx's Installation tab, which surfaces
  // the same status with an install hint.
  useEffect(() => {
    getDependencyStatus()
      .then((status) => setVscodeAvailable(status.vscode_cli?.installed ?? false))
      .catch(() => setVscodeAvailable(false));
  }, []);

  async function handleOpenInVSCode() {
    setVscodeError(null);
    try {
      await openInVSCode(repoId, worktreeId);
    } catch (err) {
      // A real error, not a silent no-op — this check passing doesn't
      // guarantee the exec call succeeds (e.g. `code` uninstalled between
      // the check above and this click).
      setVscodeError((err as Error).message);
    }
  }

  function copyBranch() {
    if (!branch) return;
    navigator.clipboard.writeText(branch).then(() => {
      setBranchCopied(true);
      if (branchCopiedTimeoutRef.current) window.clearTimeout(branchCopiedTimeoutRef.current);
      branchCopiedTimeoutRef.current = window.setTimeout(() => setBranchCopied(false), 1500);
    });
  }

  function toggleFiles() {
    setFilesOpen((o) => {
      const next = !o;
      setStoredFilesOpen(next);
      return next;
    });
  }

  // Drag-to-resize the file tree, mirroring the app sidebar's handle in
  // Layout.tsx (its own flag stays `resizing-sidebar`; sharing one class
  // would light up the other pane's handle during this drag). Pointer
  // events (one path for trackpad/touch/pen) and
  // setPointerCapture, so the drag keeps tracking once the pointer crosses
  // into a terminal pane — without capture, releasing over xterm leaves
  // the panel stuck mid-drag. Width is committed to storage on release,
  // not per move: this fires at pointer frequency and localStorage writes
  // are synchronous.
  //
  // Tracked as a delta from where the drag started rather than an absolute
  // clientX, which is what makes one handler work on both sides: the panel
  // grows as the pointer moves left when it's docked right, and right when
  // it's docked left. An absolute reading would need to know the panel's
  // own page offset, which changes with the app sidebar's width.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Pointer capture is best-effort: the spec has setPointerCapture throw
  // NotFoundError if the pointerId is no longer active by the time it's
  // called, which a real browser can hit on a fast click, and jsdom
  // doesn't implement either method at all. Losing capture degrades the
  // drag (it stops tracking once the pointer leaves the handle) rather
  // than breaking it, so it must not take the resize down with it.
  function withPointerCapture(el: Element, pointerId: number, capture: boolean) {
    try {
      if (capture) el.setPointerCapture?.(pointerId);
      else el.releasePointerCapture?.(pointerId);
    } catch {
      // See above.
    }
  }

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: filesWidth };
      withPointerCapture(e.currentTarget, e.pointerId, true);
      document.body.classList.add("resizing-files");
    },
    [filesWidth]
  );

  const handleResizeMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = e.clientX - drag.startX;
      setFilesWidth(clampFilesPanelWidth(drag.startWidth + (filesSide === "right" ? -delta : delta)));
    },
    [filesSide]
  );

  const handleResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    withPointerCapture(e.currentTarget, e.pointerId, false);
    document.body.classList.remove("resizing-files");
    setFilesWidth((w) => {
      setStoredFilesWidth(w);
      return w;
    });
  }, []);

  function nudgeFilesWidth(delta: number) {
    setFilesWidth((prev) => {
      const next = clampFilesPanelWidth(prev + delta);
      setStoredFilesWidth(next);
      return next;
    });
  }

  // Ctrl/Cmd+B toggles the file tree — the same shortcut VS Code and most
  // other editors use for their own file explorer, so it's already muscle
  // memory rather than something new to learn. Deliberately NOT intercepted
  // while focus is inside a terminal pane: tmux's own default prefix key is
  // literally Ctrl+B, so stealing it there would break every tmux binding
  // (pane switching, copy-mode, etc.) for every shell in the app — a much
  // worse regression than not having this shortcut work from a terminal.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "b") return;
      if (e.target instanceof Element && e.target.closest(".xterm")) return;
      e.preventDefault();
      toggleFiles();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Seed dockview with a panel per known terminal that doesn't already
  // have one — used both as the fallback when there's no saved layout,
  // and to pick up any terminal created after the layout was last saved.
  function seedPanels(api: DockviewApi, sessions: TerminalSession[]) {
    for (const ts of sessions) {
      if (!api.getPanel(ts.id)) {
        api.addPanel<TerminalPanelParams>({
          id: ts.id,
          component: "terminal",
          tabComponent: "terminal-tab",
          title: ts.tab_label || "shell",
          params: { terminalId: ts.id, repoId, worktreeId, worktreePath, baseLabel: ts.tab_label || "shell" },
        });
      }
    }
  }

  // Apply the initial layout exactly once dockview is ready AND both the
  // saved-layout and terminals fetches have resolved (order between any of
  // these is not guaranteed — this effect is what makes it not matter).
  // Gating on terminalsLoaded (not just a truthy `terminals`) matters: a
  // worktree with terminals but no saved layout would otherwise let this
  // fire while `terminals` was still its initial `[]`, seed nothing, and —
  // because of the ref guard below — never get a second chance once the
  // fetch actually resolved. Found for real: a fresh worktree page showed
  // the "nothing open" watermark despite the worktree having live terminal
  // sessions, reproducing on every cold load, not just occasionally.
  //
  // If a saved layout references a terminal id that no longer exists
  // server-side (e.g. deleted through some path that didn't get a chance
  // to save an updated layout first), that panel is left to dockview/
  // Terminal.tsx's own graceful failure (a pane showing a connection
  // error) rather than hand-pruning dockview's serialized grid structure —
  // a deliberate simplification, not an oversight; see docs/architecture.md.
  useEffect(() => {
    if (!dockviewApi || savedLayout === undefined || !terminalsLoaded || initialLayoutAppliedRef.current) return;
    initialLayoutAppliedRef.current = true;
    if (savedLayout) {
      try {
        dockviewApi.fromJSON(savedLayout as Parameters<DockviewApi["fromJSON"]>[0]);
      } catch (err) {
        console.error("failed to restore saved terminal layout, falling back to default", err);
      }
    }
    seedPanels(dockviewApi, terminals);
  }, [dockviewApi, savedLayout, terminalsLoaded, terminals]);

  // Switches to an already-open terminal panel by id, doing nothing (and
  // reporting false) if it isn't there — shared by the deep-link effect
  // below (a fresh navigation, so its own one-shot ref guard is fine) and
  // exposed through activeWorktreeActions so worktreeShellActions.ts can
  // call it directly when the target worktree is already the one on
  // screen, where the deep link's one-shot-per-mount guard (see that
  // effect's own comment) would otherwise block a second focus request
  // for a different terminal without a full remount.
  const focusTerminalPanel = useCallback(
    (terminalId: string): boolean => {
      if (!dockviewApi) return false;
      const panel = dockviewApi.getPanel(terminalId);
      if (!panel) return false;
      panel.api.setActive();
      return true;
    },
    [dockviewApi]
  );

  // Deep link support: a settings-page "Shells" row links to
  // /repo/:repoId/worktree/:worktreeId?terminal=<id>, and landing here
  // should focus that terminal's panel — once, after the initial
  // layout/seed above has actually created it (a fresh navigation to an
  // already-mounted instance doesn't re-run this: see the `key` remount
  // comment above WorktreeDetail).
  useEffect(() => {
    if (!deepLinkTerminalId || deepLinkAppliedRef.current) return;
    if (!focusTerminalPanel(deepLinkTerminalId)) return;
    deepLinkAppliedRef.current = true;
  }, [deepLinkTerminalId, terminals, focusTerminalPanel]);

  // Debounced layout save on every layout change, once the initial
  // load/seed above has happened (so restoring the saved layout doesn't
  // immediately re-trigger a save of the same thing it just loaded).
  useEffect(() => {
    if (!dockviewApi) return;
    const disposable = dockviewApi.onDidLayoutChange(() => {
      if (!initialLayoutAppliedRef.current) return;
      if (saveDebounceRef.current) window.clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = window.setTimeout(() => {
        saveWorktreeLayout(repoId, worktreeId, dockviewApi.toJSON()).catch((err) => {
          console.error("failed to save terminal layout", err);
        });
      }, LAYOUT_SAVE_DEBOUNCE_MS);
    });
    return () => disposable.dispose();
  }, [dockviewApi]);

  function onDockviewReady(event: DockviewReadyEvent) {
    setDockviewApi(event.api);
    event.api.onDidRemovePanel((panel) => {
      handlePanelClosed(panel.id);
    });
    // Keeps the file tree's highlighted/scrolled-to node in sync with
    // whichever editor panel is currently active — setActiveFilePath is a
    // state setter, so this closure never goes stale the way a plain
    // variable read would (see handlePanelClosed's terminalsRef comment
    // above for the general version of that pitfall).
    event.api.onDidActivePanelChange((e) => {
      const id = e.panel?.id;
      setActiveFilePath(id?.startsWith("editor:") ? id.slice("editor:".length) : null);
    });
  }

  async function handlePanelClosed(panelId: string) {
    // dockview's onDidRemovePanel fires for every panel kind (terminals
    // AND editor panels), but only terminals have a server-side session to
    // tear down. Without this check, closing an editor panel (id
    // "editor:<path>") fell through to deleteTerminal, which 404'd
    // ("terminal session not found") and surfaced that as a top-level
    // error banner — a real bug, found from a user report — for an action
    // (closing a file) that has nothing to clean up server-side.
    if (!terminalsRef.current.some((t) => t.id === panelId)) return;

    // The panel is already gone from dockview's own layout by the time
    // this fires (that's what triggered the event) — this just tells the
    // server to actually kill the tmux session and drops our own
    // bookkeeping copy of the list.
    try {
      await deleteTerminal(repoId, worktreeId, panelId);
    } catch (err) {
      setError((err as Error).message);
    }
    setTerminals((prev) => prev.filter((t) => t.id !== panelId));
  }

  async function handleNewTerminal(direction: PlacementDirection, tabLabel?: string, initialCommand?: string) {
    try {
      const ts = await createTerminal(repoId, worktreeId, tabLabel, initialCommand);
      setTerminals((prev) => [...prev, ts]);
      // A new shell is the moment the branch/PR is most likely to have
      // moved since the header last looked (you open one to check out a
      // branch, to push, to open a PR), so don't wait out the poll.
      refreshSummary();

      if (!dockviewApi) return; // the seed effect will pick it up once ready
      const reference = dockviewApi.activePanel;
      dockviewApi.addPanel<TerminalPanelParams>({
        id: ts.id,
        component: "terminal",
        tabComponent: "terminal-tab",
        title: ts.tab_label || "shell",
        params: { terminalId: ts.id, repoId, worktreeId, worktreePath, baseLabel: ts.tab_label || "shell" },
        position: reference ? { referencePanel: reference.id, direction } : undefined,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Opens a file's editor panel, reusing an already-open panel for the same
  // path instead of creating a second one — see EditorPanel.tsx's doc
  // comment for why this is what makes the "two panels on the same file"
  // question moot rather than something needing a shared-model design.
  function handleOpenFile(path: string) {
    if (!dockviewApi) return;
    const id = `editor:${path}`;
    const existing = dockviewApi.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const reference = dockviewApi.activePanel;
    dockviewApi.addPanel<EditorPanelParams>({
      id,
      component: "editor",
      title: path.split("/").pop() ?? path,
      params: { repoId, worktreeId, path },
      position: reference ? { referencePanel: reference.id, direction: "within" } : undefined,
    });
  }

  // Registers this worktree as the one the command palette's file search
  // opens into — see activeWorktreeFileOpener.ts for why this needs to be
  // a plain module-level registration rather than React context.
  useEffect(() => {
    registerActiveFileOpener(handleOpenFile);
    return () => registerActiveFileOpener(null);
  });

  // Consumes a file left for this worktree by RepoContext's /ws/open-file
  // handler when it had to navigate here first (the target worktree wasn't
  // already the open tab) — see pendingFileOpen.ts. Gated on dockviewApi so
  // this fires once panels can actually be added, not on mount; takePendingFileOpen
  // clears itself after one read, so this is safe to depend on dockviewApi
  // alone rather than needing its own "already consumed" guard.
  useEffect(() => {
    if (!dockviewApi) return;
    const path = takePendingFileOpen(worktreeId);
    if (path) handleOpenFile(path);
  }, [dockviewApi, worktreeId]);

  // Consumes a "open a new terminal here" instruction left for this
  // worktree by Sidebar.tsx's spotlight-start handler when it had to
  // navigate here first (the repo-root worktree wasn't already the open
  // tab) — see pendingNewTerminal.ts. Same gating as the pendingFileOpen
  // effect above.
  useEffect(() => {
    if (!dockviewApi) return;
    const pending = takePendingNewTerminal(worktreeId);
    if (pending) handleNewTerminal("within", pending.tabLabel, pending.initialCommand);
  }, [dockviewApi, worktreeId]);

  // Same "no deps, re-register every render" idiom as the file-opener
  // registration above — the sidebar's action icons for the currently-open
  // worktree call straight through into this instance's own handlers, and
  // need to see fresh values (e.g. vscodeAvailable flipping) immediately,
  // not just at mount. See activeWorktreeActions.ts.
  useEffect(() => {
    registerActiveWorktreeActions({
      worktreeId,
      vscodeAvailable,
      openVSCode: handleOpenInVSCode,
      openLog: () => setLogOpen(true),
      newTerminal: (tabLabel, initialCommand) => handleNewTerminal("within", tabLabel, initialCommand),
      splitRight: () => handleNewTerminal("right"),
      splitDown: () => handleNewTerminal("below"),
      focusTerminal: focusTerminalPanel,
    });
    return () => registerActiveWorktreeActions(null);
  });

  // Rendered on whichever side the preference names — as a real DOM
  // position rather than a `row-reverse` flip, so tab order and screen
  // readers follow what's actually on screen.
  const filePanel = (
    <div
      className={filesSide === "right" ? "worktree-sidebar right" : "worktree-sidebar"}
      style={{ width: `${filesWidth}px` }}
    >
      <FileTree
        repoId={repoId}
        worktreeId={worktreeId}
        onOpenFile={handleOpenFile}
        activePath={activeFilePath}
        folderPath={worktreePath}
      />
    </div>
  );

  // A real separator, not decoration — same contract as the app sidebar's:
  // arrow keys resize, Home and double-click reset. Arrow direction is
  // read as "which way is the pointer going", so it stays consistent with
  // the drag on both sides rather than always meaning "wider".
  const filesResizer = (
    <div
      className="file-tree-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file tree"
      aria-valuenow={filesWidth}
      aria-valuemin={FILES_PANEL_MIN_WIDTH}
      aria-valuemax={FILES_PANEL_MAX_WIDTH}
      tabIndex={0}
      onPointerDown={handleResizeStart}
      onPointerMove={handleResizeMove}
      onPointerUp={handleResizeEnd}
      onPointerCancel={handleResizeEnd}
      onDoubleClick={() => {
        setFilesWidth(FILES_PANEL_DEFAULT_WIDTH);
        setStoredFilesWidth(FILES_PANEL_DEFAULT_WIDTH);
      }}
      onKeyDown={(e) => {
        // What ArrowLeft does to the width, matching what dragging the
        // handle left does: a right-docked panel grows, a left-docked one
        // shrinks.
        const leftStep = filesSide === "right" ? 16 : -16;
        if (e.key === "ArrowLeft") nudgeFilesWidth(leftStep);
        else if (e.key === "ArrowRight") nudgeFilesWidth(-leftStep);
        else if (e.key === "Home") nudgeFilesWidth(FILES_PANEL_DEFAULT_WIDTH - filesWidth);
        else return;
        e.preventDefault();
      }}
    />
  );

  // The tree's own toggle, sitting on the edge the tree opens from — the
  // far right by default, immediately after the branch name when the tree
  // is on the left. Pointing at a control on one edge and having a panel
  // appear on the other is the thing this is avoiding.
  const filesToggle = (
    <button
      type="button"
      className={filesOpen ? "worktree-header-files-toggle active" : "worktree-header-files-toggle"}
      aria-pressed={filesOpen}
      title={filesOpen ? "Hide the file tree (\u2318B)" : "Show the file tree (\u2318B)"}
      aria-label={filesOpen ? "Hide the file tree" : "Show the file tree"}
      onClick={toggleFiles}
    >
      <PanelSideIcon side={filesSide} />
    </button>
  );

  return (
    <div className="container worktree-detail">
      {error && <p className="error">{error}</p>}
      {vscodeError && <p className="error">Failed to open VS Code: {vscodeError}</p>}

      <div className="worktree-body">
        {filesOpen && filesSide === "left" && (
          <>
            {filePanel}
            {filesResizer}
          </>
        )}
        <div className="terminal-area">
          {/* Sits directly above the shell tabs, not spanning the file
              tree column too — a title for this worktree's terminal/editor
              area specifically. */}
          {/* Branch name first, PR trailing and quiet. This used to open
              with "[No pull request for this branch]" — bracketed, in
              first position, ahead of the branch name — which made the
              most prominent string in the workspace a statement that
              nothing exists. No PR now renders nothing at all: the normal
              state of the UI is silence (docs/design-system.md). */}
          {/* Branch name, then the state of that branch, then its PR.
              This bar used to hold the branch name and nothing else,
              sitting directly beside a file-tree panel whose header showed
              the same string (a worktree directory is named after its
              branch) — two headers, one piece of information between
              them. It now carries what you'd otherwise run `git status`
              to find out, and each part renders only when there's
              something to say. */}
          <div className="worktree-header">
            <span className="worktree-header-branch-name">{branch}</span>
            <button
              type="button"
              className={branchCopied ? "worktree-header-copy copied" : "worktree-header-copy"}
              title="Copy branch name"
              onClick={copyBranch}
            >
              {branchCopied ? "Copied" : "⧉"}
            </button>
            {filesSide === "left" && filesToggle}

            {summary?.has_upstream && (summary.ahead > 0 || summary.behind > 0) && (
              <span
                className="worktree-header-ticks"
                title={`${summary.ahead} ahead, ${summary.behind} behind upstream`}
              >
                {summary.ahead > 0 && `↑${summary.ahead}`}
                {summary.ahead > 0 && summary.behind > 0 && " "}
                {summary.behind > 0 && `↓${summary.behind}`}
              </span>
            )}
            {summary && summary.changed_files.length > 0 && (
              <span
                className="worktree-header-changed"
                title={summary.changed_files.join("\n")}
              >
                {summary.changed_files.length} changed
              </span>
            )}

            <span className="worktree-header-spacer" />

            {summary?.pr ? (
              <a
                className="worktree-header-pr"
                href={summary.pr.url}
                target="_blank"
                rel="noopener noreferrer"
                title={summary.pr.title}
              >
                <span className="worktree-header-pr-number">#{summary.pr.number}</span>
                {summary.pr.is_draft && <span className="worktree-header-pr-draft">draft</span>}
                <span className="worktree-header-pr-title">{summary.pr.title}</span>
              </a>
            ) : null}

            {filesSide === "right" && filesToggle}
          </div>
          <DockviewActionsContext.Provider
            value={{
              repoId,
              worktreeId,
              onOpenShell: () => handleNewTerminal("within"),
              onOpenClaude: () => handleNewTerminal("within", "claude", "claude"),
              onOpenAgy: () => handleNewTerminal("within", "agy", "agy"),
            }}
          >
            <DockviewReact
              components={components}
              tabComponents={tabComponents}
              watermarkComponent={Watermark}
              prefixHeaderActionsComponent={NewTerminalPrefixAction}
              onReady={onDockviewReady}
              className="dockview-theme-abyss app-dockview"
            />
          </DockviewActionsContext.Provider>
        </div>
        {filesOpen && filesSide === "right" && (
          <>
            {filesResizer}
            {filePanel}
          </>
        )}
      </div>

      {logOpen && (
        <WorktreeAuditLog
          repoId={repoId}
          worktreeId={worktreeId}
          title="this worktree"
          onClose={() => setLogOpen(false)}
        />
      )}
    </div>
  );
}
