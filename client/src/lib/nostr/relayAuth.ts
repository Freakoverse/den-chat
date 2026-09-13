/**
 * relayAuth — NIP-42 relay authentication for the user's OWN inbox reads.
 *
 * NIP-17 recommends relays serve kind-1059 gift wraps only to the p-tagged user, gated behind NIP-42
 * AUTH. Several relays in a typical client list do exactly that (wheat.happytavern.co,
 * asia.vectorapp.io, relay.ditto.pub answer `CLOSED auth-required`). Without answering the challenge,
 * DEN's inbox subscription on those relays silently yields NOTHING — including the user's own
 * self-copies that DEN itself successfully wrote there. That was the "my sent messages vanish on
 * reload" bug: the self-copy existed, the relay just refused to hand it back to an unauthenticated
 * reader.
 *
 * nostr-tools does the protocol work: on a challenge it builds the kind-22242 template (`relay` +
 * `challenge` tags), calls the `onauth` signer we hand it, sends the AUTH, and re-issues the
 * subscription. This module supplies that signer — through the same signer abstraction every other
 * signature uses (local key, extension, bunker, vault) — with one deliberate refusal:
 *
 *   A 22242 proves the user's REAL key `R` is connected to that relay, which is stronger than "an
 *   event was relayed." Connections are shared per relay URL, so authenticating as R on a relay that
 *   also carries a v2 (pseudonym) hub's P/O-signed traffic would let that relay correlate R with the
 *   pseudonym by connection. So: never authenticate on a relay any loaded v2 hub publishes on. The
 *   subscription simply stays closed there — the same outcome as today, with the privacy kept.
 *
 * Only attach this to subscriptions over the user's OWN configured relays (the DM inbox read set),
 * never to hub or peer relay subscriptions.
 */

import { verifyEvent, type EventTemplate, type UnsignedEvent, type VerifiedEvent } from 'nostr-tools'
import { useUserStore, type ISigner } from '@/stores/userStore'
import { useHubStore } from '@/stores/hubStore'
import { isV2 } from '@/lib/hub/version'
import { signWithSigner } from '@/lib/nostr'

const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase()

/** Relays any loaded v2 (pseudonym) hub publishes on — authenticating as R there is refused. */
function v2HubRelays(): Set<string> {
  const out = new Set<string>()
  for (const hub of Object.values(useHubStore.getState().hubs)) {
    if (!isV2(hub)) continue
    for (const r of hub.generalRelays) out.add(norm(r))
  }
  return out
}

/**
 * Build the `onauth` signer for a subscription over the user's own relays. Signs the relay's
 * kind-22242 challenge as the logged-in user, refusing relays that carry v2-hub traffic.
 */
export function makeRelayAuthSigner(
  signer: ISigner | null,
  privateKey: string | null,
): (template: EventTemplate) => Promise<VerifiedEvent> {
  return async (template) => {
    const relay = template.tags.find((t) => t[0] === 'relay')?.[1] ?? ''
    if (relay && v2HubRelays().has(norm(relay))) {
      throw new Error(`[NIP-42] refusing to authenticate as the real key on ${relay}: it carries v2 (pseudonym) hub traffic`)
    }
    const pubkey = useUserStore.getState().pubkey
    if (!pubkey) throw new Error('[NIP-42] not logged in')
    const unsigned: UnsignedEvent = { ...template, pubkey }
    const signed = await signWithSigner(unsigned, signer, privateKey)
    if (!verifyEvent(signed)) throw new Error('[NIP-42] signed AUTH event failed verification')
    console.log(`[NIP-42] authenticated to ${relay || 'relay'}`)
    return signed as VerifiedEvent
  }
}
