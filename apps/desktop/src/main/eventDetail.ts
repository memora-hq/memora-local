import type { LocalEventRecordV1, MemoryPayload } from "@memora-hq/memora-protocol";
import type { LocalEventPresentation } from "./eventPresentation.js";

export interface LocalDecryptedEventDetail {
  eventId: string;
  eventType: string;
  provider: LocalEventPresentation["provider"];
  prompt?: unknown;
  tool?: {
    name?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
  metadata: Record<string, string | number | boolean | null>;
  rawContent: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstDefined(content: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (content[name] !== undefined && content[name] !== null) return content[name];
  }
  return undefined;
}

function firstString(content: Record<string, unknown>, names: string[]): string | undefined {
  const value = firstDefined(content, names);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function providerFor(content: Record<string, unknown>, presentation: LocalEventPresentation): LocalEventPresentation["provider"] {
  const provider = content.provider;
  return provider === "codex" || provider === "claude" || provider === "cursor" || provider === "vscode"
    ? provider
    : presentation.provider;
}

function metadataFor(content: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const excluded = new Set([
    "prompt",
    "user_prompt",
    "message",
    "tool_input",
    "input",
    "tool_response",
    "tool_output",
    "output",
    "result",
    "error",
    "tool_error",
    "transcript_path",
  ]);
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(content)) {
    if (excluded.has(key)) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    }
  }
  return output;
}

export function revealLocalEvent(
  event: LocalEventRecordV1,
  payload: MemoryPayload,
  presentation: LocalEventPresentation,
): LocalDecryptedEventDetail {
  const content = record(payload.content);
  const eventType = event.commit.event_type ?? payload.event_type ?? "execution_event";
  const prompt = eventType === "prompt_submitted"
    ? firstDefined(content, ["prompt", "user_prompt", "message", "input"])
    : undefined;
  const toolName = firstString(content, ["tool_name", "tool"]);
  const toolInput = firstDefined(content, ["tool_input", "input"]);
  const toolOutput = firstDefined(content, ["tool_response", "tool_output", "output", "result"]);
  const toolError = firstDefined(content, ["tool_error", "error"]);
  const hasTool = Boolean(toolName)
    || eventType === "tool_requested"
    || eventType === "tool_completed"
    || eventType === "tool_called"
    || eventType === "tool_failed";

  return {
    eventId: event.commit.event_id ?? event.commit.memory_id,
    eventType,
    provider: providerFor(content, presentation),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(hasTool ? {
      tool: {
        ...(toolName ? { name: toolName } : {}),
        ...(toolInput !== undefined ? { input: toolInput } : {}),
        ...(toolOutput !== undefined ? { output: toolOutput } : {}),
        ...(toolError !== undefined ? { error: toolError } : {}),
      },
    } : {}),
    metadata: metadataFor(content),
    rawContent: payload.content,
  };
}
