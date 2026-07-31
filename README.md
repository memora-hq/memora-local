# memora-local

The desktop half of [Memora](https://github.com/memora-hq): capture what an autonomous coding
agent actually did on your machine, sign it, and let anyone verify it later without needing to
trust your machine, your account, or Memora's hosted service.

**`memora-local` is this repo's name, not a package name.** Four things live here, each with
its own name and release cadence:

| Package | Published as | What it is |
|---|---|---|
| [`packages/local`](./packages/local) | `@smritheon/memora-local` | The evidence engine: PTY-based session capture, on-disk store, receipts, editor/agent hook integration. |
| [`packages/cli`](./packages/cli) | `@smritheon/memora-local-cli` | The full `memora` CLI — every command in [`memora-sdk`](https://github.com/memora-hq/memora-sdk)'s CLI, plus `local run`/`receipt`/`hook`/`doctor`. |
| [`apps/desktop`](./apps/desktop) | — (not published; distributed as a signed `.dmg`) | The Electron desktop app: session timeline, receipt viewer, editor/agent hook setup. |
| [`apps/vscode-extension`](./apps/vscode-extension) | `memora-local` (VS Code Marketplace, unrelated npm-style name collision, pre-existing) | Emits hook events from VS Code / Cursor by shelling out to the installed `memora` CLI. |

## Why this repo, separate from the SDK

[`memora-sdk`](https://github.com/memora-hq/memora-sdk) ships a CLI too, but a deliberately
lighter one: it can verify a `.memora` bundle or an on-disk session, but it cannot *produce*
one, because doing that means spawning a pseudo-terminal (`node-pty`, a native addon) and
capturing a live session. Bundling that into the SDK would mean every SDK/CLI installer —
including people who only want to verify evidence someone else produced — pays for native
compilation they'll never use. This repo is where that trade gets made instead: everything
here can (and does) depend on `node-pty` and Electron.

## Get started

```bash
npm install -g @smritheon/memora-local-cli   # not yet published — see AGENTS.md
memora local init
memora local run -- pnpm test                # capture a live session
memora local verify <session-id>             # verify it, offline
memora local export <session-id> --out evidence.memora
```

Or install the desktop app for a GUI over the same data — session timeline, receipt
generation, and one-click editor/agent hook setup for Claude Code, Codex, Cursor, and VS Code.

## What's not in this repo

Talking to Memora's hosted API (`write`/`query`/`read`/`verify` against a gateway) and offline
`.memora` bundle/session verification without the capture engine both live in
[`memora-sdk`](https://github.com/memora-hq/memora-sdk) — this repo's CLI depends on that same
`@smritheon/memora-verifier` package rather than reimplementing verification.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm run desktop:build
pnpm run check:private-boundary   # proves nothing here reaches into Memora Cloud's private tier
```

## License

Apache-2.0
