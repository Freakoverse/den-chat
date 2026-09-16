/**
 * ProfilePacksSection — the user's published emoji sets, sticker sets and GIF collections
 * (kind 30030), as three tabs inside the profile modal.
 *
 * Fetch timing is deliberate: the three author-scoped queries fire when the modal OPENS for this
 * pubkey — the same moment it fetches the kind-0 profile, status and follow list — and never ahead
 * of time for users whose profile hasn't been opened. Results are dropped on close so a reopen is a
 * fresh look. Each tab shows a loading state until its query settles; tab labels carry the counts.
 */
import { useEffect, useState } from 'react'
import { Loader2, Check, Smile, Sticker as StickerIcon, Film, PackageOpen } from 'lucide-react'
import { useUserStore } from '@/stores/userStore'
import { useEmojiStore, type EmojiSet } from '@/stores/emojiStore'
import { useStickerStore, type StickerSet } from '@/stores/stickerStore'
import { useGifStore, type GifCollection } from '@/stores/gifStore'
import { fetchEmojiSetsByAuthor, publishEmojiSubscriptions } from '@/lib/nostr/customEmoji'
import { fetchStickerSetsByAuthor, publishStickerSubscriptions } from '@/lib/nostr/customSticker'
import { fetchGifCollectionsByAuthor, publishGifSubscriptions } from '@/lib/nostr/customGif'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { getRenderLimit } from '@/lib/imageSizeGuard'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'

type PackTab = 'emoji' | 'sticker' | 'gif'

interface Loadable<T> { items: T[]; loading: boolean; error: boolean }
const idle = <T,>(): Loadable<T> => ({ items: [], loading: false, error: false })
const pending = <T,>(): Loadable<T> => ({ items: [], loading: true, error: false })

export function ProfilePacksSection({ pubkey, open }: { pubkey: string; open: boolean }) {
  const [tab, setTab] = useState<PackTab>('emoji')
  const [emoji, setEmoji] = useState<Loadable<EmojiSet>>(idle())
  const [sticker, setSticker] = useState<Loadable<StickerSet>>(idle())
  const [gif, setGif] = useState<Loadable<GifCollection>>(idle())

  useEffect(() => {
    if (!open || !pubkey) {
      setEmoji(idle()); setSticker(idle()); setGif(idle())
      return
    }
    let alive = true
    setEmoji(pending()); setSticker(pending()); setGif(pending())
    fetchEmojiSetsByAuthor(pubkey)
      .then((items) => { if (alive) setEmoji({ items, loading: false, error: false }) })
      .catch(() => { if (alive) setEmoji({ items: [], loading: false, error: true }) })
    fetchStickerSetsByAuthor(pubkey)
      .then((items) => { if (alive) setSticker({ items, loading: false, error: false }) })
      .catch(() => { if (alive) setSticker({ items: [], loading: false, error: true }) })
    fetchGifCollectionsByAuthor(pubkey)
      .then((items) => { if (alive) setGif({ items, loading: false, error: false }) })
      .catch(() => { if (alive) setGif({ items: [], loading: false, error: true }) })
    return () => { alive = false }
  }, [open, pubkey])

  const anyLoading = emoji.loading || sticker.loading || gif.loading

  const tabs: { key: PackTab; label: string; icon: React.ReactNode; state: Loadable<unknown> }[] = [
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

      {/* One box: full-width tab strip (three equal cells, active one boxed) over the list */}
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
                : <span className={`text-[10px] ${tab === t.key ? 'text-foreground/60' : 'text-muted-foreground/70'}`}>{t.state.items.length}</span>}
            </button>
          ))}
        </div>
        <div className="p-2.5">
          {tab === 'emoji' && <EmojiPacks pubkey={pubkey} state={emoji} />}
          {tab === 'sticker' && <StickerPacks pubkey={pubkey} state={sticker} />}
          {tab === 'gif' && <GifPacks pubkey={pubkey} state={gif} />}
        </div>
      </div>
    </div>
  )
}

/* ─── Shared bits ─── */

/** Loading skeleton / error / empty placeholder — or null when there are items to render. (A plain
 *  function, not a component: callers branch on the null, and a JSX element is always truthy.) */
function renderListState(state: Loadable<unknown>, noun: string): React.ReactNode | null {
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

function PackHeader({ name, count, noun, addr, isMine, subscribed, publishing, onSubscribe }: {
  name: string
  count: number
  noun: string
  addr: string
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
      <span className="sr-only">{addr}</span>
    </div>
  )
}

const PREVIEW_LIMIT = 12

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

function EmojiPacks({ pubkey, state }: { pubkey: string; state: Loadable<EmojiSet> }) {
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

  const placeholder = renderListState(state, 'emoji sets')
  if (placeholder) return <>{placeholder}</>
  return (
    <div className="space-y-2">
      {state.items.map((set) => {
        const addr = `30030:${set.pubkey}:${set.dTag}`
        return (
          <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-2.5">
            <PackHeader name={set.name} count={set.emojis.length} noun="emoji" addr={addr} isMine={isMine}
              subscribed={subscriptionAddresses.includes(addr)} publishing={publishingAddr === addr} onSubscribe={() => subscribe(set)} />
            <div className="flex flex-wrap gap-1">
              {set.emojis.slice(0, PREVIEW_LIMIT).map((e) => <PreviewTile key={e.shortcode} url={e.url} label={`:${e.shortcode}:`} blur={e.nsfw} />)}
              {set.emojis.length > PREVIEW_LIMIT && <span className="inline-flex items-center px-1.5 h-7 rounded bg-secondary/40 text-[10px] text-muted-foreground">+{set.emojis.length - PREVIEW_LIMIT}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ─── Stickers ─── */

function StickerPacks({ pubkey, state }: { pubkey: string; state: Loadable<StickerSet> }) {
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

  const placeholder = renderListState(state, 'sticker sets')
  if (placeholder) return <>{placeholder}</>
  return (
    <div className="space-y-2">
      {state.items.map((set) => {
        const addr = `30030:${set.pubkey}:${set.dTag}`
        return (
          <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-2.5">
            <PackHeader name={set.name} count={set.stickers.length} noun="sticker" addr={addr} isMine={isMine}
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
    </div>
  )
}

/* ─── GIFs ─── */

function GifPacks({ pubkey, state }: { pubkey: string; state: Loadable<GifCollection> }) {
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

  const placeholder = renderListState(state, 'GIF collections')
  if (placeholder) return <>{placeholder}</>
  return (
    <div className="space-y-2">
      {state.items.map((c) => {
        const addr = `30030:${c.pubkey}:${c.dTag}`
        return (
          <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-2.5">
            <PackHeader name={c.name} count={c.gifs.length} noun="GIF" addr={addr} isMine={isMine}
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
    </div>
  )
}
