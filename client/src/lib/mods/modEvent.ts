/**
 * Game mod events (kind 31142) — parsing + helpers for the Discover → Mods tab.
 *
 * Mods are DEG MODS content. They live primarily on DEG MODS' own relay, so the
 * tab fetches from that relay set rather than DEN Chat's pool. We only parse the
 * subset the listing needs; the full event spec is in
 * DEG Mods/docs/game-mod-event.md.
 */

import { nip19 } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { countLeadingZeroBits } from '@/lib/pow/pow'

export const MOD_KIND = 31142

/** Relays that carry DEG MODS content — brs.degmods.com is the primary source. */
export const MOD_RELAYS = [
  'wss://brs.degmods.com',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.nostr.band',
]

/** DEG MODS admin (NIP-78 moderation defaults — excluded tags). */
export const MOD_ADMIN_PUBKEY = 'f4bf1fb5ba8be839f70c7331733e309f780822b311f63e01f9dc8abbb428f8d5'
export const MOD_ADMIN_KIND = 30078
export const MODERATION_EXCLUDED_TAGS_DTAG = 'moderation-excluded-tags'

export interface Mod {
  id: string
  pubkey: string
  dTag: string
  /** `31142:<pubkey>:<dTag>` — stable coordinate + dedup key. */
  aTag: string
  naddr: string
  title: string
  summary: string
  game: string
  featuredImageUrl?: string
  /** Present (any value) → sensitive/NSFW. */
  contentWarning?: string
  isRepost: boolean
  emulation: boolean
  tags: string[]
  /** Hierarchical category chains, joined with ':' per segment. */
  categories: string[]
  client?: string
  publishedAt: number
  createdAt: number
  isDeleted: boolean
  /** Leading-zero bits of the event id (PoW). */
  pow: number
}

/** Category chains: read the `c` tags (JSON string-arrays) → "a:b:c" strings. */
function extractCategories(event: Event): string[] {
  const out: string[] = []
  for (const t of event.tags) {
    if (t[0] !== 'c' || !t[1]) continue
    try {
      const arr = JSON.parse(t[1])
      if (Array.isArray(arr)) out.push(arr.map(String).join(':'))
      else out.push(String(t[1]))
    } catch {
      out.push(t[1]) // non-JSON (other clients) → single literal segment
    }
  }
  return out
}

export function parseModEvent(event: Event): Mod {
  const get = (name: string) => event.tags.find((t) => t[0] === name)?.[1] ?? ''
  const getAll = (name: string) => event.tags.filter((t) => t[0] === name).map((t) => t[1]).filter(Boolean)

  const dTag = get('d')
  const repostTag = event.tags.find((t) => t[0] === 'repost')
  const emulationTag = event.tags.find((t) => t[0] === 'emulation')
  const contentWarning = get('content-warning') ||
    (event.tags.find((t) => t[0] === 'nsfw' && t[1] === 'true') ? 'nsfw' : '')

  return {
    id: event.id,
    pubkey: event.pubkey,
    dTag,
    aTag: `${MOD_KIND}:${event.pubkey}:${dTag}`,
    naddr: nip19.naddrEncode({ identifier: dTag, pubkey: event.pubkey, kind: MOD_KIND, relays: [MOD_RELAYS[0]] }),
    title: get('title'),
    summary: get('summary'),
    game: get('g'),
    featuredImageUrl: get('image') || undefined,
    contentWarning: contentWarning || undefined,
    isRepost: repostTag?.[1] === 'true',
    emulation: emulationTag?.[1] === 'true',
    tags: getAll('t'),
    categories: extractCategories(event),
    client: get('client') || undefined,
    publishedAt: parseInt(get('published_at')) || event.created_at,
    createdAt: event.created_at,
    isDeleted: event.tags.some((t) => t[0] === 'deleted' && t[1] === 'true'),
    pow: countLeadingZeroBits(event.id),
  }
}

/**
 * Dedupe raw events to one mod per coordinate (newest by created_at wins),
 * drop deletions, and sort newest-published first.
 */
export function constructModList(events: Event[]): Mod[] {
  const byCoord = new Map<string, Event>()
  for (const ev of events) {
    const dTag = ev.tags.find((t) => t[0] === 'd')?.[1] ?? ''
    const key = `${ev.pubkey}:${dTag}`
    const existing = byCoord.get(key)
    if (!existing || ev.created_at > existing.created_at) byCoord.set(key, ev)
  }
  return [...byCoord.values()]
    .map(parseModEvent)
    .filter((m) => !m.isDeleted && m.dTag)
    .sort((a, b) => b.publishedAt - a.publishedAt)
}

/**
 * Build the "open in" URL for a mod.
 *  - bare domain ("example.com")            → https://example.com/mod/<naddr>
 *  - domain + path ("example.com/foo/bar/") → https://example.com/foo/bar/<naddr>
 */
export function buildModOpenUrl(base: string, naddr: string): string {
  let b = base.trim()
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b
  try {
    const u = new URL(b)
    const path = u.pathname.replace(/\/+$/g, '') // strip trailing slashes
    u.pathname = path === '' ? `/mod/${naddr}` : `${path}/${naddr}`
    return u.toString()
  } catch {
    return `https://degmods.com/mod/${naddr}`
  }
}
