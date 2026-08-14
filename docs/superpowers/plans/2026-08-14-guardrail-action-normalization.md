# Per-Adapter Action Normalization (#29) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `normalizeToolCall`, a pure function that turns a raw Claude Code / Codex CLI
`PreToolUse` hook payload into zero or more `NormalizedAction`s (#28's schema), so a later
issue (#31) can run each through #28's `evaluateAction`.

**Architecture:** Two new files in `packages/local/src/rules/`: `patchParser.ts` (extracts file
paths from a Codex `apply_patch` diff blob — standalone, independently testable) and
`normalize.ts` (the `tool_name → category/subject` lookup table, consuming `patchParser.ts` for
the `apply_patch` case). Both re-exported from `packages/local/src/index.ts`.

**Tech Stack:** TypeScript, Node `path.resolve`, Vitest. No new dependencies.

## Global Constraints

- One flat lookup table, not per-provider branching — Claude and Codex tool names never
  collide (Codex only emits `Bash`, `apply_patch`, `mcp__*`; Claude never emits `apply_patch`).
- `normalizeToolCall` never throws. Malformed/unrecognized input returns `[]`.
- A `Bash` command matching `/\bgit\s+push\b/` produces **both** a `shell_exec` action and a
  `git_push` action (same subject) — not just the more specific one.
- An `apply_patch` call producing N files produces N separate `file_write` actions, one per
  file, not one action for the whole patch.
- Every file-path subject is resolved to absolute via `path.resolve(cwd, subject)` before being
  returned; `cwd` comes from `call.cwd`, falling back to `process.cwd()` when absent. `url` and
  `command` subjects (`WebFetch`, `Bash`, `git_push`) are never resolved as paths.
- Tool names not in the lookup table (`WebSearch`, `mcp__*`, `Task`, `TodoWrite`, anything
  unrecognized) normalize to `[]` in v1.

---

## File Structure

- Create: `packages/local/src/rules/patchParser.ts` — `parsePatchFilePaths`.
- Create: `packages/local/src/rules/patchParser.test.ts`
- Create: `packages/local/src/rules/normalize.ts` — `RawToolCall`, `normalizeToolCall`.
- Create: `packages/local/src/rules/normalize.test.ts`
- Modify: `packages/local/src/index.ts` — add two export lines.

---

## Task 1: apply_patch file-path parser

**Files:**
- Create: `packages/local/src/rules/patchParser.ts`
- Test: `packages/local/src/rules/patchParser.test.ts`

**Interfaces:**
- Produces: `parsePatchFilePaths(patchText: string): string[]` — consumed by `normalize.ts`
  (Task 2) for the `apply_patch` case.

Codex's `apply_patch` `tool_input.command` is a unified-diff-style text blob. This function
extracts every file path mentioned via `*** Add File: <path>`, `*** Update File: <path>`,
`*** Delete File: <path>`, or `*** Move to: <path>` lines. Paths are returned in the order they
appear, duplicates included (the caller, Task 2, doesn't need deduping — two `NormalizedAction`s
for the same path is harmless, `evaluateAction` in #28 is idempotent per call).

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/local/src/rules/patchParser.test.ts
import { describe, expect, it } from "vitest";
import { parsePatchFilePaths } from "./patchParser.js";

describe("parsePatchFilePaths", () => {
  it("extracts a single added file", () => {
    const patch = "*** Begin Patch\n*** Add File: src/new.ts\n+content\n*** End Patch";
    expect(parsePatchFilePaths(patch)).toEqual(["src/new.ts"]);
  });

  it("extracts multiple files across add/update/delete", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+content",
      "*** Update File: src/existing.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: src/old.ts",
      "*** End Patch",
    ].join("\n");
    expect(parsePatchFilePaths(patch)).toEqual(["src/new.ts", "src/existing.ts", "src/old.ts"]);
  });

  it("includes a Move to target alongside the Update File source", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old-name.ts",
      "*** Move to: src/new-name.ts",
      "@@",
      "*** End Patch",
    ].join("\n");
    expect(parsePatchFilePaths(patch)).toEqual(["src/old-name.ts", "src/new-name.ts"]);
  });

  it("trims trailing whitespace from extracted paths", () => {
    const patch = "*** Add File: src/new.ts   \n+content";
    expect(parsePatchFilePaths(patch)).toEqual(["src/new.ts"]);
  });

  it("returns an empty array when no file lines are present", () => {
    expect(parsePatchFilePaths("*** Begin Patch\n*** End Patch")).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parsePatchFilePaths("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/patchParser.test.ts`
Expected: FAIL — `Cannot find module './patchParser.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/local/src/rules/patchParser.ts
const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

export function parsePatchFilePaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const match of patchText.matchAll(PATCH_FILE_LINE)) {
    paths.push(match[1].trim());
  }
  return paths;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/patchParser.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/rules/patchParser.ts packages/local/src/rules/patchParser.test.ts
git commit -m "Add apply_patch file-path parser for guardrail normalization"
```

---

## Task 2: Tool-call normalization

**Files:**
- Create: `packages/local/src/rules/normalize.ts`
- Test: `packages/local/src/rules/normalize.test.ts`

**Interfaces:**
- Consumes: `NormalizedAction`, `RuleCategory` from `./schema.js`; `parsePatchFilePaths` from
  `./patchParser.js`.
- Produces: `RawToolCall` type and `normalizeToolCall(call: RawToolCall): NormalizedAction[]` —
  the full public surface of this issue, consumed later by #31.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/local/src/rules/normalize.test.ts
import { describe, expect, it } from "vitest";
import { normalizeToolCall } from "./normalize.js";

const cwd = "/repo";

describe("normalizeToolCall", () => {
  it("normalizes Read to file_read", () => {
    const result = normalizeToolCall({ tool_name: "Read", tool_input: { file_path: "/repo/a.ts" }, cwd });
    expect(result).toEqual([{ category: "file_read", subject: "/repo/a.ts" }]);
  });

  it("normalizes Write to file_write", () => {
    const result = normalizeToolCall({ tool_name: "Write", tool_input: { file_path: "/repo/a.ts" }, cwd });
    expect(result).toEqual([{ category: "file_write", subject: "/repo/a.ts" }]);
  });

  it("normalizes Edit to file_write", () => {
    const result = normalizeToolCall({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" }, cwd });
    expect(result).toEqual([{ category: "file_write", subject: "/repo/a.ts" }]);
  });

  it("normalizes NotebookEdit to file_write using notebook_path", () => {
    const result = normalizeToolCall({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/repo/nb.ipynb" }, cwd });
    expect(result).toEqual([{ category: "file_write", subject: "/repo/nb.ipynb" }]);
  });

  it("normalizes WebFetch to network_call using the url as-is", () => {
    const result = normalizeToolCall({ tool_name: "WebFetch", tool_input: { url: "https://example.com" }, cwd });
    expect(result).toEqual([{ category: "network_call", subject: "https://example.com" }]);
  });

  it("normalizes Glob to file_read using tool_input.path", () => {
    const result = normalizeToolCall({ tool_name: "Glob", tool_input: { path: "/repo/src" }, cwd });
    expect(result).toEqual([{ category: "file_read", subject: "/repo/src" }]);
  });

  it("normalizes Grep to file_read using tool_input.path", () => {
    const result = normalizeToolCall({ tool_name: "Grep", tool_input: { path: "/repo/src" }, cwd });
    expect(result).toEqual([{ category: "file_read", subject: "/repo/src" }]);
  });

  it("falls back to cwd for Glob/Grep when tool_input.path is absent", () => {
    const result = normalizeToolCall({ tool_name: "Glob", tool_input: {}, cwd });
    expect(result).toEqual([{ category: "file_read", subject: "/repo" }]);
  });

  it("normalizes a plain Bash command to shell_exec only", () => {
    const result = normalizeToolCall({ tool_name: "Bash", tool_input: { command: "ls -la" }, cwd });
    expect(result).toEqual([{ category: "shell_exec", subject: "ls -la" }]);
  });

  it("normalizes a git push Bash command to both shell_exec and git_push", () => {
    const result = normalizeToolCall({ tool_name: "Bash", tool_input: { command: "git push --force" }, cwd });
    expect(result).toEqual([
      { category: "shell_exec", subject: "git push --force" },
      { category: "git_push", subject: "git push --force" },
    ]);
  });

  it("normalizes apply_patch into one file_write action per file", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+content",
      "*** Update File: src/existing.ts",
      "*** End Patch",
    ].join("\n");
    const result = normalizeToolCall({ tool_name: "apply_patch", tool_input: { command: patch }, cwd });
    expect(result).toEqual([
      { category: "file_write", subject: "/repo/src/new.ts" },
      { category: "file_write", subject: "/repo/src/existing.ts" },
    ]);
  });

  it("resolves a relative file_path against cwd", () => {
    const result = normalizeToolCall({ tool_name: "Read", tool_input: { file_path: "src/a.ts" }, cwd });
    expect(result).toEqual([{ category: "file_read", subject: "/repo/src/a.ts" }]);
  });

  it("falls back to process.cwd() when cwd is missing", () => {
    const result = normalizeToolCall({ tool_name: "Read", tool_input: { file_path: "a.ts" } });
    expect(result).toEqual([{ category: "file_read", subject: `${process.cwd()}/a.ts` }]);
  });

  it("returns an empty array for an unrecognized tool_name", () => {
    expect(normalizeToolCall({ tool_name: "WebSearch", tool_input: { query: "x" }, cwd })).toEqual([]);
    expect(normalizeToolCall({ tool_name: "mcp__something__do", tool_input: {}, cwd })).toEqual([]);
  });

  it("returns an empty array when tool_name is missing", () => {
    expect(normalizeToolCall({ tool_input: { file_path: "/repo/a.ts" }, cwd })).toEqual([]);
  });

  it("returns an empty array when tool_input is missing for a path-based tool", () => {
    expect(normalizeToolCall({ tool_name: "Read", cwd })).toEqual([]);
  });

  it("returns an empty array when a Bash command is not a string", () => {
    expect(normalizeToolCall({ tool_name: "Bash", tool_input: { command: 123 }, cwd })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/normalize.test.ts`
Expected: FAIL — `Cannot find module './normalize.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/local/src/rules/normalize.ts
import { resolve } from "node:path";
import { parsePatchFilePaths } from "./patchParser.js";
import type { NormalizedAction } from "./schema.js";

export interface RawToolCall {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

const GIT_PUSH_PATTERN = /\bgit\s+push\b/;

function stringField(input: unknown, field: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function resolvePath(cwd: string, subject: string): string {
  return resolve(cwd, subject);
}

export function normalizeToolCall(call: RawToolCall): NormalizedAction[] {
  const toolName = typeof call.tool_name === "string" ? call.tool_name : undefined;
  if (!toolName) return [];
  const cwd = typeof call.cwd === "string" && call.cwd ? call.cwd : process.cwd();

  switch (toolName) {
    case "Read": {
      const filePath = stringField(call.tool_input, "file_path");
      return filePath ? [{ category: "file_read", subject: resolvePath(cwd, filePath) }] : [];
    }
    case "Glob":
    case "Grep": {
      const path = stringField(call.tool_input, "path") ?? cwd;
      return [{ category: "file_read", subject: resolvePath(cwd, path) }];
    }
    case "Write":
    case "Edit": {
      const filePath = stringField(call.tool_input, "file_path");
      return filePath ? [{ category: "file_write", subject: resolvePath(cwd, filePath) }] : [];
    }
    case "NotebookEdit": {
      const notebookPath = stringField(call.tool_input, "notebook_path");
      return notebookPath ? [{ category: "file_write", subject: resolvePath(cwd, notebookPath) }] : [];
    }
    case "WebFetch": {
      const url = stringField(call.tool_input, "url");
      return url ? [{ category: "network_call", subject: url }] : [];
    }
    case "Bash": {
      const command = stringField(call.tool_input, "command");
      if (!command) return [];
      const actions: NormalizedAction[] = [{ category: "shell_exec", subject: command }];
      if (GIT_PUSH_PATTERN.test(command)) actions.push({ category: "git_push", subject: command });
      return actions;
    }
    case "apply_patch": {
      const command = stringField(call.tool_input, "command");
      if (!command) return [];
      return parsePatchFilePaths(command).map((path) => ({
        category: "file_write" as const,
        subject: resolvePath(cwd, path),
      }));
    }
    default:
      return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/normalize.test.ts`
Expected: PASS, all 17 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/rules/normalize.ts packages/local/src/rules/normalize.test.ts
git commit -m "Add per-adapter tool-call normalization for the guardrail rule engine"
```

---

## Task 3: Public exports

**Files:**
- Modify: `packages/local/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces: `@memora-hq/memora-local` now also exports `parsePatchFilePaths`, `RawToolCall`,
  `normalizeToolCall`.

No new test — this is export wiring only, no runtime logic of its own. Verified by the full
package build + test suite in the final step.

- [ ] **Step 1: Add the exports**

Edit `packages/local/src/index.ts`, append after the existing `export * from "./rules/loader.js";`
line:

```typescript
export * from "./rules/patchParser.js";
export * from "./rules/normalize.js";
```

- [ ] **Step 2: Build and run the full package test suite**

Run: `pnpm --filter @memora-hq/memora-local run build && pnpm --filter @memora-hq/memora-local run test`
Expected: build `Done`; all test files pass, including the two new `src/rules/*.test.ts` files
alongside the existing 20 test files (22 total), 0 failures.

- [ ] **Step 3: Commit**

```bash
git add packages/local/src/index.ts
git commit -m "Export guardrail action normalization from @memora-hq/memora-local"
```

---

## Final Verification

- [ ] Run the full monorepo test suite for the two affected packages:

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run test`
Expected: all test files pass, no regressions in pre-existing tests.

- [ ] Run the build:

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run build`
Expected: `Done` for both packages.

- [ ] Close out the issue:

```bash
gh issue close 29 --comment "Per-adapter action normalization implemented in packages/local/src/rules/ (patchParser.ts, normalize.ts), exported from @memora-hq/memora-local. One flat tool_name lookup table serves both Claude and Codex (their tool-name vocabularies never collide). Bash commands matching git push emit both shell_exec and git_push actions; apply_patch emits one file_write action per file touched. All file-path subjects resolved to absolute via cwd. Full table-driven test coverage plus malformed-input and unknown-tool cases. See docs/superpowers/specs/2026-08-14-guardrail-action-normalization-design.md for the design. Does not call evaluateAction or wire into the hook path (#31) - separate issue."
```
