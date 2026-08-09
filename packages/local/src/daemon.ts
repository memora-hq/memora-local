import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { localHookSpoolPath, startLocalHookSpool, type LocalHookSpool } from "./hookTransport.js";

/** Pidfile location, following localHookSpoolPath()'s existing per-uid tmpdir pattern. */
export function daemonPidPath(): string {
  if (process.env.MEMORA_LOCAL_DAEMON_PID) return process.env.MEMORA_LOCAL_DAEMON_PID;
  const user = typeof process.getuid === "function" ? process.getuid() : process.pid;
  return join(tmpdir(), `memora-local-daemon-${user}.pid`);
}

/** The daemon's durable log — lives under the data root, not tmpdir, so it survives a reboot. */
export function daemonLogPath(dataRoot: string): string {
  return join(dataRoot, "daemon.log");
}

async function readPid(pidPath: string): Promise<number | null> {
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else — still running.
    // Anything else (ESRCH, etc.) means it's gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
}

/**
 * Shared crash-recovery check used by both `daemon start` and hook-triggered autostart: a
 * dead daemon (stale pidfile, process no longer alive) is always detected and its pidfile
 * cleaned up, rather than left to error a future caller on a stale file.
 */
export async function isDaemonRunning(pidPath = daemonPidPath()): Promise<DaemonStatus> {
  const pid = await readPid(pidPath);
  if (pid === null) return { running: false, pid: null };
  if (isAlive(pid)) return { running: true, pid };
  await unlink(pidPath).catch(() => undefined);
  return { running: false, pid: null };
}

export async function writeDaemonPidFile(pid: number, pidPath = daemonPidPath()): Promise<void> {
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(pid), { mode: 0o600 });
}

export async function removeDaemonPidFile(pidPath = daemonPidPath()): Promise<void> {
  await unlink(pidPath).catch(() => undefined);
}

export async function appendDaemonLog(dataRoot: string, line: string): Promise<void> {
  const path = daemonLogPath(dataRoot);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${new Date().toISOString()} ${line}\n`);
}

export async function readDaemonLog(dataRoot: string, maxLines = 200): Promise<string[]> {
  try {
    const raw = await readFile(daemonLogPath(dataRoot), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-maxLines);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Count of hook events the spool drain loop gave up on — surfaced by `daemon status`. */
export async function countFailedHookEntries(spoolPath = localHookSpoolPath()): Promise<number> {
  try {
    const entries = await readdir(spoolPath);
    return entries.filter((entry) => entry.endsWith(".failed")).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * Spawns the daemon as a detached background process running `<cliPath> daemon run-internal`,
 * with stdout/stderr redirected to the durable daemon log, writes its pidfile, and returns
 * without waiting for the child to finish starting — the spool drain loop inside it is what
 * actually does the work. Used by both `memora daemon start` and hook-triggered autostart.
 */
export async function spawnDaemon(
  dataRoot: string,
  cliPath: string,
  execPath = process.execPath,
): Promise<number> {
  const logPath = daemonLogPath(dataRoot);
  await mkdir(dirname(logPath), { recursive: true });
  const logHandle = await open(logPath, "a");
  let pid: number | undefined;
  try {
    const child = spawn(execPath, [cliPath, "daemon", "run-internal"], {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: { ...process.env, MEMORA_LOCAL_DATA_DIR: dataRoot },
    });
    child.unref();
    pid = child.pid;
  } finally {
    await logHandle.close();
  }
  if (!pid) throw new Error("failed to spawn daemon process");
  await writeDaemonPidFile(pid);
  return pid;
}

/**
 * The daemon's actual foreground loop: drains the hook spool into the local evidence store
 * until SIGTERM/SIGINT. Only meant to run inside the detached child process spawned by
 * spawnDaemon (`memora daemon run-internal`) — not called directly by CLI users.
 */
export async function runDaemonForeground(dataRoot: string): Promise<void> {
  await appendDaemonLog(dataRoot, `[daemon] started pid=${process.pid}`);
  const spool: LocalHookSpool = await startLocalHookSpool(dataRoot);
  // startLocalHookSpool's own interval is unref'd (fine for a UI process that has other
  // reasons to stay alive); the daemon has none, so it needs its own ref'd keep-alive.
  const keepAlive = setInterval(() => {}, 1 << 30);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAlive);
    spool.close();
    await appendDaemonLog(dataRoot, `[daemon] stopping (${signal})`);
    await removeDaemonPidFile();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
