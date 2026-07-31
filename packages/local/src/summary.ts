import type { LocalEventRecordV1, LocalExecutionManifestV1 } from "@smritheon/memora-protocol";
import { getAdapter } from "./adapters/registry.js";
import type { CaptureTier } from "./adapters/types.js";
import { isSecretPath } from "./capture.js";
import { resolveTier } from "./captureTier.js";
import { classifyEventType } from "./eventTaxonomy.js";

/**
 * Detail that only exists inside encrypted payloads. A caller holding the decryption key
 * (the desktop main process) can supply it; a caller verifying someone else's bundle cannot.
 * Every claim derived from it is omitted when it is absent — the summary never guesses.
 */
export interface SessionSummaryFacts {
  /** Paths from file-category events only. Never tool-command basenames. */
  filePaths?: string[];
  toolNames?: string[];
}

export interface SessionSummaryCounts {
  prompts: number;
  toolCalls: number;
  fileChanges: number;
  approvalsRequested: number;
  approvalsDenied: number;
  failures: number;
  totalEvents: number;
  backgroundEvents: number;
}

export type SecretsObservation = "no-secret-paths-observed" | "secret-paths-observed" | "unknown";

export interface SessionSummary {
  agentLabel: string;
  tier: CaptureTier;
  tierReasons: string[];
  counts: SessionSummaryCounts;
  durationMs?: number;
  /** Distinct paths, only when facts.filePaths was supplied. */
  distinctFileCount?: number;
  secrets: SecretsObservation;
  headline: string;
  sentences: string[];
  caveats: string[];
}

/** Deliberately not `toLocaleString()` — locale-dependent output would make callers machine-dependent. */
function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0]!;
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses.at(-1)}`;
}

function adapterIdOf(captureSource: string): string {
  return captureSource.endsWith("-hooks") ? captureSource.slice(0, -"-hooks".length) : captureSource;
}

function countActivity(events: LocalEventRecordV1[]): SessionSummaryCounts {
  const counts: SessionSummaryCounts = {
    prompts: 0,
    toolCalls: 0,
    fileChanges: 0,
    approvalsRequested: 0,
    approvalsDenied: 0,
    failures: 0,
    totalEvents: events.length,
    backgroundEvents: 0,
  };
  let toolOpens = 0;
  let toolCloses = 0;

  for (const event of events) {
    const { category, role, status } = classifyEventType(event.commit.event_type);
    if (!category) counts.backgroundEvents += 1;
    if (category === "prompt") counts.prompts += 1;
    if (category === "file") counts.fileChanges += 1;
    if (category === "approval" && status === "running") counts.approvalsRequested += 1;
    if (status === "denied") counts.approvalsDenied += 1;
    if (status === "failed") counts.failures += 1;
    if (role === "tool-open") toolOpens += 1;
    if (role === "tool-close") toolCloses += 1;
  }

  // One invocation emits both a request and a completion, so counting every tool event would
  // double it. This is an event count, unlike the desktop timeline's correlated-item count:
  // the two agree on well-formed hook streams and can diverge on interrupted sessions.
  counts.toolCalls = toolOpens > 0 ? toolOpens : toolCloses;
  return counts;
}

function sealingSentence(totalEvents: number, signed: boolean): string {
  const sealed = totalEvents === 0
    ? "No evidence records have been sealed yet."
    : totalEvents === 1
      ? "1 evidence record was sealed on this device."
      : `All ${String(totalEvents)} evidence records were sealed on this device.`;
  return signed ? `${sealed} This session is signed.` : sealed;
}

function durationOf(manifest: LocalExecutionManifestV1): number | undefined {
  if (!manifest.completed_at) return undefined;
  const started = new Date(manifest.started_at).getTime();
  const completed = new Date(manifest.completed_at).getTime();
  if (Number.isNaN(started) || Number.isNaN(completed) || completed < started) return undefined;
  return completed - started;
}

/**
 * A deterministic, plain-language reading of one local session.
 *
 * Describes observed events only. It never asserts that the record is verified or unaltered —
 * that claim belongs to `verifySession`, which is async and checks signatures.
 */
export function summarizeSession(
  manifest: LocalExecutionManifestV1,
  events: LocalEventRecordV1[],
  facts?: SessionSummaryFacts,
): SessionSummary {
  const adapter = getAdapter(adapterIdOf(manifest.capture_source));
  // Wrapper sessions carry an opaque agent_id like "local:local_agent:01d78cdb"; naming it
  // would be noise, not information.
  const agentLabel = adapter?.displayName ?? "The local agent";
  const { tier, reasons } = resolveTier(manifest, events);
  const counts = countActivity(events);
  const durationMs = durationOf(manifest);
  const distinctPaths = facts?.filePaths ? [...new Set(facts.filePaths)] : undefined;
  const secretPaths = distinctPaths?.filter((path) => isSecretPath(path)) ?? [];

  const clauses: string[] = [];
  if (counts.prompts > 0) clauses.push(`sent ${plural(counts.prompts, "request", "requests")}`);
  if (counts.toolCalls > 0) clauses.push(`ran ${plural(counts.toolCalls, "tool call", "tool calls")}`);
  if (distinctPaths !== undefined) {
    if (distinctPaths.length > 0) clauses.push(`changed ${plural(distinctPaths.length, "file", "files")}`);
  } else if (counts.fileChanges > 0) {
    clauses.push(`recorded ${plural(counts.fileChanges, "file change", "file changes")}`);
  }

  // A wrapper session can hold thousands of records and still classify none of them, so
  // "nothing was recorded" would be wrong — say that no *tool-level* detail exists instead.
  const headline = clauses.length
    ? `${agentLabel} ${joinClauses(clauses)}.`
    : counts.totalEvents > 0
      ? `${agentLabel} ran under observation, but no prompts, tool calls, or file changes were identified in this session.`
      : `${agentLabel} started a session, but no actions have been recorded yet.`;

  const sentences: string[] = [];
  if (distinctPaths !== undefined && distinctPaths.length > 0) {
    if (secretPaths.length === 0) sentences.push("None of the files it touched look like secrets.");
    else {
      const clause = secretPaths.length === 1
        ? "It touched 1 file that looks like a secret."
        : `It touched ${String(secretPaths.length)} files that look like secrets.`;
      sentences.push(`${clause} Memora recorded the change but never read the contents.`);
    }
  }
  sentences.push(sealingSentence(counts.totalEvents, manifest.signature !== null));

  const caveats: string[] = [];
  if (tier !== "deep") caveats.push(...reasons);
  if (manifest.capture_status === "interrupted") caveats.push("Capture stopped before the session finished, so the record may be incomplete.");
  else if (manifest.capture_status === "partial") caveats.push("Some of this session's activity was not captured.");
  if (counts.failures > 0) caveats.push(`${plural(counts.failures, "action", "actions")} failed during this session.`);
  if (counts.approvalsDenied > 0) caveats.push(`${plural(counts.approvalsDenied, "action was", "actions were")} not approved.`);
  for (const warning of manifest.capture_warnings) caveats.push(warning.message);

  return {
    agentLabel,
    tier,
    tierReasons: reasons,
    counts,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(distinctPaths !== undefined ? { distinctFileCount: distinctPaths.length } : {}),
    // No observed paths is not the same as "no secrets touched" — a deep hook session
    // records file edits as tool calls and emits no file paths at all.
    secrets: !distinctPaths?.length ? "unknown" : secretPaths.length > 0 ? "secret-paths-observed" : "no-secret-paths-observed",
    headline,
    sentences,
    caveats,
  };
}
