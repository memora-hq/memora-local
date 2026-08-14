# Memora-owned blocking approval dialog (#30)

Part of the cross-agent guardrail/policy layer epic (#32), third sub-issue. This spec covers
only showing one blocking approval dialog for a single already-decided "ask" rule match and
returning the outcome — not calling `evaluateAction` (#28), not combining multiple
`NormalizedAction`s from one tool call into one decision, and not wiring into the hook path
(#31).

## Goal

A function the guardrail hook path can call when a rule's tier is `ask`: show a blocking,
Memora-owned dialog (not the agent's own native prompt UI, per the epic's locked design
decision — Codex's `PreToolUse` hook only honors `deny`, so there's no way to force Codex's
native modal open for an arbitrary rule anyway), wait for the user's answer or a timeout, and
resolve to an outcome the caller can act on.

## Why a native OS dialog, not a bundled GUI app

The guardrail hook must work standalone — a terminal agent (Claude Code or Codex CLI) can
trigger an "ask" decision with no Memora desktop app open or even installed. Three approaches
were considered:

1. **Native OS dialog via `osascript` (macOS) / PowerShell (Windows)** — chosen. No bundling,
   no packaged artifact beyond what ships in the OS, works standalone, and the CLI process can
   synchronously spawn-and-wait for the result. "Memora-owned" here means Memora controls the
   dialog's content (title, message, buttons) — the epic's actual concern was not ceding this
   decision to Claude/Codex's own prompt UI, not achieving pixel-custom chrome.
2. A dedicated minimal Electron dialog process — rejected for v1: a second packaged Electron
   artifact per platform, slower cold start (~1-2s) per prompt, larger build scope.
3. Routing through the existing `apps/desktop` Electron app via IPC — rejected for v1: only
   works when the desktop app happens to be running; a terminal-only user without it open would
   still need approach 1 as a fallback, so the fallback ends up being the only path that matters.

## Public API

New directory `packages/local/src/dialog/`.

```ts
export interface ApprovalRequest {
  category: RuleCategory;
  subject: string;
  reason: string;
}

export type ApprovalOutcome =
  | { approved: true }
  | { approved: false; reason: "denied" | "timeout" | "no_display" };

export function requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
```

`requestApproval` dispatches on `process.platform`: `darwin` → the macOS path, `win32` → the
Windows path, anything else → immediately `{ approved: false, reason: "no_display" }` without
attempting a spawn (this repo already restricts supported platforms to macOS/Windows —
`platformSupport.ts`).

**Timeout:** 60 seconds on both platforms, chosen as long enough for a nearby user to notice
and respond, short enough that an unattended agent isn't blocked indefinitely on one action.

**Fail-safe:** any spawn error, unexpected exit, or unparseable output on either platform
collapses to `{ approved: false, reason: "no_display" }`. There is no separate pre-check for
GUI-session availability (e.g. detecting an SSH session with no WindowServer) — the dialog
attempt itself is the detector, since a no-GUI environment simply fails to run `osascript`/
PowerShell's GUI APIs, which the fail-safe path already catches.

## Module layout

- `escaping.ts` — `escapeAppleScriptString(value: string): string`,
  `escapePowerShellString(value: string): string`. Pure string transforms; this is the
  injection-safety boundary and is fully unit-tested.
- `macDialogScript.ts` — `buildMacDialogScript(request: ApprovalRequest, timeoutSeconds:
  number): string` and `parseMacDialogOutput(stdout: string): ApprovalOutcome`. Pure, fully
  unit-tested.
- `windowsDialogScript.ts` — `buildWindowsDialogScript(request: ApprovalRequest, timeoutMs:
  number): string` and `parseWindowsDialogExitCode(code: number): ApprovalOutcome`. Pure, fully
  unit-tested.
- `macDialog.ts` — `showMacDialog(request): Promise<ApprovalOutcome>`, a thin
  `spawn("osascript", ["-e", buildMacDialogScript(...)])` wrapper around the pure pieces above.
- `windowsDialog.ts` — `showWindowsDialog(request): Promise<ApprovalOutcome>`, the PowerShell
  equivalent.
- `approvalDialog.ts` — `requestApproval`, the public platform dispatcher.

`macDialog.ts`/`windowsDialog.ts`/`approvalDialog.ts`'s actual spawn calls are **not**
unit-tested directly — this matches the existing convention in this repo, where
`openUrlInBrowser` (`publishAuth.ts`) is a similarly untested best-effort OS-boundary spawn.
All the decision logic (escaping, script construction, output parsing) lives in the pure,
tested modules; the spawn wrappers are thin glue.

## Mechanism detail — verified during design

**macOS**, live-tested via a direct `osascript` invocation:

```
osascript -e 'display dialog "<escaped message>" with title "Memora Guardrail"
  buttons {"Deny", "Allow"} default button "Deny" giving up after 60'
```

Invoked as `spawn("osascript", ["-e", script])` — array form, never a shell string, so shell
metacharacters inside an agent-controlled subject (confirmed live with a message containing
`` `id` ``, `$(whoami)`, semicolons, and backslashes) have no effect; `osascript` never passes
through `/bin/sh`. Only `\` and `"` need escaping for AppleScript string-literal correctness
(`escapeAppleScriptString`: `\` → `\\`, then `"` → `\"`); embedded newlines are also replaced
with a space, since a raw newline inside an AppleScript string literal in `-e` source text is
unreliable to rely on.

Confirmed live: on timeout, the process exits 0 with stdout `button returned:, gave up:true` —
the button-returned field is **empty**, not the default button's name, when the dialog times
out. `parseMacDialogOutput` therefore checks for `gave up:true` first, then falls back to
matching `button returned:Allow` / `button returned:Deny`; anything else (unexpected format,
empty output, a nonzero exit) is `no_display`.

**Windows** (built from the documented `MessageBoxTimeoutW` convention — **not live-verified,
no Windows machine available during design**; flagged honestly rather than claimed as tested):
WinForms' `MessageBox` has no timeout parameter, so this uses PowerShell to P/Invoke the
undocumented-but-widely-used `user32.dll` `MessageBoxTimeoutW` via `Add-Type`, then maps its
return code: `6` (IDYES) → approved, `7` (IDNO) → denied, `32000` (IDTIMEOUT) → timeout,
anything else → `no_display`. Invoked as `spawn("powershell", ["-NoProfile", "-NonInteractive",
"-Command", script])`. `escapePowerShellString` escapes single quotes (`'` → `''`) for the
PowerShell string literals the script embeds the message/title into.

## Testing

- `escaping.test.ts`: both escape functions against quotes, backslashes, newlines, and
  shell/AppleScript/PowerShell metacharacters (semicolons, `$()`, backticks, `` ` ``) —
  asserting the *escaped* value round-trips safely, not that metacharacters are stripped (they
  aren't; they're inert once embedded in a properly quoted literal, which is the actual safety
  property this feature depends on).
- `macDialogScript.test.ts`: `buildMacDialogScript` produces a script containing the escaped
  message, title, and `giving up after <n>`; `parseMacDialogOutput` against the real captured
  outputs (`"button returned:Allow, gave up:false\n"`, `"button returned:Deny, gave up:false\n"`,
  `"button returned:, gave up:true\n"`, empty string, garbage text).
- `windowsDialogScript.test.ts`: `buildWindowsDialogScript` produces a script containing the
  escaped message/title and the timeout value; `parseWindowsDialogExitCode` against `6`, `7`,
  `32000`, and an arbitrary unexpected code.
- No test for the spawn wrappers or `requestApproval`'s platform dispatch beyond confirming an
  unsupported `process.platform` value short-circuits to `no_display` without touching
  `child_process` (achievable by asserting the promise resolves quickly with that platform
  value, without needing to mock `spawn`).

## Out of scope (future issues)

- Calling `evaluateAction` (#28) to decide a rule matched `ask` in the first place.
- Combining multiple `NormalizedAction`s from one raw tool call (#29) — e.g. a `Bash` command
  that's both `shell_exec` and `git_push` — into a single decision or a single dialog. That
  composition logic, and everything about wiring this into the actual hook path, is #31.
- Any richer dialog content than category/subject/reason (e.g. showing the full command output,
  a "remember this choice" option) — not part of the epic's locked v1 scope.
