package audit

// Event identifies a recorded audit-log action. Defined as its own type
// (not bare strings) so every call site passes an audit.Event value — a
// typo like "workree.create" fails to compile instead of silently
// creating a new, never-matched-by-any-filter event type at runtime. This
// is the single source of truth for which event types exist; the frontend
// mirrors it in web/src/auditEvents.ts (kept in sync by hand — there's no
// codegen step in this project, same as every other cross-language
// constant here, e.g. the resize-message JSON shape).
//
// Every new event type this module gains (interactive actions, DB/audit
// log joins, claude-hook-driven session events — see PLAN.md's audit-log
// TODOs) should be added here first, not as an inline string at the call
// site.
type Event string

const (
	EventRepoAdd                         Event = "repo.add"
	EventRepoUpdateBaseBranch            Event = "repo.update_base_branch"
	EventRepoUpdateExternalWorktreesRoot Event = "repo.update_external_worktrees_root"

	EventWorktreeCreate Event = "worktree.create"
	EventWorktreeImport Event = "worktree.import"
	// EventWorktreeAutoDiscover records the same registry-insert
	// handleImportWorktree does, but triggered automatically by the
	// discover-on-page-load flow (see handleDiscoverExternalWorktrees)
	// against a repo's configured ExternalWorktreesRoot, rather than a
	// manual "Attach" click.
	EventWorktreeAutoDiscover Event = "worktree.auto_discover"
	EventWorktreeRemove       Event = "worktree.remove"
	EventWorktreeArchive      Event = "worktree.archive"
	EventWorktreeUnarchive    Event = "worktree.unarchive"

	// Pinning (internal/api/pin.go) is deliberately NOT an audit event:
	// tried briefly, but per direct feedback it's noise rather than a
	// checkpoint worth a permanent record, unlike every other event type
	// here.

	// EventWorktreeBranchChange records a real `git checkout <branch>` (or
	// `git switch`, which also triggers post-checkout) inside a worktree —
	// see internal/githook. Distinct from worktree.create's own "branch"
	// field: that's the branch a worktree started on, this is every branch
	// it's toggled through since.
	EventWorktreeBranchChange Event = "worktree.branch_change"

	EventTerminalCreate Event = "terminal.create"
	EventTerminalClose  Event = "terminal.close"

	EventSpotlightStart Event = "spotlight.start"
	EventSpotlightStop  Event = "spotlight.stop"

	EventClaudeSessionCreate  Event = "claude.session.create"
	EventClaudeSessionContext Event = "claude.session.context"

	EventAgySessionCreate Event = "agy.session.create"

	EventFileWrite Event = "file.write"

	// EventOrphanTmuxKill records a kill made by the `worktree-studio
	// orphans --kill` sweep (see internal/term.KillOrphanTmuxSessions).
	// Carries no worktree_id — an orphan session by definition has no
	// terminal_sessions row to derive one from — so it never appears in
	// the per-worktree audit-log view, only in the raw log file.
	EventOrphanTmuxKill Event = "orphan_tmux.kill"
)
