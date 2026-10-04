// Terminal endpoints: REST CRUD for tmux-backed terminal sessions scoped to
// a worktree, plus the websocket endpoint that attaches a pty to the tmux
// session and relays it to the browser. See internal/term and PLAN.md
// section 3.
package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"worktree-studio/internal/audit"
	"worktree-studio/internal/store"
	"worktree-studio/internal/term"
)

// getRepoAndWorktree looks up a worktree scoped to a repo, writing the
// appropriate 404/500 response and returning ok=false if it can't be found.
func (s *Server) getRepoAndWorktree(w http.ResponseWriter, r *http.Request) (store.Worktree, bool) {
	repoID := chi.URLParam(r, "repoID")
	worktreeID := chi.URLParam(r, "worktreeID")

	repo, err := s.Store.GetRepo(repoID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "repo not found")
			return store.Worktree{}, false
		}
		s.Log.Error("get repo", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to look up repo")
		return store.Worktree{}, false
	}

	wt, err := s.Store.GetWorktree(worktreeID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "worktree not found")
			return store.Worktree{}, false
		}
		s.Log.Error("get worktree", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to look up worktree")
		return store.Worktree{}, false
	}
	if wt.RepoID != repo.ID {
		writeError(w, http.StatusNotFound, "worktree not found")
		return store.Worktree{}, false
	}
	return wt, true
}

// handleListTerminalsForRepo returns every terminal session across every
// worktree under this repo, joined with worktree branch/name — the settings
// page's "open shells" tab, a cross-worktree view the per-worktree
// handleListTerminals doesn't give you.
func (s *Server) handleListTerminalsForRepo(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")

	if _, err := s.Store.GetRepo(repoID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "repo not found")
			return
		}
		s.Log.Error("get repo", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to look up repo")
		return
	}

	sessions, err := s.Store.ListTerminalSessionsForRepo(repoID)
	if err != nil {
		s.Log.Error("list terminal sessions for repo", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to list terminal sessions")
		return
	}
	if sessions == nil {
		sessions = []store.TerminalSessionWithWorktree{}
	}
	writeJSON(w, http.StatusOK, sessions)
}

func (s *Server) handleListTerminals(w http.ResponseWriter, r *http.Request) {
	wt, ok := s.getRepoAndWorktree(w, r)
	if !ok {
		return
	}
	sessions, err := s.Term.ListSessions(wt.ID)
	if err != nil {
		s.Log.Error("list terminal sessions", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to list terminal sessions")
		return
	}
	if sessions == nil {
		sessions = []store.TerminalSession{}
	}
	writeJSON(w, http.StatusOK, sessions)
}

type createTerminalRequest struct {
	TabLabel       string `json:"tab_label"`
	InitialCommand string `json:"initial_command"`
	// ClaudeSessionID/ClaudeSessionTitle are set by the frontend when the
	// initial command is a `claude --session-id <uuid> ...` invocation it
	// generated itself (see createWorktreeWithClaudeTerminal in
	// worktreeActions.ts) — logged as their own audit event so the id (and
	// a human-readable title) survive independently of this terminal/tmux
	// session, letting a person later `claude --resume <id>` in this
	// worktree even after the tab/session that started it is long gone.
	ClaudeSessionID    string `json:"claude_session_id"`
	ClaudeSessionTitle string `json:"claude_session_title"`
	AgySessionID       string `json:"agy_session_id"`
	AgySessionTitle    string `json:"agy_session_title"`
}

func (s *Server) handleCreateTerminal(w http.ResponseWriter, r *http.Request) {
	wt, ok := s.getRepoAndWorktree(w, r)
	if !ok {
		return
	}

	var req createTerminalRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req) // body is optional; a bad/empty body just means "use the default label, no initial command"
	}
	label := req.TabLabel
	if label == "" {
		label = "shell"
	}

	ts, err := s.Term.CreateSession(wt.ID, wt.Path, label, req.InitialCommand)
	if err != nil {
		s.Log.Error("create terminal session", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to create terminal session: "+err.Error())
		return
	}

	if req.ClaudeSessionID != "" {
		s.auditLog(audit.EventClaudeSessionCreate, map[string]any{
			"repo_id":           wt.RepoID,
			"worktree_id":       wt.ID,
			"terminal_id":       ts.ID,
			"claude_session_id": req.ClaudeSessionID,
			"title":             req.ClaudeSessionTitle,
		})
	}
	if req.AgySessionID != "" {
		s.auditLog(audit.EventAgySessionCreate, map[string]any{
			"repo_id":        wt.RepoID,
			"worktree_id":    wt.ID,
			"terminal_id":    ts.ID,
			"agy_session_id": req.AgySessionID,
			"title":          req.AgySessionTitle,
		})
	}

	writeJSON(w, http.StatusCreated, ts)
}

func (s *Server) handleDeleteTerminal(w http.ResponseWriter, r *http.Request) {
	wt, ok := s.getRepoAndWorktree(w, r)
	if !ok {
		return
	}
	terminalID := chi.URLParam(r, "terminalID")

	ts, err := s.Store.GetTerminalSession(terminalID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "terminal session not found")
			return
		}
		s.Log.Error("get terminal session", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to look up terminal session")
		return
	}
	if ts.WorktreeID != wt.ID {
		writeError(w, http.StatusNotFound, "terminal session not found")
		return
	}

	if err := s.Term.CloseSession(ts); err != nil {
		s.Log.Error("close terminal session", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to close terminal session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "closed"})
}

// handleGetTerminalCwd returns a terminal's tmux pane's current working
// directory right now (term.CurrentPath) — a one-shot check the frontend
// makes once when a terminal panel opens, to flag (a faint red border) a
// shell whose cwd has drifted outside its worktree, e.g. someone `cd ..`d
// out of it. Deliberately not polled: this project already has one
// legitimate background poller (RepoContext.tsx's StatusScheduler, for
// live per-row status many rows show at once) and this isn't that kind of
// signal — a directory only changes when someone types `cd`, and a check
// on open is what the UI actually needs.
func (s *Server) handleGetTerminalCwd(w http.ResponseWriter, r *http.Request) {
	wt, ok := s.getRepoAndWorktree(w, r)
	if !ok {
		return
	}
	terminalID := chi.URLParam(r, "terminalID")

	ts, err := s.Store.GetTerminalSession(terminalID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "terminal session not found")
			return
		}
		s.Log.Error("get terminal session", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to look up terminal session")
		return
	}
	if ts.WorktreeID != wt.ID {
		writeError(w, http.StatusNotFound, "terminal session not found")
		return
	}

	cwd, err := term.CurrentPath(ts.TmuxSessionName)
	if err != nil {
		s.Log.Error("get terminal cwd", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to look up terminal's current directory")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"cwd": cwd})
}

var upgrader = websocket.Upgrader{
	// This is a local dev tool bound to localhost by default (see PLAN.md's
	// deferred auth/remote-access hardening note) — same-origin checks
	// aren't the load-bearing security boundary here, so allow any origin
	// rather than fighting the dev-server proxy's different origin.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// handleTerminalWS upgrades to a websocket, attaches a pty to the terminal
// session's tmux session, and relays bytes both ways. Protocol: binary ws
// messages are raw bytes fed straight into the pty (keystrokes in, tmux's
// rendered output out); text ws messages are JSON control frames, of which
// the only one currently defined is {"type":"resize","cols":N,"rows":N}.
func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	terminalID := chi.URLParam(r, "terminalID")

	ts, err := s.Store.GetTerminalSession(terminalID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "terminal session not found", http.StatusNotFound)
			return
		}
		http.Error(w, "failed to look up terminal session", http.StatusInternalServerError)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.Log.Warn("ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	if !term.HasSession(ts.TmuxSessionName) {
		// The tmux session backing this tab is already gone — it died on
		// its own (e.g. the pane's only process exited, which kills the
		// whole session by tmux's own default) or was killed outside the
		// app, and Reconcile only prunes rows like this at server startup,
		// not while the server keeps running. Without this check,
		// term.Attach below would still "succeed" (the pty process starts
		// fine) while tmux itself exits immediately and writes its own
		// "can't find session: ..." to stderr — which then gets relayed
		// through the pty exactly like real pane output, so the tab looked
		// permanently, cryptically broken with no path forward short of a
		// server restart or closing the tab by hand.
		//
		// This writes one clear, human-written line instead, and
		// deliberately does NOT delete the row itself — that stays the job
		// of the existing paths (closing the tab via handleDeleteTerminal,
		// or the next server restart's Reconcile), so there's still
		// exactly one way a terminal_sessions row goes away, not two.
		s.Log.Info("terminal's tmux session no longer exists, refusing to attach", "terminal_id", ts.ID, "tmux_session_name", ts.TmuxSessionName)
		_ = conn.WriteMessage(websocket.TextMessage, []byte(
			"\r\nThis terminal's session no longer exists (it exited, or was closed outside the app).\r\n"+
				"Close this tab (×) to remove it — a server restart would also clean it up automatically.\r\n",
		))
		return
	}

	pf, cmd, err := term.Attach(ts.TmuxSessionName)
	if err != nil {
		s.Log.Error("attach pty", "err", err)
		_ = conn.WriteMessage(websocket.TextMessage, []byte("\r\nFailed to attach to this terminal: "+err.Error()+"\r\n"))
		return
	}
	defer func() {
		_ = pf.Close()
		_ = cmd.Process.Kill() // kills the `tmux attach` client, NOT the tmux session it was attached to
	}()

	// Replays tmux's current pane title as a synthetic OSC 0 sequence right
	// after attaching — see CurrentTitle's doc comment for why this is
	// needed (tmux only emits the real escape sequence on a title *change*,
	// not on a fresh client attaching to an already-running session).
	// Best-effort: a lookup failure just means the tab keeps its default
	// label until the pane's title next changes on its own, same as before
	// this fix existed.
	if title, terr := term.CurrentTitle(ts.TmuxSessionName); terr == nil && title != "" {
		_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x1b]0;"+title+"\x07"))
	}

	// pty -> websocket
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			n, err := pf.Read(buf)
			if n > 0 {
				if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					s.Log.Debug("pty read ended", "err", err)
				}
				return
			}
		}
	}()

	// websocket -> pty (+ resize control messages)
	type resizeMsg struct {
		Type string `json:"type"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		switch msgType {
		case websocket.BinaryMessage:
			if _, err := pf.Write(data); err != nil {
				break
			}
		case websocket.TextMessage:
			var m resizeMsg
			if json.Unmarshal(data, &m) == nil && m.Type == "resize" && m.Cols > 0 && m.Rows > 0 {
				_ = term.Resize(pf, m.Cols, m.Rows)
			}
		}
	}

	<-done
}
