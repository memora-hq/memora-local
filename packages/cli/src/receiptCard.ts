import type { MemoryRef } from "@memora-hq/memora-protocol";

type ReceiptLikeRef = MemoryRef & {
  valid_signature?: boolean | null;
  agent_sig_verified?: boolean | null;
  event_digest?: string | null;
};

export function inferVerificationStatus(ref: ReceiptLikeRef): "recorded" | "anchored" | "verified" {
  const onChain = !!ref.contract_tx_hash;
  const hcsAnchored = !!ref.hcs_sequence;
  const offChainVerified = ref.valid_signature === true && !!ref.event_digest;
  const agentVerified = ref.agent_sig_verified === true;

  if ((onChain && agentVerified) || (agentVerified && offChainVerified)) {
    return "verified";
  }
  if (onChain || hcsAnchored || offChainVerified) {
    return "anchored";
  }
  return "recorded";
}

export function formatReceiptCard(ref: ReceiptLikeRef): string {
  const eventDigest = ref.event_id ?? ref.event_digest ?? "unavailable";
  const eventType = ref.event_type ?? "unknown";
  const hcsTopic = ref.hcs_topic_id || "unavailable";
  const hcsSequence = ref.hcs_sequence || "unavailable";
  const contractTx = ref.contract_tx_hash || "unavailable";
  const createdAt = ref.created_at || "unavailable";
  const verification = inferVerificationStatus(ref);

  const rows: Array<[string, string]> = [
    ["Execution ID", ref.memory_id],
    ["Event Digest", eventDigest],
    ["Event Type", eventType],
    ["Agent ID", ref.agent_id],
    ["Provider", "unavailable"],
    ["Model", "unavailable"],
    ["Payload Hash", ref.payload_hash],
    ["HCS Topic", hcsTopic],
    ["HCS Sequence", hcsSequence],
    ["Contract TX", contractTx],
    ["Created", createdAt],
    ["Verification", verification],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));

  return [
    "Memora Receipt",
    "----------------------------------------",
    ...rows.map(([label, value]) => `${label.padEnd(width)}: ${value}`),
  ].join("\n");
}
