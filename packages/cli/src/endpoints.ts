/**
 * Where the CLI's API-backed (tier 2) reads and writes point.
 *
 * Two modes:
 *
 *   gateway mode — `MEMORA_BASE_URL` is set. Everything goes through the public
 *     gateway edge (`@memora/gateway`) on its `/v1/*` paths. This is the only
 *     mode that can reach a hosted deployment: the indexer and key-broker are
 *     never exposed directly.
 *
 *   direct mode — the local-development default. Separate indexer and
 *     key-broker origins, each on its own native paths.
 *
 * Tier 1 (offline `.memora` bundle verification) uses none of this — it makes
 * no network calls at all.
 */

export interface CliEndpoints {
  /** Base URL for indexer-role calls (the gateway itself in gateway mode). */
  indexerBaseUrl: string;
  /** Base URL for key-broker-role calls (the gateway itself in gateway mode). */
  keyBrokerBaseUrl: string;
  /**
   * True when `MEMORA_BASE_URL` selected the gateway. Drives the path shape of
   * the CLI's *own* fetches (`resolveRef`, batch proof) and whether they carry a
   * bearer token — gateway reads are authenticated.
   */
  gatewayMode: boolean;
  /**
   * What `MemoraClient` is constructed with. Implied by gateway mode, and still
   * independently settable via the pre-existing `MEMORA_USE_V1_ROUTES=1` knob
   * for anyone pointing `INDEXER_BASE_URL` at a gateway by hand.
   */
  clientV1Routes: boolean;
}

export function resolveCliEndpoints(env: NodeJS.ProcessEnv = process.env): CliEndpoints {
  const baseUrl = env.MEMORA_BASE_URL?.trim();
  if (baseUrl) {
    return {
      indexerBaseUrl:   baseUrl,
      keyBrokerBaseUrl: baseUrl,
      gatewayMode:      true,
      clientV1Routes:   true,
    };
  }
  return {
    indexerBaseUrl:   env.INDEXER_BASE_URL    || "http://localhost:3001",
    keyBrokerBaseUrl: env.KEY_BROKER_BASE_URL || "http://localhost:3000",
    gatewayMode:      false,
    clientV1Routes:   env.MEMORA_USE_V1_ROUTES === "1",
  };
}

/** Merkle batch proof for one event: `GET /v1/batches/proof` vs `GET /batch-proof`. */
export function batchProofUrl(endpoints: CliEndpoints, eventId: string): string {
  const base = endpoints.indexerBaseUrl.replace(/\/$/, "");
  const qs   = `?event_id=${encodeURIComponent(eventId)}`;
  return endpoints.gatewayMode ? `${base}/v1/batches/proof${qs}` : `${base}/batch-proof${qs}`;
}
