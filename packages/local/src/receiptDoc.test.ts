import { describe, expect, it } from "vitest";
import type { LocalExecutionManifestV1 } from "@memora-hq/memora-protocol";
import { renderReceiptDocument, type ReceiptDocumentInput } from "./receiptDoc.js";
import type { SessionSummary } from "./summary.js";
import type { LocalVerificationResult } from "@memora-hq/memora-verifier";

const manifest: LocalExecutionManifestV1 = {
  format: "memora.local.execution",
  version: 1,
  session_id: "local_abc123_deadbeef",
  agent_id: "local:claude:ab12cd34",
  capture_source: "claude-hooks",
  capture_root_hash: "f".repeat(64),
  started_at: "2026-07-26T10:00:00.000Z",
  completed_at: "2026-07-26T10:04:00.000Z",
  root_event_id: "evt_root",
  event_ids: ["evt_root", "evt_two"],
  signer: "0xAb12Cd34Ef56Ab78Cd90Ef12Ab34Cd56Ef78Ab90",
  capture_status: "complete",
  capture_warnings: [],
  signature: "0xsigned",
};

const summary: SessionSummary = {
  agentLabel: "Claude Code",
  tier: "deep",
  tierReasons: [],
  counts: {
    prompts: 2,
    toolCalls: 5,
    fileChanges: 3,
    approvalsRequested: 0,
    approvalsDenied: 0,
    failures: 0,
    totalEvents: 12,
    backgroundEvents: 2,
  },
  durationMs: 240_000,
  distinctFileCount: 3,
  secrets: "no-secret-paths-observed",
  headline: "Claude Code sent 2 requests, ran 5 tool calls, and changed 3 files.",
  sentences: ["None of the files it touched look like secrets.", "All 12 evidence records were sealed on this device."],
  caveats: [],
};

const verification: LocalVerificationResult = {
  valid: true,
  integrity: "verified",
  identity: "self-issued-continuity-verified",
  completeness: "complete",
  anchoring: "local-only",
  checks: [],
};

function input(overrides: Partial<ReceiptDocumentInput> = {}): ReceiptDocumentInput {
  return {
    manifest,
    summary,
    verification,
    signer: { address: manifest.signer, isThisDevice: true },
    disclosure: "none",
    generatedAt: "2026-07-26T11:30:00.000Z",
    ...overrides,
  };
}

describe("receipt document", () => {
  it("renders the same bytes for the same input", () => {
    expect(renderReceiptDocument(input())).toBe(renderReceiptDocument(input()));
  });

  it("is fully self-contained — nothing to fetch, nothing to run", () => {
    const html = renderReceiptDocument(input());
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\ssrc=/i);
    expect(html).not.toMatch(/<link/i);
  });

  it("leads with the plain-language summary and its counts", () => {
    const html = renderReceiptDocument(input());
    expect(html).toContain("Claude Code sent 2 requests, ran 5 tool calls, and changed 3 files.");
    expect(html).toContain("None of the files it touched look like secrets.");
    expect(html).toContain("Unchanged since they were recorded.");
    expect(html).toContain("Signed by this device");
  });

  it("escapes agent-authored text instead of rendering it", () => {
    const html = renderReceiptDocument(input({
      summary: {
        ...summary,
        headline: `Claude ran <script>alert("x")</script> on 'src/app.ts' & stopped.`,
        caveats: ["<img onerror=alert(1)>"],
      },
    }));
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&amp; stopped");
  });

  it("states a verification failure rather than omitting it", () => {
    const html = renderReceiptDocument(input({
      verification: { ...verification, valid: false, integrity: "failed", completeness: "interrupted" },
    }));
    expect(html).toContain("This evidence did not verify.");
    expect(html).toContain("Changed after they were recorded.");
    expect(html).toContain("Capture stopped before the session finished.");
  });

  it("says so when no verification was run at all", () => {
    const html = renderReceiptDocument(input({ verification: undefined }));
    expect(html).toContain("This receipt was produced without a verification run.");
    expect(html).toContain("This evidence did not verify.");
  });

  it("describes the disclosure state of the file it accompanies", () => {
    expect(renderReceiptDocument(input({ disclosure: "none" }))).toContain("stay encrypted and unreadable");
    expect(renderReceiptDocument(input({ disclosure: "partial" }))).toContain("The rest stay encrypted.");
    expect(renderReceiptDocument(input({ disclosure: "full" }))).toContain("revealed in plain text");
  });

  it("never claims the signature identifies a person", () => {
    const html = renderReceiptDocument(input({
      signer: {
        address: "0x1111111111111111111111111111111111111111",
        label: "Priya's laptop",
        isThisDevice: false,
        receiptsVerified: 4,
        firstSeen: "2026-06-12T10:00:00.000Z",
      },
    }));
    expect(html).toContain("It does not prove who produced it.");
    expect(html).toContain("Priya&#39;s laptop");
    expect(html).toContain("4 receipts have been verified from it.");
    expect(html).toContain("First seen 2026-06-12 10:00 UTC");
  });

  it("ties itself to the exact evidence file when one was exported", () => {
    const html = renderReceiptDocument(input({
      bundleFileName: "memora-abc123.memora",
      bundleFingerprint: "a".repeat(64),
    }));
    expect(html).toContain("shasum -a 256 memora-abc123.memora");
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("memora local verify-bundle memora-abc123.memora");
  });

  it("degrades honestly when the summary had no decrypted facts", () => {
    const html = renderReceiptDocument(input({
      summary: {
        ...summary,
        distinctFileCount: undefined,
        secrets: "unknown",
        sentences: ["All 12 evidence records were sealed on this device."],
        headline: "Claude Code ran under observation, but no prompts, tool calls, or file changes were identified in this session.",
      },
    }));
    expect(html).toContain("no prompts, tool calls, or file changes were identified");
    expect(html).not.toContain("look like secrets");
  });
});
