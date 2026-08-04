# Can the protocol hand content-decryption keys to a web viewer without inventing a new disclosure mode?

Date: 2026-08-04
Issue: memora-hq/memora-local#3

## Answer

**Partial — leaning no as currently shaped.** The AES key a viewer would need is already a
distinct, mechanically-extractable 32-byte value (`deriveLocalEncryptionKey(identity)` in
`@memora-hq/memora-verifier@0.1.0`), and extracting it does **not** require touching
`@memora-hq/memora-protocol` at all — `memora-protocol`'s job is only generic AES-256-GCM
encrypt/decrypt over a caller-supplied key. But the key that function returns is **not scoped to
a session**: it is a single static secret derived only from the device identity's private key
(`sha256("memora:local:encryption:v1\n" + identity.privateKey)`), the same key for every event in
every session that identity has ever captured or ever will. Handing it to a web viewer for "this
one published session" hands over decryption capability for the user's entire local history.
Separately, `@memora-hq/memora-verifier` and the crypto engine inside `@memora-hq/memora-protocol`
are plain Node code (`node:crypto`, `node:fs`) with no browser build, so a web viewer could not
run today's decrypt/verify code client-side without a new browser-targeted build. Both gaps are
real protocol-repo (not memora-local-repo) work — see "What would be required" below.

---

## 1. How are event contents encrypted at rest, and what key material would a viewer need?

Every event's payload is encrypted with **AES-256-GCM** using a single symmetric key, via
`@memora-hq/memora-protocol`'s `encrypt`/`decrypt`:

`/tmp/memora-pkg-research/protocol/package/src/crypto.ts` (published as `dist/crypto.js`, package `@memora-hq/memora-protocol@0.1.0-rc.2`):

```ts
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ALG = "aes-256-gcm";
...
export function encrypt(plaintext: string, key: Buffer): EncryptedPayloadBundle {
  const nonce = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALG, key, nonce, { authTagLength: TAG_LENGTH });
  ...
}
export function decrypt(bundle: EncryptedPayloadBundle, key: Buffer): string {
  ...
  const decipher = createDecipheriv(ALG, key, nonce, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
}
```

`decrypt` needs nothing but a raw 32-byte `Buffer` key plus the `EncryptedPayloadBundle`
(`{version, alg, nonce, ciphertext, tag}` — all base64, all already present in the bundle).
Confirmed against a real conformance vector,
`/tmp/memora-pkg-research/protocol/package/vectors/bundle-v2-sealed.memora`: each `payloads[...]`
entry is exactly `{version, alg: "AES-256-GCM", nonce, ciphertext, tag}` — no key material, no
per-payload salt, travels with the bundle.

Where does that key come from? `@memora-hq/memora-verifier@0.1.0`,
`/tmp/memora-pkg-research/verifier/package/dist/session.js` (source-equivalent, package ships
compiled JS + `.d.ts` only, no `.ts` in the tarball):

```js
function encryptionKey(identity) {
    return createHash("sha256").update("memora:local:encryption:v1\n" + identity.privateKey).digest();
}
...
export function deriveLocalEncryptionKey(identity) {
    return encryptionKey(identity);
}
```

So the key a viewer would need is `sha256("memora:local:encryption:v1\n" + <device identity
private key>)` — a plain symmetric key, not an asymmetric/ECDH scheme. `LocalIdentity` is defined
in `/tmp/memora-pkg-research/verifier/package/dist/identity.d.ts`:

```ts
export interface LocalIdentity {
    agentId: string;
    address: string;
    privateKey: string;
}
```

## 2. Can that key material be extracted and handed over via a URL fragment WITHOUT changing `@memora-hq/memora-protocol`?

**Mechanically yes; safely no.**

- `deriveLocalEncryptionKey` already lives in `@memora-hq/memora-verifier`, is already exported
  from its public entry point (`export * from "./session.js"` in
  `/tmp/memora-pkg-research/verifier/package/dist/index.js`), and only calls into
  `@memora-hq/memora-protocol` for generic primitives (`canonicalizePayload`, `computeEventId`,
  `encrypt`, `hashPayload`, `signEventEnvelope` — see the `import` line at the top of
  `session.js`). `memora-protocol` itself has zero awareness of "the local encryption key" — it
  just takes whatever `Buffer` it's handed. So an app author *today* could call
  `deriveLocalEncryptionKey(identity)`, base64-encode the 32 bytes, and stick it in a URL fragment
  — no new export, type, or function is needed in `memora-protocol`.

- **But this key is not per-session.** Its derivation (`encryptionKey(identity)` above) takes
  only `identity.privateKey` and a fixed domain-separator string — no `sessionId`, no
  `manifest_id`, no per-export nonce. Every event `LocalSession.record()` ever writes for a given
  identity is encrypted with this exact same key
  (`/tmp/memora-pkg-research/verifier/package/dist/session.js`, line ~51:
  `encrypt(canonical, encryptionKey(this.options.identity))`). There is no per-session or
  per-event key anywhere in the pipeline — `export` reuses the same derivation
  (`bundle.js`: `const key = deriveLocalEncryptionKey(options.identity);`) to decrypt records for
  the `disclose` codepath.

  Confirmed no key material or per-session salt exists in the bundle format itself
  (`LocalEvidenceBundleV1`/`V2` in `/tmp/memora-pkg-research/protocol/package/src/types.ts`,
  lines 71–98): `payloads: Record<string, EncryptedPayloadBundle>` is ciphertext only; the
  optional `disclosed?: Record<string, MemoryPayload>` field (v2) is *plaintext*, produced by
  fully decrypting at export time with the device key — it is not a key-handover mechanism at
  all, it's today's binary disclose-everything-or-nothing path that the ticket is asking to move
  beyond.

  So handing over "the content key for session X" today literally means handing over the one key
  that decrypts every session that identity has captured, past and future — not a
  properly-scoped per-session secret. See §4.

## 3. Can `@memora-hq/memora-verifier` run in a browser to verify signatures client-side?

**No, not as published.** Evidence:

`@memora-hq/memora-verifier@0.1.0` `package.json`
(`/tmp/memora-pkg-research/verifier/package/package.json`):

```json
{
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "type": "module",
  ...
}
```

No `"browser"` field, no `"exports"` conditional map (so no browser/node split is even possible
via resolution — everyone gets `dist/index.js`). The barrel `dist/index.js` unconditionally
re-exports every submodule:

```js
export * from "./identity.js";
export * from "./manifest.js";
export * from "./store.js";
export * from "./session.js";
export * from "./verify.js";
```

and those submodules import Node built-ins directly, confirmed by grep over the unpacked dist:

```
verifier/package/dist/manifest.js:1:import { createHash } from "node:crypto";
verifier/package/dist/bundle.js:1:import { readFile, stat, writeFile } from "node:fs/promises";
verifier/package/dist/bundle.js:2:import { createHash } from "node:crypto";
verifier/package/dist/identity.js:1:import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
verifier/package/dist/identity.js:2:import { dirname } from "node:path";
verifier/package/dist/verify.js:1:import { createHash } from "node:crypto";
verifier/package/dist/store.js:1:import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
verifier/package/dist/store.js:2:import { join } from "node:path";
verifier/package/dist/session.js:1:import { createHash, randomBytes } from "node:crypto";
```

`node:fs/promises` has no browser equivalent at all (not a polyfill gap, a fundamental one — a
browser has no local filesystem), and it's imported at module top-level in `store.js` and
`identity.js`, both of which are unconditionally re-exported by the package's only entry point.
Any bundler resolving `@memora-hq/memora-verifier` (even just to import `verifyBundle`) has to
resolve those specifiers because ESM static import graphs are resolved before dead-export
elimination; Vite/webpack5/esbuild do not auto-polyfill `node:*` specifiers by default, so this
fails to build in a plain browser app without hand-rolled bundler aliases — and `node:fs` can't be
aliased to anything meaningful client-side regardless.

The crypto engine underneath, `@memora-hq/memora-protocol@0.1.0-rc.2`, is worse: it's plain CJS
(`package.json` has no `"type"` field → CommonJS default) and calls Node's `crypto` module
directly, not Web Crypto/`SubtleCrypto`:

```
protocol/package/dist/crypto.js:10:const crypto_1 = require("crypto");
protocol/package/dist/envelope.js:61:const crypto_1 = require("crypto");
protocol/package/dist/tee.js:23:const crypto_1 = require("crypto");
protocol/package/dist/merkle.js:29:const crypto_1 = require("crypto");
```

`crypto.js`'s `createCipheriv`/`createDecipheriv`/`createHash` (used for AES-256-GCM and SHA-256,
per §1) are Node-only APIs, not portable JS or Web Crypto calls. The one bright spot: `ethers@6`
(used for ECDSA sign/verify in `envelope.ts`/`manifest.js`, e.g. `verifyMessage`) is genuinely
isomorphic and does run in browsers via standard bundlers — so *signature recovery/verification*
specifically is not the blocker; the blockers are (a) `node:fs` baked into the verifier's only
entry point, and (b) AES-GCM/SHA-256 implemented via `node:crypto` rather than Web Crypto or a
portable JS crypto library, with no browser build/export condition offered.

## 4. Does handing over the content key leak anything beyond one session?

**Yes — significantly.** As shown in §2, `encryptionKey(identity)` is:

```js
createHash("sha256").update("memora:local:encryption:v1\n" + identity.privateKey).digest()
```

This has no session, event, or export-time component — it is a fixed function of the device
identity's private key alone. Consequences:

- **Not per-session, not per-bundle.** The exact same 32-byte key encrypts every event this
  identity has ever recorded (`LocalSession.record()` in `session.js` calls
  `encrypt(canonical, encryptionKey(this.options.identity))` for every event of every session) and
  every event it will ever record until the identity is rotated. A key handed out for "publish
  session A" also decrypts sessions B, C, ... captured before or after, on the same device.
- **Not derivable back to the private key.** Because it's a one-way SHA-256 hash of the private
  key (not, say, the private key itself, or an encoding of it), leaking the derived AES key does
  *not* let an attacker recover `identity.privateKey` or forge signatures — preimage resistance of
  SHA-256 holds. So the device's *signing* identity stays safe even if a derived content key
  leaks. Only confidentiality of content is at risk, but for the identity's *entire* history, not
  one session.
- There is no envelope-encryption layer (no per-session random data key wrapped by the identity
  key) and no KDF context/salt varying by session — confirmed by re-reading `session.ts`/`.js` in
  full: `encryptionKey` takes only `identity`, nothing else, anywhere in the call graph
  (`record()`, `collectDisclosures()` in `bundle.js`, `verifySession()` in `verify.js` all call
  `deriveLocalEncryptionKey(identity)`/`encryptionKey(identity)` with no additional arguments).

## What protocol change would be required

Given §2 and §4, shipping "publish one session, hand its key to a viewer" safely needs a change
in `@memora-hq/memora-protocol` and/or `@memora-hq/memora-verifier` (both live in the
`memora-hq/memora-sdk` / `memora-hq/memora-protocol` repos per their `package.json`
`repository` fields — cross-repo work, not something `memora-local` alone can land):

1. **A session-scoped key derivation.** Replace (or add alongside) the current
   `encryptionKey(identity) = sha256(domain + privateKey)` with something that folds in a
   per-session value, e.g. `sha256(domain + privateKey + sessionId)` or, better, a proper HKDF
   (`hkdf(privateKey, salt=sessionId, info="memora:share:v1")`). Two implementation shapes:
   - **(a) Re-derive-and-re-encrypt at export time.** Cheapest, no bundle format change: export
     would decrypt every event with the device key and re-encrypt each payload under a fresh
     session-scoped key before writing the `.memora` bundle (or a new share-bundle variant), and
     hand that session key out via the URL fragment. Existing `EncryptedPayloadBundle` shape
     (`{version, alg, nonce, ciphertext, tag}`) is reusable as-is.
   - **(b) Envelope encryption at write time.** Generate a random per-session AES data key when a
     `LocalSession` starts, encrypt events under it as today, then wrap that data key with the
     identity key and store the wrapped key in the manifest/bundle. This needs a new field (e.g.
     `manifest.wrapped_content_key`) and a version bump of `LocalExecutionManifestV1`/
     `LocalEvidenceBundleV2` (→ V3), plus a wrap/unwrap primitive in `memora-protocol`. More
     invasive but avoids re-encrypting on every export.
   Either path is new code in `@memora-hq/memora-protocol` (new derivation/wrap function) and/or
   `@memora-hq/memora-verifier` (export/import plumbing) — not achievable by `memora-local` alone.

2. **A browser-safe verification/decryption path.** At minimum:
   - Swap `node:crypto`'s `createCipheriv`/`createDecipheriv`/`createHash` in
     `memora-protocol/src/crypto.ts` (and the `createHash` calls in `envelope.ts`, `merkle.ts`,
     `tee.ts`) for Web Crypto (`crypto.subtle`) or a portable JS crypto library, gated behind a
     build target / conditional `exports` map (`"browser"` condition) so Node builds keep using
     the fast native path.
   - Split `@memora-hq/memora-verifier`'s fs-free verification logic (`verifyBundle`,
     `disclosedPayload`, the pure parts of `verify.ts`) away from its fs-dependent modules
     (`store.js`, `identity.js`) so a browser bundle can import the former without dragging in
     `node:fs/promises`, or ship a separate `@memora-hq/memora-verifier/browser` entry (or a new
     package) that only exposes the portable subset.
   - Add real `"exports"`/`"browser"` fields to both packages' `package.json` and a version bump,
     since none exist today.

Until (1) lands, the *mechanism* the ticket asks about (fragment-carried key, decrypt
client-side) is extractable today without touching `memora-protocol`'s public API, but it would
publish a key that unlocks the user's entire local history, not the one session being shared —
not an acceptable trade for a "publish-to-share" beta. Until (2) lands, a hosted web viewer
can't actually run the decrypt/verify code at all, so key handover alone doesn't close the loop.

## Sources consulted

- `@memora-hq/memora-protocol@0.1.0-rc.2` (via `npm pack`, unpacked to
  `/tmp/memora-pkg-research/protocol/package/`):
  - `package.json` (no `"type"`, CJS; no `"browser"`/`"exports"` fields)
  - `src/crypto.ts` / `dist/crypto.js` — AES-256-GCM `encrypt`/`decrypt`, `require("crypto")`
  - `src/envelope.ts` / `dist/envelope.js` — ECDSA signing/verification via `ethers`,
    `require("crypto")` for hashing
  - `src/types.ts` — `LocalEvidenceBundleV1`/`V2`, `EncryptedPayloadBundle`, `KeyStoreRow`,
    `MemoryPayload`
  - `dist/tee.js`, `dist/merkle.js` — additional `require("crypto")` usage
  - `vectors/bundle-v2-sealed.memora` — real conformance bundle showing payload/ciphertext shape
- `@memora-hq/memora-verifier@0.1.0` (via `npm pack`, unpacked to
  `/tmp/memora-pkg-research/verifier/package/`):
  - `package.json` (`"type": "module"`, no `"browser"`/`"exports"` fields)
  - `dist/index.js` — barrel `export *` of all submodules
  - `dist/session.js` / `dist/session.d.ts` — `encryptionKey`/`deriveLocalEncryptionKey`,
    `LocalSession.record()`
  - `dist/bundle.js` / `dist/bundle.d.ts` — `exportLocalBundle`, `collectDisclosures`,
    `verifyBundle`, `ExportBundleOptions`
  - `dist/identity.js` / `dist/identity.d.ts` — `LocalIdentity`, `FileKeyProvider`
  - `dist/manifest.js`, `dist/store.js`, `dist/verify.js` — Node built-in imports
- Local repo (`memora-hq/memora-local`, branch `research/e2e-content-key-handover`):
  - `packages/cli/src/cli.ts` — `cmdLocalExport` (lines 147–155), `cmdLocalVerifyBundle`
    (157–173), import block showing `exportLocalBundle`/`readLocalBundle`/`verifyBundle` sourced
    from `@memora-hq/memora-verifier`, not a local package (lines 40–49)
  - `apps/desktop/src/main/main.ts` (line 354) — same `exportLocalBundle` call pattern from the
    desktop app
  - `pnpm-lock.yaml` — confirms resolved versions `@memora-hq/memora-protocol@0.1.0-rc.2` and
    `@memora-hq/memora-verifier@0.1.0`, matching the packages downloaded and inspected above
