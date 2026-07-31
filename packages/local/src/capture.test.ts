import { describe, expect, it } from "vitest";
import { isSecretPath } from "./capture.js";

describe("isSecretPath", () => {
  it("matches the file names the capture layer refuses to read", () => {
    for (const path of [".env", ".env.local", "key.pem", "server.p12", "client.pfx", "id.key", "credentials.json", "src/credential-helper.ts"]) {
      expect(isSecretPath(path)).toBe(true);
    }
  });

  it("leaves ordinary source files alone", () => {
    for (const path of ["README.md", "src/keyboard.ts", "packages/shared/src/envelope.ts", "environment.md", "index.ts"]) {
      expect(isSecretPath(path)).toBe(false);
    }
  });

  it("tests the file name, not the directory it sits in", () => {
    expect(isSecretPath("credentials/app.ts")).toBe(false);
    expect(isSecretPath("config/.env.production")).toBe(true);
  });
});
