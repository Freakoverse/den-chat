/**
 * GifPickerPopover — 4-tab GIF picker (Discover / Mine / Others / Favorites)
 *
 * Portal-based, positioned relative to an anchor button ref.
 * Discover tab: search GIF collections from the network
 * Mine tab: user's own GIF collections + upload/create
 * Others tab: subscribed GIF collections from other users
 * Favorites tab: individually starred GIFs
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Compass, Sparkles, Star, StarOff, Plus, Trash2, Loader2, Upload,
  Search, X, FolderPlus, Image, Check, Users, ImagePlay, Eye, EyeOff, ShieldQuestion,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  useGifStore,
  getGifUploadLimitBytes,
  hasOversizedGif,
  isGifSizeOk,
  type GifEntry,
  type GifCollection,
} from '@/stores/gifStore'
import {
  publishGifCollection,
  publishGifSubscriptions,
  publishGifFavorites,
  discoverGifCollections,
  searchGifCollections,
  searchGifCollectionsByDTag,
  fetchGifCollectionByAddress,
  deleteGifCollection,
} from '@/lib/nostr/customGif'
import { uploadToBlossomServers, computeHash } from '@/lib/blossom'
import { getUploadBlossoms } from '@/stores/postingBehaviourStore'
import { useUserStore } from '@/stores/userStore'
import { useBlockStore } from '@/stores/blockStore'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { useProfileCache } from '@/hooks/useProfileCache'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const PICKER_WIDTH = 380
const PICKER_HEIGHT = 440
const GAP = 8

type Tab = 'discover' | 'mine' | 'others' | 'favorites'

interface Props {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onSelect: (gif: { name: string; url: string; nsfw: boolean }) => void
}

export function GifPickerPopover({ anchorRef, onClose, onSelect }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [tab, setTab] = useState<Tab>('discover')
  const containerRef = useRef<HTMLDivElement>(null)

  const computePosition = useCallback(() => {
    if (!anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth

    const spaceAbove = rect.top
    const spaceBelow = vh - rect.bottom
    let top: number
    if (spaceAbove >= PICKER_HEIGHT + GAP) {
      top = rect.top - PICKER_HEIGHT - GAP
    } else if (spaceBelow >= PICKER_HEIGHT + GAP) {
      top = rect.bottom + GAP
    } else {
      top = spaceAbove > spaceBelow
        ? Math.max(GAP, rect.top - PICKER_HEIGHT - GAP)
        : rect.bottom + GAP
    }

    let left = rect.right - PICKER_WIDTH
    if (left < GAP) left = rect.left
    if (left + PICKER_WIDTH > vw - GAP) left = vw - PICKER_WIDTH - GAP
    left = Math.max(GAP, left)

    setPos({ top, left })
  }, [anchorRef])

  useEffect(() => {
    computePosition()
    window.addEventListener('resize', computePosition)
    return () => window.removeEventListener('resize', computePosition)
  }, [computePosition])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Exclude the trigger button so toggle works correctly
      if (anchorRef.current?.contains(e.target as Node)) return
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement
        if (target.closest('[data-gif-picker]') || target.closest('[data-gif-picker-portal]')) return
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  const tabItems: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'discover', label: 'Discover', icon: <Compass size={14} /> },
    { id: 'mine', label: 'Mine', icon: <Sparkles size={14} /> },
    { id: 'others', label: 'Others', icon: <Users size={14} /> },
    { id: 'favorites', label: 'Favorites', icon: <Star size={14} /> },
  ]

  return createPortal(
    <div
      ref={containerRef}
      data-gif-picker-portal
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-[300]"
      style={{ top: pos.top, left: pos.left, width: PICKER_WIDTH, height: PICKER_HEIGHT }}
    >
      <div className="w-full h-full flex flex-col rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        {/* Tab bar */}
        <div className="flex border-b border-border shrink-0">
          {tabItems.map((t) => (
            <button
              key={t.id}
              onClick={(e) => { e.stopPropagation(); setTab(t.id) }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors cursor-pointer
                ${tab === t.id
                  ? 'text-primary border-b-2 border-primary bg-primary/5'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
                }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* NSFW toggle */}
        <NsfwToggle />

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'discover' && <DiscoverGifTab onSelect={onSelect} />}
          {tab === 'mine' && <MineGifTab onSelect={onSelect} />}
          {tab === 'others' && <OthersGifTab onSelect={onSelect} />}
          {tab === 'favorites' && <FavoritesGifTab onSelect={onSelect} />}
        </div>
      </div>
    </div>,
    document.body
  )
}

/* ═══════════ NSFW Toggle Bar ═══════════ */

function NsfwToggle() {
  const nsfwEnabled = useGifStore((s) => s.nsfwEnabled)
  const setNsfwEnabled = useGifStore((s) => s.setNsfwEnabled)
  const untaggedAsNsfw = useGifStore((s) => s.untaggedAsNsfw)
  const setUntaggedAsNsfw = useGifStore((s) => s.setUntaggedAsNsfw)

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-secondary/10">
      <span className="text-[10px] text-muted-foreground">Include NSFW</span>
      <div className="flex items-center gap-2">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setUntaggedAsNsfw(!untaggedAsNsfw)}
                className={`p-1 rounded transition-colors cursor-pointer ${untaggedAsNsfw
                  ? 'text-yellow-400 bg-yellow-500/15'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                <ShieldQuestion size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs z-[310] max-w-[200px]">
              {untaggedAsNsfw
                ? 'Untagged content is treated as NSFW — items without an explicit SFW/NSFW tag are hidden'
                : 'Untagged content is treated as safe — items without a tag are shown normally'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <button
          onClick={() => setNsfwEnabled(!nsfwEnabled)}
          className={`w-8 h-4 rounded-full relative transition-colors cursor-pointer ${nsfwEnabled ? 'bg-red-500/70' : 'bg-muted-foreground/30'}`}
        >
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${nsfwEnabled ? 'left-4.5' : 'left-0.5'}`} />
        </button>
      </div>
    </div>
  )
}

/** Filter GIF entries based on NSFW + untagged settings */
function filterNsfwGifs(gifs: GifEntry[]): GifEntry[] {
  const { nsfwEnabled, untaggedAsNsfw } = useGifStore.getState()
  if (nsfwEnabled) return gifs // Show everything when NSFW is enabled
  return gifs.filter((g) => {
    if (g.nsfw) return false // Always hide explicitly NSFW
    if (!g.tagged && untaggedAsNsfw) return false // Hide untagged when shield is on
    return true
  })
}

/* ═══════════ Discover Tab ═══════════ */

function DiscoverGifTab({ onSelect }: { onSelect: (g: { name: string; url: string; nsfw: boolean }) => void }) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const nsfwEnabled = useGifStore((s) => s.nsfwEnabled)
  const favorites = useGifStore((s) => s.favorites)
  const subscriptionAddresses = useGifStore((s) => s.subscriptionAddresses)

  const [loading, setLoading] = useState(true)
  const [discovered, setDiscovered] = useState<GifCollection[]>([])
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<GifCollection[]>([])
  const [searching, setSearching] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [togglingFav, setTogglingFav] = useState<string | null>(null)
  const [publishingAddr, setPublishingAddr] = useState<string | null>(null)
  const [viewingCollection, setViewingCollection] = useState<GifCollection | null>(null)
  const [searchMode, setSearchMode] = useState<'g' | 'd'>('g')
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null)
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)
  const { getProfile } = useProfileCache()

  useEffect(() => {
    setLoading(true)
    discoverGifCollections(100)
      .then((collections) => {
        setDiscovered(collections)
      })
      .finally(() => setLoading(false))
  }, [myPubkey])

  // Debounced relay search — queries #g or #d tags when user types
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!search.trim()) {
      setSearchResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = searchMode === 'g'
          ? await searchGifCollections(search.trim())
          : await searchGifCollectionsByDTag(search.trim())
        setSearchResults(results)
      } catch (err) {
        console.error('GIF relay search failed:', err)
      } finally {
        setSearching(false)
      }
    }, 400)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [search, myPubkey, searchMode])

  // Flatten all GIFs from discovered + relay search results
  const allGifs = useMemo(() => {
    // Merge discovered collections with relay search results (deduplicate)
    const merged = [...discovered]
    for (const sr of searchResults) {
      if (!merged.some((c) => c.pubkey === sr.pubkey && c.dTag === sr.dTag)) {
        merged.push(sr)
      }
    }
    const result: { gif: GifEntry; collection: GifCollection; addr: string }[] = []
    for (const c of merged) {
      if (blockedPubkeys.has(c.pubkey)) continue
      const addr = `30030:${c.pubkey}:${c.dTag}`
      for (const g of c.gifs) {
        if (!nsfwEnabled && g.nsfw) continue
        result.push({ gif: g, collection: c, addr })
      }
    }
    return result
  }, [discovered, searchResults, nsfwEnabled, blockedPubkeys])

  const filtered = useMemo(() => {
    if (!search) return allGifs
    const q = search.toLowerCase()
    return allGifs.filter((item) => item.gif.name.toLowerCase().includes(q))
  }, [allGifs, search])

  // For d-mode: collections view
  const filteredCollections = useMemo(() => {
    if (searchMode !== 'd') return []
    const merged = [...discovered].filter((c) => !blockedPubkeys.has(c.pubkey))
    for (const sr of searchResults) {
      if (blockedPubkeys.has(sr.pubkey)) continue
      if (!merged.some((c) => c.pubkey === sr.pubkey && c.dTag === sr.dTag)) {
        merged.push(sr)
      }
    }
    if (!search) return merged
    const q = search.toLowerCase()
    return merged.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.dTag.toLowerCase().includes(q)
    )
  }, [discovered, searchResults, search, searchMode, blockedPubkeys])

  const isFavorited = useCallback((url: string) => favorites.some((f) => f.url === url), [favorites])

  const toggleFavorite = async (gif: GifEntry) => {
    setTogglingFav(gif.url)
    try {
      const current = useGifStore.getState().favorites
      const exists = current.some((f) => f.url === gif.url)
      const updated = exists
        ? current.filter((f) => f.url !== gif.url)
        : [...current, gif]
      await publishGifFavorites(updated, signer, privateKey)
      useGifStore.getState().setFavorites(updated)
    } catch (err) {
      console.error('Failed to toggle favorite:', err)
    } finally {
      setTogglingFav(null)
    }
  }

  const handleSubscribe = async (collection: GifCollection) => {
    const addr = `30030:${collection.pubkey}:${collection.dTag}`
    if (subscriptionAddresses.includes(addr)) return
    setPublishingAddr(addr)
    try {
      const updated = [...subscriptionAddresses, addr]
      await publishGifSubscriptions(updated, signer, privateKey)
      useGifStore.getState().addSubscription(addr, collection)
    } catch (err) {
      console.error('Failed to subscribe:', err)
    } finally {
      setPublishingAddr(null)
    }
  }

  return (
    <>
      <div className="h-full flex flex-col">
        {/* Search + mode toggle */}
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
          <div className="flex-1 relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchMode === 'g' ? 'Search GIFs...' : 'Search sets...'}
              className="w-full h-7 pl-7 pr-2 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
              autoFocus
            />
          </div>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => { setSearchMode(searchMode === 'g' ? 'd' : 'g'); setSearchResults([]) }}
                  className={`px-1.5 py-1 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${searchMode === 'd'
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    }`}
                >
                  {searchMode === 'g' ? 'GIFs' : 'Sets'}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs z-[310]">
                {searchMode === 'g' ? 'Switch to set search' : 'Switch to GIF search'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">

          {searching && (
            <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
              <Loader2 size={10} className="animate-spin" />
              Searching relays...
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : searchMode === 'g' ? (
            /* ── g-mode: flat GIF grid ── */
            filtered.length === 0 ? (
              <div className="text-center py-6 text-xs text-muted-foreground">
                <ImagePlay size={24} className="mx-auto mb-2 opacity-40" />
                <p>{search ? 'No GIFs found' : 'No GIFs discovered yet'}</p>
                <p className="opacity-60 mt-1">Try again later as more users publish GIFs.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <TooltipProvider delayDuration={200}>
                  <div className="grid grid-cols-3 gap-1.5">
                    {filtered.map((item, i) => {
                      const fav = isFavorited(item.gif.url)
                      const toggling = togglingFav === item.gif.url
                      return (
                        <Tooltip key={`${item.gif.url}-${i}`}>
                          <TooltipTrigger asChild>
                            <div className="relative group">
                              <button
                                onClick={() => onSelect(item.gif)}
                                className="w-full aspect-square rounded-lg border border-border/30 overflow-hidden hover:border-primary/40 hover:ring-1 hover:ring-primary/20 transition-all cursor-pointer bg-secondary/20"
                              >
                                <img
                                  src={item.gif.url}
                                  alt={item.gif.name}
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleFavorite(item.gif) }}
                                disabled={toggling}
                                className={`absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center transition-all cursor-pointer
                              ${fav
                                    ? 'bg-yellow-500/90 text-white'
                                    : 'bg-black/50 text-white/70 opacity-0 group-hover:opacity-100'
                                  }`}
                              >
                                {toggling ? <Loader2 size={10} className="animate-spin" /> : <Star size={10} fill={fav ? 'currentColor' : 'none'} />}
                              </button>
                              {item.collection.pubkey !== myPubkey && !subscriptionAddresses.includes(item.addr) && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setViewingCollection(item.collection) }}
                                  className="absolute bottom-2 right-1 px-1.5 py-0.5 rounded text-[8px] bg-primary/80 text-primary-foreground opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                >
                                  View Set
                                </button>
                              )}
                              {item.gif.nsfw && (
                                <span className="absolute top-1.5 left-1.5 px-1 py-0.5 rounded text-[8px] bg-red-500/80 text-white font-bold">NSFW</span>
                              )}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs z-[310]">
                            {item.gif.name || 'Unnamed GIF'}
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                </TooltipProvider>
              </div>
            )
          ) : (
            /* ── d-mode: collection cards ── */
            filteredCollections.length === 0 ? (
              <div className="text-center py-6 text-xs text-muted-foreground">
                <ImagePlay size={24} className="mx-auto mb-2 opacity-40" />
                <p>{search ? 'No sets found' : 'No sets discovered yet'}</p>
                <p className="opacity-60 mt-1">Try again later as more users publish GIFs.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredCollections.map((collection) => {
                  const addr = `30030:${collection.pubkey}:${collection.dTag}`
                  const isSubscribed = subscriptionAddresses.includes(addr)
                  const isMine = collection.pubkey === myPubkey
                  const profile = getProfile(collection.pubkey)
                  const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(collection.pubkey))
                  const visibleGifs = filterNsfwGifs(collection.gifs)
                  return (
                    <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-2.5">
                      <div className="flex items-center justify-between mb-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-foreground truncate">{collection.name}</p>
                          <p className="text-[10px] text-muted-foreground">by <button onClick={() => setProfilePubkey(collection.pubkey)} className="text-primary hover:underline cursor-pointer">{authorName}</button> · {collection.gifs.length} GIF{collection.gifs.length !== 1 ? 's' : ''}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => setViewingCollection(collection)}
                            className="px-2 py-1 rounded text-[10px] font-medium bg-muted/50 text-foreground hover:bg-muted transition-colors cursor-pointer"
                          >
                            View
                          </button>
                          {!isMine && !isSubscribed && (
                            <button
                              onClick={() => handleSubscribe(collection)}
                              disabled={publishingAddr === addr}
                              className="px-2 py-1 rounded text-[10px] font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
                            >
                              {publishingAddr === addr ? '...' : '+Sub'}
                            </button>
                          )}
                          {isSubscribed && (
                            <span className="flex items-center gap-0.5 text-[10px] text-primary font-medium">
                              <Check size={10} /> Sub'd
                            </span>
                          )}
                        </div>
                      </div>
                      {/* Preview grid */}
                      <div className="flex flex-wrap gap-1">
                        {visibleGifs.slice(0, 6).map((gif, i) => (
                          <button
                            key={`${gif.url}-${i}`}
                            onClick={() => onSelect(gif)}
                            className="w-12 h-12 rounded border border-border/30 overflow-hidden hover:border-primary/40 transition-colors cursor-pointer"
                          >
                            <img src={gif.url} alt={gif.name} className="w-full h-full object-cover" loading="lazy" />
                          </button>
                        ))}
                        {visibleGifs.length > 6 && (
                          <div className="w-12 h-12 rounded border border-border/30 flex items-center justify-center text-[10px] text-muted-foreground">
                            +{visibleGifs.length - 6}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          )}
        </div>
      </div>

      {/* Collection preview modal */}
      {viewingCollection && createPortal(
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[320]" onClick={() => setViewingCollection(null)}>
          <div className="bg-card border border-border rounded-xl max-w-sm w-full mx-4 shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/30">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{viewingCollection.name}</p>
                <p className="text-[10px] text-muted-foreground">
                  by <button onClick={() => setProfilePubkey(viewingCollection.pubkey)} className="text-primary hover:underline cursor-pointer">{(() => {
                    const profile = getProfile(viewingCollection.pubkey)
                    return profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(viewingCollection.pubkey))
                  })()}</button> · {viewingCollection.gifs.length} GIF{viewingCollection.gifs.length !== 1 ? 's' : ''}
                </p>
              </div>
              <button onClick={() => setViewingCollection(null)} className="p-1 rounded hover:bg-accent/50 transition-colors cursor-pointer">
                <X size={16} className="text-muted-foreground" />
              </button>
            </div>
            {/* GIF grid */}
            <div className="p-3 max-h-[50vh] overflow-y-auto">
              <div className="grid grid-cols-3 gap-1.5">
                {filterNsfwGifs(viewingCollection.gifs).map((gif, i) => (
                  <div key={`${gif.url}-${i}`} className="relative group">
                    <button
                      onClick={() => { onSelect(gif); setViewingCollection(null) }}
                      className="w-full aspect-square rounded-lg border border-border/30 overflow-hidden hover:border-primary/40 hover:ring-1 hover:ring-primary/20 transition-all cursor-pointer bg-secondary/20"
                    >
                      <img
                        src={gif.url}
                        alt={gif.name}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                    {gif.nsfw && (
                      <span className="absolute top-1 left-1 px-1 py-0.5 rounded text-[8px] bg-red-500/80 text-white font-bold">NSFW</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {/* Subscribe button */}
            {(() => {
              const addr = `30030:${viewingCollection.pubkey}:${viewingCollection.dTag}`
              const isSubscribed = subscriptionAddresses.includes(addr)
              return (
                <div className="px-4 py-3 border-t border-border bg-secondary/20">
                  {isSubscribed ? (
                    <span className="flex items-center justify-center gap-1.5 text-xs text-primary font-medium">
                      <Check size={12} /> Subscribed
                    </span>
                  ) : (
                    <button
                      onClick={() => { handleSubscribe(viewingCollection); setViewingCollection(null) }}
                      disabled={publishingAddr === addr}
                      className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary-hover transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      {publishingAddr === addr ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                      Subscribe to this set
                    </button>
                  )}
                </div>
              )
            })()}
          </div>
        </div>,
        document.body
      )}

      {profilePubkey && createPortal(
        <UserProfileModal
          open={!!profilePubkey}
          onClose={() => setProfilePubkey(null)}
          targetPubkey={profilePubkey}
        />,
        document.body
      )}
    </>
  )
}

/* ═══════════ Mine Tab ═══════════ */

function MineGifTab({ onSelect }: { onSelect: (g: { name: string; url: string; nsfw: boolean }) => void }) {
  const myCollections = useGifStore((s) => s.myGifCollections)
  const nsfwEnabled = useGifStore((s) => s.nsfwEnabled)
  const untaggedAsNsfw = useGifStore((s) => s.untaggedAsNsfw)
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [showCreateInput, setShowCreateInput] = useState(false)
  const [newCollectionName, setNewCollectionName] = useState('')
  const [creating, setCreating] = useState(false)
  const [expandedCollection, setExpandedCollection] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showAddGif, setShowAddGif] = useState(false)

  // Flatten all GIFs for search
  const allGifs = useMemo(() => {
    return myCollections.flatMap((c) => {
      const addr = `30030:${c.pubkey}:${c.dTag}`
      return filterNsfwGifs(c.gifs)
        .map((g) => ({ ...g, setName: c.name, setDTag: c.dTag, setAddress: addr }))
    })
  }, [myCollections, nsfwEnabled, untaggedAsNsfw])

  const filtered = search
    ? allGifs.filter((g) =>
      g.name.toLowerCase().includes(search.toLowerCase()) ||
      g.setName.toLowerCase().includes(search.toLowerCase())
    )
    : allGifs

  const createCollection = async () => {
    if (!newCollectionName.trim() || !pubkey) return
    const dTag = newCollectionName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    setCreating(true)
    try {
      await publishGifCollection(dTag, [], signer, privateKey)
      useGifStore.getState().addMyGifCollection({
        pubkey,
        dTag,
        name: dTag.replace(/[-_]/g, ' '),
        gifs: [],
      })
      setNewCollectionName('')
      setShowCreateInput(false)
      setExpandedCollection(dTag)
    } catch (err) {
      console.error('Failed to create GIF collection:', err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Search + actions bar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
        <div className="flex-1 relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search my GIFs..."
            className="w-full h-7 pl-7 pr-2 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => { setShowCreateInput(!showCreateInput); if (!showCreateInput) setShowAddGif(false) }}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
              >
                <FolderPlus size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs z-[310]">New Collection</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  const next = !showAddGif
                  setShowAddGif(next)
                  if (next) {
                    setShowCreateInput(false)
                    if (myCollections.length > 0 && !expandedCollection) setExpandedCollection(myCollections[0].dTag)
                  }
                }}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
              >
                <Plus size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs z-[310]">Add GIF</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Create collection form */}
      {showCreateInput && (
        <div className="px-2 py-2 border-b border-border bg-muted/20">
          <p className="text-[10px] text-muted-foreground mb-1.5">Create a new GIF collection</p>
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createCollection(); if (e.key === 'Escape') setShowCreateInput(false) }}
              placeholder="Collection name..."
              className="flex-1 h-7 px-2 rounded-md text-xs bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button
              onClick={createCollection}
              disabled={!newCollectionName.trim() || creating}
              className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* GIF grid */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {myCollections.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <ImagePlay size={24} className="opacity-40" />
            <p className="text-xs text-center">No GIF collections yet.<br />Create one to get started!</p>
            <button
              onClick={() => setShowCreateInput(true)}
              className="mt-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer"
            >
              Create Collection
            </button>
          </div>
        ) : search ? (
          filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-muted-foreground">No GIFs matching "{search}"</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              <TooltipProvider delayDuration={200}>
                {filtered.map((g, i) => (
                  <Tooltip key={`${g.setDTag}-${g.url}-${i}`}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onSelect(g)}
                        className="w-full aspect-square rounded-lg border border-border/30 overflow-hidden hover:border-primary/40 hover:ring-1 hover:ring-primary/20 transition-all cursor-pointer bg-secondary/20"
                      >
                        <img src={g.url} alt={g.name} className="w-full h-full object-cover" loading="lazy" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs z-[310]">{g.name || 'Unnamed'} ({g.setName})</TooltipContent>
                  </Tooltip>
                ))}
              </TooltipProvider>
            </div>
          )
        ) : (
          myCollections.map((col) => (
            <GifCollectionCard
              key={`${col.pubkey}:${col.dTag}`}
              collection={col}
              isMine
              expanded={expandedCollection === col.dTag || showAddGif}
              onToggle={() => setExpandedCollection(expandedCollection === col.dTag ? null : col.dTag)}
              onSelect={(g) => onSelect(g)}
              nsfwEnabled={nsfwEnabled}
            />
          ))
        )}
      </div>
    </div>
  )
}

/* ═══════════ Others Tab ═══════════ */

function OthersGifTab({ onSelect }: { onSelect: (g: { name: string; url: string; nsfw: boolean }) => void }) {
  const subscribedCollections = useGifStore((s) => s.subscribedCollections)
  const subscriptionAddresses = useGifStore((s) => s.subscriptionAddresses)
  const nsfwEnabled = useGifStore((s) => s.nsfwEnabled)
  const untaggedAsNsfw = useGifStore((s) => s.untaggedAsNsfw)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const [search, setSearch] = useState('')
  const [searchMode, setSearchMode] = useState<'items' | 'sets'>('items')
  const [unsubscribing, setUnsubscribing] = useState<string | null>(null)
  const { getProfile } = useProfileCache()
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null)
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)

  const visibleCollections = useMemo(() =>
    subscribedCollections.filter((c) => !blockedPubkeys.has(c.pubkey)),
    [subscribedCollections, blockedPubkeys]
  )

  // Flatten all subscribed GIFs for item search
  const allGifs = useMemo(() => {
    return visibleCollections.flatMap((c) => {
      const addr = `30030:${c.pubkey}:${c.dTag}`
      return filterNsfwGifs(c.gifs)
        .map((g) => ({ ...g, setName: c.name, setAddress: addr }))
    })
  }, [visibleCollections, nsfwEnabled, untaggedAsNsfw])

  const filteredItems = search
    ? allGifs.filter((g) =>
      g.name.toLowerCase().includes(search.toLowerCase()) ||
      g.setName.toLowerCase().includes(search.toLowerCase())
    )
    : allGifs

  const filteredSets = search
    ? visibleCollections.filter((c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.dTag.toLowerCase().includes(search.toLowerCase())
    )
    : visibleCollections

  const handleUnsubscribe = async (collection: GifCollection) => {
    const addr = `30030:${collection.pubkey}:${collection.dTag}`
    setUnsubscribing(addr)
    try {
      const updated = subscriptionAddresses.filter((a) => a !== addr)
      await publishGifSubscriptions(updated, signer, privateKey)
      useGifStore.getState().removeSubscription(addr)
    } catch (err) {
      console.error('Failed to unsubscribe:', err)
    } finally {
      setUnsubscribing(null)
    }
  }

  return (
    <>
      <div className="h-full flex flex-col">
        {/* Search + mode toggle + discover bar */}
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
          <div className="flex-1 relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchMode === 'items' ? 'Search GIFs...' : 'Search sets...'}
              className="w-full h-7 pl-7 pr-2 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setSearchMode(searchMode === 'items' ? 'sets' : 'items')}
                  className={`px-1.5 py-1 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${searchMode === 'sets'
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    }`}
                >
                  {searchMode === 'items' ? 'Items' : 'Sets'}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs z-[310]">
                {searchMode === 'items' ? 'Switch to set search' : 'Switch to item search'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {visibleCollections.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
              <Compass size={24} className="opacity-40" />
              <p className="text-xs text-center">No subscribed GIF sets yet.<br />Use the Discover tab to find GIF packs!</p>
            </div>
          ) : search && searchMode === 'items' ? (
            filteredItems.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-xs text-muted-foreground">No GIFs matching "{search}"</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                <TooltipProvider delayDuration={200}>
                  {filteredItems.map((g, i) => (
                    <Tooltip key={`${g.setAddress}-${g.url}-${i}`}>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => onSelect(g)}
                          className="w-full aspect-square rounded-lg border border-border/30 overflow-hidden hover:border-primary/40 hover:ring-1 hover:ring-primary/20 transition-all cursor-pointer bg-secondary/20"
                        >
                          <img src={g.url} alt={g.name} className="w-full h-full object-cover" loading="lazy" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs z-[310]">{g.name || 'Unnamed'} ({g.setName})</TooltipContent>
                    </Tooltip>
                  ))}
                </TooltipProvider>
              </div>
            )
          ) : search && searchMode === 'sets' ? (
            filteredSets.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-xs text-muted-foreground">No sets matching "{search}"</p>
              </div>
            ) : (
              filteredSets.map((col) => {
                const addr = `30030:${col.pubkey}:${col.dTag}`
                const profile = getProfile(col.pubkey)
                const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(col.pubkey))
                const isUnsub = unsubscribing === addr
                const visibleGifs = filterNsfwGifs(col.gifs)
                return (
                  <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-foreground truncate">{col.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          by <button onClick={() => setProfilePubkey(col.pubkey)} className="text-primary hover:underline cursor-pointer">{authorName}</button> · {col.gifs.length} GIF{col.gifs.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                      <button
                        onClick={() => handleUnsubscribe(col)}
                        disabled={isUnsub}
                        className="px-1.5 py-0.5 rounded text-[9px] text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                      >
                        {isUnsub ? <Loader2 size={10} className="animate-spin" /> : 'Unsub'}
                      </button>
                    </div>
                    <TooltipProvider delayDuration={200}>
                      <div className="flex flex-wrap gap-1">
                        {visibleGifs.slice(0, 6).map((gif, i) => (
                          <Tooltip key={`${gif.url}-${i}`}>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => onSelect(gif)}
                                className="w-12 h-12 rounded border border-border/30 overflow-hidden hover:border-primary/40 transition-colors cursor-pointer"
                              >
                                <img src={gif.url} alt={gif.name} className="w-full h-full object-cover" loading="lazy" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs z-[310]">{gif.name || 'Unnamed GIF'}</TooltipContent>
                          </Tooltip>
                        ))}
                        {visibleGifs.length > 6 && (
                          <div className="w-12 h-12 rounded border border-border/30 flex items-center justify-center text-[10px] text-muted-foreground">
                            +{visibleGifs.length - 6}
                          </div>
                        )}
                      </div>
                    </TooltipProvider>
                  </div>
                )
              })
            )
          ) : (
            visibleCollections.map((col) => {
              const addr = `30030:${col.pubkey}:${col.dTag}`
              const profile = getProfile(col.pubkey)
              const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(col.pubkey))
              const isUnsub = unsubscribing === addr
              const visibleGifs = filterNsfwGifs(col.gifs)
              return (
                <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate">{col.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        by <button onClick={() => setProfilePubkey(col.pubkey)} className="text-primary hover:underline cursor-pointer">{authorName}</button> · {col.gifs.length} GIF{col.gifs.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                    <button
                      onClick={() => handleUnsubscribe(col)}
                      disabled={isUnsub}
                      className="px-1.5 py-0.5 rounded text-[9px] text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                    >
                      {isUnsub ? <Loader2 size={10} className="animate-spin" /> : 'Unsub'}
                    </button>
                  </div>
                  <TooltipProvider delayDuration={200}>
                    <div className="flex flex-wrap gap-1">
                      {visibleGifs.slice(0, 6).map((gif, i) => (
                        <Tooltip key={`${gif.url}-${i}`}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => onSelect(gif)}
                              className="w-12 h-12 rounded border border-border/30 overflow-hidden hover:border-primary/40 transition-colors cursor-pointer"
                            >
                              <img src={gif.url} alt={gif.name} className="w-full h-full object-cover" loading="lazy" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs z-[310]">{gif.name || 'Unnamed GIF'}</TooltipContent>
                        </Tooltip>
                      ))}
                      {visibleGifs.length > 6 && (
                        <div className="w-12 h-12 rounded border border-border/30 flex items-center justify-center text-[10px] text-muted-foreground">
                          +{visibleGifs.length - 6}
                        </div>
                      )}
                    </div>
                  </TooltipProvider>
                </div>
              )
            })
          )}
        </div>

      </div>

      {profilePubkey && createPortal(
        <UserProfileModal
          open={!!profilePubkey}
          onClose={() => setProfilePubkey(null)}
          targetPubkey={profilePubkey}
        />,
        document.body
      )}
    </>
  )
}

/* ═══════════ Favorites Tab ═══════════ */

function FavoritesGifTab({ onSelect }: { onSelect: (g: { name: string; url: string; nsfw: boolean }) => void }) {
  const favorites = useGifStore((s) => s.favorites)
  const nsfwEnabled = useGifStore((s) => s.nsfwEnabled)
  const untaggedAsNsfw = useGifStore((s) => s.untaggedAsNsfw)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [search, setSearch] = useState('')
  const [removingUrl, setRemovingUrl] = useState<string | null>(null)

  const filtered = useMemo(() => {
    let result = filterNsfwGifs(favorites)
    if (search) {
      const q = search.toLowerCase()
      result = result.filter((g) => g.name.toLowerCase().includes(q))
    }
    return result
  }, [favorites, nsfwEnabled, untaggedAsNsfw, search])

  const removeFavorite = async (url: string) => {
    setRemovingUrl(url)
    try {
      const updated = favorites.filter((f) => f.url !== url)
      await publishGifFavorites(updated, signer, privateKey)
      useGifStore.getState().setFavorites(updated)
    } catch (err) {
      console.error('Failed to remove favorite:', err)
    } finally {
      setRemovingUrl(null)
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Search */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
        <div className="flex-1 relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search favorites..."
            className="w-full h-7 pl-7 pr-2 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Star size={24} className="opacity-40" />
            <p className="text-xs text-center">{search ? 'No favorites found' : 'No favorite GIFs yet'}</p>
            <p className="text-xs text-center opacity-60">Star GIFs from the Discover tab to save them here.</p>
          </div>
        ) : (
          <TooltipProvider delayDuration={200}>
            <div className="grid grid-cols-3 gap-1.5">
              {filtered.map((gif, i) => {
                const removing = removingUrl === gif.url
                return (
                  <Tooltip key={`${gif.url}-${i}`}>
                    <TooltipTrigger asChild>
                      <div className="relative group">
                        <button
                          onClick={() => onSelect(gif)}
                          className="w-full aspect-square rounded-lg border border-border/30 overflow-hidden hover:border-primary/40 hover:ring-1 hover:ring-primary/20 transition-all cursor-pointer bg-secondary/20"
                        >
                          <img
                            src={gif.url}
                            alt={gif.name}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        </button>
                        {/* Unfavorite button */}
                        <button
                          onClick={(e) => { e.stopPropagation(); removeFavorite(gif.url) }}
                          disabled={removing}
                          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-yellow-500/90 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        >
                          {removing ? <Loader2 size={10} className="animate-spin" /> : <StarOff size={10} />}
                        </button>
                        {gif.nsfw && (
                          <span className="absolute top-1 left-1 px-1 py-0.5 rounded text-[8px] bg-red-500/80 text-white font-bold">NSFW</span>
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs z-[310]">
                      {gif.name || 'Unnamed GIF'}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          </TooltipProvider>
        )}
      </div>
    </div>
  )
}

/* ═══════════ GIF Collection Card ═══════════ */

function GifCollectionCard({
  collection, isMine, expanded, onToggle, onSelect, nsfwEnabled
}: {
  collection: GifCollection
  isMine: boolean
  expanded: boolean
  onToggle: () => void
  onSelect: (g: GifEntry) => void
  nsfwEnabled: boolean
}) {
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Staged upload
  type StagedGif = { file: File; preview: string; name: string; nsfw: boolean }
  const [staged, setStaged] = useState<StagedGif[]>([])

  const handleFileSelect = (files: FileList) => {
    const limitBytes = getGifUploadLimitBytes()
    const newStaged: StagedGif[] = []

    for (const file of Array.from(files)) {
      if (file.size > limitBytes) {
        alert(`${file.name} exceeds the GIF upload limit (${Math.round(limitBytes / 1024 / 1024)} MB)`)
        continue
      }
      if (!file.type.startsWith('image/gif')) continue
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9 _-]/g, '').trim().toLowerCase()
      newStaged.push({ file, preview: URL.createObjectURL(file), name, nsfw: false })
    }

    setStaged((prev) => [...prev, ...newStaged])
  }

  const updateStagedName = (index: number, name: string) => {
    setStaged((prev) => prev.map((s, i) => i === index ? { ...s, name } : s))
  }

  const toggleStagedNsfw = (index: number) => {
    setStaged((prev) => prev.map((s, i) => i === index ? { ...s, nsfw: !s.nsfw } : s))
  }

  const removeStagedItem = (index: number) => {
    setStaged((prev) => {
      const removed = prev[index]
      if (removed) URL.revokeObjectURL(removed.preview)
      return prev.filter((_, i) => i !== index)
    })
  }

  const confirmUpload = async () => {
    if (staged.length === 0) return
    setUploading(true)
    try {
      const newGifs: GifEntry[] = [...collection.gifs]

      for (const item of staged) {
        const sc = item.name.trim().toLowerCase() || 'gif'
        const buffer = new Uint8Array(await item.file.arrayBuffer())
        const servers = getUploadBlossoms()
        const { hash } = await uploadToBlossomServers(buffer, signer, privateKey, servers, item.file.type)
        const ext = item.file.type.split('/')[1]?.split('+')[0] || 'gif'
        const url = `https://blossom.primal.net/${hash}.${ext}`
        newGifs.push({ name: sc, url, nsfw: item.nsfw, tagged: true })
        URL.revokeObjectURL(item.preview)
      }

      await publishGifCollection(collection.dTag, newGifs, signer, privateKey)
      useGifStore.getState().updateMyGifCollection(collection.dTag, newGifs)
      setStaged([])
    } catch (err) {
      console.error('Failed to upload GIF:', err)
    } finally {
      setUploading(false)
    }
  }

  const removeGif = async (url: string) => {
    const updated = collection.gifs.filter((g) => g.url !== url)
    await publishGifCollection(collection.dTag, updated, signer, privateKey)
    useGifStore.getState().updateMyGifCollection(collection.dTag, updated)
  }

  const handleDeleteCollection = async () => {
    setDeleting(true)
    setShowDeleteModal(false)
    try {
      await deleteGifCollection(collection.dTag, signer, privateKey)
      if (isMine) {
        useGifStore.getState().removeMyGifCollection(collection.dTag)
      } else {
        const addr = `30030:${collection.pubkey}:${collection.dTag}`
        useGifStore.getState().removeSubscription(addr)
        const updatedAddrs = useGifStore.getState().subscriptionAddresses
        await publishGifSubscriptions(updatedAddrs, signer, privateKey)
      }
    } catch (err) {
      console.error('Failed to delete GIF collection:', err)
    } finally {
      setDeleting(false)
    }
  }

  const visibleGifs = filterNsfwGifs(collection.gifs)

  return (
    <div className="rounded-lg border border-border bg-secondary/20 overflow-hidden">
      {/* Header */}
      <div
        onClick={onToggle}
        className="flex items-center justify-between px-2.5 py-2 cursor-pointer hover:bg-accent/20 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-foreground truncate">{collection.name}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">{collection.gifs.length}</span>
          {!isMine && <span className="text-[10px] text-primary/60 shrink-0">subscribed</span>}
        </div>
        {isMine && (
          <div className="flex items-center gap-1 shrink-0">
            <TooltipProvider delayDuration={200}>
              {uploading ? (
                <Loader2 size={12} className="animate-spin text-muted-foreground" />
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => { e.stopPropagation(); fileRef.current?.click() }}
                      className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      <Plus size={12} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs z-[310]">Add GIFs</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowDeleteModal(true) }}
                    disabled={deleting}
                    className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                  >
                    {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs z-[310]">Request Delete</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
        {!isMine && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => { e.stopPropagation(); setShowDeleteModal(true) }}
                  className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <X size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs z-[310]">Unsubscribe</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/gif"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleFileSelect(e.target.files)}
      />

      {/* Staged GIFs (naming + NSFW flag before upload) */}
      {staged.length > 0 && (
        <div className="px-2 py-2 space-y-1.5 border-t border-border/50 pt-2">
          <p className="text-[10px] text-muted-foreground">Name your GIFs and set NSFW before uploading:</p>
          {staged.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <img src={item.preview} alt="" className="w-10 h-10 object-cover rounded shrink-0" />
              <input
                value={item.name}
                onChange={(e) => updateStagedName(i, e.target.value)}
                placeholder="GIF name..."
                className="flex-1 h-7 px-2 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <button
                onClick={() => toggleStagedNsfw(i)}
                className={`h-7 px-1.5 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${item.nsfw ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-muted/30 text-muted-foreground border border-border'}`}
              >
                {item.nsfw ? 'NSFW' : 'SFW'}
              </button>
              <button
                onClick={() => removeStagedItem(i)}
                className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1.5 pt-1">
            <button
              onClick={confirmUpload}
              disabled={uploading || staged.every((s) => !s.name.trim())}
              className="flex-1 h-7 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1"
            >
              {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              Upload {staged.length} GIF{staged.length > 1 ? 's' : ''}
            </button>
            <button
              onClick={() => { staged.forEach((s) => URL.revokeObjectURL(s.preview)); setStaged([]) }}
              className="h-7 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* GIF grid */}
      {expanded && (
        <div className="px-2 py-2">
          <TooltipProvider delayDuration={200}>
            <div className="grid grid-cols-3 gap-1.5">
              {visibleGifs.map((gif, i) => (
                <Tooltip key={`${gif.url}-${i}`}>
                  <TooltipTrigger asChild>
                    <div className="relative group">
                      <button
                        onClick={() => onSelect(gif)}
                        className="w-full aspect-square rounded-lg border border-border/30 overflow-hidden hover:border-primary/40 hover:ring-1 hover:ring-primary/20 transition-all cursor-pointer bg-secondary/20"
                      >
                        <img
                          src={gif.url}
                          alt={gif.name}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      </button>
                      {isMine && (
                        <button
                          onClick={(e) => { e.stopPropagation(); removeGif(gif.url) }}
                          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        >
                          <Trash2 size={7} />
                        </button>
                      )}
                      {gif.nsfw && (
                        <span className="absolute top-1 left-1 px-1 py-0.5 rounded text-[8px] bg-red-500/80 text-white font-bold">NSFW</span>
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs z-[310]">{gif.name || 'Unnamed GIF'}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </TooltipProvider>
        </div>
      )}

      {/* Delete confirmation modal */}
      {showDeleteModal && createPortal(
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[320]" onClick={() => setShowDeleteModal(false)}>
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-foreground mb-2">
              {isMine ? 'Request Delete GIF Collection' : 'Unsubscribe from Collection'}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {isMine
                ? <>This will send a deletion request for the GIF collection <strong>"{collection.name}"</strong> to the relays. Deletion is <strong>not guaranteed</strong> — some relays may not honor the request.</>
                : <>This will unsubscribe you from <strong>"{collection.name}"</strong>. You can re-subscribe from the Discover tab.</>
              }
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowDeleteModal(false)}>Cancel</Button>
              <Button variant="destructive" onClick={handleDeleteCollection}>
                {isMine ? 'Yes, Request Delete' : 'Unsubscribe'}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

/* ═══════════ Favorite GIF Modal (for non-blossom/untagged GIFs) ═══════════ */

export function GifFavoriteModal({ gifUrl, onClose }: { gifUrl: string; onClose: () => void }) {
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const [name, setName] = useState('')
  const [nsfw, setNsfw] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const current = useGifStore.getState().favorites
      const entry: GifEntry = { name: name.trim(), url: gifUrl, nsfw, tagged: true }
      const updated = [...current, entry]
      await publishGifFavorites(updated, signer, privateKey)
      useGifStore.getState().setFavorites(updated)
      onClose()
    } catch (err) {
      console.error('Failed to save favorite:', err)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[320] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Star size={16} className="text-yellow-500" />
          Favorite this GIF
        </h3>

        {/* Preview */}
        <div className="flex justify-center">
          <img src={gifUrl} alt="" className="max-w-[200px] max-h-[150px] object-contain rounded-lg border border-border" />
        </div>

        {/* Name input */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Name (optional)</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. thumbs-up, facepalm..."
            className="w-full h-8 px-3 rounded-lg text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
            autoFocus
          />
        </div>

        {/* NSFW toggle */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Is this NSFW?</span>
          <button
            onClick={() => setNsfw(!nsfw)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${nsfw ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-muted/30 text-muted-foreground border border-border'}`}
          >
            {nsfw ? 'NSFW' : 'SFW'}
          </button>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin mr-1" /> : <Star size={14} className="mr-1" />}
            Save
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/* ═══════════ Discovery Modal (full-screen, like StickerDiscoveryModal) ═══════════ */

export function GifDiscoveryModal({ onClose, initialSearch = '' }: { onClose: () => void; initialSearch?: string }) {
  const subscriptionAddresses = useGifStore((s) => s.subscriptionAddresses)
  const nsfwEnabled = useGifStore((s) => s.nsfwEnabled)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()

  const [loading, setLoading] = useState(true)
  const [discovered, setDiscovered] = useState<GifCollection[]>([])
  const [search, setSearch] = useState(initialSearch)
  const [searchResults, setSearchResults] = useState<GifCollection[]>([])
  const [searching, setSearching] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [authorFilter, setAuthorFilter] = useState('')
  const [publishingAddr, setPublishingAddr] = useState<string | null>(null)
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null)
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)

  useEffect(() => {
    setLoading(true)
    discoverGifCollections(100)
      .then((collections) => {
        setDiscovered(collections)
      })
      .finally(() => setLoading(false))
  }, [myPubkey])

  // Debounced relay search — queries #g tags when user types
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!search.trim()) {
      setSearchResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchGifCollections(search.trim())
        setSearchResults(results)
      } catch (err) {
        console.error('GIF relay search failed:', err)
      } finally {
        setSearching(false)
      }
    }, 400)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [search, myPubkey])

  const filtered = useMemo(() => {
    // Merge discovered + relay search results (deduplicate)
    const merged = [...discovered]
    for (const sr of searchResults) {
      if (!merged.some((c) => c.pubkey === sr.pubkey && c.dTag === sr.dTag)) {
        merged.push(sr)
      }
    }
    let result = merged.filter((c) => !blockedPubkeys.has(c.pubkey))
    if (search) {
      const q = search.toLowerCase()
      result = result.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        c.dTag.toLowerCase().includes(q) ||
        c.gifs.some((g) => g.name.toLowerCase().includes(q))
      )
    }
    if (authorFilter.trim()) {
      const q = authorFilter.trim().toLowerCase()
      result = result.filter((c) => {
        const npub = nip19.npubEncode(c.pubkey)
        const profile = getProfile(c.pubkey)
        const name = profile?.display_name || profile?.name || ''
        return npub.includes(q) || name.toLowerCase().includes(q) || c.pubkey.includes(q)
      })
    }
    return result
  }, [discovered, searchResults, search, authorFilter, getProfile])

  const handleSubscribe = async (collection: GifCollection) => {
    const addr = `30030:${collection.pubkey}:${collection.dTag}`
    if (subscriptionAddresses.includes(addr)) return
    setPublishingAddr(addr)
    try {
      const updated = [...subscriptionAddresses, addr]
      await publishGifSubscriptions(updated, signer, privateKey)
      useGifStore.getState().addSubscription(addr, collection)
    } catch (err) {
      console.error('Failed to subscribe:', err)
    } finally {
      setPublishingAddr(null)
    }
  }

  return (
    <>
      {createPortal(
        <div className="fixed inset-0 z-[320] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
          <div
            className="w-full max-w-lg max-h-[80vh] flex flex-col bg-background rounded-xl border border-border shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/30 shrink-0">
              <div className="flex items-center gap-2">
                <Compass size={16} className="text-primary" />
                <span className="text-sm font-semibold text-foreground">Discover GIF Collections</span>
              </div>
              <button onClick={onClose} className="p-1 rounded hover:bg-accent/50 transition-colors cursor-pointer">
                <X size={16} className="text-muted-foreground" />
              </button>
            </div>

            {/* Search + author filter */}
            <div className="px-4 py-4 border-b border-border space-y-3">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search collections..."
                  className="w-full h-8 pl-8 pr-3 rounded-lg text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
                  autoFocus
                />
              </div>
              <div className="relative">
                <Users size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={authorFilter}
                  onChange={(e) => setAuthorFilter(e.target.value)}
                  placeholder="Filter by author (npub, name)..."
                  className="w-full h-8 pl-8 pr-3 rounded-lg text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none font-mono text-xs"
                />
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={20} className="animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <p className="text-sm">{search ? 'No collections found' : 'No GIF collections discovered'}</p>
                  <p className="text-xs mt-1 opacity-60">Try again later as more users publish GIF collections.</p>
                </div>
              ) : (
                filtered.map((collection) => {
                  const addr = `30030:${collection.pubkey}:${collection.dTag}`
                  const isSubscribed = subscriptionAddresses.includes(addr)
                  const isPublishing = publishingAddr === addr
                  const profile = getProfile(collection.pubkey)
                  const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(collection.pubkey))
                  const visibleGifs = filterNsfwGifs(collection.gifs)

                  return (
                    <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{collection.name}</p>
                          <p className="text-[10px] text-muted-foreground">by <button onClick={() => setProfilePubkey(collection.pubkey)} className="text-primary hover:underline cursor-pointer">{authorName}</button> · {collection.gifs.length} GIFs</p>
                        </div>
                        {isSubscribed ? (
                          <span className="text-[10px] text-primary font-medium shrink-0 flex items-center gap-1">
                            <Check size={10} /> Subscribed
                          </span>
                        ) : (
                          <button
                            onClick={() => handleSubscribe(collection)}
                            disabled={isPublishing}
                            className="shrink-0 px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 cursor-pointer"
                          >
                            {isPublishing ? <Loader2 size={12} className="animate-spin" /> : 'Subscribe'}
                          </button>
                        )}
                      </div>
                      {/* Preview grid */}
                      <div className="flex flex-wrap gap-1">
                        {visibleGifs.slice(0, 6).map((g, i) => (
                          <img
                            key={`${g.url}-${i}`}
                            src={g.url}
                            alt={g.name}
                            className="w-12 h-12 object-cover rounded border border-border/30"
                            loading="lazy"
                          />
                        ))}
                        {visibleGifs.length > 6 && (
                          <div className="w-12 h-12 rounded border border-border/30 flex items-center justify-center text-[10px] text-muted-foreground">
                            +{visibleGifs.length - 6}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {profilePubkey && createPortal(
        <UserProfileModal
          open={!!profilePubkey}
          onClose={() => setProfilePubkey(null)}
          targetPubkey={profilePubkey}
        />,
        document.body
      )}
    </>
  )
}

