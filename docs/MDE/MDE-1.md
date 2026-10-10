<!-- MDE-SIGNED-REGION-START -->
Author: npub1_V1_AUTHOR_PLACEHOLDER (replace with the version-1 author's npub before sealing)
Previous version: 0
Previous file_sha256: 114879bd7244075683e3bae01e72fec620ece4342c13cfb4d16999b909b3fb31
Previous author signature: PENDING_MDE0_SIGNATURE (the MDE-0 author's signature of the hash above)

# MDE-1: Core Feature Dictionary (Version 1 Baseline)

## Abstract
This document is the first functional feature increment of the Markdown Extensions (MDE) standard. It inherits, in full, the architecture, four lineage laws, adoption governance, compliance model, and file format defined in MDE-0. It adds the version-1 token dictionary.

## Version 1 token dictionary
All version-1 tokens are chosen to avoid every CommonMark and GFM construct (Law 1, MDE-0). Each row gives the token and its rendered output.

| Token | Meaning | Rendered output |
|-------|---------|-----------------|
| `&&text&&` | Underline | `<u>text</u>` |
| `\|\|text\|\|` | Spoiler (hidden until revealed) | `<span class="spoiler">text</span>` |
| `{=text=}` | Highlight / marker | `<mark>text</mark>` |
| `{t:payload}` | Dynamic localized date/time | `<time datetime="…">localized time</time>` |
| `{>text<}` | Align center (block) | `<div style="text-align:center">text</div>` |
| `{>text>}` | Align right (block) | `<div style="text-align:right">text</div>` |
| `{<text<}` | Align left (block) | `<div style="text-align:left">text</div>` |

### Notes and semantics
- **Spoiler and the GFM table pipe.** The spoiler delimiter is `||`. Because GFM uses a single `|` as a table-cell separator, an MDE token is resolved **within** cell text, never across the `|` cell boundaries. Outside tables, `||text||` is a plain inline spoiler.
- **`{t:payload}` is a dynamic value token** (MDE-0, "Two kinds of extensions"), not a text decoration. Its delimiter is the brace family, deliberately **not** angle brackets: `<…>` is CommonMark autolink and inline-HTML territory and is barred by Law 1. The payload is one of:
  - an **ISO 8601** instant, e.g. `{t:2026-06-10T12:00:00Z}` (RECOMMENDED), or
  - a **Unix epoch seconds** integer, e.g. `{t:1718000000}`.
  ISO 8601 is recommended because an MDE-unaware reader still sees a human-readable instant, which a raw epoch integer does not provide. A renderer detects which form is present by shape (leading digits only with no letters or separators means epoch seconds; otherwise parse as ISO 8601). The rendered `<time>` carries the original value in `datetime` and shows the viewer's localized time.
- **Alignment tokens are block-level.** They wrap a single line or paragraph in an aligned block and produce a block element. They are not intended to span across unrelated block structures (for example across a list or a blockquote boundary); a renderer MAY treat a token that is not cleanly closed within one block as literal text.
- The three alignment tokens differ only by their inner delimiters: center points both arrows inward (`{>` … `<}`), right points both right (`{>` … `>}`), left points both left (`{<` … `<}`).

## Graceful degradation
A parser reading a document whose declared MDE version or lineage it does not support MUST leave every unrecognized token as readable plain text. It MUST NOT partially transform or corrupt it. Because the tokens are compact and, for timestamps, ISO 8601, unrendered content stays human-readable.

The format of that metadata block (per file type) and what it carries (`version`, `lineage`, optional `hash`) is defined once in MDE-0 (Declaring MDE in a document), since it is architecture, not a version-1 feature.

## Parser flow
A standard-aware client processes a document in three context-free phases:

```unset
[Raw stream] -> 1. Scan metadata (version + lineage) -> 2. Load that dictionary -> 3. Stream render -> [HTML / UI]
```

1. **Scan.** Locate the `version` and `lineage` in the document's metadata block or `_mde` key.
2. **Load.** Select the pre-verified token dictionary for that `(version, lineage)`. The dictionary was verified once, on adoption (MDE-0, File Format); it is not re-verified per document.
3. **Render.** Transform the registered tokens into UI components:
   - `&&text&&` -> `<u>text</u>`
   - `||text||` -> `<span class="spoiler">text</span>`
   - `{=text=}` -> `<mark>text</mark>`
   - `{t:payload}` -> `<time datetime="…">localized time</time>`
   - `{>text<}` -> `<div style="text-align:center">text</div>`
   - `{>text>}` -> `<div style="text-align:right">text</div>`
   - `{<text<}` -> `<div style="text-align:left">text</div>`

Renderers MUST sanitize output: a token's payload is data, never raw markup, so an implementation MUST escape payload content before emitting it into HTML.
<!-- MDE-SIGNED-REGION-END -->

<!-- MDE-SEAL
file_sha256: 139f65913bfece48a46283e864f2705c73e6990900613398a157dda405b865fb
signature: PENDING_SIGNATURE
-->
