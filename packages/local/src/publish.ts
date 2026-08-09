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

/**
 * Re-encrypts every event's payload under a fresh, single-use AES key, decrypting first with
 * the local identity's content key and verifying each plaintext still matches the signed
 * `payload_hash` before it's allowed to travel any further. `payload_hash` covers plaintext,
 * not ciphertext, so this re-encryption never invalidates any signature.
 */
function rebuildPayloadsUnderFreshKey(
  events: LocalEventRecordV1[],
  payloads: Record<string, EncryptedPayloadBundle>,
  identity: LocalIdentity,
  publishKey: Buffer,
): Record<string, EncryptedPayloadBundle> {
  const localKey = deriveLocalEncryptionKey(identity);
  const rebuilt: Record<string, EncryptedPayloadBundle> = {};
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
    rebuilt[objectId] = encrypt(plaintext, publishKey);
  }
  return rebuilt;
}

function finalizeArtifact(
  manifest: LocalEvidenceBundleV2["manifest"],
  events: LocalEventRecordV1[],
  payloads: Record<string, EncryptedPayloadBundle>,
  publishKey: Buffer,
): PublishArtifact {
  const bundle: LocalEvidenceBundleV2 = { format: "memora.local.bundle", version: 2, manifest, events, payloads };
  const serialized = JSON.stringify(bundle);
  return {
    bundle,
    key: publishKey.toString("base64url"),
    byteSize: Buffer.byteLength(serialized),
    eventCount: events.length,
    digest: createHash("sha256").update(serialized).digest("hex"),
  };
}

/** Builds a publish artifact directly from the local evidence store for a live session. */
export async function buildPublishArtifact(
  store: LocalEvidenceStore,
  sessionId: string,
  identity: LocalIdentity,
): Promise<PublishArtifact> {
  const manifest = await store.readManifest(sessionId);
  const events = await store.readEvents(sessionId);
  const sealedPayloads: Record<string, EncryptedPayloadBundle> = {};
  for (const event of events) {
    const objectId = localObjectId(event.commit);
    sealedPayloads[objectId] = await store.readPayload(sessionId, objectId);
  }
  const publishKey = generateAesKey();
  const payloads = rebuildPayloadsUnderFreshKey(events, sealedPayloads, identity, publishKey);
  return finalizeArtifact(manifest, events, payloads, publishKey);
}

/**
 * Builds a publish artifact from an already-exported `.memora` bundle (`memora local publish
 * ./session.memora`) — the hosted service never needs privileged access to Local's internal
 * database, just a valid bundle.
 */
export function buildPublishArtifactFromBundle(bundle: LocalEvidenceBundle, identity: LocalIdentity): PublishArtifact {
  const publishKey = generateAesKey();
  const payloads = rebuildPayloadsUnderFreshKey(bundle.events, bundle.payloads, identity, publishKey);
  return finalizeArtifact(bundle.manifest, bundle.events, payloads, publishKey);
}

export function assertPublishSize(byteSize: number): void {
  if (byteSize > PUBLISH_SIZE_LIMIT_BYTES) throw new PublishArtifactTooLargeError(byteSize);
}
