/**
 * ForumView — Reddit-style word communities (NIP-CHAT §20, Phase 1).
 *
 * Exposes two pages used by SocialFeedPage:
 *   - ForumFeedPage:  the active word community's post list (sort + vote + compose)
 *   - ForumThreadPage: a single post with its nested comments + reply composer
 *
 * Render-time filtering mirrors public chat: viewPow + blocks + WoT('forum') +
 * muted words.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSocialStore } from '@/stores/socialStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useForumStore, FORUM_DEFAULT_POW, MAX_FORUM_LIST } from '@/stores/forumStore'
import { useUserStore } from '@/stores/userStore'
import { useFollowStore } from '@/stores/followStore'
import { useBlockStore } from '@/stores/blockStore'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { useWotStore } from '@/stores/wotStore'
import { useDnnStore } from '@/stores/dnnStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import {
  sortPosts, encodeCommunityNaddr, decodeCommunityNaddr, parseCommunityAddress, communityAddress,
  parseForumWordPost, parseCommunityPost, parseForumComment, classifyReaction, reactionTargetId,
  type ForumPost, type ForumComment, type ForumSort, type CommunityDef, type WordProfile,
} from '@/lib/nostr/forum'
import { subscribeEvents, fetchEvents } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { uploadToBlossomServers, type UploadProgress } from '@/lib/blossom'
import { RichContent } from '@/components/social/RichContent'
import { RawEventModal } from '@/components/social/SocialPost'
import { NotificationList, type NotifItem } from '@/components/social/NotificationList'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import {
  ArrowBigUp, ArrowBigDown, MessageSquare, Loader2, ChevronLeft, Plus, MoreVertical, Code,
  Copy, Check, Shield, Star, Clock, Flame, TrendingUp, AlertTriangle,
  Newspaper, Bell, Users, ShieldCheck, Minus, X, Pencil, UserPlus, Trash2, Crown,
  Eye, EyeOff, RotateCcw, Upload, Filter, ImageOff, Link as LinkIcon, Sticker,
  Tag as TagIcon, Folder,
} from 'lucide-react'
import { cn, truncateNpub, formatTimestamp } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import type { SocialPage } from '@/stores/socialStore'

// ─── Rich body (media, mentions, embeds) ───

function ForumBody({ body, className }: { body: string; className?: string }) {
  const mutedWords = useBlockStore((s) => s.mutedWords)
  const setActiveProfile = useSocialStore((s) => s.setActiveProfile)
  // Content filters: per-forum toggle AND the global render preference.
  const showMedia = useForumStore((s) => s.showMedia) && usePreferencesStore((s) => s.showMedia)
  const showEmbeds = useForumStore((s) => s.showEmbeds) && usePreferencesStore((s) => s.showEmbeds)
  const showEmojis = useForumStore((s) => s.showCustomEmojis) && usePreferencesStore((s) => s.showCustomEmojis)
  if (!body.trim()) return null
  return (
    <div className={cn('text-sm text-foreground/90 break-words', className)}>
      <RichContent
        content={body}
        mutedWords={mutedWords}
        onOpenProfile={(pk) => setActiveProfile(pk)}
        disableMedia={!showMedia}
        disableEmbeds={!showEmbeds}
        disableCustomEmojis={!showEmojis}
      />
    </div>
  )
}

/** 3-dot menu for a forum post / comment — copy the event address (nevent) or view the raw event. */
function ForumEventMenu({ event, className }: { event: Event; className?: string }) {
  const [open, setOpen] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const copyAddress = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(nip19.neventEncode({ id: event.id, author: event.pubkey, kind: event.kind }))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={cn('relative shrink-0', className)} ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        className="p-1 rounded cursor-pointer text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent/50 transition-colors"
      >
        <MoreVertical size={14} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-48 bg-popover/95 backdrop-blur-md border border-border rounded-xl shadow-xl p-1 flex flex-col gap-1 z-50 animate-in fade-in-0 zoom-in-95"
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={copyAddress} className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md">
            <Copy size={13} /> {copied ? 'Copied!' : 'Copy Event Address'}
          </button>
          <button onClick={(e) => { e.stopPropagation(); setShowRaw(true); setOpen(false) }} className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md">
            <Code size={13} /> View Raw Event
          </button>
        </div>
      )}
      {showRaw && <RawEventModal rawJson={JSON.stringify(event)} onClose={() => setShowRaw(false)} />}
    </div>
  )
}

/** Short display label for a created community (its name, or a truncated naddr). */
function communityShortLabel(def: CommunityDef | undefined, address: string): string {
  if (def?.name) return def.name
  const coord = parseCommunityAddress(address)
  return coord ? `c/${truncateNpub(nip19.npubEncode(coord.pubkey), 6)}` : 'community'
}

// ─── Modal shell (portaled overlay card) ───

function ModalShell({ title, onClose, children, maxW = 'max-w-sm' }: { title: string; onClose: () => void; children: React.ReactNode; maxW?: string }) {
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={cn('w-full rounded-xl border border-border bg-card shadow-2xl', maxW)} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

// ─── PoW slider + control (icon+number button → modal) ───

function PowSlider({ value, onChange, max = 40 }: { value: number; onChange: (n: number) => void; max?: number }) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 relative h-5 flex items-center">
        <div className="absolute left-0 right-0 h-1 rounded-full bg-muted-foreground/20" />
        <div className="absolute left-0 h-1 rounded-full bg-amber-400 transition-all" style={{ width: `${pct}%` }} />
        <div className="absolute w-3 h-3 rounded-full bg-amber-400 border-2 border-background shadow pointer-events-none transition-all" style={{ left: `calc(${pct}% - 6px)` }} />
        <input type="range" min={0} max={max} value={value} onChange={(e) => onChange(parseInt(e.target.value, 10))} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
      </div>
      <div className="flex items-center h-7 rounded border border-input bg-background overflow-hidden">
        <button onClick={() => onChange(Math.max(0, value - 1))} className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer flex items-center"><Minus size={11} /></button>
        <span className="px-2 text-xs text-foreground tabular-nums min-w-[28px] text-center">{value}</span>
        <button onClick={() => onChange(Math.min(max, value + 1))} className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer flex items-center"><Plus size={11} /></button>
      </div>
    </div>
  )
}

function PowControl({ kind }: { kind: 'view' | 'publish' }) {
  const viewPow = useForumStore((s) => s.viewPow)
  const setViewPow = useForumStore((s) => s.setViewPow)
  const publishPow = useForumStore((s) => s.publishPow)
  const setPublishPow = useForumStore((s) => s.setPublishPow)
  const [open, setOpen] = useState(false)
  const value = kind === 'view' ? viewPow : publishPow
  const setValue = kind === 'view' ? setViewPow : setPublishPow
  const title = kind === 'view' ? 'Minimum view PoW' : 'Posting PoW'
  const desc = kind === 'view'
    ? 'Hide posts and comments whose proof-of-work is mined below this difficulty.'
    : 'Difficulty your posts and comments are mined to before publishing (higher = more spam-resistant, slower to post).'
  return (
    <>
      <Hint label={title}>
        <button onClick={() => setOpen(true)} className="flex items-center gap-1 h-7 px-2 rounded-full text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">
          <Shield size={12} /> {value}
        </button>
      </Hint>
      {open && (
        <ModalShell title={title} onClose={() => setOpen(false)}>
          <p className="text-xs text-muted-foreground mb-4 leading-relaxed">{desc}</p>
          <PowSlider value={value} onChange={setValue} />
          <div className="flex items-center justify-between mt-5">
            <button
              onClick={() => setValue(FORUM_DEFAULT_POW)}
              disabled={value === FORUM_DEFAULT_POW}
              className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
            >
              <RotateCcw size={12} /> Reset to default ({FORUM_DEFAULT_POW})
            </button>
            <button onClick={() => setOpen(false)} className="h-8 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer">Done</button>
          </div>
        </ModalShell>
      )}
    </>
  )
}

/** App-style tooltip wrapper (replaces native title= hovers). */
function Hint({ label, side = 'top', children }: { label: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className="text-xs">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ─── Shared: render-time filter (viewPow + blocks + WoT + muted words) ───

function useForumFilter() {
  const viewPow = useForumStore((s) => s.viewPow)
  const showNsfw = useForumStore((s) => s.showNsfw)
  const dnnOnly = useForumStore((s) => s.dnnOnly)
  const filterCategory = useForumStore((s) => s.filterCategory)
  const filterTags = useForumStore((s) => s.filterTags)
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)
  const mutedWords = useBlockStore((s) => s.mutedWords)
  const wotShouldHide = useWotStore((s) => s.shouldHide)
  const dnnVerified = useDnnStore((s) => s.verified)
  return useCallback(
    (item: { pubkey: string; pow: number; title?: string; body: string; nsfw?: boolean; category?: string; tags?: string[] }) => {
      if (item.pow < viewPow) return false
      if (item.nsfw && !showNsfw) return false
      if (blockedPubkeys.has(item.pubkey)) return false
      if (wotShouldHide(item.pubkey, 'forum')) return false
      if (dnnOnly && !dnnVerified[item.pubkey]) return false
      if (filterCategory && item.category !== filterCategory) return false
      if (filterTags.length > 0) {
        const itemTags = item.tags || []
        for (const t of filterTags) if (!itemTags.includes(t)) return false
      }
      if (mutedWords.size > 0) {
        const text = `${item.title || ''} ${item.body}`.toLowerCase()
        for (const w of mutedWords) if (w && text.includes(w.toLowerCase())) return false
      }
      return true
    },
    [viewPow, showNsfw, dnnOnly, filterCategory, filterTags, blockedPubkeys, mutedWords, wotShouldHide, dnnVerified],
  )
}

/** Renders nothing — triggers DNN verification for a post author so the dnn-only filter resolves. */
function DnnVerify({ pubkey }: { pubkey: string }) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(pubkey)
  const verifyPubkey = useDnnStore((s) => s.verifyPubkey)
  useEffect(() => { verifyPubkey(pubkey, profile?.nip05 as string | undefined) }, [pubkey, profile?.nip05, verifyPubkey])
  return null
}

// ─── Filter panel ───

function ForumToggle({ enabled, onToggle, icon, label, description, disabled }: {
  enabled: boolean; onToggle: (v: boolean) => void; icon: React.ReactNode; label: string; description: React.ReactNode; disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex items-start gap-2 min-w-0">
        <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{description}</div>
        </div>
      </div>
      <button
        onClick={() => !disabled && onToggle(!enabled)}
        disabled={disabled}
        className={cn('relative w-10 h-[22px] rounded-full transition-colors shrink-0',
          disabled ? 'bg-muted-foreground/20 cursor-not-allowed' : enabled ? 'bg-primary cursor-pointer' : 'bg-muted-foreground/30 cursor-pointer')}
      >
        <div className={cn('absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform', enabled ? 'translate-x-[22px]' : 'translate-x-[3px]')} />
      </button>
    </div>
  )
}

function ForumSettingsModal({ onClose }: { onClose: () => void }) {
  const showMedia = useForumStore((s) => s.showMedia)
  const setShowMedia = useForumStore((s) => s.setShowMedia)
  const showEmbeds = useForumStore((s) => s.showEmbeds)
  const setShowEmbeds = useForumStore((s) => s.setShowEmbeds)
  const showCustomEmojis = useForumStore((s) => s.showCustomEmojis)
  const setShowCustomEmojis = useForumStore((s) => s.setShowCustomEmojis)
  const dnnOnly = useForumStore((s) => s.dnnOnly)
  const setDnnOnly = useForumStore((s) => s.setDnnOnly)
  const showNsfw = useForumStore((s) => s.showNsfw)
  const setShowNsfw = useForumStore((s) => s.setShowNsfw)
  const gMedia = usePreferencesStore((s) => s.showMedia)
  const gEmbeds = usePreferencesStore((s) => s.showEmbeds)
  const gEmojis = usePreferencesStore((s) => s.showCustomEmojis)

  const gotoModeration = () => {
    onClose()
    useNavigationStore.getState().setSettingsTab('moderation')
    useNavigationStore.getState().setActivePage('settings')
  }
  const globalLink = (
    <span>Disabled globally. <button onClick={gotoModeration} className="text-primary hover:underline cursor-pointer">Enable in Settings → Moderation</button></span>
  )

  return (
    <ModalShell title="Forum Filters" onClose={onClose} maxW="max-w-md">
      <div className="space-y-3">
        {/* Content filters */}
        <div>
          <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5"><Eye size={14} className="text-blue-400" /> Content Filters</label>
          <p className="text-xs text-muted-foreground mb-1">Control what's rendered in forum posts. Disabled content shows a placeholder.</p>
          <div className="flex flex-col divide-y divide-border/50">
            <ForumToggle enabled={gMedia && showMedia} onToggle={setShowMedia} disabled={!gMedia} icon={<ImageOff size={14} />} label="Show Media" description={gMedia ? 'Render images, video, and audio inline' : globalLink} />
            <ForumToggle enabled={gEmbeds && showEmbeds} onToggle={setShowEmbeds} disabled={!gEmbeds} icon={<LinkIcon size={14} />} label="Show Link Previews & Embeds" description={gEmbeds ? 'Render link preview cards and media embeds for URLs' : globalLink} />
            <ForumToggle enabled={gEmojis && showCustomEmojis} onToggle={setShowCustomEmojis} disabled={!gEmojis} icon={<Sticker size={14} />} label="Show Custom Emojis" description={gEmojis ? 'Render custom emoji images in text' : globalLink} />
          </div>
        </div>

        {/* Audience */}
        <div className="flex flex-col divide-y divide-border/50 border-t border-border/50 pt-1">
          <ForumToggle enabled={dnnOnly} onToggle={setDnnOnly} icon={<ShieldCheck size={14} />} label="DNN ID holders only" description="Only show posts from authors with a verified DNN ID" />
          <ForumToggle enabled={showNsfw} onToggle={setShowNsfw} icon={<EyeOff size={14} />} label="Show NSFW" description="Show posts marked with a content warning" />
        </div>

        {/* Proof of Work */}
        <div className="border-t border-border/50 pt-3">
          <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5"><Shield size={14} className="text-amber-400" /> Proof of Work</label>
          <p className="text-xs text-muted-foreground mb-2">Hide posts whose ID proof-of-work is below this threshold.</p>
          <PowControl kind="view" />
        </div>

        <p className="text-[11px] text-muted-foreground/70 border-t border-border/50 pt-3">
          Web of Trust and muted-word filtering follow your <button onClick={gotoModeration} className="text-primary hover:underline cursor-pointer">Settings → Moderation</button> preferences.
        </p>
      </div>
    </ModalShell>
  )
}

function useAuthor(pubkey: string) {
  const { getProfile } = useProfileCache()
  const p = getProfile(pubkey)
  const name = p?.display_name || p?.name || truncateNpub(nip19.npubEncode(pubkey), 8)
  return { name, picture: p?.picture as string | undefined }
}

// ─── Vote box (up/down) ───

function VoteBox({ target, layout = 'col' }: { target: { id: string; pubkey: string }; layout?: 'col' | 'row' }) {
  const s = useForumStore((st) => st.sentimentByTarget[target.id])
  const react = useForumStore((st) => st.react)
  const score = (s?.positive ?? 0) - (s?.negative ?? 0)
  const mine = s?.mine
  return (
    <div className={cn('flex items-center gap-0.5 text-muted-foreground select-none', layout === 'col' ? 'flex-col' : 'flex-row')}>
      <Hint label="Upvote">
        <button
          onClick={() => react(target, '+')}
          className={cn('p-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer', mine === 'positive' && 'text-emerald-500')}
        >
          <ArrowBigUp size={20} className={mine === 'positive' ? 'fill-current' : ''} />
        </button>
      </Hint>
      <span className={cn('text-xs font-semibold tabular-nums', score > 0 ? 'text-emerald-500' : score < 0 ? 'text-destructive' : 'text-foreground')}>
        {score}
      </span>
      <Hint label="Downvote">
        <button
          onClick={() => react(target, '-')}
          className={cn('p-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer', mine === 'negative' && 'text-destructive')}
        >
          <ArrowBigDown size={20} className={mine === 'negative' ? 'fill-current' : ''} />
        </button>
      </Hint>
    </div>
  )
}

// ─── Copyable handle ───

function CopyHandle({ handle }: { handle: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Hint label={`Copy ${handle}`}>
      <button
        onClick={() => { navigator.clipboard?.writeText(handle).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}
        className="inline-flex items-center gap-1 min-w-0 max-w-full text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <span className="font-mono truncate">{handle}</span>
        {copied ? <Check size={12} className="shrink-0 text-emerald-500" /> : <Copy size={12} className="shrink-0" />}
      </button>
    </Hint>
  )
}

// ─── Post composer ───

const MAX_POST_TAGS = 10

function PostComposer({ onSubmit, onCancel }: {
  onSubmit: (title: string, body: string, opts: { nsfw: boolean; category?: string; tags?: string[] }) => Promise<boolean>
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [nsfw, setNsfw] = useState(false)
  const [category, setCategory] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  const addTag = (raw: string) => {
    const v = raw.trim().toLowerCase()
    if (!v) return
    setTags((cur) => (cur.includes(v) || cur.length >= MAX_POST_TAGS ? cur : [...cur, v]))
    setTagDraft('')
  }
  const onTagKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagDraft) }
    else if (e.key === 'Backspace' && !tagDraft && tags.length) setTags((cur) => cur.slice(0, -1))
  }

  const submit = async () => {
    if (!title.trim() || posting) return
    setPosting(true)
    setPostError(null)
    try {
      const ok = await onSubmit(title, body, { nsfw, category: category.trim() || undefined, tags: tags.length ? tags : undefined })
      if (ok) onCancel()
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Failed to post. Please try again.')
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        className="w-full h-9 px-3 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
        autoFocus
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Body (optional). Links, images, nostr: refs supported"
        rows={4}
        className="w-full px-3 py-2 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none resize-y"
      />
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category (optional)"
          className="sm:w-44 h-9 px-3 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <div className="flex-1 min-w-0 rounded-md bg-muted/30 border border-border px-2 py-1.5 flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded text-xs bg-accent/60 text-foreground">
              {t}
              <button onClick={() => setTags((cur) => cur.filter((x) => x !== t))} className="hover:text-red-400 cursor-pointer"><X size={12} /></button>
            </span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={onTagKey}
            onBlur={() => addTag(tagDraft)}
            disabled={tags.length >= MAX_POST_TAGS}
            placeholder={tags.length >= MAX_POST_TAGS ? `Max ${MAX_POST_TAGS} tags` : tags.length ? 'Add tag…' : 'Tags (optional, Enter to add)'}
            className="flex-1 min-w-[8rem] h-6 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
          />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <button
          onClick={() => setNsfw((v) => !v)}
          className={cn('px-2.5 h-8 rounded-md text-xs font-medium border transition-colors cursor-pointer',
            nsfw ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-muted/30 text-muted-foreground border-border')}
        >
          {nsfw ? 'NSFW' : 'SFW'}
        </button>
        <div className="flex items-center gap-2">
          <PowControl kind="publish" />
          <button onClick={onCancel} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">Cancel</button>
          <button
            onClick={submit}
            disabled={!title.trim() || posting}
            className="h-8 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
          >
            {posting ? <><Loader2 size={14} className="animate-spin" /> Posting…</> : 'Post'}
          </button>
        </div>
      </div>
      {postError && <p className="text-xs text-red-400">{postError}</p>}
    </div>
  )
}

// ─── Post row (in the feed list) ───

function PostRow({ post, onOpen, showSource }: { post: ForumPost; onOpen: () => void; showSource?: boolean }) {
  const { name, picture } = useAuthor(post.pubkey)
  const comments = useForumStore((s) => s.commentsByPost[post.id])
  const commentCount = useForumStore((s) => s.commentCounts[post.id])
  const commDef = useForumStore((s) => (post.community ? s.communitiesByAddress[post.community] : undefined))
  const sourceLabel = post.word ? `w/${post.word}` : post.community ? communityShortLabel(commDef, post.community) : ''
  return (
    <div className="flex gap-2 rounded-xl border border-border bg-card hover:border-border/80 transition-colors">
      <div className="pl-2 py-2 shrink-0"><VoteBox target={post} /></div>
      <button onClick={onOpen} className="flex-1 min-w-0 text-left py-2 pr-3 cursor-pointer">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-0.5">
          {showSource && sourceLabel && <span className="font-medium text-primary truncate">{sourceLabel}</span>}
          {showSource && sourceLabel && <span>·</span>}
          <Avatar className="h-4 w-4"><AvatarImage src={picture} /><AvatarFallback className="text-[8px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
          <span className="truncate">{name}</span>
          <span>· {formatTimestamp(post.createdAt)}</span>
          {post.nsfw && <span className="px-1 rounded bg-red-500/20 text-red-400 text-[9px] font-semibold">NSFW</span>}
        </div>
        <h3 className="text-sm font-semibold text-foreground leading-snug">{post.title}</h3>
        {post.body && <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 whitespace-pre-wrap">{post.body}</p>}
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-1.5">
          <MessageSquare size={12} /> {comments?.length ?? commentCount ?? 0} comments
          {post.category && (
            <span className="ml-auto inline-flex items-center gap-1 max-w-[45%] pl-1.5 pr-2 h-5 rounded-full bg-amber-500/15 text-amber-500 font-medium">
              <Folder size={11} className="shrink-0" /> <span className="truncate">{post.category}</span>
            </span>
          )}
        </div>
      </button>
      <ForumEventMenu event={post.raw} className="py-2 pr-2" />
    </div>
  )
}

// ─── Left sidebar nav (Feed / Notifications) ───

const FORUM_NAV: { page: SocialPage; label: string; icon: React.ReactNode }[] = [
  { page: 'forum-feed', label: 'Feed', icon: <Newspaper size={18} /> },
  { page: 'forum-notifications', label: 'Notifications', icon: <Bell size={18} /> },
]

export function ForumNav() {
  const activePage = useSocialStore((s) => s.activePage)
  const openForumFeed = useSocialStore((s) => s.openForumFeed)
  const setActivePage = useSocialStore((s) => s.setActivePage)
  // forum-feed is "active" for both the home feed and a specific word community.
  const feedActive = activePage === 'forum-feed' || activePage === 'forum-thread'
  return (
    <div className="flex flex-col gap-0.5">
      {FORUM_NAV.map((item) => {
        const active = item.page === 'forum-feed' ? feedActive : activePage === item.page
        return (
          <button
            key={item.page}
            onClick={() => (item.page === 'forum-feed' ? openForumFeed() : setActivePage(item.page))}
            className={cn('flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer',
              active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50')}
          >
            {item.icon}{item.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Notifications ───

type ForumNotifItem = NotifItem & { scope: 'open' | 'moderated' }

export function ForumNotificationsPage() {
  const myPubkey = useUserStore((s) => s.pubkey)
  const openThread = useSocialStore((s) => s.setActiveForumThread)
  const wotShouldHide = useWotStore((s) => s.shouldHide)
  const [tab, setTab] = useState<'open' | 'moderated'>('open')
  const [items, setItems] = useState<ForumNotifItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!myPubkey) { setLoading(false); return }
    let cancelled = false
    const scopeOf = (ev: Event): { scope: 'open' | 'moderated'; postId: string } | null =>
      parseForumWordPost(ev) ? { scope: 'open', postId: ev.id } : parseCommunityPost(ev) ? { scope: 'moderated', postId: ev.id } : null

    ;(async () => {
      setLoading(true)
      try {
        const [reactions, replies] = await Promise.all([
          fetchEvents({ kinds: [7], '#p': [myPubkey], limit: 200 }),
          fetchEvents({ kinds: [KINDS.FORUM_POST], '#p': [myPubkey], limit: 200 }),
        ])
        // Resolve reaction targets + reply roots (by event id).
        const ids = new Set<string>()
        for (const r of reactions) { if (r.pubkey === myPubkey) continue; const t = reactionTargetId(r); if (t) ids.add(t) }
        for (const rep of replies) { if (rep.pubkey === myPubkey) continue; const root = rep.tags.find((t) => t[0] === 'E')?.[1] || rep.tags.find((t) => t[0] === 'e')?.[1]; if (root) ids.add(root) }
        const resolved = ids.size ? await fetchEvents({ ids: [...ids].slice(0, 300) }) : []
        const map = new Map(resolved.map((e) => [e.id, e]))
        // Reaction targets that are comments → resolve their root posts for scope.
        const second = new Set<string>()
        for (const r of reactions) {
          const t = reactionTargetId(r); if (!t) continue
          const ev = map.get(t); if (!ev || scopeOf(ev)) continue
          const c = parseForumComment(ev); if (c?.rootId && !map.has(c.rootId)) second.add(c.rootId)
        }
        if (second.size) { const more = await fetchEvents({ ids: [...second].slice(0, 300) }); for (const e of more) map.set(e.id, e) }

        const out: ForumNotifItem[] = []
        for (const r of reactions) {
          if (r.pubkey === myPubkey || wotShouldHide(r.pubkey, 'forum')) continue
          const t = reactionTargetId(r); if (!t) continue
          const ev = map.get(t); if (!ev) continue
          let s = scopeOf(ev)
          if (!s) { const c = parseForumComment(ev); if (c?.rootId) { const root = map.get(c.rootId); if (root) s = scopeOf(root) } }
          if (!s) continue
          const postId = s.postId
          out.push({ id: r.id, type: 'reaction', actor: r.pubkey, createdAt: r.created_at, bucket: classifyReaction(r.content), scope: s.scope, onOpen: () => openThread(postId) })
        }
        for (const rep of replies) {
          if (rep.pubkey === myPubkey || wotShouldHide(rep.pubkey, 'forum')) continue
          if (!parseForumComment(rep)) continue
          const rootId = rep.tags.find((t) => t[0] === 'E')?.[1] || rep.tags.find((t) => t[0] === 'e')?.[1]
          if (!rootId) continue
          const root = map.get(rootId); if (!root) continue
          const s = scopeOf(root); if (!s) continue
          const postId = s.postId
          out.push({ id: rep.id, type: 'reply', actor: rep.pubkey, createdAt: rep.created_at, body: rep.content, scope: s.scope, onOpen: () => openThread(postId) })
        }
        if (!cancelled) setItems(out)
      } catch (e) {
        console.error('[forum] notifications failed:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [myPubkey, openThread, wotShouldHide])

  const tabItems = useMemo(() => items.filter((i) => i.scope === tab), [items, tab])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[680px] px-4 py-3 space-y-3">
        <div className="flex justify-center">
          <div className="inline-flex gap-1 p-1 rounded-xl bg-card border border-border">
            {(['open', 'moderated'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn('px-6 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer', tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {t === 'open' ? 'Open' : 'Moderated'}
              </button>
            ))}
          </div>
        </div>
        <NotificationList items={tabItems} loading={loading} emptyHint={tab === 'open' ? 'No reactions or replies in your open communities yet.' : 'No reactions or replies in your created/joined communities yet.'} />
      </div>
    </div>
  )
}

// ─── Right rail (go-to + your communities + discover) ───

/** Thumbnail for a word community: its profile picture, or a letter fallback. */
function WordAvatar({ word }: { word: string }) {
  const pic = useForumStore((s) => s.wordProfiles[word]?.picture)
  return pic
    ? <BlossomImage src={pic} className="h-5 w-5 rounded bg-secondary/50 shrink-0" />
    : <span className="h-5 w-5 rounded bg-secondary/50 shrink-0 flex items-center justify-center text-[9px] font-semibold text-muted-foreground uppercase">{word.slice(0, 1)}</span>
}

/** Thumbnail for a created community: its icon, or a default. */
function CommunityAvatar({ address }: { address: string }) {
  const img = useForumStore((s) => s.communitiesByAddress[address]?.image)
  return img
    ? <BlossomImage src={img} className="h-5 w-5 rounded bg-secondary/50 shrink-0" />
    : <span className="h-5 w-5 rounded bg-secondary/50 shrink-0 flex items-center justify-center"><Users size={11} className="text-muted-foreground" /></span>
}

function ForumRightRail({ tab }: { tab: 'open' | 'moderated' }) {
  return (
    <aside className="w-[300px] shrink-0 hidden lg:block overflow-y-auto p-3">
      <div className="rounded-xl border border-border bg-card p-3 flex flex-col gap-4">
        {tab === 'moderated' ? <CommunityRail /> : <WordRail />}
      </div>
    </aside>
  )
}

function WordRail() {
  const setActiveForumWord = useSocialStore((s) => s.setActiveForumWord)
  const activeWord = useSocialStore((s) => s.activeForumWord)
  const myPubkey = useUserStore((s) => s.pubkey)
  const followedPubkeys = useFollowStore((s) => s.followedPubkeys)
  const { followedWords, followedLoaded, loadFollowedWords, discoverWords, discoverLoading, discoverDone, loadDiscoverWords, fetchWordProfilesBatch } = useForumStore()
  const [input, setInput] = useState('')

  const follows = useMemo(() => [...followedPubkeys], [followedPubkeys])
  const discoverStarted = useRef(false)

  useEffect(() => { if (myPubkey && !followedLoaded) loadFollowedWords(myPubkey) }, [myPubkey, followedLoaded, loadFollowedWords])
  useEffect(() => {
    if (!discoverStarted.current && follows.length > 0) { discoverStarted.current = true; loadDiscoverWords(follows, true) }
  }, [follows, loadDiscoverWords])
  // Resolve appearance thumbnails for the words shown in the rail.
  useEffect(() => { if (followedWords.length) fetchWordProfilesBatch(followedWords) }, [followedWords, fetchWordProfilesBatch])
  useEffect(() => { if (discoverWords.length) fetchWordProfilesBatch(discoverWords.map((d) => d.word)) }, [discoverWords, fetchWordProfilesBatch])

  const go = () => {
    const w = input.trim().toLowerCase().replace(/^w\//, '')
    if (w) { setActiveForumWord(w); setInput('') }
  }

  return (
    <>
      <div className="flex gap-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
          placeholder="go to w/word…"
          className="flex-1 h-9 px-3 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <button onClick={go} className="h-9 px-3 rounded-md bg-primary/15 text-primary text-sm font-medium cursor-pointer hover:bg-primary/25 transition-colors">Go</button>
      </div>

      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1">Followed communities</p>
        {followedWords.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">Follow a community to pin it here.</p>
        ) : followedWords.map((w) => (
          <button
            key={w}
            onClick={() => setActiveForumWord(w)}
            className={cn('w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors',
              activeWord === w ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50')}
          >
            <WordAvatar word={w} />
            <span className="truncate">w/{w}</span>
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1">From people you follow</p>
        {discoverWords.length === 0 && !discoverLoading ? (
          <p className="px-1 text-xs text-muted-foreground">Communities your follows follow will show here.</p>
        ) : (
          discoverWords.map((d) => (
            <button
              key={d.word}
              onClick={() => setActiveForumWord(d.word)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
            >
              <WordAvatar word={d.word} />
              <span className="truncate flex-1">w/{d.word}</span>
              <Hint label={`${d.count} of your follows`}><span className="text-[10px] text-muted-foreground/60 shrink-0">{d.count}</span></Hint>
            </button>
          ))
        )}
        {discoverLoading ? (
          <div className="flex justify-center py-2"><Loader2 size={14} className="animate-spin text-muted-foreground" /></div>
        ) : !discoverDone && follows.length > 0 ? (
          <button onClick={() => loadDiscoverWords(follows)} className="w-full h-8 rounded-md border border-dashed border-border text-xs text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors cursor-pointer">Load more</button>
        ) : null}
      </div>
    </>
  )
}

function CommunityRail() {
  const myPubkey = useUserStore((s) => s.pubkey)
  const activeCommunity = useSocialStore((s) => s.activeForumCommunity)
  const setActiveCommunity = useSocialStore((s) => s.setActiveForumCommunity)
  const { joinedCommunities, joinedCommunitiesLoaded, loadJoinedCommunities, myCreatedCommunities, myCreatedLoaded, loadMyCreatedCommunities, communitiesByAddress, fetchCommunity, communityDiscovery, communityDiscoveryLoaded, fetchCommunityDiscovery } = useForumStore()
  const [naddrInput, setNaddrInput] = useState('')
  const [naddrError, setNaddrError] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => { if (myPubkey && !joinedCommunitiesLoaded) loadJoinedCommunities(myPubkey) }, [myPubkey, joinedCommunitiesLoaded, loadJoinedCommunities])
  useEffect(() => { if (myPubkey && !myCreatedLoaded) loadMyCreatedCommunities(myPubkey) }, [myPubkey, myCreatedLoaded, loadMyCreatedCommunities])
  useEffect(() => { if (!communityDiscoveryLoaded) fetchCommunityDiscovery() }, [communityDiscoveryLoaded, fetchCommunityDiscovery])
  // Resolve names for joined communities.
  useEffect(() => { joinedCommunities.forEach((a) => { if (!communitiesByAddress[a]) fetchCommunity(a) }) }, [joinedCommunities, communitiesByAddress, fetchCommunity])

  const showNsfw = useForumStore((s) => s.showNsfw)
  const wotShouldHide = useWotStore((s) => s.shouldHide)
  const createdSet = useMemo(() => new Set(myCreatedCommunities), [myCreatedCommunities])
  // Joined = communities you're in (10004) that you didn't create.
  const joinedOnly = useMemo(() => joinedCommunities.filter((a) => !createdSet.has(a)), [joinedCommunities, createdSet])
  const mineSet = useMemo(() => new Set([...joinedCommunities, ...myCreatedCommunities]), [joinedCommunities, myCreatedCommunities])
  // Hide communities whose creator is below the WoT threshold (forum context).
  const discover = useMemo(
    () => communityDiscovery.filter((d) => !mineSet.has(d.address) && (showNsfw || !d.nsfw) && !wotShouldHide(d.pubkey, 'forum')).slice(0, 20),
    [communityDiscovery, mineSet, showNsfw, wotShouldHide],
  )

  const openNaddr = () => {
    const decoded = decodeCommunityNaddr(naddrInput)
    if (!decoded) { setNaddrError(true); return }
    setActiveCommunity(communityAddress(decoded.pubkey, decoded.dTag))
    setNaddrInput(''); setNaddrError(false)
  }

  return (
    <>
      <button onClick={() => setCreating(true)} className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium cursor-pointer hover:bg-primary/90 transition-colors flex items-center justify-center gap-1.5">
        <Plus size={15} /> Create community
      </button>
      {creating && <CreateCommunityModal onDone={() => setCreating(false)} />}

      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1">Open by handle</p>
        <div className="flex gap-1.5">
          <input
            value={naddrInput}
            onChange={(e) => { setNaddrInput(e.target.value); setNaddrError(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') openNaddr() }}
            placeholder="c/naddr1…"
            className={cn('flex-1 h-9 px-3 rounded-md text-sm bg-muted/30 border text-foreground placeholder:text-muted-foreground focus:outline-none', naddrError ? 'border-destructive' : 'border-border')}
          />
          <button onClick={openNaddr} className="h-9 px-3 rounded-md bg-primary/15 text-primary text-sm font-medium cursor-pointer hover:bg-primary/25 transition-colors">Go</button>
        </div>
        {naddrError && <p className="px-1 text-[11px] text-destructive">Not a valid community naddr.</p>}
      </div>

      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1">Created communities</p>
        {myCreatedCommunities.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">Communities you create appear here.</p>
        ) : myCreatedCommunities.map((a) => (
          <button
            key={a}
            onClick={() => setActiveCommunity(a)}
            className={cn('w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors',
              activeCommunity === a ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50')}
          >
            <CommunityAvatar address={a} />
            <span className="truncate">{communityShortLabel(communitiesByAddress[a], a)}</span>
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1">Joined communities</p>
        {joinedOnly.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">Join a community to pin it here.</p>
        ) : joinedOnly.map((a) => (
          <button
            key={a}
            onClick={() => setActiveCommunity(a)}
            className={cn('w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors',
              activeCommunity === a ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50')}
          >
            <CommunityAvatar address={a} />
            <span className="truncate">{communityShortLabel(communitiesByAddress[a], a)}</span>
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1">Discover</p>
        {!communityDiscoveryLoaded ? (
          <div className="flex justify-center py-2"><Loader2 size={14} className="animate-spin text-muted-foreground" /></div>
        ) : discover.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No other communities found yet.</p>
        ) : discover.map((d) => (
          <button
            key={d.address}
            onClick={() => setActiveCommunity(d.address)}
            className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-md text-sm cursor-pointer text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
          >
            <BlossomImage src={d.image} className="h-5 w-5 rounded bg-secondary/50 shrink-0" fallback={<span className="h-5 w-5 rounded bg-secondary/50 shrink-0 flex items-center justify-center"><Users size={11} className="text-muted-foreground" /></span>} />
            <span className="truncate">{d.name}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/** Labeled field wrapper for the community modals. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
    </div>
  )
}

function NsfwSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)} className="flex items-center justify-between w-full px-3 py-2 rounded-md bg-muted/20 border border-border cursor-pointer text-left">
      <div>
        <p className="text-sm text-foreground">NSFW community</p>
        <p className="text-[11px] text-muted-foreground">Mark if this community contains adult content.</p>
      </div>
      <span className={cn('relative h-5 w-9 rounded-full transition-colors shrink-0', value ? 'bg-red-500' : 'bg-muted-foreground/30')}>
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', value ? 'left-4' : 'left-0.5')} />
      </span>
    </button>
  )
}

const fieldInput = 'w-full h-9 px-3 rounded-md text-sm bg-muted/30 border border-border focus:outline-none'

/** Drag-drop media upload to Blossom (size limit + progress + multi-server), yields a hash URL. */
function MediaUploadField({ value, onChange, aspect, label }: {
  value: string
  onChange: (url: string) => void
  aspect: 'square' | 'wide'
  label: string
}) {
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const [status, setStatus] = useState<'idle' | 'uploading' | 'error'>('idle')
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [localPreview, setLocalPreview] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const upload = async (file: File) => {
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    if (file.size > limitMb * 1024 * 1024) { setStatus('error'); return }
    setStatus('uploading'); setProgress(null)
    const preview = URL.createObjectURL(file); setLocalPreview(preview)
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const { hash, serverUrls } = await uploadToBlossomServers(
        data, signer, privateKey, undefined, file.type,
        (p) => setProgress({ ...p }),
        () => { const c = new AbortController(); abortRef.current = c; return c.signal },
      )
      if (serverUrls?.length) { onChange(`${serverUrls[0]}/${hash}`); setStatus('idle') }
      else setStatus('error')
    } catch {
      setStatus('error')
    } finally {
      setProgress(null); abortRef.current = null
      URL.revokeObjectURL(preview); setLocalPreview(null)
    }
  }

  const onFile = (f?: File | null) => { if (f && f.type.startsWith('image/')) upload(f) }
  const box = aspect === 'wide' ? 'h-28 w-full' : 'h-24 w-24'

  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{label}</label>
      <div
        onClick={() => status !== 'uploading' && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={(e) => { e.preventDefault(); setDragOver(false) }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); onFile(e.dataTransfer.files?.[0]) }}
        className={cn('relative rounded-lg border-2 border-dashed overflow-hidden flex items-center justify-center cursor-pointer transition-colors', box,
          dragOver ? 'border-primary bg-primary/5' : 'border-border bg-muted/20 hover:border-border/80')}
      >
        {status === 'uploading' ? (
          <div className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground text-center px-1">
            <Loader2 size={16} className="animate-spin" />
            <span>{progress ? `${progress.percent}% · server ${progress.serverIndex + 1}/${progress.totalServers}` : 'Uploading…'}</span>
          </div>
        ) : (localPreview || value) ? (
          <>
            {localPreview
              ? <img src={localPreview} className="h-full w-full object-cover" alt="" />
              : <BlossomImage src={value} className="h-full w-full" />}
            <button onClick={(e) => { e.stopPropagation(); onChange('') }} className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 cursor-pointer"><X size={13} /></button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground text-center px-1">
            <Upload size={16} />
            <span>Drop or click to upload</span>
          </div>
        )}
      </div>
      {status === 'error' && <p className="text-[11px] text-destructive">Upload failed. Check the size limit and try again.</p>}
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
    </div>
  )
}

function CreateCommunityModal({ onDone }: { onDone: () => void }) {
  const createCommunity = useForumStore((s) => s.createCommunity)
  const setActiveCommunity = useSocialStore((s) => s.setActiveForumCommunity)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState('')
  const [banner, setBanner] = useState('')
  const [nsfw, setNsfw] = useState(false)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const def = await createCommunity({ name, description, image: image.trim() || undefined, banner: banner.trim() || undefined, nsfw })
      if (def) { setActiveCommunity(def.address); onDone() }
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title="Create community" maxW="max-w-lg" onClose={onDone}>
      <div className="space-y-3">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gaming" autoFocus className={fieldInput} /></Field>
        <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's this community about?" rows={3} className={cn(fieldInput, 'h-auto py-2 resize-y')} /></Field>
        <div className="flex gap-3">
          <MediaUploadField label="Icon" aspect="square" value={image} onChange={setImage} />
          <div className="flex-1"><MediaUploadField label="Banner" aspect="wide" value={banner} onChange={setBanner} /></div>
        </div>
        <NsfwSwitch value={nsfw} onChange={setNsfw} />
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onDone} className="h-9 px-3 rounded-md text-sm text-muted-foreground hover:text-foreground cursor-pointer">Cancel</button>
          <button onClick={submit} disabled={!name.trim() || saving} className="h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground disabled:opacity-50 cursor-pointer flex items-center gap-1.5">
            {saving ? <><Loader2 size={13} className="animate-spin" /> Creating…</> : 'Create community'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ─── Forum Feed Page ───

const SORTS: { id: ForumSort; label: string; icon: React.ReactNode }[] = [
  { id: 'new', label: 'New', icon: <Clock size={13} /> },
  { id: 'top', label: 'Top', icon: <TrendingUp size={13} /> },
  { id: 'hot', label: 'Hot', icon: <Flame size={13} /> },
]

/** Shared sort pills + view-PoW + NSFW filter row (its own card). */
function FeedControls() {
  const { sort, setSort, showNsfw, setShowNsfw } = useForumStore()
  const filterCategory = useForumStore((s) => s.filterCategory)
  const filterTags = useForumStore((s) => s.filterTags)
  const [classifierOpen, setClassifierOpen] = useState(false)
  const tagCount = filterTags.length
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2">
      {SORTS.map((sOpt) => (
        <button
          key={sOpt.id}
          onClick={() => setSort(sOpt.id)}
          className={cn('h-7 px-2.5 rounded-full text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer',
            sort === sOpt.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary/60')}
        >
          {sOpt.icon} {sOpt.label}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-1">
        <Hint label="Filter by tags">
          <button
            onClick={() => setClassifierOpen(true)}
            className={cn('flex items-center gap-1 h-7 px-2 rounded-full text-[11px] font-medium transition-colors cursor-pointer',
              tagCount ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60')}
          >
            <TagIcon size={12} /> Tags{tagCount ? ` (${tagCount})` : ''}
          </button>
        </Hint>
        <Hint label="Filter by category">
          <button
            onClick={() => setClassifierOpen(true)}
            className={cn('flex items-center gap-1 h-7 px-2 rounded-full text-[11px] font-medium transition-colors cursor-pointer max-w-[10rem]',
              filterCategory ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60')}
          >
            <Folder size={12} /> <span className="truncate">{filterCategory ? `Category: ${filterCategory}` : 'Category'}</span>
          </button>
        </Hint>
        <Hint label={showNsfw ? 'NSFW shown' : 'NSFW hidden'}>
          <button
            onClick={() => setShowNsfw(!showNsfw)}
            className={cn('flex items-center gap-1 h-7 px-2 rounded-full text-[11px] font-medium transition-colors cursor-pointer',
              showNsfw ? 'bg-red-500/15 text-red-400' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60')}
          >
            {showNsfw ? <Eye size={12} /> : <EyeOff size={12} />} NSFW
          </button>
        </Hint>
        <PowControl kind="view" />
      </div>
      {classifierOpen && <ClassifierFilterModal onClose={() => setClassifierOpen(false)} />}
    </div>
  )
}

function ClassifierFilterModal({ onClose }: { onClose: () => void }) {
  const filterCategory = useForumStore((s) => s.filterCategory)
  const setFilterCategory = useForumStore((s) => s.setFilterCategory)
  const filterTags = useForumStore((s) => s.filterTags)
  const addFilterTag = useForumStore((s) => s.addFilterTag)
  const removeFilterTag = useForumStore((s) => s.removeFilterTag)
  const [catDraft, setCatDraft] = useState(filterCategory || '')
  const [tagDraft, setTagDraft] = useState('')

  const commitCategory = () => setFilterCategory(catDraft)
  const addTag = () => {
    const v = tagDraft.trim()
    if (!v) return
    addFilterTag(v)
    setTagDraft('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-4 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Filter feed</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><Folder size={12} /> Category</label>
          <div className="flex gap-2">
            <input
              value={catDraft}
              onChange={(e) => setCatDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { commitCategory(); onClose() } }}
              placeholder="Show only this category…"
              className="flex-1 h-9 px-3 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
              autoFocus
            />
            {filterCategory && (
              <button onClick={() => { setFilterCategory(null); setCatDraft('') }} className="h-9 px-3 rounded-md text-xs text-muted-foreground border border-border hover:text-foreground cursor-pointer">Clear</button>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><TagIcon size={12} /> Tags <span className="text-muted-foreground/70">(posts must include all)</span></label>
          <div className="flex gap-2">
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() } }}
              placeholder="Add a tag…"
              className="flex-1 h-9 px-3 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button onClick={addTag} className="h-9 px-3 rounded-md text-xs font-medium bg-secondary/60 text-foreground hover:bg-secondary cursor-pointer">Add</button>
          </div>
          {filterTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {filterTags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded text-xs bg-accent/60 text-foreground">
                  {t}
                  <button onClick={() => removeFilterTag(t)} className="hover:text-red-400 cursor-pointer"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={() => { setFilterCategory(null); filterTags.forEach(removeFilterTag); setCatDraft('') }} className="h-9 px-3 rounded-md text-sm text-muted-foreground hover:text-foreground cursor-pointer">Reset all</button>
          <button onClick={() => { commitCategory(); onClose() }} className="h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer">Apply</button>
        </div>
      </div>
    </div>
  )
}

function ListFullBanner() {
  const listFull = useForumStore((s) => s.listFull)
  const clearListFull = useForumStore((s) => s.clearListFull)
  if (!listFull) return null
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-500 px-4 py-3 text-sm flex items-center justify-between gap-3">
      <span>You've reached the {MAX_FORUM_LIST}-entry limit for your {listFull === 'word' ? 'followed word communities' : 'joined communities'}. Remove some before adding more; this keeps the list within relay size limits.</span>
      <button onClick={clearListFull} className="shrink-0 text-amber-500/80 hover:text-amber-500 cursor-pointer"><X size={15} /></button>
    </div>
  )
}

function WordHeader({ word }: { word: string }) {
  const profile = useForumStore((s) => s.wordProfiles[word])
  const fetchWordProfile = useForumStore((s) => s.fetchWordProfile)
  const { isFollowed, followWord, unfollowWord } = useForumStore()
  const followed = isFollowed(word)
  const [editing, setEditing] = useState(false)

  useEffect(() => { fetchWordProfile(word) }, [word, fetchWordProfile])

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {profile?.banner && <BlossomImage src={profile.banner} className="h-28 w-full" />}
      <div className="p-4">
        <div className="flex items-start gap-3">
          {profile?.picture && (
            <BlossomImage src={profile.picture} className={cn('h-12 w-12 rounded-lg bg-secondary/50 shrink-0', profile.banner && '-mt-8 border-2 border-card')} />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-foreground truncate">w/{word}</h2>
            {profile?.description && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{profile.description}</p>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Hint label="Edit appearance">
              <button onClick={() => setEditing(true)} className="h-8 w-8 rounded-full border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center justify-center">
                <Pencil size={13} />
              </button>
            </Hint>
            <button
              onClick={() => (followed ? unfollowWord(word) : followWord(word))}
              className={cn('h-8 px-3 rounded-full text-xs font-medium border transition-colors cursor-pointer flex items-center gap-1.5',
                followed ? 'bg-secondary/60 text-foreground border-border' : 'bg-primary text-primary-foreground border-primary')}
            >
              <Star size={13} className={followed ? 'fill-current' : ''} /> {followed ? 'Following' : 'Follow'}
            </button>
          </div>
        </div>
      </div>
      {editing && <WordProfileModal word={word} onClose={() => setEditing(false)} />}
    </div>
  )
}

function WordProfileModal({ word, onClose }: { word: string; onClose: () => void }) {
  const mine = useForumStore((s) => s.myWordProfile[word])
  const others = useForumStore((s) => s.othersWordProfiles[word])
  const { publishWordProfile, setWordDelegation, fetchOthersWordProfiles } = useForumStore()
  const [tab, setTab] = useState<'mine' | 'others'>('mine')
  const [picture, setPicture] = useState(mine?.delegate ? '' : (mine?.picture || ''))
  const [banner, setBanner] = useState(mine?.delegate ? '' : (mine?.banner || ''))
  const [description, setDescription] = useState(mine?.delegate ? '' : (mine?.description || ''))
  const [chosen, setChosen] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { fetchOthersWordProfiles(word) }, [word, fetchOthersWordProfiles])

  const saveMine = async () => {
    if (saving) return
    setSaving(true)
    try {
      await publishWordProfile(word, { picture: picture.trim() || undefined, banner: banner.trim() || undefined, description: description.trim() || undefined })
      onClose()
    } finally { setSaving(false) }
  }
  const useChosen = async () => {
    if (!chosen || saving) return
    setSaving(true)
    try { await setWordDelegation(word, chosen); onClose() } finally { setSaving(false) }
  }

  return (
    <ModalShell title={`Appearance for w/${word}`} maxW="max-w-lg" onClose={onClose}>
      <p className="text-xs text-muted-foreground leading-relaxed mb-3">
        Word communities have no owner, so anyone can suggest an appearance. You publish your own, or pick one from people you follow to use and re-share. Only you control what you see.
      </p>
      {mine?.delegate && (
        <p className="text-[11px] text-amber-500 mb-3">Currently using someone else's appearance. Editing below switches back to your own.</p>
      )}

      {/* Tabs */}
      <div className="inline-flex gap-1 p-0.5 rounded-lg bg-secondary/40 border border-border mb-3">
        {(['mine', 'others'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={cn('px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer', tab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            {t === 'mine' ? 'Mine' : 'From follows'}
          </button>
        ))}
      </div>

      {tab === 'mine' ? (
        <div className="space-y-3">
          <MediaUploadField label="Picture" aspect="square" value={picture} onChange={setPicture} />
          <MediaUploadField label="Banner" aspect="wide" value={banner} onChange={setBanner} />
          <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's this community about?" rows={3} className={cn(fieldInput, 'h-auto py-2 resize-y')} /></Field>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="h-9 px-3 rounded-md text-sm text-muted-foreground hover:text-foreground cursor-pointer">Cancel</button>
            <button onClick={saveMine} disabled={saving} className="h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground disabled:opacity-50 cursor-pointer flex items-center gap-1.5">
              {saving ? <><Loader2 size={13} className="animate-spin" /> Publishing…</> : 'Publish'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {others === undefined ? (
            <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>
          ) : others.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">Nobody you follow has set an appearance for this community.</p>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {others.map((p) => <OthersProfileCard key={p.pubkey} profile={p} selected={chosen === p.pubkey} onSelect={() => setChosen(p.pubkey)} />)}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="h-9 px-3 rounded-md text-sm text-muted-foreground hover:text-foreground cursor-pointer">Cancel</button>
            <button onClick={useChosen} disabled={!chosen || saving} className="h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground disabled:opacity-50 cursor-pointer flex items-center gap-1.5">
              {saving ? <><Loader2 size={13} className="animate-spin" /> Setting…</> : 'Set & publish'}
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  )
}

function OthersProfileCard({ profile, selected, onSelect }: { profile: WordProfile; selected: boolean; onSelect: () => void }) {
  const { name, picture } = useAuthor(profile.pubkey)
  return (
    <button onClick={onSelect} className={cn('w-full text-left rounded-lg border overflow-hidden transition-colors cursor-pointer', selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-border/80')}>
      {profile.banner && <BlossomImage src={profile.banner} className="h-16 w-full" />}
      <div className="p-2.5 flex gap-2.5 items-start">
        {profile.picture && <BlossomImage src={profile.picture} className="h-9 w-9 rounded-lg bg-secondary/50 shrink-0" />}
        <div className="min-w-0 flex-1">
          {profile.description && <p className="text-xs text-foreground/90 line-clamp-2">{profile.description}</p>}
          <div className="flex items-center gap-1 mt-1 text-[11px] text-muted-foreground">
            <Avatar className="h-3.5 w-3.5"><AvatarImage src={picture} /><AvatarFallback className="text-[7px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
            <span className="truncate">by {name}</span>
          </div>
        </div>
        {selected && <Check size={15} className="text-primary shrink-0" />}
      </div>
    </button>
  )
}

export function ForumFeedPage() {
  const word = useSocialStore((s) => s.activeForumWord)
  const community = useSocialStore((s) => s.activeForumCommunity)
  const openThread = useSocialStore((s) => s.setActiveForumThread)
  const { postsByWord, loadingWord, sort, fetchWordPosts, sentimentByTarget, followedWords, publishWordPost, ingestPost } = useForumStore()
  const openForumFeed = useSocialStore((s) => s.openForumFeed)
  const filterFn = useForumFilter()
  const [composing, setComposing] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  // An active community/word forces its tab; otherwise the manual choice wins.
  const [manualTab, setManualTab] = useState<'open' | 'moderated'>('open')
  const tab: 'open' | 'moderated' = community ? 'moderated' : word ? 'open' : manualTab
  const onTabClick = (t: 'open' | 'moderated') => {
    setManualTab(t)
    // Switching tabs while a specific community is open returns to that tab's home.
    if ((t === 'moderated' && word) || (t === 'open' && community)) openForumFeed()
  }

  // Open (word) fetch: the active word, or all followed words (home).
  useEffect(() => {
    if (tab !== 'open') return
    if (word) fetchWordPosts(word)
    else followedWords.forEach((w) => fetchWordPosts(w))
  }, [tab, word, followedWords, fetchWordPosts])

  // Live new posts on the open (word) feed.
  useEffect(() => {
    if (tab !== 'open') return
    const words = word ? [word] : followedWords
    if (words.length === 0) return
    const sub = subscribeEvents({ kinds: [KINDS.FORUM_POST], '#w': words }, (ev) => ingestPost(ev))
    return () => sub.close()
  }, [tab, word, followedWords, ingestPost])

  const posts = useMemo(() => {
    const source = word ? (postsByWord[word] || []) : followedWords.flatMap((w) => postsByWord[w] || [])
    const seen = new Set<string>()
    const raw = source.filter((p) => filterFn(p) && !seen.has(p.id) && seen.add(p.id))
    return sortPosts(raw, sort, (id) => sentimentByTarget[id])
  }, [word, postsByWord, followedWords, filterFn, sort, sentimentByTarget])

  const loading = word ? loadingWord === word : followedWords.some((w) => loadingWord === w)

  const dnnOnly = useForumStore((s) => s.dnnOnly)
  // Authors of the raw (pre-filter) feed — verify their DNN so the dnn-only filter resolves.
  const rawAuthors = useMemo(() => {
    const source = word ? (postsByWord[word] || []) : followedWords.flatMap((w) => postsByWord[w] || [])
    return [...new Set(source.map((p) => p.pubkey))]
  }, [word, postsByWord, followedWords])

  return (
    <div className="flex-1 flex min-h-0">
      {dnnOnly && rawAuthors.map((pk) => <DnnVerify key={pk} pubkey={pk} />)}
      {showFilters && <ForumSettingsModal onClose={() => setShowFilters(false)} />}
      {/* Main column — centered, contained */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {/* Pill tabs */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur">
          <div className="mx-auto w-full max-w-[680px] px-4 py-3 flex items-center gap-2">
            <div className="flex flex-1 gap-1 p-1 rounded-xl bg-card border border-border">
              {(['open', 'moderated'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => onTabClick(t)}
                  className={cn('flex-1 px-6 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer',
                    tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {t === 'open' ? 'Open' : 'Moderated'}
                </button>
              ))}
            </div>
            <button onClick={() => setShowFilters(true)} title="Filters" className="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"><Filter size={15} /></button>
          </div>
        </div>

        <div className="mx-auto w-full max-w-[680px] px-4 pb-6 space-y-3">
          <ListFullBanner />
          {tab === 'moderated' ? (
            community ? <CommunityFeed address={community} /> : <CommunityHome />
          ) : (
            <>
              {/* Header card */}
              {word ? (
                <WordHeader word={word} />
              ) : (
                <div className="rounded-xl border border-border bg-card p-4">
                  <h2 className="text-lg font-bold text-foreground">Your feed</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Posts from the open communities you follow.</p>
                </div>
              )}

              <FeedControls />

              {/* Composer (word only) */}
              {word && (composing
                ? <PostComposer onSubmit={(t, b, o) => publishWordPost(word, t, b, o).then(Boolean)} onCancel={() => { setComposing(false); fetchWordPosts(word) }} />
                : <button onClick={() => setComposing(true)} className="w-full h-11 rounded-xl border border-dashed border-border bg-card/50 text-sm text-muted-foreground hover:text-foreground hover:border-border/80 hover:bg-card transition-colors cursor-pointer flex items-center justify-center gap-2"><Plus size={16} /> Create a post</button>)}

              {loading && posts.length === 0 ? (
                <div className="flex items-center justify-center py-10"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
              ) : posts.length === 0 ? (
                <p className="text-center text-sm text-muted-foreground py-10">
                  {word
                    ? 'No posts yet. Be the first.'
                    : followedWords.length === 0
                      ? 'Follow communities (right) to build your feed, or open one with “go to w/word”.'
                      : 'No posts yet from your communities.'}
                </p>
              ) : (
                posts.map((p) => <PostRow key={p.id} post={p} showSource={!word} onOpen={() => openThread(p.id)} />)
              )}
            </>
          )}
        </div>
      </div>

      <ForumRightRail tab={tab} />
    </div>
  )
}

// ─── Moderated (NIP-72) communities ───

function CommunityHome() {
  const myPubkey = useUserStore((s) => s.pubkey)
  const sort = useForumStore((s) => s.sort)
  const sentimentByTarget = useForumStore((s) => s.sentimentByTarget)
  const postsByCommunity = useForumStore((s) => s.postsByCommunity)
  const approvedByCommunity = useForumStore((s) => s.approvedByCommunity)
  const communitiesByAddress = useForumStore((s) => s.communitiesByAddress)
  const { joinedCommunities, joinedCommunitiesLoaded, loadJoinedCommunities, fetchCommunity, fetchCommunityPosts } = useForumStore()
  const openThread = useSocialStore((s) => s.setActiveForumThread)
  const filterFn = useForumFilter()

  useEffect(() => { if (myPubkey && !joinedCommunitiesLoaded) loadJoinedCommunities(myPubkey) }, [myPubkey, joinedCommunitiesLoaded, loadJoinedCommunities])
  useEffect(() => { joinedCommunities.forEach((a) => fetchCommunityPosts(a)) }, [joinedCommunities, fetchCommunityPosts])
  useEffect(() => { joinedCommunities.forEach((a) => { if (!communitiesByAddress[a]) fetchCommunity(a) }) }, [joinedCommunities, communitiesByAddress, fetchCommunity])

  const posts = useMemo(() => {
    const seen = new Set<string>()
    const all = joinedCommunities.flatMap((a) => {
      const approved = new Set(approvedByCommunity[a] || [])
      return (postsByCommunity[a] || []).filter((p) => approved.has(p.id))
    })
    const uniq = all.filter((p) => filterFn(p) && !seen.has(p.id) && seen.add(p.id))
    return sortPosts(uniq, sort, (id) => sentimentByTarget[id])
  }, [joinedCommunities, postsByCommunity, approvedByCommunity, filterFn, sort, sentimentByTarget])

  return (
    <>
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-lg font-bold text-foreground">Your communities</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Approved posts from communities you've joined. Discover, create, or open one from the right.</p>
      </div>
      <FeedControls />
      {posts.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground py-10">
          {joinedCommunities.length === 0 ? 'Join a community (right) to build your feed.' : 'No approved posts yet from your communities.'}
        </p>
      ) : (
        posts.map((p) => <PostRow key={p.id} post={p} showSource onOpen={() => openThread(p.id)} />)
      )}
    </>
  )
}

function CommunityFeed({ address }: { address: string }) {
  const def = useForumStore((s) => s.communitiesByAddress[address])
  const postsRaw = useForumStore((s) => s.postsByCommunity[address])
  const approvedIds = useForumStore((s) => s.approvedByCommunity[address])
  const loadingCommunity = useForumStore((s) => s.loadingCommunity)
  const sort = useForumStore((s) => s.sort)
  const sentimentByTarget = useForumStore((s) => s.sentimentByTarget)
  const { fetchCommunity, fetchCommunityPosts, publishCommunityPost, approvePost, isCommunityJoined, joinCommunity, leaveCommunity, ingestPost, ingestApproval } = useForumStore()
  const openThread = useSocialStore((s) => s.setActiveForumThread)
  const myPubkey = useUserStore((s) => s.pubkey)
  const filterFn = useForumFilter()
  const [composing, setComposing] = useState(false)
  const [view, setView] = useState<'approved' | 'pending'>('approved')
  const [editing, setEditing] = useState(false)

  useEffect(() => { if (!def) fetchCommunity(address); fetchCommunityPosts(address) }, [address, def, fetchCommunity, fetchCommunityPosts])
  useEffect(() => {
    const subP = subscribeEvents({ kinds: [KINDS.FORUM_POST], '#a': [address] }, (ev) => ingestPost(ev))
    const subA = subscribeEvents({ kinds: [4550], '#a': [address] }, (ev) => ingestApproval(ev))
    return () => { subP.close(); subA.close() }
  }, [address, ingestPost, ingestApproval])

  const isCreator = !!(def && myPubkey && def.pubkey === myPubkey)
  const isMod = !!(def && myPubkey && def.moderators.includes(myPubkey))
  const joined = isCommunityJoined(address)
  const approved = useMemo(() => new Set(approvedIds || []), [approvedIds])

  const { visible, pendingCount } = useMemo(() => {
    const all = (postsRaw || []).filter(filterFn)
    const shown = view === 'pending'
      ? all.filter((p) => !approved.has(p.id))
      : all.filter((p) => approved.has(p.id) || p.pubkey === myPubkey)
    return { visible: sortPosts(shown, sort, (id) => sentimentByTarget[id]), pendingCount: all.filter((p) => !approved.has(p.id)).length }
  }, [postsRaw, filterFn, view, approved, myPubkey, sort, sentimentByTarget])

  const naddr = def ? encodeCommunityNaddr(def.pubkey, def.dTag, def.relays) : ''
  const mods = def ? def.moderators.filter((m) => m !== def.pubkey) : []

  return (
    <>
      {/* Community header card */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {def?.banner && <BlossomImage src={def.banner} className="h-28 w-full" />}
        <div className="p-4 space-y-3">
        <div className="flex gap-3 items-start">
          <BlossomImage src={def?.image} className="h-12 w-12 rounded-lg bg-secondary/50 shrink-0" fallback={<div className="h-12 w-12 rounded-lg bg-secondary/50 shrink-0 flex items-center justify-center"><Users size={20} className="text-muted-foreground" /></div>} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-foreground truncate">{def?.name || communityShortLabel(def, address)}</h2>
              {def?.nsfw && <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 text-[10px] font-semibold shrink-0">NSFW</span>}
              {isMod && <span className="px-1.5 py-0.5 rounded bg-primary/15 text-primary text-[10px] font-semibold flex items-center gap-1 shrink-0"><ShieldCheck size={10} /> mod</span>}
            </div>
            {def?.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{def.description}</p>}
            {naddr && <div className="mt-1 max-w-full"><CopyHandle handle={`c/${naddr}`} /></div>}
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <button
              onClick={() => (joined ? leaveCommunity(address) : joinCommunity(address))}
              className={cn('h-8 px-3 rounded-full text-xs font-medium border transition-colors cursor-pointer flex items-center gap-1.5',
                joined ? 'bg-secondary/60 text-foreground border-border' : 'bg-primary text-primary-foreground border-primary')}
            >
              <Star size={13} className={joined ? 'fill-current' : ''} /> {joined ? 'Joined' : 'Join'}
            </button>
            {isCreator && def && (
              <button onClick={() => setEditing(true)} className="h-8 px-3 rounded-full text-xs font-medium border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1.5">
                <Pencil size={12} /> Edit
              </button>
            )}
          </div>
        </div>

        {/* Creator + moderators */}
        {def && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-2.5">
            <ModChip pubkey={def.pubkey} role="creator" />
            {mods.map((m) => <ModChip key={m} pubkey={m} role="mod" />)}
          </div>
        )}

        {/* Approved / Pending toggle */}
        <div className="inline-flex gap-1 p-0.5 rounded-lg bg-secondary/40 border border-border">
          {(['approved', 'pending'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn('px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5',
                view === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {v === 'approved' ? 'Approved' : 'Pending'}
              {v === 'pending' && pendingCount > 0 && <span className="px-1 rounded bg-amber-500/20 text-amber-500 text-[10px]">{pendingCount}</span>}
            </button>
          ))}
        </div>
        </div>
      </div>

      <FeedControls />

      {/* Composer */}
      {composing
        ? <PostComposer onSubmit={(t, b, o) => def ? publishCommunityPost(def, t, b, o).then(Boolean) : Promise.resolve(false)} onCancel={() => { setComposing(false); fetchCommunityPosts(address) }} />
        : <button onClick={() => setComposing(true)} disabled={!def} className="w-full h-11 rounded-xl border border-dashed border-border bg-card/50 text-sm text-muted-foreground hover:text-foreground hover:border-border/80 hover:bg-card transition-colors cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"><Plus size={16} /> Create a post</button>}

      {loadingCommunity === address && visible.length === 0 ? (
        <div className="flex items-center justify-center py-10"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
      ) : visible.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground py-10">{view === 'pending' ? 'Nothing pending.' : 'No approved posts yet.'}</p>
      ) : (
        visible.map((p) => (
          <div key={p.id} className="space-y-1">
            <PostRow post={p} onOpen={() => openThread(p.id)} />
            {isMod && !approved.has(p.id) && def && (
              <button onClick={() => approvePost(def, p)} className="ml-12 h-7 px-3 rounded-md text-xs font-medium bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 transition-colors cursor-pointer flex items-center gap-1.5">
                <ShieldCheck size={12} /> Approve
              </button>
            )}
          </div>
        ))
      )}

      {editing && def && <EditCommunityModal def={def} onClose={() => setEditing(false)} />}
    </>
  )
}

// ─── Moderator chip + community edit modal ───

function ModChip({ pubkey, role }: { pubkey: string; role: 'creator' | 'mod' }) {
  const { name, picture } = useAuthor(pubkey)
  const setActiveProfile = useSocialStore((s) => s.setActiveProfile)
  return (
    <button onClick={() => setActiveProfile(pubkey)} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer min-w-0">
      <Avatar className="h-4 w-4"><AvatarImage src={picture} /><AvatarFallback className="text-[7px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
      <span className="truncate max-w-[110px]">{name}</span>
      {role === 'creator'
        ? <span className="inline-flex items-center gap-0.5 text-amber-400"><Crown size={10} /> creator</span>
        : <ShieldCheck size={10} className="text-primary" />}
    </button>
  )
}

/** Resolve an npub / nprofile / hex string into a hex pubkey. */
function parsePubkeyInput(input: string): string | null {
  const v = input.trim()
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase()
  try {
    const d = nip19.decode(v)
    if (d.type === 'npub') return d.data
    if (d.type === 'nprofile') return d.data.pubkey
  } catch { /* not an npub */ }
  return null
}

function EditCommunityModal({ def, onClose }: { def: CommunityDef; onClose: () => void }) {
  const updateCommunity = useForumStore((s) => s.updateCommunity)
  const [name, setName] = useState(def.name)
  const [description, setDescription] = useState(def.description)
  const [image, setImage] = useState(def.image || '')
  const [banner, setBanner] = useState(def.banner || '')
  const [nsfw, setNsfw] = useState(def.nsfw)
  const [mods, setMods] = useState<string[]>(def.moderators.filter((m) => m !== def.pubkey))
  const [modInput, setModInput] = useState('')
  const [modError, setModError] = useState(false)
  const [saving, setSaving] = useState(false)

  const addMod = () => {
    const pk = parsePubkeyInput(modInput)
    if (!pk || pk === def.pubkey || mods.includes(pk)) { setModError(true); return }
    setMods([...mods, pk]); setModInput(''); setModError(false)
  }

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const updated = await updateCommunity(def, { name, description, image: image.trim() || undefined, banner: banner.trim() || undefined, nsfw, moderators: mods })
      if (updated) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title="Edit community" maxW="max-w-lg" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={fieldInput} /></Field>
        <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" rows={3} className={cn(fieldInput, 'h-auto py-2 resize-y')} /></Field>
        <div className="flex gap-3">
          <MediaUploadField label="Icon" aspect="square" value={image} onChange={setImage} />
          <div className="flex-1"><MediaUploadField label="Banner" aspect="wide" value={banner} onChange={setBanner} /></div>
        </div>
        <NsfwSwitch value={nsfw} onChange={setNsfw} />

        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Moderators</p>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Crown size={11} className="text-amber-400" /> You (creator), always a moderator</div>
          {mods.map((m) => <ModEditRow key={m} pubkey={m} onRemove={() => setMods(mods.filter((x) => x !== m))} />)}
          <div className="flex gap-1.5">
            <input
              value={modInput}
              onChange={(e) => { setModInput(e.target.value); setModError(false) }}
              onKeyDown={(e) => { if (e.key === 'Enter') addMod() }}
              placeholder="Add moderator (npub…)"
              className={cn('flex-1 h-8 px-2.5 rounded-md text-sm bg-muted/30 border focus:outline-none', modError ? 'border-destructive' : 'border-border')}
            />
            <button onClick={addMod} className="h-8 px-2.5 rounded-md bg-secondary/60 text-foreground text-sm cursor-pointer hover:bg-secondary flex items-center gap-1"><UserPlus size={13} /></button>
          </div>
          {modError && <p className="text-[11px] text-destructive">Enter a valid npub (not the creator, not already added).</p>}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:text-foreground cursor-pointer">Cancel</button>
          <button onClick={save} disabled={!name.trim() || saving} className="h-8 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground disabled:opacity-50 cursor-pointer flex items-center gap-1.5">
            {saving ? <><Loader2 size={13} className="animate-spin" /> Saving…</> : 'Save'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

function ModEditRow({ pubkey, onRemove }: { pubkey: string; onRemove: () => void }) {
  const { name, picture } = useAuthor(pubkey)
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/20">
      <Avatar className="h-5 w-5"><AvatarImage src={picture} /><AvatarFallback className="text-[8px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
      <span className="flex-1 min-w-0 truncate text-sm text-foreground">{name}</span>
      <button onClick={onRemove} className="text-muted-foreground hover:text-destructive cursor-pointer"><Trash2 size={13} /></button>
    </div>
  )
}

// ─── Comment tree ───

interface CommentTreeNode { comment: ForumComment; replies: CommentTreeNode[] }

function buildCommentTree(comments: ForumComment[], rootId: string): CommentTreeNode[] {
  const byParent = new Map<string, ForumComment[]>()
  for (const c of comments) {
    if (!byParent.has(c.parentId)) byParent.set(c.parentId, [])
    byParent.get(c.parentId)!.push(c)
  }
  const build = (parentId: string): CommentTreeNode[] =>
    (byParent.get(parentId) || [])
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((comment) => ({ comment, replies: build(comment.id) }))
  return build(rootId)
}

function CommentNode({ node, root, depth }: { node: CommentTreeNode; root: { id: string; pubkey: string }; depth: number }) {
  const { comment } = node
  const { name, picture } = useAuthor(comment.pubkey)
  const publishComment = useForumStore((s) => s.publishComment)
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const filterFn = useForumFilter()

  if (!filterFn({ pubkey: comment.pubkey, pow: comment.pow, body: comment.body })) return null

  const submit = async () => {
    if (!text.trim()) return
    await publishComment(root, { id: comment.id, pubkey: comment.pubkey }, text)
    setText(''); setReplying(false)
  }

  return (
    <div className={cn(depth > 0 && 'pl-3 border-l border-border/60 ml-2')}>
      <div className="py-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Avatar className="h-4 w-4"><AvatarImage src={picture} /><AvatarFallback className="text-[8px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
          <span className="truncate">{name}</span>
          <span>· {formatTimestamp(comment.createdAt)}</span>
          <ForumEventMenu event={comment.raw} className="ml-auto" />
        </div>
        <ForumBody body={comment.body} className="mt-0.5" />
        <div className="flex items-center gap-2 mt-1">
          <VoteBox target={{ id: comment.id, pubkey: comment.pubkey }} layout="row" />
          <button onClick={() => setReplying((v) => !v)} className="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer">Reply</button>
        </div>
        {replying && (
          <div className="mt-1.5 space-y-1.5">
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" rows={3} className="w-full px-2.5 py-2 rounded-md text-sm bg-muted/30 border border-border focus:outline-none resize-y min-h-[64px]" autoFocus />
            <div className="flex justify-end gap-1.5">
              <button onClick={() => { setReplying(false); setText('') }} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:text-foreground cursor-pointer">Cancel</button>
              <button onClick={submit} disabled={!text.trim()} className="h-8 px-3 rounded-md text-sm bg-primary text-primary-foreground disabled:opacity-50 cursor-pointer">Send</button>
            </div>
          </div>
        )}
      </div>
      {node.replies.map((r) => <CommentNode key={r.comment.id} node={r} root={root} depth={depth + 1} />)}
    </div>
  )
}

// ─── Forum Thread Page ───

export function ForumThreadPage() {
  const postId = useSocialStore((s) => s.activeForumPostId)
  const goBack = useSocialStore((s) => s.goBack)
  const { commentsByPost, fetchPostComments, publishComment, getPost, fetchPostById, ingestComment, ingestReaction } = useForumStore()
  const communitiesByAddress = useForumStore((s) => s.communitiesByAddress)
  const myPubkey = useUserStore((s) => s.pubkey)
  const [replyText, setReplyText] = useState('')
  const [replying, setReplying] = useState(false)
  const [resolving, setResolving] = useState(false)

  const post = postId ? getPost(postId) : undefined

  // Resolve the post if it isn't cached (deep link, or opened from the home feed).
  useEffect(() => {
    if (postId && !getPost(postId)) { setResolving(true); fetchPostById(postId).finally(() => setResolving(false)) }
  }, [postId, getPost, fetchPostById])

  useEffect(() => { if (postId) fetchPostComments(postId) }, [postId, fetchPostComments])

  const tree = useMemo(
    () => (postId ? buildCommentTree(commentsByPost[postId] || [], postId) : []),
    [postId, commentsByPost],
  )

  // Live comments + reactions (post and its loaded comments).
  const reactionIds = useMemo(() => {
    const ids = postId ? [postId, ...(commentsByPost[postId] || []).map((c) => c.id)] : []
    return ids
  }, [postId, commentsByPost])
  useEffect(() => {
    if (!postId) return
    const subC = subscribeEvents({ kinds: [KINDS.FORUM_POST], '#E': [postId] }, (ev) => ingestComment(ev))
    const subR = subscribeEvents({ kinds: [7], '#e': reactionIds }, (ev) => ingestReaction(ev))
    return () => { subC.close(); subR.close() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId, reactionIds.join(','), ingestComment, ingestReaction])

  const { name, picture } = useAuthor(post?.pubkey || '')

  if (!post) {
    return (
      <div className="flex-1 flex flex-col">
        <button onClick={goBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground px-4 py-3 cursor-pointer"><ChevronLeft size={16} /> Back</button>
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground gap-2">
          {resolving ? <><Loader2 size={14} className="animate-spin" /> Loading post…</> : <><AlertTriangle size={14} /> Post not loaded. Go back and reopen.</>}
        </div>
      </div>
    )
  }

  const label = post.word ? `w/${post.word}` : post.community ? communityShortLabel(communitiesByAddress[post.community], post.community) : 'forum'

  const submitReply = async () => {
    if (!replyText.trim()) return
    await publishComment({ id: post.id, pubkey: post.pubkey }, { id: post.id, pubkey: post.pubkey }, replyText)
    setReplyText(''); setReplying(false)
  }

  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur">
          <div className="mx-auto w-full max-w-[680px] px-4 py-3">
            <button onClick={goBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer">
              <ChevronLeft size={16} /> {label}
            </button>
          </div>
        </div>

        <div className="mx-auto w-full max-w-[680px] px-4 pb-6 space-y-3">
          {/* Post card */}
          <div className="flex gap-3 rounded-xl border border-border bg-card p-4">
            <VoteBox target={{ id: post.id, pubkey: post.pubkey }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
                <Avatar className="h-4 w-4"><AvatarImage src={picture} /><AvatarFallback className="text-[8px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                <span>{name}</span><span>· {formatTimestamp(post.createdAt)}</span>
                {post.nsfw && <span className="px-1 rounded bg-red-500/20 text-red-400 text-[9px] font-semibold">NSFW</span>}
                <ForumEventMenu event={post.raw} className="ml-auto" />
              </div>
              <h1 className="text-lg font-bold text-foreground leading-tight">{post.title}</h1>
              <ForumBody body={post.body} className="mt-2" />
              {(post.category || post.tags.length > 0) && (
                <div className="mt-3 pt-3 border-t border-border flex flex-wrap items-center gap-1.5">
                  {post.category && (
                    <button
                      onClick={() => useForumStore.getState().setFilterCategory(post.category!)}
                      className="inline-flex items-center gap-1 h-6 pl-2 pr-2.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 transition-colors cursor-pointer"
                    >
                      <Folder size={11} /> {post.category}
                    </button>
                  )}
                  {post.tags.map((t) => (
                    <button
                      key={t}
                      onClick={() => useForumStore.getState().addFilterTag(t)}
                      className="inline-flex items-center gap-1 h-6 pl-2 pr-2.5 rounded-full text-[11px] font-medium bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 transition-colors cursor-pointer"
                    >
                      <TagIcon size={11} /> {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Reply composer card */}
          <div className="rounded-xl border border-border bg-card p-3">
            {replying ? (
              <div className="space-y-2">
                <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Add a comment…" rows={4} className="w-full px-3 py-2 rounded-md text-sm bg-muted/30 border border-border focus:outline-none resize-y min-h-[88px]" autoFocus />
                <div className="flex justify-end gap-2">
                  <button onClick={() => { setReplying(false); setReplyText('') }} className="h-9 px-3 rounded-md text-sm text-muted-foreground hover:text-foreground cursor-pointer">Cancel</button>
                  <button onClick={submitReply} disabled={!replyText.trim()} className="h-9 px-4 rounded-md text-sm bg-primary text-primary-foreground disabled:opacity-50 cursor-pointer">Comment</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setReplying(true)} disabled={!myPubkey} className="w-full h-9 rounded-md border border-border bg-muted/20 text-sm text-muted-foreground hover:text-foreground text-left px-3 cursor-pointer">Add a comment…</button>
            )}
          </div>

          {/* Comments card */}
          <div className="rounded-xl border border-border bg-card p-3">
            {tree.length === 0
              ? <p className="text-center text-sm text-muted-foreground py-6">No comments yet.</p>
              : tree.map((n) => <CommentNode key={n.comment.id} node={n} root={{ id: post.id, pubkey: post.pubkey }} depth={0} />)}
          </div>
        </div>
      </div>

      <ThreadRightRail post={post} />
    </div>
  )
}

// ─── Thread right rail: the source community / word ───

function ThreadRightRail({ post }: { post: ForumPost }) {
  return (
    <aside className="w-[300px] shrink-0 hidden lg:block overflow-y-auto p-3">
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {post.community ? <CommunitySource address={post.community} /> : post.word ? <WordSource word={post.word} /> : null}
      </div>
    </aside>
  )
}

function WordSource({ word }: { word: string }) {
  const setActiveForumWord = useSocialStore((s) => s.setActiveForumWord)
  const profile = useForumStore((s) => s.wordProfiles[word])
  const fetchWordProfile = useForumStore((s) => s.fetchWordProfile)
  const { isFollowed, followWord, unfollowWord } = useForumStore()
  const followed = isFollowed(word)
  useEffect(() => { fetchWordProfile(word) }, [word, fetchWordProfile])
  return (
    <div>
      {profile?.banner && <BlossomImage src={profile.banner} className="h-20 w-full" />}
      <div className="p-3 space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Community</p>
      <div className="flex items-center gap-2">
        {profile?.picture && <BlossomImage src={profile.picture} className="h-8 w-8 rounded-lg bg-secondary/50 shrink-0" />}
        <button onClick={() => setActiveForumWord(word)} className="min-w-0 text-base font-bold text-foreground hover:text-primary transition-colors cursor-pointer truncate text-left">w/{word}</button>
      </div>
      <CopyHandle handle={`w/${word}`} />
      <p className="text-xs text-muted-foreground leading-relaxed">{profile?.description || `An open word community. Anyone can post by tagging ${word}; no owner, no moderation.`}</p>
      <div className="flex gap-1.5 pt-1">
        <button onClick={() => setActiveForumWord(word)} className="flex-1 h-8 rounded-md bg-secondary/60 text-foreground text-xs font-medium hover:bg-secondary cursor-pointer">View</button>
        <button
          onClick={() => (followed ? unfollowWord(word) : followWord(word))}
          className={cn('flex-1 h-8 rounded-md text-xs font-medium border transition-colors cursor-pointer flex items-center justify-center gap-1.5',
            followed ? 'bg-secondary/60 text-foreground border-border' : 'bg-primary text-primary-foreground border-primary')}
        >
          <Star size={12} className={followed ? 'fill-current' : ''} /> {followed ? 'Following' : 'Follow'}
        </button>
      </div>
      </div>
    </div>
  )
}

function CommunitySource({ address }: { address: string }) {
  const def = useForumStore((s) => s.communitiesByAddress[address])
  const { fetchCommunity, isCommunityJoined, joinCommunity, leaveCommunity } = useForumStore()
  const setActiveCommunity = useSocialStore((s) => s.setActiveForumCommunity)
  useEffect(() => { if (!def) fetchCommunity(address) }, [address, def, fetchCommunity])
  const joined = isCommunityJoined(address)
  const naddr = def ? encodeCommunityNaddr(def.pubkey, def.dTag, def.relays) : ''
  return (
    <div>
      {def?.banner && <BlossomImage src={def.banner} className="h-20 w-full" />}
      <div className="p-3 space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Community</p>
        <div className="flex items-center gap-2">
          <BlossomImage src={def?.image} className="h-8 w-8 rounded-lg bg-secondary/50 shrink-0" fallback={<span className="h-8 w-8 rounded-lg bg-secondary/50 shrink-0 flex items-center justify-center"><Users size={15} className="text-muted-foreground" /></span>} />
          <span className="min-w-0 font-bold text-foreground truncate">{def ? def.name : communityShortLabel(def, address)}</span>
          {def?.nsfw && <span className="px-1 rounded bg-red-500/20 text-red-400 text-[9px] font-semibold shrink-0">NSFW</span>}
        </div>
        {def?.description && <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">{def.description}</p>}
        {naddr && <div className="max-w-full"><CopyHandle handle={`c/${naddr}`} /></div>}
        <div className="flex gap-1.5 pt-1">
          <button onClick={() => setActiveCommunity(address)} className="flex-1 h-8 rounded-md bg-secondary/60 text-foreground text-xs font-medium hover:bg-secondary cursor-pointer">View</button>
          <button
            onClick={() => (joined ? leaveCommunity(address) : joinCommunity(address))}
            className={cn('flex-1 h-8 rounded-md text-xs font-medium border transition-colors cursor-pointer flex items-center justify-center gap-1.5',
              joined ? 'bg-secondary/60 text-foreground border-border' : 'bg-primary text-primary-foreground border-primary')}
          >
            <Star size={12} className={joined ? 'fill-current' : ''} /> {joined ? 'Joined' : 'Join'}
          </button>
        </div>
      </div>
    </div>
  )
}
