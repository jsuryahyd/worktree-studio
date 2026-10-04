import { afterEach, describe, expect, it, vi } from "vitest";
import { registerActiveWorktreeActions } from "./activeWorktreeActions";
import { takePendingNewTerminal } from "./pendingNewTerminal";
import { focusTerminalTab, openShell, openShellWithAgy, openShellWithAgyResume, openShellWithClaude, openShellWithClaudeResume } from "./worktreeShellActions";

afterEach(() => {
  registerActiveWorktreeActions(null);
});

describe("openShell/openShellWithClaude/openShellWithAgy", () => {
  it("acts directly through the active bridge when the target worktree is already mounted", () => {
    const newTerminal = vi.fn();
    registerActiveWorktreeActions({
      worktreeId: "w1",
      vscodeAvailable: false,
      openVSCode: vi.fn(),
      openLog: vi.fn(),
      newTerminal,
      splitRight: vi.fn(),
      splitDown: vi.fn(),
      focusTerminal: vi.fn(() => true),
    });
    const navigate = vi.fn();

    openShell(navigate, "r1", "w1");
    expect(newTerminal).toHaveBeenCalledWith(undefined, undefined);
    expect(navigate).not.toHaveBeenCalled();

    openShellWithClaude(navigate, "r1", "w1");
    expect(newTerminal).toHaveBeenCalledWith("claude", "claude");
    expect(navigate).not.toHaveBeenCalled();

    openShellWithAgy(navigate, "r1", "w1");
    expect(newTerminal).toHaveBeenCalledWith("agy", "agy");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates and leaves a pending instruction when the target worktree isn't mounted", () => {
    const navigate = vi.fn();
    openShell(navigate, "r1", "w2");
    expect(navigate).toHaveBeenCalledWith("/repo/r1/worktree/w2");
    expect(takePendingNewTerminal("w2")).toEqual({});
  });

  it("navigates and leaves a claude-tagged pending instruction for openShellWithClaude when not mounted", () => {
    const navigate = vi.fn();
    openShellWithClaude(navigate, "r1", "w3");
    expect(navigate).toHaveBeenCalledWith("/repo/r1/worktree/w3");
    expect(takePendingNewTerminal("w3")).toEqual({ tabLabel: "claude", initialCommand: "claude" });
  });

  it("navigates and leaves an agy-tagged pending instruction for openShellWithAgy when not mounted", () => {
    const navigate = vi.fn();
    openShellWithAgy(navigate, "r1", "w3");
    expect(navigate).toHaveBeenCalledWith("/repo/r1/worktree/w3");
    expect(takePendingNewTerminal("w3")).toEqual({ tabLabel: "agy", initialCommand: "agy" });
  });

  it("only ever acts on the bridge when the worktree id actually matches", () => {
    const newTerminal = vi.fn();
    registerActiveWorktreeActions({
      worktreeId: "some-other-worktree",
      vscodeAvailable: false,
      openVSCode: vi.fn(),
      openLog: vi.fn(),
      newTerminal,
      splitRight: vi.fn(),
      splitDown: vi.fn(),
      focusTerminal: vi.fn(() => true),
    });
    const navigate = vi.fn();

    openShell(navigate, "r1", "w4");
    expect(newTerminal).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/repo/r1/worktree/w4");
  });
});

describe("openShellWithAgyResume", () => {
  it("builds an agy --conversation <id> command", () => {
    const navigate = vi.fn();
    openShellWithAgyResume(navigate, "r1", "w5", "session-abc-123");
    expect(navigate).toHaveBeenCalledWith("/repo/r1/worktree/w5");
    expect(takePendingNewTerminal("w5")).toEqual({
      tabLabel: "agy (resumed)",
      initialCommand: "agy --conversation session-abc-123",
    });
  });
});

describe("openShellWithClaudeResume", () => {
  it("builds a claude --resume <id> command", () => {
    const navigate = vi.fn();
    openShellWithClaudeResume(navigate, "r1", "w5", "session-abc-123");
    expect(navigate).toHaveBeenCalledWith("/repo/r1/worktree/w5");
    expect(takePendingNewTerminal("w5")).toEqual({
      tabLabel: "claude (resumed)",
      initialCommand: "claude --resume session-abc-123",
    });
  });

  it("routes through the active bridge when already mounted, same as the other open* actions", () => {
    const newTerminal = vi.fn();
    registerActiveWorktreeActions({
      worktreeId: "w6",
      vscodeAvailable: false,
      openVSCode: vi.fn(),
      openLog: vi.fn(),
      newTerminal,
      splitRight: vi.fn(),
      splitDown: vi.fn(),
      focusTerminal: vi.fn(() => true),
    });
    const navigate = vi.fn();
    openShellWithClaudeResume(navigate, "r1", "w6", "abc-123");
    expect(newTerminal).toHaveBeenCalledWith("claude (resumed)", "claude --resume abc-123");
    expect(navigate).not.toHaveBeenCalled();
  });

  // Regression test: sessionId ultimately traces back to an audit-log
  // entry, and initialCommand is typed literally into a live shell (tmux
  // send-keys, not a safe exec argv) — a malformed id must never be
  // allowed to become shell input.
  it("refuses a malformed session id rather than build a shell command out of it", () => {
    const navigate = vi.fn();
    openShellWithClaudeResume(navigate, "r1", "w7", "abc; rm -rf ~");
    expect(navigate).not.toHaveBeenCalled();
    expect(takePendingNewTerminal("w7")).toBeNull();
  });
});

describe("focusTerminalTab", () => {
  it("calls the active bridge's focusTerminal directly when the target worktree is already mounted", () => {
    const focusTerminal = vi.fn(() => true);
    registerActiveWorktreeActions({
      worktreeId: "w8",
      vscodeAvailable: false,
      openVSCode: vi.fn(),
      openLog: vi.fn(),
      newTerminal: vi.fn(),
      splitRight: vi.fn(),
      splitDown: vi.fn(),
      focusTerminal,
    });
    const navigate = vi.fn();
    focusTerminalTab(navigate, "r1", "w8", "term-1");
    expect(focusTerminal).toHaveBeenCalledWith("term-1");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates with a ?terminal= deep link when the target worktree isn't mounted", () => {
    const navigate = vi.fn();
    focusTerminalTab(navigate, "r1", "w9", "term-2");
    expect(navigate).toHaveBeenCalledWith("/repo/r1/worktree/w9?terminal=term-2");
  });
});
