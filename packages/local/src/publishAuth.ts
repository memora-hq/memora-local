import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Publishing is login-gated (existing Google/GitHub SSO); no other command needs an account.
 * The session token is stored once and reused — only the first publish on a machine pays the
 * auth cost.
 */
export function publishSessionPath(dataRoot: string): string {
  return join(dataRoot, "identity", "publish-session.json");
}

export interface PublishSession {
  token: string;
  email?: string;
}

export async function loadPublishSession(dataRoot: string): Promise<PublishSession | null> {
  try {
    return JSON.parse(await readFile(publishSessionPath(dataRoot), "utf8")) as PublishSession;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function savePublishSession(dataRoot: string, session: PublishSession): Promise<void> {
  const path = publishSessionPath(dataRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(session), { mode: 0o600 });
}

export async function clearPublishSession(dataRoot: string): Promise<void> {
  await unlink(publishSessionPath(dataRoot)).catch(() => undefined);
}

/** Best-effort: opens a URL in the default browser. Never throws — the caller always prints the URL too. */
export function openUrlInBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Silent — the caller is responsible for printing the URL as a fallback.
  }
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
}

interface DeviceTokenResponse {
  status: "authorized" | "pending" | "expired" | "denied";
  token?: string;
  email?: string;
}

export interface EnsurePublishLoginOptions {
  dataRoot: string;
  baseUrl: string;
  /** Called once the user needs to visit a URL and enter a code. */
  onPrompt: (info: { verificationUrl: string; userCode: string }) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Returns a bearer token for the publish API, reusing a stored session if one exists. If not,
 * runs a device-authorization flow: request a code, show it to the user, open (and print) the
 * verification URL, then poll until the user completes sign-in in their browser or the code
 * expires. Never itself collects a password — sign-in happens entirely on the server's page.
 */
export async function ensurePublishLogin(options: EnsurePublishLoginOptions): Promise<string> {
  const existing = await loadPublishSession(options.dataRoot);
  if (existing) return existing.token;

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const codeResponse = await fetchImpl(`${options.baseUrl}/api/v1/auth/device`, { method: "POST" });
  if (!codeResponse.ok) throw new Error(`Could not start sign-in (HTTP ${codeResponse.status}).`);
  const code = (await codeResponse.json()) as DeviceCodeResponse;

  const verificationUrl = code.verification_uri_complete ?? code.verification_uri;
  options.onPrompt({ verificationUrl, userCode: code.user_code });
  openUrlInBrowser(verificationUrl);

  const intervalMs = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const tokenResponse = await fetchImpl(`${options.baseUrl}/api/v1/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: code.device_code }),
    });
    const result = (await tokenResponse.json()) as DeviceTokenResponse;
    if (result.status === "authorized" && result.token) {
      const session: PublishSession = { token: result.token, ...(result.email ? { email: result.email } : {}) };
      await savePublishSession(options.dataRoot, session);
      return session.token;
    }
    if (result.status === "expired" || result.status === "denied") {
      throw new Error(`Sign-in ${result.status}. Run the publish command again to retry.`);
    }
    // "pending" — keep polling.
  }
  throw new Error("Sign-in timed out. Run the publish command again to retry.");
}
