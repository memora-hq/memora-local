# Local Search Over Session History (#25) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `memora local search <query>`, a keyword/full-text search across all local
sessions' decrypted event content, backed by a self-healing, incrementally-updated per-session
encrypted index.

**Architecture:** New `packages/local/src/searchIndex.ts` holds the index file format, the
`SearchIndexStore` read/write/append class (mirroring `knownSigners.ts`'s conventions), and
`ensureSearchIndexUpToDate` (the backfill/self-heal logic). `hookAdapter.ts`'s `ingestLocalHook`
gets one new append call inside its existing lock. `cli.ts` gets a new `cmdLocalSearch` and
`local search` subcommand.

**Tech Stack:** TypeScript, `@memora-hq/memora-protocol`'s `encrypt`/`decrypt`/`generateAesKey`,
`@memora-hq/memora-verifier`'s `deriveLocalEncryptionKey`, Vitest. No new dependencies.

## Global Constraints

- Index file: `<dataRoot>/search-index/<sessionId>.json`, one per session, holding
  `{ format: "memora.local.search-index", version: 1, session_id, entries: SearchIndexEntry[] }`
  where `SearchIndexEntry = { event_id, event_type, observed_at, searchable_text }`.
- Encrypted at rest via `encrypt`/`decrypt` (AES-256-GCM) using
  `deriveLocalEncryptionKey(identity)` — the same key event payloads use.
- File writes: `mkdir(..., { recursive: true, mode: 0o700 })`, atomic temp-file-then-`rename`,
  `0o600` file mode — matching `knownSigners.ts`'s exact conventions.
- Any read failure (missing file, unparseable JSON, wrong-key decrypt failure) degrades
  gracefully to an empty index — never throws. This is the mechanism that makes corruption
  self-healing rather than a failure mode.
- `searchable_text` is `JSON.stringify(content)` of the decrypted event content — no field
  curation.
- The real-time append inside `ingestLocalHook` is best-effort: wrapped in its own try/catch
  that never lets a search-index failure break evidence capture (the load-bearing path). A
  missed append is recovered later by the backfill.
- `ensureSearchIndexUpToDate` only decrypts (`store.readPayload`) events missing from the
  index — never re-decrypts already-indexed ones.
- `local search` requires a local identity to exist (errors with the same message pattern as
  `local export --disclose`'s missing-identity case).
- `cmdLocalSearch`'s own wiring in `cli.ts` is not unit-tested directly (no test seam, same
  precedent as #22/#31) — verified by a manual end-to-end smoke test instead.

---

## File Structure

- Create: `packages/local/src/searchIndex.ts`
- Create: `packages/local/src/searchIndex.test.ts`
- Modify: `packages/local/src/hookAdapter.ts`
- Modify: `packages/local/src/local.test.ts` — extend with an incremental-indexing test.
- Modify: `packages/local/src/index.ts` — add `searchIndex.js` export.
- Modify: `packages/cli/src/cli.ts` — new `cmdLocalSearch`, subcommand wiring, imports.

---

## Task 1: Search index storage and self-healing backfill

**Files:**
- Create: `packages/local/src/searchIndex.ts`
- Test: `packages/local/src/searchIndex.test.ts`

**Interfaces:**
- Consumes: `encrypt`, `decrypt` from `@memora-hq/memora-protocol`; `LocalEvidenceStore`,
  `LocalEventRecordV1` types from `@memora-hq/memora-verifier`/`@memora-hq/memora-protocol`.
- Produces: `SearchIndexEntry`, `SessionSearchIndexFile` types; `searchIndexPath(dataRoot,
  sessionId): string`; `SearchIndexStore` class with `read`/`write`/`append`, and a public
  `readonly key: Buffer`; `buildSearchIndexEntry(eventType, observedAt, eventId, content):
  SearchIndexEntry`; `ensureSearchIndexUpToDate(store, indexStore, sessionId, events):
  Promise<SessionSearchIndexFile>`. Consumed by `hookAdapter.ts` (Task 2) and `cli.ts`
  (Task 3).

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/local/src/searchIndex.test.ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateAesKey } from "@memora-hq/memora-protocol";
import {
  deriveLocalEncryptionKey,
  FileKeyProvider,
  getOrCreateIdentity,
  LocalEvidenceStore,
  LocalSession,
} from "@memora-hq/memora-verifier";
import {
  buildSearchIndexEntry,
  ensureSearchIndexUpToDate,
  SearchIndexStore,
  searchIndexPath,
} from "./searchIndex.js";

describe("SearchIndexStore", () => {
  it("round-trips a written index through read", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-search-index-"));
    const store = new SearchIndexStore(root, generateAesKey());
    const entry = buildSearchIndexEntry("tool_completed", "2026-01-01T00:00:00.000Z", "event-1", { tool: "Write" });
    await store.append("session-1", entry);
    const index = await store.read("session-1");
    expect(index.entries).toEqual([entry]);
  });

  it("does not duplicate an entry appended twice with the same event_id", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-search-index-"));
    const store = new SearchIndexStore(root, generateAesKey());
    const entry = buildSearchIndexEntry("tool_completed", "2026-01-01T00:00:00.000Z", "event-1", { tool: "Write" });
    await store.append("session-1", entry);
    await store.append("session-1", entry);
    const index = await store.read("session-1");
    expect(index.entries).toHaveLength(1);
  });

  it("writes the index file at the expected path, encrypted (not plaintext)", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-search-index-"));
    const store = new SearchIndexStore(root, generateAesKey());
    await store.append("session-1", buildSearchIndexEntry("tool_completed", "2026-01-01T00:00:00.000Z", "event-1", { secret: "marker-xyz" }));
    const raw = await readFile(searchIndexPath(root, "session-1"), "utf8");
    expect(raw).not.toContain("marker-xyz");
    expect(JSON.parse(raw)).toHaveProperty("ciphertext");
  });

  it("returns an empty index for a missing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-search-index-"));
    const store = new SearchIndexStore(root, generateAesKey());
    const index = await store.read("never-written");
    expect(index.entries).toEqual([]);
  });

  it("returns an empty index for a corrupt file rather than throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-search-index-"));
    const store = new SearchIndexStore(root, generateAesKey());
    await store.append("session-1", buildSearchIndexEntry("x", "2026-01-01T00:00:00.000Z", "e1", {}));
    await writeFile(searchIndexPath(root, "session-1"), "not json");
    const index = await store.read("session-1");
    expect(index.entries).toEqual([]);
  });

  it("returns an empty index when read with a different key than it was written with", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-search-index-"));
    const writer = new SearchIndexStore(root, generateAesKey());
    await writer.append("session-1", buildSearchIndexEntry("x", "2026-01-01T00:00:00.000Z", "e1", {}));
    const reader = new SearchIndexStore(root, generateAesKey());
    const index = await reader.read("session-1");
    expect(index.entries).toEqual([]);
  });
});

async function sessionFixture() {
  const root = await mkdtemp(join(tmpdir(), "memora-search-index-session-"));
  const store = new LocalEvidenceStore(root);
  const keys = new FileKeyProvider(join(root, "identity", "key.json"));
  const identity = await getOrCreateIdentity(keys, "test");
  const session = new LocalSession({ store, identity, captureRoot: root });
  await session.start();
  await session.record("tool_completed", { tool: "Write", file: "backfill-marker.ts" }, "adapter_reported");
  await session.finish("complete");
  return { root, store, identity };
}

describe("ensureSearchIndexUpToDate", () => {
  it("backfills a session with no existing index from real decrypted events", async () => {
    const { root, store, identity } = await sessionFixture();
    const indexStore = new SearchIndexStore(root, deriveLocalEncryptionKey(identity));
    const manifest = (await store.listSessions())[0];
    const events = await store.readEvents(manifest.session_id);
    const index = await ensureSearchIndexUpToDate(store, indexStore, manifest.session_id, events);
    expect(index.entries.some((entry) => entry.searchable_text.includes("backfill-marker.ts"))).toBe(true);
  });

  it("does not re-decrypt already-indexed events on a second call", async () => {
    const { root, store, identity } = await sessionFixture();
    const indexStore = new SearchIndexStore(root, deriveLocalEncryptionKey(identity));
    const manifest = (await store.listSessions())[0];
    const events = await store.readEvents(manifest.session_id);
    await ensureSearchIndexUpToDate(store, indexStore, manifest.session_id, events);

    const spy = vi.spyOn(store, "readPayload");
    await ensureSearchIndexUpToDate(store, indexStore, manifest.session_id, events);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/searchIndex.test.ts`
Expected: FAIL — `Cannot find module './searchIndex.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/local/src/searchIndex.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decrypt, encrypt } from "@memora-hq/memora-protocol";
import type { LocalEventRecordV1 } from "@memora-hq/memora-protocol";
import type { LocalEvidenceStore } from "@memora-hq/memora-verifier";

export interface SearchIndexEntry {
  event_id: string;
  event_type: string;
  observed_at: string;
  searchable_text: string;
}

export interface SessionSearchIndexFile {
  format: "memora.local.search-index";
  version: 1;
  session_id: string;
  entries: SearchIndexEntry[];
}

function empty(sessionId: string): SessionSearchIndexFile {
  return { format: "memora.local.search-index", version: 1, session_id: sessionId, entries: [] };
}

export function searchIndexPath(dataRoot: string, sessionId: string): string {
  return join(dataRoot, "search-index", `${sessionId}.json`);
}

export function buildSearchIndexEntry(
  eventType: string,
  observedAt: string,
  eventId: string,
  content: Record<string, unknown>,
): SearchIndexEntry {
  return { event_id: eventId, event_type: eventType, observed_at: observedAt, searchable_text: JSON.stringify(content) };
}

export class SearchIndexStore {
  constructor(private readonly dataRoot: string, readonly key: Buffer) {}

  private path(sessionId: string): string {
    return searchIndexPath(this.dataRoot, sessionId);
  }

  async read(sessionId: string): Promise<SessionSearchIndexFile> {
    try {
      const bundle = JSON.parse(await readFile(this.path(sessionId), "utf8"));
      const parsed = JSON.parse(decrypt(bundle, this.key)) as Partial<SessionSearchIndexFile>;
      if (!Array.isArray(parsed.entries)) return empty(sessionId);
      return { ...empty(sessionId), entries: parsed.entries };
    } catch {
      // Missing, unparseable, or undecryptable (e.g. wrong key): treated as an empty index.
      // ensureSearchIndexUpToDate backfills it from real events — this is the self-healing
      // mechanism, not a failure mode.
      return empty(sessionId);
    }
  }

  async write(file: SessionSearchIndexFile): Promise<void> {
    const path = this.path(file.session_id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const bundle = encrypt(JSON.stringify(file), this.key);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(bundle), { mode: 0o600 });
    await rename(temp, path);
  }

  async append(sessionId: string, entry: SearchIndexEntry): Promise<void> {
    const file = await this.read(sessionId);
    if (file.entries.some((existing) => existing.event_id === entry.event_id)) return;
    await this.write({ ...file, session_id: sessionId, entries: [...file.entries, entry] });
  }
}

export async function ensureSearchIndexUpToDate(
  store: LocalEvidenceStore,
  indexStore: SearchIndexStore,
  sessionId: string,
  events: LocalEventRecordV1[],
): Promise<SessionSearchIndexFile> {
  const index = await indexStore.read(sessionId);
  const indexed = new Set(index.entries.map((entry) => entry.event_id));
  const missing = events.filter((event) => !indexed.has(event.commit.event_id ?? event.commit.memory_id));
  if (!missing.length) return index;

  const newEntries: SearchIndexEntry[] = [];
  for (const event of missing) {
    const eventId = event.commit.event_id ?? event.commit.memory_id;
    try {
      const objectId = event.commit.cid_ciphertext.replace("local:sha256:", "");
      const encrypted = await store.readPayload(sessionId, objectId);
      const payload = JSON.parse(decrypt(encrypted, indexStore.key)) as { content?: unknown };
      const content = payload.content && typeof payload.content === "object" ? payload.content as Record<string, unknown> : {};
      newEntries.push(buildSearchIndexEntry(event.commit.event_type ?? "event", event.observed_at, eventId, content));
    } catch {
      // Unreadable/undecryptable payload for this one event: skip it rather than fail the
      // whole backfill.
    }
  }
  const updated: SessionSearchIndexFile = { ...index, session_id: sessionId, entries: [...index.entries, ...newEntries] };
  await indexStore.write(updated);
  return updated;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/searchIndex.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/local/src/searchIndex.ts packages/local/src/searchIndex.test.ts
git commit -m "Add self-healing encrypted search index for local session history"
```

---

## Task 2: Real-time incremental indexing in `ingestLocalHook`

**Files:**
- Modify: `packages/local/src/hookAdapter.ts`
- Modify: `packages/local/src/local.test.ts`

**Interfaces:**
- Consumes: `SearchIndexStore`, `buildSearchIndexEntry` from `./searchIndex.js`;
  `deriveLocalEncryptionKey` (already available from `@memora-hq/memora-verifier`, added to
  the existing import).

- [ ] **Step 1: Write the failing test**

Add to `packages/local/src/local.test.ts`'s existing `import` block (extend the
`@memora-hq/memora-verifier` import with `deriveLocalEncryptionKey`, and add a new import for
`SearchIndexStore`):

```typescript
import {
  FileKeyProvider,
  getOrCreateIdentity,
  LocalEvidenceStore,
  LocalSession,
  verifySession,
  exportLocalBundle,
  readLocalBundle,
  verifyBundle,
  deriveLocalEncryptionKey,
} from "@memora-hq/memora-verifier";
import { SearchIndexStore } from "./searchIndex.js";
```

Then add this test near the existing `"joins lifecycle hook events into one verifiable adapter
session"` test:

```typescript
it("incrementally indexes hook events for search as they're ingested", async () => {
  const root = await mkdtemp(join(tmpdir(), "memora-search-incremental-"));
  const result = await ingestLocalHook(root, "codex", {
    session_id: "codex-session-search",
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_name: "apply_patch",
    tool_input: { command: "*** Update File: secret-marker-xyz.ts" },
  });
  const identity = await getOrCreateIdentity(new FileKeyProvider(join(root, "identity", "local-key.json")));
  const key = deriveLocalEncryptionKey(identity);
  const index = await new SearchIndexStore(root, key).read(result.localSessionId);
  expect(index.entries.some((entry) => entry.searchable_text.includes("secret-marker-xyz.ts"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/local.test.ts -t "incrementally indexes"`
Expected: FAIL — the index is empty because `ingestLocalHook` doesn't append to it yet.

- [ ] **Step 3: Wire the append into `ingestLocalHook`**

In `packages/local/src/hookAdapter.ts`, add to the existing import from
`"@memora-hq/memora-verifier"`:

```typescript
import { FileKeyProvider, getOrCreateIdentity, LocalSession, LocalEvidenceStore, deriveLocalEncryptionKey } from "@memora-hq/memora-verifier";
```

And add a new import line:

```typescript
import { buildSearchIndexEntry, SearchIndexStore } from "./searchIndex.js";
```

Replace the body from `const hookEvent = ...` to the end of the `withLock` callback (currently
lines 78-81) with:

```typescript
    const hookEvent = typeof input.hook_event_name === "string" ? input.hook_event_name : "event";
    const type = eventType(provider, hookEvent);
    const content = evidenceContent(provider, input);
    const eventId = await session.record(type, content, "adapter_reported");
    try {
      const key = deriveLocalEncryptionKey(identity);
      await new SearchIndexStore(dataRoot, key).append(
        localSessionId,
        buildSearchIndexEntry(type, new Date().toISOString(), eventId, content),
      );
    } catch {
      // Best-effort: a search-index failure must never break evidence capture, which is the
      // load-bearing path here. ensureSearchIndexUpToDate backfills any entry missed this way
      // the next time `local search` runs.
    }
    await session.checkpoint("partial");
    return { localSessionId, eventId };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/local.test.ts -t "incrementally indexes"`
Expected: PASS.

- [ ] **Step 5: Run the full local.test.ts file to confirm no regressions**

Run: `pnpm --filter @memora-hq/memora-local exec vitest run src/local.test.ts`
Expected: PASS, all tests in the file green (existing tests plus the new one).

- [ ] **Step 6: Commit**

```bash
git add packages/local/src/hookAdapter.ts packages/local/src/local.test.ts
git commit -m "Incrementally index hook events for local search as they're ingested"
```

---

## Task 3: `memora local search` command and exports

**Files:**
- Modify: `packages/local/src/index.ts`
- Modify: `packages/cli/src/cli.ts`

**Interfaces:**
- Consumes: `SearchIndexStore`, `ensureSearchIndexUpToDate` from `@memora-hq/memora-local`;
  `deriveLocalEncryptionKey` (add to the existing `@memora-hq/memora-verifier` import in
  `cli.ts`).

No new automated test for `cmdLocalSearch` itself — no test seam in `cli.ts` (see Global
Constraints). Verified by the manual smoke test in Final Verification.

- [ ] **Step 1: Add the package export**

Edit `packages/local/src/index.ts`, append after the existing `export * from
"./rules/guardrail.js";` line:

```typescript
export * from "./searchIndex.js";
```

- [ ] **Step 2: Add cli.ts imports**

Add `deriveLocalEncryptionKey` to `cli.ts`'s existing `@memora-hq/memora-verifier` import
block:

```typescript
import {
  FileKeyProvider,
  LocalEvidenceStore,
  LocalSession,
  exportLocalBundle,
  readLocalBundle,
  getOrCreateIdentity,
  verifySession,
  verifyBundle,
  deriveLocalEncryptionKey,
} from "@memora-hq/memora-verifier";
```

Add `SearchIndexStore` and `ensureSearchIndexUpToDate` to the existing
`@memora-hq/memora-local` import block, in alphabetical position:

```typescript
  ensureSearchIndexUpToDate,
  ...
  SearchIndexStore,
```

- [ ] **Step 3: Write `cmdLocalSearch`**

Add this function near `cmdLocalShow` in `packages/cli/src/cli.ts`:

```typescript
function snippetAround(text: string, index: number, matchLength: number, radius = 40): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchLength + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

interface LocalSearchResult {
  session_id: string;
  event_id: string;
  event_type: string;
  observed_at: string;
  snippet: string;
}

async function cmdLocalSearch(query: string, json: boolean, limit: number) {
  const paths = localPaths();
  const identity = await paths.keys.load();
  if (!identity) throw new Error("no local identity on this device — run `memora local init` first");
  const key = deriveLocalEncryptionKey(identity);
  const indexStore = new SearchIndexStore(paths.root, key);
  const needle = query.toLowerCase();
  const results: LocalSearchResult[] = [];

  for (const manifest of await paths.store.listSessions()) {
    if (results.length >= limit) break;
    const events = await paths.store.readEvents(manifest.session_id);
    const index = await ensureSearchIndexUpToDate(paths.store, indexStore, manifest.session_id, events);
    for (const entry of index.entries) {
      if (results.length >= limit) break;
      const matchIndex = entry.searchable_text.toLowerCase().indexOf(needle);
      if (matchIndex === -1) continue;
      results.push({
        session_id: manifest.session_id,
        event_id: entry.event_id,
        event_type: entry.event_type,
        observed_at: entry.observed_at,
        snippet: snippetAround(entry.searchable_text, matchIndex, needle.length),
      });
    }
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (!results.length) { console.log("No matches."); return; }
  for (const result of results) {
    console.log(`${result.session_id}\t${result.event_type}\t${result.observed_at}\t${result.snippet}`);
  }
}
```

- [ ] **Step 4: Wire the subcommand**

In `packages/cli/src/cli.ts`'s command dispatch chain, add a new branch after the existing
`cmd === "local" && sub === "doctor"` branch:

```typescript
    } else if (cmd === "local" && sub === "search") {
      const query = args[2];
      if (!query) throw new Error("<query> required");
      const limitArg = getArg("--limit");
      const limit = limitArg ? Number(limitArg) : 50;
      if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
      await cmdLocalSearch(query, hasFlag("--json"), limit);
```

- [ ] **Step 5: Build and run the full test suite**

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run build && pnpm --filter @memora-hq/memora-local --filter ./packages/cli run test`
Expected: both builds `Done`; all test files pass, including `src/searchIndex.test.ts`
alongside the existing 27 test files in `packages/local` (28 total), 0 failures.

- [ ] **Step 6: Commit**

```bash
git add packages/local/src/index.ts packages/cli/src/cli.ts
git commit -m "Add memora local search command"
```

---

## Final Verification

- [ ] Run the full monorepo test suite for the two affected packages:

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run test`
Expected: all test files pass, no regressions.

- [ ] Run the build:

Run: `pnpm --filter @memora-hq/memora-local --filter ./packages/cli run build`
Expected: `Done` for both packages.

- [ ] **Manual end-to-end smoke test**, entirely isolated under `/tmp` — confirms real
  indexing, real search, and self-healing after deleting the index:

```bash
rm -rf /tmp/memora-search-smoke
export MEMORA_LOCAL_DATA_DIR=/tmp/memora-search-smoke
node packages/cli/dist/cli.js local init

echo '{"hook_event_name":"SessionStart","session_id":"smoke-session","cwd":"/tmp/memora-search-smoke"}' \
  | node packages/cli/dist/cli.js local hook --provider claude
echo '{"hook_event_name":"PostToolUse","session_id":"smoke-session","cwd":"/tmp/memora-search-smoke","tool_name":"Write","tool_input":{"file_path":"/tmp/memora-search-smoke/needle-marker.ts"}}' \
  | node packages/cli/dist/cli.js local hook --provider claude

node packages/cli/dist/cli.js local search needle-marker
```

Expected: one result line mentioning `needle-marker.ts`, the session id, event type
`tool_completed`, and a timestamp.

Then confirm self-healing:

```bash
rm -rf /tmp/memora-search-smoke/search-index
node packages/cli/dist/cli.js local search needle-marker
```

Expected: the same result reappears — the index file was deleted, and the search command
transparently rebuilt it from the real (still-encrypted) event payloads.

Also confirm `--json`:

```bash
node packages/cli/dist/cli.js local search needle-marker --json
```

Expected: a JSON array with one object containing `session_id`, `event_id`, `event_type`,
`observed_at`, `snippet`.

Clean up: `rm -rf /tmp/memora-search-smoke`.

- [ ] Close out the issue:

```bash
gh issue close 25 --comment "memora local search <query> [--json] [--limit N] implemented. Self-healing per-session encrypted search index (packages/local/src/searchIndex.ts): incrementally updated in real time from hookAdapter.ts's ingestLocalHook (inside the existing per-session lock, best-effort so it can never break evidence capture), with automatic backfill at search time for any missing/stale/corrupt index (no manual rebuild command needed) - covers both pre-existing sessions from before this feature and the local run PTY-wrapper capture path, which isn't hooked in real time. Full unit coverage of the index store and backfill logic (including a wrong-key decrypt-failure case and a spy-verified no-redundant-decryption case); cli.ts wiring itself has no test seam (same as #22/#31) and was verified via a manual end-to-end smoke test covering search, --json output, and self-healing after deleting the index file. See docs/superpowers/specs/2026-08-14-local-search-design.md for the design. Semantic search, efficiency scoring, and time/token estimates remain out of scope per the issue's own framing (tracked separately in #26)."
```
