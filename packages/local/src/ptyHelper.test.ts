import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExecutable, spawnHelperPathFor } from "./ptyHelper.js";

describe("spawnHelperPathFor", () => {
  it("returns the darwin prebuild spawn-helper path for the given arch", () => {
    const path = spawnHelperPathFor("/repo/node_modules/node-pty/package.json", "darwin", "arm64");
    expect(path).toBe("/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
  });

  it("returns undefined on non-darwin platforms (win32 has no spawn-helper binary)", () => {
    expect(spawnHelperPathFor("/repo/node_modules/node-pty/package.json", "win32", "x64")).toBeUndefined();
    expect(spawnHelperPathFor("/repo/node_modules/node-pty/package.json", "linux", "x64")).toBeUndefined();
  });
});

describe("ensureExecutable", () => {
  it("adds the executable bit to a file that lacks it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memora-pty-helper-"));
    const file = join(dir, "spawn-helper");
    await writeFile(file, "#!/bin/sh\n", { mode: 0o644 });

    await ensureExecutable(file);

    const mode = (await stat(file)).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
  });

  it("does not throw when the path does not exist", async () => {
    await expect(ensureExecutable("/nonexistent/path/spawn-helper")).resolves.toBeUndefined();
  });
});
