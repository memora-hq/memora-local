# Research: does `node-pty@^1.1.0` compile on `npx memora-local`?

Ticket: [#2](https://github.com/memora-hq/memora-local/issues/2) (part of [#1](https://github.com/memora-hq/memora-local/issues/1))
Date: 2026-08-04

## Bottom line

**Undermined, but only for Linux, and it will self-heal soon.** `node-pty@1.1.0` — the version `packages/local`'s `^1.1.0` range currently resolves to (`npm view node-pty dist-tags` → `latest: 1.1.0`) — ships prebuilt native binaries for macOS (arm64+x64) and Windows (x64+arm64), so `npx memora-local` genuinely does install in ~1 second on those platforms with **zero compilation**. But the published 1.1.0 tarball contains **no Linux prebuilds at all** (neither x64 nor arm64) — every Linux install falls through to `node-gyp rebuild`, requiring Python, `make`, and a C/C++ toolchain, and failing hard if they're absent. Linux prebuilds exist in the upstream `1.2.0-beta` line as of this writing but have not reached a stable release, so bumping the dependency doesn't yet fix this without accepting a beta.

## What ships in the actual npm tarball (empirical, not docs)

Ran directly against the registry, not against GitHub's description of itself:

```
$ npm view node-pty dist-tags
{ conpty: '0.7.8-conpty1', alpha: '0.10.0-alpha1', latest: '1.1.0', beta: '1.2.0-beta.15' }
```

`packages/local`'s `"node-pty": "^1.1.0"` resolves to `1.1.0` today.

`npm pack node-pty@1.1.0` + `tar xzf` and inspecting `package/prebuilds/`:

```
package/prebuilds/darwin-arm64/{pty.node, spawn-helper}
package/prebuilds/darwin-x64/{pty.node, spawn-helper}
package/prebuilds/win32-x64/{pty.node, pty.pdb, conpty.node, conpty_console_list.node, winpty-agent.exe, winpty.dll, ...}
package/prebuilds/win32-arm64/{...same set as win32-x64...}
```

No `linux-x64/`, no `linux-arm64/` directory. Tarball is 15.5 MB compressed / 64 MB unpacked (286 files) — every supported platform's binary ships in the same tarball (no `optionalDependencies` platform-package split, no separate download-at-install step).

By contrast, `npm pack node-pty@1.2.0-beta.15` (current beta, `npm view node-pty dist-tags` → `beta: 1.2.0-beta.15`) **does** include `prebuilds/linux-x64/` and `prebuilds/linux-arm64/` in addition to the four above. Linux prebuild support exists upstream but is not yet in a stable (non-beta) release.

## How node-pty decides prebuilt vs. compile (source-verified)

`package.json` scripts (from the pulled tarball):

```json
"install": "node scripts/prebuild.js || node-gyp rebuild",
"postinstall": "node scripts/post-install.js"
```

`scripts/prebuild.js` checks `prebuilds/${process.platform}-${process.arch}` for an existing directory; if found, exits `0` (skip `node-gyp rebuild`); if not found — or if `npm_config_build_from_source=true` is set — it deletes the prebuilds dir and exits `1`, and npm's `||` falls through to `node-gyp rebuild`.

At require-time, `src/utils.ts` (`loadNativeModule`) searches, in order: `build/Release`, `build/Debug`, then `prebuilds/${process.platform}-${process.arch}` — confirming the prebuilds are a first-class load path, not a fallback.

The addon uses `node-addon-api` (N-API), which is ABI-stable across Node major versions — so each platform/arch needs only **one** prebuild, not one per Node version. This is materially better than binaries tied to `NODE_MODULE_VERSION` (raw V8/node-gyp ABI).

**Empirical confirmation**, run on this machine (macOS, arm64, Node v24.16.0):

```
$ npm install node-pty@1.1.0
added 2 packages, and audited 3 packages in 820ms
$ ls node_modules/node-pty/build          # → does not exist (no compile ran)
$ ls node_modules/node-pty/prebuilds      # → darwin-arm64 darwin-x64 win32-arm64 win32-x64
$ node -e "require('node-pty').spawn"     # → loads fine, no gyp/compiler invoked
```

Install-to-usable was under one second — no network fetch beyond the ordinary npm/pnpm tarball download, no compiler invocation.

## Why Linux prebuilds are missing from 1.1.0 (GitHub history, not speculation)

From `microsoft/node-pty` commit history on `pipelines/prebuilds.yml` and related PRs/issues:

- **PR #803** (2025‑10‑06) "feat: scaffolding for prebuilt files" — introduces the prebuild pipeline.
- **PR #804** (2025‑10‑08) "feat: add prebuilds to published package" — ships prebuilds in the npm tarball for the first time.
- **PR #805** (2025‑10‑09) "chore: exclude Linux prebuilds" — explicitly strips Linux out. Reason given in **issue #851** ("Add prebuilt linux binaries with minimal glibc dependency", opened 2025‑12‑30): the CI runner is Ubuntu 22.04 (glibc 2.35), but Node.js officially supports glibc ≥ 2.28 — shipping a 2.35-linked binary would break on older-glibc distros, so Linux was pulled rather than ship a binary that silently breaks on some fraction of Linux users.
- `node-pty@1.1.0` was published **2025‑12‑22** (`npm view node-pty time`) — i.e., *before* the glibc fix landed. It inherits the "Linux excluded" state from #805.
- **PR #853** (2026‑01‑01) "Add sysroot to compile Linux prebuilds against glibc 2.28" (fixes #851) — re-adds Linux prebuild capability using a sysroot, landing in the `1.2.0-beta` line.
- **Issue #860** (2026‑01‑10, closed) "Prebuilt binary for Linux ARM is actually x86-64" and **PR #857** "Fix linux arm compiling and add CI for cross-compiled builds" show Linux arm64 prebuilds went through further churn/bugfixing after #853, in the 1.2.0-beta line.
- **Issue #852** (opened 2025‑12‑30, still **open**) "Add prebuilt linux musl binaries to support Alpine linux" — musl/Alpine Linux (common in slim Docker base images) has **no prebuild path even in the beta line**; those installs always compile.

Net: Linux prebuild support is real and upstream-shipped as of `1.2.0-beta.15`, but has not reached a stable tag. `^1.1.0` will not pick it up without a manual bump past the current major-compatible range (and accepting a prerelease).

## Failure mode without build tools (compile path)

`node-gyp`'s own README (`nodejs/node-gyp`, primary source) states the prerequisites node-pty's `node-gyp rebuild` fallback depends on:

- **macOS**: a supported Python 3, and Xcode Command Line Tools (`clang`, `clang++`, `make`) — installed via `xcode-select --install` or full Xcode. Without CLT, `node-gyp` invokes `clang`/`xcrun` and gets a missing-toolchain error (classically `xcrun: error: invalid active developer path ... missing xcrun`), which node-gyp surfaces as a `gyp: Call to 'xcrun -sdk macosx --show-sdk-path' returned exit status 1` (or equivalent) build failure — `npm install` exits non-zero, `npx memora-local` aborts before ever running.
- **Windows**: Python plus a Visual C++ build toolchain (`Desktop development with C++` workload from VS 2019+, or standalone Build Tools). Without it, `node-gyp configure`/`build` fails to find `MSBuild.exe`/`vcvarsall.bat`, producing the well-known `gyp ERR! find VS` / `gyp ERR! stack Error: Could not find any Visual Studio installation to use` error — again a hard, non-zero-exit failure, not a silent degradation.
- **Linux** (any distro, since 1.1.0 has zero Linux prebuilds): needs Python 3, `make`, and GCC/G++. `node-pty`'s own CI (`.github/workflows/ci.yml`) pins `gcc-10`/`g++-10` and a custom sysroot for its *own* builds — ordinary end-user machines without a C toolchain installed (common on fresh cloud VMs, minimal containers, or non-dev laptops) get the standard node-gyp "python"/"make: command not found" failure.

In all three cases the failure is a **hard install-time crash**, not a slow-but-working degrade — `npx memora-local` would print an unhandled npm ERR! stack trace referencing gyp/MSBuild/xcrun, not something a non-technical user could self-diagnose.

## Realistic cold-start time

| Platform | Path (with `^1.1.0` today) | Cold-start reality |
|---|---|---|
| macOS arm64 / x64 | prebuilt | ~1s install (measured above), no compiler invoked. `npx` overhead (registry resolve + tarball fetch, ~15 MB) dominates — a few seconds on normal broadband. |
| Windows x64 / arm64 | prebuilt | Same order of magnitude as macOS — no MSBuild invoked. |
| Linux x64 / arm64 (glibc) | **compiles from source** | Requires Python+make+gcc already present. If present: node-gyp compile of node-pty's C++ sources typically takes tens of seconds (30–90s is typical for pty-sized native addons on modern CI hardware; slower on constrained VMs). If **not** present: install fails outright, `npx memora-local` never runs — "seconds" is not the outcome, "does not work" is. |
| Linux musl (Alpine) | **compiles from source, on every version including current beta** | Same as above; issue #852 is still open. |

So the "installs in seconds" premise is **true for macOS and Windows today**, and **false for Linux today** — Linux either silently costs a substantial compile-time tax (best case, with tools present) or hard-fails the whole `npx memora-local` invocation (common case, tools absent — this is the default state of most cloud VMs, CI runners, and minimal containers).

## What comparable native-dependency CLIs do

- **`optionalDependencies` platform packages** (esbuild's pattern, verified via `npm view esbuild optionalDependencies`): the main package lists ~20 tiny `@esbuild/<platform>-<arch>` packages as `optionalDependencies`; npm/pnpm/yarn only download and install the one matching the current platform/arch, keeping installs small and avoiding shipping every OS's binary to every user. This is the mechanism node-pty does **not** use — node-pty instead bundles every supported platform's binary directly in the single tarball (hence the 15 MB/64 MB size regardless of what OS you're on).
- **`prebuildify`** (`npm view prebuildify` → "Create and package prebuilds for native modules") — bundles prebuilds into the package tarball itself (same strategy node-pty's custom scripts effectively replicate by hand) rather than using optionalDependencies.
- **`node-gyp-build`** (`npm view node-gyp-build` → "Build tool and bindings loader for node-gyp that supports prebuilds") — a runtime loader that checks for a matching prebuild and falls back to invoking `node-gyp` if none is found; conceptually identical to what node-pty's own `scripts/prebuild.js` + `src/utils.ts` do by hand, just not using the community-standard package.
- **`prebuild-install`** (`npm view prebuild-install` → "A command line tool to easily install prebuilt binaries for multiple version of node/iojs on a specific platform") — downloads a prebuild from a GitHub release/CDN at install time rather than bundling it in the tarball; keeps the npm package itself small at the cost of a network fetch during install.

node-pty uses a **bespoke, in-house** variant of the prebuildify pattern (its own `scripts/prebuild.js`, Azure Pipelines `pipelines/prebuilds.yml`/`publish.yml`) rather than any of the above off-the-shelf tools. This explains both its strength (fast install, no separate download step, works offline once the tarball is fetched) and its current gap (Linux support depended entirely on this one team remembering to wire up a Linux job — which they initially skipped for a legitimate glibc-compatibility reason, then fixed post-1.1.0).

## Direct answers to the ticket's questions

1. **Does `node-pty@1.1.x` ship prebuilt binaries, and for which combos?** Yes for macOS arm64, macOS x64, Windows x64, Windows arm64. **No** for Linux x64/arm64 in the `1.1.0` stable release actually resolved by `^1.1.0` — those compile from source every install. (Linux prebuilds do exist in the unreleased `1.2.0-beta` line.)
2. **Exact failure mode without build tools?** Hard `npm install` failure with a gyp/toolchain-specific stack trace (`gyp ERR! find VS` on Windows without VS Build Tools; `xcrun`/Xcode-CLT-missing error on macOS without Command Line Tools; `make`/`python`-not-found on Linux). Not a graceful degrade — `npx memora-local` aborts before the CLI runs.
3. **Realistic cold-start time?** Prebuilt case: ~1–5 seconds dominated by npm/pnpm registry+tarball fetch, no compiler invoked (measured). Compile case (Linux only, today): tens of seconds if a toolchain is present, or immediate hard failure if not.
4. **What do comparable CLIs do?** The ecosystem standard is `optionalDependencies` per-platform packages (esbuild) or a prebuild-loader library (`prebuildify` + `node-gyp-build`, or `prebuild-install`'s download-on-install variant). node-pty instead hand-rolls the "bundle every platform's binary in one tarball" strategy without any of the standard tooling, and its Linux coverage is a recent, not-yet-stable addition.

## Implication for constraint 7 (`npx memora-local`)

The zero-friction premise holds for macOS and Windows on `node-pty@1.1.0` as currently pinned. It does **not** hold for Linux today. Two independent levers exist to fix this, either of which is a small, contained change to `packages/local`'s dependency spec (not an architecture change):

- **Bump to `node-pty@1.2.0-beta.15`** (or whatever beta is current) to pick up Linux prebuilds — accepts prerelease-version risk, and still leaves Alpine/musl compiling from source (issue #852 still open upstream).
- **Wait for the fix to reach `node-pty@1.2.0` stable** (or a future `1.1.x`/`1.2.x` that backports it) before shipping — safer, but ties the launch timeline to an upstream release Microsoft controls, not this team.

Either way, Linux support depth (mentioned as fog in the map, issue #1) should explicitly note: **Linux is not zero-friction today under the pinned `^1.1.0` range**, and Alpine/musl Linux has no fix in sight upstream at all.

## Primary sources consulted

- `npm view node-pty dist-tags / versions / time` (npm registry metadata)
- `npm pack node-pty@1.1.0` and `npm pack node-pty@1.2.0-beta.15` — actual tarball contents inspected directly
- `node-pty` `package.json`, `scripts/prebuild.js`, `scripts/post-install.js`, `src/utils.ts`, `binding.gyp` (pulled from the real tarball, not GitHub's `main` branch, to see exactly what 1.1.0 shipped)
- `github.com/microsoft/node-pty` — `.github/workflows/ci.yml`, `pipelines/prebuilds.yml`, `publish.yml`, `.gitignore` (confirms `prebuilds/` is git-ignored and only produced at publish time)
- `github.com/microsoft/node-pty` PRs/issues #803, #804, #805, #851, #852, #853, #857, #860 (via GitHub REST API, `api.github.com/repos/microsoft/node-pty/...`)
- `github.com/nodejs/node-gyp` README (build prerequisites per OS)
- Empirical local install: `npm install node-pty@1.1.0` on macOS arm64 / Node v24.16.0, inspecting `node_modules/node-pty/{build,prebuilds}` and requiring the module
- `npm view esbuild optionalDependencies`, `npm view prebuildify/node-gyp-build/prebuild-install description` (comparable native-dep CLI patterns)
