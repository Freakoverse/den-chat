/**
 * messageExpiration — hub-wide "disappearing messages" (NIP-40).
 *
 * A hub can carry a `message_expiration` policy (a DURATION in seconds) on its
 * kind-36942 event. When set, every durable chat event published to the hub is
 * stamped with a NIP-40 `["expiration", <unix seconds>]` tag = created_at + the
 * duration, so NIP-40-honoring relays delete it after that time and clients
 * hide + purge it locally.
 *
 * Design notes:
 * - The policy is a DURATION; each event's expiry is absolute (created_at + duration).
 * - Non-retroactive: the tag is baked into each event at send time, so changing
 *   the timer only affects future messages. Readers honor the per-event tag, never
 *   the current hub policy.
 * - Best-effort: relay deletion depends on the relay honoring NIP-40; the client
 *   guarantees only hiding + local purge. (Same cooperative model as Signal/Concord.)
 * - Some event kinds MUST NOT be stamped (deletions/tombstones, hide events, the
 *   hub event itself) — the caller decides what to stamp; this module never guesses.
 */

import type { UnsignedEvent } from 'nostr-tools'
import { useHubStore } from '@/stores/hubStore'

/** The hub's disappearing-messages timer (seconds), or 0 if off / hub unknown. */
export function getHubExpirationTimer(hubDTag: string): number {
  const hub = useHubStore.getState().hubs[hubDTag]
  return Math.max(0, hub?.messageExpiration || 0)
}

/**
 * Stamp a NIP-40 `expiration` tag onto an unsigned durable chat event, in place,
 * when its hub has a disappearing-messages timer. No-op when the timer is off or
 * the event already carries an `expiration` tag.
 *
 * MUST be called BEFORE mining/signing (the tag changes the event id, and hub
 * events are PoW-mined over their final tag set).
 *
 * @param unsigned  the unsigned event (its `created_at` is the anchor by default)
 * @param hubDTag   the hub the event belongs to
 * @param anchorAt  optional alternative anchor (unix seconds). For time-bound
 *                  events (calendar), pass the event's END time so a future event
 *                  survives until it is over: expiry = max(created_at, anchorAt) + timer.
 */
export function stampHubExpiration(unsigned: UnsignedEvent, hubDTag: string, anchorAt?: number): void {
  const timer = getHubExpirationTimer(hubDTag)
  if (timer <= 0) return
  if (unsigned.tags.some((t) => t[0] === 'expiration')) return
  const base = typeof anchorAt === 'number' && anchorAt > unsigned.created_at ? anchorAt : unsigned.created_at
  const expiry = Math.floor(base + timer)
  unsigned.tags = [...unsigned.tags, ['expiration', expiry.toString()]]
}

/** Read the NIP-40 expiration (unix seconds) from an event's tags, or undefined. */
export function getExpirationFromTags(tags: string[][]): number | undefined {
  const raw = tags.find((t) => t[0] === 'expiration')?.[1]
  if (!raw) return undefined
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Whether an absolute expiration (unix seconds) has already passed. undefined = never. */
export function isExpired(expiration: number | undefined, nowSec?: number): boolean {
  if (!expiration) return false
  return expiration <= (nowSec ?? Math.floor(Date.now() / 1000))
}

/** Preset timer options for the settings UI, in seconds. */
export const EXPIRATION_PRESETS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '10 minutes', seconds: 10 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '6 hours', seconds: 6 * 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '1 week', seconds: 7 * 24 * 60 * 60 },
  { label: '30 days', seconds: 30 * 24 * 60 * 60 },
  { label: '90 days', seconds: 90 * 24 * 60 * 60 },
]

/** Human-readable duration for a timer value in seconds (e.g. "30 days"). */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'Off'
  const preset = EXPIRATION_PRESETS.find((p) => p.seconds === seconds)
  if (preset) return preset.label
  const units: [number, string][] = [
    [24 * 60 * 60, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ]
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.round(seconds / size)
      return `${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  return `${seconds} seconds`
}
