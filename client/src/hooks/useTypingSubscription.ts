/**
 * useTypingSubscription — Receives ephemeral typing-indicator events (NIP-CHAT §6.14, kind 26950).
 *
 * Two scoped subscriptions, both gated on the user's Preferences toggle so that
 * disabling the feature stops inbound traffic entirely (no subscription opened):
 *   - Hub:  { kinds:[26950], #h:[activeHub], since:now } — only the hub in view.
 *   - DM04: { kinds:[26950], #p:[me],        since:now } — the local user's inbox.
 *
 * Received signals are written to the typingStore keyed by conversation. Liveness
 * is judged off our local clock (see typingStore), not the event's created_at.
 */

import { useEffect, useMemo } from 'react'
import type { Event } from 'nostr-tools'
import { subscribeToRelays, getRelays } from '@/lib/nostr/relay-pool'
import { useTypingStore, hubTypingKey, dm04TypingKey } from '@/stores/typingStore'
import { useUserStore } from '@/stores/userStore'
import { useHubStore } from '@/stores/hubStore'
import { KINDS } from '@/lib/crypto/constants'

function isStopSignal(event: Event): boolean {
  return event.tags.some((t) => t[0] === 'typing' && t[1] === 'stop')
}

async function handleHubTyping(event: Event) {
  const h = event.tags.find((t) => t[0] === 'h')?.[1]
  const c = event.tags.find((t) => t[0] === 'c')?.[1]
  if (!h || !c) return

  const hub = useHubStore.getState().hubs[h]
  const { isV2 } = await import('@/lib/hub/version')
  const v2 = !!hub && isV2(hub)

  // v1: the author IS the real key R. v2: the author is a pseudonym P; the real typer R is
  // enc(hubKey, R) in the content — decrypting it also PROVES membership (AES-GCM auth tag
  // only verifies with the hub key), so no separate roster check is needed (which wouldn't
  // work cross-page anyway).
  let whoR = event.pubkey
  if (v2) {
    const secretHex = useHubStore.getState().hubSecrets[h]
    if (!secretHex || !event.content) return
    try {
      const { deriveHubContentKey } = await import('@/lib/hub/hubContent')
      const { aesDecrypt } = await import('@/lib/crypto/aes')
      const { fromHex } = await import('@/lib/crypto/lkh')
      whoR = await aesDecrypt(deriveHubContentKey(fromHex(secretHex), hub!.epoch), event.content)
    } catch { return } // wrong key/epoch or forged → drop
  }

  if (whoR === useUserStore.getState().pubkey) return // ignore own
  if (!v2) {
    // v1 membership check (mirrors the edit-hint check).
    const members = useHubStore.getState().hubMembers[h]
    if (members && members.length > 0 && !members.some((m) => m.pubkey === whoR)) return
  }

  const key = hubTypingKey(h, c)
  const store = useTypingStore.getState()
  if (isStopSignal(event)) store.clearTyping(key, whoR)
  else store.markTyping(key, whoR)
}

function handleDM04Typing(event: Event, myPubkey: string) {
  if (event.pubkey === myPubkey) return
  // Must be addressed to me.
  if (event.tags.find((t) => t[0] === 'p')?.[1] !== myPubkey) return

  const key = dm04TypingKey(event.pubkey) // conversation keyed by the counterparty (sender)
  const store = useTypingStore.getState()
  if (isStopSignal(event)) store.clearTyping(key, event.pubkey)
  else store.markTyping(key, event.pubkey)
}

export function useTypingSubscription() {
  const enabled = useTypingStore((s) => s.enabled)
  const myPubkey = useUserStore((s) => s.pubkey)
  const activeHubId = useHubStore((s) => s.activeHubId)
  const activeHub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : undefined))

  const hubRelays = useMemo(
    () => (activeHub ? [...new Set(activeHub.generalRelays)].filter(Boolean) : []),
    [activeHub],
  )
  const hubRelayKey = hubRelays.join(',')

  // ── Hub typing — scoped to the active hub ──
  useEffect(() => {
    if (!enabled || !activeHubId || hubRelays.length === 0) return
    const now = Math.floor(Date.now() / 1000)
    const sub = subscribeToRelays(
      hubRelays,
      { kinds: [KINDS.TYPING_INDICATOR], '#h': [activeHubId], since: now },
      handleHubTyping,
    )
    return () => sub.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, activeHubId, hubRelayKey])

  // ── DM04 typing — my inbox ──
  useEffect(() => {
    if (!enabled || !myPubkey) return
    const relays = getRelays()
    if (relays.length === 0) return
    const now = Math.floor(Date.now() / 1000)
    const sub = subscribeToRelays(
      relays,
      { kinds: [KINDS.TYPING_INDICATOR], '#p': [myPubkey], since: now },
      (event) => handleDM04Typing(event, myPubkey),
    )
    return () => sub.close()
  }, [enabled, myPubkey])
}
