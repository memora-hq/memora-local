/**
 * The single classification of a local event type.
 *
 * Both the plain-language summary (`summary.ts`) and the desktop timeline consume this.
 * The desktop renderer cannot import this module at runtime — it is a sandboxed browser
 * bundle and `@memora/local` reaches `node-pty` — so the Electron main process attaches
 * the classification to each `LocalEventPresentation` and ships it over IPC instead.
 * Keep this the only place event-type strings are interpreted.
 */

export type EventCategory = "prompt" | "tool" | "file" | "approval";
export type EventStatus = "submitted" | "running" | "completed" | "failed" | "denied";
export type EventRole =
  | "turn-start"
  | "tool-open"
  | "tool-close"
  | "turn-end"
  | "session-start"
  | "session-end";

export interface EventClassification {
  category?: EventCategory;
  status: EventStatus;
  role?: EventRole;
}

const TOOL_OPEN = new Set(["tool_requested"]);
const TOOL_CLOSE = new Set(["tool_completed", "tool_called", "tool_failed"]);
const FILE_EVENTS = new Set(["file_changed", "file_saved"]);
const APPROVAL_EVENTS = new Set(["approval_requested", "approval_denied"]);
const TURN_END = new Set(["turn_completed", "adapter_session_ended", "session_completed"]);
const SESSION_START = new Set(["adapter_session_started", "session_started"]);

function category(eventType: string): EventCategory | undefined {
  if (eventType === "prompt_submitted") return "prompt";
  if (TOOL_OPEN.has(eventType) || TOOL_CLOSE.has(eventType)) return "tool";
  if (FILE_EVENTS.has(eventType)) return "file";
  if (APPROVAL_EVENTS.has(eventType)) return "approval";
  return undefined;
}

function status(eventType: string): EventStatus {
  if (eventType === "tool_requested" || eventType === "approval_requested") return "running";
  if (eventType === "tool_failed") return "failed";
  if (eventType === "approval_denied") return "denied";
  if (eventType === "prompt_submitted") return "submitted";
  return "completed";
}

function role(eventType: string): EventRole | undefined {
  if (eventType === "prompt_submitted") return "turn-start";
  if (TOOL_OPEN.has(eventType)) return "tool-open";
  if (TOOL_CLOSE.has(eventType)) return "tool-close";
  if (TURN_END.has(eventType)) return "turn-end";
  if (SESSION_START.has(eventType)) return "session-start";
  if (eventType === "session_interrupted") return "session-end";
  return undefined;
}

/** Unknown or absent event types degrade to a completed background record with no category. */
export function classifyEventType(eventType?: string): EventClassification {
  if (!eventType) return { status: "completed" };
  return {
    ...(category(eventType) ? { category: category(eventType) } : {}),
    status: status(eventType),
    ...(role(eventType) ? { role: role(eventType) } : {}),
  };
}
