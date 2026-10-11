<!-- MDE-SIGNED-REGION-START -->
Author: npub1_CORE_AUTHOR_PLACEHOLDER (replace with the core author's npub before sealing)

# MDE-CORE: Markup Extensions, Base-Agnostic Core (Genesis)

## Abstract
Markup languages are the ubiquitous baseline for plain-text authoring, but they share two structural gaps: they have no versioning, and their syntax symbols are hardcoded. There is no sanctioned way to add new elements over time without risking breakage for older documents, and no audit trail for who defined what. The result is a fragmented field of mutually incompatible "flavors" with no shared lineage.

This document defines **Markup Extensions (MDE)**: an additive, version-controlled, adoption-governed formatting layer that sits on top of a base markup language. MDE is a **Layer 2** that never modifies **Layer 1** (the base markup). L1 rules are left completely untouched; MDE only adds new, non-colliding tokens that L1 does not process.

MDE is **base-agnostic**. The base language (L1) is a parameter, not a fixed choice: Markdown today, djot or another lightweight markup tomorrow. MDE-CORE is the genesis and the root of everything. It defines the architecture, the four lineage laws, the governance model, the file format, and the document declaration. It names no base and defines no tokens. Each base is bound by its own profile genesis (for example MDE-0 for Markdown), which descends from this core.

## Layered model
- **Layer 1 (L1):** a base markup language. L1 is a parameter, chosen per lineage and fixed by that lineage's base profile. L1 rules are never touched by MDE.
- **Layer 2 (L2):** MDE. A set of versioned tokens that a standard-aware renderer processes after (or alongside) L1, transforming them into UI/HTML. An MDE-unaware renderer never sees L2 as anything but plain text.

MDE is additive only. It can introduce new tokens; it can never redefine, remove, or reinterpret an L1 construct.

### Eligible bases (scope)
A base MUST be a **lightweight, human-readable text markup language** (for example Markdown, djot, AsciiDoc, Textile, Org, Wikitext). This is a hard scope limit, not a preference: MDE's core guarantee is that unrecognized content degrades to **readable plain text**, which only holds when the base itself is readable as text. Tag-heavy, binary, or non-text formats (for example compiled formats, or a data format like JSON used as a container) are out of scope as bases.

## The Four Lineage Laws
These govern how an MDE lineage may evolve. "Lineage" means a chain of version files, each descending from a previous one (see Governance and File Format). The laws are base-agnostic; where a law needs a concrete per-base list, that list lives in the base profile, not here.

1. **External Base Lock.** MDE tokens SHALL NOT use any character pattern that the declared **base** already recognizes. The concrete set of forbidden patterns is defined by each base profile (for example the Markdown profile, MDE-0, lists the CommonMark + GFM constructs). Tool-specific ecosystems outside a base's own specification are not part of its lock, because almost every bracket is claimed by *some* tool and a universal lock would be unsatisfiable. Implementers are nonetheless encouraged to avoid gratuitous overlap with popular conventions where a free alternative exists.
2. **Internal Version Lock (within a lineage).** Once a symbol or pattern is assigned a meaning in a version, that assignment is immutable in all **later** versions **of the same lineage**. MDE does not patch mistakes in place. A flawed assignment is corrected by **forking a new lineage** that the ecosystem may adopt (see Governance), not by mutating an existing version.
3. **Structural Namespace Lock (within a lineage).** A delimiter or keyword, once claimed, is never reassigned to a different feature in later versions of the same lineage.
4. **Cryptographic Lineage (auditable provenance).** Every file beyond a genesis embeds the SHA-256 of its predecessor's signed region and the predecessor author's signature of that hash, and is itself sealed (signed) by its own author (see File Format). The chain forms a tree rooted at MDE-CORE: each base profile genesis descends from CORE, and each version dictionary descends from its base's previous version. This makes every lineage, and every fork point, cryptographically **auditable**. It is explicitly **not** a fork-prevention mechanism (see Governance). Verification is performed **once, on adoption** (when a client decides to support a version), never per rendered document.

## Governance: adoption, not authority
Base markup's core problem is a central decision point. MDE deliberately has **no central authority and no formal succession**. Canonicity is decided by **adoption**, by the market of implementers and authors. Anyone may publish a version that chains off any existing version, or a new base profile that binds a new base and chains off MDE-CORE; the cryptographic lineage makes every such branch auditable, but privileges none of them by protocol.

The guarantee MDE offers is therefore **not** "forks cannot happen." It is "every fork is cryptographically auditable and degrades safely, and the ecosystem chooses which lineage leads by adopting it."

The following are **social conventions** (etiquette, not protocol rules the cryptography enforces):
- Contributors SHOULD continue the most-adopted chain descending from a base's original author, rather than fork casually.
- A fork is appropriate on irreconcilable design disagreement, or when the current lineage author has been unresponsive for a sustained period (as a rough norm, about six months).
- When a fork happens, leadership of the new chain is decided by adoption from that point forward.
- A previously-leading author who returns does not automatically regain the lead. Leadership follows adoption, not seniority.

## Compliance (stated per base, version, lineage)
Because forks are permitted and bases are plural, compliance is always stated against a specific `(base, version, lineage)` triple:
- An implementation claiming **MDE base B, version N, lineage L** MUST support every token defined in versions 1 through N of lineage L on base B, rendering each as that lineage specifies.
- **Graceful degradation is mandatory.** Tokens from an unknown base, an unknown or higher version, or a lineage the client does not support, MUST be left as readable plain text. They MUST NOT be corrupted, dropped silently in a way that changes meaning, or partially transformed.
- **No silent cherry-picking within a claimed `(base, version, lineage)`.** Do not advertise support and then omit a token the claimed version defines.

Partial support is fine and expected: simply claim the highest `(base, version, lineage)` you actually meet. There is no obligation to implement every base or lineage, only to degrade the ones you do not.

## File format: self-contained, self-verifying spec files
An MDE spec file carries its own hash and signature **inside the file**, excluded from the region those cover, the same way a Nostr event's `id` and `sig` are excluded from the serialization they attest. This keeps each file a single, portable, self-verifying document with no detached signature to lose.

A spec file has three parts:
1. A **signed region**, delimited by two marker lines (the HTML comments named `MDE-SIGNED-REGION-START` and `MDE-SIGNED-REGION-END`). Everything a signature attests lives here: the author's npub, the specification text, and (for any file beyond MDE-CORE) the reference to the predecessor's hash and signature.
2. A **seal** (the HTML comment named `MDE-SEAL`), placed **after** the end marker and therefore **excluded** from the hash. It holds this file's own `file_sha256` and `signature`. Because it is outside the signed region, writing the seal never changes the hash.
3. Optional non-signed trailer content (none is required).

The author's npub lives **inside** the signed region, so the signature attests authorship, mirroring how a Nostr pubkey is part of the hashed serialization while the `id`/`sig` are not.

### Canonicalization (required before hashing)
These are hand-edited text files, so raw bytes are not stable across editors and operating systems (line endings, trailing whitespace, final newline, byte-order marks). The hash is therefore taken over a **canonicalized** form of the signed region, not its literal bytes. This is the same problem PGP cleartext signatures solve, and MDE adopts the same style of text canonicalization:

1. Decode the signed region as UTF-8 and drop a leading byte-order mark if present.
2. Normalize every line ending (CRLF and a lone CR) to a single LF (`\n`).
3. Strip trailing spaces and tabs from the end of every line.
4. Reduce trailing blank lines so the region ends with exactly one LF.

The "signed region" is the content strictly **between** the start and end marker lines, not including the marker lines themselves.

### Hash and signature
- `file_sha256` = SHA-256 over the canonicalized signed-region bytes, as lowercase hex.
- `signature` = the author's signature over that 32-byte digest, using the key published as the author's npub (a Nostr-style schnorr signature over the digest). It is written into the seal and distributed with the file.

### Lineage linking
MDE-CORE has no predecessor, so its signed region names only its author. Every other file names its author and, inside its signed region, its predecessor's `file_sha256` and the predecessor author's `signature` of that hash: a base profile genesis names MDE-CORE as its predecessor, and each version dictionary names the previous version in its own base branch. Tampering with any link therefore breaks the tampered file's own signature. A verifier walks the relevant branch once, on adoption: fetch MDE-CORE, the target base's profile genesis, and versions 1..N of that base, recompute each `file_sha256` from its canonicalized signed region, and verify each signature and each embedded predecessor reference. On success, the client compiles that version's token dictionary natively and does not consult the chain again while rendering.

## Declaring MDE in a document
The self-signing above applies to the **spec files** that define a lineage. A **user document** that merely *uses* MDE formatting is a different thing: it does not carry the lineage chain, only a pointer to the one `(base, version, lineage)` whose dictionary a renderer should load. This section defines that pointer once, as architecture, so every base and version inherits it unchanged.

The pointer carries five fields, all REQUIRED:
- `base`: the base (L1) markup family the content is written in, for example `markdown` or `djot`. It is the dispatch discriminator: a client that does not support the base degrades immediately, without resolving anything else.
- `version`: the MDE version the content targets, within that base's lineage.
- `lineage`: the lineage author's npub. It disambiguates forks, since more than one lineage can reach the same version number on the same base.
- `hash`: the targeted version file's `file_sha256`. This pins the declaration to one exact, immutable specification, so a renderer confirms it is loading the same dictionary bytes it verified on adoption, not a same-numbered fork or a tampered copy. It also pins the exact L1 version transitively, since the chain the hash anchors reaches a base profile genesis that names the exact base version. The `hash`, not the `signature`, is what *selects* the version.
- `signature`: the lineage author's signature of that `hash`, copied from the spec file's seal. It is carried, not dropped, for two reasons. First, the signature lives in the spec file's **seal**, which sits outside the signed region and is therefore **not** covered by `hash`; it cannot be reconstructed from the hash, so it is genuinely new information. Second, propagating it with every document makes a lineage's attestation **redundantly available in the wild**: if the origin spec file or its seal is ever lost, the signature survives, distributed across the corpus, and the chain stays verifiable. A renderer that already holds the verified dictionary need not re-check the signature per document, but MUST preserve it rather than strip it.

The declaration uses the host file type's native comment or metadata facility, between the boundaries `[mde]` and `[/mde]`.

Markdown, HTML, XML (`.md`, `.html`, `.xml`), inside an HTML comment:
```markdown
<!--
[mde]
base=markdown
version=1
lineage=npub1_lineage_author...
hash=file_sha256_of_target_version...
signature=sig_of_that_hash_by_lineage_author...
[/mde]
-->
# Title
An &&underlined sentence&& and a ||hidden chunk||, posted {t:2026-06-10T12:00:00Z}.
```

Plain text (`.txt`), one metadata line per line at the top:
```unset
// [mde]
// base=markdown
// version=1
// lineage=npub1_lineage_author...
// hash=file_sha256_of_target_version...
// signature=sig_of_that_hash_by_lineage_author...
// [/mde]
A plain text file with an &&underlined idea&&.
```

Source code and config (`.py`, `.yaml`, `.js`), using the host comment syntax:
```python
# [mde]
# base=markdown
# version=1
# lineage=npub1_lineage_author...
# hash=file_sha256_of_target_version...
# signature=sig_of_that_hash_by_lineage_author...
# [/mde]
blog_post = "Supports an &&underlined string&&."
```

JSON (`.json`), a reserved root key (JSON has no comments):
```json
{
  "_mde": {
    "base": "markdown",
    "version": 1,
    "lineage": "npub1_lineage_author...",
    "hash": "file_sha256_of_target_version...",
    "signature": "sig_of_that_hash_by_lineage_author..."
  },
  "title": "My Application Document",
  "article_body": "A database entry with &&underlined strings&&."
}
```

A transport binding MAY carry the same five fields in its own native structure instead of an embedded comment (see NIP-MDE for the Nostr tag form).

## Two kinds of extensions
MDE tokens fall into two categories, which later dictionaries should keep distinct:
- **Static text decorations:** wrap or mark literal text (for example underline, spoiler, highlight, alignment). The input text is also the displayed text.
- **Dynamic value tokens:** carry a machine value that the renderer transforms into a localized or computed display (for example a timestamp). These use the general shape `{type:payload}`.

Dictionaries SHOULD prefer payloads that remain human-readable when unrendered, so that a legacy reader still sees meaningful plain text.
<!-- MDE-SIGNED-REGION-END -->

<!-- MDE-SEAL
file_sha256: 6df5d9815726fae64a8d7b1bc6ef3c17fc50dc7afce3db317892d960318f35d8
signature: PENDING_SIGNATURE
-->
