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
