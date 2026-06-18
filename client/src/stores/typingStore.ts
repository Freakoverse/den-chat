/**
 * typingStore — Ephemeral "user is typing…" presence state (NIP-CHAT §6.14, kind 26950)
 *
 * Holds, per conversation, a map of `pubkey → lastSeen` (local wall-clock ms at
 * the moment WE received their typing signal). Liveness is judged off our own
 * clock — never the sender's `created_at` — so clock skew between users can't
 * leave an indicator stuck on or never showing.
 *
 * The `enabled` flag is the user's Preferences toggle (persisted, default on);
 * the `typers` map is pure in-memory runtime state.
 */

import { create } from 'zustand'
import { useEffect, useState } from 'react'
import { useUserStore } from '@/stores/userStore'

/** Republish cadence while actively typing. */
export const TYPING_HEARTBEAT_MS = 3000
/** How long after the last received signal a user is still shown as typing. */
export const TYPING_TIMEOUT_MS = 7000

const LS_ENABLED_KEY = 'denchat_typing_indicators'

/** Conversation key for a hub channel. */
export function hubTypingKey(hubDTag: string, channelId: string): string {
  return `hub:${hubDTag}:${channelId}`
}

/** Conversation key for a NIP-04 DM, identified by the counterparty pubkey. */
export function dm04TypingKey(counterpartyPubkey: string): string {
  return `dm04:${counterpartyPubkey}`
}

function loadEnabled(): boolean {
  try {
    const raw = localStorage.getItem(LS_ENABLED_KEY)
    if (raw !== null) return raw === '1'
  } catch { /* ignore */ }
  return true // default on
}

interface TypingState {
  /** User preference — broadcast & display typing indicators. */
  enabled: boolean
  setEnabled: (v: boolean) => void

  /** convKey → (pubkey → lastSeen ms, local clock). */
  typers: Record<string, Record<string, number>>

  /** Record (or refresh) a typing signal from `pubkey` in a conversation. */
  markTyping: (convKey: string, pubkey: string) => void
  /** Clear a single user's typing state (stop signal, or their message arrived). */
  clearTyping: (convKey: string, pubkey: string) => void
  /** Drop expired entries for a conversation; removes the key entirely if empty. */
  prune: (convKey: string) => void
}

export const useTypingStore = create<TypingState>((set, get) => ({
  enabled: loadEnabled(),
  setEnabled: (v) => {
    try { localStorage.setItem(LS_ENABLED_KEY, v ? '1' : '0') } catch { /* ignore */ }
    // Turning off also drops any currently-shown indicators.
    set(v ? { enabled: v } : { enabled: v, typers: {} })
  },

  typers: {},

  markTyping: (convKey, pubkey) => {
    const conv = get().typers[convKey]
    set({
      typers: {
        ...get().typers,
        [convKey]: { ...conv, [pubkey]: Date.now() },
      },
    })
  },

  clearTyping: (convKey, pubkey) => {
    const conv = get().typers[convKey]
    if (!conv || !(pubkey in conv)) return
    const next = { ...conv }
    delete next[pubkey]
    const allTypers = { ...get().typers }
    if (Object.keys(next).length === 0) delete allTypers[convKey]
    else allTypers[convKey] = next
    set({ typers: allTypers })
  },

  prune: (convKey) => {
    const conv = get().typers[convKey]
    if (!conv) return
    const now = Date.now()
    const next: Record<string, number> = {}
    for (const [pk, ts] of Object.entries(conv)) {
      if (now - ts < TYPING_TIMEOUT_MS) next[pk] = ts
    }
    if (Object.keys(next).length === Object.keys(conv).length) return // nothing expired
    const allTypers = { ...get().typers }
    if (Object.keys(next).length === 0) delete allTypers[convKey]
    else allTypers[convKey] = next
    set({ typers: allTypers })
  },
}))

/**
 * Live list of pubkeys currently typing in a conversation, excluding self.
 * Re-renders on new signals and self-expires stale entries via a 1s prune tick.
 */
export function useTypers(convKey: string | null): string[] {
  const record = useTypingStore((s) => (convKey ? s.typers[convKey] : undefined))
  const myPubkey = useUserStore((s) => s.pubkey)
  // Liveness is time-based, so the live set is derived in an effect (time reads
  // and pruning must stay out of render) and held in state. The 1s tick both
  // refreshes the displayed set and prunes expired entries from the store.
  const [live, setLive] = useState<string[]>([])

  useEffect(() => {
    const compute = (): boolean => {
      if (!record) { setLive((prev) => (prev.length ? [] : prev)); return false }
      const now = Date.now()
      const next = Object.entries(record)
        .filter(([pk, ts]) => pk !== myPubkey && now - ts < TYPING_TIMEOUT_MS)
        .map(([pk]) => pk)
      setLive((prev) =>
        prev.length === next.length && prev.every((p, i) => p === next[i]) ? prev : next,
      )
      return Object.values(record).some((ts) => now - ts >= TYPING_TIMEOUT_MS)
    }

    compute()
    if (!record || !convKey) return
    const id = setInterval(() => {
      if (compute()) useTypingStore.getState().prune(convKey)
    }, 1000)
    return () => clearInterval(id)
  }, [record, myPubkey, convKey])

  return live
}
