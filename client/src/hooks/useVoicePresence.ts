/**
 * useVoicePresence — Manages voice host + presence subscriptions
 *
 * When a hub is active, this hook:
 * 1. Subscribes to kind 36946 (voice host availability) events
 * 2. Subscribes to kind 36947 (voice presence) events for discovery
 * 3. Auto-starts Nostr keepalive (45s) for sidebar staleness detection
 * 4. Restarts DataChannel state broadcast if still connected on remount
 *
 * Called from ChannelList (which is mounted when a hub is active).
 */

import { useEffect, useRef } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

export function useVoicePresence() {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const hubSecret = useHubStore((s) => (activeHubId ? s.hubSecrets[activeHubId] : undefined))

  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const subscribeHosts = useVoiceStore((s) => s.subscribeHosts)
  const unsubscribeHosts = useVoiceStore((s) => s.unsubscribeHosts)
  const subscribePresence = useVoiceStore((s) => s.subscribePresence)
  const unsubscribePresence = useVoiceStore((s) => s.unsubscribePresence)
  const _startKeepalive = useVoiceStore((s) => s._startKeepalive)
  const _startStateBroadcast = useVoiceStore((s) => s._startStateBroadcast)

  const connectionState = useVoiceStore((s) => s.connectionState)
  const currentChannelId = useVoiceStore((s) => s.currentChannelId)
  const currentHubDTag = useVoiceStore((s) => s.currentHubDTag)
  const currentHostPubkey = useVoiceStore((s) => s.currentHostPubkey)
  const currentSessionId = useVoiceStore((s) => s.currentSessionId)

  const prevHubRef = useRef<string | null>(null)

  // Subscribe to voice events when hub changes
  useEffect(() => {
    if (!hub) {
      // Unsubscribe from previous
      if (prevHubRef.current) {
        unsubscribeHosts(prevHubRef.current)
        unsubscribePresence(prevHubRef.current)
        prevHubRef.current = null
      }
      return
    }

    const hasVoiceChannels = hub.channels.some((c) => c.type === 'voice')
    if (!hasVoiceChannels) {
      // No voice channels — unsubscribe if previously subscribed
      if (prevHubRef.current) {
        unsubscribeHosts(prevHubRef.current)
        unsubscribePresence(prevHubRef.current)
        prevHubRef.current = null
      }
      return
    }

    // Different hub or secret changed — swap subscriptions
    if (prevHubRef.current && prevHubRef.current !== hub.dTag) {
      unsubscribeHosts(prevHubRef.current)
      unsubscribePresence(prevHubRef.current)
    }

    // Re-subscribe when hub secret arrives/changes (unsubscribe + resubscribe)
    if (prevHubRef.current === hub.dTag) {
      unsubscribeHosts(hub.dTag)
    }

    const relays = [...new Set(hub.generalRelays)].filter(Boolean)
    if (relays.length > 0) {
      const groupIds = hub.groupedRoles?.map((g) => g.groupId) || []
      subscribeHosts(hub.dTag, relays, hubSecret, groupIds)
      subscribePresence(hub.dTag, relays)
    }

    prevHubRef.current = hub.dTag

    return () => {
      if (prevHubRef.current) {
        unsubscribeHosts(prevHubRef.current)
        unsubscribePresence(prevHubRef.current)
        prevHubRef.current = null
      }
    }
  }, [hub?.dTag, hub?.channels, hubSecret])

  // Auto-start keepalive + DC broadcast when connected to a voice channel.
  // This also handles remount after navigation — if already connected,
  // restart the intervals that may have been cleared.
  useEffect(() => {
    if (
      connectionState === 'connected' &&
      currentHubDTag &&
      currentChannelId &&
      currentHostPubkey &&
      currentSessionId &&
      (signer || privateKey)
    ) {
      const hub = useHubStore.getState().hubs[currentHubDTag]
      if (!hub) return

      const relays = [...new Set(hub.generalRelays)].filter(Boolean)

      // Restart DC state broadcast (idempotent — clears existing interval first)
      _startStateBroadcast()

      // Restart Nostr keepalive (idempotent — clears existing interval first)
      _startKeepalive(
        currentHubDTag,
        currentChannelId,
        currentHostPubkey,
        currentSessionId,
        relays,
        signer,
        privateKey,
      )
    }
    // NOTE: We intentionally do NOT stop broadcast on cleanup here.
    // Broadcast/keepalive lifecycle is owned by joinChannel/leaveChannel,
    // not by UI component mount/unmount.
  }, [connectionState, currentChannelId, currentHubDTag, currentSessionId])
}

