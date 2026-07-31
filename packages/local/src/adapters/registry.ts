import type { AdapterDescriptor } from "./types.js";

const terminalHookEventMap: Record<string, string> = {
  SessionStart: "adapter_session_started",
  UserPromptSubmit: "prompt_submitted",
  PreToolUse: "tool_requested",
  PermissionRequest: "approval_requested",
  PermissionDenied: "approval_denied",
  PostToolUse: "tool_completed",
  PostToolUseFailure: "tool_failed",
  FileChanged: "file_changed",
  Stop: "turn_completed",
  SessionEnd: "adapter_session_ended",
};

const editorEventMap: Record<string, string> = {
  workspace_opened: "adapter_session_started",
  document_changed: "file_changed",
  document_saved: "file_saved",
  terminal_opened: "terminal_opened",
  terminal_closed: "terminal_closed",
  workspace_closed: "adapter_session_ended",
};

export const adapters: AdapterDescriptor[] = [
  {
    id: "codex",
    displayName: "Codex",
    captureTier: "deep",
    kind: "terminal",
    eventMap: terminalHookEventMap,
    expectedEvents: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"],
    attributionNote: "Deep, tool-level capture via Codex lifecycle hooks; requires one-time /hooks trust in Codex.",
  },
  {
    id: "claude",
    displayName: "Claude Code",
    captureTier: "deep",
    kind: "terminal",
    eventMap: terminalHookEventMap,
    expectedEvents: [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "SessionEnd",
    ],
    attributionNote: "Deep, tool-level capture via Claude Code's lifecycle hooks.",
  },
  {
    id: "vscode",
    displayName: "VS Code / GitHub Copilot",
    captureTier: "partial",
    kind: "editor",
    eventMap: editorEventMap,
    attributionNote:
      "Partial — workspace-level capture (file saves, terminal open/close). A saved file during a Copilot session is not proof Copilot authored it.",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    captureTier: "partial",
    kind: "editor",
    eventMap: editorEventMap,
    attributionNote:
      "Partial — workspace-level capture (file saves, terminal open/close). A saved file is not proof an AI agent authored it.",
  },
];

const adaptersById = new Map(adapters.map((adapter) => [adapter.id, adapter]));

export function getAdapter(id: string): AdapterDescriptor | undefined {
  return adaptersById.get(id);
}
