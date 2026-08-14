# Guardrail rule engine + `rules.yaml` schema (#28)

Part of the cross-agent guardrail/policy layer epic (#32). This spec covers only the rule
engine, schema, loading/scaffolding, and built-in defaults — not action normalization (#29),
the approval dialog (#30), or wiring into the hook path (#31).

## Goal

A standalone, testable module that:
1. Defines the schema for `~/.config/memora/rules.yaml`.
2. Loads (and auto-scaffolds on first use) that file.
3. Evaluates a normalized action against the loaded ruleset and returns a decision.

Consumers (#31, later) call `loadRuleSet()` once and `evaluateAction()` per tool call. This
module has no knowledge of Claude/Codex tool names, hook events, or the approval dialog — it
only knows normalized `{ category, subject }` actions, matching the epic's design goal that the
same `rules.yaml` applies identically to any current or future agent adapter.

## Module layout

New directory `packages/local/src/rules/`, mirroring the existing `adapters/` split:

- `schema.ts` — `Rule`, `RuleSet`, `RuleTier`, `RuleCategory`, `NormalizedAction`, `Decision` types.
- `defaults.ts` — the built-in default rules as data, plus the YAML scaffold template (defaults
  + explanatory header comments) written on first use.
- `loader.ts` — `loadRuleSet(path?): Promise<RuleSet>` — scaffold-if-missing, parse, validate.
- `engine.ts` — `evaluateAction(ruleSet, action): Decision` — precedence logic.
- `index.ts` — re-exports the public surface.

## Schema

One rule shape for all categories:

```yaml
rules:
  - id: block-force-push
    category: git_push
    pattern: '--force|-f\b'
    tier: hard_block
    reason: "Force push can overwrite remote history irreversibly"
    enabled: true
```

Fields:
- `id` — stable string identifier, unique within the file. Used for logging/UI and as the
  match result's reference.
- `category` — one of `file_read | file_write | shell_exec | git_push | network_call`.
- `pattern` — matching semantics depend on category:
  - `file_read` / `file_write`: glob, matched against the action's resolved absolute path.
  - `shell_exec` / `git_push` / `network_call`: regex, matched against the command string /
    `remote refspec` / host respectively.
- `tier` — `hard_block` (always denied, no prompt) or `ask` (escalated; the epic's dialog/#30
  and wiring/#31 handle what "ask" does — this module only classifies).
- `reason` — human-readable string shown to the user when the rule fires.
- `enabled` — defaults to `true`. Lets a user turn a rule off without deleting the entry.

```ts
type RuleTier = "hard_block" | "ask";
type RuleCategory = "file_read" | "file_write" | "shell_exec" | "git_push" | "network_call";

interface Rule {
  id: string;
  category: RuleCategory;
  pattern: string;
  tier: RuleTier;
  reason: string;
  enabled: boolean;
}

interface RuleSet {
  rules: Rule[];
}

interface NormalizedAction {
  category: RuleCategory;
  subject: string;
}

interface Decision {
  tier: "hard_block" | "ask" | "allow";
  rule?: Rule; // absent when tier === "allow"
}
```

## Built-in defaults

Shipped as ordinary, editable/deletable entries in the scaffolded file (not hardcoded
elsewhere) — a user deleting or disabling one is an explicit, visible choice on their own
machine, not a bypass. The scaffold's header comments explain the schema and note these are
defaults, safe to edit.

Conservative starter set:

1. Block writes to credential files: `.env`, `.ssh/**`, `.aws/**` (glob, `file_write`).
2. Block `git push --force` / `-f` (regex, `git_push`).
3. Block `rm -rf` on broad paths: `~`, `/`, project root (regex, `shell_exec`).
4. Block `git reset --hard` (regex, `shell_exec`).
5. Self-protection, rule A: block writes to `rules.yaml` itself — specific message
   ("editing the ruleset itself is blocked").
6. Self-protection, rule B: block writes anywhere under `~/.config/memora/**` — broad safety
   net covering the rest of Memora's config (can't work around rule A by deleting the
   directory or touching a backup).

All ship as `tier: hard_block`.

## Loading and scaffolding

`loadRuleSet(path = join(homedir(), ".config", "memora", "rules.yaml"))`:

1. If the file doesn't exist: create the parent directory (`mkdir(..., { recursive: true, mode:
   0o700 })`, matching the identity-key directory convention in `hookAdapter.ts`), write the
   scaffold template (defaults + doc comments) via the `yaml` package, then proceed to step 2.
2. Read and parse the file. Validate each rule entry (`category` is a known value, `tier` is
   `hard_block` or `ask`, `pattern` is a non-empty string, `id` is a non-empty string and unique
   in the file).
3. On a YAML parse error or a validation failure: don't throw and don't return an empty
   ruleset. Log a warning (via existing console error conventions) identifying the problem, and
   fall back to the in-memory built-in defaults from `defaults.ts`. This follows the epic's
   fail-safe principle — a broken config must not silently disable protection. Valid rules
   found alongside invalid ones are *not* partially loaded in this fallback case; the whole
   file is treated as broken to keep behavior simple and predictable. (If this proves too
   coarse in practice, per-rule skip-on-error can be revisited later — not needed for v1.)

## Engine

`evaluateAction(ruleSet, action)`:

1. Filter `ruleSet.rules` to `enabled` rules matching `action.category`.
2. Test `pattern` against `action.subject` per the category's matching semantics (glob for
   file categories, regex for the rest).
3. If any matching rule has `tier: hard_block`, return `{ tier: "hard_block", rule }` for the
   first such match — hard_block always wins over ask, per the epic.
4. Else if any matching rule has `tier: ask`, return `{ tier: "ask", rule }` for the first such
   match.
5. Else return `{ tier: "allow" }`.

No explicit allow-list tier in v1 — an action with no matching rule is implicitly allowed,
matching the epic's two-tier design (hard_block / ask only).

## Dependencies

Add `yaml` (npm) to `packages/local`'s `package.json` — used for both scaffold-writing and
parsing. No existing YAML dependency in the repo.

## Testing

Unit tests in `packages/local/src/rules/*.test.ts`, following the existing Vitest conventions
(see `hookConfig.test.ts`, `integrationDiagnostic.test.ts`):

- **Schema/loader**: scaffolds a fresh file when missing (dir created with `0o700`, file
  contains all six default rules); loads an existing valid file as-is; falls back to built-in
  defaults on invalid YAML; falls back to built-in defaults on a validation error (bad
  category/tier/missing id); a user-disabled (`enabled: false`) default rule is excluded from
  evaluation; a user-added custom rule is loaded and evaluated alongside defaults.
- **Engine precedence**: hard_block wins when both an ask and a hard_block rule match the same
  action; no match returns allow; disabled rules never match; each built-in default rule
  correctly matches its intended subject and correctly does *not* match an unrelated one (e.g.
  the force-push rule doesn't fire on a plain `git push`).
- **Self-protection rules**: writing to the rules.yaml path itself is hard_blocked; writing to
  another file under `~/.config/memora/` is hard_blocked; writing to an unrelated path is not
  affected by either.

## Out of scope (future issues)

- Producing `NormalizedAction` from real Claude/Codex tool calls (#29).
- Anything about *what happens* when tier is `ask` — dialog UI (#30) and hook wiring (#31)
  consume this module's `Decision` but are not built here.
- CLI commands for authoring/editing rules — v1 is hand-edited YAML only, per the epic.
- Per-project rule overrides — v1 is global-only, per the epic.
