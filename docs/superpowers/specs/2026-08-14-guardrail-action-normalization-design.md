# Per-adapter action normalization (#29)

Part of the cross-agent guardrail/policy layer epic (#32), second sub-issue after the rule
engine (#28). This spec covers only turning a raw Claude Code / Codex CLI tool-call hook
payload into `NormalizedAction[]` (the input type `evaluateAction` from #28 already consumes)
— not calling `evaluateAction`, and not wiring into the hook path (#31).

## Goal

A pure function that takes the raw JSON a `PreToolUse` hook receives on stdin and produces zero
or more normalized actions (`{ category, subject }`), so #31 can run each through #28's rule
engine.

## Research findings (verified, not guessed)

Claude Code and OpenAI Codex CLI's tool-call hook payloads share the same `tool_name` /
`tool_input` shape. Their tool-name vocabularies never collide: Codex only ever emits `Bash`,
`apply_patch`, or `mcp__*` tool names; Claude never emits `apply_patch`. This means normalization
does **not** need to branch on provider — one flat `tool_name → category` lookup table serves
both adapters, consistent with the epic's goal that rules are written once against normalized
categories regardless of which agent produced the action.

This repo's own test fixture (`packages/local/src/local.test.ts`) already demonstrates Codex's
shape concretely: `hook_event_name: "PostToolUse"`, `tool_name: "apply_patch"`, `tool_input: {
command: "*** Begin Patch..." }` — a unified diff-style text blob, not a simple file path.

## Module

New file `packages/local/src/rules/normalize.ts`:

```ts
export interface RawToolCall {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

export function normalizeToolCall(call: RawToolCall): NormalizedAction[];
```

Never throws. A malformed or unrecognized payload shape returns `[]` — "not evaluated,"
consistent with #28's "no matching rule = allow" semantics; this normalizer's job is only to
produce candidate actions, not to make allow/block decisions itself.

## Tool table

| `tool_name` | Category | Subject source |
|---|---|---|
| `Read` | `file_read` | `tool_input.file_path` |
| `Glob` | `file_read` | `tool_input.path` ?? `cwd` |
| `Grep` | `file_read` | `tool_input.path` ?? `cwd` |
| `Write` | `file_write` | `tool_input.file_path` |
| `Edit` | `file_write` | `tool_input.file_path` |
| `NotebookEdit` | `file_write` | `tool_input.notebook_path` |
| `WebFetch` | `network_call` | `tool_input.url` |
| `Bash` | `shell_exec` always; **additionally** `git_push` when the command matches `/\bgit\s+push\b/` | `tool_input.command` (both actions share the same subject) |
| `apply_patch` | `file_write`, one action per file | parsed from `tool_input.command` — every `*** Add File: <path>`, `*** Update File: <path>`, `*** Delete File: <path>` line, plus the target of any `*** Move to: <path>` line |
| anything else (`WebSearch`, `mcp__*`, `Task`, `TodoWrite`, unrecognized names) | — | `[]` — no meaningful path/host/command to extract in v1 |

`WebSearch` is deliberately excluded: its only field is a search `query` string, not a URL or
host a `network_call` rule could sensibly match.

**Bash/git_push overlap (locked decision):** a command like `git push --force` produces *both*
a `shell_exec` action and a `git_push` action, not just the more specific one. This lets a
generic `shell_exec` rule and a specific `git_push` rule both have a chance to fire on the same
command without either hiding the other.

**apply_patch multi-file (locked decision):** one `file_write` `NormalizedAction` per file
path found in the patch text, not one action for the whole blob. A rule protecting a specific
path (e.g. the self-protection rules from #28) fires even if that path is only one of several
files bundled into the same `apply_patch` call.

## Path resolution (locked decision)

Every extracted file-path subject is resolved to an absolute path via `path.resolve(cwd,
subject)` before being returned, using `call.cwd` (falling back to `process.cwd()` if `cwd` is
missing or not a string). Claude's `tool_input.file_path` is already absolute in practice, but
Codex's `apply_patch` paths and `Glob`/`Grep` path arguments can be relative — and #28's
`rules.yaml` patterns are authored as absolute globs (e.g. `~/.ssh/**`). An unresolved relative
subject would silently never match an absolute pattern, defeating the guardrail. `WebFetch`'s
`url` subject and `Bash`'s `command` subject are not paths and are not resolved.

## Testing

Table-driven tests in `packages/local/src/rules/normalize.test.ts`, one per tool-table row
above, plus:
- The `Bash` git-push overlap: a `git push --force` command produces both a `shell_exec` and a
  `git_push` action with the same subject.
- The `apply_patch` multi-file case: a patch touching two files produces two `file_write`
  actions, one per path.
- `Glob`/`Grep` cwd fallback when `tool_input.path` is absent.
- Relative-path resolution: a relative `file_path`/`apply_patch` path resolves against `cwd`.
- Unknown/unrecognized `tool_name` → `[]`.
- Malformed input (missing `tool_input`, non-string `command`, missing `cwd`) → `[]` or a safe
  fallback, never a thrown error.

## Out of scope (future issues)

- Calling `evaluateAction` on the produced actions, combining multiple actions' decisions into
  one, and acting on the result — all #31.
- MCP tool calls (`mcp__*`) and any tool not in the table above — not classified in v1.
- Any UI/dialog concerns — #30.
