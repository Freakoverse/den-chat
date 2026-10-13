# NIP-MDM: Masked Direct Messages

`draft` `optional`

> **Status**: Draft v1. The masked sender identity is the NIP-SKD **blinded** form under the context `"nip-mdm:v1:peer"`.
> **Depends on**: NIP-01 (addressable events), NIP-09 (deletion), NIP-44, [`NIP-SKD.md`](./NIP-SKD.md) (the `skd:1` blinded ops this spec composes).
> **Companion**: [`NIP-SKD.md`](./NIP-SKD.md) (sub-key derivation), [`NIP-CHAT.md`](./NIP-CHAT.md) (the other NIP-SKD consumer, for hubs and groups).

## Abstract

NIP-MDM is a one-to-one direct message in which the **sender's root identity never appears on the
wire**. The sender writes under a per-recipient **masked key**: a NIP-SKD **blinded** sub-key of its own
root, blinded toward the recipient. The recipient is addressed by their **real** key, exactly as an
ordinary DM, so a recipient receives with no derivation and no enumeration: they simply subscribe to
their own key. A public observer sees a masked key delivering an encrypted message to a known recipient,
and cannot tell who the sender is.

This is **not** NIP-17 level privacy, and does not try to be. Like NIP-17, the recipient is visible
(addressed by their real key); unlike NIP-17, the sender uses one stable masked key per recipient instead
of a fresh ephemeral key per message, and timestamps and sizes are truthful rather than jittered, so a
sender's messages to a given recipient are publicly linkable to each other (never to the sender's real
key). It is **private enough** for its purpose: the sender is hidden from everyone, and both the content
and the sender's real identity are disclosed only to the recipient, who can cryptographically **verify**
that identity. Your outbound social graph is fully hidden; only the fact that you received something from
someone masked is visible.

It is a different tradeoff from a NIP-17 gift wrap. A gift wrap maximizes sender unlinkability with a
fresh ephemeral key per message and jittered timing, at the cost of being unorderable, unbannable, and
unsortable (both schemes reveal the recipient). A masked key is **stable, deterministic, and verifiable**:
the recipient confirms it
belongs to the claimed root (so it is accountable and spoof-proof), it is reproducible on every device
from the root key alone (so the sender's own devices recover their sent history from a static self-derived
reference, §3.4), and it is a single stable author (so messages order and thread normally). This is
*accountable sender
pseudonymity* rather than full-conversation anonymity.

It also needs **no dedicated relay list**. Where NIP-17 defines a separate DM-relay list (kind 10050) that
clients must publish, discover, and keep in sync, NIP-MDM delivers over the recipient's ordinary NIP-65
relays (kind 10002), falling back to the client's own relay list when the recipient advertises none (§5).
There is no second list for a user to manage.

NIP-MDM adds **no new signer operations**, but it does require a signer that supports **NIP-SKD** (scheme
`skd:1`): it is otherwise a pure composition of that scheme's blinded and self ops (§1), an addressing
convention (§2, §3), and one new event kind (§2). A signer without NIP-SKD support cannot participate.

## Motivation

NIP-04 direct messages publish both parties' **real** keys: the sender as the event author, the
recipient in a `p` tag. The content is encrypted, but the **social graph is not**: anyone can read the
full who-talks-to-whom map off the relays. NIP-17 hides the **sender** with gift wraps (the recipient is
still addressed in the clear by their real key), but the randomness that achieves it makes gift-wrapped
messages hard to order, rate, or ban, forces a self-addressed copy so the sender's own other devices can
read the thread, and adds a separate DM-relay list (kind 10050) that clients must publish and keep in
sync on top of the user's ordinary relay list.

Many conversations do not need to hide the recipient, they need to hide the **sender**. A reporter
contacting a public inbox, an anonymous tip to a known account, or simply not wanting your outbound
contacts enumerable: in all of these the recipient is content to be reachable in the clear, while the
sender wants to stay unidentified to the public yet **accountable to the recipient**. A per-recipient
masked sender key provides exactly that:

- **Sender privacy.** The event author is a blinded key; recovering the sender's root is a discrete log.
  The sender's identity is disclosed only inside the ciphertext, only to the recipient.
- **No recipient-side cost.** Because the recipient is addressed by their real key, they receive and
  decrypt with their own key and **never enumerate** candidate senders. (Masking the recipient instead
  would force them to derive and subscribe to a key per possible sender, which does not scale, this is
  precisely why the recipient is left in the clear.)
- **Accountability and spoof-proofing.** The masked key is stable per sender-recipient pair and the
  recipient can **verify** it belongs to a specific root (§1.3) in constant time. Only the real sender
  can author as it (it requires their blinded private scalar), so a verified message is **provably**
  from that sender. Forgery is infeasible, not merely detectable.
- **Determinism.** The masked key is a pure function of `(sender root, recipient root)`, and the sender's
  self-copies are addressed to static self-derived keys (§3.4), so every device of the sender rebuilds the full
  sent history from the root key alone, with no stored recipient list.

The honest cost is in §7: the recipient is not hidden, and timing and size are visible. NIP-MDM is a
point between NIP-04 and NIP-17, not a replacement for either.

## Terminology

- **root key** - a party's real Nostr identity keypair. The sender's root never appears on the wire; the
  recipient's root is the public address.
- **sender** `S` (`s_priv`/`S_pub`) and **recipient** `R` (`r_priv`/`R_pub`) - the two roots of one
  message. Roles alternate per message: a reply swaps them.
- **masked key** `M` - the sender's NIP-SKD blinded sub-key for a given recipient. `M = getBlindedPubkey(
  context, R_pub)` on the sender side; the recipient re-derives the same public key as `getPeerBlindedPubkey(
  context, S_pub)` to verify (§1).
- **context** - the fixed NIP-SKD context for masked identities: `"nip-mdm:v1:peer"` (§1.1).

## 1. The masked sender identity

### 1.1 Derivation

The masked key is the NIP-SKD **blinded** form (see [`NIP-SKD.md`](./NIP-SKD.md) §1) under one fixed
context:

```
context = "nip-mdm:v1:peer"      // form = blinded; namespaced by THIS standard, not by any app (NIP-SKD §1.1)
```

The context is fixed because the **recipient** argument already carries the pairing: the blinded form
folds `ecdh_x(s_priv, R_pub)` into the derivation, so the same sender produces a **different** masked key
for every recipient, with no per-conversation string needed. A sender's masked key toward Alice is thus
unlinkable to the same sender's masked key toward Bob, by construction.

For a message from sender root `S` to recipient root `R`:

```
M = getBlindedPubkey("nip-mdm:v1:peer", R_pub)        // NIP-SKD §2 blinded: base = S, ECDH(s, R). Sender holds M_priv.
```

The sender holds the private key `M_priv` and signs and encrypts as `M`. The sender's root `S` is never
published.

### 1.2 The recipient derives nothing to receive

The recipient is addressed by their real key `R` (§2), so to receive they subscribe to `R` and decrypt
with `r_priv` against the visible masked author `M` (§3). The recipient performs **no** derivation to
receive or decrypt. Derivation appears on the recipient side only to **verify** the sender (§1.3), and
that is a single constant-time operation, not an enumeration.

### 1.3 Verification (accountability and spoof-proofing)

The sender discloses its real key inside the ciphertext (the `from` field, §2.1). After decrypting, the
recipient verifies that the claimed sender actually produced the masked author:

```
getPeerBlindedPubkey("nip-mdm:v1:peer", S_pub) == event.pubkey      // S_pub read from the decrypted `from`
```

`getPeerBlindedPubkey` computes, on the recipient's side, the blinded key with base `S` and
`ecdh_x(r_priv, S)`; by ECDH symmetry this equals the sender's own `getBlindedPubkey(context, R)`. If it
matches, the message is **provably from `S`**: only a holder of `S`'s root, or of `M`'s blinded private
scalar `s_priv + t` (which is root-equivalent, NIP-SKD §3), can sign as `M`. A third party cannot craft
an event whose author equals `getPeerBlindedPubkey(context, S')` for a root `S'` it does not control, so
a forged `from` is rejected. The masked author doubles as the sender-authentication proof: no separate
signature-over-identity is needed.

The verification is one-sided-private: the recipient can convince **itself** that the sender is `S`, but
cannot prove it to a third party without revealing its own root (the derivation needs `ecdh(r, S)`).
That is the intended property, accountable to the recipient, opaque to everyone else.

Because `M` is stable per pair, a recipient MAY cache the `M -> S` mapping after the first verified
message and recognize later messages from the same sender immediately, and MAY rate-limit or block `M`
as a stable, bannable pseudonym.

### 1.4 Signer requirements

NIP-MDM needs only the **base** `skd:1` blinded surface (NIP-SKD §6/§7); it never needs the composed
verifier ops (NIP-SKD §1.2), because §1.3 is a plain root-to-root `getPeerBlindedPubkey`. The ops used:

| Side | Purpose | Op (NIP-SKD §2) |
| --- | --- | --- |
| Sender | Derive my masked key | `getBlindedPubkey(context, R_pub)` |
| Sender | Sign the message as my masked key | `signAsBlinded(context, event, R_pub)` |
| Sender | Encrypt to the recipient | `nip44EncryptAsBlinded(context, R_pub, plaintext, R_pub)` |
| Recipient | Decrypt | plain `nip44Decrypt(ciphertext, r_priv, M)` (no blinded op; recipient is unmasked) |
| Recipient | Verify the sender | `getPeerBlindedPubkey(context, S_pub)` |
| Sender | Self-copy (§3.4) | `getSelfSubkeyPubkey`, `signAsSelfSubkey`, `nip44EncryptAsSelfSubkey` / `nip44DecryptAsSelfSubkey` |

A local-key client derives directly (same trust boundary as the root it already holds). `getBlindedPubkey`,
`getPeerBlindedPubkey`, and `getSelfSubkeyPubkey` are read-only and **MUST** be answered non-interactively
by a signer (NIP-SKD §2.1). Feature detection is the base-surface check of NIP-SKD §6 (`getBlindedPubkey`
present), e.g. `signerSupportsSkd(signer)`. All of the above are **base** `skd:1` ops (blinded and self
forms), so NIP-MDM runs on any conforming signer, local or remote, with no new surface. In the blinded
encrypt op the `recipient` and `peer` arguments are the **same** value, `R_pub`: `peer` selects the masked
key (blinded toward `R`) and `recipient` is who the ciphertext is for (the real `R`).

## 2. The message event

A masked message is an **addressable** (parameterized-replaceable) event, kind **30092**:

```jsonc
{
  "kind": 30092,                            // addressable (30000-39999). 92 is the BIP-39 index of "mask". See §9.
  "pubkey": "<M>",                          // the sender's masked key for this recipient (NOT the sender's root)
  "created_at": <corrected unix seconds>,
  "tags": [
    ["d", "<random opaque message id>"],    // REQUIRED. Unique per message; makes each message its own addressable event.
    ["p", "<R_pub>"]                        // the recipient's REAL key - REQUIRED. The public address; the recipient is not masked.
  ],
  "content": "<NIP-44 ciphertext of the payload JSON (§2.1), from M to R_pub>",
  "sig": "<BIP-340 signature by M>"         // produced by signAsBlinded(context, event, R_pub)
}
```

The event is **addressable** rather than regular on purpose: it makes a message **editable** (§2.2),
which neither NIP-04 nor NIP-17 supports. Each message carries a unique `d` tag, so every message is its
own `(kind, pubkey, d)` coordinate and all messages are retained; editing a single message republishes
that one coordinate and the relay keeps only the latest version.

Only the `d` and `p` tags are public. The `d` tag **MUST** be an opaque random id (for example 16 random
bytes, hex): it is public, so it must carry no linkable information, it exists only to separate and
address messages. The message text, the sender's identity, reply references, and attachments all live
inside the encrypted payload (§2.1). A new message's `created_at` is public and truthful (it is **not**
jittered); stable ordering is part of the tradeoff, and the timing leak is discussed in §7.

The content is encrypted with `nip44EncryptAsBlinded(context, recipient = R_pub, plaintext, peer =
R_pub)`: the signer derives `M`'s private scalar internally and computes the NIP-44 conversation key
`conversationKey(M_priv, R_pub)`. The recipient decrypts with plain `nip44Decrypt(ciphertext, r_priv, M)`
(its real key against the visible masked author), which recomputes the identical key by ECDH symmetry.

### 2.1 Payload

The decrypted `content` is a UTF-8 JSON object:

```jsonc
{
  "v": 1,                         // payload version
  "from": "<hex sender root>",    // REQUIRED: the sender's real key, disclosed only to the recipient; verified per §1.3
  "t": "Hello",                   // message text (optional if an attachment-only message)
  "edited": 1733251200,           // optional: unix time of the latest edit (present only on an edit, §2.2)
  "reply": "30092:<authorM>:<d>", // optional: addressable coordinate of the message this replies to (kept private; survives edits)
  "attachments": [                // optional: structured file references (the same shape hub messages and DEN DMs use)
    {
      "hash": "<sha256 hex>",            // Blossom blob hash (the ciphertext blob's hash when encrypted)
      "type": "image/png",              // MIME type of the original file
      "name": "photo.png",              // original filename
      "size": 12345,                    // file size in bytes (ciphertext size when encrypted)
      "servers": ["https://blossom.example"],  // optional: Blossom servers the sender uploaded to
      "encryption": {                   // optional: present only for client-encrypted files
        "algorithm": "aes-gcm",
        "key": "<hex>",                 // AES-256 key (64 hex)
        "nonce": "<hex>",               // AES-GCM nonce (24 hex)
        "originalHash": "<sha256 hex>"  // hash of the plaintext file
      }
    }
  ],
  "emoji":   [["shortcode", "<url>"]],   // optional: custom emoji refs, as DEN DMs
  "sticker": [["id", "<url>"]],          // optional
  "gif":     [["id", "<url>"]]           // optional
}
```

A recipient **MUST** verify `from` per §1.3 before attributing or displaying a sender, **MUST** ignore
unknown fields, and **MUST** tolerate a missing `t` when an attachment is present. A message whose
`from` fails verification **MUST** be treated as unattributed (the stable masked key `M` is still a valid
opaque pseudonym; a client MAY drop it or surface it as "unverified sender").

The payload is **always** this versioned object, on every message, including one that is only plain
text. Three reasons:

1. **One shape for text and attachments.** A text-only message and one that carries `attachments` (or
   `emoji`, `sticker`, `gif`) share a single structure, so a reader parses the same object either way and
   never has to guess whether the content is a bare string or a wrapper.
2. **Privacy.** All of it, the message text, the sender's `from`, reply references, and every attachment
   field (filenames, sizes, and per-file encryption keys) lives inside the NIP-44 ciphertext, because
   only the `d` and `p` tags are public (§2). Putting attachment metadata in tags would expose it.
3. **No collision with user-typed JSON.** The user's own message is always the string value of `t`, one
   level deep, so content a user literally types, even `{"t":"hi"}` or `{"v":1,"text":"hi"}`, is stored
   and rendered verbatim as that string and can never be mistaken for the envelope. The reader also keys
   off `v`: it interprets the structured fields only when `v` is present (`v` is the payload version, so
   a future shape change bumps it per §9), which is the discriminator a bare-string format would lack.

### 2.2 Editing

An edit republishes the **same** `(kind, M, d)` coordinate with new encrypted content and a `created_at`
of **the original `created_at` plus one** (not the current time). The `+1` guarantees the edit supersedes
the original under NIP-01 addressable-replacement (newest `created_at` wins, lowest id on a tie) while
keeping the message in its original timeline position, so an edited message does not jump to the bottom of
the conversation. The payload MAY carry an `edited` timestamp (§2.1) so the recipient can show an
"edited" marker; the author is unchanged (`M`), so only the sender can edit their own message. No separate
edit-hint event is needed, the replacement is the edit.

## 3. Sending and receiving

### 3.1 Send (S to R)

1. `M = getBlindedPubkey(context, R_pub)`.
2. Build the payload (§2.1) with `from = S_pub`; `ciphertext = nip44EncryptAsBlinded(context, R_pub,
   payloadJson, R_pub)`.
3. Generate a random opaque `d` (for example 16 random bytes, hex).
4. Assemble the kind-30092 event with `pubkey = M`, `tags = [["d", d], ["p", R_pub]]`, `content =
   ciphertext`, `created_at = nowSeconds()` (the corrected clock), and sign with `signAsBlinded(context,
   event, R_pub)`.
5. Publish to the recipient's relays (§5). To **edit** later, repeat with the same `d` and `created_at =
   original + 1` (§2.2).

### 3.2 Receive (as R)

Subscribe to your real key, exactly as any DM:

```
received:  { kinds: [30092], "#p": [ R_pub ] }
```

For each event: decrypt `content` with plain `nip44Decrypt(content, r_priv, event.pubkey)`; read `from`;
verify `getPeerBlindedPubkey(context, from) == event.pubkey` (§1.3). On success, attribute the message to
`from`; on failure, treat as unverified. No candidate enumeration occurs at any step. Because the kind is
addressable, a relay returns only the latest version of each `(M, d)` coordinate, so a client naturally
receives edits as replacements; it keys a message locally by its `(M, d)` coordinate, not by event id.

### 3.3 The sender's own view

Given a counterparty `X`, either party reconstructs the full thread with two constant-time derivations:

```
I sent to X:   { kinds: [30092], authors: [ getBlindedPubkey(context, X_pub) ], "#p": [ X_pub ] }
X sent to me:  { kinds: [30092], authors: [ getPeerBlindedPubkey(context, X_pub) ], "#p": [ R_pub ] }
```

The **recipient** side needs no stored state: `{ kinds: [30092], "#p": [R_pub] }` returns everything
addressed to you, and each sender is attributed from its verified `from` (§3.2). The **sender** side has
no such single reference: each sent message is authored by a different per-recipient masked key `M`, so a
device holding only the root key does not know which `M`s to query and cannot list "everything I sent".
The sender's self-copies (§3.4) close that gap.

### 3.4 The sender's self-copies

So a sender can recover its own sent history on a device that holds only the root key, every message is
mirrored to a **self-copy** addressed to a key the sender alone can derive. Two NIP-SKD **self** sub-keys
serve this (self form, no peer, so both require the sender's root to derive and neither is linkable to the
sender's real key by anyone else):

```
C_from = getSelfSubkeyPubkey("nip-mdm:v1:copy-from")    // authors the self-copy; sender holds its private key
C_to   = getSelfSubkeyPubkey("nip-mdm:v1:copy-to")      // the self-copy's address; the sender subscribes here
```

When sending a kind-30092 message to `R`, the sender publishes a second kind-30092 event, identical in
kind and shape so it is indistinguishable from any masked message on the wire:

```jsonc
{
  "kind": 30092,
  "pubkey": "<C_from>",                        // the self-copy's author key (a sender self-key)
  "created_at": <the SAME value as the real message>,
  "tags": [
    ["d", "<its own unique random id - NOT the real message's d>"],   // see "no shared public identifier" below
    ["p", "<C_to>"]                            // the self-copy's address key (a sender self-key); the sender subscribes here
  ],
  "content": "<NIP-44 ciphertext from C_from to C_to of the self-copy payload (§3.4.1)>",
  "sig": "<BIP-340 by C_from>"                 // signAsSelfSubkey("nip-mdm:v1:copy-from", event)
}
```

The two events carry the **same `created_at`** and are **published together**; no timing offset is applied
(§7). Because the self-copy's recipient `C_to` is itself a masked self-key and not the sender's real key,
nothing on the wire addresses the copies to the sender or ties them to the sender's identity.

**No shared public identifier.** The self-copy's `d` is its **own** random id, not the real message's. The
two events deliberately share no public field that an observer could join on: a shared `d` would be a
hard, volume-proof link between the real message (`M → R`) and the self-copy (`C_from → C_to`), and since
`C_from` is stable across every conversation, that link would cluster all of a sender's masked keys and
reveal every recipient. The whole real event is instead carried **encrypted** inside the self-copy payload
(§3.4.1), so only the sender, who can decrypt it, knows the two events are a pair. The only residual
correlation is the shared `created_at`, a soft link that grows ambiguous as network volume rises (§7).

**Fetching.** A client fetches both streams under kind 30092:

```
received:    { kinds: [30092], "#p": [ R_pub ] }                       // messages others sent to me
my copies:   { kinds: [30092], authors: [ C_from ], "#p": [ C_to ] }   // copies of what I sent
```

`C_from` and `C_to` are static (fixed self-derivations from the root), so any device reproduces them with
no stored state. A client accepts a self-copy event only when its author equals the derived `C_from`. The
self-copy stream yields the sender's full sent history; combined with the received stream (each message
carrying its own verified `from`), a fresh device rebuilds the entire conversation list from the root key
alone.

**The self-copy stream is unspammable.** Both of its identifiers are keys only the sender can produce:
`C_from` is a keypair only the sender holds, so no one else can sign a valid event with that author, and
`C_to` is a secret self-key no one else can derive, so no one else can even address an event to it. The
`author == C_from` check is therefore both the authenticity check and an absolute spam guarantee: the
send/recovery side cannot be polluted at all. (The **received** side, `#p = [R_pub]` on the recipient's
real key, is openly addressable and so is spammable like any DM, which is what §4.1 and §4.2 are for.)

**Why two events and not one.** The self-copy handle must be static so a fresh device can fetch by it, and
the recipient address must be on the message, but if both lived on one public event an observer would
simply join the static handle to each recipient, rebuilding the outbound graph. A single static handle
placed as a second tag on the real message would be identical across all of a sender's messages and
visible to every recipient, linking all your sent messages and their recipients. Keeping the handle (`C_to`)
on a separate event whose `p` tag is `C_to` and which never carries a recipient (its only other tag is an
opaque `d`) is what prevents that join. The cost is one extra event per message.

#### 3.4.1 Self-copy payload

The self-copy's encrypted payload carries the **entire signed real message event**, verbatim, so the copy
is a complete backup of it, not a reconstruction:

```jsonc
{
  "v": 1,
  "event": { /* the full signed kind-30092 real message: pubkey=M, tags=[["d",<real d>],["p",R]], content, id, sig */ }
}
```

Everything the sender needs is inside that embedded event, so no separate `to`, `ref`, or text field is
required: the recipient `R` is its `p` tag, its coordinate is `(30092, M, <its d>)`, and the message text
is its `content`, which the sender decrypts with `M` (it holds `M`'s key, so `conversationKey(M_priv,
R)`). The two events still share nothing in public (§3.4): the real event's identifiers live only inside
the self-copy's ciphertext.

**Rebroadcast.** Because the copy holds the exact signed event, a sender whose message was dropped or
purged from the recipient's relays can re-publish it there **byte-for-byte**, same `id` and `sig`, with no
re-encryption (which NIP-44's random nonce would otherwise change) and no re-signing. The self-copy is
thus both the sender's recovery store and a durable backup of the delivered event.

**Editing and deletion.** An edit is a new real event `(30092, M, <real d>)` with new `content` at
`created_at + 1` (re-deriving `M`'s key from the root and `R`); the sender then republishes its own
self-copy `(30092, C_from, <copy d>)`, also at `created_at + 1`, embedding the **new** real event, so the
copy always holds the current version. The two `d`s are each an independent, unique random id (§2),
unrelated to each other and derived from nothing; the link between the two events exists only inside the
self-copy's ciphertext (the embedded event), never as a shared public tag.

## 4. Bootstrap, blocking, and spam

**Bootstrap.** To send you need the recipient's npub, exactly as any DM does; from it the sender derives
`M` and publishes. The recipient needs nothing in advance: they are addressable by their real key. The
sender's real identity reaches the recipient inside the first message's `from` field (verified per §1.3),
so a reply can be sent straight back (the recipient now holds `S_pub` and derives its own masked key
toward `S`). **No handshake event is ever published.**

### 4.1 Blocking

Blocking reuses the user's **normal block list** of real keys; there is no separate masked block list to
maintain. A blocked root `B` always authors toward this recipient `R` under the single deterministic
masked key `getPeerBlindedPubkey(context, B_pub)` (base `B`, `ecdh_x(r_priv, B)`), so the recipient drops
a blocked sender at the **author-pubkey level, before decrypting**:

- Keep a local `blockedMasked` set of masked keys known to belong to blocked roots.
- On each incoming event, if `event.pubkey ∈ blockedMasked`, drop it with no decryption and no further
  work (an O(1) set lookup, so a blocked flooder costs nothing per message).
- Otherwise decrypt and verify as usual (§3.2); if the verified `from` is in the block list, add
  `event.pubkey` to `blockedMasked` and drop. This **lazily** populates `blockedMasked` the first time a
  blocked person actually messages you (one decrypt, then zero forever), so a client need never derive for
  blocked roots that never contact you.

A client **MAY** instead **eagerly** precompute `blockedMasked` by deriving `getPeerBlindedPubkey(context,
B_pub)` for every blocked root, which lets it drop even a blocked sender's *first* message pre-decryption.
Each derivation is a single `getPeerBlindedPubkey` (about two secp256k1 scalar multiplications), it is
deterministic and cached permanently, and it is recipient-specific (it folds the recipient's own key into
the ECDH). A local-key client can derive a very large block list this way as a one-time background pass (a
10k-entry list is on the order of tens of seconds and never recomputed); the masked key is fixed per pair,
so a blocked sender cannot rotate it to evade, only a brand-new root escapes, exactly as with normal
blocking. A client backed by a **remote** signer SHOULD prefer the lazy variant, since each
`getPeerBlindedPubkey` is a (non-interactive) signer round-trip and an eager backfill of a large list over
a remote signer is impractical.

The same derivation underlies per-`M` **rate limiting**: `M` is a stable, bannable pseudonym, so a client
or relay can rate or mute a masked key with no knowledge of the root behind it.

### 4.2 Spam

Because the recipient is addressable in the clear, NIP-MDM has roughly the same unsolicited-contact
exposure as NIP-04: anyone can send. It is **not** spam-proof by construction (unlike a design that masks
the recipient). It does, however, give the recipient a strong handle to filter on: every message is
either (a) from a verifiable root `S` (the recipient can allowlist known contacts, or apply web-of-trust
to `S`), or (b) unverified, which a client MAY drop or quarantine. Combined with §4.1, a recipient filters
blocked senders pre-decryption and unknown senders post-verification.

Spam exposure is therefore one-sided: the **inbound** side is spammable like any DM, while the sender's
own **self-copy** stream (§3.4) is cryptographically unspammable, since its identifiers (`C_from`, `C_to`)
are self-keys only the sender can sign as or address.

## 5. Relays

The two events go to **different** relay sets, and each set has the same simple fallback: the party's own
NIP-65 (kind 10002) list, then the client's configured relay list, then failure. Two invariants hold in
every case:

- the **real message** is published to the **recipient's** relays, **never the sender's** (an event
  authored by the sender's masked key `M` sitting on the sender's own advertised relays would correlate
  `M` with the sender by relay residence, §7);
- the **self-copy** is published to the **sender's** relays, **never the recipient's** (its stable `C_to`
  appearing across several recipients' public relay lists would let those recipients be grouped as one
  sender's recipient set, §7).

The two sets only ever share the **client relay list**: a client's own configured/default relays, which
belong to neither party and so trigger neither correlation. Because clients read their own configured
relays, that shared set also serves as the delivery and recovery rendezvous when a personal list is
missing or unreachable.

**Real message** (`M`, `p = R_pub`): publish to the recipient's kind-10002 relays; if the recipient has
none, to the client's own relay list; if the client has none either, publishing fails. The recipient
subscribes `{ kinds: [30092], "#p": [R_pub] }` on those relays.

**Self-copy** (`C_from`, `p = C_to`): publish to the sender's own kind-10002 relays; if the sender has
none, to the client's own relay list; if neither, publishing fails. The sender reads
`{ kinds: [30092], authors: [C_from], "#p": [C_to] }` there.

**Failover.** A client publishes across the chosen set and fails over within it until at least one relay
(ideally a few, for redundancy) accepts the event; a relay that rejects or does not acknowledge is skipped
and the next is tried, expanding from the personal list into the client relay list. How a client decides a
relay is reachable or trustworthy (connectivity, acknowledgement, read-back, reputation) is left to the
client; this spec requires only the ordering above and the two invariants. If the whole chain including
the client relay list is exhausted with no acceptance, the publish fails and the client reports it rather
than falling back to the counterparty's relays.

**Recovery.** Each message therefore exists as two independent copies on two independent relay sets: the
real event on the recipient's relays, and a full verbatim backup of that same signed event inside the
self-copy on the sender's relays (§3.4.1). A sender recovers sent history either **blindly**, from its own
(or the client) relays via the static `C_to`, or, once a recipient `R` is known again, by re-deriving the
deterministic `M` and fetching `{ authors: [M] }` from `R`'s relays. And if the real event is dropped or
purged from the recipient's relays, the sender re-publishes it there **byte-for-byte** from the self-copy
(same `id` and `sig`, §3.4.1). All of this works because the keys are deterministic rather than ephemeral:
a lost copy is always re-derivable, re-fetchable, and re-publishable.

## 6. Ancillary events

Edits are **native** to the message kind (§2.2): a message is edited by republishing its addressable
coordinate, with no separate event. Reactions and deletions are authored under the **masked sender key**
and addressed to the recipient's **real** key, never the sender's root, and they reference the target by
its addressable **coordinate** (`a` tag) so the reference survives edits (an edit changes the target's
event id but not its `(kind, M, d)` coordinate):

- **Reactions** (kind 7): `pubkey = M`, `tags = [["a", "30092:<targetM>:<d>"], ["p", R_pub]]`, signed with
  `signAsBlinded`. The reacting party is a sender in that moment, so it uses its own masked key toward the
  other party.
- **Deletions** (NIP-09, kind 5): authored by the same masked key that authored the target, with `["a",
  "30092:<M>:<d>"]` (and `["k", "30092"]`); a relay that honors deletions sees the authors match. A client
  MAY instead edit the message to an empty/tombstone payload (§2.2), since the kind is replaceable.

No ancillary event may carry the sender's root pubkey in any public position; a sender identity, if
needed, travels encrypted as in §2.1.

## 7. Privacy properties and limitations

What NIP-MDM **hides** from a passive relay observer:

- The sender's real identity (the author is a blinded key; recovering the root is a discrete log).
- The sender's entire **outbound** graph (there is no event publicly attributable to the sender's root).
- Which of a sender's conversations belong to the same sender (per-recipient masked keys are mutually
  unlinkable).
- The message text, the sender identity, reply structure, and attachments (all inside the ciphertext).

What it **does not** hide (deliberately below NIP-17 on sender unlinkability and timing):

- **The recipient.** The `p` tag is the recipient's real key. An observer sees that a given account
  received a message from some masked sender. A person's **inbound** exposure (that they received
  something, and when) is visible; only the sender is concealed. This is the **same** recipient exposure
  NIP-17 has: a gift wrap also carries the recipient's real key in its public `p` tag.
- **Timing and size.** `created_at` is truthful and not jittered, and message sizes are visible (NIP-44
  pads but does not fully mask length).
- **Per-pair linkage.** All of one sender's messages to one recipient share a stable `M`, so they group
  trivially. This is deliberate: it is what makes the pseudonym orderable and bannable.
- **Edit activity.** Because messages are addressable (§2.2), an observer can see that a masked key
  replaced one of its coordinates (an edit happened, and when), though not the content or the roots.
- **Self-copy existence and volume.** Each message is mirrored by a self-copy (§3.4) published at the same
  `created_at`, so an observer may correlate the two events by timing, and all of a sender's self-copies
  share the stable `C_from` / `C_to` pair, which reveals how many messages some sender has sent. Both the correlation and
  the volume are **unlinkable to the sender's real key** (`C_from` / `C_to` need the root to derive), and
  the design deliberately accepts them rather than jittering timing: as overall network activity grows,
  co-timed masked events become ordinary noise. The self-copy's own recipient `C_to` is masked too, so
  recovering the sent history never exposes the sender either.

**Deniability.** No masked event is publicly attributable to a root: linking `M` (or `C_from` / `C_to`) to
a real key requires that key's private scalar, so toward the public every NIP-MDM event a person authored
is plausibly deniable. The accountability of §1.3 runs only toward the recipient, who alone can verify the
sender.

Comparison:

| | NIP-04 | NIP-17 gift wrap | NIP-MDM |
| --- | --- | --- | --- |
| Hides sender from the public | no | yes | yes |
| Hides recipient from the public | no | no | no |
| Recipient can verify the real sender | yes (it is the root) | yes (sealed real key) | yes (§1.3) |
| Stable, verifiable author | yes (the root) | no (fresh ephemeral) | yes (masked key, per pair) |
| Public can link a sender's messages | yes (to the root) | no | per pair only (never to the root) |
| Orderable / rate-limitable / bannable author | yes | no | yes |
| Editable messages | no | no | yes (addressable) |
| Timing | truthful | jittered | truthful |
| Sender multi-device sync | n/a | self-copy to the real key | self-copy to a masked self-key |

Choose NIP-MDM when a conversation wants **sender** privacy with a stable, accountable, editable sender
identity. Choose a gift wrap when per-message unlinkability and jittered timing matter more than a stable
identity, ordering, rate-limiting, or editing. Both reveal the recipient; neither is the choice when the
recipient must also be hidden.

## 8. Security considerations

- **The masked private key is root-sensitive.** A blinded private scalar is **root-equivalent** per
  NIP-SKD §3 (`s_priv = M_priv − t`, and `t` is computable by the ECDH peer). It MUST be generated, held,
  used, and destroyed at exactly the security level applied to the root key, never cached to disk, logged,
  or handed to a less-trusted component. A conforming signer never exports it; a local-key client treats
  it as it treats the root.
- **No new signer surface.** NIP-MDM introduces no new signer op and no new derivation, so it adds no
  attack surface to a conforming `skd:1` signer beyond what NIP-SKD already defines.
- **Forgery is infeasible, not merely detectable** (§1.3): a valid masked author signature requires the
  sender's blinded private scalar, and a forged `from` fails the constant-time verification.
- **Replay.** A relay or observer can re-publish an existing masked event; clients dedupe by event id.
  An attacker cannot craft a new valid message, only resurface an old one.
- **The recipient learns the sender's root.** This is by design (`from`, §2.1); a sender who does not
  want the recipient to learn its identity should not use NIP-MDM (it is accountable sender pseudonymity,
  not anonymity toward the recipient).
- **Context pinning.** `"nip-mdm:v1:peer"` is fixed and version-stamped; a client MUST NOT accept a
  masked key derived under any other context as a NIP-MDM identity (NIP-SKD §1.1, §5).

## 9. Versioning and the kind number

The `nip-mdm:v1:*` context family (`:peer` for the masked key, `:copy-from` / `:copy-to` for the
self-copy keys) carries the **masked-identity** version; a backwards-incompatible change to any of those
derivations increments the whole family together (`nip-mdm:v2:*`), since changing one in isolation would
split a conversation. The **scheme** version is NIP-SKD's salt (`skd:1`), recorded by consumers per
NIP-SKD §5. Changing the payload shape (§2.1) is a `v` bump inside the payload, not a context change.

The **event kind is 30092**, in the **addressable** range (30000-39999) so a message is editable (§2.2),
the property that distinguishes NIP-MDM from NIP-04 and NIP-17. The number encodes the BIP-39 index of the
word "mask" (92). It was checked against popular relays and the NIP kind registry and found unused; the
number threads through §2, §3, and §6 only.

## 10. Reference consumer, DEN Chat

DEN Chat implements the masked sender key with the same `skd:1` helpers it uses for NIP-CHAT v2
pseudonyms (`client/src/lib/crypto/skd.ts`): `getBlindedPubkey` / `signAsBlinded` / `nip44EncryptAsBlinded`
on the sender side, `getPeerBlindedPubkey` for recipient-side verification, and `getSelfSubkeyPubkey` /
`signAsSelfSubkey` / `nip44*AsSelfSubkey` for the self-copy (§3.4), all under `ChatContext`-style
helpers for the `"nip-mdm:v1:*"` contexts. On the recipient side, DEN reuses its existing DM subscription
on the user's real key.

Within the §5 contract, DEN makes the client-specific choices §5 leaves open:

- it ranks and selects relays with its relay **health probe** (write plus read-back, preferring relays it
  has confirmed working) and its existing publish **failover**;
- for the self-copy's fallback when the sender has no usable kind-10002 list, it picks relays **from its
  client relay list deterministically, seeding the choice with `C_to`**, which is recipient-independent (no
  leak) and reproducible on any device, so a fresh device lands on the same relays and recovers the
  self-copies with no stored state;
- it keeps both events durable with the same **cooperative rebroadcasting** it uses for other critical
  events, topping each up to its redundancy target independently, and it restores a real message to the
  recipient's relays from the verbatim backup in the self-copy (§3.4.1) when it finds it dropped there.

None of these are required by this spec; another client may reach or verify relays however it likes, as
long as it honours the §5 ordering and the two invariants.

## 11. Test vectors

Every value below is a pure composition of the NIP-SKD derivations and is reproduced byte-for-byte by the
reference implementation (`client/src/lib/crypto/skd.ts`); the byte encodings and even-`y` rules are
exactly NIP-SKD §1/§8 (an implementation that reproduces NIP-SKD §8 reproduces these). The sender and
recipient roots are the same key pair as NIP-SKD §8, for cross-reference. Only the three deterministic
primitives are pinned: the masked key `M`, its recipient-side re-derivation, and the message
conversation key, plus the two self-copy keys. A message event's `content`, `id`, and `sig` are **not**
pinned, because NIP-44 randomizes the nonce per encryption (so the ciphertext, and therefore the id and
sig, differ each send).

```
# roots
s_priv = 1111111111111111111111111111111111111111111111111111111111111111   # sender
S_pub  = 4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa
r_priv = 2222222222222222222222222222222222222222222222222222222222222222   # recipient
R_pub  = 466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27

# ── masked sender key M (blinded form, context "nip-mdm:v1:peer") ──
# sender:    M = getBlindedPubkey("nip-mdm:v1:peer", R_pub)        base = S, IKM = ecdh_x(s_priv, R_pub)
M      = da1ae646a84d43609e7b69ae637b8457bd939ef1a725ecefdff2fc8989719bf7
# recipient: getPeerBlindedPubkey("nip-mdm:v1:peer", S_pub)        base = S, IKM = ecdh_x(r_priv, S_pub)
#   => da1ae646a84d43609e7b69ae637b8457bd939ef1a725ecefdff2fc8989719bf7     ✓ (== M, by ECDH symmetry)

# ── message conversation key (NIP-44) ──
# sender:    conversationKey(M_priv, R_pub)
# recipient: conversationKey(r_priv, M_pub)
#   => 3cb3501b3af4e59fa1b5df9323cb43a53c3b3b01714c79c69b3623afcf7530cc     ✓ (both sides equal)

# ── sender self-copy keys (self form; from s_priv alone, independent of any recipient) ──
C_from = getSelfSubkeyPubkey("nip-mdm:v1:copy-from")
#   => 7b63c265022d3fd35c2b5b90ffe5f5c3fc28c6a5e1bb7e90a292c5bd3d636b00
C_to   = getSelfSubkeyPubkey("nip-mdm:v1:copy-to")
#   => ef7bcea2043ec5035f902860cbf6702209178f9ad1fed0b07b40d223d89863e7
```
