import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
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
