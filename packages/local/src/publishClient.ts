import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LocalEvidenceBundleV2 } from "@memora-hq/memora-protocol";

export type PublishAttemptState = "PREPARED" | "UPLOADING" | "PUBLISHED";

export interface PublishAttempt {
  session: string;
  attempt_id: string;
  artifact_digest: string;
  state: PublishAttemptState;
  publication_id?: string;
}

function publishAttemptPath(dataRoot: string, sessionId: string): string {
  return join(dataRoot, "publish-attempts", `${sessionId}.json`);
}

export async function loadPublishAttempt(dataRoot: string, sessionId: string): Promise<PublishAttempt | null> {
  try {
    return JSON.parse(await readFile(publishAttemptPath(dataRoot, sessionId), "utf8")) as PublishAttempt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function savePublishAttempt(dataRoot: string, attempt: PublishAttempt): Promise<void> {
  const path = publishAttemptPath(dataRoot, attempt.session);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(attempt), { mode: 0o600 });
}

/**
 * Reuses an in-flight attempt for the exact same artifact content (so a dropped connection
 * after server-side storage but before the client saw the response doesn't orphan an upload
 * on retry), but starts a fresh attempt — fresh ID, fresh key, upstream — whenever the content
 * changed or the previous attempt already completed. Every publish of unchanged content is
 * still a fresh, independent upload; this only prevents *retries* from doubling up.
 */
export async function resolvePublishAttempt(dataRoot: string, sessionId: string, artifactDigest: string): Promise<PublishAttempt> {
  const existing = await loadPublishAttempt(dataRoot, sessionId);
  if (existing && existing.state !== "PUBLISHED" && existing.artifact_digest === artifactDigest) return existing;
  const fresh: PublishAttempt = { session: sessionId, attempt_id: randomUUID(), artifact_digest: artifactDigest, state: "PREPARED" };
  await savePublishAttempt(dataRoot, fresh);
  return fresh;
}

export async function clearPublishAttempt(dataRoot: string, sessionId: string): Promise<void> {
  await unlink(publishAttemptPath(dataRoot, sessionId)).catch(() => undefined);
}

export interface CreatePublicationRequest {
  baseUrl: string;
  token: string;
  attemptId: string;
  bundle: LocalEvidenceBundleV2;
  byteSize: number;
  fetchImpl?: typeof fetch;
}

export interface CreatePublicationResult {
  version: number;
  id: string;
}

/**
 * POSTs the versioned publish envelope. The server never receives the fragment key or a
 * pointer back into Local's own database — just a self-contained artifact — and never returns
 * a share_url either: the CLI assembles that client-side so the key never transits the API.
 */
export async function createPublication(request: CreatePublicationRequest): Promise<CreatePublicationResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const response = await fetchImpl(`${request.baseUrl}/api/v1/publications`, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.memora.publish+json",
      Authorization: `Bearer ${request.token}`,
      "Idempotency-Key": request.attemptId,
    },
    body: JSON.stringify({
      version: 1,
      artifact: request.bundle,
      metadata: { byte_size: request.byteSize },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Publish failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return (await response.json()) as CreatePublicationResult;
}

export interface DeletePublicationRequest {
  baseUrl: string;
  token: string;
  publicationId: string;
  fetchImpl?: typeof fetch;
}

/** Authorized by the same account session that published — not a separate bearer secret. */
export async function deletePublication(request: DeletePublicationRequest): Promise<void> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const response = await fetchImpl(`${request.baseUrl}/api/v1/publications/${encodeURIComponent(request.publicationId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${request.token}` },
  });
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Unpublish failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
}
