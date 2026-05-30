/**
 * Zap Store — Zustand store for Lightning Zap receipts
 *
 * Stores zap receipts indexed by hubDTag → messageEventId → ZapInfo[].
 * Similar structure to reactions in messageStore.
 */

import { create } from 'zustand'
import type { ZapInfo } from '@/lib/nostr/zap'

interface ZapState {
  /** Zaps indexed by hubDTag → targetMessageEventId → ZapInfo[] */
  zaps: Record<string, Record<string, ZapInfo[]>>
  /** Processed zap receipt event IDs (deduplication) */
  processedZapIds: Set<string>

  /** Add a zap receipt (deduplicates by receiptId) */
  addZap: (hubDTag: string, messageId: string, zap: ZapInfo) => void
  /** Mark a zap receipt ID as processed; returns false if already processed */
  markZapProcessed: (receiptId: string) => boolean
  /** Get total sats for a message */
  getZapTotal: (hubDTag: string, messageId: string) => number
  /** Get zap count for a message */
  getZapCount: (hubDTag: string, messageId: string) => number
}

/** Stable empty object to prevent Zustand selector from returning new reference each render */
const EMPTY_ZAPS: Record<string, ZapInfo[]> = {}

export const useZapStore = create<ZapState>((set, get) => ({
  zaps: {},
  processedZapIds: new Set(),

  addZap: (hubDTag, messageId, zap) =>
    set((state) => {
      const hubZaps = state.zaps[hubDTag] || {}
      const existing = hubZaps[messageId] || []
      // Deduplicate by receiptId
      if (existing.some((z) => z.receiptId === zap.receiptId)) return state
      return {
        zaps: {
          ...state.zaps,
          [hubDTag]: {
            ...hubZaps,
            [messageId]: [...existing, zap],
          },
        },
      }
    }),

  markZapProcessed: (receiptId) => {
    const state = get()
    if (state.processedZapIds.has(receiptId)) return false
    set({ processedZapIds: new Set(state.processedZapIds).add(receiptId) })
    return true
  },

  getZapTotal: (hubDTag, messageId) => {
    const state = get()
    const zaps = state.zaps[hubDTag]?.[messageId] || []
    return zaps.reduce((sum, z) => sum + z.amount, 0)
  },

  getZapCount: (hubDTag, messageId) => {
    const state = get()
    return (state.zaps[hubDTag]?.[messageId] || []).length
  },
}))

/** Get hub zaps (stable reference for selectors) */
export function getHubZaps(hubDTag: string): Record<string, ZapInfo[]> {
  return useZapStore.getState().zaps[hubDTag] || EMPTY_ZAPS
}
