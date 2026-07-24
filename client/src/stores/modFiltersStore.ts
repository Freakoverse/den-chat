/**
 * Mod listing filters for the Discover → Mods tab. Persisted to localStorage so
 * they survive restarts. Ported from DEG MODS' modFiltersStore, minus legacy
 * (kind-30402) mods — DEN Chat never shows those — and with its OWN PoW value
 * (independent of the forum/hub PoW controls, per product decision).
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type NsfwMode = 'hide' | 'show' | 'only'
export type RepostMode = 'originals' | 'show' | 'only'
export type EmulationMode = 'native' | 'show' | 'only'

export interface SourceEntry {
  /** Client name, or the special value `untagged` for mods with no client tag. */
  name: string
  enabled: boolean
}

export const UNTAGGED = 'untagged'
/** Built-in client sources (always present, not removable). */
export const BUILTIN_SOURCES = ['DEG MODS', 'DEG MODS Network']
/** Fallback default excluded tags, used until the admin NIP-78 list loads. */
export const DEFAULT_EXCLUDED_TAGS = ['loli', 'shota', 'gore', 'politics', 'religion']

const DEFAULT_SOURCES: SourceEntry[] = [
  { name: 'DEG MODS', enabled: true },
  { name: 'DEG MODS Network', enabled: true },
  { name: UNTAGGED, enabled: false },
]

interface ModFiltersState {
  nsfwMode: NsfwMode
  sources: SourceEntry[]
  searchTags: string[]
  excludedTags: string[]
  /** True once the user has manually edited the excluded tags. While false, the
   *  list tracks the admin moderation defaults (NIP-78). */
  excludedTagsTouched: boolean
  repostMode: RepostMode
  emulationMode: EmulationMode
  /** Own PoW threshold for this listing (leading-zero bits). 0 = off. */
  minPow: number

  setNsfwMode: (m: NsfwMode) => void
  setRepostMode: (m: RepostMode) => void
  setEmulationMode: (m: EmulationMode) => void
  setSources: (s: SourceEntry[]) => void
  setSearchTags: (t: string[]) => void
  setExcludedTags: (t: string[]) => void
  setMinPow: (n: number) => void
  /** Apply moderation defaults, but only if the user hasn't customized. */
  applyExcludedTagsDefaults: (defaults: string[]) => void
}

export const useModFiltersStore = create<ModFiltersState>()(
  persist(
    (set, get) => ({
      nsfwMode: 'hide',
      sources: DEFAULT_SOURCES,
      searchTags: [],
      excludedTags: DEFAULT_EXCLUDED_TAGS,
      excludedTagsTouched: false,
      repostMode: 'show',
      emulationMode: 'show',
      minPow: 15,

      setNsfwMode: (nsfwMode) => set({ nsfwMode }),
      setRepostMode: (repostMode) => set({ repostMode }),
      setEmulationMode: (emulationMode) => set({ emulationMode }),
      setSources: (sources) => set({ sources }),
      setSearchTags: (searchTags) => set({ searchTags }),
      setExcludedTags: (excludedTags) => set({ excludedTags, excludedTagsTouched: true }),
      setMinPow: (minPow) => set({ minPow: Math.max(0, Math.floor(minPow)) }),
      applyExcludedTagsDefaults: (defaults) => {
        if (!get().excludedTagsTouched) set({ excludedTags: defaults })
      },
    }),
    { name: 'den-mods-filters' },
  ),
)

/**
 * User-added "open in" targets for a mod (a domain or domain+path). The
 * degmods.com option is built in and not stored here. Persisted locally.
 */
interface ModOpenTargetsState {
  targets: string[]
  addTarget: (raw: string) => void
  removeTarget: (t: string) => void
}

export const useModOpenTargetsStore = create<ModOpenTargetsState>()(
  persist(
    (set, get) => ({
      targets: [],
      addTarget: (raw) => {
        // Keep the user's string as-typed (domain, or domain+path) — buildOpenUrl
        // decides how to append the naddr. Trailing slash is meaningful, so preserve it.
        const norm = raw.trim()
        if (!norm || get().targets.some((t) => t.toLowerCase() === norm.toLowerCase())) return
        set({ targets: [...get().targets, norm] })
      },
      removeTarget: (t) => set({ targets: get().targets.filter((x) => x !== t) }),
    }),
    { name: 'den-mods-open-targets' },
  ),
)
