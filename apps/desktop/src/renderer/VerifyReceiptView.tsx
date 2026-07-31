import React, { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle, FileArrowDown, ShieldCheck, UploadSimple, Warning, XCircle } from "@phosphor-icons/react";
import {
  DisclosureBadge,
  ExecutionTimeline,
  ReceiptInspector,
  SessionSummaryCard,
  SignerCard,
  Spinner,
  StatusBadge,
} from "./components";
import { levelAtLeast, showsTimelineByDefault, type ReadingLevel } from "./labels";

/**
 * Verifying someone else's receipt. Everything here is read-only and nothing is imported: the
 * file is checked, described, and forgotten when the view closes.
 */
export function VerifyReceiptView({
  result,
  busy,
  error,
  level,
  signerBusy,
  onChoose,
  onVerifyPath,
  onNameSigner,
  onForgetSigner,
  onClear,
}: {
  result?: LocalBundleVerificationReply;
  busy: boolean;
  error: string;
  level: ReadingLevel;
  signerBusy: boolean;
  onChoose: () => void;
  onVerifyPath: (path: string) => void;
  onNameSigner: (address: string, label: string) => void;
  onForgetSigner: (address: string) => void;
  onClear: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  useEffect(() => {
    setExpanded(false);
    setInspectorOpen(false);
    setSelectedEventId(undefined);
    setSelectedEventIds([]);
  }, [result?.path, level]);

  if (!result) {
    return <section
      className={`workspace-empty verify-drop ${dragging ? "dragging" : ""}`}
      id="main-content"
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (!file) return;
        const path = window.memoraLocal?.pathForFile(file);
        if (path) onVerifyPath(path);
      }}
    >
      <span className="empty-orbit"><ShieldCheck weight="duotone" aria-hidden /></span>
      <p className="eyebrow">Verify a receipt</p>
      <h1>Check anyone's evidence.</h1>
      <p>Drop a <code>.memora</code> file here — from a colleague, a contractor, a client. Memora checks it against the signature it was sealed with. No account, no network, nothing uploaded.</p>
      <div className="verify-actions">
        <button className="button button-primary" disabled={busy} onClick={onChoose}>
          {busy ? <Spinner label="Verifying evidence" /> : <FileArrowDown aria-hidden />}
          {busy ? "Verifying…" : "Choose a file"}
        </button>
      </div>
      {error && <p className="verify-error" role="alert"><Warning weight="fill" aria-hidden />{error}</p>}
      <p className="verify-note"><UploadSimple aria-hidden />A verified file is never added to your own evidence. It is read, checked, and shown.</p>
    </section>;
  }

  const { verification, signer, manifest, events, presentations, details, summary } = result;
  const showTimeline = showsTimelineByDefault(level) || expanded;
  const selectedEvent = events.find((event) => (event.commit.event_id ?? event.commit.memory_id) === selectedEventId);
  const selectedDetails = selectedEventIds.map((id) => details[id]).filter(Boolean);

  const share = <button className="button button-secondary" onClick={onClear}><ArrowLeft aria-hidden />Verify another</button>;

  const banner = <div className="verify-banner">
    <div className="verify-banner-file">
      {verification.valid ? <CheckCircle weight="fill" className="ok" aria-hidden /> : <XCircle weight="fill" className="bad" aria-hidden />}
      <span>
        <strong>{verification.valid ? "Sealed and unaltered" : "This receipt did not verify"}</strong>
        <small>{result.fileName} · {verification.eventCount} record{verification.eventCount === 1 ? "" : "s"}</small>
      </span>
      <StatusBadge status={verification.valid ? "verified" : "failed"} label={verification.valid ? "Verified" : "Failed"} />
    </div>
    {!verification.valid && <div className="capture-warning">
      <Warning weight="fill" aria-hidden />
      <div>
        <strong>Do not rely on anything in this file</strong>
        {verification.errors.slice(0, 4).map((message) => <p key={message}>{message}</p>)}
        {verification.errors.length > 4 && <p>and {verification.errors.length - 4} more problems.</p>}
      </div>
    </div>}
    <DisclosureBadge
      disclosure={verification.disclosure}
      disclosedCount={verification.disclosedCount}
      eventCount={verification.eventCount}
    />
    <SignerCard
      signer={signer}
      level={level}
      busy={signerBusy}
      onName={(label) => onNameSigner(signer.address, label)}
      onForget={() => onForgetSigner(signer.address)}
    />
    {levelAtLeast(level, "power") && <details className="verify-checks">
      <summary>{verification.checks.length} verification checks</summary>
      {verification.checks.map((check) => <p key={`${check.name}-${check.detail}`} className={`verify-check verify-${check.status}`}>
        <strong>{check.name}</strong>{check.detail}
      </p>)}
    </details>}
  </div>;

  return <>
    {showTimeline ? <ExecutionTimeline
      session={manifest}
      events={events}
      verification={verification}
      selectedEventId={selectedEventId}
      refreshing={false}
      level={level}
      presentations={presentations}
      share={share}
      banner={banner}
      onSelectItem={(id, eventIds) => { setSelectedEventId(id); setSelectedEventIds(eventIds); }}
      onOpenInspector={() => setInspectorOpen(true)}
      onBackToSummary={showsTimelineByDefault(level) ? undefined : () => setExpanded(false)}
    /> : <SessionSummaryCard
      session={manifest}
      summary={summary}
      verification={verification}
      level={level}
      refreshing={false}
      share={share}
      banner={banner}
      onShowTimeline={() => setExpanded(true)}
    />}
    <ReceiptInspector
      event={selectedEvent}
      presentation={selectedEventId ? presentations[selectedEventId] : undefined}
      relatedEventIds={selectedEventIds}
      details={selectedDetails}
      revealing={false}
      session={manifest}
      verification={verification}
      open={inspectorOpen}
      level={level}
      canReveal={false}
      onReveal={() => undefined}
      onClose={() => setInspectorOpen(false)}
    />
    {inspectorOpen && <button className="inspector-backdrop" aria-label="Close evidence inspector" onClick={() => setInspectorOpen(false)} />}
  </>;
}
