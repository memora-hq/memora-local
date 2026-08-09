# @memora-hq/memora-local

The evidence-capture engine behind Memora's desktop app and CLI: records a live coding-agent
session (via a wrapped pseudo-terminal), stores it on disk, and produces the same signed,
verifiable evidence that [`@memora-hq/memora-verifier`](https://github.com/memora-hq/memora-sdk/tree/main/packages/verifier)
checks.

Most people don't install this directly — it arrives as a dependency of
[the `memora-local` CLI](../cli) or the desktop app. Install it yourself only if you're
building your own capture surface on top of the same evidence format.

## What's in here

| Module | Purpose |
|---|---|
| `run.ts` | Spawns a pseudo-terminal (`node-pty`) and captures a live session |
| `capture.ts` / `captureTier.ts` | Snapshots a project directory, classifies capture completeness |
| `hookAdapter.ts` / `hookTransport.ts` | Ingests editor/agent lifecycle hook events (Claude Code, Codex, Cursor, VS Code) |
| `receiptDoc.ts` / `summary.ts` | Renders a human-readable HTML receipt for a session |
| `integrationDiagnostic.ts` | Checks whether an editor/agent hook integration is correctly wired up |
| `eventTaxonomy.ts` | Classifies captured event types for presentation |
| `knownSigners.ts` | A local address book of previously-seen signing keys (continuity, not identity) |

Session store, identity, manifest signing, and bundle/session verification are **not**
reimplemented here — they come from `@memora-hq/memora-verifier`, this package's only Memora
dependency besides `@memora-hq/memora-protocol`.

## What's deliberately not here

Nothing about talking to Memora's hosted API, and nothing about verifying evidence you didn't
produce yourself — see `@memora-hq/memora-verifier` and
[`memora-sdk`](https://github.com/memora-hq/memora-sdk) for both.

## License

Apache-2.0
