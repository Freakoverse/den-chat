/**
 * useTypingHeartbeat — Publishes ephemeral typing-indicator events (NIP-CHAT §6.14, kind 26950).
 *
 * The composer calls `notifyTyping()` on each input change (when the field is
 * non-empty); the hook throttles to one publish per TYPING_HEARTBEAT_MS, which
 * naturally produces the "first keystroke, then every ~3s while typing" cadence
 * without an internal timer. `notifyStop()` (on send / clear / blur / unmount)
 * emits a one-shot stop signal so receivers clear instantly.
 *
 * Broadcasting works with any available signer (local key, PC55, NIP-07
 * extension, or a remote signer like Bunker/UPV2). Remote signers will ask to
 * approve each ~3s beat unless the user enables auto-approve on their end. An
 * in-flight guard keeps pings from piling up on a slow signer; users with no
 * signer at all simply don't broadcast (they still receive).
 */

import { useCallback, useEffect, useRef } from 'react'
import { createHubTypingEvent, createDM04TypingEvent, signWithSigner } from '@/lib/nostr/events'
import { publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { useUserStore } from '@/stores/userStore'
import { useTypingStore, TYPING_HEARTBEAT_MS } from '@/stores/typingStore'

type TypingTarget =
  | { scope: 'hub'; hubDTag: string; channelId: string; recipientPubkey?: undefined }
  | { scope: 'dm04'; recipientPubkey: string; hubDTag?: undefined; channelId?: undefined }

export interface TypingHeartbeat {
  /** Call on input change while the composer is non-empty. Throttled internally. */
  notifyTyping: () => void
  /** Call on send / clear / blur. Emits a stop signal if we were typing. */
  notifyStop: () => void
}

export function useTypingHeartbeat(target: TypingTarget & { relays: string[] }): TypingHeartbeat {
  const lastPublishRef = useRef(0)
  const activeRef = useRef(false)
  const inFlightRef = useRef(false)
  const targetRef = useRef(target)
  useEffect(() => { targetRef.current = target })

  const publish = useCallback(async (stop: boolean) => {
    const t = targetRef.current
    if (!useTypingStore.getState().enabled) return
    const { pubkey, privateKey, signer } = useUserStore.getState()
    if (!pubkey || (!privateKey && !signer)) return // nothing to sign with
    if (!t.relays || t.relays.length === 0) return
    // Don't queue typing pings behind a slow signer; stop signals always go through.
    if (!stop && inFlightRef.current) return

    const unsigned = t.scope === 'hub'
      ? (t.hubDTag && t.channelId ? createHubTypingEvent(t.hubDTag, t.channelId, stop) : null)
      : (t.recipientPubkey ? createDM04TypingEvent(t.recipientPubkey, stop) : null)
    if (!unsigned) return

    inFlightRef.current = true
    try {
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishToSpecificRelays(t.relays, signed)
    } catch { /* best-effort, never disrupts typing */ }
    finally { inFlightRef.current = false }
  }, [])

  const notifyTyping = useCallback(() => {
    const now = Date.now()
    if (now - lastPublishRef.current < TYPING_HEARTBEAT_MS) return
    lastPublishRef.current = now
    activeRef.current = true
    void publish(false)
  }, [publish])

  const notifyStop = useCallback(() => {
    if (!activeRef.current) return
    activeRef.current = false
    lastPublishRef.current = 0
    void publish(true)
  }, [publish])

  // Leaving the conversation while mid-type → send a stop so peers clear instantly.
  useEffect(() => () => { notifyStop() }, [notifyStop])

  return { notifyTyping, notifyStop }
}
