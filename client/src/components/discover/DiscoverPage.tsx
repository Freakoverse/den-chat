/**
 * DiscoverPage — Hub discovery (browse/search public hubs)
 *
 * Layout: Left sidebar nav (compact) + main content area with:
 *   - Hero banner ("Find Your Community")
 *   - Search bar (name / npub only)
 *   - Filter modal (NSFW toggle, min PoW slider, tag input)
 *   - Hub card grid (3 columns, 15 per page, numbered pagination)
 *
 * Fetches kind 36942 events with #f=on from general relays.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useHubStore, type HubData } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { MAX_HUB_LIST_ENTRIES } from '@/lib/hub/hubLimits'

import { truncateNpub, cn } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { UserPanel } from '@/components/ui/UserPanel'
import { ResizablePanel } from '@/components/ui/ResizablePanel'
import { HubInfoModal } from '@/components/hub/HubInfoModal'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { HubJoinWarningModal, isJoinWarningDismissed } from '@/components/hub/HubJoinWarningModal'
import { useBlockStore } from '@/stores/blockStore'
import { useWotStore } from '@/stores/wotStore'
import {
  Compass, Search, Loader2, Hash, Info, UserPlus, Check, AlertTriangle,
  X, ShieldAlert, SlidersHorizontal, ChevronLeft, ChevronRight, Plus,
  Gamepad2, Package, Globe, Monitor,
} from 'lucide-react'
import type { Event } from 'nostr-tools'
import { isTauri } from '@/lib/utils'
import { ModsTab } from '@/components/discover/ModsTab'

const PAGE_SIZE = 15

// ── Parsed hub from raw event ──
interface DiscoveredHub {
  event: Event
  dTag: string
  name: string
  description: string
  icon?: string
  banner?: string
  tags?: string[]
  minPow: number
  joinMinPow: number
  nsfw: boolean
  discoverable: boolean
  creatorPubkey: string
  generalRelays: string[]
  blossomServers: string[]
  /** Original publication time (from published_at tag) — used for display ordering */
  publishedAt: number
  /** Client tag (e.g. 'DEN Chat') — identifies which app created this hub */
  clientTag?: string
}

function parseHubEventForDiscover(event: Event): DiscoveredHub | null {
  try {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1]
    if (!dTag) return null

    const name = event.tags.find(t => t[0] === 'n')?.[1] || 'Unnamed Hub'
    const tags = event.tags.filter(t => t[0] === 't' && t[1]).map(t => t[1])
    const generalRelays = event.tags.filter(t => t[0] === 'r' && t[1]).map(t => t[1])
    const blossomServers = event.tags.filter(t => t[0] === 'o' && t[1]).map(t => t[1])
    const fTag = event.tags.find(t => t[0] === 'f')
    const discoverable = fTag ? fTag[1] !== 'off' : true
    const nsfw = event.tags.some(t => t[0] === 'content-warning')
    const isDeleted = event.tags.some(t => t[0] === 'deleted' && t[1] === 'true')

    // 1. Hide deleted hubs
    if (isDeleted) return null

    // Read PoW from w tag (source of truth), fallback to legacy JSON
    const wTagVal = event.tags.find(t => t[0] === 'w')?.[1]
    let minPow = wTagVal ? parseInt(wTagVal, 10) : 0

    // Join PoW from the W tag; falls back to message PoW when absent
    const wjTagVal = event.tags.find(t => t[0] === 'W')?.[1]

    let description = ''
    let icon: string | undefined
    let banner: string | undefined

    try {
      const content = JSON.parse(event.content)
      description = content.settings?.description || ''
      icon = content.settings?.icon
      banner = content.settings?.banner
      // Legacy fallback
      if (minPow === 0) minPow = content.settings?.min_pow || 0
    } catch { }

    // Extract published_at for display ordering (falls back to created_at)
    const publishedAtTag = event.tags.find(t => t[0] === 'published_at')?.[1]
    const publishedAt = publishedAtTag ? parseInt(publishedAtTag, 10) : event.created_at

    // Extract client tag
    const clientTag = event.tags.find(t => t[0] === 'client')?.[1]

    return {
      event, dTag, name, description, icon, banner,
      tags: tags.length > 0 ? tags : undefined,
      minPow, joinMinPow: wjTagVal ? parseInt(wjTagVal, 10) : minPow,
      nsfw, discoverable, creatorPubkey: event.pubkey,
      generalRelays, blossomServers, publishedAt, clientTag,
    }
  } catch {
    return null
  }
}

// ── Discover tab type ──
type DiscoverTab = 'hubs' | 'games' | 'mods' | 'sites'

// ── Left Sidebar Nav ──
function DiscoverNav({ activeTab, onTabChange }: { activeTab: DiscoverTab; onTabChange: (tab: DiscoverTab) => void }) {
  const tabs: { id: DiscoverTab; label: string; icon: React.ReactNode }[] = [
    { id: 'hubs', label: 'Hubs', icon: <Compass size={18} /> },
    { id: 'games', label: 'Games', icon: <Gamepad2 size={18} /> },
    { id: 'mods', label: 'Mods', icon: <Package size={18} /> },
    { id: 'sites', label: 'Sites', icon: <Globe size={18} /> },
  ]
  return (
    <nav className="flex flex-col gap-1 px-2 pt-4">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer',
            activeTab === tab.id
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
          )}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </nav>
  )
}

// ── Reusable PoW min/max range slider (with magnetic pairing) ──
function PowRangeSlider({
  label,
  description,
  min,
  max,
  setMin,
  setMax,
}: {
  label: string
  description?: string
  min: number
  max: number
  setMin: (v: number) => void
  setMax: (v: number) => void
}) {
  const MAX_POW_RANGE = 10

  const onMin = (val: number) => {
    setMin(val)
    // Enforce max gap of 10
    if (max - val > MAX_POW_RANGE) {
      setMax(val + MAX_POW_RANGE)
    }
    if (val > max) {
      setMax(val)
    }
  }

  const onMax = (val: number) => {
    setMax(val)
    // Enforce max gap of 10
    if (val - min > MAX_POW_RANGE) {
      setMin(val - MAX_POW_RANGE)
    }
    if (val < min) {
      setMin(val)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-foreground">{label}</label>
        <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">
          {min}{min !== max ? ` – ${max}` : ''}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        {description || `Show hubs with PoW between min and max (max range: ${MAX_POW_RANGE})`}
      </p>

      {/* Min slider */}
      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-muted-foreground">Min</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 relative h-6 flex items-center">
              <div className="absolute left-0 right-0 h-1.5 rounded-full bg-muted-foreground/20" />
              <div
                className="absolute left-0 h-1.5 rounded-full bg-primary transition-all"
                style={{ width: `${(min / 40) * 100}%` }}
              />
              <div
                className="absolute w-4 h-4 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
                style={{ left: `calc(${(min / 40) * 100}% - 8px)` }}
              />
              <input
                type="range"
                min={0}
                max={40}
                step={1}
                value={min}
                onChange={(e) => onMin(Number(e.target.value))}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>
            <div className="flex items-center h-7 rounded-md border border-border bg-background overflow-hidden">
              <button
                onClick={() => onMin(Math.max(0, min - 1))}
                className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
              >
                <ChevronLeft size={12} />
              </button>
              <span className="px-1.5 text-xs text-foreground tabular-nums min-w-[24px] text-center">
                {min}
              </span>
              <button
                onClick={() => onMin(Math.min(40, min + 1))}
                className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
              >
                <ChevronRight size={12} />
              </button>
            </div>
          </div>
        </div>

        {/* Max slider */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-muted-foreground">Max</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 relative h-6 flex items-center">
              <div className="absolute left-0 right-0 h-1.5 rounded-full bg-muted-foreground/20" />
              <div
                className="absolute left-0 h-1.5 rounded-full bg-primary transition-all"
                style={{ width: `${(max / 40) * 100}%` }}
              />
              <div
                className="absolute w-4 h-4 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
                style={{ left: `calc(${(max / 40) * 100}% - 8px)` }}
              />
              <input
                type="range"
                min={0}
                max={40}
                step={1}
                value={max}
                onChange={(e) => onMax(Number(e.target.value))}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>
            <div className="flex items-center h-7 rounded-md border border-border bg-background overflow-hidden">
              <button
                onClick={() => onMax(Math.max(0, max - 1))}
                className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
              >
                <ChevronLeft size={12} />
              </button>
              <span className="px-1.5 text-xs text-foreground tabular-nums min-w-[24px] text-center">
                {max}
              </span>
              <button
                onClick={() => onMax(Math.min(40, max + 1))}
                className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
              >
                <ChevronRight size={12} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-muted-foreground">0 (Any)</span>
        <span className="text-[10px] text-muted-foreground">40</span>
      </div>
    </div>
  )
}

// ── Filter Modal ──
interface FilterModalProps {
  open: boolean
  onClose: () => void
  showNsfw: boolean
  setShowNsfw: (v: boolean) => void
  powMin: number
  setPowMin: (v: number) => void
  powMax: number
  setPowMax: (v: number) => void
  joinPowMin: number
  setJoinPowMin: (v: number) => void
  joinPowMax: number
  setJoinPowMax: (v: number) => void
  filterTags: string[]
  setFilterTags: (v: string[]) => void
  filterClientTags: string[]
  setFilterClientTags: (v: string[]) => void
  onApplySearch?: () => void
}

function FilterModal({ open, onClose, showNsfw, setShowNsfw, powMin, setPowMin, powMax, setPowMax, joinPowMin, setJoinPowMin, joinPowMax, setJoinPowMax, filterTags, setFilterTags, filterClientTags, setFilterClientTags, onApplySearch }: FilterModalProps) {
  const [localNsfw, setLocalNsfw] = useState(showNsfw)
  const [localPowMin, setLocalPowMin] = useState(powMin)
  const [localPowMax, setLocalPowMax] = useState(powMax)
  const [localJoinPowMin, setLocalJoinPowMin] = useState(joinPowMin)
  const [localJoinPowMax, setLocalJoinPowMax] = useState(joinPowMax)
  const [localTags, setLocalTags] = useState<string[]>(filterTags)
  const [tagInput, setTagInput] = useState('')

  // Client tag filter state
  const DEFAULT_CLIENT_OPTIONS = ['DEN Chat']
  const [localClientTags, setLocalClientTags] = useState<string[]>(filterClientTags)
  const [clientTagOptions, setClientTagOptions] = useState<string[]>(DEFAULT_CLIENT_OPTIONS)
  const [clientTagInput, setClientTagInput] = useState('')

  // Sync on open
  useEffect(() => {
    if (open) {
      setLocalNsfw(showNsfw)
      setLocalPowMin(powMin)
      setLocalPowMax(powMax)
      setLocalJoinPowMin(joinPowMin)
      setLocalJoinPowMax(joinPowMax)
      setLocalTags([...filterTags])
      setTagInput('')
      setLocalClientTags([...filterClientTags])
      setClientTagInput('')
      // Rebuild options: defaults + any custom previously selected
      const combined = new Set([...DEFAULT_CLIENT_OPTIONS, ...filterClientTags])
      setClientTagOptions([...combined])
    }
  }, [open, showNsfw, powMin, powMax, joinPowMin, joinPowMax, filterTags, filterClientTags])

  if (!open) return null

  const addTag = (raw: string) => {
    const tag = raw.replace(/^#/, '').trim().toLowerCase()
    if (tag && !localTags.includes(tag)) {
      setLocalTags([...localTags, tag])
    }
    setTagInput('')
  }

  const removeTag = (tag: string) => {
    setLocalTags(localTags.filter(t => t !== tag))
  }

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(tagInput)
    } else if (e.key === 'Backspace' && !tagInput && localTags.length > 0) {
      setLocalTags(localTags.slice(0, -1))
    }
  }

  const handleApply = () => {
    setShowNsfw(localNsfw)
    setPowMin(localPowMin)
    setPowMax(localPowMax)
    setJoinPowMin(localJoinPowMin)
    setJoinPowMax(localJoinPowMax)
    setFilterTags(localTags)
    setFilterClientTags(localClientTags)
    onClose()
    // Trigger relay query with updated filters after a tick (so state has settled)
    if (onApplySearch) {
      setTimeout(onApplySearch, 50)
    }
  }

  const handleReset = () => {
    setLocalNsfw(false)
    setLocalPowMin(15)
    setLocalPowMax(25)
    setLocalJoinPowMin(15)
    setLocalJoinPowMax(25)
    setLocalTags([])
    setTagInput('')
    setLocalClientTags([])
    setClientTagInput('')
    setClientTagOptions([...DEFAULT_CLIENT_OPTIONS])
  }

  const hasChanges = localNsfw !== false || localPowMin !== 15 || localPowMax !== 25 || localTags.length > 0 || localClientTags.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative z-10 w-full max-w-md max-h-[85vh] flex flex-col rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={16} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Filters</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-6 overflow-y-auto flex-1 min-h-0">
          {/* NSFW toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-foreground">Show NSFW Hubs</label>
              <p className="text-xs text-muted-foreground mt-0.5">Include hubs marked as sensitive content</p>
            </div>
            <button
              onClick={() => setLocalNsfw(!localNsfw)}
              className={`relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0
                ${localNsfw ? 'bg-red-500' : 'bg-muted-foreground/30'}`}
            >
              <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform
                ${localNsfw ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
            </button>
          </div>

          {/* Message PoW range slider */}
          <PowRangeSlider
            label="PoW Difficulty Range"
            min={localPowMin}
            max={localPowMax}
            setMin={setLocalPowMin}
            setMax={setLocalPowMax}
          />

          {/* Join request PoW range slider */}
          <PowRangeSlider
            label="Join Request Difficulty"
            min={localJoinPowMin}
            max={localJoinPowMax}
            setMin={setLocalJoinPowMin}
            setMax={setLocalJoinPowMax}
          />

          {/* Multi-tag filter */}
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Filter by Tags</label>
            <p className="text-xs text-muted-foreground mb-2">Show only hubs matching these topic tags. Press Enter to add.</p>

            {/* Tag chips */}
            {localTags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mb-2">
                {localTags.map(tag => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-primary/10 border border-primary/20 text-primary"
                  >
                    #{tag}
                    <button
                      onClick={() => removeTag(tag)}
                      className="hover:text-destructive transition-colors cursor-pointer"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
              <Hash size={13} className="text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder={localTags.length > 0 ? 'Add another tag...' : 'e.g. gaming, music, nostr...'}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value.replace(/^#/, ''))}
                onKeyDown={handleTagKeyDown}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none rounded-sm p-1"
              />
              <button
                onClick={() => addTag(tagInput)}
                disabled={!tagInput.trim()}
                className="text-xs text-primary hover:text-primary/80 cursor-pointer font-medium disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
          </div>

          {/* Client tag filter */}
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Filter by Client</label>
            <p className="text-xs text-muted-foreground mb-2">Show only hubs created with specific clients. Click to select, or add a custom one.</p>

            {/* Option chips */}
            <div className="flex items-center gap-1.5 flex-wrap mb-2">
              {clientTagOptions.map(opt => {
                const isSelected = localClientTags.includes(opt)
                return (
                  <button
                    key={opt}
                    onClick={() => {
                      if (isSelected) {
                        setLocalClientTags(localClientTags.filter(t => t !== opt))
                      } else {
                        setLocalClientTags([...localClientTags, opt])
                      }
                    }}
                    className={cn(
                      'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border transition-colors cursor-pointer',
                      isSelected
                        ? 'bg-primary/15 border-primary/30 text-primary'
                        : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground hover:border-primary/20'
                    )}
                  >
                    {isSelected && <Check size={10} />}
                    {opt}
                    {/* Remove button for custom (non-default) options */}
                    {!DEFAULT_CLIENT_OPTIONS.includes(opt) && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation()
                          setClientTagOptions(clientTagOptions.filter(o => o !== opt))
                          setLocalClientTags(localClientTags.filter(t => t !== opt))
                        }}
                        className="ml-0.5 hover:text-destructive"
                      >
                        <X size={9} />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Add custom client */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Add custom client name..."
                value={clientTagInput}
                onChange={(e) => setClientTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const trimmed = clientTagInput.trim()
                    if (trimmed && !clientTagOptions.includes(trimmed)) {
                      setClientTagOptions([...clientTagOptions, trimmed])
                      setLocalClientTags([...localClientTags, trimmed])
                    }
                    setClientTagInput('')
                  }
                }}
                className="flex-1 h-7 rounded-md border border-input bg-background px-2 text-xs placeholder:text-muted-foreground focus:outline-none"
              />
              <button
                onClick={() => {
                  const trimmed = clientTagInput.trim()
                  if (trimmed && !clientTagOptions.includes(trimmed)) {
                    setClientTagOptions([...clientTagOptions, trimmed])
                    setLocalClientTags([...localClientTags, trimmed])
                  }
                  setClientTagInput('')
                }}
                disabled={!clientTagInput.trim()}
                className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Plus size={12} /> Add
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border">
          <button
            onClick={handleReset}
            disabled={!hasChanges}
            className="text-xs text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Reset to defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              className="px-4 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
            >
              Apply Filters
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Hub Discovery Card ──
function DiscoverHubCard({ hub }: { hub: DiscoveredHub }) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const hubEntries = useHubStore((s) => s.hubEntries)
  const setHubData = useHubStore((s) => s.setHubData)
  const setHubStatus = useHubStore((s) => s.setHubStatus)
  const setHubEntries = useHubStore((s) => s.setHubEntries)
  const folders = useHubStore((s) => s.folders)
  // Membership signals already resolved on load (useHubEventSubscription): holding the
  // hub secret means we decrypted it from the LKH tree → we're an actual member.
  const hubSecret = useHubStore((s) => s.hubSecrets[hub.dTag])
  const hubMembers = useHubStore((s) => s.hubMembers[hub.dTag])
  const { getProfile } = useProfileCache()

  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const [showInfoModal, setShowInfoModal] = useState(false)
  const [showCreatorProfile, setShowCreatorProfile] = useState(false)
  const [showJoinWarning, setShowJoinWarning] = useState(false)
  const [showHubLimitModal, setShowHubLimitModal] = useState(false)

  const isAlreadyInList = hubEntries.some(e => e.dTag === hub.dTag)
  // "Actually in the hub" — not merely listed: we hold the secret (decrypted from the
  // LKH tree) or our pubkey is a member leaf on our page of the tree.
  const isMember = !!hubSecret || (!!myPubkey && (hubMembers?.some(m => m.pubkey === myPubkey) ?? false))
  const creatorProfile = getProfile(hub.creatorPubkey)
  const creatorName = creatorProfile?.display_name || creatorProfile?.name || truncateNpub(nip19.npubEncode(hub.creatorPubkey), 10)

  const handleShowInfo = () => {
    setShowInfoModal(true)
  }

  const handleRequestJoin = async () => {
    if (!myPubkey || joining) return

    // Check hub list limit before joining
    if (!isAlreadyInList && hubEntries.length >= MAX_HUB_LIST_ENTRIES) {
      setShowHubLimitModal(true)
      return
    }

    // Show warning modal if not dismissed
    if (!isJoinWarningDismissed()) {
      setShowJoinWarning(true)
      return
    }

    doJoin()
  }

  const doJoin = async () => {
    if (!myPubkey || joining) return
    setJoining(true)
    setJoinError(null)
    try {
      const { createUnsignedEvent, signWithSigner, mineAndSign, createHubListEvent } = await import('@/lib/nostr')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
      const hubRelays = [...(hub.generalRelays || [])]

      let unsigned = createUnsignedEvent(KINDS.JOIN_REQUEST, '', [['d', hub.dTag]])
      const signed = await mineAndSign(unsigned, hub.joinMinPow, myPubkey, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(hubRelays), signed)

      if (!isAlreadyInList) {
        // Set hub data BEFORE updating entries — prevents the hub loader from
        // racing with the signer (which can drop the extension connection)
        const hubData: HubData = {
          dTag: hub.dTag, creatorPubkey: hub.creatorPubkey, name: hub.name, icon: hub.icon, banner: hub.banner,
          tags: hub.tags, description: hub.description, epoch: 1, generalRelays: hub.generalRelays,
          blossomServers: hub.blossomServers, indexFileHash: '', channels: [],
          categories: [], roles: [], minPow: hub.minPow, joinMinPow: hub.joinMinPow, nsfw: hub.nsfw, discoverable: hub.discoverable,
        }
        setHubData(hub.dTag, hubData)
        // Mark it loaded now — we already have the full hub definition from discovery.
        // Otherwise it has no status and renders as an endless pulsing skeleton in the
        // sidebar until a reload runs the hub loader.
        setHubStatus(hub.dTag, 'loaded')

        const relayHint = hub.generalRelays[0] || ''
        const newEntry = { dTag: hub.dTag, relayHint, position: hubEntries.length, folderId: undefined }
        const newEntries = [...hubEntries, newEntry]
        setHubEntries(newEntries, folders)

        const hubListEvent = createHubListEvent(
          newEntries.map(e => ({ dTag: e.dTag, relayHint: e.relayHint, position: e.position, folderId: e.folderId })),
          folders,
        )
        const signedList = await signWithSigner(hubListEvent, signer, privateKey)
        await publishToSpecificRelays(getPublishRelays(), signedList)
      }

      setJoined(true)
    } catch (err: any) {
      console.error('Failed to send join request:', err)
      setJoinError(err?.message || 'Failed to send request')
    } finally {
      setJoining(false)
    }
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden bg-card hover:border-primary/30 transition-all duration-200 group flex flex-col">
      {/* Banner */}
      <div className="relative h-28 overflow-hidden bg-gradient-to-br from-primary/20 via-primary/5 to-secondary">
        {hub.banner ? (
          <BannerImage src={hub.banner} alt={hub.name} />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-primary/15 via-transparent to-secondary/30" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />

        {/* Badges — 7. No bolt icon on PoW */}
        <div className="absolute top-2 right-2 flex items-center gap-1">
          {hub.nsfw && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500/80 text-white backdrop-blur-sm">NSFW</span>
          )}
          {hub.minPow > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500/80 text-white backdrop-blur-sm">
              PoW {hub.minPow}
            </span>
          )}
          {hub.joinMinPow > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500/80 text-white backdrop-blur-sm">
              Join PoW {hub.joinMinPow}
            </span>
          )}
        </div>
      </div>

      <div className="p-3.5 flex flex-col gap-2.5 flex-1">
        {/* Hub identity */}
        <div className="flex items-center gap-2.5 -mt-6 relative z-10">
          {hub.icon ? (
            <div className="w-11 h-11 rounded-xl overflow-hidden shrink-0 bg-secondary border-2 border-card shadow-lg">
              <IconImage src={hub.icon} name={hub.name} />
            </div>
          ) : (
            <div className="w-11 h-11 rounded-xl bg-primary/20 flex items-center justify-center shrink-0 border-2 border-card shadow-lg">
              <Hash size={16} className="text-primary" />
            </div>
          )}
          <div className="flex-1 min-w-0 pt-4">
            <h4 className="text-sm font-semibold text-foreground truncate">{hub.name}</h4>
            <p className="text-[10px] text-muted-foreground truncate">by {creatorName}</p>
          </div>
        </div>

        {/* Description */}
        {hub.description && (
          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{hub.description}</p>
        )}

        {/* Tags */}
        {hub.tags && hub.tags.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {hub.tags.slice(0, 3).map(tag => (
              <span key={tag} className="px-1.5 py-0.5 rounded-md text-[10px] bg-secondary border border-border text-muted-foreground">
                #{tag}
              </span>
            ))}
            {hub.tags.length > 3 && (
              <button
                onClick={() => setShowAllTags(true)}
                className="px-1.5 py-0.5 rounded-md text-[10px] bg-primary/10 text-primary cursor-pointer hover:bg-primary/20 transition-colors"
              >
                +{hub.tags.length - 3} more
              </button>
            )}
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleShowInfo}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium bg-secondary border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          >
            <Info size={12} /> Info
          </button>
          {isMember ? (
            <span className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              <Check size={12} /> Joined
            </span>
          ) : isAlreadyInList || joined ? (
            <span className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Check size={12} /> Request Sent
            </span>
          ) : (
            <button
              onClick={handleRequestJoin}
              disabled={joining}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
            >
              {joining ? (
                <><Loader2 size={12} className="animate-spin" /> {hub.joinMinPow > 0 ? 'Processing...' : 'Joining...'}</>
              ) : (
                <><UserPlus size={12} /> Request Join</>
              )}
            </button>
          )}
        </div>

        {joinError && (
          <p className="text-[10px] text-destructive flex items-center gap-1">
            <AlertTriangle size={10} /> {joinError}
          </p>
        )}
      </div>

      {/* All tags modal */}
      {showAllTags && hub.tags && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60"
          onClick={() => setShowAllTags(false)}
        >
          <div
            className="bg-background rounded-lg p-4 max-w-sm w-full max-h-[50vh] overflow-y-auto shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-foreground">Tags</h4>
              <button onClick={() => setShowAllTags(false)} className="cursor-pointer text-muted-foreground hover:text-foreground">
                <X size={14} />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {hub.tags.map(tag => (
                <span key={tag} className="px-2 py-1 rounded-md text-xs bg-secondary border border-border text-muted-foreground">
                  #{tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Hub info modal */}
      <HubInfoModal
        open={showInfoModal}
        onClose={() => setShowInfoModal(false)}
        hub={{
          dTag: hub.dTag, creatorPubkey: hub.creatorPubkey, name: hub.name, icon: hub.icon, banner: hub.banner,
          tags: hub.tags, description: hub.description, epoch: 1, generalRelays: hub.generalRelays,
          blossomServers: hub.blossomServers, indexFileHash: '', channels: [],
          categories: [], roles: [], minPow: hub.minPow, joinMinPow: hub.joinMinPow, nsfw: hub.nsfw, discoverable: hub.discoverable,
        }}
        blurMedia
        onCreatorClick={() => {
          setShowInfoModal(false)
          setShowCreatorProfile(true)
        }}
      />

      {/* Creator profile modal (for viewing / blocking) */}
      <UserProfileModal
        open={showCreatorProfile}
        onClose={() => setShowCreatorProfile(false)}
        targetPubkey={hub.creatorPubkey}
      />

      {/* Join warning modal */}
      <HubJoinWarningModal
        open={showJoinWarning}
        onClose={() => setShowJoinWarning(false)}
        onConfirm={doJoin}
      />

      {/* Hub limit reached modal */}
      {showHubLimitModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-2"
          onClick={() => setShowHubLimitModal(false)}
        >
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center">
                <AlertTriangle size={24} className="text-amber-500" />
              </div>
              <h3 className="text-base font-semibold text-foreground">Hub Limit Reached</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                You've reached the maximum of <span className="font-semibold text-foreground">{MAX_HUB_LIST_ENTRIES}</span> hubs
                in your hub list. Remove some hubs from <span className="font-medium text-foreground">Settings → My Hubs</span> before
                joining new ones.
              </p>
              <div className="flex items-center gap-2 w-full mt-1">
                <button
                  onClick={() => setShowHubLimitModal(false)}
                  className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Got it
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Blossom image helpers ──
function BannerImage({ src, alt }: { src: string; alt: string }) {
  const blossom = useBlossomMedia(src)
  if (blossom.loading) return <div className="w-full h-full bg-secondary animate-pulse" />
  if (blossom.error) return <div className="w-full h-full bg-gradient-to-br from-primary/15 via-transparent to-secondary/30" />
  return <img src={blossom.src || src} alt={alt} className="w-full h-full object-cover blur-lg" loading="lazy" />
}

function IconImage({ src, name }: { src: string; name: string }) {
  const blossom = useBlossomMedia(src)
  if (blossom.error || blossom.loading) {
    return (
      <div className="w-full h-full bg-primary/20 flex items-center justify-center text-xs font-semibold text-primary">
        {name.slice(0, 2).toUpperCase()}
      </div>
    )
  }
  return <img src={blossom.src || src} alt="" className="w-full h-full object-cover blur-sm" loading="lazy" />
}

// ── Main Page Component ──
export function DiscoverPage() {
  const [discoverTab, setDiscoverTab] = useState<DiscoverTab>('hubs')
  const [hubs, setHubs] = useState<DiscoveredHub[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [exhausted, setExhausted] = useState(false) // true when relays have no more results
  const loadingMoreRef = useRef(false)

  // Reactive block + WoT state for filtering
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)
  const wotSettings = useWotStore((s) => s.settings)
  const wotGraphDepth = useWotStore((s) => s.graphDepth)

  // Filter state (defaults: NSFW off, PoW 15-25, no tags)
  const [showNsfw, setShowNsfw] = useState(false)
  const [powMin, setPowMin] = useState(15)
  const [powMax, setPowMax] = useState(25)
  const [joinPowMin, setJoinPowMin] = useState(15)
  const [joinPowMax, setJoinPowMax] = useState(25)
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [filterClientTags, setFilterClientTags] = useState<string[]>([])
  const [showFilterModal, setShowFilterModal] = useState(false)

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)

  // Deduplicate and merge new events into existing hubs
  const mergeHubs = useCallback((existing: DiscoveredHub[], newEvents: Event[], skipDiscoverableCheck = false): DiscoveredHub[] => {
    const byDTag = new Map<string, DiscoveredHub>()

    // Seed with existing
    for (const h of existing) {
      byDTag.set(h.dTag, h)
    }

    // Merge new events (keep latest per d tag)
    for (const ev of newEvents) {
      const d = ev.tags.find(t => t[0] === 'd')?.[1]
      if (!d) continue
      const existingHub = byDTag.get(d)
      if (existingHub && ev.created_at <= existingHub.event.created_at) continue

      const h = parseHubEventForDiscover(ev)
      if (h && (skipDiscoverableCheck || h.discoverable)) {
        byDTag.set(d, h)
      }
    }

    const result = Array.from(byDTag.values())
    // Sort by published_at (original creation time) — not created_at which drifts with edits
    result.sort((a, b) => b.publishedAt - a.publishedAt)
    return result
  }, [])

  // Fetch a batch of hub events from relays
  const fetchBatch = useCallback(async (until?: number): Promise<Event[]> => {
    const baseFilter: any = {
      kinds: [KINDS.HUB_EVENT],
      limit: 100,
    }
    if (until) baseFilter.until = until

    // Fetch with #f=on and without (legacy)
    const [eventsF, eventsAll] = await Promise.all([
      fetchEvents({ ...baseFilter, '#f': ['on'] }),
      fetchEvents(baseFilter),
    ])

    // Deduplicate raw events by id
    const seen = new Set<string>()
    const combined: Event[] = []
    for (const e of [...eventsF, ...eventsAll]) {
      if (!seen.has(e.id)) {
        seen.add(e.id)
        combined.push(e)
      }
    }
    return combined
  }, [])

  // Initial load
  const loadHubs = useCallback(async () => {
    setLoading(true)
    setExhausted(false)
    try {
      const events = await fetchBatch()
      const parsed = mergeHubs([], events)
      setHubs(parsed)

      // If we got very few results, relays are likely exhausted
      if (events.length < 20) {
        setExhausted(true)
      }
    } catch (err) {
      console.error('Failed to load discoverable hubs:', err)
    } finally {
      setLoading(false)
    }
  }, [fetchBatch, mergeHubs])

  // Load next batch (triggered by pagination proximity)
  const loadMoreHubs = useCallback(async () => {
    if (loadingMoreRef.current || exhausted || hubs.length === 0) return
    loadingMoreRef.current = true
    setLoadingMore(true)

    try {
      const oldest = hubs[hubs.length - 1]
      const events = await fetchBatch(oldest.event.created_at)

      if (events.length === 0) {
        setExhausted(true)
      } else {
        const merged = mergeHubs(hubs, events)
        // If no new unique hubs were added, we're done
        if (merged.length === hubs.length) {
          setExhausted(true)
        } else {
          setHubs(merged)
        }
      }
    } catch (err) {
      console.error('Failed to load more hubs:', err)
    } finally {
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [hubs, exhausted, fetchBatch, mergeHubs])

  // Relay-side search (triggered by Enter / search button / filter apply)
  const searchRelays = useCallback(async () => {
    if (searching) return
    setSearching(true)

    try {
      const q = searchQuery.trim()
      const filter: any = {
        kinds: [KINDS.HUB_EVENT],
        limit: 100,
      }

      // Add tag filters to relay query
      if (filterTags.length > 0) {
        filter['#t'] = filterTags
      }

      // Add PoW range to relay query (#w with each value in range)
      if (powMin > 0 || powMax < 40) {
        const wValues: string[] = []
        for (let i = powMin; i <= powMax; i++) {
          wValues.push(i.toString())
        }
        filter['#w'] = wValues
      }

      let isDirectLookup = false

      if (q) {
        if (q.toLowerCase().startsWith('naddr1')) {
          // naddr → decode to author + d-tag for precise hub lookup
          isDirectLookup = true
          try {
            const decoded = nip19.decode(q.toLowerCase())
            if (decoded.type === 'naddr') {
              const addr = decoded.data as { kind: number; pubkey: string; identifier: string }
              filter.authors = [addr.pubkey]
              filter['#d'] = [addr.identifier]
            }
          } catch {
            // Invalid naddr — fall through to name search
            isDirectLookup = false
            filter['#n'] = [q]
          }
        } else if (q.toLowerCase().startsWith('npub1')) {
          // npub → targeted author query
          isDirectLookup = true
          try {
            const decoded = nip19.decode(q.toLowerCase())
            if (decoded.type === 'npub') {
              filter.authors = [decoded.data as string]
            }
          } catch {
            isDirectLookup = false
            // Invalid npub — just use filter tags
          }
        } else {
          // Name → try #n exact match
          filter['#n'] = [q]
        }
      }

      const events = await fetchEvents(filter)

      if (events.length > 0) {
        setHubs(prev => mergeHubs(prev, events, isDirectLookup))
      }
    } catch (err) {
      console.error('Relay search failed:', err)
    } finally {
      setSearching(false)
    }
  }, [searchQuery, searching, filterTags, powMin, powMax, mergeHubs])

  useEffect(() => {
    loadHubs()
  }, [loadHubs])

  // ── Deep link: auto-search when navigated here via denchat://hub/<naddr> ──
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { naddr: string } | undefined
      if (detail?.naddr) {
        setSearchQuery(detail.naddr)
        // Trigger search on next tick after state update
        setTimeout(() => {
          const searchBtn = document.querySelector<HTMLButtonElement>('[data-discover-search-btn]')
          searchBtn?.click()
        }, 100)
      }
    }
    window.addEventListener('deep-link-hub-search', handler)
    return () => window.removeEventListener('deep-link-hub-search', handler)
  }, [])

  // Filter hubs
  const filteredHubs = useMemo(() => {
    let result = hubs

    // Direct address lookup — bypass ALL filters
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      if (q.startsWith('naddr1')) {
        try {
          const decoded = nip19.decode(q)
          if (decoded.type === 'naddr') {
            const addr = decoded.data as { kind: number; pubkey: string; identifier: string }
            return hubs.filter(h => h.dTag === addr.identifier && h.creatorPubkey === addr.pubkey)
          }
        } catch {
          // Invalid naddr — fall through to normal filtering
        }
      } else if (q.startsWith('npub1')) {
        try {
          const decoded = nip19.decode(q)
          if (decoded.type === 'npub') {
            return hubs.filter(h => h.creatorPubkey === decoded.data)
          }
        } catch {
          // Invalid npub — fall through to normal filtering
        }
      }
    }

    // NSFW filter (default off)
    if (!showNsfw) {
      result = result.filter(h => !h.nsfw)
    }

    // Block filter — hide hubs from blocked users
    const blockedPubkeys = useBlockStore.getState().blockedPubkeys
    if (blockedPubkeys.size > 0) {
      result = result.filter(h => !blockedPubkeys.has(h.creatorPubkey))
    }

    // WoT filter — hide hubs from users below the WoT score threshold
    const wotState = useWotStore.getState()
    const { scoreThreshold } = wotState.settings
    result = result.filter(h => {
      const score = wotState.getScore(h.creatorPubkey)
      return score >= scoreThreshold
    })

    // PoW range filter
    if (powMin > 0 || powMax < 40) {
      result = result.filter(h => h.minPow >= powMin && h.minPow <= powMax)
    }

    // Join PoW range filter (client-side only — includes the message-PoW fallback
    // for hubs that carry no W tag, so a relay #W query would wrongly exclude them)
    if (joinPowMin > 0 || joinPowMax < 40) {
      result = result.filter(h => h.joinMinPow >= joinPowMin && h.joinMinPow <= joinPowMax)
    }

    // Tag filter (multi-tag — hub must match ALL specified tags)
    if (filterTags.length > 0) {
      result = result.filter(h =>
        filterTags.every(ft => h.tags?.some(t => t.toLowerCase() === ft))
      )
    }

    // Client tag filter (hub must match ANY selected client tag)
    if (filterClientTags.length > 0) {
      result = result.filter(h =>
        h.clientTag && filterClientTags.some(ct => ct.toLowerCase() === h.clientTag!.toLowerCase())
      )
    }

    // Search by name (text search — not an address)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      result = result.filter(h => h.name.toLowerCase().includes(q))
    }

    return result
  }, [hubs, showNsfw, powMin, powMax, joinPowMin, joinPowMax, filterTags, filterClientTags, searchQuery, blockedPubkeys, wotSettings, wotGraphDepth])

  // Numbered pagination
  const totalPages = Math.max(1, Math.ceil(filteredHubs.length / PAGE_SIZE))
  const pagedHubs = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE
    return filteredHubs.slice(start, start + PAGE_SIZE)
  }, [filteredHubs, currentPage])

  // Reset to page 1 on filter/search change
  useEffect(() => {
    setCurrentPage(1)
  }, [showNsfw, powMin, powMax, joinPowMin, joinPowMax, filterTags, filterClientTags, searchQuery])

  // Prefetch next batch when user is within 2 pages of the end
  useEffect(() => {
    if (exhausted || loading) return
    const pagesFromEnd = totalPages - currentPage
    if (pagesFromEnd <= 2 && hubs.length > 0) {
      loadMoreHubs()
    }
  }, [currentPage, totalPages, exhausted, loading, hubs.length, loadMoreHubs])

  // Active filter indicator count
  const activeFilterCount = (showNsfw ? 1 : 0) + ((powMin !== 15 || powMax !== 25) ? 1 : 0) + ((joinPowMin !== 15 || joinPowMax !== 25) ? 1 : 0) + (filterTags.length > 0 ? 1 : 0) + (filterClientTags.length > 0 ? 1 : 0)

  const LeftPanel = (
    <ResizablePanel id="discover" defaultWidth={280} minWidth={200} maxWidth={420} className="flex flex-col bg-background pr-2 py-2 gap-2 max-[1080px]:hidden">
      <div className="bg-secondary/50 rounded-md shadow-md flex-1 overflow-y-auto pb-2">
        <DiscoverNav activeTab={discoverTab} onTabChange={setDiscoverTab} />
      </div>
      <UserPanel />
    </ResizablePanel>
  )

  return (
    <>
      {LeftPanel}
      <div className="flex-1 flex flex-col min-w-0 bg-background relative">
        {/* Scrollable area */}
        {/* Mobile tab bar */}
        <div className="hidden max-[1080px]:flex items-center gap-1 px-2 py-2 border-b border-border bg-secondary/30 shrink-0">
          {(['hubs', 'games', 'mods', 'sites'] as DiscoverTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setDiscoverTab(tab)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                discoverTab === tab
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
              )}
            >
              {tab === 'hubs' && <Compass size={14} />}
              {tab === 'games' && <Gamepad2 size={14} />}
              {tab === 'mods' && <Package size={14} />}
              {tab === 'sites' && <Globe size={14} />}
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-hide pr-2 max-[1080px]:px-2">
          {/* Hero Banner */}
          {discoverTab === 'hubs' ? (
            <>
              <div className="max-w-6xl mx-auto w-full">
              <div className="relative overflow-hidden bg-secondary/50 rounded-md shadow-md mt-2">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent" />
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/10 via-transparent to-transparent" />

                <div className="relative z-10 px-8 max-[1080px]:px-4 pt-10 max-[1080px]:pt-6 pb-8 max-[1080px]:pb-5 max-w-4xl mx-auto">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-12 h-12 rounded-2xl bg-primary/15 flex items-center justify-center">
                      <Compass size={24} className="text-primary" />
                    </div>
                  </div>
                  <h1 className="text-2xl font-bold text-foreground tracking-tight mb-2">
                    Find Your Community
                  </h1>
                  <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
                    Explore hubs across the Nostr network. Find communities that match your interests and join them.
                  </p>
                </div>
              </div>

              {/* Search + Filters bar */}
              <div className="sticky top-0 z-20 bg-secondary/50 backdrop-blur-md rounded-md shadow-md mt-2 px-3 py-3">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0 px-3.5 py-2 rounded-xl bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
                    <Search size={15} className="text-muted-foreground shrink-0" />
                    <input
                      type="text"
                      placeholder="Search hubs by name or npub..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') searchRelays() }}
                      className="flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none rounded-sm p-1"
                    />
                    {searchQuery && (
                      <button onClick={() => setSearchQuery('')} className="text-muted-foreground hover:text-foreground cursor-pointer">
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <button
                    data-discover-search-btn
                    onClick={searchRelays}
                    disabled={!searchQuery.trim() || searching}
                    className="flex items-center gap-1.5 px-3 py-3.5 rounded-xl border text-xs font-medium transition-colors cursor-pointer shrink-0 bg-secondary/60 border-border text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                    <span className="max-[1080px]:hidden">Search</span>
                  </button>
                  <button
                    onClick={() => setShowFilterModal(true)}
                    className={`flex items-center gap-1.5 px-4 py-3.5 rounded-xl border text-xs font-medium transition-colors cursor-pointer shrink-0
                  ${activeFilterCount > 0
                        ? 'bg-primary/10 border-primary/30 text-primary'
                        : 'bg-secondary/60 border-border text-muted-foreground hover:text-foreground'
                      }`}
                  >
                    <SlidersHorizontal size={13} />
                    <span className="max-[1080px]:hidden">Filters</span>
                    {activeFilterCount > 0 && (
                      <span className="w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] flex items-center justify-center font-bold">
                        {activeFilterCount}
                      </span>
                    )}
                  </button>
                </div>
              </div>

              {/* Results */}
              <div className="py-5 max-[1080px]:pb-12">
                {/* Results header */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-foreground">
                      {searchQuery || filterTags.length > 0 || filterClientTags.length > 0 ? 'Search Results' : 'Explore Hubs'}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      ({filteredHubs.length} hub{filteredHubs.length !== 1 ? 's' : ''})
                    </span>
                  </div>

                  <button
                    onClick={loadHubs}
                    disabled={loading}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {loading ? <Loader2 size={12} className="animate-spin" /> : <Compass size={12} />}
                    Refresh
                  </button>
                </div>

                {/* Loading state */}
                {loading && hubs.length === 0 && (
                  <div className="flex items-center justify-center py-20 text-muted-foreground">
                    <Loader2 size={20} className="animate-spin mr-3" />
                    <span className="text-sm">Discovering hubs across relays...</span>
                  </div>
                )}

                {/* Empty state */}
                {!loading && filteredHubs.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-4">
                      <Search size={24} className="text-muted-foreground" />
                    </div>
                    <h3 className="text-sm font-medium text-foreground mb-1">No hubs found</h3>
                    <p className="text-xs text-muted-foreground max-w-xs break-all">
                      {searchQuery
                        ? `No hubs match "${searchQuery}". Try a different search or adjust filters.`
                        : 'No discoverable hubs match the current filters. Try adjusting your filter settings.'}
                    </p>
                  </div>
                )}

                {/* 6. Hub card grid — 3 columns */}
                {pagedHubs.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {pagedHubs.map(hub => (
                      <DiscoverHubCard key={hub.dTag} hub={hub} />
                    ))}
                  </div>
                )}

                {/* 6. Numbered pagination with arrows */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-1 pt-6 pb-2">
                    <button
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage <= 1}
                      className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                      <button
                        key={p}
                        onClick={() => setCurrentPage(p)}
                        className={`w-7 h-7 rounded text-xs font-medium transition-colors cursor-pointer ${p === currentPage
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                          }`}
                      >
                        {p}
                      </button>
                    ))}
                    <button
                      onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                      disabled={currentPage >= totalPages}
                      className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}

                {/* Loading more indicator */}
                {loadingMore && (
                  <div className="flex items-center justify-center py-3 text-muted-foreground">
                    <Loader2 size={12} className="animate-spin mr-2" />
                    <span className="text-[11px]">Fetching more hubs from relays...</span>
                  </div>
                )}
              </div>
              </div>
            </>
          ) : discoverTab === 'sites' ? (
            /* Coming Soon placeholder for Sites (in-client DNN browser) */
            <div className="flex-1 flex flex-col items-center justify-center py-32 text-center px-4">
              <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-5">
                <Globe size={28} className="text-muted-foreground" />
              </div>
              <h2 className="text-lg font-semibold text-foreground mb-2">Sites</h2>
              <p className="text-sm text-muted-foreground max-w-xs">
                A built-in browser for DNN sites — decentralized domains with their own self-verified certificates. Coming soon.
              </p>
              {!isTauri() && (
                <div className="mt-5 max-w-xs flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-left">
                  <Monitor size={16} className="text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-500/90 leading-relaxed">
                    This view will only be available in the installed desktop app.
                  </p>
                </div>
              )}
            </div>
          ) : discoverTab === 'mods' ? (
            <ModsTab />
          ) : (
            /* Coming Soon placeholder for Games */
            <div className="flex-1 flex flex-col items-center justify-center py-32 text-center px-4">
              <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-5">
                {discoverTab === 'games' ? <Gamepad2 size={28} className="text-muted-foreground" /> : <Package size={28} className="text-muted-foreground" />}
              </div>
              <h2 className="text-lg font-semibold text-foreground mb-2">
                {discoverTab === 'games' ? 'Games' : 'Mods'}
              </h2>
              <p className="text-sm text-muted-foreground max-w-xs">
                Coming soon. Stay tuned.
              </p>
              <a
                href={discoverTab === 'games' ? 'https://degastore.com/' : 'https://degmods.com/'}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-5 inline-flex items-center gap-2 px-5 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
              >
                {discoverTab === 'games' ? 'Learn more' : 'Learn more'}
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Filter Modal */}
      <FilterModal
        open={showFilterModal}
        onClose={() => setShowFilterModal(false)}
        showNsfw={showNsfw}
        setShowNsfw={setShowNsfw}
        powMin={powMin}
        setPowMin={setPowMin}
        powMax={powMax}
        setPowMax={setPowMax}
        joinPowMin={joinPowMin}
        setJoinPowMin={setJoinPowMin}
        joinPowMax={joinPowMax}
        setJoinPowMax={setJoinPowMax}
        filterTags={filterTags}
        setFilterTags={setFilterTags}
        filterClientTags={filterClientTags}
        setFilterClientTags={setFilterClientTags}
        onApplySearch={searchRelays}
      />
    </>
  )
}
