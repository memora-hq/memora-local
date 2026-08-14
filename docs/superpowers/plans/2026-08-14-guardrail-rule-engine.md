# Guardrail Rule Engine (#28) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, testable rule engine that loads `~/.config/memora/rules.yaml`
(scaffolding it with built-in defaults on first use) and evaluates normalized actions against
it, returning `hard_block` / `ask` / `allow`.

**Architecture:** New `packages/local/src/rules/` module with four files: `schema.ts` (types),
`engine.ts` (glob/regex matching + precedence), `defaults.ts` (built-in rules + YAML scaffold
template), `loader.ts` (scaffold-if-missing, parse, validate, fall back to defaults on error).
Each file is re-exported from `packages/local/src/index.ts` alongside the existing modules
there. No wiring into the hook path, no dialog UI, no action normalization — this plan produces
only the engine, consumed by later issues (#29, #30, #31).

**Tech Stack:** TypeScript, Node `fs/promises`, the `yaml` npm package (new dependency),
Vitest.

## Global Constraints

- Rules file path: `~/.config/memora/rules.yaml` (exact path from the epic, `join(homedir(),
  ".config", "memora", "rules.yaml")`).
- Config directories created with `mkdir(..., { recursive: true, mode: 0o700 })` — matches the
  identity-key/hook-config convention already used in `hookConfig.ts`, `hookAdapter.ts`,
  `hookTransport.ts`, `knownSigners.ts`, `publishAuth.ts`, `publishClient.ts`.
- `hard_block` always wins over `ask` when both match the same action.
- No match = `allow`. No explicit allow-list tier in v1.
- A rule with `enabled: false` never matches, regardless of tier.
- Built-in defaults are ordinary editable/deletable YAML entries, not hardcoded overrides — a
  user's `rules.yaml` content is authoritative.
- On unparseable/invalid `rules.yaml`, never throw and never return an empty ruleset — fall
  back to the in-memory built-in defaults and log a warning.
- Module boundary: this code knows nothing about Claude/Codex tool names or hook events. Its
  only input is `{ category, subject }`.

---

## File Structure

- Create: `packages/local/src/rules/schema.ts` — types only, no runtime logic.
- Create: `packages/local/src/rules/engine.ts` — `evaluateAction`, glob/regex matching helpers.
- Create: `packages/local/src/rules/defaults.ts` — built-in `Rule[]` + scaffold YAML text.
- Create: `packages/local/src/rules/loader.ts` — `loadRuleSet`.
- Create: `packages/local/src/rules/engine.test.ts`
- Create: `packages/local/src/rules/defaults.test.ts`
- Create: `packages/local/src/rules/loader.test.ts`
- Modify: `packages/local/src/index.ts` — add four export lines.
- Modify: `packages/local/package.json` — add `yaml` dependency.

---

## Task 1: Add the `yaml` dependency

**Files:**
- Modify: `packages/local/package.json`

**Interfaces:** None — dependency-only change.

- [ ] **Step 1: Add the dependency**

Edit `packages/local/package.json`, in the `"dependencies"` block, add (keep alphabetical order
with the existing two entries):

```json
    "@memora-hq/memora-protocol": "0.1.0-rc.2",
    "@memora-hq/memora-verifier": "0.1.0",
    "yaml": "^2.4.0"
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: lockfile updates, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/local/package.json pnpm-lock.yaml
git commit -m "Add yaml dependency for guardrail rules.yaml parsing"
```

---

## Task 2: Rule schema types

**Files:**
- Create: `packages/local/src/rules/schema.ts`

**Interfaces:**
- Produces: `RuleTier`, `RuleCategory`, `Rule`, `RuleSet`, `NormalizedAction`, `Decision` —
  used by every other task in this plan.

No test for this task — it's pure TypeScript type declarations with no runtime behavior to
verify (types are erased at compile time).

- [ ] **Step 1: Write the types**

```typescript
export type RuleTier = "hard_block" | "ask";

export type RuleCategory =
  | "file_read"
  | "file_write"
  | "shell_exec"
  | "git_push"
  | "network_call";

export interface Rule {
  id: string;
  category: RuleCategory;
  pattern: string;
  tier: RuleTier;
  reason: string;
  enabled: boolean;
}

export interface RuleSet {
  rules: Rule[];
}

export interface NormalizedAction {
  category: RuleCategory;
  subject: string;
}

export interface Decision {
  tier: "hard_block" | "ask" | "allow";
  rule?: Rule;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @memora-hq/memora-local run build`
Expected: `Done`, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/local/src/rules/schema.ts
git commit -m "Add guardrail rule schema types"
```

---

## Task 3: Matching + evaluation engine

**Files:**
- Create: `packages/local/src/rules/engine.ts`
- Test: `packages/local/src/rules/engine.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleSet`, `RuleCategory`, `NormalizedAction`, `Decision` from `./schema.js`.
- Produces: `evaluateAction(ruleSet: RuleSet, action: NormalizedAction): Decision` — the
  function `loader.ts` (Task 5) re-exports and every future consumer (#31) calls per tool call.

Matching semantics: `file_read`/`file_write` patterns are globs matched against
`action.subject` (expected to already be a resolved absolute path — this module does no path
resolution itself, that's the caller's job); a leading `~` in the pattern is expanded to
`homedir()` before glob conversion, so patterns can be written portably in `rules.yaml`. All
other categories use `pattern` as a regular expression tested against `action.subject` with
`new RegExp(pattern).test(subject)`.

Glob support is intentionally minimal: `*` matches any run of characters except `/`, `**`
matches any run of characters including `/`, everything else is matched literally.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/local/src/rules/engine.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/engine.test.ts`
Expected: FAIL — `Cannot find module './engine.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// packages/local/src/rules/engine.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/engine.test.ts`
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/rules/engine.ts packages/local/src/rules/engine.test.ts
git commit -m "Add guardrail rule matching and evaluation engine"
```

---

## Task 4: Built-in default rules + YAML scaffold template

**Files:**
- Create: `packages/local/src/rules/defaults.ts`
- Test: `packages/local/src/rules/defaults.test.ts`

**Interfaces:**
- Consumes: `Rule` from `./schema.js`; `stringify`/`parse` from `yaml`.
- Produces: `defaultRules: Rule[]` and `scaffoldRulesYaml(): string` — both consumed by
  `loader.ts` (Task 5).

`scaffoldRulesYaml()` returns the full text written to a fresh `rules.yaml`: a header comment
block explaining the schema, followed by the eight default rules serialized as YAML.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/local/src/rules/defaults.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/defaults.test.ts`
Expected: FAIL — `Cannot find module './defaults.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/local/src/rules/defaults.ts
import { stringify } from "yaml";
import type { Rule, RuleSet } from "./schema.js";

export const defaultRules: Rule[] = [
  {
    id: "block-credential-writes",
    category: "file_write",
    pattern: "~/.env",
    tier: "hard_block",
    reason: "Writing to credential files risks leaking or corrupting secrets",
    enabled: true,
  },
  {
    id: "block-ssh-writes",
    category: "file_write",
    pattern: "~/.ssh/**",
    tier: "hard_block",
    reason: "Writing to SSH credential files risks leaking or corrupting secrets",
    enabled: true,
  },
  {
    id: "block-aws-writes",
    category: "file_write",
    pattern: "~/.aws/**",
    tier: "hard_block",
    reason: "Writing to AWS credential files risks leaking or corrupting secrets",
    enabled: true,
  },
  {
    id: "block-force-push",
    category: "git_push",
    pattern: "--force|-f\\b",
    tier: "hard_block",
    reason: "Force push can overwrite remote history irreversibly",
    enabled: true,
  },
  {
    id: "block-rm-rf-broad",
    category: "shell_exec",
    pattern: "rm\\s+(-\\w*r\\w*f\\w*|-\\w*f\\w*r\\w*)\\s+(~|/|\\.)\\s*$",
    tier: "hard_block",
    reason: "Recursive force-delete of a broad path (home, root, or cwd) risks unrecoverable data loss",
    enabled: true,
  },
  {
    id: "block-git-reset-hard",
    category: "shell_exec",
    pattern: "git\\s+reset\\s+--hard",
    tier: "hard_block",
    reason: "git reset --hard discards uncommitted work irreversibly",
    enabled: true,
  },
  {
    id: "block-rules-file-edit",
    category: "file_write",
    pattern: "~/.config/memora/rules.yaml",
    tier: "hard_block",
    reason: "Editing the guardrail ruleset itself is blocked",
    enabled: true,
  },
  {
    id: "block-memora-config-edit",
    category: "file_write",
    pattern: "~/.config/memora/**",
    tier: "hard_block",
    reason: "Editing Memora's config directory could be used to disable guardrail enforcement",
    enabled: true,
  },
];

export function scaffoldRulesYaml(): string {
  const header = [
    "# Memora guardrail rules",
    "#",
    "# Each rule matches a normalized agent action (category + pattern) and assigns it a tier:",
    "#   hard_block - always denied, no prompt.",
    "#   ask        - the user is asked to approve; treated as denied if not explicitly approved.",
    "#",
    "# category: file_read | file_write | shell_exec | git_push | network_call",
    "# pattern:  glob for file_read/file_write (matched against the resolved path),",
    "#           regex for shell_exec/git_push/network_call (matched against the command/refspec/host).",
    "# enabled:  set to false to disable a rule without deleting it.",
    "#",
    "# The rules below are Memora's built-in defaults. Edit, disable, or delete any of them,",
    "# or add your own — this file is the full ruleset, nothing is enforced beyond what's here.",
    "",
  ].join("\n");
  const ruleSet: RuleSet = { rules: defaultRules };
  return header + stringify(ruleSet);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/defaults.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/rules/defaults.ts packages/local/src/rules/defaults.test.ts
git commit -m "Add guardrail built-in default rules and rules.yaml scaffold"
```

---

## Task 5: Loader — scaffold-if-missing, parse, validate, fall back on error

**Files:**
- Create: `packages/local/src/rules/loader.ts`
- Test: `packages/local/src/rules/loader.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleSet`, `RuleCategory`, `RuleTier` from `./schema.js`; `defaultRules`,
  `scaffoldRulesYaml` from `./defaults.js`; `parse` from `yaml`.
- Produces: `defaultRulesPath(): string` and `loadRuleSet(path?: string): Promise<RuleSet>` —
  `defaultRulesPath()` returns `join(homedir(), ".config", "memora", "rules.yaml")`; consumed by
  #31 (not built in this plan) and by Task 6's re-export.

Validation rules per entry: `id` non-empty string and unique in the file; `category` is one of
the five known `RuleCategory` values; `tier` is `hard_block` or `ask`; `pattern` is a non-empty
string; `enabled` is a boolean (default to `true` if the key is absent, since hand-edited YAML
may omit it — matching the scaffold's own use of the field is still explicit, but user-authored
additions shouldn't be forced to type `enabled: true` on every line). Missing `reason` defaults
to an empty string (cosmetic only — never blocks a rule from being valid). Any other failure
(YAML syntax error, non-object root, `rules` not an array, an invalid entry) triggers the
whole-file fallback to `defaultRules`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/local/src/rules/loader.test.ts
import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRulesPath, loadRuleSet } from "./loader.js";
import { defaultRules } from "./defaults.js";

describe("loadRuleSet", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns the ~/.config/memora/rules.yaml path from defaultRulesPath", () => {
    expect(defaultRulesPath()).toMatch(/\.config\/memora\/rules\.yaml$/);
  });

  it("scaffolds a new file with the default rules when none exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-rules-"));
    const path = join(dir, "nested", "rules.yaml");
    const ruleSet = await loadRuleSet(path);
    expect(ruleSet.rules).toEqual(defaultRules);
    const written = await readFile(path, "utf8");
    expect(written).toContain("# Memora guardrail rules");
    const dirStat = await stat(join(dir, "nested"));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("loads an existing valid file as-is, including a user-added custom rule", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-rules-"));
    const path = join(dir, "rules.yaml");
    await writeFile(
      path,
      "rules:\n  - id: custom-rule\n    category: network_call\n    pattern: evil\\.example\\.com\n    tier: ask\n    reason: custom\n    enabled: true\n",
    );
    const ruleSet = await loadRuleSet(path);
    expect(ruleSet.rules).toEqual([
      {
        id: "custom-rule",
        category: "network_call",
        pattern: "evil\\.example\\.com",
        tier: "ask",
        reason: "custom",
        enabled: true,
      },
    ]);
  });

  it("excludes a default rule the user disabled", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-rules-"));
    const path = join(dir, "rules.yaml");
    await writeFile(
      path,
      "rules:\n  - id: r1\n    category: file_write\n    pattern: '**'\n    tier: hard_block\n    reason: x\n    enabled: false\n",
    );
    const ruleSet = await loadRuleSet(path);
    expect(ruleSet.rules[0].enabled).toBe(false);
  });

  it("defaults a missing enabled field to true", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-rules-"));
    const path = join(dir, "rules.yaml");
    await writeFile(path, "rules:\n  - id: r1\n    category: file_write\n    pattern: '**'\n    tier: ask\n    reason: x\n");
    const ruleSet = await loadRuleSet(path);
    expect(ruleSet.rules[0].enabled).toBe(true);
  });

  it("falls back to built-in defaults on invalid YAML syntax and logs a warning", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-rules-"));
    const path = join(dir, "rules.yaml");
    await writeFile(path, "rules:\n  - id: [unterminated\n");
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ruleSet = await loadRuleSet(path);
    expect(ruleSet.rules).toEqual(defaultRules);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("falls back to built-in defaults when a rule entry has an invalid category", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-rules-"));
    const path = join(dir, "rules.yaml");
    await writeFile(
      path,
      "rules:\n  - id: r1\n    category: not_a_real_category\n    pattern: '**'\n    tier: hard_block\n    reason: x\n    enabled: true\n",
    );
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ruleSet = await loadRuleSet(path);
    expect(ruleSet.rules).toEqual(defaultRules);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("falls back to built-in defaults when two rule ids collide", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-rules-"));
    const path = join(dir, "rules.yaml");
    await writeFile(
      path,
      "rules:\n  - id: dup\n    category: file_write\n    pattern: 'a'\n    tier: ask\n    reason: x\n    enabled: true\n  - id: dup\n    category: file_write\n    pattern: 'b'\n    tier: ask\n    reason: y\n    enabled: true\n",
    );
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ruleSet = await loadRuleSet(path);
    expect(ruleSet.rules).toEqual(defaultRules);
    expect(warnSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/loader.test.ts`
Expected: FAIL — `Cannot find module './loader.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/local/src/rules/loader.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/loader.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/rules/loader.ts packages/local/src/rules/loader.test.ts
git commit -m "Add guardrail rules.yaml loader with scaffold-on-missing and fallback-on-invalid"
```

---

## Task 6: Public exports + end-to-end self-protection test

**Files:**
- Modify: `packages/local/src/index.ts`
- Test: `packages/local/src/rules/loader.test.ts` (append one test)

**Interfaces:**
- Consumes: everything from Tasks 2-5.
- Produces: `@memora-hq/memora-local` package now exports `evaluateAction`, `defaultRules`,
  `scaffoldRulesYaml`, `defaultRulesPath`, `loadRuleSet`, and the `rules/schema.js` types —
  the full public surface #29/#30/#31 will consume.

This task adds one integration-style test proving the self-protection rules work end-to-end
through `defaultRules` and `evaluateAction` composed together (both already implemented and
individually tested in Tasks 3-5). There's no new production code here — this is a composition
check, not a red/green cycle — so it's written and run once, expected to pass immediately.

- [ ] **Step 1: Add the composition test**

Add `evaluateAction` to the `./engine.js` import and `homedir` to the `node:os` import at the
top of `packages/local/src/rules/loader.test.ts`, then add this test inside the existing
`describe("loadRuleSet", ...)` block:

```typescript
it("scaffolded defaults hard_block writes to rules.yaml itself and to the config dir, but not unrelated paths", () => {
  const ruleSet = { rules: defaultRules };
  const rulesPath = join(homedir(), ".config", "memora", "rules.yaml");
  const otherConfigFile = join(homedir(), ".config", "memora", "other-file.json");
  const unrelatedPath = join(homedir(), "project", "README.md");

  expect(evaluateAction(ruleSet, { category: "file_write", subject: rulesPath }).tier).toBe("hard_block");
  expect(evaluateAction(ruleSet, { category: "file_write", subject: otherConfigFile }).tier).toBe("hard_block");
  expect(evaluateAction(ruleSet, { category: "file_write", subject: unrelatedPath }).tier).toBe("allow");
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/rules/loader.test.ts`
Expected: PASS, all 9 tests green (8 from Task 5 + this one). If this fails, it means the
built-in default patterns from Task 4 don't actually protect the config directory as intended —
fix `defaults.ts`, not this test.

- [ ] **Step 3: Add package-level exports**

Edit `packages/local/src/index.ts`, append after the existing `export * from "./receiptDoc.js";`
line:

```typescript
export * from "./rules/schema.js";
export * from "./rules/engine.js";
export * from "./rules/defaults.js";
export * from "./rules/loader.js";
```

- [ ] **Step 4: Build and run the full package test suite**

Run: `pnpm --filter @memora-hq/memora-local run build && pnpm --filter @memora-hq/memora-local run test`
Expected: build `Done`; all test files pass, including the new `src/rules/*.test.ts` files
alongside the existing 17 (now 20) test files, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/index.ts packages/local/src/rules/loader.test.ts
git commit -m "Export guardrail rule engine from @memora-hq/memora-local"
```

---

## Final Verification

- [ ] Run the full monorepo test suite for the two affected packages:

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run test`
Expected: all test files pass, no regressions in pre-existing tests.

- [ ] Run the build:

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run build`
Expected: `Done` for both packages.

- [ ] Close out the issue (do not push/merge without the user's go-ahead — follow the same
  commit-only workflow used for #22):

```bash
gh issue close 28 --comment "Rule engine + rules.yaml schema, loading, and built-in defaults implemented in packages/local/src/rules/ (schema.ts, engine.ts, defaults.ts, loader.ts), exported from @memora-hq/memora-local. Eight built-in hard_block defaults including the two self-protection rules. Full test coverage: matching/precedence, scaffold-on-missing, fallback-on-invalid, self-protection end-to-end. See docs/superpowers/specs/2026-08-14-guardrail-rule-engine-design.md for the design. Does not yet wire into the hook path (#31) or consume real Claude/Codex actions (#29) - those are separate issues."
```
