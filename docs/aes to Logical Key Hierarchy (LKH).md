# Migration: Flat Per-Member AES → Logical Key Hierarchy (LKH)

> **Date**: 2026-03-26
> **Status**: Proposed
> **Affects**: NIP-CHAT §4 (Cryptographic Model), §5 (Blossom File System), §12 (Join/Removal Flow)

> **Hub format v2 (privacy) note.** v2 hubs keep this exact LKH tree — the key hierarchy,
> spine, pagination, and O(log N) re-key are unchanged. v2 only layers privacy on top: leaf
> identifiers become per-hub **pseudonyms `P`**, and each **page** carries a group-encrypted,
> epoch-stamped **roster segment** (`{P:R}` under `HKDF(hub_secret_epoch, "roster:epoch:<epoch>")`) — one AES op
> per page, forward-secret across kicks/rotations. The **leaf pages stay plaintext** (keyed
> on the unlinkable `P`), so the hub-secret bootstrap and binary search are unchanged — the
> page *is* the tree that distributes the hub secret, so encrypting it whole would be
> undecryptable before you hold the secret. The **ban page** is encrypted and stores real keys
> `R`. The v1→v2 change is **not** an in-place migration like the one below — it is a **fork**
> to a fresh hub (v1 plaintext history cannot become v2 ciphertext, and the owner authors v2
> under a different key `O`). See NIP-CHAT §0/§12.

---

## Why the Change

### Problem

The original NIP-CHAT spec uses **flat per-member encryption**: for each member, the creator performs `ECDH(creator_sk, member_pk) → HKDF → AES-encrypt(hub_secret)`. This has two scaling bottlenecks:

1. **Member Removal (Secret Rotation)**: When a member is removed, the hub secret must be rotated. The creator must re-encrypt the new secret for every remaining member. For a hub with 1M members, this is **1M ECDH + 1M AES operations** — feasible locally (~seconds) but impractical via a remote signer.

2. **Remote Signer Incompatibility**: The ECDH+HKDF+AES pipeline requires the creator's raw private key. Remote signers (NIP-46, NIP-PC55, NIP-UPV2) only expose `nip04.encrypt/decrypt` APIs — they cannot perform raw ECDH or HKDF. This means hubs created with a local key produce ciphertexts that signers cannot decrypt, and vice versa.

### Solution

Replace flat per-member encryption with a **Logical Key Hierarchy (LKH)** — a balanced binary tree of symmetric keys. This reduces secret rotation from O(N) to O(log N) and eliminates the remote signer bottleneck for rekey operations.

---

## What Changed

### Before (Flat Per-Member AES)

```
Creator encrypts hub_secret individually for each member:

  For each member:
    shared = ECDH(creator_sk, member_pk)
    key = HKDF(shared, salt, hub_d_tag)
    encrypted = AES-GCM(key, hub_secret)

Member file row:
  pubkey, roles, encrypted_hub_secret, creator_cache
```

- **Adding a member**: 1 ECDH + 1 HKDF + 1 AES
- **Removing a member (rekey)**: N × (AES decrypt cache + AES encrypt new secret)
- **Remote signer support**: ❌ (ECDH inaccessible)

### After (LKH Tree)

```
Members are leaves of a balanced binary tree:

               [Root Key] → encrypts hub_secret
              /            \
         [Node A]        [Node B]
         /     \          /     \
       ...     ...      ...     ...
       M1  M2  M3  M4  M5  M6  M7  M8

Leaf level:   NIP-04 encrypt (works with any signer)
Internal:     AES-256-GCM (symmetric, no signer needed)
```

- **Adding a member**: 1 NIP-04 encrypt + ~log₂(N) AES operations
- **Removing a member (rekey)**: ~log₂(N) AES operations + **0 signer calls**
- **Remote signer support**: ✅ (NIP-04 at leaf level only)

---

## How LKH Works

### Tree Structure

Members are arranged as leaves of a balanced binary tree. Each node (internal or leaf) has a randomly generated symmetric key.

- **Leaf keys** are encrypted to the member's pubkey using **NIP-04** (works with both raw private keys and remote signers)
- **Internal node keys** are encrypted with **AES-256-GCM** using their children's keys
- **The root key** encrypts the hub secret

### Member Decryption Path

A member walks UP the tree from their leaf to the root:

1. **Leaf**: Decrypt their leaf key using NIP-04 (1 signer call)
2. **Internal nodes**: Use the child key to AES-decrypt the parent key (~20 steps for 1M members)
3. **Root**: Use root key to AES-decrypt the hub secret

### Adding a Member

1. Create a new leaf node with a random key
2. NIP-04 encrypt the leaf key for the member's pubkey (1 signer call)
3. Update internal node keys up the path (AES, local)
4. Upload updated tree file to Blossom and update hub event

### Removing a Member

1. Delete the member's leaf node
2. Re-generate new random keys for every node on the path from the removed leaf to root
3. At each level, AES-encrypt the new node key with the **sibling's unchanged key**
4. Generate a new hub secret (new epoch), encrypt with new root key
5. Upload updated tree file, update hub event with new epoch

> [!IMPORTANT]
> **Zero NIP-04 / signer calls during removal.** All re-keying uses symmetric AES with keys the creator already holds. Only 2 signed events total: Blossom upload auth + hub event update.

---

## Performance Comparison

### Secret Rotation (Member Removal)

| Hub Size | Flat (Before) | LKH (After) |
|----------|---------------|-------------|
| 1,000 | 1,000 operations | ~10 AES operations |
| 100,000 | 100,000 operations | ~17 AES operations |
| 1,000,000 | 1,000,000 operations | ~20 AES operations |
| 10,000,000 | 10,000,000 operations | ~23 AES operations |

### Remote Signer Compatibility

| Operation | Flat (Before) | LKH (After) |
|-----------|---------------|-------------|
| Member decrypts hub secret | ❌ Incompatible | ✅ 1 NIP-04 decrypt |
| Creator adds member | ❌ Incompatible via signer | ✅ 1 NIP-04 encrypt |
| Creator removes member (rekey) | ❌ N signer calls | ✅ 0 signer calls |

---

## Blossom File Format Change

### Before: Flat CSV

```
<pubkey>,<roles>,<encrypted_hub_secret>,<creator_cache>
<pubkey>,<roles>,<encrypted_hub_secret>,<creator_cache>
...
```

### After: LKH Tree File

The tree file uses a line-based format with three section types:

```
# Leaf nodes (member pubkeys + NIP-04 encrypted leaf key)
leaf:<node_id>:<member_pubkey>:<roles>:<nip04_encrypted_leaf_key>

# Internal nodes (AES-encrypted node key, one blob per child)
node:<node_id>:<parent_id>:<aes_encrypted_with_left_child>:<aes_encrypted_with_right_child>

# Root (AES-encrypted hub secret)
root:<node_id>:<aes_encrypted_hub_secret>
```

Members download the tree, find their leaf by pubkey, and walk up to the root.

---

## Impact on Other Spec Sections

| Section | Change |
|---------|--------|
| §4.1 Overview | Replace ECDH+HKDF+AES diagram with LKH tree diagram |
| §4.2 Domain Separation | Remove (NIP-04 handles key isolation) |
| §4.3 Hub-Wide Secret | Unchanged (hub secret still exists, just encrypted differently) |
| §4.5 Secret Rotation | Update: O(N) → O(log N), describe tree re-keying |
| §5.2 Member/Key File Format | Replace flat CSV with LKH tree file format |
| §5.3 Creator Self-Key | Remove (creator stores node keys in the tree itself) |
| §5.6 Grouped Role Key Files | Same LKH approach, separate tree per group |
| §5.7 Mesh Lists | Mesh list maintainers build their own trees |
| §5.8 Pagination | Replace with tree balance management |
| §9.4 Handling Secret Rotation | Update client behavior for tree-based re-keying |
| §11.1 Threat Model | Update ECDH row to reflect NIP-04 + LKH |
| §12 Removal Flow | Update to describe tree re-keying |

---

## Tree Maintenance

### Rebalancing

If many members are added/removed without rebalancing, the tree could become lopsided (one branch deeper than another). This is handled by:

1. **Client-side**: Our client maintains a balanced tree on every operation
2. **"Fix Encryption" button**: Creator can trigger a full tree rebuild (N NIP-04 operations) as a repair tool
3. **Other clients**: If a third-party client creates an unbalanced tree, any admin can rebuild it

### Batch Removal

When removing multiple members at once, the client SHOULD:

1. Mark all leaves for removal
2. Compute the **deduplicated set** of affected internal nodes (union of all paths)
3. Re-key each affected node **once**
4. Total: still O(log N) for the deepest path, with overlapping paths merged

---

## Backward Compatibility

> [!CAUTION]
> This is a **breaking change** to the Blossom file format. Old-format member files (flat CSV rows with ECDH-encrypted secrets) are not compatible with the LKH tree format.

Since DEN Chat has not been publicly released, this is acceptable. No migration path is needed for existing data.

---

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Encryption scheme | ECDH + HKDF + AES per member | LKH tree (NIP-04 at leaves, AES internally) |
| Member removal cost | O(N) | O(log N) |
| Signer calls on removal | N | 0 |
| Remote signer compatible | ❌ | ✅ |
| File format | Flat CSV | Tree structure |
| Complexity | Low | Medium |

---

## Why LKH and Not MLS?

[MLS (Messaging Layer Security)](https://messaginglayersecurity.rocks/) is a protocol designed for end-to-end encrypted group messaging (RFC 9420). It uses a similar tree structure (TreeKEM) for key management. Here's why we chose LKH over MLS:

### 1. Nostr Signer Incompatibility

MLS requires each member to perform **cryptographic operations** (key package generation, commit signing, HPKE decryption) using their private key. Nostr remote signers (NIP-46, NIP-PC55, NIP-UPV2) only expose **NIP-04** and **NIP-44** — they cannot perform MLS-specific operations like HPKE or TreeKEM commits.

LKH uses **NIP-04 at the leaf level**, which every Nostr signer already supports. Internal tree operations are symmetric AES — handled entirely by the hub creator without any signer interaction.

### 2. Creator-Centric vs. Collaborative

MLS is designed for **collaborative** groups where every member can propose changes (adds, removes, updates). This requires each member to maintain state, process commits, and handle epoch transitions.

NIP-CHAT hubs are **creator-centric**: one creator (or delegated mods) manages membership. Members only need to decrypt — they never modify the tree. LKH fits this model perfectly: the creator manages the tree locally, members just download and walk it.

### 3. Stateless Members

MLS requires every member to **track state** — they must process every commit in order, or they fall out of sync (requiring a re-join). This is fragile for Nostr, where clients go offline frequently and relay connectivity is unreliable.

With LKH, members are **stateless**. They download the latest tree file from Blossom, find their leaf, and walk to the root. No commit history needed, no ordering requirements, no risk of desynchronization.

### 4. No New Dependencies

MLS requires a full MLS library implementation (or binding to one like OpenMLS). This adds significant complexity, binary size, and a large attack surface.

LKH uses only **NIP-04** (already in every Nostr client) and **AES-256-GCM** (Web Crypto API, built into every browser). Zero new dependencies.

### 5. Distribution Model

MLS assumes a **delivery service** that reliably delivers commits to all members in order. Nostr relays don't guarantee ordering or delivery.

LKH uses **Blossom** (file hosting) for distribution — members download the tree file at their own pace. The file is immutable (SHA-256 verified), so there's no ordering concern. The hub event's `epoch` tag tells clients when to re-download.

### Summary

| Aspect | MLS | LKH |
|--------|-----|-----|
| Signer compatibility | ❌ Requires HPKE/TreeKEM | ✅ NIP-04 only |
| Member state | Stateful (must track commits) | Stateless (download + decrypt) |
| Management model | Collaborative | Creator-centric |
| Dependencies | MLS library required | NIP-04 + AES (already present) |
| Distribution | Ordered delivery service | Blossom file download |
| Complexity | Very high | Medium |
| Forward secrecy | ✅ Per-epoch | ✅ Per-epoch (via secret rotation) |
