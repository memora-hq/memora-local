import { describe, expect, it } from "vitest";
import { mergeMemoraHooks, type HookConfig } from "./hookConfig.js";

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
