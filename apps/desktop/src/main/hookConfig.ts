import { getAdapter } from "@smritheon/memora-local";

export type HookProvider = string;
export type HookGroup = {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};
export type HookConfig = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

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

export function mergeMemoraHooks(config: HookConfig, provider: HookProvider, cli: string, dataRoot: string): HookConfig {
  const group = (matcher?: string) => memoraHookGroup(provider, cli, dataRoot, matcher);
  const expectedEvents = getAdapter(provider)?.expectedEvents;
  if (!expectedEvents) throw new Error(`mergeMemoraHooks: no terminal adapter registered for '${provider}'`);
  const events = Object.fromEntries(expectedEvents.map((event) => [event, group(matcherFor(event))]));
  const hooks = { ...(config.hooks ?? {}) };
  for (const [event, memoraGroup] of Object.entries(events)) {
    const existing = (hooks[event] ?? []).filter((candidate) =>
      !(candidate.hooks ?? []).some((handler) => handler.command?.includes("local hook --provider")),
    );
    hooks[event] = [...existing, memoraGroup];
  }
  return { ...config, hooks };
}
