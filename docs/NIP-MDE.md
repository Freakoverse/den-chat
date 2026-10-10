# NIP-MDE: Nostr Integration for Markdown Extensions (MDE)

## Abstract
This NIP defines how Nostr clients declare which **Markdown Extensions (MDE)** formatting dictionary a rich-text event complies with, so a standard-aware client loads the right token set and a legacy client degrades safely. The MDE syntax, versioning, lineage laws, governance, and file format are defined entirely by the standalone MDE specification (MDE-0 and its lineage). This NIP only covers transport: how an event advertises its MDE baseline.

Where MDE specification files are hosted, fetched, and verified is left to the implementor. Verification of a lineage is a one-time, on-adoption step (see MDE-0, File Format), not something a client repeats per event.

## The `mde` tag
A rich-text event (for example `kind: 30023` long-form, or `kind: 1` notes) declares its formatting baseline with a single tag:

```json
["mde", "<version>", "<lineage>"]
```

- **`"mde"`**: the literal marker identifying this as an MDE declaration.
- **`<version>`**: the MDE version the content complies with (`"0"`, `"1"`, ...).
- **`<lineage>`**: the npub (or hex pubkey) identifying **which lineage** of the specification the content uses. Under MDE's adoption-based governance, more than one lineage (fork) can reach the same version number, so the lineage pubkey tells a client exactly which token dictionary to apply. For the most-adopted lineage this is the genesis author or the successor the ecosystem has adopted.

### Why the tag is lean
A deliberately minimal tag. The `prev_hash` and `prev_signature` of the cryptographic lineage are properties of the **specification version**, not of each event, so repeating them on every note would be pure bloat and would buy nothing at render time: a client that supports version N already holds that version's verified, compiled dictionary. The full chain is carried by the signed MDE spec files and verified once, on adoption. An event therefore needs only enough to pick the right dictionary: `version` plus `lineage`.

## Example event (MDE version 1)
```json
{
  "id": "7b794f83733e84a2754c0926d8339ef6b7b212f43f019f1807d4b4a180f128af",
  "pubkey": "fa01b38f83723de4bca89d124fa489110d9cf34560a891823efca471829e01f2",
  "created_at": 1791631500,
  "kind": 30023,
  "tags": [
    ["d", "universal-formatting-mde"],
    ["title", "Decentralized Typography via Protocol Tags"],
    ["mde", "1", "npub1_lineage_author..."]
  ],
  "content": "Using MDE I can &&underline&& text, hide a ||secret plot point||, {=highlight an idea=}, show a localized {t:2026-06-10T12:00:00Z}, and align a {>centered title<} or a {>signed line>} without breaking legacy, un-updated clients."
}
```

## Client compatibility and graceful degradation
A legacy, MDE-unaware client stays safe with zero corruption:
- It ignores the unknown `"mde"` tag (relays and clients ignore tags they do not index).
- The raw tokens (for example `&&underline&&`, `||spoiler||`, `{t:2026-06-10T12:00:00Z}`) print as plain text. Because the tokens are compact and timestamps are recommended in ISO 8601, the content stays human-readable.

A standard-aware client that does not support the declared `(version, lineage)` MUST behave the same way: render the tokens as readable plain text rather than partially transform them.

## Relationship to the MDE specification
This NIP is transport only. The authoritative definitions of each token, the lineage laws, the adoption governance model, and the file format (including the signed-region canonicalization and the seal) live in the MDE specification files (`MDE-0`, `MDE-1`, and successors). A Nostr client implements MDE by compiling a verified version dictionary from those files and mapping the `mde` tag to it.
