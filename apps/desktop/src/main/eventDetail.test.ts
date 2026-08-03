import { describe, expect, it } from "vitest";
import type { LocalEventRecordV1, MemoryPayload } from "@memora-hq/memora-protocol";
import { revealLocalEvent } from "./eventDetail.js";

function event(type: string): LocalEventRecordV1 {
  return {
    format: "memora.local.event",
    version: 1,
    observed_at: "2026-07-23T00:00:00.000Z",
    source: "adapter_reported",
    commit: {
      memory_id: "event-id",
      agent_id: "agent",
      cid_ciphertext: "local:sha256:cipher",
      payload_hash: "hash",
      schema_version: 1,
      event_type: type,
    },
  };
}

function payload(content: Record<string, unknown>): MemoryPayload {
  return { contentType: "application/json", content };
}

describe("local decrypted event detail", () => {
  it("returns the exact prompt only through the explicit reveal model", () => {
    const detail = revealLocalEvent(
      event("prompt_submitted"),
      payload({ provider: "codex", prompt: "Refactor exactly this function." }),
      { provider: "codex", title: "Prompt submitted", detail: "A request was sent." },
    );
    expect(detail.prompt).toBe("Refactor exactly this function.");
    expect(detail.rawContent).toEqual({ provider: "codex", prompt: "Refactor exactly this function." });
  });

  it("preserves exact tool input and output while separating scalar metadata", () => {
    const detail = revealLocalEvent(
      event("tool_completed"),
      payload({
        provider: "claude",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test -- --runInBand" },
        tool_response: { exit_code: 0, output: "passed" },
        transcript_path: "/private/transcript.jsonl",
      }),
      { provider: "claude", title: "Bash completed", detail: "Claude used Bash.", tool: "Bash" },
    );
    expect(detail.tool).toEqual({
      name: "Bash",
      input: { command: "pnpm test -- --runInBand" },
      output: { exit_code: 0, output: "passed" },
    });
    expect(detail.metadata).toEqual({
      provider: "claude",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
    });
    expect(detail.metadata).not.toHaveProperty("transcript_path");
  });
});
