import { access, copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const MARKER_COMMENT = "# Memora Local automatic agent capture";

/** Mirrors apps/desktop's renderZshSourceLine — the exact line it appends to a shell rc file. */
export function shellIntegrationSourceLine(wrapperPath: string): string {
  return `[ -f ${JSON.stringify(wrapperPath)} ] && source ${JSON.stringify(wrapperPath)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The inverse of what apps/desktop's onboarding appends to a shell rc file (see
 * apps/desktop/src/main/main.ts's writeShellIntegration): strips the marker comment and its
 * source line, plus the blank line the append introduced, leaving everything else untouched.
 */
export function stripShellIntegrationBlock(rcContents: string, wrapperPath: string): string {
  const sourceLine = shellIntegrationSourceLine(wrapperPath);
  const block = new RegExp(`\\n?${escapeRegExp(MARKER_COMMENT)}\\n${escapeRegExp(sourceLine)}\\n?`, "g");
  return rcContents.replace(block, "\n").replace(/\n{3,}/g, "\n\n");
}

/** Whether the generated wrapper file shadows a given provider (e.g. `claude() { ... }`). */
export function shellIntegrationWrapsProvider(wrapperFileContents: string, provider: string): boolean {
  return new RegExp(`(^|\\n)${provider}\\s*\\(\\)\\s*\\{`).test(wrapperFileContents);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ShellIntegrationPaths {
  wrapperPath: string;
  rcPath: string;
}

export interface ShellIntegrationUninstallResult {
  rcUpdated: boolean;
  rcBackedUp: boolean;
  wrapperFileDisabled: boolean;
}

/**
 * Removes the shell wrapper apps/desktop's onboarding writes — functions that shadow
 * `claude`/`codex` with `memora local run`, which duplicates capture for anyone who has also
 * run `local install-hooks` (see #36: every session gets recorded twice, once per mechanism).
 * The rc file is backed up before editing, matching writeHookConfigFile's convention; the
 * wrapper file itself is renamed aside rather than deleted, since apps/desktop can regenerate
 * it on request ("Re-run onboarding to update").
 */
export async function uninstallShellIntegration(paths: ShellIntegrationPaths): Promise<ShellIntegrationUninstallResult> {
  let rcUpdated = false;
  let rcBackedUp = false;
  if (await fileExists(paths.rcPath)) {
    const original = await readFile(paths.rcPath, "utf8");
    const stripped = stripShellIntegrationBlock(original, paths.wrapperPath);
    if (stripped !== original) {
      await copyFile(paths.rcPath, `${paths.rcPath}.backup`);
      rcBackedUp = true;
      await writeFile(paths.rcPath, stripped);
      rcUpdated = true;
    }
  }

  let wrapperFileDisabled = false;
  if (await fileExists(paths.wrapperPath)) {
    await rename(paths.wrapperPath, `${paths.wrapperPath}.disabled-${Date.now()}`);
    wrapperFileDisabled = true;
  }

  return { rcUpdated, rcBackedUp, wrapperFileDisabled };
}
