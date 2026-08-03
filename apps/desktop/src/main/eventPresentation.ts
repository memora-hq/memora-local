import { basename } from "node:path";
import type { LocalEventRecordV1, MemoryPayload } from "@memora-hq/memora-protocol";
import { classifyEventType, type EventCategory, type EventRole, type EventStatus, type SessionSummaryFacts } from "@memora-hq/memora-local";

export interface LocalEventPresentation {
  provider: "codex" | "claude" | "cursor" | "vscode" | "local";
  title: string;
  detail: string;
  tool?: string;
  target?: string;
  correlationId?: string;
  /**
   * Event classification from `@memora-hq/memora-local`, carried to the renderer over IPC. The
   * renderer is a sandboxed browser bundle and cannot import `@memora-hq/memora-local` at runtime,
   * so this is how the timeline shares one taxonomy with the session summary.
   */
  category?: EventCategory;
  status?: EventStatus;
  role?: EventRole;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function provider(value: unknown, source: string): LocalEventPresentation["provider"] {
  if (value === "codex" || value === "claude" || value === "cursor" || value === "vscode") return value;
  if (source.startsWith("codex")) return "codex";
  if (source.startsWith("claude")) return "claude";
  if (source.startsWith("cursor")) return "cursor";
  if (source.startsWith("vscode")) return "vscode";
  return "local";
}

function providerName(value: LocalEventPresentation["provider"]): string {
  return value === "codex" ? "Codex"
    : value === "claude" ? "Claude"
    : value === "cursor" ? "Cursor"
    : value === "vscode" ? "GitHub Copilot"
    : "the local agent";
}

function safeTarget(input: Record<string, unknown>): string | undefined {
  const path = string(input.file_path) ?? string(input.path) ?? string(input.notebook_path);
  if (path) return path;
  const command = string(input.command);
  if (command) {
    const executable = command.split(/\s+/)[0];
    return executable ? basename(executable) : undefined;
  }
  return undefined;
}

export function presentLocalEvent(event: LocalEventRecordV1, payload?: MemoryPayload): LocalEventPresentation {
  return { ...describeLocalEvent(event, payload), ...classifyEventType(event.commit.event_type) };
}

/**
 * Facts that only exist inside decrypted payloads, gathered for the session summary.
 * File paths come from file-category events only: `safeTarget` returns a command basename
 * for tool events, which must never be counted as a changed file.
 */
export function collectSessionFacts(presentations: Record<string, LocalEventPresentation>): SessionSummaryFacts {
  const values = Object.values(presentations);
  return {
    filePaths: values.filter((item) => item.category === "file").map((item) => item.target).filter((path): path is string => Boolean(path)),
    toolNames: values.filter((item) => item.category === "tool").map((item) => item.tool).filter((tool): tool is string => Boolean(tool)),
  };
}

function describeLocalEvent(event: LocalEventRecordV1, payload?: MemoryPayload): LocalEventPresentation {
  const content = record(payload?.content);
  const integration = provider(content.provider, event.commit.mission_id?.split(":")[0] ?? event.source);
  const agent = providerName(integration);
  const type = event.commit.event_type ?? "execution_event";
  const tool = string(content.tool_name) ?? string(content.tool);
  const input = record(content.tool_input);
  const target = safeTarget(input) ?? string(content.path) ?? string(content.executable);
  const correlationId = string(content.tool_use_id) ?? string(content.tool_call_id) ?? string(content.call_id);

  if (type === "prompt_submitted") {
    return { provider: integration, title: "Prompt submitted", detail: `A new request was sent to ${agent}.` };
  }
  if (type === "tool_requested") {
    return {
      provider: integration,
      title: tool ? `${tool} requested` : "Tool requested",
      detail: target ? `${agent} prepared to use ${tool ?? "a tool"} on ${target}.` : `${agent} prepared a tool call.`,
      tool,
      target,
      ...(correlationId ? { correlationId } : {}),
    };
  }
  if (type === "tool_completed" || type === "tool_called") {
    return {
      provider: integration,
      title: tool ? `${tool} completed` : "Tool completed",
      detail: target ? `${agent} used ${tool ?? "a tool"} on ${target}.` : `${agent} completed a tool call.`,
      tool,
      target,
      ...(correlationId ? { correlationId } : {}),
    };
  }
  if (type === "tool_failed") {
    return {
      provider: integration,
      title: tool ? `${tool} failed` : "Tool failed",
      detail: target ? `${agent} could not complete ${tool ?? "the tool"} on ${target}.` : `${agent} reported a failed tool call.`,
      tool,
      target,
      ...(correlationId ? { correlationId } : {}),
    };
  }
  if (type === "approval_requested") return { provider: integration, title: "Approval requested", detail: `${agent} paused for user approval.` };
  if (type === "approval_denied") return { provider: integration, title: "Approval denied", detail: `A requested ${agent} action was not approved.` };
  if (type === "file_changed" || type === "file_saved") {
    return {
      provider: integration,
      title: type === "file_saved" ? "File saved" : "File changed",
      detail: target ? `${agent} recorded a change to ${target}.` : "A workspace file change was recorded.",
      target,
    };
  }
  if (type === "process_started") {
    return { provider: integration, title: "Process started", detail: target ? `Started ${basename(target)} under local observation.` : "A local process started under observation.", target };
  }
  if (type === "process_exited") return { provider: integration, title: "Process exited", detail: "The observed process finished and its exit state was recorded." };
  if (type.includes("session_started")) return { provider: integration, title: `${agent} session started`, detail: "Memora began observing this execution." };
  if (type.includes("session_ended") || type === "session_completed" || type === "turn_completed") {
    return { provider: integration, title: type === "turn_completed" ? "Turn completed" : `${agent} session ended`, detail: "Memora sealed the events recorded up to this point." };
  }
  if (type === "terminal_output") return { provider: integration, title: "Terminal activity", detail: "Terminal output was captured and stored as encrypted evidence." };
  return { provider: integration, title: type.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), detail: `An event from ${agent} was recorded.` };
}
