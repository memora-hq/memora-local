import type { LocalVerificationResult } from "@memora-hq/memora-local";
import { formatDateTime, humanize, shortHash, type TraceCategory, type TraceViewModel } from "./viewModels";

/**
 * How much of the evidence a reader wants to see. Purely a viewer preference — the record
 * itself is identical at every level; only which parts of it are surfaced changes.
 */
export type ReadingLevel = "everyone" | "power" | "developer";

export const READING_LEVELS: readonly ReadingLevel[] = ["everyone", "power", "developer"];

export const READING_LEVEL_META: Record<ReadingLevel, { short: string; label: string; hint: string }> = {
  everyone: {
    short: "Plain",
    label: "Plain language",
    hint: "Sentences, not hashes. Tells you what the agent did and whether anything looks wrong.",
  },
  power: {
    short: "Power",
    label: "Full timeline",
    hint: "Every turn, tool call, and file change, in order.",
  },
  developer: {
    short: "Dev",
    label: "Developer",
    hint: "Everything above plus hashes, signatures, lineage, and raw payloads.",
  },
};

export function levelAtLeast(current: ReadingLevel, minimum: ReadingLevel): boolean {
  return READING_LEVELS.indexOf(current) >= READING_LEVELS.indexOf(minimum);
}

/** The summary card is the default body only for the plain-language reader. */
export function showsTimelineByDefault(level: ReadingLevel): boolean {
  return level !== "everyone";
}

export function showsRawEvidence(level: ReadingLevel): boolean {
  return level === "developer";
}

export type EvidenceFieldId =
  | "event_id"
  | "event_type"
  | "observed"
  | "capture_source"
  | "agent_id"
  | "schema"
  | "payload_hash"
  | "cid_ciphertext"
  | "signer"
  | "signer_device"
  | "signature"
  | "parent_events"
  | "mission_id"
  | "session_root";

interface EvidenceFieldSpec {
  minimumLevel: ReadingLevel;
  mono?: boolean;
  labels: Partial<Record<ReadingLevel, string>> & { default: string };
}

/**
 * The one place a raw evidence field is allowed to reach the UI. Everything cryptographic is
 * developer-only, so a plain-language reader is never shown a hash they cannot interpret.
 */
export const EVIDENCE_FIELDS: Record<EvidenceFieldId, EvidenceFieldSpec> = {
  event_type: { minimumLevel: "everyone", labels: { default: "Event type", everyone: "What happened" } },
  observed: { minimumLevel: "everyone", labels: { default: "Observed", everyone: "When" } },
  capture_source: { minimumLevel: "everyone", labels: { default: "Capture source", everyone: "How it was captured" } },
  agent_id: { minimumLevel: "everyone", mono: true, labels: { default: "Agent ID", everyone: "Session" } },
  event_id: { minimumLevel: "power", mono: true, labels: { default: "Event ID", developer: "event_id" } },
  parent_events: { minimumLevel: "power", labels: { default: "Parent events" } },
  schema: { minimumLevel: "developer", labels: { default: "Schema" } },
  payload_hash: { minimumLevel: "developer", mono: true, labels: { default: "Content fingerprint", developer: "payload_hash" } },
  cid_ciphertext: { minimumLevel: "developer", mono: true, labels: { default: "Encrypted content reference", developer: "cid_ciphertext" } },
  signer: { minimumLevel: "developer", mono: true, labels: { default: "Signing device", developer: "signer" } },
  // The one cryptographic value a plain-language reader does see, and only ever truncated: a
  // receipt from someone else is meaningless without *some* handle on which device signed it.
  signer_device: { minimumLevel: "everyone", mono: true, labels: { default: "Signing device", everyone: "Device key", developer: "signer" } },
  signature: { minimumLevel: "developer", mono: true, labels: { default: "Device signature", developer: "signature" } },
  mission_id: { minimumLevel: "developer", mono: true, labels: { default: "Mission ID", developer: "mission_id" } },
  session_root: { minimumLevel: "developer", mono: true, labels: { default: "Session root", developer: "session_root" } },
};

export function showsField(id: EvidenceFieldId, level: ReadingLevel): boolean {
  return levelAtLeast(level, EVIDENCE_FIELDS[id].minimumLevel);
}

export function fieldLabel(id: EvidenceFieldId, level: ReadingLevel): string {
  const { labels } = EVIDENCE_FIELDS[id];
  return labels[level] ?? labels.default;
}

export type DisclosureId = "receipt" | "integrity" | "lineage" | "verification";

const DISCLOSURES: Record<DisclosureId, { minimumLevel: ReadingLevel; title: string; hint: string; everyone?: { title: string; hint: string } }> = {
  receipt: {
    minimumLevel: "everyone",
    title: "Receipt metadata",
    hint: "When and where this was observed",
    everyone: { title: "What this action was", hint: "When Memora saw it, and how" },
  },
  lineage: { minimumLevel: "power", title: "Lineage", hint: "Parents and session root" },
  verification: { minimumLevel: "power", title: "Verification checks", hint: "Per-check results for this session" },
  integrity: { minimumLevel: "developer", title: "Integrity evidence", hint: "Hashes, signer, and ciphertext" },
};

/** `undefined` means the disclosure is hidden entirely at this level. */
export function disclosureLabel(id: DisclosureId, level: ReadingLevel): { title: string; hint: string } | undefined {
  const spec = DISCLOSURES[id];
  if (!levelAtLeast(level, spec.minimumLevel)) return undefined;
  if (level === "everyone" && spec.everyone) return spec.everyone;
  return { title: spec.title, hint: spec.hint };
}

export interface AssuranceLabel {
  id: "integrity" | "identity" | "completeness" | "anchoring";
  label: string;
  value: string;
}

const COMPLETENESS_PLAIN: Record<LocalVerificationResult["completeness"], string> = {
  complete: "Full session",
  partial: "Some gaps",
  interrupted: "Cut short",
};

/**
 * The four assurance signals. Below `developer` these are stated in plain language — the raw
 * enum values ("local-only", "self-issued-continuity-verified") mean nothing to most readers.
 */
export function assuranceLabels(verification: LocalVerificationResult | undefined, level: ReadingLevel): AssuranceLabel[] {
  if (!verification) return [];
  if (level === "developer") {
    return [
      { id: "integrity", label: "Integrity", value: humanize(verification.integrity) },
      { id: "identity", label: "Identity", value: humanize(verification.identity) },
      { id: "completeness", label: "Completeness", value: humanize(verification.completeness) },
      { id: "anchoring", label: "Anchoring", value: humanize(verification.anchoring) },
    ];
  }
  return [
    { id: "integrity", label: "Contents", value: verification.integrity === "verified" ? "Unchanged since recording" : "Changed after recording" },
    { id: "identity", label: "Signed by", value: verification.identity === "failed" ? "Identity does not match" : "Same identity throughout" },
    { id: "completeness", label: "Coverage", value: COMPLETENESS_PLAIN[verification.completeness] },
    { id: "anchoring", label: "Stored", value: "Sealed on this device" },
  ];
}

/** Structural mirror of the main process's `SignerTrust`, kept local so the renderer stays standalone. */
export interface SignerIdentity {
  address: string;
  label?: string;
  isThisDevice: boolean;
  known: boolean;
  receiptsVerified?: number;
  firstSeen?: string;
}

export interface SignerStatement {
  title: string;
  lines: string[];
  /** Truncated below `developer` — long enough to compare, short enough to read. */
  address: string;
  canName: boolean;
}

/**
 * How a signing key is described to a reader.
 *
 * Every branch ends at the same caution: a signature establishes that nothing was altered, and
 * nothing whatsoever about who produced it. Continuity ("the same device as last time") is the
 * strongest claim this app is entitled to make.
 */
export function signerStatement(signer: SignerIdentity, level: ReadingLevel): SignerStatement {
  const address = level === "developer" ? signer.address : shortHash(signer.address, 6);
  const caution = "A signature proves the record was not altered after it was sealed. It does not prove who produced it.";

  if (signer.isThisDevice) {
    return { title: "Signed by this device", lines: ["The same Mac that is showing you this receipt recorded and sealed it."], address, canName: false };
  }
  if (signer.label) {
    const lines = [`Memora has seen this device key before and you named it “${signer.label}”.`];
    if (signer.receiptsVerified) {
      lines.push(`${signer.receiptsVerified} receipt${signer.receiptsVerified === 1 ? "" : "s"} verified from it${signer.firstSeen ? `, first seen ${formatDateTime(signer.firstSeen)}` : ""}.`);
    }
    lines.push(caution);
    return { title: `Same device as “${signer.label}”`, lines, address, canName: true };
  }
  if (signer.known && (signer.receiptsVerified ?? 0) > 1) {
    return {
      title: "A device you have verified before",
      lines: [
        `${signer.receiptsVerified} receipts have been verified from this key${signer.firstSeen ? `, first seen ${formatDateTime(signer.firstSeen)}` : ""}. You have not named it yet.`,
        caution,
      ],
      address,
      canName: true,
    };
  }
  return {
    title: "A device Memora has not seen before",
    lines: ["This is the first receipt verified from this key.", caution],
    address,
    canName: true,
  };
}

export type BundleDisclosureState = "none" | "partial" | "full";

/** What the sender chose to reveal — stated before anyone reads a single action. */
export function disclosureStatement(
  disclosure: BundleDisclosureState,
  disclosedCount: number,
  eventCount: number,
): { title: string; detail: string } {
  if (disclosure === "full") {
    return {
      title: "Fully readable",
      detail: `All ${eventCount} records were shared in plain text, and each one matches the signature that covers it.`,
    };
  }
  if (disclosure === "partial") {
    return {
      title: "Partly readable",
      detail: `${disclosedCount} of ${eventCount} records were shared in plain text and matched to their signatures. The rest stay encrypted.`,
    };
  }
  return {
    title: "Sealed",
    detail: "The sender shared proof without content. You can confirm nothing was altered, but the actions themselves stay encrypted.",
  };
}

export function traceFilterLabels(level: ReadingLevel): Array<["all" | TraceCategory, string]> {
  if (level === "everyone") {
    return [
      ["all", "Everything"],
      ["prompt", "Your requests"],
      ["tool", "Actions"],
      ["file", "File changes"],
      ["approval", "Permissions"],
    ];
  }
  return [
    ["all", "All activity"],
    ["prompt", "Prompts"],
    ["tool", "Tools"],
    ["file", "Files"],
    ["approval", "Approvals"],
  ];
}

export function traceCountLabels(trace: TraceViewModel, level: ReadingLevel): { heading: string; aside: string; detail: string } {
  const heading = `${trace.visibleActions} action${trace.visibleActions === 1 ? "" : "s"}`;
  if (level === "everyone") {
    return {
      heading,
      aside: "",
      detail: `${trace.promptCount} request${trace.promptCount === 1 ? "" : "s"} · ${trace.toolCalls} tool call${trace.toolCalls === 1 ? "" : "s"} · ${trace.fileChanges} file change${trace.fileChanges === 1 ? "" : "s"}`,
    };
  }
  return {
    heading,
    aside: `from ${trace.totalEvents} encrypted records`,
    detail: `${trace.promptCount} turns · ${trace.toolCalls} tool calls · ${trace.fileChanges} file changes`,
  };
}
