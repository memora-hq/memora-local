import { describe, expect, it } from "vitest";
import {
  defaultIntegrationSettings,
  isReadingLevel,
  mergeIntegrationSettings,
  normalizeIntegrationSettings,
} from "./integrationSettings.js";

describe("normalizeIntegrationSettings", () => {
  it("defaults the reading level for settings written before the field existed", () => {
    const legacy = {
      version: 1,
      onboarding_complete: true,
      automatic_terminal_agents: ["codex"],
      configured_integrations: ["codex", "cursor"],
      updated_at: "2026-07-01T10:00:00.000Z",
    };
    const settings = normalizeIntegrationSettings(legacy);

    expect(settings.reading_level).toBe("everyone");
    expect(settings.onboarding_complete).toBe(true);
    expect(settings.automatic_terminal_agents).toEqual(["codex"]);
    expect(settings.configured_integrations).toEqual(["codex", "cursor"]);
    expect(settings.updated_at).toBe("2026-07-01T10:00:00.000Z");
  });

  it("falls back to the default for a hand-edited reading level", () => {
    expect(normalizeIntegrationSettings({ version: 1, reading_level: "wizard" }).reading_level).toBe("everyone");
  });

  it("keeps a valid stored reading level", () => {
    expect(normalizeIntegrationSettings({ version: 1, reading_level: "developer" }).reading_level).toBe("developer");
  });

  it("returns defaults for an unknown version or unusable input", () => {
    const defaults = defaultIntegrationSettings();
    expect(normalizeIntegrationSettings({ version: 2, reading_level: "developer" })).toEqual(defaults);
    expect(normalizeIntegrationSettings(null)).toEqual(defaults);
    expect(normalizeIntegrationSettings("not settings")).toEqual(defaults);
    expect(normalizeIntegrationSettings([])).toEqual(defaults);
  });

  it("preserves stored diagnostics", () => {
    const last_diagnostics = { codex: { provider: "codex" } } as never;
    expect(normalizeIntegrationSettings({ version: 1, last_diagnostics }).last_diagnostics).toEqual(last_diagnostics);
  });
});

describe("mergeIntegrationSettings", () => {
  it("preserves fields the caller does not patch", () => {
    const current = {
      ...defaultIntegrationSettings(),
      reading_level: "developer" as const,
      last_diagnostics: { codex: { provider: "codex" } } as never,
    };
    // Exactly the patch configureIntegrations writes — it used to replace the whole object
    // and silently dropped every field it did not list.
    const merged = mergeIntegrationSettings(current, {
      onboarding_complete: true,
      automatic_terminal_agents: ["codex"],
      configured_integrations: ["codex"],
      connected_integrations: ["codex"],
    });

    expect(merged.reading_level).toBe("developer");
    expect(merged.last_diagnostics).toEqual(current.last_diagnostics);
    expect(merged.onboarding_complete).toBe(true);
    expect(merged.configured_integrations).toEqual(["codex"]);
  });

  it("stamps a fresh updated_at", () => {
    const current = defaultIntegrationSettings();
    const merged = mergeIntegrationSettings(current, { reading_level: "power" });

    expect(merged.updated_at).not.toBe(current.updated_at);
    expect(Number.isNaN(new Date(merged.updated_at).getTime())).toBe(false);
  });
});

describe("isReadingLevel", () => {
  it("accepts only the three levels", () => {
    expect(isReadingLevel("everyone")).toBe(true);
    expect(isReadingLevel("power")).toBe(true);
    expect(isReadingLevel("developer")).toBe(true);
    for (const value of ["", "EVERYONE", "admin", null, undefined, 3, {}]) {
      expect(isReadingLevel(value)).toBe(false);
    }
  });
});
