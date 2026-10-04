import { render, screen, waitFor } from "@testing-library/react";
import { within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorktreeAuditLog from "./WorktreeAuditLog";

vi.mock("./api", () => ({
  getWorktreeAuditLog: vi.fn(),
  getClaudeSessionTitle: vi.fn(),
  listTerminalsForRepo: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

import { getClaudeSessionTitle, getWorktreeAuditLog, listTerminalsForRepo } from "./api";

function renderLog(props: Partial<React.ComponentProps<typeof WorktreeAuditLog>> = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <MemoryRouter>
      <WorktreeAuditLog repoId="r1" worktreeId="w1" title="feature" onClose={onClose} {...props} />
    </MemoryRouter>
  );
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no local transcript found for any session id, so summarize()
  // falls back to the entry's own stored `title` field/bare id — tests
  // that care about the live-fetched title override this per-test.
  vi.mocked(getClaudeSessionTitle).mockResolvedValue(null);
  // Default: nothing currently open anywhere in the repo, so every
  // claude.session.create entry falls back to "Resume" unless a test
  // says otherwise.
  vi.mocked(listTerminalsForRepo).mockResolvedValue([]);
});

describe("WorktreeAuditLog", () => {
  it("renders entries newest-first with friendly labels and a summary", async () => {
    vi.mocked(getWorktreeAuditLog).mockResolvedValue([
      {
        ts: "2026-01-02T00:00:00Z",
        event: "terminal.create",
        worktree_id: "w1",
        tab_label: "Terminal 1",
      },
      {
        ts: "2026-01-01T00:00:00Z",
        event: "worktree.create",
        worktree_id: "w1",
        branch: "feature",
      },
    ]);

    renderLog();

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Terminal opened")).toBeInTheDocument();
    expect(items[0].querySelector(".audit-log-summary")?.textContent).toMatch(/Terminal 1/);
    expect(within(items[1]).getByText("Worktree created")).toBeInTheDocument();
    expect(items[1].querySelector(".audit-log-summary")?.textContent).toMatch(/branch feature/);
    expect(getWorktreeAuditLog).toHaveBeenCalledWith("r1", "w1");
  });

  it("renders agy.session.create event with friendly label and resume button", async () => {
    vi.mocked(getWorktreeAuditLog).mockResolvedValue([
      {
        ts: "2026-01-02T00:00:00Z",
        event: "agy.session.create",
        worktree_id: "w1",
        agy_session_id: "conv-456",
        title: "my agy task",
      },
    ]);

    renderLog();

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByText("agy session started")).toBeInTheDocument();
    expect(items[0].querySelector(".audit-log-summary")?.textContent).toMatch(/my agy task/);
    expect(within(items[0]).getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("renders claude.session.create and archive/unarchive events with friendly labels", async () => {
    vi.mocked(getWorktreeAuditLog).mockResolvedValue([
      {
        ts: "2026-01-03T00:00:00Z",
        event: "worktree.archive",
        worktree_id: "w1",
        branch: "feature",
      },
      {
        ts: "2026-01-02T00:00:00Z",
        event: "claude.session.create",
        worktree_id: "w1",
        claude_session_id: "abc-123",
        title: "feature",
      },
    ]);

    renderLog();

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Worktree archived")).toBeInTheDocument();
    expect(within(items[1]).getByText("Claude session started")).toBeInTheDocument();
    expect(items[1].querySelector(".audit-log-summary")?.textContent).toMatch(/abc-123/);
  });

  it("prefers a live-fetched transcript title over the stored title once it resolves", async () => {
    vi.mocked(getWorktreeAuditLog).mockResolvedValue([
      {
        ts: "2026-01-02T00:00:00Z",
        event: "claude.session.create",
        worktree_id: "w1",
        claude_session_id: "abc-123",
        title: "feature",
      },
    ]);
    vi.mocked(getClaudeSessionTitle).mockResolvedValue("fix the login bug please");

    renderLog();

    const item = (await screen.findAllByRole("listitem"))[0];
    await screen.findByText(/fix the login bug please/);
    expect(item.querySelector(".audit-log-summary")?.textContent).toBe(
      " — fix the login bug please (abc-123)"
    );
    expect(getClaudeSessionTitle).toHaveBeenCalledWith("abc-123");
  });

  it("shows the full injected context text for claude.session.context, not just raw JSON", async () => {
    const context =
      "Ooga. Claude wake up in cave (folder): /tmp/wt\nOoo, worktree-studio cave! Branch-mark say: feature";
    vi.mocked(getWorktreeAuditLog).mockResolvedValue([
      {
        ts: "2026-01-02T00:00:00Z",
        event: "claude.session.context",
        worktree_id: "w1",
        context,
      },
    ]);

    renderLog();

    const item = (await screen.findAllByRole("listitem"))[0];
    expect(within(item).getByText("Context injected into Claude")).toBeInTheDocument();
    const contextBlock = item.querySelector(".audit-log-context");
    expect(contextBlock).not.toBeNull();
    expect(contextBlock?.textContent).toBe(context);
  });

  it("renders worktree.branch_change with the branch it switched to", async () => {
    vi.mocked(getWorktreeAuditLog).mockResolvedValue([
      {
        ts: "2026-01-02T00:00:00Z",
        event: "worktree.branch_change",
        worktree_id: "w1",
        branch: "other-branch",
        prev_head: "aaa",
        new_head: "bbb",
      },
    ]);

    renderLog();

    const item = (await screen.findAllByRole("listitem"))[0];
    expect(within(item).getByText("Branch checked out")).toBeInTheDocument();
    expect(item.querySelector(".audit-log-summary")?.textContent).toMatch(/branch other-branch/);
  });

  it("shows an empty state when there are no events", async () => {
    vi.mocked(getWorktreeAuditLog).mockResolvedValue([]);
    renderLog();
    expect(await screen.findByText(/no events recorded yet/i)).toBeInTheDocument();
  });

  it("shows an error message if the fetch fails", async () => {
    vi.mocked(getWorktreeAuditLog).mockRejectedValue(new Error("boom"));
    renderLog();
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });

  describe("claude session resume/focus action", () => {
    it("offers Resume (not Focus) when the entry has no terminal_id", async () => {
      vi.mocked(getWorktreeAuditLog).mockResolvedValue([
        { ts: "2026-01-02T00:00:00Z", event: "claude.session.create", worktree_id: "w1", claude_session_id: "s1" },
      ]);

      const onClose = renderLog();
      const button = await screen.findByRole("button", { name: "Resume" });
      expect(screen.queryByRole("button", { name: "Focus" })).not.toBeInTheDocument();

      await userEvent.click(button);
      expect(mockNavigate).toHaveBeenCalledWith("/repo/r1/worktree/w1");
      expect(onClose).toHaveBeenCalled();
    });

    it("offers Resume when terminal_id is set but that terminal is no longer live", async () => {
      vi.mocked(getWorktreeAuditLog).mockResolvedValue([
        {
          ts: "2026-01-02T00:00:00Z",
          event: "claude.session.create",
          worktree_id: "w1",
          claude_session_id: "s1",
          terminal_id: "closed-term",
        },
      ]);
      vi.mocked(listTerminalsForRepo).mockResolvedValue([]);

      renderLog();
      expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    });

    it("offers Focus when terminal_id is set and confirmed live, and it deep-links there", async () => {
      vi.mocked(getWorktreeAuditLog).mockResolvedValue([
        {
          ts: "2026-01-02T00:00:00Z",
          event: "claude.session.create",
          worktree_id: "w1",
          claude_session_id: "s1",
          terminal_id: "open-term",
        },
      ]);
      vi.mocked(listTerminalsForRepo).mockResolvedValue([
        {
          id: "open-term",
          worktree_id: "w1",
          tmux_session_name: "wts-open-term",
          tab_label: "claude",
          created_at: "2026-01-02T00:00:00Z",
          worktree_branch: "feature",
          worktree_name: "feature",
        },
      ]);

      const onClose = renderLog();
      const button = await screen.findByRole("button", { name: "Focus" });
      expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();

      await userEvent.click(button);
      expect(mockNavigate).toHaveBeenCalledWith("/repo/r1/worktree/w1?terminal=open-term");
      expect(onClose).toHaveBeenCalled();
    });
  });
});
