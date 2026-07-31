import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalHookSpool } from "./hookTransport.js";
import { LocalEvidenceStore, verifySession, FileKeyProvider } from "@smritheon/memora-verifier";
import { getAdapter } from "./adapters/registry.js";

export type DiagnosticProvider = string;
export type IntegrationHealth = "not_installed" | "needs_attention" | "ready" | "capturing";
export type DiagnosticCheckStatus = "passed" | "warning" | "failed";

export interface IntegrationDiagnosticCheck {
  id: "cli" | "configuration" | "runtime" | "trust" | "synthetic" | "verification" | "recent_event";
  label: string;
  status: DiagnosticCheckStatus;
  detail: string;
}

export interface IntegrationRuntime {
  kind: "terminal" | "desktop";
  path: string;
  version?: string;
}

export interface IntegrationDiagnosticResult {
  provider: DiagnosticProvider;
  status: IntegrationHealth;
  checked_at: string;
  checks: IntegrationDiagnosticCheck[];
  runtimes: IntegrationRuntime[];
  remediation: string[];
  last_real_event_at: string | null;
  warnings: string[];
}

export interface HookConfigurationAnalysis {
  valid: boolean;
  handlerCount: number;
  missingEvents: string[];
  duplicateEvents: string[];
  staleEvents: string[];
}

type HookConfig = {
  hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>;
};

export function analyzeHookConfiguration(
  config: HookConfig,
  provider: DiagnosticProvider,
  cliPath: string,
  dataRoot: string,
): HookConfigurationAnalysis {
  const missingEvents: string[] = [];
  const duplicateEvents: string[] = [];
  const staleEvents: string[] = [];
  let handlerCount = 0;
  for (const event of getAdapter(provider)?.expectedEvents ?? []) {
    const handlers = (config.hooks?.[event] ?? [])
      .flatMap((group) => group.hooks ?? [])
      .filter((handler) => handler.command?.includes(`local hook --provider ${provider}`));
    handlerCount += handlers.length;
    if (!handlers.length) missingEvents.push(event);
    if (handlers.length > 1) duplicateEvents.push(event);
    if (handlers.some((handler) =>
      handler.type !== "command"
      || !handler.command?.includes(JSON.stringify(cliPath))
      || !handler.command?.includes(JSON.stringify(dataRoot))
    )) staleEvents.push(event);
  }
  return {
    valid: !missingEvents.length && !duplicateEvents.length && !staleEvents.length,
    handlerCount,
    missingEvents,
    duplicateEvents,
    staleEvents,
  };
}

async function runProcess(
  executable: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 5_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

async function executableVersion(path: string): Promise<string | undefined> {
  try {
    const result = await runProcess(path, ["--version"], { timeoutMs: 3_000 });
    const version = (result.stdout || result.stderr).trim().split("\n").pop();
    return version || undefined;
  } catch {
    return undefined;
  }
}

async function detectRuntimes(provider: DiagnosticProvider, candidates: string[]): Promise<IntegrationRuntime[]> {
  const runtimes: IntegrationRuntime[] = [];
  const seen = new Set<string>();
  for (const path of candidates) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    try {
      await access(path, constants.X_OK);
      runtimes.push({
        kind: path.includes(".app/Contents/") ? "desktop" : "terminal",
        path,
        version: await executableVersion(path),
      });
    } catch {
      // Candidate is not installed.
    }
  }
  return runtimes;
}

type CodexHookMetadata = {
  command?: string | null;
  enabled?: boolean;
  trustStatus?: "managed" | "untrusted" | "trusted" | "modified";
};

async function listCodexHooks(runtime: string, cwd: string): Promise<{
  hooks: CodexHookMetadata[];
  warnings: string[];
  errors: string[];
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex hook inspection timed out${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`));
    }, 7_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: { data?: Array<{ hooks?: CodexHookMetadata[]; warnings?: string[]; errors?: Array<{ message?: string }> }> };
          };
          if (message.id !== 2) continue;
          clearTimeout(timer);
          child.kill();
          const entries = message.result?.data ?? [];
          resolve({
            hooks: entries.flatMap((entry) => entry.hooks ?? []),
            warnings: entries.flatMap((entry) => entry.warnings ?? []),
            errors: entries.flatMap((entry) => (entry.errors ?? []).map((error) => error.message ?? "Unknown hook error")),
          });
          return;
        } catch {
          // Wait for a complete JSON line.
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin.write(`${JSON.stringify({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "memora-diagnostic", title: "Memora diagnostic", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ method: "hooks/list", id: 2, params: { cwds: [cwd] } })}\n`);
  });
}

async function runSyntheticDiagnostic(cliPath: string, provider: DiagnosticProvider): Promise<{
  accepted: boolean;
  verified: boolean;
  detail: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "memora-diagnostic-"));
  const dataRoot = join(root, "data");
  const spoolRoot = join(root, "spool");
  try {
    const payload = {
      session_id: `memora-diagnostic-${Date.now()}`,
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      diagnostic: true,
    };
    const command = await runProcess(cliPath, ["local", "hook", "--provider", provider], {
      input: JSON.stringify(payload),
      env: { ...process.env, MEMORA_LOCAL_HOOK_SPOOL: spoolRoot, MEMORA_LOCAL_DATA_DIR: dataRoot },
      timeoutMs: 5_000,
    });
    if (command.code !== 0) {
      return { accepted: false, verified: false, detail: `Hook command exited ${command.code ?? "without a status"}` };
    }
    const drainer = await startLocalHookSpool(dataRoot, spoolRoot, 10_000);
    await drainer.drain();
    drainer.close();
    const store = new LocalEvidenceStore(dataRoot);
    const sessions = await store.listSessions();
    if (sessions.length !== 1) return { accepted: true, verified: false, detail: "Synthetic hook did not create one isolated session" };
    const identity = await new FileKeyProvider(join(dataRoot, "identity", "local-key.json")).load() ?? undefined;
    const verification = await verifySession(store, sessions[0].session_id, identity);
    return {
      accepted: true,
      verified: verification.valid,
      detail: verification.valid ? "Synthetic hook produced verified local evidence" : "Synthetic evidence verification failed",
    };
  } catch (error) {
    return { accepted: false, verified: false, detail: (error as Error).message };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function lastRealEvent(dataRoot: string, provider: DiagnosticProvider): Promise<string | null> {
  const sessions = await new LocalEvidenceStore(dataRoot).listSessions();
  const matching = sessions.filter((manifest) => manifest.capture_source === `${provider}-hooks`);
  return matching[0]?.started_at ?? null;
}

export interface RunIntegrationDiagnosticOptions {
  provider: DiagnosticProvider;
  dataRoot: string;
  cliPath: string;
  hookConfigPath: string;
  runtimeCandidates: string[];
  cwd?: string;
  now?: Date;
}

export async function runIntegrationDiagnostic(options: RunIntegrationDiagnosticOptions): Promise<IntegrationDiagnosticResult> {
  const checkedAt = (options.now ?? new Date()).toISOString();
  const checks: IntegrationDiagnosticCheck[] = [];
  const remediation: string[] = [];
  const warnings: string[] = [];

  let cliReady = false;
  try {
    await access(options.cliPath, constants.X_OK);
    const result = await runProcess(options.cliPath, ["--help"], { timeoutMs: 5_000 });
    cliReady = result.code === 0 || result.code === 1;
  } catch {
    cliReady = false;
  }
  checks.push({
    id: "cli",
    label: "Memora CLI",
    status: cliReady ? "passed" : "failed",
    detail: cliReady ? `Executable at ${options.cliPath}` : "Memora CLI is missing or cannot execute",
  });
  if (!cliReady) remediation.push("Install the Memora command-line tool.");

  let configurationValid = false;
  try {
    const config = JSON.parse(await readFile(options.hookConfigPath, "utf8")) as HookConfig;
    const analysis = analyzeHookConfiguration(config, options.provider, options.cliPath, options.dataRoot);
    configurationValid = analysis.valid;
    const problems = [
      analysis.missingEvents.length ? `missing: ${analysis.missingEvents.join(", ")}` : "",
      analysis.duplicateEvents.length ? `duplicates: ${analysis.duplicateEvents.join(", ")}` : "",
      analysis.staleEvents.length ? `stale: ${analysis.staleEvents.join(", ")}` : "",
    ].filter(Boolean);
    checks.push({
      id: "configuration",
      label: "Lifecycle configuration",
      status: analysis.valid ? "passed" : "failed",
      detail: analysis.valid ? `${analysis.handlerCount} current handlers installed` : problems.join("; "),
    });
  } catch (error) {
    checks.push({
      id: "configuration",
      label: "Lifecycle configuration",
      status: "failed",
      detail: `Cannot read a valid hook configuration: ${(error as Error).message}`,
    });
  }
  if (!configurationValid) remediation.push("Reinstall this integration from Memora Agent connections.");

  const runtimes = await detectRuntimes(options.provider, options.runtimeCandidates);
  checks.push({
    id: "runtime",
    label: "Agent runtime",
    status: runtimes.length ? "passed" : "failed",
    detail: runtimes.length
      ? runtimes.map((runtime) => `${runtime.kind}: ${runtime.version ?? runtime.path}`).join("; ")
      : `${options.provider === "codex" ? "Codex" : "Claude"} runtime not detected`,
  });
  if (!runtimes.length) remediation.push(`Install ${options.provider === "codex" ? "Codex" : "Claude Code"}.`);

  let trustReady = options.provider === "claude";
  if (options.provider === "codex" && runtimes.length) {
    try {
      const inspected = await listCodexHooks(runtimes.find((runtime) => runtime.kind === "desktop")?.path ?? runtimes[0].path, options.cwd ?? process.cwd());
      warnings.push(...inspected.warnings, ...inspected.errors);
      const memoraHooks = inspected.hooks.filter((hook) => hook.command?.includes("local hook --provider codex"));
      trustReady = memoraHooks.length > 0 && memoraHooks.every((hook) => hook.enabled && ["trusted", "managed"].includes(hook.trustStatus ?? ""));
      const statuses = [...new Set(memoraHooks.map((hook) => hook.trustStatus ?? "unknown"))];
      checks.push({
        id: "trust",
        label: "Codex hook trust",
        status: trustReady ? "passed" : "failed",
        detail: memoraHooks.length ? `${memoraHooks.length} handlers: ${statuses.join(", ")}` : "Codex did not discover the Memora hooks",
      });
    } catch (error) {
      checks.push({
        id: "trust",
        label: "Codex hook trust",
        status: "warning",
        detail: `Could not inspect Codex trust: ${(error as Error).message}`,
      });
      warnings.push("Codex trust could not be inspected.");
    }
    if (!trustReady) remediation.push("In Codex, open /hooks, review the Memora commands, and choose Trust.");
  } else if (options.provider === "claude") {
    checks.push({
      id: "trust",
      label: "Hook enablement",
      status: configurationValid ? "passed" : "warning",
      detail: "Claude does not expose Codex-style hook trust inspection",
    });
  }

  const synthetic = cliReady ? await runSyntheticDiagnostic(options.cliPath, options.provider) : {
    accepted: false,
    verified: false,
    detail: "Skipped because the Memora CLI is unavailable",
  };
  checks.push({
    id: "synthetic",
    label: "Synthetic hook",
    status: synthetic.accepted ? "passed" : "failed",
    detail: synthetic.accepted ? "Privacy-safe hook accepted in an isolated store" : synthetic.detail,
  });
  checks.push({
    id: "verification",
    label: "Evidence verification",
    status: synthetic.verified ? "passed" : "failed",
    detail: synthetic.detail,
  });

  const recentAt = await lastRealEvent(options.dataRoot, options.provider);
  const recent = recentAt !== null && (options.now ?? new Date()).getTime() - new Date(recentAt).getTime() <= 5 * 60_000;
  checks.push({
    id: "recent_event",
    label: "Recent real event",
    status: recent ? "passed" : "warning",
    detail: recentAt ? `Last captured at ${recentAt}` : "No real provider event has been captured",
  });
  if (!recent) remediation.push(`After resolving the checks above, perform one ${options.provider === "codex" ? "Codex" : "Claude"} action and retest.`);

  const requiredFailed = checks.some((check) => check.status === "failed");
  const installed = cliReady || configurationValid || runtimes.length > 0;
  const status: IntegrationHealth = !installed
    ? "not_installed"
    : requiredFailed || !trustReady
      ? "needs_attention"
      : recent
        ? "capturing"
        : "ready";
  return {
    provider: options.provider,
    status,
    checked_at: checkedAt,
    checks,
    runtimes,
    remediation: [...new Set(remediation)],
    last_real_event_at: recentAt,
    warnings: [...new Set(warnings)].map((warning) => warning.replace(/[\r\n]+/g, " ").slice(0, 500)),
  };
}
