export type SecretScanSeverity = "block" | "warn";

export interface SecretScanFinding {
  ruleId: string;
  severity: SecretScanSeverity;
  /** A human reference to where this was found — an event label, not raw location data. */
  label: string;
  /** Redacted preview of the matched value — the raw value is never surfaced anywhere. */
  preview: string;
}

export interface SecretScanResult {
  findings: SecretScanFinding[];
  blocked: boolean;
  warned: boolean;
}

interface SecretScanRule {
  id: string;
  severity: SecretScanSeverity;
  pattern: RegExp;
}

/**
 * High-confidence, known credential formats — block outright, no --force. False positives
 * here should be reported so the rule gets tuned, not worked around.
 */
const BLOCK_RULES: SecretScanRule[] = [
  { id: "aws_access_key_id", severity: "block", pattern: /AKIA[0-9A-Z]{16}/g },
  { id: "github_token", severity: "block", pattern: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g },
  { id: "openai_api_key", severity: "block", pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: "anthropic_api_key", severity: "block", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "google_api_key", severity: "block", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { id: "slack_token", severity: "block", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "private_key_pem", severity: "block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { id: "jwt_token", severity: "block", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

/** Ambiguous matches — surfaced with a default-No confirmation, but publish may proceed. */
const WARN_RULES: SecretScanRule[] = [
  { id: "bearer_header", severity: "warn", pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{8,}/gi },
  {
    id: "env_secret_assignment",
    severity: "warn",
    pattern: /\b(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)\w*\s*[:=]\s*['"]?[^\s'"]{6,}/g,
  },
];

const HIGH_ENTROPY_MIN_LENGTH = 24;
// Real-world high-entropy tokens (hex, base64) rarely land exactly at their alphabet's
// theoretical max (log2(16)=4.0, log2(64)=6.0) over a short sample — 3.5 catches random-looking
// hex/base64 while still excluding low-variety or repetitive strings.
const HIGH_ENTROPY_THRESHOLD_BITS_PER_CHAR = 3.5;
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/_=-]{24,}/g;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function redactPreview(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 2)}${"•".repeat(Math.max(4, value.length - 2))}`;
  const head = value.slice(0, Math.min(8, value.length - 4));
  const tail = value.slice(-4);
  return `${head}${"•".repeat(10)}${tail}`;
}

interface RawMatch {
  finding: SecretScanFinding;
  raw: string;
}

function findMatches(rules: SecretScanRule[], text: string, label: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      matches.push({ finding: { ruleId: rule.id, severity: rule.severity, label, preview: redactPreview(match[0]) }, raw: match[0] });
    }
  }
  return matches;
}

// Pure-hex strings (sha256 digests, event/object IDs, git-style hashes) are ubiquitous
// non-secret identifiers throughout Memora's own data model, and no real secret format this
// scanner targets (AWS/GitHub/OpenAI/Anthropic/Slack/Google/JWT/base64 tokens) is pure lowercase
// hex — they all mix case, digits, and `+/_=-`. Excluding pure hex keeps this rule from firing
// on every session's own hashes, which would make it too noisy to mean anything.
const PURE_HEX = /^[0-9a-f]+$/i;

function findHighEntropyStrings(text: string, label: string, alreadyMatchedRaw: string[]): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  for (const match of text.matchAll(HIGH_ENTROPY_CANDIDATE)) {
    const candidate = match[0];
    if (candidate.length < HIGH_ENTROPY_MIN_LENGTH) continue;
    if (PURE_HEX.test(candidate)) continue;
    if (alreadyMatchedRaw.some((known) => known.includes(candidate) || candidate.includes(known))) continue;
    if (shannonEntropy(candidate) < HIGH_ENTROPY_THRESHOLD_BITS_PER_CHAR) continue;
    findings.push({ ruleId: "high_entropy_string", severity: "warn", label, preview: redactPreview(candidate) });
  }
  return findings;
}

/**
 * Scans one piece of plaintext (an event's decrypted payload, serialized) for credential
 * patterns. Runs entirely offline against an in-memory string — nothing here ever touches
 * the network, and the raw matched value never leaves this function except as a redacted
 * preview.
 */
export function scanTextForSecrets(text: string, label: string): SecretScanFinding[] {
  const blocked = findMatches(BLOCK_RULES, text, label);
  const warned = findMatches(WARN_RULES, text, label);
  const highEntropy = findHighEntropyStrings(
    text,
    label,
    [...blocked, ...warned].map((m) => m.raw),
  );
  return [...blocked.map((m) => m.finding), ...warned.map((m) => m.finding), ...highEntropy];
}

export interface PlaintextForScan {
  label: string;
  text: string;
}

/** Scans every event's plaintext and classifies the overall result for the publish flow. */
export function scanForSecrets(plaintexts: PlaintextForScan[]): SecretScanResult {
  const findings = plaintexts.flatMap(({ label, text }) => scanTextForSecrets(text, label));
  return {
    findings,
    blocked: findings.some((finding) => finding.severity === "block"),
    warned: findings.some((finding) => finding.severity === "warn"),
  };
}
