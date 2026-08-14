import { spawn } from "node:child_process";
import { buildWindowsDialogScript, parseWindowsDialogExitCode } from "./windowsDialogScript.js";
import type { ApprovalOutcome, ApprovalRequest } from "./macDialogScript.js";

const TIMEOUT_MS = 60_000;

export function showWindowsDialog(request: ApprovalRequest): Promise<ApprovalOutcome> {
  return new Promise((resolvePromise) => {
    const script = buildWindowsDialogScript(request, TIMEOUT_MS);
    try {
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", () => resolvePromise({ approved: false, reason: "no_display" }));
      child.on("close", (code) => resolvePromise(parseWindowsDialogExitCode(code ?? -1)));
    } catch {
      resolvePromise({ approved: false, reason: "no_display" });
    }
  });
}
