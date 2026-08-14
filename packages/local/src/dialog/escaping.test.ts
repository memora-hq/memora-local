import { describe, expect, it } from "vitest";
import { escapeAppleScriptString, escapePowerShellString } from "./escaping.js";

describe("escapeAppleScriptString", () => {
  it("escapes double quotes", () => {
    expect(escapeAppleScriptString('say "hi"')).toBe('say \\"hi\\"');
  });

  it("escapes backslashes before quotes so escaping isn't doubled", () => {
    expect(escapeAppleScriptString('a\\"b')).toBe('a\\\\\\"b');
  });

  it("replaces newlines and carriage returns with a space", () => {
    expect(escapeAppleScriptString("line1\nline2\r\nline3")).toBe("line1 line2 line3");
  });

  it("leaves shell metacharacters untouched (they are inert once embedded in the AppleScript literal)", () => {
    const input = "rm -rf ~; $(whoami) `id`";
    expect(escapeAppleScriptString(input)).toBe(input);
  });

  it("is a no-op for a plain string", () => {
    expect(escapeAppleScriptString("/repo/src/a.ts")).toBe("/repo/src/a.ts");
  });
});

describe("escapePowerShellString", () => {
  it("doubles single quotes", () => {
    expect(escapePowerShellString("it's a test")).toBe("it''s a test");
  });

  it("doubles multiple single quotes", () => {
    expect(escapePowerShellString("'a' and 'b'")).toBe("''a'' and ''b''");
  });

  it("leaves shell metacharacters untouched", () => {
    const input = "rm -rf ~; $(whoami) `id`";
    expect(escapePowerShellString(input)).toBe(input);
  });

  it("is a no-op for a plain string", () => {
    expect(escapePowerShellString("C:\\repo\\src\\a.ts")).toBe("C:\\repo\\src\\a.ts");
  });
});
