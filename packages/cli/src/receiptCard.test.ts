import { describe, expect, it } from "vitest";
import { formatReceiptCard, inferVerificationStatus } from "./receiptCard.js";

const baseRef = {
  memory_id: "0x" + "11".repeat(32),
  agent_id: "agent-1",
  task_id: null,
  cid_ciphertext: "ipfs://cid",
  payload_hash: "deadbeef",
  hcs_topic_id: "",
  hcs_sequence: "",
  hcs_timestamp: "",
  contract_tx_hash: "",
  created_at: "2026-06-25T12:00:00.000Z",
  event_id: "ab".repeat(32),
  event_type: "ai_receipt",
} as const;

describe("inferVerificationStatus", () => {
  it("returns recorded when only the indexed ref exists", () => {
    expect(inferVerificationStatus(baseRef)).toBe("recorded");
  });

  it("returns anchored for off-chain attested records", () => {
    expect(inferVerificationStatus({ ...baseRef, event_digest: "0x" + "cd".repeat(32), valid_signature: true })).toBe("anchored");
  });

  it("returns verified for enterprise verified records", () => {
    expect(
      inferVerificationStatus({
        ...baseRef,
        event_digest: "0x" + "cd".repeat(32),
        valid_signature: true,
        agent_sig_verified: true,
      }),
    ).toBe("verified");
  });
});

describe("formatReceiptCard", () => {
  it("renders the required receipt fields", () => {
    const text = formatReceiptCard({
      ...baseRef,
      hcs_topic_id: "0.0.12345",
      hcs_sequence: "42",
      contract_tx_hash: "0xabc",
    });

    expect(text).toContain("Memora Receipt");
    expect(text).toContain("Execution ID");
    expect(text).toContain("Event Digest");
    expect(text).toContain("Provider");
    expect(text).toContain("unavailable");
    expect(text).toContain("Verification");
  });
});
