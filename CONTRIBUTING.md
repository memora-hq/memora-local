# Contributing

`memora-local` (`@memora-hq/memora-local`, `@memora-hq/memora-local-cli`, the desktop app, and
the VS Code/Cursor extension) is an open-source developer preview under Apache 2.0.
Contributions are welcome — bug fixes, documentation improvements, editor/agent integration
support, and desktop app ergonomics all help.

## Before you start

**Open an issue first for anything that touches session capture correctness**
(`packages/local/src/run.ts`, `capture.ts`) or the on-disk store format
(`packages/local/src/store.ts`) — evidence produced under a broken capture path can't be
retroactively fixed. Small fixes (typos, broken links, non-normative doc corrections) can go
straight to a PR.

**This repo does not accept changes to hosted infrastructure.** There isn't any here. If your
change needs one, it belongs in the private `memora-cloud` repo instead.

**Verification logic (bundle/session integrity checks) lives in `memora-sdk`'s
`@memora-hq/memora-verifier`, not here.** If you find a verification bug, file it against
`memora-sdk`, not this repo — duplicating that logic here would defeat the point of the split.

## Development setup

```bash
pnpm install
pnpm build
pnpm test
pnpm run desktop:build
pnpm run check:private-boundary
```

## Pull request process

1. Fork the repository and create a branch from `main`.
2. Make changes. Keep commits focused — one logical change per commit.
3. If your change touches a cross-repo dependency version pin
   (`@memora-hq/memora-protocol`/`memora-verifier`/`memora-core`), update it deliberately.
4. Run `pnpm build && pnpm test && pnpm run check:private-boundary` locally before pushing. CI
   runs the same, plus a desktop build.
5. Open the PR against `main`.

## Code style

TypeScript throughout. No `any` without justification. No comments explaining *what* code does
— only *why*, when the reason is non-obvious.

## Sign-off

Commits should include a `Signed-off-by` line (`git commit -s`) certifying you wrote the change
or otherwise have the right to submit it under this project's license (Developer Certificate of
Origin).
