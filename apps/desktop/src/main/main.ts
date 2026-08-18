import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { access, appendFile, chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt, type MemoryPayload } from "@memora-hq/memora-protocol";
import {
  adapters,
  deriveLocalEncryptionKey,
  exportLocalBundle,
  FileKeyProvider,
  hookConfigPathFor,
  KnownSignerStore,
  LocalEvidenceStore,
  readLocalBundle,
  renderReceiptDocument,
  runIntegrationDiagnostic,
  summarizeSession,
  verifyLocalBundle,
  verifyLocalSession,
  type DiagnosticProvider,
  type IntegrationDiagnosticResult,
  type KnownSigner,
} from "@memora-hq/memora-local";
import {
  buildBundleView,
  type BundleVerificationReply,
  type ExportBundleReply,
  type LocalSessionView,
  type ReceiptBundleRef,
  type SignerTrust,
} from "./bundleView.js";
import { revealLocalEvent, type LocalDecryptedEventDetail } from "./eventDetail.js";
import { collectSessionFacts, presentLocalEvent, type LocalEventPresentation } from "./eventPresentation.js";
import {
  defaultIntegrationSettings,
  isReadingLevel,
  mergeIntegrationSettings,
  normalizeIntegrationSettings,
  type IntegrationId,
  type IntegrationSettings,
} from "./integrationSettings.js";
import { renderShellIntegration, renderZshSourceLine, type TerminalAgentId } from "./shellIntegration.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env.MEMORA_LOCAL_DATA_DIR || join(homedir(), "Library", "Application Support", "Memora");
const store = new LocalEvidenceStore(dataRoot);
const keys = new FileKeyProvider(join(dataRoot, "identity", "local-key.json"));
const knownSigners = KnownSignerStore.forDataRoot(dataRoot);
const integrationsPath = join(dataRoot, "integrations.json");
const shellIntegrationPath = join(homedir(), ".config", "memora", "shell.zsh");
const activeDataRootPath = join(homedir(), ".config", "memora", "data-root");
const zshrcPath = join(homedir(), ".zshrc");
const cliLauncherTarget = join(homedir(), ".local", "bin", "memora");

const terminalAdapters = adapters.filter((adapter) => adapter.kind === "terminal");
const editorAdapters = adapters.filter((adapter) => adapter.kind === "editor");
const adapterIds = new Set(adapters.map((adapter) => adapter.id));
const terminalAdapterIds = new Set(terminalAdapters.map((adapter) => adapter.id));

const terminalAgents: Record<TerminalAgentId, { command: string; label: string }> = Object.fromEntries(
  terminalAdapters.map((adapter) => [adapter.id, { command: adapter.id, label: adapter.displayName }]),
);

// The CLI script desktop bundles and shells out to — for hook install/uninstall (below) and
// for the `~/.local/bin/memora` launcher it writes for terminal convenience.
function resolveCliScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "cli", "cli.js")
    : join(app.getAppPath(), "..", "..", "packages", "cli", "dist", "cli.js");
}

async function installCliLauncher(): Promise<{ target: string; pathHint: string }> {
  const target = cliLauncherTarget;
  const cli = resolveCliScriptPath();

  await access(cli, constants.R_OK);
  await mkdir(dirname(target), { recursive: true });

  const launcher = app.isPackaged
    ? `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`
    : `#!/bin/sh\nexec /usr/bin/env node ${JSON.stringify(cli)} "$@"\n`;

  await writeFile(target, launcher, { mode: 0o755 });
  await chmod(target, 0o755);
  await access(target, constants.R_OK | constants.X_OK);

  return { target, pathHint: join(homedir(), ".local", "bin") };
}

// Only one process should ever write hook config — desktop shells out to the CLI's own
// install-hooks/uninstall-hooks rather than merging hook config itself, so there's a single
// implementation (and a single embedded CLI path) regardless of which surface triggered it.
function runCli(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolveCliScriptPath(), ...args], {
      env: { ...process.env, MEMORA_LOCAL_DATA_DIR: dataRoot, ELECTRON_RUN_AS_NODE: "1" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `memora ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function installLifecycleHooks(
  selected: TerminalAgentId[],
  previouslyInstalled: TerminalAgentId[],
): Promise<{ codex_review_required: boolean; installed: TerminalAgentId[]; uninstalled: TerminalAgentId[] }> {
  const installed: TerminalAgentId[] = [];
  const uninstalled: TerminalAgentId[] = [];
  for (const adapter of terminalAdapters) {
    const id = adapter.id as TerminalAgentId;
    if (selected.includes(id)) {
      await runCli(["local", "install-hooks", "--provider", id]);
      installed.push(id);
    } else if (previouslyInstalled.includes(id)) {
      // Only uninstall adapters we previously installed — calling uninstall-hooks for a
      // provider that was never configured would needlessly create its hook config file.
      await runCli(["local", "uninstall-hooks", "--provider", id]);
      uninstalled.push(id);
    }
  }
  return { codex_review_required: selected.includes("codex"), installed, uninstalled };
}

async function installEditorAdapters(selected: IntegrationId[]): Promise<{ installed: string[] }> {
  const source = app.isPackaged
    ? join(process.resourcesPath, "vscode-extension")
    : join(app.getAppPath(), "..", "vscode-extension");
  await access(join(source, "extension.cjs"), constants.R_OK);
  const installed: string[] = [];
  const extensionDirectory = "smritheon.memora-local-0.1.0";
  for (const adapter of editorAdapters) {
    if (!selected.includes(adapter.id)) continue;
    await cp(source, join(homedir(), `.${adapter.id}`, "extensions", extensionDirectory), { recursive: true, force: true });
    installed.push(adapter.id);
  }
  return { installed };
}

async function readIntegrationSettings(): Promise<IntegrationSettings> {
  try {
    return normalizeIntegrationSettings(JSON.parse(await readFile(integrationsPath, "utf8")));
  } catch {
    // First run or an invalid developer-preview settings file.
    return defaultIntegrationSettings();
  }
}

/**
 * The single settings writer. Every caller patches only the fields it owns, so a write can
 * never silently drop another feature's setting.
 */
async function writeIntegrationSettings(patch: Partial<IntegrationSettings>): Promise<IntegrationSettings> {
  const settings = mergeIntegrationSettings(await readIntegrationSettings(), patch);
  await mkdir(dirname(integrationsPath), { recursive: true });
  await writeFile(integrationsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settings;
}

async function resolveShellCommand(command: string): Promise<string | null> {
  const pathEntries = (process.env.PATH ?? "").split(":");
  for (const directory of pathEntries) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

async function diagnoseIntegration(provider: DiagnosticProvider): Promise<IntegrationDiagnosticResult> {
  const terminal = await resolveShellCommand(provider);
  const runtimeCandidates = [
    terminal,
    provider === "codex" ? "/Applications/ChatGPT.app/Contents/Resources/codex" : null,
    provider === "codex" ? "/Applications/Codex.app/Contents/Resources/codex" : null,
  ].filter((value): value is string => Boolean(value));
  const result = await runIntegrationDiagnostic({
    provider,
    dataRoot,
    cliPath: cliLauncherTarget,
    hookConfigPath: hookConfigPathFor(provider),
    shellWrapperPath: shellIntegrationPath,
    runtimeCandidates,
    cwd: app.getAppPath(),
  });
  const settings = await readIntegrationSettings();
  await writeIntegrationSettings({ last_diagnostics: { ...(settings.last_diagnostics ?? {}), [provider]: result } });
  return result;
}

async function writeShellIntegration(selected: TerminalAgentId[]): Promise<{ restart_required: boolean; detected: Record<TerminalAgentId, boolean> }> {
  const detected: Record<TerminalAgentId, boolean> = { codex: false, claude: false };
  const executables: Partial<Record<TerminalAgentId, string>> = {};

  for (const id of selected) {
    const agent = terminalAgents[id];
    const executable = await resolveShellCommand(agent.command);
    detected[id] = executable !== null;
    if (!executable) continue;
    executables[id] = executable;
  }

  await mkdir(dirname(shellIntegrationPath), { recursive: true });
  await writeFile(
    shellIntegrationPath,
    renderShellIntegration(selected, executables, process.env.MEMORA_LOCAL_DATA_DIR ? dataRoot : undefined),
    { mode: 0o600 },
  );

  let zshrc = "";
  try { zshrc = await readFile(zshrcPath, "utf8"); } catch { /* create it below */ }
  const sourceLine = renderZshSourceLine(shellIntegrationPath);
  if (!zshrc.includes(sourceLine)) {
    await appendFile(zshrcPath, `${zshrc.endsWith("\n") || !zshrc ? "" : "\n"}\n# Memora Local automatic agent capture\n${sourceLine}\n`);
  }
  return { restart_required: true, detected };
}

async function configureIntegrations(selected: IntegrationId[]) {
  const normalized = [...new Set(selected)].filter((id): id is IntegrationId => adapterIds.has(id));
  const terminal = normalized.filter((id): id is TerminalAgentId => id in terminalAgents);
  const previouslyInstalled = (await readIntegrationSettings()).automatic_terminal_agents;
  await installCliLauncher();
  await mkdir(dirname(activeDataRootPath), { recursive: true, mode: 0o700 });
  await writeFile(activeDataRootPath, `${dataRoot}\n`, { mode: 0o600 });
  const shell = await writeShellIntegration(terminal);
  const lifecycle = await installLifecycleHooks(terminal, previouslyInstalled);
  const editors = await installEditorAdapters(normalized);
  await writeIntegrationSettings({
    onboarding_complete: true,
    automatic_terminal_agents: terminal,
    configured_integrations: normalized,
    connected_integrations: normalized,
  });
  const diagnosticEntries: Array<readonly [DiagnosticProvider, IntegrationDiagnosticResult]> = [];
  for (const provider of terminal) {
    diagnosticEntries.push([provider, await diagnoseIntegration(provider)] as const);
  }
  const diagnostics = Object.fromEntries(diagnosticEntries);
  return { settings: await readIntegrationSettings(), shell, lifecycle, editors, diagnostics };
}

type LocalIdentity = NonNullable<Awaited<ReturnType<FileKeyProvider["load"]>>>;

async function decryptEventPayload(
  sessionId: string,
  event: Awaited<ReturnType<LocalEvidenceStore["readEvents"]>>[number],
  loadedIdentity?: LocalIdentity,
): Promise<MemoryPayload> {
  const identity = loadedIdentity ?? await keys.load();
  if (!identity) throw new Error("The local evidence key is unavailable on this device.");
  const objectId = event.commit.cid_ciphertext.replace("local:sha256:", "");
  const encrypted = await store.readPayload(sessionId, objectId);
  return JSON.parse(decrypt(encrypted, deriveLocalEncryptionKey(identity))) as MemoryPayload;
}

function assertSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9._-]+$/.test(sessionId)) throw new Error("Invalid local session ID.");
}

async function readSessionView(sessionId: string): Promise<LocalSessionView> {
  const manifest = await store.readManifest(sessionId);
  const events = await store.readEvents(sessionId);
  const identity = await keys.load();
  const presentations: Record<string, LocalEventPresentation> = {};
  for (const event of events) {
    const id = event.commit.event_id ?? event.commit.memory_id;
    let payload: MemoryPayload | undefined;
    if (identity) {
      try {
        payload = await decryptEventPayload(sessionId, event, identity);
      } catch {
        // The cryptographic verifier reports unreadable evidence separately.
      }
    }
    presentations[id] = presentLocalEvent(event, payload);
  }
  return { manifest, events, presentations, summary: summarizeSession(manifest, events, collectSessionFacts(presentations)) };
}

/**
 * A signing key's local history. Continuity only: it says this is the same key as before, never
 * who holds it. The renderer is responsible for saying that out loud.
 */
async function describeSigner(address: string): Promise<SignerTrust> {
  const identity = await keys.load();
  const known = await knownSigners.get(address);
  return {
    address,
    isThisDevice: Boolean(identity) && identity!.address.toLowerCase() === address.toLowerCase(),
    known: Boolean(known),
    ...(known?.label ? { label: known.label } : {}),
    ...(known ? { receiptsVerified: known.receipts_verified, firstSeen: known.first_seen } : {}),
  };
}

/**
 * Prints a receipt to PDF in a throwaway window with scripting switched off. The document is our
 * own HTML, but the strings inside it came from agent output, so it is treated as untrusted.
 */
async function renderPdfDocument(html: string, outputPath: string): Promise<void> {
  const temp = join(app.getPath("temp"), `memora-receipt-${randomUUID()}.html`);
  await writeFile(temp, html, { mode: 0o600 });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await window.loadFile(temp);
    const pdf = await window.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: { marginType: "none" },
    });
    await writeFile(outputPath, pdf, { mode: 0o600 });
  } finally {
    window.destroy();
    await rm(temp, { force: true });
  }
}

function registerIpc(): void {
  ipcMain.handle("local:list", () => store.listSessions());
  ipcMain.handle("local:session", (_event, sessionId: unknown) => {
    assertSessionId(sessionId);
    return readSessionView(sessionId);
  });
  ipcMain.handle("local:reveal", async (_event, sessionId: string, eventIds: string[]): Promise<LocalDecryptedEventDetail[]> => {
    assertSessionId(sessionId);
    if (!Array.isArray(eventIds) || eventIds.length === 0 || eventIds.length > 8 || eventIds.some((id) => typeof id !== "string")) {
      throw new Error("Select between one and eight local evidence records.");
    }
    const events = await store.readEvents(sessionId);
    const identity = await keys.load();
    if (!identity) throw new Error("The local evidence key is unavailable on this device.");
    const byId = new Map(events.map((event) => [event.commit.event_id ?? event.commit.memory_id, event]));
    const details: LocalDecryptedEventDetail[] = [];
    for (const eventId of [...new Set(eventIds)]) {
      const event = byId.get(eventId);
      if (!event) throw new Error("The selected evidence record no longer exists.");
      const payload = await decryptEventPayload(sessionId, event, identity);
      const presentation = presentLocalEvent(event, payload);
      details.push(revealLocalEvent(event, payload, presentation));
    }
    return details;
  });
  ipcMain.handle("local:verify", async (_event, sessionId: string) => verifyLocalSession(store, sessionId, await keys.load() ?? undefined));

  ipcMain.handle("local:export", async (_event, request: { sessionId: unknown; disclose?: boolean }): Promise<ExportBundleReply> => {
    assertSessionId(request?.sessionId);
    const disclose = request.disclose === true;
    const manifest = await store.readManifest(request.sessionId);
    const suggested = `memora-${manifest.session_id.slice(-8)}-${manifest.started_at.slice(0, 10)}${disclose ? "-readable" : ""}.memora`;
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: disclose ? "Export a readable copy" : "Export sealed evidence",
      defaultPath: join(app.getPath("downloads"), suggested),
      filters: [{ name: "Memora evidence", extensions: ["memora"] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const identity = disclose ? await keys.load() : null;
    if (disclose && !identity) throw new Error("The local evidence key is unavailable on this device.");
    const result = await exportLocalBundle(store, request.sessionId, filePath, disclose ? { disclose: "all", identity: identity! } : {});
    return { canceled: false, ...result, fileName: basename(result.path) };
  });

  ipcMain.handle("local:chooseBundle", async (): Promise<{ canceled: boolean; path?: string }> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Verify a Memora receipt",
      properties: ["openFile"],
      filters: [{ name: "Memora evidence", extensions: ["memora", "json"] }],
    });
    return canceled || !filePaths[0] ? { canceled: true } : { canceled: false, path: filePaths[0] };
  });

  // Read-only by design: a file from someone else is verified and displayed, never written into
  // this device's evidence store. `readLocalBundle` caps the size before parsing.
  ipcMain.handle("local:verifyBundle", async (_event, path: unknown): Promise<BundleVerificationReply> => {
    if (typeof path !== "string" || !path.trim()) throw new Error("Choose a .memora evidence file to verify.");
    const bundle = await readLocalBundle(path);
    const verification = verifyLocalBundle(bundle);
    if (verification.valid) await knownSigners.record(verification.signer);
    return {
      path,
      fileName: basename(path),
      verification,
      signer: await describeSigner(verification.signer),
      ...buildBundleView(bundle, verification.disclosure),
    };
  });

  ipcMain.handle("local:exportReceipt", async (_event, request: { sessionId: unknown; bundle?: ReceiptBundleRef }): Promise<{ canceled: boolean; path?: string }> => {
    assertSessionId(request?.sessionId);
    const view = await readSessionView(request.sessionId);
    const verification = await verifyLocalSession(store, request.sessionId, await keys.load() ?? undefined);
    const suggested = `memora-receipt-${view.manifest.session_id.slice(-8)}-${view.manifest.started_at.slice(0, 10)}.pdf`;
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Save PDF receipt",
      defaultPath: join(app.getPath("downloads"), suggested),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const html = renderReceiptDocument({
      manifest: view.manifest,
      summary: view.summary,
      verification,
      signer: await describeSigner(view.manifest.signer),
      disclosure: request.bundle?.disclosure ?? "none",
      ...(request.bundle?.fileName ? { bundleFileName: request.bundle.fileName } : {}),
      ...(request.bundle?.fingerprint ? { bundleFingerprint: request.bundle.fingerprint } : {}),
      generatedAt: new Date().toISOString(),
    });
    await renderPdfDocument(html, filePath);
    return { canceled: false, path: filePath };
  });

  ipcMain.handle("signers:list", (): Promise<KnownSigner[]> => knownSigners.list());
  ipcMain.handle("signers:label", (_event, address: unknown, label: unknown) => {
    if (typeof address !== "string" || typeof label !== "string") throw new Error("Enter a name for this device.");
    return knownSigners.label(address, label);
  });
  ipcMain.handle("signers:forget", (_event, address: unknown) => {
    if (typeof address !== "string") throw new Error("Unknown device.");
    return knownSigners.forget(address);
  });

  ipcMain.handle("cli:install", installCliLauncher);
  ipcMain.handle("integrations:get", readIntegrationSettings);
  ipcMain.handle("integrations:configure", (_event, selected: IntegrationId[]) => configureIntegrations(selected));
  ipcMain.handle("integrations:diagnose", (_event, provider: DiagnosticProvider) => {
    if (!terminalAdapterIds.has(provider)) throw new Error("Unsupported diagnostic provider");
    return diagnoseIntegration(provider);
  });
  ipcMain.handle("integrations:set-reading-level", (_event, level: unknown) => {
    if (!isReadingLevel(level)) throw new Error("Unsupported reading level");
    return writeIntegrationSettings({ reading_level: level });
  });
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0a0a0d",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (!app.isPackaged && process.env.MEMORA_DESKTOP_DEV_URL) await window.loadURL(process.env.MEMORA_DESKTOP_DEV_URL);
  else await window.loadFile(join(here, "..", "dist-renderer", "index.html"));
}

// No startLocalHookSpool() here: the daemon owns draining hook events into the local
// evidence store (autostarted on first hook fire), independent of whether desktop is
// running. Desktop draining too would race it across processes.
app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
