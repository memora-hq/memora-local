import type { MemoryRef } from "@memora-hq/memora-protocol";

export type LookupIdKind = "memory_id" | "event_id";

const EVENT_ID_RE = /^[0-9a-f]{64}$/i;
const MEMORY_ID_RE = /^0x[0-9a-f]{64}$/i;
const UUID_MEMORY_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseExecutionLookupId(input: string): { kind: LookupIdKind; value: string } {
  const value = input.trim();
  if (!value) throw new Error("Execution id is required");
  if (MEMORY_ID_RE.test(value)) return { kind: "memory_id", value: value.toLowerCase() };
  if (EVENT_ID_RE.test(value)) return { kind: "event_id", value: value.toLowerCase() };
  if (UUID_MEMORY_ID_RE.test(value)) return { kind: "memory_id", value: value.toLowerCase() };
  return { kind: "memory_id", value };
}

export function getLookupId(args: string[], positionalIndex: number): string | undefined {
  const positional = args[positionalIndex];
  if (positional && !positional.startsWith("--")) return positional;

  const getArg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  return getArg("--memory") ?? getArg("--execution-id");
}

export interface ResolveRefOptions {
  /**
   * Use the gateway's `/v1/events/:id` path shape instead of the indexer's
   * direct `/memory/:id`. Defaults to false (direct mode).
   */
  v1Routes?: boolean;
  /** Bearer token sent as `Authorization` — gateway reads are authenticated. */
  authToken?: string;
}

export function memoryRefUrl(baseUrl: string, id: string, v1Routes = false): string {
  const base    = baseUrl.replace(/\/$/, "");
  const encoded = encodeURIComponent(id);
  return v1Routes ? `${base}/v1/events/${encoded}` : `${base}/memory/${encoded}`;
}

export async function resolveRef(
  baseUrl: string,
  id: string,
  options: ResolveRefOptions = {},
): Promise<MemoryRef | null> {
  const lookup = parseExecutionLookupId(id);
  try {
    const res = await fetch(
      memoryRefUrl(baseUrl, lookup.value, options.v1Routes),
      options.authToken ? { headers: { Authorization: `Bearer ${options.authToken}` } } : undefined,
    );
    if (!res.ok) return null;
    return res.json() as Promise<MemoryRef>;
  } catch {
    return null;
  }
}
