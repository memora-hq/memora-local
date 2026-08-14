import { describe, expect, it } from "vitest";
import { normalizeToolCall } from "./normalize.js";

const cwd = "/repo";

describe("normalizeToolCall", () => {
  it("normalizes Read to file_read", () => {
    const result = normalizeToolCall({ tool_name: "Read", tool_input: { file_path: "/repo/a.ts" }, cwd });
    expect(result).toEqual([{ category: "file_read", subject: "/repo/a.ts" }]);
  });

  it("normalizes Write to file_write", () => {
    const result = normalizeToolCall({ tool_name: "Write", tool_input: { file_path: "/repo/a.ts" }, cwd });
    expect(result).toEqual([{ category: "file_write", subject: "/repo/a.ts" }]);
  });

  it("normalizes Edit to file_write", () => {
    const result = normalizeToolCall({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" }, cwd });
    expect(result).toEqual([{ category: "file_write", subject: "/repo/a.ts" }]);
  });

  it("normalizes NotebookEdit to file_write using notebook_path", () => {
    const result = normalizeToolCall({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/repo/nb.ipynb" }, cwd });
    expect(result).toEqual([{ category: "file_write", subject: "/repo/nb.ipynb" }]);
  });

  it("normalizes WebFetch to network_call using the url as-is", () => {
    const result = normalizeToolCall({ tool_name: "WebFetch", tool_input: { url: "https://example.com" }, cwd });
    expect(result).toEqual([{ category: "network_call", subject: "https://example.com" }]);
  });

  it("normalizes Glob to file_read using tool_input.path", () => {
    const result = normalizeToolCall({ tool_name: "Glob", tool_input: { path: "/repo/src" }, cwd });
    expect(result).toEqual([{ category: "file_read", subject: "/repo/src" }]);
  });

  it("normalizes Grep to file_read using tool_input.path", () => {
    const result = normalizeToolCall({ tool_name: "Grep", tool_input: { path: "/repo/src" }, cwd });
    expect(result).toEqual([{ category: "file_read", subject: "/repo/src" }]);
  });

  it("falls back to cwd for Glob/Grep when tool_input.path is absent", () => {
    const result = normalizeToolCall({ tool_name: "Glob", tool_input: {}, cwd });
    expect(result).toEqual([{ category: "file_read", subject: "/repo" }]);
  });

  it("normalizes a plain Bash command to shell_exec only", () => {
    const result = normalizeToolCall({ tool_name: "Bash", tool_input: { command: "ls -la" }, cwd });
    expect(result).toEqual([{ category: "shell_exec", subject: "ls -la" }]);
  });

  it("normalizes a git push Bash command to both shell_exec and git_push", () => {
    const result = normalizeToolCall({ tool_name: "Bash", tool_input: { command: "git push --force" }, cwd });
    expect(result).toEqual([
      { category: "shell_exec", subject: "git push --force" },
      { category: "git_push", subject: "git push --force" },
    ]);
  });

  it("normalizes apply_patch into one file_write action per file", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+content",
      "*** Update File: src/existing.ts",
      "*** End Patch",
    ].join("\n");
    const result = normalizeToolCall({ tool_name: "apply_patch", tool_input: { command: patch }, cwd });
    expect(result).toEqual([
      { category: "file_write", subject: "/repo/src/new.ts" },
      { category: "file_write", subject: "/repo/src/existing.ts" },
    ]);
  });

  it("resolves a relative file_path against cwd", () => {
    const result = normalizeToolCall({ tool_name: "Read", tool_input: { file_path: "src/a.ts" }, cwd });
    expect(result).toEqual([{ category: "file_read", subject: "/repo/src/a.ts" }]);
  });

  it("falls back to process.cwd() when cwd is missing", () => {
    const result = normalizeToolCall({ tool_name: "Read", tool_input: { file_path: "a.ts" } });
    expect(result).toEqual([{ category: "file_read", subject: `${process.cwd()}/a.ts` }]);
  });

  it("returns an empty array for an unrecognized tool_name", () => {
    expect(normalizeToolCall({ tool_name: "WebSearch", tool_input: { query: "x" }, cwd })).toEqual([]);
    expect(normalizeToolCall({ tool_name: "mcp__something__do", tool_input: {}, cwd })).toEqual([]);
  });

  it("returns an empty array when tool_name is missing", () => {
    expect(normalizeToolCall({ tool_input: { file_path: "/repo/a.ts" }, cwd })).toEqual([]);
  });

  it("returns an empty array when tool_input is missing for a path-based tool", () => {
    expect(normalizeToolCall({ tool_name: "Read", cwd })).toEqual([]);
  });

  it("returns an empty array when a Bash command is not a string", () => {
    expect(normalizeToolCall({ tool_name: "Bash", tool_input: { command: 123 }, cwd })).toEqual([]);
  });
});
