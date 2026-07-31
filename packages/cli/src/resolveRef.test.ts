import { afterEach, describe, expect, it, vi } from "vitest";
import { getLookupId, memoryRefUrl, parseExecutionLookupId, resolveRef } from "./resolveRef.js";
import { batchProofUrl, resolveCliEndpoints } from "./endpoints.js";

describe("parseExecutionLookupId", () => {
  it("treats 0x-prefixed 32-byte hex as memory_id", () => {
    const id = "0x" + "ab".repeat(32);
    expect(parseExecutionLookupId(id)).toEqual({ kind: "memory_id", value: id });
  });

  it("treats bare 64-char hex as event_id", () => {
    const id = "cd".repeat(32).toUpperCase();
    expect(parseExecutionLookupId(id)).toEqual({ kind: "event_id", value: id.toLowerCase() });
  });

  it("treats UUIDs as memory_id", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseExecutionLookupId(id)).toEqual({ kind: "memory_id", value: id });
  });

  it("treats opaque execution ids as memory_id", () => {
    expect(parseExecutionLookupId("mem_tr_013")).toEqual({ kind: "memory_id", value: "mem_tr_013" });
  });
});

describe("getLookupId", () => {
  it("prefers positional ids", () => {
    expect(getLookupId(["receipt", "mem_123"], 1)).toBe("mem_123");
  });

  it("falls back to --memory", () => {
    expect(getLookupId(["verify", "--memory", "mem_123"], 1)).toBe("mem_123");
  });
});

describe("memoryRefUrl", () => {
  it("uses the direct indexer path by default", () => {
    expect(memoryRefUrl("http://localhost:3001", "0xabc")).toBe("http://localhost:3001/memory/0xabc");
  });

  it("uses the gateway /v1/events path when v1Routes is set", () => {
    expect(memoryRefUrl("https://api.getmemora.dev", "0xabc", true))
      .toBe("https://api.getmemora.dev/v1/events/0xabc");
  });

  it("strips a trailing slash and encodes the id in both modes", () => {
    expect(memoryRefUrl("http://localhost:3001/", "a b")).toBe("http://localhost:3001/memory/a%20b");
    expect(memoryRefUrl("https://gw/", "a b", true)).toBe("https://gw/v1/events/a%20b");
  });
});

describe("resolveRef", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubFetch() {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ memory_id: "0xabc" }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("fetches the direct indexer path with no Authorization header", async () => {
    const fetchMock = stubFetch();
    await resolveRef("http://localhost:3001", "mem_123");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3001/memory/mem_123", undefined);
  });

  it("fetches the gateway path with a bearer token in gateway mode", async () => {
    const fetchMock = stubFetch();
    await resolveRef("https://api.getmemora.dev", "mem_123", { v1Routes: true, authToken: "key_abc" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.getmemora.dev/v1/events/mem_123", {
      headers: { Authorization: "Bearer key_abc" },
    });
  });

  it("normalizes the looked-up id before building the URL", async () => {
    const fetchMock = stubFetch();
    const eventId = "CD".repeat(32);
    await resolveRef("http://localhost:3001", eventId);
    expect(fetchMock).toHaveBeenCalledWith(`http://localhost:3001/memory/${eventId.toLowerCase()}`, undefined);
  });

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response));
    expect(await resolveRef("http://localhost:3001", "mem_123")).toBeNull();
  });
});

describe("resolveCliEndpoints", () => {
  it("defaults to direct mode with localhost origins", () => {
    expect(resolveCliEndpoints({})).toEqual({
      indexerBaseUrl:   "http://localhost:3001",
      keyBrokerBaseUrl: "http://localhost:3000",
      gatewayMode:      false,
      clientV1Routes:   false,
    });
  });

  it("honours INDEXER_BASE_URL / KEY_BROKER_BASE_URL in direct mode", () => {
    const endpoints = resolveCliEndpoints({
      INDEXER_BASE_URL:    "http://indexer.internal:3001",
      KEY_BROKER_BASE_URL: "http://broker.internal:3000",
    });
    expect(endpoints.indexerBaseUrl).toBe("http://indexer.internal:3001");
    expect(endpoints.keyBrokerBaseUrl).toBe("http://broker.internal:3000");
    expect(endpoints.gatewayMode).toBe(false);
  });

  it("keeps MEMORA_USE_V1_ROUTES as an independent client-only knob", () => {
    const endpoints = resolveCliEndpoints({ MEMORA_USE_V1_ROUTES: "1" });
    expect(endpoints.clientV1Routes).toBe(true);
    // Does not flip the CLI's own read paths — those stay direct without MEMORA_BASE_URL.
    expect(endpoints.gatewayMode).toBe(false);
  });

  it("uses MEMORA_BASE_URL for both roles and implies v1 routes", () => {
    expect(resolveCliEndpoints({ MEMORA_BASE_URL: "https://api.getmemora.dev" })).toEqual({
      indexerBaseUrl:   "https://api.getmemora.dev",
      keyBrokerBaseUrl: "https://api.getmemora.dev",
      gatewayMode:      true,
      clientV1Routes:   true,
    });
  });

  it("lets MEMORA_BASE_URL win over the direct-mode variables", () => {
    const endpoints = resolveCliEndpoints({
      MEMORA_BASE_URL:     "https://api.getmemora.dev",
      INDEXER_BASE_URL:    "http://indexer.internal:3001",
      KEY_BROKER_BASE_URL: "http://broker.internal:3000",
    });
    expect(endpoints.indexerBaseUrl).toBe("https://api.getmemora.dev");
    expect(endpoints.keyBrokerBaseUrl).toBe("https://api.getmemora.dev");
  });

  it("treats a blank MEMORA_BASE_URL as unset", () => {
    expect(resolveCliEndpoints({ MEMORA_BASE_URL: "   " }).gatewayMode).toBe(false);
  });
});

describe("batchProofUrl", () => {
  const eventId = "ab".repeat(32);

  it("uses the indexer's /batch-proof in direct mode", () => {
    expect(batchProofUrl(resolveCliEndpoints({}), eventId))
      .toBe(`http://localhost:3001/batch-proof?event_id=${eventId}`);
  });

  it("uses the gateway's /v1/batches/proof in gateway mode", () => {
    const endpoints = resolveCliEndpoints({ MEMORA_BASE_URL: "https://api.getmemora.dev/" });
    expect(batchProofUrl(endpoints, eventId))
      .toBe(`https://api.getmemora.dev/v1/batches/proof?event_id=${eventId}`);
  });
});
