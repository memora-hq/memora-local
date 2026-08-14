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
