import type { DiagnosticProvider, IntegrationDiagnosticResult } from "@smritheon/memora-local";
import type { TerminalAgentId } from "./shellIntegration.js";

export type IntegrationId = string;

/**
 * How much of the evidence a reader wants to see. Viewer preference only — it is stored
 * beside the other desktop integration settings and never enters the signed record.
 */
export type ReadingLevel = "everyone" | "power" | "developer";

export const READING_LEVELS: readonly ReadingLevel[] = ["everyone", "power", "developer"];
export const DEFAULT_READING_LEVEL: ReadingLevel = "everyone";

export interface IntegrationSettings {
  version: 1;
  onboarding_complete: boolean;
  automatic_terminal_agents: TerminalAgentId[];
  configured_integrations?: IntegrationId[];
  connected_integrations?: IntegrationId[];
  last_diagnostics?: Partial<Record<DiagnosticProvider, IntegrationDiagnosticResult>>;
  reading_level: ReadingLevel;
  updated_at: string;
}

export function isReadingLevel(value: unknown): value is ReadingLevel {
  return typeof value === "string" && (READING_LEVELS as readonly string[]).includes(value);
}

export function defaultIntegrationSettings(): IntegrationSettings {
  return {
    version: 1,
    onboarding_complete: false,
    automatic_terminal_agents: [],
    configured_integrations: [],
    connected_integrations: [],
    reading_level: DEFAULT_READING_LEVEL,
    updated_at: new Date(0).toISOString(),
  };
}

/**
 * Read a settings file that may predate any field added since it was written. Fields are
 * defaulted individually, so adding a setting never leaves existing installs with `undefined`.
 */
export function normalizeIntegrationSettings(parsed: unknown): IntegrationSettings {
  const defaults = defaultIntegrationSettings();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
  const stored = parsed as Partial<IntegrationSettings>;
  if (stored.version !== 1) return defaults;
  return {
    version: 1,
    onboarding_complete: stored.onboarding_complete === true,
    automatic_terminal_agents: Array.isArray(stored.automatic_terminal_agents) ? stored.automatic_terminal_agents : [],
    configured_integrations: Array.isArray(stored.configured_integrations) ? stored.configured_integrations : [],
    connected_integrations: Array.isArray(stored.connected_integrations) ? stored.connected_integrations : [],
    ...(stored.last_diagnostics ? { last_diagnostics: stored.last_diagnostics } : {}),
    reading_level: isReadingLevel(stored.reading_level) ? stored.reading_level : DEFAULT_READING_LEVEL,
    updated_at: typeof stored.updated_at === "string" ? stored.updated_at : defaults.updated_at,
  };
}

/**
 * The only supported way to change settings. Callers pass just the fields they own, so a
 * write can never drop a field it doesn't know about.
 */
export function mergeIntegrationSettings(
  current: IntegrationSettings,
  patch: Partial<IntegrationSettings>,
): IntegrationSettings {
  return { ...current, ...patch, version: 1, updated_at: new Date().toISOString() };
}
