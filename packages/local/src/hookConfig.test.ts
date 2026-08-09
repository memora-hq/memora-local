import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hookConfigPathFor,
  mergeMemoraHooks,
  readHookConfigFile,
  removeMemoraHooks,
  writeHookConfigFile,
  type HookConfig,
} from "./hookConfig.js";

describe("lifecycle hook configuration", () => {
  it("collapses previously duplicated quoted Memora handlers", () => {
    const duplicate = {
      matcher: "*",
      hooks: [{
        type: "command",
        command: 'MEMORA_LOCAL_DATA_DIR="/tmp/Memora" "/Users/test/.local/bin/memora" local hook --provider codex',
      }],
    };
    const input: HookConfig = { hooks: { PostToolUse: [duplicate, duplicate, duplicate] } };
    const merged = mergeMemoraHooks(input, "codex", "/Users/test/.local/bin/memora", "/tmp/Memora");
    expect(merged.hooks?.PostToolUse).toHaveLength(1);
  });

  it("preserves unrelated user hooks", () => {
    const input: HookConfig = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-hook" }] }],
      },
    };
    const merged = mergeMemoraHooks(input, "claude", "/Users/test/.local/bin/memora", "/tmp/Memora");
    expect(merged.hooks?.Stop).toHaveLength(2);
    expect(merged.hooks?.Stop?.[0].hooks?.[0].command).toBe("/usr/local/bin/my-hook");
  });

  it("produces the exact registered event set and matchers for codex (6 events)", () => {
    const merged = mergeMemoraHooks({}, "codex", "/Users/test/.local/bin/memora", "/tmp/Memora");
    const events = Object.keys(merged.hooks ?? {});
    expect(events).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"]);
    const matcherOf = (event: string) => merged.hooks?.[event]?.[0]?.matcher;
    expect(matcherOf("SessionStart")).toBe("startup|resume|clear|compact");
    expect(matcherOf("UserPromptSubmit")).toBeUndefined();
    expect(matcherOf("PreToolUse")).toBe("*");
    expect(matcherOf("PermissionRequest")).toBe("*");
    expect(matcherOf("PostToolUse")).toBe("*");
    expect(matcherOf("Stop")).toBeUndefined();
  });

  it("produces the exact registered event set and matchers for claude (8 events)", () => {
    const merged = mergeMemoraHooks({}, "claude", "/Users/test/.local/bin/memora", "/tmp/Memora");
    const events = Object.keys(merged.hooks ?? {});
    expect(events).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "SessionEnd",
    ]);
    const matcherOf = (event: string) => merged.hooks?.[event]?.[0]?.matcher;
    expect(matcherOf("SessionStart")).toBe("startup|resume|clear|compact");
    expect(matcherOf("UserPromptSubmit")).toBeUndefined();
    expect(matcherOf("PreToolUse")).toBe("*");
    expect(matcherOf("PermissionRequest")).toBe("*");
    expect(matcherOf("PostToolUse")).toBe("*");
    expect(matcherOf("PostToolUseFailure")).toBe("*");
    expect(matcherOf("Stop")).toBeUndefined();
    expect(matcherOf("SessionEnd")).toBeUndefined();
  });

  it("throws for an unknown provider", () => {
    expect(() => mergeMemoraHooks({}, "unknown-agent", "/Users/test/.local/bin/memora", "/tmp/Memora")).toThrow(
      "mergeMemoraHooks: no terminal adapter registered for 'unknown-agent'",
    );
  });

  it("throws for a registered non-terminal adapter with no expectedEvents", () => {
    expect(() => mergeMemoraHooks({}, "cursor", "/Users/test/.local/bin/memora", "/tmp/Memora")).toThrow(
      "mergeMemoraHooks: no terminal adapter registered for 'cursor'",
    );
  });
});

describe("removeMemoraHooks", () => {
  it("strips Memora's hook groups but keeps unrelated user hooks", () => {
    const merged = mergeMemoraHooks(
      { hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-hook" }] }] } },
      "claude",
      "/Users/test/.local/bin/memora",
      "/tmp/Memora",
    );
    const removed = removeMemoraHooks(merged);
    expect(removed.hooks?.Stop).toHaveLength(1);
    expect(removed.hooks?.Stop?.[0].hooks?.[0].command).toBe("/usr/local/bin/my-hook");
  });

  it("drops the hooks key entirely once nothing but Memora's own hooks remain", () => {
    const merged = mergeMemoraHooks({}, "codex", "/Users/test/.local/bin/memora", "/tmp/Memora");
    const removed = removeMemoraHooks(merged);
    expect(removed).toEqual({});
    expect("hooks" in removed).toBe(false);
  });

  it("preserves unrelated top-level config keys even when hooks empties out", () => {
    const merged = mergeMemoraHooks({ model: "sonnet" }, "codex", "/Users/test/.local/bin/memora", "/tmp/Memora");
    const removed = removeMemoraHooks(merged);
    expect(removed).toEqual({ model: "sonnet" });
  });

  it("is a no-op on a config with no hooks key", () => {
    expect(removeMemoraHooks({})).toEqual({});
  });
});

describe("hookConfigPathFor", () => {
  it("resolves codex and claude paths under the home directory", () => {
    expect(hookConfigPathFor("codex")).toMatch(/\.codex\/hooks\.json$/);
    expect(hookConfigPathFor("claude")).toMatch(/\.claude\/settings\.json$/);
  });

  it("throws for a provider with no registered hook config path", () => {
    expect(() => hookConfigPathFor("cursor")).toThrow("no hook config path registered for 'cursor'");
  });
});

describe("readHookConfigFile / writeHookConfigFile", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads an empty config for a missing file", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-hookcfg-"));
    expect(await readHookConfigFile(join(dir, "missing.json"))).toEqual({});
  });

  it("writes without a backup on first write, then backs up on the next", async () => {
    dir = await mkdtemp(join(tmpdir(), "memora-hookcfg-"));
    const path = join(dir, "nested", "settings.json");

    const first = await writeHookConfigFile(path, { hooks: { Stop: [] } });
    expect(first.backedUp).toBe(false);

    const second = await writeHookConfigFile(path, { hooks: { Stop: [], SessionEnd: [] } });
    expect(second.backedUp).toBe(true);

    const backup = JSON.parse(await readFile(`${path}.backup`, "utf8"));
    expect(backup).toEqual({ hooks: { Stop: [] } });

    const current = await readHookConfigFile(path);
    expect(current).toEqual({ hooks: { Stop: [], SessionEnd: [] } });
  });
});
