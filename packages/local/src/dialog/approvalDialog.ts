import { showMacDialog } from "./macDialog.js";
import { showWindowsDialog } from "./windowsDialog.js";
import type { ApprovalOutcome, ApprovalRequest } from "./macDialogScript.js";

export type { ApprovalOutcome, ApprovalRequest } from "./macDialogScript.js";

export function requestApproval(
  request: ApprovalRequest,
  platform: NodeJS.Platform = process.platform,
): Promise<ApprovalOutcome> {
  if (platform === "darwin") return showMacDialog(request);
  if (platform === "win32") return showWindowsDialog(request);
  return Promise.resolve({ approved: false, reason: "no_display" });
}
