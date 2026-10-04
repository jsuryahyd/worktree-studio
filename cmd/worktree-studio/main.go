// Command worktree-studio runs the local HTTP server for worktree-studio: a
// small dashboard over git worktrees for a registry of repos, backed by a
// SQLite store and a JSONL audit log. See PLAN.md and docs/architecture.md.
package main

import (
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"worktree-studio/internal/api"
	"worktree-studio/internal/attention"
	"worktree-studio/internal/audit"
	"worktree-studio/internal/files"
	"worktree-studio/internal/openfile"
	"worktree-studio/internal/store"
	"worktree-studio/internal/term"
	webembed "worktree-studio/web"
)

const defaultAddr = ":8787"

// addrPort extracts ":<port>" from a listen address like ":8787",
// "0.0.0.0:9000", or "localhost:8787" — used to build a "http://localhost:
// <port>" URL for the installed claude hook script, regardless of what
// host `addr` itself binds to (the hook always runs on this same machine).
func addrPort(addr string) string {
	if i := strings.LastIndex(addr, ":"); i != -1 {
		return addr[i:]
	}
	return ":" + addr
}

// maxPortTries bounds how far past the requested port listenFirstFree looks.
const maxPortTries = 20

// listenFirstFree listens on addr, and if that port is taken tries the next
// port up (logging each one it skips), up to maxPortTries ports. It returns
// the listener plus the address actually bound, so callers build URLs from
// that rather than the requested addr.
func listenFirstFree(addr string, logger *slog.Logger) (net.Listener, string, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, "", err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, "", err
	}
	var lastErr error
	for i := 0; i < maxPortTries; i++ {
		try := net.JoinHostPort(host, strconv.Itoa(port+i))
		ln, err := net.Listen("tcp", try)
		if err == nil {
			return ln, try, nil
		}
		lastErr = err
		logger.Warn("port unavailable, trying next", "addr", try, "err", err)
	}
	return nil, "", fmt.Errorf("no free port in %d tries from %s: %w", maxPortTries, addr, lastErr)
}

// logFilePath returns ~/.worktree-studio/server.log — this process's own
// log output, mirrored to disk so the main settings modal's Logs tab (and
// anyone debugging after the fact) has something durable to read even
// when the server was started headless/backgrounded and its stdout went
// nowhere anyone can get back to. Deliberately basic, no rotation — same
// call internal/audit.Logger makes for the audit log.
func logFilePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	return filepath.Join(home, ".worktree-studio", "server.log"), nil
}

func main() {
	// `install-hooks`/`uninstall-hooks` are one-shot CLI subcommands (see
	// hooks.go, driven by install/install.sh and install/uninstall.sh) —
	// handled and exited before any of the server's own setup (store,
	// audit log, worktree root) runs, since they don't need any of it.
	if runHooksCommand(os.Args[1:]) {
		return
	}
	if runOpenFileCommand(os.Args[1:]) {
		return
	}
	if runSpotlightCommand(os.Args[1:]) {
		return
	}
	if runOrphansCommand(os.Args[1:]) {
		return
	}
	if runCreateWorktreeCommand(os.Args[1:]) {
		return
	}

	logPath, err := logFilePath()
	if err != nil {
		// No file to log to yet, but stdout still works — a log
		// destination failing isn't itself worth crashing over.
		logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
		logger.Warn("resolve log file path, logging to stdout only", "err", err)
		logPath = ""
	}

	logWriter := io.Writer(os.Stdout)
	if logPath != "" {
		if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
			logWriter = os.Stdout
			logPath = ""
		} else if f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			// Never closed: this file needs to stay open for the entire
			// process lifetime, and the OS reclaims the descriptor on exit.
			logWriter = io.MultiWriter(os.Stdout, f)
		} else {
			logWriter = os.Stdout
			logPath = ""
		}
	}
	logger := slog.New(slog.NewTextHandler(logWriter, nil))

	st, err := store.OpenDefault()
	if err != nil {
		logger.Error("open store", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	al, err := audit.NewDefault()
	if err != nil {
		logger.Error("open audit log", "err", err)
		os.Exit(1)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		logger.Error("resolve home dir", "err", err)
		os.Exit(1)
	}
	worktreeRoot := filepath.Join(home, ".worktree-studio", "worktrees")
	if err := os.MkdirAll(worktreeRoot, 0o755); err != nil {
		logger.Error("create worktree root", "err", err)
		os.Exit(1)
	}

	if dropped, err := term.Reconcile(st); err != nil {
		logger.Warn("reconcile terminal sessions against live tmux sessions", "err", err)
	} else if dropped > 0 {
		logger.Info("pruned stale terminal session rows (tmux session no longer live)", "count", dropped)
	}

	// One-time correction for an installation that already ran an earlier,
	// regressed version of the terminal-clipboard feature — see
	// term.CorrectGlobalMouseAndPassthroughSettings's own comment and
	// docs/terminal-clipboard.md's "Problem 4"/"Problem 5"/"Problem 6".
	term.CorrectGlobalMouseAndPassthroughSettings()

	// Same idea, for an installation whose tmux server predates the
	// xterm-keys/extended-keys word-navigation fix — see
	// term.CorrectGlobalKeyEncodingSettings's own comment and
	// docs/terminal-keybindings.md.
	term.CorrectGlobalKeyEncodingSettings()

	// Same idea again, for the copy-mode keys that relay a copy to the
	// browser clipboard (and now show a "Copied N chars" confirmation).
	// tmux key tables are server-global, so this corrects every existing
	// session immediately — without it, an already-running tmux server
	// would keep its old bindings until someone happened to open a brand
	// new terminal. See term.BindGlobalCopyModeKeys and
	// docs/terminal-clipboard.md's "Problem 7"/"Problem 8".
	term.BindGlobalCopyModeKeys()

	addr := defaultAddr
	if v := os.Getenv("WORKTREE_STUDIO_ADDR"); v != "" {
		addr = v
	}

	ln, addr, err := listenFirstFree(addr, logger)
	if err != nil {
		logger.Error("no free port", "err", err)
		os.Exit(1)
	}

	srv := &api.Server{
		Store:        st,
		Audit:        al,
		Term:         &term.Manager{Store: st, Audit: al},
		Files:        files.NewManager(),
		Attention:    attention.NewTracker(),
		OpenFile:     openfile.NewTracker(),
		WorktreeRoot: worktreeRoot,
		Log:          logger,
		LogFilePath:  logPath,
		// The hook always runs on the same machine as the server (a
		// script Claude Code invokes as a local subprocess), so localhost
		// is correct regardless of what host `addr` itself binds to.
		SelfBaseURL: "http://localhost" + addrPort(addr),
	}

	// Backfills the synthetic root worktree (see api.Server.ensureRootWorktree)
	// for repos registered before it existed — new repos get theirs at
	// add-repo time instead, this only ever does real work once per repo.
	if repos, err := st.ListRepos(); err != nil {
		logger.Warn("list repos for root-worktree backfill", "err", err)
	} else {
		for _, repo := range repos {
			srv.EnsureRootWorktree(repo)
		}
	}

	// Removes worktrees archived for longer than api.ArchivedWorktreeRetention
	// (git worktree + DB row, hard delete): once at startup, so anything that
	// crossed the threshold while the server was down is cleaned up promptly,
	// then on a running interval for as long as the server stays up. The
	// interval doesn't need to be anywhere near the 60-day retention itself —
	// it only controls how promptly an already-expired worktree gets noticed.
	srv.SweepExpiredArchivedWorktrees()
	go func() {
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			srv.SweepExpiredArchivedWorktrees()
		}
	}()

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	srv.Routes(r)
	mountFrontend(r, logger)

	logger.Info("worktree-studio listening", "addr", addr)
	if err := http.Serve(ln, r); err != nil {
		logger.Error("server exited", "err", err)
		os.Exit(1)
	}
}

// mountFrontend serves the embedded web/dist build if it actually contains
// a built app (i.e. has an index.html), and otherwise serves a small
// friendly placeholder page instead of 404s/crashes — this is the "graceful
// fallback if web/dist doesn't exist yet" behavior.
func mountFrontend(r chi.Router, logger *slog.Logger) {
	sub, err := fs.Sub(webembed.DistFS, "dist")
	if err != nil {
		logger.Warn("no embedded web/dist available, serving placeholder", "err", err)
		r.NotFound(placeholderHandler)
		return
	}

	if _, err := fs.Stat(sub, "index.html"); err != nil {
		logger.Warn("web/dist has no built frontend yet (run: cd web && bun install && bun run build), serving placeholder")
		r.NotFound(placeholderHandler)
		return
	}

	fileServer := http.FileServer(http.FS(sub))
	r.Handle("/*", spaHandler(sub, fileServer))
}

// spaHandler serves static files when they exist, and falls back to
// index.html otherwise so client-side routing (React Router paths like
// /repo/:id) works on a hard refresh.
func spaHandler(fsys fs.FS, fileServer http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path != "/" {
			trimmed := path[1:]
			if _, err := fs.Stat(fsys, trimmed); err == nil {
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}

const placeholderHTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>worktree-studio</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; line-height: 1.5;">
<h1>worktree-studio</h1>
<p>The API server is running, but the frontend hasn't been built yet.</p>
<p>Run:</p>
<pre style="background:#eee; padding: 1rem;">cd web &amp;&amp; bun install &amp;&amp; bun run build</pre>
<p>then restart this server, or run <code>bun run dev</code> in <code>web/</code> for a hot-reloading dev server proxying to this API.</p>
</body>
</html>`

func placeholderHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(placeholderHTML))
}
