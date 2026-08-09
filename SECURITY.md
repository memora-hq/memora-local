# Security policy

## Scope

This policy covers `@memora-hq/memora-local`, the `memora-local` CLI, the desktop app
(`apps/desktop`), and the VS Code/Cursor extension (`apps/vscode-extension`) in this
repository. It does not cover Memora's hosted service (that's `memora-cloud`) or the
verification logic in `@memora-hq/memora-verifier` / the client SDK (that's `memora-sdk`) —
each has its own security process.

## Supported versions

Developer preview. There are no versioned stable releases yet. Security reports should target
the current `main` branch and the latest published npm/desktop-app versions.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities by emailing: **akuniyil@purdue.edu**

Include:
- A clear description of the vulnerability
- Steps to reproduce or a proof of concept
- The file(s) and function(s) involved
- Your assessment of impact and severity

You will receive an acknowledgement within 72 hours. Fixes are prioritized by severity. Given
this repo's role — it's what produces the evidence every Memora verifier trusts, and it runs
with a live PTY attached to whatever an agent is doing on the developer's machine — a
correctness or sandboxing bug here is treated as high severity by default.

## Known limitations

**Session capture cannot guarantee complete semantic visibility into every child process.**
`packages/local/src/run.ts` samples the process tree; a subprocess that avoids the wrapped PTY
entirely (e.g. by talking to a background daemon) won't be captured. Captured sessions are
marked `partial`, never silently upgraded to `complete`.

**A signature proves the record was not altered. It does not prove who produced it.** Matching
a recovered signing key to a real-world identity is outside what this repo (or
`@memora-hq/memora-verifier`) establishes.

**The desktop app installs a shell launcher at `~/.local/bin/memora`** that editor/agent hooks
and the VS Code/Cursor extension invoke. Treat that path as a trust boundary — anything that
can overwrite it can intercept every hook event on the machine.
