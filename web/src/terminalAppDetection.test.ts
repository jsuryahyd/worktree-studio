import { describe, expect, it } from "vitest";
import { detectTerminalApp } from "./terminalAppDetection";

describe("detectTerminalApp", () => {
  it("detects claude from its real observed OSC 0 title", () => {
    // The exact bytes `claude` was confirmed (via a real pty capture) to
    // emit: "\x1b]0;⏳ Claude Code\x07" — xterm.js hands onTitleChange just
    // the text payload, without the OSC wrapper or terminator.
    expect(detectTerminalApp("⏳ Claude Code")).toEqual({ kind: "claude", label: "Claude" });
  });

  it("matches regardless of the leading status glyph", () => {
    expect(detectTerminalApp("✳ Claude Code")).toEqual({ kind: "claude", label: "Claude" });
    expect(detectTerminalApp("Claude Code")).toEqual({ kind: "claude", label: "Claude" });
  });

  it("returns null for a plain shell prompt title", () => {
    expect(detectTerminalApp("user@host: ~/worktree")).toBeNull();
  });

  it("returns null for an empty title", () => {
    expect(detectTerminalApp("")).toBeNull();
  });

  it("does not false-positive on an unrelated title merely containing 'Claude'", () => {
    expect(detectTerminalApp("Claude's notes.txt — vim")).toBeNull();
  });

  // Regression test for a real reported bug: once a claude session has
  // been running a while, it rewrites its title to a short auto-
  // generated task summary that never contains "Claude Code" at all —
  // confirmed by sampling real running sessions on a dev machine, where
  // most had already moved past the idle-default title. Matching only
  // the literal "Claude Code" substring (the original implementation)
  // missed all of these, silently reverting the tab to generic "shell"
  // styling for the majority of real, hours-long usage.
  it("detects claude from a real observed task-summary title with no 'Claude Code' text", () => {
    expect(detectTerminalApp("✳ Add user roles to Sentry exception with nested logging")).toEqual({
      kind: "claude",
      label: "Claude",
    });
    expect(detectTerminalApp("✳ Fix state corruption in RoleProvider and update changesets")).toEqual({
      kind: "claude",
      label: "Claude",
    });
  });

  it("detects claude from a Braille spinner-frame glyph while actively \"thinking\"", () => {
    expect(detectTerminalApp("⠐ Add root worktree view and fix settings defaults")).toEqual({
      kind: "claude",
      label: "Claude",
    });
  });

  it("detects agy from titles containing agy or Antigravity", () => {
    expect(detectTerminalApp("agy")).toEqual({ kind: "agy", label: "agy" });
    expect(detectTerminalApp("AGY session")).toEqual({ kind: "agy", label: "agy" });
    expect(detectTerminalApp("Antigravity Agent")).toEqual({ kind: "agy", label: "agy" });
  });
});
