import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * node-pty's macOS build forks the pty via a small "spawn-helper" binary passed to
 * posix_spawn. npm/pnpm tarball extraction does not reliably preserve the executable bit on
 * this file, which makes posix_spawn fail outright ("posix_spawnp failed") and silently costs
 * the caller a real TTY, since node-pty's own spawn() throws synchronously with no indication
 * it's a permissions problem. Windows has no equivalent (ConPTY, no separate helper binary).
 */
export function spawnHelperPathFor(
  nodePtyPackageJsonPath: string,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  if (platform !== "darwin") return undefined;
  return join(dirname(nodePtyPackageJsonPath), "prebuilds", `darwin-${arch}`, "spawn-helper");
}

export async function ensureExecutable(path: string): Promise<void> {
  await chmod(path, 0o755).catch(() => undefined);
}
