import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { defaultRules, scaffoldRulesYaml } from "./defaults.js";
import type { RuleSet } from "./schema.js";

describe("guardrail defaults", () => {
  it("defines exactly eight default rules, all hard_block and enabled", () => {
    expect(defaultRules).toHaveLength(8);
    for (const rule of defaultRules) {
      expect(rule.tier).toBe("hard_block");
      expect(rule.enabled).toBe(true);
    }
  });

  it("includes the two self-protection rules", () => {
    const ids = defaultRules.map((rule) => rule.id);
    expect(ids).toContain("block-rules-file-edit");
    expect(ids).toContain("block-memora-config-edit");
  });

  it("has unique ids across all default rules", () => {
    const ids = defaultRules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("scaffold text parses back into a RuleSet containing exactly the default rules", () => {
    const parsed = parse(scaffoldRulesYaml()) as RuleSet;
    expect(parsed.rules).toEqual(defaultRules);
  });

  it("scaffold text includes an explanatory header comment", () => {
    expect(scaffoldRulesYaml()).toContain("# Memora guardrail rules");
  });
});
