# NIP-TC: Topic Chat

> **Status**: Draft
> **Depends on**: NIP-01, NIP-10, NIP-13, NIP-78
> **Optional**: NIP-30 (custom emoji), NIP-32 (labels), NIP-36 (content warnings)
> **Working title**: `NIP-TC` is a placeholder identifier; a real NIP number is assigned on submission.

## Abstract

Topic Chat is a permissionless, real-time public chat system scoped by a **topic tag** rather than an owned channel event. A single new event kind, `1312`, carries a plaintext message and a `["t", "<topic>"]` tag; the topic string **is** the room. Anyone may post to any topic, there is exactly one room per topic string globally, and spam is handled by proof-of-work plus client-side filtering rather than by channel ownership or moderation.

It is an **alternative to [NIP-28](https://github.com/nostr-protocol/nips/blob/master/28.md)**: where NIP-28 binds a chat room to a `kind:40` channel event (an owned, deletable object you post *under*), Topic Chat binds the room to a tag (nothing to create, own, or lose).

## Motivation

NIP-28 models a chat room as a `kind:40` "channel creation" event that messages reference by `e` tag. That makes every room an owned object: it has an author, it can be deleted, its metadata is controlled by whoever created it, and it is a single point of failure for the conversation living under it.

Topic Chat removes the object. The "room" for `nostr` is simply every `kind:1312` event carrying `["t", "nostr"]`. There is nothing to create before talking, no owner, and exactly one room per topic string. This is a deliberately thin primitive: one message kind, a tag, and a proof-of-work spam gate. Clients are expected to build a focused, real-time chat experience on top of it (live subscription to the active topic, an inline composer, quick topic switching).

## 1. Message Event (Kind `1312`)

**Type**: Regular Event. **Content**: plaintext (Markdown supported), never encrypted.

```json
{
  "kind": 1312,
  "pubkey": "<sender_pubkey>",
  "created_at": 1893456000,
  "tags": [
    ["t", "gaming"],
    ["nonce", "42", "15"],
    ["e", "<root_event_id>", "", "root"],
    ["e", "<parent_event_id>", "", "reply"]
  ],
  "content": "anyone on the new co-op mode tonight?",
  "sig": "<signature>"
}
```

### Tags

| Tag | Required | Description |
|-----|----------|-------------|
| `t` | Yes | Topic string, normalized to lowercase and trimmed. The room. Relay-filterable via `#t`. |
| `nonce` | Conditional | Proof-of-work nonce, NIP-13 format `["nonce", "<counter>", "<target_difficulty>"]`. Required when the client enforces a minimum difficulty. |
| `e` | No | Reply threading, NIP-10. Two `e` tags per reply: one `root` marker (thread root event id), one `reply` marker (immediate parent). For a direct reply to a top-level message, both reference the same event. |
| `emoji` | No | NIP-30 custom emoji: `["emoji", "<shortcode>", "<url>"]`. |
| `sticker` | No | Sticker: `["sticker", "<shortcode>", "<url>", "<set_address>"]`. |
| `j` | No | GIF attachment: `["j", "<name>", "<url>", "sfw"\|"nsfw"]`. `j` is used because `g` is the NIP-52 geohash tag. |
| `content-warning` | No | NIP-36: marks the message sensitive/NSFW. |
| `L` | Conditional | NIP-32 label namespace. Set to `"content-warning"` when the `content-warning` tag is present. |
| `client` | No | Client identification, e.g. `["client", "DEN Chat"]`. |

## 2. Topics (the room)

- A topic is any string carried in a `["t", "<topic>"]` tag, normalized to **lowercase** with surrounding whitespace trimmed. Clients MUST normalize identically on write and on read so the same topic always resolves to the same room.
- There is exactly **one** room per normalized topic string, globally. No event needs to exist for a topic to be valid; a topic with no messages is simply an empty room.
- The topic string is the copy-able identifier (for example `nostr`, `bitcoin`, `dev`). It is not a URL.

## 3. Threading (NIP-10)

Replies use NIP-10 marked `e` tags: a `root` marker for the thread root and a `reply` marker for the immediate parent. A message with no `e` tags is a top-level message in its topic.

## 4. Proof of Work (NIP-13, coupled model)

Topic Chat uses a **coupled** proof-of-work model: the same difficulty value is both the post requirement and the read filter threshold.

- **Posting**: the client mines the event id to at least the configured difficulty before signing, recording it in the `nonce` tag (NIP-13).
- **Filtering**: the client verifies `countLeadingZeroBits(event.id) >= difficulty` and hides messages below the viewer's threshold. Hidden, not deleted: lowering the threshold reveals them.
- **Default**: `15` bits, configurable per client (range `0` to `40`).

There is no separate read vs write difficulty: higher difficulty means both harder to spam and stricter filtering.

## 5. Topic List (NIP-78, Kind `30078`)

A user's subscribed topics are stored in a NIP-78 Application Specific Data event, one addressable event per user.

```json
{
  "kind": 30078,
  "pubkey": "<user_pubkey>",
  "tags": [
    ["d", "public-chat-list"],
    ["t", "nostr"],
    ["t", "bitcoin"],
    ["t", "dev"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

| Tag | Description |
|-----|-------------|
| `d` | Fixed value `"public-chat-list"`. Makes this a per-user addressable replaceable event. |
| `t` | One tag per subscribed topic (normalized lowercase). |

The list is fetched on startup and republished when topics are added or removed.

## 6. Subscriptions

Active topic:

```json
{"kinds": [1312], "#t": ["<topic>"], "limit": 50}
```

Pagination (older messages):

```json
{"kinds": [1312], "#t": ["<topic>"], "until": <oldest_timestamp>, "limit": 50}
```

Clients maintain a single active subscription for the currently viewed topic. Switching topics closes the old subscription and opens a new one. The active feed ingests new messages in real time.

## 7. Content Tags

Topic Chat carries the same rich content tags as encrypted chat, but plaintext (stored as-is on relays, no encryption layer):

- **Custom emoji** (NIP-30): `["emoji", "<shortcode>", "<url>"]`, rendered inline as images.
- **Stickers**: `["sticker", "<shortcode>", "<url>", "<set_address>"]`, rendered as large standalone images.
- **GIFs**: `["j", "<name>", "<url>", "sfw"|"nsfw"]`, rendered as inline animated images.

## 8. Client Behavior

**Joining a topic**: normalize the entered topic, add it to the local topic list, republish the NIP-78 list (kind `30078`), open a subscription.

**Leaving a topic**: remove it from the local list, clear cached messages, republish the list, and if it was the active topic return to the topic list.

**Sending a message**: build an unsigned `kind:1312` with the `t` tag, optional NIP-10 reply `e` tags, and any content tags; append `["content-warning", ""]` + `["L", "content-warning"]` if NSFW; append `["client", "..."]` if enabled; mine to the configured difficulty if `> 0`; sign; publish with relay-confirmation tracking; optimistically render locally.

**Content filters** (all default OFF except muted words). These are client-side only: all messages are received, then hidden or redacted per preference.

| Filter | Default | Description |
|--------|---------|-------------|
| Show media | OFF | Display embedded images, videos, stickers, GIFs. |
| Show link previews | OFF | Render URL previews. |
| Show custom emoji | OFF | Render NIP-30 shortcodes as images. |
| Hide muted words | ON | Redact messages containing muted words. |

## 9. Relationship to NIP-28

| | NIP-28 (Public Chat) | Topic Chat (this NIP) |
|---|---|---|
| The room | a `kind:40` channel event | a `["t", "<topic>"]` tag |
| Creating a room | publish a channel event first | nothing, the topic just exists |
| Ownership | channel author owns metadata | none |
| How many rooms named X | many (one per channel event) | exactly one, globally |
| Message kind | `42` (references the channel) | `1312` (references a topic) |
| Spam control | client/relay policy | proof-of-work (NIP-13) + client filters |

Topic Chat shares **no event kinds** with NIP-28; it is a distinct model, not an extension. Clients MAY implement both.

## 10. Security & Spam Considerations

- **Plaintext**: messages are public and unencrypted. Topic Chat is for open conversation, never for private communication.
- **Spam**: with no gatekeeper, proof-of-work is the primary defense. Clients SHOULD ship a sane default difficulty and expose it to the user.
- **No identity guarantees**: any keypair may post to any topic. Reputation is out of scope; clients MAY layer their own trust signals (for example Web-of-Trust scoring or muted words) on top of the read path.
- **Impersonation of topics**: topics are strings, so lookalikes (`bitcoin` vs `bltcoin`) are possible. Normalization removes casing/whitespace ambiguity but not homoglyphs; this is inherent to a permissionless namespace.
