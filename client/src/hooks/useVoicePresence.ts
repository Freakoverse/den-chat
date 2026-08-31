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
import { getChannelGroupId } from '@/lib/hub/permissions'

// Baseline key-state per connected hub, MODULE-level so it survives this hook unmounting — the hook is
// mounted from ChannelList, which unmounts when the user navigates away from the hub view (to Settings,
// DMs, another page) while still in the call. A component-local ref would be destroyed on that unmount and
// re-adopt the post-rotation key-state as a fresh baseline on remount, silently skipping the re-key. A
// module map keyed by hubDTag persists across those mount/unmount cycles.
const _lastVoiceKeyState = new Map<string, string>()

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

  // ── Re-key E2EE when a kick/ban rotates the connected channel's secret mid-call ──
  // A kick bumps the hub (or group) epoch AND rotates the secret. Remaining participants must
  // re-derive the frame key from the NEW secret so the kicked member — who only holds the old
  // secret — can no longer decrypt or inject audio. We key this on the connected channel's secret
  // VALUE (and epoch): watching the value (not just the epoch) avoids the race where the epoch bumps
  // in the store a beat before the freshly-decrypted secret lands. If the secret is gone (we were the
  // one kicked), `rekeyE2EEForRotation` self-disconnects us from the call.
  const rekeyE2EEForRotation = useVoiceStore((s) => s.rekeyE2EEForRotation)
  const connectedKeyState = useHubStore((s) => {
    if (!currentHubDTag || !currentChannelId) return ''
    const ch = s.hubs[currentHubDTag]
    if (!ch) return ''
    const gid = getChannelGroupId(ch, currentChannelId)
    if (gid) {
      const ep = ch.groupedRoles?.find((g) => g.groupId === gid)?.epoch ?? ch.epoch ?? 0
      return `${gid}:${ep}:${s.groupSecrets?.[currentHubDTag]?.[gid] ?? ''}`
    }
    return `hub:${ch.epoch ?? 0}:${s.hubSecrets?.[currentHubDTag] ?? ''}`
  })
  useEffect(() => {
    if (connectionState !== 'connected' || !currentHubDTag || !connectedKeyState) return
    // First observation for this hub: record baseline, don't re-key. On a real change (rotation) re-key.
    // The baseline is module-level, so a rotation that lands while this hook was unmounted is still caught
    // on remount (the stored pre-rotation state won't match the new one).
    const prev = _lastVoiceKeyState.get(currentHubDTag)
    if (prev !== undefined && prev !== connectedKeyState) {
      const hub = useHubStore.getState().hubs[currentHubDTag]
      const relays = hub ? [...new Set(hub.generalRelays)].filter(Boolean) : []
      rekeyE2EEForRotation(currentHubDTag, relays, signer, privateKey)
    }
    _lastVoiceKeyState.set(currentHubDTag, connectedKeyState)
  }, [connectedKeyState, connectionState, currentHubDTag])
}

