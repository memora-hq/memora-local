import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestLocalHook, type LocalHookInput, type LocalHookProvider } from "./hookAdapter.js";

const MAX_HOOK_BYTES = 5 * 1024 * 1024;

export function localHookSpoolPath(): string {
  if (process.env.MEMORA_LOCAL_HOOK_SPOOL) return process.env.MEMORA_LOCAL_HOOK_SPOOL;
  const user = typeof process.getuid === "function" ? process.getuid() : process.pid;
  return join(tmpdir(), `memora-local-hooks-${user}`);
}

export async function enqueueLocalHook(
  provider: LocalHookProvider,
  input: LocalHookInput,
  spoolPath = localHookSpoolPath(),
): Promise<void> {
  const body = JSON.stringify({ provider, input });
  if (Buffer.byteLength(body) > MAX_HOOK_BYTES) throw new Error("hook payload exceeds 5 MB");
  await mkdir(spoolPath, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const temporary = join(spoolPath, `.${id}.tmp`);
  const ready = join(spoolPath, `${id}.json`);
  await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  await rename(temporary, ready);
}

export interface LocalHookSpool {
  drain(): Promise<number>;
  close(): void;
}

export async function startLocalHookSpool(
  dataRoot: string,
  spoolPath = localHookSpoolPath(),
  intervalMs = 250,
): Promise<LocalHookSpool> {
  await mkdir(spoolPath, { recursive: true, mode: 0o700 });
  let draining = false;
  const drain = async (): Promise<number> => {
    if (draining) return 0;
    draining = true;
    let processed = 0;
    try {
      const entries = (await readdir(spoolPath)).filter((entry) => entry.endsWith(".json")).sort();
      for (const entry of entries) {
        const path = join(spoolPath, entry);
        try {
          const request = JSON.parse(await readFile(path, "utf8")) as {
            provider?: LocalHookProvider;
            input?: LocalHookInput;
          };
          if (!request.provider || !["codex", "claude", "vscode", "cursor"].includes(request.provider) || !request.input) {
            throw new Error("invalid local hook request");
          }
          await ingestLocalHook(dataRoot, request.provider, request.input);
          await unlink(path);
          processed += 1;
        } catch (error) {
          const failed = join(spoolPath, `${entry}.failed`);
          await rename(path, failed).catch(() => undefined);
          console.error(`[memora] failed to ingest ${entry}: ${(error as Error).message}`);
        }
      }
    } finally {
      draining = false;
    }
    return processed;
  };
  const timer = setInterval(() => { void drain(); }, intervalMs);
  timer.unref();
  await drain();
  return { drain, close: () => clearInterval(timer) };
}
