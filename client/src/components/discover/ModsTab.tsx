/**
 * ModsTab — the Discover → Mods listing. Fetches DEG MODS game-mod events
 * (kind 31142) from DEG MODS' relays, applies the ported filters, paginates,
 * and lets the user open a mod on degmods.com or a custom domain.
 */

import { useEffect, useMemo, useState, useRef } from 'react'
import { nip19 } from 'nostr-tools'
import {
  Package, Loader2, ChevronLeft, ChevronRight, SlidersHorizontal, X, ExternalLink,
  Plus, Repeat2, Gamepad2, ImageOff,
} from 'lucide-react'
import { cn, truncateNpub, openExternalUrl } from '@/lib/utils'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useProfileCache } from '@/hooks/useProfileCache'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { useModFeed } from '@/hooks/useModFeed'
import { applyModFilters } from '@/lib/mods/filterMods'
import { buildModOpenUrl, type Mod, MOD_ADMIN_PUBKEY, MOD_ADMIN_KIND, MODERATION_EXCLUDED_TAGS_DTAG, getModRelays } from '@/lib/mods/modEvent'
import { fetchEventsFromRelays } from '@/lib/nostr/relay-pool'
import {
  useModFiltersStore, useModOpenTargetsStore, BUILTIN_SOURCES, UNTAGGED,
  type NsfwMode, type RepostMode, type EmulationMode, type SourceEntry,
} from '@/stores/modFiltersStore'

const MODS_PER_PAGE = 20

function useModAuthor(pubkey: string) {
  const { getProfile } = useProfileCache()
  const p = getProfile(pubkey)
  const npub = nip19.npubEncode(pubkey)
  const name = p?.display_name || p?.name || truncateNpub(npub, 8)
  const hasName = !!(p?.display_name || p?.name)
  return { name, npub, picture: p?.picture as string | undefined, hasName }
}

export function ModsTab() {
  const feed = useModFeed()
  const { nsfwMode, sources, searchTags, excludedTags, repostMode, emulationMode, minPow, applyExcludedTagsDefaults } = useModFiltersStore()
  const [page, setPage] = useState(1)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [openMod, setOpenMod] = useState<Mod | null>(null)

  // Auto-fill excluded tags from the DEG MODS admin moderation list (NIP-78),
  // unless the user has customized them.
  useEffect(() => {
    let cancelled = false
    fetchEventsFromRelays(getModRelays(), { kinds: [MOD_ADMIN_KIND], authors: [MOD_ADMIN_PUBKEY], '#d': [MODERATION_EXCLUDED_TAGS_DTAG], limit: 1 })
      .then((events) => {
        if (cancelled || events.length === 0) return
        const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
        const tags = newest.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1].toLowerCase())
        if (tags.length > 0) applyExcludedTagsDefaults(tags)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [applyExcludedTagsDefaults])

  const filtered = useMemo(
    () => applyModFilters(feed.mods, { nsfwMode, minPow, sources, searchTags, excludedTags, repostMode, emulationMode }),
    [feed.mods, nsfwMode, minPow, sources, searchTags, excludedTags, repostMode, emulationMode],
  )

  // Discovered client sources (for the "add source" helper).
  const availableClients = useMemo(
    () => [...new Set(feed.mods.map((m) => m.client).filter((c): c is string => !!c))].sort(),
    [feed.mods],
  )

  const totalPages = Math.max(1, Math.ceil(filtered.length / MODS_PER_PAGE))
  const currentPage = Math.min(page, totalPages)
  const paginated = filtered.slice((currentPage - 1) * MODS_PER_PAGE, currentPage * MODS_PER_PAGE)

  // Reset to page 1 on filter changes.
  useEffect(() => { setPage(1) }, [nsfwMode, minPow, sources, searchTags, excludedTags, repostMode, emulationMode])

  // Prefetch an older batch as the user nears the last loaded page.
  useEffect(() => {
    if (!feed.loading && !feed.reachedEnd && currentPage >= totalPages - 1) feed.loadMore()
  }, [currentPage, totalPages, feed])

  const pageNumbers = useMemo(() => {
    const nums: (number | 'ellipsis')[] = []
    if (totalPages <= 7) for (let i = 1; i <= totalPages; i++) nums.push(i)
    else {
      nums.push(1)
      if (currentPage > 3) nums.push('ellipsis')
      for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) nums.push(i)
      if (currentPage < totalPages - 2) nums.push('ellipsis')
      nums.push(totalPages)
    }
    return nums
  }, [currentPage, totalPages])

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="max-w-6xl mx-auto w-full px-4 max-[1080px]:px-0 py-4 space-y-4">
        {/* Header + filters toggle */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Package size={18} className="text-primary" />
            <h1 className="text-xl font-bold text-foreground">Mods</h1>
            {!feed.loading && <span className="text-xs text-muted-foreground">({filtered.length}{feed.reachedEnd ? '' : '+'})</span>}
          </div>
          <button
            onClick={() => setFiltersOpen((v) => !v)}
            className={cn('flex items-center gap-1.5 h-8 px-3 rounded-lg border text-xs font-medium transition-colors cursor-pointer',
              filtersOpen ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-secondary/60 border-border text-muted-foreground hover:text-foreground')}
          >
            <SlidersHorizontal size={13} /> Filters
          </button>
        </div>

        {filtersOpen && <ModFiltersModal availableClients={availableClients} onClose={() => setFiltersOpen(false)} />}

        {/* Grid */}
        {feed.loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="aspect-video bg-secondary animate-pulse" />
                <div className="p-3 space-y-2">
                  <div className="h-4 w-3/4 bg-secondary rounded animate-pulse" />
                  <div className="h-3 w-full bg-secondary rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : paginated.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {paginated.map((mod) => <ModCard key={mod.aTag} mod={mod} onOpen={() => setOpenMod(mod)} />)}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-16">No mods match your filters.</p>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-1 pt-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}
              className={cn('p-2 rounded-lg transition-colors', currentPage <= 1 ? 'text-muted-foreground/40 cursor-not-allowed' : 'text-muted-foreground hover:bg-secondary/60 cursor-pointer')}>
              <ChevronLeft size={16} />
            </button>
            {pageNumbers.map((num, i) => num === 'ellipsis'
              ? <span key={`e${i}`} className="px-1 text-sm text-muted-foreground/50">…</span>
              : <button key={num} onClick={() => setPage(num)}
                  className={cn('w-8 h-8 rounded-lg text-sm font-medium transition-colors cursor-pointer', num === currentPage ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/60')}>{num}</button>)}
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages && feed.reachedEnd}
              className={cn('p-2 rounded-lg transition-colors', currentPage >= totalPages && feed.reachedEnd ? 'text-muted-foreground/40 cursor-not-allowed' : 'text-muted-foreground hover:bg-secondary/60 cursor-pointer')}>
              <ChevronRight size={16} />
            </button>
          </div>
        )}

        {feed.loadingMore && (
          <div className="flex items-center justify-center gap-2 py-1 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Loading more mods…
          </div>
        )}
      </div>

      {openMod && <ModOpenModal mod={openMod} onClose={() => setOpenMod(null)} />}
    </div>
  )
}

// ─── Card ───

function ModCard({ mod, onOpen }: { mod: Mod; onOpen: () => void }) {
  const author = useModAuthor(mod.pubkey)
  const showMedia = usePreferencesStore((s) => s.showMedia)
  const nsfw = !!mod.contentWarning

  return (
    <button onClick={onOpen}
      className="group flex flex-col text-left rounded-xl border border-border bg-card overflow-hidden hover:border-primary/30 hover:shadow-lg transition-all cursor-pointer">
      {/* Featured image */}
      <div className="relative w-full aspect-video overflow-hidden bg-secondary">
        {mod.featuredImageUrl && showMedia ? (
          <BlossomImage src={mod.featuredImageUrl} alt={mod.title}
            className={cn('w-full h-full object-cover group-hover:scale-105 transition-transform duration-300', nsfw && 'blur-lg')}
            fallback={<PlaceholderArt />} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {mod.featuredImageUrl && !showMedia
              ? <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><ImageOff size={13} /> Media hidden</span>
              : <PlaceholderArt />}
          </div>
        )}
        {nsfw && <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-red-500/90 text-white text-[10px] font-semibold">NSFW</span>}
        {mod.isRepost && <span className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 text-white/90 text-[10px]"><Repeat2 size={10} /> Repost</span>}
      </div>

      {/* Content */}
      <div className="flex flex-col gap-2 p-3 flex-1">
        <h3 className="font-semibold text-sm text-foreground line-clamp-1 group-hover:text-primary transition-colors">{mod.title || 'Untitled mod'}</h3>
        {mod.game && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground w-fit"><Gamepad2 size={11} /> {mod.game}</span>}
        {mod.summary && <p className="text-xs text-muted-foreground line-clamp-3">{mod.summary}</p>}

        {/* Author */}
        <div className="flex items-center gap-2 mt-auto pt-1">
          <Avatar className="h-5 w-5">
            {author.picture && <AvatarImage src={author.picture} />}
            <AvatarFallback className="text-[8px] bg-primary/20 text-primary">{author.name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="text-[11px] text-muted-foreground truncate">
            {author.hasName ? author.name : truncateNpub(author.npub, 8)}
          </span>
        </div>
      </div>
    </button>
  )
}

function PlaceholderArt() {
  return <div className="w-full h-full bg-gradient-to-br from-primary/15 via-transparent to-secondary flex items-center justify-center"><Package size={28} className="text-muted-foreground/40" /></div>
}

// ─── Open-in modal ───

function ModOpenModal({ mod, onClose }: { mod: Mod; onClose: () => void }) {
  const { targets, addTarget, removeTarget } = useModOpenTargetsStore()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const open = (url: string) => { openExternalUrl(url); onClose() }
  const addAndOpen = () => {
    const v = draft.trim()
    if (!v) return
    addTarget(v)
    setDraft('')
    inputRef.current?.focus()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-3" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70" />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-lg p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Open this mod</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
        </div>
        <p className="text-xs text-muted-foreground truncate">{mod.title || 'Untitled mod'}</p>

        <div className="flex flex-col gap-1.5">
          {/* Built-in */}
          <OpenTargetRow label="degmods.com" url={buildModOpenUrl('degmods.com', mod.naddr)} onOpen={open} />
          {/* Saved custom targets */}
          {targets.map((t) => (
            <OpenTargetRow key={t} label={t} url={buildModOpenUrl(t, mod.naddr)} onOpen={open} onRemove={() => removeTarget(t)} />
          ))}
        </div>

        {/* Add a domain */}
        <div className="pt-1 border-t border-border">
          <label className="text-[11px] text-muted-foreground">Open on another domain</label>
          <div className="flex gap-2 mt-1">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addAndOpen() }}
              placeholder="example.com  or  example.com/mods/"
              className="flex-1 h-9 px-3 rounded-md text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button onClick={addAndOpen} disabled={!draft.trim()}
              className="h-9 px-3 rounded-md text-xs font-medium bg-secondary/60 text-foreground hover:bg-secondary disabled:opacity-40 cursor-pointer">
              Add
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground/70 mt-1">
            A bare domain gets <span className="font-mono">/mod/{'{naddr}'}</span> appended; a domain with a path gets just the address after it. Saved locally.
          </p>
        </div>
      </div>
    </div>
  )
}

function OpenTargetRow({ label, url, onOpen, onRemove }: { label: string; url: string; onOpen: (url: string) => void; onRemove?: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <button onClick={() => onOpen(url)}
        className="flex-1 flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-secondary/40 hover:bg-secondary/70 transition-colors cursor-pointer text-left">
        <span className="text-sm text-foreground truncate">{label}</span>
        <ExternalLink size={13} className="text-muted-foreground shrink-0" />
      </button>
      {onRemove && (
        <button onClick={onRemove} className="p-2 text-muted-foreground/60 hover:text-red-400 cursor-pointer" title="Remove"><X size={13} /></button>
      )}
    </div>
  )
}

// ─── Filters bar ───

const NSFW_OPTS: { v: NsfwMode; label: string }[] = [{ v: 'hide', label: 'Hide NSFW' }, { v: 'show', label: 'Show NSFW' }, { v: 'only', label: 'Only NSFW' }]
const REPOST_OPTS: { v: RepostMode; label: string }[] = [{ v: 'show', label: 'Show reposts' }, { v: 'originals', label: 'Hide reposts' }, { v: 'only', label: 'Only reposts' }]
const EMU_OPTS: { v: EmulationMode; label: string }[] = [{ v: 'show', label: 'Show emulated' }, { v: 'native', label: 'Native only' }, { v: 'only', label: 'Only emulated' }]

function ModFiltersModal({ availableClients, onClose }: { availableClients: string[]; onClose: () => void }) {
  const s = useModFiltersStore()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-3" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70" />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-lg flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={15} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Mod filters</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          {/* Mode segmented rows */}
          <SegRow label="Content" value={s.nsfwMode} options={NSFW_OPTS} onChange={s.setNsfwMode} />
          <SegRow label="Reposts" value={s.repostMode} options={REPOST_OPTS} onChange={s.setRepostMode} />
          <SegRow label="Emulation" value={s.emulationMode} options={EMU_OPTS} onChange={s.setEmulationMode} />

          {/* PoW */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-foreground">Minimum PoW</div>
              <div className="text-[11px] text-muted-foreground">Hide mods below this proof-of-work. This setting is local to Mods.</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => s.setMinPow(s.minPow - 1)} className="w-7 h-7 rounded-md bg-secondary/60 text-foreground hover:bg-secondary cursor-pointer">–</button>
              <span className="w-8 text-center text-sm tabular-nums text-foreground">{s.minPow}</span>
              <button onClick={() => s.setMinPow(s.minPow + 1)} className="w-7 h-7 rounded-md bg-secondary/60 text-foreground hover:bg-secondary cursor-pointer">+</button>
            </div>
          </div>

          {/* Sources */}
          <SourcesEditor availableClients={availableClients} />

          {/* Tags + excluded tags */}
          <TagEditor label="Tags" hint="Show only mods with these tags" values={s.searchTags} onChange={s.setSearchTags} />
          <TagEditor label="Excluded tags" hint="Hide mods with these tags (auto-filled from DEG MODS moderation)" values={s.excludedTags} onChange={s.setExcludedTags} />
        </div>

        <div className="px-4 py-3 border-t border-border shrink-0">
          <button onClick={onClose} className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 cursor-pointer">Done</button>
        </div>
      </div>
    </div>
  )
}

function SegRow<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <div className="inline-flex gap-1 p-1 rounded-lg bg-secondary/40 border border-border">
        {options.map((o) => (
          <button key={o.v} onClick={() => onChange(o.v)}
            className={cn('px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer',
              value === o.v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function SourcesEditor({ availableClients }: { availableClients: string[] }) {
  const { sources, setSources } = useModFiltersStore()
  const [draft, setDraft] = useState('')

  const toggle = (name: string) => setSources(sources.map((x) => x.name === name ? { ...x, enabled: !x.enabled } : x))
  const add = (name: string) => {
    const v = name.trim()
    if (!v || sources.some((x) => x.name.toLowerCase() === v.toLowerCase())) return
    setSources([...sources, { name: v, enabled: true }])
    setDraft('')
  }
  const remove = (name: string) => setSources(sources.filter((x) => x.name !== name))

  const isBuiltin = (e: SourceEntry) => BUILTIN_SOURCES.includes(e.name) || e.name === UNTAGGED
  const discovered = availableClients.filter((c) => !sources.some((x) => x.name.toLowerCase() === c.toLowerCase()))

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-foreground">Sources</div>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((src) => (
          <span key={src.name} className={cn('inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-full text-[11px] font-medium border',
            src.enabled ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-secondary/40 border-border text-muted-foreground')}>
            <button onClick={() => toggle(src.name)} className="cursor-pointer">{src.name === UNTAGGED ? 'Untagged' : src.name}</button>
            {!isBuiltin(src) && <button onClick={() => remove(src.name)} className="hover:text-red-400 cursor-pointer"><X size={11} /></button>}
          </span>
        ))}
      </div>
      {discovered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">Discovered:</span>
          {discovered.slice(0, 8).map((c) => (
            <button key={c} onClick={() => add(c)} className="h-6 px-2 rounded-full bg-secondary/40 border border-border text-[10px] text-muted-foreground hover:text-foreground cursor-pointer">+ {c}</button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(draft) }}
          placeholder="Add a source (client name)…"
          className="flex-1 h-8 px-2.5 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none" />
        <button onClick={() => add(draft)} disabled={!draft.trim()} className="h-8 px-2.5 rounded-md text-xs bg-secondary/60 text-foreground hover:bg-secondary disabled:opacity-40 cursor-pointer"><Plus size={13} /></button>
      </div>
    </div>
  )
}

function TagEditor({ label, hint, values, onChange }: { label: string; hint: string; values: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim().toLowerCase()
    if (!v || values.map((x) => x.toLowerCase()).includes(v)) return
    onChange([...values, v])
    setDraft('')
  }
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-foreground">{label}</div>
      <div className="text-[11px] text-muted-foreground -mt-1">{hint}</div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded text-[11px] bg-accent/60 text-foreground">
              {t}<button onClick={() => onChange(values.filter((x) => x !== t))} className="hover:text-red-400 cursor-pointer"><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
          placeholder="Add a tag…"
          className="flex-1 h-8 px-2.5 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none" />
        <button onClick={add} disabled={!draft.trim()} className="h-8 px-2.5 rounded-md text-xs bg-secondary/60 text-foreground hover:bg-secondary disabled:opacity-40 cursor-pointer"><Plus size={13} /></button>
      </div>
    </div>
  )
}
