export function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, " ");
}

export function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}
