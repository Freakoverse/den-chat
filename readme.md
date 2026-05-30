<p align="center">
  <img src="media/DEN Chat Banner.png" alt="DEN Chat" width="100%" />
</p>

# DEN Chat

A decentralized, encrypted chat system built on Nostr.

## What is DEN Chat?

DEN Chat brings hub-based group communication to Nostr — channels, categories, roles, permissions — all without trusting a central server. Messages are encrypted by default using a shared hub secret, so non-members can't read your conversations.

The familiar hub/channel structure you'd expect — but your identity is your Nostr keypair, your messages live on relays you choose, and no corporation controls your community.

## How It Works

### Hubs
A hub is a community space. It has channels for conversation, categories to organize them, and roles to manage permissions. The entire hub structure lives in a single Nostr event owned by the creator.

### Encryption
Every hub has a shared secret. All messages are encrypted with it — non-members see nothing but ciphertext. Private channels can use additional per-group secrets for extra isolation (e.g., a staff-only channel that even regular members can't read).

### Membership
Member lists are stored on [Blossom](https://github.com/hzrd149/blossom) servers as content-addressed files. The creator maintains the canonical list, but any member can facilitate access for others via their own LKH tree — a "mesh membership" model that prevents any single point of failure.

### Filter Relays
For hubs that want stronger access control, optional filter relays gate who can read and write. These specialized relays check the creator's member list before accepting or serving messages.

## Documentation

- **[NIP-CHAT Specification](docs/NIP-CHAT.md)** — the full protocol spec (event kinds, crypto model, relay behavior, client behavior, and security model)

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                    Hub Event                     │
│              (kind 36942, on relays)             │
│                                                  │
│  Roles · Categories · Channels · Permissions     │
│  Relay list · Blossom servers · Index file hash  │
└──────────────────────┬──────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌────────────┐ ┌─────────┐ ┌──────────┐
   │  General   │ │ Filter  │ │ Blossom  │
   │  Relays    │ │ Relays  │ │ Servers  │
   │            │ │         │ │          │
   │ Hub events │ │Messages │ │ Member   │
   │ Join reqs  │ │ (gated) │ │ files    │
   │            │ │         │ │ Block    │
   │            │ │         │ │ lists    │
   │            │ │         │ │ History  │
   │            │ │         │ │ Media    │
   └────────────┘ └─────────┘ └──────────┘
```

## Protocol Summary

| Kind | Event | Purpose |
|------|-------|---------|
| `36942` | Hub Event | Hub structure, roles, channels, permissions |
| `36943` | Message | Encrypted channel message |
| `36944` | Join Request | Signal intent to join a hub |
| `16942` | User Hub List | User's personal list of joined hubs |

## Key Design Decisions

- **Encrypted by default** — all messages use AES-256-GCM. Non-members can't read content.
- **No MLS** — uses ECDH + HKDF + AES-GCM for simplicity and scale. No complex tree state.
- **Mesh membership** — no single point of failure for member lists. Creator is canonical but not exclusive.
- **Full history access** — new members can read all past messages. Removed members lose access to everything.
- **Client-side permissions** — the protocol doesn't gatekeep. Clients decide what to render based on roles.
- **Domain-separated keys** — NIP-CHAT keys can never collide with NIP-04/NIP-17/NIP-44 DM keys.

## Security Model

DEN Chat is designed for **group communication with encryption**, not private messaging:

- ✅ Messages encrypted against outsiders
- ✅ Removed members lose all access (including history)
- ✅ Relay operators can't read message content
- ✅ Multiple relays and Blossom servers prevent single points of failure
- ⚠️ No forward secrecy (by design — group chat history is a feature, not a bug)
- ⚠️ Any current member could leak the hub secret
- ⚠️ Filter relays are trusted for access control (but not for content)

## Project Status

📋 **Specification**: Draft v3 ([NIP-CHAT.md](docs/NIP-CHAT.md))  
🔨 **Client**: In development — hub creation, messaging, reactions, editing, deleting, profiles functional  
🔌 **Filter Relay**: Not yet started  

## Other NIPs & Kinds Involved

### Standard Nostr Kinds Used

| Kind | Name | NIP | Usage |
|------|------|-----|-------|
| `0` | User Metadata | NIP-01 | Profile display (name, avatar, about) |
| `3` | Contact List | NIP-02 | Follow lists |
| `5` | Deletion | NIP-09 | Request deletion of messages |
| `7` | Reaction | NIP-25 | Emoji reactions on messages |
| `1059` | Gift Wrap | NIP-59 | Encrypted envelope for join requests |
| `1060` | Sealed Sender | NIP-59 | Inner sealed message |
| `10002` | Relay List | NIP-65 | User's preferred relay list |
| `10063` | Blossom Server List | Blossom | User's preferred Blossom servers |
| `24134` | UPV2 | UPV2 | Username-password vault login |

### NIPs Referenced

| NIP | Usage |
|-----|-------|
| NIP-01 | Event structure, relay communication |
| NIP-02 | Contact/follow lists |
| NIP-07 | Browser extension signer (`window.nostr`) |
| NIP-09 | Event deletion requests (kind 5) |
| NIP-19 | Bech32 encoding (`npub`, `naddr`, `nevent`) |
| NIP-25 | Emoji reactions on messages (kind 7) |
| NIP-44 | Encrypted payloads (message content encryption) |
| NIP-46 | Remote signer via `bunker://` or `nostrconnect://` |
| NIP-59 | Gift wrap / sealed sender for join requests |
| NIP-65 | Relay list metadata |

## Version Management

To bump the app version across all config files, run from the `DEN Chat` directory:

```
node scripts/bump-version.mjs 0.2.0
```

This updates:

| File | Purpose |
|------|---------|
| `client/package.json` | npm/Vite version + `__APP_VERSION__` UI constant |
| `client/package-lock.json` | Lockfile consistency |
| `src-tauri/tauri.conf.json` | Tauri installer filenames & update manifests |
| `src-tauri/Cargo.toml` | Rust crate version |
| `client/public/version.json` | Web update detection (polled by running clients) |

The web app displays the current version in **Settings → Updates** and automatically detects when a newer version has been deployed (shows a refresh toast).

---

Built on [Nostr](https://nostr.com/) · Encrypted with AES-256-GCM · Stored on [Blossom](https://github.com/hzrd149/blossom)
