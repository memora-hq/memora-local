import { describe, expect, it } from "vitest";
import { buildMacDialogScript, parseMacDialogOutput } from "./macDialogScript.js";

describe("buildMacDialogScript", () => {
  it("embeds the escaped subject and reason in the dialog message", () => {
    const script = buildMacDialogScript(
      { category: "file_write", subject: "/repo/a.ts", reason: 'blocked "write"' },
      60,
    );
    expect(script).toContain("/repo/a.ts");
    expect(script).toContain('blocked \\"write\\"');
  });

  it("includes the Memora title and Deny/Allow buttons", () => {
    const script = buildMacDialogScript({ category: "shell_exec", subject: "ls", reason: "x" }, 60);
    expect(script).toContain('with title "Memora Guardrail"');
    expect(script).toContain('buttons {"Deny", "Allow"}');
    expect(script).toContain('default button "Deny"');
  });

  it("includes the timeout as giving up after <n>", () => {
    const script = buildMacDialogScript({ category: "shell_exec", subject: "ls", reason: "x" }, 42);
    expect(script).toContain("giving up after 42");
  });
});

describe("parseMacDialogOutput", () => {
  it("returns approved for button returned:Allow", () => {
    expect(parseMacDialogOutput("button returned:Allow, gave up:false\n")).toEqual({ approved: true });
  });

  it("returns denied for button returned:Deny", () => {
    expect(parseMacDialogOutput("button returned:Deny, gave up:false\n")).toEqual({
      approved: false,
      reason: "denied",
    });
  });

  it("returns timeout when gave up:true, even though button returned is empty", () => {
    expect(parseMacDialogOutput("button returned:, gave up:true\n")).toEqual({
      approved: false,
      reason: "timeout",
    });
  });

  it("returns no_display for empty output", () => {
    expect(parseMacDialogOutput("")).toEqual({ approved: false, reason: "no_display" });
  });

  it("returns no_display for unrecognized output", () => {
    expect(parseMacDialogOutput("some unexpected error text")).toEqual({ approved: false, reason: "no_display" });
  });
});
