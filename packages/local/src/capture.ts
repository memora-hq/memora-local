import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const EXCLUDED_NAMES = new Set([".git", "node_modules", "dist", "build", ".next", ".cache"]);
const SECRET_PATTERNS = [/^\.env(?:\.|$)/i, /\.(?:pem|key|p12|pfx)$/i, /credentials?/i];

/**
 * Whether a path's file name looks like a secret the capture layer refuses to read.
 *
 * Basename-only on purpose: this reproduces exactly what `snapshotProject` excluded, so a
 * summary built from observed paths reports the same set the capture layer did. Note the
 * `credentials?` pattern is unanchored, so `credential-helper.ts` matches — existing
 * behaviour, pinned by tests rather than tightened here.
 */
export function isSecretPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return SECRET_PATTERNS.some((pattern) => pattern.test(name));
}

export interface FileSnapshot {
  path: string;
  hash: string;
  size: number;
  content?: string;
  excluded?: string;
}

export async function snapshotProject(root: string, maxContentBytes = 5 * 1024 * 1024): Promise<Map<string, FileSnapshot>> {
  const output = new Map<string, FileSnapshot>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile()) continue;
      const info = await stat(absolute);
      if (isSecretPath(entry.name)) {
        output.set(path, { path, hash: "", size: info.size, excluded: "secret-default" });
        continue;
      }
      const bytes = await readFile(absolute);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const isText = !bytes.subarray(0, Math.min(bytes.length, 8_000)).includes(0);
      output.set(path, {
        path,
        hash,
        size: info.size,
        ...(isText && info.size <= maxContentBytes ? { content: bytes.toString("utf8") } : {}),
        ...(!isText ? { excluded: "binary-content" } : info.size > maxContentBytes ? { excluded: "oversized-content" } : {}),
      });
    }
  }
  await walk(root);
  return output;
}

export function diffSnapshots(before: Map<string, FileSnapshot>, after: Map<string, FileSnapshot>): Array<{ change: "created" | "modified" | "deleted"; file: FileSnapshot }> {
  const changes: Array<{ change: "created" | "modified" | "deleted"; file: FileSnapshot }> = [];
  for (const [path, file] of after) {
    const previous = before.get(path);
    if (!previous) changes.push({ change: "created", file });
    else if (previous.hash !== file.hash || previous.excluded !== file.excluded) changes.push({ change: "modified", file });
  }
  for (const [path, file] of before) if (!after.has(path)) changes.push({ change: "deleted", file });
  return changes.sort((a, b) => a.file.path.localeCompare(b.file.path));
}
