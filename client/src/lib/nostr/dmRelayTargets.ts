/**
 * dmRelayTargets — shared "where a DM publishes" model + the progress shape its relay-status UI reads.
 *
 * One source of truth for BOTH the publish set and the sectioned relay-status tooltip, so the two can
 * never drift. Each DM type describes its publish targets as labelled {@link RelaySection}s; the union of
 * all sections is the actual publish set and the UI "total". The shared {@link DmRelayStatus} component
 * renders the counter (confirmed/total) and, on click, the sections with per-relay accept/pending dots.
 *
 * Section layouts (add a new one here if a future DM type appears):
 *   - B-DM (NIP-04) / M-DM (MDM): your NIP-65 relays, the recipient's relays, the client relays.
 *   - W-DM (NIP-17), strict spec: your 10050 DM inbox (self copy) + the recipient's relays; NO client.
 */

import type { Event } from 'nostr-tools'
import { publishWithFailover } from '@/lib/nostr/relay-pool'
import { clientPublishRelays, userPublishRelays } from '@/stores/postingBehaviourStore'

export interface RelaySection {
  label: string
  relays: string[]
}

export interface DmRelayProgress {
  /** Labelled publish targets, in display order. Their union is the publish set and the UI total. */
  sections: RelaySection[]
  /** Relays that have acknowledged the event so far. */
  acceptedRelays: string[]
  /** True once the publish has finished (success or exhausted), so the UI stops spinning. */
  settled?: boolean
}

const normRelay = (u: string) => u.replace(/\/+$/, '')
const uniq = (a: string[]) => [...new Set(a.map(normRelay))]

/** Unique relays across all sections = the real publish set and the UI "total". */
export function dmRelayUnion(sections: RelaySection[]): string[] {
  return uniq(sections.flatMap((s) => s.relays))
}

export function dmProgressTotal(p: DmRelayProgress): number {
  return dmRelayUnion(p.sections).length
}

export function dmProgressConfirmed(p: DmRelayProgress): number {
  const acc = new Set(p.acceptedRelays.map(normRelay))
  return dmRelayUnion(p.sections).filter((r) => acc.has(r)).length
}

/**
 * Section layout for B-DM (NIP-04) and M-DM (MDM): your NIP-65 relays, the recipient's relays, then the
 * client relays. Uses the shared publish helpers so it honours the Settings > Network post-to-X toggles
 * AND the "limit client/user relays" caps (same deterministic per-user pick as getPublishRelays), so the
 * counter reflects exactly the relays targeted. `recipientRelays` is already discovered and gated by the
 * caller (empty when "post to recipient relays" is off).
 */
export function dmSectionsStandard(recipientRelays: string[]): RelaySection[] {
  return [
    { label: 'Your relays (NIP-65)', relays: uniq(userPublishRelays()) },
    { label: "Recipient's relays", relays: uniq(recipientRelays) },
    { label: 'Client relays', relays: uniq(clientPublishRelays()) },
  ]
}

/**
 * Section layout for W-DM (NIP-17), strict spec: your 10050 DM inbox (the self copy, for read-back) and
 * the recipient's relays (the delivered copy). No client relays, per the strict-10050 rule.
 */
export function dmSectionsNip17(selfRelays: string[], recipientRelays: string[]): RelaySection[] {
  return [
    { label: 'Your DM inbox (NIP-17)', relays: uniq(selfRelays) },
    { label: "Recipient's relays", relays: uniq(recipientRelays) },
  ]
}

/**
 * Publish to the union of `sections` with failover, reporting accepted relays as they confirm. Used by
 * B-DM and M-DM as their single unified publish. W-DM runs its own strict recipient-then-self sequencing
 * and only reuses the section/progress shape, not this helper.
 */
export async function publishDmSectioned(
  event: Event,
  sections: RelaySection[],
  onAccepted?: (accepted: string[]) => void,
): Promise<string[]> {
  const all = dmRelayUnion(sections)
  if (!all.length) { onAccepted?.([]); return [] }
  return publishWithFailover(event, all, {
    pool: all,
    target: all.length,
    onProgress: (_c, _t, accepted) => onAccepted?.(accepted),
  })
}
