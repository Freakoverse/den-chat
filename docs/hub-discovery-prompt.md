# Hub Discovery Prompt

A self-contained prompt to hand to any coding AI (with zero prior context) to build a
standalone one-page hub browser/search over Nostr. No branding, no filters. Edit the block
below and copy the whole thing when you want to use it.

---

```
Build a single self-contained HTML file (one page) that browses and searches "hubs" from
the Nostr network. Use vanilla JavaScript with the `nostr-tools` library loaded from a CDN
as an ES module (for SimplePool and nip19). Dark theme, responsive, works on mobile. No
build step, no framework, no backend.

=== WHAT A HUB IS (Nostr background you need) ===
A hub is a Nostr "addressable" event of kind 36942. Query relays over WebSocket; the easiest
path is nostr-tools' SimplePool. Read these from each event:
- The `d` tag  -> the hub's identifier (string).
- The `n` tag  -> hub name (fallback "Unnamed Hub").
- The `picture` tag -> icon image URL.
- The `banner`  tag -> banner image URL.
- The `about`   tag -> description/bio.
- Every `o` tag -> a Blossom media server URL this hub uses (there can be several).
- `event.pubkey` -> the hub creator's public key (hex).
- The `published_at` tag (unix seconds) -> use for ordering; fall back to `event.created_at`.
- The `s` tag -> a 6-hex-character "short code" (may be absent).
Some older hubs put the face inside `event.content` as JSON instead of in tags:
`JSON.parse(event.content).settings` may hold `.icon`, `.banner`, `.description`. Prefer the
tags above when present, otherwise fall back to these content fields.

=== DELETED HUBS + ALWAYS THE LATEST VERSION ===
- Never show a hub whose event carries a `["deleted","true"]` tag. Drop it entirely, even if
  an older non-deleted copy of the same hub is also received.
- Never show an event that has no `d` tag.
- A hub is identified by its coordinate `kind:pubkey:d` (here `36942:<pubkey>:<d>`). Relays
  and searches will hand you several revisions of the same hub. ALWAYS keep and show only the
  one with the highest `created_at` for that coordinate, no matter which relay or which query
  it arrived from. When a newer revision arrives later (from another relay, the next page, or
  a search), replace the one you were showing; if an older revision arrives, ignore it. If the
  newest revision for a coordinate is a deleted one, the hub is gone (don't fall back to an
  older copy).

Default relays to connect to:
  wss://relay.primal.net, wss://relay.damus.io, wss://nos.lol, wss://nostr.mom,
  wss://relay.snort.social, wss://offchain.pub, wss://relay.nostr.net

=== INITIAL LOAD + INFINITE PAGINATION ===
On page load, query { kinds:[36942], limit: 60 }, sorted newest-first by published_at.
Show results in a paginated grid, PAGE_SIZE = 12 per page.
Pagination controls at the bottom: a left arrow, numbered page buttons in the middle, a right
arrow. Clicking a number/arrow jumps to that page.
As the user approaches the last loaded page (e.g. they are on the second-to-last page or
nearer), automatically fetch the NEXT batch: query { kinds:[36942], limit:60, until: <oldest
published_at you have so far> } and append any new unique hubs, then recompute page count.
Stop trying once a fetch returns nothing new (no more to load). Show a subtle loading
indicator while fetching, and never block the UI.

=== IMAGES: BLOSSOM-ADDRESSED, LOAD-AS-YOU-GO, WITH FAILOVER ===
Hub banner and icon URLs are usually Blossom media: content-addressed by a SHA-256 hash, so
the URL path ends in a 64-hex-character hash with an optional extension, e.g.
  https://some.server/<64-hex-hash>.jpg
The SAME file (same hash) is typically mirrored on several servers, so a single server being
down or having dropped the blob should NOT mean a broken image. For every hub image:
- Parse the hash (+ optional extension) out of the URL path. If the path has no 64-hex hash
  segment, it isn't content-addressed; just use the URL as-is with no alternates.
- Build an ordered list of alternate URLs by taking that same `/<hash><ext>` path and
  prefixing it with each server origin, in this order: first the hub's own `o`-tag servers,
  then the default Blossom servers below. Dedupe origins and skip the URL's original origin.
- Load the image progressively: keep the placeholder (color block for banners, initials
  circle for icons) visible, and only swap the real image in once it has actually loaded
  (on the img's load event). On an image error, advance to the next alternate URL and retry.
  When every alternate is exhausted, keep the placeholder.

Default Blossom servers (the fallback mirror list):
  https://blossom.primal.net, https://blossom.data.haus, https://nostr.download,
  https://blossom.jumble.social, https://blossom.ditto.pub, https://blossom-01.uid.ovh,
  https://blossom-02.uid.ovh

=== HUB CARD ===
Each hub renders as a card containing, top to bottom:
1. The banner image across the top (object-fit: cover, fixed height), loaded with the Blossom
   failover described above. Placeholder color block until it loads / if all sources fail.
2. The icon image as a circle overlapping the bottom of the banner, same failover. If it
   fails/missing, show a circle with the hub's initials (first letters of the name).
3. The hub name (bold, truncate if long).
4. A short bio: the description, clamped to ~2-3 lines.
5. At the very bottom, a "Copy address" button. Clicking it copies the hub's shareable
   address to the clipboard and briefly shows "Copied". The address is the hub's naddr,
   built with nostr-tools nip19.naddrEncode({ identifier: <d tag>, pubkey: <event.pubkey>,
   kind: 36942, relays: [] }).

=== SEARCH (top of page, with a text input + a Search button; Enter also triggers it) ===
The search box accepts four kinds of input. First try to satisfy the query LOCALLY against
already-loaded hubs (instant). If nothing local matches, pressing Search runs a targeted
relay query and merges the result in (still honoring deleted + newest-version rules above).

1. Plain text -> treat as a name search: locally filter loaded hubs whose name contains the
   text (case-insensitive). (No relay name search needed.)

2. An `naddr1...` string -> decode with nip19.decode; it yields { kind, pubkey, identifier }.
   Locally show the hub whose pubkey + d-tag match. On Search, relay-query
   { kinds:[36942], authors:[pubkey], "#d":[identifier] }.

3. An `npub1...` string -> decode with nip19.decode to a hex pubkey. Locally show all loaded
   hubs by that author. On Search, relay-query { kinds:[36942], authors:[pubkey] }.

4. A SHORT ADDRESS of the form  s<npub><6hexcode>[-selector]  (e.g. "snpub1abc...def 123abc").
   Parse it WITHOUT any hashing:
     - Strip an optional leading "nostr:".
     - It must start with "s"; drop that leading "s".
     - If there's a "-", everything after it is an ignorable selector; keep the part before.
     - The last 6 characters of what remains are the lowercase hex `code`; they must match
       /^[0-9a-f]{6}$/.
     - Everything before those 6 chars is the authority, which is an `npub1...`; decode it
       with nip19.decode to a hex pubkey.
   Locally show loaded hubs where event.pubkey === that pubkey AND the hub's `s` tag === code.
   On Search, relay-query { kinds:[36942], authors:[pubkey], "#s":[code] }.
   If the string doesn't parse as a valid short address, fall back to a plain-text name search.

A "clear" (x) button in the search box resets back to the full browsing view.

=== POLISH ===
- Graceful empty states ("No hubs found", a loading spinner on first load).
- Clean modern card grid (CSS grid, ~3 columns desktop, 1 column mobile, comfortable spacing).
- No external services other than the Nostr relays, the Blossom servers, and the nostr-tools CDN.
- Everything in one .html file.
```
