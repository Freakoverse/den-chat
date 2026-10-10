<!-- MDE-SIGNED-REGION-START -->
Author: npub1_GENESIS_AUTHOR_PLACEHOLDER (replace with the genesis author's npub before sealing)

# MDE-0: Embedded Markdown Extensions, Core Architecture (Genesis)

## Abstract
Markdown is the ubiquitous baseline for plain-text authoring, but it has two structural gaps: it has no versioning, and its syntax symbols are hardcoded. There is no sanctioned way to add new elements over time without risking breakage for older documents, and no audit trail for who defined what. The result is a fragmented field of mutually incompatible "flavors" with no shared lineage.

This document defines **Markdown Extensions (MDE)**: an additive, version-controlled, adoption-governed formatting layer that sits on top of base Markdown. MDE is a **Layer 2** that never modifies **Layer 1** (base Markdown). L1 rules are left completely untouched; MDE only adds new, non-colliding tokens that L1 does not process.

MDE-0 is the genesis document. It defines the architecture, the four lineage laws, the governance model, and the file format. It defines no formatting tokens itself; the first token dictionary is MDE-1.

## Layered model
- **Layer 1 (L1):** base Markdown. For the purposes of this standard, "standard Markdown" means **CommonMark plus GFM** (GitHub Flavored Markdown). This is the concrete, widely implemented baseline MDE builds on; the exact versions and the full construct list are given in Appendix: Layer 1 reference.
- **Layer 2 (L2):** MDE. A set of versioned tokens that a standard-aware renderer processes after (or alongside) L1, transforming them into UI/HTML. An MDE-unaware renderer never sees L2 as anything but plain text.

MDE is additive only. It can introduce new tokens; it can never redefine, remove, or reinterpret an L1 construct.

## The Four Lineage Laws
These govern how an MDE lineage may evolve. "Lineage" means a chain of version files, each descending from a previous one (see Governance and File Format).

1. **External Markdown Lock.** MDE tokens SHALL NOT use any character pattern that CommonMark or GFM already recognizes: `*`, `**`, `_`, `` ` ``, `~~`, `#`, `>`, `-`, `+`, ordered-list `1.`, `[ ]` links, `( )` link targets, `< >` autolinks and inline HTML, images `![ ]`, the GFM table pipe `|`, and task-list `[ ]`/`[x]`. "Standard Markdown" here is scoped to **CommonMark + GFM**. Tool-specific ecosystems outside that baseline (Pandoc attribute lists, MDX `{expression}` braces, the Obsidian `==highlight==` convention, reStructuredText, and so on) are **not** part of this lock, because almost every bracket is claimed by *some* tool and a universal lock would be unsatisfiable. Implementers are nonetheless encouraged to avoid gratuitous overlap with popular conventions where a free alternative exists.
2. **Internal Version Lock (within a lineage).** Once a symbol or pattern is assigned a meaning in a version, that assignment is immutable in all **later** versions **of the same lineage**. MDE does not patch mistakes in place. A flawed assignment is corrected by **forking a new lineage** that the ecosystem may adopt (see Governance), not by mutating an existing version.
3. **Structural Namespace Lock (within a lineage).** A delimiter or keyword, once claimed, is never reassigned to a different feature in later versions of the same lineage.
4. **Cryptographic Lineage (auditable provenance).** Every version beyond the genesis embeds the SHA-256 of the preceding version's signed region and the preceding author's signature of that hash, and is itself sealed (signed) by its own author (see File Format). This makes every lineage, and every fork point, cryptographically **auditable**. It is explicitly **not** a fork-prevention mechanism (see Governance). Verification is performed **once, on adoption** (when a client decides to support a version), never per rendered document.

## Governance: adoption, not authority
Base Markdown's core problem is a central decision point. MDE deliberately has **no central authority and no formal succession**. Canonicity is decided by **adoption**, by the market of implementers and authors. Anyone may publish a version that chains off any existing version; the cryptographic lineage makes every such branch auditable, but privileges none of them by protocol.

The guarantee MDE offers is therefore **not** "forks cannot happen." It is "every fork is cryptographically auditable and degrades safely, and the ecosystem chooses which lineage leads by adopting it."

The following are **social conventions** (etiquette, not protocol rules the cryptography enforces):
- Contributors SHOULD continue the most-adopted chain descending from the original author, rather than fork casually.
- A fork is appropriate on irreconcilable design disagreement, or when the current lineage author has been unresponsive for a sustained period (as a rough norm, about six months).
- When a fork happens, leadership of the new chain is decided by adoption from that point forward.
- A previously-leading author who returns does not automatically regain the lead. Leadership follows adoption, not seniority.

## Compliance (stated per lineage)
Because forks are permitted, compliance is always stated against a specific `(version, lineage)` pair:
- An implementation claiming **MDE version N of lineage L** MUST support every token defined in versions 1 through N of lineage L, rendering each as that lineage specifies.
- **Graceful degradation is mandatory.** Tokens from an unknown or higher version, or from a lineage the client does not support, MUST be left as readable plain text. They MUST NOT be corrupted, dropped silently in a way that changes meaning, or partially transformed.
- **No silent cherry-picking within a claimed `(version, lineage)`.** Do not advertise support for vN of L and then omit a token that vN of L defines.

Partial support is fine and expected: simply claim the highest `(version, lineage)` you actually meet. There is no obligation to implement every lineage, only to degrade the ones you do not.

## File format: self-contained, self-verifying spec files
An MDE version file carries its own hash and signature **inside the file**, excluded from the region those cover, the same way a Nostr event's `id` and `sig` are excluded from the serialization they attest. This keeps each version a single, portable, self-verifying document with no detached signature to lose.

A version file has three parts:
1. A **signed region**, delimited by two marker lines (the HTML comments named `MDE-SIGNED-REGION-START` and `MDE-SIGNED-REGION-END`). Everything a signature attests lives here: the author's npub, the specification text, and (for version 1 and beyond) the reference to the previous version's hash and signature.
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
MDE-0 has no predecessor, so its signed region names only its author. Each later version names its author and, inside its signed region, the predecessor's `file_sha256` and the predecessor author's `signature` of that hash. Tampering with any link therefore breaks the tampered file's own signature. A verifier walks the chain once, on adoption: fetch versions 0..N, recompute each `file_sha256` from its canonicalized signed region, and verify each signature and each embedded predecessor reference. On success, the client compiles that version's token dictionary natively and does not consult the chain again while rendering.

## Declaring MDE in a document
The self-signing above applies to the **spec files** that define a lineage. A **user document** that merely *uses* MDE formatting is a different thing: it does not carry the lineage chain, only a pointer to the one `(version, lineage)` whose dictionary a renderer should load. This section defines that pointer once, as architecture, so every later version inherits it unchanged.

The pointer carries four fields, all REQUIRED:
- `version`: the MDE version the content targets.
- `lineage`: the lineage author's npub. It disambiguates forks, since more than one lineage can reach the same version number.
- `hash`: the targeted version file's `file_sha256`. This pins the declaration to one exact, immutable specification, so a renderer confirms it is loading the same dictionary bytes it verified on adoption, not a same-numbered fork or a tampered copy. The `hash`, not the `signature`, is what *selects* the version.
- `signature`: the lineage author's signature of that `hash`, copied from the spec file's seal. It is carried, not dropped, for two reasons. First, the signature lives in the spec file's **seal**, which sits outside the signed region and is therefore **not** covered by `hash`; it cannot be reconstructed from the hash, so it is genuinely new information. Second, propagating it with every document makes a lineage's attestation **redundantly available in the wild**: if the origin spec file or its seal is ever lost, the signature survives, distributed across the corpus, and the chain stays verifiable. A renderer that already holds the verified dictionary need not re-check the signature per document, but MUST preserve it rather than strip it.

The declaration uses the host file type's native comment or metadata facility, between the boundaries `[mde]` and `[/mde]`.

Markdown, HTML, XML (`.md`, `.html`, `.xml`), inside an HTML comment:
```markdown
<!--
[mde]
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
    "version": 1,
    "lineage": "npub1_lineage_author...",
    "hash": "file_sha256_of_target_version...",
    "signature": "sig_of_that_hash_by_lineage_author..."
  },
  "title": "My Application Document",
  "article_body": "A database entry with &&underlined strings&&."
}
```

A transport binding MAY carry the same four fields in its own native structure instead of an embedded comment (see NIP-MDE for the Nostr tag form).

## Two kinds of extensions
MDE tokens fall into two categories, which later dictionaries should keep distinct:
- **Static text decorations:** wrap or mark literal text (for example underline, spoiler, highlight, alignment). The input text is also the displayed text.
- **Dynamic value tokens:** carry a machine value that the renderer transforms into a localized or computed display (for example a timestamp). These use the general shape `{type:payload}`.

Dictionaries SHOULD prefer payloads that remain human-readable when unrendered, so that a legacy reader still sees meaningful plain text.

## Appendix: Layer 1 reference (CommonMark 0.31.2 + GFM 0.29)
This is the concrete Layer 1 that MDE builds on and that Law 1 forbids colliding with. "Standard Markdown" in this document means exactly this set: **CommonMark version 0.31.2** plus the **GitHub Flavored Markdown (GFM) version 0.29** extensions. The table is listed here for convenience and is the baseline this lineage targets; the authoritative definitions remain the CommonMark 0.31.2 and GFM 0.29 specifications. Platform-specific rendering features outside those two specs (for example GitHub's alert blocks, footnotes, or diagram fences) are not part of this baseline.

| Construct | Syntax | Source |
|-----------|--------|--------|
| Paragraph | plain text separated by a blank line | CommonMark |
| ATX heading | `# heading` through `###### heading` | CommonMark |
| Setext heading | a text line underlined by `===` or `---` | CommonMark |
| Thematic break | `---`, `***`, or `___` on their own line | CommonMark |
| Blockquote | `> quoted text` | CommonMark |
| Bullet list | `-`, `+`, or `*` item markers | CommonMark |
| Ordered list | `1.` or `1)` item markers | CommonMark |
| Indented code block | four leading spaces | CommonMark |
| Fenced code block | a triple-backtick fence or a `~~~` fence | CommonMark |
| HTML block | raw block-level HTML | CommonMark |
| Link reference definition | `[label]: url "title"` | CommonMark |
| Emphasis | `*text*` or `_text_` | CommonMark |
| Strong | `**text**` or `__text__` | CommonMark |
| Code span | text wrapped in a backtick pair | CommonMark |
| Link | `[text](url)` or `[text][ref]` | CommonMark |
| Image | `![alt](url)` | CommonMark |
| Autolink | `<https://example.com>` | CommonMark |
| Raw inline HTML | inline tags such as `<br>` or `<span>` | CommonMark |
| Hard line break | two trailing spaces or a trailing `\` | CommonMark |
| Backslash escape | `\*`, `\_`, and other escaped punctuation | CommonMark |
| Entity / numeric reference | `&amp;`, `&#35;`, `&#x23;` | CommonMark |
| Table | rows of `\| a \| b \|` with a `---` separator row | GFM |
| Task list item | `- [ ]` and `- [x]` | GFM |
| Strikethrough | `~~text~~` | GFM |
| Extended autolink | bare `https://`, `www.`, and email URLs | GFM |
| Tagfilter | disallows unsafe raw HTML such as `<script>` | GFM |
<!-- MDE-SIGNED-REGION-END -->

<!-- MDE-SEAL
file_sha256: 97aec06c5c10ccb56714b98e5903832d030895b55f0716f5d1105fb038e62060
signature: PENDING_SIGNATURE
-->
