import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportLocalBundle,
  FileKeyProvider,
  getOrCreateIdentity,
  LocalEvidenceStore,
  LocalSession,
  readLocalBundle,
  verifyLocalBundle,
} from "@memora-hq/memora-local";
import { buildBundleView } from "./bundleView.js";

async function bundleFixture(disclose: boolean) {
  const root = await mkdtemp(join(tmpdir(), "memora-bundle-view-"));
  const store = new LocalEvidenceStore(root);
  const identity = await getOrCreateIdentity(new FileKeyProvider(join(root, "identity", "key.json")), "test");
  const session = new LocalSession({ store, identity, captureRoot: root, captureSource: "claude-hooks" });
  await session.start();
  await session.record("prompt_submitted", { provider: "claude" }, "adapter_reported");
  await session.record("tool_completed", {
    provider: "claude",
    tool_name: "Edit",
    tool_input: { file_path: "src/app.ts" },
  }, "adapter_reported");
  await session.record("file_changed", { provider: "claude", path: "src/app.ts" }, "filesystem_observed");
  const manifest = await session.finish("complete");

  const path = join(root, "evidence.memora");
  await exportLocalBundle(store, manifest.session_id, path, disclose ? { disclose: "all", identity } : {});
  const bundle = await readLocalBundle(path);
  return { bundle, verification: verifyLocalBundle(bundle), manifest };
}

describe("foreign bundle view", () => {
  it("reads a disclosed bundle as richly as a local session", async () => {
    const { bundle, verification } = await bundleFixture(true);
    expect(verification.disclosure).toBe("full");

    const view = buildBundleView(bundle, verification.disclosure);
    const presentations = Object.values(view.presentations);
    expect(presentations.some((item) => item.tool === "Edit" && item.target === "src/app.ts")).toBe(true);
    expect(presentations.some((item) => item.provider === "claude")).toBe(true);

    expect(view.summary.agentLabel).toBe("Claude Code");
    expect(view.summary.distinctFileCount).toBe(1);
    expect(view.summary.secrets).toBe("no-secret-paths-observed");
    expect(view.summary.headline).toContain("changed 1 file");
  });

  it("invents nothing about a sealed bundle it cannot read", async () => {
    const { bundle, verification } = await bundleFixture(false);
    expect(verification.disclosure).toBe("none");

    const view = buildBundleView(bundle, verification.disclosure);
    const presentations = Object.values(view.presentations);
    expect(presentations.every((item) => item.tool === undefined)).toBe(true);
    expect(presentations.every((item) => item.target === undefined)).toBe(true);

    // Event types live in the unencrypted commit, so counts still hold — but no file paths,
    // no tool names, and no claim about secrets.
    expect(view.summary.counts.prompts).toBe(1);
    expect(view.summary.counts.toolCalls).toBe(1);
    expect(view.summary.distinctFileCount).toBeUndefined();
    expect(view.summary.secrets).toBe("unknown");
    expect(view.summary.headline).toContain("recorded 1 file change");
    expect(view.summary.sentences.join(" ")).not.toContain("secret");
  });

  it("keeps the event journal exactly as it arrived", async () => {
    const { bundle, verification, manifest } = await bundleFixture(true);
    const view = buildBundleView(bundle, verification.disclosure);
    expect(view.events).toBe(bundle.events);
    expect(view.manifest.session_id).toBe(manifest.session_id);
    expect(Object.keys(view.presentations)).toHaveLength(manifest.event_ids.length);
  });
});
