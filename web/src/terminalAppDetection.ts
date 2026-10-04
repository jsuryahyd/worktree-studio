// Detects a well-known interactive app running inside a terminal pane from
// the window title it sets via an OSC 0/2 escape sequence — xterm.js's
// onTitleChange fires whenever one arrives over the pty stream, the same
// mechanism a real terminal emulator uses to show "vim: file.txt" or
// "ssh: host" in a tab instead of a generic shell label.
//
// `claude` sets its title via OSC 0 to "<status glyph><space><text>" —
// but that trailing text is only the literal "Claude Code" briefly, at
// idle-default. Once a session has been running a while it rewrites the
// title to a short auto-generated summary of its current task instead
// (e.g. "✳ Fix state corruption in RoleProvider and update changesets"),
// which never contains "Claude Code" at all. Matching only that substring
// (the original implementation) was a real, reported bug: sampling every
// actual claude-backed tmux session on a real dev machine, the large
// majority of sessions that had been running for more than a few minutes
// had already rewritten their title to a task summary, so the icon/tab
// styling silently reverted to generic "shell" for most real usage — not
// an edge case. The glyph itself is the durable signal instead: every
// sample observed either "✳" (idle) or a Braille Patterns spinner frame
// (U+2800–U+28FF, actively "thinking") as the leading character,
// regardless of what text follows it — matching on that prefix instead
// of the trailing text is what actually survives a real, hours-long
// session. Kept the literal "Claude Code" check too, in case a future
// claude version's idle-default glyph itself ever changes.
//
// This is deliberately a small registry, not a single hardcoded check:
// the plan is to cover more "persisting" interactive apps the same way
// later (this is where a new entry goes), while WorktreeDetail.tsx keeps
// the actual icon components out of this framework-free module.
export type TerminalAppKind = "claude" | "agy";

interface TerminalAppSignature {
  kind: TerminalAppKind;
  label: string;
  matches: (title: string) => boolean;
}

// U+2733 EIGHT SPOKED ASTERISK (claude's idle-default status glyph) or any
// Braille Patterns codepoint (U+2800–U+28FF, its spinner-frame glyphs) as
// the very first character of the title.
const CLAUDE_STATUS_GLYPH = /^[✳⠀-⣿]/;

const SIGNATURES: TerminalAppSignature[] = [
  {
    kind: "claude",
    label: "Claude",
    matches: (title) => title.includes("Claude Code") || CLAUDE_STATUS_GLYPH.test(title),
  },
  {
    kind: "agy",
    label: "agy",
    matches: (title) =>
      title.includes("agy") || title.includes("Antigravity") || title.includes("AGY"),
  },
];

export interface DetectedTerminalApp {
  kind: TerminalAppKind;
  label: string;
}

export function detectTerminalApp(title: string): DetectedTerminalApp | null {
  const signature = SIGNATURES.find((s) => s.matches(title));
  return signature ? { kind: signature.kind, label: signature.label } : null;
}
