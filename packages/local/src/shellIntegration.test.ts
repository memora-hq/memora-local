import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shellIntegrationSourceLine,
  shellIntegrationWrapsProvider,
  stripShellIntegrationBlock,
  uninstallShellIntegration,
} from "./shellIntegration.js";

const wrapperPath = "/Users/test/.config/memora/shell.zsh";
const sourceLine = shellIntegrationSourceLine(wrapperPath);

describe("stripShellIntegrationBlock", () => {
  it("removes the marker comment, source line, and the blank line the append introduced", () => {
    const rc = [
      'eval "$(fnm env --use-on-cd --shell zsh)"',
      "",
      "# Memora Local automatic agent capture",
      sourceLine,
      "",
      "# bun completions",
      '[ -s "/Users/test/.bun/_bun" ] && source "/Users/test/.bun/_bun"',
      "",
    ].join("\n");
    const stripped = stripShellIntegrationBlock(rc, wrapperPath);
    expect(stripped).not.toContain("Memora Local automatic agent capture");
    expect(stripped).not.toContain(sourceLine);
    expect(stripped).toContain('eval "$(fnm env --use-on-cd --shell zsh)"');
    expect(stripped).toContain("# bun completions");
    expect(stripped).not.toMatch(/\n{3,}/);
  });

  it("leaves an rc file with no Memora block untouched", () => {
    const rc = 'export PATH="$HOME/.local/bin:$PATH"\n';
    expect(stripShellIntegrationBlock(rc, wrapperPath)).toBe(rc);
  });

  it("only touches the exact wrapper path passed in, not a same-shaped block for a different path", () => {
    const otherPath = "/Users/other/.config/memora/shell.zsh";
    const rc = `# Memora Local automatic agent capture\n${shellIntegrationSourceLine(otherPath)}\n`;
    expect(stripShellIntegrationBlock(rc, wrapperPath)).toBe(rc);
  });
});

describe("shellIntegrationWrapsProvider", () => {
  it("detects a wrapped provider", () => {
    const contents = 'codex() { command memora local run -- "/bin/codex" "$@"; }\n';
    expect(shellIntegrationWrapsProvider(contents, "codex")).toBe(true);
    expect(shellIntegrationWrapsProvider(contents, "claude")).toBe(false);
  });
});

describe("uninstallShellIntegration", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("backs up and strips the rc file, and disables the wrapper file", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-shell-integration-"));
    dirs.push(root);
    const rcPath = join(root, ".zshrc");
    const wrapper = join(root, "shell.zsh");
    await writeFile(rcPath, `export PATH="$HOME/.local/bin:$PATH"\n\n# Memora Local automatic agent capture\n${shellIntegrationSourceLine(wrapper)}\n`);
    await writeFile(wrapper, 'claude() { command memora local run -- "/bin/claude" "$@"; }\n');

    const result = await uninstallShellIntegration({ wrapperPath: wrapper, rcPath });
    expect(result).toEqual({ rcUpdated: true, rcBackedUp: true, wrapperFileDisabled: true });

    const updatedRc = await readFile(rcPath, "utf8");
    expect(updatedRc).not.toContain("Memora Local automatic agent capture");
    const backup = await readFile(`${rcPath}.backup`, "utf8");
    expect(backup).toContain("Memora Local automatic agent capture");
  });

  it("is a no-op when nothing is installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-shell-integration-"));
    dirs.push(root);
    const result = await uninstallShellIntegration({
      wrapperPath: join(root, "shell.zsh"),
      rcPath: join(root, ".zshrc"),
    });
    expect(result).toEqual({ rcUpdated: false, rcBackedUp: false, wrapperFileDisabled: false });
  });
});
