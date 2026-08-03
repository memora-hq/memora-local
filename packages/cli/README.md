# @memora-hq/memora-local-cli

Full terminal surface for writing, reading, inspecting, verifying, and **capturing** Memora
execution records. This is the heavier sibling of
[`memora-sdk`](https://github.com/memora-hq/memora-sdk)'s `@memora-hq/memora-cli`: everything
below plus `memora local run` (live session capture via `node-pty`), `memora local receipt`
(HTML receipt rendering), `memora local hook` (editor/agent hook ingestion), and `memora local
doctor` (integration diagnostics) — commands that need `@memora-hq/memora-local` and don't ship
in the SDK's leaner CLI. Install this one if you want to *produce* evidence, not just verify it.

## Commands

```bash
memora receipt <execution_id>
memora verify <execution_id>
```

Legacy flag form still works:

```bash
memora receipt --memory <execution_id>
memora verify --memory <execution_id>
```

## Accepted IDs

- `memory_id` / execution ID
- `event_id` when the current indexer API can resolve it
- `event_digest` when the current indexer API can resolve it

Common production shapes:

- `memory_id`: `0x...` 32-byte hex
- `event_id`: 64-char hex without `0x`

## Environment

Hosted deployments:

- `MEMORA_BASE_URL` — base URL of the Memora gateway (the public API edge, e.g.
  `https://api.getmemora.dev`). When set, the CLI talks to that one host on its
  `/v1/*` routes for everything, and `INDEXER_BASE_URL` / `KEY_BROKER_BASE_URL`
  are ignored. This is the only way to reach a hosted deployment — the indexer
  and key-broker are not exposed directly.
- `MEMORA_API_KEY` — bearer token sent with gateway requests. Gateway reads
  are authenticated; without a key they return `401`.

Local development (direct mode, used when `MEMORA_BASE_URL` is unset):

- `INDEXER_BASE_URL` for direct indexer reads (default `http://localhost:3001`)
- `KEY_BROKER_BASE_URL` for `read` (default `http://localhost:3000`)
- `MEMORA_USE_V1_ROUTES=1` — legacy escape hatch that puts the client SDK on
  `/v1/*` paths without switching base URLs. Prefer `MEMORA_BASE_URL`.
- `MEMORA_API_KEY` — the indexer's own reads require a bearer token with no
  unauthenticated path, in direct mode as much as gateway mode. Set this to
  whatever bearer your self-hosted indexer expects; without it, reads against
  an indexer that enforces read auth will fail (surfaced by the CLI as
  "not found" rather than an auth error, since it doesn't distinguish 401
  from a genuine miss).

Either mode:

- `HEDERA_EVM_RPC_URL` and `MEMORA_REGISTRY_CONTRACT_ID` for deeper anchored replay checks

## What `receipt` shows

`memora receipt <id>` prints a human-readable card with:

- Execution ID
- Event Digest
- Event Type
- Agent ID
- Provider / Model
- Payload Hash
- HCS Topic / Sequence
- Contract TX
- Created timestamp
- Verification status

If provider/model metadata is encrypted or unavailable, the CLI prints:

```text
Provider: unavailable
Model: unavailable
```

## Two ways to verify

The CLI carries two verifiers with different trust properties. The offline one is
the foundation; the API-backed one is the convenience layer on top of it.

### Tier 1 — offline bundle verification (no network, no credentials)

```bash
memora local verify-bundle evidence.memora
```

Verifies a `.memora` evidence bundle entirely on your machine: hash chain,
signatures, and — when the bundle was exported with `--disclose` — that the
readable records match their signed hashes. It makes **zero network calls** and
needs no API key, no account, and no Memora service to be running or even to
still exist. Anyone handed a bundle can check it. The frozen contract here is
the `.memora` file format itself.

A signature proves the record was not altered. It does not prove who produced it.

### Tier 2 — API-backed replay verification (hosted records)

```bash
memora verify <execution_id>
memora replay verify --memory <execution_id> [--signer <0x...>]
```

Verifies a record that lives in a hosted Memora deployment: it cross-checks the
indexed row against the raw HCS commit, the on-chain commit path, the agent
signer timeline, and any Merkle batch proof. Because it reads records out of
Memora's hosted database, it requires `MEMORA_BASE_URL` plus an API key
(`MEMORA_API_KEY`). That authentication requirement is a property of reading
someone's hosted records, not a limit on what can be verified — tier 1 above
needs nothing. The frozen contract here is the gateway's HTTP routes.

## What `verify` proves

`memora verify <id>` verifies the Memora execution record that was stored:

- indexed ref presence
- payload hash presence
- event ID / digest format when present
- indexed signature status when available
- anchor status when present

For anchored records, it delegates to the stronger replay verifier path.

It does **not** prove that a closed AI provider actually used a requested model. It only verifies Memora’s recorded hashes, signatures, anchors, and stored provider/model metadata when that metadata is available.
