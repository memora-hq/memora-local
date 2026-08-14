import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";
import { defaultRules, scaffoldRulesYaml } from "./defaults.js";
import type { Rule, RuleCategory, RuleSet, RuleTier } from "./schema.js";

const CATEGORIES: RuleCategory[] = ["file_read", "file_write", "shell_exec", "git_push", "network_call"];
const TIERS: RuleTier[] = ["hard_block", "ask"];

export function defaultRulesPath(): string {
  return join(homedir(), ".config", "memora", "rules.yaml");
}

function validate(value: unknown): RuleSet {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { rules?: unknown }).rules)) {
    throw new Error("rules.yaml must have a top-level 'rules' array");
  }
  const seenIds = new Set<string>();
  const rules = (value as { rules: unknown[] }).rules.map((entry, index): Rule => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`rules[${index}] must be an object`);
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id) throw new Error(`rules[${index}].id must be a non-empty string`);
    if (seenIds.has(raw.id)) throw new Error(`duplicate rule id: ${raw.id}`);
    seenIds.add(raw.id);
    if (!CATEGORIES.includes(raw.category as RuleCategory)) {
      throw new Error(`rules[${index}].category must be one of ${CATEGORIES.join(", ")}`);
    }
    if (!TIERS.includes(raw.tier as RuleTier)) {
      throw new Error(`rules[${index}].tier must be one of ${TIERS.join(", ")}`);
    }
    if (typeof raw.pattern !== "string" || !raw.pattern) {
      throw new Error(`rules[${index}].pattern must be a non-empty string`);
    }
    return {
      id: raw.id,
      category: raw.category as RuleCategory,
      pattern: raw.pattern,
      tier: raw.tier as RuleTier,
      reason: typeof raw.reason === "string" ? raw.reason : "",
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    };
  });
  return { rules };
}

export async function loadRuleSet(path: string = defaultRulesPath()): Promise<RuleSet> {
  try {
    await access(path);
  } catch {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, scaffoldRulesYaml(), { mode: 0o600 });
    return { rules: defaultRules };
  }
  try {
    const text = await readFile(path, "utf8");
    return validate(parse(text));
  } catch (error) {
    console.error(`[memora] failed to load ${path}, falling back to built-in guardrail defaults: ${(error as Error).message}`);
    return { rules: defaultRules };
  }
}
