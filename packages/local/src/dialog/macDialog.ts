import { spawn } from "node:child_process";
import { buildMacDialogScript, parseMacDialogOutput, type ApprovalOutcome, type ApprovalRequest } from "./macDialogScript.js";

const TIMEOUT_SECONDS = 60;

export function showMacDialog(request: ApprovalRequest): Promise<ApprovalOutcome> {
  return new Promise((resolvePromise) => {
    const script = buildMacDialogScript(request, TIMEOUT_SECONDS);
    let stdout = "";
    try {
      const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.on("error", () => resolvePromise({ approved: false, reason: "no_display" }));
      child.on("close", () => resolvePromise(parseMacDialogOutput(stdout)));
    } catch {
      resolvePromise({ approved: false, reason: "no_display" });
    }
  });
}
