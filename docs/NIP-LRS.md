# NIP-LRS: Local Relay Signer

A desktop Nostr signer exposes its NIP-46 interface over a **private relay bound to localhost**, so
any NIP-46-capable client on the same machine — a web app in the browser, or an installed app — can
sign through it with **no relays and no key material leaving the signer**, and — on the one-click
discovery path — **no pairing string**.

## Motivation

NIP-46 lets a client sign through a remote signer by exchanging encrypted `kind:24133` events
through a relay. When the client and the signer are on the **same machine**, routing those events
through a public relay adds latency, a relay dependency, and a privacy surface — for a conversation
that never needs to leave the device.

The insight is that the relay can simply be **local**. A signer that runs a minimal NIP-01 relay on
`127.0.0.1` is a rendezvous that both the client and the signer connect to; the NIP-46 traffic is
unchanged. Because it is an ordinary relay speaking the ordinary protocol, **a NIP-46 client needs
no new transport code** — it points a relay URL at localhost. And because the events stay NIP-44
encrypted end-to-end, a local relay is not a weaker channel than a remote one.

This NIP specifies the two things that "run a relay on localhost" does not settle on its own:

1. **A port convention and failover**, so clients and signers find each other with zero
   configuration even when the default port is taken.
2. **Discovery**, so a client can tell a signer's relay apart from an ordinary relay, learn the
   signer's name, and reconnect to the same signer across restarts.

The derivation of NIP-46 itself is untouched; this is a transport and discovery layer.

## 1. Overview

```
  ┌───────────────┐        ws://127.0.0.1:7777         ┌──────────────────────────┐
  │   Client       │  ── NIP-01 relay protocol ───────► │  Signer                   │
  │ (web app, or   │     (carries encrypted NIP-46       │  ┌─────────────────────┐  │
  │  installed app)│      kind:24133 events)             │  │ local NIP-01 relay   │  │
  │               │  ◄───────────────────────────────── │  └──────────┬──────────┘  │
  └───────┬───────┘                                      │  subscribes │ (or in-     │
          │                                              │  to its own │  process)   │
          │ publishes signed event                       │  ┌──────────▼───────────┐ │
          ▼                                              │  │ NIP-46 signer + keys │ │
     ┌────────┐                                          │  └──────────────────────┘ │
     │ Relay   │   (only for publishing, as with any      └──────────────────────────┘
     └────────┘    local-key login)
```

Signing happens entirely on-device. A public relay is involved only when the client publishes the
finished event — identical to a local-key login.

## 2. Identity model

Two distinct keypairs are in play, and keeping them separate is what makes discovery private:

- **Transport key** — a keypair the signer generates **once on install** and persists. It is the
  signer's NIP-46 remote-signer identity: clients encrypt their requests to it, and it is the key a
  client uses to recognize "this signer" across sessions. It is **random and carries no meaning** —
  it is *not* any of the user's accounts. It is the only pubkey a signer reveals at discovery.
- **Account keys** — the user's actual Nostr identities, which the signer signs *as*. An account
  pubkey is **never exposed at discovery**; it is returned to a client only **after the user
  approves a connection** (via the `connect` / `get_public_key` response). So a process that merely
  probes the machine learns "a signer is here" and a throwaway transport key — never *whose*
  accounts it holds.

A signer MAY serve many accounts behind one transport key. The transport key identifies the
*signer install*; the account is chosen per connection.

On reinstall or reset, the transport key is regenerated; the signer is then a new identity and
clients re-pair ([§7](#7-reconnection)). The transport key is not backed up or derived from anything
stable — losing it is indistinguishable from a fresh install, by design.

## 3. Transport

The signer runs a **minimal NIP-01 relay** and MUST bind it to the loopback interface only
(`127.0.0.1` / `::1`). It MUST NOT bind to `0.0.0.0` or any routable interface.

Over this relay, client and signer exchange **unmodified NIP-46**: encrypted `kind:24133` events,
addressed to each other's pubkeys, matched by subscription. The relay only needs to support what
NIP-46 exercises — `EVENT` / `REQ` / `CLOSE` in, `OK` / `EVENT` / `EOSE` / `NOTICE` out. It is a
request pipe, not an archive: an in-memory, bounded buffer is sufficient, and it need not persist
across restarts. It SHOULD retain a small window of recent events rather than dropping each the
instant no subscription matches, so a `REQ` that arrives just after its `EVENT` still matches. It
MUST verify event signatures.

**Browser reachability.** The relay is reached by web pages, which browsers treat specially:

- `ws://127.0.0.1` is a secure context, so an HTTPS page may open it without mixed-content blocking;
  no `wss://` or certificate is needed.
- Chromium gates a request from a public page into a private address behind a **Private Network
  Access** preflight. The signer MUST answer the `OPTIONS` preflight and send
  `Access-Control-Allow-Private-Network: true` (with a permissive `Access-Control-Allow-Origin`), or
  web clients on those browsers cannot connect. Origin is **not** an authorization signal (any page
  may connect); it is at most a display hint.

## 4. Port and failover

- The default port is **7777**.
- On start, the signer binds the **first free port** in the range **7777–7786** (ten ports). This
  lets a signer coexist with unrelated software, or with another signer, that already holds a lower
  port. A signer SHOULD prefer to re-bind its previous port when free, so its port is stable absent
  a collision.
- If no port in the range is free, the signer does not start the relay silently; it surfaces the
  condition and MAY offer a user-set port.
- A signer MAY let the user set a custom port or disable the relay entirely. A custom port outside
  the range is reachable only by a client told about it out of band (below), not by scan discovery.

The range is a shared constant: clients scan the same 7777–7786. Ten is chosen to survive a few
collisions, not to host many signers — a client never expects ten signers, and scanning ten loopback
ports is sub-millisecond per port.

**Escape hatch.** A `bunker://` connection string carries the actual relay URL, including a
non-default port, so paste/QR pairing works on any port. Only *scan discovery* depends on the range.
A signer MAY list its loopback relay alongside public relays in such a string; a client SHOULD
**prefer the loopback relay** when one is present, so a same-machine session stays local instead of
routing through a public relay.

## 5. Discovery

### 5.1 The info document

To support one-click discovery, a signer SHOULD answer a plain HTTP `GET` on its relay port with the
NIP-11 relay information document (`Accept: application/nostr+json`), carrying an **LRS marker**:

```json
{
  "name": "<signer name>",
  "local_relay_signer": {
    "v": 1,
    "transport_pubkey": "<32-byte hex x-only pubkey>"
  }
}
```

- The presence of a `local_relay_signer` object **is** the capability marker: a client treats a port
  as a signer **only** if the info document carries it. An ordinary relay does not, so it is skipped.
  This is a capability test, never a check against a known list of pubkeys or names — any software
  presenting the marker is a candidate signer.
- `transport_pubkey` is the signer's transport key ([§2](#2-identity-model)) — the pubkey a client
  connects to and pins. It is the only pubkey disclosed; no account is listed.
- `name` is **self-declared and untrusted**. Two signers may use the same name, and nothing stops a
  process from claiming any name. A client MUST NOT treat the name as identity; it is a display label
  only. Disambiguate in the UI by showing the name together with a short fingerprint of
  `transport_pubkey`.

Serving the marker is a **SHOULD**, not a **MUST**: it is what upgrades pairing from a paste to a
click. A signer MAY omit it (answering a non-upgrade `GET` as an error) — for privacy
([§8](#8-security-considerations)) or simplicity — and still be fully usable. A signer that omits the
marker **MUST** instead expose a localhost `bunker://` connection string ([§4](#4-port-and-failover))
for the user to copy into a client. That string is the guaranteed fallback: because it is ordinary
NIP-46, **any** NIP-46 client connects with it, whether or not either side implements this NIP. The
marker only removes the paste — it is never required for connectivity.

### 5.2 Finding a signer (client)

To discover signers with zero configuration, a client:

1. **Fast path.** If it has a remembered signer, it tries that signer's **last-known port** first:
   `GET` the info document, and if the marker's `transport_pubkey` matches the remembered one,
   connect — no scan.
2. **Scan.** Otherwise it probes `127.0.0.1:7777` through `127.0.0.1:7786`, requesting the info
   document on each. Each port either is not listening (skip), is not a relay / has no marker (skip),
   or is a signer (collect `{name, transport_pubkey, port}`).
3. **Select.** With one signer found, use it. With more than one, present the list (name + key
   fingerprint) and let the user choose. With none, report "no local signer" — not an error.

Browsers apply the Private Network Access preflight to each probe; a bounded range keeps this cheap.

## 6. Connecting

The session is ordinary NIP-46 over the local relay. Every NIP-46 method rides unchanged
(`connect`, `get_public_key`, `sign_event`, `nip04_*` / `nip44_*`, `get_relays`, and any further
methods a signer supports); this NIP adds **no** new wire method — discovery is out of band (the
info document), not a request. The connection proceeds as:

1. The client has a persistent **client key** (its own NIP-46 keypair), as in any NIP-46 client.
2. It opens a `connect` to the signer's `transport_pubkey` over the relay. On **first** contact there
   is no shared secret — there is no pasted string — so the signer MUST obtain **user approval**
   before the connection is usable, and SHOULD surface that approval **in the signer's own UI**
   (not auto-granted on the wire). The signer records a connection keyed by the client key, with the
   user's chosen policy.
3. On approval, the signer returns the result, and `get_public_key` returns the **account** pubkey
   the user selected — the first point at which the account is disclosed.
4. The client **pins** the signer's `transport_pubkey` (trust on first use) and remembers the
   account it logged in as.

After this, requests flow as normal NIP-46. Safe metadata queries (`ping`, `get_public_key`,
`get_relays`) MAY auto-respond per the signer's policy; signing and encryption follow the
connection's policy.

A client reconnecting with the same client key is recognized by the signer and resumes its stored
policy without a fresh approval.

### 6.1 Client metadata (naming the connection)

In the discovery/bunker direction there is no pasted `nostrconnect://` URI, so the `connect` request
is the only moment a client can name itself. A client SHOULD include a **metadata** JSON object as a
`connect` param so the signer can label the connection with a real app name instead of a raw key or
host:

```json
{ "name": "Jumble", "url": "https://jumble.social", "image": "https://.../icon.png" }
```

Field names match the nostrconnect `metadata` convention (and Amber's `BunkerMetadata`), so one blob
works against either signer. Because standard NIP-46 positional params are
`[signer_pubkey, secret, perms]`, a signer SHOULD locate the metadata by scanning the params for a
JSON object carrying a non-empty `name` rather than pinning an index — this coexists with `perms`
and any order a client appends it. All fields are optional and advisory (display only); a signer MUST
NOT grant trust based on them. When absent, the signer falls back to the web **Origin** it observed —
read from the `Origin` header on the client's WebSocket handshake, which a browser sets to the page's
origin (a non-browser client sends none) — then to the client key. The metadata is not re-sent on
reconnect; the signer keeps the name it stored at first approval.

## 7. Reconnection

The port is a **cache**; the `transport_pubkey` is the identity.

A client persists `{ transport_pubkey, account_pubkey, last_port }`. On launch:

1. Try `last_port`; if the info document there carries the matching `transport_pubkey`, reconnect and
   resume as `account_pubkey`.
2. Else scan the range ([§5.2](#52-finding-a-signer-client)) and reconnect to the port whose marker
   matches the pinned `transport_pubkey`.
3. A client MUST match the pinned `transport_pubkey` before reconnecting. If no listening port
   presents it, the signer is **offline** — the client reports that and does **not** connect to a
   different signer that happens to occupy the old port.

**Reinstall / reset** regenerates the transport key, so the pin no longer matches; the signer appears
as a new, unremembered signer and the client re-pairs (a fresh approval). This is the accepted cost
of not backing up the transport key.

## 8. Security considerations

- **Loopback only.** The relay MUST bind `127.0.0.1` / `::1`. Binding a routable interface would
  expose signing to the network.
- **Accounts are not enumerable.** Discovery reveals only the random transport key and a
  self-declared name — never an account pubkey. A probing process (or a web page) learns that a
  signer is present, not whose keys it holds. The account is disclosed only after the user approves a
  connection.
- **Scan discovery is an ambient presence signal.** When a signer serves the info-doc marker
  ([§5.1](#51-the-info-document)), *any* local process — and any web page the browser lets reach
  loopback — can learn that a signer is present and read its `transport_pubkey`. Because that key is
  stable across origins and sessions, it is a cross-site fingerprint: a page can tell this user runs a
  signer and recognize the same install elsewhere, without ever touching an account. This is the cost
  of zero-config discovery, and the reason the marker is a **SHOULD**, not a MUST. A signer that
  serves it SHOULD gate it behind a user setting; the `bunker://` string path
  ([§4](#4-port-and-failover)) advertises nothing and is the zero-leak default.
- **End-to-end encrypted.** NIP-46 traffic over the relay stays NIP-44 encrypted to the transport
  key, so the relay being local adds no plaintext exposure; a process that connects without the
  transport private key cannot read others' traffic.
- **Untrusted clients are gated by approval.** Any local process, and any website via the browser,
  can connect and send requests to the signer. This is expected; it is bounded by the same
  per-connection approval and policy as a remote NIP-46 connection. A signer SHOULD rate-limit
  unapproved senders and MUST NOT auto-approve a new connection without user consent.
- **Name is untrusted.** `name` is self-declared; identity is the pinned transport key. UIs
  disambiguate by key fingerprint, never by name alone.
- **Port collisions are handled, not prevented.** Failover lets signers coexist; it does not let two
  signers hold the same port. A client selecting among multiple discovered signers chooses by pinned
  key, not by port.

## 9. Implementation notes

- **Reuse, don't rebuild, the signer.** A signer that already handles NIP-46 over remote relays
  already processes `kind:24133` from a relay subscription. Hosting a local relay and adding
  `ws://127.0.0.1:<port>` to the signer's own subscription set lets every existing code path — NIP-44
  decryption, the approval pipeline, signing — serve local clients unchanged. The only new component
  is the relay itself; implementations MAY short-circuit the signer's self-connection in process
  rather than opening a loopback socket to themselves.
- **Close HTTP responses cleanly, or browsers reset.** The relay answers two non-upgrade HTTP
  requests on its port — the NIP-11 info `GET` ([§5.1](#51-the-info-document)) and the Private Network
  Access `OPTIONS` preflight ([§3](#3-transport)). Closing either socket while unread request bytes
  remain in the receive buffer makes the OS send a TCP **RST**, which the browser surfaces as
  `ERR_CONNECTION_RESET` — intermittently failing discovery, and (because the preflight gates the
  WebSocket) signing too. A relay that peeks just enough of the request to route it, then closes, hits
  this. Read each request to completion (drain to the blank line, bounded) and shut the write half
  down gracefully before dropping the connection.
- **Toggle-off closes connections.** Disabling the relay MUST answer in-flight requests with an error
  and close open connections, not merely stop accepting new ones — existing connections keep
  processing otherwise.
- **Transport key storage.** Persist the transport key with the same care as any signer key material;
  it is the connection identity, though not itself an account key.

## Appendix A: Client implementation notes (field guide)

Non-normative. Lessons from a shipped web client; useful for anyone writing an LRS client.

### Discovery resilience

- **Never trust a single probe.** A real signer was measured resetting **~40% of browser connections**
  to its NIP-11 endpoint (`ERR_CONNECTION_RESET`). Retry each probe, and re-scan the range a few times
  before concluding "no signer". (Root cause is the §9 "close HTTP responses cleanly" bug on the
  signer side, but a client should be resilient regardless.)
- **`curl` lies.** curl uses a fresh connection each time and ignores CORS, so it hits the endpoint
  reliably even when the browser cannot. "Works in curl" does not mean "works in the client" — always
  test discovery from the actual client runtime.
- **A browser `fetch` cannot distinguish "port closed" from "connection reset"** — both throw a generic
  `TypeError`; the `net::ERR_*` reason is console-only. The one thing you *can* distinguish is your own
  `AbortError` (timeout). Use a short per-probe timeout (~1–1.5s), treat a fast failure as "retry" and
  a timeout as "give up on that port for now".
- **Closed-port behavior is environment-dependent** — some stacks refuse a dead loopback port
  instantly, others hang until your timeout. Scan all ports in parallel with a short timeout so dead
  ports don't stall the scan.

### Web-client specifics

- **CORS + PNA preflight is mandatory on the signer.** The NIP-11 fetch's `Accept: application/nostr+json`
  is a non-simple header, so the browser fires an `OPTIONS` preflight; the WS to `ws://127.0.0.1` is
  likewise gated by the PNA preflight. The same signer bug that RSTs the `GET` also RSTs the preflight,
  so **flaky discovery predicts flaky signing** — budget a connect-retry. `http://127.0.0.1` and
  `ws://127.0.0.1` are treated as secure, so HTTPS pages reach them; the preflight is the gate.
- **PWA service-worker caching will mask fixes.** A cached bundle keeps serving old discovery/signing
  code, so rebuilds appear to do nothing. Bump/replace the service worker and hard-refresh.

### Reuse and identity

- **It's vanilla NIP-46 — point your bunker client at loopback.** Build
  `bunker://<transport_pubkey>?relay=ws://127.0.0.1:<port>` and feed it to your existing NIP-46/bunker
  parser. Signing is unchanged. (Native/installed clients skip CORS/PNA and the SW cache entirely.)
- **First connect blocks on in-app approval; there is usually no `onauth` URL.** On the scan path there
  is no pairing secret, so `connect()` won't resolve until the user approves **in the signer's own
  window**. Don't set an aggressive connect timeout, and don't assume an auth URL will fire.
- **Persist ONE client key per signer**, keyed by `transport_pubkey`, in storage that survives logout.
  Default bunker libraries (nostr-tools included) mint a fresh client keypair each session, so the
  signer sees a new client every login and piles up duplicate connections. Reusing the key also lets
  the signer resume silently (no re-approval).
- **The name is untrusted and will collide — always show a fingerprint.** In testing, two signers both
  self-declared "DENOS"; only the `transport_pubkey` fingerprint told them apart.
- **Pin the transport key (TOFU); the port is just a cache.** On reconnect try the last-known port
  first, then rescan, and reconnect **only** to the port presenting the pinned key.

### Testing

- **A bare HTTP mock of the NIP-11 doc is a trap.** If the stub isn't a real relay (no WebSocket) it
  shows up as a discoverable signer and then fails at `connect` ("all promises were rejected"). Make
  test stubs real relays, or keep them off the scan range.
