# NIP-SKD: Sub-Key Derivation

`draft` `optional`

> **Status**: Draft. The scheme is identified by the stable salt `"nip-skd-v1"`.

## Abstract

NIP-SKD defines two signer capabilities:

1. **Deterministic derivation of application-scoped keys** from the user's identity key, via
   HKDF (optionally combined with ECDH to a peer), under a fixed, versioned salt.
2. **Operating as those derived keys ("sub-keys") without ever exposing their private
   material to the client.**

Together they let an application give a user a private, deterministic keyspace: per-purpose,
per-context identities (and other keyed constructs such as shared wallets) that are
reproducible on any device holding the root key, unlinkable in public, and usable through
remote/browser signers — because nothing sensitive ever crosses the signer boundary.

## Motivation

Today's signers expose `getPublicKey`, `signEvent`, and NIP-04/44 encrypt/decrypt. They
compute `ECDH(priv, peer)` and HKDF **internally** for encryption, but expose neither a
scoped derivation nor a way to act as a derived key. Applications that need a **stable,
unlinkable, per-context pseudonym** (or any app-scoped key) therefore cannot support
remote/browser signers at all — the only value the signer will emit is a randomized
ciphertext.

Deterministic sub-keys deliberately trade some privacy for **operability**. They are *less*
private than NIP-17 giftwraps — a stable per-context key is linkable *within* that context,
where a giftwrap uses a fresh ephemeral key and a randomized timestamp every time. But that
same randomness is exactly what makes giftwraps a **moderation and spam-resistance
nightmare**: with no stable author and jittered timestamps, there is nothing to ban, rate, or
order. A deterministic sub-key keeps a **stable, verifiable pseudonymous identity** —
bannable, attestable, sortable — while still hiding the real key from the public. It is not a
replacement for giftwraps but a different point on the tradeoff curve, useful wherever an
application needs *accountable pseudonymity* rather than maximal unlinkability.

NIP-CHAT v2 is the driving consumer: each member acts under a per-hub pseudonym derived from
their key, and each hub is authored under a derived owner pseudonym, so that real identities
never appear in public. But the mechanism is general — any app can carve out its own
deterministic sub-keyspace.

## Terminology

- **root key** — the user's active identity keypair (`root_priv`, `root_pub`).
- **context** — an application-supplied, non-empty, namespaced string identifying the
  purpose of a derivation. Public, not secret.
- **sub-key** — a keypair deterministically derived from the root key and a context (and,
  for the shared form, a peer public key).

## 1. Derivation

Two forms, both **HKDF-SHA256** (RFC 5869), both under the fixed salt **`"nip-skd-v1"`**:

**Self derivation** (no peer):
```
seed = HKDF-SHA256(IKM = root_priv, salt = "nip-skd-v1", info = context, L = 48)
```

**Shared derivation** (with a peer public key):
```
shared = secp256k1_ecdh_x(root_priv, peer_pub)     // 32-byte X-coordinate, as NIP-44 uses
seed   = HKDF-SHA256(IKM = shared,   salt = "nip-skd-v1", info = context, L = 48)
```

The `seed` is a **48-byte (384-bit)** HKDF output, reduced to a valid secp256k1 secret key:
`sub_priv = seed mod n`, and on the ~2^-384 chance the reduction is `0`, implementations **MUST**
take `sub_priv = 1`. This keeps the derivation **total and deterministic** — the zero case is *pinned*,
not left undefined, so every conforming implementation derives the same sub-key for that input rather
than diverging (one throwing, another mapping elsewhere). `sub_pub = sub_priv · G` (x-only, BIP-340).

> **Why 48 bytes (wide reduction).** Reducing exactly 256 bits `mod n` would be very slightly biased
> because `n` is a hair below `2^256`. Per RFC 9380 §5, the seed is `L = ceil((ceil(log2(n)) + k) / 8)
> = ceil((256 + 128) / 8) = 48` bytes (a 128-bit security margin), which makes `mod n` **unbiased by
> construction** (statistical distance ≈ 2^-256). Implementations MUST take exactly 48 bytes from HKDF —
> the reduction is defined on that width.

**Byte encodings** (also pinned by the §8 test vectors — an implementation that reproduces §8 satisfies
all of these by construction):

- `salt` (`"nip-skd-v1"`) and `context` are encoded as **UTF-8** before entering HKDF.
- The 48-byte HKDF `seed` is interpreted as a **big-endian** unsigned integer for `seed mod n`.
- In the shared form, `peer_pub` is a 32-byte **x-only** key (BIP-340). It is reconstructed as the
  even-`y` point (`02‖x`) before the ECDH, and `secp256k1_ecdh_x` is the **raw** 32-byte x-coordinate
  of the resulting shared point — the same value NIP-44 feeds into its KDF, **not** its `sha256`.

Both forms are **deterministic** in `(root key, context[, peer])` and reproduce identically
anywhere the root key is available. HKDF's two stages carry the separation:

- **salt** (`"nip-skd-v1"`) — scheme separation. It differs from NIP-44's `"nip44-v2"`, so no
  NIP-SKD output can reproduce a NIP-44 conversation key, even on the same ECDH input.
- **info** (`context`) — purpose separation. Distinct contexts yield independent keys, so two
  purposes that share an `IKM` (e.g. two derivations against the same peer) never collide.

### 1.1 The `context` (info) rules

- MUST be **non-empty**.
- SHOULD be **namespaced** by the consuming protocol/app (e.g. `"nip-chat:v2:..."`) to avoid
  cross-app collisions on the same input.
- MUST be **stable** per purpose — the derived key depends on it; changing the string changes
  the key.

## 2. Operations (sub-signer)

A conforming signer **MUST NOT** return the `seed`, the `sub_priv`, the raw ECDH result, or
`HKDF(root_priv, ·)` to the client. It exposes operations that **use** the sub-key
internally:

- `getSubkeyPubkey(context[, peer]) → sub_pub`
- `signAsSubkey(context[, peer], event) → event` — a BIP-340 signature by `sub_priv`. The signer
  **MUST** treat the supplied `event` as final: set `pubkey = sub_pub`, compute `id` over the event
  **exactly as given**, and sign. It **MUST NOT** alter `created_at`, `tags` (including any
  proof-of-work `nonce` tag), or `kind`. Clients may mine proof-of-work (NIP-13) against `sub_pub`
  *before* requesting the signature, so re-stamping `created_at` or reordering/stripping tags would
  invalidate the already-mined `id`. A signer's ordinary `sign_event` path that re-times or normalizes
  the template MUST be bypassed here — sign the client's event byte-for-byte.
- `nip44EncryptAsSubkey(context[, peer], recipient, plaintext) → ciphertext`, and its
  matching `nip44DecryptAsSubkey`. The **NIP-04** equivalents (`nip04EncryptAsSubkey` /
  `nip04DecryptAsSubkey`) are defined identically, for signers that still support NIP-04.

`peer` is a trailing argument present **only** for shared derivations; self derivations **omit** it.
Signers **MUST** distinguish self from shared by the argument's **presence**, never by an empty-string
sentinel.

### 2.1 Interactivity

`getSubkeyPubkey` is a **read-only** derivation that returns a public key — no secret, no signature.
A signer **SHOULD** answer it **non-interactively** (no user-approval prompt), exactly as it already
answers `get_public_key` (NIP-46) or the injected `getPublicKey` (NIP-07). This is required for the
capability probe in §6/§7 to work: a client detects support by *calling* `getSubkeyPubkey`, so a
signer that routes it through an approval prompt turns feature-detection into a hanging request and
appears not to support NIP-SKD at all. Treat it as the same public-information class as
`get_public_key`.

`signAsSubkey` produces a signature and **MUST** follow the signer's normal authorization model for
signing (typically explicit user consent, unless the user has pre-authorized the app or a
`skd:<context-prefix>` grant — §4). The encrypt/decrypt-as-subkey operations **SHOULD** follow the
signer's authorization model as well; a signer **MAY** answer them non-interactively for a trusted
connection (some transports, e.g. NIP-UPV2, auto-execute all non-signing sub-key ops) or require
consent — but `signAsSubkey` is never made non-interactive by default.

## 3. Security invariant

A signer implementing NIP-SKD **MUST NEVER** expose to the client:

- the raw ECDH shared secret `secp256k1_ecdh_x(root_priv, peer_pub)`,
- the raw `HKDF(root_priv, ·)` or the derived `seed`,
- any sub-key's private key.

Internal derivation and internal use are unrestricted, provided every purpose uses a
**distinct, non-empty, domain-separated `context`**. (The `context` requirement is a
*key-separation* rule, not an exposure rule — it prevents different features derived from the
same input from colliding, even though nothing is exposed.)

There is intentionally **no** "export the derived secret" method. Applications that want to
act as a derived identity do so through §2 operations; the private material stays in the
signer. Clients holding a **local key** may derive directly — that is the same trust boundary
as the root key they already hold.

## 4. Permissions

Operations SHOULD be gated by user permission, mirroring NIP-04/44 approval. Because
`context` is public and any caller may request any string (including another app's), the
security boundary is **authorization, not the context**:

- A signer SHOULD let the user grant an app/connection a **shared permission pool** over a
  context **prefix** (e.g. "allow `nip-chat:*`"), auto-approving all derivations and sub-key
  operations under it — analogous to a `bunker://` connection's permission grant, with one
  toggle rather than a per-operation prompt storm.
- Sub-keys MAY carry narrower, per-context permissions if the user prefers.

## 5. Versioning

The **salt carries the scheme version.** A backwards-incompatible change — a different
construction, or a deliberate salt rotation — increments it: `nip-skd-v2`, `nip-skd-v3`, …
Signers MAY support multiple versions concurrently. Consumers **MUST select a version
explicitly** (never "latest") so derivations stay reproducible. (NIP-CHAT does this by
recording `["signer_scheme", "skd", "<n>"]` on the hub; see NIP-CHAT §0.)

## 6. Client interface (NIP-07)

```ts
window.nostr.skd = {
  getSubkeyPubkey(context: string, peerPub?: string): Promise<string>,
  signAsSubkey(context: string, event: EventTemplate, peerPub?: string): Promise<Event>,
  nip44: {
    encryptAsSubkey(context: string, recipient: string, plaintext: string, peerPub?: string): Promise<string>,
    decryptAsSubkey(context: string, sender: string, ciphertext: string, peerPub?: string): Promise<string>,
  },
  nip04: { /* same shape */ },
}
```

Feature-detection: `typeof window.nostr?.skd?.getSubkeyPubkey === 'function'`.

## 7. Remote signer (NIP-46)

New request methods, mirroring §6:

```
skd_get_subkey_pubkey        params: [context]                        (+ peer for shared)
skd_sign_as_subkey           params: [context, event]                 (+ peer)
skd_nip44_encrypt_as_subkey  params: [context, recipient, plaintext]  (+ peer)
skd_nip44_decrypt_as_subkey  params: [context, sender, ciphertext]    (+ peer)
skd_nip04_encrypt_as_subkey  params: [context, recipient, plaintext]  (+ peer)   # NIP-04 signers only
skd_nip04_decrypt_as_subkey  params: [context, sender, ciphertext]    (+ peer)   # NIP-04 signers only
```

`peer`, when present, is the **trailing** positional parameter; it is **omitted entirely** for self
derivations (never sent as an empty string — see §2). A client discovers support by attempting
`skd_get_subkey_pubkey` and handling a method-not-supported response — so a signer **MUST** answer
that method non-interactively (§2.1), the same as `get_public_key`, or the probe stalls and the
signer wrongly appears to lack NIP-SKD. Connection permission grants extend the connection's
permission set with `skd:<context-prefix>` entries (§4).

**Other transports.** The method names and their logical parameters above are the contract; the
**positional-array** encoding is specific to NIP-46. A non-NIP-46 signer protocol (e.g. NIP-UPV2)
binds these same methods and parameters using its own request encoding — see that transport's
specification (for NIP-UPV2, the params are a named JSON object rather than a positional array).
The derivation itself (§5) and the test vectors (§8) are transport-independent, so a pseudonym
derived over any transport is byte-identical.

**Capability discovery when the probe is unavailable.** The two discovery mechanisms above — the §6
method-presence check and the §7 attempt-`skd_get_subkey_pubkey` probe — both assume the *client* can
tell whether the *signer* implements NIP-SKD by inspecting or calling the signer directly. Some
transports break that assumption:

- An **in-process adapter** (e.g. a same-page iframe vault reached over `postMessage`) defines the
  method wrappers on the client side unconditionally, so method-presence is always true regardless of
  what the backend supports — the §6 check gives a false positive.
- A signer that **cannot answer the probe non-interactively** — e.g. a vault that is locked by default
  and needs `sessionPriv` before it can derive — would reject or stall the §7 probe while locked,
  giving a false negative.

Such a transport SHOULD advertise support **out-of-band in its own handshake** (a static capability
of the deployed build, independent of lock state) rather than relying on method-presence or a live
probe, and the client SHOULD treat the absence of that advertisement as "no NIP-SKD" — gating v2 off,
the same outcome as a failed §7 probe. This keeps feature-detection accurate for a backend that is
outdated or locked, instead of enabling operations it would later reject. The advertised value names
the derivation scheme (§5), e.g. `skd:1`. This is a discovery mechanism only; the methods, parameters,
and derivation remain exactly as specified above. (DEN Chat's iframe vault does this: its ready
handshake carries `capabilities: ["skd:1"]`.)

## 8. Test vectors

Generated from the reference implementation (`client/src/lib/crypto/skd.ts`) and verified,
including the ECDH symmetry that underpins owner-verification. `ecdh_x` is the **raw**
x-coordinate of the shared point (the x-only peer reconstructed as even-y `02||x`); `xonly(·)`
drops the parity byte; `reduce_mod_n` maps the **48-byte** seed to a secp256k1 scalar (wide
reduction — see §1).

```
# ── self derivation (NIP-CHAT owner pseudonym O) ──
root_priv = 1111111111111111111111111111111111111111111111111111111111111111
context   = "nip-chat:v2:owner-pseudonym:abc-123"
seed      = HKDF-SHA256(IKM=root_priv, salt="nip-skd-v1", info=context, L=48)
sub_pub   = xonly(reduce_mod_n(seed)·G)
         => 1a899ab5f78459554ba2aad008af3459597fd7906066a306f17d22415e2c59ee     # = O_pub

# ── shared derivation (NIP-CHAT member pseudonym P) ──
root_priv = 2222222222222222222222222222222222222222222222222222222222222222     # member R
peer_pub  = 1a899ab5f78459554ba2aad008af3459597fd7906066a306f17d22415e2c59ee     # owner O_pub (above)
context   = "nip-chat:v2:member-pseudonym:abc-123"
seed      = HKDF-SHA256(IKM=ecdh_x(root_priv, peer_pub), salt="nip-skd-v1", info=context, L=48)
sub_pub   = xonly(reduce_mod_n(seed)·G)
         => be1eee04aba10e55fcf58ba2bd65a9c1c02c8abad9f2d607e7a511fde33cf251     # = P_pub

# ── symmetry (owner re-derives the same P → owner-verification) ──
# member R_pub (of root_priv 2222…) = 466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27
# owner derives shared with (O_priv, R_pub, same member context) and gets the identical P_pub,
# because ecdh_x(O_priv, R_pub) == ecdh_x(R_priv, O_pub)  ⇒  be1eee04…e33cf251   ✓
```

The shared derivation feeds the **raw** ECDH x-coordinate into HKDF (as NIP-44 does), **not**
`sha256(x)` — a signer implementation must match this to reproduce the vectors.

## 9. Reference consumer — NIP-CHAT v2

- **Owner pseudonym `O`** (self): `context = "nip-chat:v2:owner-pseudonym:" + d_tag`, `IKM =
  R_owner_priv`. The hub is authored by `O`; the creator's real key never appears publicly.
- **Member pseudonym `P`** (shared): `context = "nip-chat:v2:member-pseudonym:" + d_tag`,
  `IKM = ECDH(R_member_priv, O_pub)`. The owner re-derives the same `P` from
  `ECDH(O_priv, R_member_pub)`, giving owner-verification and squat-resistance.

Both are used through §2 sub-signer operations on remote signers, or derived directly on a
local key. See NIP-CHAT §0.1, §4.5, §6.3.
