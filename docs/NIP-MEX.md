# NIP-MEX: Nostr Integration for Markup Extensions (MEX)

## Abstract
This NIP defines how Nostr clients declare which **Markup Extensions (MEX)** formatting dictionary a rich-text event complies with, so a standard-aware client loads the right token set and a legacy client degrades safely. The MEX syntax, base model, versioning, lineage laws, governance, and file format are defined entirely by the standalone MEX specification (MEX-CORE and the per-base lineages that descend from it). This NIP only covers transport: how an event advertises its MEX baseline.

Where MEX specification files are hosted, fetched, and verified is left to the implementor. Verification of a lineage is a one-time, on-adoption step (see MEX-CORE, File Format), not something a client repeats per event.

## The `mex` tag
A rich-text event (for example `kind: 30023` long-form, or `kind: 1` notes) declares its formatting baseline with a single tag:

```json
["mex", "<base>", "<version>", "<lineage>", "<hash>", "<signature>"]
```

- **`"mex"`**: the literal marker identifying this as an MEX declaration.
- **`<base>`**: the base (L1) markup family the content is written in, for example `"markdown"` or `"djot"`. It is the dispatch discriminator: a client that does not support the base degrades immediately, without resolving anything else.
- **`<version>`**: the MEX version the content complies with (`"0"`, `"1"`, ...), within that base's lineage.
- **`<lineage>`**: the npub (or hex pubkey) identifying **which lineage** of the specification the content uses. Under MEX's adoption-based governance, more than one lineage (fork) can reach the same version number on the same base, so the lineage pubkey tells a client which lineage the content follows. For the most-adopted lineage this is the base profile's genesis author or the successor the ecosystem has adopted.
- **`<hash>`**: the targeted version file's `file_sha256`. This is what actually *selects* the dictionary: `base` + `version` + `lineage` can still be ambiguous if one author published more than one file under the same version number, but the hash pins the declaration to one exact, immutable specification (and, transitively, the exact L1 version). A client matches it against the dictionary it verified on adoption.
- **`<signature>`**: the lineage author's signature of that `hash`, copied from the spec file's seal. These fields mirror the five-field document declaration defined in MEX-CORE (Declaring MEX in a document).

### Why the signature is carried
The signature lives in the spec file's **seal**, outside the signed region, so it is **not** covered by `hash` and cannot be reconstructed from it. Carrying it on the event is not render-time bloat: it is **redundancy**. Nostr events are replicated across many relays, so propagating the signature with the content makes a lineage's attestation durably available in the wild. If the origin spec file or its seal is ever lost, the signature survives, distributed across the corpus, and the chain stays verifiable. What is deliberately **not** carried is the full `prev_hash`/`prev_signature` *chain*: that is a property of the specification lineage, walked once on adoption, not of each event.

## Example event (MEX base markdown, version 1)
```json
{
  "id": "7b794f83733e84a2754c0926d8339ef6b7b212f43f019f1807d4b4a180f128af",
  "pubkey": "fa01b38f83723de4bca89d124fa489110d9cf34560a891823efca471829e01f2",
  "created_at": 1791631500,
  "kind": 30023,
  "tags": [
    ["d", "universal-formatting-mex"],
    ["title", "Decentralized Typography via Protocol Tags"],
    ["mex", "markdown", "1", "npub1_lineage_author...", "file_sha256_of_target_version...", "sig_of_that_hash_by_lineage_author..."]
  ],
  "content": "Using MEX I can &&underline&& text, hide a ||secret plot point||, {=highlight an idea=}, show a localized {t:2026-06-10T12:00:00Z}, and align a {>centered title<} or a {>signed line>} without breaking legacy, un-updated clients."
}
```

## Client compatibility and graceful degradation
A legacy, MEX-unaware client stays safe with zero corruption:
- It ignores the unknown `"mex"` tag (relays and clients ignore tags they do not index).
- The raw tokens (for example `&&underline&&`, `||spoiler||`, `{t:2026-06-10T12:00:00Z}`) print as plain text. Because the tokens are compact and timestamps are ISO 8601 UTC instants, the content stays human-readable.

A standard-aware client that does not support the declared `(base, version, lineage)` MUST behave the same way: render the tokens as readable plain text rather than partially transform them. A client that does not support the declared `base` at all degrades on that field alone, without resolving the lineage or hash.

## Relationship to the MEX specification
This NIP is transport only. The authoritative definitions of the base model, the lineage laws, the adoption governance model, and the file format (including the signed-region canonicalization and the seal) live in the base-agnostic core (`MEX-CORE`), and each token is defined in a per-base lineage (for the Markdown base, `MEX-0` binds the base and `MEX-1` onward define the tokens). A Nostr client implements MEX by compiling a verified version dictionary from those files and mapping the `mex` tag to it.
