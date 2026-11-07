# NIP-SKD worked example: a group-chat consumer (NIP-CHAT v2)

`informational` `non-normative`

> This document is a companion to [NIP-SKD](./NIP-SKD.md). It is **not** part of the NIP-SKD
> standard: it is a worked example showing how one consumer (NIP-CHAT v2) uses all three
> derivation forms end to end. The normative derivation, operations, security invariants, and
> test vectors live in NIP-SKD itself. Section references (§1.2, §2, etc.) point into NIP-SKD.

## Reference consumer: NIP-CHAT v2

NIP-CHAT v2 uses **self** (for the owner) and **blinded** (for members and the join address). It does
**not** use the `shared` form.

- **Owner pseudonym `O`** (self): `context = "nip-chat:v2:owner-pseudonym:" + d_tag`, `IKM =
  R_owner_priv`. The hub is authored by `O`, so the creator's real key never appears publicly.
- **Member pseudonym `P`** (blinded): `context = "nip-chat:v2:member-pseudonym:" + d_tag`, base = the
  member's `R`, peer = `O_pub`. The member holds `P_priv = R_priv + t` (and signs as `P`). The owner
  re-derives the same `P_pub` via **`getPeerBlindedPubkeyViaSelf`** (`viaContext` = the owner-pseudonym
  context, `context` = the member-pseudonym context, `peer` = `R_pub`), where the ECDH runs on the
  owner's **pseudonym** `O`, not the owner's root (§1.2). This is used for owner-verification, leaf
  placement, and squat-resistance, but the owner **cannot** obtain `P_priv`, so cannot impersonate the
  member.
- **Facilitated pseudonym `Pf`** (blinded): the same construction one level down. Base = the
  facilitated user's `R`, peer = the facilitator's member pseudonym `P_fac`. The facilitator re-derives
  `Pf_pub` via **`getPeerBlindedPubkeyViaBlinded`** (`viaContext` = the facilitator's member-pseudonym
  context, `viaPeer` = `O_pub`, `context` = the facilitated-pseudonym context, `peer` = `R_f_pub`) but
  cannot act as `Pf`.
- **Join address** (blinded): a per-join key, base = the applicant's `R`, peer = `O_pub`. The owner
  re-derives it from `R_pub` (after opening the sealed `R`) via `getPeerBlindedPubkeyViaSelf` (same as
  the member case, with the join-addr context) to confirm the applicant controls `R`.

The member **and** owner sides, and the facilitated **and** facilitator sides, are all used through §2
sub-signer operations on remote signers, or derived directly on a local key. In particular the composed
verifier ops (§1.2) let the **owner** (ViaSelf) and **facilitator** (ViaBlinded) roles run on a
remote/browser signer, not only on a local key: the intermediate pseudonym private (`O`/`P_fac`) is
derived inside the signer and never leaves it. See NIP-CHAT §0.1, §4.5, §6.3.
