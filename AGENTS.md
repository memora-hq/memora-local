# AGENTS.md — memora-local

Guidance for AI coding agents working in this repository. This is the desktop/capture half of a
larger system; the hosted counterpart (`memora-cloud`, closed-source) and the client SDK
(`memora-sdk`, public) are separate repos this one only ever *consumes* npm packages from, never
imports source from directly.

## What's in here, and why node-pty lives here specifically

- `packages/local` (`@memora-hq/memora-local`) — the capture engine: `run.ts` spawns a PTY
  (`node-pty`) and records a live session; `capture.ts`/`captureTier.ts` snapshot a project
  directory; `hookAdapter.ts`/`hookTransport.ts` ingest editor/agent lifecycle hooks;
  `receiptDoc.ts`/`summary.ts` render human-readable output; `integrationDiagnostic.ts` checks
  whether an editor/agent integration is wired up correctly. It depends on
  `@memora-hq/memora-verifier` (from `memora-sdk`, published on npm) for bundle/session
  verification rather than reimplementing it.
- `packages/cli` (`@memora-hq/memora-local-cli`) — the full `memora` binary: every command
  `memora-sdk`'s CLI has, plus `local run`/`receipt`/`hook`/`doctor`, which need
  `@memora-hq/memora-local` and are the reason this CLI is a separate, heavier package rather
  than something `memora-sdk` ships.
- `apps/desktop` — Electron app. Bundles `packages/cli`'s built output as an `extraResource`
  and installs it as the `memora` launcher at `~/.local/bin/memora`; editor/agent hooks
  (`hookConfig.ts`) and VS Code/Cursor (`apps/vscode-extension`) both shell out to that
  launcher rather than importing `packages/local` directly.
- `apps/vscode-extension` — thin (`extension.cjs`, CommonJS, no dependencies at all): spawns
  the installed `memora` CLI on editor lifecycle events. If you're tempted to give it a real
  dependency on `packages/local`, don't — the whole point of routing through the CLI binary is
  that the extension's sandboxed renderer-adjacent process never needs Node-native modules.

## What must never happen in this repo

**No import of `@memora/shared`, `@memora/indexer`, `@memora/gateway`, `@memora/key-broker`,
`@memora/contracts`, or anything from `apps/web`** (Memora Cloud's private tier), and no
occurrence of `MEMORA_KEK`, `MEMORA_SERVICE_HMAC_SECRET`, `MEMORA_WRITE_SECRET`,
`HEDERA_OPERATOR_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or `/rest/v1/`. `scripts/check-private-
boundary.mjs` enforces this in CI; it should always report 0 violations. (This is the mirror
image of `memora-sdk`'s `check-local-boundary.mjs` — that repo checks for the *absence* of
node-pty/Electron; this repo is supposed to have both, and instead checks for the absence of
private-infrastructure leakage.)

## Cross-repo dependencies

`@memora-hq/memora-protocol` and `@memora-hq/memora-verifier` (and, in `packages/cli`,
`@memora-hq/memora-core`) are real npm dependencies here, not workspace links — this repo has
no `packages/protocol`, `packages/verifier`, or `packages/sdk` directories of its own. Bump
pinned versions deliberately. As of this repo's creation, `@memora-hq/memora-verifier` and the
split-aware `@memora-hq/memora-core` have not been published yet (see the private
`memora-cloud` repo's OSS-split tracking) — the version pins here are the *intended* next
versions, not resolvable from a truly clean external clone until that publish happens.

## Naming note

`apps/vscode-extension`'s own `package.json` name is `"memora-local"` (unscoped, VS Code
Marketplace convention) — this predates the repo split and is an unrelated namespace from the
scoped npm packages (`@memora-hq/memora-local`, etc.) above. Don't conflate the two when
searching for "memora-local" in either context.

## What does NOT belong in this repo

Anything about write authorization policy, key custody, Supabase/database schemas,
service-to-service authentication, or hosted-service operational concerns (`memora-cloud`);
talking to Memora's hosted API or offline bundle/session verification without the capture
engine (`memora-sdk`).
