import { describe, expect, it } from "vitest";
import type { LocalEventRecordV1, MemoryPayload } from "@memora-hq/memora-protocol";
import { collectSessionFacts, presentLocalEvent } from "./eventPresentation.js";

const event = (type: string): LocalEventRecordV1 => ({
  format: "memora.local.event",
  version: 1,
  observed_at: "2026-07-23T00:00:00.000Z",
  source: "adapter_reported",
  commit: {
    memory_id: "memory",
    agent_id: "agent",
    cid_ciphertext: "local:sha256:cipher",
    payload_hash: "hash",
    schema_version: 1,
    event_type: type,
    mission_id: "session",
  },
});

const payload = (content: Record<string, unknown>): MemoryPayload => ({
  contentType: "application/json",
  content,
});

describe("local event presentation", () => {
  it("describes tools without exposing command arguments", () => {
    const result = presentLocalEvent(event("tool_completed"), payload({
      provider: "codex",
      tool_name: "Bash",
      tool_input: { command: "pnpm test --token super-secret" },
    }));
    expect(result).toEqual({
      provider: "codex",
      title: "Bash completed",
      detail: "Codex used Bash on pnpm.",
      tool: "Bash",
      target: "pnpm",
      category: "tool",
      status: "completed",
      role: "tool-close",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("shows a file target for a completed tool", () => {
    expect(presentLocalEvent(event("tool_completed"), payload({
      provider: "claude",
      tool_name: "Write",
      tool_input: { file_path: "src/app.ts" },
    })).detail).toBe("Claude used Write on src/app.ts.");
  });

  it("never includes prompt content", () => {
    const result = presentLocalEvent(event("prompt_submitted"), payload({
      provider: "codex",
      prompt: "private prompt",
    }));
    expect(result.detail).toBe("A new request was sent to Codex.");
    expect(JSON.stringify(result)).not.toContain("private prompt");
  });

  it("classifies every event so the renderer and the summary share one taxonomy", () => {
    expect(presentLocalEvent(event("prompt_submitted"))).toMatchObject({ category: "prompt", status: "submitted", role: "turn-start" });
    expect(presentLocalEvent(event("tool_requested"))).toMatchObject({ category: "tool", status: "running", role: "tool-open" });
    expect(presentLocalEvent(event("file_saved"))).toMatchObject({ category: "file", status: "completed" });
    expect(presentLocalEvent(event("terminal_output")).category).toBeUndefined();
  });
});

describe("collectSessionFacts", () => {
  it("takes paths from file events and tool names from tool events", () => {
    const facts = collectSessionFacts({
      a: { provider: "claude", title: "", detail: "", category: "file", target: "src/app.ts" },
      b: { provider: "claude", title: "", detail: "", category: "file", target: "src/app.ts" },
      c: { provider: "claude", title: "", detail: "", category: "tool", tool: "Bash", target: "git" },
      d: { provider: "claude", title: "", detail: "" },
    });

    // "git" is a command basename from safeTarget, not a changed file — it must not appear.
    expect(facts.filePaths).toEqual(["src/app.ts", "src/app.ts"]);
    expect(facts.toolNames).toEqual(["Bash"]);
  });

  it("returns empty lists when nothing could be decrypted", () => {
    expect(collectSessionFacts({})).toEqual({ filePaths: [], toolNames: [] });
  });
});
