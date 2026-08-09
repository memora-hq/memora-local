import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDaemonLog,
  countFailedHookEntries,
  daemonLogPath,
  daemonPidPath,
  isDaemonRunning,
  readDaemonLog,
  removeDaemonPidFile,
  writeDaemonPidFile,
} from "./daemon.js";

describe("daemonPidPath", () => {
  it("honors MEMORA_LOCAL_DAEMON_PID override", () => {
    const original = process.env.MEMORA_LOCAL_DAEMON_PID;
    process.env.MEMORA_LOCAL_DAEMON_PID = "/tmp/custom-daemon.pid";
    try {
      expect(daemonPidPath()).toBe("/tmp/custom-daemon.pid");
    } finally {
      if (original === undefined) delete process.env.MEMORA_LOCAL_DAEMON_PID;
      else process.env.MEMORA_LOCAL_DAEMON_PID = original;
    }
  });

  it("defaults to a per-uid tmpdir path", () => {
    expect(daemonPidPath()).toMatch(/memora-local-daemon-.+\.pid$/);
  });
});

describe("daemon pidfile lifecycle", () => {
  let dir: string;
  let pidPath: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reports not running when no pidfile exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-daemon-"));
    pidPath = join(dir, "daemon.pid");
    expect(await isDaemonRunning(pidPath)).toEqual({ running: false, pid: null });
  });

  it("reports running for a live pid and cleans up a stale one", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-daemon-"));
    pidPath = join(dir, "daemon.pid");

    await writeDaemonPidFile(process.pid, pidPath);
    expect(await isDaemonRunning(pidPath)).toEqual({ running: true, pid: process.pid });

    // A pid essentially guaranteed not to exist.
    await writeFile(pidPath, "999999999");
    expect(await isDaemonRunning(pidPath)).toEqual({ running: false, pid: null });
    // isDaemonRunning should have removed the stale pidfile as a side effect.
    await expect(readFile(pidPath, "utf8")).rejects.toThrow();
  });

  it("removeDaemonPidFile is a no-op when nothing exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-daemon-"));
    pidPath = join(dir, "daemon.pid");
    await expect(removeDaemonPidFile(pidPath)).resolves.toBeUndefined();
  });
});

describe("daemon log", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty log before anything has been written", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-daemon-"));
    expect(await readDaemonLog(dir)).toEqual([]);
  });

  it("appends timestamped lines and tails them", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-daemon-"));
    await appendDaemonLog(dir, "[daemon] started pid=123");
    await appendDaemonLog(dir, "[daemon] stopping (SIGTERM)");
    const lines = await readDaemonLog(dir);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[daemon] started pid=123");
    expect(lines[1]).toContain("[daemon] stopping (SIGTERM)");
  });

  it("lives at <dataRoot>/daemon.log", () => {
    expect(daemonLogPath("/tmp/memora-data")).toBe("/tmp/memora-data/daemon.log");
  });
});

describe("countFailedHookEntries", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("is zero when the spool directory doesn't exist", async () => {
    expect(await countFailedHookEntries(join(tmpdir(), "memora-nonexistent-spool"))).toBe(0);
  });

  it("counts only .failed entries", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-spool-"));
    await writeFile(join(dir, "a.json"), "{}");
    await writeFile(join(dir, "b.json.failed"), "{}");
    await writeFile(join(dir, "c.json.failed"), "{}");
    expect(await countFailedHookEntries(dir)).toBe(2);
  });
});
