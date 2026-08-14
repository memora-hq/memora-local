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
