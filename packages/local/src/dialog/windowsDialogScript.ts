import { escapePowerShellString } from "./escaping.js";
import type { ApprovalOutcome, ApprovalRequest } from "./macDialogScript.js";

const IDYES = 6;
const IDNO = 7;
const IDTIMEOUT = 32000;
// MB_YESNO (0x4) | MB_ICONWARNING (0x30) | MB_SYSTEMMODAL (0x1000)
const MESSAGEBOX_STYLE = 0x00001034;

function dialogMessage(request: ApprovalRequest): string {
  return `Memora blocked a ${request.category} action.\n\nSubject: ${request.subject}\nReason: ${request.reason}`;
}

export function buildWindowsDialogScript(request: ApprovalRequest, timeoutMs: number): string {
  const message = escapePowerShellString(dialogMessage(request));
  const title = escapePowerShellString("Memora Guardrail");
  return [
    "Add-Type -TypeDefinition '",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class MemoraGuardrailDialog {",
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)]',
    "  public static extern int MessageBoxTimeout(IntPtr hWnd, string text, string caption, uint options, short languageId, int milliseconds);",
    "}';",
    `[MemoraGuardrailDialog]::MessageBoxTimeout([IntPtr]::Zero, '${message}', '${title}', ${MESSAGEBOX_STYLE}, 0, ${timeoutMs})`,
    "exit $LASTEXITCODE",
  ].join("\n");
}

export function parseWindowsDialogExitCode(code: number): ApprovalOutcome {
  if (code === IDYES) return { approved: true };
  if (code === IDNO) return { approved: false, reason: "denied" };
  if (code === IDTIMEOUT) return { approved: false, reason: "timeout" };
  return { approved: false, reason: "no_display" };
}
