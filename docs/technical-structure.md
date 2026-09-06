# DEN Chat — Technical Structure

> **Hub format v2 (privacy).** This document describes the shared implementation. Where
> hub-member privacy applies, a v2 hub (`["version","2"]` on kind `36942`) differs from a
> v1 hub: member tree leaves store per-hub **pseudonyms `P`** (not real keys), leaf pages
> and the ban list are **encrypted blobs**, each event carries an encrypted `identity`
> attestation, join requests are sealed to the owner, and migration is by **forking** to a
> fresh hub (never in place). See NIP-CHAT §0 for the full
> model. v1 hubs are frozen and keep working as-is.

## Tech Stack

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Desktop shell | Tauri v2 | `^2.x` | Multi-OS (Windows, macOS, Linux). Same architecture as DENOS. |
| Frontend | React | `^19.x` | Component-based UI. |
| Language | TypeScript | `^5.7` | Type safety across the entire codebase. |
| Build | Vite | `^6.x` | Fast dev server, production builds. |
| Styling | Tailwind CSS v4 | `^4.x` | Utility-first, v4 with `@tailwindcss/vite`. |
| Components | Radix UI | Latest | Accessible, unstyled primitives (dialog, tooltip, popover, etc.). |
| State | Zustand | `^5.x` | Simple, scalable state management. |
| Icons | Lucide React | Latest | SVG icon library. |
| Animations | Framer Motion | Latest | Micro-animations, layout transitions. |
| Drag & Drop | @dnd-kit | Latest | Hub sidebar reorder, folder creation. |
| Markdown | react-markdown + remark-gfm | Latest | Message content rendering with GFM support. |
| Emoji Picker | emoji-picker-react | Latest | Unicode emoji picker for messages and reactions. |

---

## Nostr & Crypto Libraries

| Library | Purpose |
|---------|---------|
| `nostr-tools` | Event signing, relay connections, NIP-01 primitives, NIP-19 encoding (npub/naddr), filters. |
| `blossom-client-sdk` | Upload/download files to Blossom servers. Multi-server upload with progress tracking. |
| `@noble/hashes` | HKDF-SHA256, SHA-256 hashing. Audited, fast, no dependencies. |
| Web Crypto API (`SubtleCrypto`) | AES-256-GCM encrypt/decrypt (channel messages, LKH tree node keys). NIP-04 for leaf key distribution. |
| `@scure/bip39` | BIP-39 mnemonic generation and validation (24-word seed phrases). |
| `@scure/bip32` | BIP-32 HD key derivation (seed → Nostr keypairs at multiple indices). |
| `@tauri-apps/plugin-stronghold` or OS keychain | Secure storage for seeds/nsecs on desktop (Windows Credential Manager, macOS Keychain, Linux Secret Service). |

---

## Nostr Event Kinds Used

### NIP-CHAT Kinds (custom)

| Kind | Name | Type | Purpose |
|------|------|------|---------|
| `36942` | Hub Event | Addressable Replaceable | Hub structure, roles, channels, permissions, relay/blossom/index refs |
| `36943` | Message | Regular | Encrypted channel message (AES-256-GCM with channel-derived key) |
| `36944` | Join Request | Addressable Replaceable | Signal intent to join a hub |
| `36945` | Pin List | Addressable Replaceable | Pinned messages per channel |
| `36946` | Voice Host | Addressable Replaceable | Voice channel host/session management |
| `36947` | Voice Presence | Addressable Replaceable | Voice channel presence (who's in the call) |
| `16942` | User Hub List | Replaceable | User's personal list of joined hubs (with folders) |

### Standard Nostr Kinds

| Kind | NIP | Name | Purpose in DEN Chat |
|------|-----|------|---------------------|
| `0` | NIP-01 | User Metadata | Display names, profile pictures, about text for hub members |
| `1` | NIP-01 | Short Text Note | Social feed posts |
| `3` | NIP-02 | Contact List (Follows) | Follow/unfollow, mutual follows in member lists |
| `4` | NIP-04 | Encrypted DM | Legacy NIP-04 encrypted direct messages |
| `5` | NIP-09 | Deletion Request | Request deletion of own messages (NIP-09 via a-tag and e-tag) |
| `6` | NIP-18 | Repost | Social feed reposts |
| `7` | NIP-25 | Reactions | Message reactions (unicode emoji, NIP-04 encrypted emoji in DMs) |
| `13` | NIP-59 | Seal | Sealed inner event for NIP-17 DMs |
| `14` | NIP-59 | DM Rumor | Rumor content inside sealed sender |
| `1059` | NIP-17 | Gift Wrap | NIP-17 private 1-on-1 DMs (NIP-44 encrypted) |
| `1060` | NIP-17 | Sealed Sender | Inner event of gift wrap for DMs |
| `1984` | NIP-56 | Report | Report content/users |
| `9734` | NIP-57 | Zap Request | Lightning tipping on messages |
| `9735` | NIP-57 | Zap Receipt | Lightning tip confirmation |
| `10002` | NIP-65 | Relay List Metadata | User relay preferences (used by Posting Behaviour) |
| `10050` | NIP-17 | DM Relay List | User DM relay preferences |
| `10063` | NIP-96 | User Blossom Server List | Which Blossom servers a user prefers |
| `24134` | NIP-UPV2 | Login/Signing Flow | Username+password login via DNN IDs |
| `30003` | NIP-51 | Bookmark Set / Link Set | Profile link sets (linktree-style, `d` tag prefixed `links-`) |
| `64600` | DNN | DNN Node Discovery | Discover DNN nodes for ID resolution |

### Custom Content Tags

| Tag | Context | Purpose |
|-----|---------|---------|
| `emoji` (NIP-30) | Hub Chat, DMs | Custom emoji shortcodes with encrypted URLs |
| `sticker` | Hub Chat, DMs | Custom sticker packs with encrypted URLs |
| `j` (GIF) | Hub Chat, DMs | GIF attachments with encrypted URLs (`j` is used because `g` is the standard Nostr geohash tag per NIP-52) |
| `client` | All events | Client identification tag (`DEN Chat`) |
| `nonce` (NIP-13) | Hub Chat | Proof-of-Work for spam prevention |
| `identity` (**v2**) | Hub Chat (all member events) | Encrypted `"R_pub:sig_R"` attestation (`sig_R` = a per-message kind-`27492` attestation) binding the pseudonymous author `P` to their real key. Required in v2 hubs; events without it are dropped. |
| `version` (**v2**) | Hub Event | Hub format version. Absent ⇒ v1; `"2"` ⇒ v2. |
| `new_hub` (**v2**) | Hub Event | On a forked v1 hub, the `d` tag of its v2 successor. |

---

## Publishing Architecture

All event publishing is centralized through the **Posting Behaviour** system:

### Relay Resolution

```
getPublishRelays(hubRelays?) → deduplicated relay URL[]
```

Three toggle-controlled relay sources:
1. **Client relays** — from the relay pool configuration (localStorage)
2. **User relays** — NIP-65 relay list (kind 10002)
3. **Hub relays** — hub-specific relays from hub event (only for hub-scoped events)

Each source can be independently toggled on/off. Optional "limit to 3 per list" randomization.

### Publishing Primitive

```typescript
// All callsites use this pattern:
await publishToSpecificRelays(getPublishRelays(hubRelays), signedEvent)

// Hub-scoped events (messages, join requests, hub edits):
const hubRelays = [...hub.generalRelays]
await publishToSpecificRelays(getPublishRelays(hubRelays), signedEvent)

// Non-hub events (profile, DMs, social posts, emoji sets):
await publishToSpecificRelays(getPublishRelays(), signedEvent)
```

Source of truth: `src/stores/postingBehaviourStore.ts`

### Blossom Upload Resolution

```
getUploadBlossoms(hubBlossoms?) → deduplicated blossom server URL[]
```

Merges client blossom servers, user blossom servers (kind 10063), and hub-specific blossoms.

> **Privacy Note**: Media uploads to Blossom servers are **not encrypted**. A warning banner appears in the file upload strip informing users that server operators can view uploaded files.

---

## Project Structure

```
DEN Chat/
├── docs/
│   ├── NIP-CHAT.md                             # Hub chat protocol spec (v2)
│   ├── NIP-SKD.md                              # Sub-key derivation scheme (pseudonyms)
│   ├── NIP-WEB-Vault.md                        # Web-vault (PWA remote signer) spec
│   ├── aes to Logical Key Hierarchy (LKH).md   # Member-tree key management
│   ├── general-structure-and-design.md         # High-level design
│   └── technical-structure.md                  # This file
├── readme.md                        # Project overview
│
└── client/
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    │
    ├── src/
    │   ├── main.tsx                  # App entry
    │   ├── App.tsx                   # Root component, routing
    │   │
    │   ├── components/
    │   │   ├── ui/                   # Radix UI primitives (button, dialog, tooltip, avatar, etc.)
    │   │   │   ├── BlossomImg.tsx         # Blossom-backed image component
    │   │   │   ├── HashRecoveryModal.tsx  # Hash-based file recovery modal
    │   │   │   └── VerificationBadge.tsx  # DNN ID verification badge
    │   │   │
    │   │   ├── auth/                 # Authentication screens
    │   │   │   ├── LoginScreen.tsx        # Full login screen with all auth methods
    │   │   │   ├── UPV2Login.tsx          # Username + password (NIP-UPV2)
    │   │   │   ├── PC55Login.tsx          # Local signer detection + login (NIP-PC55)
    │   │   │   ├── NIP46Login.tsx         # Nostr Connect modal
    │   │   │   ├── ImportAccount.tsx      # Seed/nsec import (desktop only)
    │   │   │   ├── GenerateAccount.tsx    # Seed generation (desktop only)
    │   │   │   └── AccountCarousel.tsx    # Returning user account selector
    │   │   │
    │   │   ├── layout/
    │   │   │   └── AppLayout.tsx          # Main app layout (sidebar + content area)
    │   │   │
    │   │   ├── hub/                  # Hub (server) UI
    │   │   │   ├── HubSidebar.tsx         # Hub list sidebar (drag-drop folders)
    │   │   │   ├── ChannelList.tsx        # Category + channel tree
    │   │   │   ├── ChannelView.tsx        # Message list, compose, threads, reactions, file upload
    │   │   │   ├── ForumView.tsx          # Forum-style channel view with threaded discussions
    │   │   │   ├── VoiceChannelView.tsx   # Voice channel UI (WebRTC, spatial audio)
    │   │   │   ├── SpatialPanel.tsx       # Spatial audio positioning panel
    │   │   │   ├── MemberList.tsx         # Right sidebar member list (active members for large hubs)
    │   │   │   ├── HubSettingsModal.tsx   # Hub management (roles, channels, blossom, relays)
    │   │   │   ├── HubEventCard.tsx       # Hub event preview card
    │   │   │   ├── HubMessageCard.tsx     # Hub message preview card
    │   │   │   ├── HubInfoModal.tsx       # Hub info display modal
    │   │   │   ├── CreateHubDialog.tsx    # Hub creation wizard
    │   │   │   ├── InviteModal.tsx        # Hub invite link generation
    │   │   │   ├── JoinRequestsModal.tsx  # Pending join requests (mod view)
    │   │   │   ├── LinksModal.tsx          # Profile link sets viewer + editor (kind 30003)
    │   │   │   ├── PinModal.tsx           # Pinned messages modal
    │   │   │   ├── UserHubSettingsModal.tsx # Per-hub user settings (mesh list, prefs)
    │   │   │   └── UserProfileModal.tsx   # User profile view + admin actions (ban, etc.)
    │   │   │
    │   │   ├── chat/                 # Shared chat components
    │   │   │   ├── ChatInputBar.tsx       # Shared compose input (markdown toolbar, emoji, file upload, stickers, GIFs)
    │   │   │   ├── MessageContent.tsx     # Message content renderer (markdown, embeds, spoilers)
    │   │   │   ├── EmojiPickerPopover.tsx # Custom emoji picker + discovery + set management
    │   │   │   ├── StickerPickerPopover.tsx # Custom sticker picker + discovery + set management
    │   │   │   └── GifPickerPopover.tsx   # GIF picker + favorites + discovery
    │   │   │
    │   │   ├── dm/                   # Direct Messages
    │   │   │   ├── DMPage.tsx            # NIP-17 DM conversation list + chat view
    │   │   │   ├── DM04ChatView.tsx      # NIP-04 legacy DM chat view
    │   │   │   └── NewDMModal.tsx        # Start new DM modal (follow list + search)
    │   │   │
    │   │   ├── social/               # Social Feed (kind:1)
    │   │   │   ├── SocialFeedPage.tsx     # Social feed page (following, global, user posts)
    │   │   │   ├── SocialPost.tsx         # Single post with replies, reactions, reposts, zaps
    │   │   │   ├── ComposeBox.tsx         # Post composition with PoW + relay settings
    │   │   │   ├── ComposeSettings.tsx    # Per-post settings (PoW difficulty, relay toggles)
    │   │   │   ├── MediaUploadStrip.tsx   # Reusable file upload preview strip with progress
    │   │   │   ├── RichContent.tsx        # Rich content renderer (images, videos, image galleries)
    │   │   │   ├── PostThread.tsx         # Threaded post view
    │   │   │   └── UserProfilePage.tsx    # User profile page (posts, follows, relays)
    │   │   │
    │   │   ├── discover/
    │   │   │   └── DiscoverPage.tsx       # Hub discovery + join flow
    │   │   │
    │   │   ├── nostr/
    │   │   │   └── NostrCards.tsx         # Nostr entity preview cards (profiles, events, etc.)
    │   │   │
    │   │   └── settings/
    │   │       └── SettingsPage.tsx       # Full settings page (general, network, posting behaviour, emoji/sticker/GIF management, keypair, guides)
    │   │
    │   ├── stores/                   # Zustand state management
    │   │   ├── userStore.ts              # Current user (pubkey, signer, privateKey, profile)
    │   │   ├── hubStore.ts               # Hub state (hubs, channels, members, secrets, prefs)
    │   │   ├── messageStore.ts           # Message cache per hub/channel (with unread tracking)
    │   │   ├── navigationStore.ts        # Navigation state (active page)
    │   │   ├── followStore.ts            # Follow/unfollow (kind 3 contact list)
    │   │   ├── blockStore.ts             # Block/unblock (kind 10000 mute list)
    │   │   ├── dmStore.ts                # NIP-17 DM conversations (gift wrap)
    │   │   ├── dm04Store.ts              # NIP-04 DM conversations (legacy encrypted DMs)
    │   │   ├── socialStore.ts            # Social feed state
    │   │   ├── emojiStore.ts             # Custom emoji sets (kind 30030, NIP-30)
    │   │   ├── stickerStore.ts           # Custom sticker sets
    │   │   ├── gifStore.ts               # GIF favorites + search
    │   │   ├── pinStore.ts               # Pinned messages per channel (kind 36945)
    │   │   ├── voiceStore.ts             # Voice channel state (WebRTC, presence, mute, spatial)
    │   │   ├── postingBehaviourStore.ts  # Relay + blossom publishing toggles (central relay resolution)
    │   │   ├── userListsStore.ts         # User relay list (NIP-65) + blossom server list
    │   │   └── preferencesStore.ts       # UI preferences (12h/24h time, theme, compact mode)
    │   │
    │   ├── hooks/
    │   │   ├── useMessages.ts            # Channel message decryption + send/edit/delete
    │   │   ├── useHubLoader.ts           # Hub data loading (member files, epoch secrets)
    │   │   ├── useHubSubscriptions.ts    # Hub event subscriptions (messages, join requests, pagination)
    │   │   ├── useProfileCache.ts        # Profile metadata caching (kind 0)
    │   │   ├── useBlossomMedia.ts        # Blossom media URL resolution + hash verification
    │   │   ├── useStartup.ts             # App initialization (relay connect, user data load)
    │   │   └── useVoicePresence.ts       # Voice channel presence broadcasting
    │   │
    │   ├── lib/
    │   │   ├── constants.ts              # App-wide constants (storage keys, defaults)
    │   │   ├── utils.ts                  # Utility functions (truncateNpub, formatTimestamp)
    │   │   │
    │   │   ├── nostr/
    │   │   │   ├── relay-pool.ts         # Relay connection pool (connect, subscribe, publish, fetchEvents)
    │   │   │   ├── events.ts             # Event creation helpers (messages, deletions, profiles)
    │   │   │   ├── index.ts              # Re-exports
    │   │   │   ├── nip17.ts              # NIP-17 gift wrap creation + unwrapping
    │   │   │   ├── nip04dm.ts            # NIP-04 encrypt/decrypt helpers
    │   │   │   ├── customEmoji.ts        # Custom emoji tag extraction, encryption, publishing
    │   │   │   ├── customSticker.ts      # Custom sticker tag encryption + set management
    │   │   │   ├── customGif.ts          # GIF tag encryption + favorites publishing
    │   │   │   └── buildRelayIndex.ts    # Relay index building utility
    │   │   │
    │   │   ├── auth/
    │   │   │   ├── upv2.ts              # NIP-UPV2 login key derivation + challenge flow
    │   │   │   ├── pc55.ts              # NIP-PC55 localhost WebSocket discovery + signing
    │   │   │   ├── nip46.ts             # NIP-46 Nostr Connect (relay-based)
    │   │   │   ├── keygen.ts            # BIP-39 seed generation + BIP-32 Nostr derivation
    │   │   │   └── secure-storage.ts    # OS secure storage abstraction (Tauri keychain)
    │   │   │
    │   │   ├── crypto/
    │   │   │   ├── aes.ts               # AES-256-GCM encrypt/decrypt (Web Crypto)
    │   │   │   ├── hkdf.ts              # HKDF-SHA256 key derivation (@noble/hashes)
    │   │   │   ├── lkh.ts               # LKH tree engine — monolithic + paginated (spine/page) building, walking, serialization
    │   │   │   └── constants.ts         # DOMAIN_SALT, event kinds, AES constants
    │   │   │
    │   │   ├── hub/
    │   │   │   ├── buildHubEvent.ts     # Hub event construction
    │   │   │   └── groupEncryption.ts   # Grouped-role encryption helpers (member qualification, group secrets)
    │   │   │
    │   │   ├── blossom/
    │   │   │   ├── index.ts             # Barrel export (re-exports from client.ts, members.ts, treeUpdater.ts)
    │   │   │   ├── client.ts            # Multi-server Blossom upload/download (progress, hash compute, deletion)
    │   │   │   ├── members.ts           # LKH member operations (paginated + monolithic), index file I/O, ban pages
    │   │   │   └── treeUpdater.ts       # Safe atomic tree update (upload → verify → publish → cleanup)
    │   │   │
    │   │   ├── pow/
    │   │   │   ├── pow.ts               # Proof-of-Work mining (NIP-13) + benchmark
    │   │   │   └── pow-worker.ts        # Web Worker for background PoW mining
    │   │   │
    │   │   ├── voice/
    │   │   │   ├── types.ts             # Voice provider interface (abstract)
    │   │   │   ├── cloudflare-provider.ts # Cloudflare Calls WebRTC provider
    │   │   │   ├── livekit-provider.ts   # LiveKit WebRTC provider
    │   │   │   ├── e2ee-crypto.ts       # Voice E2EE key management
    │   │   │   ├── e2ee-worker.ts       # Insertable Streams encryption worker
    │   │   │   ├── spatial-engine.ts    # Spatial audio positioning engine
    │   │   │   ├── rnnoise.ts           # RNNoise noise suppression integration
    │   │   │   └── optional-deps.d.ts   # Optional dependency type declarations
    │   │   │
    │   │   └── cache/
    │   │       └── ...                  # IndexedDB / Tauri FS caching abstraction
    │   │
    │   └── styles/
    │       └── index.css                # Tailwind imports, design tokens, custom styles
    │
    ├── src-tauri/                        # Tauri native shell (desktop only)
    │   ├── tauri.conf.json
    │   ├── Cargo.toml
    │   └── src/
    │       └── main.rs
    │
    └── public/
        ├── favicon.ico
        └── icons/                       # App icons for Tauri builds
```

---

## Authentication & Key Management

### Authentication Methods

| Method | Protocol | When Available | Platform |
|--------|----------|----------------|----------|
| Username + Password | NIP-UPV2 (kind 24134) | Always | All |
| Login with DENOS | NIP-PC55 (`ws://localhost:7777`) | Local signer detected | Desktop + Web |
| Nostr Connect | NIP-46 (relay-based bunker://) | Always | All |
| Import Account | BIP-39 seed (24 words) or nsec | Desktop only | Tauri only |
| Generate Account | BIP-39 24-word seed generation | Desktop only | Tauri only |

**Web/PWA restriction**: Import and Generate options are **hidden** on web/PWA. Private keys must never be handled in a browser environment without OS-level secure storage.

### Key Generation Flow

```
1. Generate 24-word BIP-39 mnemonic
2. Derive seed from mnemonic
3. Derive Nostr keypairs:
   m/44'/1237'/0'/0/0  →  keypair[0]  (primary)
   m/44'/1237'/1'/0/0  →  keypair[1]  (second account)
   m/44'/1237'/2'/0/0  →  keypair[2]  (third account)
   ...
4. Store mnemonic in OS secure storage
5. User can switch between derived accounts
```

### Secure Storage

| Platform | Backend | App ID |
|----------|---------|--------|
| Windows | Windows Credential Manager | `den-chat` |
| macOS | Keychain | `den-chat` |
| Linux | Secret Service (libsecret) | `den-chat` |
| Web/PWA | None — no secrets stored locally | N/A |

### DNN Integration

- DNN IDs are the primary human-readable identifier (replaces NIP-05 for login)
- Resolution: DNN ID → npub via DNN node network
- Node discovery: kind 64600 events + hardcoded fallback nodes
- Verified badge shown on profiles with valid DNN ID
- Used as username in NIP-UPV2 login flow

---

## Crypto Module Detail

### Constants (`lib/crypto/constants.ts`)

```typescript
export const DOMAIN_SALT = '14bf723f-5c4d-4898-9e57-a6aee6e2c8fa-v1';
```

### Key Distribution (Paginated LKH Tree)

The hub's member key hierarchy uses a **paginated spine-and-page architecture**. Members are partitioned into **leaf pages** of up to 10,000 leaves each, with a **spine tree** connecting page roots to a single root that encrypts the hub secret.

> **v2:** Leaf identifiers are pseudonyms `P`, and each **page** carries a group-encrypted,
> epoch-stamped **roster segment** line (`roster:<epoch>:<enc({P:R})>` under
> `HKDF(hub_secret_epoch, "roster:epoch:<epoch>")`). The **leaf pages stay plaintext** (keyed on the unlinkable
> `P`), so `findPageForPubkey` binary search and the v1 hub-secret bootstrap are unchanged —
> the page *is* the tree distributing the hub secret, so a hub-secret-derived page key would be
> undecryptable before you hold the secret. The ban page is encrypted and stores real keys `R`.
> See NIP-CHAT §5.2.1 and §5.3.

```
Paginated LKH Architecture:

  Index File (Blossom)
  ├── spine:<hash>            → Spine file (connects page roots to hub secret)
  ├── leaf-page:0:<hash>      → Page 0 (up to 10,000 members)
  ├── leaf-page:1:<hash>      → Page 1
  ├── ...                     → ...
  ├── bans:0:<hash>           → Ban page
  ├── history:<hash>          → Epoch secret history
  └── group:<id>:<hash>       → Group tree (monolithic, per grouped_roles)

Spine Tree:
                 [Spine Root] → encrypts hub_secret
                /              \
          [Node A]          [Node B]
          /     \            /     \
    [PageRoot₀] [PageRoot₁] [PageRoot₂] [PageRoot₃]
         ↓           ↓           ↓           ↓
      Page 0      Page 1      Page 2      Page 3

Leaf Page (self-contained subtree):
              [Page Root]
             /            \
        [Node]          [Node]
        /    \          /    \
      M₁    M₂       M₃    M₄

  Leaf level:   NIP-04 encrypt leaf key for each member's pubkey
  Internal:     AES-GCM encrypt node key with children's keys
  Page root:    Top node of the page subtree (key bridges to spine)
  Spine root:   AES-GCM encrypt hub_secret with root key
```

#### Member Decryption Path (Paginated)

```
  1. Download index file → findPageForPubkey(index, myPubkey) → page hash
  2. Download my leaf page + spine file (2 parallel fetches)
  3. NIP-04 decrypt leaf key (1 signer call)
  4. Walk leaf page: AES-decrypt up to page root (~log₂(PAGE_SIZE) steps)
  5. Walk spine: AES-decrypt from page root up to spine root (~log₂(pages) steps)
  6. AES-decrypt hub_secret from spine root
```

#### Creator-Side Operations

| Operation | Downloads | Uploads | NIP-04 Calls |
|-----------|-----------|---------|-------------|
| Add member | 1 page + spine | 1 page + spine + index | 1 (new leaf) |
| Remove/ban member | 1 page + spine | 1 page + spine + history + index | 0 |
| Change member role | 1 page + spine | 1 page + spine + index | 0 |
| Fix encryption (full rebuild) | None (from store) | All pages + spine + history + index | N (all members) |

The spine stores **encrypted page-root keys** (`pr-key:<nodeId>:<aes_encrypted_rawKey>` lines) allowing the creator to recover all page-root keys from the spine alone, without downloading all pages. This enables O(1) spine rebuilds after single-page modifications.

#### Monolithic Trees (Group Trees, Facilitator Mesh Lists)

Group trees and facilitator mesh lists remain monolithic (single tree file with `tree:<hash>` in the index). They are small enough (group members or facilitator's members) that pagination is unnecessary.

```
Monolithic LKH Tree (group/facilitator):

  Leaf level:   NIP-04 encrypt leaf key
  Internal:     AES-GCM encrypt node key with children's keys
  Root:         AES-GCM encrypt group_secret (or hub_secret) with root key
```

#### Member Sidebar (Active Members)

For **small hubs** (1 leaf page / monolithic), the sidebar shows all members with full search.

For **large hubs** (>1 leaf page), only the user's own page is loaded at startup (up to `PAGE_SIZE = 10,000` members). The sidebar:
- Displays **"Active Members"** instead of "Members"
- Shows an info tooltip with approximate total count (`pageCount × PAGE_SIZE`)
- Search operates over loaded members only
- Directs users to Hub Settings → Members for full npub search

The page count is stored in `hubStore.hubPageCounts` (set by `useHubLoader` from the parsed index).

### Channel Message Encryption

```
1. HKDF(hub_secret, hub_d_tag, channel_id)         → channel_message_key
2. AES-GCM(channel_message_key, plaintext_json)    → message content
```

> **v2 — encrypted hub content.** A v2 hub also encrypts the hub event's structural
> `content` (roles, categories, channel names, permissions, plugins):
> `hub_content_key = HKDF(hub_secret, salt, "hub-content:epoch:<epoch>")`, then
> `AES-GCM`. The public face (`n`, `picture`, `banner`, `about`, `t`) moves to plaintext
> tags so the join/Discover card renders. The hub **secret still lives in the tree** (via
> `m` → page/spine), not in the content — so a newly-added member gets the secret from the
> tree first, then decrypts the content like any message.

### Ciphertext Format

```
base64( 12-byte-IV || ciphertext || 16-byte-auth-tag )
```

---

## Feature Summary

### Hub Chat
- Real-time encrypted messaging (AES-256-GCM channel keys)
- Reply/thread system with thread modal
- Message editing and deletion (NIP-09)
- File attachments via Blossom upload (multi-server, progress tracking)
- Custom emoji (NIP-30), custom stickers, GIFs (encrypted tags)
- Emoji reactions
- Proof-of-Work (NIP-13) with configurable difficulty
- Pinned messages (kind 36945)
- NSFW content toggle
- Forum-style channels with threaded discussions, titles, featured images, and tags
- Raw event viewer with decrypted content
- Client tag (`DEN Chat`) toggle

### Voice Channels
- WebRTC voice calls (Cloudflare Calls + LiveKit provider abstraction)
- E2EE voice encryption (Insertable Streams API)
- Push-to-Talk and Voice Activity Detection modes
- Spatial audio positioning with dual-mode engine (3D HRTF + scalar fallback)
- 3D HRTF directional audio (left/right panning, distance attenuation via PannerNode)
- Hearing cone control (0% full circle → 100% tight directional cone, VRChat-style)
- RNNoise-based noise suppression
- Per-user volume control and mute
- Visual speaking indicators (green glow, DataChannel-broadcast VAD state)
- Voice presence broadcasting (kind 36947)
- DataChannel state sync (~10Hz) for real-time position, heading, cone, speaking, mute state

### Direct Messages
- **NIP-17 DMs**: Gift-wrapped, NIP-44 encrypted, sealed sender privacy
- **NIP-04 DMs**: Legacy encrypted DMs for backward compatibility
- Both support: replies, threads, emoji reactions, custom emoji, stickers, GIFs
- File attachments via Blossom upload
- Conversation filtering (following vs. other)
- DM04 reaction encryption (NIP-04 encrypted emoji content)
- Raw event viewer with decrypted content

### Social Feed
- Kind 1 text notes (following feed, global feed, user profile feed)
- Replies and threaded discussions
- Reactions (kind 7), reposts (kind 6), bookmarks
- Post composition with markdown toolbar
- Per-post Proof-of-Work settings
- Media attachments via Blossom upload
- Custom emoji in posts
- User profile pages (posts, follows, relays)

### Custom Content
- **Custom Emoji Sets**: Create, import (a-tag), manage NIP-30 emoji sets (kind 30030)
- **Custom Sticker Packs**: Create, import, send stickers in chat and DMs
- **GIF Support**: Search (Tenor API), favorites, send GIFs in chat and DMs
- All custom content tags are encrypted in hub chat (AES) and NIP-04 DMs

### Settings
- General: display name, profile, client tag toggle
- Network: relay management, blossom server management
- Posting Behaviour: relay source toggles (client/user/hub), rate limiting
- Emoji/Sticker/GIF management (create, import, remove sets)
- Keypair management (seed backup, account switching)
- Guides tab with video tutorials

### Hub Management
- Hub creation wizard (name, description, icon, channels, roles, relays, blossom servers)
- Channel/category management (text, voice, announcement, forum)
- Role-based permissions (admin, moderator, custom roles)
- Member management (join requests, bans, mesh lists)
- Hub settings (epoch, PoW requirement, relays, blossom servers)
- Hub discovery page with search and filtering
- Hub invite links (naddr encoding)
- Hub folders in sidebar (drag-drop organization)

### Profile Links
- Linktree-style link sets using NIP-51 kind 30003 (d-tag prefixed `links-`)
- Multiple link sets per user with title, description, and header image
- Link items stored as `r` tags with optional labels
- Set ordering via `order` tag (reorderable in editor)
- Link reordering within each set
- Header image upload via Blossom
- Per-set publish with change detection (only modified sets need republishing)
- Set deletion via empty replacement + kind 5 deletion request
- Viewer modal accessible from user profile (any user)
- Editor modal for self (create, edit, delete, reorder sets and links)
- Smart link icons (auto-detects Twitter, GitHub, YouTube, etc. from URL domain)

---

## Subscription Strategy

### Active subscriptions (always running)

| Subscription | Filter | Purpose |
|---|---|---|
| Hub events | `{kinds: [36942], #d: [hub1, hub2, ...]}` | Detect epoch changes, hub updates |
| User Hub List | `{kinds: [16942], authors: [self]}` | Keep hub list in sync |
| User Metadata | `{kinds: [0], authors: [visible_members]}` | Profile info for rendered members |
| NIP-17 DMs | `{kinds: [1059], #p: [self], limit: 200}` | Incoming gift-wrapped DMs |
| NIP-04 DMs | `{kinds: [4], #p: [self]} + {authors: [self]}` | Legacy encrypted DMs |

### On-demand subscriptions (per channel view)

| Subscription | Filter | Purpose |
|---|---|---|
| Channel messages | `{kinds: [36943], #h: [hub_d], #c: [channel_id]}` | Load messages for viewed channel |
| Join requests | `{kinds: [36944], #d: [hub_d]}` | Mod view: pending joins |
| Voice presence | `{kinds: [36947], #h: [hub_d], #c: [voice_channel_id]}` | Voice channel participants |

### Background tasks

| Task | Frequency | Purpose |
|---|---|---|
| Hub event check | On reconnect + every 5 min | Catch missed epoch changes |
| Unread count | Every 30 sec per idle hub | Badge count on hub sidebar |

---

## Web Deploy

The same codebase serves both desktop and web:

```
client/src/       → React app (pure web, no Tauri imports at the top level)
client/src-tauri/ → Tauri native shell (desktop only)
```

- **Desktop**: `npm run tauri build` → platform-specific installer
- **Web**: `npm run build` → `dist/` folder → deploy to Vercel / Cloudflare Pages / any static host
- **PWA**: add `vite-plugin-pwa` for installable web app experience

Tauri-specific code is gated behind runtime checks:

```typescript
import { isTauri } from './utils/platform';

if (isTauri()) {
  // Use Tauri filesystem API, secure storage, etc.
} else {
  // IndexedDB / Web API fallback
}
```

---

## Storage & Caching

| Context | Technology |
|---------|-----------|
| Web (browser) | IndexedDB for large data (member file pages, epoch secrets, message cache). `localStorage` for small config. |
| Desktop (Tauri) | Tauri filesystem API for large caches. `localStorage` for small config. |
| Platform detection | `const isTauri = '__TAURI__' in window;` — branch at runtime. |

### What to cache locally

| Data | Storage | Lifecycle |
|------|---------|-----------|
| Hub events (kind 36942) | IndexedDB/Tauri FS | Updated on subscription push |
| Member file pages | IndexedDB/Tauri FS | Re-download only changed pages (compare hash) |
| Epoch secrets by number | IndexedDB/Tauri FS | Persist forever (needed for historical decryption) |
| History file | IndexedDB/Tauri FS | Re-download on epoch change |
| User Hub List (kind 16942) | IndexedDB/Tauri FS | Updated on join/leave |
| Message cache | IndexedDB | Recent messages per channel, lazy-loaded, with unread counters |
| Posting behaviour | localStorage | Relay/blossom toggle settings |
| UI preferences | localStorage | Time format, theme, compact mode, guides dismissed |
| Authentication state | Secure storage (desktop) / memory (web) | Seed, nsec, sessions |

---

## NIP Reference

| NIP | Used For |
|-----|----------|
| NIP-01 | Core protocol — events, relays, filters, subscriptions |
| NIP-02 | Contact lists (follow/unfollow) |
| NIP-04 | Legacy encrypted DMs (kind 4) |
| NIP-09 | Message/event deletion requests |
| NIP-13 | Proof of Work — `nonce` tag for spam prevention |
| NIP-17 | Private 1-on-1 DMs (gift wrap, sealed sender) |
| NIP-18 | Reposts (kind 6) |
| NIP-19 | Encoding — `npub`, `naddr`, `nevent` for sharing |
| NIP-25 | Reactions on messages and posts |
| NIP-30 | Custom emoji shortcodes and sets (kind 30030) |
| NIP-44 | NIP-44 encryption (used by NIP-17 gift wrap) |
| NIP-46 | Nostr Connect — relay-based remote signing |
| NIP-51 | Lists — profile link sets (kind 30003, linktree-style) |
| NIP-56 | Reporting content/users |
| NIP-57 | Zaps (Lightning tips on messages) |
| NIP-59 | Gift Wrap (seal + rumor for DM privacy) |
| NIP-65 | Relay list metadata — user relay preferences |
| NIP-96 | Blossom server list — user blossom server preferences |
| NIP-UPV2 | Username/password login via DNN IDs (kind 24134) |
| NIP-PC55 | Local desktop signer via localhost WebSocket |
| DNN | Decentralized naming — DNN ID resolution, node discovery (kind 64600) |

---

## Key References from Existing Projects

### From DENOS
- Tauri v2 project structure and config
- Multi-Blossom upload flow
- Web Crypto AES-GCM encryption patterns (backup encryption)
- Platform-specific build pipeline (Windows .msi, macOS .dmg, Linux .AppImage/.deb)
- Zustand store patterns
- Radix UI component library

### From Jumble
- `nostr-tools` relay connection patterns
- `blossom-client-sdk` integration
- `@noble/hashes` HKDF/SHA-256 usage
- `react-markdown` + `remark-gfm` message rendering
- Emoji picker integration
- PWA configuration (`vite-plugin-pwa`)

---

*This document is a living reference. Last updated May 2026.*
