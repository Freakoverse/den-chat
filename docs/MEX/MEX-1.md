<!-- MEX-SIGNED-REGION-START -->
Author: npub1_MARKDOWN_V1_AUTHOR_PLACEHOLDER (replace with the version-1 author's npub before sealing)
Base: markdown
Previous version: 0
Previous file_sha256: 4809c5acde30224e72bd3988f2cd404925e5b980d1de70bcb125eb9a9f534ea8
Previous author signature: PENDING_MEX0_SIGNATURE (the MEX-0 author's signature of the hash above)

# MEX-1: Markdown Core Feature Dictionary (Version 1 Baseline)

## Abstract
This document is the first functional feature increment of Markup Extensions (MEX) on the Markdown base. It inherits, in full, the architecture, four lineage laws, adoption governance, compliance model, and file format defined in MEX-CORE, and the Markdown base binding and External Base Lock defined in MEX-0. It adds the version-1 token dictionary.

## Version 1 token dictionary
All version-1 tokens are chosen to avoid every CommonMark and GFM construct (External Base Lock, MEX-CORE; the concrete Markdown collision list is in MEX-0). Each row gives the token and its rendered output.

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
- **Spoiler and the GFM table pipe.** The spoiler delimiter is `||`. Because GFM uses a single `|` as a table-cell separator, an MEX token is resolved **within** cell text, never across the `|` cell boundaries. Outside tables, `||text||` is a plain inline spoiler.
- **`{t:payload}` is a dynamic value token** (MEX-CORE, "Two kinds of extensions"), not a text decoration. Its delimiter is the brace family, deliberately **not** angle brackets: `<…>` is CommonMark autolink and inline-HTML territory and is barred by External Base Lock. The payload is a single canonical form: an **ISO 8601 (RFC 3339) UTC instant ending in `Z`**, for example `{t:2026-06-10T12:00:00Z}` (fractional seconds are permitted, e.g. `...T12:00:00.000Z`). The trailing `Z` is the UTC designator, so the token names one absolute moment, exactly as a Unix epoch would, while staying human-readable: a reader on a non-supporting client still sees a recognizable date and time rather than an opaque integer, and ISO's year-first order (YYYY-MM-DD) is unambiguous about month versus day across locales. A payload that is not a well-formed UTC instant ending in `Z` is invalid and MUST be left as literal text, not interpreted as a time. A renderer parses the instant, preserves the original value in the rendered `<time datetime="…">`, and displays it in the viewer's local time zone.
- **Alignment tokens are block-level.** They wrap a single line or paragraph in an aligned block and produce a block element. They are not intended to span across unrelated block structures (for example across a list or a blockquote boundary); a renderer MAY treat a token that is not cleanly closed within one block as literal text.
- The three alignment tokens differ only by their inner delimiters: center points both arrows inward (`{>` … `<}`), right points both right (`{>` … `>}`), left points both left (`{<` … `<}`).

## Graceful degradation
A parser reading a document whose declared MEX base, version, or lineage it does not support MUST leave every unrecognized token as readable plain text. It MUST NOT partially transform or corrupt it. Because the tokens are compact and, for timestamps, ISO 8601, unrendered content stays human-readable.

The format of that metadata block (per file type) and what it carries (`base`, `version`, `lineage`, `hash`, and `signature`, all required) is defined once in MEX-CORE (Declaring MEX in a document), since it is architecture, not a version-1 feature.

## Parser flow
A standard-aware client processes a document in three context-free phases:

```unset
[Raw stream] -> 1. Scan metadata (base + version + lineage + hash) -> 2. Load that dictionary -> 3. Stream render -> [HTML / UI]
```

1. **Scan.** Locate the `base`, `version`, `lineage`, and `hash` in the document's metadata block or `_mex` key. The `signature` is also present but is not needed to select the dictionary (MEX-CORE, Declaring MEX in a document).
2. **Load.** Select the pre-verified token dictionary for that `(base, version, lineage)` at the declared `hash`, which pins the exact spec file. The dictionary was verified once, on adoption (MEX-CORE, File Format); it is not re-verified per document.
3. **Render.** Transform the registered tokens into UI components:
   - `&&text&&` -> `<u>text</u>`
   - `||text||` -> `<span class="spoiler">text</span>`
   - `{=text=}` -> `<mark>text</mark>`
   - `{t:payload}` -> `<time datetime="…">localized time</time>`
   - `{>text<}` -> `<div style="text-align:center">text</div>`
   - `{>text>}` -> `<div style="text-align:right">text</div>`
   - `{<text<}` -> `<div style="text-align:left">text</div>`

Renderers MUST sanitize output, escaping every token payload before it is emitted into HTML (MEX-CORE, Renderer safety). The `{t:}` payload in particular is parsed as a UTC instant, never echoed as markup.
<!-- MEX-SIGNED-REGION-END -->

<!-- MEX-SEAL
file_sha256: 5495f9887fbdd83a19cb83747d88421a18a84fb05f98eda4b3361285b9077718
signature: PENDING_SIGNATURE
-->
