# Wire Guardrail Enforcement Into `local hook` (#31) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose the rule engine (#28), action normalization (#29), and the approval dialog
(#30) into one decision function, then wire it into `memora local hook`'s `PreToolUse` path so
a matched `hard_block` or unapproved `ask` rule genuinely denies the tool call via the
documented `hookSpecificOutput` JSON protocol (verified identical on Claude Code and Codex).

**Architecture:** New `packages/local/src/rules/guardrail.ts` holds all decision logic, fully
unit-testable via dependency injection (no real dialogs, no real filesystem in tests).
`packages/cli/src/cli.ts`'s `cmdLocalHook` gets thin wiring: check applicability, load rules,
evaluate, attach the decision to the evidence payload, print the deny JSON when applicable.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

## Global Constraints

- Deny protocol (verified against Codex's own source and Claude Code's official docs — both
  identical): on stdout, exit code 0:
  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>"}}
  ```
  Never emit `permissionDecision: "ask"` to either provider — Codex's own source confirms it
  fails open (proceeds) on `"ask"`, which is exactly why #30 built a separate blocking dialog
  instead. Nothing printed = implicit allow (today's existing default).
- `isGuardrailApplicable` gates on: `provider` is `"codex"` or `"claude"`;
  `payload.hook_event_name === "PreToolUse"`; and the `MEMORA_GUARDRAIL_DISABLED` kill switch
  is not set (any non-empty env value disables enforcement entirely).
- Across multiple `NormalizedAction`s from one tool call, reduce to the single most severe
  decision: `hard_block` > `ask` > `allow`. Only one dialog, at most, per tool call.
- The guardrail decision is merged into the hook payload before `enqueueLocalHook` (rides the
  existing `tool_requested` evidence event — no changes to `eventTaxonomy.ts`/`summary.ts`) —
  but only when `isGuardrailApplicable` was true; payloads from inapplicable events/providers
  are enqueued unchanged, exactly as today.
- `cli.ts` wiring is not unit-tested directly (no test seam — `main()` runs at import time,
  same situation as #22). All decision logic lives in `guardrail.ts` and is fully tested there.

---

## File Structure

- Create: `packages/local/src/rules/guardrail.ts`
- Create: `packages/local/src/rules/guardrail.test.ts`
- Modify: `packages/local/src/index.ts` — add guardrail exports.
- Modify: `packages/cli/src/cli.ts` — wire `cmdLocalHook`, add imports.

---

## Task 1: Guardrail decision logic

**Files:**
- Create: `packages/local/src/rules/guardrail.ts`
- Test: `packages/local/src/rules/guardrail.test.ts`

**Interfaces:**
- Consumes: `normalizeToolCall`, `RawToolCall` from `./normalize.js`; `evaluateAction` from
  `./engine.js`; `Rule`, `RuleSet` from `./schema.js`; `requestApproval`, `ApprovalOutcome`,
  `ApprovalRequest` from `../dialog/approvalDialog.js`.
- Produces: `GuardrailOutcome`, `GuardrailDecision`, `isGuardrailApplicable(provider: string,
  payload: { hook_event_name?: unknown }, disabled: boolean): boolean`,
  `evaluateGuardrail(payload: RawToolCall, ruleSet: RuleSet, requestApprovalFn?: typeof
  requestApproval): Promise<GuardrailDecision>` — consumed by `cli.ts` (Task 2).

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/local/src/rules/guardrail.test.ts
import { describe, expect, it, vi } from "vitest";
import { evaluateGuardrail, isGuardrailApplicable } from "./guardrail.js";
import type { Rule, RuleSet } from "./schema.js";
import type { ApprovalOutcome, ApprovalRequest } from "../dialog/approvalDialog.js";

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: "test-rule",
    category: "file_write",
    pattern: "**",
    tier: "hard_block",
    reason: "test reason",
    enabled: true,
    ...overrides,
  };
}

describe("isGuardrailApplicable", () => {
  it("is true for claude PreToolUse when not disabled", () => {
    expect(isGuardrailApplicable("claude", { hook_event_name: "PreToolUse" }, false)).toBe(true);
  });

  it("is true for codex PreToolUse when not disabled", () => {
    expect(isGuardrailApplicable("codex", { hook_event_name: "PreToolUse" }, false)).toBe(true);
  });

  it("is false for an editor adapter", () => {
    expect(isGuardrailApplicable("vscode", { hook_event_name: "PreToolUse" }, false)).toBe(false);
  });

  it("is false for a non-PreToolUse event", () => {
    expect(isGuardrailApplicable("claude", { hook_event_name: "PostToolUse" }, false)).toBe(false);
  });

  it("is false when disabled via the kill switch", () => {
    expect(isGuardrailApplicable("claude", { hook_event_name: "PreToolUse" }, true)).toBe(false);
  });
});

describe("evaluateGuardrail", () => {
  const approvalFn = (outcome: ApprovalOutcome) => vi.fn((_: ApprovalRequest) => Promise.resolve(outcome));

  it("allows when no rule matches", async () => {
    const ruleSet: RuleSet = { rules: [rule({ pattern: "/nowhere/**" })] };
    const decision = await evaluateGuardrail(
      { tool_name: "Write", tool_input: { file_path: "/repo/a.ts" }, cwd: "/repo" },
      ruleSet,
    );
    expect(decision).toEqual({ outcome: "allow" });
  });

  it("hard_blocks without ever calling requestApprovalFn", async () => {
    const ruleSet: RuleSet = { rules: [rule({ tier: "hard_block" })] };
    const fn = approvalFn({ approved: true });
    const decision = await evaluateGuardrail(
      { tool_name: "Write", tool_input: { file_path: "/repo/a.ts" }, cwd: "/repo" },
      ruleSet,
      fn,
    );
    expect(decision.outcome).toBe("hard_block");
    expect(decision.denyReason).toBe("test reason");
    expect(fn).not.toHaveBeenCalled();
  });

  it("resolves to ask_approved when the dialog approves", async () => {
    const ruleSet: RuleSet = { rules: [rule({ tier: "ask" })] };
    const fn = approvalFn({ approved: true });
    const decision = await evaluateGuardrail(
      { tool_name: "Write", tool_input: { file_path: "/repo/a.ts" }, cwd: "/repo" },
      ruleSet,
      fn,
    );
    expect(decision.outcome).toBe("ask_approved");
    expect(fn).toHaveBeenCalledWith({ category: "file_write", subject: "/repo/a.ts", reason: "test reason" });
  });

  it("resolves to ask_denied with 'Denied by user' when the dialog denies", async () => {
    const ruleSet: RuleSet = { rules: [rule({ tier: "ask" })] };
    const fn = approvalFn({ approved: false, reason: "denied" });
    const decision = await evaluateGuardrail(
      { tool_name: "Write", tool_input: { file_path: "/repo/a.ts" }, cwd: "/repo" },
      ruleSet,
      fn,
    );
    expect(decision).toEqual({ outcome: "ask_denied", rule: expect.objectContaining({ id: "test-rule" }), denyReason: "Denied by user" });
  });

  it("resolves to ask_denied with 'Approval request timed out' on timeout", async () => {
    const ruleSet: RuleSet = { rules: [rule({ tier: "ask" })] };
    const fn = approvalFn({ approved: false, reason: "timeout" });
    const decision = await evaluateGuardrail(
      { tool_name: "Write", tool_input: { file_path: "/repo/a.ts" }, cwd: "/repo" },
      ruleSet,
      fn,
    );
    expect(decision.denyReason).toBe("Approval request timed out");
  });

  it("resolves to ask_denied with 'No display available to show approval prompt' on no_display", async () => {
    const ruleSet: RuleSet = { rules: [rule({ tier: "ask" })] };
    const fn = approvalFn({ approved: false, reason: "no_display" });
    const decision = await evaluateGuardrail(
      { tool_name: "Write", tool_input: { file_path: "/repo/a.ts" }, cwd: "/repo" },
      ruleSet,
      fn,
    );
    expect(decision.denyReason).toBe("No display available to show approval prompt");
  });

  it("hard_block wins over ask across multiple actions from one Bash call, without calling requestApprovalFn", async () => {
    const ruleSet: RuleSet = {
      rules: [
        rule({ id: "ask-shell", category: "shell_exec", tier: "ask", pattern: ".*" }),
        rule({ id: "block-push", category: "git_push", tier: "hard_block", pattern: ".*" }),
      ],
    };
    const fn = approvalFn({ approved: true });
    const decision = await evaluateGuardrail(
      { tool_name: "Bash", tool_input: { command: "git push --force" }, cwd: "/repo" },
      ruleSet,
      fn,
    );
    expect(decision.outcome).toBe("hard_block");
    expect(decision.rule?.id).toBe("block-push");
    expect(fn).not.toHaveBeenCalled();
  });

  it("allows an unclassified tool without calling requestApprovalFn", async () => {
    const ruleSet: RuleSet = { rules: [rule({ category: "network_call", tier: "ask", pattern: ".*" })] };
    const fn = approvalFn({ approved: true });
    const decision = await evaluateGuardrail(
      { tool_name: "WebSearch", tool_input: { query: "x" }, cwd: "/repo" },
      ruleSet,
      fn,
    );
    expect(decision).toEqual({ outcome: "allow" });
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/guardrail.test.ts`
Expected: FAIL — `Cannot find module './guardrail.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/local/src/rules/guardrail.ts
import { normalizeToolCall, type RawToolCall } from "./normalize.js";
import { evaluateAction } from "./engine.js";
import type { Rule, RuleSet } from "./schema.js";
import { requestApproval } from "../dialog/approvalDialog.js";

export type GuardrailOutcome = "allow" | "hard_block" | "ask_approved" | "ask_denied";

export interface GuardrailDecision {
  outcome: GuardrailOutcome;
  rule?: Rule;
  denyReason?: string;
}

export function isGuardrailApplicable(
  provider: string,
  payload: { hook_event_name?: unknown },
  disabled: boolean,
): boolean {
  if (disabled) return false;
  if (provider !== "codex" && provider !== "claude") return false;
  return payload.hook_event_name === "PreToolUse";
}

const SEVERITY: Record<"allow" | "ask" | "hard_block", number> = { allow: 0, ask: 1, hard_block: 2 };

export async function evaluateGuardrail(
  payload: RawToolCall,
  ruleSet: RuleSet,
  requestApprovalFn: typeof requestApproval = requestApproval,
): Promise<GuardrailDecision> {
  const actions = normalizeToolCall(payload);
  let best: { tier: "allow" | "ask" | "hard_block"; rule?: Rule; subject?: string } = { tier: "allow" };
  for (const action of actions) {
    const decision = evaluateAction(ruleSet, action);
    if (SEVERITY[decision.tier] > SEVERITY[best.tier]) {
      best = { tier: decision.tier, rule: decision.rule, subject: action.subject };
    }
  }
  if (best.tier === "allow") return { outcome: "allow" };
  if (best.tier === "hard_block") {
    return { outcome: "hard_block", rule: best.rule, denyReason: best.rule!.reason };
  }
  const approval = await requestApprovalFn({
    category: best.rule!.category,
    subject: best.subject!,
    reason: best.rule!.reason,
  });
  if (approval.approved) return { outcome: "ask_approved", rule: best.rule };
  const denyReason = approval.reason === "denied"
    ? "Denied by user"
    : approval.reason === "timeout"
      ? "Approval request timed out"
      : "No display available to show approval prompt";
  return { outcome: "ask_denied", rule: best.rule, denyReason };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/guardrail.test.ts`
Expected: PASS, all 13 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/rules/guardrail.ts packages/local/src/rules/guardrail.test.ts
git commit -m "Add guardrail decision logic composing rule engine, normalization, and dialog"
```

---

## Task 2: Export and wire into `cmdLocalHook`

**Files:**
- Modify: `packages/local/src/index.ts`
- Modify: `packages/cli/src/cli.ts`

**Interfaces:**
- Consumes: `isGuardrailApplicable`, `evaluateGuardrail` from `@memora-hq/memora-local`
  (re-exported via `guardrail.js`); already-imported `loadRuleSet`, `enqueueLocalHook`.

No new automated test — this is the untestable wiring layer (see Global Constraints). Verified
by the full build/test suite plus a manual smoke test in Final Verification.

- [ ] **Step 1: Add the package export**

Edit `packages/local/src/index.ts`, append after the existing `export * from
"./dialog/approvalDialog.js";` line:

```typescript
export * from "./rules/guardrail.js";
```

- [ ] **Step 2: Add the cli.ts import**

Edit `packages/cli/src/cli.ts`'s existing `@memora-hq/memora-local` import block (the one
starting `import { KnownSignerStore, ... } from "@memora-hq/memora-local";`), adding these
names in alphabetical position among the existing ones (`GuardrailDecision` is a type-only
import, needed for the explicit annotation in Step 3):

```typescript
  evaluateGuardrail,
  isGuardrailApplicable,
  loadRuleSet,
  type GuardrailDecision,
```

- [ ] **Step 3: Rewrite `cmdLocalHook`**

Replace the existing `cmdLocalHook` function body (currently `packages/cli/src/cli.ts:432-452`)
with:

```typescript
async function cmdLocalHook(provider: string) {
  if (!["codex", "claude", "vscode", "cursor"].includes(provider)) {
    throw new Error("--provider must be codex, claude, vscode, or cursor");
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString();
  if (!input.trim()) throw new Error("hook JSON is required on stdin");
  const payload = JSON.parse(input) as Record<string, unknown>;

  const guardrailDisabled = Boolean(process.env.MEMORA_GUARDRAIL_DISABLED);
  const guardrailApplicable = isGuardrailApplicable(provider, payload, guardrailDisabled);
  // Explicit annotation matters here: without it, TS infers the ternary's type as the union of
  // GuardrailDecision and the bare `{ outcome: "allow" }` literal, and later `decision.rule`
  // access fails to typecheck because that literal type (not GuardrailDecision) has no `rule`
  // property at all, even though `rule` is optional on GuardrailDecision.
  const decision: GuardrailDecision = guardrailApplicable
    ? await evaluateGuardrail(payload, await loadRuleSet())
    : { outcome: "allow" };

  if (guardrailApplicable) {
    payload.memora_guardrail_decision = decision.outcome;
    if (decision.rule) payload.memora_guardrail_rule_id = decision.rule.id;
  }
  await enqueueLocalHook(provider as LocalHookProvider, payload);

  // Purely local plumbing: this drains /tmp hook events into the local evidence store. It
  // never touches the network or implies an upload — that only happens via `local publish`.
  // A failure here must not fail the hook itself, so it's caught and swallowed.
  try {
    if (!(await isDaemonRunning()).running) {
      await spawnDaemon(localPaths().root, resolveSelfCliPath());
    }
  } catch (error) {
    console.error(`[memora] daemon autostart failed: ${(error as Error).message}`);
  }

  if (decision.outcome === "hard_block" || decision.outcome === "ask_denied") {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.denyReason,
      },
    }));
  }
}
```

- [ ] **Step 4: Build and run the full test suite**

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run build && pnpm --filter @memora-hq/memora-local --filter ./packages/cli run test`
Expected: both builds `Done`; all test files pass, including `src/rules/guardrail.test.ts`
alongside the existing 26 test files in `packages/local` (27 total), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/index.ts packages/cli/src/cli.ts
git commit -m "Wire guardrail enforcement into the local hook PreToolUse path"
```

---

## Final Verification

- [ ] Run the full monorepo test suite for the two affected packages:

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run test`
Expected: all test files pass, no regressions.

- [ ] Run the build:

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run build`
Expected: `Done` for both packages.

- [ ] **Manual end-to-end smoke test** (the one piece of this issue that can't be unit-tested —
  confirms the real wiring, not just `evaluateGuardrail` in isolation). This directly invokes
  the built CLI's `local hook` command with a synthetic `PreToolUse` payload against a
  temporary rules file, bypassing the need to actually install hooks into a real agent:

The `HOME` override below makes `defaultRulesPath()` (from #28) resolve to
`/tmp/memora-guardrail-smoke/.config/memora/rules.yaml`, so the rules file must be placed there
directly — no separate copy step needed:

```bash
mkdir -p /tmp/memora-guardrail-smoke/.config/memora
cat > /tmp/memora-guardrail-smoke/.config/memora/rules.yaml <<'EOF'
rules:
  - id: smoke-test-block
    category: file_write
    pattern: /tmp/memora-guardrail-smoke/protected.txt
    tier: hard_block
    reason: "smoke test hard_block"
    enabled: true
EOF
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"/tmp/memora-guardrail-smoke/protected.txt"},"cwd":"/tmp/memora-guardrail-smoke","session_id":"smoke-test"}' \
  | MEMORA_LOCAL_DATA_DIR=/tmp/memora-guardrail-smoke/data \
    HOME=/tmp/memora-guardrail-smoke \
    node packages/cli/dist/cli.js local hook --provider claude
```

Expected stdout:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"smoke test hard_block"}}
```

Then clean up: `rm -rf /tmp/memora-guardrail-smoke`.

- [ ] Also confirm the allow path prints nothing — rerun the same command with
  `tool_input.file_path` changed to `/tmp/memora-guardrail-smoke/unprotected.txt`; expected:
  no stdout output at all (only whatever the daemon-autostart path logs to stderr, if
  anything).

- [ ] Close out the issue:

```bash
gh issue close 31 --comment "Guardrail enforcement wired into local hook's PreToolUse path. New packages/local/src/rules/guardrail.ts composes evaluateAction (#28), normalizeToolCall (#29), and requestApproval (#30) into one decision, reducing multiple normalized actions from one tool call to the single most severe outcome. cmdLocalHook in packages/cli/src/cli.ts now checks isGuardrailApplicable, loads rules.yaml, evaluates, attaches the decision to the existing tool_requested evidence event, and emits the documented hookSpecificOutput deny JSON (verified identical on Claude Code and Codex, including that Codex fails open on permissionDecision:ask, which is why this never emits ask to either provider). MEMORA_GUARDRAIL_DISABLED kill switch included. Full unit coverage of the decision logic with injected fakes (no real dialogs in tests); cli.ts wiring itself has no test seam (same as #22) and was verified via a manual end-to-end smoke test instead. This closes out the guardrail epic #32 (#28, #29, #30, #31 all complete)."
```

- [ ] Close out the epic:

```bash
gh issue close 32 --comment "All four sub-issues complete: #28 (rule engine + rules.yaml), #29 (action normalization), #30 (approval dialog), #31 (hook enforcement wiring). Guardrail enforcement is live in @memora-hq/memora-local and wired into memora local hook's PreToolUse path for Claude Code and Codex. Known follow-ups, deliberately out of scope for this epic per the original design: #27 (better headless/no-display fallback for ask rules, post-beta) and the Windows dialog path in #30 is unverified pending access to a Windows machine."
```
