// Thin client wrapper around worktree-studio's REST API.

export interface Repo {
  id: string;
  name: string;
  path: string;
  // Branch new worktrees are created from. "" means auto-detect (origin's
  // default branch, else local main/master, else the main checkout's
  // current HEAD) — see internal/gitops.DetectDefaultBranch.
  base_branch: string;
  // Absolute path another tool creates this repo's worktrees under (e.g.
  // Conductor's own workspace root). "" means auto-discovery is disabled —
  // see discoverExternalWorktrees() below.
  external_worktrees_root: string;
}

// Not to be confused with WorktreeStatus below, which is git dirty/ahead-
// behind info — this is the worktree's own lifecycle state.
export type WorktreeLifecycle = "active" | "archived" | "deleted";

// "created" = made through worktree-studio's own "+ New worktree" flow;
// "imported" = an existing `git worktree` attached in via the repo settings
// page's attach flow; "root" = the synthetic per-repo root-checkout
// worktree (see rootWorktree.ts) — never created/imported/archived through
// any of this UI.
export type WorktreeSource = "created" | "imported" | "root";

export interface Worktree {
  id: string;
  repo_id: string;
  name: string;
  branch: string;
  path: string;
  created_at: string;
  status: WorktreeLifecycle;
  source: WorktreeSource;
  // When this worktree was last archived (RFC3339), or "" if it isn't
  // currently archived.
  archived_at: string;
  // The branch/ref this worktree's own branch was created from (e.g.
  // "main" or "origin/main"), or "" for worktrees where that's not
  // recorded (imported, or the synthetic root worktree).
  source_branch: string;
  // Exempt from ever being archived (see worktreeRules.ts's
  // canArchiveWorktree, mirroring internal/api's CanArchiveWorktree) and
  // sorted ahead of every unpinned worktree in its repo — the backend's
  // own ORDER BY already returns worktrees in that order, so nothing on
  // this side needs to re-sort for display.
  pinned: boolean;
}

/** A `git worktree` that exists on disk for a repo but isn't tracked in
 * worktree-studio's DB yet — a candidate for importWorktree(). */
export interface ExternalWorktreeEntry {
  path: string;
  branch: string;
}

export interface DependencyStatus {
  installed: boolean;
  detail?: string;
  install_hint?: string;
}

export type DependencyName = "tmux" | "spotlight" | "skill" | "vscode_cli";
export type DependencyStatusMap = Record<DependencyName, DependencyStatus>;

/** One row of the dynamic "Claude Code hooks" list — everything the
 * settings UI needs to render and toggle a hook, driven entirely by
 * whatever internal/claudehook's registry reports (see GET
 * /api/settings/hooks). Adding a hook there is the only change needed for
 * a new row to show up here — the frontend never hardcodes hook ids. */
export interface HookStatus {
  id: string;
  name: string;
  hint?: string;
  installed: boolean;
}

export interface TerminalSession {
  id: string;
  worktree_id: string;
  tmux_session_name: string;
  tab_label: string;
  created_at: string;
}

/** A TerminalSession joined with its worktree's branch/name — used by the
 * repo settings page's "Shells" tab. */
export interface TerminalSessionWithWorktree extends TerminalSession {
  worktree_branch: string;
  worktree_name: string;
}

export interface WorktreeStatus {
  branch: string;
  dirty: boolean;
  has_upstream: boolean;
  ahead: number;
  behind: number;
}

export interface AuditLogEntry {
  ts: string;
  event: string;
  [field: string]: unknown;
}

export interface SpotlightStatus {
  available: boolean;
  active: boolean;
  root?: string;
  active_worktree_path?: string;
  pid?: number;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
}

export interface FileContent {
  path: string;
  content: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore non-JSON error bodies
    }
    if (res.status === 409) throw new ConflictError(message);
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function listRepos(): Promise<Repo[]> {
  return request<Repo[]>("/api/repos/");
}

export function addRepo(name: string, path: string): Promise<Repo> {
  return request<Repo>("/api/repos/", {
    method: "POST",
    body: JSON.stringify({ name, path }),
  });
}

/** Saves this repo's settings — the base branch new worktrees are created
 * from, and the external-worktrees-root auto-discovery path. Both fields
 * are always sent together: the backend writes them as one unit, so a save
 * that only sent the one being edited would silently blank out the other
 * (see internal/api.handleUpdateRepoSettings's doc comment). Pass "" for
 * either to revert it to its default. */
export function updateRepoSettings(
  repoId: string,
  settings: { base_branch: string; external_worktrees_root: string }
): Promise<Repo> {
  return request<Repo>(`/api/repos/${repoId}/settings`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function listWorktrees(repoId: string): Promise<Worktree[]> {
  return request<Worktree[]>(`/api/repos/${repoId}/worktrees/`);
}

export function newNameSuggestion(repoId: string): Promise<string> {
  return request<{ name: string }>(
    `/api/repos/${repoId}/worktrees/new-name-suggestion`
  ).then((r) => r.name);
}

/** sourceBranch optionally picks which branch/ref (local or remote-
 * tracking, e.g. "origin/main") to create the worktree from — see
 * listBranches() below. Omitted/"" falls back to the repo's base-branch
 * setting, then auto-detection, same as before this param existed. */
export function createWorktree(repoId: string, name: string, sourceBranch?: string): Promise<Worktree> {
  return request<Worktree>(`/api/repos/${repoId}/worktrees/`, {
    method: "POST",
    body: JSON.stringify({ name, source_branch: sourceBranch }),
  });
}

export interface RepoBranches {
  branches: string[];
  /** Whichever branch would currently be used as a new worktree's start
   * point if nothing else were specified (repo.base_branch, else
   * auto-detected) — the new-worktree dialog's branch dropdown pre-selects
   * this. "" if none could be resolved. */
  default: string;
}

/** Every local + remote-tracking branch for a repo, for the new-worktree
 * dialog's "branch to create from" dropdown. */
export function listBranches(repoId: string): Promise<RepoBranches> {
  return request<RepoBranches>(`/api/repos/${repoId}/branches`);
}

/** Registers an existing, already-on-disk git worktree of this repo — no
 * `git worktree add` is run, this is purely a registry insert for a
 * worktree created some other way (by hand, or by another tool). The
 * backend rejects a path that isn't actually one of this repo's real git
 * worktrees (a plain 400, not a ConflictError), and 409s only if that path
 * is already registered. `name` defaults server-side to `ext_<dirname>` if
 * omitted, so imported worktrees are visually distinguishable from ones
 * created through the normal flow. */
export function importWorktree(
  repoId: string,
  path: string,
  name?: string
): Promise<Worktree> {
  return request<Worktree>(`/api/repos/${repoId}/worktrees/import`, {
    method: "POST",
    body: JSON.stringify({ path, name }),
  });
}

export function deleteWorktree(
  repoId: string,
  worktreeId: string,
  force = false
): Promise<void> {
  const qs = force ? "?force=true" : "";
  return request<void>(`/api/repos/${repoId}/worktrees/${worktreeId}${qs}`, {
    method: "DELETE",
  });
}

/** Thrown by request() when the server responds 409 Conflict (used here to
 * mean: worktree has uncommitted changes, retry with force to discard them). */
export class ConflictError extends Error {}

/** Worktrees `git worktree list` reports for this repo that aren't tracked
 * in the DB yet — the repo settings page's "other git worktrees" datagrid.
 * Import a candidate from here via importWorktree() above. */
export function listExternalWorktrees(repoId: string): Promise<ExternalWorktreeEntry[]> {
  return request<ExternalWorktreeEntry[]>(`/api/repos/${repoId}/worktrees/external`);
}

/** Registers every not-yet-tracked git worktree found under this repo's
 * configured `external_worktrees_root` (see Repo.external_worktrees_root) —
 * the automatic counterpart to importWorktree() above. A no-op (empty
 * result) if that setting is blank. RepoContext calls this once per repo
 * right after repos load, so worktrees another tool created show up without
 * anyone visiting the settings page. Returns the worktrees it just onboarded. */
export function discoverExternalWorktrees(repoId: string): Promise<Worktree[]> {
  return request<Worktree[]>(`/api/repos/${repoId}/worktrees/discover`, {
    method: "POST",
  });
}

/** Every terminal session across every worktree under a repo, joined with
 * worktree branch/name — the repo settings page's "Shells" tab. */
export function listTerminalsForRepo(repoId: string): Promise<TerminalSessionWithWorktree[]> {
  return request<TerminalSessionWithWorktree[]>(`/api/repos/${repoId}/terminals/all`);
}

export function listTerminals(
  repoId: string,
  worktreeId: string
): Promise<TerminalSession[]> {
  return request<TerminalSession[]>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/terminals/`
  );
}

export function createTerminal(
  repoId: string,
  worktreeId: string,
  tabLabel?: string,
  initialCommand?: string,
  claudeSessionId?: string,
  claudeSessionTitle?: string,
  agySessionId?: string,
  agySessionTitle?: string
): Promise<TerminalSession> {
  return request<TerminalSession>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/terminals/`,
    {
      method: "POST",
      body: JSON.stringify({
        tab_label: tabLabel,
        initial_command: initialCommand,
        claude_session_id: claudeSessionId,
        claude_session_title: claudeSessionTitle,
        agy_session_id: agySessionId,
        agy_session_title: agySessionTitle,
      }),
    }
  );
}

/** Archives a worktree: a pure visibility flag, hides it from the normal
 * list. Does NOT touch git — the worktree/branch stay on disk, and any
 * claude session recorded against it stays resumable. See unarchiveWorktree
 * to reverse it, and deleteWorktree for the actual destructive removal. */
export function archiveWorktree(repoId: string, worktreeId: string): Promise<void> {
  return request<void>(`/api/repos/${repoId}/worktrees/${worktreeId}/archive`, {
    method: "POST",
  });
}

export function unarchiveWorktree(repoId: string, worktreeId: string): Promise<void> {
  return request<void>(`/api/repos/${repoId}/worktrees/${worktreeId}/unarchive`, {
    method: "POST",
  });
}

export function pinWorktree(repoId: string, worktreeId: string): Promise<{ pinned: boolean }> {
  return request<{ pinned: boolean }>(`/api/repos/${repoId}/worktrees/${worktreeId}/pin`, {
    method: "POST",
  });
}

export function unpinWorktree(repoId: string, worktreeId: string): Promise<{ pinned: boolean }> {
  return request<{ pinned: boolean }>(`/api/repos/${repoId}/worktrees/${worktreeId}/unpin`, {
    method: "POST",
  });
}

/** Every archived worktree for a repo — the settings page's "Archived
 * worktrees" section, where one can be unarchived back before the
 * backend's retention sweep hard-removes it (git worktree + DB row) once
 * it's been archived for worktreeActions.ts's ARCHIVED_RETENTION_DAYS. */
export function listArchivedWorktrees(repoId: string): Promise<Worktree[]> {
  return request<Worktree[]>(`/api/repos/${repoId}/worktrees/archived`);
}

export function deleteTerminal(
  repoId: string,
  worktreeId: string,
  terminalId: string
): Promise<void> {
  return request<void>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/terminals/${terminalId}`,
    { method: "DELETE" }
  );
}

/** A one-shot check of a terminal's tmux pane's current working directory
 * — used once when a terminal panel opens to flag (a faint red border) a
 * shell whose cwd has drifted outside its worktree. Not polled — see
 * internal/api/terminals.go's handleGetTerminalCwd for why a single
 * on-open check is what this actually needs. */
export function getTerminalCwd(
  repoId: string,
  worktreeId: string,
  terminalId: string
): Promise<{ cwd: string }> {
  return request<{ cwd: string }>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/terminals/${terminalId}/cwd`
  );
}

export interface PRSummary {
  number: number;
  title: string;
  state: string; // "OPEN" | "CLOSED" | "MERGED"
  url: string;
  is_draft: boolean;
}

export interface WorktreeSummary {
  branch: string;
  ahead: number;
  behind: number;
  has_upstream: boolean;
  dirty: boolean;
  changed_files: string[];
  /** null if the branch has no pull request, or the `gh` CLI itself isn't
   * available/authenticated — both degrade gracefully, not an error. */
  pr: PRSummary | null;
}

/** Git status + changed-file list + pull request (via `gh`) for a
 * worktree's branch — the sidebar's hover-summary popover. Not meant to be
 * called on every hover: see prGitCache.ts, which caches this with a TTL
 * and only re-fetches when stale, specifically to avoid hitting GitHub's
 * API rate limits from repeated hovers. */
export function getWorktreeSummary(repoId: string, worktreeId: string): Promise<WorktreeSummary> {
  return request<WorktreeSummary>(`/api/repos/${repoId}/worktrees/${worktreeId}/summary`);
}

export function getWorktreeStatus(
  repoId: string,
  worktreeId: string
): Promise<WorktreeStatus> {
  return request<WorktreeStatus>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/status`
  );
}

export function getWorktreeAuditLog(
  repoId: string,
  worktreeId: string
): Promise<AuditLogEntry[]> {
  return request<AuditLogEntry[]>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/audit-log`
  );
}

/** One past claude session found for a worktree's own path under
 * ~/.claude/projects/ — see internal/claudehook.ListSessionsForCwd. */
export interface ClaudeSessionSummary {
  session_id: string;
  /** First real user message, clipped — "" if none was found. */
  preview: string;
  /** The transcript file's own last-modified time (RFC3339). */
  updated_at: string;
  /** Transcript file size in bytes — see format.ts's formatBytes. */
  size_bytes: number;
}

/** Every past claude session for this worktree, newest first — the
 * dockview watermark's "past sessions" welcome screen. */
export function getWorktreeClaudeSessions(
  repoId: string,
  worktreeId: string
): Promise<ClaudeSessionSummary[]> {
  return request<ClaudeSessionSummary[]>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/claude-sessions`
  );
}

/** Whether a repo's shared post-checkout hook (see internal/githook) —
 * which logs every branch a worktree gets checked out onto to its audit
 * log — is currently installed. Installed once per repo (worktrees of the
 * same repo share one .git/hooks/, so there's no per-worktree variant). */
export function getGitHookStatus(repoId: string): Promise<{ installed: boolean }> {
  return request<{ installed: boolean }>(`/api/repos/${repoId}/git-hook/`);
}

export function installGitHook(repoId: string): Promise<void> {
  return request<void>(`/api/repos/${repoId}/git-hook/install`, { method: "POST" });
}

export function uninstallGitHook(repoId: string): Promise<void> {
  return request<void>(`/api/repos/${repoId}/git-hook/uninstall`, { method: "POST" });
}

export function getSpotlightStatus(
  repoId: string,
  worktreeId: string
): Promise<SpotlightStatus> {
  return request<SpotlightStatus>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/spotlight/`
  );
}

/** stash=true is the non-interactive equivalent of answering "yes" to the
 * spotlight CLI's own "stash and start?" prompt — this server-side call
 * has no controlling terminal to show that prompt on, so a dirty root
 * refuses (409/ConflictError) unless the caller passes stash=true, which
 * only happens after the user confirms it themselves in a browser prompt
 * (see startSpotlightWithFriendlyError in worktreeActions.ts). */
export function startSpotlight(
  repoId: string,
  worktreeId: string,
  stash = false
): Promise<{ root: string }> {
  const qs = stash ? "?stash=true" : "";
  return request<{ root: string }>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/spotlight/start${qs}`,
    { method: "POST" }
  );
}

export function stopSpotlight(repoId: string, worktreeId: string): Promise<void> {
  return request<void>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/spotlight/stop`,
    { method: "POST" }
  );
}

/** Dismisses a worktree's "claude needs your attention" sidebar badge —
 * called when its detail page is opened. See useAttentionStream.ts for the
 * live push side of this (the /ws/attention connection that sets the
 * badge in the first place). */
export function clearAttention(repoId: string, worktreeId: string): Promise<void> {
  return request<void>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/attention/clear`,
    { method: "POST" }
  );
}

/** Builds the websocket URL for a terminal session, relative to the current
 * page so it works both from `vite dev` (proxied) and the production Go
 * server (served directly) without needing separate config. */
export function terminalWsUrl(terminalId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/terminals/${terminalId}`;
}

/** Builds the websocket URL for a worktree's file-change push (fsnotify-
 * driven external-change notifications) — same relative-URL trick as
 * terminalWsUrl above, so it works from both `vite dev` and the production
 * server unmodified. */
export function filesWsUrl(worktreeId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/files/${worktreeId}`;
}

/** Builds the websocket URL for the global (not worktree-scoped) attention
 * push channel — see useAttentionStream.ts. */
export function attentionWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/attention`;
}

/** Builds the websocket URL for the global (not worktree-scoped) open-file
 * push channel — see useOpenFileStream.ts. */
export function openFileWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/open-file`;
}

/** Returns the saved dockview layout for a worktree, or `null` if nothing
 * has been saved yet (a 404, which is the normal/expected first-open
 * state here — not routed through request()'s generic error handling,
 * since a missing layout isn't an error condition for this call). */
export async function getWorktreeLayout(
  repoId: string,
  worktreeId: string
): Promise<unknown | null> {
  const res = await fetch(`/api/repos/${repoId}/worktrees/${worktreeId}/layout`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function saveWorktreeLayout(
  repoId: string,
  worktreeId: string,
  layout: unknown
): Promise<void> {
  return request<void>(`/api/repos/${repoId}/worktrees/${worktreeId}/layout`, {
    method: "PUT",
    body: JSON.stringify(layout),
  });
}

export function getFileTree(repoId: string, worktreeId: string): Promise<FileNode[]> {
  return request<FileNode[]>(`/api/repos/${repoId}/worktrees/${worktreeId}/files/tree`);
}

export function getFileContent(
  repoId: string,
  worktreeId: string,
  path: string
): Promise<FileContent> {
  return request<FileContent>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/files/content?path=${encodeURIComponent(path)}`
  );
}

export function openInVSCode(repoId: string, worktreeId: string): Promise<void> {
  return request<void>(`/api/repos/${repoId}/worktrees/${worktreeId}/open-in-vscode`, {
    method: "POST",
  });
}

export function saveFileContent(
  repoId: string,
  worktreeId: string,
  path: string,
  content: string
): Promise<void> {
  return request<void>(
    `/api/repos/${repoId}/worktrees/${worktreeId}/files/content?path=${encodeURIComponent(path)}`,
    { method: "PUT", body: JSON.stringify({ content }) }
  );
}

export function getDependencyStatus(): Promise<DependencyStatusMap> {
  return request<DependencyStatusMap>("/api/settings/dependencies");
}

export function getHooks(): Promise<HookStatus[]> {
  return request<HookStatus[]>("/api/settings/hooks");
}

export function installHook(id: string): Promise<void> {
  return request<void>(`/api/settings/hooks/${encodeURIComponent(id)}/install`, { method: "POST" });
}

export function uninstallHook(id: string): Promise<void> {
  return request<void>(`/api/settings/hooks/${encodeURIComponent(id)}/uninstall`, { method: "POST" });
}

export function installSkill(): Promise<void> {
  return request<void>("/api/settings/dependencies/skill/install", { method: "POST" });
}

export interface ServerLogs {
  /** "" if the server has no durable log file to read from (its home
   * directory couldn't be resolved at startup) — Lines is always empty
   * in that case too. */
  path: string;
  /** The most recent ERROR-level lines from the server's own log file,
   * oldest first — see internal/api/logs.go's tailErrorLines. Bounded
   * (currently 200); Path is shown in the UI so a person can open/tail/
   * grep the real file directly for anything this leaves out. */
  lines: string[];
}

/** The main settings modal's Logs tab. */
export function getServerLogs(): Promise<ServerLogs> {
  return request<ServerLogs>("/api/settings/logs");
}

/** Returns a claude session's human-readable title (its first real user
 * message, clipped), or `null` if no local transcript is found for that
 * session id — not routed through request()'s generic error handling
 * since a missing transcript is an expected, non-error outcome (e.g. the
 * session hasn't said anything yet, or was started somewhere this
 * machine's ~/.claude/projects doesn't have a record of). */
export async function getClaudeSessionTitle(sessionId: string): Promise<string | null> {
  const res = await fetch(`/api/claude-sessions/${sessionId}/title`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return body.title as string;
}
