import type { MemoryRef } from "@memora-hq/memora-protocol";
import { fail, pass, type CheckResult, warn } from "./checks.js";

type VerifyableRef = MemoryRef & {
  valid_signature?: boolean | null;
  agent_sig_verified?: boolean | null;
  event_digest?: string | null;
};

const EVENT_ID_RE = /^[0-9a-f]{64}$/i;
const EVENT_DIGEST_RE = /^0x[0-9a-f]{64}$/i;

export function runLightVerify(ref: VerifyableRef): CheckResult[] {
  const checks: CheckResult[] = [];

  checks.push(pass("indexed ref exists", `memory_id: ${ref.memory_id}`));

  checks.push(
    typeof ref.payload_hash === "string" && ref.payload_hash.length > 0
      ? pass("payload_hash present", ref.payload_hash.slice(0, 16) + "…")
      : fail("payload_hash present", "missing payload_hash"),
  );

  if (ref.event_id) {
    checks.push(
      EVENT_ID_RE.test(ref.event_id)
        ? pass("event_id format", ref.event_id.slice(0, 16) + "…")
        : fail("event_id format", `unexpected format: ${ref.event_id}`),
    );
  } else {
    checks.push(warn("event_id format", "event_id absent"));
  }

  if (ref.event_digest) {
    checks.push(
      EVENT_DIGEST_RE.test(ref.event_digest)
        ? pass("event_digest format", ref.event_digest.slice(0, 18) + "…")
        : fail("event_digest format", `unexpected format: ${ref.event_digest}`),
    );
  } else {
    checks.push(warn("event_digest format", "event_digest absent"));
  }

  if (ref.valid_signature === true) {
    checks.push(pass("operator signature status", `signer: ${ref.signer ?? "unknown"}`));
  } else if (ref.valid_signature === false) {
    checks.push(fail("operator signature status", "indexed signature verification failed"));
  } else {
    checks.push(warn("operator signature status", "signature verification unavailable"));
  }

  if (ref.agent_sig_verified === true) {
    checks.push(pass("agent countersignature", "agent signature verified"));
  } else if (ref.agent_sig_verified === false) {
    checks.push(fail("agent countersignature", "agent signature invalid or signer not registered"));
  } else {
    checks.push(warn("agent countersignature", "no agent signature recorded"));
  }

  if (ref.contract_tx_hash || ref.hcs_sequence) {
    checks.push(pass("anchoring status", "anchored data exists"));
  } else {
    checks.push(warn("anchoring status", "enterprise/local record — no external anchor recorded"));
  }

  return checks;
}
