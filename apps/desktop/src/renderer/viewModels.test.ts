import { describe, expect, it } from "vitest";
import type { LocalEventRecordV1, LocalExecutionManifestV1 } from "@smritheon/memora-protocol";
import { buildTrace, eventLabel, formatDateTime, formatTime, groupEvents, groupSessionsByProvider, healthLabel, humanize, providerForSession, sessionDuration, shortHash } from "./viewModels";

const event = (observed_at: string, event_type?: string, id = "memory"): LocalEventRecordV1 => ({
  format: "memora.local.event",
  version: 1,
  observed_at,
  source: "adapter_reported",
  commit: {
    memory_id: id,
    agent_id: "agent",
    cid_ciphertext: "local:sha256:cipher",
    payload_hash: "a".repeat(64),
    schema_version: 1,
    event_type,
  },
});

// buildTrace reads each event's category/status/role off the presentation the main process
// builds with @smritheon/memora-local's classifyEventType. These fixtures spell out that contract.
const present = (
  title: string,
  classification: Pick<LocalEventPresentation, "category" | "status" | "role">,
  extra: Partial<LocalEventPresentation> = {},
): LocalEventPresentation => ({ provider: "claude", title, detail: `${title}.`, ...classification, ...extra });

const PROMPT = { category: "prompt", status: "submitted", role: "turn-start" } as const;
const TOOL_OPEN = { category: "tool", status: "running", role: "tool-open" } as const;
const TOOL_CLOSE = { category: "tool", status: "completed", role: "tool-close" } as const;
const TURN_END = { status: "completed", role: "turn-end" } as const;
const BACKGROUND = { status: "completed" } as const;

describe("desktop view models", () => {
  it("humanizes protocol and health labels", () => {
    expect(humanize("tool_called")).toBe("Tool Called");
    expect(healthLabel("needs_attention")).toBe("Needs Attention");
    expect(healthLabel()).toBe("Not tested");
  });

  it("formats hashes without losing both ends", () => {
    expect(shortHash("a".repeat(64), 6)).toBe("aaaaaa…aaaaaa");
    expect(shortHash()).toBe("Unavailable");
  });

  it("handles invalid and missing timestamps", () => {
    expect(formatTime("invalid")).toBe("Unknown time");
    expect(formatDateTime()).toBe("Unavailable");
  });

  it("uses the event type when available", () => {
    expect(eventLabel(event("2026-01-01T00:00:00Z", "process_started"))).toBe("Process Started");
    expect(eventLabel(event("2026-01-01T00:00:00Z"))).toBe("Execution Event");
  });

  it("groups events by observed date", () => {
    expect(groupEvents([
      event("2026-01-01T00:00:00Z"),
      event("2026-01-01T01:00:00Z"),
      event("2026-01-02T00:00:00Z"),
    ])).toHaveLength(2);
  });

  it("sorts a trace chronologically and folds capture noise into turns", () => {
    const trace = buildTrace([
      event("2026-01-01T00:00:03Z", "turn_completed", "turn-end"),
      event("2026-01-01T00:00:01Z", "prompt_submitted", "prompt"),
      event("2026-01-01T00:00:02Z", "terminal_output", "terminal"),
    ], {
      prompt: present("Prompt submitted", PROMPT),
      terminal: present("Terminal activity", BACKGROUND),
      "turn-end": present("Turn completed", TURN_END),
    });
    expect(trace.turns).toHaveLength(1);
    expect(trace.turns[0].items.map((item) => item.id)).toEqual(["prompt"]);
    expect(trace.turns[0].hiddenEventCount).toBe(2);
    expect(trace.turns[0].completedAt).toBe("2026-01-01T00:00:03Z");
  });

  it("pairs requested and completed tool evidence into one visible action", () => {
    const trace = buildTrace([
      event("2026-01-01T00:00:00Z", "prompt_submitted", "prompt"),
      event("2026-01-01T00:00:01Z", "tool_requested", "request"),
      event("2026-01-01T00:00:02Z", "tool_completed", "complete"),
    ], {
      prompt: present("Prompt submitted", PROMPT),
      request: present("Bash requested", TOOL_OPEN, { tool: "Bash", correlationId: "call-1" }),
      complete: present("Bash completed", TOOL_CLOSE, { tool: "Bash", correlationId: "call-1" }),
    });
    expect(trace.visibleActions).toBe(2);
    expect(trace.toolCalls).toBe(1);
    expect(trace.turns[0].items[1]).toMatchObject({
      id: "complete",
      eventIds: ["request", "complete"],
      status: "completed",
      completedAt: "2026-01-01T00:00:02Z",
    });
  });

  it("carries a failed tool status through onto the paired action", () => {
    const trace = buildTrace([
      event("2026-01-01T00:00:00Z", "prompt_submitted", "prompt"),
      event("2026-01-01T00:00:01Z", "tool_requested", "request"),
      event("2026-01-01T00:00:02Z", "tool_failed", "failed"),
    ], {
      prompt: present("Prompt submitted", PROMPT),
      request: present("Bash requested", TOOL_OPEN, { tool: "Bash", correlationId: "call-1" }),
      failed: present("Bash failed", { category: "tool", status: "failed", role: "tool-close" }, { tool: "Bash", correlationId: "call-1" }),
    });
    expect(trace.turns[0].items[1]).toMatchObject({ id: "failed", status: "failed" });
  });

  it("starts a new turn for each classified prompt", () => {
    const trace = buildTrace([
      event("2026-01-01T00:00:00Z", "prompt_submitted", "first"),
      event("2026-01-01T00:00:01Z", "file_changed", "file"),
      event("2026-01-01T00:00:02Z", "prompt_submitted", "second"),
    ], {
      first: present("Prompt submitted", PROMPT),
      file: present("File changed", { category: "file", status: "completed" }),
      second: present("Prompt submitted", PROMPT),
    });
    expect(trace.turns.map((turn) => turn.label)).toEqual(["Turn 1", "Turn 2"]);
    expect(trace.promptCount).toBe(2);
    expect(trace.fileChanges).toBe(1);
  });

  it("folds an unclassified event into the background record count", () => {
    const trace = buildTrace([
      event("2026-01-01T00:00:00Z", "prompt_submitted", "prompt"),
      event("2026-01-01T00:00:01Z", "codex_somehook", "unknown"),
    ], {
      prompt: present("Prompt submitted", PROMPT),
      unknown: present("Codex Somehook", BACKGROUND),
    });
    expect(trace.turns[0].hiddenEventCount).toBe(1);
    expect(trace.visibleActions).toBe(1);
  });

  it("formats live, short and minute session durations", () => {
    const base: LocalExecutionManifestV1 = {
      format: "memora.local.execution",
      version: 1,
      session_id: "session",
      agent_id: "agent",
      capture_source: "codex",
      capture_root_hash: "hash",
      started_at: "2026-01-01T00:00:00.000Z",
      root_event_id: "event",
      event_ids: [],
      signer: "signer",
      capture_status: "partial",
      capture_warnings: [],
      signature: "signature",
    };
    expect(sessionDuration(base)).toBe("Capturing now");
    expect(sessionDuration({ ...base, completed_at: "2026-01-01T00:00:09.000Z" })).toBe("9 sec");
    expect(sessionDuration({ ...base, completed_at: "2026-01-01T00:02:00.000Z" })).toBe("2 min");
    expect(providerForSession({ ...base, capture_source: "claude-hooks" })).toBe("claude");
    expect(groupSessionsByProvider([
      { ...base, capture_source: "codex-hooks" },
      { ...base, session_id: "claude", capture_source: "claude-hooks" },
    ]).map((group) => group.provider)).toEqual(["codex", "claude"]);
  });
});
