/**
 * ProfilePacksSection — the user's published emoji sets, sticker sets and GIF collections
 * (kind 30030), as three tabs inside the profile modal.
 *
 * Fetch timing is deliberate: the three author-scoped queries fire when the modal OPENS for this
 * pubkey — the same moment it fetches the kind-0 profile, status and follow list — and never ahead
 * of time for users whose profile hasn't been opened. Results are dropped on close so a reopen is a
 * fresh look.
 *
 * Pagination is the mods-tab pattern: relays are asked for a BATCH (50) of the author's newest sets,
 * the list is paged with the shared numbered Pagination (10 per page), and when the reader reaches
 * the second-to-last page the next older batch is fetched with an `until` cursor (oldest seen − 1)
 * and appended — so the page numbers grow as more arrives. A batch that returns nothing new marks
 * the end. A set republished with a newer created_at may surface twice across batches; the newest
 * revision per d-tag wins.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Check, Smile, Sticker as StickerIcon, Film, PackageOpen } from 'lucide-react'
import { useUserStore } from '@/stores/userStore'
import { useEmojiStore, type EmojiSet } from '@/stores/emojiStore'
import { useStickerStore, type StickerSet } from '@/stores/stickerStore'
import { useGifStore, type GifCollection } from '@/stores/gifStore'
import { fetchEmojiSetsByAuthorBatch, publishEmojiSubscriptions } from '@/lib/nostr/customEmoji'
import { fetchStickerSetsByAuthorBatch, publishStickerSubscriptions } from '@/lib/nostr/customSticker'
import { fetchGifCollectionsByAuthorBatch, publishGifSubscriptions } from '@/lib/nostr/customGif'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { Pagination } from '@/components/ui/Pagination'
import { getRenderLimit } from '@/lib/imageSizeGuard'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'

type PackTab = 'emoji' | 'sticker' | 'gif'

const BATCH = 50
const PER_PAGE = 10
const PREVIEW_LIMIT = 12

interface Batch<T> { items: { set: T; createdAt: number }[]; oldest?: number; rawCount: number }
type BatchFetcher<T> = (pubkey: string, opts: { limit: number; until?: number }) => Promise<Batch<T>>

interface PagedPacks<T> {
  items: T[]
  loading: boolean      // first batch in flight
  loadingMore: boolean  // an older batch in flight
  reachedEnd: boolean
  error: boolean
  page: number
  totalPages: number
  pageItems: T[]
  setPage: (p: number) => void
}

/** Cursor-batched, numbered-page list of one author's sets (the useModFeed + ModsTab pattern, per tab). */
function usePagedPacks<T extends { dTag: string }>(open: boolean, pubkey: string, fetchBatch: BatchFetcher<T>): PagedPacks<T> {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [reachedEnd, setReachedEnd] = useState(false)
  const [error, setError] = useState(false)
  const [page, setPage] = useState(1)

  const byDTag = useRef<Map<string, { set: T; createdAt: number }>>(new Map())
  const oldest = useRef<number | undefined>(undefined)
  const inFlight = useRef(false)

  const recompute = () => {
    setItems([...byDTag.current.values()].sort((a, b) => b.createdAt - a.createdAt).map((x) => x.set))
  }

  const ingest = (batch: Batch<T>): number => {
    let added = 0
    for (const { set, createdAt } of batch.items) {
      const cur = byDTag.current.get(set.dTag)
      if (!cur) added++
      if (!cur || createdAt > cur.createdAt) byDTag.current.set(set.dTag, { set, createdAt })
    }
    if (batch.oldest !== undefined && (oldest.current === undefined || batch.oldest < oldest.current)) oldest.current = batch.oldest
    if (added > 0) recompute()
    return added
  }

  // Initial batch on open; full reset on close / pubkey change.
  useEffect(() => {
    byDTag.current = new Map()
    oldest.current = undefined
    inFlight.current = false
    setItems([]); setReachedEnd(false); setError(false); setPage(1); setLoadingMore(false)
    if (!open || !pubkey) { setLoading(false); return }
    let alive = true
    setLoading(true)
    fetchBatch(pubkey, { limit: BATCH })
      .then((batch) => { if (!alive) return; ingest(batch); if (batch.rawCount === 0) setReachedEnd(true) })
      .catch(() => { if (alive) setError(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pubkey])

  const loadMore = useCallback(async () => {
    if (inFlight.current || reachedEnd || loading || !open || !pubkey) return
    inFlight.current = true
    setLoadingMore(true)
    try {
      const batch = await fetchBatch(pubkey, { limit: BATCH, until: oldest.current ? oldest.current - 1 : undefined })
      const added = ingest(batch)
      // Nothing new at all → the relays have nothing older; also stop if the relays had fewer than a batch
      if (batch.rawCount === 0 || added === 0) setReachedEnd(true)
    } catch {
      setReachedEnd(true)
    } finally {
      inFlight.current = false
      setLoadingMore(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchBatch, reachedEnd, loading, open, pubkey])

  const totalPages = Math.max(1, Math.ceil(items.length / PER_PAGE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = items.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE)

  // Prefetch the next older batch as the reader nears the last loaded page.
  useEffect(() => {
    if (!loading && !reachedEnd && items.length > 0 && currentPage >= totalPages - 1) loadMore()
  }, [currentPage, totalPages, loading, reachedEnd, items.length, loadMore])

  return { items, loading, loadingMore, reachedEnd, error, page: currentPage, totalPages, pageItems, setPage }
}

export function ProfilePacksSection({ pubkey, open }: { pubkey: string; open: boolean }) {
  const [tab, setTab] = useState<PackTab>('emoji')
  const emoji = usePagedPacks<EmojiSet>(open, pubkey, fetchEmojiSetsByAuthorBatch)
  const sticker = usePagedPacks<StickerSet>(open, pubkey, fetchStickerSetsByAuthorBatch)
  const gif = usePagedPacks<GifCollection>(open, pubkey, fetchGifCollectionsByAuthorBatch)

  useEffect(() => { if (!open) setTab('emoji') }, [open])

  const anyLoading = emoji.loading || sticker.loading || gif.loading

  const tabs: { key: PackTab; label: string; icon: React.ReactNode; state: PagedPacks<unknown> }[] = [
    { key: 'emoji', label: 'Emoji', icon: <Smile size={12} />, state: emoji },
    { key: 'sticker', label: 'Stickers', icon: <StickerIcon size={12} />, state: sticker },
    { key: 'gif', label: 'GIFs', icon: <Film size={12} />, state: gif },
  ]

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Packs</div>
        {anyLoading && <Loader2 size={11} className="animate-spin text-muted-foreground" />}
      </div>

      {/* One box: full-width tab strip (three equal cells, active one a rounded pill) over the list */}
      <div className="rounded-lg border border-border bg-secondary/10 overflow-hidden">
        <div className="grid grid-cols-3 gap-1 p-1.5 border-b border-border">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors cursor-pointer
                ${tab === t.key
                  ? 'bg-secondary/70 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/30'}`}
            >
              {t.icon}
              {t.label}
              {t.state.loading
                ? <Loader2 size={10} className="animate-spin opacity-70" />
                : <span className={`text-[10px] ${tab === t.key ? 'text-foreground/60' : 'text-muted-foreground/70'}`}>
                    {t.state.items.length}{t.state.reachedEnd || t.state.items.length === 0 ? '' : '+'}
                  </span>}
            </button>
          ))}
        </div>
        <div className="p-2.5">
          {tab === 'emoji' && <EmojiPacks pubkey={pubkey} paged={emoji} />}
          {tab === 'sticker' && <StickerPacks pubkey={pubkey} paged={sticker} />}
          {tab === 'gif' && <GifPacks pubkey={pubkey} paged={gif} />}
        </div>
      </div>
    </div>
  )
}

/* ─── Shared bits ─── */

/** Loading skeleton / error / empty placeholder — or null when there are items to render. (A plain
 *  function, not a component: callers branch on the null, and a JSX element is always truthy.) */
function renderListState(state: PagedPacks<unknown>, noun: string): React.ReactNode | null {
  if (state.loading) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg border border-border/50 bg-secondary/20 p-2.5 animate-pulse">
            <div className="h-3 w-1/3 rounded bg-muted-foreground/20 mb-2" />
            <div className="flex gap-1">
              {[0, 1, 2, 3, 4, 5].map((j) => <div key={j} className="w-6 h-6 rounded bg-muted-foreground/15" />)}
            </div>
          </div>
        ))}
      </div>
    )
  }
  if (state.error) {
    return <p className="text-xs text-muted-foreground py-2">Couldn't load {noun} from relays.</p>
  }
  if (state.items.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground py-2">
        <PackageOpen size={13} className="opacity-60" /> No {noun} published.
      </p>
    )
  }
  return null
}

/** Numbered pages under the list, plus the "fetching older" spinner while the next batch lands. */
function PagesFooter({ state }: { state: PagedPacks<unknown> }) {
  return (
    <>
      <Pagination currentPage={state.page} totalPages={state.totalPages} onPageChange={state.setPage} />
      {state.loadingMore && (
        <div className="flex items-center justify-center gap-1.5 py-1 text-[10px] text-muted-foreground">
          <Loader2 size={10} className="animate-spin" /> Fetching older packs…
        </div>
      )}
    </>
  )
}

function PackHeader({ name, count, noun, isMine, subscribed, publishing, onSubscribe }: {
  name: string
  count: number
  noun: string
  isMine: boolean
  subscribed: boolean
  publishing: boolean
  onSubscribe: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 mb-1.5">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-foreground truncate">{name}</p>
        <p className="text-[10px] text-muted-foreground">{count} {noun}{count !== 1 ? 's' : ''}</p>
      </div>
      {isMine ? (
        <span className="text-[10px] text-muted-foreground shrink-0">Yours</span>
      ) : subscribed ? (
        <span className="text-[10px] text-primary font-medium shrink-0 flex items-center gap-1"><Check size={10} /> Subscribed</span>
      ) : (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onSubscribe}
                disabled={publishing}
                className="shrink-0 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium disabled:opacity-50 cursor-pointer"
              >
                {publishing ? <Loader2 size={10} className="animate-spin" /> : 'Subscribe'}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">Add this pack to your picker (publishes your subscription list)</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )
}

function PreviewTile({ url, label, blur, wide }: { url: string; label: string; blur: boolean; wide?: boolean }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`inline-flex ${wide ? 'w-14 h-10' : 'w-7 h-7'} rounded overflow-hidden bg-secondary/40 ${blur ? 'blur-[3px]' : ''}`}>
            <BlossomImage src={url} alt="" className="w-full h-full" contain maxSizeMB={getRenderLimit('chat')} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function useSelfAndSigner(pubkey: string) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  return { isMine: !!myPubkey && myPubkey === pubkey, signer, privateKey }
}

/* ─── Emoji ─── */

function EmojiPacks({ pubkey, paged }: { pubkey: string; paged: PagedPacks<EmojiSet> }) {
  const { isMine, signer, privateKey } = useSelfAndSigner(pubkey)
  const subscriptionAddresses = useEmojiStore((s) => s.subscriptionAddresses)
  const addSubscription = useEmojiStore((s) => s.addSubscription)
  const [publishingAddr, setPublishingAddr] = useState<string | null>(null)

  const subscribe = async (set: EmojiSet) => {
    const addr = `30030:${set.pubkey}:${set.dTag}`
    if (subscriptionAddresses.includes(addr)) return
    setPublishingAddr(addr)
    try {
      await publishEmojiSubscriptions([...subscriptionAddresses, addr], signer, privateKey)
      addSubscription(addr, set)
    } catch (err) {
      console.error('Failed to subscribe to emoji set:', err)
    } finally {
      setPublishingAddr(null)
    }
  }

  const placeholder = renderListState(paged, 'emoji sets')
  if (placeholder) return <>{placeholder}</>
  return (
    <div className="space-y-2">
      {paged.pageItems.map((set) => {
        const addr = `30030:${set.pubkey}:${set.dTag}`
        return (
          <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-2.5">
            <PackHeader name={set.name} count={set.emojis.length} noun="emoji" isMine={isMine}
              subscribed={subscriptionAddresses.includes(addr)} publishing={publishingAddr === addr} onSubscribe={() => subscribe(set)} />
            <div className="flex flex-wrap gap-1">
              {set.emojis.slice(0, PREVIEW_LIMIT).map((e) => <PreviewTile key={e.shortcode} url={e.url} label={`:${e.shortcode}:`} blur={e.nsfw} />)}
              {set.emojis.length > PREVIEW_LIMIT && <span className="inline-flex items-center px-1.5 h-7 rounded bg-secondary/40 text-[10px] text-muted-foreground">+{set.emojis.length - PREVIEW_LIMIT}</span>}
            </div>
          </div>
        )
      })}
      <PagesFooter state={paged} />
    </div>
  )
}

/* ─── Stickers ─── */

function StickerPacks({ pubkey, paged }: { pubkey: string; paged: PagedPacks<StickerSet> }) {
  const { isMine, signer, privateKey } = useSelfAndSigner(pubkey)
  const subscriptionAddresses = useStickerStore((s) => s.subscriptionAddresses)
  const addSubscription = useStickerStore((s) => s.addSubscription)
  const untaggedAsNsfw = useStickerStore((s) => s.untaggedAsNsfw)
  const [publishingAddr, setPublishingAddr] = useState<string | null>(null)

  const subscribe = async (set: StickerSet) => {
    const addr = `30030:${set.pubkey}:${set.dTag}`
    if (subscriptionAddresses.includes(addr)) return
    setPublishingAddr(addr)
    try {
      await publishStickerSubscriptions([...subscriptionAddresses, addr], signer, privateKey)
      addSubscription(addr, set)
    } catch (err) {
      console.error('Failed to subscribe to sticker set:', err)
    } finally {
      setPublishingAddr(null)
    }
  }

  const placeholder = renderListState(paged, 'sticker sets')
  if (placeholder) return <>{placeholder}</>
  return (
    <div className="space-y-2">
      {paged.pageItems.map((set) => {
        const addr = `30030:${set.pubkey}:${set.dTag}`
        return (
          <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-2.5">
            <PackHeader name={set.name} count={set.stickers.length} noun="sticker" isMine={isMine}
              subscribed={subscriptionAddresses.includes(addr)} publishing={publishingAddr === addr} onSubscribe={() => subscribe(set)} />
            <div className="flex flex-wrap gap-1">
              {set.stickers.slice(0, PREVIEW_LIMIT).map((s) => (
                <PreviewTile key={s.shortcode} url={s.url} label={s.shortcode} blur={s.nsfw || (!s.tagged && untaggedAsNsfw)} wide />
              ))}
              {set.stickers.length > PREVIEW_LIMIT && <span className="inline-flex items-center px-1.5 h-10 rounded bg-secondary/40 text-[10px] text-muted-foreground">+{set.stickers.length - PREVIEW_LIMIT}</span>}
            </div>
          </div>
        )
      })}
      <PagesFooter state={paged} />
    </div>
  )
}

/* ─── GIFs ─── */

function GifPacks({ pubkey, paged }: { pubkey: string; paged: PagedPacks<GifCollection> }) {
  const { isMine, signer, privateKey } = useSelfAndSigner(pubkey)
  const subscriptionAddresses = useGifStore((s) => s.subscriptionAddresses)
  const addSubscription = useGifStore((s) => s.addSubscription)
  const untaggedAsNsfw = useGifStore((s) => s.untaggedAsNsfw)
  const [publishingAddr, setPublishingAddr] = useState<string | null>(null)

  const subscribe = async (collection: GifCollection) => {
    const addr = `30030:${collection.pubkey}:${collection.dTag}`
    if (subscriptionAddresses.includes(addr)) return
    setPublishingAddr(addr)
    try {
      await publishGifSubscriptions([...subscriptionAddresses, addr], signer, privateKey)
      addSubscription(addr, collection)
    } catch (err) {
      console.error('Failed to subscribe to GIF collection:', err)
    } finally {
      setPublishingAddr(null)
    }
  }

  const placeholder = renderListState(paged, 'GIF collections')
  if (placeholder) return <>{placeholder}</>
  return (
    <div className="space-y-2">
      {paged.pageItems.map((c) => {
        const addr = `30030:${c.pubkey}:${c.dTag}`
        return (
          <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-2.5">
            <PackHeader name={c.name} count={c.gifs.length} noun="GIF" isMine={isMine}
              subscribed={subscriptionAddresses.includes(addr)} publishing={publishingAddr === addr} onSubscribe={() => subscribe(c)} />
            <div className="flex flex-wrap gap-1">
              {c.gifs.slice(0, PREVIEW_LIMIT).map((g, i) => (
                <PreviewTile key={`${g.url}-${i}`} url={g.url} label={g.name || 'GIF'} blur={g.nsfw || (!g.tagged && untaggedAsNsfw)} wide />
              ))}
              {c.gifs.length > PREVIEW_LIMIT && <span className="inline-flex items-center px-1.5 h-10 rounded bg-secondary/40 text-[10px] text-muted-foreground">+{c.gifs.length - PREVIEW_LIMIT}</span>}
            </div>
          </div>
        )
      })}
      <PagesFooter state={paged} />
    </div>
  )
}
