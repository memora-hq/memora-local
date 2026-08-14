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
