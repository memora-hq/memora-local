import type { LocalEventRecordV1, LocalExecutionManifestV1 } from "@smritheon/memora-protocol";
import { getAdapter } from "./adapters/registry.js";
import type { CaptureTier } from "./adapters/types.js";

export interface CaptureTierResult {
  tier: CaptureTier;
  reasons: string[];
}

const TOOL_LEVEL_EVENT_TYPES = new Set([
  "tool_requested",
  "tool_completed",
  "tool_failed",
  "approval_requested",
  "approval_denied",
]);

export function resolveTier(
  manifest: LocalExecutionManifestV1,
  events: LocalEventRecordV1[],
): CaptureTierResult {
  if (manifest.capture_source === "process-wrapper") {
    return {
      tier: "wrapper",
      reasons: ["Captured via the generic process wrapper (before/after file diff only); no tool-level events."],
    };
  }

  const adapterId = manifest.capture_source.endsWith("-hooks")
    ? manifest.capture_source.slice(0, -"-hooks".length)
    : manifest.capture_source;
  const adapter = getAdapter(adapterId);
  if (!adapter) {
    return {
      tier: "wrapper",
      reasons: [`Unrecognized capture source '${manifest.capture_source}'; treated as wrapper-tier.`],
    };
  }

  if (adapter.captureTier === "deep") {
    const hasToolLevelEvent = events.some(
      (event) => event.commit.event_type !== undefined && TOOL_LEVEL_EVENT_TYPES.has(event.commit.event_type),
    );
    if (!hasToolLevelEvent) {
      return {
        tier: "partial",
        reasons: [adapter.attributionNote, "No tool-level events observed in this session; hooks may not be fully installed."],
      };
    }
    return { tier: "deep", reasons: [adapter.attributionNote] };
  }

  return { tier: adapter.captureTier, reasons: [adapter.attributionNote] };
}
