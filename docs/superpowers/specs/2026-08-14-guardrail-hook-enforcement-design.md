# Wire enforcement into `local hook` (#31)

Final sub-issue of the cross-agent guardrail/policy layer epic (#32). This spec covers wiring
the rule engine (#28), action normalization (#29), and the approval dialog (#30) into the
actual `memora local hook` CLI path, so a matched `hard_block` or unapproved `ask` rule
genuinely denies a Claude Code / Codex tool call, not just theoretically evaluates it.

## Research: the actual block/deny protocol (verified, not guessed)

Both Claude Code and Codex CLI accept the same JSON on stdout with exit code 0:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "<human-readable reason>"
  }
}
```

Confirmed for Claude Code from the official hooks reference (code.claude.com/docs/en/hooks).
Confirmed for Codex CLI by reading `codex-rs/hooks/src/events/pre_tool_use.rs` directly,
including its own unit tests: the same JSON schema, exit 0, is honored identically. Codex also
honors an exit-code-2 + stderr legacy fallback (as does Claude Code), but this plan uses only
the documented JSON mechanism.

Critically, Codex's own tests (`unsupported_permission_decision_fails_open`) confirm it
explicitly rejects `permissionDecision: "ask"` and fails open (proceeds) — this is the exact
mechanism behind the epic's claim that "only deny is honored on PreToolUse," and it's why #30
built a Memora-owned dialog instead of ever emitting `"ask"` to either provider's hook protocol.
This plan's hook process only ever emits `"deny"` (or nothing, for allow) — never `"ask"`.

Not emitting anything (no JSON on stdout) is the implicit "allow" — this matches today's
existing purely-observational behavior for every hook call that isn't a guardrail-relevant
`PreToolUse` event, so no behavior changes for those.

## New module: `packages/local/src/rules/guardrail.ts`

```ts
export type GuardrailOutcome = "allow" | "hard_block" | "ask_approved" | "ask_denied";

export interface GuardrailDecision {
  outcome: GuardrailOutcome;
  rule?: Rule;
  denyReason?: string;
}

export function isGuardrailApplicable(
  provider: string,
  payload: { hook_event_name?: unknown },
  disabled: boolean,
): boolean;

export async function evaluateGuardrail(
  payload: RawToolCall,
  ruleSet: RuleSet,
  requestApprovalFn?: typeof requestApproval,
): Promise<GuardrailDecision>;
```

**`isGuardrailApplicable`** — pure, cheap gate, called before any filesystem I/O. `true` only
when: `provider` is `"codex"` or `"claude"` (the two terminal adapters `normalizeToolCall`
understands — editor adapters like `vscode`/`cursor` never fire `PreToolUse` at all, per
`adapters/registry.ts`'s `editorEventMap`); `payload.hook_event_name === "PreToolUse"`; and
`disabled` is `false`. The kill switch: `cmdLocalHook` computes `disabled` from
`Boolean(process.env.MEMORA_GUARDRAIL_DISABLED)` (any non-empty value disables enforcement
entirely, independent of `rules.yaml`'s content — a fast escape hatch if a bad rule or a bug
blocks something legitimate).

**`evaluateGuardrail`** — the decision logic, given it's already known to be applicable:
1. `normalizeToolCall(payload)` → zero or more `NormalizedAction`s.
2. For each action, `evaluateAction(ruleSet, action)`.
3. Reduce to the single most severe decision across all actions
   (`hard_block` > `ask` > `allow`; ties keep the first action reaching that severity, along
   with its matched rule and that action's specific subject). This is where #29's Bash
   git-push overlap (one call producing both a `shell_exec` and a `git_push` action) and
   apply_patch multi-file case (one call producing several `file_write` actions) actually
   resolve into a single decision for the whole tool call — not multiple dialogs, not multiple
   deny outputs.
4. `allow` → `{ outcome: "allow" }`.
5. `hard_block` → `{ outcome: "hard_block", rule, denyReason: rule.reason }`. No dialog shown.
6. `ask` → call `requestApprovalFn({ category: rule.category, subject, reason: rule.reason })`
   (defaults to #30's real `requestApproval`; injectable so tests never pop a real dialog).
   `approved: true` → `{ outcome: "ask_approved", rule }`. Otherwise, map the outcome's
   `reason` to a human string: `"denied"` → `"Denied by user"`, `"timeout"` → `"Approval
   request timed out"`, `"no_display"` → `"No display available to show approval prompt"` —
   all three produce `{ outcome: "ask_denied", rule, denyReason }`.

## Wiring in `packages/cli/src/cli.ts`'s `cmdLocalHook`

After parsing the stdin JSON payload (unchanged) and before the existing
`enqueueLocalHook`/daemon-autostart logic (both unchanged):

```
disabled := Boolean(process.env.MEMORA_GUARDRAIL_DISABLED)
if isGuardrailApplicable(provider, payload, disabled):
    ruleSet := loadRuleSet()
    decision := evaluateGuardrail(payload, ruleSet)
else:
    decision := { outcome: "allow" }   // not evaluated; the applicable gate itself is the record
```

The decision is merged into the payload **before** `enqueueLocalHook`, but only when it came
from an actual evaluation (i.e. `isGuardrailApplicable` was true) — payloads from inapplicable
events/providers are enqueued exactly as today, unchanged:

```
if isGuardrailApplicable(...):
    payload.memora_guardrail_decision := decision.outcome
    if decision.rule: payload.memora_guardrail_rule_id := decision.rule.id
await enqueueLocalHook(provider, payload)
```

This rides the existing `tool_requested` evidence event (added by `hookAdapter.ts`'s
`eventType`/`evidenceContent` mapping of the `PreToolUse` hook event) — zero changes to
`eventTaxonomy.ts`, `summary.ts`, or desktop timeline presentation code. A blocked action is
visible in session evidence, just not as its own dedicated timeline row.

After the (unchanged) daemon-autostart block, if the outcome is `hard_block` or `ask_denied`:

```
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: decision.denyReason,
  },
}));
```

Nothing is printed for `allow` or `ask_approved` — matches the existing implicit-allow default.
`cmdLocalHook` still exits 0 in every case (this is the documented mechanism; exit code is not
how denial is signaled).

## Testing

`guardrail.test.ts`:
- `isGuardrailApplicable`: true only for `codex`/`claude` + `PreToolUse` + not disabled; false
  for `vscode`/`cursor`, false for any other `hook_event_name`, false when `disabled` is true.
- `evaluateGuardrail`, using hand-built `RuleSet`s (no filesystem) and a fake
  `requestApprovalFn` (no real dialogs):
  - No matching rule → `allow`.
  - A `hard_block` rule match → `hard_block`, `requestApprovalFn` never called.
  - An `ask` rule match, fake resolves `{ approved: true }` → `ask_approved`.
  - An `ask` rule match, fake resolves `{ approved: false, reason: "denied" }` → `ask_denied`,
    `denyReason: "Denied by user"`.
  - Same for `"timeout"` → `"Approval request timed out"`, and `"no_display"` → `"No display
    available to show approval prompt"`.
  - A tool call producing multiple actions where one is `hard_block` and another is `ask`
    (e.g. a fabricated multi-action case) → `hard_block` wins, `requestApprovalFn` never
    called.
  - An unclassified tool (`normalizeToolCall` returns `[]`) → `allow`, `requestApprovalFn`
    never called.

`cmdLocalHook`'s own wiring in `cli.ts` is not unit-tested directly — `cli.ts` has no test seam
(`main()` executes at import time), the same situation already documented and accepted for
issue #22. All of the actual decision logic this issue adds is fully covered in
`guardrail.ts`'s tests; the `cli.ts` change is thin glue calling already-tested functions,
verified instead by a manual end-to-end smoke test (see below).

## Manual verification (not automated)

Since `cmdLocalHook`'s wiring can't be unit-tested, and this is the safety-critical path of the
whole epic, the implementation plan includes a manual smoke test: install a temporary
`hard_block` rule, install the real Claude Code hook via `local install-hooks`, and confirm a
matching tool call is actually denied end-to-end (not just that `evaluateGuardrail` returns the
right value in isolation).

## Out of scope

- Any UI for viewing guardrail decisions in the desktop app's timeline (evidence is captured,
  but no dedicated presentation work is part of this issue).
- Codex's exit-code-2/stderr legacy deny path — not used, since the JSON mechanism is
  documented and confirmed working on both providers.
- Any change to `PermissionRequest`/`PostToolUse`/other hook events — this issue only adds
  decision logic to `PreToolUse`.
