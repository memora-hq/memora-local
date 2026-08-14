# Memora-Owned Blocking Approval Dialog (#30) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `requestApproval`, a function the guardrail hook path can call for an "ask"-tier
rule match: shows a blocking native OS dialog (macOS via `osascript`, Windows via PowerShell),
waits up to 60s, and resolves to an approved/denied/timeout/no_display outcome.

**Architecture:** `packages/local/src/dialog/` with a strict pure/impure split: escaping,
script-building, and output-parsing are pure functions with full unit coverage; the actual
`child_process.spawn` calls are thin, untested wrappers (matching this repo's existing
`openUrlInBrowser` convention). `approvalDialog.ts` dispatches on `process.platform`.

**Tech Stack:** TypeScript, Node `child_process.spawn`, Vitest. No new dependencies.

## Global Constraints

- Public API: `requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome>` where
  `ApprovalRequest = { category: RuleCategory; subject: string; reason: string }` and
  `ApprovalOutcome = { approved: true } | { approved: false; reason: "denied" | "timeout" |
  "no_display" }`.
- 60 second timeout on both platforms.
- Any spawn error, unexpected exit code, or unparseable output collapses to `{ approved: false,
  reason: "no_display" }` — no separate GUI-session pre-check.
- `process.platform` outside `darwin`/`win32` resolves immediately to `{ approved: false,
  reason: "no_display" }` without spawning anything.
- All OS-boundary spawn calls use array-form `spawn(cmd, [...args])`, never a shell string —
  this is the injection-safety property the design depends on.
- Spawn wrapper files (`macDialog.ts`, `windowsDialog.ts`, the dispatch in `approvalDialog.ts`)
  are not unit-tested directly, matching the existing `openUrlInBrowser` convention in
  `publishAuth.ts`. All decision logic lives in the pure, tested modules.

---

## File Structure

- Create: `packages/local/src/dialog/escaping.ts`
- Create: `packages/local/src/dialog/escaping.test.ts`
- Create: `packages/local/src/dialog/macDialogScript.ts`
- Create: `packages/local/src/dialog/macDialogScript.test.ts`
- Create: `packages/local/src/dialog/windowsDialogScript.ts`
- Create: `packages/local/src/dialog/windowsDialogScript.test.ts`
- Create: `packages/local/src/dialog/macDialog.ts`
- Create: `packages/local/src/dialog/windowsDialog.ts`
- Create: `packages/local/src/dialog/approvalDialog.ts`
- Create: `packages/local/src/dialog/approvalDialog.test.ts`
- Modify: `packages/local/src/index.ts` — add dialog module exports.

---

## Task 1: String escaping

**Files:**
- Create: `packages/local/src/dialog/escaping.ts`
- Test: `packages/local/src/dialog/escaping.test.ts`

**Interfaces:**
- Produces: `escapeAppleScriptString(value: string): string`,
  `escapePowerShellString(value: string): string` — consumed by `macDialogScript.ts` (Task 2)
  and `windowsDialogScript.ts` (Task 3).

`escapeAppleScriptString` escapes backslashes then double quotes (order matters — escaping `"`
first would double-escape the backslashes just inserted), then replaces any `\n`/`\r` with a
single space (a raw newline inside an AppleScript string literal embedded in `-e` source text
is unreliable). `escapePowerShellString` escapes single quotes by doubling them (`'` → `''`),
the standard PowerShell single-quoted-string escape.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/local/src/dialog/escaping.test.ts
import { describe, expect, it } from "vitest";
import { escapeAppleScriptString, escapePowerShellString } from "./escaping.js";

describe("escapeAppleScriptString", () => {
  it("escapes double quotes", () => {
    expect(escapeAppleScriptString('say "hi"')).toBe('say \\"hi\\"');
  });

  it("escapes backslashes before quotes so escaping isn't doubled", () => {
    expect(escapeAppleScriptString('a\\"b')).toBe('a\\\\\\"b');
  });

  it("replaces newlines and carriage returns with a space", () => {
    expect(escapeAppleScriptString("line1\nline2\r\nline3")).toBe("line1 line2 line3");
  });

  it("leaves shell metacharacters untouched (they are inert once embedded in the AppleScript literal)", () => {
    const input = "rm -rf ~; $(whoami) `id`";
    expect(escapeAppleScriptString(input)).toBe(input);
  });

  it("is a no-op for a plain string", () => {
    expect(escapeAppleScriptString("/repo/src/a.ts")).toBe("/repo/src/a.ts");
  });
});

describe("escapePowerShellString", () => {
  it("doubles single quotes", () => {
    expect(escapePowerShellString("it's a test")).toBe("it''s a test");
  });

  it("doubles multiple single quotes", () => {
    expect(escapePowerShellString("'a' and 'b'")).toBe("''a'' and ''b''");
  });

  it("leaves shell metacharacters untouched", () => {
    const input = "rm -rf ~; $(whoami) `id`";
    expect(escapePowerShellString(input)).toBe(input);
  });

  it("is a no-op for a plain string", () => {
    expect(escapePowerShellString("C:\\repo\\src\\a.ts")).toBe("C:\\repo\\src\\a.ts");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/dialog/escaping.test.ts`
Expected: FAIL — `Cannot find module './escaping.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/local/src/dialog/escaping.ts
export function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, " ");
}

export function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/dialog/escaping.test.ts`
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/dialog/escaping.ts packages/local/src/dialog/escaping.test.ts
git commit -m "Add AppleScript/PowerShell string escaping for the guardrail approval dialog"
```

---

## Task 2: macOS dialog script builder + output parser

**Files:**
- Create: `packages/local/src/dialog/macDialogScript.ts`
- Test: `packages/local/src/dialog/macDialogScript.test.ts`

**Interfaces:**
- Consumes: `escapeAppleScriptString` from `./escaping.js`; `RuleCategory` from
  `../rules/schema.js` (for the `ApprovalRequest` type).
- Produces: `ApprovalRequest`, `ApprovalOutcome` types (the shared public types — also reused by
  Task 3 and Task 4); `buildMacDialogScript(request: ApprovalRequest, timeoutSeconds: number):
  string`; `parseMacDialogOutput(stdout: string): ApprovalOutcome`. Consumed by `macDialog.ts`
  (Task 4).

The `ApprovalRequest`/`ApprovalOutcome` types are defined here (not in a separate types file)
since this is the first task that needs them; Task 3 imports them from here.

`parseMacDialogOutput` checks for `gave up:true` first (timeout — the button-returned field is
empty on timeout, confirmed by live-testing `osascript` during design), then falls back to
matching `button returned:Allow` / `button returned:Deny`; anything else is `no_display`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/local/src/dialog/macDialogScript.test.ts
import { describe, expect, it } from "vitest";
import { buildMacDialogScript, parseMacDialogOutput } from "./macDialogScript.js";

describe("buildMacDialogScript", () => {
  it("embeds the escaped subject and reason in the dialog message", () => {
    const script = buildMacDialogScript(
      { category: "file_write", subject: "/repo/a.ts", reason: 'blocked "write"' },
      60,
    );
    expect(script).toContain("/repo/a.ts");
    expect(script).toContain('blocked \\"write\\"');
  });

  it("includes the Memora title and Deny/Allow buttons", () => {
    const script = buildMacDialogScript({ category: "shell_exec", subject: "ls", reason: "x" }, 60);
    expect(script).toContain('with title "Memora Guardrail"');
    expect(script).toContain('buttons {"Deny", "Allow"}');
    expect(script).toContain('default button "Deny"');
  });

  it("includes the timeout as giving up after <n>", () => {
    const script = buildMacDialogScript({ category: "shell_exec", subject: "ls", reason: "x" }, 42);
    expect(script).toContain("giving up after 42");
  });
});

describe("parseMacDialogOutput", () => {
  it("returns approved for button returned:Allow", () => {
    expect(parseMacDialogOutput("button returned:Allow, gave up:false\n")).toEqual({ approved: true });
  });

  it("returns denied for button returned:Deny", () => {
    expect(parseMacDialogOutput("button returned:Deny, gave up:false\n")).toEqual({
      approved: false,
      reason: "denied",
    });
  });

  it("returns timeout when gave up:true, even though button returned is empty", () => {
    expect(parseMacDialogOutput("button returned:, gave up:true\n")).toEqual({
      approved: false,
      reason: "timeout",
    });
  });

  it("returns no_display for empty output", () => {
    expect(parseMacDialogOutput("")).toEqual({ approved: false, reason: "no_display" });
  });

  it("returns no_display for unrecognized output", () => {
    expect(parseMacDialogOutput("some unexpected error text")).toEqual({ approved: false, reason: "no_display" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/dialog/macDialogScript.test.ts`
Expected: FAIL — `Cannot find module './macDialogScript.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/local/src/dialog/macDialogScript.ts
import { escapeAppleScriptString } from "./escaping.js";
import type { RuleCategory } from "../rules/schema.js";

export interface ApprovalRequest {
  category: RuleCategory;
  subject: string;
  reason: string;
}

export type ApprovalOutcome =
  | { approved: true }
  | { approved: false; reason: "denied" | "timeout" | "no_display" };

function dialogMessage(request: ApprovalRequest): string {
  return `Memora blocked a ${request.category} action.\n\nSubject: ${request.subject}\nReason: ${request.reason}`;
}

export function buildMacDialogScript(request: ApprovalRequest, timeoutSeconds: number): string {
  const message = escapeAppleScriptString(dialogMessage(request));
  return `display dialog "${message}" with title "Memora Guardrail" buttons {"Deny", "Allow"} default button "Deny" giving up after ${timeoutSeconds}`;
}

export function parseMacDialogOutput(stdout: string): ApprovalOutcome {
  if (stdout.includes("gave up:true")) return { approved: false, reason: "timeout" };
  if (stdout.includes("button returned:Allow")) return { approved: true };
  if (stdout.includes("button returned:Deny")) return { approved: false, reason: "denied" };
  return { approved: false, reason: "no_display" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/dialog/macDialogScript.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/dialog/macDialogScript.ts packages/local/src/dialog/macDialogScript.test.ts
git commit -m "Add macOS approval dialog script builder and output parser"
```

---

## Task 3: Windows dialog script builder + exit-code parser

**Files:**
- Create: `packages/local/src/dialog/windowsDialogScript.ts`
- Test: `packages/local/src/dialog/windowsDialogScript.test.ts`

**Interfaces:**
- Consumes: `escapePowerShellString` from `./escaping.js`; `ApprovalRequest`, `ApprovalOutcome`
  from `./macDialogScript.js`.
- Produces: `buildWindowsDialogScript(request: ApprovalRequest, timeoutMs: number): string`;
  `parseWindowsDialogExitCode(code: number): ApprovalOutcome`. Consumed by `windowsDialog.ts`
  (Task 4).

Uses PowerShell to P/Invoke `user32.dll`'s `MessageBoxTimeoutW` (WinForms' `MessageBox` has no
timeout parameter), since Windows' well-known return codes are `IDYES=6`, `IDNO=7`,
`IDTIMEOUT=32000`. This mechanism is **not live-verified** (no Windows machine available during
design) — built from the documented P/Invoke convention.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/local/src/dialog/windowsDialogScript.test.ts
import { describe, expect, it } from "vitest";
import { buildWindowsDialogScript, parseWindowsDialogExitCode } from "./windowsDialogScript.js";

describe("buildWindowsDialogScript", () => {
  it("embeds the escaped subject and reason in the dialog message", () => {
    const script = buildWindowsDialogScript(
      { category: "file_write", subject: "C:\\repo\\a.ts", reason: "it's blocked" },
      60000,
    );
    expect(script).toContain("C:\\repo\\a.ts");
    expect(script).toContain("it''s blocked");
  });

  it("includes the Memora title", () => {
    const script = buildWindowsDialogScript({ category: "shell_exec", subject: "dir", reason: "x" }, 60000);
    expect(script).toContain("Memora Guardrail");
  });

  it("includes the timeout in milliseconds", () => {
    const script = buildWindowsDialogScript({ category: "shell_exec", subject: "dir", reason: "x" }, 12345);
    expect(script).toContain("12345");
  });

  it("references MessageBoxTimeout", () => {
    const script = buildWindowsDialogScript({ category: "shell_exec", subject: "dir", reason: "x" }, 60000);
    expect(script).toContain("MessageBoxTimeout");
  });
});

describe("parseWindowsDialogExitCode", () => {
  it("returns approved for IDYES (6)", () => {
    expect(parseWindowsDialogExitCode(6)).toEqual({ approved: true });
  });

  it("returns denied for IDNO (7)", () => {
    expect(parseWindowsDialogExitCode(7)).toEqual({ approved: false, reason: "denied" });
  });

  it("returns timeout for IDTIMEOUT (32000)", () => {
    expect(parseWindowsDialogExitCode(32000)).toEqual({ approved: false, reason: "timeout" });
  });

  it("returns no_display for an unexpected code", () => {
    expect(parseWindowsDialogExitCode(1)).toEqual({ approved: false, reason: "no_display" });
    expect(parseWindowsDialogExitCode(-1)).toEqual({ approved: false, reason: "no_display" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/dialog/windowsDialogScript.test.ts`
Expected: FAIL — `Cannot find module './windowsDialogScript.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/local/src/dialog/windowsDialogScript.ts
import { escapePowerShellString } from "./escaping.js";
import type { ApprovalOutcome, ApprovalRequest } from "./macDialogScript.js";

const IDYES = 6;
const IDNO = 7;
const IDTIMEOUT = 32000;
// MB_YESNO (0x4) | MB_ICONWARNING (0x30) | MB_SYSTEMMODAL (0x1000)
const MESSAGEBOX_STYLE = 0x00001034;

function dialogMessage(request: ApprovalRequest): string {
  return `Memora blocked a ${request.category} action.\n\nSubject: ${request.subject}\nReason: ${request.reason}`;
}

export function buildWindowsDialogScript(request: ApprovalRequest, timeoutMs: number): string {
  const message = escapePowerShellString(dialogMessage(request));
  const title = escapePowerShellString("Memora Guardrail");
  return [
    "Add-Type -TypeDefinition '",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class MemoraGuardrailDialog {",
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)]',
    "  public static extern int MessageBoxTimeout(IntPtr hWnd, string text, string caption, uint options, short languageId, int milliseconds);",
    "}';",
    `[MemoraGuardrailDialog]::MessageBoxTimeout([IntPtr]::Zero, '${message}', '${title}', ${MESSAGEBOX_STYLE}, 0, ${timeoutMs})`,
    "exit $LASTEXITCODE",
  ].join("\n");
}

export function parseWindowsDialogExitCode(code: number): ApprovalOutcome {
  if (code === IDYES) return { approved: true };
  if (code === IDNO) return { approved: false, reason: "denied" };
  if (code === IDTIMEOUT) return { approved: false, reason: "timeout" };
  return { approved: false, reason: "no_display" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/dialog/windowsDialogScript.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/dialog/windowsDialogScript.ts packages/local/src/dialog/windowsDialogScript.test.ts
git commit -m "Add Windows approval dialog script builder and exit-code parser"
```

---

## Task 4: Spawn wrappers, platform dispatcher, and exports

**Files:**
- Create: `packages/local/src/dialog/macDialog.ts`
- Create: `packages/local/src/dialog/windowsDialog.ts`
- Create: `packages/local/src/dialog/approvalDialog.ts`
- Test: `packages/local/src/dialog/approvalDialog.test.ts`
- Modify: `packages/local/src/index.ts`

**Interfaces:**
- Consumes: `buildMacDialogScript`, `parseMacDialogOutput`, `ApprovalRequest`, `ApprovalOutcome`
  from `./macDialogScript.js`; `buildWindowsDialogScript`, `parseWindowsDialogExitCode` from
  `./windowsDialogScript.js`.
- Produces: `showMacDialog(request): Promise<ApprovalOutcome>`,
  `showWindowsDialog(request): Promise<ApprovalOutcome>`,
  `requestApproval(request): Promise<ApprovalOutcome>` — the full public surface of this issue,
  consumed later by #31.

Per the Global Constraints, `macDialog.ts`/`windowsDialog.ts` and the spawn-dispatch branches of
`approvalDialog.ts` are not unit-tested directly. `approvalDialog.test.ts` covers only the one
branch that doesn't spawn anything: an unsupported platform short-circuits immediately.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/local/src/dialog/approvalDialog.test.ts
import { describe, expect, it } from "vitest";
import { requestApproval } from "./approvalDialog.js";

describe("requestApproval", () => {
  it("resolves to no_display on an unsupported platform without spawning anything", async () => {
    const outcome = await requestApproval(
      { category: "shell_exec", subject: "ls", reason: "test" },
      "linux" as NodeJS.Platform,
    );
    expect(outcome).toEqual({ approved: false, reason: "no_display" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/dialog/approvalDialog.test.ts`
Expected: FAIL — `Cannot find module './approvalDialog.js'`.

- [ ] **Step 3: Write the spawn wrappers**

```typescript
// packages/local/src/dialog/macDialog.ts
import { spawn } from "node:child_process";
import { buildMacDialogScript, parseMacDialogOutput, type ApprovalOutcome, type ApprovalRequest } from "./macDialogScript.js";

const TIMEOUT_SECONDS = 60;

export function showMacDialog(request: ApprovalRequest): Promise<ApprovalOutcome> {
  return new Promise((resolvePromise) => {
    const script = buildMacDialogScript(request, TIMEOUT_SECONDS);
    let stdout = "";
    try {
      const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.on("error", () => resolvePromise({ approved: false, reason: "no_display" }));
      child.on("close", () => resolvePromise(parseMacDialogOutput(stdout)));
    } catch {
      resolvePromise({ approved: false, reason: "no_display" });
    }
  });
}
```

```typescript
// packages/local/src/dialog/windowsDialog.ts
import { spawn } from "node:child_process";
import {
  buildWindowsDialogScript,
  parseWindowsDialogExitCode,
  type ApprovalOutcome,
  type ApprovalRequest,
} from "./windowsDialogScript.js";

const TIMEOUT_MS = 60_000;

export function showWindowsDialog(request: ApprovalRequest): Promise<ApprovalOutcome> {
  return new Promise((resolvePromise) => {
    const script = buildWindowsDialogScript(request, TIMEOUT_MS);
    try {
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", () => resolvePromise({ approved: false, reason: "no_display" }));
      child.on("close", (code) => resolvePromise(parseWindowsDialogExitCode(code ?? -1)));
    } catch {
      resolvePromise({ approved: false, reason: "no_display" });
    }
  });
}
```

- [ ] **Step 4: Write the dispatcher**

```typescript
// packages/local/src/dialog/approvalDialog.ts
import { showMacDialog } from "./macDialog.js";
import { showWindowsDialog } from "./windowsDialog.js";
import type { ApprovalOutcome, ApprovalRequest } from "./macDialogScript.js";

export type { ApprovalOutcome, ApprovalRequest } from "./macDialogScript.js";

export function requestApproval(
  request: ApprovalRequest,
  platform: NodeJS.Platform = process.platform,
): Promise<ApprovalOutcome> {
  if (platform === "darwin") return showMacDialog(request);
  if (platform === "win32") return showWindowsDialog(request);
  return Promise.resolve({ approved: false, reason: "no_display" });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/dialog/approvalDialog.test.ts`
Expected: PASS, 1 test green.

- [ ] **Step 6: Add package-level exports**

Edit `packages/local/src/index.ts`, append after the existing `export * from
"./rules/normalize.js";` line:

```typescript
export * from "./dialog/macDialogScript.js";
export * from "./dialog/windowsDialogScript.js";
export * from "./dialog/approvalDialog.js";
```

Note: `escaping.ts`'s functions are internal implementation detail (consumed only by the two
script builders) and are not re-exported at the package level — only the public
request/outcome types and `requestApproval` need to be visible to consumers like the future
#31.

- [ ] **Step 7: Build and run the full package test suite**

Run: `pnpm --filter @memora-hq/memora-local run build && pnpm --filter @memora-hq/memora-local run test`
Expected: build `Done`; all test files pass, including the four new `src/dialog/*.test.ts`
files alongside the existing 22 test files (26 total), 0 failures.

- [ ] **Step 8: Commit**

```bash
git add packages/local/src/dialog/macDialog.ts packages/local/src/dialog/windowsDialog.ts packages/local/src/dialog/approvalDialog.ts packages/local/src/dialog/approvalDialog.test.ts packages/local/src/index.ts
git commit -m "Add guardrail approval dialog platform dispatcher and exports"
```

---

## Final Verification

- [ ] Run the full monorepo test suite for the two affected packages:

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run test`
Expected: all test files pass, no regressions in pre-existing tests.

- [ ] Run the build:

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run build`
Expected: `Done` for both packages.

- [ ] Manually sanity-check the macOS dialog actually appears (this repo's development machine
  is macOS, so this is a real, not hypothetical, check — the Windows path cannot be manually
  verified here and remains flagged as unverified in the spec and issue-close comment):

Run (packages/local is an ESM package, so use dynamic import, not require):
```bash
node --input-type=module -e "
import { requestApproval } from './packages/local/dist/dialog/approvalDialog.js';
requestApproval({ category: 'shell_exec', subject: 'rm -rf ~', reason: 'manual smoke test' })
  .then((outcome) => console.log(JSON.stringify(outcome)));
"
```
Expected: a native macOS dialog box appears titled "Memora Guardrail" with Deny/Allow buttons
and the subject/reason text; clicking either button (or waiting 60s) prints the matching
outcome to stdout.

- [ ] Close out the issue:

```bash
gh issue close 30 --comment "Blocking approval dialog implemented in packages/local/src/dialog/ (escaping.ts, macDialogScript.ts, windowsDialogScript.ts, macDialog.ts, windowsDialog.ts, approvalDialog.ts), exported from @memora-hq/memora-local. Native OS dialogs (osascript on macOS, PowerShell MessageBoxTimeoutW on Windows), 60s timeout, fail-safe to no_display on any error. macOS path live-verified during design and manually smoke-tested; Windows path is built from the documented MessageBoxTimeoutW convention but is NOT live-verified (no Windows machine available) - flagging this for whoever picks up Windows QA. See docs/superpowers/specs/2026-08-14-guardrail-approval-dialog-design.md for the design. Does not call evaluateAction, does not combine multiple normalized actions into one decision, and does not wire into the hook path (#31) - separate issue."
```
