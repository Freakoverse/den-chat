/**
 * useExceptionSubscriptions — Tier 2 subscriptions for event kinds
 * that don't carry the hub's #h tag
 *
 * Some events (like zap receipts) are created by external services
 * (LNURL servers) that don't know about our hub tagging scheme.
 * This hook creates separate subscriptions filtered by #e (event IDs
 * of loaded messages) to fetch those event kinds.
 *
 * Architecture:
 * 1. Watch the active hub + channel + loaded messages
 * 2. Collect event IDs of loaded messages for the active channel
 * 3. Create TWO subscriptions:
 *    a. Historical fetch — get past zap receipts for those messages
 *    b. Real-time — catch new zap receipts as they happen
 * 4. Route events to the appropriate store (zapStore, etc.)
 */

import { useEffect, useRef } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useMessageStore } from '@/stores/messageStore'
import { useZapStore } from '@/stores/zapStore'
import { subscribeToRelays } from '@/lib/nostr/relay-pool'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import { parseZapReceipt } from '@/lib/nostr/zap'
import type { Event } from 'nostr-tools'

/** Event kinds that need the exception subscription (no #h tag) */
const EXCEPTION_KINDS = [STANDARD_KINDS.ZAP_RECEIPT]

/**
 * Process an exception event — route to the appropriate store.
 * Since these events don't have an #h tag, we derive the hub context
 * from the event's #e tag (which references a loaded message).
 */
function processExceptionEvent(event: Event, hubDTag: string) {
  if (event.kind === STANDARD_KINDS.ZAP_RECEIPT) {
    const zapStore = useZapStore.getState()

    // Dedup
    if (!zapStore.markZapProcessed(event.id)) return

    const zapInfo = parseZapReceipt(event)
    if (!zapInfo) return
    if (!zapInfo.targetEventId) return

    // Look up the message by event ID to get the addressable reference
    const msgStore = useMessageStore.getState()
    const hubMessages = msgStore.messages[hubDTag] || {}

    // Search all channels for the target message
    let messageKey: string | null = null
    for (const channelMsgs of Object.values(hubMessages)) {
      const msg = channelMsgs.find((m) => m.id === zapInfo.targetEventId)
      if (msg) {
        // Use addressable reference as the store key
        messageKey = msg.dTag ? `36943:${msg.pubkey}:${msg.dTag}` : msg.id
        break
      }
    }

    if (!messageKey) return

    zapStore.addZap(hubDTag, messageKey, zapInfo)
  }

  // Future exception kinds can be added here:
  // if (event.kind === SOME_OTHER_KIND) { ... }
}

export function useExceptionSubscriptions() {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const activeChannelId = useHubStore((s) => s.activeChannelId)
  const hubs = useHubStore((s) => s.hubs)

  // Use message count as a lightweight dependency — avoids re-running on every message content change
  const messageCount = useMessageStore((s) => {
    if (!activeHubId || !activeChannelId) return 0
    return s.messages[activeHubId]?.[activeChannelId]?.length || 0
  })

  // Track active subscriptions for cleanup
  const subsRef = useRef<{ close: () => void }[]>([])
  // Track the last set of event IDs to avoid unnecessary re-subscriptions
  const lastFingerprintRef = useRef<string>('')

  useEffect(() => {
    // Cleanup function
    const cleanup = () => {
      for (const sub of subsRef.current) {
        sub.close()
      }
      subsRef.current = []
    }

    if (!activeHubId || !activeChannelId || messageCount === 0) {
      cleanup()
      lastFingerprintRef.current = ''
      return cleanup
    }

    const hub = hubs[activeHubId]
    if (!hub) {
      cleanup()
      lastFingerprintRef.current = ''
      return cleanup
    }

    // Read actual message data inside the effect (not as a dependency)
    const channelMsgs = useMessageStore.getState().messages[activeHubId]?.[activeChannelId] || []
    const eventIds = channelMsgs
      .filter((m) => !m.deleted)
      .map((m) => m.id)

    if (eventIds.length === 0) {
      cleanup()
      lastFingerprintRef.current = ''
      return cleanup
    }

    // Fingerprint check — skip if same set of IDs
    const fingerprint = `${activeHubId}:${activeChannelId}:${eventIds.length}:${eventIds[0]}:${eventIds[eventIds.length - 1]}`
    if (fingerprint === lastFingerprintRef.current) return cleanup
    lastFingerprintRef.current = fingerprint

    // Tear down old subscriptions
    cleanup()

    const relays = [...hub.filterRelays, ...hub.generalRelays]
    if (relays.length === 0) return cleanup

    const hubDTag = activeHubId

    // Event handler
    const handleEvent = (event: Event) => {
      processExceptionEvent(event, hubDTag)
    }

    // 1. Historical fetch — get past receipts for loaded messages
    const initialSub = subscribeToRelays(
      relays,
      {
        kinds: EXCEPTION_KINDS,
        '#e': eventIds,
      },
      handleEvent,
      () => {
        // EOSE: done, close this one-time fetch
        initialSub.close()
      }
    )

    // 2. Real-time — catch new receipts as they happen
    const realtimeSub = subscribeToRelays(
      relays,
      {
        kinds: EXCEPTION_KINDS,
        '#e': eventIds,
        since: Math.floor(Date.now() / 1000),
      },
      handleEvent
    )

    subsRef.current = [initialSub, realtimeSub]

    return cleanup
  }, [activeHubId, activeChannelId, hubs, messageCount])
}
