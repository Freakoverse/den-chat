# NIP-CHAT: Decentralized Hub-Based Chat Protocol for Nostr

> **Status**: Draft v4 (hub format **v2** — privacy)
> **Depends on**: NIP-01, NIP-13, NIP-44
> **Companion**: [`NIP-SKD.md`](./NIP-SKD.md) (the sub-key derivation scheme v2 pseudonyms use).

---

## 0. Hub Format Versions (v1 & v2)

NIP-CHAT hubs come in two **formats**, distinguished by a `["version", "N"]` tag on the
hub event (kind `36942`). **Both are permanent, first-class options** — v2 is *not* a
migration target that deprecates v1:

- **v1** — `version` tag **absent**. Fully public: member list, ban list, join authorship,
  and message sender→hub linkage are public (encrypted content, public metadata). Works
  with **any** signer. Choose v1 when reach matters more than privacy.
- **v2** — `["version", "2"]`. Adds **member- and creator-identity privacy**: the real
  identities of members *and* the creator, the ban list, and join authorship are hidden
  from the public, and cross-hub linkage is broken (per-hub pseudonyms), while moderation
  and O(log N) routing are preserved. **Requires a capable signing setup** (§0.5). The one
  leak it **reduces rather than closes** is sender→hub linkage: the plaintext `h` tag stays
  (for routing), so an observer still learns *a pseudonym posted to hub X* — pseudonymous
  per-hub activity, never real-identity or cross-hub linkage (see §10 threat table).

Clients MUST branch on the tag: absent → v1; `"2"` → v2; **any higher/unknown number →
prompt the user to update their client** and do not render the hub.

**Version integrity — fail toward privacy.** The `version` tag is a mutable field, so a
buggy client or a careless admin could strip or alter it after the hub is live. To stop
that from silently downgrading a private hub into plaintext behaviour (a dox), a client
MUST treat a hub as **v2 if _any_ of these signals says v2**, and as v1 only if **all**
agree v1:

1. the **hub type recorded in the user's own hub list** when they joined (§6.4) — empty ⇒
   v1, `"2"` ⇒ v2;
2. the live `version` tag on the hub event;
3. **encrypted `content`** on the hub event — intrinsic and unspoofable (a v2 hub's
   structural body *is* ciphertext; it cannot be forged back to plaintext).

On any inconsistency (recorded v2 but live tag reads v1, or tag reads v1 but `content` is
encrypted, etc.), the client MUST **warn the user, refuse to render/post as v1, and block
publishing** until resolved. The one transition a client must never make silently is
turning a hub the user joined as v2 into v1 behaviour.

### 0.1 The v2 model in one page

**Requires NIP-SKD (§0.5).** v2 identities are derived with [NIP-SKD](./NIP-SKD.md) Sub-Key
Derivation — via a local key, or a signer that implements it. A signer without NIP-SKD
cannot participate privately.

**Pseudonymous membership, owner-verifiable.** Each member acts under a per-hub pseudonym
`P` — a **blinded** derivation of their real key `R` toward the hub owner `O` (NIP-SKD
`blinded` form). The owner can independently re-derive `P`'s **public** key to verify it, but
**cannot** obtain `P`'s private key:

```
// NIP-SKD blinded form: context = "nip-chat:v2:member-pseudonym:" + d_tag, peer = O_pub
t      = HKDF( ECDH(R_priv, O_pub), salt = "nip-skd-v1", info = blinded(context) )   // see NIP-SKD §1
P_pub  = xonly( lift_even_y(R_pub) + t·G )      // P_priv = R_priv + t, held only by the member
// owner verifies:  getPeerBlindedPubkey(context, peer = R_pub) == P_pub   // pubkey only; never P_priv
```

where `O` is the owner pseudonym (below), and `blinded(context)` is the form-tagged HKDF `info`
of NIP-SKD §1. Local keys compute it directly; capable signers derive `P` as a NIP-SKD blinded
sub-key (§0.5). `P` is deterministic per (member, hub), unlinkable across hubs, unlinkable to
`R` for the public, **owner-verifiable, and squat-proof**: a leaked `P` cannot be re-bound to a
different `R` because the owner would derive a *different* `P` for that `R`. Crucially the owner
derives only `P_pub` (to verify and place the leaf) and **never `P_priv`**, so it cannot sign as
a member. The member tree stores `P`; every member-authored event is signed by `P`.

**Hidden creator.** The hub is authored not by the creator's real key `R_owner` but by a
derived **owner pseudonym `O`**:

```
// NIP-SKD self form: context = "nip-chat:v2:owner-pseudonym:" + d_tag
O_priv = HKDF( R_owner_priv, salt = "nip-skd-v1", info = self(context) )   // see NIP-SKD §1
O_pub  = derivePublic(O_priv)
```

The hub coordinate is `kind:O_pub:d_tag`; `R_owner` never appears publicly. `O` is
**self-authoritative** — it *is* the hub's owner key, recognised as the owner without an
`identity` tag, and only `R_owner`'s holder can derive `O_priv`, so no one can forge it. A
static **owner attestation**, stored encrypted with the hub secret, reveals the real creator
to members once they are in:

```
// R_owner signs a never-published attestation event committing to the coordinate,
// via signEvent (remote-compatible), kind 27493 with tags [["a", coord]]:
sig_owner = signEvent(R_owner, { kind: 27493, tags: [["a", coord]], content: "" }).sig
// stored as enc(hubSecret, {R_owner_pub, created_at, sig_owner})
```

**Accountable identity — `R` signs every message.** Every member event carries
`["identity", "<ciphertext>"]` = `enc(key, "R_pub:sig_R")` (the real pubkey and signature joined by a
`:`), where `sig_R` is a **per-message signature by the real key over the message** — not a static
binding, and **not** a raw signature over `event.id`. Because a signer only exposes `signEvent` (it
can't sign an arbitrary digest), `R` signs a **never-published kind `27492` attestation event** whose
`m` tag commits to the message digest — the same event-based indirection used for the owner
attestation above:

```
digest = getEventHash(event without its `identity` and `nonce` tags)   // stable across PoW mining
sig_R  = signEvent(R, { kind: 27492, tags: [["m", digest]], content: "" }).sig
```

The digest **excludes** the `identity` tag (circular — it holds the sig) and the `nonce` tag (PoW
mining varies it), so it binds `R` to the content and every semantic tag yet stays stable across
mining and works identically for local keys and remote signers. Verifiers reconstruct the kind-`27492`
event from `(R_pub, event.created_at, digest)` and check `sig_R`.

- hub messages / reactions / activity → encrypted with the **channel/hub key** for the
  event's epoch (members decrypt, public cannot).
- join requests → encrypted to the owner `O` via ephemeral-static ECDH (§6.3).

The owner **cannot** derive `P_priv` (blinded form, above), so it cannot forge a member's
messages — that unforgeability is now **structural**. The per-message `R` signature stays for a
different, essential reason: **trustless attribution**. A member cannot re-derive another member's
`P ↔ R` binding themselves (that needs `O_priv`), so `sig_R` is how *any* member cryptographically
verifies **which real `R`** authored a message — without trusting the owner's roster. This is an
**accountable** model: within the hub, authorship is provable and member-verifiable. It gives up
the deniability of the earlier static-endorsement design — a conscious, in-scope trade for a
Discord-like community platform (§10).

**Drop rule.** In a v2 hub, an event without a valid `identity` tag is not rendered and does
not notify: cheap plaintext presence check first, then post-decrypt validity (verify `sig_R`
over the event and that `P == event.pubkey`). Owner-authored (`O`) events are **exempt** —
`O` is the recognised owner key.

**Everything authoritative keys on `R`.** Bans, roster, roles, and membership all key on the
real key `R` (resolved from the identity tag / owner-side derivation), never on the
disposable label `P`. So a member whose `P` ever changes is still the same person, and a
banned `R` cannot evade by minting a new `P`.

### 0.2 What changes on Blossom (see §5)

- **Member tree** stores `P` (not `R`); the **leaf pages stay plaintext** (keyed on the
  unlinkable pseudonym `P`), so the top-level binary search **and the v1 hub-secret bootstrap
  are unchanged** — a member finds their leaf by `P`, decrypts their leaf key, and walks to
  the hub secret exactly as in v1. Encrypting whole pages is **deliberately not done**: the
  page *is* the tree that distributes the hub secret, so a hub-secret-derived page key would
  be undecryptable before you have the hub secret (chicken-and-egg); and `P` is already
  unlinkable, so hiding the P-set buys nothing but count/churn — which the file size leaks
  anyway.
- Each **leaf page carries one group-encrypted roster segment** — a `{ P: R }` map for that
  page's members, encrypted with `HKDF(hubSecret_epoch, "roster:epoch:<epoch>")` and **stamped with the
  epoch** whose secret encrypts it (§5.2.1). Members resolve the roster (the real user, including
  **silent members** who never posted) *after* they hold the hub secret; non-members and the
  plaintext page reveal only the unlinkable `P`. One group AES op per page (not per member),
  keyed on the client-held hub secret, so it adds **no signer round-trips** — owner tree ops
  stay v1-class even with a remote signer. The per-epoch stamp gives **forward-secret
  identity**: on a kick/rotation the touched page's segment is rewritten under the new epoch,
  untouched pages keep their old stamp, and a rotated-out secret can't open a segment written
  after it — so a kicked member (or a leaked old secret) sees who was present when they held
  the key but **never anyone added later**. A bare rotation rewrites 0 roster segments; a
  kick/add rewrites one — v1-parity even at 10M members.
- **Ban list** stores real keys `R` (you ban the person, not a throwaway pseudonym) and is
  **encrypted** with `HKDF(hubSecret_epoch, "ban-list:epoch:<epoch>")`. It must be its own encrypted file
  because banned members are removed from the tree.

### 0.3 What changes on events (see §6, §14)

- Hub event is authored by the **owner pseudonym `O`** (coordinate `kind:O:d_tag`); it gains
  a `version` tag, an encrypted owner attestation, and (on an optional v2 copy of a v1 hub) a
  `new_hub` tag.
- Hub event **`content` is encrypted** with `hub_content_key` (§4.2): the structural body
  (roles, categories, **channel names**, permissions, plugins) is member-only, while the
  **public face** (`n`, `picture`, `banner`, `about`, `t`) moves out to plaintext tags for
  the join/Discover card (§6.1). The hub **secret is not in the content** — it stays in the
  tree — so this adds no bootstrap step.
- Message and every member-authored hub event gain the encrypted `identity` tag (`P_pub`
  bound to `R` by a **per-message** `sig_R`); `pubkey` is `P`.
- Join requests are sealed to the owner `O` (§6.3).

### 0.4 v1 and v2 coexist — no forced migration (see §12)

v1 and v2 are permanent options, not stages, and v1 is **not** deprecated. There is no
migration directive. A creator who wants to take a public hub private MAY use an optional
**"Create v2 copy"** action that spawns a fresh v2 hub and (optionally) stamps the old hub
with `["new_hub", "<new_d_tag>"]` to point members at the successor; the old hub keeps
working. History does **not** move (v1 plaintext cannot become v2 ciphertext). Clients honour
`new_hub` only when the successor's creator matches, and treat it as an informational
pointer, not a shutdown.

### 0.5 Capability requirement — NIP-SKD (v2)

v2 identities are derived with **[NIP-SKD](./NIP-SKD.md) Sub-Key Derivation** (salt
`"nip-skd-v1"`). Derivation needs one of:

- a **local key** — the client holds `R_priv` and computes the HKDF/ECDH directly; or
- a **remote/browser signer that implements NIP-SKD** — it derives and operates the sub-keys
  **internally**, never exposing their private material:
  - owner `O` → **self** form on context `"nip-chat:v2:owner-pseudonym:"+d_tag`;
  - member `P` → **blinded** form on `"nip-chat:v2:member-pseudonym:"+d_tag` with peer `O_pub`
    (the owner verifies `P` via `getPeerBlindedPubkey` but cannot derive `P_priv`);
  - facilitated `Pf` → **blinded** form on `"nip-chat:v2:facilitated-pseudonym:"+d_tag` with peer
    `P_fac`; join address → **blinded** form on `"nip-chat:v2:join-addr:"+d_tag` with peer `O_pub`.

  NIP-CHAT v2 uses only the **self** and **blinded** NIP-SKD forms — never the `shared` form.

Because NIP-SKD extracts under salt `"nip-skd-v1"` (disjoint from NIP-44's `"nip44-v2"`), no
v2 derivation can reproduce a DM key. The DEN client ships NIP-SKD itself (local key or its
own signer), so v2 works for DEN-client users immediately; third-party signers adopt over
time. A signer **without** NIP-SKD cannot join or post in a v2 hub: the client shows an
explanatory page ("use the DEN client or a NIP-SKD signer") and **never** falls back to
publishing in the clear. The scheme each hub uses is recorded in
`["signer_scheme", "skd", "1"]` (§6.1), so clients route derivation by it and a future
NIP-SKD version or replacement never breaks existing hubs.

---

## 1. Overview

NIP-CHAT defines a decentralized, hub-based chat system built on Nostr. It provides Discord-like functionality — hubs, channels, categories, roles, permissions — without relying on trusted servers for core operations.

### 1.1 Design Philosophy

- **Encrypted by default.** All hub messages are encrypted with a hub-wide shared secret. Non-members cannot read content. Users should understand: *"messages are encrypted, but any member could leak them — treat it like a private group chat, not a vault."*
- **Anyone can post.** The protocol layer does not gatekeep who can publish events to a channel. Enforcement is a client-side rendering decision (in v2, the identity drop rule of §0.1) based on member lists.
- **Mesh membership.** There is no single authoritative member list. The hub creator maintains the canonical list, but any member can maintain their own list for the hub (facilitation). Clients verify facilitated messages via the `facilitator` tag.
- **Encryption is layered.** The hub-wide secret encrypts all channels by default. Private channels can use separate per-group secrets via `grouped_roles` for additional isolation.
- **Full history access.** Current members can decrypt all historical messages from any epoch. Removed members lose access to all history upon secret rotation. This mirrors the Discord model — no forward secrecy, prioritizing UX over Signal-grade privacy.
- **Honest security model.** This protocol explicitly states what is trusted, what is verified, and what tradeoffs exist at each layer.

### 1.2 What This Is Not

- This is **not NIP-29**. There is no single relay authority. No relay decides membership or controls who can post.
- This is **not Signal**. The encryption model uses shared secrets. It protects against outsiders, not against members who already know the secret. There is no forward secrecy. For most hub use cases (community servers, group chats), this is the correct tradeoff.

---

## 2. Core Concepts

### 2.1 Hub

A hub is a collection of roles, categories, channels, and members. It is the top-level container, analogous to a Discord server.

A hub is represented by a **single addressable replaceable event** (kind `36942`). In **v1** the hub is authored by the creator's real key, which is the hub owner. In **v2** the hub is authored by a derived **owner pseudonym `O`** (§0.1, §4.5), so the real creator stays hidden from the public; a static owner attestation inside the encrypted content reveals the creator to members only. Updating the hub (renaming a channel, adding a role, etc.) means publishing a new version of this event with the same `d` tag (in v2, signed by `O`).

> **Hiding the creator (optional).** The owner's pubkey is public — it authors the hub event and appears in the hub's `36942:<pubkey>:<d>` coordinate. A creator who does not want the hub tied to their main identity can simply **create a separate Nostr account — one with no profile, links, or other identifying activity — and use it solely to create and manage the hub.** This is a manual choice available today, requires no protocol support, and keeps the hub unlinked from their intended identity as long as that account is never used for anything identifying.

### 2.2 Channels

Channels are where messages are posted. Each channel MAY belong to a category and has a type:

| Type | Description |
|------|-------------|
| `chat` | Normal text channel for conversation |
| `announcement` | Read-only for most roles; specific roles can post |
| `forum` | Forum-style channel with structured posts (title, body, tags, featured image) |
| `voice` | Voice/video channel. No messages are posted here — the channel serves as a room identifier for real-time audio/video sessions. Presence is tracked via kind `36947` events. |

### 2.3 Categories

Categories are visual groupings of channels, similar to Discord. A category can define default permissions and encryption that its channels inherit (via the `synced` flag).

### 2.4 Roles

Roles define what a member is allowed to do. Every hub MUST have exactly one `everyone` role that applies to all members. The `everyone` role MUST have `position: 0` and cannot be deleted or renamed. Additional roles (mod, admin, etc.) are created by the hub owner with ascending position values starting from `1`.

Roles serve three purposes:
1. **Permissions** — client-side rendering decisions (can this user post? can they invite?). When a member has multiple roles, the **most permissive** value wins for each permission flag.
2. **Encryption groups** — roles can be combined into `grouped_roles` for channel-specific encryption secrets
3. **Member sidebar grouping** — roles with `hoist: true` create separate collapsible sections in the member sidebar. Members with multiple hoisted roles appear in the highest-priority one (lowest `position` value, excluding `0`). Members without a hoisted role appear under `everyone` (always last).

#### Duplicate "everyone" Handling

If a hub event contains multiple roles named `everyone` (e.g., from a non-standard publisher), clients SHOULD merge them into a single role by combining permissions with "most permissive wins" and keeping the first role's `role_id`. The merged role MUST have `position: 0`.

### 2.5 Members

A member is any Nostr pubkey that appears on a followed member list for the hub. Membership is determined by Blossom-hosted member files maintained by the creator and optionally supplemented by trusted members' lists.

---

## 3. Relay & Storage Architecture

### 3.1 General Relays (`general`)

General relays store all hub events:
- Hub events (kind `36942`)
- Join request events (kind `36944`)
- Channel messages (kind `36943`), poll (`1067`), vote (`1017`), and report (`36948`) events, and every other member-authored hub event

Any standard Nostr relay can serve as a general relay. Hub content is protected by encryption, not by the relay: messages are encrypted with the hub secret, so a relay serving the ciphertext publicly leaks nothing beyond the already-priced `h`-tag traffic residual (§10 threat table; plan §8.1). Access control and spam control are **entirely client-side** (§9.9): the identity drop rule renders only member-authored events, and the message PoW (`w`) plus join PoW (`W`) price spam. There is no relay-side membership gate in v2 — that would require the relay to read the encrypted member pages, which needs the hub secret a relay must never hold.

Operators who want an *additional* spam floor MAY run a generic PoW/rate-limit relay, but that is **not** part of this spec; it is a general-purpose, ecosystem-wide relay policy that belongs in its own NIP, and v2's security floor does not depend on it.

### 3.2 Blossom Servers

Blossom servers store files that are too large for Nostr relays:
- **Member/key files** — membership list and encrypted key material
- **Ban list** — banned pubkeys
- **Epoch secret history** — historical secrets for full history access
- **Media files** — images, videos, and other attachments from hub messages

Hub events reference Blossom servers via `o` tags.

- Recommended: at least 3 Blossom servers for redundancy
- All files are content-addressed (SHA-256 hash verified)
- Clients MUST verify file hash matches the expected value before trusting contents
- If a file from one Blossom server fails hash verification, the client SHOULD try the next server

### 3.3 Architecture Summary

| Type | Stores | Access Control | Required |
|------|--------|---------------|----------|
| `general` relay | Hub event, join requests, channel messages, reports, all hub events | None at the relay (public); enforcement is client-side (§9.9) | Yes (≥1) |
| Blossom server | Member files, block lists, history, media | Public download, hash-verified | Yes (≥1, recommend 3) |

---

## 4. Cryptographic Model

### 4.1 Overview

NIP-CHAT uses a **Logical Key Hierarchy (LKH)** — a balanced binary tree of symmetric keys — to distribute hub secrets to members. This approach provides:

- **O(log N) secret rotation** when members are removed (vs. O(N) with flat per-member encryption)
- **Remote signer compatibility** — NIP-04 is used only at the leaf level, making it work with NIP-46, NIP-PC55, NIP-UPV2, and NIP-07 signers
- **Zero signer calls during re-keying** — internal tree operations use symmetric AES-256-GCM

```
Members as leaves of a balanced binary tree:

               [Root Key] → encrypts hub_secret
              /            \
         [Node A]        [Node B]
         /     \          /     \
       ...     ...      ...     ...
       M1  M2  M3  M4  M5  M6  M7  M8

Leaf level:    NIP-04 encrypt (1 signer call per member)
Internal:      AES-256-GCM (symmetric, no signer needed)
Root:          AES-256-GCM encrypt of hub_secret
```

#### Member Decryption Path

A member walks UP the tree from their leaf to the root:

1. **Leaf**: Decrypt their leaf key using NIP-04 decrypt with the creator's pubkey (1 signer call)
2. **Internal nodes**: Use child key to AES-decrypt parent key (~log₂(N) steps)
3. **Root**: Use root key to AES-decrypt the hub secret

For 1M members: tree depth ≈ 20, so decryption = **1 NIP-04 call + ~20 AES operations**.

### 4.2 Hub-Wide Secret

Every hub has a **hub secret** — a random 256-bit symmetric key generated by the creator. This secret encrypts all channel messages by default.

```
hub_secret = random(32 bytes)
```

All HKDF derivations in NIP-CHAT use a fixed **domain salt** — a static string that isolates NIP-CHAT key derivations from any other protocol that might use HKDF with the same input key material. The salt does not need to be secret; its purpose is protocol-level domain separation, not confidentiality (which is provided by the hub secret itself).

```
domain_salt = "14bf723f-5c4d-4898-9e57-a6aee6e2c8fa-v1"
```

This value is a randomly generated UUID v4 with a `-v1` version suffix, chosen once and hardcoded. All conforming clients MUST use this exact string as the HKDF salt. Changing it would produce incompatible keys.

Message encryption uses a per-channel derived key:

```
channel_message_key = HKDF-SHA256(
    input_key_material = hub_secret,
    salt               = domain_salt,
    info               = "channel:<channel_id>:epoch:<epoch_number>",
    output_length      = 32 bytes
)
```

Messages are encrypted with AES-256-GCM using the `channel_message_key`. The `epoch_number` in the info string ensures that each epoch produces a cryptographically distinct key even for the same channel.

Other hub features use their own domain-separated keys derived from the same hub secret:

```
reports_key = HKDF-SHA256(
    input_key_material = hub_secret,
    salt               = domain_salt,
    info               = "reports:<hub_d_tag>:epoch:<epoch_number>",
    output_length      = 32 bytes
)

events_key = HKDF-SHA256(
    input_key_material = hub_secret,
    salt               = domain_salt,
    info               = "events:<hub_d_tag>:epoch:<epoch_number>",
    output_length      = 32 bytes
)

voice_host_key = HKDF-SHA256(
    input_key_material = hub_secret (or group_secret for group-scoped hosts),
    salt               = domain_salt,
    info               = "voice-host:epoch:<epoch_number>",
    output_length      = 32 bytes
)

hub_content_key = HKDF-SHA256(            // v2 only — encrypts the hub event's structural content (§6.1)
    input_key_material = hub_secret,
    salt               = domain_salt,
    info               = "hub-content:epoch:<epoch_number>",
    output_length      = 32 bytes
)
```

The `events_key` encrypts calendar events (kind `31923`) and RSVPs (kind `31925`). The `voice_host_key` encrypts SFU provider credentials in voice host events (kind `36946`). For group-scoped voice hosts, the group secret is used instead of the hub secret.

This domain separation ensures that channel message keys, report encryption keys, event keys, voice host keys, and any future feature keys are cryptographically independent — compromising one domain does not affect others.

### 4.3 Grouped Role Secrets (Private Channels)

Channels or categories that need additional privacy beyond the hub-wide secret use `grouped_roles`. Each group has its own independent LKH tree and secret:

```
group_secret = random(32 bytes)
```

This secret is distributed via a separate Blossom LKH tree file (one per group). Only members of the roles in the group appear as leaves in the group's tree.

Channel message encryption for private channels:

```
private_channel_key = HKDF-SHA256(
    input_key_material = group_secret,
    salt               = domain_salt,
    info               = "channel:<channel_id>:epoch:<group_epoch_number>",
    output_length      = 32 bytes
)
```

### 4.4 Secret Rotation (LKH Re-Keying)

Rotation occurs **only when a member is removed** from the hub (or from a grouped role). Adding new members does NOT trigger rotation.

#### Rotation Process

1. Delete the removed member's leaf node from the tree
2. Re-generate new random keys for every node on the path from the removed leaf to root (~log₂(N) nodes)
3. At each level, AES-encrypt the new node key with the **sibling node's unchanged key**
4. Generate a new hub secret, encrypt with the new root key (new epoch)
5. Update the epoch secret history file (see §5.5)
6. Upload updated tree file to all Blossom servers
7. Update the index file, upload to Blossom
8. Publish updated hub event with new `m` tag hash and incremented `epoch`

**Zero NIP-04 / signer calls during rotation.** All re-keying uses symmetric AES with keys the creator already holds. Only 2 signed events total: Blossom upload auth + hub event update.

#### Batch Removal

When removing multiple members at once, the client SHOULD:

1. Mark all leaves for removal
2. Compute the **deduplicated set** of affected internal nodes (union of all paths to root)
3. Re-key each affected node **once** (paths overlap significantly near the root)

#### Performance

| Hub Size | Tree Depth | Re-key Operations (per removal) | Signer Calls |
|----------|-----------|--------------------------------|-------------|
| 1,000 | ~10 | ~10 AES | 0 |
| 100,000 | ~17 | ~17 AES | 0 |
| 1,000,000 | ~20 | ~20 AES | 0 |
| 10,000,000 | ~23 | ~23 AES | 0 |

Adding a member: 1 NIP-04 encrypt + ~log₂(N) AES operations.

### 4.5 Pseudonymous Identity (v2)

v2 hubs add an identity layer on top of the LKH model. Nothing in §4.1–§4.4 changes — the
tree still distributes the hub secret exactly as described — but the **leaf identities are
pseudonyms**, the **hub owner is itself a pseudonym**, and every member event carries a
**per-message signature by the real key**. All derivation runs through the v2 capability
(§0.5): a local key computes the HKDF/ECDH directly; a remote signer derives them as
[NIP-SKD](./NIP-SKD.md) sub-keys, never exposing the private material.

**Owner pseudonym `O`.** The creator does not author the hub under their real key `R_owner`.
They derive a self-scoped owner pseudonym:

```
// NIP-SKD self form: context = "nip-chat:v2:owner-pseudonym:" + d_tag
O_priv = HKDF( R_owner_priv, salt = "nip-skd-v1", info = self(context) )   // see NIP-SKD §1
O_pub  = derivePublic(O_priv)
```

The hub coordinate is `coord = kind:O_pub:d_tag`; `R_owner` never appears in public
metadata. `O` is **self-authoritative**: it is the owner key referenced by the coordinate,
so `O`-authored events need no `identity` tag, and because only `R_owner`'s holder can
derive `O_priv`, no one — not even a member who can compute their own `P` — can forge `O`.

**Owner attestation (creator revealed to members).** A single signature, stored encrypted
with the hub secret, lets members learn who really runs the hub once they are in:

```
// R_owner signs a never-published attestation event committing to the coordinate,
// via signEvent (remote-compatible), kind 27493 with tags [["a", coord]]:
sig_owner = signEvent(R_owner, { kind: 27493, tags: [["a", coord]], content: "" }).sig
// stored as enc(hubSecret, {R_owner_pub, created_at, sig_owner}) in the hub's encrypted content
```

Members decrypt it and verify `sig_owner` against `R_owner_pub`. Outsiders see only `O`. A
static attestation is sufficient here (unlike member events, which need per-message
signatures) because `O_priv` is derivable **only** by `R_owner` — there is no party who can
forge `O`, so nothing to bind per-message.

**Per-hub member pseudonym `P`, owner-verifiable.** A member's pseudonym is a **blinded**
derivation of their real key `R` toward the owner, so the owner can independently re-derive its
**public** key to verify it — but cannot obtain its private key:

```
// NIP-SKD blinded form: context = "nip-chat:v2:member-pseudonym:" + d_tag, peer = O_pub
t      = HKDF( ECDH(R_priv, O_pub), salt = "nip-skd-v1", info = blinded(context) )   // see NIP-SKD §1
P_pub  = xonly( lift_even_y(R_pub) + t·G )      // P_priv = R_priv + t, held only by the member
```

`P` is deterministic per (member, hub), unlinkable across hubs, and unlinkable to `R` for
the public. The **owner re-derives `P_pub`** via the blinded verifier op
`getPeerBlindedPubkey(context, peer = R_pub) = xonly( lift_even_y(R_pub) + t·G )` — the same
`t`, because `ECDH(O_priv, R_pub) == ECDH(R_priv, O_pub)` — and checks it against the claimed
`P_pub`, giving **owner verification** at admission and **squat-resistance**: a leaked `P`
cannot be re-bound to a different `R`, because the owner would derive a *different* `P` for that
`R`. The owner obtains only `P_pub` (to verify and place the leaf) and **never `P_priv`** — so,
unlike the earlier shared-derivation design, it **cannot sign as, or decrypt as, a member**.
Forgery of member events is thereby prevented *structurally*; the per-message signature below
additionally gives members trustless attribution.

**Accountable identity — `R` signs every message.** Rather than a static binding, the real
key signs **each** member event — via a never-published kind `27492` attestation (signers only
expose `signEvent`, not raw-digest signing), whose `m` tag commits to the message digest:

```
digest = getEventHash(event without its `identity` and `nonce` tags)   // stable across PoW mining
sig_R  = signEvent(R, { kind: 27492, tags: [["m", digest]], content: "" }).sig
```

carried as `["identity", enc(key, "R_pub:sig_R")]`. The blinded pseudonym already makes `P`
unforgeable by the owner (it cannot derive `P_priv`), so this signature is not what prevents
owner-forgery — it provides **trustless attribution**: a member cannot re-derive another
member's `P ↔ R` binding on their own (that needs `O_priv`), so `sig_R` is how *any* member
cryptographically verifies **which real `R`** authored an event, without trusting the owner's
roster. This makes authorship **provable and member-verifiable inside the hub** — an accountable
model that consciously drops the deniability of the old static-endorsement design (§10).

**Transport.** The identity ciphertext is keyed by the hub secret, never by the public hub
id:

- In hub messages/reactions/activity: `enc = AES-GCM(channel_or_hub_key_for_epoch, "R_pub:sig_R")`,
  carried as `["identity", enc]`. The epoch is already on the event.
- In join requests: encrypted to the owner `O` via ephemeral-static ECDH (§6.3).
- In the member tree: each leaf **page** carries a group-encrypted, epoch-stamped roster
  segment (`{ P: R }`) under `HKDF(hub_secret_epoch, "roster:epoch:<epoch>")` (the page itself stays plaintext,
  §5.2.1), for the roster and for banning by real key.

Enforcement (drop events lacking a valid per-message signature) is specified in §9.9.

### 4.6 Pseudonymous Authoring — Every Member Action

The identity rule (§4.5) is not just for text messages. **Every event a member authors in a v2
hub channel — message, edit, delete/tombstone, reaction, poll create/vote, calendar event/RSVP,
forum post/reply — is authored on the wire by `P`** and carries the per-message `["identity",
enc(channel_or_hub_key, R_pub ‖ sig_R)]` tag. Because a v2 message is stored + addressed by `P`,
edits and deletes reference the original by `P` too, and NIP-09 `a`-tag deletion requests use the
`P` coordinate. Auxiliary notifications (edit/delete hints) and kind-5 fallbacks are authored by
`P` but omit the identity tag (they carry no member content).

**Uploads (Blossom).** The kind-24242 auth event MUST NOT reveal `R`. A **member**'s media
uploads sign the auth as `P`; the **owner**'s tree-file uploads (leaf pages, spine, index, group
trees, ban pages) sign as `O`. Otherwise a storage operator could bridge a `P`-authored message
that references a blob back to the real uploader (or unmask the hub operator). Uploads to a user's
*own* public sets (custom emoji/gif/sticker) stay under `R` — they are the user's identity, not
hub content.

**Mentions.** A v2 message MUST NOT carry a plaintext `["p", R]` tag for an @-mentioned member —
that would expose the mentioned member's real key on a relay-queryable field scoped to the hub. The
mention lives inside the (encrypted) message content as the `@npub…` text; recipients detect their
own mentions by decrypting content and scanning for their npub, so no `p`-tag / `#p` pre-filter is
needed. (Group mentions `@everyone`/`@here`/`@role` carry no individual `R` and stay as `M` tags.)

**Relay-query discipline.** The cardinal rule ("`R` never on the wire") extends to relay *filters*:
a client MUST NOT issue a subscription/fetch that combines a hub scope (`#h`, or `#d` on a hub
coordinate, or a hub `a`-ref) with the real key `R` — e.g. `authors:[R]`, `#p:[R]`. Such a filter
tells the relay that `R` is active in this hub. Query by the pseudonym the events are actually
authored under (`P`, `O`, the facilitated `Pf`, or the throwaway join-address sub-key for join
requests). Rescinding a join request (fetch + tombstone + kind-5) is likewise done under the
**join-address sub-key** (`ChatContext.joinAddr`, peer = `O`), never `R`.

**Moderator ban lists.** A non-owner moderator's soft-ban list (a kind-36944 join request carrying a
`list` tag → Blossom index/pages) is authored under the moderator's `P`, its Blossom auth signed as
`P`, and its ban pages **encrypted with the hub secret** (`uploadBanPagesV2`) — never `R`-authored
with plaintext pages. Consumers subscribe by each moderator's `P` and decrypt pages with the hub
secret. The ban set is keyed by the moderator's real key `R` in local state (resolving `P→R` via the
roster) so the live subscription, the on-load fetch, and the moderator's own writer all agree.

**Pins.** The per-user pin list (a replaceable event) is authored by, and keyed on, `P` — so
`R`'s membership isn't exposed by their pin list.

**Hide / unhide (moderation).** Hidden-message events (kind `36949`) are authored by `O` when the
**owner** moderates (globally verifiable, since `O` is the public hub author) and by `P` when a
**non-owner moderator** does (same-page verifiable via the roster). A client honours a hide iff its author is
`O`, or is a same-page member holding the `hide_messages` permission — the exact v1 rule, lifted
to pseudonyms. `R_owner` for the owner check comes from the decrypted owner attestation (§4.5).

**Typing indicators.** Authored by `P`; the real typer is `enc(hub_content_key, R_pub)` placed in
the (otherwise empty) content — no signature (typing is low-stakes). A receiver decrypts it with
the hub content key (universal, unlike the *per-page* roster) to show who is typing, cross-page;
a successful decrypt also proves the sender is a member (AES-GCM auth tag).

**Membership list (kind 16942).** A v2 hub the user belongs to MUST NOT appear in the public `v`
tags of their user hub list. v2 entries live in the NIP-51 **encrypted content** (nip44 to self);
v1 entries stay in public tags. One list, read as public-tags ∪ decrypted-content.

**Facilitator (mesh) lists — the facilitator is a "sub-owner".** A facilitator — a member, not the
owner — vouches for others by distributing the hub secret through their own small LKH tree (§6.3).
v2 mirrors the owner↔member scheme one level down, with the facilitator's member pseudonym `P_fac`
playing the owner's role:

- **The facilitated user's identity is `Pf`, a blinded derivation of `R_f` toward `P_fac`** — the
  exact shape of a member's `P` (blinded toward `O`), one level down with `P_fac` in the owner's
  role. Context string `nip-chat:v2:facilitated-pseudonym:<dTag>`, peer `P_fac` (NIP-SKD blinded
  form). The facilitated user derives it from `R_f_priv` + `P_fac_pub` (`Pf_priv = R_f_priv + t`,
  held only by them); the facilitator re-derives the same **`Pf_pub`** via
  `getPeerBlindedPubkey(context, peer = R_f_pub)` (same `t` by ECDH symmetry) but **cannot** obtain
  `Pf_priv`. So **the facilitator adds people by their real npub `R_f`** (v1's UX) — it derives
  `Pf_pub` itself and keys the leaf on it; `R_f` never enters the tree, and the facilitator cannot
  impersonate the vouched user. (The verifier-side derivation is a sub-sub-key off `P_fac`, so the
  *facilitator* role needs a **local** key; the *facilitated* side derives from its own root and
  works on any NIP-SKD signer.)
- **Leaf key wrapped `P_fac ↔ Pf`** (to the leaf pubkey), so the facilitator can rehydrate every leaf
  for a rebuild without needing the `R_f`s back.
- **The list JR (and its Blossom auth) is authored by `P_fac`** — the facilitator's ordinary public
  member identity; no `R_fac` leak. The vouched user finds it by that handle.
- **The facilitated user posts under `Pf`** with a normal identity tag (`enc(channelKey, R_f‖sig)`)
  plus `["facilitator", P_fac]`. Viewers validate P-to-P: `P_fac` is a member with `facilitate`, and
  `msg.pubkey` (`= Pf`) is a leaf in `P_fac`'s tree. No roster needed — works for someone the owner
  never added to the main tree.

> **Resolving the `facilitator` tag (interop).** The `["facilitator", …]` tag carries the
> facilitator's **on-wire** identity — `P_fac` in v2 (the real key `R_fac` in v1). But the member
> roster keys members by their **real key `R`** (with the pseudonym `P` in a side field). So to check
> "is this facilitator a member who holds `facilitate`", a validator must match the tag against
> **either** the roster's `R` **or** its `P`, then read permissions by the resolved member — matching
> `P_fac` only against `R` finds nothing and silently hides every message that facilitator vouched.
> Likewise, the tree-membership check compares the tag-tree leaves against **`msg.pubkey`** (the
> on-wire `Pf`/`R`), never the identity-tag-resolved `R`. A facilitated user is a non-member with no
> roster of their own, so their client trusts the secret (obtained through the tree) rather than
> re-verifying the facilitator's permission it can't see.

`members.ts`: `createAndUploadFacilitatorTreeV2` / `addMemberToFacilitatorTreeV2` /
`rebuildFacilitatorTreeV2` (by `R_f`) and `decryptSecretFromFacilitatorTreeV2` (facilitated side).
A facilitated user decrypts the hub's encrypted structural content with the same content key once it
holds the secret (else it lands in an empty hub with no channels).
Epoch history rides along exactly as in v1 (see §5.6). **Out-of-band handshake:** the vouched user
gives the facilitator their npub (`R_f`); the facilitator gives the vouched user their `P_fac` handle
(surfaced with a copy button in User Settings → My Facilitation List). Because the facilitator can't
reverse `Pf → R_f`, its client remembers the vouched `R_f`s locally (for the list display + removal).

> **Why `R` in the event, not "look it up in the roster"?** The roster is *paginated* — a member
> holds `P→R` only for members on **their own** leaf page. So anything that must resolve `R`
> cross-page carries it **in the event** (the identity tag for content, `enc(R)` for typing),
> exactly as messages do. The roster is only for the owner's rehydration and same-page display.

### 4.7 Facilitation — the full system

A **facilitator** is a member (not the owner) who can vouch people into a hub *without* an admin
approving them, by distributing the hub secret through their own LKH tree. It is a delegated,
resilient admission path (e.g. the owner is offline). The whole system:

**Permission gate (`facilitate`).** Facilitation is gated by a per-role `facilitate` permission,
**off by default** for every role (the creator always has it via full permissions). Only a member
whose role grants it may build/maintain a facilitation list (the UI is hidden otherwise). The
permission is the revocation lever — see message validation below. (Applies to v1 and v2 alike; the
permission set is client-side-enforced like all others, §8.)

**The list.** A facilitator publishes a kind-`36944` join request carrying a **`list`** tag whose
value is the Blossom hash of their **index** → **monolithic** LKH tree (§5.2.3) that hands out the
current hub secret. In **v1** the tree keys leaves on real keys `R` and wraps `R`→`R`. In **v2** it
keys on the facilitated pseudonym `Pf` (a **blinded** derivation of `R_f` toward `P_fac`, §4.6) and
wraps `P_fac ↔ Pf` — no `R` ever enters the tree. In **both** versions the facilitator adds people **by their public npub** (in v2 it
derives `Pf` from that npub itself), and a facilitated user gets in by fetching the facilitator's
`list` → tree and decrypting their own leaf. Once set,
the facilitator is remembered (`facilitator` pref) and re-used on reload.

**Facilitated posting + display validation.** A facilitated member tags every message with a
`["facilitator", <facilitator-pubkey>]` tag. A viewer shows such a message **iff** the named
facilitator (a) is a member, (b) **currently holds `facilitate`**, and (c) has the author in their
tree. So **revoking the role/permission hides every message from everyone that facilitator vouched**
— the same effect as a ban, driven purely by the permission (checked live against current roles, so
a stale cached list can't re-expose a revoked facilitator). Revocation also **re-gates the vouched
users themselves**: a facilitated non-member whose facilitator lost the permission (or left) is sent
back to the awaiting-approval overlay even though the hub secret still sits in their store — the key
is valid (nothing rotated) but their authorization is gone.

Viewers load a facilitator's member list **lazily** — only for facilitators actually referenced by a
visible message, once each — never the whole set on load. Because a transient relay miss returns an
empty list indistinguishable from "no list", the load **retries with backoff** instead of treating
the first empty as final (otherwise that facilitator's messages would stay hidden until an app
restart). Fetched lists are **persisted to `localStorage`** (public pubkeys only) so they validate
instantly on the next start, with a once-per-session background revalidation for add/remove.

**Epoch rotation (the subtle part).** Because a facilitated member's *only* source of the secret is
the facilitator's tree, the tree must track the **current epoch**, or the member would encrypt with
a stale secret under a new-epoch tag (undecryptable) — and re-using an old secret would also let a
just-kicked member read new messages, breaking forward secrecy. So:
- The facilitation tree carries the **epoch history** (the byte-identical owner-tree history blob,
  `AES(currentSecret, "hub:<epoch>:<hex>…")`) so a vouched member can decrypt every past epoch.
- After a rotation the **facilitator rebuilds** their tree under the new secret + updated history and
  republishes the `list`. This is a **manual, explicit action** ("Update list to current epoch" in
  User Settings → My Facilitation List): the facilitator is a member, so their client already holds
  the new secret; the button re-encrypts every vouched leaf under it. (An automatic rebuild was tried
  but removed — it only fired when the facilitator's client was open at the exact instant the rotation
  event arrived; a facilitator who logged in *after* the rotation saw no epoch transition to detect,
  so it silently did nothing. Manual is reliable regardless of timing.) If the facilitator never
  updates, their vouched members stay at the last epoch they hold — the owner directly admitting them
  is the escape hatch.
- The **facilitated member re-fetches** on rotation — automatically when their client is open for the
  event, and on every hub open/reload (the loader re-pulls the facilitator's tree using the saved
  `facilitator` npub, which is **persisted to `localStorage`** so it survives sessions; only the npub
  and the show-facilitated toggle are stored, never the derived secret). The three write sites that
  install a facilitated secret (load, live rotation, manual "Set facilitator") all enforce one
  invariant: **`hubSecrets[dTag]` is the current epoch's secret, or empty — never stale.** So if the
  facilitator is still behind, the client **keeps the epoch history but clears the current secret** —
  it can read old messages but cannot read *or send* at the new epoch (no stale-secret send under a
  new tag). Whenever a facilitated user has no current secret — behind on epoch, or their facilitator
  was de-permissioned — they see the awaiting-approval gate. It renders the saved facilitator as a
  clickable identity card (avatar, name, copyable npub → opens their profile) explaining they haven't
  been let in (list not updated, or permission removed), with Remove / Change beside the Withdraw
  button; it clears on its own once the facilitator updates their list.

**Graduation & interaction with kick.** If a facilitated member is later admitted by the owner
(added to the main tree), they become a normal member — their new messages carry no facilitator
tag, and revoking the facilitator no longer affects them. Conversely, kicking a member who is *also*
in a facilitator's list reverts them to facilitated (a vouch outlives a kick); fully removing them
needs the owner to also revoke that facilitator (or rotate).

---

## 5. Blossom File System

### 5.1 Index File

The hub event contains a single `m` tag pointing to an **index file** on Blossom:

```json
["m", "<sha256_of_index_file>", "<epoch>"]
```

The index file lists all Blossom files and their hashes. Two formats are supported:

#### Paginated Format (Hub Creator Indexes)

Used for hub creator member trees. Members are partitioned into leaf pages of up to 10,000 each, connected by a spine tree.

```
meta:page_size=10000
spine:<sha256_of_spine_file>
leaf-page:0:<first_pubkey_hex>:<sha256_of_page_0>
leaf-page:1:<first_pubkey_hex>:<sha256_of_page_1>
...
bans:0:<sha256_of_ban_page_0>
history:<sha256_of_history_file>
group:<group_id>:<sha256_of_group_tree_file>
```

| Line | Description |
|------|-------------|
| `meta:page_size=N` | Page size constant (always `10000`). Presence of `meta:` indicates paginated format. |
| `spine:<hash>` | SHA-256 hash of the spine file connecting page roots to the hub secret. |
| `leaf-page:<idx>:<first_pubkey>:<hash>` | A leaf page. `idx` is the page index (0-based). `first_pubkey` is the lexicographically smallest pubkey in the page (for binary search). `hash` is the page file's SHA-256. |
| `bans:N:<hash>` | Ban page (see §5.3). |
| `history:<hash>` | Epoch secret history (see §5.4). |
| `group:<id>:<hash>` | Group tree for `grouped_roles` (see §5.5). |

Clients locate a member's page via binary search on `first_pubkey` values: find the last page whose `first_pubkey ≤ target_pubkey`.

#### Monolithic Format (Facilitator / Mod Indexes)

Used for facilitator mesh lists and mod ban list indexes. Contains a single LKH tree file.

```
tree:<sha256_of_lkh_tree_file>
bans:0:<sha256_of_ban_page_0>
history:<sha256_of_history_file>
```

For grouped roles, additional tree files are referenced:

```
group:<group_id>:<sha256_of_group_tree_file>
```

#### Format Detection

Clients detect the format by checking for the presence of `meta:` (paginated) vs `tree:` (monolithic) lines. Both formats populate the same `IndexFile` structure — the client checks `pageSize > 0` to determine which path was used.

Clients download the index file first, compare with locally cached hashes, and only download files that have changed.

### 5.2 LKH Tree File Format

The member/key file uses a **Logical Key Hierarchy (LKH)** tree structure.

> [!IMPORTANT]
> **v2 differences (see §0.2).** In a v2 hub: (1) each `leaf`'s `member_pubkey` is the
> member's **pseudonym `P`**, not their real key; (2) each **page** carries one extra line — a
> group-encrypted, epoch-stamped **roster segment** `roster:<epoch>:<enc({P:R})>` under
> `HKDF(hub_secret_epoch, "roster:epoch:<epoch>")` (§5.2.1), used to render real users in the roster and to ban by
> real key; (3) the **leaf pages stay plaintext** (keyed on the unlinkable `P`), so the
> top-level binary search **and the v1 hub-secret bootstrap are unchanged** — the page *is* the
> tree that distributes the hub secret, so encrypting it whole would be undecryptable before
> you hold the secret. The tree math, spine, pagination, and `findPageForPubkey` operate on
> opaque 32-byte keys and are unchanged.
>
> **Residual leak (accepted, but load-bearing).** The plaintext index still exposes each
> page's `first_pubkey` boundary — roughly **one pseudonym per 10k-member page** (≈
> `pageCount` pseudonyms) — and, watched across epochs, a coarse **member-count and churn**
> signal ("~N members, growing/shrinking"). This is **pseudonym-level — no real
> identities**. It is accepted, but note it is **load-bearing**: since v2 has no relay-side
> membership gate (enforcement is entirely client-side, §9.9), this index is the *only*
> public membership signal left, so its residual value is higher than it looks in isolation.
> Hiding it too would require encrypting the index boundaries and binary-search-with-
> decryption — deliberately **not** done in v2, a conscious cost/benefit call given the
> values are pseudonyms.

#### 5.2.1 Leaf Page File (Paginated)

Each leaf page is a self-contained subtree of up to `PAGE_SIZE` (10,000) members. The file is line-based:

```
leaf:<node_id>:<member_pubkey>:<role_ids>:<nip04_encrypted_leaf_key>[:<flags>]
node:<node_id>:<left_child_id>:<right_child_id>:<aes_encrypted_with_left>:<aes_encrypted_with_right>
page-root:<node_id>:<left_child_id>:<right_child_id>:<aes_encrypted_with_left>:<aes_encrypted_with_right>
roster:<epoch>:<aes_encrypted_P_to_R_map>          # v2 only — see "Roster segment" below
```

**Line Types:**

**`leaf`** — A member (tree leaf node)

| Field | Description |
|-------|-------------|
| `node_id` | Short UUID. Unique identifier for this tree node. |
| `member_pubkey` | Hex-encoded public key of the member. |
| `role_ids` | Pipe-separated role UUIDs (e.g., `role1\|role2`). Use `everyone` for default role only. |
| `nip04_encrypted_leaf_key` | The leaf's symmetric key, encrypted to this member's pubkey using NIP-04. Only this member can decrypt. |
| `flags` | Optional. `w` = whitelisted (see §5.3 Ban List Resolution). |

**`node`** — An internal tree node

| Field | Description |
|-------|-------------|
| `node_id` | Short UUID. Unique identifier for this tree node. |
| `left_child_id` | Node ID of the left child (leaf or node). |
| `right_child_id` | Node ID of the right child (leaf or node). |
| `aes_encrypted_with_left` | This node's key, AES-256-GCM encrypted with the left child's key. |
| `aes_encrypted_with_right` | This node's key, AES-256-GCM encrypted with the right child's key. |

**`page-root`** — The top node of the page subtree (exactly one per file)

Same fields as `node`. The page-root's key bridges to the spine tree (the spine holds it encrypted with the spine node's key). Unlike the monolithic `root`, the page-root does NOT hold `encHubSecret` — that is the spine's responsibility.

**`roster`** (v2 only) — The page's group-encrypted identity segment. At most one per file.

| Field | Description |
|-------|-------------|
| `epoch` | The epoch whose hub secret encrypts this segment (so a reader picks the right secret from history). |
| `aes_encrypted_P_to_R_map` | `AES-GCM(HKDF(hub_secret_epoch, "roster:epoch:<epoch>"), JSON({ P: R, … }))` — the `P→R` map for **this page's** members. Base64 (no `:`), so the line splits cleanly. |

The roster segment is what lets members (who hold the hub secret) resolve each pseudonym `P` to the real key `R` — including **silent members** who never posted — and ban by real key. Keying it on the hub secret means members can deanonymize each other *inside* the hub while the public cannot; the leaf pages themselves stay plaintext and reveal only `P`.

**Group-encrypted, not per-leaf.** One AES op per page (not per member), and because the key is the client-held hub secret, reading/writing it costs **no signer round-trips** — owner tree ops stay v1-class even with a remote signer.

**Epoch stamp → forward-secret identity.** On a kick or rotation, only the *touched* page's segment is rewritten under the **new** epoch and re-stamped; untouched pages keep their old stamp (readers hold every past secret via §5.4 history). A rotated-out secret cannot open a segment written after it, so a **kicked member — or a leaked old secret — sees the members present when they held the key, but never anyone added afterward.** A bare rotation rewrites **0** roster segments; a kick/add rewrites **one** — v1-parity even at 10M members. (Fully re-hiding *already-present* members on a bare rotation would require re-encrypting every segment; that "eager" rewrite is **deliberately not done**.)

#### 5.2.2 Spine File (Paginated)

The spine connects page roots to a single root that encrypts the hub secret. It contains:

```
pr-key:<node_id>:<aes_encrypted_page_root_key>
node:<node_id>:<left_child_id>:<right_child_id>:<aes_encrypted_with_left>:<aes_encrypted_with_right>
root:<node_id>:<left_child_id>:<right_child_id>:<aes_encrypted_with_left>:<aes_encrypted_with_right>:<aes_encrypted_hub_secret>
```

**`pr-key`** — Page-root key recovery line (creator-side only)

| Field | Description |
|-------|-------------|
| `node_id` | The page-root's node ID (matches a `page-root` in one of the leaf pages). |
| `aes_encrypted_page_root_key` | The page-root's raw key, AES-encrypted with the hub secret. Allows the creator to recover all page-root keys from the spine alone without downloading all pages. |

**`root`** — Same as monolithic root. Holds `aes_encrypted_hub_secret`.

#### 5.2.3 Monolithic Tree File (Group Trees, Facilitator Mesh Lists)

Group trees (`grouped_roles`) and facilitator mesh lists use a single file containing all members:

```
leaf:<node_id>:<member_pubkey>:<role_ids>:<nip04_encrypted_leaf_key>[:<flags>]
node:<node_id>:<left_child_id>:<right_child_id>:<aes_encrypted_with_left>:<aes_encrypted_with_right>
root:<node_id>:<left_child_id>:<right_child_id>:<aes_encrypted_with_left>:<aes_encrypted_with_right>:<aes_encrypted_hub_secret>
```

**`root`** — The root node (exactly one per file)

Same fields as `node`, plus:

| Field | Description |
|-------|-------------|
| `aes_encrypted_hub_secret` | The hub secret (or group secret), AES-256-GCM encrypted with the root key. |

#### Example (Paginated — 4 members, 1 page)

**Leaf page file:**
```
leaf:a1b2:ab12...cd34:everyone:NIP04ciphertext1
leaf:c3d4:ef56...gh78:everyone|mod:NIP04ciphertext2:w
leaf:e5f6:ij90...kl12:everyone:NIP04ciphertext3
leaf:g7h8:mn34...op56:everyone:NIP04ciphertext4
node:i9j0:a1b2:c3d4:AEScipher_left1:AEScipher_right1
node:k1l2:e5f6:g7h8:AEScipher_left2:AEScipher_right2
page-root:m3n4:i9j0:k1l2:AEScipher_left3:AEScipher_right3
```

**Spine file:**
```
pr-key:m3n4:AEScipher_pageroot_key
root:s1t2:m3n4:m3n4:AEScipher_left4:AEScipher_left4:AEScipher_hub_secret
```

#### Member Decryption (Paginated)

1. Download index file → binary search `leaf-page` entries by pubkey → get page hash
2. Download leaf page + spine (parallel)
3. Find the `leaf` line matching your pubkey in the page
4. NIP-04 decrypt the leaf key using the creator's pubkey (1 signer call)
5. Walk up the page: AES-decrypt through internal `node`s to `page-root`
6. Walk up the spine: find the spine node referencing your `page-root` node ID, AES-decrypt up to `root`
7. AES-decrypt the hub secret from the `root` line

**Partial member visibility:** In this model, a member only downloads their own leaf page and the spine — not all pages. Therefore the client only has visibility of the members on its own page (up to `PAGE_SIZE`). Clients SHOULD label this subset "Active Members" and display an approximate total count (`page_count × PAGE_SIZE`) when multiple pages exist.

#### Member Decryption (Monolithic)

1. Find the `leaf` line matching your pubkey
2. NIP-04 decrypt the leaf key using the creator's pubkey (1 signer call)
3. Find the parent `node` that references your `node_id` as a child
4. AES-decrypt the parent's key using your leaf key (use the `aes_encrypted_with_left` or `aes_encrypted_with_right` depending on which child you are)
5. Repeat up the tree until reaching `root`
6. AES-decrypt the hub secret from the root line

#### Creator Operations

The creator holds ALL symmetric keys in memory when building/modifying the tree. Adding or removing members only requires local AES operations — NIP-04 is only needed when creating a new leaf.

With the paginated format, the creator downloads only the affected page + spine for any single-member operation, modifies the page, rebuilds the spine with updated page-root keys, and uploads the changed files.

### 5.3 Ban List File

> [!IMPORTANT]
> **v2 differences (see §0.2).** In a v2 hub the ban list stores the banned member's
> **real key `R`** (resolved from their identity attestation), so that a returner who
> mints a fresh pseudonym `P'` is still caught by matching `R`. The ban file **MUST be
> encrypted** as a whole blob with `HKDF(hub_secret, salt, "ban-list:epoch:<epoch>")`,
> and it is a **separate file** (banned members are removed from the tree, so their ban
> cannot ride in a leaf). Enforcement resolves each rendered event's attested `R` and
> drops if `R` is on the decrypted ban set.

Ban list pages use a simple format with `member_pubkey` and an optional `reason`:

```
<banned_pubkey>,<reason>
```

Ban list pages are referenced in the index file as `bans:N`.

Mods who maintain mesh lists (via the `list` tag on their join request, §6.3) include their own ban list pages in their own Blossom index file, following the same format. Clients discover mod ban lists through the same mesh list mechanism.

#### Ban List Resolution

When a pubkey appears on both a member list and a ban list **from the same author**:
- **The ban list supersedes**, regardless of whitelist (`w`) flag.
- The `w` flag only protects against bans from **other** authors (mods).

Resolution order:
1. Start with the creator's member list (leaf pubkeys from LKH tree)
2. Subtract the creator's ban list (supersedes even `w` flag — same author)
3. Subtract mod ban lists (except `w`-flagged members)
4. Union with manually followed lists

```
effective = (creator_members − creator_bans)
          − (mod_bans − whitelisted)
          ∪ manually_followed
```

> **Note:** When banning a current member, the creator SHOULD also remove them from the LKH tree and rotate the hub secret (incrementing the epoch). This ensures the banned member loses access to future encrypted messages.

### 5.4 Epoch Secret History File

A single AES-GCM encrypted blob containing **all historical secrets** as plaintext. The entire blob is encrypted with the **current hub secret**.

#### Plaintext Format (inside the blob)

```
hub:<epoch_number>:<secret_hex>
group:<group_id>:<epoch_number>:<secret_hex>
```

#### Example

Plaintext (before encryption):
```
hub:1:a4b5c6d7e8f9...secrethex
hub:2:f9e8d7c6b5a4...secrethex
hub:3:1a2b3c4d5e6f...secrethex
group:abc123def:1:c3d4e5f6...secrethex
group:abc123def:2:e5f6a7b8...secrethex
```

The file stored on Blossom is: `AES-GCM-encrypt(current_hub_secret, <plaintext above>)`

Referenced in the index file as `history:<hash>`.

#### Behavior

- **Current members**: have the current hub secret → decrypt the blob → get all epoch secrets → full history access
- **Group members**: have the current group secret → can additionally decrypt group rows (if stored in a separate group blob)
- **New members**: download history file → decrypt blob with current secret → read all past messages
- **Removed members**: lose current secret on next rotation → can't decrypt the blob → locked out of all epochs
- **On hub secret rotation**: decrypt blob with old secret → append old epoch's secret line → re-encrypt entire blob with new secret. O(1) cryptographic operations regardless of history size.
- **On group secret rotation**: same approach for group-specific blobs.

This provides Discord-like UX where members see the full conversation history from day one.

### 5.5 Grouped Role Key Files

Each `grouped_roles` entry has its own Blossom LKH tree file. Same tree structure as the hub member file (§5.2), but:
- Contains the **group secret** instead of the hub secret (encrypted in the root node)
- Only includes members whose roles are part of the group (as leaf nodes)
- Has its own independent epoch and tree

Group secret history is stored in the **unified history file** (§5.4) alongside hub secrets. Each group's history rows are encrypted with that group's current secret.

Referenced via the `m` field in the `grouped_roles` entry in the hub event content.

**v2 keying — leaves on `P`, wrapped `O ↔ P`.** In a v2 hub a group tree keys each leaf on the member's pseudonym `P` (never `R`), and wraps that leaf's key **`O ↔ P`** — the owner `O` to the member's pseudonym `P` (= the leaf pubkey). A member unwraps with their own `P`-signer (peer = `O`). This differs from the naïve `O ↔ R` (wrapping to the real key), and the choice matters for maintenance:

- Because the wrap is to `leaf.pubkey` (`P`), the **owner can rehydrate the whole tree from the tree alone** — decrypting each leaf against its own `P`, with **no roster / `P→R` lookup**. That in turn enables **incremental** add/remove (`addMemberToGroupTreeV2` / `removeMemberFromGroupTreeV2`): patch the one changed leaf and re-key its path, preserving every other member.
- This is what keeps group re-keying correct once the roster spans **more than one leaf page**. A full rebuild driven by the in-memory roster only sees the owner's own page, so it would silently drop group members on other pages; reading membership from the *tree* (via incremental ops) avoids that. Kicks and role changes take the incremental path; a full "fix-encryption" rebuild (which already holds the complete roster) rebuilds from scratch and doubles as the `O↔R → O↔P` migration.
- A removal **rotates** the group secret (forward secrecy) and bumps the group epoch; a pure addition reuses the current secret.

### 5.6 Mesh Lists (Facilitation)

Any member can maintain their OWN Blossom LKH tree file for the hub, enabling them to act as a **facilitator** — granting non-members access to encrypted hub messages.

- They build their own tree with their own members as leaves
- Leaf keys are NIP-04 encrypted using THEIR keypair (not the creator's)
- The hub secret distributed is the same one they obtained from the creator's tree
- Tree + index files are uploaded to the hub's Blossom servers (and optionally the facilitator's own servers for redundancy)
- Discovery: the facilitator adds a `["list", "<sha256_of_index_file>"]` tag to their join request (kind `36944`); see §6.3
- Their files are NOT referenced in the hub event

The creator's list (in the hub event's `m` tag) remains the canonical source.

#### Facilitated Messages

When a non-member obtains the hub secret via a facilitator's mesh list, their messages include a `["facilitator", "<facilitator_hex_pubkey>"]` tag (see §6.2). This allows clients to:

1. Identify who facilitated the non-member's access
2. Verify the facilitator is an actual member of the creator's list before rendering
3. Apply user preferences (e.g., "show facilitated messages" toggle)

#### Trust Model

- Facilitators can only distribute the **same hub secret** they already have — they cannot grant access to secrets they don't possess
- Clients SHOULD verify that the `facilitator` pubkey in a message tag is actually in the creator's member list before trusting it
- Clients SHOULD additionally verify that the **message author** appears as a leaf in the facilitator's own LKH tree. A valid facilitator tag alone is insufficient — the facilitator must have explicitly added the posting user to their tree.
- If either verification fails (facilitator not in creator list, or author not in facilitator tree), the client SHOULD treat the message as an unauthorized non-member post and apply the non-member message hiding policy (see §9.8).
- The hub secret epoch in a facilitated message will match an existing epoch in the creator's history file, so members can decrypt without fetching the facilitator's tree

### 5.7 Tree Balance Management

The tree SHOULD be kept balanced (all leaves at the same depth, ±1 level) to maintain O(log N) performance.

When members are added or removed:
- **Adding**: insert the new leaf into the tree, maintaining balance. If the tree is full, extend one branch.
- **Removing**: delete the leaf, re-key the affected path. If the sibling is also deleted, collapse the parent.
- **Rebalancing**: if the tree becomes significantly unbalanced (e.g., max depth > 2× log₂(N)), the creator MAY rebuild the tree from scratch. This is an O(N) operation (N NIP-04 encrypts) and should be rare.

Clients SHOULD offer a "Fix Encryption" action in hub settings that rebuilds a balanced tree — useful for recovering from other clients' implementation issues or data corruption.
- Only re-upload pages whose content changed. Update index file with new hashes.

#### Role Deletion (Lazy Cleanup)

Deleting a role does NOT trigger a tree update. The hub event is the authority for what roles exist — the client ignores unknown role UUIDs in tree leaves, falling back to `everyone` or whatever other valid roles the member has. Stale role references in leaves are harmless dead data that self-heal whenever a page is next touched for any other reason (member add, ban, role change, fix encryption).

---

## 6. Event Kinds

### 6.1 Hub Event — Kind `36942`

**Type**: Addressable Replaceable Event

```json
{
  "kind": 36942,
  "pubkey": "<creator_hex_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["d", "<hub_uuid>"],
    ["n", "<hub_name>"],
    ["w", "<pow_difficulty>"],
    ["W", "<join_pow_difficulty>"],
    ["epoch", "<epoch_number>"],
    ["b", "<on|off>"],
    ["r", "wss://relay1.example.com", "general"],
    ["r", "wss://relay2.example.com", "general"],
    ["o", "https://blossom1.example.com"],
    ["o", "https://blossom2.example.com"],
    ["o", "https://blossom3.example.com"],
    ["m", "<sha256_of_index_file>", "<epoch>"],
    ["published_at", "<original_creation_timestamp>"],
    ["client", "<client_app_name>"]
  ],
  "content": "<JSON string>",
  "sig": "<signature>"
}
```

#### Tags

| Tag | Required | Description |
|-----|----------|-------------|
| `d` | Yes | UUID v4. Unique hub identifier for addressable replaceable event. |
| `n` | Yes | Human-readable hub name for display and discovery. |
| `w` | No | Minimum **message** PoW difficulty (NIP-13). Messages MUST include a `nonce` tag meeting this difficulty. Clients SHOULD hide messages below this threshold. This is v2's primary spam floor for messages (enforcement is client-side, §9.9). Clients discovering hubs can filter by `#w` to find hubs with specific difficulty levels. **The hub event itself MUST also be mined to `w`** — see the `nonce` row below. |
| `W` | No (**v2**) | Minimum **join** PoW difficulty (NIP-13), separate from and set **higher than** the message `w`. The join request (kind `36944`) MUST carry a `nonce` meeting this difficulty; under-PoW joins are dropped before the owner spends an ECDH to decrypt them (§6.3). Plaintext because prospective members cannot read the encrypted `content`. Absent ⇒ no join PoW. |
| `nonce` | Conditional | The **hub event's own** PoW nonce (NIP-13). Required when `w` > 0: the 36942 event MUST be mined to `w` leading-zero bits on **every publish** — creation *and* every republish (settings edit, channel/role/relay/blossom edit, ban, member add/remove, epoch rotation). This makes publishing a hub cost PoW, so fake hubs can't be spammed for free. Discovery clients **verify it locally** and drop any hub whose event id doesn't actually meet its claimed `w`. `w = 0` ⇒ no nonce needed. |
| `message_expiration` | No | Disappearing-messages timer as a DURATION in **seconds** (a JSON-number-as-string). Absent, `0`, or malformed ⇒ off. When set, every durable chat event in the hub carries a NIP-40 `["expiration", <created_at + this>]` tag (§9.10). **Named distinctly from NIP-40's `expiration` on purpose** — an `expiration` tag on the hub event would make relays delete the hub itself. Hub-wide policy only; per-message expiry is stamped at send time. |
| `epoch` | Yes | Current hub-wide secret epoch. Incrementing integer starting at `1`. Increments only on secret rotation (member removal or a user being added to the block list). |
| `b` | No | DNN ID requirement (`on`/`off`). Default: `off`. |
| `r` | Yes | Relay. Third value is `general`. At least one `general` MUST be defined. |
| `o` | Yes | Blossom server URL. Recommend ≥3 for redundancy. Used for member files and media. |
| `m` | Yes | Index file reference: `["m", "<sha256>", "<epoch>"]`. |
| `t` | No | Discoverable topic tag (e.g., `["t", "gaming"]`). Multiple `t` tags allowed. Clients can query hubs via `#t` filters for hub discovery. |
| `content-warning` | No | NIP-36: marks the hub as containing sensitive/NSFW content. Value is an optional reason string (may be empty). Clients SHOULD blur or hide NSFW hubs unless the user has opted in. |
| `L` | Conditional | NIP-32: label namespace. Set to `"content-warning"` when the `content-warning` tag is present, enabling relay-side querying via `#L` filters. Required if `content-warning` is present. |
| `f` | No | Discoverability flag (`on`/`off`). Default when absent: `on`. When `off`, compliant clients SHOULD NOT display this hub in public search, browse, or discovery UIs. This is a **client-side convention** — it does not hide the event from relays. Clients can filter relay queries with `#f` to efficiently fetch only discoverable hubs. |
| `published_at` | Yes | Unix timestamp of the original hub creation. On first publish, set to the same value as `created_at`. On subsequent updates, carry forward the original value unchanged. This provides a stable ordering timestamp for hub discovery and display, since `created_at` drifts with each update. |
| `client` | No | Name of the client application that created or last updated this hub (e.g., `"DEN Chat"`). Used for discovery filtering — users can search for hubs created by a specific client. Clients SHOULD include this tag for discoverability. |
| `version` | No | Hub **format** version (§0). **Absent ⇒ v1** (public format — a permanent option, not deprecated). `"2"` ⇒ v2 (member-identity privacy). Any higher/unknown value ⇒ clients SHOULD prompt to update and not render the hub. See the version-integrity fail-safe in §0. |
| `signer_scheme` | Conditional (**v2**) | Which NIP-SKD derivation scheme produced this hub's identities: `["signer_scheme", "<family>", "<version>"]`, e.g. `["signer_scheme", "skd", "1"]` ⇒ NIP-SKD v1 (salt `"nip-skd-v1"`). **Absent ⇒ `skd`/`1`** (default). Set at creation and **pinned** (the owner pseudonym `O` is scheme-bound). Clients route derivation by `(family, version)`, so a future NIP-SKD version — or a different scheme the ecosystem adopts — is a new tag value, never a break for existing hubs. Bumping the version (e.g. `"2"`) selects salt `"nip-skd-v2"`; changing the family points at a different scheme entirely. |
| `new_hub` | Conditional | Present only on a **v1 hub that has been forked** to a v2 successor (§12). Value is the successor hub's `d` tag. Clients MUST only honor it when the successor's creator pubkey equals this hub's creator pubkey, and SHOULD (a) show a permanent "this hub has moved" banner and (b) hide this hub from discovery. |
| `picture` | No (**v2**) | Plaintext hub icon URL for the join/Discover card. In v2 the icon moves out of the (encrypted) `content.settings` into this tag so non-members can preview it. |
| `banner` | No (**v2**) | Plaintext hub banner URL for the join/Discover card. Moved out of `content.settings` in v2. |
| `about` | No (**v2**) | Plaintext public description/blurb for the join/Discover card. Moved out of `content.settings` in v2. Member-only prose belongs in a pinned message or channel, not here. |

#### Updating Hub Events (`created_at` Increment)

Hub events are addressable replaceable events that get updated frequently (settings changes, member list rotation, epoch bumps, etc.). When publishing an updated hub event, the client MUST set `created_at` to the **previous event's `created_at` + 1** — the same increment rule used for message edits (see §6.2, Editing Messages).

This prevents the hub event from jumping to the current wall-clock time on every update, which would cause discovery UIs that sort by `created_at` to incorrectly show old hubs as "recently created." Clients and discovery aggregators SHOULD sort hubs by `published_at` for display ordering, not `created_at`.

#### Content (JSON)

> [!IMPORTANT]
> **v2: the `content` field is encrypted (§4.2, §2.5 of the plan).** In a v2 hub the JSON
> below is serialized and encrypted as
> `content = base64(IV || AES-GCM(hub_content_key, json) || tag)` — same format as a
> message — so the **structure (roles, categories, channel names, permissions, plugins)**
> is member-only. Re-encrypt with the **current** epoch key on every republish. The hub
> **secret is not here** — it lives in the Blossom tree (via `m` → page/spine), so a new
> member gets the secret from the tree first and then decrypts this content, exactly like a
> message; there is no bootstrap loop.
>
> The **public face** moves OUT of `content.settings` into the plaintext `picture`,
> `banner`, and `about` tags (plus `n`, `t`) so the join/Discover card still renders for
> non-members. `content.settings` is therefore **omitted** in v2. An **unlisted hub** simply
> leaves the face tags blank and sets `f=off`; members still see the encrypted structure once
> admitted. An unlisted hub is only hidden from Discover — it still publishes a public hub
> event (stable `d`, `epoch`, `m`) and its pseudonymous `h`-tag traffic stays observable on
> relays; only its branding and discoverability are hidden, not its existence or activity.

```json
{
  "settings": {
    "profile_picture": "<image_url>",
    "banner_image": "<image_url>",
    "description": "<hub description text>"
  },

  "roles": [
    {
      "role_id": "<uuid>",
      "name": "everyone",
      "position": 0,
      "permissions": {
        "view_channel": true,
        "send_messages": true,
        "add_reactions": true,
        "create_invite": false,
        "ban_members": false,
        "hide_messages": false,
        "embed_links": false,
        "attach_files": false,
        "mention_everyone": false,
        "mention_here": false,
        "create_polls": true
      }
    },
    {
      "role_id": "<uuid>",
      "name": "mod",
      "color": "#e74c3c",
      "position": 1,
      "hoist": true,
      "permissions": {
        "view_channel": true,
        "send_messages": true,
        "add_reactions": true,
        "create_invite": true,
        "ban_members": true,
        "hide_messages": true,
        "embed_links": true,
        "attach_files": true,
        "mention_everyone": true,
        "mention_here": true,
        "create_polls": true
      }
    }
  ],

  "grouped_roles": [
    {
      "group_id": "<sha256(sorted(role_ids))>",
      "roles": ["<role_id_A>", "<role_id_B>"],
      "epoch": 3,
      "m": "<sha256_of_group_key_file>"
    }
  ],

  "categories": [
    {
      "category_id": "<uuid>",
      "name": "General",
      "position": 1,
      "encryption": null,
      "permissions": {
        "everyone": { "view_channel": true, "send_messages": true }
      }
    },
    {
      "category_id": "<uuid>",
      "name": "Staff",
      "position": 2,
      "encryption": "group:<group_id>",
      "permissions": {
        "everyone": { "view_channel": false },
        "<mod_role_id>": { "view_channel": true, "send_messages": true }
      }
    }
  ],

  "channels": [
    {
      "channel_id": "<uuid>",
      "name": "general",
      "type": "chat",
      "category_id": "<uuid>",
      "synced": true,
      "encryption": null,
      "position": 1,
      "permissions": {}
    },
    {
      "channel_id": "<uuid>",
      "name": "announcements",
      "type": "announcement",
      "category_id": "<uuid>",
      "synced": false,
      "encryption": null,
      "position": 2,
      "permissions": {
        "everyone": { "view_channel": true, "send_messages": false },
        "<mod_role_id>": { "send_messages": true }
      }
    }
  ],

  "plugins": {}
}
```

#### Content Field Reference

**`roles[]`**

| Field | Type | Description |
|-------|------|-------------|
| `role_id` | UUID | Unique identifier |
| `name` | string | Display name. `everyone` is required and always present. |
| `color` | string\|null | Optional hex color (e.g., `"#e74c3c"`) for display badges in the member list. `null` or absent for default theme color. |
| `position` | integer | Display order and priority. `0` is reserved for the `everyone` role (always last in the member sidebar). Custom roles use ascending integers starting from `1`. Lower values = higher priority. |
| `hoist` | boolean | Optional, defaults to `false`. When `true`, members with this role are displayed in their own collapsible section in the member sidebar. Members in multiple hoisted roles appear in the highest-priority (lowest `position`) hoisted role. Members not in any hoisted role appear under `everyone`. |
| `permissions` | object | Permission flags (see §8) |

**`grouped_roles[]`**

Only present when the hub has private channels with separate encryption.

| Field | Type | Description |
|-------|------|-------------|
| `group_id` | string | `sha256(sorted(role_ids))` — deterministic, no duplicates possible |
| `roles` | string[] | Role IDs whose members share this group's secret |
| `epoch` | integer | Increments on membership changes within this group |
| `m` | string | SHA-256 hash of the group's Blossom key file |

**`categories[]`**

| Field | Type | Description |
|-------|------|-------------|
| `category_id` | UUID | Unique identifier |
| `name` | string | Display name |
| `position` | integer | Display order |
| `encryption` | string\|null | `"group:<group_id>"` or `null` (hub-wide secret) |
| `permissions` | object | Role → permission overrides |

**`channels[]`**

| Field | Type | Description |
|-------|------|-------------|
| `channel_id` | UUID | Unique identifier |
| `name` | string | Display name |
| `description` | string\|null | Optional channel description displayed in the header. `null` if not set. |
| `type` | string | `chat`, `announcement`, `forum`, or `voice` |
| `category_id` | UUID\|null | Parent category (`null` if uncategorized) |
| `synced` | boolean | If `true`, inherit category's permissions AND encryption |
| `encryption` | string\|null | `"group:<group_id>"` or `null`. Ignored when `synced: true`. |
| `position` | integer | Display order within category |
| `permissions` | object | Role → permission overrides. Ignored when `synced: true`. |

---

### 6.2 Message Event — Kind `36943`

**Type**: Addressable Replaceable Event

```json
{
  "kind": 36943,
  "pubkey": "<sender_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["d", "<message_uuid>"],
    ["h", "<hub_d_tag>"],
    ["c", "<channel_id>"],
    ["epoch", "<epoch_number>"],
    ["published_at", "<original_creation_timestamp>"],
    ["nonce", "<random>", "<difficulty_bits>"]
  ],
  "content": "<AES-256-GCM encrypted message>",
  "sig": "<signature>"
}
```

The `content` field is a base64-encoded binary blob:

```
base64( 12-byte-IV || ciphertext || 16-byte-auth-tag )
```

Clients split on known offsets: first 12 bytes = IV, last 16 bytes = auth tag, everything between = ciphertext.

| Tag | Required | Description |
|-----|----------|-------------|
| `d` | Yes | UUID v4. Unique identifier for this message. Makes it individually addressable. Re-publishing with the same `d` tag replaces the previous version (edit behavior). |
| `h` | Yes | Hub `d` tag identifier |
| `c` | Yes | Channel UUID |
| `epoch` | Yes | Epoch number of the secret used for encryption. The client infers whether this is a hub epoch or group epoch from the channel's `encryption` field: if `null`, it refers to the hub secret epoch; if `"group:<group_id>"`, it refers to that group's epoch. |
| `published_at` | Yes | Unix timestamp of the original message creation. On first publish, set to `created_at`. On edits, carry forward unchanged. Used for display ordering (see Editing Messages below). |
| `nonce` | Conditional | PoW nonce (NIP-13 format: `["nonce", "<counter>", "<target_difficulty>"]`). Required if hub has a `w` tag with difficulty > 0. |
| `facilitator` | No | Hex pubkey of the member who facilitated this non-member's access to the hub secret (see §5.6). Clients SHOULD verify the facilitator is in the creator's member list before rendering. |
| `identity` | Conditional (**v2**) | Encrypted **per-message** identity signature binding the event's pseudonymous author `P` (= `pubkey`) to the member's real key `R`. Value is `AES-GCM(channel_or_hub_key_for_epoch, "R_pub:sig_R")` where `sig_R` is `R`'s signature on a never-published kind-`27492` attestation whose `m` tag is the message digest = `getEventHash(event)` computed with the `identity` and `nonce` tags removed (so it survives PoW mining and works via `signEvent` on remote signers) — a fresh signature **over this event**, not a static binding and not over `event.id`. Because `P` is a blinded pseudonym the owner cannot sign as (§4.5), this signature is not what prevents forgery; it lets **any member** cryptographically verify which real `R` authored the event (trustless attribution) without trusting the owner's roster. **Required on every member event in a v2 hub**; events lacking a valid signature are dropped (§9.9). Opaque ciphertext — not usable for relay-level filtering. |
| `content-warning` | No | NIP-36: marks this message as containing sensitive/NSFW content. Value is an optional reason string (may be empty). Clients SHOULD blur or hide the message until the user clicks to reveal. |
| `L` | Conditional | NIP-32: label namespace. Set to `"content-warning"` when the `content-warning` tag is present. Required if `content-warning` is present. |

#### Encryption

- **Hub-wide encrypted channels** (`encryption: null`): encrypted with the channel key derived from the hub secret.
- **Group-encrypted channels** (`encryption: "group:<group_id>"`): encrypted with the channel key derived from the group secret.

#### Replies and Threading

Replies reference the parent message using `a` tags (since messages are addressable replaceable events, event IDs are unstable across edits). Every reply includes **two** `a` tags:

- **`root`** — points to the thread root (the original top-level message that started the thread)
- **`reply`** — points to the direct parent being replied to

If replying to a top-level message (not itself a reply), both `root` and `reply` point to the same message.

```json
["a", "36943:<root_pubkey>:<root_d_tag>", "", "root"]
["a", "36943:<parent_pubkey>:<parent_d_tag>", "", "reply"]
["q", "36943:<quoted_pubkey>:<quoted_d_tag>"]
```

**Important:** When editing a message that is a reply, the client MUST carry forward both `root` and `reply` tags in the re-published event.

#### Editing Messages

Because messages are addressable replaceable events, editing is done by re-publishing the event with the **same `d` tag**. The relay naturally replaces the previous version — no separate edit event is needed.

##### `created_at` Increment Rule

When editing a message, the client MUST set `created_at` to the **previous event's `created_at` + 1** (not the current wall-clock time). This ensures:

1. **Relay acceptance** — relays require a newer `created_at` to replace an addressable event, so +1 is the minimum valid increment.
2. **Stable chronological ordering** — if `created_at` jumped to "now" on every edit, an old edited message would appear to be new, stealing slots in `limit`-based relay queries (e.g., "fetch latest 100 messages") and disrupting the timeline.
3. **Accumulation across edits** — repeated edits increment by +1 each time from the previous event timestamp, not from `published_at`. This means a message edited 5 times has `created_at = original + 5`.

##### `published_at` Tag

Every message MUST include a `published_at` tag containing the **original creation timestamp** (the `created_at` value from the first version of this message). On edits, carry this tag forward unchanged.

Clients MUST use `published_at` (not `created_at`) for **display ordering** in the chat timeline. The `created_at` field should only be used internally for relay replacement semantics and edit detection.

##### Edited Event Example

```json
{
  "kind": 36943,
  "created_at": 1700000001,
  "tags": [
    ["d", "<same_message_uuid>"],
    ["h", "<hub_d_tag>"],
    ["c", "<channel_id>"],
    ["epoch", "<epoch_number>"],
    ["published_at", "1700000000"]
  ],
  "content": "<AES-256-GCM encrypted edited content>"
}
```

In the example above, the original message had `created_at: 1700000000`. The edit sets `created_at` to `1700000001` (+1), while `published_at` preserves the original timestamp `1700000000` for ordering.

**Client behavior:**

- When a newer version of a message (same `d` tag + `pubkey`, higher `created_at`) is received, the client SHOULD replace the displayed content.
- The message SHOULD display an `(edited)` indicator when `created_at` differs from `published_at`.
- Display ordering MUST use `published_at`, not `created_at`.
- Only the **original author** can publish a new version (enforced by the `kind + pubkey + d-tag` uniqueness rule).

#### Deleting Messages (Request Delete)

A user can request deletion of their own message using two mechanisms:

**1. NIP-09 Deletion Event (Kind 5)**

For addressable replaceable events, the deletion request uses an `a` tag instead of an `e` tag:

```json
{
  "kind": 5,
  "tags": [
    ["a", "36943:<sender_pubkey>:<message_d_tag>"]
  ],
  "content": "User requested deletion"
}
```

**2. Fallback "deleted" Tag**

Because not all relays honor NIP-09 deletion requests, the client SHOULD also re-publish the message with the **same `d` tag** and a `["deleted", "true"]` tag appended. The relay replaces the original with this deleted version.

```json
{
  "kind": 36943,
  "tags": [
    ["d", "<same_message_uuid>"],
    ["h", "<hub_d_tag>"],
    ["c", "<channel_id>"],
    ["epoch", "<epoch_number>"],
    ["deleted", "true"]
  ],
  "content": ""
}
```

**Client behavior:**

- When a `kind: 5` event references a message via `a` tag, or a message has a `["deleted", "true"]` tag, the client MUST NOT render the message.
- If a reply references a message that has been deleted, the reply preview SHOULD display: *"Original message was request-deleted"*.
- If a reply references a message that cannot be found at all, the reply preview SHOULD display: *"Original message not found"*.
- Only the **original author** may delete their own messages. Clients MUST ignore deletion events from different pubkeys.

#### Publishing Rules

- Publish to the hub's **general relays** (the `general` relays from the hub event, plus the client/user relays per the publishing configuration).

#### Plaintext Format

Before encryption, the message content is a JSON string:

```json
{
  "text": "**hello** world, check this out @<hex_pubkey>",
  "attachments": [
    {
      "hash": "<sha256>",
      "type": "image/png",
      "name": "screenshot.png",
      "size": 1234567
    }
  ],
  "nsfw": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Message content in Markdown format. Mentions use `@<hex_pubkey>` inline. |
| `attachments` | array | Optional. Blossom file references (see §6.2.1). |
| `nsfw` | boolean | Optional. If `true`, the message contains sensitive/NSFW content. Clients SHOULD blur attachments and hide text behind a click-to-reveal overlay. This field is inside the encrypted content and only visible to members. |

The JSON is serialized, then encrypted with AES-256-GCM using the channel message key, and placed in the event's `content` field.

#### 6.2.1 Attachment Schema

Each entry in the `attachments` array describes a file stored on the hub's Blossom servers.

```json
{
  "hash": "<sha256>",
  "type": "image/png",
  "name": "screenshot.png",
  "size": 1234567,
  "encryption": {
    "algorithm": "aes-gcm",
    "key": "<hex_64_chars>",
    "nonce": "<hex_24_chars>",
    "originalHash": "<sha256_of_plaintext_file>"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hash` | string | Yes | SHA-256 hash of the file stored on Blossom. When `encryption` is present, this is the hash of the **ciphertext** (since Blossom is content-addressed). When absent, this is the plaintext hash. |
| `type` | string | Yes | MIME type of the **original** file (e.g., `"image/png"`). |
| `name` | string | Yes | Original filename. |
| `size` | integer | Yes | File size in bytes. When `encryption` is present, this is the **ciphertext** size (plaintext + 16-byte GCM auth tag). |
| `encryption` | object | No | Per-file encryption metadata (see below). Absent for unencrypted uploads. |

**`encryption` object:**

| Field | Type | Description |
|-------|------|-------------|
| `algorithm` | string | Always `"aes-gcm"`. |
| `key` | string | AES-256 key in hex (64 characters / 32 bytes). Randomly generated per file. |
| `nonce` | string | AES-GCM nonce/IV in hex (24 characters / 12 bytes). Randomly generated per file. |
| `originalHash` | string | SHA-256 hash of the **plaintext** file in hex. Used for integrity verification after decryption. |

**Backward compatibility:** Messages without `encryption` on their attachments render exactly as before — the file is fetched directly from Blossom via its hash. Clients MUST handle both encrypted and unencrypted attachments in the same message.

#### 6.2.2 Encrypted Media Uploads

Clients MAY offer an opt-in toggle to encrypt file attachments before uploading to Blossom. This protects file content from Blossom server operators while keeping the encryption keys inside the already-encrypted message payload (accessible only to hub members).

**Upload flow (sender):**

1. User selects files and enables the "Encrypt uploads" toggle
2. For each file:
   - Compute `SHA-256(plaintext)` → `originalHash`
   - Generate random AES-256 key (32 bytes) and AES-GCM nonce (12 bytes)
   - Encrypt: `ciphertext = AES-GCM-encrypt(key, nonce, plaintext)` — ciphertext includes the 16-byte GCM authentication tag
   - Compute `SHA-256(ciphertext)` → `hash` (this becomes the Blossom content address)
   - Upload ciphertext to Blossom servers (standard Blossom upload, content-addressed by ciphertext hash)
3. Build the attachment entry with `hash` (ciphertext), `size` (ciphertext length), and the `encryption` object
4. Serialize the message JSON (including attachment metadata), encrypt with the channel key, publish

**Render flow (receiver):**

1. Decrypt the message content with the channel key → parse JSON → read `attachments`
2. If an attachment has `encryption`:
   - Download the ciphertext from Blossom using `hash` (content-addressed)
   - Decrypt: `plaintext = AES-GCM-decrypt(key, nonce, ciphertext)` — GCM authentication tag is verified automatically
   - Verify: `SHA-256(plaintext) == originalHash` (integrity check)
   - Create a `Blob URL` from the plaintext bytes for rendering
3. If an attachment has no `encryption`:
   - Render directly from the Blossom URL (existing behavior, supports streaming)

**Important tradeoffs:**

- Encrypted media **cannot be streamed** — the full ciphertext must be downloaded before decryption (GCM requires the complete ciphertext for authentication tag verification)
- Encrypted media uses **blob URLs** — the decrypted file exists only in browser memory, never written to disk
- Clients SHOULD cache decrypted blob URLs in a session-level map (`hash → blobUrl`) to avoid re-downloading and re-decrypting the same file
- The encryption key is **per-file** (not derived from the hub secret) — each file has its own independent key and nonce
- The encryption metadata is **inside the encrypted message content** — only hub members who can decrypt the message can obtain the file decryption key

**Security model:**

| Without file encryption | With file encryption |
|------------------------|---------------------|
| Blossom operators can view uploaded files | Blossom operators see only ciphertext |
| Files are streamable (progressive rendering) | Files must be fully downloaded before rendering |
| File hash = plaintext hash | File hash = ciphertext hash (plaintext hash in `originalHash`) |
| Standard Blossom content addressing | Standard Blossom content addressing (of ciphertext) |

---

### 6.3 Join Request Event — Kind `36944`

**Type**: Addressable Replaceable Event

Published by a user to signal they want to join a hub. Shows up in a request queue in the hub UI for mods/creator to process.

> [!IMPORTANT]
> **v2 private join (see §0.1).** In a v2 hub the join request MUST NOT reveal the
> requester to the public. The hub owner is the **owner pseudonym `O`** (§4.5). Use
> **ephemeral-static ECDH** (sealed-sender):
> 1. The joiner generates an ephemeral keypair `e` and computes
>    `shared = ECDH(e_priv, O_pub)`.
> 2. The request is **signed by a derived throwaway key** `addr` — a **blinded** derivation of the
>    joiner's `R` toward `O` (NIP-SKD blinded form, context `"nip-chat:v2:join-addr:"+d_tag`, peer
>    `O_pub`; `addr_pub = xonly(lift_even_y(R_pub) + HKDF(ECDH(joiner_priv, O_pub), …)·G)`) — and
>    uses `addr_pub` as its `d`-scoped identifier, so a repeat request from the same joiner replaces
>    the previous one. The owner can later re-derive `addr_pub` from `R` (via `getPeerBlindedPubkey`)
>    to confirm the authoring key belongs to the sealed `R`.
> 3. The request carries `["ephemeral", "<e_pub>"]` and a plaintext `["version", "2"]` marker
>    (so owners route it as a v2 join and never feed a v1 join into the decrypt path), and its
>    `content` is `NIP-44 v2` encrypted — `nip44.encrypt(getConversationKey(e_priv, O_pub), {r, p, note?})`
>    (payload keys `r` = `R_pub`, `p` = `P_pub`) — not raw `AES-GCM(shared, …)`; the NIP-44 conversation
>    key is itself an HKDF over the ephemeral↔`O` ECDH.
> 4. The owner decrypts with `ECDH(O_priv, e_pub)` to learn the real requester, then
>    **re-derives `P_pub` from `R`** via the blinded verifier op —
>    `getPeerBlindedPubkey("nip-chat:v2:member-pseudonym:"+d_tag, peer = R_pub)` — and admits `P`
>    only if it matches the claimed `P_pub`. This makes the pseudonym **owner-verified and
>    squat-proof**: a `P` that does not derive from the presented `R` is rejected. The owner obtains
>    `P_pub` only, never `P_priv`.
> The public sees only an unlinkable throwaway key posting an opaque blob to the hub.
>
> **Legacy joins to a v2 hub.** An outdated client with no v2 guard may send a plaintext v1
> join (kind `36944`, real-key author) to a v2 hub — it references the same coordinate
> `36942:O:d_tag`, so the owner receives it. Such a join lacks `["version","2"]` and is
> **un-admittable** (the sender cannot derive `P`). The owner's client MUST recognise it by the
> missing marker, skip the v2 decrypt path, and NOT add it to the tree; it MAY surface a subtle
> "a user on an outdated client tried to join" hint. Nothing can restore the sender's privacy
> (their old client already published their real key) nor admit them until they update.
>
> **Join PoW gate (required when `W` is set).** Because a v2 join is opaque ciphertext, the
> owner's only way to tell a real request from garbage is to run an ECDH + attempt-decrypt on
> each one — so the outer `36944` MUST carry a `nonce` (NIP-13) meeting the hub's **`W`**
> join difficulty (§6.1). Clients and owners drop under-`W` joins **before** spending an
> ECDH, restoring the cheap-discard property. `W` is set higher than the message `w`: a
> legitimate user pays it once (a join is rare), an attacker pays it per fake.

```json
{
  "kind": 36944,
  "pubkey": "<joiner_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["d", "<hub_d_tag>"],
    ["nonce", "<counter>", "<target_difficulty>"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

- The join request MUST include a `nonce` tag with PoW meeting the hub's join difficulty: in a v2 hub this is the **`W`** tag (§6.1); in a v1 hub it is the message `w` tag if set with difficulty > 0.

- `d` tag makes this replaceable (one request per user per hub). In v2 the `d`-scoped identifier is the derived `addr_pub` (see the callout above), not the joiner's real pubkey.
- Published to **general relays**.
- The user is NOT a member until they appear in a followed member file.
- Clients MAY display a "Pending" state for users who have a join request but are not yet on any list.
- Mods and creator add the user to their member file as a client-side action — no separate protocol event.
- Clients MAY offer batch accept (add multiple pending users at once) and sync functionality (copy missing members from mod lists to creator list as a manual action).

#### Mesh List Discovery (Facilitation)

Members who maintain their own Blossom LKH tree for the hub (see §5.6) can advertise it by adding a `list` tag to their join request:

```json
{
  "kind": 36944,
  "pubkey": "<facilitator_pubkey>",
  "tags": [
    ["d", "<hub_d_tag>"],
    ["list", "<sha256_of_their_index_file>"]
  ]
}
```

Clients fetching join requests for a hub automatically discover mesh lists from members who have a `list` tag. No additional event kind needed.

**Client behavior for facilitated access:**

1. Non-member selects a facilitator from a list of members who have a `list` tag on their join request
2. Client downloads the facilitator's index → tree from the hub's Blossom servers (hash-verified)
3. Client decrypts the hub secret from the facilitator's tree (NIP-04 with facilitator as counterparty)
4. Messages posted by the non-member include `["facilitator", "<facilitator_hex_pubkey>"]` tag
5. On subsequent app restarts, the client auto-fetches the facilitator's tree if the user has a saved facilitator preference

#### Withdrawing, Rescinding & Resending a Join Request

A pending request is a live `36944` event that persists on relays until it is tombstoned, so
its lifecycle has three client-driven actions (all apply to **both v1 and v2** unless noted).

**Withdraw (dual "edit-then-delete").** When an applicant cancels a pending request the client
mirrors the message/hub deletion pattern (§6.2, §6.5): (1) re-publish the same request (same
`d`-scoped identifier) with `["deleted", "true"]` and `created_at + 1`, tombstoning it at the
source; (2) publish a NIP-09 kind-5 deletion request for the join-request coordinate; and (3)
remove the hub from the User Hub List (§6.4). In **v2**, (1) and (2) are signed under the
throwaway **join-address sub-key** (`joinAddr`, blinded toward `O`, §4.6/§6.3), never `R`; in
**v1** under `R`. Moderator queues filter tombstoned requests via the existing `["deleted",
"true"]` marker.

**Self-rescind on admit.** When a member's client loads a hub and confirms **actual**
membership — a successful owner-tree decrypt of its own `P`-leaf (§5.2.1), **not** merely
facilitated access (§4.7) — it auto-cleans its now-redundant request by running **only steps
(1) and (2)** of a withdrawal (tombstone + kind-5); it does **not** leave the hub (never step
(3), the hub-list removal). It **no-ops** when there is no live (non-tombstoned) request, and
runs **at most once per device** (a local flag). *Rationale:* the `36944` request survives on
relays after approval, so without this it keeps re-appearing in the creator's join-request
view; tombstoning it at the source lets every moderator's view/badge filter it via the existing
marker. Implemented as `tombstoneOwnJoinRequest()` (`client/src/lib/hub/rescindJoinRequest.ts`),
triggered from the member-load path (`client/src/hooks/useHubLoader.ts`).

**Resend.** A still-pending applicant MAY re-publish their request with a fresh `created_at =
now` (replacing the previous one under the same `d`-scoped identifier) to re-surface it above an
inactive creator's "seen" watermark (below). It is gated to **at most once every 3 days**
(`RESEND_MIN_AGE_S`), measured from the current request's `created_at`. In **v1** the request is
re-signed under `R` and re-mined to the hub's join PoW. In **v2** it is rebuilt as a fresh
sealed request (new ephemeral `e` keypair + join-address sub-key, §6.3). Published
**hub-relays-only in v2** (correlation avoidance, §10.4-1), hub + personal relays in v1.
Implemented in `client/src/lib/hub/resendJoinRequest.ts`; surfaced as a "Resend" button beside
"Withdraw" on the awaiting-approval overlay.

#### Creator "Seen" Watermark — `den-join-read-state` (NIP-78)

The creator's per-hub join-request **"seen" watermark** — a map of hub `d`-tag → last-seen unix
timestamp — is persisted as a **NIP-78 Application-Specific Data** event (kind `30078`) so the
"already handled up to here" decision syncs across the creator's devices. It mirrors the
client's other read-states (`den-hub-read-state`, `den-dm-read-state`). This is
**creator-/moderation-side** state only.

- **`d` tag**: the generic, non-hub-specific value `"den-join-read-state"`, so an observer
  learns only that this key has a den-chat join read-state — **never which hubs it moderates**.
- **`content`**: **NIP-44 self-encrypted**. The payload enumerates the hub `d`-tags the creator
  moderates; because the event is authored by the real key `R`, a plaintext copy would link `R`
  to the private v2 hubs they own, so it **MUST** be encrypted (the same reasoning as the
  encrypted v2 entries in the User Hub List, §4.6).
- Published to the creator's **own relays** (like the other read-states), not hub relays.

The join-request view shows only requests **newer than this watermark** by default (with a "Show
all" toggle), and advances the watermark **best-effort** when the view is opened.

---

### 6.4 User Hub List — Kind `16942`

**Type**: Replaceable Event

Published by a user to their own relays. Lists all hubs the user is a member of with ordering and optional folder grouping, so clients can restore the hub sidebar layout on startup.

```json
{
  "kind": 16942,
  "pubkey": "<user_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["v", "<hub1_d_tag>", "<relay_hint>", "0"],
    ["v", "<hub2_d_tag>", "<relay_hint>", "1"],
    ["v", "<hub3_d_tag>", "<relay_hint>", "2:<folder_uuid>"],
    ["v", "<hub4_d_tag>", "<relay_hint>", "3:<folder_uuid>"],
    ["v", "<hub5_d_tag>", "<relay_hint>", "4"],
    ["folder", "<folder_uuid>", "<folder_name>"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `v` | Yes | Hub reference. Values: `["v", "<hub_d_tag>", "<relay_hint>", "<position>" or "<position>:<folder_uuid>", "<hub_format>", "<signer_scheme>"]`. Position is an integer determining display order. If `position:folder_uuid` format, the hub belongs to that folder. The 5th value `<hub_format>` records the hub's format **at join time** — empty/absent ⇒ v1, `"2"` ⇒ v2 — and is the first, authoritative signal in the version-integrity fail-safe (§0): a client MUST NOT treat a hub recorded here as `"2"` as if it were v1, even if the live hub event's `version` tag has since been stripped or altered. The 6th value `<signer_scheme>` records the hub's NIP-SKD scheme as `"family:version"` (e.g. `"skd:1"`; empty/absent ⇒ `"skd:1"`), so the owner can re-derive `O` on a new device with the correct derivation. |
| `folder` | No | Folder definition: `["folder", "<uuid>", "<name>"]`. Defines a folder group that hubs can belong to. |

- One per user (replaceable event — latest timestamp wins).
- Published to the **user's own relays**, not hub-specific relays.
- Updated when user joins/leaves a hub, reorders hubs, or creates/renames folders.
- Clients fetch this event on startup to know which hubs to load and how to arrange the sidebar.
- Position integers need not be contiguous — clients sort by value.
- Hubs within a folder are ordered by their position values.
- Folder position is determined by its lowest-positioned hub.

---

### 6.5 Hub Deletion (Request Delete)

The hub creator can request deletion of their hub using two mechanisms, mirroring the message deletion approach (§6.2).

**1. NIP-09 Deletion Event (Kind 5)**

For addressable replaceable events, the deletion request uses an `a` tag:

```json
{
  "kind": 5,
  "pubkey": "<creator_pubkey>",
  "tags": [
    ["a", "36942:<creator_pubkey>:<hub_d_tag>"]
  ],
  "content": "Hub deletion requested"
}
```

**2. Fallback "deleted" Tag**

Because not all relays honor NIP-09 deletion requests, the client SHOULD also re-publish the hub event with the **same `d` tag** and a `["deleted", "true"]` tag appended. The relay replaces the original with this deleted version.

```json
{
  "kind": 36942,
  "pubkey": "<creator_pubkey>",
  "tags": [
    ["d", "<hub_d_tag>"],
    ["n", "<hub_name>"],
    ["epoch", "<epoch_number>"],
    ["deleted", "true"]
  ],
  "content": ""
}
```

The deleted hub event retains only the essential tags (`d`, `n`, `epoch`) plus `["deleted", "true"]`. The `content` field is set to an empty string.

**Client behavior:**

- When a `kind: 5` event references a hub via `a` tag, or a hub event has a `["deleted", "true"]` tag, the client SHOULD mark the hub as deleted in the sidebar.
- Clients SHOULD display a visual indicator (e.g., `✕` overlay) on deleted hubs in the sidebar.
- Hubs that appear in the User Hub List (kind `16942`) but cannot be found on relays SHOULD display a different indicator (e.g., `?` overlay) to distinguish from deleted hubs.
- Only the **hub creator** may delete their hub. Clients MUST ignore deletion events from different pubkeys.
- Deletion is a **request**, not a guarantee. Relays MAY honor or ignore the request. The user SHOULD be informed that deletion may not be permanent or universal.

---

### 6.6 Channel Pin List — Kind `36945`

**Type**: Addressable Replaceable Event

Published by a member to pin messages across channels in a hub. Each user has **one pin event per hub** — all channel pins are stored in a single event via `pin` tags.

```json
{
  "kind": 36945,
  "pubkey": "<pinner_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["d", "<hub_d_tag>"],
    ["pin", "<channel_id>", "36943:<msg_author_pubkey>:<msg_d_tag>"],
    ["pin", "<channel_id>", "36943:<msg_author_pubkey>:<msg_d_tag>"],
    ["pin", "<other_channel_id>", "36943:<msg_author_pubkey>:<msg_d_tag>"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `d` | Yes | Hub `d` tag. One pin list per user per hub (addressable replaceable semantics). |
| `pin` | No | Pinned message reference: `["pin", "<channel_id>", "<addressable_ref>"]`. The addressable reference uses the format `36943:<author_pubkey>:<message_d_tag>`, which is stable across message edits. Multiple `pin` tags allowed. |

#### Publishing Rules

- Published to the **same relays as messages** (the hub's general relays)
- This ensures pin visibility is gated by the same access controls as message content

#### Subscription

To fetch all pin lists for a hub:

```json
{"kinds": [36945], "#d": ["<hub_d_tag>"]}
```

Clients filter by channel ID locally from the `pin` tags.

#### Pinning a Message

1. Read user's existing pin event for this hub (or start with empty tags)
2. Append a `pin` tag: `["pin", "<channel_id>", "36943:<author>:<d_tag>"]`
3. Publish updated event (relay replaces previous version)

#### Unpinning a Message

1. Remove the matching `pin` tag from the event
2. Re-publish (if no pins remain, the event can be published with only the `d` tag)

#### Client Behavior

- The pin button in the channel header opens a **Pin Modal** showing pinned messages for the current channel
- The hub creator's pins are displayed first and expanded by default
- Other members' pins are shown in collapsible accordion sections, grouped by pinner
- Each pin displays: message preview, author, timestamp, and a "Jump to message" action
- The message action bar (`...` menu) includes a "Pin" / "Unpin" option for the current user's own pin list
- A badge on the pin icon indicates when pins exist for the current channel

---

### 6.7 Voice Host Availability — Kind `36946`

**Type**: Addressable Replaceable Event

Published by a member to declare their SFU (Selective Forwarding Unit) server is available for hosting voice/video sessions in a hub. Each user has **one host event per hub per scope** — one for hub-wide credentials and optionally one per grouped role scope. The encrypted content contains provider credentials that only members with the appropriate secret can decrypt.

DEN Chat supports two SFU providers:

| Provider | Description | Setup |
|----------|-------------|-------|
| `cloudflare` | Cloudflare Realtime SFU (managed, 1 TB/mo free) | User pastes App ID + API Token from Cloudflare dashboard |
| `livekit` | LiveKit OSS (self-hosted, unlimited) | User provides server URL + API Key + API Secret |

```json
{
  "kind": 36946,
  "pubkey": "<host_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["d", "<hub_d_tag>"],
    ["status", "available"],
    ["provider", "cloudflare"],
    ["epoch", "<epoch_number>"],
    ["group", "<group_id>"]  
  ],
  "content": "<encrypted with group secret or hub secret>",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `d` | Yes | Hub `d` tag for hub-wide scope, or `<hub_d_tag>:<group_id>` for group-scoped. This ensures each scope is a separate addressable replaceable event per user. |
| `status` | Yes | `"available"` or `"paused"`. When paused, clients MUST NOT use this host's SFU for new sessions. |
| `provider` | Yes | `"cloudflare"` or `"livekit"`. Tells the client which provider adapter to use. |
| `epoch` | Yes | Epoch number of the secret used to encrypt the content. For hub-wide scope, this is the hub epoch. For group scope, this is the group epoch. When the epoch changes (secret rotation), hosts SHOULD re-publish with the new epoch. |
| `group` | No | Group ID from `grouped_roles[]`. If present, credentials are encrypted with the **group secret** instead of the hub secret. Only members of the group can decrypt. If absent, the event is hub-wide. |

**Encrypted content** (decrypted with a key derived from the appropriate secret via `HKDF(secret, domain_salt, "voice-host:epoch:<epoch_number>")` — where `secret` is the hub secret for hub-wide events, or the group secret for group-scoped events):

```json
// Cloudflare Realtime:
{
  "provider": "cloudflare",
  "cfAppId": "<cloudflare_app_id>",
  "cfApiToken": "<cloudflare_api_token>"
}

// LiveKit (self-hosted):
{
  "provider": "livekit",
  "lkUrl": "wss://lk.example.com",
  "lkApiKey": "<livekit_api_key>",
  "lkApiSecret": "<livekit_api_secret>"
}
```

#### Publishing Rules

- Published to the **same relays as messages** (the hub's general relays)
- **Hub-wide events**: credentials are encrypted with the hub secret — all hub members can decrypt
- **Group-scoped events**: credentials are encrypted with the group secret — only members of the grouped role can decrypt
- The host controls their own SFU availability via the `status` tag
- A host SHOULD only publish group-scoped credentials for groups they belong to, to prevent a leak where the host knows the raw credentials without holding the group secret

#### Subscription

To fetch all voice hosts for a hub:

```json
{"kinds": [36946], "#d": ["<hub_d_tag>"]}
```

#### Host Pool Resolution

When a user joins a voice channel, the client:

1. Fetches all kind `36946` events for the hub
2. Filters by `status: available`
3. Checks voice presence events (kind `36947`) to see if a session already exists for this channel
4. If an active session exists → joins it on the existing host's SFU
5. If no active session → picks an available host (prefer hub creator's, then random), creates a new SFU session
6. Publishes a kind `36947` presence heartbeat

#### Access Control Model

Voice access is gated by hub encryption — only members who can decrypt the hub secret can access SFU credentials. No additional authentication layer is applied. If a host suspects abuse (excessive bandwidth consumption), they can set their `status` to `"paused"` at any time.

#### IP Privacy

All WebRTC connections MUST use `iceTransportPolicy: 'relay'` to force TURN relay mode. This prevents participant IP addresses from leaking via WebRTC ICE candidates. Both Cloudflare Realtime and LiveKit provide built-in TURN relay functionality.

---

### 6.8 Voice Presence Heartbeat — Kind `36947`

**Type**: Addressable Replaceable Event

Published by a participant while they are in a voice channel. Updated every **30 seconds** as a heartbeat. Clients check the `created_at` timestamp — if older than **60 seconds**, the participant is considered offline (handles ungraceful disconnects).

Each user has **one presence event per hub**.

```json
{
  "kind": 36947,
  "pubkey": "<participant_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["d", "<hub_d_tag>"],
    ["c", "<channel_id>"],
    ["status", "joined"],
    ["host", "<host_pubkey>"],
    ["session", "<session_id>"],
    ["pos", "0", "0"],
    ["sphere", "50"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `d` | Yes | Hub `d` tag. One presence event per user per hub. |
| `c` | Yes | Channel UUID of the voice channel the user is currently in. |
| `status` | Yes | `"joined"` or `"left"`. On leaving a voice channel, publish with `"left"` so clients can immediately update. |
| `host` | Yes | Pubkey of the SFU host whose infrastructure is being used for this session. |
| `session` | Yes | Provider-specific session identifier (e.g., Cloudflare session ID, LiveKit room name). |
| `pos` | No | Spatial audio position: `["pos", "<x>", "<y>"]`. Coordinates in a 2D space. Defaults to `"0", "0"` (center) on join. |
| `sphere` | No | Voice sphere radius for spatial audio: `["sphere", "<radius>"]`. Controls how far the user's voice carries. Default: `"50"`. |

#### Heartbeat Mechanism

```
While in voice channel:
  Every 30 seconds → re-publish kind 36947 with updated created_at

Other clients watching the hub:
  If (now - event.created_at) > 60 seconds → consider user offline
  If status == "left" → immediately remove from voice UI
```

**Why addressable replaceable (not ephemeral):**
- A new client opening a hub can immediately fetch who's in voice via a REQ filter
- One event per user per hub — no event pile-up on relays
- Timestamp-based freshness check handles ungraceful disconnects
- Relays naturally replace old heartbeats (same `kind + pubkey + d-tag`)

#### Subscription

To fetch all voice presence for a hub:

```json
{"kinds": [36947], "#d": ["<hub_d_tag>"]}
```

Clients filter by channel ID locally from the `c` tag.

#### Spatial Audio

Spatial audio is processed entirely client-side using the Web Audio API (`PannerNode` + `GainNode`). The SFU delivers raw audio streams; spatial positioning is applied locally based on the `pos` and `sphere` tags from other participants' presence events.

- `pos` tags are updated on drag (throttled to ~5 Hz to avoid relay spam)
- Volume attenuation is calculated as: distance between participants vs. listener's sphere radius
- All participants spawn at position `(0, 0)` on join (reset on rejoin)

#### Presence in Two Contexts

| Context | Source of Truth | Reason |
|---------|----------------|--------|
| **User is IN the voice channel** | SFU connection state (WebRTC) | Provider fires `onParticipantLeft` immediately on disconnect — 100% accurate |
| **User is NOT in the channel** (sidebar) | Kind `36947` heartbeat events | Only way to know who's in channels you're not connected to; 60s timeout handles ghosts |

---

### 6.9 Polls — Kind `1067` & Kind `1017`

NIP-CHAT supports polls using adapted NIP-88-style event kinds (`1067` for polls, `1017` for votes) for encrypted hubs. All poll content and vote selections are placed in the encrypted `content` field rather than in plaintext tags.

#### 6.9.1 Poll Event — Kind `1067`

**Type**: Regular Event

```json
{
  "kind": 1067,
  "pubkey": "<creator_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["h", "<hub_d_tag>"],
    ["c", "<channel_id>"],
    ["epoch", "<epoch_number>"],
    ["nonce", "<random>", "<difficulty_bits>"]
  ],
  "content": "<AES-256-GCM encrypted poll JSON>",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `h` | Yes | Hub `d` tag identifier |
| `c` | Yes | Channel UUID where the poll appears |
| `epoch` | Yes | Epoch number of the secret used for encryption |
| `nonce` | Conditional | PoW nonce (NIP-13). Required if hub has a `w` tag with difficulty > 0. |
| `facilitator` | No | Hex pubkey of the member who facilitated this non-member's access (see §5.6). |

The `content` field is encrypted identically to messages (§6.2): base64-encoded `12-byte-IV || ciphertext || 16-byte-auth-tag`, using the channel message key derived from the hub secret (or group secret for private channels).

##### Encrypted Content (JSON)

```json
{
  "text": "What should we play tonight?",
  "options": [
    { "id": "opt1", "label": "Minecraft" },
    { "id": "opt2", "label": "Valorant" },
    { "id": "opt3", "label": "Just chatting" }
  ],
  "polltype": "singlechoice",
  "endsAt": 1720000000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | The poll question/label |
| `options` | array | Yes | Poll options. Each has `id` (alphanumeric) and `label` (display text). |
| `polltype` | string | No | `"singlechoice"` (default) or `"multiplechoice"` |
| `endsAt` | integer | No | Unix timestamp when the poll closes. If absent, the poll has no expiry. |

##### Publishing Rules

Same as messages (§6.2): publish to the hub's general relays.

#### 6.9.2 Vote Event — Kind `1017`

**Type**: Regular Event

```json
{
  "kind": 1017,
  "pubkey": "<voter_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["e", "<poll_event_id>"],
    ["h", "<hub_d_tag>"],
    ["c", "<channel_id>"],
    ["epoch", "<epoch_number>"]
  ],
  "content": "<AES-256-GCM encrypted vote JSON>",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `e` | Yes | Event ID of the poll being voted on |
| `h` | Yes | Hub `d` tag identifier |
| `c` | Yes | Channel UUID (same as the poll's channel) |
| `epoch` | Yes | Epoch number of the secret used for encryption |

##### Encrypted Content (JSON)

```json
{
  "response": ["opt2"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `response` | string[] | Array of selected option IDs. For `singlechoice` polls, only the first entry is considered. |

##### Counting Results

Clients fetch votes by querying: `{kinds: [1017], #e: [<poll_event_id>]}` from the hub's relays.

- **One vote per pubkey**: If a pubkey has multiple vote events for the same poll, the event with the latest `created_at` is used.
- **Expired polls**: Votes with `created_at` after the poll's `endsAt` timestamp SHOULD be ignored.
- **Singlechoice**: Only the first `response` entry is counted.
- **Multiplechoice**: All unique `response` entries are counted (one vote per option per pubkey).

##### Privacy Notes

- The `e` tag reveals **which poll** a user voted on (necessary for relay indexing), but the vote selection is encrypted in `content` — only hub members can see what option was chosen.
- This is comparable to Discord polls where the server knows who voted, but here the relay cannot see the choice.

---

### 6.10 Hub Report — Kind `36948`

**Type**: Addressable Replaceable Event

Published by a member to report another user within a hub. Reports are private — encrypted with the hub secret — and visible only to hub members. Because they are addressable replaceable events, a reporter can retract a report by re-publishing with the same `d` tag and status set to `"retracted"`.

> **v2 (private hubs).** A report is a **member content event** and follows the same rules as a channel message (§4.5, §4.6): it is authored under the reporter's **member pseudonym `P`** — never their real key `R` — and carries an **`identity` tag** (`R`'s attestation, encrypted with the `reports_key`) so a moderator holding that key can still resolve the reporter's real identity, while the relay and non-mods cannot. The **`p` tag names the reported user by *their* pseudonym `P`** too (resolved from the roster; a profile-originated report whose target is only known by `R` is mapped to that member's `P` before publishing). Consequently, a client enumerating **its own** reports (for the "my reports" view and retraction) MUST query by the reporter's `P`, not `R`. Retractions re-publish under the same `P` and `d` tag. A facilitated (`Pf`) reporter authors under `Pf` by the same mechanism. In **v1** the reporter authors under `R` and tags the reported `R` directly, as shown below.

```json
{
  "kind": 36948,
  "pubkey": "<reporter_pubkey — R in v1, member P (or facilitated Pf) in v2>",
  "created_at": "<timestamp>",
  "tags": [
    ["d", "<random_uuid_v4>"],
    ["a", "36942:<hub_creator_pubkey>:<hub_d_tag>"],
    ["p", "<reported_user_pubkey>"],
    ["report", "36943:<msg_author_pubkey>:<msg_d_tag>"],
    ["y", "<report_type>"],
    ["s", "open"],
    ["epoch", "<epoch_number>"],
    ["nonce", "<random>", "<difficulty_bits>"]
  ],
  "content": "<AES-256-GCM encrypted report JSON>",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `d` | Yes | Unique UUID v4 identifier for this report. Enables addressable replacement (retraction). |
| `a` | Yes | Hub scope: `"36942:<creator_pubkey>:<hub_d_tag>"`. Ties the report to a specific hub. |
| `p` | Yes | Pubkey of the **reported user** (the violator). v1: their real key `R`. **v2: their member pseudonym `P`** (resolved from the roster before publishing). |
| `identity` | v2 only | The reporter's `R` identity attestation, encrypted with the `reports_key` (§4.6). Lets a mod resolve the real reporter while keeping `R` off the wire. Absent in v1. |
| `report` | No | Addressable reference to the reported message: `"36943:<author>:<d_tag>"`. Present when reporting a specific message; absent for general user reports. |
| `y` | Yes | Report type/classification. Predefined values: `"spam"`, `"nudity"`, `"profanity"`, `"illegal"`, `"malware"`, `"impersonation"`, `"other"` (NIP-56 vocabulary). Custom freeform strings are also valid — clients SHOULD present predefined types as suggestions and allow custom input. |
| `s` | Yes | Report status: `"open"` (active) or `"retracted"` (withdrawn by reporter). |
| `epoch` | Yes | Epoch number of the hub secret used for encryption. |
| `nonce` | Conditional | PoW nonce (NIP-13). Required if hub has a `w` tag with difficulty > 0. |

#### Encrypted Content (JSON)

```json
{
  "text": "This user is posting spam links repeatedly"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | No | Free-text explanation of the report reason. May be empty. |

#### Encryption

Report content is encrypted using AES-256-GCM with a key derived via HKDF:

```
reports_key = HKDF-SHA256(
    input_key_material = hub_secret,
    salt               = domain_salt,
    info               = "reports:<hub_d_tag>:epoch:<epoch_number>",
    output_length      = 32 bytes
)
```

This uses a separate `"reports"` domain to isolate report encryption keys from channel message keys and calendar event keys.

#### Publishing Rules

- Published to the **same relays as messages** (the hub's general relays)
- Reports are encrypted with the hub secret — only hub members can decrypt
- PoW requirements follow the hub's `w` tag setting (same as messages)

#### Subscription

To fetch all reports for a hub (moderator view):

```json
{"kinds": [36948], "#a": ["36942:<creator_pubkey>:<hub_d_tag>"]}
```

To fetch a user's own reports:

```json
{"kinds": [36948], "authors": ["<my_pubkey>"], "#a": ["36942:<creator_pubkey>:<hub_d_tag>"]}
```

#### Retraction

To retract a report, the reporter re-publishes the event with:
- The **same `d` tag** (relay replaces the original)
- `["s", "retracted"]` instead of `["s", "open"]`
- Optionally updated encrypted content

#### Client Behavior

**Submission entry points:**
1. **Message dropdown** → "Report User" option. Pre-fills the `report` tag with the message's addressable reference and includes a message preview.
2. **User profile modal** → "Report User" option (only visible in hub context). No `report` tag — this is a general user report.

**Moderator view:**
- Reports are displayed in the Hub Settings modal under a "Reports" tab (creator/mod only)
- Filters: date range (defaults to past 48 hours), latest/oldest sort, reporter search, violator search, status filter

**User view:**
- Users can view and manage their own reports in the User Hub Settings modal under a "My Reports" tab
- Each open report shows a "Retract" button that re-publishes with status `"retracted"`

---

### 6.11 Calendar Time Event — Kind `31923`

**Type**: Addressable Replaceable Event

Published by a hub member to create a calendar event within a hub. Follows the [NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md) structure (same kind number, addressable replaceable, d-tag, RSVP via kind 31925) but with **all tag values and content AES-encrypted** using the hub secret. This keeps event details (title, time, location, description) private to hub members.

> **v2 (private hubs).** Calendar events and RSVPs (§6.12) are **member content events**: on a v2 hub the `pubkey` is the author's **member pseudonym `P`** (or facilitated `Pf`) — never `R` — and the event carries an **`identity` tag** (`R`'s attestation, encrypted with the `events_key`), exactly like a channel message (§4.5, §4.6). Because the owner `O` can derive any member's `P`, a roster lookup alone (`P → R`) is **not** sufficient to attribute an event — a client MUST **verify the `identity` tag** (which `R` alone can produce) before showing an author or granting own-event controls, falling back to the roster only when the tag is absent/unverifiable (e.g. a historical epoch). The event's coordinate `31923:<P>:<d>` and the RSVP's `a`-tag reference the event by `P`.

```json
{
  "kind": 31923,
  "pubkey": "<creator_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["d", "<random_uuid_v4>"],
    ["h", "<hub_d_tag>"],
    ["epoch", "<epoch_number>"],
    ["title", "<AES-encrypted title>"],
    ["start", "<AES-encrypted unix_timestamp>"],
    ["end", "<AES-encrypted unix_timestamp>"],
    ["summary", "<AES-encrypted one-line summary>"],
    ["image", "<AES-encrypted image_url>"],
    ["location", "<AES-encrypted location_string>"],
    ["g", "<AES-encrypted geohash>"],
    ["D", "<AES-encrypted day_number>"],
    ["facilitator", "<facilitator_pubkey>"],
    ["nonce", "<random>", "<difficulty_bits>"],
    ["client", "DEN Chat"]
  ],
  "content": "<AES-256-GCM encrypted description>",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `d` | Yes | Unique UUID v4 identifier. Enables addressable replacement (edits). Same `d` tag re-publishes replace the event. |
| `h` | Yes | Hub d tag — ties this event to a specific hub. |
| `epoch` | Yes | Epoch number of the hub secret used for encryption. |
| `title` | Yes | AES-encrypted event title string. |
| `start` | Yes | AES-encrypted unix timestamp (seconds) as a string. Stored in UTC. |
| `end` | No | AES-encrypted unix timestamp (seconds) as a string. Omitted for events with no defined end time. |
| `summary` | No | AES-encrypted short one-line summary. If absent, clients use the beginning of the description. |
| `image` | No | AES-encrypted URL of the event's image (uploaded via Blossom or external). |
| `location` | No | AES-encrypted location string (address, URL, or room name). Multiple `location` tags allowed. |
| `g` | No | AES-encrypted geohash. |
| `D` | No | AES-encrypted day-granularity tags for date-range indexing. One `D` tag per day the event spans. The value is `floor(unix_timestamp / 86400)` as a string. |
| `facilitator` | No | Pubkey of the facilitator who provided access for a non-member. |
| `nonce` | Conditional | PoW nonce (NIP-13). Required if hub has a `w` tag with difficulty > 0. |
| `client` | No | Client identifier tag. Optional per user preference. |

#### Encrypted Content

The `content` field contains the event's full description, AES-256-GCM encrypted with the events key. May be empty if no description is provided.

#### Encryption

All encrypted tag values and content use AES-256-GCM with a key derived via HKDF in the `"events"` domain:

```
events_key = HKDF-SHA256(
    input_key_material = hub_secret,
    salt               = domain_salt,
    info               = "events:<hub_d_tag>:epoch:<epoch_number>",
    output_length      = 32 bytes
)
```

This uses a separate `"events"` domain from channel message keys (`"channel:..."`) and report keys (`"reports:..."`), ensuring domain isolation.

#### Differences from Standard NIP-52

| Aspect | Standard NIP-52 | NIP-CHAT Calendar |
|--------|----------------|-------------------|
| Tag values | Plaintext | AES-encrypted |
| Content | Plaintext description | AES-encrypted description |
| Routing | None (public) | `h` (hub) + `epoch` tags |
| Visibility | Public | Hub members only |
| `D` tag | Not defined | Day-granularity indexing (encrypted) |
| Key derivation | N/A | HKDF `"events"` domain |

#### Publishing Rules

- Published to the hub's **general relays**
- PoW requirements follow the hub's `w` tag setting (same as messages)
- Editing: re-publish with the **same `d` tag** — relays replace the previous version

#### Deletion

Two-step deletion for maximum coverage:

1. **Addressable replaceable overwrite** (primary): Re-publish with the same `d` tag, adding `["deleted", "true"]` and empty content. Relays replace the original.
2. **NIP-09 deletion request** (fallback): Publish a kind 5 event with an `a` tag referencing `"31923:<pubkey>:<d_tag>"`.

#### Subscription

To fetch all calendar events for a hub:

```json
{"kinds": [31923], "#h": ["<hub_d_tag>"]}
```

#### Live Event Detection

A calendar event is considered **live** if:
- `start ≤ now ≤ end` (when end time is defined), or
- `start ≤ now ≤ start + 3600` (when no end time — defaults to 1 hour)

Clients should re-evaluate live status periodically (e.g., every 30 seconds) to update UI indicators.

#### Client Behavior

- Times are entered in the user's local timezone and converted to UTC unix timestamps for storage
- Times are displayed in each viewer's local timezone
- Start date/time is mandatory; end date/time is optional
- Image upload uses the hub's Blossom servers; URL paste is also supported
- Validation: start cannot be in the past, end cannot be before start

---

### 6.12 Calendar RSVP — Kind `31925`

**Type**: Addressable Replaceable Event

Published by a hub member to RSVP to a calendar event. Follows [NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md) RSVP structure (kind 31925, `a` tag reference to the event) with encrypted status and note.

```json
{
  "kind": 31925,
  "pubkey": "<responder_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["d", "<random_uuid_v4>"],
    ["a", "31923:<event_author_pubkey>:<event_d_tag>"],
    ["h", "<hub_d_tag>"],
    ["epoch", "<epoch_number>"],
    ["status", "<AES-encrypted status>"],
    ["nonce", "<random>", "<difficulty_bits>"]
  ],
  "content": "<AES-256-GCM encrypted note>",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `d` | Yes | Unique UUID v4 identifier. Reuse the same `d` tag to update an existing RSVP. |
| `a` | Yes | Addressable reference to the calendar event: `"31923:<pubkey>:<d_tag>"`. |
| `h` | Yes | Hub d tag. |
| `epoch` | Yes | Epoch number of the hub secret used for encryption. |
| `status` | Yes | AES-encrypted RSVP status. Plaintext value is one of: `"accepted"`, `"declined"`, `"tentative"`. |
| `nonce` | Conditional | PoW nonce (NIP-13). Required if hub has a `w` tag with difficulty > 0. |

#### Encrypted Content

The `content` field contains an optional RSVP note (free-text), AES-256-GCM encrypted with the events key. May be empty.

#### Encryption

Uses the same `"events"` domain key as calendar events (§6.11).

#### One RSVP per User per Event

RSVPs are addressable replaceable events. A user updates their RSVP by re-publishing with the **same `d` tag**. The store deduplicates by pubkey per event reference, keeping only the latest `created_at`.

#### Deletion

Same two-step deletion as calendar events (§6.11): addressable replaceable overwrite with `["deleted", "true"]`, plus NIP-09 deletion request as fallback.

#### Subscription

To fetch all RSVPs for a calendar event:

```json
{"kinds": [31925], "#a": ["31923:<event_author_pubkey>:<event_d_tag>"]}
```

RSVPs are fetched **on-demand** when a user opens the event detail view, not eagerly with the event list.

---

### 6.13 Message Edit Hint — Kind `26943`

**Type**: Ephemeral Event (kind range 20000–29999 — relays forward to connected subscribers but do NOT persist)

#### Problem

Edited messages use the `created_at` increment rule (§6.2, Editing Messages) to avoid disrupting `limit`-based relay fetches. However, this means the edited event's `created_at` remains close to the original timestamp — far in the past relative to other clients' real-time subscriptions (`since: <current_time>`). As a result, **relays do not push edited messages to real-time subscribers**, and other clients only see edits after a full refresh.

#### Solution

After successfully publishing an edited message, the client SHOULD publish an ephemeral **Message Edit Hint** event. This lightweight signal tells other connected clients that a specific message has been updated, prompting them to re-fetch the latest version.

```json
{
  "kind": 26943,
  "pubkey": "<sender_pubkey>",
  "created_at": "<current_wall_clock_timestamp>",
  "tags": [
    ["h", "<hub_d_tag>"],
    ["d", "<edited_message_d_tag>"],
    ["c", "<channel_id>"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `h` | Yes | Hub `d` tag. Ensures the hint reaches clients subscribed to this hub's events. |
| `d` | Yes | The `d` tag of the edited message. Identifies which addressable event was updated. |
| `c` | No | Channel UUID. MAY be included to help receivers locate the message in their local store without scanning all channels. |

The message author is identified by `event.pubkey` — since only the author can edit their own message, the hint sender IS the message author. No separate `p` tag is needed.

#### Key Design Points

- **`created_at` = current wall-clock time** — unlike the edit itself (which uses `original + 1`), the hint uses `now` so it passes through real-time subscription `since` filters.
- **`content` is empty** — the hint carries no sensitive data. It is purely a signal, not a content event. No encryption is needed.
- **Ephemeral** — relays MUST NOT persist this event. It is only useful to clients connected at the moment of publication. Clients that are offline will pick up the edit on their next initial fetch (which has no `since` filter).
- **Fire after successful publish** — the hint SHOULD only be published after the edited message has been accepted by at least one relay, to avoid sending hints for edits that failed to publish.

#### Client Behavior (Receiver)

When a client receives a kind `26943` event via its real-time subscription:

1. **Verify the sender is a hub member.** If the hint's `pubkey` is not in the hub's member list, ignore it.
2. Extract `d` (message d-tag) from the tags. Use `event.pubkey` as the author.
3. Fetch the latest version of the addressable event from the hub's relays:
   ```json
   {"kinds": [36943], "authors": ["<event.pubkey>"], "#d": ["<d_value>"]}
   ```
4. If a newer version is returned (higher `created_at` than the locally stored version), update the local store and re-decrypt.
5. If no newer version is found (relay hasn't propagated yet), the client MAY retry once after a short delay (e.g., 1–2 seconds).
6. Clients MAY debounce re-fetches per message d-tag (e.g., at most once per 10 seconds) to limit redundant queries from rapid successive hints.

#### Subscription

Clients SHOULD include kind `26943` in their existing real-time hub subscription filter:

```json
{
  "kinds": [36943, 26943, ...],
  "#h": ["<hub_d_tag_1>", "<hub_d_tag_2>"],
  "since": "<current_timestamp>"
}
```

Since this kind is in the ephemeral range, relays that support ephemeral events will forward it to matching subscribers without storing it. Relays that do not support ephemeral events will simply ignore it — the behavior degrades gracefully to the current refresh-to-see-edits model.

#### PoW

Edit hints SHOULD meet the same Proof of Work difficulty as the hub requires for messages (the `w` tag on the hub event). Although hints carry no content, they trigger re-fetch queries on every connected client — a single hint to a hub with N subscribers causes N relay queries. Without PoW, an attacker could exploit this amplification to generate excessive relay load at near-zero cost. Requiring PoW makes such spam computationally expensive.

---

### 6.14 Typing Indicator — Kind `26950`

**Type**: Ephemeral Event (kind range 20000–29999 — relays forward to connected subscribers but do NOT persist)

#### Purpose

Provides a real-time "user is typing…" presence signal for hub channels and NIP-04 (kind `4`) direct messages, mirroring the familiar typing indicator of centralized chat apps. Because no central server tracks session state, each client broadcasts its own ephemeral typing signal, and receivers maintain a short-lived **local** timeout to decide who is currently typing.

Typing indicators are a **separate kind** from the Message Edit Hint (`26943`) despite both being message-flow ephemeral signals. Typing is a high-frequency heartbeat (republished every few seconds while a user types), whereas edit hints are rare one-shots. A dedicated kind keeps the always-on edit-hint subscription free of typing traffic, permits relay-level filtering, and lets clients that disable the feature avoid the traffic entirely by simply not subscribing.

Typing indicators are scoped to **hub channels and NIP-04 DMs only** — they are NOT used for NIP-17 DMs (gift-wrapping every heartbeat is prohibitively expensive) nor for public chat.

#### Event Structure

**Hub channel:**

```json
{
  "kind": 26950,
  "pubkey": "<typer_pubkey>",
  "created_at": "<current_wall_clock_timestamp>",
  "tags": [
    ["h", "<hub_d_tag>"],
    ["c", "<channel_id>"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

**NIP-04 direct message:**

```json
{
  "kind": 26950,
  "pubkey": "<typer_pubkey>",
  "created_at": "<current_wall_clock_timestamp>",
  "tags": [
    ["p", "<recipient_pubkey>"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `h` | Hub only | Hub `d` tag. Scopes the signal to a hub for relay routing and subscriber filtering. |
| `c` | Hub only | Channel UUID. Identifies which channel the user is typing in. |
| `p` | DM only | Recipient pubkey. Ensures the signal reaches the recipient's inbox subscription. |
| `typing` | No | Optional state marker. `["typing", "stop"]` tells receivers to clear the indicator immediately instead of waiting for the timeout. Its absence means actively typing. |

The typer is identified by `event.pubkey`. The sender pubkey plus the `p` tag (DM) or `h`+`c` tags (hub) fully identify the conversation; no further routing data is required.

#### Key Design Points

- **`created_at` = current wall-clock time** — so the event passes real-time subscription `since` filters.
- **`content` is empty** — the signal carries no data and is never encrypted. It is pure presence.
- **Receiver-clock timeout (not the sender's clock).** Receivers MUST decide "still typing?" using their **own local receipt time**, not the event's `created_at`. This avoids clock-skew artifacts (a sender with a skewed clock producing a stuck-on or never-shown indicator). The `created_at` is used only to satisfy relay `since` filters and to discard obviously-stale events.
- **Heartbeat cadence.** While a user is actively typing, the client SHOULD republish the signal on a fixed interval (RECOMMENDED ~3 seconds). It MUST NOT publish per keystroke.
- **Display timeout.** A receiver SHOULD show a user as typing until it has received no heartbeat from them for a short window (RECOMMENDED ~7 seconds — roughly twice the heartbeat interval plus margin, so a single dropped event does not flicker the indicator off).
- **Immediate clear.** A receiver MUST clear a user's typing state upon (a) receiving that user's actual message in the conversation, or (b) receiving a `["typing", "stop"]` signal from them.
- **Self-exclusion.** Clients MUST NOT display their own typing signal.

#### Client Behavior

**Sender:**

1. On the first change in an empty composer (or the first change after the last heartbeat lapsed), publish a typing signal immediately.
2. While the composer remains non-empty and the user keeps editing, republish every ~3 seconds.
3. Stop publishing when the composer becomes empty, loses focus, goes idle, or the message is sent. Clients MAY publish a single `["typing", "stop"]` signal at this point for instant clearing on receivers; otherwise the receiver timeout handles it.

**Receiver:**

1. **Verify the sender is authorized.** For hubs, ignore signals whose `pubkey` is not in the hub's member list. For DMs, apply the client's normal DM-accept policy.
2. Record `last_seen[conversation][pubkey] = local_now` on each received signal (a `stop` signal clears the entry instead).
3. Render the set of pubkeys whose `last_seen` is within the display timeout, excluding self, aggregated as "X is typing…", "X and Y are typing…", "X, Y, and N more are typing…".
4. Expire entries past the display timeout, and clear an entry the moment that user's message arrives.

#### Subscription

Typing is subscribed on its **own filter**, scoped to the conversation currently in view, and only while the feature is enabled:

```json
// Hub — the open channel's hub
{ "kinds": [26950], "#h": ["<hub_d_tag>"], "since": "<current_timestamp>" }
// DM04 — the local user's inbox
{ "kinds": [26950], "#p": ["<my_pubkey>"], "since": "<current_timestamp>" }
```

Because the kind is ephemeral, supporting relays forward matching events without storing them; non-supporting relays ignore them and the feature degrades to simply not showing typing indicators.

#### User Setting

Clients SHOULD expose a user setting (RECOMMENDED default: on) to disable typing indicators. When disabled, the client MUST NOT publish typing signals **and** SHOULD NOT open the typing subscription, so that turning the feature off eliminates both outbound and inbound typing traffic.

#### Privacy

A typing signal reveals that a pubkey is actively composing in a given hub/channel (or to a given DM recipient) at a given time — the same metadata surface already exposed by the Message Edit Hint (`26943`) and by NIP-04 message metadata, respectively. No message content is exposed. Privacy-sensitive users can suppress the signal entirely via the user setting above.

#### Abuse & Rate Limiting

Unlike the Message Edit Hint, a typing signal triggers **no downstream relay queries** on receivers — it only updates local presence state — so the query-amplification rationale for requiring Proof of Work does not apply. Because the signal is a frequent heartbeat, requiring meaningful per-heartbeat PoW would impose a continuous computational and battery cost on the sender for little benefit. Therefore:

- Typing signals do NOT require PoW.
- The sender's fixed heartbeat interval (~3 seconds) is the primary rate control; clients MUST throttle accordingly.
- Relays MAY rate-limit ephemeral events per connection at their discretion.

---

## 7. Member List Mechanics

> [!IMPORTANT]
> **v2 roster (see §0.2, §5.2.1).** In a v2 hub the tree stores pseudonyms `P`. To show the
> **real user** in the member sidebar, the client decrypts the page's **group-encrypted roster
> segment** — one `AES-GCM(HKDF(hub_secret_epoch, "roster:epoch:<epoch>"), {P:R})` blob per page (a
> single op for the whole page, not per-leaf), free with the plaintext page it already fetched and
> present even for **silent members** who never posted — to recover the `{P → R}` map, then fetches
> `R`'s kind:0 profile. Ban subtraction is performed on `R`. This is preferred over reading `P`'s
> kind:0 (which would be a double kind:0 fetch).
>
> **Render cost — window the viewport and cache the verification.** The per-member Schnorr
> verify of `sig_R` is the new cost and it scales with rendered-roster size. Two things keep
> it cheap: (a) render **viewport-windowed** — only decrypt/verify/fetch the members actually
> on screen (plus a small buffer), never the whole page at once; and (b) **cache the
> verification result**, not merely the `P→R` map — verify each `sig_R` **once ever** and
> remember the verdict, so scrolling or re-opening the roster never re-verifies. With both,
> v2 roster render stays close to v1's cost in practice.

### 7.1 Resolution Order

A client constructs its effective member list by:

1. **Creator's Blossom member file** — always fetched, always trusted. Canonical source.
2. **Creator's Blossom ban list** — subtracted. Supersedes member list even with `w` flag (same author).
3. **Mod ban lists** — subtracted, except for `w`-flagged members.
4. **Manually followed member files** — user opts in via client UI.
5. **Facilitated messages** — verified per-message via the `facilitator` tag (see §5.6). No list merge needed.

```
effective = (creator_members − creator_bans)
          − (mod_bans − whitelisted)
          ∪ manually_followed
```

### 7.2 Whitelisting (`w` flag)

The creator can protect specific members from mod bans by adding a `w` column to their row in the member file.

- `w` protects ONLY against bans from **other authors** (mods)
- `w` does NOT protect against bans from the **same author** (the creator themselves)
- If the creator wants to ban a whitelisted member, they add them to their own ban list — this supersedes the `w` flag

### 7.3 Visual Differentiation

| Source | Display |
|--------|---------|
| On creator's list | Full member — normal display, role badge, full color |
| Facilitated (verified `facilitator` tag) | Recognized — slightly muted, facilitated-by indicator |
| On manually followed list only | Known — more muted, small indicator |
| On no followed list | Unknown — greyed out, collapsed, or hidden behind "show unverified" toggle |

---

## 8. Permissions

Permissions are **client-side rendering decisions**. The protocol does not enforce them — any user can publish any event. Clients decide what to render.

### 8.1 Permission Flags

| Permission | Type | Description |
|-----------|------|-------------|
| `view_channel` | boolean | Whether the role can see the channel in the UI |
| `send_messages` | boolean | Whether the role's messages are rendered |
| `add_reactions` | boolean | Whether reactions from this role are rendered |
| `create_invite` | boolean | Whether the user can copy and share the hub address |
| `ban_members` | boolean | Whether the user can add members to ban lists |
| `hide_messages` | boolean | Whether the user can hide specific messages |
| `embed_links` | boolean | Whether links auto-unfurl |
| `attach_files` | boolean | Whether file attachments are rendered |
| `mention_everyone` | boolean | Whether @everyone pings are processed |
| `mention_here` | boolean | Whether @here pings are processed |
| `create_polls` | boolean | Whether the role can create polls (kind `1067`) in channels |
| `connect_voice` | boolean | Whether the user can join voice channels |
| `speak` | boolean | Whether the user can unmute and transmit audio in voice channels |
| `stream_video` | boolean | Whether the user can enable camera or screen share in voice channels |

### 8.2 Permission Resolution

1. Start with the user's role permissions from `roles[]`. If a user has multiple roles, use **most permissive wins** — if any of the user's roles grant a permission, it is granted.
2. Apply category-level overrides from `categories[].permissions`.
3. If `synced: false`, apply channel-level overrides from `channels[].permissions`.
4. More specific overrides win.
5. The hub creator always has all permissions, regardless of role assignments.

**Client-side enforcement:** Compliant clients SHOULD suppress messages from users whose effective `send_messages` permission is `false` for the channel, even if those messages are published via a non-compliant client. This prevents role bypass via modified clients.

### 8.3 Important: Permissions Are Not Security

Permissions determine what a compliant client renders. A malicious client can ignore them. For actual access control, use encryption (hub secret / group secrets); membership and spam enforcement are client-side (the identity drop rule + message/join PoW, §9.9).

---

## 9. Client Behavior

### 9.1 Joining a Hub

1. User discovers a hub via its `naddr` (link, search, or browse).
2. Client fetches the hub event (kind `36942`) from general relays.
3. Client displays hub info (name, description, public metadata).
4. User clicks "Join."
5. Client publishes a Join Request (kind `36944`) to general relays.
6. Client downloads the creator's index file from Blossom (hash-verified via `m` tag).
7. If user is already in the member file → decrypt hub secret → full access.
8. If not → display "Pending" state until creator/mod adds them.
9. Once added → client updates its User Hub List (kind `16942`).

### 9.2 Subscribing to Messages

**Single channel:**
```json
{"kinds": [36943], "#h": ["<hub_d_tag>"], "#c": ["<channel_id>"]}
```

**Multiple hubs (same relay):**
```json
{"kinds": [36943], "#h": ["<hub1_d_tag>", "<hub2_d_tag>"]}
```

**Lazy loading:**
- Active subscription only for the currently viewed hub/channel.
- Background-poll other hubs periodically for unread counts.
- SHOULD NOT maintain 100+ active subscriptions simultaneously.

### 9.3 Decrypting Messages

1. Read the message's `epoch` tag.
2. Look up the corresponding secret in local cache (or download from history file).
3. Derive the channel key: `HKDF(secret, "channel:<channel_id>:epoch:<epoch>")`.
4. Decrypt `content` with AES-256-GCM.

### 9.4 Handling Secret Rotation

Clients MUST maintain a subscription to the hub event (kind `36942`, filter: `{"kinds": [36942], "#d": ["<hub_d_tag>"]}`) for each hub in their User Hub List. Since the hub event is an addressable replaceable event, any update pushes to subscribers automatically.

When the hub event updates:
1. Client checks if the `epoch` value in the `m` tag has changed.
2. If unchanged → no action needed.
3. If changed → download updated index file from Blossom.
4. Compare tree file hash with locally cached version. Download if changed.
5. Walk the LKH tree from own leaf to root: NIP-04 decrypt leaf key → AES-decrypt up the path → AES-decrypt new hub secret from root.
6. Download updated history file, decrypt all historical secrets.
7. Store all secrets locally keyed by epoch number.

### 9.5 New Member — History Access

1. New member is added as a leaf to the creator's LKH tree.
2. Member downloads tree file, walks from their leaf to root to decrypt current hub secret.
3. Member downloads history file.
4. Member decrypts all historical epoch secrets using current hub secret.
5. Member can now read all past messages from any epoch.

### 9.6 File Verification

All files from Blossom MUST be hash-verified:

```
downloaded_hash = SHA-256(file_contents)
expected_hash   = value from index file (or m tag)
if mismatch → REJECT, try next Blossom server
```

### 9.7 Client-Side Posting Restrictions

Although the protocol does not enforce who can publish events (§1.1, §8.3), clients SHOULD gate posting UI elements for users who are not authorized to post:

**Authorization check:**

1. Is the user in the creator's LKH member tree? → **Authorized**
2. Is the user facilitated? Check all three conditions:
   - User has a facilitator set for this hub
   - The facilitator pubkey appears in the creator's member list
   - The user's own pubkey appears as a leaf in the facilitator's LKH tree
   - All three true → **Authorized**
3. Otherwise → **Unauthorized** (read-only)

**UI gating for unauthorized users:**

- Replace the message input with a read-only banner (e.g., *"You must be a member or facilitated to post in this hub"*)
- Hide interactive action buttons: reply, thread reply, reactions
- Disable file attachment and emoji picker
- Thread modals should also respect the same gate

This is a **client-side UX decision** — it does not prevent a malicious client from publishing events. Enforcement is entirely client-side: in v2, the identity drop rule (§9.9) refuses to render events without a valid attestation, and message PoW (`w`) plus join PoW (`W`) price spam. There is no relay-side membership gate.

### 9.8 Ban Enforcement and Non-Member Message Filtering

Clients SHOULD implement message filtering based on both hub-level bans and membership status.

#### Banned User Messages

When a user's pubkey appears on the hub's ban list (§5.3):

- Messages from banned users MUST be **completely hidden** — no blur, no reveal button, no indication they exist
- This is a hard filter: banned user messages are removed from the rendered message list entirely
- Banning is distinct from personal blocking (e.g., NIP-51 mute lists), which may use a softer treatment (blur + reveal)

#### Non-Member Message Filtering

Clients SHOULD offer a **"Hide non-member messages"** toggle (recommended default: **ON**) that filters messages from pubkeys not present in any followed member list:

- When **ON**: messages from users who are neither members nor verified facilitated users are hidden from the chat view
- When **OFF**: messages from non-members are rendered normally (they may still be unreadable if the non-member didn't have the hub secret)
- The toggle applies globally across all hubs
- Own messages are never filtered regardless of membership status

This prevents cache pollution from events published by unauthorized clients to the hub's general relays. In v2 the identity drop rule (§9.9) supersedes this toggle: an event without a valid `identity` attestation is dropped before it can pollute the cache.

### 9.9 v2 Identity Enforcement (Drop Rule)

In a **v2 hub**, membership/accountability is enforced by the identity attestation rather
than by matching the author's real pubkey (which is never public). For every incoming
member-authored event (message, reaction, pin, report, poll/vote, calendar, voice
presence):

1. **Cheap pre-check (plaintext):** the event carries an `["identity", …]` tag. If absent,
   **drop** the event before any decryption — do not render, do not notify. This is the v2
   analogue of "hide non-member messages," and stops anonymous spam.
2. **Validity check (post-decrypt):** decrypt the tag (`"R_pub:sig_R"`) with the channel/hub key
   for the event's epoch to recover `R_pub` and `sig_R`; recompute the digest =
   `getEventHash(event)` with the `identity` and `nonce` tags removed, reconstruct the kind-`27492`
   attestation `{ kind: 27492, pubkey: R_pub, created_at: event.created_at, tags: [["m", digest]],
   content: "" }`, and verify `sig_R` against it (with `P_pub = event.pubkey`). If verification
   fails, **drop**. (The outer `P` signature is already checked by the relay pool; do not verify over
   `event.id` — the attestation digest deliberately excludes `nonce` so it survives PoW mining.)
3. **Ban check:** if `R_pub` (or `P_pub`) is on the decrypted ban set (§5.3), **drop**
   (hard filter, no reveal — same treatment as a v1 ban).
4. Otherwise render, attributing the message to the **real user `R`** (resolved via the
   attestation; profile fetched from `R`'s kind:0).

Notifications/sounds fire only for events that pass (1)–(3) **and** the hub's PoW
threshold **and** decrypt successfully — consistent with the v1 rule that only real,
readable, sufficiently-PoW'd messages notify.

### 9.10 Disappearing Messages

A hub MAY set a hub-wide disappearing-messages timer via the `message_expiration` tag on
the hub event (§6.1): a duration in **seconds**, where absent or `0` means off. It is
configured in hub settings **after creation** (never at creation) and is gated by whoever
may edit hub settings. The timer is hub-wide for now; per-channel overrides are a future
extension.

**Stamping (send time).** While the timer is set, a sender MUST add a NIP-40
`["expiration", "<created_at + message_expiration>"]` tag — an absolute unix timestamp in
seconds — to every **durable** chat event it publishes: messages (including forum posts),
reactions, polls, votes, calendar time events (§6.11), and RSVPs (§6.12). The `expiration`
tag MUST be added **before** mining PoW, because it is part of the event id the `nonce` is
mined over.

Calendar time events anchor their expiry to the event's **end**, not its creation:
`expiration = max(created_at, event_end) + message_expiration`. This lets a future event
survive until it is over and then disappear one timer-window later. If the event has no end
time, anchor on its start instead.

**Never stamped.** These MUST NOT carry an `expiration` tag: kind-5 deletions and their
`36943`/calendar tombstones (an expiring tombstone would resurrect the message it erased),
hide/unhide events, ephemeral edit-hint events, pins, join requests, and the hub event
(`36942`) itself.

**Non-retroactive.** The tag is baked into each event at send time, so changing the timer
affects only future messages. Readers MUST honor the per-event `expiration` tag and never
the current hub policy. An edit MUST preserve the **original** message's `expiration` —
editing never extends a message's life nor introduces an expiry where the original had none.

**Enforcement (cooperative / best-effort, like Signal).** Relays that honor NIP-40 delete
the event server-side after its expiry. Independent of any relay, a client:

- MUST NOT ingest or display an already-expired event;
- SHOULD physically purge expired events from local storage — a seized device is the
  threat, and hiding is not disappearing;
- SHOULD hide messages that expire while they are being viewed.

**Metadata leak (accepted).** The `expiration` tag is **plaintext** — NIP-40 requires it so
relays can act on it — so a relay can observe that a hub uses disappearing messages and
roughly the timer value. This is a deliberate, accepted leak: the price of real server-side
deletion, and consistent with v2's other accepted plaintext leaks (the `h`-tag pseudonym
traffic, the PoW `w`/`W` floors, and the public face tags; see §8.1 of the plan and §10.1).

---

## 10. Security Model & Tradeoffs

### 10.1 Threat Model

| Threat | Mitigation |
|--------|-----------|
| Non-member reads messages | Hub secret encryption — a non-member obtains only ciphertext (relays serve it publicly). |
| Non-member posts | Client-side identity drop rule (§9.9): events without a valid attestation are not rendered. Message PoW (`w`) prices spam. |
| Kicked member reads future messages | Secret rotation. New epoch secret not available to removed members. |
| Kicked member reads historical messages | History file re-encrypted with new secret. Removed member can't decrypt. |
| Relay reads content | AES-256-GCM encryption. Relay sees only ciphertext. |
| Member leaks hub secret | All members can read — secret protects against outsiders only. By design. |
| Creator goes rogue | Mesh lists allow community to follow alternative list maintainers. |
| Blossom server tampers with files | SHA-256 hash verification. Multiple Blossom servers for redundancy. |
| Key isolation from DMs | NIP-04 at leaf level uses the same key-agreement as DMs, but the encrypted payload (leaf symmetric key) is hub-specific and meaningless outside the tree context. |
| **(v2)** Public learns the member list | Members are stored as per-hub pseudonyms `P`, and leaf pages are encrypted. Public sees at most ~one pseudonym per page (plaintext index boundary), never real identities. |
| **(v2)** Public learns who is banned | Ban list stores real keys `R` and is encrypted with a hub-secret-derived key. Only members can read it. |
| **(v2)** Public learns who joined | Join requests are sealed to the owner via ephemeral-static ECDH and signed by a throwaway derived key (§6.3). |
| **(v2)** Public links a sender to a hub / across hubs | Messages are signed by `P` (per-hub, derived), unlinkable to `R` or across hubs. Residual: the plaintext `h` tag reveals *a pseudonym* posted to a hub (see plan §8.1). |
| **(v2)** Member is impersonated by a forged `R` in a leaf/event | `P` is owner-verified at admission (a **blinded** derivation of `R`, re-derived by the owner via `getPeerBlindedPubkey`, §6.3), and each message carries a fresh `sig_R` over the event (§9.9). Only the real `R` holder can produce a valid `P` signature (the owner derives `P_pub` but never `P_priv`), and a `P` that does not derive from the presented `R` is rejected (squat-proof). |
| **(v2)** User is coerced/accused over `P`'s messages | **v2 is accountable, not deniable** — a conscious trade (§0.1, §4.5): `R` signs **every** message, so authorship is provable to members, and to outsiders if a member leaks the ciphertext+signature. There is no "leaked pseudonym key" defence. Users should understand a v2 hub attributes their words to their real key within the member set — treat it as a private group chat, not an anonymity tool. |
| **(v2)** Public learns who created/owns the hub | The hub is authored by the owner pseudonym `O` (`kind:O:d_tag`); `R_owner` never appears publicly. A static owner attestation, encrypted with the hub secret, reveals the creator to **members only** (§4.5). |
| **(v2)** Public learns the hub's internal structure | Hub `content` (roles, categories, channel names, permissions) is encrypted with `hub_content_key`; only the public face (`n`, `picture`, `banner`, `about`, `t`) is visible. |

### 10.2 Explicit Non-Goals

- **Forward secrecy** — current members can decrypt all historical messages via the history file. This is intentional (Discord model).
- **Instant cryptographic revocation** — there is a window between removal and secret rotation.
- **Protocol-level permission enforcement** — permissions are client-side rendering decisions only.
- **Protection against members** — the hub secret protects against outsiders. Any current member can leak content.

### 10.3 Security Tiers

| Configuration | Privacy Level |
|--------------|--------------|
| v1 hub secret | Encrypted content, public metadata (member list, bans, sender→hub all public) |
| v2 hub secret | Encrypted content **and** encrypted structure; pseudonymous members, encrypted ban list, sealed joins |
| Grouped role secret | Additional isolation for specific channels |
| v2 + grouped role secret | Maximum isolation for sensitive channels within a private hub |

### 10.4 Client Security Requirements (normative)

The v2 privacy guarantees above hold **only if every client enforces the following**. These are not
optional optimizations — a client that skips any of them reintroduces a concrete deanonymization or
integrity break for *all* members of the hubs it touches, so they are stated as MUST/SHOULD requirements
for interoperability.

1. **Relay-footprint discipline (hub-only publishing).** A v2 event authored under a hub pseudonym
   (`O`, `P`, `Pf`) — every hub event, message, edit, deletion, reaction, poll, calendar event, hide,
   voice presence/host/keepalive, join request, and its rescind — **MUST** be published to the hub's own
   relays only. It **MUST NOT** be sent to the author's personal (NIP-65 / client) relay set. Publishing a
   pseudonym-authored event onto the relays the author advertises under their real key `R` lets a passive
   relay/observer correlate the pseudonym → `R` by relay footprint, defeating the pseudonymity. The same
   applies to Blossom `kind:24242` auth: it **MUST** be signed by the pseudonym (`O`/`P`/`Pf`), never `R`.
   > *Residual (document to users):* a single client, process, and IP multiplex all of a user's traffic
   > over one connection pool, so a relay present in *both* a hub's relay set and the user's personal set,
   > or a network/IP observer, can still correlate across that boundary. Full isolation requires a
   > dedicated transport per pseudonym (out of scope here).

2. **Version-downgrade rejection.** A hub's format version only ever increases. A client **MUST** persist
   the highest version accepted for a hub and **MUST** reject (skip, keep the last good state) any hub
   event whose version is lower — a validly-signed but downgraded event would otherwise force members'
   clients onto the v1 (plaintext-`R`) path and deanonymize the whole membership. The mark **MUST** be
   advanced only from events that are cryptographically confirmed to be from the real owner (below).

3. **Epoch-rollback rejection.** A v2 hub's epoch only ever increases. A client **MUST** persist the
   highest epoch accepted and **MUST** reject any hub event with a lower epoch — a stale (rotated-out)
   event served by a malicious/eclipsing relay would otherwise re-key the client to a secret a removed
   member still holds.

4. **Owner binding.** Hub events are addressable (`kind:pubkey:d_tag`) and queried by `d_tag`, so a relay
   may serve a hub event for a given `d_tag` signed by *any* pubkey. Once a client has cryptographically
   confirmed a hub's real owner — by successfully decrypting its hub secret with `creatorPubkey` as `O`,
   which no other key can do — it **MUST** reject any subsequent hub event for that hub from a different
   author (including a `deleted` tombstone). The downgrade/rollback marks (2–3) and the owner binding
   **MUST** be recorded only on such a confirmed-owner event, so a forged event that never decrypts can
   neither poison the marks nor steal the binding. This binding **MUST** be scoped so it cannot bind from a
   value an attacker controls: bind on the v2 member-tree decrypt (the member's `P`-leaf, unforgeable for a
   wrong `O`) or on a **verified owner attestation** — never on a bare content decrypt, whose ciphertext is
   public and replayable under a forged author.

5. **Fail-closed signing and auth.** If a client cannot produce the required pseudonym signer or Blossom
   auth for a v2 operation (e.g. a signer without NIP-SKD support), it **MUST** refuse the operation. It
   **MUST NOT** fall back to signing or authing under the real key `R`. Reads that require a partial/
   unverifiable security input (e.g. an unreadable encrypted ban list) **MUST** fail closed rather than
   treat "couldn't load" as "empty/allowed".

6. **Attestation & identity verification.** A client **MUST** verify the owner attestation's signature
   over the hub coordinate before trusting the real-owner key it carries (§4.5). Content events **MUST**
   follow the identity drop-rule (§9.9): an event whose identity attestation is present-but-invalid, or
   absent on v2, is dropped — never rendered or attributed by wire pseudonym alone.

7. **Authorization on receipt, by the verified real key.** Because there is no server, every client
   **MUST** re-check the author's permission when it *receives* an event (send, react, poll, hide,
   mod-ban, …) — the sender's UI gate is not trusted. The check **MUST** resolve the author to their
   identity-verified real key `R` (not the on-wire pseudonym), because an unknown pseudonym resolves to the
   permissive `everyone` role and would let a restricted member bypass a per-channel/role restriction by
   authoring under a throwaway key.

8. **Content-integrity & bounded parsing.** Every Blossom blob referenced by hash **MUST** be
   SHA-256-verified before use. A client **SHOULD** bound the resources a hostile blob can consume:
   cap hub-metadata download size, and guard the LKH tree/spine walks against a maliciously cyclic
   structure (a cycle a member/facilitator can craft, in which every decrypt legitimately succeeds, would
   otherwise hang the client).

9. **Sub-key derivation conformance.** Pseudonyms **MUST** be derived per NIP-SKD (salt `"nip-skd-v1"`,
   the fixed contexts of §0.1, the **form-tagged** HKDF `info` of NIP-SKD §1, HKDF-SHA256 with a
   **48-byte** output reduced `mod n`). `O` uses the **self** form; `P`, `Pf`, and the join address use
   the **blinded** form — including its even-`y` base normalization and the `t=0→1` / `blinded_priv=0→1`
   pins (NIP-SKD §1). All implementations (local and remote signers) must be byte-identical or members
   will derive mismatched pseudonyms and be unable to interoperate.

---

## 11. Join Flow

```
User discovers hub (naddr link, search, browse)
  → Client fetches hub event from general relay
  → User clicks "Join"
  → Client publishes Join Request (kind 36944) to general relays
  → Join request appears in hub UI for mods/creator
  → Mod or creator adds user to their Blossom member file
  → User downloads member file → decrypts hub secret → full access
  → User downloads history file → decrypts all epoch secrets → full history
  → Client updates User Hub List (kind 16942) on user's relays
  → On a later hub load, member's client confirms membership (owner-tree decrypt)
      and auto-rescinds its now-redundant join request (§6.3)
```

### Removal Flow

```
Mod/creator removes user from the LKH tree
  → (Optionally) adds user to block list
  → Creator re-keys path from removed leaf to root (~log₂(N) AES operations)
  → Creator generates new hub secret, encrypts with new root key (new epoch)
  → History file re-encrypted with new hub secret
  → Updated tree file and history uploaded to Blossom, index updated
  → Hub event updated with new m tag and epoch
  → Remaining members walk tree with updated keys to get new hub secret
  → Removed user can no longer decrypt new or historical messages
```

---

## 12. Optional v1 → v2 Copy (Fork Model)

**v1 and v2 are permanent, coexisting formats — v1 is not deprecated and there is no
migration directive (§0.4).** A creator who is happy with a public hub keeps it as v1
indefinitely. A creator who *wants* privacy can **optionally** spawn a fresh v2 successor: a
hub does not "become" v2 in place (v1 plaintext history cannot become v2 ciphertext, and the
owner authors the v2 hub under a different key `O`), so the move is a **fork**, never an
in-place rewrite. This entire section is opt-in; nothing here is required of a v1 hub.

### 12.1 v1 hub UI states

- **No `new_hub` tag** → clients SHOULD show a subtle badge and, on click, a note:
  *"This is a v1 hub. Its member list, ban list, and who-posts-where are public. v2 hubs
  don't leak this."* Informative, not nagging.
- **Has `new_hub` tag** → clients SHOULD show a **permanent "This hub has moved to a new
  version — click to request to join"** banner to everyone, and hide the hub from
  discovery. The **creator** additionally sees a **Delete old hub** control (same flow as
  §6.5), recommended after a grace period, with a warning that deletion permanently loses
  the old history and orphans anyone who never migrated.

### 12.2 Create v2 copy (fork)

Creator-only action on a v1 hub:

1. Create a **fresh v2 hub**: new `d` tag, authored by the creator's **owner pseudonym `O`**
   (§4.5) so the coordinate is `kind:O:d_tag`, new `hub_secret`, `epoch = 1`, the encrypted
   owner attestation, `["version","2"]`, and the source hub's name / icon / description /
   roles / channels / relays / blossom servers. The creator holds the hub secret directly as
   owner; members are added via the normal v2 join flow.
2. Add `["new_hub", "<new_d_tag>"]` to the **old** v1 hub event and republish it
   (creator-signed → authentic). Clients honor it only if the successor's creator pubkey
   matches.
3. Surface the moved-banner UI.

**Not carried over (by design):** no allowlist/auto-admit (would require the creator
online to admit each member anyway — members just use the normal v2 join
flow), no ban carry-over (reject bad re-joins manually), and **no history** (old messages
stay readable in the old hub; copying them would drag `R`-signed history into the private
hub). Members re-join via §6.3; the creator approves as usual.

**Fork resets bans (evasion side-effect).** Because the fork starts from an empty ban set,
every prior ban — **including the creator's own** — is void in the new hub. A fork is
therefore a clean slate: a creator forking to escape a brigade also resets their own bans,
so forking doubles as a ban-evasion path. This is acceptable at today's scale (few hubs,
at most a handful of bans each); if hubs grow large, revisit by carrying a re-encrypted ban
set into the fork.

### 12.3 Discovery

Clients MUST hide any hub carrying a `new_hub` tag from search/browse/discovery.

---

## 13. Event Kind Summary

| Kind | Name | Type | Published To |
|------|------|------|-------------|
| `36942` | Hub Event | Addressable Replaceable | General relays |
| `36943` | Message | Addressable Replaceable | Hub general relays |
| `26943` | Message Edit Hint | Ephemeral | Hub general relays |
| `26950` | Typing Indicator | Ephemeral | Hub general relays (hub) · recipient's inbox relays (DM04) |
| `36944` | Join Request | Addressable Replaceable | General relays & hub's relays |
| `36945` | Channel Pin List | Addressable Replaceable | Hub general relays |
| `36946` | Voice Host Availability | Addressable Replaceable | Hub general relays |
| `36947` | Voice Presence Heartbeat | Addressable Replaceable | Hub general relays |
| `36948` | Hub Report | Addressable Replaceable | Hub general relays |
| `36949` | Hide Message (moderation hide/unhide, §4.6) | Addressable Replaceable | Hub general relays |
| `31923` | Calendar Time Event (NIP-52) | Addressable Replaceable | Hub general relays |
| `31925` | Calendar RSVP (NIP-52) | Addressable Replaceable | Hub general relays |
| `1067` | Poll | Regular | Hub general relays |
| `1017` | Vote | Regular | Hub general relays |
| `16942` | User Hub List | Replaceable | User's own relays |
| `1312` | Public Chat Message | Regular | User's relays (§16) |
| `30078` | Public Chat Topic List (NIP-78) | Addressable Replaceable | User's own relays (§16) |
| `30078` | Join Read-State (`den-join-read-state`, NIP-78, self-encrypted) | Addressable Replaceable | Creator's own relays (§6.3) |
| `14` | DM Rumor (NIP-17) | Unsigned (inside seal) | Never published directly (§17) |
| `15` | DM File (NIP-17) | Unsigned (inside seal) | Never published directly (§17) |
| `13` | Seal (NIP-17) | Signed | Never published directly (inside gift wrap) |
| `1059` | Gift Wrap (NIP-17) | Signed (throwaway key) | Sender's + recipient's relays (§17) |
| `10050` | DM Relay List (NIP-17) | Replaceable | User's own relays |
| `30030` | Emoji Set (NIP-30) | Addressable Replaceable | User's relays (§19) |
| `30031` | Sticker Set | Addressable Replaceable | User's relays (§19) |
| `30032` | GIF Collection | Addressable Replaceable | User's relays (§19) |
| `30000` | Emoji/Sticker/GIF Subscription Lists (NIP-51) | Addressable Replaceable | User's relays (§19) |
| `1111` | Forum Post & Comment (NIP-22) | Regular | User/community relays (§20) |
| `7` | Forum Reaction (NIP-25) | Regular | User/community relays (§20) |
| `34550` | Community Definition (NIP-72) | Addressable Replaceable | Community/user relays (§20) |
| `4550` | Community Post Approval (NIP-72) | Regular | Community relays (§20) |
| `10004` | Followed Communities (NIP-51) | Replaceable | User's relays (§20) |
| `30044` | Word Community Profile (DEN) | Addressable (`d`=word) | Public relays (§20) |
| `10044` | Followed Word Communities (DEN) | Replaceable | User's relays (§20) |

---

## 14. Tag Reference

| Tag | Used In | Description |
|-----|---------|-------------|
| `d` | Hub, Join Request, Pin List, Voice Host, Voice Presence, Report | Addressable replaceable identifier |
| `n` | Hub | Hub name |
| `w` | Hub | Minimum **message** PoW difficulty (NIP-13) |
| `W` | Hub (**v2**) | Minimum **join** PoW difficulty (NIP-13), separate from and higher than `w`; the join request MUST meet it, dropped before the owner spends an ECDH (§6.1, §6.3) |
| `epoch` | Hub, Message, Poll, Vote, Report, Voice Host | Secret epoch number (incrementing integer) |
| `b` | Hub | DNN ID requirement flag |
| `r` | Hub | Relay (`general`) |
| `o` | Hub | Blossom server URL |
| `m` | Hub | Index file reference: `["m", "<sha256>", "<epoch>"]` |
| `h` | Message | Hub `d` tag reference |
| `c` | Message, Voice Presence | Channel UUID |
| `e` | Message | Reply reference |
| `q` | Message | Quote reference |
| `nonce` | Hub, Message, Report | PoW nonce (NIP-13 format). On the hub event (36942) it proves the hub event was mined to its `w` difficulty on every publish (anti-spam); discovery clients drop hubs whose event PoW < claimed `w` (§6.1). |
| `list` | Join Request | Optional SHA-256 hash of the member's own Blossom index file (mesh list / facilitation discovery, §5.6) |
| `facilitator` | Message | Hex pubkey of the member who facilitated the sender's access to the hub secret (§5.6). Present only when the sender is not in the creator's member list. |
| `v` | User Hub List | Hub `d` tag with relay hint, position, and optional folder reference |
| `folder` | User Hub List | Folder group definition (UUID + name) |
| `content-warning` | Hub, Message | NIP-36: sensitive content flag. Value is an optional reason string. |
| `L` | Hub, Message | NIP-32: label namespace (set to `"content-warning"` for NSFW marking). |
| `deleted` | Hub, Message | Deletion fallback flag. `["deleted", "true"]` marks the event as request-deleted. Used when relays do not honor NIP-09 Kind 5 deletion. |
| `version` | Hub | Hub format version (**v2**, §0). Absent ⇒ v1; `"2"` ⇒ v2; higher ⇒ update client. |
| `new_hub` | Hub | On a forked v1 hub: `d` tag of the v2 successor (§12). Honor only if same creator pubkey. |
| `identity` | Message + all member-authored hub events (**v2**) | Encrypted `"R_pub:sig_R"` attestation (`sig_R` = a per-message kind-`27492` attestation, not a signature over `event.id`) binding the pseudonymous author to their real key (§0.1, §6.2). Opaque ciphertext; required in v2, drop events without it (§9.9). |
| `picture` | Hub (**v2**) | Plaintext hub icon URL for the join/Discover card (moved out of the encrypted `content`). |
| `banner` | Hub (**v2**) | Plaintext hub banner URL for the join/Discover card. |
| `about` | Hub (**v2**) | Plaintext public blurb for the join/Discover card. |
| `f` | Hub | Discoverability flag (`on`/`off`). Default when absent: `on`. When `off`, clients SHOULD hide the hub from search/browse UIs. Supports relay-side filtering via `#f`. |
| `pin` | Pin List | Pinned message reference: `["pin", "<channel_id>", "36943:<author>:<d_tag>"]`. Stable across message edits. |
| `status` | Voice Host, Voice Presence | State indicator: `"available"`/`"paused"` (host) or `"joined"`/`"left"` (presence). |
| `provider` | Voice Host | SFU provider type: `"cloudflare"` or `"livekit"`. |
| `host` | Voice Presence | Pubkey of the SFU host whose infrastructure is being used. |
| `session` | Voice Presence | Provider-specific session identifier. |
| `pos` | Voice Presence | Spatial audio position: `["pos", "<x>", "<y>"]`. |
| `sphere` | Voice Presence | Voice sphere radius for spatial audio attenuation. |
| `report` | Report | Reported message addressable reference: `["report", "36943:<author>:<d_tag>"]`. Present when reporting a specific message. |
| `y` | Report | Report type classification. Predefined: `spam`, `nudity`, `profanity`, `illegal`, `malware`, `impersonation`, `other`. Custom freeform strings also valid. |
| `s` | Report | Report status: `open` (active) or `retracted` (withdrawn by reporter). |
| `a` | Report, Message, Calendar RSVP | Addressable event reference. In reports: hub scope `["a", "36942:<creator>:<d_tag>"]`. In messages: reply/thread root reference. In RSVPs: calendar event reference `["a", "31923:<pubkey>:<d_tag>"]`. |
| `p` | Report, Message | Pubkey reference. In reports: the reported user (violator). In messages: mention or reply target. |
| `title` | Calendar Event | AES-encrypted event title. |
| `start` | Calendar Event | AES-encrypted start unix timestamp (UTC seconds, as string). |
| `end` | Calendar Event | AES-encrypted end unix timestamp (UTC seconds, as string). Optional. |
| `summary` | Calendar Event | AES-encrypted short one-line summary. Optional. |
| `image` | Calendar Event | AES-encrypted image URL. Optional. |
| `location` | Calendar Event | AES-encrypted location string. Multiple tags allowed. Optional. |
| `D` | Calendar Event | AES-encrypted day-granularity index: `floor(timestamp / 86400)` as string. One per spanned day. |
| `status` | Calendar RSVP, Report, Voice Host, Voice Presence | In RSVPs: AES-encrypted RSVP status (`accepted`/`declined`/`tentative`). In reports: `open`/`retracted`. In voice: `available`/`paused`/`joined`/`left`. |
| `t` | Public Chat Message, Public Chat Topic List | Topic string (lowercase). Used for relay filtering (`#t`) in public chat. |
| `j` | Hub Chat, DMs, Public Chat | GIF attachment: `["j", "<name>", "<url>", "sfw"\|"nsfw"]`. `j` is used because `g` is the standard Nostr geohash tag per NIP-52. |
| `sticker` | Hub Chat, DMs, Public Chat | Custom sticker attachment: `["sticker", "<shortcode>", "<url>", "<set_address>"]`. |
| `emoji` | Hub Chat, DMs, Public Chat | NIP-30 custom emoji: `["emoji", "<shortcode>", "<url>"]`. |
| `file-type` | DM File (kind 15) | MIME type of the original file before encryption (e.g., `"image/png"`). |
| `encryption-algorithm` | DM File (kind 15) | Always `"aes-gcm"`. Identifies the symmetric encryption algorithm used for the file. |
| `decryption-key` | DM File (kind 15) | AES-256 key in hex (64 chars). Per-file random key for decrypting the ciphertext. |
| `decryption-nonce` | DM File (kind 15) | AES-GCM nonce/IV in hex (24 chars = 12 bytes). |
| `x` | DM File (kind 15) | SHA-256 hash of the encrypted file (ciphertext) in hex. Used as the Blossom content address. |
| `ox` | DM File (kind 15) | SHA-256 hash of the original plaintext file in hex. Used for integrity verification after decryption. |
| `size` | DM File (kind 15) | Encrypted file size in bytes (string). |
| `dim` | DM File (kind 15) | Image/video dimensions as `"widthxheight"` (e.g., `"1920x1080"`). |

---

## 15. Implementation Notes

### 15.1 Deterministic Group ID

```
Input:  role_ids = ["uuid-B", "uuid-A", "uuid-C"]
Sorted: ["uuid-A", "uuid-B", "uuid-C"]
Joined: "uuid-A,uuid-B,uuid-C"
Result: sha256("uuid-A,uuid-B,uuid-C") → group_id
```

Clients MUST sort lexicographically and join with `,` before hashing.

### 15.2 Encryption Inheritance

```
1. channel.encryption       → if present and synced == false, use this
2. category.encryption      → if channel.synced == true, use category's
3. null                     → hub-wide secret (default)
```

### 15.3 Tree Management Recommendations

- Keep the tree balanced (all leaves at same depth ±1)
- When adding members, insert leaves to maintain balance
- On removal: re-key only the affected path (~log₂(N) nodes), not the entire tree
- Offer "Fix Encryption" (full tree rebuild) as a rare maintenance action
- Tree file size: ~200 bytes per member (leaf line + share of internal nodes)

### 15.4 Blossom Server Recommendations

- Minimum 3 Blossom servers for redundancy
- SHA-256 hash verification on every download
- Upload media to all `o` servers for redundancy
- If one server fails hash check, try next server before rejecting

---

## 16. Public Chat — Kind `1312`

### 16.1 Overview

Public Chat is a **permissionless, topic-based** chat system that operates independently from the hub-based encrypted messaging (§6). It requires no hub membership, no encryption, and no authority — anyone can post, and messages are public plaintext. Spam prevention relies on **Proof-of-Work** (NIP-13).

This is a separate protocol layer that shares the same client but has completely different trust assumptions from hub chat:

| Property | Hub Chat (§6) | Public Chat |
|----------|--------------|-------------|
| Event Kind | `36943` | `1312` |
| Encryption | AES-256-GCM (hub secret) | None (plaintext) |
| Access Control | Client-side (identity drop rule, §9.9) | Open to all |
| Identity | Hub member lists | Any Nostr keypair |
| Spam Prevention | Message PoW + join PoW | PoW only |
| Editing | Re-publish same d-tag | Not supported |
| Structure | Hub → Channel hierarchy | Flat topics |

### 16.2 Message Event — Kind `1312`

**Type**: Regular Event

```json
{
  "kind": 1312,
  "pubkey": "<sender_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["t", "<topic>"],
    ["nonce", "<counter>", "<difficulty>"],
    ["e", "<reply_event_id>", "", "root"],
    ["e", "<reply_event_id>", "", "reply"]
  ],
  "content": "Hello, world!",
  "sig": "<signature>"
}
```

Messages are **plaintext** — the `content` field contains the raw message text (Markdown supported).

#### Tags

| Tag | Required | Description |
|-----|----------|-------------|
| `t` | Yes | Topic string (normalized to lowercase). Used for relay subscription filtering (`#t`). |
| `nonce` | Conditional | PoW nonce (NIP-13 format: `["nonce", "<counter>", "<target_difficulty>"]`). Required if the client enforces a minimum PoW difficulty. |
| `e` | No | Reply threading (NIP-10). Two `e` tags per reply: one with `root` marker (thread root event ID), one with `reply` marker (direct parent event ID). When replying to a top-level message, both reference the same event. |
| `emoji` | No | NIP-30 custom emoji tags: `["emoji", "<shortcode>", "<url>"]`. |
| `sticker` | No | Custom sticker: `["sticker", "<shortcode>", "<url>", "<set_address>"]`. |
| `j` | No | GIF attachment: `["j", "<name>", "<url>", "sfw"\|"nsfw"]`. (`j` is used because `g` is the standard Nostr geohash tag per NIP-52.) |
| `content-warning` | No | NIP-36: marks message as sensitive/NSFW. |
| `L` | Conditional | NIP-32: label namespace. Set to `"content-warning"` when the `content-warning` tag is present. |
| `client` | No | Client identification tag (e.g., `["client", "DEN Chat"]`). |

#### PoW Filtering (Coupled Model)

Public Chat uses a **coupled PoW model** — the same difficulty value serves as both the post requirement and the filter threshold:

- When posting: the client mines the event ID to meet the configured difficulty before signing
- When filtering: the client verifies `countLeadingZeroBits(event.id) >= difficulty` and hides messages below the threshold
- Default difficulty: `15` bits (configurable per client, range 0–40)

This means higher PoW = harder to spam AND stricter filtering. There is no separate "read difficulty" vs "write difficulty".

### 16.3 Topic List — NIP-78 (Kind `30078`)

Each user's subscribed topic list is persisted via a **NIP-78 Application Specific Data** event:

```json
{
  "kind": 30078,
  "pubkey": "<user_pubkey>",
  "tags": [
    ["d", "public-chat-list"],
    ["t", "nostr"],
    ["t", "bitcoin"],
    ["t", "dev"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

| Tag | Description |
|-----|-------------|
| `d` | Fixed value: `"public-chat-list"`. Makes this an addressable replaceable event (one per user). |
| `t` | One tag per subscribed topic (lowercase). |

The topic list is fetched on startup and updated when topics are added or removed.

### 16.4 Subscriptions

**Active topic subscription:**
```json
{"kinds": [1312], "#t": ["<topic>"], "limit": 50}
```

**Pagination (older messages):**
```json
{"kinds": [1312], "#t": ["<topic>"], "until": <oldest_timestamp>, "limit": 50}
```

Clients maintain a single active subscription for the currently viewed topic. Switching topics closes the old subscription and opens a new one.

### 16.5 Content Tags

Public Chat messages support the same rich content tags as hub chat and DMs, but **unencrypted**:

- **Custom Emoji** (NIP-30): `["emoji", "<shortcode>", "<url>"]` — rendered inline as images
- **Stickers**: `["sticker", "<shortcode>", "<url>", "<set_address>"]` — rendered as large standalone images
- **GIFs**: `["j", "<name>", "<url>", "sfw"|"nsfw"]` — rendered as inline animated images

Since Public Chat is plaintext, these tags are stored as-is on relays (no encryption layer).

### 16.6 Content Filters

Because Public Chat is permissionless, clients SHOULD provide fine-grained content filtering controls (all default OFF except muted words):

| Filter | Default | Description |
|--------|---------|-------------|
| Show media | OFF | Display embedded images, videos, stickers, GIFs |
| Show link previews | OFF | Render URL previews |
| Show custom emojis | OFF | Render NIP-30 custom emoji shortcodes as images |
| Hide muted words | ON | Redact messages containing muted words |
| DNN ID only | OFF | Only show messages from users with verified DNN IDs |

These are **client-side filters** — all messages are still received from relays, but hidden or redacted based on user preferences.

### 16.7 Client Behavior

#### Joining a Topic

1. User enters a topic name or selects from suggestions
2. Client normalizes the topic to lowercase and trims whitespace
3. Topic is added to the local topic list
4. Client publishes updated NIP-78 topic list (Kind `30078`)
5. Client opens a subscription for the new topic

#### Leaving a Topic

1. Client removes the topic from the local topic list
2. Client clears cached messages for the topic
3. Client publishes updated NIP-78 topic list
4. If the removed topic was active, the view returns to the topic list

#### Sending a Message

1. Client builds an unsigned Kind `1312` event with `t` tag, optional reply `e` tags, and any content tags (emoji, sticker, GIF)
2. If NSFW: append `["content-warning", ""]` and `["L", "content-warning"]` tags
3. If client tag enabled: append `["client", "DEN Chat"]`
4. If PoW difficulty > 0: mine the event using a Web Worker until the event ID has the required leading zero bits
5. Sign the event
6. Publish with progressive relay tracking (show relay confirmation count)
7. Optimistically add the message to the local view

#### PoW Rendering

- Each message displays its computed PoW difficulty
- Messages below the user's configured threshold are hidden (not deleted — lowering the threshold reveals them)
- The PoW badge shows the number of leading zero bits in the event ID

---

## 17. Direct Messages — NIP-17 Gift Wrap

### 17.1 Overview

DEN Chat implements NIP-17 for private direct messages. Unlike hub chat (which uses a shared hub secret), DMs use **per-conversation NIP-44 encryption** with a three-layer wrapping protocol that hides both message content and metadata (who is messaging whom) from relays.

| Property | Hub Chat (§6) | DMs (NIP-17) |
|----------|--------------|-------------|
| Encryption | AES-256-GCM (shared hub secret) | NIP-44 (per-conversation key agreement) |
| Metadata privacy | Relay sees sender pubkey + hub/channel | Relay sees only throwaway pubkey + recipient |
| File attachments | Optional encryption in attachment JSON (§6.2.1) | Always encrypted (kind 15, separate event) |
| Editing | Re-publish same d-tag | Not supported (rumors are unsigned, no d-tag) |
| Deniability | No (signed events) | Yes (rumors are unsigned — deniable) |

### 17.2 Protocol Layers

NIP-17 uses three nested event kinds:

```
Kind 14/15 (Rumor, unsigned)  →  Kind 13 (Seal, NIP-44 encrypted)  →  Kind 1059 (Gift Wrap, NIP-44 encrypted)
```

1. **Rumor (kind 14 or 15)** — The actual DM content. **Unsigned** — provides deniability. Never published directly.
2. **Seal (kind 13)** — Encrypts the serialized rumor JSON to the recipient using the sender's real key (NIP-44). Signed by the sender. Never published directly.
3. **Gift Wrap (kind 1059)** — Encrypts the serialized seal JSON using a **random throwaway key**. Signed by the throwaway key. This is the only event published to relays.

The throwaway key ensures the relay cannot determine the real sender — it sees only the throwaway pubkey and the recipient's pubkey (from the `p` tag).

### 17.3 Text Message — Kind 14 (Rumor)

A standard text DM. The rumor is unsigned and contains the plaintext message.

```json
{
  "kind": 14,
  "pubkey": "<sender_real_pubkey>",
  "created_at": "<actual_timestamp>",
  "tags": [
    ["p", "<recipient_pubkey>"],
    ["client", "DEN Chat"]
  ],
  "content": "Hello, this is a private message!"
}
```

| Field | Description |
|-------|-------------|
| `kind` | `14` — text DM rumor |
| `pubkey` | Sender's real pubkey (hidden inside the seal) |
| `created_at` | Actual message timestamp (the gift wrap timestamp is randomized) |
| `content` | Plaintext message content (Markdown supported) |
| `p` tag | Recipient's pubkey |
| `client` tag | Optional client identification |

**Important:** The rumor has **no signature** — it cannot be proven to have been authored by `pubkey`. This provides cryptographic deniability.

### 17.4 File Attachment — Kind 15 (DM File)

Encrypted file attachments use a **separate event kind** (kind 15) rather than embedding files in the kind 14 content. The file is encrypted client-side with AES-256-GCM before uploading to Blossom, and the decryption metadata is placed in the rumor's tags.

```json
{
  "kind": 15,
  "pubkey": "<sender_real_pubkey>",
  "created_at": "<actual_timestamp>",
  "tags": [
    ["p", "<recipient_pubkey>"],
    ["file-type", "image/png"],
    ["encryption-algorithm", "aes-gcm"],
    ["decryption-key", "<aes256_key_hex_64_chars>"],
    ["decryption-nonce", "<aes_gcm_nonce_hex_24_chars>"],
    ["x", "<sha256_of_ciphertext>"],
    ["ox", "<sha256_of_plaintext>"],
    ["size", "<ciphertext_size_bytes>"],
    ["dim", "<widthxheight>"],
    ["e", "<parent_rumor_id>"]
  ],
  "content": "<blossom_url_of_encrypted_file>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `p` | Yes | Recipient's pubkey |
| `file-type` | Yes | MIME type of the original file (before encryption) |
| `encryption-algorithm` | Yes | Always `"aes-gcm"` |
| `decryption-key` | Yes | AES-256 key in hex (64 chars / 32 bytes). Randomly generated per file. |
| `decryption-nonce` | Yes | AES-GCM nonce/IV in hex (24 chars / 12 bytes). Randomly generated per file. |
| `x` | Yes | SHA-256 of the ciphertext (Blossom content address) |
| `ox` | Yes | SHA-256 of the original plaintext file (integrity verification) |
| `size` | No | Ciphertext size in bytes |
| `dim` | No | Image/video dimensions as `"widthxheight"` |
| `e` | No | Event ID of a parent kind 14 rumor this file is attached to (for grouping text + files) |

The `content` field contains the **Blossom URL** of the encrypted file (e.g., `https://blossom.example.com/<ciphertext_hash>`).

#### Encryption Flow (Same as Hub Chat §6.2.2)

1. Generate random AES-256 key (32 bytes) and nonce (12 bytes)
2. `ciphertext = AES-GCM-encrypt(key, nonce, plaintext_file)` — includes 16-byte auth tag
3. Compute `SHA-256(ciphertext)` → Blossom content address
4. Upload ciphertext to Blossom
5. Place decryption metadata in kind 15 rumor tags
6. Wrap in seal → gift wrap → publish

#### Decryption Flow

1. Unwrap gift wrap → unseal → parse kind 15 rumor
2. Extract `decryption-key`, `decryption-nonce`, and Blossom URL from tags
3. Download ciphertext from Blossom
4. `plaintext = AES-GCM-decrypt(key, nonce, ciphertext)`
5. Verify: `SHA-256(plaintext) == ox` tag value
6. Create blob URL for rendering

### 17.5 Seal — Kind 13

The seal encrypts the serialized rumor JSON to the target pubkey using NIP-44.

```json
{
  "kind": 13,
  "pubkey": "<sender_real_pubkey>",
  "created_at": "<randomized_timestamp>",
  "tags": [],
  "content": "<nip44_encrypted_rumor_json>",
  "sig": "<signature>"
}
```

- `created_at` is **randomized** (within the past 48 hours) to prevent timestamp correlation attacks
- `content` is the NIP-44 encrypted serialization of the kind 14/15 rumor, encrypted to the target pubkey
- The seal is signed by the sender's real key
- Two seals are created per message: one encrypted to the recipient, one encrypted to the sender (so the sender can read their own DMs)

### 17.6 Gift Wrap — Kind 1059

The outermost layer, published to relays.

```json
{
  "kind": 1059,
  "pubkey": "<throwaway_pubkey>",
  "created_at": "<randomized_timestamp>",
  "tags": [
    ["p", "<recipient_pubkey>"]
  ],
  "content": "<nip44_encrypted_seal_json>",
  "sig": "<throwaway_signature>"
}
```

- `pubkey` is a **randomly generated throwaway key** — the relay has no idea who the real sender is
- `created_at` is **randomized** (independent of the actual message time)
- The `p` tag reveals the recipient (necessary for relay delivery) but not the sender
- `content` is NIP-44 encrypted using the throwaway private key + recipient pubkey
- Each message produces **two gift wraps**: one for the recipient, one for the sender (self-copy)

### 17.7 Publishing Rules

- Gift wraps MUST be published to the **recipient's DM relays** (kind `10050` relay list) and the **sender's DM relays**
- If the recipient has no kind `10050` event, fall back to their kind `10002` relay list
- The self-copy gift wrap is published to the sender's own DM relays
- **Two gift wraps per message**: one addressed to the recipient, one addressed to the sender

### 17.8 DM Relay List — Kind 10050

Users advertise their preferred DM relays via a kind `10050` replaceable event (NIP-17 spec):

```json
{
  "kind": 10050,
  "pubkey": "<user_pubkey>",
  "tags": [
    ["relay", "wss://relay1.example.com"],
    ["relay", "wss://relay2.example.com"]
  ],
  "content": ""
}
```

Clients fetch the counterparty's `10050` event to determine where to publish gift wraps. For self-copies, the client publishes to its own `10050` relays.

### 17.9 Subscription

```json
{"kinds": [1059], "#p": ["<my_pubkey>"], "limit": 100}
```

**Critical:** Subscriptions use `limit` only — **never `since`**. Gift wrap timestamps are intentionally randomized per the NIP-17 spec, so `since`-based pagination produces unreliable results. Clients SHOULD fetch a large initial batch and then maintain a real-time subscription for new events.

### 17.10 Unwrapping Flow

```
Receive kind 1059 gift wrap event
  → NIP-44 decrypt content (my key + throwaway pubkey) → parse kind 13 seal
  → Verify seal.kind == 13
  → NIP-44 decrypt seal.content (my key + seal.pubkey) → parse kind 14/15 rumor
  → Verify rumor.kind == 14 or 15
  → Extract sender pubkey from seal.pubkey (real identity)
  → Use rumor.created_at for message ordering (not gift wrap or seal timestamps)
  → If kind 15: download file from content URL, decrypt with tags metadata
```

### 17.11 Comparison: Hub Chat vs DM File Encryption

Both systems use the same `AES-256-GCM` primitives from `fileEncryption.ts`, but the metadata delivery differs:

| Aspect | Hub Chat Attachments (§6.2.1) | DM File Attachments (Kind 15) |
|--------|------------------------------|------------------------------|
| Encryption keys stored in | `encryption` object in the attachment JSON (inside encrypted message content) | Tags on the kind 15 rumor (inside seal, inside gift wrap) |
| Key delivery encryption | AES-256-GCM (hub/channel key) | NIP-44 (per-conversation ECDH) |
| File encryption opt-in | User toggle (default off) | Always encrypted |
| Content field | Encrypted message JSON containing `{text, attachments}` | Blossom URL of the encrypted file |
| Multiple files | Multiple entries in `attachments` array (single event) | One kind 15 event per file (linked via `e` tag) |
| Hash used for Blossom | `hash` field (ciphertext hash when encrypted) | `x` tag (ciphertext hash) |
| Original hash | `originalHash` in encryption object | `ox` tag |

---

## 18. Future Extensions

- **Hub discovery protocol** — search by tags, PoW, member count
- **Automated join approval** — bot-driven member file management
- **Channel-specific member lists** — different membership than the hub
- **Mesh list sync** — automated synchronization of mesh lists between facilitators

---

## 19. Custom Emoji, Sticker & GIF Sets

DEN Chat lets users publish and subscribe to reusable sets of custom emoji, stickers, and GIFs. Each set is an **addressable replaceable** event identified by `(pubkey, kind, d-tag)`. Three distinct kinds keep the types from sharing a relay slot:

| Kind | Type | Item tag |
|------|------|----------|
| `30030` | Emoji set (NIP-30) | `emoji` |
| `30031` | Sticker set | `sticker` |
| `30032` | GIF collection | `j` |

### Set identity

- The **`d` tag is a random UUIDv4**, not the set's name. Because relays key addressable events solely on `(pubkey, kind, d-tag)`, deriving the d-tag from the (slugified) name caused two sets with the same name — across types or within one — to overwrite each other on relays. A UUID guarantees uniqueness.
- The display name lives in a **`title` tag**. Readers that encounter a legacy set without a `title` SHOULD fall back to de-slugging the `d` tag.
- There is **no `t` type-discriminator tag** — the kind alone identifies the type.

### Emoji set — Kind `30030`

Standard NIP-30. The only DEN extension is an optional **4th element** on each `emoji` tag carrying an SFW/NSFW classification; NIP-30 readers ignore extra tag elements, so the set stays interoperable with other clients.

```json
{
  "kind": 30030,
  "pubkey": "<author_pubkey>",
  "created_at": "<timestamp>",
  "tags": [
    ["d", "8a1c4e2b-9f7d-4a3e-bb21-1c2d3e4f5a6b"],
    ["title", "Anime Reactions"],
    ["emoji", "smug", "https://blossom.example/abc.png", "sfw"],
    ["emoji", "lewd", "https://blossom.example/def.png", "nsfw"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

Item tag: `["emoji", "<shortcode>", "<url>", "sfw"|"nsfw"?]`. The SFW/NSFW element is optional; absent means "untagged."

### Sticker set — Kind `30031`

Identical shape with `sticker` item tags:

```json
{
  "kind": 30031,
  "tags": [
    ["d", "f4e9b7a0-3c8d-4e1f-9a2b-6d5c4b3a2f10"],
    ["title", "Anime Reactions"],
    ["sticker", "thumbsup", "https://blossom.example/stk1.webp", "sfw"]
  ],
  "content": ""
}
```

### GIF collection — Kind `30032`

Uses `j` item tags (not `g`, which is the NIP-52 geohash tag):

```json
{
  "kind": 30032,
  "tags": [
    ["d", "2d7f1a93-5b6c-4d8e-8f01-3a4b5c6d7e8f"],
    ["title", "Reaction GIFs"],
    ["j", "clapping", "https://blossom.example/g1.gif", "sfw"]
  ],
  "content": ""
}
```

### Deletion

A set is deleted by publishing an empty replacement under the same `d` tag carrying a `["deleted", "true"]` tag and no item tags.

### Subscription lists

A user's subscriptions to *other* people's sets are stored as NIP-51 lists (kind `30000`), one per type, distinguished by `d` tag:

| `d` tag | References |
|---------|-----------|
| `emoji-subscriptions` | `["a", "30030:<pubkey>:<dtag>"]` per subscribed set |
| `sticker-subscriptions` | `["a", "30031:<pubkey>:<dtag>"]` per subscribed set |
| `gif-subscriptions` | `["a", "30032:<pubkey>:<dtag>"]` per subscribed collection |
| `gif-favorites` | `["j", "<name>", "<url>", "sfw"\|"nsfw"]` for individually favorited GIFs |

Each `a` tag is an addressable reference to a subscribed set; clients fetch those sets by their `(kind, pubkey, d-tag)` coordinate.

---

## 20. Forum — Communities

The Forum is a Reddit-style threaded-discussion surface in the social area. It supports **two distinct community types** that look the same in the UI but differ fundamentally in ownership and addressing. **They are intentionally separate** — posts in one type never appear in the other.

| | **Word community** (UI tab: *Open*) | **Created community** (NIP-72, UI tab: *Moderated*) |
|---|---|---|
| Reference tag on posts | `["t", "<word>"]` | `["A"/"a", "34550:<creator>:<id>"]` |
| Identity / handle | the word → **`w/<word>`** | the address → **`c/<naddr>`** |
| How many "gaming"? | exactly **one**, global | **many** (one per creator) |
| Definition event | none | kind `34550` |
| Moderation | **none central** — client-side only | creator + moderators (kind `4550`) |
| Followed-list kind | `10044` (DEN) | `10004` (NIP-51) |
| Status | **Phase 1 (implemented)** | **Phase 2 (implemented)** |

Both types use **kind `1111`** (NIP-22) for posts and comments, and **kind `7`** (NIP-25) for reactions. A post and its comments are distinguished by the parent-reference rules below (mirrors §6.x message/reply separation).

### 20.1 Word Communities (Open)

A word community is not a created object — there is **no definition event, no creator, and no central moderation**. The "community" is simply the set of all top-level kind-`1111` posts carrying `["t", "<word>"]`. There is exactly **one** community per word, globally. Its handle is **`w/<word>`** (a copy-able identifier, not a URL).

This is the [Public Chat (§16)](#16-public-chat--kind-1312) topic model applied to threaded posts. **It does not collide with public chat:** public chat is kind `1312`, forum posts are kind `1111`, so every fetch is kind-pinned and the two never cross-populate even though they share the `t:<word>` namespace.

#### Top-level post

```json
{
  "kind": 1111,
  "pubkey": "<author>",
  "created_at": "<timestamp>",
  "tags": [
    ["t", "gaming"],
    ["subject", "Best co-op games of 2026?"]
  ],
  "content": "<body markdown>",
  "sig": "<sig>"
}
```

- `["t", "<word>"]` — the word community (lowercase, relay-filterable). Normalized lowercase.
- `["subject", "<title>"]` — the post title (NIP-14).
- A top-level post carries **no parent reference** (no `e`/`E` tag). It is the root of its own thread.

#### Comment

Comments follow NIP-22 with the **post as the thread root**:

```json
{
  "kind": 1111,
  "tags": [
    ["E", "<post-id>"], ["K", "1111"], ["P", "<post-author>"],
    ["e", "<parent-id>"], ["k", "1111"], ["p", "<parent-author>"]
  ],
  "content": "<comment markdown>"
}
```

- Uppercase `E`/`K`/`P` = root scope (the top-level post). Lowercase `e`/`k`/`p` = immediate parent (the post or a parent comment).
- Comments **do not** carry the `["t", "<word>"]` tag — only the top-level post does.

#### Fetching

- **Top-level posts for a word:** `{ "kinds": [1111], "#t": ["gaming"] }` — returns only top-level posts (comments lack `t`).
- **A post's full comment tree:** `{ "kinds": [1111], "#E": ["<post-id>"] }` — the whole subtree in one query; build nesting from the lowercase `e` parent tags.
- **Reactions:** `{ "kinds": [7], "#e": ["<post-id>"] }` (see §20.3).

#### Moderation

Word communities have **no central moderation**. Filtering is purely client-side and reuses the exact stack used for Public Chat (§16):
- **Proof of Work** threshold (per client setting),
- **Web of Trust** scoring (a `forum` context, mirroring the `publicChat` context),
- **Muted words**, and **blocked pubkeys** (NIP-51 kind `10000`).

#### Followed words

A user's subscribed word communities are stored in a **replaceable kind `10044`** event (DEN-specific; mirrors the shape of NIP-51 kind `10004`), one `["t", "<word>"]` tag per subscription. Latest-wins, no `d` tag.

```json
{ "kind": 10044, "tags": [["t", "gaming"], ["t", "nostr"], ["t", "bitcoin"]], "content": "" }
```

**Optional appearance (kind `30044`).** Word communities have no owner, so an appearance (picture / banner / description; the word itself is the name) is an **addressable** event keyed by `d = <word>`, one per author per word. Resolution is explicit, not automatic: a client renders **the viewer's own** 30044 for the word. That event either carries the appearance directly, or **delegates** to another author's via an `["a", "30044:<author>:<word>"]` tag (the editor's "From follows" tab lets you adopt and re-share an appearance published by someone you follow). With no 30044 for a word, nothing extra renders. This keeps metadata owner-free and fully under each viewer's control, without bloating the follow list. Picture/banner upload through the same Blossom flow as the rest of the app (size limit, progress, multiple servers), and every forum image renders through the shared failover + hash-verification component.

```json
// own appearance
{ "kind": 30044, "tags": [["d","gaming"], ["picture","https://…"], ["banner","https://…"], ["description","All things gaming"]], "content": "" }
// delegate to another author's appearance for "gaming"
{ "kind": 30044, "tags": [["d","gaming"], ["a","30044:<author-pubkey>:gaming"]], "content": "" }
```

**List size cap.** Both follow/join lists are capped at **400 entries**. The binding constraint is the created-community list (kind `10004`): each `["a","34550:<64-hex>:<dtag>"]` entry is ~110 bytes, so 400 ≈ 44 KB of tags — safely inside a 64 KB relay event limit. The same count is applied to the word list (kind `10044`, ~30 bytes/entry), which is far smaller at that size.

### 20.2 Created Communities (NIP-72)

Standard [NIP-72](https://github.com/nostr-protocol/nips/blob/master/72.md):
- **Definition:** kind `34550` — `d` (identifier), `name`, `description`, `image` (icon), `banner` (wide image), `["content-warning","nsfw"]` (optional adult flag), `["p", pubkey, "", "moderator"]`, `["relay", url]`. Address `34550:<creator>:<id>` → naddr → handle **`c/<naddr>`**. The creator is always an implicit moderator.
- **Posts:** kind `1111`, top-level scoped to the community: `["A", addr] ["K", "34550"] ["P", creator]` (root) + `["a", addr] ["k", "34550"] ["p", creator]` (parent), `["subject", title]`, no `e`. So `{kinds:[1111], "#a":[addr]}` returns only top-level posts.
- **Comments:** identical to word-community comments (kind `1111` with `E/e` thread tags) — a comment's root is the **post**, not the community.
- **Approval:** moderators publish kind `4550` (content = the JSON of the approved post) referencing the post (`e`), author (`p`), post kind (`k`), and community (`a`). Clients honor approvals only from the community's defined moderators.
- **Followed communities:** NIP-51 kind `10004` (`["a", "34550:…"]` tags) — interoperable with other NIP-72 clients.

**Display rule:** a community feed has an **Approved / Pending** toggle anyone can switch. *Approved* lists moderator-approved posts (plus the viewer's *own*, so authors see their submission immediately); *Pending* lists not-yet-approved submissions. Moderators see an **Approve** action on pending posts; when a moderator posts, the client self-approves so it appears at once. The community header shows the **creator** (crown) and **moderators**; the creator can **Edit** the community (name/description/icon) and **add/remove moderators**, which republishes the kind-`34550` definition. The Moderated-tab home feed merges *approved* posts from the communities you've joined (kind `10004`).

Because creation is owned, multiple communities can share a name (`c/<naddr-A>` and `c/<naddr-B>` both named "gaming"), each with its own creator and moderators.

### 20.3 Reaction Sentiment & Sorting

Forum reactions are kind `7` (NIP-25). To support up/down style sorting while remaining compatible with reactions from other clients, each reaction's `content` is classified into a **positive** or **negative** bucket. A fixed set of contents is treated as negative; **everything else (including `+`, empty, and unknown emoji) is positive**:

```
negative = { -, 👎, 💩, 💀, ☠️, 🤮, 🤢, 🤡, 😡, 😠, 🤬, 😤, 😒, 🙄,
             😞, 😔, 😟, 😕, 🙁, ☹️, 😣, 😖, 😫, 😩, 😢, 😭, 💔, 🥴, 😬, 🖕 }
```

One reaction per author counts (latest wins). The two buckets are surfaced as **up / down** controls. Voting is **delete-then-react**: changing or removing a vote first publishes a NIP-09 (`kind 5`) deletion of the user's prior reaction, then (unless toggling off) publishes the new one — so a member always has at most one active reaction per target.

Sort modes (all **best-effort**, reordering only what was fetched):
- **New** — chronological by `created_at` (default).
- **Top** — by `(positive − negative)` reaction count, descending.
- **Hot** — by `(positive + negative)` total reaction count, descending.

### 20.4 Client UI

- **Left rail (Forum section):** `Feed` and `Notifications` nav items (mirrors Short Form). `Feed` opens the forum home.
- **Notifications** (forum and long-form each have their own page, scoped to their own type so they never cross-notify): replies on your posts/comments shown individually, and reactions **aggregated into 24-hour buckets** (one summary card per day) so a vote burst doesn't flood the page. The forum page is split by the *Open* / *Moderated* tabs; the long-form page is a single list.
- **Main feed:** tabbed by type, *Open* (word) and *Moderated* (NIP-72). With no community selected, *Open* shows the merged feed of your followed words and *Moderated* shows a community browser; selecting one forces its tab. Posts are labeled by source word (`w/…`) or community name.
- **Right rail (context tools):**
  - *Open:* `go to w/word`, your followed words, and a "from people you follow" discovery list (≤5 communities per followed person, ≤100 total, load-more).
  - *Moderated:* `Create community`, `Open by handle` (paste a `c/naddr…`), your created and joined communities, and a `Discover` list of other communities.
- **Handles** `w/<word>` and `c/<naddr>` are copy-able identifiers (resolved by pasting back into the client), not browser URLs. Long `c/naddr` handles are truncated in the UI but copy in full.
- **Proof of Work** is adjustable via a shield-icon button (showing the current difficulty) that opens a slider modal with a *reset to default* — for both the posting difficulty and the minimum view difficulty.
- **NSFW:** posts and communities are flagged with `["content-warning","nsfw"]` (NIP-36). A feed toggle (default *hidden*) shows/hides NSFW posts; the setting is shared across both tabs.
- **Thread view:** opening a post shows a right column with its source — the word community (follow) or created community (icon/banner/description, copy handle, join) — so you can jump back to the source feed.
- **Reply boxes** are multi-line text areas.
- **Live updates:** the active feed subscribes to new posts, and a thread subscribes to new comments and reactions, ingesting them in real time.
- **Render filter:** every post/comment passes the same gate as public chat: view-PoW threshold, blocked pubkeys, Web-of-Trust (`forum` context), and muted words. The same WoT threshold also drops below-threshold authors from **created-community discovery** (by creator) and from the **notification** pages (by actor). Word communities have no creator, so only their posts are WoT-filtered.

---

*This specification is a living document. Feedback and contributions are welcome.*
