import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalEvidenceBundleV2 } from "@memora-hq/memora-protocol";
import {
  clearPublishAttempt,
  createPublication,
  deletePublication,
  loadPublishAttempt,
  resolvePublishAttempt,
  savePublishAttempt,
} from "./publishClient.js";

const emptyBundle: LocalEvidenceBundleV2 = {
  format: "memora.local.bundle",
  version: 2,
  manifest: {
    format: "memora.local.execution",
    version: 1,
    session_id: "s1",
    agent_id: "a1",
    capture_source: "wrapper_observed",
    capture_root_hash: "x",
    started_at: "2026-01-01T00:00:00.000Z",
    root_event_id: "r1",
    event_ids: [],
    signer: "0x0",
    capture_status: "complete",
    capture_warnings: [],
    signature: null,
  },
  events: [],
  payloads: {},
};

describe("resolvePublishAttempt", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("creates a fresh attempt when none exists", async () => {
    root = await mkdtemp(join(tmpdir(), "memora-publish-attempt-"));
    const attempt = await resolvePublishAttempt(root, "s1", "digest-a");
    expect(attempt.state).toBe("PREPARED");
    expect(attempt.artifact_digest).toBe("digest-a");
    expect(await loadPublishAttempt(root, "s1")).toEqual(attempt);
  });

  it("reuses an in-flight attempt with the same digest (retry-safe)", async () => {
    root = await mkdtemp(join(tmpdir(), "memora-publish-attempt-"));
    const first = await resolvePublishAttempt(root, "s1", "digest-a");
    await savePublishAttempt(root, { ...first, state: "UPLOADING" });
    const second = await resolvePublishAttempt(root, "s1", "digest-a");
    expect(second.attempt_id).toBe(first.attempt_id);
    expect(second.state).toBe("UPLOADING");
  });

  it("starts a new attempt when the digest changed (content differs)", async () => {
    root = await mkdtemp(join(tmpdir(), "memora-publish-attempt-"));
    const first = await resolvePublishAttempt(root, "s1", "digest-a");
    await savePublishAttempt(root, { ...first, state: "UPLOADING" });
    const second = await resolvePublishAttempt(root, "s1", "digest-b");
    expect(second.attempt_id).not.toBe(first.attempt_id);
    expect(second.artifact_digest).toBe("digest-b");
  });

  it("starts a new attempt when the previous one already published (fresh upload every time)", async () => {
    root = await mkdtemp(join(tmpdir(), "memora-publish-attempt-"));
    const first = await resolvePublishAttempt(root, "s1", "digest-a");
    await savePublishAttempt(root, { ...first, state: "PUBLISHED", publication_id: "pub1" });
    const second = await resolvePublishAttempt(root, "s1", "digest-a");
    expect(second.attempt_id).not.toBe(first.attempt_id);
    expect(second.state).toBe("PREPARED");
  });

  it("clearPublishAttempt removes the file", async () => {
    root = await mkdtemp(join(tmpdir(), "memora-publish-attempt-"));
    await resolvePublishAttempt(root, "s1", "digest-a");
    await clearPublishAttempt(root, "s1");
    expect(await loadPublishAttempt(root, "s1")).toBeNull();
  });
});

describe("createPublication", () => {
  it("posts the versioned envelope with the idempotency key and bearer token", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://example.test/api/v1/publications");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok123");
      expect(headers["Idempotency-Key"]).toBe("attempt-1");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ version: 1, artifact: emptyBundle, metadata: { byte_size: 42 } });
      return new Response(JSON.stringify({ version: 1, id: "pub-1" }), { status: 200 });
    });

    const result = await createPublication({
      baseUrl: "https://example.test",
      token: "tok123",
      attemptId: "attempt-1",
      bundle: emptyBundle,
      byteSize: 42,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ version: 1, id: "pub-1" });
  });

  it("throws with the server's status on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      createPublication({
        baseUrl: "https://example.test",
        token: "tok",
        attemptId: "a1",
        bundle: emptyBundle,
        byteSize: 1,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("HTTP 500");
  });
});

describe("deletePublication", () => {
  it("DELETEs with the bearer token", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://example.test/api/v1/publications/pub-1");
      expect(init.method).toBe("DELETE");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return new Response(null, { status: 204 });
    });
    await expect(
      deletePublication({
        baseUrl: "https://example.test",
        token: "tok",
        publicationId: "pub-1",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });

  it("treats a 404 as already-deleted, not an error", async () => {
    const fetchImpl = vi.fn(async () => new Response("gone", { status: 404 }));
    await expect(
      deletePublication({
        baseUrl: "https://example.test",
        token: "tok",
        publicationId: "pub-1",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });
});
