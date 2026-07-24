/**
 * Apply the Mods-listing filters (NSFW, PoW, sources, tags, excluded tags,
 * reposts, emulation). Ported from DEG MODS' applyModFilters, minus legacy mods.
 */

import { UNTAGGED, type NsfwMode, type RepostMode, type EmulationMode, type SourceEntry } from '@/stores/modFiltersStore'
import type { Mod } from '@/lib/mods/modEvent'

export interface ModFilterState {
  nsfwMode: NsfwMode
  minPow: number
  sources: SourceEntry[]
  searchTags: string[]
  excludedTags: string[]
  repostMode: RepostMode
  emulationMode: EmulationMode
}

export function applyModFilters(mods: Mod[], f: ModFilterState): Mod[] {
  let result = mods

  if (f.nsfwMode === 'hide') result = result.filter((m) => !m.contentWarning)
  else if (f.nsfwMode === 'only') result = result.filter((m) => !!m.contentWarning)

  if (f.repostMode === 'originals') result = result.filter((m) => !m.isRepost)
  else if (f.repostMode === 'only') result = result.filter((m) => m.isRepost)

  if (f.emulationMode === 'native') result = result.filter((m) => !m.emulation)
  else if (f.emulationMode === 'only') result = result.filter((m) => m.emulation)

  if (f.minPow > 0) result = result.filter((m) => m.pow >= f.minPow)

  // A mod is removed only if its client (or `untagged` for no client) is an
  // explicitly-disabled source; unknown clients pass through.
  const disabledSources = new Set(f.sources.filter((s) => !s.enabled).map((s) => s.name.toLowerCase()))
  if (disabledSources.size > 0) {
    result = result.filter((m) => !disabledSources.has((m.client || UNTAGGED).toLowerCase()))
  }

  if (f.searchTags.length > 0) {
    const wanted = f.searchTags.map((t) => t.toLowerCase())
    result = result.filter((m) => m.tags.some((t) => wanted.includes(t.toLowerCase())))
  }

  if (f.excludedTags.length > 0) {
    const banned = new Set(f.excludedTags.map((t) => t.toLowerCase()))
    result = result.filter((m) => !m.tags.some((t) => banned.has(t.toLowerCase())))
  }

  return result
}
