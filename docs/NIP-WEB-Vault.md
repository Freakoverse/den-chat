# NIP-WEB-Vault — Origin-Isolated Web Key Vault

> **Status:** Draft / Proposal · **Authors:** DEN Chat · **Requires:** [NIP-07] semantics (re-used, not the transport)
>
> This is **not** an official ratified NIP. It is a proposed, implementation-backed convention for delivering a Nostr signer (and, optionally, blockchain transaction signing) as an **origin-isolated web iframe** instead of a browser extension or a relay-based remote signer. It re-uses NIP-07's *method shapes* but defines its own *transport* (same-page `postMessage`, zero network).

---

## 1. Abstract

`NIP-WEB-Vault` describes how a web/PWA application (the **Client**) can store and use a user's secret keys without ever holding them, by delegating all key operations to a **Vault** — a minimal web app served from a **separate origin**, embedded as a hidden `<iframe>`, and addressed exclusively over `postMessage`. The key is generated, encrypted at rest, decrypted, and used for signing **entirely inside the Vault origin**; the Client only ever sends *requests* and receives *results*.

It targets the gap left by the two existing signer delivery mechanisms:

- **[NIP-07]** (`window.nostr`) requires a **browser extension** — unavailable on most mobile browsers.
- **[NIP-46]** (Nostr Connect) requires **relays + a remote signer + a push service** — network-dependent, more infrastructure.

`NIP-WEB-Vault` is the **no-extension, no-relay, mobile-first local** option: a same-device iframe signer that makes **zero network requests**.

---

## 2. Motivation

A web app that holds a raw key in its own origin is one XSS away from total compromise. Moving the key into a separate origin embedded as an iframe means the Client's JavaScript — even if fully XSS-compromised — **cannot read the key**: the Same-Origin Policy denies it access to the Vault's DOM, storage, and memory. The Client can only ask the Vault to perform operations, and (for sensitive ones) the **Vault itself** renders the confirmation UI, so a compromised Client cannot forge *what the user is approving*.

This document specifies the transport, the operation surface, the at-rest format, the **session & confirmation model**, and the **security requirements** an implementation MUST meet.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119.

---

## 3. Terminology

| Term | Meaning |
|---|---|
| **Client** | The application embedding the Vault (e.g. `https://web.example.com`). |
| **Vault** | The signer web app, served from its own origin (e.g. `https://vault.example.org`), embedded by the Client as an iframe. |
| **Operation** (`op`) | A named request the Client sends to the Vault (`signEvent`, `unlock`, …). |
| **Overlay** | A full-viewport UI the Vault renders inside its own iframe for interactive steps (PIN entry, confirmation, seed reveal). |
| **Seed** | A stored secret (BIP-39 mnemonic, `nsec`, or hex key), encrypted at rest under one PIN. |
| **Account** | A public identity derived from a Seed (index for HD seeds; index 0 for single keys). |

---

## 4. Architecture

```
┌─────────────────────────── Client origin (web.example.com) ───────────────────────────┐
│  app code  ──postMessage──▶  hidden <iframe src="https://vault.example.org">            │
│            ◀──postMessage──                                                              │
│                                   │                                                     │
│                ┌──────────────────┴──────────────────── Vault origin ──────────────────┐│
│                │  key gen · encrypted IndexedDB · signing · in-iframe Overlay UI        ││
│                │  no network (connect-src 'none')                                       ││
│                └────────────────────────────────────────────────────────────────────── ┘│
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

1. The Vault MUST be served from a **different origin** than the Client.
2. The Vault SHOULD be served from a **different registrable domain (eTLD+1)** than the Client, so browser Site Isolation places it in a **separate OS process** (defends against Spectre-class cross-origin reads; a subdomain shares the Client's process).
3. The Vault MUST make **no network requests** at runtime (enforced via CSP `connect-src 'none'`).
4. The Vault is embedded **hidden** (0×0 / `visibility:hidden`) and is only made visible when it needs an Overlay (§6).

---

## 5. Transport

### 5.1 Message format

All messages are JSON-serializable objects sent with `postMessage`, targeted at the counterpart's exact origin (never `"*"`).

**Request** (Client → Vault):
```json
{ "id": "r17", "type": "signEvent", "params": { "event": { ... } } }
```

**Response** (Vault → Client):
```json
{ "id": "r17", "ok": true,  "result": { ... } }
{ "id": "r17", "ok": false, "error": "Locked" }
```

- `id` MUST be unique per in-flight request; the Vault MUST echo it.
- The Client MUST correlate responses by `id` and SHOULD time out requests it considers abandoned (interactive ops require a long timeout — minutes — because they await user input).

### 5.2 Handshake & overlay control (Vault → Client, unsolicited)

| `type` | Meaning |
|---|---|
| `vault-ready` | Sent once the Vault has loaded and is ready to receive ops. |
| `vault-overlay` `{ show: boolean }` | Asks the Client to resize the iframe to a full-viewport overlay (`show:true`) or back to hidden (`show:false`). |

### 5.3 Origin gating (both directions, normative)

- The Vault MUST ignore any message whose `event.origin` is not in its configured **allow-list of Client origins** (`ALLOWED_PARENT_ORIGINS`).
- The Vault MUST set `Content-Security-Policy: frame-ancestors <client-origin(s)>` so only authorized Clients can embed it.
- The Client MUST ignore any message whose `event.origin` is not the Vault origin.
- Neither side MUST EVER use `postMessage(..., "*")`.

---

## 6. The Overlay (interactive) model

Operations that require a **secret, a PIN, or an explicit user confirmation** MUST be performed through an Overlay rendered **by the Vault, inside the Vault's iframe**. The secret/PIN MUST NOT be passed in by the Client.

Flow:
1. Client calls an interactive op (e.g. `unlockInteractive`, `signTransaction`).
2. Vault sends `vault-overlay {show:true}`; the Client resizes the iframe to cover the viewport.
3. Vault renders its own UI (PIN field, confirmation rows, seed words …), collects input, performs the operation.
4. Vault sends `vault-overlay {show:false}`; the iframe returns to hidden.
5. Vault resolves the original request with a **non-secret** result (e.g. a pubkey, a signed payload), never the seed or PIN.

Because the Overlay is the Vault's own DOM in the Vault's origin, a compromised Client **cannot** read what is typed into it, nor alter what is displayed for confirmation.

---

## 7. Core signing operations (the NIP-07 surface)

These re-use NIP-07's method semantics. They require the Vault to be **unlocked** (§9); see §10 for when the user is prompted.

| `type` | Params | Result |
|---|---|---|
| `getPublicKey` | — | `string` (hex pubkey) |
| `signEvent` | `{ event }` (unsigned event) | signed event (`id`, `pubkey`, `sig` populated) |
| `nip04Encrypt` | `{ pubkey, plaintext }` | `string` |
| `nip04Decrypt` | `{ pubkey, ciphertext }` | `string` |
| `nip44Encrypt` | `{ pubkey, plaintext }` | `string` |
| `nip44Decrypt` | `{ pubkey, ciphertext }` | `string` |

A conforming Client SDK SHOULD expose these as a standard `window.nostr` provider so existing NIP-07-consuming apps work unchanged.

---

## 8. Transaction signing (OPTIONAL extension)

For non-Nostr chains (e.g. BTC / EVM). This is OPTIONAL and SHOULD be a separable module — Nostr-only deployments omit it.

| `type` | Params | Result |
|---|---|---|
| `signTransaction` | `{ chain, tx }` — **structured** inputs (recipient, amount, UTXOs / nonce+gas, …), never a pre-built sighash | `{ signed }` (raw signed tx hex) |

Normative requirements:
- The Vault MUST build the sighash itself from the structured inputs, so the confirmation it displays cannot be forged by the Client.
- The Vault MUST render an in-Overlay confirmation showing the human-readable amount + recipient (decoding e.g. ERC-20 calldata) and MUST require a **per-transaction PIN**, regardless of session state (§9, §10).


---

## 9. Lifecycle, locking & sessions

### 9.1 At-rest format

- Each Seed is encrypted with **PBKDF2-SHA256 (≥ 600,000 iterations) → AES-256-GCM** under the user's PIN/password. (Reference uses this exact format; it doubles as the portable backup file, see §11.)
- One PIN per Seed; all Accounts under a Seed share it.
- Keys are stored in the Vault origin's IndexedDB. Plaintext keys MUST NOT be persisted.

### 9.2 Lock state

- **Locked** — no decrypted key in memory. Signing ops fail with `"Locked"`.
- **Unlocked** — the Vault holds the decrypted key in memory for the active Account. Reached via `unlockInteractive` (PIN entered in Overlay).
- The Vault MUST **auto-lock after idle** (reference: 30 minutes; implementations SHOULD make this configurable) by zeroing the in-memory key.
- On a lock-during-use, the Client SDK SHOULD perform **transparent re-unlock**: catch the `"Locked"` error, prompt re-unlock via the Vault Overlay, and retry the original op once.

### 9.3 PIN-attempt rate limiting (normative)

The Vault MUST rate-limit PIN attempts **per Seed**, persisted across reloads, with escalating lockout after a small number of free attempts (reference: a few free tries, then escalating timed lockouts). This caps offline-style brute forcing of a PIN by a compromised Client that can repeatedly call unlock.

---

## 10. Confirmation model

This profile is **single-client by design**: one Vault deployment serves exactly one Client origin (§5.3) — the way a per-project subdomain does (`denchat.dekev.top` ↔ `web.denchat.top`). The Vault therefore has **no per-app permission system**: there is one app, the user chose to use it, and it is trusted to *request* operations.

> **Why not a permission model?** A per-(client, capability) grant system (`ask`/`session`/`always` per app) only earns its place when **one shared Vault serves several mutually-distrusting apps** — the [NIP-46] / browser-extension situation. That is **explicitly out of scope** here. Deploy **one Vault origin per project** instead: besides removing the need for permissions, it keeps each project's keys in a **separate origin**, so a compromise of one project's Client cannot reach another project's keys (§13). A single shared Vault would concentrate every project's keys behind one door and widen the blast radius.

What the Vault *does* gate is **unlocking** and **confirmation** — that is what makes it strictly safer than a Client holding a raw key:

| Operation class | When the user is asked |
|---|---|
| **Unlock** | Once per session — the seed PIN, entered in the Overlay (§6). Auto-locks on idle (§9.2); a lock-during-use triggers transparent re-unlock. |
| **Nostr signing** (`getPublicKey`, `signEvent`, `nip04*`, `nip44*`) | **Not** re-prompted while unlocked — signs for the current session, then re-unlock after idle-lock. |
| **Transaction signing** (`signTransaction`) | **Every time** — an in-Overlay confirm of amount + recipient **plus a PIN**, regardless of session state. Value never auto-approves. |
| **Secret-touching management** (reveal/export, change-PIN, delete, derive, import) | **Every time** — performed interactively in the Overlay (§11); the PIN/secret is entered there. |

This is the same trust shape as logging into a Nostr client with your `nsec` (one trusted app signs for itself) — except the key is **origin-isolated**, signing is gated behind a **session PIN** with **idle auto-lock**, and money + secret operations **re-confirm in the Vault's own UI**.

---

## 11. Lifecycle & management operations

Secret-touching variants are **interactive** (suffix `Interactive`): the PIN/secret is entered in the Overlay and never passed by the Client. Non-interactive variants exist for back-compat where the Client already holds a value, but new deployments SHOULD prefer the interactive ones.

| `type` | Purpose | Interactive? |
|---|---|---|
| `status` | seeds + accounts + active + unlocked flags | no |
| `listAccounts` | enumerate accounts | no |
| `generateInteractive` | generate a new seed; reveal + back-up + set PIN **in-Overlay**; returns only the new pubkey | yes |
| `importInteractive` | import phrase / nsec / hex / encrypted-backup (paste, file, or **QR scan**); set/enter PIN in-Overlay | yes |
| `deriveInteractive` | derive the next HD account under a seed | yes (PIN) |
| `unlockInteractive` | unlock an account (PIN in-Overlay) | yes (PIN) |
| `lock` | zero the in-memory key | no |
| `removeInteractive` | delete an account/seed (PIN-confirmed) | yes (PIN) |
| `exportRevealInteractive` | reveal the secret + offer encrypted backup (download / **QR**) **in-Overlay**; the plaintext is never returned to the Client | yes (PIN) |
| `changePinInteractive` | re-encrypt a seed under a new PIN | yes (PIN) |
| `renameSeed` / `renameAccount` | rename labels (non-secret) | no |

**Backup format.** The encrypted backup file is the v1 payload of §9.1:
```json
{ "version": 1, "alg": "AES-256-GCM", "kdf": "PBKDF2-SHA256",
  "iterations": 600000, "salt": "<base64>", "iv": "<base64>", "ciphertext": "<base64>" }
```
It is interchangeable: a backup produced by one conforming implementation MUST be importable by another. Backups MAY be exchanged as a file **or** as a QR encoding of this JSON (ciphertext only — safe to handle outside the Vault, since the PIN is required to decrypt).

---

## 12. Security requirements (summary, normative)

1. Vault MUST be a **distinct origin**; SHOULD be a **distinct registrable domain** (process isolation).
2. Vault MUST enforce a strict CSP: `default-src 'none'`, `connect-src 'none'`, `frame-ancestors <client(s)>`. (`media-src`/`img-src` only as needed for QR camera/render.)
3. Vault MUST gate inbound messages by Client origin; both sides MUST avoid `postMessage("*")`.
4. The decrypted key MUST NOT leave the Vault origin and MUST NOT be returned to the Client by any op.
5. Secrets/PINs MUST be entered in the **Vault Overlay**, never passed in by the Client.
6. `signTransaction` MUST build its own sighash and require a per-tx in-Overlay PIN + confirm.
7. Keys at rest MUST use PBKDF2 (≥600k) → AES-GCM; PIN attempts MUST be rate-limited per Seed; the Vault MUST auto-lock on idle.

---

## 13. Threat model & non-goals (be honest)

**Protects against:**
- **XSS / full compromise of the Client origin** — cannot read the key (SOP), cannot exfiltrate it, cannot forge the confirmation UI (rendered in the Vault). At worst, while unlocked, it can *request* the Nostr signatures the session allows — but it cannot steal the key or auto-approve a transaction (per-tx PIN), and because each project has its **own** Vault origin, it cannot reach another project's keys.
- **Spectre-class cross-origin reads** — mitigated when the Vault is on a separate registrable domain (separate process).

**Does NOT protect against (out of scope — true for browser extensions too):**
- **A malicious browser extension** with host permissions. Extensions are more privileged than pages, bypass CSP, and can read the Vault origin's DOM/storage. No web-page mechanism can block this. → Mitigation is *not* a web page: a native app with an OS keyring, a hardware signer, or user extension hygiene.
- **Device-level malware** (keylogger, memory scraper, rooted OS). Defeats any software key store.

**Platform guidance.** This profile is strongest where extensions don't exist: **mobile (PWA / browser)**. On **desktop**, prefer a **native app with OS keyring** or a **NIP-07 extension**; treat the Vault there as a convenience fallback, not the maximum-assurance option.

---

## 14. Relationship to other specs

| | NIP-07 (extension) | NIP-46 (remote) | **NIP-WEB-Vault (this)** |
|---|---|---|---|
| Delivery | browser extension | separate app + relays + push | same-page iframe |
| Network | none | relays (network) | **none** |
| Where keys live | extension origin/process | the remote signer | **separate web origin (separate process if cross-site)** |
| Works on mobile browsers | rarely | yes | **yes** |
| Cross-device | no | yes | no (same device/browser) |
| App-facing API | `window.nostr` | NIP-46 connect | `window.nostr` shim over `postMessage` |

`NIP-WEB-Vault` is complementary, not a replacement: a Client SHOULD offer the **best signer available per platform** — native keyring (desktop app) → NIP-07 extension (if present) → Vault (mobile / no extension) → NIP-46 (remote).
