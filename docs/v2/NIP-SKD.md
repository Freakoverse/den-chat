# NIP-SKD: Sub-Key Derivation

`draft` `optional`

> **Status**: Draft. The scheme is identified by the stable salt `"nip-skd-v1"`. It offers three
> derivation **forms** — `self`, `shared`, and `blinded` — all under that one scheme version.

## Abstract

NIP-SKD defines two signer capabilities:

1. **Deterministic derivation of application-scoped keys** from the user's identity key, via
   HKDF (optionally combined with ECDH to a peer), under a fixed, versioned salt. Three forms are
   defined — a **self** key (from the root alone), a **shared** key (a fresh key both parties to an
   ECDH derive in full), and a **blinded** key (the root key blinded so the peer can derive its
   *public* key to verify, but never its private key).
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
their key (a **blinded** key, so the hub owner can verify a pseudonym belongs to a member
without being able to act as them), and each hub is authored under a derived owner pseudonym (a
**self** key), so that real identities never appear in public. But the mechanism is general —
any app can carve out its own deterministic sub-keyspace.

## Terminology

- **root key** — the user's active identity keypair (`root_priv`, `root_pub`).
- **context** — an application-supplied, non-empty, namespaced string identifying the
  purpose of a derivation. Public, not secret.
- **form** — one of `self`, `shared`, `blinded` (§1). The form is part of the domain
  separation (it is folded into the HKDF `info`) and each form has its own operations (§2).
- **sub-key** — a keypair deterministically derived from the root key and a context (and, for
  the `shared` and `blinded` forms, a peer public key). Covers all three forms; where the
  distinction matters, `blinded` keys are called out explicitly.
- **blinded key** — a sub-key of the `blinded` form: `root_pub + t·G` where `t` is a scalar
  derived from the two-party ECDH secret. The root holder can compute its private key
  (`root_priv + t`); the peer can compute only its public key (verify, not impersonate).

## 1. Derivation

Three forms, all **HKDF-SHA256** (RFC 5869), all under the fixed salt **`"nip-skd-v1"`**. The
HKDF `info` is **domain-separated by form** so no two forms ever share a `seed` on the same
inputs:

```
info(form, context) = "nip-skd:" ‖ form ‖ 0x1F ‖ context      // form ∈ { "self", "shared", "blinded" }
```

`0x1F` is the ASCII **unit separator**; it makes the form/context boundary unforgeable — no
`context` value (even one literally starting with `"blinded:"`) can impersonate another form's
prefix. `salt`, the form tag, and `context` are all **UTF-8**; `0x1F` is a single raw byte.

Let `reduce(seed)` be the **48-byte (384-bit)** HKDF output interpreted as a big-endian integer,
reduced `mod n` (the secp256k1 order), with the ~2^-384 case `0` pinned to `1` (see the note
below). `xonly(·)` is the x-coordinate (BIP-340). `G` is the generator, `n` the group order.

**Self derivation** (no peer) — an independent sub-key from your own root:
```
seed     = HKDF-SHA256(IKM = root_priv, salt = "nip-skd-v1", info = info("self", context), L = 48)
sub_priv = reduce(seed)
sub_pub  = xonly(sub_priv · G)
```

**Shared derivation** (peer public key) — an independent sub-key from the two-party ECDH secret;
**both** parties derive the identical keypair (`ecdh_x` is symmetric):
```
shared   = secp256k1_ecdh_x(root_priv, peer_pub)     // 32-byte X-coordinate, as NIP-44 uses
seed     = HKDF-SHA256(IKM = shared, salt = "nip-skd-v1", info = info("shared", context), L = 48)
sub_priv = reduce(seed)
sub_pub  = xonly(sub_priv · G)
```

**Blinded derivation** (peer public key) — the root key **blinded** by the two-party ECDH secret.
The root holder gets the private key; the peer can derive only the **public** key (to verify a
binding, never to sign as it):
```
shared       = secp256k1_ecdh_x(root_priv, peer_pub)
seed         = HKDF-SHA256(IKM = shared, salt = "nip-skd-v1", info = info("blinded", context), L = 48)
t            = reduce(seed)                               // blinding scalar (tweak); reduce() pins t away from 0
blinded_priv = (root_priv_evenY + t) mod n
if blinded_priv == 0:  blinded_priv = 1                  // ~2^-256 invalid-key edge (t ≡ -root_priv)
blinded_pub  = xonly( lift_even_y(root_pub) + t·G )
```

- **Both directions land on the same `blinded_pub`.** The root holder derives it as above. A peer
  who holds the *other* ECDH private key derives the **same** key from the peer's side — see
  §2 (`getPeerBlindedPubkey`) — because `ecdh_x` is symmetric and the base is `root_pub` in both
  computations. The peer never obtains `blinded_priv`; recovering it would require `root_priv`
  (a discrete log from `root_pub`).

**The `reduce` pins.** `reduce(seed)` maps the wide seed to `[1, n-1]`, pinning `0 → 1`. This keeps
every form total and deterministic:
- For **self** and **shared**, `reduce(seed)` *is* the sub-key private scalar; the `0 → 1` pin is
  pure totality (which valid scalar the ~2^-384 case maps to is immaterial).
- For **blinded**, `reduce(seed)` is the tweak `t`, and the `0` pin is a **hard requirement, not
  just totality**: `t = 0` would make `blinded = root` (the pseudonym would *equal* the real key,
  leaking it). Pinning `t` away from `0` prevents that. The additional `blinded_priv == 0` pin
  covers the other ~2^-256 edge, `t ≡ -root_priv`, which would otherwise yield an invalid key.

**Even-y normalization (blinded only).** Nostr/BIP-340 public keys are x-only and denote the
**even-y** point, so the blinded key must be computed on that convention identically on both sides
(the Taproot / BIP-341 key-tweak rule):
- `lift_even_y(root_pub)` reconstructs the even-y point `02‖x` from the x-only `root_pub`.
- `root_priv_evenY` is the scalar whose point is that even-y point: `root_priv` if `root_priv·G`
  already has even `y`, else `n − root_priv`.

The root holder MUST add `t` to `root_priv_evenY` (not to the raw stored key), and the verifier MUST
add `t·G` to `lift_even_y(root_pub)` — otherwise an odd-`y` `root_pub` makes the two sides compute
different `blinded_pub`. (BIP-340 signing then handles the parity of `blinded_pub` itself, as usual.)

> **Why 48 bytes (wide reduction).** Reducing exactly 256 bits `mod n` would be very slightly biased
> because `n` is a hair below `2^256`. Per RFC 9380 §5, the seed is `L = ceil((ceil(log2(n)) + k) / 8)
> = ceil((256 + 128) / 8) = 48` bytes (a 128-bit security margin), which makes `mod n` **unbiased by
> construction** (statistical distance ≈ 2^-256). Implementations MUST take exactly 48 bytes from HKDF —
> the reduction is defined on that width.

**Byte encodings** (also pinned by the §8 test vectors — an implementation that reproduces §8 satisfies
all of these by construction):

- `salt` (`"nip-skd-v1"`), the form tag, and `context` are encoded as **UTF-8**; the `0x1F` separator
  is a single raw byte between the form tag and `context`.
- The 48-byte HKDF `seed` is interpreted as a **big-endian** unsigned integer for `reduce`.
- In the shared and blinded forms, `peer_pub` is a 32-byte **x-only** key (BIP-340). It is
  reconstructed as the even-`y` point (`02‖x`) before the ECDH, and `secp256k1_ecdh_x` is the **raw**
  32-byte x-coordinate of the resulting shared point — the same value NIP-44 feeds into its KDF, **not**
  its `sha256`.
- In the blinded form the base is `lift_even_y(root_pub)` (even-`y` `02‖x`), the output is
  `xonly(base + t·G)` (elliptic-curve point addition, then x-only), and the private tweak is applied to
  `root_priv_evenY` as above.

All forms are **deterministic** in `(root key, form, context[, peer])` and reproduce identically
anywhere the root key is available. HKDF's two stages carry the separation:

- **salt** (`"nip-skd-v1"`) — scheme separation. It differs from NIP-44's `"nip44-v2"`, so no
  NIP-SKD output can reproduce a NIP-44 conversation key, even on the same ECDH input.
- **info** (form + context) — purpose **and form** separation. Distinct contexts yield independent
  keys; the form tag additionally guarantees the three forms never share a `seed` on the same inputs.
  This is essential for **shared vs blinded**: they use the same `IKM = ecdh_x(R,O)` and the same
  `context`, so **without** the form tag they would compute the *identical* `seed`. An observer who
  then saw both `shared_pub = seed·G` and `blinded_pub = root_pub + seed·G` for that pair could
  recover `root_pub = blinded_pub − shared_pub` — deanonymizing the root. The distinct `info` makes the
  two seeds independent, so `blinded_pub − shared_pub` is a random point and the leak is closed by
  construction.

### 1.1 The `context` (info) rules

`context` is the **application-supplied** portion of `info`; the derivation prepends the fixed
`"nip-skd:" ‖ form ‖ 0x1F` domain tag (§1). The rules below govern `context`:

- MUST be **non-empty**.
- SHOULD be **namespaced** by the consuming protocol/app (e.g. `"nip-chat:v2:..."`) to avoid
  cross-app collisions on the same input.
- MUST be **stable** per purpose — the derived key depends on it; changing the string changes
  the key.

The same `context` MAY be used with more than one form (the form tag keeps the seeds independent),
but a consumer SHOULD still pick one form per purpose to avoid confusion.

## 2. Operations (sub-signer)

A conforming signer **MUST NOT** return the `seed`, any sub-key or blinded private key, the raw
ECDH result, or `HKDF(root_priv, ·)` to the client. It exposes operations that **use** the derived
key internally. The form is selected by the **method name** (not by argument presence); `peer` is a
required parameter of the shared and blinded methods and absent from the self methods.

**Self** (no peer):
- `getSelfSubkeyPubkey(context) → sub_pub`
- `signAsSelfSubkey(context, event) → event`
- `nip44EncryptAsSelfSubkey(context, recipient, plaintext) → ciphertext`, `nip44DecryptAsSelfSubkey(context, sender, ciphertext) → plaintext` (+ `nip04*` equivalents for NIP-04 signers)

**Shared** (peer required):
- `getSharedSubkeyPubkey(context, peer) → sub_pub`
- `signAsSharedSubkey(context, event, peer) → event`
- `nip44EncryptAsSharedSubkey(context, recipient, plaintext, peer)`, `nip44DecryptAsSharedSubkey(context, sender, ciphertext, peer)` (+ `nip04*`)

**Blinded** (peer required):
- `getBlindedPubkey(context, peer) → blinded_pub` — the **caller's own** blinded key (base = the
  caller's root, blinded toward `peer`). The signer also holds `blinded_priv` for the sign/encrypt ops.
- `getPeerBlindedPubkey(context, peer) → blinded_pub` — a **peer's** blinded key toward the caller
  (base = `peer`, blinded with `ecdh_x(caller_root, peer)`). **Public key only** — this is the
  verifier-side derivation. There is deliberately **no** operation to *act as* a peer's blinded key;
  that is the property that lets a verifier confirm a `blinded ↔ root` binding without being able to
  impersonate it.
- `signAsBlinded(context, event, peer) → event` — sign as the caller's own blinded key.
- `nip44EncryptAsBlinded(context, recipient, plaintext, peer)`, `nip44DecryptAsBlinded(context, sender, ciphertext, peer)` (+ `nip04*`)

Every `signAs*` operation **MUST** treat the supplied `event` as final: set `pubkey` to the derived
public key, compute `id` over the event **exactly as given**, and sign. It **MUST NOT** alter
`created_at`, `tags` (including any proof-of-work `nonce` tag), or `kind`. Clients may mine
proof-of-work (NIP-13) against the derived pubkey *before* requesting the signature, so re-stamping
`created_at` or reordering/stripping tags would invalidate the already-mined `id`. A signer's ordinary
`sign_event` path that re-times or normalizes the template MUST be bypassed here — sign the client's
event byte-for-byte.

### 2.1 Interactivity

The pubkey derivations — `getSelfSubkeyPubkey`, `getSharedSubkeyPubkey`, `getBlindedPubkey`, and
`getPeerBlindedPubkey` — are **read-only**: they return a public key, no secret and no signature. A
signer **SHOULD** answer them **non-interactively** (no user-approval prompt), exactly as it answers
`get_public_key` (NIP-46) or the injected `getPublicKey` (NIP-07). This is required for the capability
probe in §6/§7 to work: a client detects support by *calling* a pubkey op, so a signer that routes it
through an approval prompt turns feature-detection into a hanging request and appears not to support
NIP-SKD at all. Treat them as the same public-information class as `get_public_key`.

The `signAs*` operations produce a signature and **MUST** follow the signer's normal authorization
model for signing (typically explicit user consent, unless the user has pre-authorized the app or a
`skd:<context-prefix>` grant — §4). The encrypt/decrypt-as-subkey operations **SHOULD** follow the
signer's authorization model as well; a signer **MAY** answer them non-interactively for a trusted
connection (some transports, e.g. NIP-UPV2, auto-execute all non-signing sub-key ops) or require
consent — but the `signAs*` operations are never made non-interactive by default.

## 3. Security invariant

A signer implementing NIP-SKD **MUST NEVER** expose to the client:

- the raw ECDH shared secret `secp256k1_ecdh_x(root_priv, peer_pub)`,
- the raw `HKDF(root_priv, ·)` or the derived `seed`,
- any sub-key's private key, **including a blinded key's private scalar `root_priv + t`** (which is
  a linear offset of the root key — exposing it would reveal `root_priv` to anyone who also knows `t`,
  e.g. the ECDH peer).

Internal derivation and internal use are unrestricted, provided every purpose uses a **distinct,
non-empty, domain-separated `context`**, and every form uses its **distinct form tag** in `info` (§1).
The `context` rule is a *key-separation* rule (it stops different features from colliding); the
form-tag rule additionally stops the **shared** and **blinded** forms from sharing a seed on the same
inputs, which would leak the root by subtraction (§1). Neither exposes anything — they are correctness
invariants.

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

The three **forms** (`self`, `shared`, `blinded`) are **not** versions — they coexist under one
scheme version and are selected per-operation (§2). The form is carried in the HKDF `info`, not the
salt, so adding or choosing a form never changes the scheme version. A signer that advertises `skd:1`
(§7) implements all three forms.

## 6. Client interface (NIP-07)

```ts
window.nostr.skd = {
  // self
  getSelfSubkeyPubkey(context: string): Promise<string>,
  signAsSelfSubkey(context: string, event: EventTemplate): Promise<Event>,
  nip44EncryptAsSelfSubkey(context: string, recipient: string, plaintext: string): Promise<string>,
  nip44DecryptAsSelfSubkey(context: string, sender: string, ciphertext: string): Promise<string>,

  // shared (both parties derive the same keypair)
  getSharedSubkeyPubkey(context: string, peerPub: string): Promise<string>,
  signAsSharedSubkey(context: string, event: EventTemplate, peerPub: string): Promise<Event>,
  nip44EncryptAsSharedSubkey(context: string, recipient: string, plaintext: string, peerPub: string): Promise<string>,
  nip44DecryptAsSharedSubkey(context: string, sender: string, ciphertext: string, peerPub: string): Promise<string>,

  // blinded (caller owns the private key; a peer can derive only the public key to verify)
  getBlindedPubkey(context: string, peerPub: string): Promise<string>,       // my own blinded key
  getPeerBlindedPubkey(context: string, peerPub: string): Promise<string>,   // a peer's blinded key (verify) — pubkey only
  signAsBlinded(context: string, event: EventTemplate, peerPub: string): Promise<Event>,
  nip44EncryptAsBlinded(context: string, recipient: string, plaintext: string, peerPub: string): Promise<string>,
  nip44DecryptAsBlinded(context: string, sender: string, ciphertext: string, peerPub: string): Promise<string>,

  // nip04* equivalents of each nip44* method, for signers that still support NIP-04
}
```

Feature-detection: `typeof window.nostr?.skd?.getSelfSubkeyPubkey === 'function'` (a signer exposing
the surface implements all three forms).

## 7. Remote signer (NIP-46)

New request methods, mirroring §6:

```
# self
skd_get_self_subkey_pubkey          params: [context]
skd_sign_as_self_subkey             params: [context, event]
skd_nip44_encrypt_as_self_subkey    params: [context, recipient, plaintext]
skd_nip44_decrypt_as_self_subkey    params: [context, sender, ciphertext]

# shared
skd_get_shared_subkey_pubkey        params: [context, peer]
skd_sign_as_shared_subkey           params: [context, event, peer]
skd_nip44_encrypt_as_shared_subkey  params: [context, recipient, plaintext, peer]
skd_nip44_decrypt_as_shared_subkey  params: [context, sender, ciphertext, peer]

# blinded
skd_get_blinded_pubkey              params: [context, peer]     # my own blinded key
skd_get_peer_blinded_pubkey         params: [context, peer]     # a peer's blinded key (verify) — pubkey only
skd_sign_as_blinded                 params: [context, event, peer]
skd_nip44_encrypt_as_blinded        params: [context, recipient, plaintext, peer]
skd_nip44_decrypt_as_blinded        params: [context, sender, ciphertext, peer]

# skd_nip04_* equivalents of each nip44 method, for NIP-04 signers only
```

`peer` is a **fixed positional parameter** of the shared and blinded methods; the self methods have no
`peer` parameter (the form is chosen by the method name, not by argument presence). A client discovers
support by attempting `skd_get_self_subkey_pubkey` and handling a method-not-supported response — so a
signer **MUST** answer that method non-interactively (§2.1), the same as `get_public_key`, or the probe
stalls and the signer wrongly appears to lack NIP-SKD. Connection permission grants extend the
connection's permission set with `skd:<context-prefix>` entries (§4).

**Other transports.** The method names and their logical parameters above are the contract; the
**positional-array** encoding is specific to NIP-46. A non-NIP-46 signer protocol (e.g. NIP-UPV2)
binds these same methods and parameters using its own request encoding — see that transport's
specification (for NIP-UPV2, the params are a named JSON object rather than a positional array).
The derivation itself (§1, §5) and the test vectors (§8) are transport-independent, so a pseudonym
derived over any transport is byte-identical.

**Capability discovery when the probe is unavailable.** The two discovery mechanisms above — the §6
method-presence check and the §7 attempt-`skd_get_self_subkey_pubkey` probe — both assume the *client*
can tell whether the *signer* implements NIP-SKD by inspecting or calling the signer directly. Some
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
the derivation scheme (§5), e.g. `skd:1`, and implies support for all three forms. This is a discovery
mechanism only; the methods, parameters, and derivation remain exactly as specified above. (DEN Chat's
iframe vault does this: its ready handshake carries `capabilities: ["skd:1"]`.)

## 8. Test vectors

> **⚠️ Regeneration required.** The vectors below must be **regenerated from the reference
> implementation** (`client/src/lib/crypto/skd.ts`) after it implements this revision. Two changes
> invalidate every prior value: (1) `info` now carries the `"nip-skd:" ‖ form ‖ 0x1F` domain tag, so
> even the `self` and `shared` outputs change; (2) the `blinded` form is new. The `=> …` result lines
> are placeholders until then. Each conforming signer (client, vault, DENOS) MUST reproduce the
> regenerated values byte-for-byte. Include at least one **blinded** case whose `root_pub` has **odd
> y**, to pin the even-`y` normalization.

`ecdh_x` is the **raw** x-coordinate of the shared point (the x-only peer reconstructed as even-y
`02||x`); `xonly(·)` drops the parity byte; `reduce(·)` maps the **48-byte** seed to a secp256k1 scalar
(wide reduction, `0 → 1`; see §1); `lift_even_y(·)` reconstructs the even-`y` point from an x-only key.

```
# ── self derivation (NIP-CHAT owner pseudonym O) ──
root_priv = 1111111111111111111111111111111111111111111111111111111111111111
context   = "nip-chat:v2:owner-pseudonym:abc-123"
info      = "nip-skd:self" ‖ 0x1F ‖ context
seed      = HKDF-SHA256(IKM=root_priv, salt="nip-skd-v1", info=info, L=48)
sub_pub   = xonly(reduce(seed)·G)
         => <regenerate>     # = O_pub

# ── shared derivation (independent key both parties derive; NOT used by NIP-CHAT v2) ──
root_priv = 2222222222222222222222222222222222222222222222222222222222222222
peer_pub  = <O_pub above>
context   = "nip-skd:example:shared:abc-123"
info      = "nip-skd:shared" ‖ 0x1F ‖ context
seed      = HKDF-SHA256(IKM=ecdh_x(root_priv, peer_pub), salt="nip-skd-v1", info=info, L=48)
sub_pub   = xonly(reduce(seed)·G)
         => <regenerate>

# ── blinded derivation (NIP-CHAT member pseudonym P) ──
root_priv = 2222222222222222222222222222222222222222222222222222222222222222     # member R
peer_pub  = <O_pub above>                                                          # owner O_pub
context   = "nip-chat:v2:member-pseudonym:abc-123"
info      = "nip-skd:blinded" ‖ 0x1F ‖ context
seed      = HKDF-SHA256(IKM=ecdh_x(root_priv, peer_pub), salt="nip-skd-v1", info=info, L=48)
t         = reduce(seed)
P_pub     = xonly( lift_even_y(root_pub) + t·G )      # root_pub = R_pub
         => <regenerate>     # = P_pub

# ── blinded symmetry (owner re-derives the same P → owner-verification) ──
# member R_pub (of root_priv 2222…) = <regenerate>
# owner computes getPeerBlindedPubkey(context, peer=R_pub) with IKM=ecdh_x(O_priv, R_pub) and
# base = lift_even_y(R_pub); by ECDH symmetry the seed (hence t) is identical, so
#   xonly(lift_even_y(R_pub) + t·G)  ==  P_pub above     ✓  (owner never learns P_priv = R_priv + t)

# ── blinded, odd-y base (pins even-y normalization) ──
# choose a root_priv whose root_pub has odd y; verify the holder (using root_priv_evenY = n - root_priv)
# and the verifier (using lift_even_y(root_pub)) both produce the same blinded_pub.
#   => <regenerate>
```

The shared and blinded forms feed the **raw** ECDH x-coordinate into HKDF (as NIP-44 does), **not**
`sha256(x)` — a signer implementation must match this to reproduce the vectors.

## 9. Reference consumer — NIP-CHAT v2

NIP-CHAT v2 uses **self** (for the owner) and **blinded** (for members and the join address); it does
**not** use the `shared` form.

- **Owner pseudonym `O`** (self): `context = "nip-chat:v2:owner-pseudonym:" + d_tag`, `IKM =
  R_owner_priv`. The hub is authored by `O`; the creator's real key never appears publicly.
- **Member pseudonym `P`** (blinded): `context = "nip-chat:v2:member-pseudonym:" + d_tag`, base = the
  member's `R`, peer = `O_pub`. The member holds `P_priv = R_priv + t` (and signs as `P`); the owner
  re-derives the same `P_pub` via `getPeerBlindedPubkey(context, R_pub)` for owner-verification, leaf
  placement, and squat-resistance — but **cannot** obtain `P_priv`, so cannot impersonate the member.
- **Facilitated pseudonym `Pf`** (blinded): the same construction one level down — base = the
  facilitated user's `R`, peer = the facilitator's member pseudonym `P_fac`. The facilitator verifies
  via `getPeerBlindedPubkey` but cannot act as `Pf`.
- **Join address** (blinded): a per-join key, base = the applicant's `R`, peer = `O_pub`; the owner
  re-derives it from `R_pub` (after opening the sealed `R`) to confirm the applicant controls `R`.

All are used through §2 sub-signer operations on remote signers, or derived directly on a local key.
See NIP-CHAT §0.1, §4.5, §6.3.
