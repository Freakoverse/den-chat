# NIP-CHAT: Decentralized Hub-Based Chat Protocol for Nostr

> **Status**: Draft v3  
> **Depends on**: NIP-01, NIP-13, NIP-44

---

## 1. Overview

NIP-CHAT defines a decentralized, hub-based chat system built on Nostr. It provides Discord-like functionality — hubs, channels, categories, roles, permissions — without relying on trusted servers for core operations.

### 1.1 Design Philosophy

- **Encrypted by default.** All hub messages are encrypted with a hub-wide shared secret. Non-members cannot read content. Users should understand: *"messages are encrypted, but any member could leak them — treat it like a private group chat, not a vault."*
- **Anyone can post.** The protocol layer does not gatekeep who can publish events to a channel. Filtering is a client-side (or filter-relay-side) rendering decision based on member lists.
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

A hub is represented by a **single addressable replaceable event** (kind `36942`). The creator's pubkey is the hub owner. Updating the hub (renaming a channel, adding a role, etc.) means publishing a new version of this event with the same `d` tag.

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

General relays store:
- Hub events (kind `36942`)
- Join request events (kind `36944`)

These events are **always public** and meant for discoverability and coordination. Any standard Nostr relay can serve as a general relay.

### 3.2 Filter Relays (`filter`)

Filter relays are **optional, specialized relays** that store channel messages (kind `36943`), poll events (kind `1067`), vote events (kind `1017`), and report events (kind `36948`). When a hub defines one or more filter relays:

- **Messages MUST be published ONLY to filter relays**, not to general relays
- The filter relay maintains a copy of the creator's member list
- The filter relay **rejects posts** from pubkeys not on the creator's member list
- The filter relay **removes stored posts** of members who are removed from the creator's list
- The filter relay **refuses to serve messages** to pubkeys not on the creator's member list (NIP-42 AUTH)

This provides:
- Spam prevention (non-members can't post)
- Privacy (non-members can't access even the encrypted blobs)
- Reduced client processing (relay does the filtering)

#### 3.2.1 Trust Model for Filter Relays

Filter relays are trusted to:
- Honestly enforce membership-based access
- Stay online and serve messages

Filter relays are **NOT** trusted to:
- Read message content (messages are encrypted with the hub secret)
- Decide membership (creator's list is the source of truth)
- Be the sole relay (multiple filter relays are supported)

#### 3.2.2 When No Filter Relay Is Defined

If the hub event contains no `filter` relay tags:
- Messages are published to `general` relays
- Messages are still encrypted (hub-wide secret), but the encrypted blobs are publicly visible
- Client-side filtering by member lists determines what is rendered
- The client SHOULD display a notice: *"This hub has no filter relay. Messages are encrypted but visible to anyone (even non-members). Metadata (who posted, when) is not protected."*

### 3.3 Blossom Servers

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

### 3.4 Architecture Summary

| Type | Stores | Access Control | Required |
|------|--------|---------------|----------|
| `general` relay | Hub event, join requests | None (public) | Yes (≥1) |
| `filter` relay | Channel messages, reports | Membership-gated (NIP-42 AUTH) | Optional |
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

#### 5.2.1 Leaf Page File (Paginated)

Each leaf page is a self-contained subtree of up to `PAGE_SIZE` (10,000) members. The file is line-based:

```
leaf:<node_id>:<member_pubkey>:<role_ids>:<nip04_encrypted_leaf_key>[:<flags>]
node:<node_id>:<left_child_id>:<right_child_id>:<aes_encrypted_with_left>:<aes_encrypted_with_right>
page-root:<node_id>:<left_child_id>:<right_child_id>:<aes_encrypted_with_left>:<aes_encrypted_with_right>
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

### 5.6 Mesh Lists (Facilitation)

Any member can maintain their OWN Blossom LKH tree file for the hub, enabling them to act as a **facilitator** — granting non-members access to encrypted hub messages.

- They build their own tree with their own members as leaves
- Leaf keys are NIP-04 encrypted using THEIR keypair (not the creator's)
- The hub secret distributed is the same one they obtained from the creator's tree
- Tree + index files are uploaded to the hub's Blossom servers (and optionally the facilitator's own servers for redundancy)
- Discovery: the facilitator adds a `["list", "<sha256_of_index_file>"]` tag to their join request (kind `36944`); see §6.3
- Their files are NOT referenced in the hub event

The creator's list (in the hub event's `m` tag) remains the canonical source. Filter relays use only the creator's list.

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
    ["epoch", "<epoch_number>"],
    ["b", "<on|off>"],
    ["r", "wss://relay1.example.com", "general"],
    ["r", "wss://relay2.example.com", "general"],
    ["r", "wss://filter.example.com", "filter"],
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
| `w` | No | Minimum PoW difficulty (NIP-13). Messages MUST include a `nonce` tag meeting this difficulty. Clients SHOULD hide messages below this threshold. Useful for spam prevention in hubs without filter relays. Clients discovering hubs can filter by `#w` to find hubs with specific difficulty levels. |
| `epoch` | Yes | Current hub-wide secret epoch. Incrementing integer starting at `1`. Increments only on secret rotation (member removal or a user being added to the block list). |
| `b` | No | DNN ID requirement (`on`/`off`). Default: `off`. |
| `r` | Yes | Relay. Third value is `general` or `filter`. At least one `general` MUST be defined. |
| `o` | Yes | Blossom server URL. Recommend ≥3 for redundancy. Used for member files and media. |
| `m` | Yes | Index file reference: `["m", "<sha256>", "<epoch>"]`. |
| `t` | No | Discoverable topic tag (e.g., `["t", "gaming"]`). Multiple `t` tags allowed. Clients can query hubs via `#t` filters for hub discovery. |
| `content-warning` | No | NIP-36: marks the hub as containing sensitive/NSFW content. Value is an optional reason string (may be empty). Clients SHOULD blur or hide NSFW hubs unless the user has opted in. |
| `L` | Conditional | NIP-32: label namespace. Set to `"content-warning"` when the `content-warning` tag is present, enabling relay-side querying via `#L` filters. Required if `content-warning` is present. |
| `f` | No | Discoverability flag (`on`/`off`). Default when absent: `on`. When `off`, compliant clients SHOULD NOT display this hub in public search, browse, or discovery UIs. This is a **client-side convention** — it does not hide the event from relays. Clients can filter relay queries with `#f` to efficiently fetch only discoverable hubs. |
| `published_at` | Yes | Unix timestamp of the original hub creation. On first publish, set to the same value as `created_at`. On subsequent updates, carry forward the original value unchanged. This provides a stable ordering timestamp for hub discovery and display, since `created_at` drifts with each update. |
| `client` | No | Name of the client application that created or last updated this hub (e.g., `"DEN Chat"`). Used for discovery filtering — users can search for hubs created by a specific client. Clients SHOULD include this tag for discoverability. |

#### Updating Hub Events (`created_at` Increment)

Hub events are addressable replaceable events that get updated frequently (settings changes, member list rotation, epoch bumps, etc.). When publishing an updated hub event, the client MUST set `created_at` to the **previous event's `created_at` + 1** — the same increment rule used for message edits (see §6.2, Editing Messages).

This prevents the hub event from jumping to the current wall-clock time on every update, which would cause discovery UIs that sort by `created_at` to incorrectly show old hubs as "recently created." Clients and discovery aggregators SHOULD sort hubs by `published_at` for display ordering, not `created_at`.

#### Content (JSON)

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

- If the hub defines **filter relays**: publish ONLY to filter relays.
- If the hub defines **no filter relays**: publish to general relays.
- MUST NOT publish to both types simultaneously.

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

- If the hub has a `w` tag with difficulty > 0, the join request MUST include a `nonce` tag with PoW meeting the hub's difficulty.

- `d` tag makes this replaceable (one request per user per hub).
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
| `v` | Yes | Hub reference. Values: `["v", "<hub_d_tag>", "<relay_hint>", "<position>" or "<position>:<folder_uuid>"]`. Position is an integer determining display order. If `position:folder_uuid` format, the hub belongs to that folder. |
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

- Published to the **same relays as messages** (filter relays if defined, otherwise general relays)
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

- Published to the **same relays as messages** (filter relays if defined, otherwise general relays)
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

Same as messages (§6.2): publish to filter relays if defined, otherwise to general relays.

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

##### Filter Relay Considerations

Filter relays MUST accept kinds `1067`, `1017`, and `36948` in addition to kind `36943` when the event carries an `h` tag or `a` tag matching a hub they serve. The same membership-based access rules apply: only hub members can publish or retrieve poll, vote, and report events.

---

### 6.10 Hub Report — Kind `36948`

**Type**: Addressable Replaceable Event

Published by a member to report another user within a hub. Reports are private — encrypted with the hub secret — and visible only to hub members. Because they are addressable replaceable events, a reporter can retract a report by re-publishing with the same `d` tag and status set to `"retracted"`.

```json
{
  "kind": 36948,
  "pubkey": "<reporter_pubkey>",
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
| `p` | Yes | Pubkey of the **reported user** (the violator). |
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

- Published to the **same relays as messages** (filter relays if defined, otherwise general relays)
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

- Published to **hub relays** (filter relays if defined, otherwise general relays)
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

#### Filter Relay Support

Filter relays MUST accept kinds `31923` and `31925` in addition to kind `36943` when the event carries an `h` tag matching a hub they serve. The same membership-based access rules apply: only hub members can publish or retrieve calendar events and RSVPs.

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

## 7. Member List Mechanics

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

### 7.4 Filter Relay List Handling

Filter relays use **only the creator's member file and ban list** for access control. They do NOT use mesh lists. The creator remains sole authority for relay-level access.

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

Permissions determine what a compliant client renders. A malicious client can ignore them. For actual access control, use encryption (hub secret / group secrets) and filter relays.

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

This is a **client-side UX decision** — it does not prevent a malicious client from publishing events. For actual enforcement, use filter relays (§3.2) which reject posts from non-members at the relay level.

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

This prevents cache pollution from events published by unauthorized clients to general relays (where no filter relay is protecting the channel).

---

## 10. Filter Relay Behavior

### 10.1 Setup

1. Hub creator adds the relay via `["r", "wss://...", "filter"]` tag.
2. Relay fetches the hub event from general relays.
3. Relay downloads the index file and member/block files from Blossom (using `o` and `m` tags).
4. Relay builds and maintains an internal member index.

### 10.2 Write Policy

When a message (kind `36943`) is published:
1. Check if `pubkey` is on the creator's member list and NOT on the block list.
2. YES → accept and store.
3. NO → reject with `OK false`.

### 10.3 Read Policy

When a client subscribes (NIP-42 AUTH):
1. Check if subscribing pubkey is on the creator's member list and NOT blocked.
2. YES → serve matching events.
3. NO → return no results.

### 10.4 List Updates

- Relay SHOULD poll the hub event on general relays for `m` tag changes.
- When the index file hash changes: download new index, download changed pages, update internal member index.
- **Members removed**: denied future reads/writes. Existing posts by removed members are **deleted** from the relay.
- **Members added**: granted access immediately.

### 10.5 Multiple Filter Relays

All filter relays follow the same creator member and block files. Clients SHOULD publish to all filter relays for redundancy.

---

## 11. Security Model & Tradeoffs

### 11.1 Threat Model

| Threat | Mitigation |
|--------|-----------|
| Non-member reads messages | Hub secret encryption. Filter relay prevents access to ciphertext. |
| Non-member posts | Filter relay rejects. Without filter relay, client-side filtering. |
| Kicked member reads future messages | Secret rotation. New epoch secret not available to removed members. |
| Kicked member reads historical messages | History file re-encrypted with new secret. Removed member can't decrypt. |
| Relay reads content | AES-256-GCM encryption. Relay sees only ciphertext. |
| Member leaks hub secret | All members can read — secret protects against outsiders only. By design. |
| Creator goes rogue | Mesh lists allow community to follow alternative list maintainers. |
| Blossom server tampers with files | SHA-256 hash verification. Multiple Blossom servers for redundancy. |
| Key isolation from DMs | NIP-04 at leaf level uses the same key-agreement as DMs, but the encrypted payload (leaf symmetric key) is hub-specific and meaningless outside the tree context. |

### 11.2 Explicit Non-Goals

- **Forward secrecy** — current members can decrypt all historical messages via the history file. This is intentional (Discord model).
- **Instant cryptographic revocation** — there is a window between removal and secret rotation.
- **Protocol-level permission enforcement** — permissions are client-side rendering decisions only.
- **Protection against members** — the hub secret protects against outsiders. Any current member can leak content.

### 11.3 Security Tiers

| Configuration | Privacy Level |
|--------------|--------------|
| Hub secret only (no filter relay) | Encrypted content, public metadata |
| Hub secret + filter relay | Encrypted content, gated access |
| Grouped role secret | Additional isolation for specific channels |
| Grouped role secret + filter relay | Maximum privacy for sensitive channels |

---

## 12. Join Flow

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
  → Filter relay removes kicked user's posts
  → Remaining members walk tree with updated keys to get new hub secret
  → Removed user can no longer decrypt new or historical messages
```

---

## 13. Event Kind Summary

| Kind | Name | Type | Published To |
|------|------|------|-------------|
| `36942` | Hub Event | Addressable Replaceable | General relays |
| `36943` | Message | Addressable Replaceable | Filter relays (if defined) or General relays |
| `26943` | Message Edit Hint | Ephemeral | Filter relays (if defined) or General relays |
| `36944` | Join Request | Addressable Replaceable | General relays & hub's relays |
| `36945` | Channel Pin List | Addressable Replaceable | Filter relays (if defined) or General relays |
| `36946` | Voice Host Availability | Addressable Replaceable | Filter relays (if defined) or General relays |
| `36947` | Voice Presence Heartbeat | Addressable Replaceable | Filter relays (if defined) or General relays |
| `36948` | Hub Report | Addressable Replaceable | Filter relays (if defined) or General relays |
| `31923` | Calendar Time Event (NIP-52) | Addressable Replaceable | Filter relays (if defined) or General relays |
| `31925` | Calendar RSVP (NIP-52) | Addressable Replaceable | Filter relays (if defined) or General relays |
| `1067` | Poll | Regular | Filter relays (if defined) or General relays |
| `1017` | Vote | Regular | Filter relays (if defined) or General relays |
| `16942` | User Hub List | Replaceable | User's own relays |
| `1312` | Public Chat Message | Regular | User's relays (§16) |
| `30078` | Public Chat Topic List (NIP-78) | Addressable Replaceable | User's own relays (§16) |
| `14` | DM Rumor (NIP-17) | Unsigned (inside seal) | Never published directly (§17) |
| `15` | DM File (NIP-17) | Unsigned (inside seal) | Never published directly (§17) |
| `13` | Seal (NIP-17) | Signed | Never published directly (inside gift wrap) |
| `1059` | Gift Wrap (NIP-17) | Signed (throwaway key) | Sender's + recipient's relays (§17) |
| `10050` | DM Relay List (NIP-17) | Replaceable | User's own relays |

---

## 14. Tag Reference

| Tag | Used In | Description |
|-----|---------|-------------|
| `d` | Hub, Join Request, Pin List, Voice Host, Voice Presence, Report | Addressable replaceable identifier |
| `n` | Hub | Hub name |
| `w` | Hub | Minimum PoW difficulty (NIP-13) |
| `epoch` | Hub, Message, Poll, Vote, Report, Voice Host | Secret epoch number (incrementing integer) |
| `b` | Hub | DNN ID requirement flag |
| `r` | Hub | Relay (`general` or `filter`) |
| `o` | Hub | Blossom server URL |
| `m` | Hub | Index file reference: `["m", "<sha256>", "<epoch>"]` |
| `h` | Message | Hub `d` tag reference |
| `c` | Message, Voice Presence | Channel UUID |
| `e` | Message | Reply reference |
| `q` | Message | Quote reference |
| `nonce` | Message, Report | PoW nonce (NIP-13 format) |
| `list` | Join Request | Optional SHA-256 hash of the member's own Blossom index file (mesh list / facilitation discovery, §5.6) |
| `facilitator` | Message | Hex pubkey of the member who facilitated the sender's access to the hub secret (§5.6). Present only when the sender is not in the creator's member list. |
| `v` | User Hub List | Hub `d` tag with relay hint, position, and optional folder reference |
| `folder` | User Hub List | Folder group definition (UUID + name) |
| `content-warning` | Hub, Message | NIP-36: sensitive content flag. Value is an optional reason string. |
| `L` | Hub, Message | NIP-32: label namespace (set to `"content-warning"` for NSFW marking). |
| `deleted` | Hub, Message | Deletion fallback flag. `["deleted", "true"]` marks the event as request-deleted. Used when relays do not honor NIP-09 Kind 5 deletion. |
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
| Access Control | Membership + filter relays | Open to all |
| Identity | Hub member lists | Any Nostr keypair |
| Spam Prevention | Filter relay + PoW | PoW only |
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

*This specification is a living document. Feedback and contributions are welcome.*
