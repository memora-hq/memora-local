import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPublishSession, ensurePublishLogin, loadPublishSession, savePublishSession } from "./publishAuth.js";

describe("publish session store", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("round-trips a session", async () => {
    root = await mkdtemp(join(tmpdir(), "memora-publish-auth-"));
    expect(await loadPublishSession(root)).toBeNull();
    await savePublishSession(root, { token: "tok", email: "a@b.com" });
    expect(await loadPublishSession(root)).toEqual({ token: "tok", email: "a@b.com" });
    await clearPublishSession(root);
    expect(await loadPublishSession(root)).toBeNull();
  });
});

describe("ensurePublishLogin", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("returns the stored token without any network call when already logged in", async () => {
    root = await mkdtemp(join(tmpdir(), "memora-publish-auth-"));
    await savePublishSession(root, { token: "existing-token" });
    const fetchImpl = vi.fn();
    const token = await ensurePublishLogin({
      dataRoot: root,
      baseUrl: "https://example.test",
      onPrompt: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(token).toBe("existing-token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs the device flow, polls until authorized, and persists the session", async () => {
    root = await mkdtemp(join(tmpdir(), "memora-publish-auth-"));
    let pollCount = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v1/auth/device")) {
        return new Response(
          JSON.stringify({ device_code: "dc1", user_code: "ABCD-1234", verification_uri: "https://example.test/activate", interval: 1, expires_in: 60 }),
          { status: 200 },
        );
      }
      pollCount += 1;
      const status = pollCount < 2 ? "pending" : "authorized";
      return new Response(JSON.stringify({ status, ...(status === "authorized" ? { token: "new-token", email: "me@example.test" } : {}) }), { status: 200 });
    });

    const prompts: Array<{ verificationUrl: string; userCode: string }> = [];
    const token = await ensurePublishLogin({
      dataRoot: root,
      baseUrl: "https://example.test",
      onPrompt: (info) => prompts.push(info),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    expect(token).toBe("new-token");
    expect(prompts).toEqual([{ verificationUrl: "https://example.test/activate", userCode: "ABCD-1234" }]);
    expect(await loadPublishSession(root)).toEqual({ token: "new-token", email: "me@example.test" });
  });

  it("throws when the device code expires", async () => {
    root = await mkdtemp(join(tmpdir(), "memora-publish-auth-"));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v1/auth/device")) {
        return new Response(
          JSON.stringify({ device_code: "dc1", user_code: "ABCD-1234", verification_uri: "https://example.test/activate", interval: 1, expires_in: 60 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "expired" }), { status: 200 });
    });

    await expect(
      ensurePublishLogin({
        dataRoot: root,
        baseUrl: "https://example.test",
        onPrompt: () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("expired");
  });
});
