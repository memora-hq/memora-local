import type { LocalEventRecordV1, LocalExecutionManifestV1 } from "@memora-hq/memora-protocol";
import type { EventCategory, EventStatus, IntegrationHealth } from "@memora-hq/memora-local";

export type SessionProvider = "codex" | "claude" | "cursor" | "vscode" | "local";
/**
 * Event classification comes from `@memora-hq/memora-local`'s taxonomy, delivered per event on
 * `LocalEventPresentation` by the main process. The renderer is a sandboxed browser bundle
 * and cannot import that package at runtime, so IPC — not an import — is how the timeline
 * and the session summary stay on one implementation.
 */
export type TraceCategory = EventCategory;
export type TraceStatus = EventStatus;

export interface TraceItem {
  id: string;
  eventIds: string[];
  category: TraceCategory;
  status: TraceStatus;
  timestamp: string;
  completedAt?: string;
  title: string;
  detail: string;
  tool?: string;
  target?: string;
  correlationId?: string;
}

export interface TraceTurn {
  id: string;
  label: string;
  startedAt: string;
  completedAt?: string;
  items: TraceItem[];
  hiddenEventCount: number;
  totalEventCount: number;
}

export interface TraceViewModel {
  turns: TraceTurn[];
  totalEvents: number;
  visibleActions: number;
  toolCalls: number;
  fileChanges: number;
  promptCount: number;
}

export function humanize(value?: string): string {
  if (!value) return "Unknown";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function shortHash(value?: string, visible = 12): string {
  if (!value) return "Unavailable";
  if (value.length <= visible * 2 + 1) return value;
  return `${value.slice(0, visible)}…${value.slice(-visible)}`;
}

export function formatTime(value?: string): string {
  if (!value) return "Unknown time";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

export function formatDateTime(value?: string): string {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(parsed);
}

export function healthLabel(health?: IntegrationHealth): string {
  return health ? humanize(health) : "Not tested";
}

export function eventLabel(event: LocalEventRecordV1): string {
  return humanize(event.commit.event_type ?? "Execution event");
}

export function sessionDuration(session: LocalExecutionManifestV1): string {
  if (!session.completed_at) return "Capturing now";
  const duration = new Date(session.completed_at).getTime() - new Date(session.started_at).getTime();
  if (!Number.isFinite(duration) || duration < 0) return "Duration unavailable";
  if (duration < 1_000) return `${duration} ms`;
  if (duration < 60_000) return `${Math.round(duration / 1_000)} sec`;
  return `${Math.round(duration / 60_000)} min`;
}

export function providerForSession(session: LocalExecutionManifestV1): SessionProvider {
  const source = `${session.capture_source} ${session.agent_id}`.toLowerCase();
  if (source.includes("codex")) return "codex";
  if (source.includes("claude")) return "claude";
  if (source.includes("cursor")) return "cursor";
  if (source.includes("vscode") || source.includes("copilot")) return "vscode";
  return "local";
}

export function groupSessionsByProvider(sessions: LocalExecutionManifestV1[]): Array<{ provider: SessionProvider; sessions: LocalExecutionManifestV1[] }> {
  const order: SessionProvider[] = ["codex", "claude", "cursor", "vscode", "local"];
  return order
    .map((provider) => ({ provider, sessions: sessions.filter((session) => providerForSession(session) === provider) }))
    .filter((group) => group.sessions.length > 0);
}

export function groupEvents(events: LocalEventRecordV1[]): Array<{ label: string; events: LocalEventRecordV1[] }> {
  const groups = new Map<string, LocalEventRecordV1[]>();
  for (const event of events) {
    const date = new Date(event.observed_at);
    const key = Number.isNaN(date.getTime())
      ? "Recorded events"
      : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
    const current = groups.get(key) ?? [];
    current.push(event);
    groups.set(key, current);
  }
  return [...groups].map(([label, grouped]) => ({ label, events: grouped }));
}

function eventId(event: LocalEventRecordV1): string {
  return event.commit.event_id ?? event.commit.memory_id;
}

function chronological(events: LocalEventRecordV1[]): LocalEventRecordV1[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftTime = new Date(left.event.observed_at).getTime();
      const rightTime = new Date(right.event.observed_at).getTime();
      const safeLeft = Number.isNaN(leftTime) ? Number.MAX_SAFE_INTEGER : leftTime;
      const safeRight = Number.isNaN(rightTime) ? Number.MAX_SAFE_INTEGER : rightTime;
      return safeLeft - safeRight || left.index - right.index;
    })
    .map(({ event }) => event);
}

function pendingTool(turn: TraceTurn, presentation?: LocalEventPresentation): TraceItem | undefined {
  const candidates = turn.items.filter((item) => item.category === "tool" && item.status === "running");
  if (presentation?.correlationId) {
    const exact = candidates.find((item) => item.correlationId === presentation.correlationId);
    if (exact) return exact;
  }
  if (presentation?.tool) {
    const sameTool = [...candidates].reverse().find((item) => item.tool === presentation.tool);
    if (sameTool) return sameTool;
  }
  return candidates.at(-1);
}

export function buildTrace(
  events: LocalEventRecordV1[],
  presentations: Record<string, LocalEventPresentation>,
): TraceViewModel {
  const ordered = chronological(events);
  const turns: TraceTurn[] = [];
  let current: TraceTurn | undefined;
  let promptNumber = 0;

  const ensureTurn = (timestamp: string): TraceTurn => {
    if (current) return current;
    current = {
      id: `activity-${turns.length + 1}`,
      label: promptNumber ? `Turn ${promptNumber}` : "Session setup",
      startedAt: timestamp,
      items: [],
      hiddenEventCount: 0,
      totalEventCount: 0,
    };
    turns.push(current);
    return current;
  };

  for (const event of ordered) {
    const id = eventId(event);
    const presentation = presentations[id];

    if (presentation?.role === "turn-start") {
      promptNumber += 1;
      current = {
        id: `turn-${promptNumber}-${id}`,
        label: `Turn ${promptNumber}`,
        startedAt: event.observed_at,
        items: [],
        hiddenEventCount: 0,
        totalEventCount: 0,
      };
      turns.push(current);
    }

    const turn = ensureTurn(event.observed_at);
    turn.totalEventCount += 1;
    const category = presentation?.category;
    if (!category) {
      turn.hiddenEventCount += 1;
      if (presentation?.role === "turn-end") turn.completedAt = event.observed_at;
      continue;
    }

    if (presentation?.role === "tool-close") {
      const pending = pendingTool(turn, presentation);
      if (pending) {
        pending.eventIds.push(id);
        pending.id = id;
        pending.status = presentation.status ?? "completed";
        pending.completedAt = event.observed_at;
        pending.title = presentation?.title ?? eventLabel(event);
        pending.detail = presentation?.detail ?? pending.detail;
        pending.target = presentation?.target ?? pending.target;
        continue;
      }
    }

    turn.items.push({
      id,
      eventIds: [id],
      category,
      status: presentation?.status ?? "completed",
      timestamp: event.observed_at,
      title: presentation?.title ?? eventLabel(event),
      detail: presentation?.detail ?? `${humanize(event.source)} evidence was recorded.`,
      ...(presentation?.tool ? { tool: presentation.tool } : {}),
      ...(presentation?.target ? { target: presentation.target } : {}),
      ...(presentation?.correlationId ? { correlationId: presentation.correlationId } : {}),
    });
  }

  const populatedTurns = turns.filter((turn) => turn.totalEventCount > 0);
  const items = populatedTurns.flatMap((turn) => turn.items);
  return {
    turns: populatedTurns,
    totalEvents: ordered.length,
    visibleActions: items.length,
    toolCalls: items.filter((item) => item.category === "tool").length,
    fileChanges: items.filter((item) => item.category === "file").length,
    promptCount: items.filter((item) => item.category === "prompt").length,
  };
}
