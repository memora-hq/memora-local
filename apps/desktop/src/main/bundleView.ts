import type { LocalEventRecordV1, LocalEvidenceBundle, LocalExecutionManifestV1 } from "@smritheon/memora-protocol";
import {
  disclosedPayload,
  summarizeSession,
  type BundleDisclosure,
  type LocalBundleVerification,
  type SessionSummary,
} from "@smritheon/memora-local";
import { revealLocalEvent, type LocalDecryptedEventDetail } from "./eventDetail.js";
import { collectSessionFacts, presentLocalEvent, type LocalEventPresentation } from "./eventPresentation.js";

/** What the renderer needs to draw one session, whether it came from this device or a file. */
export interface LocalSessionView {
  manifest: LocalExecutionManifestV1;
  events: LocalEventRecordV1[];
  presentations: Record<string, LocalEventPresentation>;
  summary: SessionSummary;
}

/**
 * A signing key as this device knows it. `known`/`receiptsVerified` describe *continuity* — the
 * same key seen before — and never the identity of whoever holds it.
 */
export interface SignerTrust {
  address: string;
  label?: string;
  isThisDevice: boolean;
  known: boolean;
  receiptsVerified?: number;
  firstSeen?: string;
}

/** The exported `.memora` a receipt document describes, when one was written. */
export interface ReceiptBundleRef {
  fileName?: string;
  fingerprint?: string;
  disclosure: BundleDisclosure;
}

export interface ExportBundleReply {
  canceled: boolean;
  path?: string;
  fileName?: string;
  disclosure?: BundleDisclosure;
  disclosedCount?: number;
  eventCount?: number;
  fingerprint?: string;
}

/** A session view plus the decrypted detail the sender chose to include, keyed by event ID. */
export interface BundleView extends LocalSessionView {
  details: Record<string, LocalDecryptedEventDetail>;
}

export interface BundleVerificationReply extends BundleView {
  path: string;
  fileName: string;
  verification: LocalBundleVerification;
  signer: SignerTrust;
}

/**
 * Turns someone else's bundle into the same shape `local:session` returns, so a foreign receipt
 * renders through the existing summary card and timeline.
 *
 * Sealed records carry no payload, so their presentation falls back to what the unencrypted commit
 * says — the event type — and the summary reports counts without inventing detail.
 */
export function buildBundleView(bundle: LocalEvidenceBundle, disclosure: BundleDisclosure): BundleView {
  const presentations: Record<string, LocalEventPresentation> = {};
  const details: Record<string, LocalDecryptedEventDetail> = {};
  for (const event of bundle.events) {
    const id = event.commit.event_id ?? event.commit.memory_id;
    const payload = disclosedPayload(bundle, event);
    const presentation = presentLocalEvent(event, payload);
    presentations[id] = presentation;
    // Only records the sender chose to reveal have content to show; the rest stay sealed and
    // there is nothing on this device that could open them.
    if (payload) details[id] = revealLocalEvent(event, payload, presentation);
  }
  // Facts gathered from a *subset* of records would understate file counts while reading as exact,
  // so anything short of full disclosure falls back to event-derived phrasing.
  const facts = disclosure === "full" ? collectSessionFacts(presentations) : undefined;
  return {
    manifest: bundle.manifest,
    events: bundle.events,
    presentations,
    details,
    summary: summarizeSession(bundle.manifest, bundle.events, facts),
  };
}
