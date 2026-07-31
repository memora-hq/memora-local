import type { LocalEventRecordV1, LocalExecutionManifestV1, MemoryCommit } from "@smritheon/memora-protocol";
import { describe, expect, it } from "vitest";
import { resolveTier } from "./captureTier.js";

function manifest(captureSource: string): LocalExecutionManifestV1 {
  return {
    format: "memora.local.execution",
    version: 1,
    session_id: "local_test_session",
    agent_id: "agent_test",
    capture_source: captureSource,
    capture_root_hash: "0".repeat(64),
    started_at: new Date().toISOString(),
    root_event_id: "event_0",
    event_ids: ["event_0"],
    signer: "0xtest",
    capture_status: "complete",
    capture_warnings: [],
    signature: null,
  };
}

function eventWithType(eventType: string): LocalEventRecordV1 {
  const commit: MemoryCommit = {
    memory_id: `mem_${eventType}`,
    agent_id: "agent_test",
    cid_ciphertext: "local:sha256:" + "0".repeat(64),
    payload_hash: "0".repeat(64),
    schema_version: 1,
    event_type: eventType,
  };
  return {
    format: "memora.local.event",
    version: 1,
    observed_at: new Date().toISOString(),
    source: "adapter_reported",
    commit,
  };
}

describe("resolveTier", () => {
  it("returns wrapper tier for process-wrapper capture source", () => {
    const result = resolveTier(manifest("process-wrapper"), [eventWithType("session_started")]);
    expect(result.tier).toBe("wrapper");
    expect(result.reasons).toEqual([
      "Captured via the generic process wrapper (before/after file diff only); no tool-level events.",
    ]);
  });

  it("returns wrapper tier for an unrecognized capture source", () => {
    const result = resolveTier(manifest("mystery-adapter-hooks"), []);
    expect(result.tier).toBe("wrapper");
    expect(result.reasons).toEqual([
      "Unrecognized capture source 'mystery-adapter-hooks'; treated as wrapper-tier.",
    ]);
  });

  it("returns deep tier for a deep adapter with tool-level events", () => {
    const events = [
      eventWithType("adapter_session_started"),
      eventWithType("tool_requested"),
      eventWithType("tool_completed"),
    ];
    const result = resolveTier(manifest("claude-hooks"), events);
    expect(result.tier).toBe("deep");
    expect(result.reasons).toEqual(["Deep, tool-level capture via Claude Code's lifecycle hooks."]);
  });

  it("downgrades a deep adapter with no tool-level events to partial", () => {
    const events = [eventWithType("adapter_session_started"), eventWithType("prompt_submitted")];
    const result = resolveTier(manifest("codex-hooks"), events);
    expect(result.tier).toBe("partial");
    expect(result.reasons).toEqual([
      "Deep, tool-level capture via Codex lifecycle hooks; requires one-time /hooks trust in Codex.",
      "No tool-level events observed in this session; hooks may not be fully installed.",
    ]);
  });

  it("returns partial tier for a partial adapter regardless of events", () => {
    const result = resolveTier(manifest("cursor-hooks"), [eventWithType("file_saved")]);
    expect(result.tier).toBe("partial");
    expect(result.reasons).toEqual([
      "Partial — workspace-level capture (file saves, terminal open/close). A saved file is not proof an AI agent authored it.",
    ]);
  });
});
