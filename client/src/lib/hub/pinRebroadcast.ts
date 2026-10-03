/**
 * pinRebroadcast: cooperative durability for a channel's pinned content.
 *
 * When anyone opens a channel's pins, we make sure each pinned message AND each contributing PIN_LIST is
 * present on all of the hub's advertised relays: for each event we check which hub relays already hold it
 * (by id) and rebroadcast the already-signed event to the ones that don't. This re-spreads a pinned
 * message that only survived on a single relay back across the hub, so it stops showing "Message not
 * loaded" for other members.
 *
 * Properties:
 *  - Rebroadcast only, never re-sign/edit: a dead/write-rejecting relay just refuses the publish harmlessly.
 *  - Hub relays only: the events are already hub-scoped content on those relays, so there's no new footprint.
 *  - Deduped per session per event id, so repeatedly opening pins doesn't re-publish what we already spread.
 *  - The caller filters out deleted / superseded messages, so we never resurrect removed content.
 */

import type { Event } from 'nostr-tools'
import { fetchEventsFromRelays, publishToSpecificRelays } from '@/lib/nostr/relay-pool'

const norm = (u: string) => u.replace(/\/+$/, '')

/** Event ids already rebroadcast this session (so reopening pins doesn't re-publish them). */
const rebroadcastedThisSession = new Set<string>()

/**
 * Ensure each event in `events` is present on every relay in `hubRelays`, rebroadcasting to the ones that
 * lack it. Best-effort and non-throwing. Pass already-signed events (pinned messages + PIN_LISTs).
 */
export async function rebroadcastToHubRelays(events: Event[], hubRelays: string[]): Promise<void> {
  const relays = Array.from(new Set(hubRelays.map(norm))).filter(Boolean)
  if (relays.length === 0) return

  const todo = events.filter((e) => e && e.id && !rebroadcastedThisSession.has(e.id))
  if (todo.length === 0) return
  for (const e of todo) rebroadcastedThisSession.add(e.id)

  const ids = todo.map((e) => e.id)
  // Per relay: which of these ids does it already hold? (One query per relay with all ids.)
  const have = new Map<string, Set<string>>()
  await Promise.all(relays.map(async (relay) => {
    const got = await fetchEventsFromRelays([relay], { ids }).catch(() => [] as Event[])
    have.set(relay, new Set(got.map((g) => g.id)))
  }))

  // For each event, publish it to the hub relays that are missing it.
  await Promise.all(todo.map(async (e) => {
    const missing = relays.filter((r) => !have.get(r)?.has(e.id))
    if (missing.length > 0) await publishToSpecificRelays(missing, e).catch(() => {})
  }))
}
