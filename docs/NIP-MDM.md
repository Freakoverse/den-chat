# NIP-MDM: Masked Direct Messages

## Abstract

NIP-MDM (Masked Direct Messages) is a one-to-one direct message in which the **sender's root identity never
appears on the wire**.
The sender authors under a per-recipient **masked key** `M` (a NIP-SKD **blinded** sub-key of its root,
blinded toward the recipient); the recipient is addressed by their **real** key, so they receive with no
derivation, just a subscription to their own key. A public observer sees a masked key delivering an
encrypted message to a known recipient, and cannot tell who the sender is.

The goal is to be **private enough** while keeping the **reliability and moderation** of an ordinary DM, not
to be a maximal-privacy system. Where a maximal-unlinkability scheme uses a fresh ephemeral key per message
and jittered timing (unorderable, unbannable, unsortable), NIP-MDM gives one **stable, deterministic,
verifiable** masked key per recipient: the recipient confirms it belongs to the claimed root (accountable
and spoof-proof, §1.3), any of the sender's devices reproduce it from the root alone (§3.4), and it is a
single stable author that orders and threads normally. Timestamps are truthful, so a sender's messages to
one recipient are publicly linkable to each other but never to the sender's root. This is *accountable
sender pseudonymity*, not anonymity toward the recipient.

It needs **no dedicated relay list** (it uses each party's ordinary kind-10002 list, §5) and **no new signer
operations**: it is a pure composition of NIP-SKD's blinded and self ops (§1), an addressing convention (§2,
§3), and one event kind (§2). A signer without NIP-SKD (`skd:1`) support cannot participate.

## Motivation

NIP-04 publishes both parties' **real** keys (sender as author, recipient in `p`): the content is encrypted
but the **social graph is not**, so anyone can read the who-talks-to-whom map off the relays. A
maximal-unlinkability scheme hides the sender with per-message ephemeral wrappers, but the randomness makes
messages hard to order, rate, or ban, forces a self-addressed copy for the sender's other devices, and adds
a dedicated DM-relay list to maintain.

Many conversations need to hide the **sender**, not the recipient: a reporter's public tip line, an
anonymous tip to a known account, or simply keeping your outbound contacts unenumerable. The recipient is
content to be reachable in the clear; the sender wants to stay unidentified to the public yet accountable to
the recipient. A per-recipient masked key gives exactly that: the author is a blinded key (recovering the
root is a discrete log), the recipient decrypts with their own key and never enumerates senders, the key is
stable and verifiable per pair so a verified message is provably from that sender, and it is a pure function
of `(sender root, recipient root)` so every device rebuilds the conversation list from the root alone (§3.4).

NIP-MDM is a point between NIP-04 and a maximal-unlinkability scheme (its honest costs are in §7), not a
replacement for either.

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

The masked key is the NIP-SKD **blinded** form (see NIP-SKD §1) under one fixed
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
| Sender | Sent-contacts index (§3.4) | `getSelfSubkeyPubkey`, `signAsSelfSubkey`, `nip44EncryptAsSelfSubkey` / `nip44DecryptAsSelfSubkey` |

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
which neither NIP-04 nor an ephemeral-wrap DM supports. Each message carries a unique `d` tag, so every message is its
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
  "text": "Hello",                // the message text (optional if an attachment-only message)
  "published_at": 1733251200,     // REQUIRED: real original send time = the FIRST version's created_at; carried forward unchanged on edits; the sort key (§2.2)
  "updated_at": 1733251260,       // optional: real wall-clock time of the latest edit (present only on an edit); drives the "edited" marker (§2.2)
  "reply": "30092:<authorM>:<d>", // optional: addressable coordinate of the message this replies to (kept private; survives edits)
  "attachments": [                // optional: structured file references
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
  ]
}
```

Two variants reuse this same envelope (`v`, `from`, `published_at`, and the edit fields): a **reaction**
carries a `reaction` object in place of `text` (§6), and a **tombstone** (a deleted message, §6) carries
none of `text`, `attachments`, or `reaction`. A reader routes on these: `text` or `attachments` is a
message, a `reaction` object is a reaction, and an envelope with none of them is a tombstone. The
sent-contacts index (§3.4) is **not** one of these: it is a separate **binary** payload under the same
kind, never parsed as a message, recognized by its author being the sender's own `C_from`.

A recipient **MUST** verify `from` per §1.3 before attributing or displaying a sender, **MUST** ignore
unknown fields, **MUST** tolerate a missing `text` (an attachment-only message, a reaction, or a
tombstone), and **MUST** order the
conversation by `published_at` rather than the event's `created_at` (§2.2). A message whose
`from` fails verification **MUST** be treated as unattributed (the stable masked key `M` is still a valid
opaque pseudonym; a client MAY drop it or surface it as "unverified sender").

The payload is **always** this versioned object, on every message, including one that is only plain
text. Three reasons:

1. **One shape for text and attachments.** A text-only message and one that carries `attachments` share a
   single structure, so a reader parses the same object either way and never has to guess whether the
   content is a bare string or a wrapper.
2. **Privacy.** All of it, the message text, the sender's `from`, reply references, the real send and edit
   timestamps (`published_at` / `updated_at`, §2.2), and every attachment field (filenames, sizes, and
   per-file encryption keys) lives inside the NIP-44 ciphertext, because only the `d` and `p` tags are
   public (§2). Putting any of it in tags would expose it.
3. **No collision with user-typed JSON.** The user's own message is always the string value of `text`, one
   level deep, so content a user literally types, even a string like `{"text":"hi"}` or `{"v":1,"text":"hi"}`
   that mimics the envelope, is stored and rendered verbatim as that string and can never be mistaken for
   the envelope itself. The reader also keys
   off `v`: it interprets the structured fields only when `v` is present (`v` is the payload version, so
   a future shape change bumps it per §9), which is the discriminator a bare-string format would lack.

### 2.2 Editing

Because the message is addressable, editing it is just re-publishing the **same** `(kind, M, d)` coordinate
with new encrypted content: the relay replaces the previous version, and no separate edit event is needed.
The author is unchanged (`M`), so only the sender can edit their own message.

NIP-01 selects the current version of a coordinate by **highest `created_at`, lowest id on a tie**, and a
relay accepts a replacement only when its `created_at` is strictly greater. That overloads `created_at` as a
replacement token, so it cannot also serve as an honest timestamp. NIP-MDM therefore splits the three
concerns NIP-01 folds into that one field across three values. (A single standard original-send-time field
would have avoided this; absent one, these three are the workaround.)

- **`created_at` (event field): a logical version counter.** On the first send it equals the true send
  time. On each edit the client **MUST** set it to the **previous version's `created_at` + 1**, never the
  wall clock. Edits accumulate: a message edited `k` times has `created_at = original + k`. The `+1` is the
  smallest increment a relay accepts as a replacement, so the edit supersedes with no id-tie ambiguity, and
  staying near the original keeps the message in its timeline slot instead of jumping to "now" and stealing
  slots in `limit`-based relay fetches.
- **`published_at` (payload field, REQUIRED): the real original send time.** It is the first version's
  `created_at`, carried forward **unchanged** on every edit. Clients **MUST** order the conversation by
  `published_at`, not by `created_at` (which drifts with edit count). On the first send
  `published_at == created_at`.
- **`updated_at` (payload field, optional): the real wall-clock time of the latest edit** (the corrected
  clock, §3.1). Present only on an edit. It drives the "edited" marker and any "last edited" display, and is
  never used for ordering or for replacement selection.

Unlike NIP-CHAT, which carries `published_at` and `updated_at` as **public tags**, NIP-MDM keeps both inside
the **encrypted payload** (§2.1): only `d` and `p` are ever public (§2), so the true send and edit times
stay private. The public `created_at` still leaks a coarse time (the original, advancing by one per edit),
which §7 accounts for.

A client **SHOULD** show an "edited" marker when `updated_at` is present (equivalently, when the stored
`created_at` has advanced past `published_at`). An edit to a reply **MUST** carry its `reply` reference
forward unchanged (§2.1).

## 3. Sending and receiving

### 3.1 Send (S to R)

1. `M = getBlindedPubkey(context, R_pub)`.
2. Build the payload (§2.1) with `from = S_pub` and `published_at` set to this message's `created_at`
   (step 4); `ciphertext = nip44EncryptAsBlinded(context, R_pub, payloadJson, R_pub)`.
3. Generate a random opaque `d` (for example 16 random bytes, hex).
4. Assemble the kind-30092 event with `pubkey = M`, `tags = [["d", d], ["p", R_pub]]`, `content =
   ciphertext`, `created_at = nowSeconds()` (the corrected clock), and sign with `signAsBlinded(context,
   event, R_pub)`.
5. Publish per §5 (the recipient's relay list, the sender's own list, and the client relay list for
   redundancy). To **edit** later, repeat with the same `d`, `created_at = previous version's created_at +
   1`, `published_at` unchanged, and `updated_at = nowSeconds()` (§2.2).
6. Update the sent-contacts index (§3.4): move `R_pub` to the front (a new contact triggers a republish; a
   repeat to an existing contact MAY be debounced). Skipped on an edit (an edit adds no new recipient).

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
The sender's sent-contacts index (§3.4) closes that gap.

### 3.4 The sender's sent-contacts index

Each sent message is authored by a different per-recipient `M`, so a device with only the root key cannot
enumerate its own conversations (§3.3). The sender closes this with a single **sent-contacts index**: one
addressable event whose encrypted payload lists the recipients it has messaged. It is **not** a copy of any
message, content durability is §5's job; the index only answers *whom did I message*.

**Keys.** Two static NIP-SKD **self** sub-keys from the root alone (no peer, so only the sender can derive or
address them). The `copy-*` strings are fixed opaque labels, their wording carries no meaning beyond being
constant and distinct:

```
C_from = getSelfSubkeyPubkey("nip-mdm:v1:copy-from")    // authors the index
C_to   = getSelfSubkeyPubkey("nip-mdm:v1:copy-to")      // the index's address
```

**The event.** One kind-30092 event, same kind as a message so it is indistinguishable on the wire,
replaced in place on each update:

```jsonc
{
  "kind": 30092,
  "pubkey": "<C_from>",
  "created_at": <previous created_at + 1 per update>,   // replacement counter only
  "tags": [
    ["d", "<random opaque id, generated once and reused on every update>"],
    ["p", "<C_to>"]
  ],
  "content": "<NIP-44 ciphertext C_from -> C_to of the packed payload below>",
  "sig": "<BIP-340 by C_from, via signAsSelfSubkey>"
}
```

Only `d` and `p` are public. The `d` is **random**, like a message's, so nothing distinguishes the index on
the wire; a device finds it by author (`{ authors: [C_from] }`) and reads `d` off the returned event. There
is no `published_at`/`updated_at`: the index is never displayed, so `created_at` is purely the NIP-01
replacement counter (§2.2).

**Payload.** A version byte then the recipients' **root** pubkeys, 32 bytes each, most-recent first:

```
0x01 ‖ root_0 (32 bytes) ‖ root_1 (32) ‖ … ‖ root_{n-1} (32)      // newest first
```

Because NIP-44 encrypts a UTF-8 **string**, the packed bytes are **base64-encoded** to form the plaintext
(the only form a remote signer accepts; a client **MAY** use any agreed compact encoding). **Roots**, not
masked keys, are stored: `M` derives from a root but not the reverse, and the list is encrypted, so the
roots never leave the sender. Position encodes recency; no timestamps.

**Update.** On a new message to `R`: dedup `R_pub`, insert it at the front, drop the tail if over the cap,
republish at `created_at + 1`. A client **MUST** republish when the **set** changes (a new contact or a
prune) and **MAY** debounce a republish that only reorders existing contacts, so messaging a contact already
in the list puts no index event on the wire. The cap keeps the event within the sender's target relay size
limit; under 64 KB it is **767** roots (the last count whose base64 payload stays below NIP-44's 2^15-byte
padding step, a ~43 KB event). Pruning sheds only the least-recent contacts beyond the cap; those threads
stay reachable by npub, just not auto-enumerated on a fresh device.

**Multi-device.** The index is one replaceable event, so concurrent updates **merge**: fetch the latest,
union the lists (dedup, keep each root's front-most position), republish at `max(seen created_at) + 1`.
Because `d` is chosen at creation, two devices creating the first index before syncing can pick different
`d`s; a client that sees more than one `C_from` event unions all their lists and converges future writes
onto the lowest `d`.

**Cold start.** A fresh device derives `C_from`/`C_to` (it does not need `d`), fetches
`{ kinds:[30092], authors:[C_from] }`, decrypts the roots, and for each derives `M` and fetches that thread
(§5). With the received stream `{ kinds:[30092], "#p":[R_pub] }` it rebuilds the full conversation list from
the root alone.

**Unspammable.** `C_from` is a keypair only the sender holds and `C_to` a secret only the sender can
address, so the index cannot be polluted; `author == C_from` is both the authenticity check and the spam
guard. (The received side, `#p = [R_pub]`, is spammable like any DM, which §4.1 and §4.2 address.)

## 4. Bootstrap, blocking, and spam

**Bootstrap.** To send you need the recipient's npub, exactly as any DM does; from it the sender derives
`M` and publishes. The recipient needs nothing in advance: they are addressable by their real key. The
sender's real identity reaches the recipient inside the first message's `from` field (verified per §1.3),
so a reply can be sent straight back (the recipient now holds `S_pub` and derives its own masked key
toward `S`). **No handshake event is ever published.**

### 4.1 Blocking

Blocking reuses the user's **normal block list** of real keys; there is no separate masked block list. A
blocked root `B` always authors toward recipient `R` under the one deterministic key
`getPeerBlindedPubkey(context, B_pub)`, so the recipient drops it at the **author-pubkey level, before
decrypting**: keep a `blockedMasked` set and, on each event, drop in O(1) if `event.pubkey` is in it.

Populate `blockedMasked` **lazily** (the default): on a verified message whose `from` is blocked, add
`event.pubkey` and drop, one decrypt per blocked sender, then zero forever. A client **MAY** instead
**eagerly** precompute it by deriving `getPeerBlindedPubkey(context, B_pub)` for every blocked root, to drop
even a blocked sender's first message pre-decryption; this is cheap and permanent for a local key, but a
client on a **remote** signer SHOULD prefer lazy (each derivation is a signer round-trip). The masked key is
fixed per pair, so a blocked sender cannot rotate to evade, only a new root escapes, as with normal
blocking. The same derivation powers per-`M` **rate limiting**: `M` is a stable, bannable pseudonym.

### 4.2 Spam

Because the recipient is addressable in the clear, NIP-MDM has roughly the same unsolicited-contact
exposure as NIP-04: anyone can send. It is **not** spam-proof by construction (unlike a design that masks
the recipient). It does, however, give the recipient a strong handle to filter on: every message is
either (a) from a verifiable root `S` (the recipient can allowlist known contacts, or apply web-of-trust
to `S`), or (b) unverified, which a client MAY drop or quarantine. Combined with §4.1, a recipient filters
blocked senders pre-decryption and unknown senders post-verification.

Spam exposure is therefore one-sided: the **inbound** side is spammable like any DM, while the sender's
own **sent-contacts index** (§3.4) is cryptographically unspammable, since its identifiers (`C_from`,
`C_to`) are self-keys only the sender can sign as or address.

## 5. Relays

NIP-MDM uses one relay concept: each party's **ordinary kind-10002 relay list**, with no read/write split
and no separate DM-relay list. Events are found on their author's relays, and the recipient already knows
the sender (it must, to derive `M`), so it can look on the sender's relays as well as its own. Publishing to
both parties' lists plus a shared **client relay list** gives NIP-04-grade deliverability; the default
favors reliability, with an optional privacy mode below.

- **Real message** (`M`, `p = R_pub`): a client **SHOULD** publish to the recipient's relays (where it
  subscribes `{ kinds:[30092], "#p":[R_pub] }`), the sender's own relays (where the recipient can also find
  it by `{ kinds:[30092], authors:[M], "#p":[R_pub] }`), and the client relay list.
- **Sent-contacts index** (`C_from`, `p = C_to`, §3.4): the sender's own relays (read by
  `{ kinds:[30092], authors:[C_from] }`) and the client relay list, never the recipient's, who cannot
  derive `C_to`.

If a party advertises no kind-10002 list, that part falls back to the client relay list; if that is also
empty or the whole set is unreachable, the publish **fails loudly** rather than dropping silently. Within
the chosen set a client fans out and fails over until a relay (ideally several) accepts; how it judges a
relay reachable is left to the client.

**Recovery.** A sender rebuilds its history by reading the index (§3.4), then for each recipient root
re-deriving its own `M` (`getBlindedPubkey(context, R_pub)`) and fetching `{ kinds:[30092], authors:[M],
"#p":[R_pub] }` from that recipient's relays or its own. A recipient missing a known partner `S`'s messages
**SHOULD** likewise query `S`'s relays, authored by `S`'s masked key toward it
(`getPeerBlindedPubkey(context, S_pub)`, §3.3). Durability is a property of this multi-relay spread (plus any
retention layer a sender runs), not of a per-message copy.

**Privacy mode (optional).** Putting the real message on the sender's own relays means an `M`-authored event
sits on relays the sender advertises, a **soft** correlation only (the public cannot derive `M`, shared
relays dilute it, and no relay attests who uploaded, §7). A sender on a distinctive personal relay set
**MAY** use a mode that narrows publishing to the recipient's relays only (real message) and the sender's
relays only (index), sharing just the client list, trading deliverability for tighter unlinkability.

## 6. Ancillary events

Edits are **native** to the message kind (§2.2): a message is edited by republishing its addressable
coordinate, with no separate event. Reactions and deletions stay inside the same masked envelope as
messages, so none of them exposes anything a message would not.

**Reactions.** A reaction is just another masked kind-30092 event (§2): only `d` and `p` (the other party's
real key) are public, the author is the reactor's masked key `M` toward that party, and the reaction itself
rides in the NIP-44 encrypted payload, never in a public tag. So nothing public distinguishes a reaction
from a message, and neither the message reacted to nor the glyph is exposed. The payload reuses the §2.1
envelope with a `reaction` object in place of `text`:

```jsonc
{
  "v": 1,
  "from": "<hex sender root>",                 // REQUIRED: verified per §1.3, exactly as a message
  "published_at": 1733251200,                  // REQUIRED, as a message (§2.2)
  "reaction": {
    "target": "30092:<targetM>:<targetD>",     // coordinate of the message being reacted to (survives edits)
    "emoji": "+"                               // the reaction glyph, or a NIP-30 custom-emoji shortcode
  }
}
```

The recipient decrypts and verifies `from` exactly as for a message (§3.2), then routes on the `reaction`
object. `target` is a **coordinate**, not an event id, so it survives edits of the target (an edit changes
the target's id but not its `(kind, M, d)` coordinate). To change or remove a reaction, the reactor edits
or tombstones the reaction's own coordinate (§2.2); a client **SHOULD** keep at most one active reaction
event per target per reactor. A reaction needs no index entry of its own: the counterparty is already in the
sent-contacts index (§3.4), and the reaction is recovered along with the thread through the direct
`{ kinds: [30092], authors: [M], "#p": [X] }` query for the already-known counterparty `X` (§3.3).

**Deletions.** A sender deletes its own message **privately** by tombstone-editing it: republish the
coordinate with an empty payload (no `text`, `attachments`, or `reaction`) at `previous created_at + 1`
(§2.2). Because the kind is addressable, the relay keeps only this latest empty version, so the content is
gone and nothing public reveals what was removed. A client **MAY** additionally publish a NIP-09 `kind 5`
deletion (authored by the same masked key `M`, with `["a", "30092:<M>:<d>"]` and `["k", "30092"]`) to ask
relays to hard-purge the event, but a `kind 5` is **public and reveals the target coordinate**, so it is an
explicit opt-in, not the default.

No ancillary event may carry the sender's root pubkey in any public position; a sender identity, if
needed, travels encrypted as in §2.1.

## 7. Privacy properties and limitations

What NIP-MDM **hides** from a passive relay observer:

- The sender's real identity and entire **outbound graph** (the author is a blinded key; no event is
  publicly attributable to the sender's root).
- Which conversations share one sender (per-recipient masked keys are mutually unlinkable).
- The message text, sender identity, reply structure, and attachments (all in the ciphertext).
- Reaction and deletion activity: reactions and tombstones are masked kind-30092 events too (§6), so the
  glyph, target, and even whether an event is a reaction are encrypted; only an optional NIP-09 purge is
  public.
- Message and contact **volume**: the sent-contacts index (§3.4) is one capped, replaceable, self-keyed
  event, not a per-message copy, so an observer can count neither messages nor contacts.

What it **does not** hide (deliberately below a maximal-unlinkability scheme on sender unlinkability and timing):

- **The recipient**, and their inbound exposure: the `p` tag is their real key, so an observer sees that
  they received something, and when. Same as any sender-hiding DM.
- **Timing and size**: `created_at` is truthful and not jittered; NIP-44 pads but does not fully mask length.
- **Per-pair linkage**: a sender's messages to one recipient share a stable `M` (deliberate, it makes the
  pseudonym orderable and bannable).
- **Edit activity**: an observer sees a coordinate replaced and `created_at` advance, so *that* an edit
  happened, but not its real time (`updated_at`), content, or roots (all encrypted, §2.2).
- **Relay residence (default)**: the real message also sits on the sender's own relays (§5), a soft
  correlation only, removable via the §5 privacy mode at a deliverability cost.

**Deniability.** Linking `M` (or `C_from` / `C_to`) to a real key requires that key's private scalar, so
toward the public every NIP-MDM event is plausibly deniable; the accountability of §1.3 runs only toward
the recipient.

Comparison:

| | NIP-04 | NIP-17 | NIP-MDM |
| --- | --- | --- | --- |
| Hides sender from the public | no | yes | yes |
| Hides recipient from the public | no | no | no |
| Recipient can verify the real sender | yes (it is the root) | yes (sealed real key) | yes (§1.3) |
| Stable, verifiable author | yes (the root) | no (fresh ephemeral) | yes (masked key, per pair) |
| Public can link a sender's messages | yes (to the root) | no | per pair only (never to the root) |
| Orderable / rate-limitable / bannable author | yes | no | yes |
| Editable messages | no | no | yes (addressable) |
| Timing | truthful | jittered | truthful |
| Sender multi-device sync | n/a | self-copy to the real key | sent-contacts index at a masked self-key |

Choose NIP-MDM when a conversation wants **sender** privacy with a stable, accountable, editable sender
identity. Choose a maximal-unlinkability scheme when per-message unlinkability and jittered timing matter
more than a stable identity, ordering, rate-limiting, or editing. Both reveal the recipient; neither is
the choice when the recipient must also be hidden.

## 8. Security considerations

- **The masked private key is root-sensitive.** A blinded private scalar is root-equivalent (NIP-SKD §3),
  so it **MUST** be generated, held, used, and destroyed at the root key's security level, never exported,
  cached to disk, logged, or handed to a less-trusted component. A conforming signer never exports it.
- **No new signer surface.** NIP-MDM adds no signer op and no derivation beyond NIP-SKD, so no new attack
  surface on a conforming `skd:1` signer.
- **Forgery is infeasible, not merely detectable** (§1.3): authoring as `M` needs the sender's blinded
  private scalar, and a forged `from` fails the constant-time check.
- **Replay.** An existing event can be re-published; clients dedupe by event id. An attacker cannot craft a
  new valid message, only resurface an old one.
- **The recipient learns the sender's root** (`from`, §2.1), by design: this is accountable pseudonymity,
  not anonymity toward the recipient.
- **Context pinning.** A client **MUST NOT** accept a masked key derived under any context other than the
  fixed `"nip-mdm:v1:peer"` as a NIP-MDM identity (NIP-SKD §1.1, §5).

## 9. Versioning and the kind number

The `nip-mdm:v1:*` context family (`:peer` for the masked key, `:copy-from` / `:copy-to` for the
sent-contacts index keys) carries the **masked-identity** version; a backwards-incompatible change to any of those
derivations increments the whole family together (`nip-mdm:v2:*`), since changing one in isolation would
split a conversation. The **scheme** version is NIP-SKD's salt (`skd:1`), recorded by consumers per
NIP-SKD §5. Changing the payload shape (§2.1) is a `v` bump inside the payload, not a context change.

The **event kind is 30092**, in the **addressable** range (30000-39999) so a message is editable (§2.2),
the property that distinguishes NIP-MDM from both NIP-04 and an ephemeral-wrap DM. The number encodes the BIP-39 index of the
word "mask" (92). It was checked against popular relays and the NIP kind registry and found unused; the
number threads through §2, §3, and §6 only.

## 10. Test vectors

A cross-check that an implementation wired MDM's context strings into NIP-SKD correctly (not a re-pinning of
NIP-SKD's own primitives): the values below compose NIP-SKD's derivations under MDM's contexts. Roots are
the same key pair as NIP-SKD §8. Only the deterministic keys are pinned; a message's `content`/`id`/`sig`
are not (NIP-44 randomizes the nonce per encryption).

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

# ── sent-contacts index keys (self form; from s_priv alone, independent of any recipient) ──
C_from = getSelfSubkeyPubkey("nip-mdm:v1:copy-from")
#   => 7b63c265022d3fd35c2b5b90ffe5f5c3fc28c6a5e1bb7e90a292c5bd3d636b00
C_to   = getSelfSubkeyPubkey("nip-mdm:v1:copy-to")
#   => ef7bcea2043ec5035f902860cbf6702209178f9ad1fed0b07b40d223d89863e7
```

## References

- NIP-SKD: `nevent1qvzqqqpqpypzq082fqrtrcdfs2wnp4wt3fuqz82zw8rywn4nz5c7ey0jsyg0u06qqqsqqqpw7aeayck39jqm037l3gvyz6wln4vqtyrvvk5l7uau6lrwsaq86dufr`
