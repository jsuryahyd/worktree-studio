import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorktreeDetail from "./WorktreeDetail";

// Stub out the real Terminal component (xterm + a real WebSocket) — this
// test is about dockview panel orchestration and terminal CRUD wiring,
// not xterm/websocket internals (those are exercised by manual/real-server
// verification elsewhere, and Terminal.tsx itself is unchanged by this step).
vi.mock("./Terminal", () => ({
  default: ({ terminalId }: { terminalId: string }) => (
    <div data-testid={`terminal-${terminalId}`}>term:{terminalId}</div>
  ),
}));

// Stub out the real EditorPanel (CodeMirror + its own file-content fetch)
// for the same reason Terminal is stubbed above — this test is about
// dockview panel orchestration (does opening a file create/reuse the right
// panel?), not the editor engine's own internals.
vi.mock("./EditorPanel", () => ({
  default: ({ params }: { params: { path: string } }) => (
    <div data-testid={`editor-${params.path}`}>editor:{params.path}</div>
  ),
}));

vi.mock("./api", () => ({
  listTerminals: vi.fn(),
  createTerminal: vi.fn(),
  deleteTerminal: vi.fn(),
  getWorktreeLayout: vi.fn(),
  saveWorktreeLayout: vi.fn(),
  getFileTree: vi.fn(),
  getDependencyStatus: vi.fn(),
  openInVSCode: vi.fn(),
  getTerminalCwd: vi.fn(),
  getWorktreeSummary: vi.fn(),
  getWorktreeClaudeSessions: vi.fn(),
}));

// Stubbed rather than wrapped in the real RepoProvider (which would need
// listRepos/listWorktrees/getWorktreeStatus/getSpotlightStatus mocked too,
// none of which this test cares about) — WorktreeDetail only reads
// worktreesByRepo from this context, to resolve the current worktree's
// path (for TerminalPanel's cwd-mismatch check).
vi.mock("./RepoContext", () => ({
  useRepoContext: vi.fn(),
}));

import {
  createTerminal,
  deleteTerminal,
  getDependencyStatus,
  getFileTree,
  getTerminalCwd,
  getWorktreeClaudeSessions,
  getWorktreeLayout,
  getWorktreeSummary,
  listTerminals,
  saveWorktreeLayout,
} from "./api";
import { useRepoContext } from "./RepoContext";
import { getActiveWorktreeActions } from "./activeWorktreeActions";
import { formatDateTime } from "./format";
import {
  FILES_PANEL_DEFAULT_WIDTH,
  FILES_PANEL_MAX_WIDTH,
  getStoredFilesWidth,
  setStoredFilesSide,
  setStoredFilesWidth,
} from "./filesPanelPreference";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/repo/r1/worktree/w1"]}>
      <Routes>
        <Route path="/repo/:repoId/worktree/:worktreeId" element={<WorktreeDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(listTerminals).mockResolvedValue([
    { id: "t1", worktree_id: "w1", tmux_session_name: "wts-t1", tab_label: "shell" },
  ]);
  let nextId = 2;
  vi.mocked(createTerminal).mockImplementation(async () => ({
    id: `t${nextId++}`,
    worktree_id: "w1",
    tmux_session_name: `wts-t${nextId}`,
    tab_label: "shell",
  }));
  vi.mocked(getWorktreeLayout).mockResolvedValue(null);
  vi.mocked(saveWorktreeLayout).mockResolvedValue(undefined);
  vi.mocked(getFileTree).mockResolvedValue([]);
  vi.mocked(deleteTerminal).mockResolvedValue(undefined);
  vi.mocked(getWorktreeClaudeSessions).mockResolvedValue([]);
  // The WorktreeSummary cache is localStorage-backed (prGitCache.ts, 5min
  // TTL), so without this the first test's summary is served to every
  // later one regardless of what getWorktreeSummary is mocked to return.
  localStorage.clear();

  // Matches the active worktree's own path by default, i.e. no
  // cwd-mismatch border — individual tests override this to exercise the
  // mismatch case.
  vi.mocked(getTerminalCwd).mockResolvedValue({ cwd: "/tmp/feature" });
  vi.mocked(getWorktreeSummary).mockResolvedValue({
    branch: "feature",
    ahead: 0,
    behind: 0,
    has_upstream: true,
    dirty: false,
    changed_files: [],
    pr: null,
  });
  vi.mocked(useRepoContext).mockReturnValue({
    repos: [],
    reposLoading: false,
    reposError: null,
    refreshRepos: vi.fn(),
    selectedRepoId: "r1",
    worktreesByRepo: {
      r1: [
        { id: "w1", repo_id: "r1", name: "feature-worktree", branch: "feature", path: "/tmp/feature", created_at: "", status: "active" },
        { id: "w2", repo_id: "r1", name: "other-worktree", branch: "other", path: "/tmp/other", created_at: "", status: "active" },
      ],
    },
    worktreesLoading: false,
    worktreesError: null,
    refreshWorktrees: vi.fn(),
    gitStatus: {},
    spotlightStatus: {},
    statusRefreshing: {},
  });
  vi.mocked(getDependencyStatus).mockResolvedValue({
    tmux: { installed: true },
    spotlight: { installed: true },
    skill: { installed: true },
    vscode_cli: { installed: false },
  });
});

describe("WorktreeDetail", () => {
  it("renders each existing terminal as a dockview panel", async () => {
    renderPage();
    await waitFor(() => expect(listTerminals).toHaveBeenCalledWith("r1", "w1"));
    expect(await screen.findByTestId("terminal-t1")).toBeInTheDocument();
  });

  it("flags a terminal whose cwd has drifted outside the worktree with a faint border", async () => {
    vi.mocked(getTerminalCwd).mockResolvedValue({ cwd: "/tmp/somewhere-else" });
    renderPage();
    const term = await screen.findByTestId("terminal-t1");
    await waitFor(() => expect(term.closest(".terminal-panel-inset")).toHaveClass("cwd-mismatch"));
  });

  it("does not flag a terminal whose cwd is a subdirectory of the worktree", async () => {
    vi.mocked(getTerminalCwd).mockResolvedValue({ cwd: "/tmp/feature/src" });
    renderPage();
    const term = await screen.findByTestId("terminal-t1");
    await waitFor(() => expect(getTerminalCwd).toHaveBeenCalled());
    expect(term.closest(".terminal-panel-inset")).not.toHaveClass("cwd-mismatch");
  });

  it("Ctrl/Cmd+B toggles the file tree panel", async () => {
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");
    expect(container.querySelector(".worktree-sidebar")).toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
    });
    expect(container.querySelector(".worktree-sidebar")).not.toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
    });
    expect(container.querySelector(".worktree-sidebar")).toBeInTheDocument();
  });

  // Regression guard: tmux's own default prefix key is Ctrl+B, so this
  // shortcut must not steal that keystroke away from a focused terminal
  // pane — see WorktreeDetail.tsx's own comment on this effect.
  it("Ctrl+B does not toggle the file tree when the event originates inside a terminal (.xterm)", async () => {
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");
    expect(container.querySelector(".worktree-sidebar")).toBeInTheDocument();

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    document.body.appendChild(xterm);

    act(() => {
      xterm.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
    });
    expect(container.querySelector(".worktree-sidebar")).toBeInTheDocument();

    document.body.removeChild(xterm);
  });

  it("the far-left '+' in the tab strip creates a new terminal", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("terminal-t1");

    await user.click(screen.getByTitle("New terminal tab"));
    await waitFor(() => expect(createTerminal).toHaveBeenCalledWith("r1", "w1", undefined, undefined));
    expect(await screen.findByTestId("terminal-t2")).toBeInTheDocument();
  });

  // The "+"/split-right/split-down buttons that used to live in this
  // component's own toolbar now live in the sidebar's expandable worktree
  // card and call through the activeWorktreeActions registry instead — see
  // activeWorktreeActions.ts. Driven here the same way that consumer would.
  it("creates a terminal via the registered newTerminal action and renders it", async () => {
    renderPage();
    await screen.findByTestId("terminal-t1");

    await act(async () => {
      getActiveWorktreeActions()?.newTerminal();
    });

    await waitFor(() => expect(createTerminal).toHaveBeenCalledWith("r1", "w1", undefined, undefined));
    expect(await screen.findByTestId("terminal-t2")).toBeInTheDocument();
  });

  it("creates a terminal via the registered splitRight and splitDown actions", async () => {
    renderPage();
    await screen.findByTestId("terminal-t1");

    await act(async () => {
      getActiveWorktreeActions()?.splitRight();
    });
    expect(await screen.findByTestId("terminal-t2")).toBeInTheDocument();

    await act(async () => {
      getActiveWorktreeActions()?.splitDown();
    });
    expect(await screen.findByTestId("terminal-t3")).toBeInTheDocument();

    expect(createTerminal).toHaveBeenCalledTimes(2);
  });

  // The header used to hold the branch name and nothing else, beside a
  // file-tree panel showing that same string. It now carries what you'd
  // otherwise run `git status` for — and each part renders only when
  // there's something to report.
  describe("worktree header", () => {
    it("stays silent for a clean, in-sync branch", async () => {
      renderPage();
      await screen.findByTestId("terminal-t1");

      expect(screen.getByText("feature")).toBeInTheDocument();
      expect(screen.queryByText(/changed$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^[↑↓]/)).not.toBeInTheDocument();
      // An absent PR renders nothing at all, not "[No pull request…]".
      expect(screen.queryByText(/pull request/i)).not.toBeInTheDocument();
    });

    it("reports ahead/behind and a changed-file count when there is any", async () => {
      vi.mocked(getWorktreeSummary).mockResolvedValue({
        branch: "feature",
        ahead: 2,
        behind: 54,
        has_upstream: true,
        dirty: true,
        changed_files: ["a.go", "b.go", "c.go"],
        pr: null,
      });
      renderPage();
      await screen.findByTestId("terminal-t1");

      expect(await screen.findByText("3 changed")).toBeInTheDocument();
      const ticks = await screen.findByTitle("2 ahead, 54 behind upstream");
      expect(ticks.textContent).toBe("↑2 ↓54");
    });

    it("shows a PR as a number plus title, with draft called out separately", async () => {
      vi.mocked(getWorktreeSummary).mockResolvedValue({
        branch: "feature",
        ahead: 0,
        behind: 0,
        has_upstream: true,
        dirty: false,
        changed_files: [],
        pr: { number: 2841, title: "Order id migration", url: "https://example/pr", is_draft: true },
      });
      renderPage();
      await screen.findByTestId("terminal-t1");

      expect(await screen.findByText("#2841")).toBeInTheDocument();
      expect(screen.getByText("Order id migration")).toBeInTheDocument();
      expect(screen.getByText("draft")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /2841/ })).toHaveAttribute("href", "https://example/pr");
    });
  });

  it("fetches the saved layout for this worktree on mount", async () => {
    renderPage();
    await screen.findByTestId("terminal-t1");
    await waitFor(() => expect(getWorktreeLayout).toHaveBeenCalledWith("r1", "w1"));
  });

  it(
    "saves the layout (debounced) after a real dockview layout change",
    async () => {
      // Real timers, not fake ones — vi.useFakeTimers() interacts badly
      // with testing-library's internal polling (findBy/waitFor use real
      // setTimeout under the hood too), so faking time here risked
      // deadlocking the test rather than actually speeding it up. A 600ms
      // real wait for one test is a fine price for exercising the real
      // debounce path end-to-end instead of mocking it away.
      renderPage();
      await screen.findByTestId("terminal-t1");
      await waitFor(() => expect(getWorktreeLayout).toHaveBeenCalled());

      // Let anything the initial mount scheduled flush and settle, so the
      // count asserted below belongs to the change this test makes.
      await new Promise((resolve) => setTimeout(resolve, 600));
      vi.mocked(saveWorktreeLayout).mockClear();

      await act(async () => {
        getActiveWorktreeActions()?.newTerminal();
      });
      await screen.findByTestId("terminal-t2");

      await new Promise((resolve) => setTimeout(resolve, 600));
      await waitFor(() => expect(saveWorktreeLayout).toHaveBeenCalled());

      // The debounce's actual contract: adding one panel fires several
      // dockview layout events in the same tick (add, set-active, resize)
      // and they coalesce into ONE save.
      //
      // This replaced an `expect(saveWorktreeLayout).not.toHaveBeenCalled()`
      // taken mid-window, which was a wall-clock race — the awaits above it
      // are real-timer polling, so under a loaded full-suite run they
      // routinely overran the 500ms debounce and the save had legitimately
      // already happened. Counting coalesced calls tests the same property
      // and doesn't depend on how fast the machine is.
      expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);

      const lastCall = vi.mocked(saveWorktreeLayout).mock.calls.at(-1);
      expect(lastCall?.[0]).toBe("r1");
      expect(lastCall?.[1]).toBe("w1");
      // The third argument is dockview's own real toJSON() output (not a
      // fixture) — assert it's shaped like a real serialized layout
      // rather than pinning its exact contents, which would make this
      // test brittle against dockview's own internal schema.
      expect(lastCall?.[2]).toHaveProperty("panels");
      expect(lastCall?.[2]).toHaveProperty("grid");
    },
    10000
  );

  // Regression test for a real user-reported bug ("all worktrees show the
  // same terminals" / "terminals not switching"): react-router reuses the
  // same WorktreeDetail component instance across navigations between two
  // different worktree URLs (same route element, just new params) rather
  // than unmounting it — so without an explicit remount, dockview's
  // long-lived panel set from previously-visited worktrees just
  // accumulated. Uses real client-side navigation (createMemoryRouter +
  // router.navigate), not separate render() calls — those would trivially
  // "pass" regardless of the bug, since each always creates a fresh tree.
  //
  // A single w1->w2 hop alone does NOT discriminate here: dockview's own
  // default tab-visibility handling unmounts the now-inactive w1 panel's
  // DOM even on the *buggy* code, so it looks fine by accident on the
  // first hop. The bug only becomes visible on a round trip back to a
  // *previously*-visited worktree — confirmed by hand: this exact
  // assertion failed (showing "terminal-t2" while on /worktree/w1) against
  // the pre-fix component, and passes against the fixed one.
  it("shows the right worktree's terminal after navigating away and back (round trip)", async () => {
    vi.mocked(listTerminals).mockImplementation(async (_repoId, worktreeId) => {
      if (worktreeId === "w1") {
        return [{ id: "t1", worktree_id: "w1", tmux_session_name: "wts-t1", tab_label: "shell" }];
      }
      if (worktreeId === "w2") {
        return [{ id: "t2", worktree_id: "w2", tmux_session_name: "wts-t2", tab_label: "shell" }];
      }
      return [];
    });

    const router = createMemoryRouter(
      [{ path: "/repo/:repoId/worktree/:worktreeId", element: <WorktreeDetail /> }],
      { initialEntries: ["/repo/r1/worktree/w1"] }
    );
    render(<RouterProvider router={router} />);
    await screen.findByTestId("terminal-t1");

    router.navigate("/repo/r1/worktree/w2");
    await screen.findByTestId("terminal-t2");

    router.navigate("/repo/r1/worktree/w1");

    expect(await screen.findByTestId("terminal-t1")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-t2")).not.toBeInTheDocument();
  });

  it("empty-state watermark's 'Open claude' button creates a claude terminal", async () => {
    vi.mocked(listTerminals).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Open claude" }));
    await waitFor(() =>
      expect(createTerminal).toHaveBeenCalledWith("r1", "w1", "claude", "claude")
    );
  });

  it("empty-state watermark's 'Open agy' button creates an agy terminal", async () => {
    vi.mocked(listTerminals).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Open agy" }));
    await waitFor(() =>
      expect(createTerminal).toHaveBeenCalledWith("r1", "w1", "agy", "agy")
    );
  });

  it("empty-state watermark's 'Open shell' button creates a plain terminal", async () => {
    vi.mocked(listTerminals).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Open shell" }));
    await waitFor(() =>
      expect(createTerminal).toHaveBeenCalledWith("r1", "w1", undefined, undefined)
    );
  });

  it("empty-state watermark lists past claude sessions as cards with preview/time/size", async () => {
    vi.mocked(listTerminals).mockResolvedValue([]);
    const updatedAt = "2026-01-15T10:34:00Z";
    vi.mocked(getWorktreeClaudeSessions).mockResolvedValue([
      {
        session_id: "sess-1",
        preview: "fix the flaky login test",
        updated_at: updatedAt,
        size_bytes: 2_400_000,
      },
    ]);
    renderPage();

    await screen.findByText("Past claude sessions");
    expect(screen.getByText("fix the flaky login test")).toBeInTheDocument();
    // An absolute date/time, not a relative one ("2 weeks ago" doesn't
    // help someone telling two same-titled sessions apart) — see
    // format.ts's formatDateTime, whose exact output is locale/timezone
    // dependent, hence computing the expectation rather than hardcoding it.
    expect(screen.getByText(formatDateTime(updatedAt))).toBeInTheDocument();
    expect(screen.getByText("2.3 MB")).toBeInTheDocument();
    expect(getWorktreeClaudeSessions).toHaveBeenCalledWith("r1", "w1");
  });

  it("centers a single past-session card instead of leaving it flush left in the grid", async () => {
    vi.mocked(listTerminals).mockResolvedValue([]);
    vi.mocked(getWorktreeClaudeSessions).mockResolvedValue([
      { session_id: "sess-1", preview: "only session", updated_at: "2026-01-15T10:34:00Z", size_bytes: 1024 },
    ]);
    renderPage();

    const card = await screen.findByText("only session");
    const cards = card.closest(".claude-session-cards");
    expect(cards?.children).toHaveLength(1);
  });

  it("clicking a past-session card resumes that session in a new terminal", async () => {
    vi.mocked(listTerminals).mockResolvedValue([]);
    vi.mocked(getWorktreeClaudeSessions).mockResolvedValue([
      { session_id: "sess-abc-123", preview: "add pagination", updated_at: new Date().toISOString(), size_bytes: 1024 },
    ]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText("add pagination"));
    await waitFor(() =>
      expect(createTerminal).toHaveBeenCalledWith("r1", "w1", "claude (resumed)", "claude --resume sess-abc-123")
    );
  });

  it("shows no past-sessions section when there are none", async () => {
    vi.mocked(listTerminals).mockResolvedValue([]);
    vi.mocked(getWorktreeClaudeSessions).mockResolvedValue([]);
    renderPage();

    await screen.findByRole("button", { name: "Open shell" });
    expect(screen.queryByText("Past claude sessions")).not.toBeInTheDocument();
  });

  it("opens a file from the file tree into an editor panel, and reuses it on a second click", async () => {
    vi.mocked(getFileTree).mockResolvedValue([
      { name: "main.go", path: "src/main.go", type: "file" },
    ]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("terminal-t1");

    const fileButton = await screen.findByText("main.go");
    await user.click(fileButton);
    expect(await screen.findByTestId("editor-src/main.go")).toBeInTheDocument();

    // Clicking the same file again must not open a second panel — see
    // EditorPanel.tsx's doc comment: one panel per file per worktree,
    // reused rather than duplicated.
    await user.click(fileButton);
    expect(screen.getAllByTestId("editor-src/main.go")).toHaveLength(1);
  });

  // Regression test for a real user-reported bug: dockview's
  // onDidRemovePanel fires for every closed panel, terminals AND editor
  // panels alike, but only terminals have a server-side session to tear
  // down. Before the fix, closing an editor panel fell through to
  // deleteTerminal(editorPanelId), which 404'd ("terminal session not
  // found") and surfaced that as a top-level error banner sitting right
  // above the editor — for an action (closing a file) that has nothing to
  // clean up server-side.
  it("closing a file's editor panel does not call deleteTerminal or show an error", async () => {
    vi.mocked(getFileTree).mockResolvedValue([{ name: "main.go", path: "main.go", type: "file" }]);
    const user = userEvent.setup();
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");

    await user.click(await screen.findByText("main.go"));
    await screen.findByTestId("editor-main.go");

    const editorTab = Array.from(container.querySelectorAll(".dv-tab")).find((el) =>
      el.textContent?.includes("main.go")
    );
    const closeBtn = editorTab?.querySelector(".dv-default-tab-action");
    expect(closeBtn).toBeTruthy();
    await user.click(closeBtn as Element);

    await waitFor(() => expect(screen.queryByTestId("editor-main.go")).not.toBeInTheDocument());
    expect(deleteTerminal).not.toHaveBeenCalled();
    expect(screen.queryByText(/terminal session not found/i)).not.toBeInTheDocument();
  });
});

// The tree lives on the right by default, and its toggle sits at the same
// end of the header — the whole point being that you click an edge and the
// panel comes out of that edge. Placement is a real DOM position, not a
// CSS flip, so it's assertable here.
describe("WorktreeDetail file tree placement", () => {
  it("puts the tree after the terminal area by default (right side)", async () => {
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");

    const body = container.querySelector(".worktree-body")!;
    const kids = [...body.children].map((el) => el.className.split(" ")[0]);
    expect(kids).toEqual(["terminal-area", "file-tree-resizer", "worktree-sidebar"]);
    expect(container.querySelector(".worktree-sidebar")).toHaveClass("right");
  });

  it("puts the tree before the terminal area when the side preference is left", async () => {
    setStoredFilesSide("left");
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");

    const body = container.querySelector(".worktree-body")!;
    const kids = [...body.children].map((el) => el.className.split(" ")[0]);
    expect(kids).toEqual(["worktree-sidebar", "file-tree-resizer", "terminal-area"]);
    expect(container.querySelector(".worktree-sidebar")).not.toHaveClass("right");
  });

  it("moves an already-open panel when the side preference changes", async () => {
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");
    expect(container.querySelector(".worktree-body")!.firstElementChild).toHaveClass("terminal-area");

    act(() => setStoredFilesSide("left"));
    expect(container.querySelector(".worktree-body")!.firstElementChild).toHaveClass("worktree-sidebar");
  });

  it("the header's toggle button hides and shows the tree", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");

    await user.click(screen.getByRole("button", { name: "Hide the file tree" }));
    expect(container.querySelector(".worktree-sidebar")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show the file tree" }));
    expect(container.querySelector(".worktree-sidebar")).toBeInTheDocument();
  });

  it("keeps the toggle at the header's trailing edge, after the PR link", async () => {
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");

    const header = container.querySelector(".worktree-header")!;
    expect(header.lastElementChild).toHaveClass("worktree-header-files-toggle");
  });
});

// The header used to name the branch the registry recorded at creation
// time and fetch its PR exactly once. Both go stale from inside this very
// worktree's shells — a checkout, a `gh pr create` — and the synthetic
// root worktree has no registry row at all, so it had no branch name to
// show in the first place.
describe("WorktreeDetail header branch and PR", () => {
  it("names the branch git reports, not the one the registry recorded", async () => {
    vi.mocked(getWorktreeSummary).mockResolvedValue({
      branch: "switched-to-this-one",
      ahead: 0,
      behind: 0,
      has_upstream: true,
      dirty: false,
      changed_files: [],
      pr: null,
    });
    const { container } = renderPage();
    await waitFor(() =>
      expect(container.querySelector(".worktree-header-branch-name")).toHaveTextContent(
        "switched-to-this-one"
      )
    );
  });

  it("links the PR once one exists for the branch", async () => {
    vi.mocked(getWorktreeSummary).mockResolvedValue({
      branch: "feature",
      ahead: 0,
      behind: 0,
      has_upstream: true,
      dirty: false,
      changed_files: [],
      pr: {
        number: 42,
        title: "Add the thing",
        state: "OPEN",
        url: "https://github.com/o/r/pull/42",
        is_draft: false,
      },
    });
    renderPage();
    const link = await screen.findByTitle("Add the thing");
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/42");
    expect(link).toHaveTextContent("#42");
  });

  it("re-checks the branch and PR when a new shell is opened", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("terminal-t1");
    await waitFor(() => expect(getWorktreeSummary).toHaveBeenCalled());
    // A count, not an exact number: the file tree's own header shares this
    // hook (and its cache), so how many calls the initial render makes is
    // a race between the two, and not what this test is about.
    const before = vi.mocked(getWorktreeSummary).mock.calls.length;

    await user.click(screen.getByTitle("New terminal tab"));
    await waitFor(() =>
      expect(vi.mocked(getWorktreeSummary).mock.calls.length).toBeGreaterThan(before)
    );
  });
});

// The tree is a global panel whose contents change per worktree, so its
// width is one remembered number, not one per worktree. Drag is delta-
// based so the same handler serves both sides: a right-docked panel grows
// as the pointer moves left.
describe("WorktreeDetail file tree resizing", () => {
  function drag(handle: Element, fromX: number, toX: number) {
    // jsdom implements neither PointerEvent nor pointer capture, so
    // MouseEvent stands in (React reads clientX/pointerId off whatever the
    // event object carries) and the capture calls are left to fail — which
    // is itself the assertion that withPointerCapture's guard holds, since
    // an unguarded call would take the whole drag down.
    act(() => {
      handle.dispatchEvent(
        Object.assign(new MouseEvent("pointerdown", { bubbles: true, clientX: fromX }), { pointerId: 1 })
      );
      handle.dispatchEvent(
        Object.assign(new MouseEvent("pointermove", { bubbles: true, clientX: toX }), { pointerId: 1 })
      );
      handle.dispatchEvent(
        Object.assign(new MouseEvent("pointerup", { bubbles: true, clientX: toX }), { pointerId: 1 })
      );
    });
  }

  it("starts at the persisted width", async () => {
    setStoredFilesWidth(320);
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");
    expect(container.querySelector<HTMLElement>(".worktree-sidebar")!.style.width).toBe("320px");
  });

  it("dragging the handle leftwards widens a right-docked panel, and persists on release", async () => {
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");

    drag(container.querySelector(".file-tree-resizer")!, 900, 800);

    const expected = FILES_PANEL_DEFAULT_WIDTH + 100;
    expect(container.querySelector<HTMLElement>(".worktree-sidebar")!.style.width).toBe(`${expected}px`);
    expect(getStoredFilesWidth()).toBe(expected);
  });

  it("dragging the same direction narrows a left-docked panel", async () => {
    setStoredFilesSide("left");
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");

    drag(container.querySelector(".file-tree-resizer")!, 300, 380);

    const expected = FILES_PANEL_DEFAULT_WIDTH + 80;
    expect(container.querySelector<HTMLElement>(".worktree-sidebar")!.style.width).toBe(`${expected}px`);
  });

  it("clamps to the allowed range rather than letting the panel swallow the terminal", async () => {
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");

    drag(container.querySelector(".file-tree-resizer")!, 900, -4000);
    expect(getStoredFilesWidth()).toBe(FILES_PANEL_MAX_WIDTH);
  });

  it("double-clicking the handle resets to the default width", async () => {
    const user = userEvent.setup();
    setStoredFilesWidth(400);
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");

    await user.dblClick(container.querySelector(".file-tree-resizer")!);
    expect(container.querySelector<HTMLElement>(".worktree-sidebar")!.style.width).toBe(
      `${FILES_PANEL_DEFAULT_WIDTH}px`
    );
    expect(getStoredFilesWidth()).toBe(FILES_PANEL_DEFAULT_WIDTH);
  });

  // Keyboard-reachable, like the app sidebar's handle: arrow direction
  // means "which way the pointer would go", so it matches the drag on
  // whichever side the panel is docked.
  it("arrow keys resize it, in the direction the drag would", async () => {
    const { container } = renderPage();
    await screen.findByTestId("terminal-t1");
    const handle = container.querySelector(".file-tree-resizer")!;

    act(() => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(getStoredFilesWidth()).toBe(FILES_PANEL_DEFAULT_WIDTH + 16);

    act(() => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(getStoredFilesWidth()).toBe(FILES_PANEL_DEFAULT_WIDTH);
  });
});
