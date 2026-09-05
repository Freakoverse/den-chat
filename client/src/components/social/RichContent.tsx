/**
 * RichContent — Renders post content with media embeds and nostr reference cards
 *
 * Handles:
 * - Image URLs (.jpg, .png, .gif, .webp, .svg) → <img> with grid grouping + gallery
 * - Video URLs (.mp4, .webm, .mov) → <video>
 * - Audio URLs (.mp3, .ogg, .wav, .flac) → <audio>
 * - nostr:npub / nostr:nprofile → profile mention link
 * - nostr:note / nostr:nevent → embedded note card
 * - Plain URLs → clickable links
 */

import { useState, useEffect, useMemo, useCallback, Fragment } from 'react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { nip19 } from 'nostr-tools'
import { useProfileCache } from '@/hooks/useProfileCache'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { Copy, Check, X, ChevronLeft, ChevronRight, ImageOff, Link as LinkIcon, Eye } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { HubEventCard } from '@/components/hub/HubEventCard'
import { HubMessageCard } from '@/components/hub/HubMessageCard'
import { LongFormCard, CommentCard, LiveActivityCard } from '@/components/nostr/NostrCards'
import { getEmojiMap } from '@/stores/emojiStore'
import { MutedWordPill } from '@/components/chat/MessageContent'
import { detectEmbed, isEmbeddable } from '@/lib/embeds'
import { Embed } from '@/components/ui/Embed'
import type { EmbedInfo } from '@/lib/embeds'
import type { Event } from 'nostr-tools'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { CustomAudioPlayer } from '@/components/ui/CustomAudioPlayer'
import { getRenderLimit } from '@/lib/imageSizeGuard'
import { ImageTooLarge } from '@/components/ui/ImageTooLarge'

const IMAGE_REGEX = /\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?[^\s]*)?$/i
const VIDEO_REGEX = /\.(mp4|webm|mov|avi|mkv)(\?[^\s]*)?$/i
const AUDIO_REGEX = /\.(mp3|ogg|wav|flac|aac|m4a)(\?[^\s]*)?$/i
/** Blossom server URLs with a bare sha256 hash path (no file extension) */
const BLOSSOM_MEDIA_SIMPLE = /^https?:\/\/(blossom\.(primal\.net|band|nostr\.hu|data\.haus)|cdn\.sovbit\.host)\/[a-f0-9]{64}(\?[^\s]*)?$/i
const URL_REGEX = /(https?:\/\/[^\s<]+)/g
const NOSTR_REGEX = /(nostr:(?:npub|nprofile|note|nevent|naddr)[a-zA-Z0-9]+|@(?:npub1|nprofile1|note1|nevent1|naddr1)[a-zA-Z0-9]+|\b(?:npub1|nprofile1|note1|nevent1|naddr1)[a-zA-Z0-9]+)/g

interface RichContentProps {
  content: string
  onOpenProfile?: (pubkey: string) => void
  onOpenThread?: (eventId: string) => void
  mutedWords?: Set<string>
  /** Replace inline images/videos/audio with a "media hidden" placeholder. */
  disableMedia?: boolean
  /** Replace link-preview/media embeds with a "link preview hidden" placeholder. */
  disableEmbeds?: boolean
  /** Render custom-emoji shortcodes as text instead of images (no-op for plain bodies). */
  disableCustomEmojis?: boolean
}

/** Click-to-view placeholder — shows a "hidden" chip that reveals its children on click. */
function RevealPlaceholder({ kind, children }: { kind: 'media' | 'embed'; children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false)
  if (revealed) return <>{children}</>
  return (
    <div className="flex items-center gap-2.5 py-1.5 px-3 mt-2 rounded-lg bg-muted/40 border border-border/40">
      {kind === 'media' ? <ImageOff size={14} className="text-muted-foreground shrink-0" /> : <LinkIcon size={14} className="text-muted-foreground shrink-0" />}
      <span className="text-xs text-muted-foreground">{kind === 'media' ? 'Media hidden' : 'Link preview hidden'}</span>
      <button
        onClick={(e) => { e.stopPropagation(); setRevealed(true) }}
        className="ml-auto flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full text-muted-foreground hover:text-foreground bg-muted/60 hover:bg-muted transition-colors cursor-pointer"
      >
        <Eye size={11} /> Preview
      </button>
    </div>
  )
}

interface ContentSegment {
  type: 'text' | 'url' | 'image' | 'video' | 'audio' | 'nostr' | 'embed'
  value: string
}

function parseContent(content: string): ContentSegment[] {
  const segments: ContentSegment[] = []
  const combined = new RegExp(`${NOSTR_REGEX.source}|${URL_REGEX.source}`, 'g')
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = combined.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: content.slice(lastIndex, match.index) })
    }

    const matched = match[0]

    if (matched.startsWith('nostr:') || matched.startsWith('@') || /^(?:npub1|nprofile1|note1|nevent1|naddr1)/.test(matched)) {
      segments.push({ type: 'nostr', value: matched })
    } else if (IMAGE_REGEX.test(matched)) {
      segments.push({ type: 'image', value: matched })
    } else if (VIDEO_REGEX.test(matched)) {
      segments.push({ type: 'video', value: matched })
    } else if (AUDIO_REGEX.test(matched)) {
      segments.push({ type: 'audio', value: matched })
    } else if (BLOSSOM_MEDIA_SIMPLE.test(matched)) {
      // Blossom hash URLs without file extension — treat as images
      segments.push({ type: 'image', value: matched })
    } else if (isEmbeddable(matched)) {
      segments.push({ type: 'embed', value: matched })
    } else {
      segments.push({ type: 'url', value: matched })
    }

    lastIndex = match.index + matched.length
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', value: content.slice(lastIndex) })
  }

  return segments
}

/**
 * Groups segments so that consecutive images (separated only by whitespace/newlines)
 * are collected into a single "image-group" block.
 */
type RenderBlock =
  | { kind: 'inline'; segments: ContentSegment[] }
  | { kind: 'image-group'; urls: string[] }
  | { kind: 'video'; url: string }
  | { kind: 'audio'; url: string }
  | { kind: 'embed'; url: string; embed: EmbedInfo }

function groupSegments(segments: ContentSegment[]): RenderBlock[] {
  const blocks: RenderBlock[] = []
  let currentInline: ContentSegment[] = []
  let currentImages: string[] = []

  const flushInline = () => {
    if (currentInline.length > 0) {
      blocks.push({ kind: 'inline', segments: currentInline })
      currentInline = []
    }
  }
  const flushImages = () => {
    if (currentImages.length > 0) {
      blocks.push({ kind: 'image-group', urls: [...currentImages] })
      currentImages = []
    }
  }

  for (const seg of segments) {
    if (seg.type === 'image') {
      flushInline()
      currentImages.push(seg.value)
    } else if (seg.type === 'text' && seg.value.trim() === '' && currentImages.length > 0) {
      // Whitespace between images — keep grouping
      continue
    } else if (seg.type === 'video') {
      flushInline()
      flushImages()
      blocks.push({ kind: 'video', url: seg.value })
    } else if (seg.type === 'audio') {
      flushInline()
      flushImages()
      blocks.push({ kind: 'audio', url: seg.value })
    } else if (seg.type === 'embed') {
      flushInline()
      flushImages()
      blocks.push({ kind: 'embed', url: seg.value, embed: detectEmbed(seg.value)! })
    } else {
      flushImages()
      currentInline.push(seg)
    }
  }

  flushInline()
  flushImages()

  return blocks
}

/* ─── Custom emoji (NIP-30) :shortcode: rendering ────────── */

const EMOJI_SHORTCODE_RE = /:([a-zA-Z0-9_-]+):/g

function emojifySocial(text: string): React.ReactNode {
  const emojiMap = getEmojiMap()
  if (emojiMap.size === 0) return text

  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  EMOJI_SHORTCODE_RE.lastIndex = 0
  while ((match = EMOJI_SHORTCODE_RE.exec(text)) !== null) {
    const shortcode = match[1]
    const emoji = emojiMap.get(shortcode)
    if (!emoji) continue

    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    parts.push(
      <img
        key={`emoji-${match.index}`}
        src={emoji.url}
        alt={`:${shortcode}:`}
        title={`:${shortcode}:`}
        className="inline h-5 w-5 align-text-bottom object-contain"
        loading="lazy"
      />
    )
    lastIndex = match.index + match[0].length
  }

  if (parts.length === 0) return text
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return <>{parts}</>
}

export function RichContent({ content, onOpenProfile, onOpenThread, mutedWords, disableMedia = false, disableEmbeds = false }: RichContentProps) {
  const globalEmbedsOff = !usePreferencesStore((s) => s.showEmbeds)
  const globalMutedWordsOff = !usePreferencesStore((s) => s.hideMutedWords)
  const effectiveMutedWords = globalMutedWordsOff ? undefined : mutedWords
  const segments = useMemo(() => parseContent(content), [content])
  const blocks = useMemo(() => groupSegments(segments), [segments])

  /** Redact muted words in a text string */
  const redactText = useCallback((text: string): React.ReactNode => {
    if (!effectiveMutedWords || effectiveMutedWords.size === 0) return text
    const escaped = Array.from(effectiveMutedWords).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi')
    const parts = text.split(regex)
    if (parts.length <= 1) return text
    return parts.map((part, i) => {
      if (i % 2 === 1) return <MutedWordPill key={i}>{part}</MutedWordPill>
      return part
    })
  }, [effectiveMutedWords])

  /** Apply redaction then emojify */
  const renderText = useCallback((text: string): React.ReactNode => {
    const emojified = emojifySocial(text)
    if (!effectiveMutedWords || effectiveMutedWords.size === 0) return emojified
    // If emojifySocial returned a plain string, redact directly
    if (typeof emojified === 'string') return redactText(emojified)
    // Otherwise it's a JSX fragment with mixed text/img nodes — walk children
    return emojified
  }, [effectiveMutedWords, redactText])

  // Collect ALL image URLs for the gallery lightbox
  const allImages = useMemo(
    () => segments.filter((s) => s.type === 'image').map((s) => s.value),
    [segments]
  )

  const [galleryIndex, setGalleryIndex] = useState<number | null>(null)

  const openGallery = useCallback((url: string) => {
    const idx = allImages.indexOf(url)
    setGalleryIndex(idx >= 0 ? idx : 0)
  }, [allImages])

  return (
    <div className="mt-1">
      {blocks.map((block, i) => {
        if (block.kind === 'inline') {
          return (
            <div key={i} className="text-sm text-foreground/90 whitespace-pre-wrap break-words">
              {block.segments.map((seg, j) => {
                if (seg.type === 'text') return <span key={j}>{renderText(seg.value)}</span>
                if (seg.type === 'url') return (
                  <TooltipProvider key={j} delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <a
                          href={seg.value}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {seg.value}
                        </a>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[400px] break-all">
                        {seg.value}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )
                if (seg.type === 'nostr') return (
                  <NostrMention
                    key={j}
                    uri={seg.value}
                    onOpenProfile={onOpenProfile}
                    onOpenThread={onOpenThread}
                  />
                )
                return null
              })}
            </div>
          )
        }

        if (block.kind === 'image-group') {
          const urls = block.urls
          const media = urls.length === 1 ? (
            <MediaImage
              src={urls[0]}
              className="rounded-lg mt-2 max-w-full object-contain cursor-pointer"
              style={{ maxHeight: 400 }}
              onClick={(e) => { e.stopPropagation(); openGallery(urls[0]) }}
            />
          ) : (
            // 2-column grid for multiple adjacent images
            <div className="grid grid-cols-2 gap-1 mt-2 rounded-lg overflow-hidden">
              {urls.map((url, j) => (
                <MediaImage
                  key={j}
                  src={url}
                  className="w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
                  style={{ maxHeight: 250, minHeight: 120 }}
                  onClick={(e) => { e.stopPropagation(); openGallery(url) }}
                />
              ))}
            </div>
          )
          return disableMedia
            ? <RevealPlaceholder key={i} kind="media">{media}</RevealPlaceholder>
            : <Fragment key={i}>{media}</Fragment>
        }

        if (block.kind === 'video') {
          const media = (
            <MediaVideo
              src={block.url}
              className="rounded-lg mt-2 w-full"
              style={{ maxHeight: 400 }}
              onClick={(e) => e.stopPropagation()}
            />
          )
          return disableMedia
            ? <RevealPlaceholder key={i} kind="media">{media}</RevealPlaceholder>
            : <Fragment key={i}>{media}</Fragment>
        }

        if (block.kind === 'audio') {
          const media = <CustomAudioPlayer src={block.url} className="w-full mt-2" />
          return disableMedia
            ? <RevealPlaceholder key={i} kind="media">{media}</RevealPlaceholder>
            : <Fragment key={i}>{media}</Fragment>
        }

        if (block.kind === 'embed') {
          const embedEl = <div className="mt-2"><Embed embed={block.embed} /></div>
          return (globalEmbedsOff || disableEmbeds)
            ? <RevealPlaceholder key={i} kind="embed">{embedEl}</RevealPlaceholder>
            : <Fragment key={i}>{embedEl}</Fragment>
        }

        return null
      })}

      {/* Gallery lightbox */}
      {galleryIndex !== null && (
        <ImageGallery
          images={allImages}
          startIndex={galleryIndex}
          onClose={() => setGalleryIndex(null)}
        />
      )}
    </div>
  )
}

/* ─── Media Loading Wrappers ─────────────────────────────────────────── */

function MediaImage({ src, className, style, onClick }: {
  src: string
  className?: string
  style?: React.CSSProperties
  onClick?: (e: React.MouseEvent) => void
}) {
  const socialLimitMB = getRenderLimit('social')
  const blossom = useBlossomMedia(src, socialLimitMB)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [overridden, setOverridden] = useState(false)

  // Reset states when src changes or blossom fails over to a new server
  useEffect(() => { setLoaded(false); setError(false); setOverridden(false) }, [src, blossom.src])

  // Size limit exceeded
  if (blossom.sizeExceeded && !overridden) {
    return (
      <ImageTooLarge
        url={src}
        detectedSize={blossom.detectedSize}
        onOverride={() => setOverridden(true)}
        className="rounded-lg mt-2 max-w-full"
      />
    )
  }

  // Show not-found error
  if (blossom.error === 'not-found') {
    return (
      <div className="rounded-lg mt-2 bg-destructive/10 border border-destructive/30 flex flex-col items-center justify-center text-xs py-4 px-3 gap-1">
        <span className="text-muted-foreground">Image not found on any server</span>
        <a href={src} target="_blank" rel="noopener noreferrer" className="text-primary text-xs hover:underline mt-1">
          ⬇ Try direct link
        </a>
      </div>
    )
  }

  const resolvedSrc = blossom.src || src
  const isLoading = blossom.loading || (!loaded && !error)

  return (
    <div className="relative" style={style}>
      {/* Shimmer skeleton while loading */}
      {isLoading && (
        <div
          className="rounded-lg mt-2 bg-muted/40 animate-pulse"
          style={{ ...style, minHeight: 160 }}
        />
      )}
      {error && !blossom.loading && (
        <div className="rounded-lg mt-2 bg-secondary/40 border border-border/50 flex items-center justify-center text-xs text-muted-foreground/60 py-6">
          Failed to load image
        </div>
      )}
      {!blossom.loading && resolvedSrc && (
        <img
          src={resolvedSrc}
          alt=""
          className={`${className} transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0 absolute'}`}
          style={loaded ? style : { ...style, position: 'absolute', top: 0, left: 0, width: '100%' }}
          loading="lazy"
          // Strip the Referer so hotlink-protected hosts (which 403 cross-origin
          // requests coming from another domain) still serve the image.
          referrerPolicy="no-referrer"
          onLoad={() => { setLoaded(true); setError(false) }}
          onError={() => { blossom.onImgError(); setError(true) }}
          onClick={onClick}
        />
      )}
    </div>
  )
}

function MediaVideo({ src, className, style, onClick }: {
  src: string
  className?: string
  style?: React.CSSProperties
  onClick?: (e: React.MouseEvent) => void
}) {
  const blossom = useBlossomMedia(src)

  if (blossom.error === 'not-found') {
    return (
      <div className="rounded-lg mt-2 bg-destructive/10 border border-destructive/30 flex flex-col items-center justify-center text-xs py-4 px-3 gap-1">
        <span className="text-muted-foreground">Video not found on any server</span>
        <a href={src} target="_blank" rel="noopener noreferrer" className="text-primary text-xs hover:underline mt-1">
          ⬇ Try direct link
        </a>
      </div>
    )
  }

  const resolvedSrc = blossom.src || src

  return (
    <div className="relative">
      {!blossom.loading && resolvedSrc && (
        <video
          src={resolvedSrc}
          controls
          className={className}
          style={style}
          preload="none"
          onClick={onClick}
        />
      )}
    </div>
  )
}

/* ─── Image Gallery (Lightbox) ────────────────────────────────────────── */

export function ImageGallery({ images, startIndex, onClose }: {
  images: string[]
  startIndex: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(startIndex)
  const [imgLoaded, setImgLoaded] = useState(false)

  const prev = () => { setImgLoaded(false); setIndex((i) => (i > 0 ? i - 1 : images.length - 1)) }
  const next = () => { setImgLoaded(false); setIndex((i) => (i < images.length - 1 ? i + 1 : 0)) }

  // Close via the configurable close-modal keybind (topmost modal only)
  useEscToClose(onClose)

  // Keyboard navigation (arrows)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/90"
      onClick={(e) => { e.stopPropagation(); onClose() }}
    >
      {/* Close */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white cursor-pointer z-10"
      >
        <X size={24} />
      </button>

      {/* Counter */}
      {images.length > 1 && (
        <div className="absolute top-4 left-4 text-white/70 text-sm z-10">
          {index + 1} / {images.length}
        </div>
      )}

      {/* Previous */}
      {images.length > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); prev() }}
          className="absolute left-4 text-white/70 hover:text-white cursor-pointer z-10 p-2 rounded-full bg-black/30 hover:bg-black/50 transition-colors"
        >
          <ChevronLeft size={28} />
        </button>
      )}

      {/* Loading spinner for gallery */}
      {!imgLoaded && (
        <div className="absolute flex items-center gap-2 text-white/50 text-sm">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading…
        </div>
      )}

      {/* Image — uses blossom resolution to avoid refetching from a different server */}
      <GalleryImage
        key={`${index}-${images[index]}`}
        src={images[index]}
        loaded={imgLoaded}
        onLoad={() => setImgLoaded(true)}
      />

      {/* Next */}
      {images.length > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); next() }}
          className="absolute right-4 text-white/70 hover:text-white cursor-pointer z-10 p-2 rounded-full bg-black/30 hover:bg-black/50 transition-colors"
        >
          <ChevronRight size={28} />
        </button>
      )}
    </div>
  )
}

/** Gallery image that resolves through blossom cache to avoid refetching */
function GalleryImage({ src, loaded, onLoad }: {
  src: string
  loaded: boolean
  onLoad: () => void
}) {
  const blossom = useBlossomMedia(src)
  const resolvedSrc = blossom.src || src

  return (
    <img
      src={resolvedSrc}
      alt=""
      className={`max-w-[90vw] max-h-[90vh] object-contain rounded-lg transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      onClick={(e) => e.stopPropagation()}
      onLoad={onLoad}
      onError={blossom.onImgError}
    />
  )
}

/* ─── Nostr Mentions & Embeds ─────────────────────────────────────────── */

function NostrMention({ uri, onOpenProfile, onOpenThread }: {
  uri: string
  onOpenProfile?: (pubkey: string) => void
  onOpenThread?: (eventId: string) => void
}) {
  const raw = uri.replace('nostr:', '').replace(/^@/, '')

  try {
    const decoded = nip19.decode(raw)

    if (decoded.type === 'npub') {
      return <ProfileMention pubkey={decoded.data as string} onOpenProfile={onOpenProfile} />
    }

    if (decoded.type === 'nprofile') {
      const data = decoded.data as { pubkey: string }
      return <ProfileMention pubkey={data.pubkey} onOpenProfile={onOpenProfile} />
    }

    if (decoded.type === 'note') {
      return <EmbeddedNote eventId={decoded.data as string} onOpenProfile={onOpenProfile} onOpenThread={onOpenThread} />
    }

    if (decoded.type === 'nevent') {
      const data = decoded.data as { id: string; kind?: number; relays?: string[] }
      if (data.kind === 1111) {
        return <CommentCard eventId={data.id} relays={data.relays} />
      }
      return <EmbeddedNote eventId={data.id} onOpenProfile={onOpenProfile} onOpenThread={onOpenThread} />
    }

    if (decoded.type === 'naddr') {
      const data = decoded.data as { identifier: string; pubkey: string; kind: number; relays?: string[] }
      if (data.kind === 36942) {
        return <HubEventCard identifier={data.identifier} pubkey={data.pubkey} relays={data.relays} />
      }
      if (data.kind === 36943) {
        return <HubMessageCard identifier={data.identifier} pubkey={data.pubkey} relays={data.relays} />
      }
      if (data.kind === 30023) {
        return <LongFormCard identifier={data.identifier} pubkey={data.pubkey} relays={data.relays} />
      }
      if (data.kind === 30311) {
        return <LiveActivityCard identifier={data.identifier} pubkey={data.pubkey} relays={data.relays} />
      }
    }

    return <UnsupportedNostr uri={uri} kind={decoded.type} />
  } catch {
    return <span className="text-primary font-mono text-xs">{uri}</span>
  }
}

function ProfileMention({ pubkey, onOpenProfile }: {
  pubkey: string
  onOpenProfile?: (pubkey: string) => void
}) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(pubkey)
  const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(pubkey))

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpenProfile?.(pubkey) }}
      className="inline text-primary font-medium bg-primary/10 hover:bg-primary/20 p-1 leading-none rounded transition-colors cursor-pointer"
    >
      @{name}
    </button>
  )
}

function EmbeddedNote({ eventId, onOpenProfile, onOpenThread }: {
  eventId: string
  onOpenProfile?: (pubkey: string) => void
  onOpenThread?: (eventId: string) => void
}) {
  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const { getProfile } = useProfileCache()

  useEffect(() => {
    fetchEvents({ ids: [eventId], limit: 1 }).then((events) => {
      if (events.length > 0) setEvent(events[0])
      setLoading(false)
    })
  }, [eventId])

  if (loading) {
    return (
      <span className="inline-block my-1 px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground">
        Loading note...
      </span>
    )
  }

  if (!event) {
    return <UnsupportedNostr uri={`nostr:${nip19.noteEncode(eventId)}`} kind="note (not found)" />
  }

  if (event.kind !== 1) {
    return <UnsupportedNostr uri={`nostr:${nip19.noteEncode(eventId)}`} kind={`kind ${event.kind}`} />
  }

  const profile = getProfile(event.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(event.pubkey))

  return (
    <div
      className="my-2 rounded-lg border border-border p-3 hover:bg-accent/10 transition-colors cursor-pointer"
      onClick={(e) => { e.stopPropagation(); onOpenThread?.(eventId) }}
    >
      <div className="flex items-center gap-2 mb-1">
        <button onClick={(e) => { e.stopPropagation(); onOpenProfile?.(event.pubkey) }} className="cursor-pointer">
          <Avatar className="h-5 w-5">
            {profile?.picture && <AvatarImage src={profile.picture} />}
            <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
              {displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </button>
        <span className="text-xs font-semibold text-foreground">{displayName}</span>
        <span className="text-[10px] text-muted-foreground">{formatTimestamp(event.created_at)}</span>
      </div>
      <div className="text-xs text-foreground/80 whitespace-pre-wrap break-words line-clamp-4">
        {event.content}
      </div>
    </div>
  )
}

function UnsupportedNostr({ uri, kind }: { uri: string; kind: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(uri)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <span className="inline-flex items-center gap-1 my-1 px-2 py-1 rounded-md border border-border text-xs text-muted-foreground">
      Rendering of {kind} not supported
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={handleCopy} className="hover:text-foreground cursor-pointer">
              {copied ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Copy address</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  )
}
