/**
 * DNN Store — Zustand store for DNN ID verification state
 *
 * Manages:
 * - Verification cache (pubkey → verified DNN ID + relays, 30-min TTL)
 * - Status tracking (pending/verified/failed/not-dnn)
 * - Relay discovery: relays from kind:63600 metadata are cached alongside
 *   verification and exposed via getRelaysForPubkey() for DM/feed use.
 * - Node management delegation to dnnService
 */

import { create } from 'zustand'
import { nip19 } from 'nostr-tools'
import { dnnService, type DnnNodeInfo } from '@/lib/dnn/dnnService'
import { isDnnId, extractDnnId } from '@/lib/dnn/dnnUtils'

/* ─── Constants ─── */

const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

/* ─── Types ─── */

export type DnnVerifyStatus = 'pending' | 'verified' | 'failed' | 'not-dnn'

interface VerifiedEntry {
  dnnId: string
  verifiedAt: number
  relays: string[] // wss:// relay URLs from kind:63600 metadata
}

export interface DnnState {
  /** pubkey → verified DNN ID info (only set when verification passed) */
  verified: Record<string, VerifiedEntry>
  /** pubkey → verification status */
  status: Record<string, DnnVerifyStatus>
  /** Service initialization state */
  serviceReady: boolean

  /* ── Actions ── */

  /**
   * Verify a pubkey's DNN ID.
   * Call this after fetching a profile — it checks if nip05 is a DNN ID and verifies ownership.
   * On success, caches the DNN ID AND any relays from the kind:63600 metadata.
   */
  verifyPubkey: (pubkey: string, nip05: string | undefined | null) => void

  /** Get the verified DNN ID for a pubkey, or null */
  getVerifiedDnnId: (pubkey: string) => string | null

  /** Check if a pubkey has a verified DNN ID */
  isVerified: (pubkey: string) => boolean

  /**
   * Get DNN-discovered relays for a verified pubkey.
   * Returns cached relays if verified and TTL not expired, else [].
   */
  getRelaysForPubkey: (pubkey: string) => string[]

  /**
   * Get deduplicated DNN relays for multiple pubkeys.
   * Unions all relays from verified pubkeys, deduplicates, returns unique list.
   * Useful for feed subscriptions where you follow many DNN users.
   */
  getRelaysForPubkeys: (pubkeys: string[]) => string[]

  /** Initialize the DNN service (call once at app startup) */
  initService: () => Promise<void>

  /** Re-discover nodes */
  refreshNodes: () => Promise<void>

  /** Get all discovered nodes (for settings display) */
  getDiscoveredNodes: () => DnnNodeInfo[]

  /** Get user-configured nodes */
  getUserNodes: () => string[]

  /** Add a user node */
  addUserNode: (url: string) => void

  /** Remove a user node */
  removeUserNode: (url: string) => void
}

/** Set of pubkeys currently being verified (avoid duplicate requests) */
const pendingVerifications = new Set<string>()

export const useDnnStore = create<DnnState>((set, get) => ({
  verified: {},
  status: {},
  serviceReady: false,

  verifyPubkey: (pubkey, nip05) => {
    // Skip if already in-progress
    if (pendingVerifications.has(pubkey)) return

    // Check if nip05 is a DNN ID
    const dnnId = extractDnnId(nip05)
    if (!dnnId) {
      // Not a DNN ID — mark and skip
      if (!get().status[pubkey]) {
        set((s) => ({ status: { ...s.status, [pubkey]: 'not-dnn' } }))
      }
      return
    }

    // Check cache — skip if still valid
    const existing = get().verified[pubkey]
    if (existing && Date.now() - existing.verifiedAt < CACHE_TTL_MS) {
      return
    }

    // Mark as pending
    pendingVerifications.add(pubkey)
    set((s) => ({ status: { ...s.status, [pubkey]: 'pending' } }))

    // Convert hex pubkey to npub for verification
    let npub: string
    try {
      npub = nip19.npubEncode(pubkey)
    } catch {
      pendingVerifications.delete(pubkey)
      set((s) => ({ status: { ...s.status, [pubkey]: 'failed' } }))
      return
    }

    // Fire-and-forget verification — now returns full resolve result
    dnnService.verifyDnnId(dnnId, npub)
      .then((result) => {
        if (result) {
          // Extract relays from kind:63600 metadata (only valid wss:// URLs)
          const relays = (result.metadata?.relays ?? [])
            .filter((r): r is string => typeof r === 'string' && r.startsWith('wss://'))

          if (relays.length > 0) {
            console.log(`[DNN] Discovered ${relays.length} relay(s) for @${dnnId}:`, relays)
          }

          set((s) => ({
            verified: {
              ...s.verified,
              [pubkey]: { dnnId, verifiedAt: Date.now(), relays },
            },
            status: { ...s.status, [pubkey]: 'verified' },
          }))
        } else {
          set((s) => ({ status: { ...s.status, [pubkey]: 'failed' } }))
        }
      })
      .catch(() => {
        set((s) => ({ status: { ...s.status, [pubkey]: 'failed' } }))
      })
      .finally(() => {
        pendingVerifications.delete(pubkey)
      })
  },

  getVerifiedDnnId: (pubkey) => {
    const entry = get().verified[pubkey]
    if (!entry) return null
    // Check TTL
    if (Date.now() - entry.verifiedAt > CACHE_TTL_MS) return null
    return entry.dnnId
  },

  isVerified: (pubkey) => {
    return get().status[pubkey] === 'verified' && !!get().getVerifiedDnnId(pubkey)
  },

  getRelaysForPubkey: (pubkey) => {
    const entry = get().verified[pubkey]
    if (!entry) return []
    // Check TTL — stale entries don't contribute relays
    if (Date.now() - entry.verifiedAt > CACHE_TTL_MS) return []
    return entry.relays
  },

  getRelaysForPubkeys: (pubkeys) => {
    const allRelays = new Set<string>()
    const state = get()
    const now = Date.now()

    for (const pk of pubkeys) {
      const entry = state.verified[pk]
      if (!entry || now - entry.verifiedAt > CACHE_TTL_MS) continue
      for (const relay of entry.relays) {
        allRelays.add(relay)
      }
    }

    return [...allRelays]
  },

  initService: async () => {
    if (get().serviceReady) return
    try {
      await dnnService.initialize()
      set({ serviceReady: true })
    } catch (e) {
      console.error('[dnnStore] Failed to initialize DNN service:', e)
    }
  },

  refreshNodes: async () => {
    await dnnService.healthCheckAll()
    await dnnService.discoverPeers()
    // Trigger re-render by touching state
    set((s) => ({ ...s }))
  },

  getDiscoveredNodes: () => dnnService.getDiscoveredNodes(),

  getUserNodes: () => dnnService.getUserNodes(),

  addUserNode: (url) => {
    dnnService.addUserNode(url)
    set((s) => ({ ...s }))
  },

  removeUserNode: (url) => {
    dnnService.removeUserNode(url)
    set((s) => ({ ...s }))
  },
}))
