# Local search over captured session history (#25)

Adds `memora local search <query>`: keyword/full-text search across all local sessions'
decrypted event content, so prior execution traces can inform new work instead of being
write-only audit history. First-pass scope per the issue: full-text/keyword only — no semantic
similarity, no efficiency scoring, no time/token estimates (those need new capture and outcome
labeling, tracked separately).

## Why an incremental encrypted index, not a lazy full scan

A lazy per-search full scan (decrypt every event across every session on every search call) was
considered and rejected: it gets slower as the local evidence store grows, and repeated searches
redo the same decryption work. An incremental index avoids that, at the cost of real complexity
this spec addresses head-on: keeping the index in sync as events are recorded, and handling
corruption/staleness without a separate manual rebuild step (see "Self-healing" below).

## Index storage

One small encrypted file per session: `<dataRoot>/search-index/<sessionId>.json`.

```ts
interface SearchIndexEntry {
  event_id: string;
  event_type: string;
  observed_at: string;
  searchable_text: string; // JSON.stringify(decrypted event content)
}

interface SessionSearchIndexFile {
  format: "memora.local.search-index";
  version: 1;
  session_id: string;
  entries: SearchIndexEntry[];
}
```

Encrypted at rest with AES-256-GCM via `encrypt`/`decrypt` from `@memora-hq/memora-protocol`,
using the same `deriveLocalEncryptionKey(identity)` key already used for event payloads — this
index is derived from evidence content, so it stays inside the same trust boundary. It is
**not** stored through `LocalEvidenceStore`'s payload API (that's for evidence objects proper);
it's Memora-local's own derived cache, following the exact pattern `knownSigners.ts` already
uses for its own JSON file: `mkdir(..., { recursive: true, mode: 0o700 })`, atomic
temp-file-then-`rename` write, `0o600` file mode, and a `read()` that treats any parse/decrypt
failure as "empty" rather than throwing — corruption degrades gracefully, it doesn't break
search.

`searchable_text` is deliberately just `JSON.stringify(content)` of the decrypted event's
content — no field curation (no picking out just "prompt" or "tool_input" the way
`eventDetail.ts` does for display). This keeps indexing simple and guarantees nothing searchable
gets silently excluded because a field name wasn't anticipated.

## Real-time incremental update

`packages/local/src/hookAdapter.ts`'s `ingestLocalHook` is the one recording path this repo's
own code owns for the "deep" tier adapters (`codex`, `claude` — terminal hook capture, by far
the dominant capture path). Immediately after the existing `session.record(...)` call, **inside
the same `withLock` critical section** that already serializes writes for that session, append
a new `SearchIndexEntry` (built from the same `eventType(...)`/`evidenceContent(...)` values
already computed there) to that session's index file. Appends are idempotent by `event_id`, so
a retried hook call can't duplicate an entry.

**Deliberate scope boundary, stated explicitly rather than left as a silent gap:** `local run`'s
PTY-wrapper capture path (`packages/local/src/run.ts`, used for `memora local run -- <command>`)
is a second, less common event-recording path. This plan does not add a real-time incremental
hook there. It doesn't need one — see Self-healing below — but its indexing is lazy (built on
first search after the fact) rather than real-time.

## Self-healing backfill (replaces a manual rebuild command)

At search time, for each session: compare the index file's entry count (or absence) against
that session's actual event count (`manifest.event_ids.length` / `readEvents` length, both
cheap metadata reads with no decryption involved). Any gap — missing index file, an index
that's behind (events recorded before this feature existed, or via the un-hooked `run.ts`
path, or from an interrupted process), or a corrupt/undecryptable index file — is repaired by
decrypting exactly the missing events (`store.readPayload` + `decrypt`, the same mechanism
`apps/desktop/src/main/main.ts`'s `decryptEventPayload` already uses) and appending them to the
index, which is then rewritten once. This means:
- No separate `--rebuild-index` command is needed.
- The very first search over a pre-existing evidence store (from before this feature shipped)
  transparently builds full indexes for every session, at a one-time cost proportional to that
  session's event count — every search after that is fast.
- A corrupted or deleted index file is not a failure mode a user or agent needs to reason
  about — it silently self-repairs on the next search.

## Command

```
memora local search <query> [--json] [--limit N]
```

- Requires a local identity to already exist (same precondition `local export --disclose`
  already has) — errors with the same "run `memora local init` first" message pattern if
  missing.
- Case-insensitive substring match of `query` against each entry's `searchable_text` across
  every session (`store.listSessions()`), after ensuring that session's index is up to date per
  the self-healing logic above.
- Default output: one line per match — session id, event type, timestamp, and a short snippet
  of `searchable_text` centered on the match (grep-style, truncated with ellipses on either
  side).
- `--json`: emits an array of structured match objects (`session_id`, `event_id`, `event_type`,
  `observed_at`, `snippet`) instead — for the issue's other stated motivation, an agent
  searching its own past traces programmatically rather than a human reading terminal output.
- `--limit N` (default 50): caps the number of results returned, across all sessions combined,
  to keep output bounded on a large local history.

## Module layout

- `packages/local/src/searchIndex.ts` — `SearchIndexEntry`, `SessionSearchIndexFile` types;
  a small store class (mirroring `KnownSignerStore`'s shape) with `read`/`write`/`append`
  methods; `buildSearchIndexEntry(eventType, observedAt, content)`; and
  `ensureSearchIndexUpToDate(store, indexStore, sessionId, events, key)` — the backfill/repair
  entry point the CLI search command calls.
- `packages/local/src/hookAdapter.ts` — modified to append to the index inside `ingestLocalHook`,
  as described above.
- `packages/cli/src/cli.ts` — new `cmdLocalSearch` and `local search` subcommand wiring.

## Testing

- `searchIndex.test.ts`: read/write/append round-trip (using a real in-memory-derived key, not a
  mock, since the encrypt/decrypt round-trip correctness is exactly what needs verifying);
  append is idempotent by `event_id`; `read` returns a graceful "empty" result (not a throw) for
  a missing file, a corrupt/unparseable file, and a file encrypted with a different key;
  `ensureSearchIndexUpToDate` backfills missing entries without re-decrypting already-indexed
  ones (verifiable by asserting `store.readPayload` is called only for the missing event ids,
  using a spy).
- `hookAdapter.test.ts` (existing file, extended): a `PreToolUse`/`PostToolUse` hook event
  ingested via `ingestLocalHook` results in a search index entry for that session containing the
  expected `searchable_text`.
- `cli.ts`'s `cmdLocalSearch` wiring itself is not unit-tested directly (no test seam, same
  precedent as #22/#31) — verified instead by a manual end-to-end smoke test: run a couple of
  real hook events through `local hook`, then `local search` for a known substring and confirm
  it's found, including after deleting the index file to confirm self-healing recovers it.

## Out of scope

- Semantic/similarity search, "which approach was more efficient" scoring, time/token estimates
  — explicitly deferred to the separate token/time estimation issue (#26) per the issue's own
  scope note.
- Any UI in the desktop app for search — CLI only for this issue.
- Indexing the `local run` PTY-wrapper capture path in real time (see the deliberate scope
  boundary above) — covered by lazy backfill instead.
