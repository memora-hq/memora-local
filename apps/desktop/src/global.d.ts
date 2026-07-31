import type { LocalEventRecordV1, LocalExecutionManifestV1 } from "@smritheon/memora-protocol";
import type { IntegrationDiagnosticResult, KnownSigner, LocalVerificationResult, SessionSummary } from "@smritheon/memora-local";
import type { BundleVerificationReply, ExportBundleReply, ReceiptBundleRef } from "./main/bundleView";
import type { IntegrationSettings, ReadingLevel } from "./main/integrationSettings";

declare global {
  type LocalEventPresentation = {
    provider: "codex" | "claude" | "cursor" | "vscode" | "local";
    title: string;
    detail: string;
    tool?: string;
    target?: string;
    correlationId?: string;
    category?: "prompt" | "tool" | "file" | "approval";
    status?: "submitted" | "running" | "completed" | "failed" | "denied";
    role?: "turn-start" | "tool-open" | "tool-close" | "turn-end" | "session-start" | "session-end";
  };

  type LocalDecryptedEventDetail = {
    eventId: string;
    eventType: string;
    provider: LocalEventPresentation["provider"];
    prompt?: unknown;
    tool?: {
      name?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    };
    metadata: Record<string, string | number | boolean | null>;
    rawContent: unknown;
  };

  type LocalBundleVerificationReply = BundleVerificationReply;
  type LocalExportBundleReply = ExportBundleReply;
  type LocalReceiptBundleRef = ReceiptBundleRef;

  interface Window {
    memoraLocal: {
      listSessions(): Promise<LocalExecutionManifestV1[]>;
      getSession(sessionId: string): Promise<{
        manifest: LocalExecutionManifestV1;
        events: LocalEventRecordV1[];
        presentations: Record<string, LocalEventPresentation>;
        summary: SessionSummary;
      }>;
      revealEvents(sessionId: string, eventIds: string[]): Promise<LocalDecryptedEventDetail[]>;
      verifySession(sessionId: string): Promise<LocalVerificationResult>;
      exportSession(sessionId: string, disclose: boolean): Promise<ExportBundleReply>;
      exportReceipt(sessionId: string, bundle?: ReceiptBundleRef): Promise<{ canceled: boolean; path?: string }>;
      chooseBundle(): Promise<{ canceled: boolean; path?: string }>;
      verifyBundle(path: string): Promise<BundleVerificationReply>;
      pathForFile(file: File): string;
      listSigners(): Promise<KnownSigner[]>;
      labelSigner(address: string, label: string): Promise<KnownSigner | undefined>;
      forgetSigner(address: string): Promise<void>;
      installCli(): Promise<{ target: string; pathHint: string }>;
      getIntegrations(): Promise<IntegrationSettings>;
      configureIntegrations(selected: Array<"codex" | "claude" | "cursor" | "vscode">): Promise<{
        settings: IntegrationSettings;
        shell: {
          restart_required: boolean;
          detected: Record<"codex" | "claude", boolean>;
        };
        lifecycle: {
          codex_review_required: boolean;
          installed: Array<"codex" | "claude">;
        };
        editors: {
          installed: Array<"cursor" | "vscode">;
        };
        diagnostics: Partial<Record<"codex" | "claude", IntegrationDiagnosticResult>>;
      }>;
      diagnoseIntegration(provider: "codex" | "claude"): Promise<IntegrationDiagnosticResult>;
      setReadingLevel(level: ReadingLevel): Promise<IntegrationSettings>;
    };
  }
}
export {};
