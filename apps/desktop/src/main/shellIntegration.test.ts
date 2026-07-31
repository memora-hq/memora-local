import { describe, expect, it } from "vitest";
import { renderShellIntegration, renderZshSourceLine } from "./shellIntegration.js";

describe("automatic agent shell integration", () => {
  it("routes normal agent commands through Memora while preserving arguments", () => {
    const script = renderShellIntegration(
      ["codex", "claude"],
      { codex: "/opt/tools/codex", claude: "/opt/tools/claude" },
    );
    expect(script).toContain('codex() { command memora local run -- "/opt/tools/codex" "$@"; }');
    expect(script).toContain('claude() { command memora local run -- "/opt/tools/claude" "$@"; }');
  });

  it("only emits functions for installed agents and safely quotes paths", () => {
    const script = renderShellIntegration(
      ["codex", "claude"],
      { codex: "/Applications/Agent Tools/codex" },
      "/tmp/Memora Local",
    );
    expect(script).toContain('MEMORA_LOCAL_DATA_DIR="/tmp/Memora Local"');
    expect(script).toContain('"/Applications/Agent Tools/codex" "$@"');
    expect(script).not.toContain("claude()");
  });

  it("creates an idempotent zsh source line", () => {
    expect(renderZshSourceLine("/Users/test/.config/memora/shell.zsh")).toBe(
      '[ -f "/Users/test/.config/memora/shell.zsh" ] && source "/Users/test/.config/memora/shell.zsh"',
    );
  });
});
