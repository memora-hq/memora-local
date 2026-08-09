import { homedir } from "node:os";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAdapter } from "./adapters/registry.js";

export type HookProvider = string;
export type HookGroup = {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};
export type HookConfig = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

// Desktop/Electron-specific paths for each terminal adapter's hook config file — these live
// under the user's home directory and aren't part of the portable adapter registry.
const hookConfigPaths: Record<string, string> = {
  codex: join(homedir(), ".codex", "hooks.json"),
  claude: join(homedir(), ".claude", "settings.json"),
};

/** Where a terminal adapter's hook config file lives on disk. Throws for non-terminal adapters. */
export function hookConfigPathFor(provider: HookProvider): string {
  const path = hookConfigPaths[provider];
  if (!path) throw new Error(`hookConfigPathFor: no hook config path registered for '${provider}'`);
  return path;
}

function memoraHookGroup(provider: HookProvider, cli: string, dataRoot: string, matcher?: string): HookGroup {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [{
      type: "command",
      command: `MEMORA_LOCAL_DATA_DIR=${JSON.stringify(dataRoot)} ${JSON.stringify(cli)} local hook --provider ${provider}`,
      timeout: 30,
      statusMessage: "Recording execution evidence",
    }],
  };
}

function matcherFor(event: string): string | undefined {
  if (event === "SessionStart") return "startup|resume|clear|compact";
  if (["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"].includes(event)) return "*";
  return undefined; // UserPromptSubmit, Stop, SessionEnd
}

function isMemoraHandler(command: string | undefined): boolean {
  return Boolean(command?.includes("local hook --provider"));
}

export function mergeMemoraHooks(config: HookConfig, provider: HookProvider, cli: string, dataRoot: string): HookConfig {
  const group = (matcher?: string) => memoraHookGroup(provider, cli, dataRoot, matcher);
  const expectedEvents = getAdapter(provider)?.expectedEvents;
  if (!expectedEvents) throw new Error(`mergeMemoraHooks: no terminal adapter registered for '${provider}'`);
  const events = Object.fromEntries(expectedEvents.map((event) => [event, group(matcherFor(event))]));
  const hooks = { ...(config.hooks ?? {}) };
  for (const [event, memoraGroup] of Object.entries(events)) {
    const existing = (hooks[event] ?? []).filter((candidate) =>
      !(candidate.hooks ?? []).some((handler) => isMemoraHandler(handler.command)),
    );
    hooks[event] = [...existing, memoraGroup];
  }
  return { ...config, hooks };
}

/**
 * The inverse of mergeMemoraHooks: strips every Memora-authored hook group, leaving any
 * unrelated user hooks untouched. An event key whose hook list becomes empty is dropped
 * entirely rather than left behind as `[]`.
 */
export function removeMemoraHooks(config: HookConfig): HookConfig {
  if (!config.hooks) return config;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(config.hooks)) {
    const remaining = groups.filter((group) => !(group.hooks ?? []).some((handler) => isMemoraHandler(handler.command)));
    if (remaining.length > 0) hooks[event] = remaining;
  }
  // Drop the `hooks` key entirely once nothing's left under it, rather than leaving a
  // stray `"hooks": {}` in a config file that may never have had a hooks key at all.
  if (Object.keys(hooks).length === 0) {
    const { hooks: _dropped, ...rest } = config;
    return rest;
  }
  return { ...config, hooks };
}

export async function readHookConfigFile(path: string): Promise<HookConfig> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HookConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes a hook config file, backing up any existing file to `<path>.backup` first. The
 * backup holds the config as it was immediately before Memora's most recent write — good
 * enough to hand-restore from, without accumulating unbounded backup history.
 */
export async function writeHookConfigFile(path: string, config: HookConfig): Promise<{ backedUp: boolean }> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  const backedUp = await fileExists(resolved);
  if (backedUp) await copyFile(resolved, `${resolved}.backup`);
  await writeFile(resolved, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { backedUp };
}
