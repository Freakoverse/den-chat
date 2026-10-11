<!-- MEX-SIGNED-REGION-START -->
Author: npub1_MARKDOWN_PROFILE_AUTHOR_PLACEHOLDER (replace with the Markdown profile author's npub before sealing)
Base: markdown
Previous: MEX-CORE
Previous file_sha256: d7164cf6abaaa3e72ff85532e0d1ad3e3019bc2394f6c301668dde4ed7930cd5
Previous author signature: PENDING_CORE_SIGNATURE (the MEX-CORE author's signature of the hash above)

# MEX-0: Markdown Profile for Markup Extensions (Base Genesis)

## Abstract
This document is the **Markdown profile genesis** for Markup Extensions (MEX). It inherits, in full, the architecture, four lineage laws, adoption governance, compliance model, and file format defined in MEX-CORE. It does one job: bind the `markdown` base to a concrete Layer 1, state the Markdown-specific External Base Lock, and provide the Layer 1 reference. It defines no tokens; the first Markdown token dictionary is MEX-1.

## Base binding
- **Base identifier:** `markdown`. This is the value carried in the `base` field of a document declaration and in the `mex` Nostr tag (see MEX-CORE, Declaring MEX in a document, and NIP-MEX).
- **Layer 1:** **CommonMark version 0.31.2** plus the **GitHub Flavored Markdown (GFM) version 0.29** extensions. This is the exact, immutable L1 that this Markdown lineage builds on. Later Markdown versions inherit this baseline unless a future version explicitly re-pins it, which, per the Internal Version Lock (MEX-CORE), is a new version, never an in-place change. Platform-specific rendering features outside those two specifications (for example GitHub's alert blocks, footnotes, or diagram fences) are not part of this baseline.

## External Base Lock (Markdown)
This is the concrete forbidden-pattern list for Law 1 (External Base Lock, MEX-CORE) on the Markdown base. MEX tokens on this base SHALL NOT use any character pattern that CommonMark or GFM already recognizes: `*`, `**`, `_`, `` ` ``, `~~`, `#`, `>`, `-`, `+`, ordered-list `1.`, `[ ]` links, `( )` link targets, `< >` autolinks and inline HTML, images `![ ]`, the GFM table pipe `|`, and task-list `[ ]`/`[x]`. "Standard Markdown" here is scoped to **CommonMark + GFM** (see Base binding). Tool-specific ecosystems outside that baseline (Pandoc attribute lists, MDX `{expression}` braces, the Obsidian `==highlight==` convention, reStructuredText, and so on) are **not** part of this lock, because almost every bracket is claimed by *some* tool and a universal lock would be unsatisfiable. Implementers are nonetheless encouraged to avoid gratuitous overlap with popular conventions where a free alternative exists.

## Appendix: Layer 1 reference (CommonMark 0.31.2 + GFM 0.29)
This is the concrete Layer 1 that the Markdown profile builds on and that External Base Lock forbids colliding with. The table is listed here for convenience; the authoritative definitions remain the CommonMark 0.31.2 and GFM 0.29 specifications.

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
<!-- MEX-SIGNED-REGION-END -->

<!-- MEX-SEAL
file_sha256: 4809c5acde30224e72bd3988f2cd404925e5b980d1de70bcb125eb9a9f534ea8
signature: PENDING_SIGNATURE
-->
