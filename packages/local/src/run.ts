import process from "node:process";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import * as pty from "node-pty";
import type { LocalSession } from "@memora-hq/memora-verifier";
import { diffSnapshots, snapshotProject } from "./capture.js";

export interface RunLocalCommandOptions {
  command: string[];
  cwd: string;
  session: LocalSession;
  terminal?: { cols: number; rows: number };
}

async function resolveExecutable(command: string, env: Record<string, string>): Promise<string> {
  if (isAbsolute(command) || command.includes("/")) return command;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  return command;
}

export async function runLocalCommand(options: RunLocalCommandOptions): Promise<number> {
  if (!options.command.length) throw new Error("a command is required after --");
  const before = await snapshotProject(options.cwd);
  await options.session.record("process_started", {
    executable: options.command[0],
    argument_count: Math.max(0, options.command.length - 1),
    cwd_hash_only: true,
  }, "wrapper_observed");

  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const executable = await resolveExecutable(options.command[0], env);
  let outputBuffer = "";
  let flushChain = Promise.resolve();
  const flush = () => {
    if (!outputBuffer) return;
    const content = outputBuffer;
    outputBuffer = "";
    flushChain = flushChain.then(() => options.session.record("terminal_output", { content }, "wrapper_observed").then(() => undefined));
  };
  const interval = setInterval(flush, 500);
  const captureOutput = (data: string, target: NodeJS.WriteStream) => {
    target.write(data);
    outputBuffer += data;
    if (outputBuffer.length >= 16_384) flush();
  };

  let exit: { exitCode: number; signal?: number };
  let stdinHandler: ((data: Buffer) => void) | undefined;
  let resizeHandler: (() => void) | undefined;
  try {
    const child = pty.spawn(executable, options.command.slice(1), {
      name: process.env.TERM ?? "xterm-256color",
      cols: options.terminal?.cols ?? process.stdout.columns ?? 120,
      rows: options.terminal?.rows ?? process.stdout.rows ?? 40,
      cwd: options.cwd,
      env,
    });
    child.onData((data) => captureOutput(data, process.stdout));
    stdinHandler = (data: Buffer) => child.write(data.toString());
    process.stdin.on("data", stdinHandler);
    if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
    process.stdin.resume();
    resizeHandler = () => child.resize(process.stdout.columns ?? 120, process.stdout.rows ?? 40);
    process.stdout.on("resize", resizeHandler);
    exit = await new Promise((resolve) => child.onExit(resolve));
  } catch (error) {
    options.session.warn({ code: "PTY_UNAVAILABLE", message: `PTY unavailable; used pipe capture: ${(error as Error).message}`, source: "wrapper_observed" });
    const child = spawnProcess(executable, options.command.slice(1), { cwd: options.cwd, env, stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", (data: Buffer) => captureOutput(data.toString(), process.stdout));
    child.stderr.on("data", (data: Buffer) => captureOutput(data.toString(), process.stderr));
    exit = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ exitCode: code ?? 1, ...(signal ? { signal: 1 } : {}) }));
    });
  }
  clearInterval(interval);
  flush();
  await flushChain;
  if (stdinHandler) process.stdin.off("data", stdinHandler);
  if (resizeHandler) process.stdout.off("resize", resizeHandler);
  if (stdinHandler && process.stdin.isTTY) process.stdin.setRawMode?.(false);
  if (stdinHandler) process.stdin.pause();

  const after = await snapshotProject(options.cwd);
  const changes = diffSnapshots(before, after);
  for (const change of changes) {
    await options.session.record("file_changed", {
      change: change.change,
      path: change.file.path,
      hash: change.file.hash,
      size: change.file.size,
      ...(change.file.content !== undefined ? { content: change.file.content } : {}),
      ...(change.file.excluded ? { content_excluded: change.file.excluded } : {}),
    }, "filesystem_observed");
  }
  await options.session.record("process_exited", {
    exit_code: exit.exitCode,
    ...(exit.signal ? { signal: exit.signal } : {}),
    changed_files: changes.length,
  }, "wrapper_observed");
  return exit.exitCode;
}
