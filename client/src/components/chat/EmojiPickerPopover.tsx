/**
 * EmojiPickerPopover — Tabbed emoji picker (Basic / Mine / Others)
 *
 * Portal-based, positioned relative to an anchor button ref.
 * Basic tab: standard Unicode emojis via emoji-picker-react
 * Mine tab: user's own custom NIP-30 emoji sets + upload
 * Others tab: subscribed sets from other users + Discover button
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import EmojiPickerReact, { EmojiStyle, Theme } from 'emoji-picker-react'
import { Smile, Sparkles, Users, Plus, Trash2, Loader2, Upload, Search, X, FolderPlus, Image, AlertTriangle, Check, Compass, ShieldQuestion } from 'lucide-react'
import { useEmojiStore, getEmojiUploadLimitBytes, hasOversizedEmoji, type CustomEmoji, type EmojiSet } from '@/stores/emojiStore'
import { publishEmojiSet, publishEmojiSubscriptions, discoverEmojiSets, fetchEmojiSetByAddress, deleteEmojiSet, fetchEmojiSetsByAuthor } from '@/lib/nostr/customEmoji'
import { uploadToBlossomServers, computeHash } from '@/lib/blossom'
import { getUploadBlossoms } from '@/stores/postingBehaviourStore'
import { useUserStore } from '@/stores/userStore'
import { useBlockStore } from '@/stores/blockStore'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { useProfileCache } from '@/hooks/useProfileCache'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { CustomSelect } from '@/components/ui/custom-select'

// emoji-picker-react lays its Basic-tab emojis out with JS-computed absolute
// positions: columns = floor(width / 34px). At exactly 340 (= 10 × 34) Firefox
// measures the full width (its overlay scrollbar isn't subtracted like Chromium's
// classic one) and packs 10 columns, overflowing the right edge. Keeping the width
// just under that threshold yields 9 columns in both browsers with room to spare.
const PICKER_WIDTH = 330
const PICKER_HEIGHT = 380
const GAP = 8

type Tab = 'discover' | 'basic' | 'mine' | 'others'

interface Props {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onSelect: (emoji: string, customEmoji?: { shortcode: string; url: string }) => void
}

export function EmojiPickerPopover({ anchorRef, onClose, onSelect }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number; height: number }>({ top: 0, left: 0, height: PICKER_HEIGHT })
  const [tab, setTab] = useState<Tab>('basic')
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState(PICKER_HEIGHT - 70) // conservative initial estimate

  // Measure actual available height for the emoji content area
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => setContentHeight(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [pos.height])

  const computePosition = useCallback(() => {
    if (!anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth

    const spaceAbove = rect.top
    const spaceBelow = vh - rect.bottom
    let top: number
    let height = PICKER_HEIGHT
    if (spaceAbove >= PICKER_HEIGHT + GAP) {
      top = rect.top - PICKER_HEIGHT - GAP
    } else if (spaceBelow >= PICKER_HEIGHT + GAP) {
      top = rect.bottom + GAP
    } else {
      // Not enough room for full height — pick the larger side and shrink to fit
      if (spaceAbove > spaceBelow) {
        height = Math.max(200, spaceAbove - GAP * 2)
        top = rect.top - height - GAP
      } else {
        height = Math.max(200, spaceBelow - GAP * 2)
        top = rect.bottom + GAP
      }
    }

    // Final safety clamp: ensure the picker stays within viewport bounds
    if (top < GAP) top = GAP
    if (top + height > vh - GAP) height = Math.max(200, vh - top - GAP)

    let left = rect.right - PICKER_WIDTH
    if (left < GAP) left = rect.left
    if (left + PICKER_WIDTH > vw - GAP) left = vw - PICKER_WIDTH - GAP
    left = Math.max(GAP, left)

    setPos({ top, left, height })
  }, [anchorRef])

  useEffect(() => {
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [computePosition])

  // Close on outside click — but ignore clicks inside portaled children (discovery modal, tooltips)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (containerRef.current && !containerRef.current.contains(target) &&
          anchorRef.current && !anchorRef.current.contains(target) &&
          !target.closest('[data-emoji-picker-portal]') &&
          !target.closest('[data-radix-popper-content-wrapper]')) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  // Listen for emoji-picker-discover event (from emoji click modal)
  useEffect(() => {
    const handler = (e: Event) => {
      setTab('discover')
    }
    window.addEventListener('emoji-picker-discover', handler)
    return () => window.removeEventListener('emoji-picker-discover', handler)
  }, [])

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'basic', label: 'Basic', icon: <Smile size={14} /> },
    { id: 'discover', label: 'Discover', icon: <Compass size={14} /> },
    { id: 'mine', label: 'Mine', icon: <Sparkles size={14} /> },
    { id: 'others', label: 'Others', icon: <Users size={14} /> },
  ]

  return createPortal(
    <div
      ref={containerRef}
      data-emoji-picker
      className="fixed z-[300] flex flex-col bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-xl shadow-2xl overflow-hidden"
      style={{ top: pos.top, left: pos.left, width: PICKER_WIDTH, height: pos.height }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Tab bar */}
      <div className="flex border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.3)] shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors cursor-pointer ${
              tab === t.id
                ? 'text-[hsl(var(--primary))] border-b-2 border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.05)]'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted)/0.3)]'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* NSFW Toggle */}
      <EmojiNsfwToggle />

      {/* Tab content */}
      <div ref={contentRef} className="flex-1 overflow-hidden">
        {tab === 'discover' && (
          <DiscoverEmojiTab onPickerClose={onClose} />
        )}
        {tab === 'basic' && (
          <EmojiPickerReact
            theme={Theme.DARK}
            width={PICKER_WIDTH}
            height={contentHeight}
            autoFocusSearch={false}
            emojiStyle={EmojiStyle.NATIVE}
            searchPlaceHolder="Search emojis..."
            style={{
              '--epr-bg-color': 'hsl(var(--background))',
              '--epr-category-label-bg-color': 'hsl(var(--background))',
              '--epr-text-color': 'hsl(var(--foreground))',
              '--epr-hover-bg-color': 'hsl(var(--muted) / 0.5)',
              '--epr-picker-border-color': 'transparent',
              '--epr-search-input-bg-color': 'hsl(var(--muted) / 0.3)',
              '--epr-search-border-color': 'hsl(var(--border))',
              '--epr-search-input-text-color': 'hsl(var(--foreground))',
              '--epr-search-input-placeholder-color': 'hsl(var(--muted-foreground))',
              '--epr-category-navigation-button-size': '24px',
              '--epr-emoji-size': '24px',
              '--epr-search-input-height': '28px',
              '--epr-search-input-border-radius': '6px',
              '--epr-header-padding': '6px 8px',
              fontSize: '12px',
              border: 'none',
              borderRadius: '0',
            } as React.CSSProperties}
            onEmojiClick={(data) => onSelect(data.emoji)}
          />
        )}
        {tab === 'mine' && (
          <MineTab onSelect={onSelect} />
        )}
        {tab === 'others' && (
          <OthersTab onSelect={onSelect} />
        )}
      </div>
    </div>,
    document.body
  )
}

/* ═══════════ NSFW Toggle Bar ═══════════ */

function EmojiNsfwToggle() {
  const nsfwEnabled = useEmojiStore((s) => s.nsfwEnabled)
  const setNsfwEnabled = useEmojiStore((s) => s.setNsfwEnabled)
  const untaggedAsNsfw = useEmojiStore((s) => s.untaggedAsNsfw)
  const setUntaggedAsNsfw = useEmojiStore((s) => s.setUntaggedAsNsfw)

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-secondary/10 shrink-0">
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

/** Filter emoji entries based on NSFW + untagged settings */
function filterNsfwEmojis(emojis: CustomEmoji[]): CustomEmoji[] {
  const { nsfwEnabled, untaggedAsNsfw } = useEmojiStore.getState()
  if (nsfwEnabled) return emojis
  return emojis.filter((e) => {
    if (e.nsfw) return false
    if (!e.tagged && untaggedAsNsfw) return false
    return true
  })
}

// ─── Mine Tab ───

function MineTab({ onSelect }: { onSelect: (emoji: string, custom?: { shortcode: string; url: string }) => void }) {
  const myEmojiSets = useEmojiStore((s) => s.myEmojiSets)
  const updateMyEmojiSet = useEmojiStore((s) => s.updateMyEmojiSet)
  const addMyEmojiSet = useEmojiStore((s) => s.addMyEmojiSet)
  const removeMyEmojiSet = useEmojiStore((s) => s.removeMyEmojiSet)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const pubkey = useUserStore((s) => s.pubkey)
  const nsfwEnabled = useEmojiStore((s) => s.nsfwEnabled)
  const untaggedAsNsfw = useEmojiStore((s) => s.untaggedAsNsfw)

  const [showUpload, setShowUpload] = useState(false)
  const [showNewSet, setShowNewSet] = useState(false)
  const [newSetName, setNewSetName] = useState('')
  const [uploadTargetSet, setUploadTargetSet] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // Flatten all emojis for search (with NSFW filtering)
  const allEmojis = useMemo(() => {
    return myEmojiSets.flatMap((s) =>
      filterNsfwEmojis(s.emojis).map((e) => ({ ...e, setDTag: s.dTag, setPubkey: s.pubkey }))
    )
  }, [myEmojiSets, nsfwEnabled, untaggedAsNsfw])

  const filtered = search
    ? allEmojis.filter((e) => e.shortcode.toLowerCase().includes(search.toLowerCase()))
    : allEmojis

  const handleCreateSet = async () => {
    const name = newSetName.trim()
    if (!name || !pubkey) return
    const dTag = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-')
    try {
      await publishEmojiSet(dTag, [], signer, privateKey)
      addMyEmojiSet({ pubkey, dTag, name, emojis: [] })
      setNewSetName('')
      setShowNewSet(false)
      setUploadTargetSet(dTag)
      setShowUpload(true)
    } catch (err) {
      console.error('Failed to create emoji set:', err)
    }
  }

  const handleDeleteEmoji = async (setDTag: string, shortcode: string) => {
    const set = myEmojiSets.find((s) => s.dTag === setDTag)
    if (!set) return
    const newEmojis = set.emojis.filter((e) => e.shortcode !== shortcode)
    try {
      await publishEmojiSet(setDTag, newEmojis, signer, privateKey)
      updateMyEmojiSet(setDTag, newEmojis)
    } catch (err) {
      console.error('Failed to delete emoji:', err)
    }
  }

  // Delete set state
  const [deleteSetDTag, setDeleteSetDTag] = useState<string | null>(null)
  const [deletingSet, setDeletingSet] = useState(false)
  const deleteSet = myEmojiSets.find((s) => s.dTag === deleteSetDTag)

  const handleDeleteSet = async () => {
    if (!deleteSetDTag) return
    setDeletingSet(true)
    try {
      await deleteEmojiSet(deleteSetDTag, signer, privateKey)
      removeMyEmojiSet(deleteSetDTag)
    } catch (err) {
      console.error('Failed to delete emoji set:', err)
    } finally {
      setDeletingSet(false)
      setDeleteSetDTag(null)
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Search + actions bar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[hsl(var(--border))]">
        <div className="flex-1 relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search my emojis..."
            className="w-full h-7 pl-7 pr-2 rounded-md text-xs bg-[hsl(var(--muted)/0.3)] border border-[hsl(var(--border))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none"
          />
        </div>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => { setShowNewSet(!showNewSet); if (!showNewSet) setShowUpload(false) }}
                className="p-1.5 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted)/0.5)] transition-colors cursor-pointer"
              >
                <FolderPlus size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs z-[310]">New Set</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                disabled={myEmojiSets.length === 0}
                onClick={() => { const next = !showUpload; setShowUpload(next); if (next) { setShowNewSet(false); if (!uploadTargetSet && myEmojiSets.length > 0) setUploadTargetSet(myEmojiSets[0].dTag) } }}
                className={`p-1.5 rounded-md transition-colors ${myEmojiSets.length === 0 ? 'text-[hsl(var(--muted-foreground)/0.3)] cursor-not-allowed' : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted)/0.5)] cursor-pointer'}`}
              >
                <Plus size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs z-[310]">Add Emoji</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* New set form */}
      {showNewSet && (
        <div className="px-2 py-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.2)]">
          <p className="text-[10px] text-[hsl(var(--muted-foreground))] mb-1.5">Create a new emoji set</p>
          <div className="flex gap-1.5">
            <input
              value={newSetName}
              onChange={(e) => setNewSetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateSet()}
              placeholder="Set name..."
              className="flex-1 h-7 px-2 rounded-md text-xs bg-[hsl(var(--background))] border border-[hsl(var(--border))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none"
              autoFocus
            />
            <button
              onClick={handleCreateSet}
              disabled={!newSetName.trim()}
              className="h-7 px-2.5 rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>
      )}

      {/* Upload form */}
      {showUpload && myEmojiSets.length > 0 && (
        <EmojiUploadForm
          sets={myEmojiSets}
          targetSet={uploadTargetSet || myEmojiSets[0].dTag}
          onTargetChange={setUploadTargetSet}
          onDone={() => setShowUpload(false)}
        />
      )}

      {/* Emoji grid */}
      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {myEmojiSets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-[hsl(var(--muted-foreground))]">
            <Image size={24} className="opacity-40" />
            <p className="text-xs text-center">No emoji sets yet.<br />Create one to get started!</p>
            <button
              onClick={() => setShowNewSet(true)}
              className="mt-1 px-3 py-1.5 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer"
            >
              Create Set
            </button>
          </div>
        ) : filtered.length === 0 && search ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No emojis matching "{search}"</p>
          </div>
        ) : (
          <>
            {search ? (
              <div className="grid grid-cols-8 gap-1">
                {filtered.map((e) => (
                  <EmojiButton
                    key={`${e.setDTag}-${e.shortcode}`}
                    emoji={e}
                    onClick={() => onSelect(`:${e.shortcode}:`, { shortcode: e.shortcode, url: e.url })}
                    onDelete={() => handleDeleteEmoji(e.setDTag, e.shortcode)}
                  />
                ))}
              </div>
            ) : (
              myEmojiSets.map((set) => (
                <div key={set.dTag} className="mb-2">
                  <div className="flex items-center justify-between px-0.5 mb-1">
                    <p className="text-[10px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                      {set.name}
                    </p>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => setDeleteSetDTag(set.dTag)}
                            className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                          >
                            <Trash2 size={10} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs z-[310]">Request Delete</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  {set.emojis.length === 0 ? (
                    <p className="text-[10px] text-[hsl(var(--muted-foreground)/0.6)] italic px-0.5">Empty set — add emojis above</p>
                  ) : (
                    <div className="grid grid-cols-8 gap-1">
                      {set.emojis.map((e) => (
                        <EmojiButton
                          key={e.shortcode}
                          emoji={e}
                          onClick={() => onSelect(`:${e.shortcode}:`, { shortcode: e.shortcode, url: e.url })}
                          onDelete={() => handleDeleteEmoji(set.dTag, e.shortcode)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </>
        )}
      </div>

      {/* Delete set confirmation modal */}
      {deleteSetDTag && createPortal(
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[320]" onClick={() => !deletingSet && setDeleteSetDTag(null)}>
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-foreground mb-2">Request Delete Emoji Set</h3>
            {!deletingSet ? (
              <>
                <p className="text-sm text-muted-foreground mb-4">
                  This will send a deletion request for the emoji set <strong>"{deleteSet?.name || deleteSetDTag}"</strong> to the relays. Deletion is <strong>not guaranteed</strong> —
                  some relays may not honor the request, and other clients may have already cached the set.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setDeleteSetDTag(null)}>Cancel</Button>
                  <Button variant="destructive" onClick={handleDeleteSet}>Yes, Request Delete</Button>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 py-4">
                <Loader2 size={16} className="animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Sending deletion request...</span>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// ─── Emoji Button ───

function EmojiButton({ emoji, onClick, onDelete }: {
  emoji: CustomEmoji
  onClick: () => void
  onDelete: () => void
}) {
  return (
    <div className="relative group">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onClick}
              className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[hsl(var(--muted)/0.5)] transition-colors cursor-pointer"
            >
              <img
                src={emoji.url}
                alt={`:${emoji.shortcode}:`}
                className="w-6 h-6 object-contain"
                loading="lazy"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs z-[310]">:{emoji.shortcode}:</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer z-10"
      >
        <Trash2 size={7} />
      </button>
    </div>
  )
}

// ─── Upload Form ───

function EmojiUploadForm({ sets, targetSet, onTargetChange, onDone }: {
  sets: EmojiSet[]
  targetSet: string
  onTargetChange: (dTag: string) => void
  onDone: () => void
}) {
  const updateMyEmojiSet = useEmojiStore((s) => s.updateMyEmojiSet)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [shortcode, setShortcode] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [nsfw, setNsfw] = useState(false)

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setError(null)

    // Check emoji upload limit
    const limitBytes = getEmojiUploadLimitBytes()
    if (f.size > limitBytes) {
      setError(`File too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Max: ${(limitBytes / 1024 / 1024).toFixed(0)} MB`)
      return
    }

    // Check if it's an image
    if (!f.type.startsWith('image/')) {
      setError('Only image files are allowed')
      return
    }

    setFile(f)
    setPreview(URL.createObjectURL(f))

    // Auto-fill shortcode from filename
    if (!shortcode) {
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
      setShortcode(name)
    }
  }

  const handleUpload = async () => {
    if (!file || !shortcode.trim()) return
    const sc = shortcode.trim().replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
    setUploading(true)
    setError(null)
    setUploadProgress(0)

    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const servers = getUploadBlossoms()

      const { hash } = await uploadToBlossomServers(
        data,
        signer,
        privateKey,
        servers,
        file.type,
        (progress) => setUploadProgress(progress.percent),
      )

      // Build URL from first server + hash
      const ext = file.type.split('/')[1]?.split('+')[0] || 'png'
      const url = `https://blossom.primal.net/${hash}.${ext}`

      // Add to the target set
      const set = sets.find((s) => s.dTag === targetSet)
      if (set) {
        const newEmojis = [...set.emojis, { shortcode: sc, url, nsfw, tagged: true }]
        await publishEmojiSet(targetSet, newEmojis, signer, privateKey)
        updateMyEmojiSet(targetSet, newEmojis)
      }

      // Reset form
      setFile(null)
      setPreview(null)
      setShortcode('')
      setUploadProgress(0)
      setNsfw(false)
      onDone()
    } catch (err) {
      console.error('Emoji upload failed:', err)
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview) }
  }, [preview])

  return (
    <div className="px-2 py-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.15)] space-y-2">
      {/* Row 1: Set selector */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-[hsl(var(--muted-foreground))] shrink-0">Set:</span>
        <CustomSelect
          value={targetSet}
          onChange={onTargetChange}
          options={sets.map((s) => ({ value: s.dTag, label: s.name }))}
          compact
        />
      </div>

      {/* Row 2: File select + preview */}
      <div className="flex items-center gap-1.5">
        <input type="file" ref={fileInputRef} accept="image/*" className="hidden" onChange={handleFileSelect} />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="h-7 px-2.5 rounded-md text-xs bg-[hsl(var(--secondary))] border border-[hsl(var(--border))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted)/0.5)] transition-colors cursor-pointer flex items-center gap-1.5 shrink-0"
        >
          <Upload size={11} />
          {file ? 'Change' : 'Select Image'}
        </button>
        {preview && (
          <img src={preview} alt="Preview" className="w-7 h-7 rounded border border-[hsl(var(--border))] object-contain bg-[hsl(var(--muted)/0.3)] shrink-0" />
        )}
        {file && (
          <span className="text-[10px] text-[hsl(var(--muted-foreground))] truncate">{file.name}</span>
        )}
      </div>

      {/* Row 3: Shortcode + NSFW + Add */}
      <div className="flex items-center gap-1.5">
        <input
          value={shortcode}
          onChange={(e) => setShortcode(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
          placeholder="shortcode"
          className="flex-1 h-7 px-2 rounded-md text-xs bg-[hsl(var(--background))] border border-[hsl(var(--border))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none font-mono min-w-0"
        />
        <button
          onClick={() => setNsfw(!nsfw)}
          className={`h-7 px-1.5 rounded-md text-[10px] font-medium transition-colors cursor-pointer shrink-0 ${nsfw ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-muted/30 text-muted-foreground border border-border'}`}
        >
          {nsfw ? 'NSFW' : 'SFW'}
        </button>
        <button
          onClick={handleUpload}
          disabled={!file || !shortcode.trim() || uploading}
          className="h-7 px-3 rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 flex items-center gap-1 shrink-0"
        >
          {uploading ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          {uploading ? `${uploadProgress}%` : 'Add'}
        </button>
      </div>

      {/* Upload progress bar */}
      {uploading && (
        <div className="h-1 rounded-full bg-[hsl(var(--muted)/0.3)] overflow-hidden">
          <div
            className="h-full bg-[hsl(var(--primary))] rounded-full transition-all duration-300"
            style={{ width: `${uploadProgress}%` }}
          />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-1 text-[10px] text-red-400">
          <AlertTriangle size={10} className="shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}
    </div>
  )
}

// ─── Others Tab ───

function OthersTab({ onSelect }: { onSelect: (emoji: string, custom?: { shortcode: string; url: string }) => void }) {
  const subscribedSets = useEmojiStore((s) => s.subscribedSets)
  const subscriptionAddresses = useEmojiStore((s) => s.subscriptionAddresses)
  const removeSubscription = useEmojiStore((s) => s.removeSubscription)
  const nsfwEnabled = useEmojiStore((s) => s.nsfwEnabled)
  const untaggedAsNsfw = useEmojiStore((s) => s.untaggedAsNsfw)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const [search, setSearch] = useState('')
  const [searchMode, setSearchMode] = useState<'items' | 'sets'>('items')
  const [unsubscribing, setUnsubscribing] = useState<string | null>(null)
  const { getProfile } = useProfileCache()



  const handleUnsubscribe = async (set: EmojiSet) => {
    const addr = `30030:${set.pubkey}:${set.dTag}`
    setUnsubscribing(addr)
    try {
      const newAddrs = subscriptionAddresses.filter((a) => a !== addr)
      await publishEmojiSubscriptions(newAddrs, signer, privateKey)
      removeSubscription(addr)
    } catch (err) {
      console.error('Failed to unsubscribe:', err)
    } finally {
      setUnsubscribing(null)
    }
  }

  // Flatten all subscribed emojis for item search (with NSFW filtering)
  const allEmojis = useMemo(() => {
    return subscribedSets.flatMap((s) =>
      filterNsfwEmojis(s.emojis).map((e) => ({ ...e, setName: s.name, setDTag: s.dTag }))
    )
  }, [subscribedSets, nsfwEnabled, untaggedAsNsfw])

  const filteredItems = search
    ? allEmojis.filter((e) =>
        e.shortcode.toLowerCase().includes(search.toLowerCase()) ||
        e.setName.toLowerCase().includes(search.toLowerCase())
      )
    : allEmojis

  const filteredSets = search
    ? subscribedSets.filter((s) =>
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        s.dTag.toLowerCase().includes(search.toLowerCase())
      )
    : subscribedSets

  return (
    <div className="h-full flex flex-col">
      {/* Search + mode toggle + discover bar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[hsl(var(--border))]">
        <div className="flex-1 relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchMode === 'items' ? 'Search emojis...' : 'Search sets...'}
            className="w-full h-7 pl-7 pr-2 rounded-md text-xs bg-[hsl(var(--muted)/0.3)] border border-[hsl(var(--border))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none"
          />
        </div>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setSearchMode(searchMode === 'items' ? 'sets' : 'items')}
                className={`px-1.5 py-1 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${
                  searchMode === 'sets'
                    ? 'bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]'
                    : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted)/0.5)]'
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
      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {subscribedSets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-[hsl(var(--muted-foreground))]">
            <Users size={24} className="opacity-40" />
            <p className="text-xs text-center">No subscribed sets yet.<br />Use the Discover tab to find sets!</p>
          </div>
        ) : search && searchMode === 'items' ? (
          filteredItems.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">No emojis matching "{search}"</p>
            </div>
          ) : (
            <div className="grid grid-cols-8 gap-1">
              {filteredItems.map((e, i) => (
                <TooltipProvider key={`${e.setDTag}-${e.shortcode}-${i}`} delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onSelect(`:${e.shortcode}:`, { shortcode: e.shortcode, url: e.url })}
                        className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[hsl(var(--muted)/0.5)] transition-colors cursor-pointer"
                      >
                        <img src={e.url} alt={`:${e.shortcode}:`} className="w-6 h-6 object-contain" loading="lazy" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs z-[310]">:{e.shortcode}: ({e.setName})</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ))}
            </div>
          )
        ) : search && searchMode === 'sets' ? (
          filteredSets.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">No sets matching "{search}"</p>
            </div>
          ) : (
            filteredSets.map((set) => {
              const profile = getProfile(set.pubkey)
              const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(set.pubkey))
              const addr = `30030:${set.pubkey}:${set.dTag}`
              const isUnsubscribing = unsubscribing === addr
              return (
                <div key={`${set.pubkey}:${set.dTag}`} className="mb-2.5">
                  <div className="flex items-center gap-1 px-0.5 mb-1">
                    <p className="text-[10px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider truncate">
                      {set.name}
                    </p>
                    <span className="text-[9px] text-[hsl(var(--muted-foreground)/0.6)]">by {authorName}</span>
                    <button
                      onClick={() => handleUnsubscribe(set)}
                      disabled={isUnsubscribing}
                      className="ml-auto px-1.5 py-0.5 rounded text-[9px] text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                    >
                      {isUnsubscribing ? <Loader2 size={10} className="animate-spin" /> : 'Unsub'}
                    </button>
                  </div>
                  <div className="grid grid-cols-8 gap-1">
                    {set.emojis.map((e) => (
                      <TooltipProvider key={e.shortcode} delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => onSelect(`:${e.shortcode}:`, { shortcode: e.shortcode, url: e.url })}
                              className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[hsl(var(--muted)/0.5)] transition-colors cursor-pointer"
                            >
                              <img src={e.url} alt={`:${e.shortcode}:`} className="w-6 h-6 object-contain" loading="lazy" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs z-[310]">:{e.shortcode}:</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ))}
                  </div>
                </div>
              )
            })
          )
        ) : (
          subscribedSets.map((set) => {
            const profile = getProfile(set.pubkey)
            const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(set.pubkey))
            const addr = `30030:${set.pubkey}:${set.dTag}`
            const isUnsubscribing = unsubscribing === addr
            return (
              <div key={`${set.pubkey}:${set.dTag}`} className="mb-2.5">
                <div className="flex items-center gap-1 px-0.5 mb-1">
                  <p className="text-[10px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider truncate">
                    {set.name}
                  </p>
                  <span className="text-[9px] text-[hsl(var(--muted-foreground)/0.6)]">by {authorName}</span>
                  <button
                    onClick={() => handleUnsubscribe(set)}
                    disabled={isUnsubscribing}
                    className="ml-auto px-1.5 py-0.5 rounded text-[9px] text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {isUnsubscribing ? <Loader2 size={10} className="animate-spin" /> : 'Unsub'}
                  </button>
                </div>
                <div className="grid grid-cols-8 gap-1">
                  {set.emojis.map((e) => (
                    <TooltipProvider key={e.shortcode} delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => onSelect(`:${e.shortcode}:`, { shortcode: e.shortcode, url: e.url })}
                            className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[hsl(var(--muted)/0.5)] transition-colors cursor-pointer"
                          >
                            <img src={e.url} alt={`:${e.shortcode}:`} className="w-6 h-6 object-contain" loading="lazy" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs z-[310]">:{e.shortcode}:</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/* ═══════════ Discover Tab ═══════════ */

function DiscoverEmojiTab({ onPickerClose }: { onPickerClose?: () => void }) {
  const subscriptionAddresses = useEmojiStore((s) => s.subscriptionAddresses)
  const addSubscription = useEmojiStore((s) => s.addSubscription)
  const nsfwEnabled = useEmojiStore((s) => s.nsfwEnabled)
  const untaggedAsNsfw = useEmojiStore((s) => s.untaggedAsNsfw)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)

  const [loading, setLoading] = useState(true)
  const [discovered, setDiscovered] = useState<EmojiSet[]>([])
  const [search, setSearch] = useState('')
  const [searchMode, setSearchMode] = useState<'name' | 'author'>('name')
  const [broad, setBroad] = useState(false)
  const [publishingAddr, setPublishingAddr] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(10)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    discoverEmojiSets(100, broad).then(async (found) => {
      const sizeChecks = await Promise.all(found.map(async (s) => {
        const oversized = await hasOversizedEmoji(s.emojis)
        return oversized ? null : s
      }))
      setDiscovered(sizeChecks.filter((s): s is EmojiSet => s !== null))
    }).catch((err) => {
      console.error('Failed to discover emoji sets:', err)
    }).finally(() => setLoading(false))
  }, [myPubkey, broad])

  // Reset visible count when filters change
  useEffect(() => {
    setVisibleCount(10)
  }, [search, searchMode, broad])

  const filtered = useMemo(() => {
    let result = discovered.filter((s) => !blockedPubkeys.has(s.pubkey))

    // Apply NSFW filtering
    result = result.map((s) => ({
      ...s,
      emojis: filterNsfwEmojis(s.emojis),
    })).filter((s) => s.emojis.length > 0)

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      if (searchMode === 'author') {
        result = result.filter((s) => {
          const npub = nip19.npubEncode(s.pubkey)
          const profile = getProfile(s.pubkey)
          const name = profile?.display_name || profile?.name || ''
          return npub.includes(q) || name.toLowerCase().includes(q) || s.pubkey.includes(q)
        })
      } else {
        result = result.filter((s) =>
          s.name.toLowerCase().includes(q) || s.dTag.toLowerCase().includes(q)
        )
      }
    }
    return result
  }, [discovered, search, searchMode, getProfile, blockedPubkeys, nsfwEnabled, untaggedAsNsfw])

  const visibleSets = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const hasMore = visibleCount < filtered.length

  // IntersectionObserver to load more sets when sentinel comes into view
  useEffect(() => {
    const sentinel = sentinelRef.current
    const container = scrollContainerRef.current
    if (!sentinel || !container || !hasMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => prev + 10)
        }
      },
      { root: container, rootMargin: '100px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, filtered])

  const handleSubscribe = async (set: EmojiSet) => {
    const addr = `30030:${set.pubkey}:${set.dTag}`
    if (subscriptionAddresses.includes(addr)) return
    setPublishingAddr(addr)
    try {
      const updated = [...subscriptionAddresses, addr]
      await publishEmojiSubscriptions(updated, signer, privateKey)
      addSubscription(addr, set)
    } catch (err) {
      console.error('Failed to subscribe:', err)
    } finally {
      setPublishingAddr(null)
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Search toolbar with mode toggle + broad toggle */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[hsl(var(--border))] shrink-0">
        <div className="flex-1 relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchMode === 'author' ? 'Search by author...' : 'Search sets...'}
            className={`w-full h-7 pl-7 pr-2 rounded-md text-xs bg-[hsl(var(--muted)/0.3)] border border-[hsl(var(--border))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none ${searchMode === 'author' ? 'font-mono' : ''}`}
          />
        </div>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => { setSearchMode(searchMode === 'name' ? 'author' : 'name'); setSearch('') }}
                className={`p-1.5 rounded-md transition-colors cursor-pointer ${searchMode === 'author'
                  ? 'bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]'
                  : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted)/0.5)]'
                }`}
              >
                <Users size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs z-[310]">
              {searchMode === 'author' ? 'Switch to name search' : 'Search by author'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setBroad(!broad)}
                className={`px-1.5 py-1 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${broad
                  ? 'bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]'
                  : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted)/0.5)]'
                }`}
              >
                {broad ? 'Broad' : 'Strict'}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs z-[310]">
              {broad ? 'Using broad search (all emoji tags)' : 'Using strict search (NIP-30 only)'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-2 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={18} className="animate-spin text-[hsl(var(--muted-foreground))]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-[hsl(var(--muted-foreground))]">
            <p className="text-xs">{search ? 'No sets found' : 'No emoji sets discovered'}</p>
            <p className="text-[10px] mt-1 opacity-60">Try again later as more users publish emoji sets.</p>
          </div>
        ) : (
          <>
            {visibleSets.map((set) => {
              const addr = `30030:${set.pubkey}:${set.dTag}`
              const isSubscribed = subscriptionAddresses.includes(addr)
              const isPublishing = publishingAddr === addr
              const profile = getProfile(set.pubkey)
              const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(set.pubkey))

              return (
                <div key={addr} className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--secondary)/0.2)] p-2">
                  <div className="flex items-center justify-between mb-1">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-[hsl(var(--foreground))] truncate">{set.name}</p>
                      <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
                        by <button onClick={() => { window.dispatchEvent(new CustomEvent('open-profile-modal', { detail: set.pubkey })); onPickerClose?.() }} className="text-[hsl(var(--primary))] hover:underline cursor-pointer">{authorName}</button> · {set.emojis.length} emoji{set.emojis.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                    {isSubscribed ? (
                      <span className="text-[10px] text-[hsl(var(--primary))] font-medium shrink-0 flex items-center gap-1">
                        <Check size={10} /> Subscribed
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSubscribe(set)}
                        disabled={isPublishing}
                        className="shrink-0 px-2.5 py-1 rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-[10px] font-medium disabled:opacity-50 cursor-pointer"
                      >
                        {isPublishing ? <Loader2 size={10} className="animate-spin" /> : 'Subscribe'}
                      </button>
                    )}
                  </div>
                  {/* Preview grid */}
                  <div className="flex flex-wrap gap-0.5">
                    {set.emojis.slice(0, 12).map((e) => (
                      <TooltipProvider key={e.shortcode} delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <img src={e.url} alt={`:${e.shortcode}:`} className="w-6 h-6 object-contain rounded" loading="lazy" />
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs z-[310]">:{e.shortcode}:</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ))}
                    {set.emojis.length > 12 && (
                      <span className="w-6 h-6 flex items-center justify-center text-[9px] text-[hsl(var(--muted-foreground))] font-medium">
                        +{set.emojis.length - 12}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
            {/* Scroll sentinel + load-more indicator */}
            {hasMore && (
              <div ref={sentinelRef} className="flex items-center justify-center py-3">
                <Loader2 size={14} className="animate-spin text-[hsl(var(--muted-foreground))]" />
                <span className="ml-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">Loading more…</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Discovery Modal ───

export function EmojiDiscoveryModal({ onClose, initialSearch = '', initialAuthor = '' }: { onClose: () => void; initialSearch?: string; initialAuthor?: string }) {
  const [sets, setSets] = useState<EmojiSet[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState(initialSearch)
  const [authorFilter, setAuthorFilter] = useState(initialAuthor)
  const [broad, setBroad] = useState(false)
  const subscriptionAddresses = useEmojiStore((s) => s.subscriptionAddresses)
  const addSubscription = useEmojiStore((s) => s.addSubscription)
  const removeSubscription = useEmojiStore((s) => s.removeSubscription)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const [publishingAddr, setPublishingAddr] = useState<string | null>(null)
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null)
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)
  const [visibleCount, setVisibleCount] = useState(10)
  const modalSentinelRef = useRef<HTMLDivElement>(null)
  const modalScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)

    // When opened with an initial author (e.g. from "Find this set"), do a targeted
    // fetch for that author's sets in parallel with the generic discovery query.
    // This ensures the specific set is always found even if it's not in the top N results.
    let authorPubkey: string | null = null
    if (initialAuthor) {
      try {
        if (initialAuthor.startsWith('npub1')) {
          const decoded = nip19.decode(initialAuthor)
          if (decoded.type === 'npub') authorPubkey = decoded.data as string
        } else {
          authorPubkey = initialAuthor // assume hex pubkey
        }
      } catch { /* ignore invalid npub */ }
    }

    const discoverPromise = discoverEmojiSets(100, broad)
    const authorPromise = authorPubkey ? fetchEmojiSetsByAuthor(authorPubkey).catch(() => [] as EmojiSet[]) : Promise.resolve([] as EmojiSet[])

    Promise.all([discoverPromise, authorPromise]).then(async ([discovered, authorSets]) => {
      // Merge author sets into discovered, deduplicating by pubkey:dTag
      const seen = new Set<string>()
      const merged: EmojiSet[] = []
      for (const s of [...authorSets, ...discovered]) {
        const key = `${s.pubkey}:${s.dTag}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(s)
      }
      // Filter out sets with any emoji > 1 MB
      const sizeChecks = await Promise.all(merged.map(async (s) => {
        const oversized = await hasOversizedEmoji(s.emojis)
        return oversized ? null : s
      }))
      setSets(sizeChecks.filter((s): s is EmojiSet => s !== null))
    }).catch((err) => {
      console.error('Failed to discover emoji sets:', err)
    }).finally(() => setLoading(false))
  }, [myPubkey, broad, initialAuthor])

  const filtered = useMemo(() => {
    let result = sets.filter((s) => !blockedPubkeys.has(s.pubkey))
    // Apply NSFW filtering
    result = result.map((s) => ({
      ...s,
      emojis: filterNsfwEmojis(s.emojis),
    })).filter((s) => s.emojis.length > 0)
    if (search) {
      const q = search.toLowerCase()
      result = result.filter((s) => s.name.toLowerCase().includes(q) || s.dTag.toLowerCase().includes(q) || s.emojis.some((e) => e.shortcode.toLowerCase().includes(q)))
    }
    if (authorFilter) {
      const a = authorFilter.toLowerCase().trim()
      result = result.filter((s) => {
        // Match by npub or hex pubkey
        const npub = nip19.npubEncode(s.pubkey).toLowerCase()
        if (npub.includes(a) || s.pubkey.toLowerCase().includes(a)) return true
        // Match by profile name
        const profile = getProfile(s.pubkey)
        const name = (profile?.display_name || profile?.name || '').toLowerCase()
        return name.includes(a)
      })
    }
    return result
  }, [sets, search, authorFilter, getProfile])

  // Reset visible count when filters change
  useEffect(() => {
    setVisibleCount(10)
  }, [search, authorFilter, broad])

  const visibleSets = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const hasMore = visibleCount < filtered.length

  // IntersectionObserver to load more sets when sentinel comes into view
  useEffect(() => {
    const sentinel = modalSentinelRef.current
    const container = modalScrollRef.current
    if (!sentinel || !container || !hasMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => prev + 10)
        }
      },
      { root: container, rootMargin: '100px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, filtered])

  const handleToggleSubscription = async (set: EmojiSet) => {
    const addr = `30030:${set.pubkey}:${set.dTag}`
    setPublishingAddr(addr)
    try {
      if (subscriptionAddresses.includes(addr)) {
        const newAddrs = subscriptionAddresses.filter((a) => a !== addr)
        await publishEmojiSubscriptions(newAddrs, signer, privateKey)
        removeSubscription(addr)
      } else {
        const newAddrs = [...subscriptionAddresses, addr]
        await publishEmojiSubscriptions(newAddrs, signer, privateKey)
        addSubscription(addr, set)
      }
    } catch (err) {
      console.error('Failed to update subscription:', err)
    } finally {
      setPublishingAddr(null)
    }
  }

  return (
    <>
      {createPortal(
        <div data-emoji-picker-portal className="fixed inset-0 z-[320] flex items-center justify-center bg-black/60 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
          <div
            className="w-full max-w-lg max-h-[80vh] flex flex-col bg-[hsl(var(--background))] rounded-xl border border-[hsl(var(--border))] shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))] bg-[hsl(var(--secondary)/0.3)] shrink-0">
              <div className="flex items-center gap-2">
                <Compass size={16} className="text-[hsl(var(--primary))]" />
                <span className="text-sm font-semibold text-[hsl(var(--foreground))]">Discover Emoji Sets</span>
              </div>
              <button onClick={onClose} className="p-1 rounded hover:bg-[hsl(var(--accent)/0.5)] transition-colors cursor-pointer">
                <X size={16} className="text-[hsl(var(--muted-foreground))]" />
              </button>
            </div>

            {/* Search + author filter + broad toggle */}
            <div className="px-4 py-4 border-b border-[hsl(var(--border))] space-y-3">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search sets..."
                  className="w-full h-8 pl-8 pr-3 rounded-lg text-sm bg-[hsl(var(--muted)/0.3)] border border-[hsl(var(--border))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none"
                  autoFocus
                />
              </div>
              <div className="relative">
                <Users size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
                <input
                  value={authorFilter}
                  onChange={(e) => setAuthorFilter(e.target.value)}
                  placeholder="Filter by author (npub, name)..."
                  className="w-full h-8 pl-8 pr-3 rounded-lg text-sm bg-[hsl(var(--muted)/0.3)] border border-[hsl(var(--border))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none font-mono text-xs"
                />
              </div>
              <div className="flex items-center gap-2 select-none">
                <button
                  onClick={() => setBroad(!broad)}
                  className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 cursor-pointer ${broad ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--muted-foreground)/0.3)]'}`}
                >
                  <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${broad ? 'left-[16px]' : 'left-[2px]'}`} />
                </button>
                <span className="text-xs text-[hsl(var(--muted-foreground))]">Broad search</span>
              </div>
            </div>

            {/* Content */}
            <div ref={modalScrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={20} className="animate-spin text-[hsl(var(--muted-foreground))]" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-[hsl(var(--muted-foreground))]">
                  <p className="text-sm">{search ? 'No sets found' : 'No emoji sets discovered'}</p>
                  <p className="text-xs mt-1 opacity-60">Try again later as more users publish their emoji sets.</p>
                </div>
              ) : (
                <>
                  {visibleSets.map((set) => {
                    const addr = `30030:${set.pubkey}:${set.dTag}`
                    const isSubscribed = subscriptionAddresses.includes(addr)
                    const isPublishing = publishingAddr === addr
                    const profile = getProfile(set.pubkey)
                    const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(set.pubkey))

                    return (
                      <div key={addr} className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--secondary)/0.2)] p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-[hsl(var(--foreground))] truncate">{set.name}</p>
                            <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
                              by <button onClick={() => setProfilePubkey(set.pubkey)} className="text-[hsl(var(--primary))] hover:underline cursor-pointer">{authorName}</button> · {set.emojis.length} emoji{set.emojis.length !== 1 ? 's' : ''}
                            </p>
                          </div>
                          <button
                            onClick={() => handleToggleSubscription(set)}
                            disabled={isPublishing}
                            className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer disabled:opacity-50 flex items-center gap-1.5 ${
                              isSubscribed
                                ? 'bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20'
                                : 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90'
                            }`}
                          >
                            {isPublishing ? <Loader2 size={11} className="animate-spin" /> : null}
                            {isSubscribed ? 'Unsubscribe' : 'Subscribe'}
                          </button>
                        </div>
                        {/* Emoji preview */}
                        <div className="flex flex-wrap gap-1 max-h-[60px] overflow-hidden">
                          {set.emojis.slice(0, 16).map((e) => (
                            <TooltipProvider key={e.shortcode} delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <img
                                    src={e.url}
                                    alt={`:${e.shortcode}:`}
                                    className="w-7 h-7 object-contain rounded"
                                    loading="lazy"
                                  />
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="text-xs z-[320]">:{e.shortcode}:</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ))}
                          {set.emojis.length > 16 && (
                            <span className="w-7 h-7 flex items-center justify-center text-[10px] text-[hsl(var(--muted-foreground))] font-medium">
                              +{set.emojis.length - 16}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {/* Scroll sentinel + load-more indicator */}
                  {hasMore && (
                    <div ref={modalSentinelRef} className="flex items-center justify-center py-3">
                      <Loader2 size={14} className="animate-spin text-[hsl(var(--muted-foreground))]" />
                      <span className="ml-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">Loading more…</span>
                    </div>
                  )}
                </>
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
