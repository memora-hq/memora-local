import { describe, expect, it } from "vitest";
import { classifyEventType, type EventClassification } from "./eventTaxonomy.js";

const cases: Array<[string | undefined, EventClassification]> = [
  // Terminal lifecycle hooks (codex, claude).
  ["adapter_session_started", { status: "completed", role: "session-start" }],
  ["prompt_submitted", { category: "prompt", status: "submitted", role: "turn-start" }],
  ["tool_requested", { category: "tool", status: "running", role: "tool-open" }],
  ["approval_requested", { category: "approval", status: "running" }],
  ["approval_denied", { category: "approval", status: "denied" }],
  ["tool_completed", { category: "tool", status: "completed", role: "tool-close" }],
  ["tool_failed", { category: "tool", status: "failed", role: "tool-close" }],
  ["file_changed", { category: "file", status: "completed" }],
  ["turn_completed", { status: "completed", role: "turn-end" }],
  ["adapter_session_ended", { status: "completed", role: "turn-end" }],
  // Editor adapters (cursor, vscode).
  ["file_saved", { category: "file", status: "completed" }],
  ["terminal_opened", { status: "completed" }],
  ["terminal_closed", { status: "completed" }],
  // Process wrapper.
  ["session_started", { status: "completed", role: "session-start" }],
  ["process_started", { status: "completed" }],
  ["terminal_output", { status: "completed" }],
  ["process_exited", { status: "completed" }],
  ["session_completed", { status: "completed", role: "turn-end" }],
  ["session_interrupted", { status: "completed", role: "session-end" }],
  // Legacy / alternate tool completion spelling.
  ["tool_called", { category: "tool", status: "completed", role: "tool-close" }],
  // Unmapped hook fallback (`${provider}_${hook.toLowerCase()}`) and a missing type.
  ["codex_somehook", { status: "completed" }],
  [undefined, { status: "completed" }],
];

describe("classifyEventType", () => {
  it.each(cases)("classifies %s", (eventType, expected) => {
    expect(classifyEventType(eventType)).toEqual(expected);
  });

  it("never reports a category for background records", () => {
    for (const type of ["adapter_session_started", "terminal_output", "process_exited", "codex_somehook"]) {
      expect(classifyEventType(type).category).toBeUndefined();
    }
  });
});
