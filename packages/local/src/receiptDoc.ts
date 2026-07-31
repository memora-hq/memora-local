import type { LocalExecutionManifestV1 } from "@smritheon/memora-protocol";
import type { BundleDisclosure, LocalVerificationResult } from "@smritheon/memora-verifier";
import type { SessionSummary } from "./summary.js";

export interface ReceiptSigner {
  address: string;
  /** The name the reader gave this device, if any. Never asserted as a person's identity. */
  label?: string;
  isThisDevice: boolean;
  receiptsVerified?: number;
  firstSeen?: string;
}

export interface ReceiptDocumentInput {
  manifest: LocalExecutionManifestV1;
  summary: SessionSummary;
  /** Absent means verification never ran — the document says exactly that. */
  verification?: LocalVerificationResult;
  signer: ReceiptSigner;
  disclosure: BundleDisclosure;
  /** sha256 of the `.memora` file this page describes, so the two artefacts stay tied together. */
  bundleFingerprint?: string;
  bundleFileName?: string;
  /** Passed in, never read from the clock, so the same input always renders the same bytes. */
  generatedAt: string;
}

/**
 * Everything interpolated here originates in agent output — tool names, file paths, event types —
 * and the result is loaded into a browser to print. Nothing reaches the page unescaped.
 */
function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Deliberately not `toLocaleString()` — a receipt must render identically on every machine. */
function formatTimestamp(iso?: string): string {
  if (!iso) return "unavailable";
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "unavailable";
  return `${time.toISOString().slice(0, 10)} ${time.toISOString().slice(11, 16)} UTC`;
}

function formatDuration(ms?: number): string | undefined {
  if (ms === undefined || ms < 0) return undefined;
  if (ms < 1_000) return `${String(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} seconds`;
  if (ms < 3_600_000) return `${String(Math.round(ms / 60_000))} minutes`;
  return `${(ms / 3_600_000).toFixed(1)} hours`;
}

function shorten(value: string, lead = 10, tail = 6): string {
  return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

const TIER_SENTENCE: Record<SessionSummary["tier"], string> = {
  deep: "Memora observed this tool's own lifecycle events, so individual actions are attributed to the agent.",
  partial: "Memora observed this workspace, but the tool does not report which actions were the agent's.",
  wrapper: "Memora observed the process from the outside. Individual actions inside it were not itemised.",
  planned: "Memora has no capture integration for this tool yet.",
};

const DISCLOSURE_SENTENCE: Record<BundleDisclosure, string> = {
  none: "The evidence file beside this receipt is sealed. Its contents stay encrypted and unreadable without the recording device's key.",
  partial: "Some records in the evidence file beside this receipt were revealed in plain text. The rest stay encrypted.",
  full: "Every record in the evidence file beside this receipt was revealed in plain text, and each one can be checked against the signature that covers it.",
};

function assuranceStatements(verification: LocalVerificationResult | undefined): Array<{ label: string; value: string; failed: boolean }> {
  if (!verification) {
    return [{ label: "Verification", value: "This receipt was produced without a verification run.", failed: true }];
  }
  return [
    {
      label: "Contents",
      value: verification.integrity === "verified"
        ? "Unchanged since they were recorded."
        : "Changed after they were recorded.",
      failed: verification.integrity !== "verified",
    },
    {
      label: "Signing",
      value: verification.identity === "failed"
        ? "The signature does not match the recorded identity."
        : "One identity signed every record, start to finish.",
      failed: verification.identity === "failed",
    },
    {
      label: "Coverage",
      value: verification.completeness === "complete"
        ? "The full session was captured."
        : verification.completeness === "partial"
          ? "Parts of the session were not captured."
          : "Capture stopped before the session finished.",
      failed: verification.completeness === "interrupted",
    },
    { label: "Storage", value: "Sealed on the device that recorded it. Nothing was uploaded.", failed: false },
  ];
}

function signerStatement(signer: ReceiptSigner): string {
  if (signer.isThisDevice) return "Signed by this device — the same machine that produced this receipt.";
  if (signer.label) {
    const parts = [`Signed by the device the reader named “${signer.label}”.`];
    if (signer.receiptsVerified && signer.receiptsVerified > 1) {
      parts.push(`${String(signer.receiptsVerified)} receipts have been verified from it.`);
    }
    if (signer.firstSeen) parts.push(`First seen ${formatTimestamp(signer.firstSeen)}.`);
    return parts.join(" ");
  }
  return "Signed by a device key with no recorded history.";
}

const STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 48px 56px; background: #fff; color: #16161a;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 12px; line-height: 1.55;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
header { border-bottom: 2px solid #16161a; padding-bottom: 16px; margin-bottom: 28px; }
.eyebrow { margin: 0 0 6px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #6b6b76; }
h1 { margin: 0 0 6px; font-size: 21px; line-height: 1.25; font-weight: 650; }
h2 { margin: 0 0 10px; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: #6b6b76; font-weight: 600; }
.subject { margin: 0; color: #45454f; }
section { margin-bottom: 26px; break-inside: avoid; }
.headline { font-size: 16px; line-height: 1.45; font-weight: 600; margin: 0 0 10px; }
.sentences p { margin: 0 0 6px; color: #45454f; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.card { border: 1px solid #dededf; border-radius: 8px; padding: 12px 14px; }
.card small { display: block; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: #6b6b76; margin-bottom: 4px; }
.card strong { font-weight: 550; }
.card.failed { border-color: #b4231d; background: #fdf3f2; }
.card.failed strong { color: #8f1a15; }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.metrics div { border: 1px solid #dededf; border-radius: 8px; padding: 12px 14px; }
.metrics span { display: block; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: #6b6b76; }
.metrics b { font-size: 20px; font-weight: 600; }
.note { border-left: 3px solid #dededf; padding: 2px 0 2px 14px; color: #45454f; }
.note p { margin: 0 0 5px; }
.note.warn { border-left-color: #c8891f; }
.banner { border: 1px solid #b4231d; background: #fdf3f2; color: #8f1a15; border-radius: 8px; padding: 12px 14px; font-weight: 600; margin-bottom: 22px; }
ol { margin: 0; padding-left: 18px; color: #45454f; }
ol li { margin-bottom: 4px; }
dl { margin: 0; display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 5px 16px; }
dt { color: #6b6b76; }
dd { margin: 0; overflow-wrap: anywhere; }
footer { border-top: 1px solid #dededf; margin-top: 34px; padding-top: 12px; color: #6b6b76; font-size: 10.5px; }
@page { margin: 0; }
`;

/**
 * Renders one session as a self-contained, shareable receipt: plain language first, then how the
 * reader can check every claim on it for themselves. No external stylesheets, fonts, scripts, or
 * images — the file works offline, forever, in any browser.
 */
export function renderReceiptDocument(input: ReceiptDocumentInput): string {
  const { manifest, summary, verification, signer, disclosure } = input;
  const failed = verification ? !verification.valid : true;
  const duration = formatDuration(summary.durationMs);
  const assurance = assuranceStatements(verification);
  const fileChanges = summary.distinctFileCount ?? summary.counts.fileChanges;

  const metrics: Array<[string, number]> = [
    ["Requests", summary.counts.prompts],
    ["Tool calls", summary.counts.toolCalls],
    ["File changes", fileChanges],
    ["Records sealed", summary.counts.totalEvents],
  ];

  const facts: Array<[string, string]> = [
    ["Session started", formatTimestamp(manifest.started_at)],
    ["Session ended", manifest.completed_at ? formatTimestamp(manifest.completed_at) : "did not complete"],
    ...(duration ? [["Duration", duration] as [string, string]] : []),
    ["Session ID", manifest.session_id],
    ["First record", manifest.root_event_id || "unavailable"],
    ["Signing key", signer.address],
    ...(input.bundleFileName ? [["Evidence file", input.bundleFileName] as [string, string]] : []),
    ...(input.bundleFingerprint ? [["Evidence file sha256", input.bundleFingerprint] as [string, string]] : []),
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Memora receipt — ${escapeHtml(summary.agentLabel)}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <p class="eyebrow">Memora · execution receipt</p>
  <h1>${escapeHtml(summary.headline)}</h1>
  <p class="subject">${escapeHtml(summary.agentLabel)} · ${escapeHtml(formatTimestamp(manifest.started_at))}${duration ? ` · ${escapeHtml(duration)}` : ""}</p>
</header>

${failed ? `<div class="banner">This evidence did not verify. Treat everything below as unconfirmed.</div>` : ""}

<section>
  <h2>What happened</h2>
  <p class="headline">${escapeHtml(summary.headline)}</p>
  <div class="sentences">${summary.sentences.map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join("")}</div>
  <div class="metrics">${metrics.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join("")}</div>
</section>

<section>
  <h2>What this receipt establishes</h2>
  <div class="grid">${assurance.map((item) => `<div class="card${item.failed ? " failed" : ""}"><small>${escapeHtml(item.label)}</small><strong>${escapeHtml(item.value)}</strong></div>`).join("")}</div>
</section>

<section>
  <h2>How completely it was observed</h2>
  <div class="note">
    <p>${escapeHtml(TIER_SENTENCE[summary.tier])}</p>
    ${summary.tierReasons.map((reason) => `<p>${escapeHtml(reason)}</p>`).join("")}
    <p>${escapeHtml(DISCLOSURE_SENTENCE[disclosure])}</p>
  </div>
</section>

${summary.caveats.length ? `<section>
  <h2>Worth a look</h2>
  <div class="note warn">${summary.caveats.map((caveat) => `<p>${escapeHtml(caveat)}</p>`).join("")}</div>
</section>` : ""}

<section>
  <h2>Who signed it</h2>
  <div class="note">
    <p>${escapeHtml(signerStatement(signer))}</p>
    <p class="mono">${escapeHtml(shorten(signer.address, 14, 8))}</p>
    <p>A signature proves the record was not altered after it was sealed. It does not prove who produced it.</p>
  </div>
</section>

<section>
  <h2>Check this yourself</h2>
  <ol>
    <li>Ask for the <span class="mono">.memora</span> evidence file this receipt describes.</li>
    ${input.bundleFingerprint ? `<li>Confirm its fingerprint: <span class="mono">shasum -a 256 ${escapeHtml(input.bundleFileName ?? "evidence.memora")}</span> must print <span class="mono">${escapeHtml(input.bundleFingerprint)}</span>.</li>` : ""}
    <li>Verify it offline, with no account and no network: <span class="mono">memora local verify-bundle ${escapeHtml(input.bundleFileName ?? "evidence.memora")}</span> — or drop the file into Memora Local.</li>
    <li>Nothing in this document is trusted on its own. Every claim above is derived from the signed records inside that file.</li>
  </ol>
</section>

<section>
  <h2>Reference</h2>
  <dl>${facts.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd class="mono">${escapeHtml(value)}</dd>`).join("")}</dl>
</section>

<footer>Generated by Memora Local on ${escapeHtml(formatTimestamp(input.generatedAt))} · session ${escapeHtml(shorten(manifest.session_id, 18, 6))}</footer>
</body>
</html>
`;
}
