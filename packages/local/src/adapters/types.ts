export type CaptureTier = "deep" | "partial" | "wrapper" | "planned";

export interface AdapterDescriptor {
  id: string; // "claude" | "codex" | "cursor" | "vscode"
  displayName: string; // "Claude Code"
  captureTier: CaptureTier;
  kind: "terminal" | "editor" | "mcp" | "desktop";
  eventMap: Record<string, string>; // provider hook/event name -> Memora event type
  expectedEvents?: string[]; // for the integration diagnostic, terminal adapters only
  attributionNote: string; // one honest sentence about what this tier can/can't prove
}
