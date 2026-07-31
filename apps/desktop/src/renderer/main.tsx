import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { LocalEventRecordV1, LocalExecutionManifestV1 } from "@smritheon/memora-protocol";
import type { IntegrationDiagnosticResult, IntegrationHealth, LocalVerificationResult, SessionSummary } from "@smritheon/memora-local";
import { ArrowLeft, ArrowRight, CheckCircle, EyeSlash, HardDrives, PlugsConnected, ShieldCheck, Sparkle, Warning } from "@phosphor-icons/react";
import {
  AgentChoice,
  Brand,
  DiagnosticReport,
  DisclosureConfirm,
  ExecutionTimeline,
  IntegrationSetupGuide,
  ProviderLogo,
  ReceiptInspector,
  SessionRail,
  SessionSummaryCard,
  ShareEvidence,
  Spinner,
  StatusBadge,
  type IntegrationId,
} from "./components";
import { VerifyReceiptView } from "./VerifyReceiptView";
import { levelAtLeast, READING_LEVELS, READING_LEVEL_META, showsTimelineByDefault, type ReadingLevel } from "./labels";
import "./styles.css";

type DiagnosticProvider = "codex" | "claude";
type OnboardingStep = "welcome" | "integrations" | "setup";
type Workspace = "sessions" | "verify";

function App() {
  const bridge = window.memoraLocal;
  const [sessions, setSessions] = useState<LocalExecutionManifestV1[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [events, setEvents] = useState<LocalEventRecordV1[]>([]);
  const [presentations, setPresentations] = useState<Record<string, LocalEventPresentation>>({});
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [decryptedDetails, setDecryptedDetails] = useState<LocalDecryptedEventDetail[]>([]);
  const [revealingDetails, setRevealingDetails] = useState(false);
  const [revealError, setRevealError] = useState("");
  const [verification, setVerification] = useState<LocalVerificationResult>();
  const [installMessage, setInstallMessage] = useState("");
  const [installing, setInstalling] = useState(false);
  const [onboarding, setOnboarding] = useState<boolean | undefined>();
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>("welcome");
  const [selectedAgents, setSelectedAgents] = useState<IntegrationId[]>([]);
  const [connectionMessage, setConnectionMessage] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Partial<Record<DiagnosticProvider, IntegrationDiagnosticResult>>>({});
  const [diagnosing, setDiagnosing] = useState<DiagnosticProvider>();
  const [openDiagnostic, setOpenDiagnostic] = useState<DiagnosticProvider>();
  const [refreshing, setRefreshing] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [dataError, setDataError] = useState("");
  const [readingLevel, setReadingLevel] = useState<ReadingLevel>("everyone");
  const [summary, setSummary] = useState<SessionSummary>();
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>("sessions");
  const [sharing, setSharing] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const [confirmingDisclosure, setConfirmingDisclosure] = useState(false);
  // Remembered per session so a receipt saved after an export can name the exact file it describes.
  const [lastExports, setLastExports] = useState<Record<string, LocalReceiptBundleRef>>({});
  const [bundleResult, setBundleResult] = useState<LocalBundleVerificationReply>();
  const [verifyingBundle, setVerifyingBundle] = useState(false);
  const [bundleError, setBundleError] = useState("");
  const [signerBusy, setSignerBusy] = useState(false);

  useEffect(() => {
    if (!bridge) {
      setOnboarding(false);
      return;
    }
    void bridge.getIntegrations()
      .then((settings) => {
        setSelectedAgents(settings.configured_integrations ?? settings.connected_integrations ?? settings.automatic_terminal_agents);
        setDiagnostics(settings.last_diagnostics ?? {});
        setReadingLevel(settings.reading_level ?? "everyone");
        setOnboarding(!settings.onboarding_complete);
      })
      .catch((error) => {
        setDataError(error instanceof Error ? error.message : String(error));
        setOnboarding(false);
      });
  }, [bridge]);

  // Optimistic: a failed preference write must never surface as an evidence error.
  const changeReadingLevel = useCallback((level: ReadingLevel) => {
    const previous = readingLevel;
    if (previous === level) return;
    setReadingLevel(level);
    void bridge?.setReadingLevel(level).catch(() => setReadingLevel(previous));
  }, [bridge, readingLevel]);

  const toggleAgent = (id: IntegrationId) => {
    setSelectedAgents((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const connectAgents = async () => {
    if (!bridge) return;
    setConnecting(true);
    setConnectionMessage("");
    try {
      const result = await bridge.configureIntegrations(selectedAgents);
      setDiagnostics(result.diagnostics);
      const terminalSelected = selectedAgents.filter((id): id is DiagnosticProvider => id === "codex" || id === "claude");
      const missing = terminalSelected.filter((id) => !result.shell.detected[id]);
      const editorNote = result.editors.installed.length
        ? ` Restart ${result.editors.installed.map((id) => id === "vscode" ? "VS Code" : "Cursor").join(" and ")} to activate workspace evidence.`
        : "";
      const attention = Object.values(result.diagnostics).some((diagnostic) =>
        diagnostic && ["not_installed", "needs_attention"].includes(diagnostic.status),
      );
      if (attention) {
        setConnectionMessage(`Connections installed, but a diagnostic needs attention.${editorNote}`);
      } else if (missing.length) {
        setConnectionMessage(`Lifecycle hooks installed. Install ${missing.join(" and ")} before using terminal auto-capture.${editorNote}`);
      } else {
        setConnectionMessage(`Automatic capture is ready.${editorNote} Open a new terminal for command interception.`);
      }
      setOnboardingStep("setup");
    } catch (error) {
      setConnectionMessage(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setConnecting(false);
    }
  };

  const testConnection = async (provider: DiagnosticProvider) => {
    if (!bridge) return;
    setDiagnosing(provider);
    setOpenDiagnostic(provider);
    try {
      const result = await bridge.diagnoseIntegration(provider);
      setDiagnostics((current) => ({ ...current, [provider]: result }));
    } catch (error) {
      setConnectionMessage(`Diagnostic failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDiagnosing(undefined);
    }
  };

  const connectionHealth = useMemo<IntegrationHealth>(() => {
    if (!selectedAgents.length) return "not_installed";
    const selectedDiagnostics = selectedAgents
      .filter((provider): provider is DiagnosticProvider => provider === "codex" || provider === "claude")
      .map((provider) => diagnostics[provider]);
    if (selectedDiagnostics.some((diagnostic) => !diagnostic || diagnostic.status === "needs_attention" || diagnostic.status === "not_installed")) return "needs_attention";
    if (selectedDiagnostics.some((diagnostic) => diagnostic?.status === "capturing")) return "capturing";
    return "ready";
  }, [diagnostics, selectedAgents]);

  const installCli = async () => {
    setInstalling(true);
    setInstallMessage("");
    try {
      if (!bridge) throw new Error("The desktop bridge did not load. Fully quit and restart Memora Local.");
      const result = await bridge.installCli();
      setInstallMessage(`CLI installed at ${result.target}. Open a new terminal to use memora.`);
    } catch (error) {
      setInstallMessage(`Installation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setInstalling(false);
    }
  };

  const exportEvidence = async (disclose: boolean) => {
    if (!bridge || !selectedSessionId) return;
    setSharing(true);
    setShareMessage("");
    try {
      const result = await bridge.exportSession(selectedSessionId, disclose);
      if (result.canceled) return;
      setLastExports((current) => ({
        ...current,
        [selectedSessionId]: {
          disclosure: result.disclosure ?? "none",
          ...(result.fileName ? { fileName: result.fileName } : {}),
          ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
        },
      }));
      setShareMessage(disclose
        ? `Readable copy saved to ${result.path}. Anyone who opens it can read ${result.disclosedCount} records and verify every one.`
        : `Sealed evidence saved to ${result.path}. The recipient can verify it offline; its contents stay encrypted.`);
    } catch (error) {
      setShareMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSharing(false);
      setConfirmingDisclosure(false);
    }
  };

  const saveReceipt = async () => {
    if (!bridge || !selectedSessionId) return;
    setSharing(true);
    setShareMessage("");
    try {
      const result = await bridge.exportReceipt(selectedSessionId, lastExports[selectedSessionId]);
      if (!result.canceled) setShareMessage(`Receipt saved to ${result.path}.`);
    } catch (error) {
      setShareMessage(`Receipt failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSharing(false);
    }
  };

  const verifyBundleAt = useCallback(async (path: string) => {
    if (!bridge) return;
    setVerifyingBundle(true);
    setBundleError("");
    try {
      setBundleResult(await bridge.verifyBundle(path));
    } catch (error) {
      setBundleResult(undefined);
      setBundleError(error instanceof Error ? error.message : String(error));
    } finally {
      setVerifyingBundle(false);
    }
  }, [bridge]);

  const chooseBundle = async () => {
    if (!bridge) return;
    try {
      const choice = await bridge.chooseBundle();
      if (!choice.canceled && choice.path) await verifyBundleAt(choice.path);
    } catch (error) {
      setBundleError(error instanceof Error ? error.message : String(error));
    }
  };

  const updateSigner = async (action: () => Promise<unknown>) => {
    if (!bridge || !bundleResult) return;
    setSignerBusy(true);
    try {
      await action();
      // Re-verifying is how the signer's history refreshes — the file is on disk and read-only.
      await verifyBundleAt(bundleResult.path);
    } catch (error) {
      setBundleError(error instanceof Error ? error.message : String(error));
    } finally {
      setSignerBusy(false);
    }
  };

  const refresh = useCallback(async (quiet = true) => {
    if (!bridge) return;
    if (!quiet) setRefreshing(true);
    try {
      const next = await bridge.listSessions();
      setSessions(next);
      setSelectedSessionId((current) => current && next.some((session) => session.session_id === current)
        ? current
        : next[0]?.session_id);
      setDataError("");
    } catch (error) {
      setDataError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!quiet) setRefreshing(false);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh(false);
    const timer = window.setInterval(() => void refresh(true), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedSessionId || !bridge) {
      setEvents([]);
      setPresentations({});
      setSummary(undefined);
      setVerification(undefined);
      setSelectedEventIds([]);
      setDecryptedDetails([]);
      return;
    }
    let active = true;
    void Promise.all([
      bridge.getSession(selectedSessionId),
      bridge.verifySession(selectedSessionId),
    ]).then(([session, nextVerification]) => {
      if (!active) return;
      setEvents(session.events);
      setPresentations(session.presentations ?? {});
      setSummary(session.summary);
      setVerification(nextVerification);
      setSelectedEventId((current) => current && session.events.some((event) => (event.commit.event_id ?? event.commit.memory_id) === current)
        ? current
        : session.events[0] ? session.events[0].commit.event_id ?? session.events[0].commit.memory_id : undefined);
      setSelectedEventIds((current) => current.length && current.every((id) => session.events.some((event) => (event.commit.event_id ?? event.commit.memory_id) === id))
        ? current
        : session.events[0] ? [session.events[0].commit.event_id ?? session.events[0].commit.memory_id] : []);
    }).catch((error) => {
      if (active) setDataError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [bridge, selectedSessionId, sessions]);

  useEffect(() => { setSummaryExpanded(false); setShareMessage(""); }, [selectedSessionId, readingLevel]);

  const selectedSession = sessions.find((session) => session.session_id === selectedSessionId);
  const selectedEvent = events.find((event) => (event.commit.event_id ?? event.commit.memory_id) === selectedEventId);

  const selectTraceItem = (id: string, eventIds: string[]) => {
    setSelectedEventId(id);
    setSelectedEventIds(eventIds);
    setDecryptedDetails([]);
    setRevealError("");
  };

  const closeInspector = () => {
    setInspectorOpen(false);
    setDecryptedDetails([]);
    setRevealError("");
  };

  const revealSelectedDetails = async () => {
    if (!bridge || !selectedSessionId || selectedEventIds.length === 0) return;
    setRevealingDetails(true);
    setRevealError("");
    try {
      setDecryptedDetails(await bridge.revealEvents(selectedSessionId, selectedEventIds));
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : String(error));
    } finally {
      setRevealingDetails(false);
    }
  };

  if (onboarding === undefined) return <main className="boot">
    <Brand compact />
    <div className="boot-line"><Spinner label="Preparing local evidence" /><span>Preparing local evidence</span></div>
  </main>;

  if (!bridge) return <main className="bridge-error">
    <Brand />
    <div className="bridge-error-content">
      <Warning weight="duotone" aria-hidden />
      <p className="eyebrow">Desktop connection unavailable</p>
      <h1>Memora could not reach its local evidence bridge.</h1>
      <p>Fully quit and restart Memora Local. Your recorded evidence remains on this device.</p>
    </div>
  </main>;

  if (onboarding) {
    const activeDiagnostic = openDiagnostic ? diagnostics[openDiagnostic] : undefined;
    return <main className={`onboarding-flow onboarding-${onboardingStep}`}>
      <div className="titlebar-drag" />
      <header className="onboarding-nav">
        <Brand compact />
        <div className="onboarding-progress" aria-label={`Onboarding step ${onboardingStep === "welcome" ? 1 : onboardingStep === "integrations" ? 2 : 3} of 3`}>
          <i className={onboardingStep === "welcome" ? "active" : "complete"} />
          <i className={onboardingStep === "integrations" ? "active" : onboardingStep === "setup" ? "complete" : ""} />
          <i className={onboardingStep === "setup" ? "active" : ""} />
        </div>
        <span className="onboarding-local"><HardDrives aria-hidden />Stored locally</span>
      </header>

      {onboardingStep === "welcome" && <section className="welcome-stage">
        <div className="evidence-halo" aria-hidden>
          <span><ShieldCheck weight="duotone" /></span>
          <i className="halo-orbit orbit-one"><ProviderLogo provider="codex" size={18} /></i>
          <i className="halo-orbit orbit-two"><ProviderLogo provider="claude" size={18} /></i>
          <i className="halo-orbit orbit-three"><ProviderLogo provider="cursor" size={18} /></i>
        </div>
        <div className="welcome-copy">
          <p className="eyebrow"><Sparkle weight="fill" aria-hidden />Memora Local</p>
          <h1>Should your coding sessions leave verifiable evidence?</h1>
          <p>Memora can observe supported agent actions, show you what happened, and seal the underlying evidence on this Mac—automatically.</p>
        </div>
        <fieldset className="reading-level-choice">
          <legend>How do you want to read your evidence?</legend>
          {READING_LEVELS.map((id) => <button
            key={id}
            className={readingLevel === id ? "selected" : ""}
            aria-pressed={readingLevel === id}
            onClick={() => changeReadingLevel(id)}
          >
            <strong>{READING_LEVEL_META[id].label}</strong>
            <small>{READING_LEVEL_META[id].hint}</small>
          </button>)}
        </fieldset>
        <button className="button button-primary welcome-cta" onClick={() => setOnboardingStep("integrations")}>
          Set up local evidence<ArrowRight aria-hidden />
        </button>
        <button className="welcome-skip" onClick={() => setOnboarding(false)}>Not now</button>
        <div className="welcome-trust">
          <span><CheckCircle weight="fill" aria-hidden />No cloud account</span>
          <span><EyeSlash aria-hidden />No hidden reasoning</span>
          <span><HardDrives aria-hidden />Encrypted on device</span>
        </div>
      </section>}

      {onboardingStep === "integrations" && <section className="integration-stage">
        <button className="onboarding-back" onClick={() => setOnboardingStep("welcome")}><ArrowLeft aria-hidden />Back</button>
        <div className="stage-heading">
          <p className="eyebrow">Choose integrations</p>
          <h1>Where should Memora observe?</h1>
          <p>Select the tools you use. You can change this later without affecting existing evidence.</p>
        </div>
        <div className="agent-grid integration-grid">
          {(["codex", "claude", "cursor", "vscode"] as const).map((id) => <AgentChoice
            key={id}
            id={id}
            selected={selectedAgents.includes(id)}
            onToggle={() => toggleAgent(id)}
          />)}
        </div>
        <div className="stage-footer">
          <span>{selectedAgents.length ? `${selectedAgents.length} integration${selectedAgents.length === 1 ? "" : "s"} selected` : "Select at least one integration"}</span>
          <button className="button button-primary" disabled={connecting || !selectedAgents.length} onClick={() => void connectAgents()}>
            {connecting ? <Spinner label="Installing integrations" /> : <PlugsConnected weight="duotone" aria-hidden />}
            {connecting ? "Installing securely…" : "Continue"}
            {!connecting && <ArrowRight aria-hidden />}
          </button>
        </div>
        {connectionMessage && <p className={`setup-message stage-message ${connectionMessage.includes("failed") ? "message-error" : ""}`} role="status">{connectionMessage}</p>}
      </section>}

      {onboardingStep === "setup" && <section className="provider-setup-stage">
        <button className="onboarding-back" onClick={() => setOnboardingStep("integrations")}><ArrowLeft aria-hidden />Integrations</button>
        <div className="stage-heading setup-stage-heading">
          <p className="eyebrow">One-time setup</p>
          <h1>Finish connecting your tools.</h1>
          <p>Each provider protects its own automation boundary. Complete these steps once, then Memora observes supported activity automatically.</p>
        </div>
        <IntegrationSetupGuide
          selected={selectedAgents}
          diagnostics={diagnostics}
          diagnosing={diagnosing}
          onTest={(provider) => void testConnection(provider)}
          onOpenDiagnostic={setOpenDiagnostic}
        />
        <div className="setup-complete-bar">
          <div><strong>Ready to observe</strong><span>You can revisit connection health at any time.</span></div>
          <button className="button button-primary" onClick={() => setOnboarding(false)}>Open observation layer<ArrowRight aria-hidden /></button>
        </div>
      </section>}

      {activeDiagnostic && <div className="diagnostic-sheet-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.currentTarget === event.target) setOpenDiagnostic(undefined);
      }}>
        <DiagnosticReport
          diagnostic={activeDiagnostic}
          testing={diagnosing === activeDiagnostic.provider}
          onTest={() => void testConnection(activeDiagnostic.provider)}
          onClose={() => setOpenDiagnostic(undefined)}
        />
      </div>}
    </main>;
  }

  const showTimeline = showsTimelineByDefault(readingLevel) || summaryExpanded;
  const share = <ShareEvidence
    busy={sharing}
    onExportSealed={() => void exportEvidence(false)}
    onExportReadable={() => setConfirmingDisclosure(true)}
    onSaveReceipt={() => void saveReceipt()}
  />;
  const shareBanner = shareMessage
    ? <div className={`inline-message share-message ${shareMessage.includes("failed") ? "message-error" : "message-success"}`} role="status">{shareMessage}</div>
    : undefined;

  return <main className="app-shell">
    <a className="skip-link" href="#main-content">Skip to execution evidence</a>
    <SessionRail
      sessions={sessions}
      selected={workspace === "sessions" ? selectedSessionId : undefined}
      health={connectionHealth}
      installing={installing}
      installMessage={installMessage}
      level={readingLevel}
      verifying={workspace === "verify"}
      onSelect={(id) => { setWorkspace("sessions"); setSelectedSessionId(id); closeInspector(); }}
      onConnections={() => { setOnboardingStep("integrations"); setOnboarding(true); }}
      onInstall={() => void installCli()}
      onChangeLevel={changeReadingLevel}
      onVerifyReceipt={() => { setWorkspace("verify"); closeInspector(); }}
    />
    {dataError && <div className="global-error" role="alert"><Warning weight="fill" aria-hidden /><span><strong>Local evidence unavailable</strong>{dataError}</span></div>}
    {workspace === "verify" ? <VerifyReceiptView
      result={bundleResult}
      busy={verifyingBundle}
      error={bundleError}
      level={readingLevel}
      signerBusy={signerBusy}
      onChoose={() => void chooseBundle()}
      onVerifyPath={(path) => void verifyBundleAt(path)}
      onNameSigner={(address, label) => void updateSigner(() => bridge.labelSigner(address, label))}
      onForgetSigner={(address) => void updateSigner(() => bridge.forgetSigner(address))}
      onClear={() => { setBundleResult(undefined); setBundleError(""); }}
    /> : !selectedSession ? <section className="workspace-empty" id="main-content">
      <span className="empty-orbit"><PlugsConnected weight="duotone" aria-hidden /></span>
      <p className="eyebrow">Ready for evidence</p>
      <h1>Your next agent action appears here.</h1>
      <p>Open a connected coding agent and work normally. Memora will capture supported lifecycle events automatically.</p>
      <div className="empty-status"><StatusBadge status={connectionHealth} /><span>{selectedAgents.length ? `${selectedAgents.length} integrations configured` : "No integrations configured"}</span></div>
      <button className="button button-secondary" onClick={() => { setOnboardingStep("integrations"); setOnboarding(true); }}><PlugsConnected aria-hidden />Manage agent connections</button>
      {levelAtLeast(readingLevel, "power") && <div className="cli-alternative"><span>CLI alternative</span><code>memora local run -- codex</code></div>}
    </section> : <>
      {showTimeline ? <ExecutionTimeline
        session={selectedSession}
        events={events}
        verification={verification}
        selectedEventId={selectedEventId}
        refreshing={refreshing || !selectedSession.completed_at}
        level={readingLevel}
        onSelectItem={selectTraceItem}
        onOpenInspector={() => setInspectorOpen(true)}
        onBackToSummary={showsTimelineByDefault(readingLevel) ? undefined : () => setSummaryExpanded(false)}
        presentations={presentations}
        share={share}
        banner={shareBanner}
      /> : <SessionSummaryCard
        session={selectedSession}
        summary={summary}
        verification={verification}
        level={readingLevel}
        refreshing={refreshing || !selectedSession.completed_at}
        onShowTimeline={() => setSummaryExpanded(true)}
        share={share}
        banner={shareBanner}
      />}
      <ReceiptInspector
        event={selectedEvent}
        presentation={selectedEventId ? presentations[selectedEventId] : undefined}
        relatedEventIds={selectedEventIds}
        details={decryptedDetails}
        revealing={revealingDetails}
        revealError={revealError}
        session={selectedSession}
        verification={verification}
        open={inspectorOpen}
        level={readingLevel}
        onReveal={() => void revealSelectedDetails()}
        onClose={closeInspector}
      />
      {inspectorOpen && <button className="inspector-backdrop" aria-label="Close evidence inspector" onClick={closeInspector} />}
    </>}
    {confirmingDisclosure && <DisclosureConfirm
      summary={summary}
      busy={sharing}
      onConfirm={() => void exportEvidence(true)}
      onCancel={() => setConfirmingDisclosure(false)}
    />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
