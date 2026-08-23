/**
 * useCalendar — Hook for creating, editing, deleting calendar events and RSVPs
 *
 * Handles encryption/decryption of event tags, PoW mining, signing, and publishing.
 * Uses a separate key derivation domain from channel messages (deriveEventsKey).
 * Modeled after usePoll.ts.
 */

import { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import {
  useCalendarStore,
  type RawCalendarEvent,
  type RawCalendarRsvp,
} from '@/stores/calendarStore'
import {
  createCalendarTimeEvent,
  createCalendarRsvpEvent,
  createDeletedCalendarEvent,
  createDeletionEvent,
  signWithSigner,
  mineAndSign,
} from '@/lib/nostr/events'
import { stampHubExpiration } from '@/lib/hub/messageExpiration'
import { KINDS } from '@/lib/crypto/constants'
import { aesEncrypt, aesDecrypt } from '@/lib/crypto/aes'
import { deriveEventsKey } from '@/lib/crypto/hkdf'

import { publishEventProgressive, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { getPublishRelays, getDeletePublishRelays } from '@/stores/postingBehaviourStore'
import { isClientTagEnabled } from '@/components/social/ComposeSettings'

// ─── Decrypted types ───

export interface DecryptedCalendarEvent {
  id: string
  pubkey: string
  dTag: string
  createdAt: number
  title: string
  summary?: string
  image?: string
  description: string
  locations: string[]
  geohash?: string
  startTimestamp: number
  endTimestamp?: number
  deleted: boolean
  rawEvent?: string
}

export interface DecryptedRsvp {
  pubkey: string
  dTag: string
  status: 'accepted' | 'declined' | 'tentative'
  note?: string
  createdAt: number
  deleted: boolean
}

// ─── Creation data ───

export interface CalendarEventData {
  title: string
  description?: string
  summary?: string
  image?: string
  location?: string
  startTimestamp: number
  endTimestamp?: number
}

// ─── D tag computation ───

function computeDayTags(startTs: number, endTs?: number): string[] {
  const startDay = Math.floor(startTs / 86400)
  const endDay = endTs ? Math.floor(endTs / 86400) : startDay
  const days: string[] = []
  for (let d = startDay; d <= endDay; d++) {
    days.push(d.toString())
  }
  return days
}

// ─── Utilities ───

export function isEventLive(event: DecryptedCalendarEvent): boolean {
  const now = Math.floor(Date.now() / 1000)
  if (event.endTimestamp) {
    return event.startTimestamp <= now && now <= event.endTimestamp
  }
  // No end time: consider live for 1 hour after start
  return event.startTimestamp <= now && now <= event.startTimestamp + 3600
}

// ─── Hook ───

const EMPTY_EVENTS: RawCalendarEvent[] = []

export function useCalendar(hubDTag: string | null) {
  const privateKey = useUserStore((s) => s.privateKey)
  const signer = useUserStore((s) => s.signer)
  const pubkey = useUserStore((s) => s.pubkey)
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const hubs = useHubStore((s) => s.hubs)
  const hubPrefs = useHubStore((s) => hubDTag ? s.hubPrefs[hubDTag] : undefined)

  const rawEvents = useCalendarStore((s) =>
    hubDTag ? s.events[hubDTag] || EMPTY_EVENTS : EMPTY_EVENTS
  )
  const fetchEvents = useCalendarStore((s) => s.fetchEvents)
  const fetchStatus = useCalendarStore((s) =>
    hubDTag ? s.fetchStatus[hubDTag] || 'idle' : 'idle'
  )

  const [decryptedEvents, setDecryptedEvents] = useState<DecryptedCalendarEvent[]>([])

  // Fetch events on mount
  const fetchedRef = useRef(false)
  useEffect(() => {
    if (!hubDTag || fetchedRef.current) return
    fetchedRef.current = true
    fetchEvents(hubDTag)
  }, [hubDTag, fetchEvents])

  // Derive events key
  const getEventsKey = useCallback((): Uint8Array | null => {
    if (!hubDTag) return null
    const secretHex = hubSecrets[hubDTag]
    if (!secretHex) return null

    const secret = new Uint8Array(secretHex.length / 2)
    for (let i = 0; i < secretHex.length; i += 2) {
      secret[i / 2] = parseInt(secretHex.substring(i, i + 2), 16)
    }

    const hub = hubs[hubDTag]
    const epoch = hub?.epoch || 1
    return deriveEventsKey(secret, hubDTag, epoch)
  }, [hubDTag, hubSecrets, hubs])

  // Decrypt a single tag value
  const decryptTagValue = useCallback(
    async (key: Uint8Array, tags: string[][], tagName: string): Promise<string | undefined> => {
      const tag = tags.find((t) => t[0] === tagName)
      if (!tag || !tag[1]) return undefined
      try {
        return await aesDecrypt(key, tag[1])
      } catch {
        return undefined
      }
    },
    []
  )

  // Decrypt all tag values with a given name (e.g. multiple location tags)
  const decryptTagValues = useCallback(
    async (key: Uint8Array, tags: string[][], tagName: string): Promise<string[]> => {
      const matchingTags = tags.filter((t) => t[0] === tagName && t[1])
      const results: string[] = []
      for (const tag of matchingTags) {
        try {
          const decrypted = await aesDecrypt(key, tag[1])
          results.push(decrypted)
        } catch {
          // Skip failed decryptions
        }
      }
      return results
    },
    []
  )

  // Decrypt a raw event
  const decryptEvent = useCallback(
    async (raw: RawCalendarEvent): Promise<DecryptedCalendarEvent | null> => {
      const key = getEventsKey()
      if (!key) return null

      const title = await decryptTagValue(key, raw.tags, 'title')
      if (!title) return null // Can't display without a title

      const summary = await decryptTagValue(key, raw.tags, 'summary')
      const image = await decryptTagValue(key, raw.tags, 'image')
      const geohash = await decryptTagValue(key, raw.tags, 'g')
      const locations = await decryptTagValues(key, raw.tags, 'location')

      const startStr = await decryptTagValue(key, raw.tags, 'start')
      const endStr = await decryptTagValue(key, raw.tags, 'end')

      let description = ''
      if (raw.content) {
        try {
          description = await aesDecrypt(key, raw.content)
        } catch {
          description = '[Encrypted]'
        }
      }

      const startTimestamp = startStr ? parseInt(startStr, 10) : 0
      const endTimestamp = endStr ? parseInt(endStr, 10) : undefined

      return {
        id: raw.id,
        pubkey: raw.pubkey,
        dTag: raw.dTag,
        createdAt: raw.createdAt,
        title,
        summary,
        image,
        description,
        locations,
        geohash,
        startTimestamp,
        endTimestamp,
        deleted: raw.deleted,
        rawEvent: raw.rawEvent,
      }
    },
    [getEventsKey, decryptTagValue, decryptTagValues]
  )

  // Decrypt all events when raw events change
  useEffect(() => {
    if (rawEvents.length === 0) {
      setDecryptedEvents([])
      return
    }

    let cancelled = false
    Promise.all(rawEvents.map(decryptEvent)).then((results) => {
      if (!cancelled) {
        setDecryptedEvents(
          results.filter((e): e is DecryptedCalendarEvent => e !== null && !e.deleted)
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [rawEvents, decryptEvent])

  // Create a calendar event
  const createEvent = useCallback(
    async (data: CalendarEventData) => {
      if (!hubDTag || (!signer && !privateKey)) return

      const key = getEventsKey()
      if (!key) return

      const hub = hubs[hubDTag]
      const minPow = hub?.minPow || 0
      const facilitator = hubPrefs?.facilitator || undefined
      const epoch = hub?.epoch || 1

      // Encrypt tag values
      const encryptedTags: [string, ...string[]][] = []
      encryptedTags.push(['title', await aesEncrypt(key, data.title)])
      encryptedTags.push(['start', await aesEncrypt(key, data.startTimestamp.toString())])

      if (data.endTimestamp) {
        encryptedTags.push(['end', await aesEncrypt(key, data.endTimestamp.toString())])
      }
      if (data.summary) {
        encryptedTags.push(['summary', await aesEncrypt(key, data.summary)])
      }
      if (data.image) {
        encryptedTags.push(['image', await aesEncrypt(key, data.image)])
      }
      if (data.location) {
        encryptedTags.push(['location', await aesEncrypt(key, data.location)])
      }

      // D tags (day-granularity)
      const dayTags = computeDayTags(data.startTimestamp, data.endTimestamp)
      for (const day of dayTags) {
        encryptedTags.push(['D', await aesEncrypt(key, day)])
      }

      // Encrypt description into content
      let content = ''
      if (data.description) {
        content = await aesEncrypt(key, data.description)
      }

      let unsigned = createCalendarTimeEvent(
        content,
        encryptedTags,
        hubDTag,
        epoch,
        undefined,
        facilitator
      )

      if (isClientTagEnabled()) {
        unsigned = { ...unsigned, tags: [...unsigned.tags, ['client', 'DEN Chat']] }
      }

      // Disappearing messages: anchor a calendar event's expiry to its END time so
      // a future event survives until it's over, then disappears one timer later.
      stampHubExpiration(unsigned, hubDTag, data.endTimestamp || data.startTimestamp)
      const signed = await mineAndSign(unsigned, minPow, pubkey, signer, privateKey)

      const hubRelays = hub?.generalRelays || []
      const publishRelays = getPublishRelays(hubRelays)
      await publishEventProgressive(signed, () => {}, publishRelays)

      // Add to local store immediately
      useCalendarStore.getState().addEvent({
        id: signed.id,
        pubkey: signed.pubkey,
        dTag: signed.tags.find((t) => t[0] === 'd')![1],
        hubDTag,
        epoch,
        createdAt: signed.created_at,
        content: signed.content,
        tags: signed.tags,
        deleted: false,
        facilitator,
        rawEvent: JSON.stringify(signed),
      })
    },
    [hubDTag, signer, privateKey, pubkey, hubs, hubPrefs, getEventsKey]
  )

  // Edit a calendar event (re-publish with same d-tag)
  const editEvent = useCallback(
    async (dTag: string, data: CalendarEventData) => {
      if (!hubDTag || (!signer && !privateKey)) return

      const key = getEventsKey()
      if (!key) return

      const hub = hubs[hubDTag]
      const minPow = hub?.minPow || 0
      const epoch = hub?.epoch || 1

      // Encrypt tag values (same as create)
      const encryptedTags: [string, ...string[]][] = []
      encryptedTags.push(['title', await aesEncrypt(key, data.title)])
      encryptedTags.push(['start', await aesEncrypt(key, data.startTimestamp.toString())])

      if (data.endTimestamp) {
        encryptedTags.push(['end', await aesEncrypt(key, data.endTimestamp.toString())])
      }
      if (data.summary) {
        encryptedTags.push(['summary', await aesEncrypt(key, data.summary)])
      }
      if (data.image) {
        encryptedTags.push(['image', await aesEncrypt(key, data.image)])
      }
      if (data.location) {
        encryptedTags.push(['location', await aesEncrypt(key, data.location)])
      }

      const dayTags = computeDayTags(data.startTimestamp, data.endTimestamp)
      for (const day of dayTags) {
        encryptedTags.push(['D', await aesEncrypt(key, day)])
      }

      let content = ''
      if (data.description) {
        content = await aesEncrypt(key, data.description)
      }

      // Re-publish with same d-tag — relay replaces old version
      let unsigned = createCalendarTimeEvent(content, encryptedTags, hubDTag, epoch, dTag)

      if (isClientTagEnabled()) {
        unsigned = { ...unsigned, tags: [...unsigned.tags, ['client', 'DEN Chat']] }
      }

      // Anchor expiry to the event's END time (see createEvent).
      stampHubExpiration(unsigned, hubDTag, data.endTimestamp || data.startTimestamp)
      const signed = await mineAndSign(unsigned, minPow, pubkey, signer, privateKey)
      const hubRelays = hubs[hubDTag]?.generalRelays || []
      const publishRelays = getPublishRelays(hubRelays)
      await publishToSpecificRelays(publishRelays, signed)

      // Update local store
      useCalendarStore.getState().addEvent({
        id: signed.id,
        pubkey: signed.pubkey,
        dTag,
        hubDTag,
        epoch,
        createdAt: signed.created_at,
        content: signed.content,
        tags: signed.tags,
        deleted: false,
        rawEvent: JSON.stringify(signed),
      })
    },
    [hubDTag, signer, privateKey, pubkey, hubs, getEventsKey]
  )

  // Delete a calendar event
  const deleteEvent = useCallback(
    async (dTag: string) => {
      if (!hubDTag || (!signer && !privateKey) || !pubkey) return

      const hub = hubs[hubDTag]
      const epoch = hub?.epoch || 1

      // Look up original event timestamp for created_at + 1 ordering
      const rawEvents = useCalendarStore.getState().events[hubDTag] || []
      const originalEvent = rawEvents.find((e) => e.dTag === dTag && e.pubkey === pubkey)
      const originalCreatedAt = originalEvent?.createdAt

      // 1. Re-publish with deleted tag (primary — addressable replaceable overwrite)
      const deletedEvent = createDeletedCalendarEvent(
        KINDS.CALENDAR_TIME_EVENT,
        dTag,
        hubDTag,
        epoch,
        originalCreatedAt
      )
      const signedDeleted = await signWithSigner(deletedEvent, signer, privateKey)
      const hubRelays = hub?.generalRelays || []
      const publishRelays = getDeletePublishRelays(hubRelays)
      await publishToSpecificRelays(publishRelays, signedDeleted)

      // 2. NIP-09 deletion request as fallback
      const aRef = `${KINDS.CALENDAR_TIME_EVENT}:${pubkey}:${dTag}`
      const deletionEvent = createDeletionEvent([], [aRef], 'Event deletion requested')
      const signedDeletion = await signWithSigner(deletionEvent, signer, privateKey)
      await publishToSpecificRelays(publishRelays, signedDeletion)

      // Update local store
      useCalendarStore.getState().addEvent({
        id: signedDeleted.id,
        pubkey: signedDeleted.pubkey,
        dTag,
        hubDTag,
        epoch,
        createdAt: signedDeleted.created_at,
        content: '',
        tags: signedDeleted.tags,
        deleted: true,
        rawEvent: JSON.stringify(signedDeleted),
      })
    },
    [hubDTag, signer, privateKey, pubkey, hubs]
  )

  // Submit an RSVP
  const submitRsvp = useCallback(
    async (
      eventARef: string,
      status: 'accepted' | 'declined' | 'tentative',
      note?: string,
      existingDTag?: string
    ) => {
      if (!hubDTag || (!signer && !privateKey)) return

      const key = getEventsKey()
      if (!key) return

      const hub = hubs[hubDTag]
      const minPow = hub?.minPow || 0
      const epoch = hub?.epoch || 1

      const encryptedStatus = await aesEncrypt(key, status)
      let content = ''
      if (note) {
        content = await aesEncrypt(key, note)
      }

      // Use existing d-tag if updating, or generate new
      let unsigned = createCalendarRsvpEvent(
        content,
        eventARef,
        hubDTag,
        epoch,
        encryptedStatus,
        existingDTag
      )

      if (isClientTagEnabled()) {
        unsigned = { ...unsigned, tags: [...unsigned.tags, ['client', 'DEN Chat']] }
      }

      stampHubExpiration(unsigned, hubDTag)
      const signed = await mineAndSign(unsigned, minPow, pubkey, signer, privateKey)
      const hubRelays = hub?.generalRelays || []
      const publishRelays = getPublishRelays(hubRelays)
      await publishEventProgressive(signed, () => {}, publishRelays)

      // Add to local store
      useCalendarStore.getState().addRsvp({
        id: signed.id,
        pubkey: signed.pubkey,
        dTag: signed.tags.find((t) => t[0] === 'd')![1],
        hubDTag,
        eventRef: eventARef,
        epoch,
        createdAt: signed.created_at,
        content: signed.content,
        statusTag: encryptedStatus,
        deleted: false,
        rawEvent: JSON.stringify(signed),
      })
    },
    [hubDTag, signer, privateKey, pubkey, hubs, getEventsKey]
  )

  // Delete an RSVP
  const deleteRsvp = useCallback(
    async (dTag: string, eventARef: string) => {
      if (!hubDTag || (!signer && !privateKey) || !pubkey) return

      const hub = hubs[hubDTag]
      const epoch = hub?.epoch || 1

      // Look up original RSVP timestamp for created_at + 1 ordering
      const rawRsvps = useCalendarStore.getState().rsvps[eventARef] || []
      const originalRsvp = rawRsvps.find((r) => r.dTag === dTag && r.pubkey === pubkey)
      const originalCreatedAt = originalRsvp?.createdAt

      // 1. Re-publish with deleted tag (primary — addressable replaceable overwrite)
      const deletedEvent = createDeletedCalendarEvent(KINDS.CALENDAR_RSVP, dTag, hubDTag, epoch, originalCreatedAt)
      const signedDeleted = await signWithSigner(deletedEvent, signer, privateKey)
      const hubRelays = hub?.generalRelays || []
      const publishRelays = getDeletePublishRelays(hubRelays)
      await publishToSpecificRelays(publishRelays, signedDeleted)

      // 2. NIP-09 deletion request as fallback
      const aRef = `${KINDS.CALENDAR_RSVP}:${pubkey}:${dTag}`
      const deletionEvent = createDeletionEvent([], [aRef], 'RSVP deletion requested')
      const signedDeletion = await signWithSigner(deletionEvent, signer, privateKey)
      await publishToSpecificRelays(publishRelays, signedDeletion)

      // Update local store
      useCalendarStore.getState().addRsvp({
        id: signedDeleted.id,
        pubkey: signedDeleted.pubkey,
        dTag,
        hubDTag,
        eventRef: eventARef,
        epoch,
        createdAt: signedDeleted.created_at,
        content: '',
        statusTag: '',
        deleted: true,
        rawEvent: JSON.stringify(signedDeleted),
      })
    },
    [hubDTag, signer, privateKey, pubkey, hubs]
  )

  // Decrypt RSVPs for a specific event
  const decryptRsvps = useCallback(
    async (eventARef: string): Promise<DecryptedRsvp[]> => {
      const key = getEventsKey()
      if (!key) return []

      const rawRsvps = useCalendarStore.getState().rsvps[eventARef] || []
      const results: DecryptedRsvp[] = []

      for (const raw of rawRsvps) {
        try {
          let status: 'accepted' | 'declined' | 'tentative' = 'tentative'
          if (raw.statusTag) {
            const decryptedStatus = await aesDecrypt(key, raw.statusTag)
            if (
              decryptedStatus === 'accepted' ||
              decryptedStatus === 'declined' ||
              decryptedStatus === 'tentative'
            ) {
              status = decryptedStatus
            }
          }

          let note: string | undefined
          if (raw.content) {
            try {
              note = await aesDecrypt(key, raw.content)
            } catch {
              // No note or decryption failed
            }
          }

          results.push({
            pubkey: raw.pubkey,
            dTag: raw.dTag,
            status,
            note,
            createdAt: raw.createdAt,
            deleted: raw.deleted,
          })
        } catch {
          // Skip failed decryptions
        }
      }

      return results.filter((r) => !r.deleted)
    },
    [getEventsKey]
  )

  // Tick every 30s so live status recalculates as time passes
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const liveEventCount = useMemo(() =>
    decryptedEvents.filter(isEventLive).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [decryptedEvents, tick]
  )

  return {
    decryptedEvents,
    liveEventCount,
    loading: fetchStatus === 'loading',
    createEvent,
    editEvent,
    deleteEvent,
    submitRsvp,
    deleteRsvp,
    decryptRsvps,
  }
}
