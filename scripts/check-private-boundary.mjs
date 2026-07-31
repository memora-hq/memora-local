#!/usr/bin/env node
// scripts/check-private-boundary.mjs
//
// This repo (memora-local) is the one that's *supposed* to have node-pty and live
// session capture — the opposite concern from memora-sdk's check-local-boundary.mjs.
// What this repo must never do is reach into Memora Cloud's private-tier
// infrastructure: the indexer, gateway, key broker, contracts, or web console, or any
// of the credentials those services use. See docs/OSS_SPLIT_PLAN.md ("Org Layout and
// the Public/Private Boundary") in the private memora-cloud repo for the full
// rationale — this is the same guard shape, re-scoped to a physically separate repo.
//
// Two checks:
//
//   Class A — static import scan. Flags any import/export-from/dynamic-import
//   specifier naming a private package.
//
//   Class B — credential/infrastructure string scan. Flags occurrences (anywhere in
//   file text, not just imports) of the credential/env-var names the private repo's
//   own boundary guard already tracks.
//
// Usage:
//   node scripts/check-private-boundary.mjs
//   Scans every package under packages/ and apps/ in this workspace.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PRIVATE_PACKAGE_NAMES = [
  "@memora/shared",
  "@memora/indexer",
  "@memora/gateway",
  "@memora/key-broker",
  "@memora/contracts",
  "web",
];

const CREDENTIAL_STRINGS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "MEMORA_KEK",
  "MEMORA_SERVICE_HMAC_SECRET",
  "MEMORA_WRITE_SECRET",
  "HEDERA_OPERATOR_KEY",
  "/rest/v1/",
];

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules", "dist", "dist-main", "dist-renderer", "build", "out",
  "release", "coverage", ".vite", ".vite-temp", ".turbo", ".git",
]);

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".cts", ".mts", ".js", ".cjs", ".mjs"]);
const FROM_CLAUSE_RE = /\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /(?<!\w)import\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function walk(dirAbs) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

function isPrivateSpecifier(spec) {
  return PRIVATE_PACKAGE_NAMES.some((name) => spec === name || spec.startsWith(`${name}/`));
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === "\n") line++;
  return line;
}

function findPackageRoots() {
  const roots = [];
  for (const group of ["packages", "apps"]) {
    const groupAbs = path.join(REPO_ROOT, group);
    let entries;
    try {
      entries = fs.readdirSync(groupAbs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) roots.push(path.join(groupAbs, entry.name));
    }
  }
  return roots;
}

function scanFile(fileAbs, violations) {
  const content = fs.readFileSync(fileAbs, "utf8");
  const rel = path.relative(REPO_ROOT, fileAbs);

  for (const re of [FROM_CLAUSE_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content))) {
      if (isPrivateSpecifier(match[1])) {
        violations.push({ type: "import", file: rel, line: lineNumberAt(content, match.index), detail: match[1] });
      }
    }
  }

  for (const cred of CREDENTIAL_STRINGS) {
    let idx = content.indexOf(cred);
    while (idx !== -1) {
      violations.push({ type: "credential-string", file: rel, line: lineNumberAt(content, idx), detail: cred });
      idx = content.indexOf(cred, idx + 1);
    }
  }
}

function main() {
  const violations = [];
  for (const pkgRoot of findPackageRoots()) {
    const scanRoot = fs.existsSync(path.join(pkgRoot, "src")) ? path.join(pkgRoot, "src") : pkgRoot;
    for (const fileAbs of walk(scanRoot)) {
      if (!SCAN_EXTENSIONS.has(path.extname(fileAbs))) continue;
      scanFile(fileAbs, violations);
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`✗ [${v.type}] ${v.file}:${v.line} — ${v.detail}`);
    }
    console.error(`\nprivate boundary guard: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log("private boundary guard: 0 violations");
}

main();
