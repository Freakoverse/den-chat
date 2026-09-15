/**
 * NIP-SHORT — short, human-readable addresses for events.
 *
 *   s<authority><code>[-<selector>]
 *
 * `authority` is the author (an `npub1…`, or a DNN ID which resolves to one), `code` is the first
 * 6 hex characters of SHA-256 over a canonical input, and the optional `-selector` continues that
 * same hash to break a collision.
 *
 * The code lives in the event as a single-letter `["s", code]` tag, so it is relay-indexed and
 * signed — there is no side mapping to publish or keep alive. The canonical input deliberately
 * excludes tags, which is what lets the code be one of them.
 *
 * Ported from DEG Mods' implementation (byte-compatible codes). Spec:
 * git.nostrdev.com/freakoverse/DNN → docs/NIPS/NIP-SHORT.md
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { nip19, verifyEvent, type Event } from 'nostr-tools'
import { fetchEventsFromRelays } from '@/lib/nostr/relay-pool'
import { getReadRelays } from '@/lib/nostr/readRelays'
import { isValidDnnFormat } from '@/lib/dnn/dnnUtils'
import { dnnService } from '@/lib/dnn/dnnService'

export const SHORT_CODE_LENGTH = 6

const CODE_RE = /^[0-9a-f]{6}$/
const SUFFIX_RE = /^[0-9a-f]+$/

/**
 * Text-scanner candidate for a short address: `s` marker + an authority that starts with `n`
 * (npub1… or a DNN ID) + 6-hex code, optional `-selector`. Deliberately loose — every hit MUST be
 * confirmed with looksLikeShortAddress() (valid code, decodable npub or well-formed DNN ID), since
 * an ordinary word like "snapshot" also starts with "sn".
 */
export const SHORT_ADDRESS_PATTERN = /(?:nostr:)?\bsn[a-zA-Z0-9.]{7,}(?:-[0-9a-f]{1,8})?\b/g

/** The identity-determining fields a code is derived from. Never tags. */
export interface CodeSource {
  kind: number
  pubkey: string
  created_at: number
  content: string
  tags: string[][]
}

/** Replaceable and addressable kinds derive from their coordinate, so the code survives every edit. */
export function isCoordinateKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000)
}

export function canonicalInput(source: CodeSource): string {
  if (isCoordinateKind(source.kind)) {
    const d = source.tags.find((t) => t[0] === 'd')?.[1] ?? ''
    return `a:${source.kind}:${source.pubkey}:${d}`
  }
  return `e:${source.kind}:${source.pubkey}:${source.created_at}:${source.content}`
}

/** Full digest — the code is its head, collision selectors continue from there. */
export function computeFullHash(source: CodeSource): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalInput(source))))
}

export function computeShortCode(source: CodeSource): string {
  return computeFullHash(source).slice(0, SHORT_CODE_LENGTH)
}

/** The `s` tag an event carries, if any. */
export function shortCodeOf(event: Event): string | null {
  const v = event.tags.find((t) => t[0] === 's')?.[1]
  return v && CODE_RE.test(v) ? v : null
}

// ─── Addresses ──────────────────────────────────────────────────────

export interface ShortAddress {
  authority: string // npub1… or a DNN ID
  code: string
  suffix: string // '' when absent
}

export function formatShortAddress(authority: string, code: string, suffix = ''): string {
  return `s${authority}${code}${suffix ? `-${suffix}` : ''}`
}

/**
 * Parse `s<authority><code>[-selector]`. The authority is variable-length and the code is fixed,
 * so the code is peeled off the *end* — there is no delimiter between them to split on.
 */
export function parseShortAddress(input: string): ShortAddress | null {
  const raw = input.trim().replace(/^nostr:/i, '')
  if (!raw.startsWith('s') || raw.length < 2 + SHORT_CODE_LENGTH) return null
  const body = raw.slice(1)

  const dash = body.indexOf('-')
  const head = dash === -1 ? body : body.slice(0, dash)
  const suffix = dash === -1 ? '' : body.slice(dash + 1).toLowerCase()
  if (suffix && !SUFFIX_RE.test(suffix)) return null

  const code = head.slice(-SHORT_CODE_LENGTH).toLowerCase()
  const authority = head.slice(0, -SHORT_CODE_LENGTH)
  if (!CODE_RE.test(code) || !authority) return null
  return { authority, code, suffix }
}

/** Hex pubkey for an npub authority, or null when it isn't a decodable npub. */
export function authorityToPubkey(authority: string): string | null {
  if (/^npub1/i.test(authority)) {
    try {
      const d = nip19.decode(authority)
      return d.type === 'npub' ? (d.data as string) : null
    } catch { return null }
  }
  return null
}

export function isDnnAuthority(authority: string): boolean {
  return !/^npub1/i.test(authority) && isValidDnnFormat(authority)
}

/**
 * Does this look like a short address rather than a bare npub / DNN ID / ordinary word?
 * Requires a well-formed 6-hex code AND an authority that is either a decodable npub or a
 * well-formed DNN ID — the grammar alone ("sn…") is far too loose for free text.
 */
export function looksLikeShortAddress(input: string): boolean {
  const parsed = parseShortAddress(input)
  if (!parsed) return false
  return authorityToPubkey(parsed.authority) !== null || isDnnAuthority(parsed.authority)
}

/** Resolve any authority (npub or DNN ID) to a hex pubkey. Null when it can't be resolved. */
export async function resolveAuthorityPubkey(authority: string): Promise<string | null> {
  const direct = authorityToPubkey(authority)
  if (direct) return direct
  if (!isDnnAuthority(authority)) return null
  try {
    const res = await dnnService.resolve(authority)
    return res?.npub ? authorityToPubkey(res.npub) : null
  } catch {
    return null
  }
}

// ─── Verification ───────────────────────────────────────────────────

/** An event's `s` tag must match what its own fields hash to, and it must verify. */
export function verifyShortCode(event: Event): boolean {
  const claimed = shortCodeOf(event)
  if (!claimed || claimed !== computeShortCode(event)) return false
  try { return verifyEvent(event) } catch { return false }
}

/**
 * The short address derivable with no network at all: the stored code checked against what the
 * event hashes to. Null when the event carries no code, or one that doesn't verify.
 */
export function verifiedShortAddress(event: Event, authority?: string): string | null {
  const stored = shortCodeOf(event)
  if (!stored || stored !== computeShortCode(event)) return null
  return formatShortAddress(authority || nip19.npubEncode(event.pubkey), stored)
}

/**
 * The address to share for an event, adding a collision selector only when the author actually
 * has another event on the same code. The stored tag never changes — disambiguation lives in the
 * address alone, by reading further along the same hash.
 */
export async function shareableShortAddress(event: Event, authority?: string, relays?: string[]): Promise<string | null> {
  const code = shortCodeOf(event) ?? computeShortCode(event)
  if (!CODE_RE.test(code)) return null
  const auth = authority || nip19.npubEncode(event.pubkey)

  let others: Event[] = []
  try {
    others = await fetchEventsFromRelays(relays ?? getReadRelays(), { authors: [event.pubkey], '#s': [code] })
  } catch {
    // Can't check — share the base address rather than nothing. A collision would show a
    // disambiguation prompt on resolve, not a wrong event.
    return formatShortAddress(auth, code)
  }

  const rivals = others.filter((e) => e.id !== event.id && verifyShortCode(e))
  if (rivals.length === 0) return formatShortAddress(auth, code)

  const mine = computeFullHash(event)
  const theirs = rivals.map(computeFullHash)
  for (let n = SHORT_CODE_LENGTH + 1; n <= mine.length; n++) {
    const prefix = mine.slice(0, n)
    if (theirs.every((h) => !h.startsWith(prefix))) {
      return formatShortAddress(auth, code, mine.slice(SHORT_CODE_LENGTH, n))
    }
  }
  return formatShortAddress(auth, code)
}

// ─── Resolution ─────────────────────────────────────────────────────

export type ShortResolution =
  | { status: 'resolved'; event: Event }
  | { status: 'ambiguous'; candidates: Event[] }
  | { status: 'not-found' }
  | { status: 'bad-address' }

/**
 * Resolve a short address to its event over the read relay set (client + own NIP-65).
 *
 * Verification is not optional: the `s` tag is self-asserted, so every candidate is re-hashed
 * from its own fields and signature-checked before it counts. Without that, anyone could tag an
 * event with someone else's code.
 */
export async function resolveShortAddress(address: string, relays?: string[]): Promise<ShortResolution> {
  const parsed = parseShortAddress(address)
  if (!parsed) return { status: 'bad-address' }

  const pubkey = await resolveAuthorityPubkey(parsed.authority)
  if (!pubkey) return { status: 'bad-address' }

  let verified: Event[] = []
  try {
    const events = await fetchEventsFromRelays(relays ?? getReadRelays(), { authors: [pubkey], '#s': [parsed.code] })
    verified = events.filter(verifyShortCode)
  } catch {
    return { status: 'not-found' }
  }
  if (verified.length === 0) return { status: 'not-found' }

  if (parsed.suffix) {
    const want = parsed.code + parsed.suffix
    const matches = verified.filter((e) => computeFullHash(e).startsWith(want))
    if (matches.length === 1) return { status: 'resolved', event: matches[0] }
    if (matches.length === 0) return { status: 'not-found' }
    return { status: 'ambiguous', candidates: matches }
  }

  // A replaceable/addressable coordinate legitimately returns several revisions of one event —
  // that's history, not ambiguity. Keep the newest per coordinate.
  const byCoord = new Map<string, Event>()
  for (const e of verified) {
    const key = isCoordinateKind(e.kind)
      ? `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`
      : e.id
    const cur = byCoord.get(key)
    if (!cur || e.created_at > cur.created_at) byCoord.set(key, e)
  }
  const candidates = [...byCoord.values()]
  if (candidates.length === 1) return { status: 'resolved', event: candidates[0] }
  return { status: 'ambiguous', candidates }
}
