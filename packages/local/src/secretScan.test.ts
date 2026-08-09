import { describe, expect, it } from "vitest";
import { scanForSecrets, scanTextForSecrets } from "./secretScan.js";

describe("scanTextForSecrets — block rules", () => {
  it("blocks an AWS access key ID", () => {
    const findings = scanTextForSecrets("export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "event");
    expect(findings.some((f) => f.ruleId === "aws_access_key_id" && f.severity === "block")).toBe(true);
  });

  it("blocks a GitHub personal access token", () => {
    const findings = scanTextForSecrets("ghp_" + "a".repeat(36), "event");
    expect(findings.some((f) => f.ruleId === "github_token" && f.severity === "block")).toBe(true);
  });

  it("blocks an OpenAI-style API key", () => {
    const findings = scanTextForSecrets("sk-proj-" + "a1B2c3D4e5F6g7H8".repeat(2), "event");
    expect(findings.some((f) => f.ruleId === "openai_api_key" && f.severity === "block")).toBe(true);
  });

  it("blocks an Anthropic-style API key", () => {
    const findings = scanTextForSecrets("sk-ant-" + "a1B2c3D4e5F6g7H8".repeat(2), "event");
    expect(findings.some((f) => f.ruleId === "anthropic_api_key" && f.severity === "block")).toBe(true);
  });

  it("blocks a PEM private key header", () => {
    const findings = scanTextForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEow...", "event");
    expect(findings.some((f) => f.ruleId === "private_key_pem" && f.severity === "block")).toBe(true);
  });

  it("blocks a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const findings = scanTextForSecrets(jwt, "event");
    expect(findings.some((f) => f.ruleId === "jwt_token" && f.severity === "block")).toBe(true);
  });

  it("never includes the raw matched value in the finding", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const findings = scanTextForSecrets(`key=${secret}`, "event");
    for (const finding of findings) {
      expect(finding.preview).not.toBe(secret);
      expect(finding.preview).toContain("•");
    }
  });
});

describe("scanTextForSecrets — warn rules", () => {
  it("warns on a generic Authorization: Bearer header", () => {
    const findings = scanTextForSecrets("Authorization: Bearer abcdefgh12345678", "event");
    expect(findings.some((f) => f.ruleId === "bearer_header" && f.severity === "warn")).toBe(true);
  });

  it("warns on a generic env-style secret assignment", () => {
    const findings = scanTextForSecrets("API_KEY=some-plain-looking-value", "event");
    expect(findings.some((f) => f.ruleId === "env_secret_assignment" && f.severity === "warn")).toBe(true);
  });

  it("warns on a high-entropy mixed-alphabet string not matching a known format", () => {
    const findings = scanTextForSecrets("token: 9fQ3ac7Be8b1D4c6A0e5F7d2B8c1A4e6F9d3B7c2", "event");
    expect(findings.some((f) => f.ruleId === "high_entropy_string")).toBe(true);
  });

  it("does not flag a pure-hex hash as high-entropy (event IDs/payload hashes are not secrets)", () => {
    const findings = scanTextForSecrets(
      "event_id: 5dbcf721a017fa2b749c5f7a0dec91f0e0cedc63deb04799681f1865c6bb8fb8",
      "event",
    );
    expect(findings.filter((f) => f.ruleId === "high_entropy_string")).toHaveLength(0);
  });

  it("does not double-flag a blocked value as high-entropy too", () => {
    const findings = scanTextForSecrets("ghp_" + "a1B2c3D4e5F6g7H8".repeat(3), "event");
    expect(findings.filter((f) => f.ruleId === "high_entropy_string")).toHaveLength(0);
  });
});

describe("scanTextForSecrets — clean input", () => {
  it("finds nothing in ordinary text", () => {
    expect(scanTextForSecrets("fix the auth callback bug and add a regression test", "event")).toEqual([]);
  });
});

describe("scanForSecrets", () => {
  it("is clean (not blocked, not warned) when nothing matches", () => {
    const result = scanForSecrets([{ label: "event 1", text: "hello world" }]);
    expect(result).toEqual({ findings: [], blocked: false, warned: false });
  });

  it("is blocked when any event has a block-severity finding, even alongside warn findings", () => {
    const result = scanForSecrets([
      { label: "event 1", text: "API_KEY=looks-plain-ish" },
      { label: "event 2", text: "AKIAIOSFODNN7EXAMPLE" },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.warned).toBe(true);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
  });

  it("is warned but not blocked when only warn-severity findings exist", () => {
    const result = scanForSecrets([{ label: "event 1", text: "API_KEY=looks-plain-ish" }]);
    expect(result.blocked).toBe(false);
    expect(result.warned).toBe(true);
  });
});
