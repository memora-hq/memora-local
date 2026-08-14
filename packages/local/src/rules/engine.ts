import { homedir } from "node:os";
import type { Decision, NormalizedAction, Rule, RuleSet } from "./schema.js";

function globToRegExp(pattern: string): RegExp {
  const expanded = pattern.startsWith("~") ? homedir() + pattern.slice(1) : pattern;
  let source = "";
  for (let i = 0; i < expanded.length; i += 1) {
    const char = expanded[i];
    if (char === "*" && expanded[i + 1] === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function matches(rule: Rule, subject: string): boolean {
  if (rule.category === "file_read" || rule.category === "file_write") {
    return globToRegExp(rule.pattern).test(subject);
  }
  return new RegExp(rule.pattern).test(subject);
}

export function evaluateAction(ruleSet: RuleSet, action: NormalizedAction): Decision {
  const candidates = ruleSet.rules.filter(
    (rule) => rule.enabled && rule.category === action.category && matches(rule, action.subject),
  );
  const hardBlock = candidates.find((rule) => rule.tier === "hard_block");
  if (hardBlock) return { tier: "hard_block", rule: hardBlock };
  const ask = candidates.find((rule) => rule.tier === "ask");
  if (ask) return { tier: "ask", rule: ask };
  return { tier: "allow" };
}
