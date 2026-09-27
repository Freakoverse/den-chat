# NIP-WC: Word Communities

> **Status**: Draft
> **Depends on**: NIP-01, NIP-13, NIP-22, NIP-25
> **Optional**: NIP-36 (content warnings), NIP-51 (mute/block lists)
> **Complements**: [NIP-72](https://github.com/nostr-protocol/nips/blob/master/72.md) (moderated communities)
> **Working title**: `NIP-WC` is a placeholder identifier; a real NIP number is assigned on submission.

## Abstract

A Word Community is an **ownerless, permissionless** threaded community scoped by a **word tag**. Every top-level [NIP-22](https://github.com/nostr-protocol/nips/blob/master/22.md) comment (`kind:1111`) carrying `["t", "<word>"]` belongs to the community for that word. There is exactly **one** community per word, globally: no definition event, no creator, no moderators, no approval step. Its handle is **`w/<word>`**, a copy-able identifier.

It is the **open counterpart to [NIP-72](https://github.com/nostr-protocol/nips/blob/master/72.md)**: it reuses NIP-72's post/comment/reaction substrate (`kind:1111` posts, NIP-22 comment trees, `kind:7` reactions) but replaces NIP-72's owned `kind:34550` definition and `kind:4550` moderator approval with a single tag. Moderation is entirely client-side (proof-of-work, Web-of-Trust, muted words, blocked pubkeys).

## Motivation

NIP-72 binds a community to an owned `kind:34550` definition and gates its feed behind moderator `kind:4550` approvals. That is the right model when a community wants an owner, a moderator set, and a curated feed. It also centralizes: a community has an author, its metadata is controlled, and multiple communities can claim the same name (`34550:<creatorA>:gaming` and `34550:<creatorB>:gaming` are different rooms).

Word Communities remove the owned object. The community for `gaming` is simply every top-level `kind:1111` post tagged `["t", "gaming"]`. There is nothing to create, nobody owns the word, and there is exactly one `gaming` globally. This mirrors, at the threaded-forum level, the same "a tag is the room" idea that Topic Chat applies to flat chat. Because there is no moderator, quality control moves to the read path: proof-of-work, Web-of-Trust scoring, muted words, and blocked pubkeys, all client-side.

## 1. The Model

- A word community is **not a created object**. It is the set of all top-level `kind:1111` posts carrying `["t", "<word>"]`.
- The word is normalized to **lowercase**, trimmed. There is exactly **one** community per normalized word.
- Its handle is **`w/<word>`**, a copy-able identifier (not a URL).
- It does **not** collide with flat Topic Chat (`kind:1312`) even when they share the `t:<word>` namespace: every fetch is kind-pinned (`1111` vs `1312`), so the two never cross-populate.

## 2. Top-Level Post (Kind `1111`)

**Type**: Regular Event (NIP-22 comment used as a root post). **Content**: Markdown.

```json
{
  "kind": 1111,
  "pubkey": "<author>",
  "created_at": 1893456000,
  "tags": [
    ["t", "gaming"],
    ["subject", "Best co-op games of 2026?"],
    ["nonce", "1337", "15"]
  ],
  "content": "<body markdown>",
  "sig": "<sig>"
}
```

- `["t", "<word>"]` scopes the post to the community. Relay-filterable, normalized lowercase. The `t` tag **is** the membership.
- `["subject", "<title>"]` is the post title (NIP-14).
- A top-level post carries **no** `e`/`E` parent reference: it is the root of its own thread.
- `["nonce", ...]` optional proof-of-work (NIP-13), see Section 8.

## 3. Comments (NIP-22)

Comments are standard NIP-22 `kind:1111` events with the **post as the thread root**. This is identical to a NIP-72 community comment: a comment's root is the post, not the community.

```json
{
  "kind": 1111,
  "pubkey": "<replier>",
  "tags": [
    ["E", "<post_id>"], ["K", "1111"], ["P", "<post_author>"],
    ["e", "<parent_id>"], ["k", "1111"], ["p", "<parent_author>"]
  ],
  "content": "<comment markdown>",
  "sig": "<sig>"
}
```

- Uppercase `E`/`K`/`P` = root scope (the top-level post). Lowercase `e`/`k`/`p` = immediate parent (the post or a parent comment).
- Comments **do not** carry `["t", "<word>"]`: only the top-level post does. This is what makes `#t` fetches return roots only.

## 4. Fetching

- **Top-level posts for a word**: `{"kinds": [1111], "#t": ["gaming"]}`. Returns only roots (comments lack `t`).
- **A post's full comment tree**: `{"kinds": [1111], "#E": ["<post_id>"]}`. The whole subtree in one query; build nesting from the lowercase `e` parent tags.
- **Reactions for a target**: `{"kinds": [7], "#e": ["<target_id>"]}` (see Section 5).

## 5. Reactions & Sentiment Sorting (Kind `7`, NIP-25)

Reactions are standard NIP-25 `kind:7`. To support up/down sorting while staying compatible with reactions from other clients, each reaction's `content` is bucketed **positive** or **negative**. A fixed set of contents is negative; everything else (including `+`, empty, and unknown emoji) is positive.

```
negative = { -, thumbs-down, and a fixed set of negative-sentiment emoji }
```

- One reaction per author counts (latest wins). The two buckets surface as up/down controls.
- Voting is **delete-then-react**: changing or removing a vote first publishes a NIP-09 (`kind:5`) deletion of the prior reaction, then (unless toggling off) publishes the new one, so an author holds at most one active reaction per target.

Sort modes (best-effort, reordering only what was fetched):

- **New**: chronological by `created_at` (default).
- **Top**: by `(positive - negative)`, descending.
- **Hot**: by `(positive + negative)`, descending.

## 6. Appearance (Kind `30044`, optional)

A word has no owner, so its appearance (picture, banner, description; the word itself is the name) is an **addressable** event keyed by `d = <word>`, one per author per word. Resolution is **explicit, not automatic**: a client renders the **viewer's own** `30044` for the word. That event either carries the appearance directly, or **delegates** to another author's via `["a", "30044:<author>:<word>"]` (letting a user adopt and re-share an appearance published by someone they follow). With no `30044` for a word, nothing extra renders.

```json
{ "kind": 30044, "tags": [["d","gaming"], ["picture","https://…"], ["banner","https://…"], ["description","All things gaming"]], "content": "" }
```

```json
// delegate to a followed author's appearance
{ "kind": 30044, "tags": [["d","gaming"], ["a","30044:<author>:gaming"]], "content": "" }
```

This keeps metadata owner-free and fully under each viewer's control without bloating any global list.

## 7. Followed Words (Kind `10044`)

A user's subscribed word communities are a replaceable `kind:10044` event, one `["t", "<word>"]` tag per subscription. Latest-wins, no `d` tag. It mirrors the shape of NIP-51 `kind:10004` (followed NIP-72 communities) but for words.

```json
{ "kind": 10044, "tags": [["t","gaming"], ["t","nostr"], ["t","bitcoin"]], "content": "" }
```

## 8. Moderation (client-side only)

Word communities have **no central moderation**. Filtering is purely client-side:

- **Proof of Work** threshold on top-level posts (NIP-13), per client setting.
- **Web-of-Trust** scoring, dropping below-threshold authors from feeds and notifications.
- **Muted words**.
- **Blocked pubkeys** (NIP-51 `kind:10000`).
- **NSFW**: posts flagged with `["content-warning", "nsfw"]` (NIP-36); a feed toggle (default hidden) shows or hides them.

## 9. Relationship to NIP-72

| | NIP-72 (moderated) | Word Community (this NIP) |
|---|---|---|
| Community creation | `kind:34550` owned definition | none (implicit) |
| Identity of the community | `34550:<creator>:<d>` (addressable) | the word, a `["t","<word>"]` tag |
| How many named "gaming" | many (one per creator) | exactly one, global |
| Post scoping | `A`/`a` = community address | `["t","<word>"]` |
| Post needs approval | yes, moderator `kind:4550` | no |
| Moderation | creator + moderators | none (client-side only) |
| Followed list | NIP-51 `kind:10004` | `kind:10044` |
| Handle | `c/<naddr>` | `w/<word>` |
| Post & comment layer | `kind:1111` (NIP-22) | `kind:1111` (NIP-22), identical |

The comment tree below a top-level post is byte-identical to NIP-72's. The two models diverge **only** at the community and top-level-post layer: NIP-72 binds them to an owned event with an approval gate, Word Communities bind them to a tag. A client MAY present both in one forum UI (an "open" tab for words and a "moderated" tab for NIP-72), since posts are kind-pinned and scoped differently.

## 10. Security & Spam Considerations

- **No gatekeeper**: with no definition and no approval, proof-of-work and Web-of-Trust are the primary quality signals. Clients SHOULD ship sane defaults and expose the thresholds.
- **One word, one community**: because a word maps to a single global room, there is no way to "own" or fork a word. Competing curation is expressed through client-side filtering and the per-viewer `30044` appearance, not through separate communities.
- **Homoglyphs**: word normalization removes casing and whitespace ambiguity but not lookalike characters; this is inherent to a permissionless namespace.
