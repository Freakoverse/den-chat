/**
 * User Group List — kind 16943 (NIP-CHAT §21.10). Replaceable, published to the user's own relays.
 * EVERY entry lives in the NIP-44 self-encrypted content (no plaintext form): which groups a user
 * belongs to is nobody else's business, and a v1/v2 split would only leak the v1 ones.
 */
import type { Event, UnsignedEvent } from 'nostr-tools'
import { KINDS } from '@/lib/crypto/constants'
import { createUnsignedEvent, signWithSigner } from '@/lib/nostr/events'
import { fetchReplaceable } from '@/lib/nostr/relay-pool'
import { nip44SelfEncrypt, nip44SelfDecrypt, publishHubList } from '@/lib/hub/hubListPrivacy'
import type { ISigner } from '@/stores/userStore'

export interface GroupEntry {
  /** Full coordinate `36950:<creator or O>:<d>` — a group needs its author to be resolved. */
  a: string
  dTag: string
  /** The event author: creator's R (v1) or O (v2). */
  pubkey: string
  relay: string
  position: number
  /** Format at accept time — the authoritative version fail-safe (§0). */
  format: '1' | '2'
  signerScheme?: string
}

export function parseGroupCoord(a: string): { pubkey: string; dTag: string } | null {
  const [kind, pubkey, ...rest] = a.split(':')
  const dTag = rest.join(':')
  if (kind !== String(KINDS.GROUP_EVENT) || !/^[0-9a-f]{64}$/i.test(pubkey) || !dTag) return null
  return { pubkey: pubkey.toLowerCase(), dTag }
}

export function makeGroupEntry(g: { creatorPubkey: string; dTag: string; relays: string[]; version?: number; signerScheme?: string }, position: number): GroupEntry {
  return {
    a: `${KINDS.GROUP_EVENT}:${g.creatorPubkey}:${g.dTag}`,
    dTag: g.dTag,
    pubkey: g.creatorPubkey,
    relay: g.relays[0] ?? '',
    position,
    format: g.version === 2 ? '2' : '1',
    signerScheme: g.version === 2 ? (g.signerScheme ?? 'skd:1') : undefined,
  }
}

export async function buildGroupListEvent(
  entries: GroupEntry[],
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<UnsignedEvent> {
  const payload = {
    groups: entries.map((e) => ({ a: e.a, relay: e.relay, position: e.position, format: e.format, ...(e.signerScheme ? { signer_scheme: e.signerScheme } : {}) })),
  }
  const content = await nip44SelfEncrypt(JSON.stringify(payload), myPubkey, signer, privateKey)
  return createUnsignedEvent(KINDS.USER_GROUP_LIST, content, [['client', 'DEN Chat']])
}

export async function parseGroupListEvent(
  event: Event,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<GroupEntry[]> {
  if (!event.content) return []
  const plaintext = await nip44SelfDecrypt(event.content, myPubkey, signer, privateKey)
  const parsed = JSON.parse(plaintext) as { groups?: Array<{ a?: string; relay?: string; position?: number; format?: string; signer_scheme?: string }> }
  const out: GroupEntry[] = []
  for (const g of parsed.groups ?? []) {
    if (!g.a) continue
    const coord = parseGroupCoord(g.a)
    if (!coord) continue
    out.push({
      a: g.a,
      dTag: coord.dTag,
      pubkey: coord.pubkey,
      relay: g.relay ?? '',
      position: typeof g.position === 'number' ? g.position : out.length,
      format: g.format === '2' ? '2' : '1',
      signerScheme: g.signer_scheme,
    })
  }
  return out.sort((x, y) => x.position - y.position)
}

/** Fetch the user's current list (null when none). Waits longer than the 4s default like the hub list. */
export async function fetchGroupListEvent(pubkey: string): Promise<Event | null> {
  return fetchReplaceable(pubkey, KINDS.USER_GROUP_LIST, undefined, 10000)
}

/** Sign + publish with failover across the user's relays (same path as the hub list). */
export async function publishGroupList(
  entries: GroupEntry[],
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<{ accepted: string[]; createdAt: number }> {
  const unsigned = await buildGroupListEvent(entries, myPubkey, signer, privateKey)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  const accepted = await publishHubList(signed)
  if (accepted.length === 0) throw new Error('Your group list was not accepted by any relay — please try again.')
  return { accepted, createdAt: signed.created_at }
}
