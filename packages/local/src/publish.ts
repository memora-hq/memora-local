import { createHash } from "node:crypto";
import {
  canonicalizePayload,
  decrypt,
  encrypt,
  generateAesKey,
  hashPayload,
  type EncryptedPayloadBundle,
  type LocalEvidenceBundle,
  type LocalEvidenceBundleV2,
  type LocalEventRecordV1,
} from "@memora-hq/memora-protocol";
import { deriveLocalEncryptionKey, localObjectId, type LocalEvidenceStore, type LocalIdentity } from "@memora-hq/memora-verifier";
import type { PlaintextForScan } from "./secretScan.js";

/**
 * ~25 MB compressed publish artifact. Not a magic number — a shareable Memora execution
 * should normally be dramatically smaller than this. Publish fails hard over the limit
 * rather than ever silently dropping events or payloads.
 */
export const PUBLISH_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;

export class PublishArtifactTooLargeError extends Error {
  constructor(public readonly byteSize: number, public readonly limitBytes = PUBLISH_SIZE_LIMIT_BYTES) {
    super(
      `Session is too large to publish (${(byteSize / 1_000_000).toFixed(1)} MB, limit ${(limitBytes / 1_000_000).toFixed(0)} MB). ` +
      `Nothing was uploaded. Try: memora local export <session-id> --out session.memora`,
    );
    this.name = "PublishArtifactTooLargeError";
  }
}

export interface PublishArtifact {
  /** The re-encrypted bundle: manifest/events pass through untouched, only payloads changes. */
  bundle: LocalEvidenceBundleV2;
  /** Fresh per-publish AES-256 key, base64url — goes in the URL fragment, never sent to the server. */
  key: string;
  /** Size of the bundle as it will be uploaded, in bytes — checked against PUBLISH_SIZE_LIMIT_BYTES. */
  byteSize: number;
  eventCount: number;
  /** sha256 of the serialized bundle — used as the idempotency/retry digest. */
  digest: string;
}

/** A session's plaintext, decrypted and verified but not yet re-encrypted — the point in the
 * publish flow where the secret scan runs, before any encrypt/upload happens. */
export interface DecryptedPublishSession {
  manifest: LocalEvidenceBundleV2["manifest"];
  events: LocalEventRecordV1[];
  /** Decrypted plaintext (raw JSON string) for every event, keyed by object ID. */
  plaintexts: Record<string, string>;
}

/**
 * Decrypts every event's payload with the local identity's content key and verifies each
 * plaintext still matches the signed `payload_hash` before it's allowed to travel any
 * further. Nothing is encrypted yet — that's the caller's job, after the secret scan runs
 * over this plaintext.
 */
function decryptAndVerify(
  events: LocalEventRecordV1[],
  payloads: Record<string, EncryptedPayloadBundle>,
  identity: LocalIdentity,
): Record<string, string> {
  const localKey = deriveLocalEncryptionKey(identity);
  const plaintexts: Record<string, string> = {};
  for (const event of events) {
    const objectId = localObjectId(event.commit);
    const sealed = payloads[objectId];
    if (!sealed) throw new Error(`Local evidence is missing its stored content: ${objectId}`);
    let plaintext: string;
    try {
      plaintext = decrypt(sealed, localKey);
    } catch {
      throw new Error(`Local evidence is damaged and cannot be published: ${objectId}`);
    }
    if (hashPayload(canonicalizePayload(JSON.parse(plaintext))) !== event.commit.payload_hash) {
      throw new Error(`Local evidence is damaged and cannot be published: ${objectId}`);
    }
    plaintexts[objectId] = plaintext;
  }
  return plaintexts;
}

/** Decrypts a live session's payloads from the store — the first half of publishing it. */
export async function decryptPublishSession(
  store: LocalEvidenceStore,
  sessionId: string,
  identity: LocalIdentity,
): Promise<DecryptedPublishSession> {
  const manifest = await store.readManifest(sessionId);
  const events = await store.readEvents(sessionId);
  const sealedPayloads: Record<string, EncryptedPayloadBundle> = {};
  for (const event of events) {
    const objectId = localObjectId(event.commit);
    sealedPayloads[objectId] = await store.readPayload(sessionId, objectId);
  }
  return { manifest, events, plaintexts: decryptAndVerify(events, sealedPayloads, identity) };
}

/** Decrypts an already-exported `.memora` bundle's payloads — the file-path publish source. */
export function decryptPublishBundle(bundle: LocalEvidenceBundle, identity: LocalIdentity): DecryptedPublishSession {
  return {
    manifest: bundle.manifest,
    events: bundle.events,
    plaintexts: decryptAndVerify(bundle.events, bundle.payloads, identity),
  };
}

/** Maps a decrypted session onto scan inputs: one entry per event, labeled for a human to read. */
export function plaintextsForScan(session: DecryptedPublishSession): PlaintextForScan[] {
  return session.events.map((event, index) => ({
    label: `event ${index + 1} (${event.commit.event_type ?? "event"})`,
    text: session.plaintexts[localObjectId(event.commit)] ?? "",
  }));
}

/**
 * Re-encrypts a decrypted session's payloads under a fresh, single-use AES key — the second
 * half of publishing, run only after the secret scan has passed or been acknowledged.
 * `payload_hash` covers plaintext, not ciphertext, so this re-encryption never invalidates any
 * signature; `manifest`/`events` pass through the bundle untouched, only `payloads` is new.
 */
export function finalizePublishArtifact(session: DecryptedPublishSession): PublishArtifact {
  const publishKey = generateAesKey();
  const payloads: Record<string, EncryptedPayloadBundle> = {};
  for (const [objectId, plaintext] of Object.entries(session.plaintexts)) {
    payloads[objectId] = encrypt(plaintext, publishKey);
  }
  const bundle: LocalEvidenceBundleV2 = {
    format: "memora.local.bundle",
    version: 2,
    manifest: session.manifest,
    events: session.events,
    payloads,
  };
  const serialized = JSON.stringify(bundle);
  return {
    bundle,
    key: publishKey.toString("base64url"),
    byteSize: Buffer.byteLength(serialized),
    eventCount: session.events.length,
    digest: createHash("sha256").update(serialized).digest("hex"),
  };
}

/** Builds a publish artifact directly from the local evidence store for a live session. */
export async function buildPublishArtifact(
  store: LocalEvidenceStore,
  sessionId: string,
  identity: LocalIdentity,
): Promise<PublishArtifact> {
  return finalizePublishArtifact(await decryptPublishSession(store, sessionId, identity));
}

/**
 * Builds a publish artifact from an already-exported `.memora` bundle (`memora local publish
 * ./session.memora`) — the hosted service never needs privileged access to Local's internal
 * database, just a valid bundle.
 */
export function buildPublishArtifactFromBundle(bundle: LocalEvidenceBundle, identity: LocalIdentity): PublishArtifact {
  return finalizePublishArtifact(decryptPublishBundle(bundle, identity));
}

export function assertPublishSize(byteSize: number): void {
  if (byteSize > PUBLISH_SIZE_LIMIT_BYTES) throw new PublishArtifactTooLargeError(byteSize);
}
