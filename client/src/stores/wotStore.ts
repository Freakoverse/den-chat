/**
 * WoT Store — Web of Trust scoring engine
 *
 * Scores users based on the social graph:
 *   +1 for each person in your graph (up to followDepth) who follows them
 *   -1 for each person in your graph who publicly mutes/blocks them
 *   +1 if they have a verified DNN ID (toggleable)
 *
 * Overrides:
 *   - Direct follow: always shown (bypass WoT entirely)
 *   - Direct block: existing block behavior applies (WoT irrelevant)
 *
 * Performance:
 *   - Graph is built lazily in background using requestIdleCallback
 *   - Scores are cached per pubkey with 10-min TTL
 *   - Smart refresh: on TTL expiry, compare event created_at + id
 *     to detect changes without re-parsing unchanged data
 */

import { create } from 'zustand'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { useFollowStore } from '@/stores/followStore'
import { useBlockStore } from '@/stores/blockStore'
import { useDnnStore } from '@/stores/dnnStore'
import type { Event } from 'nostr-tools'

/* ─── Constants ─── */

const STORAGE_KEY = 'den_wot_settings'
const SCORE_CACHE_TTL = 10 * 60 * 1000 // 10 minutes
const GRAPH_BATCH_SIZE = 50 // pubkeys per relay query batch
const MAX_GRAPH_SIZE = 5000 // safety cap on total graph nodes

/* ─── Types ─── */

export interface WotSettings {
  scoreThreshold: number    // -5 to +5, default 0
  followDepth: number       // 0 to 3, default 0
  dnnBonus: boolean         // DNN ID = +1, default true
  applySocial: boolean      // Filter social feed, default true
  applyPublicChat: boolean  // Filter public chat, default true
  applyHubChat: boolean     // Filter hub chat, default false
  applyDMs: boolean         // Filter DMs (NIP-17 & NIP-04), default true
}

export type WotContext = 'social' | 'publicChat' | 'hubChat' | 'dms'

interface CachedScore {
  score: number
  computedAt: number
}

/** Snapshot of an event's identity for smart refresh */
interface EventSnapshot {
  id: string
  created_at: number
}

interface GraphData {
  /** pubkey → Set of pubkeys they follow */
  follows: Map<string, Set<string>>
  /** pubkey → Set of pubkeys they publicly mute/block */
  publicMutes: Map<string, Set<string>>
  /** pubkey → event snapshot for change detection */
  followEventSnapshots: Map<string, EventSnapshot>
  muteEventSnapshots: Map<string, EventSnapshot>
  /** The depth levels that have been built */
  builtDepth: number
  /** Timestamp of last graph build */
  builtAt: number
  /** Pubkeys discovered at each depth level (for incremental builds) */
  depthLevelPubkeys: Map<number, Set<string>>
}

export interface WotState {
  settings: WotSettings
  /** Whether the graph is currently being built */
  building: boolean
  /** Current built depth */
  graphDepth: number
  /** Graph build progress info */
  graphSize: number
  /** Build progress: what phase we're in */
  buildPhase: string
  /** Build progress: items processed so far */
  buildProgress: number
  /** Build progress: total items to process */
  buildTotal: number
  /** Build progress: target depth being built */
  buildDepthTarget: number
  /** Build progress: which depth level is currently being fetched */
  buildDepthCurrent: number

  /* ── Actions ── */

  /** Update WoT settings */
  updateSettings: (partial: Partial<WotSettings>) => void

  /**
   * Check if a pubkey should be hidden based on WoT score.
   * Returns true if the user should be HIDDEN.
   * Fast path: direct follow → false, direct block → defers to blockStore.
   */
  shouldHide: (pubkey: string, context: WotContext) => boolean

  /**
   * Get the computed WoT score for a pubkey.
   * Uses cache, computes on miss.
   */
  getScore: (pubkey: string) => number

  /**
   * Build the social graph up to the configured depth.
   * Called once at startup and on settings change.
   */
  buildGraph: () => Promise<void>

  /**
   * Smart refresh — check if graph data has changed, only rebuild delta.
   */
  refreshGraph: () => Promise<void>
}

/* ─── Default Settings ─── */

const DEFAULT_SETTINGS: WotSettings = {
  scoreThreshold: 0,
  followDepth: 0,
  dnnBonus: true,
  applySocial: true,
  applyPublicChat: true,
  applyHubChat: false,
  applyDMs: true,
}

/* ─── Helpers ─── */

function loadSettings(): WotSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return { ...DEFAULT_SETTINGS, ...parsed }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(settings: WotSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch { /* ignore */ }
}

/**
 * Fetch kind:3 (follow lists) for a batch of pubkeys.
 * Returns the latest event per pubkey.
 */
async function fetchFollowLists(
  pubkeys: string[],
  onBatchDone?: (processed: number, total: number) => void,
): Promise<Map<string, Event>> {
  const result = new Map<string, Event>()
  if (pubkeys.length === 0) return result

  const total = pubkeys.length
  let processed = 0

  // Batch to avoid huge relay queries
  for (let i = 0; i < pubkeys.length; i += GRAPH_BATCH_SIZE) {
    const batch = pubkeys.slice(i, i + GRAPH_BATCH_SIZE)
    try {
      const events = await fetchEvents({
        kinds: [3],
        authors: batch,
        limit: batch.length,
      })
      // Keep only the latest per pubkey
      for (const ev of events) {
        const existing = result.get(ev.pubkey)
        if (!existing || ev.created_at > existing.created_at) {
          result.set(ev.pubkey, ev)
        }
      }
    } catch (err) {
      console.warn('[WoT] Failed to fetch follow lists batch:', err)
    }
    processed += batch.length
    onBatchDone?.(processed, total)
  }

  return result
}

/**
 * Fetch kind:10000 (mute lists) for a batch of pubkeys.
 * Only parses PUBLIC tags — encrypted content is ignored.
 */
async function fetchPublicMuteLists(
  pubkeys: string[],
  onBatchDone?: (processed: number, total: number) => void,
): Promise<Map<string, { event: Event; muted: Set<string> }>> {
  const result = new Map<string, { event: Event; muted: Set<string> }>()
  if (pubkeys.length === 0) return result

  const total = pubkeys.length
  let processed = 0

  for (let i = 0; i < pubkeys.length; i += GRAPH_BATCH_SIZE) {
    const batch = pubkeys.slice(i, i + GRAPH_BATCH_SIZE)
    try {
      const events = await fetchEvents({
        kinds: [10000],
        authors: batch,
        limit: batch.length,
      })
      // Keep latest per pubkey, parse public p-tags only
      for (const ev of events) {
        const existing = result.get(ev.pubkey)
        if (!existing || ev.created_at > existing.event.created_at) {
          const muted = new Set<string>()
          for (const tag of ev.tags) {
            if (tag[0] === 'p' && tag[1]) muted.add(tag[1])
          }
          result.set(ev.pubkey, { event: ev, muted })
        }
      }
    } catch (err) {
      console.warn('[WoT] Failed to fetch mute lists batch:', err)
    }
    processed += batch.length
    onBatchDone?.(processed, total)
  }

  return result
}

/* ─── Module-level graph & score cache ─── */

let graphData: GraphData = {
  follows: new Map(),
  publicMutes: new Map(),
  followEventSnapshots: new Map(),
  muteEventSnapshots: new Map(),
  builtDepth: -1,
  builtAt: 0,
  depthLevelPubkeys: new Map(),
}

const scoreCache = new Map<string, CachedScore>()

/* ─── Store ─── */

export const useWotStore = create<WotState>((set, get) => ({
  settings: loadSettings(),
  building: false,
  graphDepth: -1,
  graphSize: 0,
  buildPhase: '',
  buildProgress: 0,
  buildTotal: 0,
  buildDepthTarget: 0,
  buildDepthCurrent: 0,

  updateSettings: (partial) => {
    const next = { ...get().settings, ...partial }
    saveSettings(next)

    // Check if we need to build more graph
    const depthIncreased = partial.followDepth !== undefined && partial.followDepth > graphData.builtDepth
    set({ settings: next })

    // Clear score cache when settings change (threshold or depth affects results)
    scoreCache.clear()

    // Only trigger a build if depth increased beyond what we've already cached
    if (depthIncreased && !get().building) {
      get().buildGraph()
    }
  },

  shouldHide: (pubkey, context) => {
    const { settings } = get()

    // Check if WoT is enabled for this context
    switch (context) {
      case 'social': if (!settings.applySocial) return false; break
      case 'publicChat': if (!settings.applyPublicChat) return false; break
      case 'hubChat': if (!settings.applyHubChat) return false; break
      case 'dms': if (!settings.applyDMs) return false; break
    }

    // Direct follow override — never hide people you follow
    const myFollows = useFollowStore.getState().followedPubkeys
    if (myFollows.has(pubkey)) return false

    // Direct block — handled by blockStore, not WoT
    if (useBlockStore.getState().isBlocked(pubkey)) return false

    // Compute or retrieve cached score
    const score = get().getScore(pubkey)

    return score < settings.scoreThreshold
  },

  getScore: (pubkey) => {
    const now = Date.now()

    // Check cache
    const cached = scoreCache.get(pubkey)
    if (cached && now - cached.computedAt < SCORE_CACHE_TTL) {
      return cached.score
    }

    // Compute score
    const { settings } = get()
    let score = 0

    // Collect all pubkeys in our graph (up to built depth)
    const graphPubkeys = new Set<string>()
    const myFollows = useFollowStore.getState().followedPubkeys

    // Depth 0: my direct follows
    for (const pk of myFollows) {
      graphPubkeys.add(pk)
    }

    // Depth 1+: follows of follows (from pre-built graph)
    if (settings.followDepth >= 1) {
      const addFollowsAtDepth = (sources: Set<string>, currentDepth: number) => {
        if (currentDepth > settings.followDepth) return
        if (graphPubkeys.size >= MAX_GRAPH_SIZE) return

        const nextSources = new Set<string>()
        for (const source of sources) {
          const theirFollows = graphData.follows.get(source)
          if (!theirFollows) continue
          for (const pk of theirFollows) {
            if (!graphPubkeys.has(pk)) {
              graphPubkeys.add(pk)
              nextSources.add(pk)
              if (graphPubkeys.size >= MAX_GRAPH_SIZE) return
            }
          }
        }

        if (nextSources.size > 0 && currentDepth + 1 <= settings.followDepth) {
          addFollowsAtDepth(nextSources, currentDepth + 1)
        }
      }
      addFollowsAtDepth(myFollows, 1)
    }

    // Count positive signals: how many graph members follow the target
    for (const pk of graphPubkeys) {
      const theirFollows = graphData.follows.get(pk)
      if (theirFollows && theirFollows.has(pubkey)) {
        score += 1
      }
    }

    // Count negative signals: how many graph members publicly mute the target
    for (const pk of graphPubkeys) {
      const theirMutes = graphData.publicMutes.get(pk)
      if (theirMutes && theirMutes.has(pubkey)) {
        score -= 1
      }
    }

    // Also check my own follows' public mutes (always available even at depth 0)
    for (const pk of myFollows) {
      if (!graphPubkeys.has(pk)) {
        const theirMutes = graphData.publicMutes.get(pk)
        if (theirMutes && theirMutes.has(pubkey)) {
          score -= 1
        }
      }
    }

    // DNN bonus
    if (settings.dnnBonus) {
      const dnnVerified = useDnnStore.getState().isVerified(pubkey)
      if (dnnVerified) {
        score += 1
      }
    }

    // Cache it
    scoreCache.set(pubkey, { score, computedAt: now })

    return score
  },

  buildGraph: async () => {
    if (get().building) return

    const { settings } = get()
    const myFollows = useFollowStore.getState().followedPubkeys
    const myFollowsArr = Array.from(myFollows)

    // Determine the starting depth — skip levels we already have
    const startFromDepth = graphData.builtDepth + 1
    const targetDepth = settings.followDepth

    // If we already have everything cached, nothing to do
    if (graphData.builtDepth >= targetDepth && graphData.builtDepth >= 0) {
      console.log(`[WoT] Graph already built to depth ${graphData.builtDepth}, target is ${targetDepth} — skipping`)
      scoreCache.clear()
      set({ graphDepth: graphData.builtDepth, graphSize: graphData.follows.size })
      return
    }

    set({
      building: true,
      buildPhase: startFromDepth === 0 ? 'Fetching follow lists…' : `Resuming from depth ${startFromDepth}…`,
      buildProgress: 0,
      buildTotal: myFollowsArr.length,
      buildDepthTarget: targetDepth,
      buildDepthCurrent: startFromDepth,
    })

    console.log(`[WoT] Building graph — depth ${startFromDepth}→${targetDepth}, ${myFollowsArr.length} direct follows`)
    const startTime = Date.now()

    try {
      // Only fetch depth-0 data if we haven't already
      if (graphData.builtDepth < 0) {
        set({ buildPhase: 'Fetching follow lists…', buildProgress: 0, buildTotal: myFollowsArr.length, buildDepthCurrent: 0 })
        const followEvents = await fetchFollowLists(myFollowsArr, (p, t) => {
          set({ buildProgress: p, buildTotal: t })
        })

        set({ buildPhase: 'Fetching mute lists…', buildProgress: 0, buildTotal: myFollowsArr.length })
        const muteData = await fetchPublicMuteLists(myFollowsArr, (p, t) => {
          set({ buildProgress: p, buildTotal: t })
        })

        // Parse follow lists into graph
        set({ buildPhase: 'Processing…', buildProgress: 0, buildTotal: followEvents.size })
        for (const [pk, ev] of followEvents) {
          const follows = new Set<string>()
          for (const tag of ev.tags) {
            if (tag[0] === 'p' && tag[1]) follows.add(tag[1])
          }
          graphData.follows.set(pk, follows)
          graphData.followEventSnapshots.set(pk, { id: ev.id, created_at: ev.created_at })
        }

        // Parse public mutes
        for (const [pk, data] of muteData) {
          graphData.publicMutes.set(pk, data.muted)
          graphData.muteEventSnapshots.set(pk, { id: data.event.id, created_at: data.event.created_at })
        }

        graphData.builtDepth = 0
        graphData.depthLevelPubkeys.set(0, myFollows)
        set({ graphDepth: 0, graphSize: graphData.follows.size })
      }

      // Build deeper levels if needed
      if (targetDepth >= 1) {
        // Figure out which pubkeys were at the last built depth level
        // so we can continue from there
        let currentLevelPubkeys = graphData.depthLevelPubkeys.get(graphData.builtDepth) || myFollows
        let allKnown = new Set<string>(graphData.follows.keys())
        // Also add my follows
        for (const pk of myFollowsArr) allKnown.add(pk)

        const resumeDepth = Math.max(1, graphData.builtDepth + 1)

        for (let depth = resumeDepth; depth <= targetDepth; depth++) {
          // Check if we already have this depth cached
          if (graphData.depthLevelPubkeys.has(depth)) {
            currentLevelPubkeys = graphData.depthLevelPubkeys.get(depth)!
            for (const pk of currentLevelPubkeys) allKnown.add(pk)
            graphData.builtDepth = depth
            set({ graphDepth: depth, graphSize: graphData.follows.size, buildDepthCurrent: depth })
            continue
          }

          // Collect next-level pubkeys (follows of current level)
          const nextLevel = new Set<string>()
          for (const pk of currentLevelPubkeys) {
            const theirFollows = graphData.follows.get(pk)
            if (!theirFollows) continue
            for (const followedPk of theirFollows) {
              if (!allKnown.has(followedPk)) {
                nextLevel.add(followedPk)
                allKnown.add(followedPk)
                if (allKnown.size >= MAX_GRAPH_SIZE) break
              }
            }
            if (allKnown.size >= MAX_GRAPH_SIZE) break
          }

          if (nextLevel.size === 0) break

          console.log(`[WoT] Depth ${depth}: fetching ${nextLevel.size} follow lists`)

          const nextLevelArr = Array.from(nextLevel)

          // Fetch follow lists with progress
          set({
            buildPhase: `Depth ${depth}: fetching follow lists…`,
            buildProgress: 0,
            buildTotal: nextLevelArr.length,
            buildDepthCurrent: depth,
          })
          const nextFollowEvents = await fetchFollowLists(nextLevelArr, (p, t) => {
            set({ buildProgress: p, buildTotal: t, graphSize: graphData.follows.size })
          })

          // Fetch mute lists with progress
          set({
            buildPhase: `Depth ${depth}: fetching mute lists…`,
            buildProgress: 0,
            buildTotal: nextLevelArr.length,
          })
          const nextMuteData = await fetchPublicMuteLists(nextLevelArr, (p, t) => {
            set({ buildProgress: p, buildTotal: t })
          })

          // Parse results
          set({ buildPhase: `Depth ${depth}: processing…` })
          for (const [pk, ev] of nextFollowEvents) {
            const follows = new Set<string>()
            for (const tag of ev.tags) {
              if (tag[0] === 'p' && tag[1]) follows.add(tag[1])
            }
            graphData.follows.set(pk, follows)
            graphData.followEventSnapshots.set(pk, { id: ev.id, created_at: ev.created_at })
          }

          for (const [pk, data] of nextMuteData) {
            graphData.publicMutes.set(pk, data.muted)
            graphData.muteEventSnapshots.set(pk, { id: data.event.id, created_at: data.event.created_at })
          }

          graphData.builtDepth = depth
          graphData.depthLevelPubkeys.set(depth, nextLevel)
          currentLevelPubkeys = nextLevel

          // Update UI progress
          set({ graphDepth: depth, graphSize: graphData.follows.size })

          // Yield to main thread between depth levels
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }

      graphData.builtAt = Date.now()

      // Clear score cache since graph changed
      scoreCache.clear()

      const elapsed = Date.now() - startTime
      console.log(`[WoT] Graph built in ${elapsed}ms — ${graphData.follows.size} follow lists, ${graphData.publicMutes.size} mute lists`)

      set({
        building: false,
        graphDepth: graphData.builtDepth,
        graphSize: graphData.follows.size,
        buildPhase: '',
        buildProgress: 0,
        buildTotal: 0,
      })
    } catch (err) {
      console.error('[WoT] Graph build failed:', err)
      set({ building: false, buildPhase: '', buildProgress: 0, buildTotal: 0 })
    }
  },

  refreshGraph: async () => {
    if (get().building) return

    const { settings } = get()
    const myFollows = useFollowStore.getState().followedPubkeys
    const myFollowsArr = Array.from(myFollows)

    // If graph was never built, do a full build
    if (graphData.builtDepth < 0) {
      return get().buildGraph()
    }

    // Collect all pubkeys currently in the graph
    const allGraphPubkeys = Array.from(graphData.follows.keys())
    if (allGraphPubkeys.length === 0) {
      return get().buildGraph()
    }

    console.log(`[WoT] Smart refresh — checking ${allGraphPubkeys.length} pubkeys for changes`)

    set({ building: true })

    try {
      let changesDetected = 0

      // Check follow list changes by comparing event IDs
      const freshFollowEvents = await fetchFollowLists(allGraphPubkeys)
      for (const [pk, ev] of freshFollowEvents) {
        const snapshot = graphData.followEventSnapshots.get(pk)
        if (!snapshot || snapshot.id !== ev.id || snapshot.created_at !== ev.created_at) {
          // This pubkey's follow list changed — update
          const follows = new Set<string>()
          for (const tag of ev.tags) {
            if (tag[0] === 'p' && tag[1]) follows.add(tag[1])
          }
          graphData.follows.set(pk, follows)
          graphData.followEventSnapshots.set(pk, { id: ev.id, created_at: ev.created_at })
          changesDetected++
        }
      }

      // Check mute list changes
      const freshMuteData = await fetchPublicMuteLists(allGraphPubkeys)
      for (const [pk, data] of freshMuteData) {
        const snapshot = graphData.muteEventSnapshots.get(pk)
        if (!snapshot || snapshot.id !== data.event.id || snapshot.created_at !== data.event.created_at) {
          graphData.publicMutes.set(pk, data.muted)
          graphData.muteEventSnapshots.set(pk, { id: data.event.id, created_at: data.event.created_at })
          changesDetected++
        }
      }

      // Check for new follows we don't have in graph yet
      for (const pk of myFollowsArr) {
        if (!graphData.follows.has(pk)) {
          changesDetected++
        }
      }

      if (changesDetected > 0) {
        console.log(`[WoT] Smart refresh: ${changesDetected} change(s) detected, clearing score cache`)
        scoreCache.clear()

        // If there are new follows, rebuild to pick them up
        if (myFollowsArr.some(pk => !graphData.follows.has(pk))) {
          set({ building: false })
          return get().buildGraph()
        }
      } else {
        console.log(`[WoT] Smart refresh: no changes detected`)
      }

      graphData.builtAt = Date.now()
      set({ building: false, graphSize: graphData.follows.size })
    } catch (err) {
      console.error('[WoT] Smart refresh failed:', err)
      set({ building: false })
    }
  },
}))
