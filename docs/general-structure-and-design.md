# DEN Chat — General Structure & Design

> **Hub format v2 (privacy).** New hubs are created as **v2** (`["version","2"]`), which
> hides real member identities, the ban list, join authorship, sender→hub linkage, **and
> the hub's internal structure** (roles, categories, channel names) from the public. Only a
> **public face** (name, icon, banner, blurb, topics) stays visible for the join/Discover
> card; the structure is encrypted and readable only after joining. Members act under a
> per-hub pseudonym `P`; the client resolves the real user behind `P` for display via an
> encrypted identity attestation. v1 hubs are frozen and keep working; a creator upgrades
> by **forking** to a fresh v2 hub (a "this hub has moved" banner then guides members to
> re-join). An **unlisted hub** leaves the public face blank and sets `f=off` — it is
> invisible in Discover, but it still publishes a public hub event (stable `d`, `epoch`,
> `m`) and its pseudonymous `h`-tag traffic is still observable on relays; only its
> branding and discoverability are hidden, not its existence or activity. UI deltas are
> called out inline below. See NIP-CHAT §0/§12.

## App Identity

- **Name**: DEN Chat
- **Logo**: `media/den chat logo a (no bg).png` (primary), `media/den chat logo b (no bg).png` (alt)
- **Taskbar icon**: `media/den chat logo a (bg) (for taskbar_app).png`
- **Default theme**: Dark mode (light mode toggle in Settings)

---

## Authentication

### Login Screen Layout

```
┌────────────────────────────────────────┐
│                                        │
│          [DEN Chat Logo]               │
│           DEN Chat                     │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ Username (DNN ID or npub)        │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │ Password                         │  │
│  └──────────────────────────────────┘  │
│                                        │
│         [ Login ]  ← NIP-UPV2          │
│                                        │
│  ────────────────────────────────────  │
│                                        │
│    [ Login with DENOS ]                │
│    ↑ Only shown if local signer        │
│      detected (NIP-PC55 probe on       │
│      ws://localhost:7777)              │
│                                        │
│  ────────────────────────────────────  │
│                                        │
│    [ Nostr Connect ]                   │
│    ↑ Opens NIP-46 connection modal     │
│      (bunker:// or relay-based)        │
│                                        │
│  ────────────────────────────────────  │
│                                        │
│    [ Import Account ]                  │
│    ↑ Modal: enter 24 words (BIP-39)    │
│      or nsec → logs in immediately     │
│    ⚠ HIDDEN on web/PWA (security)      │
│                                        │
│  ────────────────────────────────────  │
│                                        │
│    [ Generate New Account ]            │
│    ↑ Generates 24-word BIP-39 seed     │
│      → derives keypair at index 0      │
│      → shows npub → logs in           │
│    ⚠ HIDDEN on web/PWA (security)      │
│                                        │
│  ────────────────────────────────────  │
│                                        │
│   [ ← ] [user card] [user card] [ → ] │
│   ↑ Account carousel — shown only if   │
│     local accounts exist (generated     │
│     or imported seeds/nsecs).           │
│     Seed → multiple accounts possible.  │
│     nsec → single account.             │
│     Click a card → instant login.       │
│                                        │
└────────────────────────────────────────┘
```

### Authentication Methods

| Method | Protocol | When Shown | Platform |
|--------|----------|------------|----------|
| Username + Password | NIP-UPV2 (kind 24134) | Always | All |
| Login with DENOS | NIP-PC55 (ws://localhost:7777) | Local signer detected | Desktop + Web |
| Nostr Connect | NIP-46 (relay-based) | Always | All |
| Import Account | BIP-39 seed or nsec | Desktop only | Desktop (Tauri) only |
| Generate New Account | BIP-39 24-word seed | Desktop only | Desktop (Tauri) only |
| Account Carousel | Local storage | Has existing accounts | Desktop (Tauri) only |

### Key Generation

- Generate **24-word BIP-39** mnemonic
- Derive Nostr keypairs using `m/44'/1237'/<index>'/0/0` (standard Nostr derivation path)
- Index 0 = primary identity, index 1, 2, 3... = additional accounts from same seed
- Seed phrase stored in OS secure storage (Tauri keychain/credential manager)
- **Web/PWA: NEVER import or generate seeds/nsecs** — only external signer auth (UPV2, NIP-46, PC55)

### Secure Storage (per platform)

| Platform | Storage | Notes |
|----------|---------|-------|
| Windows | Windows Credential Manager | Via Tauri secure storage plugin |
| macOS | Keychain | Via Tauri secure storage plugin |
| Linux | Secret Service (libsecret/GNOME Keyring) | Via Tauri secure storage plugin |
| Web/PWA | None — no secrets stored | All auth via external signers |

App identifier for secure storage: `den-chat` (distinct from DENOS's `denos`).

---

## Main Application Layout

### Discord-Like Structure

```
┌─────┬──────────────┬───────────────────────────────────────┬──────────────┐
│     │              │ Hub Header                            │              │
│     │              │ [hub name]    [search] [inbox] [gear] │              │
│  H  │              ├───────────────────────────────────────┤              │
│  u  │  Channel     │                                       │   Member     │
│  b  │  List        │  Message Area                         │   List       │
│     │              │                                       │              │
│  S  │  ┌ General   │  ┌─────────────────────────────────┐  │  ┌ Admin    │
│  i  │  │ # general │  │ [avatar] Username    12:34 PM    │  │  │ user1    │
│  d  │  │ # random  │  │ **hello** everyone!              │  │  ├ Mods     │
│  e  │  │           │  │                                   │  │  │ user2    │
│  b  │  ├ Staff     │  │ [avatar] Username2   12:35 PM    │  │  │ user3    │
│  a  │  │ # mod-chat│  │ check this out                    │  │  ├ Members  │
│  r  │  │           │  │ [image attachment]                │  │  │ user4    │
│     │  └           │  │                                   │  │  │ user5    │
│  ┌┐ │              │  └─────────────────────────────────┘  │              │
│  ││ │              ├───────────────────────────────────────┤              │
│  ││ │              │ Message Input                         │              │
│  ││ │              │ [+ attach] [rich text input...] [send]│              │
│  └┘ │              │                                       │              │
├─────┤──────────────┼───────────────────────────────────────┤──────────────┤
│user │              │                                       │              │
│panel│              │                                       │              │
└─────┴──────────────┴───────────────────────────────────────┴──────────────┘
```

### Component Breakdown

#### Hub Sidebar (leftmost, ~72px)

- Vertical strip of hub icons (circular, like Discord server bar)
- Hub icons show first letter or custom image
- Unread indicator (dot / badge count)
- **Hub folders**: drag a hub onto another to create a folder (UUID-identified group)
- Drag-drop to reorder hubs and folders
- Separator between hub groups
- Bottom: `[+]` button to create or join a hub
- Bottom: `[DM]` icon to switch to DM view
- Bottom: user avatar → settings/profile

#### Channel List (~240px)

- Hub name at top with dropdown for hub settings
- Categories as collapsible sections
- Channels as list items with `#` prefix (text) or `📢` (announcement)
- Right-click context menu: mute, notification settings
- Private channels only visible if user has the group secret

#### Message Area (flexible center)

- Message list with infinite scroll (up = older messages)
- Each message: avatar, username (with role badge color), timestamp, markdown content
- Attachments rendered inline (images, files with download link)
- Replies show a compact preview of the parent message
- Epoch indicator when decryption key changes (subtle divider: "encryption updated")
- Message actions on hover: reply, react, quote, more (...)

#### Member List (~240px, right)

- Grouped by role (e.g., "Admin — 1", "Moderators — 3", "Members — 47")
- Visual differentiation per spec §7.3:
  - Creator's list members: full color, solid badge
  - Facilitated members: slightly muted, facilitated-by indicator
  - Manually followed: more muted, small indicator
  - Unknown: greyed, behind "show unverified" toggle
- No online/offline status (no reliable decentralized presence mechanism; relay polling would be too costly)
- Click → profile card modal
- **v2:** the tree stores pseudonyms `P`; the sidebar shows the **real user** by decrypting the
  page's group-encrypted **roster segment** (`{P:R}` under `HKDF(hub_secret_epoch, "roster:epoch:<epoch>")`) — one
  decrypt per page, free with the page, and present even for members who never posted — then
  rendering `R`'s profile. The `P→R` mapping is cached. (Message authorship is proven
  per-message, §0.1; the roster segment carries the real keys for the roster and bans.)

#### User Panel (bottom-left)

- User avatar, display name, DNN ID or npub
- Mic/audio controls (future: voice channels)
- Settings gear icon

---

## Hub Management Views

### Create Hub Modal

1. Hub name
2. Hub icon (upload via Blossom)
3. Select/add general relay(s)
4. Select/add Blossom server(s) (min 1, recommend 3)
5. Default roles (auto-create `everyone` role)
6. `[Create]` → generates hub secret → creates member file → uploads to Blossom → publishes kind 36942

### Hub Settings Page (gear icon on hub header, creator/admin only)

- **Overview**: name, icon, description, banner
- **Roles**: create/edit/delete roles, permission matrix
- **Channels**: create/edit/delete/reorder channels and categories
- **Members**: view member list, accept join requests, batch actions, sync from mod lists
- **Blossom**: manage Blossom servers, view index file status
- **Relays**: manage general relays
- **Security**: view current epoch, trigger manual secret rotation

### Join Request Queue

- List of pending join requests (kind 36944)
- Each card: user avatar, display name, npub, DNN ID (if any)
- Actions: `[Accept]` (add to member file) `[Reject]` (ignore / block)
- Batch select: checkbox per request → `[Accept All Selected]`
- Sync button: "Import members from [mod name]'s list" (manual action, copies missing members from a mod's Blossom file to the creator's list)

---

## Direct Messages

- Accessible via DM icon on hub sidebar
- Uses NIP-17 (gift-wrapped DMs) — completely separate from hub encryption
- DM list: conversations sorted by recency
- DM thread: same message rendering as channels

---

## DNN Integration

- DNN IDs displayed with verified badge (green ✓) next to usernames
- DNN ID shown in profile cards, member list, and user panel
- Node discovery via kind 64600 + hardcoded fallbacks
- Resolution cached for 5 minutes in memory
- Verification: DNN resolution npub must match profile pubkey
- Login via NIP-UPV2: DNN ID is the "username" field

---

## User Hub List (Kind 16942) — Folder Support

The User Hub List event supports **folders** (grouped hubs) and **ordering**:

```json
{
  "kind": 16942,
  "pubkey": "<user_pubkey>",
  "tags": [
    ["v", "<hub1_d_tag>", "<relay_hint>", "0"],
    ["v", "<hub2_d_tag>", "<relay_hint>", "1"],
    ["v", "<hub3_d_tag>", "<relay_hint>", "2:<folder_uuid>"],
    ["v", "<hub4_d_tag>", "<relay_hint>", "3:<folder_uuid>"],
    ["v", "<hub5_d_tag>", "<relay_hint>", "4"],
    ["folder", "<folder_uuid>", "<folder_name>"]
  ],
  "content": "",
  "sig": "<signature>"
}
```

| Tag | Description |
|-----|-------------|
| `v` | 4th value: position (integer). If `position:folder_uuid`, hub belongs to that folder. Position determines display order. |
| `folder` | Defines a folder group: `["folder", "<uuid>", "<name>"]` |

- Hubs without a folder UUID are top-level
- Folders themselves have a position (determined by the first hub in the folder)
- Drag-drop reorder updates positions and re-publishes kind 16942
- Drag hub onto hub → creates new folder → prompts for name (or generates default)
- Drag hub into existing folder → moves it into the folder

---

## Settings Page

### Sections

| Section | Contents |
|---------|----------|
| **Account** | Profile info, DNN ID, npub, relay list, Blossom server list |
| **Appearance** | Theme toggle (dark/light), font size, compact mode |
| **Notifications** | Per-hub notification settings, DM notifications |
| **Connected Apps** | NIP-46 / NIP-UPV2 / NIP-PC55 sessions (if using external signer) |
| **Security** | Seed phrase backup (show 24 words), connected devices, logout |
| **About** | Version, links, licenses |

### Theme

- **Dark mode** (default): deep dark background (#1a1a2e or similar), muted accents
- **Light mode**: clean white/light gray, same accent colors
- Toggle: switch in settings + stored in `localStorage`
- Implementation: CSS variables for all colors, toggled by adding `data-theme="light"` to `<html>`

---

## Notifications

- Unread badges on hub icons (sidebar)
- Channel bold text for channels with unread messages
- Desktop notifications (via Tauri notification plugin) for DMs and mentions
- Web notifications (via Notification API) for DMs and mentions
- @mention highlighting in messages
- @everyone / @here support (based on permissions)

---

## UX Flows

### First Launch (Desktop)

```
App opens → Login screen
  → User generates account OR imports seed/nsec OR uses external signer
  → Main app loads
  → Empty hub sidebar
  → Prompt: "Join a hub or create your own"
  → [Join Hub] (enter naddr) or [Create Hub]
```

### First Launch (Web/PWA)

```
App opens → Login screen
  → Only external signer options shown (UPV2, NIP-46, PC55)
  → No import/generate (security)
  → Main app loads
  → Same flow as desktop
```

### Joining a Hub

```
User clicks [+] on hub sidebar → [Join Hub]
  → Enters naddr or hub d_tag
  → Client fetches hub event (kind 36942) from general relays
  → Preview: hub name, icon, description, member count, channel list
  → User clicks [Join]
  → Publishes kind 36944 to general relays
  → Shows "Pending" state on hub icon
  → When accepted: icon transitions to full color, channels load, messages decrypt
  → Kind 16942 updated with new hub entry
```

**v2 join & fork UX:**

- **Joining a v2 hub:** the client derives the user's per-hub pseudonym `P` and its
  identity attestation, and publishes a **sealed** join request (kind `36944`) that only
  the hub owner can decrypt (ephemeral-static ECDH). The owner's join queue shows the real
  requester; on accept, `P` is added to the tree. Thereafter the user posts as `P` with an
  encrypted `identity` tag on every event.
- **v2 join preview:** the join card shows only the **public face** (name, icon, banner,
  blurb, topics, approximate member count from the public index) — **not** the channel
  list, which is in the encrypted `content` and unlocks only after the user is admitted and
  obtains the hub secret from the tree.
- **Forking a v1 hub:** the creator uses **Create v2 copy** (hub settings). It spawns a
  fresh v2 hub and stamps the old hub with `new_hub`. The old hub then shows a permanent
  **"This hub has moved to a new version — request to join"** banner (creator also sees a
  **Delete old hub** control). History does not move; the old hub stays readable until
  deleted. Discovery hides hubs that carry a `new_hub` tag.

### Sending a Message

```
User types in message input (Tiptap)
  → Formats with markdown, adds mentions, attaches files
  → Hits Enter or clicks Send
  → Client:
    1. Uploads attachments to Blossom (all o servers)
    2. Builds plaintext JSON: { text, attachments }
    3. Looks up channel encryption → hub secret or group secret
    4. Derives channel_message_key via HKDF
    5. Encrypts with AES-256-GCM → base64(IV || ciphertext || tag)
    6. Creates kind 36943 event with h, c, epoch tags
    7. Signs event (via signer or local key)
    8. Publishes to the hub's general relays
```

### Creating a Hub

```
User clicks [+] → [Create Hub]
  → Create Hub modal opens
  → Fills in: name, icon, description
  → Adds relays (at least 1 general)
  → Adds Blossom servers (recommend 3)
  → Clicks [Create]
  → Client:
    1. Generates hub UUID (d tag)
    2. Generates hub_secret (32 random bytes)
    3. Creates everyone role with default permissions
    4. Creates default #general channel
    5. Builds LKH tree with creator as sole leaf (NIP-04 encrypted)
    6. Uploads tree file to Blossom servers
    7. Creates index file, uploads
    8. Creates history file (epoch 1), uploads
    9. Publishes kind 36942 hub event
    10. Updates kind 16942 user hub list
```

---

## Responsive Behavior

| Viewport | Layout |
|----------|--------|
| Desktop (≥1024px) | Full 4-column layout (sidebar + channels + messages + members) |
| Tablet (768–1023px) | Channel list and member list in slide-out drawers |
| Mobile (≤767px) | Single column, swipe navigation between panels |

*Web/PWA should handle all viewports. Desktop (Tauri) can enforce minimum window size.*

---

*This document will be updated as development progresses and design details are refined.*
