/**
 * dmSpamFilterStore — "hide low effort DMs" (NIP-13 proof-of-work gate for the DM "Other" tab).
 *
 * Low-effort DM spam is cheap to send because a gift wrap / kind-4 / MDM event costs nothing to
 * produce. Requiring a minimum PoW (leading-zero bits on the event id, NIP-13) makes bulk spam
 * expensive while a single genuine DM is trivial to mine. When enabled, conversations in the DM
 * **Other** tab (never Following) whose incoming messages don't clear the threshold are hidden from
 * the list AND excluded from the unread badge. SFX is already followed-only, so Other never beeps.
 *
 * This is presentational only: nothing is deleted, and lowering the threshold (or disabling the
 * filter) brings hidden conversations straight back. It is a stop-gap until a published PoW-advertising
 * convention exists; some clients don't attach PoW, so legitimate DMs from them can be hidden too —
 * that trade-off is the point, and the user controls it.
 */

import { create } from 'zustand'
import { countLeadingZeroBits } from '@/lib/pow/pow'

const LS_KEY = 'dm-spam-filter'

/** Default PoW bar (leading-zero bits) for the slider. */
export const DEFAULT_DM_POW_THRESHOLD = 15
export const DM_POW_MIN = 1
export const DM_POW_MAX = 30

/** Default send-side PoW the client mines ALL outgoing DMs (B/M/W) to. 0 = off (no mining). */
export const DEFAULT_DM_SEND_POW = 15
export const DM_SEND_POW_MIN = 0
export const DM_SEND_POW_MAX = 30

interface DmSpamFilterState {
  /** Whether the "Other" tab + badge hide below-threshold DMs. Default ON (opt-out). */
  enabled: boolean
  /** Minimum NIP-13 leading-zero bits an incoming DM must have to show in "Other". */
  threshold: number
  /** NIP-13 leading-zero bits the client mines every outgoing DM to (0 = off). */
  sendTarget: number
  setEnabled: (v: boolean) => void
  setThreshold: (v: number) => void
  setSendTarget: (v: number) => void
  /** Reset the threshold back to the default (leaves enabled as-is). */
  resetThreshold: () => void
}

function clampThreshold(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_DM_POW_THRESHOLD
  return Math.max(DM_POW_MIN, Math.min(DM_POW_MAX, Math.round(v)))
}

function clampSendTarget(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_DM_SEND_POW
  return Math.max(DM_SEND_POW_MIN, Math.min(DM_SEND_POW_MAX, Math.round(v)))
}

function load(): { enabled: boolean; threshold: number; sendTarget: number } {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const d = JSON.parse(raw) as { enabled?: unknown; threshold?: unknown; sendTarget?: unknown }
      return {
        // Default ON: only an explicit stored `false` disables it (so a user who turned it off stays off).
        enabled: d.enabled !== false,
        threshold: typeof d.threshold === 'number' ? clampThreshold(d.threshold) : DEFAULT_DM_POW_THRESHOLD,
        sendTarget: typeof d.sendTarget === 'number' ? clampSendTarget(d.sendTarget) : DEFAULT_DM_SEND_POW,
      }
    }
  } catch { /* storage blocked / corrupt */ }
  return { enabled: true, threshold: DEFAULT_DM_POW_THRESHOLD, sendTarget: DEFAULT_DM_SEND_POW }
}

function persist(enabled: boolean, threshold: number, sendTarget: number): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ enabled, threshold, sendTarget })) } catch { /* storage blocked */ }
}

export const useDmSpamFilterStore = create<DmSpamFilterState>((set, get) => ({
  ...load(),
  setEnabled: (v) => { set({ enabled: v }); persist(v, get().threshold, get().sendTarget) },
  setThreshold: (v) => { const t = clampThreshold(v); set({ threshold: t }); persist(get().enabled, t, get().sendTarget) },
  setSendTarget: (v) => { const s = clampSendTarget(v); set({ sendTarget: s }); persist(get().enabled, get().threshold, s) },
  resetThreshold: () => { set({ threshold: DEFAULT_DM_POW_THRESHOLD }); persist(get().enabled, DEFAULT_DM_POW_THRESHOLD, get().sendTarget) },
}))

/** The send-side DM PoW target, read outside React (send paths). */
export function getDmSendPowTarget(): number {
  return useDmSpamFilterStore.getState().sendTarget
}

/**
 * Does a DM conversation clear the PoW bar? True (show / count it) when it has NO incoming messages
 * (so it's the user's own outgoing or a freshly-started pending thread, never spam) OR at least one
 * incoming (not-mine) message whose event id has >= `threshold` leading-zero bits. Scans with an
 * early return, so a legitimate thread is cheap; a pure-spam thread is tiny anyway.
 */
export function conversationClearsDmPow(
  messages: { id: string; isMine: boolean }[],
  threshold: number,
): boolean {
  let hasIncoming = false
  for (const m of messages) {
    if (m.isMine) continue
    hasIncoming = true
    if (countLeadingZeroBits(m.id) >= threshold) return true
  }
  return !hasIncoming
}
