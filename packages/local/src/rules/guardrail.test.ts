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
