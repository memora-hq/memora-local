export type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
};

export function pass(name: string, detail?: string): CheckResult {
  return { name, ok: true, detail };
}

export function fail(name: string, detail?: string): CheckResult {
  return { name, ok: false, detail };
}

export function warn(name: string, detail?: string): CheckResult {
  return { name, ok: false, detail: `⚠ ${detail ?? ""}` };
}

export function printChecks(checks: CheckResult[]) {
  for (const c of checks) {
    const sym = c.ok ? "✓" : isWarning(c) ? "⚠" : "✗";
    const detail = c.detail ? `  — ${c.detail}` : "";
    console.log(`  ${sym} ${c.name}${detail}`);
  }
}

export function isWarning(check: CheckResult): boolean {
  return check.detail?.startsWith("⚠") ?? false;
}
