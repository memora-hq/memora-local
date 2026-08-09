# memora-local

The desktop half of [Memora](https://github.com/memora-hq): capture what an autonomous coding
agent actually did on your machine, sign it, and let anyone verify it later without needing to
trust your machine, your account, or Memora's hosted service.

**`memora-local` is this repo's name, not a package name.** Four things live here, each with
its own name and release cadence:

| Package | Published as | What it is |
|---|---|---|
| [`packages/local`](./packages/local) | `@memora-hq/memora-local` | The evidence engine: PTY-based session capture, on-disk store, receipts, editor/agent hook integration. |
| [`packages/cli`](./packages/cli) | `memora-local` (npm, unscoped) | The full `memora` CLI — `npx memora-local`. Every command in [`memora-sdk`](https://github.com/memora-hq/memora-sdk)'s CLI, plus `local run`/`local publish`/`daemon`/`receipt`/`hook`/`doctor`. |
| [`apps/desktop`](./apps/desktop) | — (not published; distributed as a signed `.dmg`) | The Electron desktop app: session timeline, receipt viewer, editor/agent hook setup. Frozen for the beta, not deleted — see `AGENTS.md`. |
| [`apps/vscode-extension`](./apps/vscode-extension) | `memora-local` (VS Code Marketplace) | **Dropped from the beta wedge**, not migrated (see `AGENTS.md`). Its `package.json` name also happens to be `memora-local` — same string as `packages/cli`'s npm name, but a different registry (VS Code Marketplace, not npm) so there's no real publish collision. Inside *this* pnpm workspace the two do share an identical package name; nothing currently filters or depends on it by that name after `typecheck:vscode-extension` was removed, but be aware before adding one. |

## Why this repo, separate from the SDK

[`memora-sdk`](https://github.com/memora-hq/memora-sdk) ships a CLI too, but a deliberately
lighter one: it can verify a `.memora` bundle or an on-disk session, but it cannot *produce*
one, because doing that means spawning a pseudo-terminal (`node-pty`, a native addon) and
capturing a live session. Bundling that into the SDK would mean every SDK/CLI installer —
including people who only want to verify evidence someone else produced — pays for native
compilation they'll never use. This repo is where that trade gets made instead: everything
here can (and does) depend on `node-pty` and Electron.

## Platform support

**Memora Local beta supports macOS and Windows.** No account. No global install. No setup
wizard — run `npx memora-local` and start.

**Linux is not supported in this beta.** `node-pty` (the native terminal integration this repo
depends on) has no Linux prebuilds, so a clean Linux install would mean compiling from source —
that conflicts with the zero-setup promise above, so `memora` refuses to run on Linux with a
clear message rather than quietly degrading or dropping into a slow, build-tool-dependent
install. See [#12](https://github.com/memora-hq/memora-local/issues/12) for the reasoning and
to follow progress. If you want to build from source anyway as a contributor, see
[Linux (unsupported, contributor-only)](#linux-unsupported-contributor-only) below — that path
carries none of the beta's installation guarantees.

## Get started

```bash
npx memora-local local init
memora local run -- pnpm test                # capture a live session
memora local verify <session-id>             # verify it, offline
memora local export <session-id> --out evidence.memora
memora local publish <session-id>            # scan, confirm, and share a link
```

(`npx memora-local` installs the `memora` binary for the invocation; `npm install -g memora-local`
works too if you want it on PATH persistently.)

Or install the desktop app for a GUI over the same data — session timeline, receipt
generation, and one-click editor/agent hook setup for Claude Code, Codex, Cursor, and VS Code.

## What's not in this repo

Talking to Memora's hosted API (`write`/`query`/`read`/`verify` against a gateway) and offline
`.memora` bundle/session verification without the capture engine both live in
[`memora-sdk`](https://github.com/memora-hq/memora-sdk) — this repo's CLI depends on that same
`@memora-hq/memora-verifier` package rather than reimplementing verification.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm run desktop:build
pnpm run check:private-boundary   # proves nothing here reaches into Memora Cloud's private tier
```

### Linux (unsupported, contributor-only)

Not part of the beta support matrix (see [Platform support](#platform-support) above) — this is
for people building/testing the repo itself, not an installation path to point end users at.

```bash
# Debian/Ubuntu build tools node-pty needs to compile from source:
sudo apt-get install -y python3 make g++
pnpm install   # node-pty is an optionalDependency; on Linux this compiles it via node-gyp
pnpm build
```

`memora`'s own CLI still refuses to run on Linux regardless of whether `node-pty` happened to
compile — that refusal isn't a build-environment gap you can work around, it's a deliberate
product decision (#12). This path exists only so contributors can run the test suite and work
on the capture engine's Linux code paths, not to produce a working end-user install.

## License

Apache-2.0
