/**
 * calendarStore — State management for NIP-52 calendar events in hubs
 *
 * Calendar events (kind 31923) are stored per hub.
 * RSVPs (kind 31925) are fetched on-demand when an event detail mounts.
 * Modeled after pollStore.ts.
 */

import { create } from 'zustand'
import { subscribeToRelays } from '@/lib/nostr/relay-pool'
import { useHubStore } from '@/stores/hubStore'
import { KINDS } from '@/lib/crypto/constants'
import type { Event } from 'nostr-tools'

export interface RawCalendarEvent {
  id: string
  pubkey: string
  dTag: string
  hubDTag: string
  epoch: number
  createdAt: number
  /** Raw encrypted content (event description) */
  content: string
  /** Raw tags (with encrypted values) */
  tags: string[][]
  deleted: boolean
  facilitator?: string
  rawEvent?: string
}

export interface RawCalendarRsvp {
  id: string
  pubkey: string
  dTag: string
  hubDTag: string
  /** a-tag ref to the calendar event: "31923:pubkey:dTag" */
  eventRef: string
  epoch: number
  createdAt: number
  /** Raw encrypted content (RSVP note) */
  content: string
  /** Raw encrypted status tag value */
  statusTag: string
  deleted: boolean
  rawEvent?: string
}

interface CalendarStore {
  /** events[hubDTag] → RawCalendarEvent[] sorted by createdAt */
  events: Record<string, RawCalendarEvent[]>
  /** rsvps[eventARef] → RawCalendarRsvp[] (dedup'd by pubkey keeping latest) */
  rsvps: Record<string, RawCalendarRsvp[]>
  /** Track which hubs have had events fetched */
  fetchStatus: Record<string, 'idle' | 'loading' | 'done'>
  /** Track which events have had RSVPs fetched */
  rsvpFetchStatus: Record<string, 'idle' | 'loading' | 'done'>

  addEvent: (event: RawCalendarEvent) => void
  addRsvp: (rsvp: RawCalendarRsvp) => void
  fetchEvents: (hubDTag: string) => Promise<void>
  fetchRsvps: (eventARef: string, hubDTag: string) => Promise<void>
}

export function parseCalendarEvent(event: Event): RawCalendarEvent | null {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
  const hubDTag = event.tags.find((t) => t[0] === 'h')?.[1]
  const epochStr = event.tags.find((t) => t[0] === 'epoch')?.[1]
  const deletedTag = event.tags.find((t) => t[0] === 'deleted')
  const facilitatorTag = event.tags.find((t) => t[0] === 'facilitator')?.[1]

  if (!dTag || !hubDTag) return null

  return {
    id: event.id,
    pubkey: event.pubkey,
    dTag,
    hubDTag,
    epoch: epochStr ? parseInt(epochStr, 10) : 1,
    createdAt: event.created_at,
    content: event.content,
    tags: event.tags,
    deleted: !!deletedTag,
    facilitator: facilitatorTag,
    rawEvent: JSON.stringify(event),
  }
}

export function parseCalendarRsvp(event: Event): RawCalendarRsvp | null {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
  const hubDTag = event.tags.find((t) => t[0] === 'h')?.[1]
  const eventRef = event.tags.find((t) => t[0] === 'a')?.[1]
  const epochStr = event.tags.find((t) => t[0] === 'epoch')?.[1]
  const statusTag = event.tags.find((t) => t[0] === 'status')?.[1]
  const deletedTag = event.tags.find((t) => t[0] === 'deleted')

  if (!dTag || !hubDTag || !eventRef) return null

  return {
    id: event.id,
    pubkey: event.pubkey,
    dTag,
    hubDTag,
    eventRef,
    epoch: epochStr ? parseInt(epochStr, 10) : 1,
    createdAt: event.created_at,
    content: event.content,
    statusTag: statusTag || '',
    deleted: !!deletedTag,
    rawEvent: JSON.stringify(event),
  }
}

export const useCalendarStore = create<CalendarStore>((set, get) => ({
  events: {},
  rsvps: {},
  fetchStatus: {},
  rsvpFetchStatus: {},

  addEvent: (event) => {
    set((state) => {
      const hubEvents = state.events[event.hubDTag] || []

      // Addressable replaceable: dedup by pubkey+dTag, keep latest createdAt
      const existing = hubEvents.find(
        (e) => e.pubkey === event.pubkey && e.dTag === event.dTag
      )
      if (existing) {
        if (existing.createdAt >= event.createdAt) return state
        // Replace with newer version
        const filtered = hubEvents.filter(
          (e) => !(e.pubkey === event.pubkey && e.dTag === event.dTag)
        )
        return {
          events: {
            ...state.events,
            [event.hubDTag]: [...filtered, event].sort(
              (a, b) => a.createdAt - b.createdAt
            ),
          },
        }
      }

      return {
        events: {
          ...state.events,
          [event.hubDTag]: [...hubEvents, event].sort(
            (a, b) => a.createdAt - b.createdAt
          ),
        },
      }
    })
  },

  addRsvp: (rsvp) => {
    set((state) => {
      const existing = state.rsvps[rsvp.eventRef] || []

      // Dedup by pubkey — keep the one with latest createdAt
      const dominated = existing.some(
        (r) => r.pubkey === rsvp.pubkey && r.createdAt > rsvp.createdAt
      )
      if (dominated) return state

      // Remove old from same pubkey + same event id
      const filtered = existing.filter(
        (r) => r.pubkey !== rsvp.pubkey && r.id !== rsvp.id
      )

      return {
        rsvps: {
          ...state.rsvps,
          [rsvp.eventRef]: [...filtered, rsvp],
        },
      }
    })
  },

  fetchEvents: async (hubDTag) => {
    const status = get().fetchStatus[hubDTag]
    if (status === 'loading' || status === 'done') return

    set((state) => ({
      fetchStatus: { ...state.fetchStatus, [hubDTag]: 'loading' },
    }))

    const hubs = useHubStore.getState().hubs
    const hub = hubs[hubDTag]
    if (!hub) {
      set((state) => ({
        fetchStatus: { ...state.fetchStatus, [hubDTag]: 'done' },
      }))
      return
    }

    const relays = [
      ...new Set([...hub.generalRelays, ...hub.filterRelays]),
    ].filter(Boolean)
    if (relays.length === 0) {
      set((state) => ({
        fetchStatus: { ...state.fetchStatus, [hubDTag]: 'done' },
      }))
      return
    }

    const addEvent = get().addEvent

    return new Promise<void>((resolve) => {
      const sub = subscribeToRelays(
        relays,
        {
          kinds: [KINDS.CALENDAR_TIME_EVENT],
          '#h': [hubDTag],
        },
        (event: Event) => {
          const calEvent = parseCalendarEvent(event)
          if (calEvent) addEvent(calEvent)
        },
        () => {
          sub.close()
          set((state) => ({
            fetchStatus: { ...state.fetchStatus, [hubDTag]: 'done' },
          }))
          resolve()
        }
      )

      // Safety timeout
      setTimeout(() => {
        sub.close()
        set((state) => ({
          fetchStatus: { ...state.fetchStatus, [hubDTag]: 'done' },
        }))
        resolve()
      }, 15000)
    })
  },

  fetchRsvps: async (eventARef, hubDTag) => {
    const status = get().rsvpFetchStatus[eventARef]
    if (status === 'loading' || status === 'done') return

    set((state) => ({
      rsvpFetchStatus: { ...state.rsvpFetchStatus, [eventARef]: 'loading' },
    }))

    const hubs = useHubStore.getState().hubs
    const hub = hubs[hubDTag]
    if (!hub) {
      set((state) => ({
        rsvpFetchStatus: { ...state.rsvpFetchStatus, [eventARef]: 'done' },
      }))
      return
    }

    const relays = [
      ...new Set([...hub.generalRelays, ...hub.filterRelays]),
    ].filter(Boolean)
    if (relays.length === 0) {
      set((state) => ({
        rsvpFetchStatus: { ...state.rsvpFetchStatus, [eventARef]: 'done' },
      }))
      return
    }

    const addRsvp = get().addRsvp

    return new Promise<void>((resolve) => {
      const sub = subscribeToRelays(
        relays,
        {
          kinds: [KINDS.CALENDAR_RSVP],
          '#a': [eventARef],
        },
        (event: Event) => {
          const rsvp = parseCalendarRsvp(event)
          if (rsvp) addRsvp(rsvp)
        },
        () => {
          sub.close()
          set((state) => ({
            rsvpFetchStatus: {
              ...state.rsvpFetchStatus,
              [eventARef]: 'done',
            },
          }))
          resolve()
        }
      )

      setTimeout(() => {
        sub.close()
        set((state) => ({
          rsvpFetchStatus: {
            ...state.rsvpFetchStatus,
            [eventARef]: 'done',
          },
        }))
        resolve()
      }, 15000)
    })
  },
}))
