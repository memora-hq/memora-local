import { describe, expect, it } from "vitest";
import { buildWindowsDialogScript, parseWindowsDialogExitCode } from "./windowsDialogScript.js";

describe("buildWindowsDialogScript", () => {
  it("embeds the escaped subject and reason in the dialog message", () => {
    const script = buildWindowsDialogScript(
      { category: "file_write", subject: "C:\\repo\\a.ts", reason: "it's blocked" },
      60000,
    );
    expect(script).toContain("C:\\repo\\a.ts");
    expect(script).toContain("it''s blocked");
  });

  it("includes the Memora title", () => {
    const script = buildWindowsDialogScript({ category: "shell_exec", subject: "dir", reason: "x" }, 60000);
    expect(script).toContain("Memora Guardrail");
  });

  it("includes the timeout in milliseconds", () => {
    const script = buildWindowsDialogScript({ category: "shell_exec", subject: "dir", reason: "x" }, 12345);
    expect(script).toContain("12345");
  });

  it("references MessageBoxTimeout", () => {
    const script = buildWindowsDialogScript({ category: "shell_exec", subject: "dir", reason: "x" }, 60000);
    expect(script).toContain("MessageBoxTimeout");
  });
});

describe("parseWindowsDialogExitCode", () => {
  it("returns approved for IDYES (6)", () => {
    expect(parseWindowsDialogExitCode(6)).toEqual({ approved: true });
  });

  it("returns denied for IDNO (7)", () => {
    expect(parseWindowsDialogExitCode(7)).toEqual({ approved: false, reason: "denied" });
  });

  it("returns timeout for IDTIMEOUT (32000)", () => {
    expect(parseWindowsDialogExitCode(32000)).toEqual({ approved: false, reason: "timeout" });
  });

  it("returns no_display for an unexpected code", () => {
    expect(parseWindowsDialogExitCode(1)).toEqual({ approved: false, reason: "no_display" });
    expect(parseWindowsDialogExitCode(-1)).toEqual({ approved: false, reason: "no_display" });
  });
});
