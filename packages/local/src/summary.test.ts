import type { LocalCaptureWarning, LocalEventRecordV1, LocalExecutionManifestV1, MemoryCommit } from "@smritheon/memora-protocol";
import { describe, expect, it } from "vitest";
import { summarizeSession } from "./summary.js";

const STARTED_AT = "2026-07-01T10:00:00.000Z";
const COMPLETED_AT = "2026-07-01T10:05:00.000Z";

function manifest(
  captureSource: string,
  overrides: Partial<LocalExecutionManifestV1> = {},
): LocalExecutionManifestV1 {
  return {
    format: "memora.local.execution",
    version: 1,
    session_id: "local_test_session",
    agent_id: "agent_test",
    capture_source: captureSource,
    capture_root_hash: "0".repeat(64),
    started_at: STARTED_AT,
    completed_at: COMPLETED_AT,
    root_event_id: "event_0",
    event_ids: ["event_0"],
    signer: "0xtest",
    capture_status: "complete",
    capture_warnings: [],
    signature: null,
    ...overrides,
  };
}

let sequence = 0;
function eventWithType(eventType: string): LocalEventRecordV1 {
  sequence += 1;
  const commit: MemoryCommit = {
    memory_id: `mem_${eventType}_${sequence}`,
    agent_id: "agent_test",
    cid_ciphertext: "local:sha256:" + "0".repeat(64),
    payload_hash: "0".repeat(64),
    schema_version: 1,
    event_type: eventType,
  };
  return { format: "memora.local.event", version: 1, observed_at: STARTED_AT, source: "adapter_reported", commit };
}

function events(...types: string[]): LocalEventRecordV1[] {
  return types.map(eventWithType);
}

/** 1 prompt, 2 tool invocations (request + completion each), 4 file changes, 1 turn end. */
const deepSession = () =>
  events(
    "prompt_submitted",
    "tool_requested",
    "tool_completed",
    "tool_requested",
    "tool_completed",
    "file_changed",
    "file_changed",
    "file_changed",
    "file_changed",
    "turn_completed",
  );

describe("summarizeSession", () => {
  it("reads a deep session in plain language when decrypted paths are available", () => {
    const summary = summarizeSession(manifest("claude-hooks"), deepSession(), {
      filePaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"],
    });

    expect(summary.agentLabel).toBe("Claude Code");
    expect(summary.tier).toBe("deep");
    expect(summary.headline).toBe("Claude Code sent 1 request, ran 2 tool calls, and changed 3 files.");
    expect(summary.sentences).toEqual([
      "None of the files it touched look like secrets.",
      "All 10 evidence records were sealed on this device.",
    ]);
    expect(summary.caveats).toEqual([]);
    expect(summary.distinctFileCount).toBe(3);
    expect(summary.secrets).toBe("no-secret-paths-observed");
    expect(summary.durationMs).toBe(300_000);
  });

  it("counts one tool call per invocation, not one per tool event", () => {
    const summary = summarizeSession(manifest("claude-hooks"), deepSession());
    expect(summary.counts.toolCalls).toBe(2);
    expect(summary.counts.prompts).toBe(1);
    expect(summary.counts.fileChanges).toBe(4);
    expect(summary.counts.totalEvents).toBe(10);
    expect(summary.counts.backgroundEvents).toBe(1);
  });

  it("drops every path-derived claim when no decrypted facts are supplied", () => {
    const summary = summarizeSession(manifest("claude-hooks"), deepSession());

    expect(summary.headline).toBe("Claude Code sent 1 request, ran 2 tool calls, and recorded 4 file changes.");
    expect(summary.sentences).toEqual(["All 10 evidence records were sealed on this device."]);
    expect(summary.secrets).toBe("unknown");
    expect(summary.distinctFileCount).toBeUndefined();
  });

  it("reports observed secret-like paths without claiming the agent avoided secrets", () => {
    const summary = summarizeSession(manifest("claude-hooks"), deepSession(), {
      filePaths: ["src/a.ts", ".env.local"],
    });

    expect(summary.secrets).toBe("secret-paths-observed");
    expect(summary.sentences[0]).toBe(
      "It touched 1 file that looks like a secret. Memora recorded the change but never read the contents.",
    );
    expect(summary.sentences.join(" ")).not.toContain("None of the files");
  });

  it("degrades honestly for a process-wrapper session", () => {
    const summary = summarizeSession(
      manifest("process-wrapper"),
      events("session_started", "process_started", "terminal_output", "file_changed", "file_changed", "process_exited", "session_completed"),
    );

    expect(summary.tier).toBe("wrapper");
    expect(summary.agentLabel).toBe("The local agent");
    expect(summary.headline).toBe("The local agent recorded 2 file changes.");
    expect(summary.counts.toolCalls).toBe(0);
    expect(summary.caveats).toEqual([
      "Captured via the generic process wrapper (before/after file diff only); no tool-level events.",
    ]);
  });

  it("does not claim nothing happened when a session recorded only unclassified events", () => {
    const summary = summarizeSession(
      manifest("process-wrapper"),
      events("session_started", "process_started", "terminal_output", "terminal_output", "process_exited"),
    );

    expect(summary.headline).toBe(
      "The local agent ran under observation, but no prompts, tool calls, or file changes were identified in this session.",
    );
    expect(summary.counts.totalEvents).toBe(5);
    expect(summary.counts.backgroundEvents).toBe(5);
  });

  it("reports secrets as unknown when a session observed no file paths at all", () => {
    // A deep hook session records file edits as tool calls and emits no paths, so an empty
    // path list must never be read as "the agent avoided secrets".
    const summary = summarizeSession(manifest("claude-hooks"), events("prompt_submitted", "tool_requested", "tool_completed"), {
      filePaths: [],
      toolNames: ["Bash"],
    });

    expect(summary.secrets).toBe("unknown");
    expect(summary.sentences.join(" ")).not.toContain("look like secrets");
  });

  it("surfaces a deep adapter that produced no tool-level evidence", () => {
    const summary = summarizeSession(manifest("codex-hooks"), events("adapter_session_started", "prompt_submitted"));

    expect(summary.tier).toBe("partial");
    expect(summary.headline).toBe("Codex sent 1 request.");
    expect(summary.caveats).toEqual([
      "Deep, tool-level capture via Codex lifecycle hooks; requires one-time /hooks trust in Codex.",
      "No tool-level events observed in this session; hooks may not be fully installed.",
    ]);
  });

  it("handles a session with no events", () => {
    const summary = summarizeSession(manifest("claude-hooks"), []);

    expect(summary.headline).toBe("Claude Code started a session, but no actions have been recorded yet.");
    expect(summary.sentences).toEqual(["No evidence records have been sealed yet."]);
  });

  it("carries capture warnings, interruptions, failures, and denials into caveats", () => {
    const warnings: LocalCaptureWarning[] = [
      { code: "pty_unavailable", message: "Terminal output was captured through a pipe." },
      { code: "spool_drained_late", message: "Some events arrived after the session ended." },
    ];
    const summary = summarizeSession(
      manifest("claude-hooks", { capture_status: "interrupted", capture_warnings: warnings }),
      events("prompt_submitted", "tool_requested", "tool_failed", "approval_requested", "approval_denied"),
    );

    expect(summary.counts.failures).toBe(1);
    expect(summary.counts.approvalsRequested).toBe(1);
    expect(summary.counts.approvalsDenied).toBe(1);
    expect(summary.caveats).toEqual([
      "Capture stopped before the session finished, so the record may be incomplete.",
      "1 action failed during this session.",
      "1 action was not approved.",
      "Terminal output was captured through a pipe.",
      "Some events arrived after the session ended.",
    ]);
  });

  it("mentions the signature only when the manifest is signed", () => {
    const signed = summarizeSession(manifest("claude-hooks", { signature: "0xsignature" }), deepSession());
    expect(signed.sentences.at(-1)).toBe("All 10 evidence records were sealed on this device. This session is signed.");
  });

  it("uses singular wording for counts of one", () => {
    const summary = summarizeSession(manifest("claude-hooks"), events("prompt_submitted", "tool_requested", "tool_completed"), {
      filePaths: ["src/only.ts"],
    });
    expect(summary.headline).toBe("Claude Code sent 1 request, ran 1 tool call, and changed 1 file.");
  });

  it("never claims verification and never echoes a captured path", () => {
    const summary = summarizeSession(manifest("claude-hooks"), deepSession(), {
      filePaths: ["src/super-secret-project/a.ts"],
      toolNames: ["Bash"],
    });
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toMatch(/unaltered|\bverified\b/i);
    expect(serialized).not.toContain("super-secret-project");
  });

  it("is deterministic for identical input", () => {
    const session = deepSession();
    const first = summarizeSession(manifest("claude-hooks"), session, { filePaths: ["src/a.ts"] });
    const second = summarizeSession(manifest("claude-hooks"), session, { filePaths: ["src/a.ts"] });
    expect(first).toEqual(second);
  });
});
