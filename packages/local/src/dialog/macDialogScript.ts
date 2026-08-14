import { escapeAppleScriptString } from "./escaping.js";
import type { RuleCategory } from "../rules/schema.js";

export interface ApprovalRequest {
  category: RuleCategory;
  subject: string;
  reason: string;
}

export type ApprovalOutcome =
  | { approved: true }
  | { approved: false; reason: "denied" | "timeout" | "no_display" };

function dialogMessage(request: ApprovalRequest): string {
  return `Memora blocked a ${request.category} action.\n\nSubject: ${request.subject}\nReason: ${request.reason}`;
}

export function buildMacDialogScript(request: ApprovalRequest, timeoutSeconds: number): string {
  const message = escapeAppleScriptString(dialogMessage(request));
  return `display dialog "${message}" with title "Memora Guardrail" buttons {"Deny", "Allow"} default button "Deny" giving up after ${timeoutSeconds}`;
}

export function parseMacDialogOutput(stdout: string): ApprovalOutcome {
  if (stdout.includes("gave up:true")) return { approved: false, reason: "timeout" };
  if (stdout.includes("button returned:Allow")) return { approved: true };
  if (stdout.includes("button returned:Deny")) return { approved: false, reason: "denied" };
  return { approved: false, reason: "no_display" };
}
