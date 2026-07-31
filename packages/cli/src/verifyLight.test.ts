import { describe, expect, it, vi } from "vitest";
import { printChecks } from "./checks.js";
import { runLightVerify } from "./verifyLight.js";

const baseRef = {
  memory_id: "mem_001",
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
  signer: "0xabc",
} as const;

describe("runLightVerify", () => {
  it("passes for a valid enterprise record with available signatures", () => {
    const checks = runLightVerify({
      ...baseRef,
      event_digest: "0x" + "cd".repeat(32),
      valid_signature: true,
      agent_sig_verified: true,
    });
    expect(checks.some((check) => check.name === "payload_hash present" && check.ok)).toBe(true);
    expect(checks.some((check) => check.name === "operator signature status" && check.ok)).toBe(true);
  });

  it("fails when payload_hash is missing", () => {
    const checks = runLightVerify({
      ...baseRef,
      payload_hash: "",
      event_digest: "0x" + "cd".repeat(32),
      valid_signature: true,
    });
    expect(checks.some((check) => check.name === "payload_hash present" && !check.ok)).toBe(true);
  });

  it("renders unanchored enterprise records as warnings, not failures", () => {
    const checks = runLightVerify({
      ...baseRef,
      event_digest: "0x" + "cd".repeat(32),
      valid_signature: true,
    });

    const warnSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printChecks(checks);
    expect(
      warnSpy.mock.calls.some(([line]) =>
        String(line).includes("⚠ anchoring status  — ⚠ enterprise/local record"),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });
});
