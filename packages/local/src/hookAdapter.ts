import { createHash } from "node:crypto";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAdapter } from "./adapters/registry.js";
import { FileKeyProvider, getOrCreateIdentity, LocalSession, LocalEvidenceStore } from "@memora-hq/memora-verifier";

export type LocalHookProvider = string;

export interface LocalHookInput {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  [key: string]: unknown;
}

function safeId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventType(provider: LocalHookProvider, hookEvent: string): string {
  const adapter = getAdapter(provider);
  return adapter?.eventMap[hookEvent] ?? `${provider}_${hookEvent.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`;
}

function evidenceContent(provider: LocalHookProvider, input: LocalHookInput): Record<string, unknown> {
  const { transcript_path: _transcriptPath, cwd: _cwd, ...content } = input;
  return { provider, ...content };
}

async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(path);
      try { return await action(); } finally { await rmdir(path).catch(() => undefined); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error("timed out waiting for local hook session lock");
}

export async function ingestLocalHook(
  dataRoot: string,
  provider: LocalHookProvider,
  input: LocalHookInput,
): Promise<{ localSessionId: string; eventId: string }> {
  if (!getAdapter(provider)) throw new Error(`Unknown Memora adapter: ${provider}`);
  const providerSessionId = typeof input.session_id === "string" && input.session_id
    ? input.session_id
    : `${provider}:${typeof input.cwd === "string" ? input.cwd : process.cwd()}`;
  const mappingId = safeId(`${provider}:${providerSessionId}`);
  const mappingPath = join(dataRoot, "adapters", provider, `${mappingId}.json`);
  const lockPath = `${mappingPath}.lock`;
  await mkdir(dirname(mappingPath), { recursive: true, mode: 0o700 });

  return withLock(lockPath, async () => {
    const store = new LocalEvidenceStore(dataRoot);
    const identity = await getOrCreateIdentity(new FileKeyProvider(join(dataRoot, "identity", "local-key.json")));
    const captureRoot = resolve(typeof input.cwd === "string" ? input.cwd : process.cwd());
    let localSessionId: string | undefined;
    try {
      localSessionId = (JSON.parse(await readFile(mappingPath, "utf8")) as { local_session_id?: string }).local_session_id;
    } catch {
      // First event for this provider session.
    }

    let session: LocalSession;
    if (localSessionId) {
      session = await LocalSession.resume({ store, identity, captureRoot, captureSource: `${provider}-hooks` }, localSessionId);
    } else {
      session = new LocalSession({ store, identity, captureRoot, captureSource: `${provider}-hooks` });
      await session.start();
      localSessionId = session.sessionId;
      await writeFile(mappingPath, JSON.stringify({ local_session_id: localSessionId }, null, 2), { mode: 0o600 });
    }

    const hookEvent = typeof input.hook_event_name === "string" ? input.hook_event_name : "event";
    const eventId = await session.record(eventType(provider, hookEvent), evidenceContent(provider, input), "adapter_reported");
    await session.checkpoint("partial");
    return { localSessionId, eventId };
  });
}
