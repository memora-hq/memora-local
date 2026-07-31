import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileKeyProvider,
  getOrCreateIdentity,
  LocalEvidenceStore,
  LocalSession,
  verifySession,
  exportLocalBundle,
  readLocalBundle,
  verifyBundle,
} from "@smritheon/memora-verifier";
import { diffSnapshots, snapshotProject } from "./capture.js";
import { ingestLocalHook } from "./hookAdapter.js";
import { enqueueLocalHook, startLocalHookSpool } from "./hookTransport.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memora-local-"));
  const store = new LocalEvidenceStore(root);
  const keys = new FileKeyProvider(join(root, "identity", "key.json"));
  const identity = await getOrCreateIdentity(keys, "test");
  const session = new LocalSession({ store, identity, captureRoot: root });
  await session.start();
  await session.record("tool_called", { tool: "fixture" }, "adapter_reported");
  const manifest = await session.finish("complete");
  return { root, store, identity, manifest };
}

describe("Memora Local evidence", () => {
  it("creates and independently verifies a signed encrypted session", async () => {
    const { store, identity, manifest } = await fixture();
    const result = await verifySession(store, manifest.session_id, identity);
    expect(result.valid).toBe(true);
    expect(result.integrity).toBe("verified");
    expect(result.completeness).toBe("complete");
  });

  it("detects a modified encrypted payload", async () => {
    const { store, identity, manifest } = await fixture();
    const events = await store.readEvents(manifest.session_id);
    const objectId = events[0].commit.cid_ciphertext.replace("local:sha256:", "");
    const path = join(store.sessionDir(manifest.session_id), "payloads", `${objectId}.json`);
    const payload = JSON.parse(await readFile(path, "utf8"));
    payload.ciphertext = payload.ciphertext.slice(0, -2) + "AA";
    await writeFile(path, JSON.stringify(payload));
    expect((await verifySession(store, manifest.session_id, identity)).valid).toBe(false);
  });

  it("exports a versioned bundle without private keys", async () => {
    const { root, store, identity, manifest } = await fixture();
    const path = join(root, "evidence.memora");
    await exportLocalBundle(store, manifest.session_id, path);
    const text = await readFile(path, "utf8");
    const bundle = await readLocalBundle(path);
    expect(bundle.manifest.session_id).toBe(manifest.session_id);
    expect(verifyBundle(bundle).valid).toBe(true);
    expect(text).not.toContain(identity.privateKey);
  });

  it("excludes likely secrets and reports ordinary file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-capture-"));
    await writeFile(join(root, ".env"), "TOKEN=secret");
    await writeFile(join(root, "a.txt"), "before");
    const before = await snapshotProject(root);
    await writeFile(join(root, "a.txt"), "after");
    await writeFile(join(root, "b.txt"), "new");
    const after = await snapshotProject(root);
    expect(after.get(".env")?.content).toBeUndefined();
    expect(after.get(".env")?.excluded).toBe("secret-default");
    expect(diffSnapshots(before, after).map((entry) => entry.file.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("joins lifecycle hook events into one verifiable adapter session", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-hooks-"));
    const first = await ingestLocalHook(root, "codex", {
      session_id: "codex-session-1",
      hook_event_name: "SessionStart",
      cwd: root,
      source: "startup",
    });
    const second = await ingestLocalHook(root, "codex", {
      session_id: "codex-session-1",
      hook_event_name: "PostToolUse",
      cwd: root,
      tool_name: "apply_patch",
      tool_use_id: "tool-1",
      tool_input: { command: "*** Begin Patch" },
    });
    expect(second.localSessionId).toBe(first.localSessionId);

    const store = new LocalEvidenceStore(root);
    const events = await store.readEvents(first.localSessionId);
    expect(events.map((event) => event.commit.event_type)).toEqual([
      "session_started",
      "adapter_session_started",
      "tool_completed",
    ]);
    expect((await verifySession(store, first.localSessionId)).valid).toBe(true);
  });

  it("accepts sandbox-friendly hook delivery through a private spool", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-hook-server-"));
    const spoolPath = join(root, "spool");
    const spool = await startLocalHookSpool(root, spoolPath, 60_000);
    try {
      await enqueueLocalHook("claude", {
        session_id: "claude-socket-session",
        hook_event_name: "SessionStart",
        cwd: root,
      }, spoolPath);
      expect(await spool.drain()).toBe(1);
      const sessions = await new LocalEvidenceStore(root).listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].capture_source).toBe("claude-hooks");
    } finally {
      spool.close();
    }
  });
});
