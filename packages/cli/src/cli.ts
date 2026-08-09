#!/usr/bin/env node
/**
 * Memora CLI: write, query, read, verify, replay.
 * Env: MEMORA_BASE_URL (hosted gateway) or INDEXER_BASE_URL + KEY_BROKER_BASE_URL
 * (local direct mode), and for read/verify a wallet (PRIVATE_KEY or signer).
 */

import path from "path";
import { config as loadEnv } from "dotenv";

// Load repo root .env when run via pnpm from package dir (cwd = packages/cli)
loadEnv({ path: path.resolve(process.cwd(), "../../.env") });

import { MemoraClient } from "@memora-hq/memora-core";
import { ethers } from "ethers";
import {
  verifyEventEnvelope,
  recoverEnvelopeSigner,
  verifyEventId,
  verifyAgentSignature,
  verifyAgentTeeSignature,
  createTeeVerifier,
  computeEventLeafHash,
  verifyMerkleProof,
  PhaseTimer,
  type AgentCanonicalSigningFields,
  type AgentTeeCanonicalSigningFields,
  type MemoryCommit,
  type MerkleProof,
} from "@memora-hq/memora-protocol";
import { fail, isWarning, pass, printChecks, type CheckResult, warn } from "./checks.js";
import { formatReceiptCard } from "./receiptCard.js";
import { getLookupId, resolveRef, type ResolveRefOptions } from "./resolveRef.js";
import { batchProofUrl, resolveCliEndpoints } from "./endpoints.js";
import { runLightVerify } from "./verifyLight.js";
// Offline .memora bundle and on-disk session verification — the same primitives
// memora-sdk's leaner CLI uses. Imported directly here too so this CLI's local
// commands don't route bundle/session verification through @memora-hq/memora-local
// a second time — one verifier implementation, two consuming CLIs.
import {
  FileKeyProvider,
  LocalEvidenceStore,
  LocalSession,
  exportLocalBundle,
  readLocalBundle,
  getOrCreateIdentity,
  verifySession,
  verifyBundle,
} from "@memora-hq/memora-verifier";
// Live session capture (PTY), receipts, hook integration, and diagnostics — this is
// the reason this CLI exists as a separate, heavier package from memora-sdk's:
// everything here needs @memora-hq/memora-local and, transitively, node-pty.
import {
  KnownSignerStore,
  assertPublishSize,
  clearPublishAttempt,
  countFailedHookEntries,
  createPublication,
  daemonLogPath,
  decryptPublishBundle,
  decryptPublishSession,
  deletePublication,
  enqueueLocalHook,
  ensurePublishLogin,
  finalizePublishArtifact,
  getAdapter,
  hookConfigPathFor,
  isSupportedPlatform,
  isDaemonRunning,
  loadPublishAttempt,
  loadPublishSession,
  mergeMemoraHooks,
  openUrlInBrowser,
  plaintextsForScan,
  PublishArtifactTooLargeError,
  readDaemonLog,
  readHookConfigFile,
  removeDaemonPidFile,
  removeMemoraHooks,
  renderReceiptDocument,
  resolvePublishAttempt,
  runDaemonForeground,
  runIntegrationDiagnostic,
  runLocalCommand,
  savePublishAttempt,
  scanForSecrets,
  spawnDaemon,
  summarizeSession,
  unsupportedPlatformMessage,
  writeHookConfigFile,
  type LocalHookProvider,
  type DiagnosticProvider,
  type DecryptedPublishSession,
} from "@memora-hq/memora-local";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { access, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";

// MEMORA_BASE_URL points at the public gateway and serves both roles; without it we
// fall back to today's direct indexer + key-broker origins for local development.
const ENDPOINTS           = resolveCliEndpoints();
const INDEXER_BASE_URL    = ENDPOINTS.indexerBaseUrl;
const KEY_BROKER_BASE_URL = ENDPOINTS.keyBrokerBaseUrl;

function localPaths() {
  const root = process.env.MEMORA_LOCAL_DATA_DIR || join(homedir(), "Library", "Application Support", "Memora");
  return {
    root,
    store: new LocalEvidenceStore(root),
    keys: new FileKeyProvider(join(root, "identity", "local-key.json")),
    signers: KnownSignerStore.forDataRoot(root),
  };
}

async function cmdLocalInit() {
  const paths = localPaths();
  const identity = await getOrCreateIdentity(paths.keys);
  await paths.store.initialize();
  console.log("Memora Local initialized");
  console.log(`  agent:  ${identity.agentId}`);
  console.log(`  signer: ${identity.address}`);
  console.log("  trust:  self-issued local identity");
}

async function cmdLocalRun(command: string[]) {
  const paths = localPaths();
  const identity = await getOrCreateIdentity(paths.keys);
  const cwd = resolve(process.cwd());
  const session = new LocalSession({ store: paths.store, identity, captureRoot: cwd });
  await session.start();
  session.warn({
    code: "PROCESS_TREE_SAMPLED",
    message: "Wrapper capture cannot guarantee semantic visibility into every child tool call.",
    source: "wrapper_observed",
  });
  console.error(`[memora] local session ${session.sessionId}`);
  try {
    const exitCode = await runLocalCommand({ command, cwd, session });
    await session.finish("partial", { exit_code: exitCode });
    console.error(`\n[memora] captured ${session.sessionId} (local, partial)`);
    process.exitCode = exitCode;
  } catch (error) {
    await session.finish("interrupted", { error: (error as Error).message }).catch(() => undefined);
    throw error;
  }
}

async function cmdLocalSessions() {
  const manifests = await localPaths().store.listSessions();
  if (!manifests.length) { console.log("No local sessions."); return; }
  for (const manifest of manifests) {
    console.log(`${manifest.session_id}\t${manifest.capture_status}\t${manifest.started_at}\t${manifest.event_ids.length} events`);
  }
}

async function cmdLocalShow(sessionId: string) {
  const store = localPaths().store;
  const manifest = await store.readManifest(sessionId);
  const events = await store.readEvents(sessionId);
  console.log(`${manifest.session_id} · ${manifest.capture_status} · ${manifest.event_ids.length} events`);
  for (const event of events) {
    console.log(`${event.observed_at}\t${event.source}\t${event.commit.event_type ?? "event"}\t${event.commit.event_id}`);
  }
}

async function cmdLocalVerify(sessionId: string) {
  const paths = localPaths();
  const identity = await paths.keys.load() ?? undefined;
  const result = await verifySession(paths.store, sessionId, identity);
  console.log(`Integrity:    ${result.integrity}`);
  console.log(`Identity:     ${result.identity}`);
  console.log(`Completeness: ${result.completeness}`);
  console.log(`Anchoring:    ${result.anchoring}`);
  for (const check of result.checks) console.log(`  ${check.status === "passed" ? "✓" : check.status === "warning" ? "⚠" : "✗"} ${check.name}: ${check.detail}`);
  if (!result.valid) process.exitCode = 1;
}

async function cmdLocalExport(sessionId: string, output: string, disclose: boolean) {
  const paths = localPaths();
  const identity = disclose ? await paths.keys.load() ?? undefined : undefined;
  if (disclose && !identity) throw new Error("no local identity on this device — run `memora local init` first");
  const result = await exportLocalBundle(paths.store, sessionId, resolve(output), disclose ? { disclose: "all", identity } : {});
  console.log(`Exported ${sessionId} to ${result.path}`);
  console.log(`Disclosure:  ${result.disclosure}${result.disclosure === "none" ? " (contents stay encrypted)" : ` (${result.disclosedCount}/${result.eventCount} records readable)`}`);
  console.log(`sha256:      ${result.fingerprint}`);
}

async function cmdLocalVerifyBundle(path: string) {
  const result = verifyBundle(await readLocalBundle(resolve(path)));
  console.log(`Bundle integrity: ${result.valid ? "verified" : "failed"}`);
  console.log(`Signed by:        ${result.signer}`);
  console.log(`Records:          ${result.eventCount}`);
  console.log(`Disclosure:       ${result.disclosure}${result.disclosure === "none" ? "" : ` (${result.disclosedCount} readable and matched to their signed hashes)`}`);
  for (const check of result.checks) console.log(`  ${check.status === "passed" ? "✓" : check.status === "warning" ? "⚠" : "✗"} ${check.name}: ${check.detail}`);
  for (const error of result.errors) console.log(`  ✗ ${error}`);
  if (!result.valid) { process.exitCode = 1; return; }

  // Continuity only: this records that the same key has been seen before, never who holds it.
  const signer = await localPaths().signers.record(result.signer);
  console.log(signer.receipts_verified > 1
    ? `Seen before:      yes${signer.label ? ` (${signer.label})` : ""}, ${signer.receipts_verified} receipts since ${signer.first_seen}`
    : "Seen before:      no — this is the first receipt verified from this key");
  console.log("A signature proves the record was not altered. It does not prove who produced it.");
}

// Publishing is a separate hosted service from the write/query/read gateway above (that's
// on-chain evidence via the indexer; this is the memora.io hosted viewer) — its own origin,
// overridable for local development against a non-production viewer/API.
const PUBLISH_ORIGIN = process.env.MEMORA_PUBLISH_BASE_URL ?? "https://memora.dev";

function formatDuration(startedAt: string, completedAt: string | undefined): string {
  if (!completedAt) return "in progress";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatBytes(byteSize: number): string {
  return byteSize >= 1_000_000 ? `${(byteSize / 1_000_000).toFixed(1)} MB` : `${(byteSize / 1000).toFixed(0)} KB`;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Publishing requires interactive confirmation. Non-interactive publishing is disabled " +
      "because a publication may expose session contents to anyone holding its share link.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function copyToClipboard(text: string): void {
  const command = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : null;
  if (!command) return;
  try {
    const child = spawn(command, { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(text);
  } catch {
    // Best-effort — the link is always printed too.
  }
}

/** Resolves the publish source (an existing bundle file path, or a session ID) and decrypts
 * its payloads — the step just before the secret scan runs, ahead of any encrypt/upload. */
async function resolveDecryptedSession(
  source: string,
  paths: ReturnType<typeof localPaths>,
): Promise<{ sessionKey: string; session: DecryptedPublishSession }> {
  const identity = await paths.keys.load();
  if (!identity) throw new Error("no local identity on this device — run `memora local init` first");

  const asPath = resolve(source);
  const isBundleFile = await access(asPath, constants.R_OK).then(() => true, () => false);
  if (isBundleFile) {
    const bundle = await readLocalBundle(asPath);
    return { sessionKey: bundle.manifest.session_id, session: decryptPublishBundle(bundle, identity) };
  }
  return { sessionKey: source, session: await decryptPublishSession(paths.store, source, identity) };
}

function printScanFindings(findings: ReturnType<typeof scanForSecrets>["findings"]): void {
  for (const finding of findings) {
    console.log(`  ${finding.label}`);
    console.log(`    rule: ${finding.ruleId}    ${finding.preview}`);
  }
}

async function cmdLocalPublish(source: string, open: boolean) {
  const paths = localPaths();
  const { sessionKey, session } = await resolveDecryptedSession(source, paths);

  console.log("Preparing shareable session…");
  console.log("Scanning for secrets…\n");
  const scan = scanForSecrets(plaintextsForScan(session));

  if (scan.blocked) {
    console.log("✗ Possible credentials found\n");
    printScanFindings(scan.findings.filter((f) => f.severity === "block"));
    console.log("\nMemora will not publish this session because anyone with the share link");
    console.log("would be able to decrypt the full artifact.\n");
    console.log("Nothing was uploaded.\n");
    console.log("Review the session locally or create a sanitized session before publishing.");
    process.exitCode = 1;
    return;
  }

  const artifact = finalizePublishArtifact(session);

  try {
    assertPublishSize(artifact.byteSize);
  } catch (error) {
    if (error instanceof PublishArtifactTooLargeError) {
      console.log(`✗ ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (scan.warned) {
    console.log(`⚠ ${scan.findings.length} possible secret(s) found\n`);
    printScanFindings(scan.findings);
    console.log("\nThese may be legitimate values.\n");
  } else {
    console.log("✓ Secret scan passed\n");
  }

  console.log(`Session      ${sessionKey}`);
  console.log(`Events       ${artifact.eventCount}`);
  console.log(`Duration     ${formatDuration(artifact.bundle.manifest.started_at, artifact.bundle.manifest.completed_at)}`);
  console.log(`Upload       ${formatBytes(artifact.byteSize)}\n`);
  console.log("The complete share link is the access credential — anyone who receives it can");
  console.log("view this published session. Forwarding the link forwards access.\n");

  if (!(await confirm(scan.warned ? "Publish anyway?" : "Publish to Memora Cloud?"))) {
    console.log("Not published.");
    return;
  }

  let token: string;
  try {
    token = await ensurePublishLogin({
      dataRoot: paths.root,
      baseUrl: PUBLISH_ORIGIN,
      onPrompt: ({ verificationUrl, userCode }) => {
        console.log(`\nSign in to publish: ${verificationUrl}`);
        console.log(`Code: ${userCode}\n`);
      },
    });
  } catch (error) {
    console.log(`\n✗ Could not sign in: ${(error as Error).message}`);
    console.log("\nYour session remains stored locally. Nothing was uploaded.");
    console.log(`\nRetry:\n  memora local publish ${source}`);
    process.exitCode = 1;
    return;
  }

  const attempt = await resolvePublishAttempt(paths.root, sessionKey, artifact.digest);
  await savePublishAttempt(paths.root, { ...attempt, state: "UPLOADING" });

  let result: { version: number; id: string };
  try {
    console.log("Uploading…");
    result = await createPublication({
      baseUrl: PUBLISH_ORIGIN,
      token,
      attemptId: attempt.attempt_id,
      bundle: artifact.bundle,
      byteSize: artifact.byteSize,
    });
  } catch (error) {
    console.log(`\n✗ Could not reach Memora Cloud: ${(error as Error).message}`);
    console.log("\nYour session remains stored locally. Nothing was deleted or modified.");
    console.log(`\nRetry:\n  memora local publish ${source}`);
    process.exitCode = 1;
    return;
  }

  await savePublishAttempt(paths.root, { ...attempt, state: "PUBLISHED", publication_id: result.id });

  const link = `${PUBLISH_ORIGIN}/v/${result.id}#${artifact.key}`;
  copyToClipboard(link);
  console.log("\n✓ Published");
  console.log("✓ Link copied to clipboard\n");
  console.log(link);

  if (open) {
    openUrlInBrowser(link);
    console.log("✓ Opened in browser");
  }
}

async function cmdLocalUnpublish(publicationIdArg: string | undefined, sessionArg: string | undefined) {
  const paths = localPaths();
  const session = await loadPublishSession(paths.root);
  if (!session) throw new Error("not signed in — run `memora local publish` first to sign in");

  let publicationId = publicationIdArg;
  if (!publicationId && sessionArg) {
    const attempt = await loadPublishAttempt(paths.root, sessionArg);
    if (!attempt || attempt.state !== "PUBLISHED" || !attempt.publication_id) {
      throw new Error(`no publication found for session ${sessionArg}`);
    }
    publicationId = attempt.publication_id;
  }
  if (!publicationId) throw new Error("usage: memora local unpublish <publication-id> | --session <session-id>");

  await deletePublication({ baseUrl: PUBLISH_ORIGIN, token: session.token, publicationId });
  if (sessionArg) await clearPublishAttempt(paths.root, sessionArg);
  console.log("✓ Publication deleted.\n");
  console.log("Existing links will no longer load this session.");
}

async function cmdLocalReceipt(sessionId: string, output: string) {
  const paths = localPaths();
  const identity = await paths.keys.load() ?? undefined;
  const manifest = await paths.store.readManifest(sessionId);
  const events = await paths.store.readEvents(sessionId);
  const verification = await verifySession(paths.store, sessionId, identity);
  const known = await paths.signers.get(manifest.signer);
  const html = renderReceiptDocument({
    manifest,
    // The CLI has no decrypted presentation layer, so the summary reports what the signed events
    // themselves state and claims nothing about file paths or tool names.
    summary: summarizeSession(manifest, events),
    verification,
    signer: {
      address: manifest.signer,
      isThisDevice: Boolean(identity) && identity!.address.toLowerCase() === manifest.signer.toLowerCase(),
      ...(known?.label ? { label: known.label } : {}),
      ...(known ? { receiptsVerified: known.receipts_verified, firstSeen: known.first_seen } : {}),
    },
    disclosure: "none",
    generatedAt: new Date().toISOString(),
  });
  await writeFile(resolve(output), html, { mode: 0o600 });
  console.log(`Receipt written to ${resolve(output)}`);
}

async function cmdLocalHook(provider: string) {
  if (!["codex", "claude", "vscode", "cursor"].includes(provider)) {
    throw new Error("--provider must be codex, claude, vscode, or cursor");
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString();
  if (!input.trim()) throw new Error("hook JSON is required on stdin");
  const payload = JSON.parse(input) as Record<string, unknown>;
  await enqueueLocalHook(provider as LocalHookProvider, payload);

  // Purely local plumbing: this drains /tmp hook events into the local evidence store. It
  // never touches the network or implies an upload — that only happens via `local publish`.
  // A failure here must not fail the hook itself, so it's caught and swallowed.
  try {
    if (!(await isDaemonRunning()).running) {
      await spawnDaemon(localPaths().root, resolveSelfCliPath());
    }
  } catch (error) {
    console.error(`[memora] daemon autostart failed: ${(error as Error).message}`);
  }
}

// The hook command embeds an absolute path to this CLI so agent config files keep working
// no matter how `memora` was invoked (npx, a global install, a workspace-local bin). This
// is the CLI's own script path, not a fixed launcher location — there's no dependency on
// `~/.local/bin/memora` existing.
function resolveSelfCliPath(): string {
  return resolve(process.argv[1]);
}

function requireTerminalAdapter(provider: string): void {
  const adapter = getAdapter(provider);
  if (!adapter || adapter.kind !== "terminal") {
    throw new Error("--provider must be codex or claude");
  }
}

async function cmdLocalInstallHooks(provider: string) {
  requireTerminalAdapter(provider);
  const paths = localPaths();
  const configPath = hookConfigPathFor(provider);
  const existing = await readHookConfigFile(configPath);
  const merged = mergeMemoraHooks(existing, provider, resolveSelfCliPath(), paths.root);
  const { backedUp } = await writeHookConfigFile(configPath, merged);
  if (backedUp) console.log(`✓ Backed up ${configPath}`);
  console.log(`✓ Installed ${getAdapter(provider)!.displayName} hook`);
}

async function cmdLocalUninstallHooks(provider: string) {
  requireTerminalAdapter(provider);
  const configPath = hookConfigPathFor(provider);
  const existing = await readHookConfigFile(configPath);
  const cleaned = removeMemoraHooks(existing);
  const { backedUp } = await writeHookConfigFile(configPath, cleaned);
  if (backedUp) console.log(`✓ Backed up ${configPath}`);
  console.log(`✓ Uninstalled ${getAdapter(provider)!.displayName} hook`);
}

async function cmdDaemonStart() {
  const paths = localPaths();
  const status = await isDaemonRunning();
  if (status.running) {
    console.log(`Daemon already running (pid ${status.pid})`);
    return;
  }
  const pid = await spawnDaemon(paths.root, resolveSelfCliPath());
  console.log(`✓ Daemon started (pid ${pid})`);
  console.log(`  log: ${daemonLogPath(paths.root)}`);
}

async function cmdDaemonStop() {
  const status = await isDaemonRunning();
  if (!status.running || !status.pid) {
    console.log("Daemon is not running");
    return;
  }
  process.kill(status.pid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    if (!(await isDaemonRunning()).running) break;
  }
  // Safety net in case the daemon didn't get to clean up its own pidfile (e.g. SIGKILL).
  await removeDaemonPidFile();
  console.log("✓ Daemon stopped");
}

async function cmdDaemonStatus() {
  const paths = localPaths();
  const status = await isDaemonRunning();
  console.log(status.running ? `Daemon running (pid ${status.pid})` : "Daemon not running");
  const failed = await countFailedHookEntries();
  if (failed > 0) console.log(`⚠ ${failed} hook event(s) failed to ingest — see ${daemonLogPath(paths.root)}`);
}

async function cmdDaemonLogs() {
  const paths = localPaths();
  const lines = await readDaemonLog(paths.root);
  if (lines.length === 0) { console.log("No daemon log yet."); return; }
  for (const line of lines) console.log(line);
}

// Not part of the public command list — the detached child spawnDaemon() launches runs this.
async function cmdDaemonRunInternal() {
  await runDaemonForeground(localPaths().root);
}

async function resolveExecutable(command: string): Promise<string | null> {
  for (const directory of (process.env.PATH ?? "").split(":")) {
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

async function cmdLocalDoctor(provider: string, json: boolean) {
  if (!["codex", "claude"].includes(provider)) throw new Error("--provider must be codex or claude");
  const selected = provider as DiagnosticProvider;
  const paths = localPaths();
  const executable = await resolveExecutable(selected);
  const runtimeCandidates = [
    executable,
    selected === "codex" ? "/Applications/ChatGPT.app/Contents/Resources/codex" : null,
    selected === "codex" ? "/Applications/Codex.app/Contents/Resources/codex" : null,
  ].filter((value): value is string => Boolean(value));
  const result = await runIntegrationDiagnostic({
    provider: selected,
    dataRoot: paths.root,
    cliPath: join(homedir(), ".local", "bin", "memora"),
    hookConfigPath: selected === "codex"
      ? join(homedir(), ".codex", "hooks.json")
      : join(homedir(), ".claude", "settings.json"),
    runtimeCandidates,
    cwd: process.cwd(),
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${selected === "codex" ? "Codex" : "Claude"} connection: ${result.status.replace("_", " ")}`);
    for (const check of result.checks) {
      const icon = check.status === "passed" ? "✓" : check.status === "warning" ? "⚠" : "✗";
      console.log(`  ${icon} ${check.label}: ${check.detail}`);
    }
    for (const action of result.remediation) console.log(`  → ${action}`);
  }
  if (result.status === "needs_attention" || result.status === "not_installed") process.exitCode = 1;
}
// When pointed at the gateway (api.getmemora.dev) rather than a raw indexer, requests
// must go through /v1/events with a per-agent API key as the write secret. Self-hosted
// operators point MEMORA_BASE_URL at their own gateway and set MEMORA_API_KEY to
// whatever bearer token that deployment expects — the CLI has no separate operator-secret
// code path.
const WRITE_SECRET        = process.env.MEMORA_API_KEY;
const USE_V1_ROUTES       = ENDPOINTS.clientV1Routes;
const PRIVATE_KEY         = process.env.PRIVATE_KEY;
const MIRROR_URL          = process.env.HEDERA_MIRROR_URL || "https://testnet.mirrornode.hedera.com";
const EVM_RPC_URL         = process.env.HEDERA_EVM_RPC_URL;
const REGISTRY_ADDRESS    = process.env.MEMORA_REGISTRY_CONTRACT_ID;

const REGISTRY_VIEW_ABI = [
  "function isAgentSignerValid(bytes32 agentId, address signer, uint256 atTimestamp) view returns (bool)",
  "function strictAttestationRequired(bytes32 agentId) view returns (bool)",
  "function strictTeeRequired(bytes32 agentId) view returns (bool)",
  "function getAgentSignerPolicy(bytes32 agentId, address signer) view returns (bool enabled, uint256 validFrom, uint256 validUntil)",
  "function getMemory(bytes32 memoryId) view returns (bytes32 agentId, string cid, bytes32 payloadHash, bytes32 taskId, address writer, uint256 createdAt, bytes32 eventDigest, address operatorSigner, address agentSigner, bytes32 agentCommitDigest, bytes32 teeQuoteHash)",
];

// Phase TEE+5: commit path detection via transaction receipt event topics.
const COMMIT_PATH_TOPICS = {
  TEE:      ethers.id("MemoryCommittedV4(bytes32,bytes32,bytes32,string,bytes32,address,uint256,bytes32,address,bytes32,address,bytes32)"),
  VERIFIED: ethers.id("MemoryCommittedV3(bytes32,bytes32,bytes32,string,bytes32,address,uint256,bytes32,address,bytes32,address)"),
  ATTESTED: ethers.id("MemoryCommittedV2(bytes32,bytes32,bytes32,string,bytes32,address,uint256,bytes32,address,address)"),
  LEGACY:   ethers.id("MemoryCommitted(bytes32,bytes32,bytes32,string,bytes32,address,uint256)"),
} as const;

type CommitPath = "TEE" | "VERIFIED" | "ATTESTED" | "LEGACY" | "UNKNOWN";

const client = new MemoraClient({
  indexerBaseUrl: INDEXER_BASE_URL,
  keyBrokerBaseUrl: KEY_BROKER_BASE_URL,
  ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL || "https://gateway.pinata.cloud/ipfs/",
  writeSecret: WRITE_SECRET,
  v1Routes: USE_V1_ROUTES,
});

// The CLI's own reads (resolveRef, batch proof). Both gateway and direct-mode reads
// require a bearer token — the indexer's GET /memory/:id and key-broker reads have no
// unauthenticated path, with or without MEMORA_BASE_URL — so MEMORA_API_KEY is sent
// whenever it's set, in either mode. Without it, a self-hosted indexer/key-broker that
// enforces read auth will 401, which the CLI currently surfaces as a misleading
// "not found" rather than an auth error (see resolveRef.ts / batchProofUrl callers).
const REF_OPTIONS: ResolveRefOptions = ENDPOINTS.gatewayMode
  ? { v1Routes: true, authToken: WRITE_SECRET }
  : { authToken: WRITE_SECRET };
const READ_INIT: RequestInit | undefined = REF_OPTIONS.authToken
  ? { headers: { Authorization: `Bearer ${REF_OPTIONS.authToken}` } }
  : undefined;

// ── Existing commands ──────────────────────────────────────────────────────────

async function cmdWrite(agentId: string, filePath: string) {
  const fs = await import("fs");
  const path = await import("path");
  let fullPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(fullPath) && !path.isAbsolute(filePath) && !filePath.startsWith("..")) {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const alt = path.resolve(repoRoot, filePath);
    if (fs.existsSync(alt)) fullPath = alt;
  }
  const payload = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  const receipt = await client.write({
    agentId,
    contentType: payload.contentType ?? "application/json",
    content: payload.content ?? payload,
    tags: payload.tags,
    taskId: payload.taskId,
    access: payload.access,
  });
  console.log("Write receipt:");
  console.log(JSON.stringify(receipt, null, 2));
}

async function cmdQuery(agentId: string) {
  const list = await client.query({ agentId, limit: 20 });
  console.log("Memories:", list.length);
  console.log(JSON.stringify(list, null, 2));
}

async function cmdRead(memoryId: string) {
  if (!PRIVATE_KEY) {
    console.error("PRIVATE_KEY env required for read (to sign challenge)");
    process.exit(1);
  }
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  const payload = await client.read(memoryId, (m) => wallet.signMessage(m), wallet.address);
  console.log("Decrypted payload:");
  console.log(JSON.stringify(payload, null, 2));
}

async function cmdReceipt(id: string) {
  const ref = await resolveRef(INDEXER_BASE_URL, id, REF_OPTIONS);
  if (!ref) {
    console.error("Execution not found");
    process.exit(1);
  }
  console.log(formatReceiptCard(ref));
}

async function cmdVerify(id: string, opts?: { signer?: string }) {
  const ref = await resolveRef(INDEXER_BASE_URL, id, REF_OPTIONS);
  if (!ref) {
    console.error("Execution not found");
    process.exit(1);
  }

  const anchored = !!(ref.contract_tx_hash || ref.hcs_sequence);
  if (anchored) {
    await cmdReplayVerify(ref.memory_id, opts?.signer);
    return;
  }

  const checks = runLightVerify(ref);
  printChecks(checks);
  const failed = checks.some((check) => !check.ok && !isWarning(check));
  if (failed) {
    console.log("\n  VERIFY VERDICT: INTEGRITY CONCERN — review failed checks above\n");
    process.exit(1);
  }
  console.log("\n  VERIFY VERDICT: CONSISTENT with indexed record\n");
}

// ── Task 4: replay verify ──────────────────────────────────────────────────────

/**
 * Fetch the raw HCS commit message from the Hedera mirror node.
 * Returns the parsed MemoryCommit or null if unavailable.
 */
async function fetchHcsCommit(
  topicId: string,
  sequenceNumber: string
): Promise<MemoryCommit | null> {
  if (!topicId || !sequenceNumber) return null;
  try {
    const url = `${MIRROR_URL}/api/v1/topics/${topicId}/messages/${sequenceNumber}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as { message?: string };
    if (!data.message) return null;
    const decoded = Buffer.from(data.message, "base64").toString("utf8");
    return JSON.parse(decoded) as MemoryCommit;
  } catch {
    return null;
  }
}

interface BatchProofResult {
  event_id:         string;
  batch_id:         string;
  leaf_hash:        string;
  leaf_index:       number;
  merkle_proof:     MerkleProof;
  merkle_root:      string;
  event_count:      number;
  hcs_sequence:     string | null;
  hcs_timestamp:    string | null;
  contract_tx_hash: string | null;
  batch_status:     string;
  integrity_mode:   string;
}

/**
 * Fetch the Merkle batch proof for an event from the indexer (direct mode) or the
 * gateway's `/v1/batches/proof` (gateway mode).
 * Returns null if the event is not in any batch.
 */
async function fetchBatchProof(eventId: string): Promise<BatchProofResult | null> {
  try {
    const res = await fetch(batchProofUrl(ENDPOINTS, eventId), READ_INIT);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return res.json() as Promise<BatchProofResult>;
  } catch {
    return null;
  }
}

/**
 * Fetch a memory ref to check parent existence.
 */
async function parentExists(parentId: string): Promise<boolean> {
  const r = await resolveRef(INDEXER_BASE_URL, parentId, REF_OPTIONS);
  return r !== null;
}

type SignerTimelineEvent = {
  blockTimestamp: number;
  enabled: boolean;
  validFrom: number;
  validUntil: number;
};

type SignerTimelineResult = {
  validAtTime: boolean | null; // null = could not determine (fallback required)
  source: "event-history" | "current-state";
  events: SignerTimelineEvent[];
  warning?: string;
};

/**
 * Phase 5: reconstruct point-in-time signer validity from on-chain AgentSignerUpdated events.
 *
 * This overcomes the limitation of isAgentSignerValid() which only reflects the CURRENT policy.
 * If a signer was registered, revoked, and re-registered, isAgentSignerValid() loses history.
 * By replaying events in block-timestamp order, we determine what the policy was at atTimestamp.
 *
 * Returns validAtTime=null if event log querying fails (caller should fall back to current state).
 */
async function reconstructSignerTimeline(
  provider: ethers.JsonRpcProvider,
  registryAddress: string,
  agentIdBytes32: string,
  signerAddr: string,
  atTimestamp: number
): Promise<SignerTimelineResult> {
  const iface = new ethers.Interface([
    "event AgentSignerUpdated(bytes32 indexed agentId, address indexed signer, bool enabled, uint256 validFrom, uint256 validUntil)",
  ]);
  const topicHash  = ethers.id("AgentSignerUpdated(bytes32,address,bool,uint256,uint256)");
  const paddedSigner = ethers.zeroPadValue(signerAddr.toLowerCase(), 32);

  try {
    const logs = await provider.getLogs({
      address: registryAddress,
      topics: [topicHash, agentIdBytes32, paddedSigner],
      fromBlock: 0,
      toBlock: "latest",
    });

    if (logs.length === 0) {
      return {
        validAtTime: false,
        source: "event-history",
        events: [],
        warning: "no AgentSignerUpdated events found — signer was never registered",
      };
    }

    const eventsWithTimestamps = await Promise.all(
      logs.map(async (log) => {
        const block  = await provider.getBlock(log.blockNumber);
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        return {
          blockTimestamp: block?.timestamp ?? 0,
          enabled:        parsed?.args.enabled  as boolean,
          validFrom:      Number(parsed?.args.validFrom),
          validUntil:     Number(parsed?.args.validUntil),
        };
      })
    );
    eventsWithTimestamps.sort((a, b) => a.blockTimestamp - b.blockTimestamp);

    // Last event at or before atTimestamp is the active policy at that moment
    const priorEvents = eventsWithTimestamps.filter(e => e.blockTimestamp <= atTimestamp);
    if (priorEvents.length === 0) {
      return {
        validAtTime: false,
        source: "event-history",
        events: eventsWithTimestamps,
        warning: "all AgentSignerUpdated events are after event time — signer not registered at event time",
      };
    }

    const active = priorEvents[priorEvents.length - 1];
    const valid  =
      active.enabled &&
      active.validFrom <= atTimestamp &&
      (active.validUntil === 0 || atTimestamp <= active.validUntil);

    return { validAtTime: valid, source: "event-history", events: eventsWithTimestamps };
  } catch (e) {
    return {
      validAtTime: null,
      source: "current-state",
      events: [],
      warning: `event log query failed (${(e as Error).message}) — fell back to current on-chain state`,
    };
  }
}

/**
 * Detect the commit path (VERIFIED/ATTESTED/LEGACY) by inspecting the transaction receipt.
 * Requires the contract_tx_hash from the index.
 */
async function detectCommitPath(
  provider: ethers.JsonRpcProvider,
  contractTxHash: string
): Promise<CommitPath> {
  try {
    const receipt = await provider.getTransactionReceipt(contractTxHash);
    if (!receipt) return "UNKNOWN";
    const topics0 = receipt.logs.map((l) => l.topics[0]);
    if (topics0.includes(COMMIT_PATH_TOPICS.TEE))      return "TEE";
    if (topics0.includes(COMMIT_PATH_TOPICS.VERIFIED)) return "VERIFIED";
    if (topics0.includes(COMMIT_PATH_TOPICS.ATTESTED)) return "ATTESTED";
    if (topics0.includes(COMMIT_PATH_TOPICS.LEGACY))   return "LEGACY";
    return "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

async function cmdReplayVerify(memoryId: string, expectedSigner?: string) {
  const timer = new PhaseTimer();
  console.log(`\nmemora replay verify: ${memoryId}`);
  const hcsProtected = !!process.env.HEDERA_HCS_SUBMIT_KEY;
  console.log(`  HCS topic: ${hcsProtected ? "PROTECTED (submit key)" : "OPEN (no submit key — injection possible)"}`);
  if (expectedSigner) console.log(`  Expected operator: ${expectedSigner}`);
  console.log();
  const checks: CheckResult[] = [];
  let overallOk = true;

  // ── 1. Fetch indexed ref ────────────────────────────────────────────────────
  const ref = await timer.time("index_fetch_ref", () => resolveRef(INDEXER_BASE_URL, memoryId, REF_OPTIONS));
  if (!ref) {
    console.log(`  ✗ memory not found in index`);
    process.exit(1);
  }

  // ── 2. Contract anchor ─────────────────────────────────────────────────────
  checks.push(
    ref.contract_tx_hash
      ? pass("on-chain anchored", `contract_tx: ${ref.contract_tx_hash.slice(0, 18)}…`)
      : warn("on-chain anchored", "no contract_tx_hash — indexer-only record")
  );

  // ── 3. HCS sequence present ────────────────────────────────────────────────
  checks.push(
    ref.hcs_sequence
      ? pass("HCS indexed", `seq #${ref.hcs_sequence} @ ${ref.hcs_timestamp}`)
      : warn("HCS indexed", "no hcs_sequence — not yet indexed by subscriber")
  );

  // ── 4. event_id format ─────────────────────────────────────────────────────
  const hasEventId = typeof ref.event_id === "string" && ref.event_id.length === 64;
  checks.push(
    hasEventId
      ? pass("event_id present", ref.event_id!.slice(0, 16) + "…")
      : warn("event_id present", ref.event_id ? `unexpected format: ${ref.event_id}` : "absent (pre-Phase-1 record)")
  );

  // ── 5. Subscriber signature verification (from index) ─────────────────────
  const refAny = ref as unknown as Record<string, unknown>;
  if (refAny.valid_signature === true) {
    checks.push(pass("subscriber verified signature", `signer: ${ref.signer ?? "unknown"}`));
  } else if (refAny.valid_signature === false) {
    checks.push(fail("subscriber verified signature", `signer mismatch or missing signature`));
    overallOk = false;
  } else {
    checks.push(warn("subscriber verified signature", "valid_signature not yet recorded (pre-Phase-2 subscriber)"));
  }

  // ── 6. Parent linkage + ordering (Phase 3) ───────────────────────────────
  const parentIds: string[] = Array.isArray(ref.parent_ids) ? ref.parent_ids : [];
  const childSeq = ref.hcs_sequence ? Number(ref.hcs_sequence) : null;

  if (parentIds.length === 0) {
    checks.push(pass("parent linkage", "no parents declared"));
  } else {
    const parentRefs = await timer.time("parent_fetch_refs", () => Promise.all(parentIds.map(async (pid) => ({
      pid,
      ref: await resolveRef(INDEXER_BASE_URL, pid, REF_OPTIONS),
    }))));

    const missing   = parentRefs.filter((p) => !p.ref);
    const outOfOrder = parentRefs.filter((p) => {
      if (!p.ref || childSeq === null) return false;
      const pSeq = p.ref.hcs_sequence ? Number(p.ref.hcs_sequence) : null;
      return pSeq !== null && pSeq >= childSeq;
    });
    const invalidSig = parentRefs.filter((p) => {
      const pr = p.ref as unknown as Record<string, unknown>;
      return p.ref && pr.valid_signature === false;
    });

    if (missing.length > 0) {
      checks.push(warn("parent linkage", `${missing.length} orphaned parent(s): ${missing.map((p) => p.pid.slice(0, 10) + "…").join(", ")}`));
      overallOk = false;
    } else {
      checks.push(pass("parent linkage", `${parentIds.length} parent(s) exist in index`));
    }

    if (outOfOrder.length > 0) {
      checks.push(fail("parent HCS ordering", `${outOfOrder.length} parent(s) have hcs_sequence ≥ child (lineage violation)`));
      overallOk = false;
    } else if (childSeq !== null && parentRefs.every((p) => p.ref?.hcs_sequence)) {
      checks.push(pass("parent HCS ordering", `all parents precede child (#${childSeq})`));
    } else {
      checks.push(warn("parent HCS ordering", "hcs_sequence missing on some records — cannot verify ordering"));
    }

    if (invalidSig.length > 0) {
      checks.push(warn("parent signature validity", `${invalidSig.length} parent(s) have invalid/absent operator signatures`));
    } else if (parentRefs.some((p) => p.ref && (p.ref as unknown as Record<string, unknown>).valid_signature === true)) {
      checks.push(pass("parent signature validity", "all indexed parents have verified signatures"));
    }
  }

  // ── 6b. Agent signature (Phase 3) ────────────────────────────────────────
  const refAnyExt = ref as unknown as Record<string, unknown>;
  if (refAnyExt.agent_sig_verified === true) {
    checks.push(pass("agent countersignature", `agent signer: ${String(refAnyExt.agent_signer ?? "unknown").slice(0, 12)}…`));
  } else if (refAnyExt.agent_sig_verified === false) {
    checks.push(fail("agent countersignature", `agent signature invalid or signer not registered`));
    overallOk = false;
  } else {
    checks.push(warn("agent countersignature", "no agent signature (pre-Phase-3 write or unsigned runtime)"));
  }

  // ── On-chain checks (Phase 4+5) — create provider/registry once ─────────────
  const agentSignerAddr  = refAnyExt.agent_signer as string | null | undefined;
  const agentIdBytes32   = ethers.keccak256(ethers.toUtf8Bytes(ref.agent_id));

  // Determine event timestamp source — used for both signer validity and timeline checks
  let atTimestamp: number;
  let tsSource: string;
  if (ref.hcs_timestamp) {
    atTimestamp = Math.floor(new Date(ref.hcs_timestamp).getTime() / 1000);
    tsSource    = `HCS timestamp (${ref.hcs_timestamp})`;
  } else if (ref.created_at) {
    atTimestamp = Math.floor(new Date(ref.created_at).getTime() / 1000);
    tsSource    = `created_at fallback (${ref.created_at}) — HCS timestamp unavailable`;
  } else {
    atTimestamp = Math.floor(Date.now() / 1000);
    tsSource    = "current time (no timestamp available — uncertainty high)";
  }

  let provider: ethers.JsonRpcProvider | null = null;
  let registry: ethers.Contract | null = null;
  if (EVM_RPC_URL && REGISTRY_ADDRESS) {
    provider = new ethers.JsonRpcProvider(EVM_RPC_URL, undefined, { batchMaxCount: 1 });
    registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_VIEW_ABI, provider);
  }

  // ── 7. On-chain commit path (Phase TEE+5) ────────────────────────────────
  let onChainCommitPath: CommitPath = "UNKNOWN";
  if (provider && ref.contract_tx_hash) {
    onChainCommitPath = await timer.time("contract_commit_path_detection", () => detectCommitPath(provider, ref.contract_tx_hash));
    switch (onChainCommitPath) {
      case "TEE":
        checks.push(pass(
          "on-chain commit path",
          "TEE — hardware-attested ecrecover enforced by contract (MemoryCommittedV4)"
        ));
        break;
      case "VERIFIED":
        checks.push(pass(
          "on-chain commit path",
          "VERIFIED — ecrecover enforced by contract (MemoryCommittedV3)"
        ));
        break;
      case "ATTESTED":
        checks.push(warn(
          "on-chain commit path",
          "ATTESTED — caller-asserted signers, no on-chain ecrecover (MemoryCommittedV2)"
        ));
        break;
      case "LEGACY":
        checks.push(warn(
          "on-chain commit path",
          "LEGACY — no attestation fields stored (MemoryCommitted)"
        ));
        break;
      default:
        checks.push(warn("on-chain commit path", "could not determine path from receipt"));
    }
  } else if (ref.contract_tx_hash) {
    checks.push(warn("on-chain commit path", "HEDERA_EVM_RPC_URL not set — skipping commit path check"));
  }

  // ── 8. On-chain signer timeline (Phase 5 upgrade of Phase 4 check) ────────
  if (agentSignerAddr) {
    if (provider && REGISTRY_ADDRESS) {
      try {
        const isStrict = await registry!.strictAttestationRequired(agentIdBytes32);

        // Phase 5: reconstruct from event history first
        const timeline = await timer.time("signer_timeline_reconstruction", () =>
          reconstructSignerTimeline(
            provider, REGISTRY_ADDRESS, agentIdBytes32, agentSignerAddr, atTimestamp
          )
        );

        if (timeline.validAtTime === null) {
          // Event log query failed — fall back to current on-chain state with warning
          const isValid  = await registry!.isAgentSignerValid(agentIdBytes32, agentSignerAddr, atTimestamp);
          const label    = "agent signer valid at event time";
          const stateMsg = `⚠ signer validity fell back to current contract state (${timeline.warning}) | ${tsSource} | strict: ${isStrict}`;
          checks.push(isValid ? warn(label, stateMsg) : fail(label, `not valid in current state — ${stateMsg}`));
          if (!isValid) overallOk = false;
        } else if (timeline.validAtTime) {
          checks.push(pass(
            "agent signer valid at event time",
            `✓ signer valid from event-history timeline | source: ${timeline.source} | ${tsSource} | strict: ${isStrict}`
          ));
        } else {
          const detail = timeline.warning ?? "signer was not valid at this timestamp according to event history";
          checks.push(fail(
            "agent signer valid at event time",
            `✗ ${detail} | source: ${timeline.source} | ${tsSource} | strict: ${isStrict}`
          ));
          overallOk = false;
        }
      } catch (e) {
        checks.push(warn("agent signer valid at event time", `on-chain query failed: ${(e as Error).message}`));
      }
    } else {
      checks.push(warn(
        "agent signer valid at event time",
        "HEDERA_EVM_RPC_URL or MEMORA_REGISTRY_CONTRACT_ID not set — skipping on-chain check"
      ));
    }
  }

  // ── 9. Fetch raw HCS commit and verify from source ─────────────────────────
  const rawCommit = await timer.time("hcs_raw_fetch", () => fetchHcsCommit(ref.hcs_topic_id || "", ref.hcs_sequence || ""));
  if (rawCommit) {
    // 9a. event_id recomputation
    const eidCheck = verifyEventId(rawCommit);
    checks.push(
      eidCheck.valid
        ? pass("event_id integrity (from HCS)", "sha256 matches commitBase")
        : fail("event_id integrity (from HCS)", eidCheck.reason)
    );
    if (!eidCheck.valid) overallOk = false;

    // 9b. Operator ECDSA signature (from HCS)
    if (rawCommit.signature) {
      if (expectedSigner) {
        const sigCheck = verifyEventEnvelope(rawCommit, parentIds, expectedSigner);
        checks.push(
          sigCheck.valid
            ? pass("off-chain operator signature (from HCS)", `signer: ${sigCheck.recoveredSigner}`)
            : fail("off-chain operator signature (from HCS)", sigCheck.reason)
        );
        if (!sigCheck.valid) overallOk = false;
      } else {
        // No --signer provided: we can recover the signer but cannot confirm it is the
        // authorised operator. Report as a warning (recovering a signer is not proof of
        // authenticity) and prompt the user to pass --signer to actually verify identity.
        const recovered = recoverEnvelopeSigner(rawCommit, parentIds);
        checks.push(warn(
          "off-chain operator signature (from HCS)",
          recovered
            ? `recovered signer ${recovered} — pass --signer <0x...> to verify operator identity`
            : "could not recover signer from signature",
        ));
      }
    } else {
      checks.push(warn("off-chain operator signature (from HCS)", "no signature in HCS commit (pre-Phase-2)"));
    }

    // 9c. Phase 5/TEE: Agent ECDSA signature off-chain verification from HCS raw data
    if (rawCommit.agent_signature && rawCommit.agent_signer) {
      const rawCommitAny = rawCommit as unknown as Record<string, unknown>;
      const rawTeeQuoteHash = rawCommitAny.tee_quote_hash as string | undefined;

      let agentSigResult;
      let domainLabel: string;
      if (rawTeeQuoteHash) {
        // Phase TEE: use TEE domain — tee_quote_hash is part of the signed fields
        const agentTeeFields: AgentTeeCanonicalSigningFields = {
          agent_id:         rawCommit.agent_id,
          agent_signer:     rawCommit.agent_signer,
          parent_event_ids: [...parentIds].sort(),
          payload_hash:     rawCommit.payload_hash?.replace(/^0x/, "") ?? "",
          task_id:          rawCommit.task_id ?? "0x" + "0".repeat(64),
          tee_quote_hash:   rawTeeQuoteHash.replace(/^0x/, ""),
        };
        agentSigResult = verifyAgentTeeSignature(agentTeeFields, rawCommit.agent_signature, rawCommit.agent_signer);
        domainLabel = "TEE domain";
      } else {
        // Phase 5: existing non-TEE domain
        const agentFields: AgentCanonicalSigningFields = {
          agent_id:         rawCommit.agent_id,
          agent_signer:     rawCommit.agent_signer,
          parent_event_ids: [...parentIds].sort(),
          payload_hash:     rawCommit.payload_hash?.replace(/^0x/, "") ?? "",
          task_id:          rawCommit.task_id ?? "0x" + "0".repeat(64),
        };
        agentSigResult = verifyAgentSignature(agentFields, rawCommit.agent_signature, rawCommit.agent_signer);
        domainLabel = "standard domain";
      }
      checks.push(
        agentSigResult.valid
          ? pass(`off-chain agent signature (from HCS, ${domainLabel})`, `signer: ${agentSigResult.recoveredSigner}`)
          : fail(`off-chain agent signature (from HCS, ${domainLabel})`, agentSigResult.reason)
      );
      if (!agentSigResult.valid) overallOk = false;
    } else if (rawCommit.agent_signer && !rawCommit.agent_signature) {
      checks.push(warn("off-chain agent signature (from HCS)", "agent_signer present but agent_signature missing in HCS commit"));
    }

    // 9d. payload_hash format consistency
    const storedHash = ref.payload_hash?.replace(/^0x/, "") ?? "";
    const commitHash = rawCommit.payload_hash?.replace(/^0x/, "") ?? "";
    checks.push(
      storedHash === commitHash
        ? pass("payload_hash consistency", `${storedHash.slice(0, 16)}…`)
        : fail("payload_hash consistency", `index: ${storedHash.slice(0, 12)}… vs HCS: ${commitHash.slice(0, 12)}…`)
    );
    if (storedHash !== commitHash) overallOk = false;
  } else {
    checks.push(warn("HCS commit retrieval", `Could not fetch from mirror node (${MIRROR_URL}). Skipping deep verification.`));
  }

  // ── 10. Merkle batch proof (Phase 6) ────────────────────────────────────────
  if (hasEventId && ref.event_id) {
    const eventIdForBatch = ref.event_id;
    const batchProof = await timer.time("batch_proof_fetch", () => fetchBatchProof(eventIdForBatch));

    if (!batchProof) {
      // Not in a batch — this is fine, per-event verification path still applies
      checks.push(warn("batch checkpoint", "no batch checkpoint found — using per-event verification path"));
    } else {
      // Recompute leaf hash from the indexed memory ref fields
      const leafInput = {
        event_id:         ref.event_id,
        payload_hash:     ref.payload_hash,
        agent_id:         ref.agent_id,
        agent_signer:     refAnyExt.agent_signer as string | null | undefined ?? null,
        operator_signer:  ref.signer              ?? null,
        parent_event_ids: ref.parent_ids           ?? null,
        event_digest:     refAnyExt.event_digest as string | null | undefined ?? null,
        agent_commit_digest: null,
      };
      const recomputedLeaf = computeEventLeafHash(leafInput);

      // 10a. Leaf hash matches stored leaf_hash
      const leafHashMatch = recomputedLeaf.toLowerCase() === batchProof.leaf_hash.toLowerCase();
      checks.push(
        leafHashMatch
          ? pass("event leaf hash valid", `index ${batchProof.leaf_index} in batch ${batchProof.batch_id.slice(0, 8)}…`)
          : fail("event leaf hash valid",
              `recomputed=${recomputedLeaf.slice(0, 16)}… stored=${batchProof.leaf_hash.slice(0, 16)}…`)
      );
      if (!leafHashMatch) overallOk = false;

      // 10b. Merkle proof verifies against batch root
      const proofValid = verifyMerkleProof(
        batchProof.leaf_hash,
        batchProof.merkle_proof,
        batchProof.merkle_root
      );
      checks.push(
        proofValid
          ? pass("Merkle proof valid", `root=${batchProof.merkle_root.slice(0, 16)}…`)
          : fail("Merkle proof valid", "Merkle proof does not verify against batch root — possible tampering")
      );
      if (!proofValid) overallOk = false;

      // 10c. Batch anchor status
      if (batchProof.batch_status === "anchored" && batchProof.hcs_sequence) {
        checks.push(pass(
          "batch root anchored",
          `HCS seq #${batchProof.hcs_sequence} (${batchProof.integrity_mode}) — event ∈ #${batchProof.batch_id.slice(0, 8)}…`
        ));
      } else if (batchProof.batch_status === "pending") {
        checks.push(warn("batch root anchored", `batch ${batchProof.batch_id.slice(0, 8)}… still pending (not yet anchored to HCS)`));
      } else {
        checks.push(warn("batch root anchored", `batch status: ${batchProof.batch_status}`));
      }

      // 10d. Contract anchor (if present)
      if (batchProof.contract_tx_hash) {
        checks.push(pass(
          "batch contract anchor",
          `tx: ${batchProof.contract_tx_hash.slice(0, 18)}…`
        ));
      }
    }
  }

  // ── 11-15. TEE attestation checks ──────────────────────────────────────────
  // All TEE checks emit warn (not fail) when commit path is not TEE — backward compatible.
  const refAnyTee = ref as unknown as Record<string, unknown>;
  const indexedTeeQuoteHash = refAnyTee.tee_quote_hash as string | undefined;
  const indexedTeeQuoteCid  = refAnyTee.tee_quote_cid  as string | undefined;
  const indexedTeePlatform  = refAnyTee.tee_platform   as string | undefined;
  const isTeeCommit = onChainCommitPath === "TEE";

  if (indexedTeeQuoteHash) {
    // 11. TEE quote hash present and well-formed
    const hashOk = /^(0x)?[0-9a-fA-F]{64}$/.test(indexedTeeQuoteHash);
    checks.push(
      hashOk
        ? pass("TEE quote hash present", `${indexedTeeQuoteHash.replace(/^0x/, "").slice(0, 16)}…`)
        : fail("TEE quote hash present", `unexpected format: ${indexedTeeQuoteHash}`)
    );
    if (!hashOk && isTeeCommit) overallOk = false;

    if (hashOk && indexedTeeQuoteCid) {
      // 12-15 require IPFS_GATEWAY_URL and a working MEMORA_TEE_* env
      const ipfsGateway = process.env.IPFS_GATEWAY_URL ?? "https://gateway.pinata.cloud/ipfs/";
      const teeMock     = process.env.MEMORA_TEE_MOCK;
      const teePlatform = process.env.MEMORA_TEE_PLATFORM ?? indexedTeePlatform;

      try {
        // 12. Fetch quote from IPFS and verify hash integrity
        const url = /^https?:\/\//.test(indexedTeeQuoteCid)
          ? indexedTeeQuoteCid
          : `${ipfsGateway.replace(/\/+$/, "")}/${indexedTeeQuoteCid}`;

        let rawQuoteBytes: Buffer;
        try {
          const fetchRes = await fetch(url);
          if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
          rawQuoteBytes = Buffer.from(await fetchRes.arrayBuffer());
        } catch (fetchErr) {
          checks.push(warn("TEE quote IPFS integrity", `fetch failed: ${(fetchErr as Error).message}`));
          throw fetchErr; // skip 13-15
        }

        const { createHash } = await import("crypto");
        const actualHash = createHash("sha256").update(rawQuoteBytes).digest("hex");
        const expectedHash = indexedTeeQuoteHash.replace(/^0x/, "").toLowerCase();
        const hashMatch = actualHash === expectedHash;
        checks.push(
          hashMatch
            ? pass("TEE quote IPFS integrity", `sha256 matches indexed hash ${expectedHash.slice(0, 16)}…`)
            : fail("TEE quote IPFS integrity", `hash mismatch: fetched=${actualHash.slice(0, 16)}… expected=${expectedHash.slice(0, 16)}…`)
        );
        if (!hashMatch) {
          if (isTeeCommit) overallOk = false;
        } else {
          // 13. Cryptographic verification via TeeVerifier
          const claimedSigner = (refAnyTee.agent_signer as string | undefined) ?? "";
          const verifier = createTeeVerifier({
            MEMORA_TEE_MOCK:       teeMock,
            MEMORA_TEE_PLATFORM:   teePlatform,
          });
          const teeResult = await verifier.verifyQuote(rawQuoteBytes, expectedHash, claimedSigner);
          checks.push(
            teeResult.valid
              ? pass("TEE quote cryptographic verification", `platform=${teeResult.platform} measurement=${teeResult.measurement.slice(0, 16)}…`)
              : (isTeeCommit ? fail : warn)("TEE quote cryptographic verification", teeResult.reason ?? "verification failed")
          );
          if (!teeResult.valid && isTeeCommit) overallOk = false;

          if (teeResult.valid) {
            // 14. report_data binding: recovered signer in quote must match agent_signer
            const signerMatch = teeResult.agent_signer.toLowerCase() === claimedSigner.toLowerCase();
            checks.push(
              signerMatch
                ? pass("TEE report_data binding", `quote binds ${teeResult.agent_signer.slice(0, 12)}… (matches agent_signer)`)
                : fail("TEE report_data binding", `quote binds ${teeResult.agent_signer.slice(0, 12)}… but agent_signer is ${claimedSigner.slice(0, 12)}…`)
            );
            if (!signerMatch && isTeeCommit) overallOk = false;

            // 15. On-chain teeQuoteHash matches indexed value
            if (provider && REGISTRY_ADDRESS && ref.memory_id) {
              try {
                const onChainMemory = await registry!.getMemory(ref.memory_id);
                const onChainTeeHash = String(onChainMemory[10] ?? "");
                const normalizedOnChain  = onChainTeeHash.replace(/^0x/, "").toLowerCase();
                const normalizedIndexed  = indexedTeeQuoteHash.replace(/^0x/, "").toLowerCase();
                const hashConsistent = normalizedOnChain === normalizedIndexed ||
                  normalizedOnChain === "0".repeat(64); // zero = not stored (pre-TEE)
                checks.push(
                  hashConsistent
                    ? pass("on-chain teeQuoteHash match", `contract: ${normalizedOnChain.slice(0, 16)}…`)
                    : fail("on-chain teeQuoteHash match",
                        `contract: ${normalizedOnChain.slice(0, 16)}… ≠ indexed: ${normalizedIndexed.slice(0, 16)}…`)
                );
                if (!hashConsistent && isTeeCommit) overallOk = false;
              } catch (e) {
                checks.push(warn("on-chain teeQuoteHash match", `on-chain query failed: ${(e as Error).message}`));
              }
            } else {
              checks.push(warn("on-chain teeQuoteHash match", "HEDERA_EVM_RPC_URL not set — skipping on-chain hash check"));
            }
          }
        }
      } catch {
        // fetchErr already handled above; other errors are internal
      }
    } else if (!indexedTeeQuoteCid) {
      checks.push(warn("TEE quote IPFS integrity", "tee_quote_cid not in index — cannot verify IPFS fetch"));
    }
  } else if (isTeeCommit) {
    // On-chain says TEE but index has no tee_quote_hash — index is stale or corrupted
    checks.push(fail("TEE quote hash present", "on-chain commit is TEE (V4) but tee_quote_hash missing from index"));
    overallOk = false;
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  printChecks(checks);
  const passed = checks.filter((c) => c.ok).length;
  const total  = checks.length;
  console.log(`\n  ${passed}/${total} checks passed`);

  if (!overallOk) {
    console.log("\n  REPLAY VERDICT: INTEGRITY CONCERN — review failed checks above\n");
  } else {
    console.log("\n  REPLAY VERDICT: CONSISTENT with indexed provenance\n");
  }

  if (!overallOk) process.exit(1);
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

async function main() {
  if (!isSupportedPlatform()) {
    console.error(unsupportedPlatformMessage());
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const cmd  = args[0];
  const sub  = args[1];

  if (!cmd) {
    console.log("Usage: memora <command> [options]");
    console.log("  memora write  --agent <id> --file payload.json");
    console.log("  memora query  --agent <id>");
    console.log("  memora read   --memory <id>");
    console.log("  memora receipt <id>");
    console.log("  memora verify <id>");
    console.log("  memora replay verify --memory <id> [--signer <0x...>]");
    console.log("  memora local init");
    console.log("  memora local run -- <command> [args...]");
    console.log("  memora local sessions");
    console.log("  memora local show <session-id>");
    console.log("  memora local verify <session-id>");
    console.log("  memora local export <session-id> --out evidence.memora [--disclose]");
    console.log("  memora local publish <session-id>|<bundle-path> [--open]");
    console.log("  memora local unpublish <publication-id> | --session <session-id>");
    console.log("  memora local receipt <session-id> --out receipt.html");
    console.log("  memora local verify-bundle <path>");
    console.log("  memora local doctor --provider codex|claude [--json]");
    console.log("  memora local hook --provider codex|claude|vscode|cursor  # integration use");
    console.log("  memora local install-hooks --provider codex|claude");
    console.log("  memora local uninstall-hooks --provider codex|claude");
    console.log("  memora daemon start|stop|status|logs");
    process.exit(1);
  }

  const getArg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const hasFlag = (name: string) => args.includes(name);

  try {
    if (cmd === "local" && sub === "init") {
      await cmdLocalInit();
    } else if (cmd === "local" && sub === "run") {
      const separator = args.indexOf("--");
      if (separator < 0 || separator === args.length - 1) throw new Error("usage: memora local run -- <command> [args...]");
      await cmdLocalRun(args.slice(separator + 1));
    } else if (cmd === "local" && sub === "sessions") {
      await cmdLocalSessions();
    } else if (cmd === "local" && sub === "show") {
      const session = args[2];
      if (!session) throw new Error("<session-id> required");
      await cmdLocalShow(session);
    } else if (cmd === "local" && sub === "verify") {
      const session = args[2];
      if (!session) throw new Error("<session-id> required");
      await cmdLocalVerify(session);
    } else if (cmd === "local" && sub === "export") {
      const session = args[2];
      const output = getArg("--out");
      if (!session || !output) throw new Error("<session-id> and --out required");
      await cmdLocalExport(session, output, hasFlag("--disclose"));
    } else if (cmd === "local" && sub === "publish") {
      const source = args[2];
      if (!source) throw new Error("<session-id>|<bundle-path> required");
      await cmdLocalPublish(source, hasFlag("--open"));
    } else if (cmd === "local" && sub === "unpublish") {
      const positional = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
      await cmdLocalUnpublish(positional, getArg("--session"));
    } else if (cmd === "local" && sub === "receipt") {
      const session = args[2];
      const output = getArg("--out");
      if (!session || !output) throw new Error("<session-id> and --out required");
      await cmdLocalReceipt(session, output);
    } else if (cmd === "local" && sub === "verify-bundle") {
      const path = args[2];
      if (!path) throw new Error("<path> required");
      await cmdLocalVerifyBundle(path);
    } else if (cmd === "local" && sub === "hook") {
      const provider = getArg("--provider");
      if (!provider) throw new Error("--provider required");
      await cmdLocalHook(provider);
    } else if (cmd === "local" && sub === "install-hooks") {
      const provider = getArg("--provider");
      if (!provider) throw new Error("--provider required");
      await cmdLocalInstallHooks(provider);
    } else if (cmd === "local" && sub === "uninstall-hooks") {
      const provider = getArg("--provider");
      if (!provider) throw new Error("--provider required");
      await cmdLocalUninstallHooks(provider);
    } else if (cmd === "local" && sub === "doctor") {
      await cmdLocalDoctor(getArg("--provider") ?? "codex", hasFlag("--json"));
    } else if (cmd === "daemon" && sub === "start") {
      await cmdDaemonStart();
    } else if (cmd === "daemon" && sub === "stop") {
      await cmdDaemonStop();
    } else if (cmd === "daemon" && sub === "status") {
      await cmdDaemonStatus();
    } else if (cmd === "daemon" && sub === "logs") {
      await cmdDaemonLogs();
    } else if (cmd === "daemon" && sub === "run-internal") {
      await cmdDaemonRunInternal();
    } else if (cmd === "write") {
      const agent = getArg("--agent");
      const file  = getArg("--file");
      if (!agent || !file) throw new Error("--agent and --file required");
      await cmdWrite(agent, file);
    } else if (cmd === "query") {
      const agent = getArg("--agent");
      if (!agent) throw new Error("--agent required");
      await cmdQuery(agent);
    } else if (cmd === "read") {
      const memory = getArg("--memory");
      if (!memory) throw new Error("--memory required");
      await cmdRead(memory);
    } else if (cmd === "receipt") {
      const id = getLookupId(args, 1);
      if (!id) throw new Error("<id> or --memory required");
      await cmdReceipt(id);
    } else if (cmd === "verify") {
      const id = getLookupId(args, 1);
      const signer = getArg("--signer");
      if (!id) throw new Error("<id> or --memory required");
      await cmdVerify(id, { signer });
    } else if (cmd === "replay" && sub === "verify") {
      const memory           = getArg("--memory");
      const signer           = getArg("--signer");
      if (!memory) throw new Error("--memory required");
      await cmdReplayVerify(memory, signer);
    } else {
      throw new Error(`Unknown command: ${cmd}${sub ? " " + sub : ""}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

main();
