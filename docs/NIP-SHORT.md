# NIP-SHORT: Shortened Event Addresses for Nostr

## Summary

NIP-SHORT defines short, human-readable references for Nostr events. Instead of
sharing a long `nevent1…`, `naddr1…`, or `note1…`, the author embeds a compact
code **directly inside the event** as a single-letter tag. A client resolves a
short address to its event with a single relay query and verifies it locally.

A short address is formed by a leading marker, an authority, and a fixed-width
code:

```
s<authority><code>
```

Where:

* `s` → the **short-address marker**, signaling that the string is a NIP-SHORT
  address (see [Client Recognition](#client-recognition-of-short-addresses))
* `authority` → the event author, as an `npub` (the baseline, always supported)
  or, optionally, a name that resolves to the author's pubkey — such as a DNN ID
  — for a shorter authority (see [Authority](#authority))
* `code` → **6 lowercase hex characters** deterministically derived from the
  event (see [Derivation](#derivation))

**Example (npub authority):**

```
snpub1m4ny6hjqzepn4rxknuq94c2gpqzr29ufkkw7ttcxyak7v43n6vvsajc2jl1f4c2a
```

**Example (DNN authority):**

```
snAbandonAbility2DH1f4c2a
```

In the rare event of a collision, the address gains a client-side selector
suffix (see [Collision Handling](#collision-handling)); the marker, the base
code, and the stored event never change.

Because the code lives inside the event itself, there is **no separate mapping
event** to publish, maintain, or lose, and no batching to manage. The mapping is
intrinsic to the event: if the event exists, its short address resolves; if the
event is gone, there is nothing to resolve to. There is no disconnect state.

---

## Motivation

Nostr references are long. A single `nevent1…` or `naddr1…` runs well past a
hundred characters, and users consistently find them unpleasant to share: they
clutter a message, wrap across several lines, and — because a long opaque string
reads as suspicious — recipients often hesitate to click them, mistaking a
legitimate reference for spam or a tracking link.

To cope, many users route their post links through centralized URL shorteners.
This reintroduces the exact fragility Nostr exists to avoid: the shortened link
now depends on a single third-party service. If that service deletes the link,
changes its policy, or shuts down, the reference breaks permanently — even
though the underlying event may still be perfectly available on relays. A
censorship-resistant network ends up with its most-shared references sitting
behind a centralized chokepoint that can rot or disappear.

NIP-SHORT solves this natively. It produces a compact, human-friendly reference
that is short enough to share comfortably and to read without alarm, carries no
third-party dependency, and resolves through ordinary relays with mandatory
client-side verification. The only thing that can break the link is the author
deleting the event it points to; there is no external service in the path to
fail, and no centralized party that can take it down.

---

## Design Principles

* **One lookup.** Resolution is a single relay query scoped to the author, plus
  an optional name-resolution step when a name→pubkey authority (such as a DNN
  ID) is used instead of an `npub`.
* **Self-contained.** The short code is a signed field of the event; no external
  index can drift, break, or be deleted independently.
* **Deterministic & verifiable.** Any client can recompute the code from the
  fetched event and confirm it. The tag is only a relay-side filter hint; trust
  comes from recomputation plus the event's own signature.
* **Author-scoped.** The code only needs to be unique within a single author's
  events, so it can be short. Author scoping also removes any spam/pollution
  vector — only the authority's own events can ever match.

---

## Authority

The **authority** identifies the event's author and is fundamentally a reference
to the author's public key. Two forms are supported:

* **`npub` — the baseline, always supported.** The standard NIP-19 bech32 public
  key. It requires nothing beyond NIP-19 to resolve, so an `npub`-authority
  short address is fully functional on its own. This form is normative: a
  conforming client MUST support it.
* **A name→pubkey identifier — optional.** Any system that maps a short,
  human-readable identifier to a pubkey MAY be used to produce a shorter,
  friendlier authority. **DNN** is one such system, and its compact IDs yield the
  shortest addresses. These resolvers are optional and pluggable — NIP-SHORT does
  not depend on any particular one — and are out of scope here beyond two
  requirements: a client MUST be able to resolve the identifier to a pubkey, and
  the identifier's character set MUST NOT conflict with the address grammar
  (notably it MUST NOT contain the `-` selector separator).

> `npub` authorities are long (63 characters), so an `npub`-based short address
> is shorter than a raw `nevent`/`naddr` but not itself "short." The dramatic
> compactness comes from the optional name layer; the trade-off is that `npub`
> needs no extra infrastructure while a name resolver does.

---

## The Short Tag

The author attaches a single-letter tag `s` to the event:

```json
["s", "<code>"]
```

* `code` → the **6-character** hex code (see Derivation). The tag value is
  **always exactly the 6-char code** — never the marker and never a collision
  suffix (those exist only in the shared address string).
* The tag value does not include the author, since the author is the authority
  component of the short address and is supplied as the `authors` filter at
  resolution time.

> **Note on the two `s`'s.** The address **marker** `s` (the first character of
> the shareable string) and the event **tag** `s` (a key inside the signed
> event) share a letter but are unrelated in parsing. The marker never appears
> in the event; the tag value is never the marker. They are handled in entirely
> separate contexts.

The single-letter tag `s` is indexed by relays per NIP-01 and is therefore
queryable via a `#s` filter.

**Coexistence with other uses of the `s` tag.** Another specification may use a
single-letter `s` tag for an unrelated purpose (a status, a label, and so on).
This does not interfere with NIP-SHORT in either direction, for several
compounding reasons:

* **Relay filters are exact-match on the value.** A `#s` query returns only
  events whose `s` value is *exactly* the queried string. A NIP-SHORT code is
  always **6 lowercase hex characters** — a narrow, constrained value space — so
  it can never equal a word-like status or label that another use would store.
  The two value spaces do not overlap, so neither side's queries ever return the
  other side's events.
* **NIP-SHORT resolution is author-scoped.** Every lookup filters by
  `authors: [<pubkey>]`, so only the addressed author's own events are ever
  considered.
* **NIP-SHORT verifies before trusting.** For each candidate the client reads
  the kind, recomputes the code from the event, and checks the signature.
  Anything that matched the `s` value by coincidence but is not the intended
  event fails this step and is discarded.
* **The reverse holds too.** NIP-SHORT `s` tags do not disturb another use's
  `#s` queries, since those filter by their own event kinds and their own exact
  `s` values — neither of which a NIP-SHORT event carries.

The only shared resource is the relay-side `s` index, which simply holds more
entries; correctness is unaffected.

**Example event carrying its own short address:**

```json
{
  "kind": 30023,
  "pubkey": "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
  "created_at": 1766200252,
  "tags": [
    ["d", "my-article-slug"],
    ["title", "On Short Addresses"],
    ["s", "1f4c2a"]
  ],
  "content": "..."
}
```

---

## Derivation

The code is the **first 6 lowercase hexadecimal characters** of the SHA-256
digest of a canonical input string. The canonical input depends only on the
event's *stable identity* and **never on the event's tags** — this is what
avoids the self-reference problem (a code that fed into the event id, which in
turn covers the tags, would be impossible to compute) and also makes the code
independent of NIP-13 proof-of-work nonces.

There are two canonical inputs, selected by the event's kind. Both order the
fields as **kind, then pubkey**, so the coordinate form is literally the
standard NIP-01 coordinate string.

### Coordinate-based (replaceable & addressable)

Applies when:

```
kind == 0  ||  kind == 3  ||  10000 <= kind < 20000  ||  30000 <= kind < 40000
```

Canonical input:

```
"a:" + <coordinate>
```

where `<coordinate>` is the **standard NIP-01 `a`-tag / `naddr` coordinate
string**, `kind + ":" + pubkey_hex + ":" + d_value`:

* **Addressable** events fill the `d` slot, e.g. `a:30078:<hexpubkey>:my-slug`.
* **Replaceable** events (kinds `0`, `3`, `10000–19999`) have no `d` tag, so
  `d_value` is the empty string and the input ends in a trailing colon, e.g.
  `a:0:<hexpubkey>:`.

> **Do not strip the trailing colon.** It is not decorative — it is the empty
> `d` slot of the canonical coordinate string that every Nostr coordinate
> serializer already produces. Building this input as `"a:" +` your existing
> coordinate helper's output is automatically correct; special-casing the empty
> `d` to drop the colon would diverge from standard tooling and silently
> mismatch other implementations.

Because the code derives from the **stable coordinate**, it does **not change
when the author edits** the event. A short link to a long-form article (or to a
profile) survives every revision.

### Content-based (regular events)

Applies to all other kinds (regular events such as `kind 1`).

Canonical input:

```
"e:" + kind + ":" + pubkey_hex + ":" + created_at + ":" + content
```

Regular events are immutable (a "note" is never edited — a new note is posted
instead), so this input is inherently stable.

### The `a:` / `e:` prefixes

The one-character prefix does two jobs: it **domain-separates** the two input
forms so a coordinate input and a content input can never collide, and it is a
**mnemonic** matching Nostr's own tag conventions — the `a` tag references an
event *by coordinate* (the replaceable/addressable case) and the `e` tag
references an event *by id* (the regular case). Any two distinct prefixes would
work; `a`/`e` are chosen to make intent obvious.

### Notes

* `pubkey_hex` is the **64-character lowercase hex** public key — not the
  `npub`. (The `npub` appears only as the authority in the shareable address,
  never in the hash.)
* The digest is computed over the UTF-8 bytes of the canonical input.
* The base code width (6 hex ≈ 16.7M values) is **fixed**. Resolution parses the
  address by peeling this fixed number of characters off the right (after the
  marker is stripped). Because uniqueness is only required within one author's
  events, 6 hex is ample; the collision path below covers the rare exception.
* The full digest is read **left to right**: the first 6 characters are the
  `code`; the 7th, 8th, … characters are the collision-selector extension used
  only when disambiguation is needed (see Collision Handling).

### Worked examples

```
Addressable (kind 30078):
  SHA-256("a:30078:3bf0c63f…e91a2d:my-slug")  → first 6 hex = code

Replaceable (kind 0, profile):
  SHA-256("a:0:3bf0c63f…e91a2d:")             → first 6 hex = code

Regular (kind 1, note):
  SHA-256("e:1:3bf0c63f…e91a2d:1766200252:gm") → first 6 hex = code
```

---

## Creating a Short Address (Publishers)

1. Finalize the event's identity-determining fields, select the canonical input
   for the kind, and compute `code = first 6 hex of SHA-256(canonical_input)`.
2. Run a **single** scoped collision query, with a recommended **1–2 second
   timeout**:

   ```json
   { "authors": ["<pubkey_hex>"], "#s": ["<code>"] }
   ```

   One query at the base width is sufficient: any event sharing a longer prefix
   necessarily shares the 6-char prefix, so the returned set is the complete
   collision set. (This holds precisely because the stored tag is always 6 —
   nothing is hidden in a deeper exact-match bucket.)
3. **Empty result (or timeout):** publish the event with `["s", code]`. The
   short address is `"s" + authority + code`.
4. **Non-empty result:** recompute the full SHA-256 hash of each returned event
   (using its kind-appropriate canonical input):
   * If any candidate's full hash equals this event's full hash, it is the same
     post — do **not** publish; surface "already exists" (for addressable
     events: "this event already has a short address").
   * Otherwise this is a genuine collision. Still store `["s", code]` (the tag
     stays 6). Generate the shareable address with a **selector suffix**:
     `"s" + authority + code + "-" + <extra hex>`, where the extra hex is the
     fewest additional characters of this event's hash needed to make it unique
     among the returned candidates (see Collision Handling).

**Proof-of-work.** Because the code excludes tags, adding a NIP-13 `nonce` tag
does not change it, so the collision query MAY run **in parallel** with PoW
mining. Caveat: if the PoW miner also mutates `created_at`, then for
content-based (regular) events the code depends on `created_at` and MUST be
computed after mining settles. Coordinate-based events are independent of both
the nonce and `created_at`, so they may always parallelize.

**Editing coordinate-based events.** When republishing (editing) a replaceable
or addressable event, the author MUST carry the `s` tag forward. The code is
unchanged (the coordinate is stable), and because these kinds replace by
coordinate, resolution naturally returns the latest version.

Publishers SHOULD publish to both their configured **write relays** and the
**client's default relay set** to maximize discoverability (see FAQ).

---

## Resolution (Clients)

Given a short address, e.g. `snAbandonAbility2DH1f4c2a` or
`snAbandonAbility2DH1f4c2a-a5`:

### 1. Parse

* Strip the leading **`s` marker**.
* If the remainder contains a `-`, split there: the left part is
  `authority + code`, the right part is the **selector suffix**.
* Peel the **last 6 characters** of the left part as `code`; everything before
  them is `authority`.
* The full selector prefix a candidate must match is `code + suffix` (equal to
  just `code` when there is no suffix).

The fixed 6-char code width makes this right-peel unambiguous even though DNN IDs
and hex codes share characters, and even for variable-length DNN authorities.

### 2. Resolve the authority to a pubkey

* If `authority` begins with `npub1`, decode it (bech32) to the 64-char hex
  pubkey.
* Otherwise it is a **DNN ID**: resolve it via the DNN network to the owner's
  npub, then decode to hex.

### 3. Query relays

A single filter, scoped to the author:

```json
{ "authors": ["<pubkey_hex>"], "#s": ["<code>"] }
```

No `kind` filter is required; the kind is read from each returned event.

### 4. Verify each candidate (MANDATORY)

For every returned event:

* Read its `kind`, select the matching canonical input, recompute the code, and
  confirm it equals the address's `code`.
* Validate the event signature (standard NIP-01).

Discard any event that fails either check. The `s` tag alone is never trusted —
it is only a relay-side index; authenticity comes from recomputation plus the
signature.

### 5. Select and present

* **Selector suffix present:** recompute each verified candidate's full hash and
  keep the one whose hash starts with `code + suffix`. Exactly one should remain
  → render it silently.
* **No suffix, one verified candidate:** render it.
* **Multiple candidates that the address cannot disambiguate** (no suffix, or a
  stale suffix matching more than one): present a **disambiguation UI**; do
  **not** silently choose.
* **None:** the short address cannot currently be resolved (see FAQ).

Once a candidate is selected, the client can reconstruct the authoritative
`nevent`/`naddr`/`note` from the event itself if a canonical reference is needed.

---

## Collision Handling

A collision (two of the author's events sharing the same 6-char code) is
extremely unlikely — the birthday bound only reaches ~50% at roughly 4,000
short-addressed events from a *single* author. It is handled without ever
mutating an event.

The mechanism is simply **reading further along the same hash**. The SHA-256
digest is a long hex string; the first 6 characters are the code, and if two of
the author's events share those 6, the selector suffix is just the *next*
character(s) of that same digest — enough to tell them apart:

```
SHA-256(input) = 1f4c2a 9 5 e3b7d…
                 └────┘ │ └ 8th char → suffix "…-a5"-style 2nd char
                 code   └── 7th char → suffix "…-9"-style 1st char
```

* The `s` tag remains **6 hex** for every event, so all colliding events stay in
  the same queryable bucket and a single query returns them all.
* Disambiguation lives **only in the shared address**, as a `-<hex>` suffix. The
  resolver selects by recomputing candidate hashes and prefix-matching — never
  by counting or ordering, so it is robust to partial relay visibility.
* The suffix length is the minimum needed to make the target unique among the
  fetched candidates — almost always **one** character, occasionally two. It
  grows logarithmically with candidate count, not linearly.
* Because disambiguation is address-side, a more precise address can be minted
  later without republishing the event. An already-shared shorter address that a
  *future* event undercuts degrades gracefully to the disambiguation UI.

Clients MAY offer collision-safe address generation as a toggle for regular
events (decided at compose time, since regular events are immutable) and as an
on-demand "Generate short address" action for addressable events (which edits
the event to add the `s` tag and republishes it, replacing by coordinate).

---

## Address Marker, Delimiter, and Charsets

* Every short address begins with the marker `s`.
* The selector separator is `-` (hyphen).
* `code` and the selector suffix are **lowercase hex** (`[0-9a-f]`).
* An `npub` is bech32 and never contains `-`; a DNN ID begins with `n`.
* **Neither authority type begins with `s`** (npub → `npub1`, DNN → `n`), so the
  leading marker is never confusable with the authority.
* **DNN IDs MUST NOT contain `-`.** (DNN IDs are `n` followed by alphanumeric
  characters, so this holds by construction.) A client implementation that
  adopts a different DNN ID charset MUST choose a separator outside that charset.

---

## Client Recognition of Short Addresses

Because every short address begins with `s` immediately followed by an authority
(which always begins with `n`), a bare string is classified as:

* `snpub1…` → a short address with an **npub** authority
* `sn…` (not `snpub1…`) → a short address with a **DNN** authority
* `npub1…` → a bare **npub** (a profile), not a short address
* `n…` (no leading `s`) → a bare **DNN ID** (a profile), not a short address

This lets clients auto-detect short addresses in shared plain text (DMs, notes,
QR codes) without attempting resolution. Clients that expose short addresses in
URLs (e.g. `https://example.com/snAbandonAbility2DH1f4c2a`) MAY additionally use
a route of their choosing; the URL route is a client concern and is independent
of the marker, which remains part of the canonical address string.

---

## UX Recommendation: Step-by-Step Loading Indicator

Resolution involves a few sequential steps (optional DNN resolution, the relay
query, verification, rendering). To avoid appearing unresponsive — especially
for direct URL navigation — clients **SHOULD** show a step-by-step indicator:

1. **Parsing address** — stripping the marker, extracting authority, code, and
   any suffix
2. **Resolving authority** — DNN-ID→npub (only for DNN authorities)
3. **Querying relays** — fetching by `authors + #s`
4. **Verifying** — recomputing the code and checking the signature
5. **Rendering** — displaying the event

Each step SHOULD show an elapsed-time counter, with completed steps visually
distinguished from in-progress and pending ones.

---

## Optional Name Authorities (e.g. DNN)

`npub` authorities work everywhere but are long, so the most compact and
friendly short addresses come from an optional name→pubkey authority. Clients
that want the shortest, nicest addresses MAY support one; **DNN** is the
reference example, and when the DNN network stores/replicates the author's
events it can additionally raise discovery toward a practical guarantee (see
FAQ). This is purely an enhancement — `npub` authorities are fully functional
without it — but it materially improves UX and adoption, so clients targeting
end users are encouraged to support at least one name authority.

---

## Benefits

* **Human-friendly** and compact — shorter than a raw `nevent`/`naddr` even with
  a plain `npub`, and most compact with an optional name authority such as DNN.
* **No separate mapping event** — nothing to batch, append, preserve, or delete.
* **No disconnect** — the mapping cannot break independently of the event.
* **Single-query resolution** with mandatory client-side verification.
* **No spam vector** — author-scoped queries only ever match the author's events.
* **Deterministic** — any client computes the same code for the same event.
* **Edit-safe** for addressable/replaceable events — links survive revisions.

---

## Examples

**npub, normal (70 chars):**

```
snpub1m4ny6hjqzepn4rxknuq94c2gpqzr29ufkkw7ttcxyak7v43n6vvsajc2jl1f4c2a
```

**npub, two-way collision (1-char selector):**

```
snpub1m4ny6hjqzepn4rxknuq94c2gpqzr29ufkkw7ttcxyak7v43n6vvsajc2jl1f4c2a-a
```

**DNN, normal (25 chars):**

```
snAbandonAbility2DH1f4c2a
```

**DNN, deeper collision (2-char selector, 28 chars):**

```
snAbandonAbility2DH1f4c2a-a5
```

> Structure: `s` marker + `authority` + `6-hex code` + optional `-<hex selector>`.
> After stripping the leading `s`, the last 6 hex before any `-` are always the
> code; everything between the marker and the code is the authority.

---

## FAQ

### What happens if a client cannot find the event?

Resolution depends on the client querying at least one relay that holds the
event. If no queried relay has it, the short address cannot resolve. This is a
general property of Nostr, not specific to NIP-SHORT — ordinary `nevent`/`naddr`
references fail the same way when relay overlap is insufficient.

### Why doesn't the short address include relay hints?

Relay hints add size and complexity. NIP-SHORT prioritizes human readability,
minimal length, and deterministic parsing, and relies on relay overlap and
publisher relay selection for discovery.

### How can clients improve discoverability?

Publishers SHOULD publish events to both the author's configured **write relays**
and the **client's default relay set**. Overlap with other users of the same
client, plus broad infrastructure relays, significantly improves the odds that a
resolving client queries a relay that holds the event.

### Can third parties mirror short-addressed events?

Yes. The event is an ordinary Nostr event: any relay may store it and any indexer
may track it. Resolution is always verified client-side (recompute the code,
validate the signature), so mirroring introduces no trust risk. Third parties
cannot *create* a short address for someone else's event — the code is a tag
inside the author's own signed event — but they can freely replicate the event.

### Is resolution guaranteed globally?

No. Like all Nostr references, resolution depends on relay availability and
propagation. NIP-SHORT improves usability and compactness, not global
availability.

### Does DNN provide stronger guarantees?

Potentially, yes — and this applies only when the optional DNN authority is
used. If the author owns the DNN ID used as the authority and DNN
nodes store, replicate, and propagate the author's events, discovery can approach
a practical guarantee provided the DNN network is operational and the event has
not been deleted. In that case the short address becomes infrastructure-backed
and behaves more like a DNS record than a best-effort relay lookup.