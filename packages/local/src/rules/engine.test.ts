import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { evaluateAction } from "./engine.js";
import type { Rule, RuleSet } from "./schema.js";

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: "test-rule",
    category: "file_write",
    pattern: "**",
    tier: "hard_block",
    reason: "test",
    enabled: true,
    ...overrides,
  };
}

describe("evaluateAction", () => {
  it("returns allow when no rule matches", () => {
    const ruleSet: RuleSet = { rules: [rule({ category: "file_write", pattern: "/etc/**" })] };
    const decision = evaluateAction(ruleSet, { category: "file_write", subject: "/tmp/foo.txt" });
    expect(decision).toEqual({ tier: "allow" });
  });

  it("matches a glob pattern against a file_write subject", () => {
    const ruleSet: RuleSet = { rules: [rule({ category: "file_write", pattern: "/etc/**" })] };
    const decision = evaluateAction(ruleSet, { category: "file_write", subject: "/etc/passwd" });
    expect(decision.tier).toBe("hard_block");
    expect(decision.rule?.id).toBe("test-rule");
  });

  it("does not cross directory boundaries on a single-star glob segment", () => {
    const ruleSet: RuleSet = { rules: [rule({ category: "file_write", pattern: "/etc/*" })] };
    const decision = evaluateAction(ruleSet, { category: "file_write", subject: "/etc/sub/passwd" });
    expect(decision.tier).toBe("allow");
  });

  it("expands a leading ~ in glob patterns to the home directory", () => {
    const ruleSet: RuleSet = { rules: [rule({ category: "file_write", pattern: "~/.ssh/**" })] };
    const subject = join(homedir(), ".ssh", "id_rsa");
    const decision = evaluateAction(ruleSet, { category: "file_write", subject });
    expect(decision.tier).toBe("hard_block");
  });

  it("matches a regex pattern against a shell_exec subject", () => {
    const ruleSet: RuleSet = { rules: [rule({ category: "shell_exec", pattern: "rm\\s+-rf\\s+~" })] };
    const decision = evaluateAction(ruleSet, { category: "shell_exec", subject: "rm -rf ~" });
    expect(decision.tier).toBe("hard_block");
  });

  it("does not match a different category even with an identical subject string", () => {
    const ruleSet: RuleSet = { rules: [rule({ category: "shell_exec", pattern: ".*" })] };
    const decision = evaluateAction(ruleSet, { category: "git_push", subject: "anything" });
    expect(decision.tier).toBe("allow");
  });

  it("ignores disabled rules", () => {
    const ruleSet: RuleSet = { rules: [rule({ enabled: false, pattern: "**" })] };
    const decision = evaluateAction(ruleSet, { category: "file_write", subject: "/tmp/foo" });
    expect(decision.tier).toBe("allow");
  });

  it("hard_block wins over ask when both match the same action", () => {
    const ruleSet: RuleSet = {
      rules: [
        rule({ id: "ask-rule", tier: "ask", pattern: "**" }),
        rule({ id: "block-rule", tier: "hard_block", pattern: "**" }),
      ],
    };
    const decision = evaluateAction(ruleSet, { category: "file_write", subject: "/tmp/foo" });
    expect(decision.tier).toBe("hard_block");
    expect(decision.rule?.id).toBe("block-rule");
  });

  it("returns ask when only an ask rule matches", () => {
    const ruleSet: RuleSet = { rules: [rule({ tier: "ask", pattern: "**" })] };
    const decision = evaluateAction(ruleSet, { category: "file_write", subject: "/tmp/foo" });
    expect(decision.tier).toBe("ask");
  });
});
