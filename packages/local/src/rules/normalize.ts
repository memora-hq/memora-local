import { resolve } from "node:path";
import { parsePatchFilePaths } from "./patchParser.js";
import type { NormalizedAction } from "./schema.js";

export interface RawToolCall {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

const GIT_PUSH_PATTERN = /\bgit\s+push\b/;

function stringField(input: unknown, field: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function resolvePath(cwd: string, subject: string): string {
  return resolve(cwd, subject);
}

export function normalizeToolCall(call: RawToolCall): NormalizedAction[] {
  const toolName = typeof call.tool_name === "string" ? call.tool_name : undefined;
  if (!toolName) return [];
  const cwd = typeof call.cwd === "string" && call.cwd ? call.cwd : process.cwd();

  switch (toolName) {
    case "Read": {
      const filePath = stringField(call.tool_input, "file_path");
      return filePath ? [{ category: "file_read", subject: resolvePath(cwd, filePath) }] : [];
    }
    case "Glob":
    case "Grep": {
      const path = stringField(call.tool_input, "path") ?? cwd;
      return [{ category: "file_read", subject: resolvePath(cwd, path) }];
    }
    case "Write":
    case "Edit": {
      const filePath = stringField(call.tool_input, "file_path");
      return filePath ? [{ category: "file_write", subject: resolvePath(cwd, filePath) }] : [];
    }
    case "NotebookEdit": {
      const notebookPath = stringField(call.tool_input, "notebook_path");
      return notebookPath ? [{ category: "file_write", subject: resolvePath(cwd, notebookPath) }] : [];
    }
    case "WebFetch": {
      const url = stringField(call.tool_input, "url");
      return url ? [{ category: "network_call", subject: url }] : [];
    }
    case "Bash": {
      const command = stringField(call.tool_input, "command");
      if (!command) return [];
      const actions: NormalizedAction[] = [{ category: "shell_exec", subject: command }];
      if (GIT_PUSH_PATTERN.test(command)) actions.push({ category: "git_push", subject: command });
      return actions;
    }
    case "apply_patch": {
      const command = stringField(call.tool_input, "command");
      if (!command) return [];
      return parsePatchFilePaths(command).map((path) => ({
        category: "file_write" as const,
        subject: resolvePath(cwd, path),
      }));
    }
    default:
      return [];
  }
}
