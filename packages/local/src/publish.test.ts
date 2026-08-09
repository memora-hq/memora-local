import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { decrypt } from "@memora-hq/memora-protocol";
import {
  exportLocalBundle,
  FileKeyProvider,
  getOrCreateIdentity,
  LocalEvidenceStore,
  LocalSession,
  readLocalBundle,
  deriveLocalEncryptionKey,
} from "@memora-hq/memora-verifier";
import {
  PUBLISH_SIZE_LIMIT_BYTES,
  PublishArtifactTooLargeError,
  assertPublishSize,
  buildPublishArtifact,
  buildPublishArtifactFromBundle,
} from "./publish.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memora-publish-"));
  const store = new LocalEvidenceStore(root);
  const keys = new FileKeyProvider(join(root, "identity", "key.json"));
  const identity = await getOrCreateIdentity(keys, "test");
  const session = new LocalSession({ store, identity, captureRoot: root });
  await session.start();
  await session.record("tool_called", { tool: "fixture", secret: "should-not-leak-as-object-key" }, "adapter_reported");
  await session.record("tool_result", { output: "ok" }, "adapter_reported");
  const manifest = await session.finish("complete");
  return { root, store, identity, manifest };
}

describe("buildPublishArtifact", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("re-encrypts every payload under a fresh key, distinct from the local identity key", async () => {
    const fx = await fixture();
    root = fx.root;
    const events = await fx.store.readEvents(fx.manifest.session_id);
    const artifact = await buildPublishArtifact(fx.store, fx.manifest.session_id, fx.identity);

    expect(artifact.eventCount).toBe(events.length);
    expect(Object.keys(artifact.bundle.payloads)).toHaveLength(events.length);

    const localKey = deriveLocalEncryptionKey(fx.identity);
    const publishKey = Buffer.from(artifact.key, "base64url");
    expect(publishKey.equals(localKey)).toBe(false);

    for (const objectId of Object.keys(artifact.bundle.payloads)) {
      const decrypted = JSON.parse(decrypt(artifact.bundle.payloads[objectId], publishKey));
      expect(decrypted).toBeTruthy();
    }
  });

  it("passes manifest and events through untouched", async () => {
    const fx = await fixture();
    root = fx.root;
    const events = await fx.store.readEvents(fx.manifest.session_id);
    const artifact = await buildPublishArtifact(fx.store, fx.manifest.session_id, fx.identity);

    expect(artifact.bundle.manifest).toEqual(fx.manifest);
    expect(artifact.bundle.events).toEqual(events);
  });

  it("generates a different key (and different digest) on every call", async () => {
    const fx = await fixture();
    root = fx.root;
    const first = await buildPublishArtifact(fx.store, fx.manifest.session_id, fx.identity);
    const second = await buildPublishArtifact(fx.store, fx.manifest.session_id, fx.identity);
    expect(first.key).not.toBe(second.key);
    expect(first.digest).not.toBe(second.digest);
  });

  it("throws if a stored payload has been tampered with", async () => {
    const fx = await fixture();
    root = fx.root;
    const events = await fx.store.readEvents(fx.manifest.session_id);
    const objectId = events[0].commit.cid_ciphertext.replace("local:sha256:", "");
    const path = join(fx.store.sessionDir(fx.manifest.session_id), "payloads", `${objectId}.json`);
    const { readFile, writeFile } = await import("node:fs/promises");
    const payload = JSON.parse(await readFile(path, "utf8"));
    payload.ciphertext = payload.ciphertext.slice(0, -2) + "AA";
    await writeFile(path, JSON.stringify(payload));

    await expect(buildPublishArtifact(fx.store, fx.manifest.session_id, fx.identity)).rejects.toThrow(
      "damaged and cannot be published",
    );
  });
});

describe("buildPublishArtifactFromBundle", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("produces an equivalent artifact to publishing directly from the store", async () => {
    const fx = await fixture();
    root = fx.root;
    const bundlePath = join(fx.root, "session.memora");
    await exportLocalBundle(fx.store, fx.manifest.session_id, bundlePath);
    const bundle = await readLocalBundle(bundlePath);

    const artifact = buildPublishArtifactFromBundle(bundle, fx.identity);
    expect(artifact.eventCount).toBe(bundle.events.length);
    expect(artifact.bundle.manifest).toEqual(fx.manifest);

    const publishKey = Buffer.from(artifact.key, "base64url");
    for (const objectId of Object.keys(artifact.bundle.payloads)) {
      expect(() => decrypt(artifact.bundle.payloads[objectId], publishKey)).not.toThrow();
    }
  });
});

describe("assertPublishSize", () => {
  it("passes under the limit", () => {
    expect(() => assertPublishSize(PUBLISH_SIZE_LIMIT_BYTES - 1)).not.toThrow();
  });

  it("throws a descriptive error over the limit, without truncating anything itself", () => {
    expect(() => assertPublishSize(PUBLISH_SIZE_LIMIT_BYTES + 1)).toThrow(PublishArtifactTooLargeError);
    try {
      assertPublishSize(PUBLISH_SIZE_LIMIT_BYTES + 1);
    } catch (error) {
      expect((error as Error).message).toContain("memora local export");
    }
  });
});
