import { describe, expect, it } from "vitest";
import { analyzeHookConfiguration } from "./integrationDiagnostic.js";

const cli = "/Users/test/.local/bin/memora";
const root = "/Users/test/Library/Application Support/Memora";
const command = `MEMORA_LOCAL_DATA_DIR=${JSON.stringify(root)} ${JSON.stringify(cli)} local hook --provider codex`;
const handler = (value = command) => ({ type: "command", command: value });
const group = (value = command) => ({ hooks: [handler(value)] });
const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"];

describe("analyzeHookConfiguration", () => {
  it("accepts exactly one current handler per event", () => {
    const hooks = Object.fromEntries(events.map((event) => [event, [group()]]));
    expect(analyzeHookConfiguration({ hooks }, "codex", cli, root)).toEqual({
      valid: true,
      handlerCount: 6,
      missingEvents: [],
      duplicateEvents: [],
      staleEvents: [],
    });
  });

  it("detects missing, duplicate, and stale handlers", () => {
    const hooks = Object.fromEntries(events.map((event) => [event, [group()]]));
    hooks.Stop = [];
    hooks.PreToolUse = [group(), group()];
    hooks.PostToolUse = [group(command.replace(root, "/tmp/old-root"))];
    const result = analyzeHookConfiguration({ hooks }, "codex", cli, root);
    expect(result.valid).toBe(false);
    expect(result.missingEvents).toEqual(["Stop"]);
    expect(result.duplicateEvents).toEqual(["PreToolUse"]);
    expect(result.staleEvents).toEqual(["PostToolUse"]);
  });

  it("ignores unrelated user hooks", () => {
    const hooks = Object.fromEntries(events.map((event) => [event, [
      { hooks: [handler("/usr/bin/example-hook")] },
      group(),
    ]]));
    expect(analyzeHookConfiguration({ hooks }, "codex", cli, root).valid).toBe(true);
  });

  it("treats a registered adapter with no expectedEvents as an empty expected-events list", () => {
    // "cursor" is a real registry entry (kind: "editor") but has no expectedEvents.
    expect(analyzeHookConfiguration({ hooks: {} }, "cursor", cli, root)).toEqual({
      valid: true,
      handlerCount: 0,
      missingEvents: [],
      duplicateEvents: [],
      staleEvents: [],
    });
  });

  it("treats an unregistered provider as an empty expected-events list rather than throwing", () => {
    expect(() => analyzeHookConfiguration({ hooks: {} }, "unknown-agent", cli, root)).not.toThrow();
    expect(analyzeHookConfiguration({ hooks: {} }, "unknown-agent", cli, root)).toEqual({
      valid: true,
      handlerCount: 0,
      missingEvents: [],
      duplicateEvents: [],
      staleEvents: [],
    });
  });
});
