import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LocalEventRecordV1, LocalExecutionManifestV1 } from "@smritheon/memora-protocol";
import type { IntegrationDiagnosticResult, IntegrationHealth, LocalVerificationResult, SessionSummary } from "@smritheon/memora-local";
import {
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  CaretRight,
  ChatText,
  Check,
  CheckCircle,
  Circle,
  Clock,
  Export,
  File,
  FilePdf,
  Fingerprint,
  GitBranch,
  HardDrives,
  Info,
  LockKey,
  LockKeyOpen,
  PlugsConnected,
  Receipt,
  Seal,
  ShieldCheck,
  Terminal,
  Warning,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { siClaude, siCursor, siGithubcopilot, siOpenai } from "simple-icons";
import {
  assuranceLabels,
  disclosureLabel,
  disclosureStatement,
  EVIDENCE_FIELDS,
  fieldLabel,
  READING_LEVELS,
  READING_LEVEL_META,
  showsField,
  showsRawEvidence,
  signerStatement,
  traceCountLabels,
  traceFilterLabels,
  type BundleDisclosureState,
  type EvidenceFieldId,
  type ReadingLevel,
  type SignerIdentity,
} from "./labels";
import { buildTrace, eventLabel, formatDateTime, formatTime, groupSessionsByProvider, healthLabel, humanize, providerForSession, sessionDuration, shortHash, type SessionProvider, type TraceCategory, type TraceItem } from "./viewModels";

export type IntegrationId = "codex" | "claude" | "cursor" | "vscode";

const providerNames: Record<SessionProvider, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  vscode: "GitHub Copilot",
  local: "Local tools",
};

const providerIcons = {
  codex: siOpenai,
  claude: siClaude,
  cursor: siCursor,
  vscode: siGithubcopilot,
} as const;

export function ProviderLogo({ provider, size = 22 }: { provider: IntegrationId | SessionProvider; size?: number }) {
  if (provider === "local") return <HardDrives size={size} weight="duotone" aria-hidden />;
  const icon = providerIcons[provider];
  return <svg
    className="provider-logo"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    role="img"
    aria-label={icon.title}
  >
    <path d={icon.path} fill="currentColor" />
  </svg>;
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? "brand brand-compact" : "brand"}>
    <span className="brand-mark" aria-hidden><i /><b /></span>
    <span className="brand-copy"><strong>Memora</strong>{!compact && <small>Local evidence</small>}</span>
  </div>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function StatusBadge({ status, label }: { status: IntegrationHealth | "verified" | "partial" | "failed" | "checking"; label?: string }) {
  const Icon = status === "capturing" || status === "verified" ? CheckCircle
    : status === "needs_attention" || status === "partial" ? Warning
    : status === "failed" || status === "not_installed" ? XCircle
    : Circle;
  return <span className={`status-badge status-${status}`}><Icon weight="fill" aria-hidden />{label ?? healthLabel(status as IntegrationHealth)}</span>;
}

const agentMeta: Record<IntegrationId, { name: string; description: string }> = {
  codex: { name: "Codex", description: "Desktop app, IDE and terminal sessions" },
  claude: { name: "Claude Code", description: "Terminal sessions and lifecycle tools" },
  cursor: { name: "Cursor", description: "Workspace edits and integrated terminal" },
  vscode: { name: "GitHub Copilot", description: "VS Code workspace activity" },
};

export function AgentChoice({
  id,
  selected,
  onToggle,
}: {
  id: IntegrationId;
  selected: boolean;
  onToggle: () => void;
}) {
  const meta = agentMeta[id];
  return <article className={`agent-choice ${selected ? "selected" : ""}`}>
    <button className="agent-choice-main" type="button" aria-pressed={selected} onClick={onToggle}>
      <span className={`agent-icon agent-${id}`}><ProviderLogo provider={id} size={22} /></span>
      <span><strong>{meta.name}</strong><small>{meta.description}</small></span>
      <span className="choice-control">{selected ? <Check weight="bold" aria-hidden /> : <span aria-hidden>+</span>}</span>
    </button>
  </article>;
}

const setupGuidance: Record<IntegrationId, { title: string; steps: string[]; note: string }> = {
  codex: {
    title: "Review the Memora hooks in Codex",
    steps: ["Open Codex and enter /hooks.", "Review each Memora lifecycle hook.", "Choose Trust, then perform one Codex action."],
    note: "Codex requires this one-time approval. Memora cannot grant it for you.",
  },
  claude: {
    title: "Restart Claude Code once",
    steps: ["Close any running Claude Code session.", "Open a new terminal and start Claude.", "Perform one action, then test the connection."],
    note: "Memora preserves unrelated Claude hooks when it installs its lifecycle handlers.",
  },
  cursor: {
    title: "Restart Cursor to load Memora",
    steps: ["Fully quit Cursor.", "Open the workspace you want to observe.", "Save a file or use the integrated terminal."],
    note: "Workspace evidence is recorded locally by the Memora extension.",
  },
  vscode: {
    title: "Restart VS Code to load Memora",
    steps: ["Fully quit VS Code.", "Open the workspace that uses Copilot.", "Save a file or use the integrated terminal."],
    note: "Workspace activity is captured; Copilot attribution remains partial.",
  },
};

export function IntegrationSetupGuide({
  selected,
  diagnostics,
  diagnosing,
  onTest,
  onOpenDiagnostic,
}: {
  selected: IntegrationId[];
  diagnostics: Partial<Record<"codex" | "claude", IntegrationDiagnosticResult>>;
  diagnosing?: "codex" | "claude";
  onTest: (provider: "codex" | "claude") => void;
  onOpenDiagnostic: (provider: "codex" | "claude") => void;
}) {
  return <div className="setup-guide-list">
    {selected.map((id) => {
      const guidance = setupGuidance[id];
      const diagnostic = id === "codex" || id === "claude" ? diagnostics[id] : undefined;
      return <section className="setup-guide" key={id}>
        <div className={`setup-logo agent-${id}`}><ProviderLogo provider={id} size={25} /></div>
        <div className="setup-guide-copy">
          <div className="setup-guide-title"><div><p>{agentMeta[id].name}</p><h3>{guidance.title}</h3></div>{diagnostic && <StatusBadge status={diagnostic.status} />}</div>
          <ol>{guidance.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p className="setup-guide-note"><LockKey aria-hidden />{guidance.note}</p>
          {(id === "codex" || id === "claude") && <div className="setup-guide-actions">
            <button className="button button-secondary" onClick={() => onTest(id)} disabled={diagnosing === id}>
              {diagnosing === id ? <Spinner label={`Testing ${id}`} /> : <ArrowClockwise aria-hidden />}
              {diagnosing === id ? "Testing…" : "Test connection"}
            </button>
            {diagnostic && <button className="button button-quiet" onClick={() => onOpenDiagnostic(id)}>View details</button>}
          </div>}
        </div>
      </section>;
    })}
  </div>;
}

export function DiagnosticReport({
  diagnostic,
  testing,
  onTest,
  onClose,
}: {
  diagnostic: IntegrationDiagnosticResult;
  testing: boolean;
  onTest: () => void;
  onClose?: () => void;
}) {
  return <section className="diagnostic-panel" aria-label={`${diagnostic.provider} diagnostic`}>
    <header className="panel-header">
      <div>
        <p className="eyebrow">Connection diagnostic</p>
        <h2>{humanize(diagnostic.provider)}</h2>
      </div>
      {onClose && <button className="icon-button" aria-label="Close diagnostic" onClick={onClose}><X aria-hidden /></button>}
    </header>
    <div className="diagnostic-summary">
      <StatusBadge status={diagnostic.status} />
      <span>Tested {formatDateTime(diagnostic.checked_at)}</span>
    </div>
    <div className="diagnostic-checks">
      {diagnostic.checks.map((check) => {
        const Icon = check.status === "passed" ? CheckCircle : check.status === "warning" ? Warning : XCircle;
        return <div className={`diagnostic-check check-${check.status}`} key={check.id}>
          <Icon weight="fill" aria-hidden />
          <span><strong>{check.label}</strong><small>{check.detail}</small></span>
        </div>;
      })}
    </div>
    {diagnostic.runtimes.length > 0 && <div className="diagnostic-runtime">
      <p className="section-label">Detected runtimes</p>
      {diagnostic.runtimes.map((runtime) => <p key={`${runtime.kind}-${runtime.path}`}><code>{runtime.kind}</code><span>{runtime.version ?? shortHash(runtime.path, 18)}</span></p>)}
    </div>}
    {diagnostic.remediation.length > 0 && <div className="remediation">
      <Info weight="fill" aria-hidden />
      <div><strong>Action required</strong>{diagnostic.remediation.map((item) => <p key={item}>{item}</p>)}</div>
    </div>}
    <button className="button button-secondary diagnostic-rerun" onClick={onTest} disabled={testing}>
      {testing ? <Spinner label="Running diagnostic" /> : <ArrowClockwise aria-hidden />}
      {testing ? "Running checks…" : "Test again"}
    </button>
  </section>;
}

export function ReadingLevelSwitch({ level, onChange }: { level: ReadingLevel; onChange: (level: ReadingLevel) => void }) {
  return <div className="reading-level-switch" role="group" aria-label="Reading level">
    {READING_LEVELS.map((id) => <button
      key={id}
      className={level === id ? "active" : ""}
      aria-pressed={level === id}
      title={READING_LEVEL_META[id].hint}
      onClick={() => onChange(id)}
    >{READING_LEVEL_META[id].short}</button>)}
  </div>;
}

export function SessionRail({
  sessions,
  selected,
  health,
  installing,
  installMessage,
  level,
  verifying,
  onSelect,
  onConnections,
  onInstall,
  onChangeLevel,
  onVerifyReceipt,
}: {
  sessions: LocalExecutionManifestV1[];
  selected?: string;
  health: IntegrationHealth;
  installing: boolean;
  installMessage: string;
  level: ReadingLevel;
  verifying: boolean;
  onSelect: (id: string) => void;
  onConnections: () => void;
  onInstall: () => void;
  onChangeLevel: (level: ReadingLevel) => void;
  onVerifyReceipt: () => void;
}) {
  return <aside className="session-rail">
    <div className="titlebar-drag" />
    <Brand />
    <nav aria-label="Memora Local">
      <button className="rail-action" onClick={onConnections}><PlugsConnected aria-hidden /><span>Agent connections</span><StatusBadge status={health} /></button>
      <button className={`rail-action ${verifying ? "active" : ""}`} aria-pressed={verifying} onClick={onVerifyReceipt}><ShieldCheck aria-hidden /><span>Verify a receipt</span><CaretRight aria-hidden /></button>
      <button className="rail-action" onClick={onInstall} disabled={installing}>{installing ? <Spinner label="Installing CLI" /> : <Terminal aria-hidden />}<span>{installing ? "Installing CLI…" : "Command-line tool"}</span><CaretRight aria-hidden /></button>
    </nav>
    {installMessage && <div className={`inline-message ${installMessage.startsWith("Installation failed") ? "message-error" : "message-success"}`} role="status">{installMessage}</div>}
    <ReadingLevelSwitch level={level} onChange={onChangeLevel} />
    <div className="rail-section-heading"><span>Executions</span><b>{sessions.length}</b></div>
    <div className="session-list">
      {sessions.length === 0 && <p className="rail-empty">Captured agent executions will appear here.</p>}
      {groupSessionsByProvider(sessions).map((group) => <section className="provider-session-group" key={group.provider}>
        <div className="provider-group-label"><ProviderLogo provider={group.provider} size={13} /><span>{providerNames[group.provider]}</span><b>{group.sessions.length}</b></div>
        {group.sessions.map((session) => <button
          key={session.session_id}
          className={`session-row ${selected === session.session_id ? "active" : ""}`}
          onClick={() => onSelect(session.session_id)}
          aria-current={selected === session.session_id ? "page" : undefined}
          title={session.session_id}
        >
          <span className={`session-state capture-${session.capture_status}`} aria-hidden />
          <span><strong>{shortHash(session.session_id, 10)}</strong><small>{humanize(session.capture_status)} · {session.event_ids.length} events</small></span>
          <CaretRight aria-hidden />
        </button>)}
      </section>)}
    </div>
    <footer><span className="privacy-dot" />Evidence stays on this device</footer>
  </aside>;
}

function EventIcon({ type }: { type?: string }) {
  const normalized = type?.toLowerCase() ?? "";
  const Icon = normalized.includes("file") ? File
    : normalized.includes("process") || normalized.includes("terminal") ? Terminal
    : normalized.includes("session") ? Receipt
    : normalized.includes("git") ? GitBranch
    : Receipt;
  return <Icon weight="duotone" aria-hidden />;
}

function TraceIcon({ category }: { category: TraceCategory }) {
  const Icon = category === "prompt" ? ChatText
    : category === "tool" ? Terminal
    : category === "file" ? File
    : LockKey;
  return <Icon weight="duotone" aria-hidden />;
}

function traceDuration(item: TraceItem): string | undefined {
  if (!item.completedAt) return undefined;
  const duration = new Date(item.completedAt).getTime() - new Date(item.timestamp).getTime();
  if (!Number.isFinite(duration) || duration < 0) return undefined;
  if (duration < 1_000) return `${duration} ms`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)} sec`;
  return `${Math.round(duration / 60_000)} min`;
}

/** A session ID is meaningless to a plain-language reader; name the tool instead. */
function sessionTitle(session: LocalExecutionManifestV1): string {
  return `${providerNames[providerForSession(session)]} session`;
}

export function ShareEvidence({
  busy,
  onExportSealed,
  onExportReadable,
  onSaveReceipt,
}: {
  busy: boolean;
  onExportSealed: () => void;
  onExportReadable: () => void;
  onSaveReceipt: () => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (action: () => void) => { setOpen(false); action(); };
  return <div className="share-evidence">
    <button className="button button-secondary" disabled={busy} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      {busy ? <Spinner label="Preparing evidence" /> : <Export weight="duotone" aria-hidden />}
      {busy ? "Preparing…" : "Share evidence"}
      {!busy && <CaretDown aria-hidden />}
    </button>
    {open && <>
      <button className="share-backdrop" aria-label="Close share menu" onClick={() => setOpen(false)} />
      <div className="share-menu" role="menu">
        <button role="menuitem" onClick={() => choose(onSaveReceipt)}>
          <FilePdf weight="duotone" aria-hidden />
          <span><strong>Save PDF receipt</strong><small>A page anyone can read. No hashes, no account.</small></span>
        </button>
        <button role="menuitem" onClick={() => choose(onExportSealed)}>
          <Seal weight="duotone" aria-hidden />
          <span><strong>Export sealed evidence</strong><small>Proof without content. They verify it; they read nothing.</small></span>
        </button>
        <button role="menuitem" className="share-disclose" onClick={() => choose(onExportReadable)}>
          <LockKeyOpen weight="duotone" aria-hidden />
          <span><strong>Export readable copy…</strong><small>Includes the decrypted prompts and tool calls.</small></span>
        </button>
      </div>
    </>}
  </div>;
}

/**
 * The one place local plaintext is allowed to leave this device. It says exactly what is about to
 * be shared, before anything is written.
 */
export function DisclosureConfirm({
  summary,
  busy,
  onConfirm,
  onCancel,
}: {
  summary?: SessionSummary;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const records = summary?.counts.totalEvents ?? 0;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target && !busy) onCancel();
  }}>
    <section className="modal disclosure-modal" role="dialog" aria-modal="true" aria-labelledby="disclosure-title">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Before you share</p>
          <h2 id="disclosure-title">A readable copy reveals what the agent actually did.</h2>
        </div>
        <button className="icon-button" aria-label="Cancel" disabled={busy} onClick={onCancel}><X aria-hidden /></button>
      </header>
      <p>Everyone who opens this file can read it — there is no password on it and no way to take it back.</p>
      <ul className="disclosure-list">
        <li><LockKeyOpen weight="duotone" aria-hidden /><span><strong>{records} record{records === 1 ? "" : "s"} in plain text</strong><small>Your exact prompts, every tool call, and the results they returned.</small></span></li>
        <li><ShieldCheck weight="duotone" aria-hidden /><span><strong>Each one provable</strong><small>The reader can check the revealed content against the signature that covers it.</small></span></li>
        <li><HardDrives weight="duotone" aria-hidden /><span><strong>Your key never leaves</strong><small>The file carries content, not the identity that signed it.</small></span></li>
      </ul>
      {summary?.secrets === "secret-paths-observed" && <div className="capture-warning">
        <Warning weight="fill" aria-hidden />
        <div><strong>This session touched files that look like secrets</strong><p>Their paths will appear in the copy you share. Memora never recorded their contents.</p></div>
      </div>}
      <div className="modal-actions">
        <button className="button button-quiet" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="button button-primary" disabled={busy} onClick={onConfirm}>
          {busy ? <Spinner label="Preparing readable copy" /> : <LockKeyOpen aria-hidden />}
          {busy ? "Preparing…" : "Choose where to save"}
        </button>
      </div>
    </section>
  </div>;
}

export function SignerCard({
  signer,
  level,
  busy,
  onName,
  onForget,
}: {
  signer: SignerIdentity;
  level: ReadingLevel;
  busy: boolean;
  onName: (label: string) => void;
  onForget: () => void;
}) {
  const statement = signerStatement(signer, level);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState(signer.label ?? "");
  useEffect(() => { setNaming(false); setDraft(signer.label ?? ""); }, [signer.address, signer.label]);

  return <section className="signer-card">
    <div className="signer-heading">
      <span className={`signer-icon ${signer.isThisDevice ? "own" : signer.label ? "named" : ""}`}><Fingerprint weight="duotone" aria-hidden /></span>
      <div><strong>{statement.title}</strong><code>{statement.address}</code></div>
    </div>
    {statement.lines.map((line) => <p key={line}>{line}</p>)}
    {statement.canName && !naming && <div className="signer-actions">
      <button className="button button-quiet" onClick={() => setNaming(true)}>{signer.label ? "Rename this device" : "Name this device"}</button>
      {signer.known && <button className="button button-quiet" disabled={busy} onClick={onForget}>Forget it</button>}
    </div>}
    {statement.canName && naming && <form className="signer-naming" onSubmit={(event) => { event.preventDefault(); onName(draft); setNaming(false); }}>
      <label htmlFor="signer-label">A name only you will see</label>
      <input
        id="signer-label"
        value={draft}
        maxLength={60}
        autoFocus
        placeholder="Priya's laptop"
        onChange={(event) => setDraft(event.target.value)}
      />
      <button className="button button-secondary" type="submit" disabled={busy}>Save</button>
      <button className="button button-quiet" type="button" onClick={() => { setNaming(false); setDraft(signer.label ?? ""); }}>Cancel</button>
    </form>}
  </section>;
}

export function DisclosureBadge({
  disclosure,
  disclosedCount,
  eventCount,
}: {
  disclosure: BundleDisclosureState;
  disclosedCount: number;
  eventCount: number;
}) {
  const statement = disclosureStatement(disclosure, disclosedCount, eventCount);
  return <div className={`disclosure-badge disclosure-${disclosure}`}>
    {disclosure === "none" ? <LockKey weight="duotone" aria-hidden /> : <LockKeyOpen weight="duotone" aria-hidden />}
    <span><strong>{statement.title}</strong><small>{statement.detail}</small></span>
  </div>;
}

function AssuranceStrip({ verification, level }: { verification?: LocalVerificationResult; level: ReadingLevel }) {
  const assurance = assuranceLabels(verification, level);
  return <div className={`assurance-strip ${level === "developer" ? "" : "assurance-plain"}`} aria-label="Execution assurance">
    {assurance.length
      ? assurance.map(({ id, label, value }) => <div key={id}><small>{label}</small><strong>{value}</strong></div>)
      : [1, 2, 3, 4].map((item) => <div className="skeleton assurance-skeleton" key={item} />)}
  </div>;
}

export function ExecutionTimeline({
  session,
  events,
  verification,
  selectedEventId,
  refreshing,
  level,
  onSelectItem,
  onOpenInspector,
  onBackToSummary,
  presentations,
  share,
  banner,
}: {
  session: LocalExecutionManifestV1;
  events: LocalEventRecordV1[];
  verification?: LocalVerificationResult;
  selectedEventId?: string;
  refreshing: boolean;
  level: ReadingLevel;
  onSelectItem: (id: string, eventIds: string[]) => void;
  onOpenInspector: () => void;
  onBackToSummary?: () => void;
  presentations: Record<string, LocalEventPresentation>;
  share?: React.ReactNode;
  banner?: React.ReactNode;
}) {
  const trace = useMemo(() => buildTrace(events, presentations), [events, presentations]);
  const [filter, setFilter] = useState<"all" | TraceCategory>("all");
  const [openTurns, setOpenTurns] = useState<Set<string>>(new Set());
  const [visibleLimits, setVisibleLimits] = useState<Record<string, number>>({});
  const initializedSession = useRef<string>();
  useEffect(() => {
    const latest = trace.turns.at(-1)?.id;
    if (!latest || initializedSession.current === session.session_id) return;
    initializedSession.current = session.session_id;
    setOpenTurns(new Set([latest]));
    setVisibleLimits({});
    setFilter("all");
  }, [session.session_id, trace.turns.length]);

  const visibleTurns = trace.turns
    .map((turn) => ({
      ...turn,
      items: filter === "all" ? turn.items : turn.items.filter((item) => item.category === filter),
    }))
    .filter((turn) => turn.items.length > 0 || (filter === "all" && turn.hiddenEventCount > 0));
  const counts = traceCountLabels(trace, level);
  return <section className="workspace-main" id="main-content">
    <header className="execution-header">
      <div>
        <div className="header-kicker"><span>Execution evidence</span>{refreshing && <><i />Live</>}</div>
        <h1 title={session.session_id}>{level === "everyone" ? sessionTitle(session) : shortHash(session.session_id, 18)}</h1>
        <p>{session.agent_id} · {sessionDuration(session)}</p>
      </div>
      <div className="execution-header-actions">
        <StatusBadge status={verification?.valid ? "verified" : verification ? "failed" : "checking"} label={verification?.valid ? "Verified" : verification ? "Verification failed" : "Checking"} />
        {share}
      </div>
    </header>
    <AssuranceStrip verification={verification} level={level} />
    {banner}
    {onBackToSummary && <button className="button button-secondary summary-return" onClick={onBackToSummary}>Back to the plain-language summary</button>}
    {session.capture_warnings.length > 0 && <div className="capture-warning"><Warning weight="fill" aria-hidden /><div><strong>Partial capture</strong>{session.capture_warnings.map((warning) => <p key={`${warning.code}-${warning.message}`}>{warning.message}</p>)}</div></div>}
    <div className="timeline-heading">
      <div>
        <p className="eyebrow">Chronological trace</p>
        <h2>{counts.heading} {counts.aside && <span>{counts.aside}</span>}</h2>
        <p>{counts.detail}</p>
      </div>
      <span><Clock aria-hidden />Oldest first</span>
    </div>
    <div className="trace-filters" aria-label="Filter execution trace">
      {traceFilterLabels(level).map(([id, label]) => <button
        key={id}
        className={filter === id ? "active" : ""}
        aria-pressed={filter === id}
        onClick={() => setFilter(id)}
      >{label}</button>)}
    </div>
    <div className="timeline-scroll trace-scroll">
      {events.length === 0 ? <div className="content-empty"><Receipt weight="duotone" aria-hidden /><h3>Waiting for evidence</h3><p>This execution exists, but no event records are available yet.</p></div>
        : visibleTurns.length === 0 ? <div className="content-empty"><Receipt weight="duotone" aria-hidden /><h3>No matching actions</h3><p>Choose another trace filter to see the recorded activity.</p></div>
        : visibleTurns.map((turn) => {
          const expanded = openTurns.has(turn.id);
          const visibleLimit = visibleLimits[turn.id] ?? 8;
          const displayedItems = turn.items.slice(0, visibleLimit);
          const remaining = Math.max(0, turn.items.length - displayedItems.length);
          return <section className={`trace-turn ${expanded ? "expanded" : ""}`} key={turn.id}>
            <button className="trace-turn-header" aria-expanded={expanded} onClick={() => setOpenTurns((current) => {
              const next = new Set(current);
              if (next.has(turn.id)) next.delete(turn.id);
              else next.add(turn.id);
              return next;
            })}>
              <span className="turn-index">{turn.label === "Session setup" ? "S" : turn.label.replace("Turn ", "")}</span>
              <span>
                <strong>{turn.label}</strong>
                <small>{turn.items.length} action{turn.items.length === 1 ? "" : "s"} · {turn.totalEventCount} evidence records</small>
              </span>
              <time>{formatTime(turn.startedAt)}</time>
              <CaretDown aria-hidden />
            </button>
            {expanded && <div className="trace-turn-body">
              {displayedItems.map((item) => {
                const selected = item.eventIds.includes(selectedEventId ?? "");
                const duration = traceDuration(item);
                return <button
                  key={`${turn.id}-${item.id}`}
                  className={`trace-action trace-${item.category} trace-${item.status} ${selected ? "active" : ""}`}
                  onClick={() => { onSelectItem(item.id, item.eventIds); onOpenInspector(); }}
                >
                  <span className="trace-action-icon"><TraceIcon category={item.category} /></span>
                  <span className="trace-action-copy">
                    <span className="trace-action-title"><strong>{item.title}</strong>{item.tool && <code>{item.tool}</code>}</span>
                    <small>{item.detail}</small>
                    {item.target && <span className="trace-target">{item.target}</span>}
                  </span>
                  <span className="trace-action-meta">
                    <time>{formatTime(item.timestamp)}</time>
                    {duration && <small>{duration}</small>}
                    <i>{humanize(item.status)}</i>
                  </span>
                  <CaretRight aria-hidden />
                </button>;
              })}
              {remaining > 0 && <button className="trace-show-more" onClick={() => setVisibleLimits((current) => ({
                ...current,
                [turn.id]: Math.min(turn.items.length, visibleLimit + 20),
              }))}>
                <span>Show {Math.min(20, remaining)} more actions</span>
                <small>{displayedItems.length} of {turn.items.length} shown in chronological order</small>
                <CaretDown aria-hidden />
              </button>}
              {filter === "all" && turn.hiddenEventCount > 0 && <div className="folded-evidence">
                <LockKey aria-hidden />
                <span><strong>{turn.hiddenEventCount} background record{turn.hiddenEventCount === 1 ? "" : "s"} folded away</strong><small>Lifecycle, process, and terminal capture evidence remains encrypted and verifiable.</small></span>
              </div>}
            </div>}
          </section>;
        })}
    </div>
  </section>;
}

const TIER_LABELS: Record<SessionSummary["tier"], string> = {
  deep: "Deep capture",
  partial: "Partial capture",
  wrapper: "Wrapper capture",
  planned: "Not captured yet",
};

export function SessionSummaryCard({
  session,
  summary,
  verification,
  level,
  refreshing,
  onShowTimeline,
  share,
  banner,
}: {
  session: LocalExecutionManifestV1;
  summary?: SessionSummary;
  verification?: LocalVerificationResult;
  level: ReadingLevel;
  refreshing: boolean;
  onShowTimeline: () => void;
  share?: React.ReactNode;
  banner?: React.ReactNode;
}) {
  return <section className="workspace-main summary-stage" id="main-content">
    <header className="execution-header">
      <div>
        <div className="header-kicker"><span>What your agent did</span>{refreshing && <><i />Live</>}</div>
        <h1>{sessionTitle(session)}</h1>
        <p>{sessionDuration(session)}</p>
      </div>
      <div className="execution-header-actions">
        <StatusBadge status={verification?.valid ? "verified" : verification ? "failed" : "checking"} label={verification?.valid ? "Verified" : verification ? "Verification failed" : "Checking"} />
        {share}
      </div>
    </header>
    {banner}
    <AssuranceStrip verification={verification} level={level} />
    <div className="summary-scroll">
      {!summary ? <div className="summary-placeholder">{[1, 2, 3].map((item) => <div className="skeleton summary-skeleton" key={item} />)}</div> : <>
        <h2 className="summary-headline">{summary.headline}</h2>
        <div className="summary-sentences">{summary.sentences.map((sentence) => <p key={sentence}>{sentence}</p>)}</div>
        <div className="summary-metrics">
          <div><small>Requests</small><strong>{summary.counts.prompts}</strong></div>
          <div><small>Tool calls</small><strong>{summary.counts.toolCalls}</strong></div>
          <div><small>File changes</small><strong>{summary.distinctFileCount ?? summary.counts.fileChanges}</strong></div>
          <div><small>Records sealed</small><strong>{summary.counts.totalEvents}</strong></div>
        </div>
        <div className="summary-tier">
          <span className={`tier-chip tier-${summary.tier}`}>{TIER_LABELS[summary.tier]}</span>
          <p>{summary.tierReasons.join(" ")}</p>
        </div>
        {summary.caveats.length > 0 && <div className="capture-warning">
          <Warning weight="fill" aria-hidden />
          <div><strong>Worth a look</strong>{summary.caveats.map((caveat) => <p key={caveat}>{caveat}</p>)}</div>
        </div>}
        <div className="summary-actions">
          <button className="button button-primary" onClick={onShowTimeline}>Show every action<ArrowRight aria-hidden /></button>
        </div>
      </>}
    </div>
  </section>;
}

function EvidenceRow({ label, value, mono = false }: { label: string; value?: string | number | null; mono?: boolean }) {
  const rendered = value === undefined || value === null || value === "" ? "Unavailable" : String(value);
  return <div className="evidence-row"><dt>{label}</dt><dd className={mono ? "mono" : ""} title={rendered}>{rendered}</dd></div>;
}

/**
 * The only path by which a raw evidence field reaches the DOM. Fields below the reader's
 * level are dropped here, so a plain-language reader never sees a hash.
 */
function EvidenceRows({ level, rows }: { level: ReadingLevel; rows: Array<{ id: EvidenceFieldId; value?: string | number | null }> }) {
  const visible = rows.filter((row) => showsField(row.id, level));
  if (visible.length === 0) return null;
  return <dl>
    {visible.map((row) => <EvidenceRow key={row.id} label={fieldLabel(row.id, level)} value={row.value} mono={EVIDENCE_FIELDS[row.id].mono} />)}
  </dl>;
}

export function compactEmbeddedValues(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:") && value.includes(",")) {
      const [header, encoded] = value.split(",", 2);
      const mediaType = header.slice(5).split(";")[0] || "binary data";
      const approximateBytes = Math.floor((encoded?.length ?? 0) * 0.75);
      return `[embedded ${mediaType} · approximately ${Math.max(1, Math.round(approximateBytes / 1024))} KB · available in raw payload]`;
    }
    if (value.length > 12_000) {
      return `[large text result · ${value.length.toLocaleString()} characters · available in raw payload]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(compactEmbeddedValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, compactEmbeddedValues(nested)]));
  }
  return value;
}

function RawEventPayload({ details }: { details: LocalDecryptedEventDetail[] }) {
  const [open, setOpen] = useState(false);
  return <details className="raw-event" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Raw decrypted event payload <CaretRight aria-hidden /></summary>
    {open && <pre>{JSON.stringify(details.map((detail) => detail.rawContent), null, 2)}</pre>}
  </details>;
}

export function ReceiptInspector({
  event,
  presentation,
  relatedEventIds,
  details,
  revealing,
  revealError,
  session,
  verification,
  open,
  level,
  canReveal = true,
  onReveal,
  onClose,
}: {
  event?: LocalEventRecordV1;
  presentation?: LocalEventPresentation;
  relatedEventIds: string[];
  details: LocalDecryptedEventDetail[];
  revealing: boolean;
  revealError?: string;
  session: LocalExecutionManifestV1;
  verification?: LocalVerificationResult;
  open: boolean;
  level: ReadingLevel;
  /** False for someone else's bundle: sealed records there can never be opened on this device. */
  canReveal?: boolean;
  onReveal: () => void;
  onClose: () => void;
}) {
  const prompt = details.find((detail) => detail.prompt !== undefined)?.prompt;
  const toolDetails = details.filter((detail) => detail.tool).map((detail) => detail.tool!);
  const toolName = toolDetails.find((tool) => tool.name)?.name ?? presentation?.tool;
  const toolInput = toolDetails.find((tool) => tool.input !== undefined)?.input;
  const toolOutput = [...toolDetails].reverse().find((tool) => tool.output !== undefined)?.output;
  const toolError = [...toolDetails].reverse().find((tool) => tool.error !== undefined)?.error;
  const metadata = Object.assign({}, ...details.map((detail) => detail.metadata)) as Record<string, string | number | boolean | null>;
  const hasDetails = details.length > 0;
  const receiptLabels = disclosureLabel("receipt", level);
  const integrityLabels = disclosureLabel("integrity", level);
  const lineageLabels = disclosureLabel("lineage", level);
  const verificationLabels = disclosureLabel("verification", level);

  const readableValue = (value: unknown, compact = false) => {
    const display = compact ? compactEmbeddedValues(value) : value;
    return typeof display === "string" ? display : JSON.stringify(display, null, 2);
  };

  return <aside className={`receipt-inspector ${open ? "open" : ""}`} aria-label="Evidence inspector">
    <header className="inspector-header">
      <div><p className="eyebrow">Selected action</p><h2>Action details</h2></div>
      <button className="icon-button inspector-close" onClick={onClose} aria-label="Close evidence inspector"><X aria-hidden /></button>
    </header>
    {!event ? <div className="inspector-empty"><Receipt weight="duotone" aria-hidden /><h3>Select an event</h3><p>Choose an event from the timeline to inspect its recorded evidence.</p></div> : <div className="inspector-scroll">
      <div className="receipt-status">
        <span className="receipt-icon"><ShieldCheck weight="duotone" aria-hidden /></span>
        <div><strong>{presentation?.title ?? eventLabel(event)}</strong><small>{formatDateTime(event.observed_at)}</small></div>
        <StatusBadge status={verification?.valid ? "verified" : verification ? "failed" : "checking"} label={verification?.valid ? "Verified" : verification ? "Failed" : "Checking"} />
      </div>
      {presentation && <p className="receipt-description">{presentation.detail}</p>}
      <section className={`local-detail-card ${hasDetails ? "revealed" : ""}`}>
        <div className="local-detail-heading">
          <span>{hasDetails ? <LockKeyOpen weight="duotone" aria-hidden /> : <LockKey weight="duotone" aria-hidden />}</span>
          <div><strong>{hasDetails ? canReveal ? "Decrypted for this view" : "Shared in readable form" : "Encrypted action content"}</strong><small>{relatedEventIds.length} evidence record{relatedEventIds.length === 1 ? "" : "s"} · {canReveal ? "never uploaded" : "from the file you were given"}</small></div>
        </div>
        {!hasDetails ? canReveal ? <>
          <p>Reveal the exact prompt, tool call, and captured response from the encrypted file on this Mac.</p>
          <button className="button button-secondary local-reveal" disabled={revealing} onClick={onReveal}>
            {revealing ? <Spinner label="Decrypting local evidence" /> : <LockKeyOpen aria-hidden />}
            {revealing ? "Decrypting…" : "Show local details"}
          </button>
          {revealError && <p className="local-reveal-error" role="alert">{revealError}</p>}
        </> : <p>The sender kept this record sealed. Its integrity is still provable, but only the device that recorded it can open it.</p> : <div className="decrypted-details">
          {prompt !== undefined && <section className="decrypted-block prompt-block"><h3>Exact prompt submitted</h3><pre>{readableValue(prompt)}</pre></section>}
          {toolName && <div className="exact-tool-name"><span>Exact tool</span><code>{toolName}</code></div>}
          {toolInput !== undefined && <section className="decrypted-block"><h3>Tool input</h3><pre>{readableValue(toolInput)}</pre></section>}
          {toolOutput !== undefined && <section className="decrypted-block output-block"><h3>Captured result <span>large values summarized</span></h3><pre>{readableValue(toolOutput, true)}</pre></section>}
          {toolError !== undefined && <section className="decrypted-block error-block"><h3>Captured error</h3><pre>{readableValue(toolError)}</pre></section>}
          {Object.keys(metadata).length > 0 && <section className="decrypted-metadata">
            <h3>Provider metadata</h3>
            <dl>{Object.entries(metadata).map(([key, value]) => <EvidenceRow key={key} label={humanize(key)} value={value} mono={key.includes("id")} />)}</dl>
          </section>}
          {showsRawEvidence(level) && <RawEventPayload details={details} />}
        </div>}
      </section>

      <div className="receipt-disclosures">
        {receiptLabels && <details className="receipt-disclosure">
          <summary><span>{receiptLabels.title}<small>{receiptLabels.hint}</small></span><CaretRight aria-hidden /></summary>
          <EvidenceRows level={level} rows={[
            { id: "event_id", value: event.commit.event_id ?? event.commit.memory_id },
            { id: "event_type", value: humanize(event.commit.event_type) },
            { id: "observed", value: formatDateTime(event.observed_at) },
            { id: "capture_source", value: humanize(event.source) },
            { id: "agent_id", value: event.commit.agent_id },
            { id: "schema", value: `v${event.commit.schema_version}` },
          ]} />
        </details>}
        {integrityLabels && <details className="receipt-disclosure">
          <summary><span>{integrityLabels.title}<small>{integrityLabels.hint}</small></span><CaretRight aria-hidden /></summary>
          <EvidenceRows level={level} rows={[
            { id: "payload_hash", value: event.commit.payload_hash },
            { id: "cid_ciphertext", value: event.commit.cid_ciphertext },
            { id: "signer", value: event.commit.signer },
            { id: "signature", value: event.commit.signature ? shortHash(event.commit.signature, 16) : null },
          ]} />
        </details>}
        {lineageLabels && <details className="receipt-disclosure">
          <summary><span>{lineageLabels.title}<small>{lineageLabels.hint}</small></span><CaretRight aria-hidden /></summary>
          <EvidenceRows level={level} rows={[
            { id: "parent_events", value: event.commit.parent_event_ids?.length ?? 0 },
            { id: "mission_id", value: event.commit.mission_id },
            { id: "session_root", value: session.root_event_id },
          ]} />
          {showsRawEvidence(level) && event.commit.parent_event_ids?.map((parent) => <code className="parent-id" key={parent}>{parent}</code>)}
        </details>}
        {verification && verificationLabels && <details className="receipt-disclosure">
          <summary><span>{verificationLabels.title}<small>{verification.checks.length} checks for this session</small></span><CaretRight aria-hidden /></summary>
          <div className="verification-checks">
            {verification.checks.map((check) => <div className={`verification-row verification-${check.status}`} key={`${check.name}-${check.detail}`}>
              {check.status === "passed" ? <CheckCircle weight="fill" aria-hidden /> : check.status === "warning" ? <Warning weight="fill" aria-hidden /> : <XCircle weight="fill" aria-hidden />}
              <span><strong>{humanize(check.name)}</strong><small>{check.detail}</small></span>
            </div>)}
          </div>
        </details>}
      </div>
      <p className="evidence-disclaimer"><HardDrives aria-hidden />Content is decrypted only in this app after you request it. The evidence stored on disk remains encrypted and its hashes remain independently verifiable.</p>
    </div>}
  </aside>;
}
