/**
 * MessageContent — Shared markdown message renderer
 *
 * Handles: markdown, spoiler text (||text||), code blocks with line numbers,
 * media embeds (images, video, audio, YouTube, Twitter), and link previews.
 *
 * Used by both hub chat (ChannelView) and DMs (DMPage).
 */

import { useState, useEffect, useMemo, memo, useCallback, useRef, Children, isValidElement, cloneElement } from 'react'
import { Download, Loader2, Check, Copy, Hash, Link as LinkIcon, Eye } from 'lucide-react'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { VerificationBadge } from '@/components/ui/VerificationBadge'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { nip19 } from 'nostr-tools'
import { getEmojiMap, isEmojiSizeOk } from '@/stores/emojiStore'
import { getRenderLimit } from '@/lib/imageSizeGuard'
import { BlossomImg } from '@/components/ui/BlossomImg'
import { HubEventCard } from '@/components/hub/HubEventCard'
import { HubMessageCard } from '@/components/hub/HubMessageCard'
import { CalendarTimeEventCard } from '@/components/hub/CalendarTimeEventCard'
import { ProfileCard, NoteCard, LongFormCard, CommentCard, LiveActivityCard } from '@/components/nostr/NostrCards'
import { detectEmbed } from '@/lib/embeds'
import { Embed } from '@/components/ui/Embed'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { useHubStore } from '@/stores/hubStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { CustomAudioPlayer } from '@/components/ui/CustomAudioPlayer'

/* ─── Channel mention pill (#channel → click to open that channel) ─── */

/** Open a channel the way the sidebar does: select it (AppLayout routes voice/forum/
 *  text by the channel's type). For a voice channel, open its text-chat (like the
 *  sidebar's chat toggle) rather than the join screen. Navigate on the mobile layout. */
function openChannel(channelId: string, voice: boolean) {
  useHubStore.getState().setActiveChannel(channelId)
  useVoiceStore.getState().setVoiceChatMode(voice)   // voice channel → show its text-chat
  if (window.innerWidth <= 1080) useNavigationStore.getState().setMobileView('chat')
}

export function ChannelPill({ channelId, name, voice }: { channelId: string; name: string; voice?: boolean }) {
  // Resolve which category this channel sits under (in the active hub) so the hover
  // tooltip can disambiguate duplicate channel names across categories — the pill text
  // itself stays short (just #name), which is what a click already navigates to.
  const categoryName = useHubStore((s) => {
    const hub = s.activeHubId ? s.hubs[s.activeHubId] : undefined
    if (!hub) return undefined
    const ch = hub.channels.find((c) => c.channelId === channelId)
    if (!ch?.categoryId) return undefined
    return hub.categories.find((cat) => cat.categoryId === ch.categoryId)?.name
  })

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={(e) => { e.stopPropagation(); openChannel(channelId, !!voice) }}
            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors cursor-pointer align-baseline"
          >
            <Hash size={11} className="opacity-80" />{name}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {categoryName
            ? <span>#{name} <span className="opacity-60">· {categoryName}</span></span>
            : `#${name}`}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

type HubChannel = { channelId: string; name: string; type?: string }

/** Build a regex + name→channel lookup for the hub's channels (longest names first). */
function channelMatcher(channels?: HubChannel[]): { re: RegExp; byName: Map<string, HubChannel> } | null {
  if (!channels || channels.length === 0) return null
  const byName = new Map<string, HubChannel>()
  for (const c of channels) if (c.name) byName.set(c.name.toLowerCase(), c)
  const names = channels.map((c) => c.name).filter(Boolean).sort((a, b) => b.length - a.length)
  if (names.length === 0) return null
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(^|\\s)#(${escaped.join('|')})(?![a-zA-Z0-9_-])`, 'gi')
  return { re, byName }
}

/* ─── Spoiler text (Discord-style ||text||) ─── */

export function SpoilerText({ children }: { children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            onClick={() => setRevealed((v) => !v)}
            className={`inline rounded px-0.5 cursor-pointer transition-all duration-200 select-none
              ${revealed
                ? 'bg-muted/60 text-foreground'
                : 'bg-muted-foreground/80 text-transparent hover:bg-muted-foreground/60'
              }`}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          {revealed ? 'Click to hide spoiler' : 'Click to reveal spoiler'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/* ─── Muted word pill (click to reveal / rehide) ─── */

export function MutedWordPill({ children }: { children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            onClick={() => setRevealed((v) => !v)}
            className={`inline rounded-sm px-0.5 cursor-pointer transition-all duration-200 select-none
              ${revealed
                ? 'bg-slate-500/20 text-foreground'
                : 'bg-slate-500 text-slate-500'
              }`}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          {revealed ? 'Click to hide' : 'Muted word'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Split content by ||spoiler|| markers into typed segments */
export function splitSpoilerSegments(text: string): { type: 'text' | 'spoiler'; value: string }[] {
  const segments: { type: 'text' | 'spoiler'; value: string }[] = []
  const regex = /\|\|(.+?)\|\|/gs
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'spoiler', value: match[1] })
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }
  return segments
}

/* ─── Timestamp token (<t:unix>) ─── */

const TIMESTAMP_REGEX = /<t:(\d+)>/g

/** Check if text contains any <t:unix> tokens */
function hasTimestampTokens(text: string): boolean {
  TIMESTAMP_REGEX.lastIndex = 0
  return TIMESTAMP_REGEX.test(text)
}

/** Split text into plain text and timestamp segments */
function splitTimestampSegments(text: string): { type: 'text' | 'timestamp'; value: string }[] {
  const segments: { type: 'text' | 'timestamp'; value: string }[] = []
  TIMESTAMP_REGEX.lastIndex = 0
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = TIMESTAMP_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'timestamp', value: match[1] })
    lastIndex = TIMESTAMP_REGEX.lastIndex
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }
  return segments
}

/** Live-updating timestamp display — shows full date/time + relative indicator */
export function TimestampToken({ unix }: { unix: number }) {
  const [, setTick] = useState(0)

  // Re-render periodically to keep the relative time fresh
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const dt = new Date(unix * 1000)
  const datePart = dt.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
  const timePart = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  const diffMs = dt.getTime() - Date.now()
  const absDiffMs = Math.abs(diffMs)
  let relative: string
  if (absDiffMs < 60_000) {
    relative = diffMs >= 0 ? 'now' : 'just now'
  } else if (absDiffMs < 3_600_000) {
    const mins = Math.round(absDiffMs / 60_000)
    relative = diffMs >= 0 ? `in ${mins} minute${mins !== 1 ? 's' : ''}` : `${mins} minute${mins !== 1 ? 's' : ''} ago`
  } else if (absDiffMs < 86_400_000) {
    const hrs = Math.round(absDiffMs / 3_600_000)
    relative = diffMs >= 0 ? `in ${hrs} hour${hrs !== 1 ? 's' : ''}` : `${hrs} hour${hrs !== 1 ? 's' : ''} ago`
  } else {
    const days = Math.round(absDiffMs / 86_400_000)
    relative = diffMs >= 0 ? `in ${days} day${days !== 1 ? 's' : ''}` : `${days} day${days !== 1 ? 's' : ''} ago`
  }

  return (
    <span
      className="inline-block bg-primary/10 text-primary rounded-sm px-1 py-0.5 text-xs font-medium cursor-default"
      title={dt.toISOString()}
    >
      {datePart} – {timePart} ({relative})
    </span>
  )
}

/* ─── Link Preview (Tauri desktop only) ─── */

interface LinkPreviewData {
  title?: string
  description?: string
  image?: string
  siteName?: string
}

const previewCache = new Map<string, LinkPreviewData | null>()

/**
 * Only mounts its children once it scrolls near the viewport (IntersectionObserver).
 * Lets a chat full of link previews / embeds defer their fetches + iframe loads until
 * the user actually scrolls to them — important on slow connections. Once shown, it
 * stays mounted (re-fetching on every scroll would be worse). A skeleton of `minHeight`
 * reserves space to limit layout shift when the real content loads.
 */
function LazyInView({ minHeight = 0, skeleton = false, children }: { minHeight?: number; skeleton?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (visible) return
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          obs.disconnect()
        }
      },
      { rootMargin: '200px 0px' }, // start loading a touch before it's on screen
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [visible])

  if (visible) return <>{children}</>
  // Embeds reserve their space with a shimmer; previews use a zero-footprint spacer
  // (many resolve to nothing, so we avoid leaving an empty placeholder gap).
  return (
    <div
      ref={ref}
      className={skeleton ? 'media-skeleton rounded-lg max-w-[min(400px,100%)]' : undefined}
      style={{ minHeight }}
    />
  )
}

export function LinkPreview({ href }: { href: string }) {
  const showLinkPreviews = usePreferencesStore((s) => s.showLinkPreviews)
  const [preview, setPreview] = useState<LinkPreviewData | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!showLinkPreviews || !('__TAURI__' in window)) { setLoaded(true); return }

    if (previewCache.has(href)) {
      setPreview(previewCache.get(href) || null)
      setLoaded(true)
      return
    }

    let cancelled = false
      ; (async () => {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const data = await invoke<LinkPreviewData>('fetch_link_preview', { url: href })
          if (!cancelled) {
            const result = (data?.title || data?.description) ? data : null
            previewCache.set(href, result)
            setPreview(result)
          }
        } catch {
          previewCache.set(href, null)
        } finally {
          if (!cancelled) setLoaded(true)
        }
      })()
    return () => { cancelled = true }
  }, [href, showLinkPreviews])

  if (!loaded || !preview) return null

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex mt-1 rounded-lg border border-border overflow-hidden max-w-[min(400px,100%)] bg-secondary/30 hover:bg-secondary/50 transition-colors group"
    >
      {preview.image && (
        <img
          src={preview.image}
          alt=""
          className="w-24 h-24 object-cover shrink-0"
          loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      )}
      <div className="flex flex-col justify-center px-3 py-2 min-w-0">
        {preview.siteName && (
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{preview.siteName}</p>
        )}
        {preview.title && (
          <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">{preview.title}</p>
        )}
        {preview.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{preview.description}</p>
        )}
      </div>
    </a>
  )
}

/* ─── BlossomImage — inline image with blossom fallback + shimmer skeleton ─── */

function BlossomImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const blossom = useBlossomMedia(src)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  // Reset states when src changes or blossom fails over to a new server
  useEffect(() => { setLoaded(false); setError(false) }, [src, blossom.src])

  if (blossom.error === 'not-found') {
    return (
      <div className="rounded-lg mt-1 bg-destructive/10 border border-destructive/30 flex flex-col items-center text-xs py-3 px-3 gap-1 max-w-[min(400px,100%)]">
        <span className="text-muted-foreground">Image not found on any server</span>
        <a href={src} target="_blank" rel="noopener noreferrer" className="text-primary text-xs hover:underline">⬇ Try direct link</a>
      </div>
    )
  }

  const resolvedSrc = blossom.src || src
  const isLoading = !loaded && !error

  return (
    <div className="relative block mt-1 max-w-[min(400px,100%)]">
      {/* Shimmer skeleton while loading */}
      {isLoading && (
        <div className="media-skeleton" style={{ minHeight: 160, width: 400, maxWidth: '100%' }} />
      )}
      {error && (
        <div className="rounded-lg bg-secondary/40 border border-border/50 flex items-center justify-center text-xs text-muted-foreground/60 py-6 max-w-[min(400px,100%)]">
          Failed to load image
        </div>
      )}
      {/* Always render img (hidden until loaded) — matches BlobMedia pattern */}
      <img
        src={resolvedSrc}
        alt={alt || ''}
        className={`${className || 'max-w-[min(400px,100%)] max-h-[300px] rounded-lg border border-transparent hover:border-border transition-colors object-contain'} transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0 h-0 overflow-hidden'}`}
        onLoad={() => { setLoaded(true); setError(false) }}
        onError={() => { blossom.onImgError(); setError(true) }}
      />
      {loaded && blossom.verified !== 'verified' && blossom.expectedHash && (
        <VerificationBadge
          verified={blossom.verified}
          expectedHash={blossom.expectedHash}
          servers={blossom.servers}
          ext={blossom.ext}
          onRecovered={blossom.acceptVerifiedUrl}
        />
      )}
    </div>
  )
}

/* ─── Video Embed with blossom fallback + shimmer skeleton ─── */

export function VideoEmbed({ src }: { src: string }) {
  const blossom = useBlossomMedia(src)
  const [failed, setFailed] = useState(false)

  // Cache-and-play state
  const [cacheState, setCacheState] = useState<'idle' | 'downloading' | 'done' | 'error' | 'too-large'>('idle')
  const [cacheProgress, setCacheProgress] = useState(0) // 0-100
  const [cacheLoaded, setCacheLoaded] = useState(0)  // bytes downloaded
  const [cacheTotal, setCacheTotal] = useState(0)     // total bytes (from content-length)
  const [cacheBlobUrl, setCacheBlobUrl] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const MAX_PREVIEW_BYTES = 50 * 1024 * 1024 // 50 MB

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  useEffect(() => {
    setFailed(false)
    setCacheState('idle')
    setCacheProgress(0)
    setCacheLoaded(0)
    setCacheTotal(0)
    if (errorTimerRef.current) { clearTimeout(errorTimerRef.current); errorTimerRef.current = null }
    // Revoke old blob URL on src change
    if (cacheBlobUrl) { URL.revokeObjectURL(cacheBlobUrl); setCacheBlobUrl(null) }
  }, [src]) // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      if (cacheBlobUrl) URL.revokeObjectURL(cacheBlobUrl)
      abortRef.current?.abort()
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    }
  }, [cacheBlobUrl])

  const showError = (type: 'error' | 'too-large' = 'error') => {
    setCacheState(type)
    setCacheProgress(0)
    abortRef.current = null
    errorTimerRef.current = setTimeout(() => { setCacheState('idle'); errorTimerRef.current = null }, 4000)
  }

  /** Stream-read a fetch response into a blob URL */
  const streamToBlob = async (res: Response, signal: AbortSignal): Promise<string | null | 'too-large'> => {
    if (!res.ok || !res.body) return null

    const contentLength = Number(res.headers.get('content-length') || 0)
    const contentType = res.headers.get('content-type') || 'video/mp4'

    // Size cap — reject before downloading if server reports size
    if (contentLength > MAX_PREVIEW_BYTES) {
      setCacheTotal(contentLength)
      return 'too-large'
    }

    setCacheTotal(contentLength)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.length
      setCacheLoaded(loaded)

      // Runtime cap — abort if actual bytes exceed limit (covers missing content-length)
      if (loaded > MAX_PREVIEW_BYTES) {
        reader.cancel()
        setCacheTotal(loaded)
        return 'too-large'
      }

      if (contentLength > 0) {
        setCacheProgress(Math.round((loaded / contentLength) * 100))
      }
    }

    if (signal.aborted) return null

    const blob = new Blob(chunks, { type: contentType })
    return URL.createObjectURL(blob)
  }

  const handleCacheAndPlay = async () => {
    if (cacheState === 'downloading') return
    const controller = new AbortController()
    abortRef.current = controller
    setCacheState('downloading')
    setCacheProgress(0)

    const resolvedUrl = blossom.src || src

    try {
      const res = await fetch(resolvedUrl, {
        signal: controller.signal,
        referrerPolicy: 'no-referrer',
      })

      const result = await streamToBlob(res, controller.signal)
      if (result === 'too-large') {
        showError('too-large')
        return
      }
      if (result) {
        setCacheBlobUrl(result)
        setCacheState('done')
        abortRef.current = null
        return
      }

      showError()
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setCacheState('idle')
        setCacheProgress(0)
      } else {
        showError()
      }
      abortRef.current = null
    }
  }

  const handleCancelCache = () => {
    abortRef.current?.abort()
  }

  if (blossom.error === 'not-found') {
    return (
      <div className="rounded-lg mt-1 bg-destructive/10 border border-destructive/30 flex flex-col items-center text-xs py-3 px-3 gap-1 max-w-[min(400px,100%)]">
        <span className="text-muted-foreground">Video not found on any server</span>
        <a href={src} target="_blank" rel="noopener noreferrer" className="text-primary text-xs hover:underline">⬇ Try direct link</a>
      </div>
    )
  }

  const resolvedSrc = blossom.src || src

  // Cached blob ready — play inline
  if (cacheState === 'done' && cacheBlobUrl) {
    return (
      <div className="relative block mt-1 max-w-[min(400px,100%)]">
        <video
          src={cacheBlobUrl}
          controls
          autoPlay
          className="max-w-[min(400px,100%)] max-h-[300px] rounded-lg border border-transparent hover:border-border transition-colors"
        />
      </div>
    )
  }

  if (failed) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 mt-1 rounded-lg border border-border bg-secondary/40 max-w-[min(400px,100%)]">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Download size={18} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground font-medium truncate">Video link</p>
          <p className="text-xs text-muted-foreground truncate">{src.split('/').pop()?.split('?')[0] || 'Video'}</p>
          {/* Download progress bar */}
          {cacheState === 'downloading' && (
            <div className="mt-1.5">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1 rounded-full bg-border overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-200"
                    style={{ width: `${cacheProgress}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{cacheProgress}%</span>
              </div>
              {cacheTotal > 0 && (
                <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{formatBytes(cacheLoaded)} / {formatBytes(cacheTotal)}</p>
              )}
            </div>
          )}
          {cacheState === 'error' && (
            <p className="text-[11px] text-destructive mt-0.5">Preview blocked by server</p>
          )}
          {cacheState === 'too-large' && (
            <p className="text-[11px] text-destructive mt-0.5">Too large to preview ({formatBytes(cacheTotal)})</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {cacheState === 'downloading' ? (
            <button
              onClick={handleCancelCache}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
              title="Cancel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          ) : (
            <>
              <a
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
                title="Download"
              >
                <Download size={15} />
              </a>
              <button
                onClick={handleCacheAndPlay}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-primary hover:bg-primary/10 transition-colors cursor-pointer"
                title="Preview — download and play inline"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative block mt-1 max-w-[min(400px,100%)]">
      <video
        src={resolvedSrc}
        controls
        className="max-w-[min(400px,100%)] max-h-[300px] rounded-lg border border-transparent hover:border-border transition-colors"
        preload="none"
        onError={() => setFailed(true)}
      />
      {blossom.verified !== 'verified' && blossom.expectedHash && (
        <VerificationBadge
          verified={blossom.verified}
          expectedHash={blossom.expectedHash}
          servers={blossom.servers}
          ext={blossom.ext}
          onRecovered={blossom.acceptVerifiedUrl}
        />
      )}
    </div>
  )
}

/* ─── Audio Embed with blossom fallback + shimmer skeleton ─── */

function AudioEmbed({ src }: { src: string }) {
  const blossom = useBlossomMedia(src)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => { setLoaded(false) }, [src])

  if (blossom.error === 'not-found') {
    return (
      <div className="rounded-lg mt-1 bg-destructive/10 border border-destructive/30 flex flex-col items-center text-xs py-3 px-3 gap-1 max-w-[340px]">
        <span className="text-muted-foreground">Audio not found on any server</span>
        <a href={src} target="_blank" rel="noopener noreferrer" className="text-primary text-xs hover:underline">⬇ Try direct link</a>
      </div>
    )
  }

  const resolvedSrc = blossom.src || src
  const isLoading = !loaded

  return (
    <div className="relative mt-1 max-w-[min(400px,100%)]">
      {/* Shimmer skeleton while loading */}
      {isLoading && (
        <div className="media-skeleton" style={{ width: 300, height: 44 }} />
      )}
      {/* Audio player */}
      <div className={`flex flex-col gap-1 px-2 py-1.5 rounded-lg border border-border/50 bg-secondary/30 transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0 h-0 overflow-hidden'}`}>
        <CustomAudioPlayer
          src={resolvedSrc}
          title={src.split('/').pop() || 'Audio'}
          preload="metadata"
          onLoadedData={() => setLoaded(true)}
        />
        {loaded && blossom.verified !== 'verified' && blossom.expectedHash && (
          <VerificationBadge
            verified={blossom.verified}
            expectedHash={blossom.expectedHash}
            servers={blossom.servers}
            ext={blossom.ext}
            onRecovered={blossom.acceptVerifiedUrl}
            position="top-right"
            size="sm"
          />
        )}
      </div>
    </div>
  )
}

/* ─── Code Block with line numbers + copy ─── */

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Matches the long-form article code block: header (language + copy) over a plain <pre>.
  return (
    <div className="my-2">
      <div className="flex items-center justify-between px-3 py-1.5 rounded-t-lg bg-secondary/60 border border-border border-b-0">
        <span className="text-[10px] text-muted-foreground/60 font-mono">{language || ''}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="rounded-b-lg rounded-t-none bg-secondary/80 border border-border p-4 overflow-x-auto text-xs font-mono !mt-0">{code}</pre>
    </div>
  )
}


/* ─── Main MessageContent renderer ─── */

/** "Link preview hidden" placeholder that reveals the embed on click (public chat). */
function RevealEmbed({ embed }: { embed: ReturnType<typeof detectEmbed> }) {
  const [revealed, setRevealed] = useState(false)
  if (!embed) return null
  if (revealed) {
    return (
      <div className="mt-1">
        <LazyInView skeleton minHeight={embed.layout === 'video' ? 225 : (embed.height ?? 200)}>
          <Embed embed={embed} maxWidth={400} />
        </LazyInView>
      </div>
    )
  }
  return (
    <div className="mt-1 flex items-center gap-2.5 py-1.5 px-3 rounded-lg bg-muted/40 border border-border/40">
      <LinkIcon size={14} className="text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground">Link preview hidden</span>
      <button
        onClick={() => setRevealed(true)}
        className="ml-auto flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full text-muted-foreground hover:text-foreground bg-muted/60 hover:bg-muted transition-colors cursor-pointer"
      >
        <Eye size={11} /> Preview
      </button>
    </div>
  )
}

export const MessageContent = memo(function MessageContent({ content, suffix, onProfileClick, emojiTags, disableLinkPreviews, disableCustomEmojis, disableMedia, disableHubInviteCards, mutedWords, hubRoleNames, hubChannels }: { content: string; suffix?: React.ReactNode; onProfileClick?: (pubkey: string) => void; emojiTags?: [string, string, string?][]; disableLinkPreviews?: boolean; disableCustomEmojis?: boolean; disableMedia?: boolean; disableHubInviteCards?: boolean; mutedWords?: Set<string>; hubRoleNames?: string[]; hubChannels?: HubChannel[] }) {
  const globalEmbedsOff = !usePreferencesStore((s) => s.showEmbeds)
  const globalMutedWordsOff = !usePreferencesStore((s) => s.hideMutedWords)
  const globalMediaOff = !usePreferencesStore((s) => s.showMedia)
  const globalEmojisOff = !usePreferencesStore((s) => s.showCustomEmojis)
  const effectiveDisablePreviews = disableLinkPreviews || globalEmbedsOff
  const effectiveDisableMedia = disableMedia || globalMediaOff
  const effectiveDisableEmojis = disableCustomEmojis || globalEmojisOff
  const effectiveMutedWords = globalMutedWordsOff ? undefined : mutedWords
  const hasSpoilers = /\|\|.+?\|\|/s.test(content)

  // Preserve multiple blank lines: \n\n is a normal paragraph break (handled by
  // mb-3 margins). For every extra newline beyond 2, insert a \u00a0 spacer paragraph
  // so react-markdown doesn't collapse them.
  const processed = content.replace(/\n{3,}/g, (m) => {
    const spacers = Array(m.length - 2).fill('\u00a0').join('\n\n')
    return '\n\n' + spacers + '\n\n'
  })

  /** Replace muted words in a text string with redacted pill spans */
  const redactMutedWords = useCallback((text: string): React.ReactNode => {
    if (!effectiveMutedWords || effectiveMutedWords.size === 0) return text
    // Build a regex that matches any muted word (case-insensitive)
    const escaped = Array.from(effectiveMutedWords).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi')
    const parts = text.split(regex)
    if (parts.length <= 1) return text
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        return <MutedWordPill key={i}>{part}</MutedWordPill>
      }
      return part
    })
  }, [effectiveMutedWords])

  /** Recursively walk React children and redact muted words in text nodes */
  const redactChildren = useCallback((children: React.ReactNode): React.ReactNode => {
    if (!effectiveMutedWords || effectiveMutedWords.size === 0) return children
    return Children.map(children, (child) => {
      if (typeof child === 'string') return redactMutedWords(child)
      if (isValidElement(child) && (child.props as any)?.children) {
        return cloneElement(child, {}, redactChildren((child.props as any).children))
      }
      return child
    })
  }, [effectiveMutedWords, redactMutedWords])

  // Collect embeds/previews during render, then render them all after the text content
  // This prevents embeds from splitting inline text (e.g. "testing out [link] [EMBED] , seems decent")
  type DeferredEmbed = { type: 'embed'; href: string; embed: ReturnType<typeof detectEmbed> } | { type: 'preview'; href: string } | { type: 'hidden'; href: string; embed: ReturnType<typeof detectEmbed> }
  const collectedEmbedsRef = useRef<DeferredEmbed[]>([])

  /** Renders all embeds/previews collected during the last markdown pass */
  const DeferredEmbeds = useCallback(() => {
    const items = collectedEmbedsRef.current
    // Deduplicate by href — React StrictMode re-invokes the Markdown render,
    // causing the `a` handler to push the same URL multiple times.
    const seen = new Set<string>()
    const unique = items.filter(item => {
      if (seen.has(item.href)) return false
      seen.add(item.href)
      return true
    })
    if (unique.length === 0) return null
    return (
      <>
        {unique.map((item, i) =>
          item.type === 'embed' ? (
            <div key={`embed-${i}`} className="mt-1">
              <LazyInView skeleton minHeight={item.embed!.layout === 'video' ? 225 : (item.embed!.height ?? 200)}>
                <Embed embed={item.embed!} maxWidth={400} />
              </LazyInView>
            </div>
          ) : item.type === 'hidden' ? (
            <RevealEmbed key={`hidden-${i}`} embed={item.embed} />
          ) : (
            <LazyInView key={`preview-${i}`}>
              <LinkPreview href={item.href} />
            </LazyInView>
          )
        )}
      </>
    )
  }, [])

  // Stable reference — prevents React from unmounting/remounting custom elements on parent re-renders
  const components = useMemo<import('react-markdown').Components>(() => ({
    p: ({ children }) => {
      if (children === '\u00a0') return <p className="h-3" />
      const childArr = Array.isArray(children) ? children : [children]
      const hasBlock = childArr.some((c: any) =>
        c?.type && (typeof c.type === 'string'
          ? ['video', 'audio', 'iframe', 'div', 'figure'].includes(c.type) ||
          (c.type === 'img' && !(c.props?.alt as string)?.startsWith('emoji:') && !(c.props?.alt as string)?.startsWith('timestamp:'))
          : true
        ) && c?.props
      )
      const processed = redactChildren(children)
      if (hasBlock) return <div className="mb-3 last:mb-0">{processed}</div>
      return <p className="mb-3 last:mb-0">{processed}</p>
    },
    h1: ({ children }) => <p className="font-bold text-lg mb-1">{children}</p>,
    h2: ({ children }) => <p className="font-bold text-[15px] mb-1">{children}</p>,
    h3: ({ children }) => <p className="font-semibold text-sm mb-1">{children}</p>,
    h4: ({ children }) => <p className="font-semibold text-sm mb-1 text-foreground/80">{children}</p>,
    h5: ({ children }) => <p className="font-medium text-xs uppercase tracking-wide mb-1 text-foreground/70">{children}</p>,
    h6: ({ children }) => <p className="font-medium text-xs mb-1 text-muted-foreground">{children}</p>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    del: ({ children }) => <del className="opacity-60">{children}</del>,
    a: ({ href, children }) => {
      if (!href || /^javascript:/i.test(href)) return <span>{children}</span>
      // Normalize URLs without a protocol — prevents relative path resolution
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
        href = 'https://' + href
      }
      if (!effectiveDisableMedia && /\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?[^#]*)?(#.*)?$/i.test(href)) {
        return <BlossomImage src={href} alt={String(children) || ''} />
      }
      if (!effectiveDisableMedia && /\.(mp4|webm|mov|avi|mkv)(\?[^#]*)?(#.*)?$/i.test(href)) {
        return <VideoEmbed src={href} />
      }
      if (!effectiveDisableMedia && /\.(mp3|ogg|wav|flac|aac|m4a)(\?[^#]*)?(#.*)?$/i.test(href)) {
        return <AudioEmbed src={href} />
      }
      // Embeddable URLs (YouTube, Twitch, Kick, Twitter/X, Spotify, Steam, TikTok)
      const embedInfo = detectEmbed(href)
      if (embedInfo) {
        // Defer the embed — or a "hidden" placeholder when previews are disabled — to render after text.
        collectedEmbedsRef.current.push(effectiveDisablePreviews ? { type: 'hidden', href, embed: embedInfo } : { type: 'embed', href, embed: embedInfo })
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{children}</a>
        )
      }
      // Defer link preview to render after all text content
      if (!effectiveDisablePreviews) {
        collectedEmbedsRef.current.push({ type: 'preview', href })
      }
      return (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {children}
              </a>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[min(400px,100%)] break-all">
              {href}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )
    },
    ul: ({ children }) => <ul className="list-disc list-outside pl-5 mb-3 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal list-outside pl-5 mb-3 last:mb-0">{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const isBlock = className?.includes('language-') || (typeof children === 'string' && children.includes('\n'))
      if (isBlock) {
        const codeStr = String(children).replace(/\n$/, '')
        return <CodeBlock code={codeStr} language={className?.replace('language-', '')} />
      }
      return (
        <code className="bg-secondary/80 border border-border rounded px-1.5 py-0.5 text-xs font-mono text-primary">
          {children}
        </code>
      )
    },
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-primary/40 pl-2 mb-3 last:mb-0 opacity-80">{children}</blockquote>
    ),
    hr: () => <hr className="border-border my-2" />,
    img: ({ src, alt }) => {
      // Mention pills (inserted by preMentionMarkdown) — render inline styled badge
      // alt format: "mention:everyone", "mention:here", "mention:role:roleName"
      if (alt && alt.startsWith('mention:')) {
        const mentionType = alt.slice(8) // e.g. "everyone", "here", "role:r2"
        let label: string
        let colorClass: string
        if (mentionType === 'everyone') {
          label = '@everyone'
          colorClass = 'bg-primary/15 text-primary hover:bg-primary/25'
        } else if (mentionType === 'here') {
          label = '@here'
          colorClass = 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
        } else if (mentionType.startsWith('role:')) {
          label = `@${mentionType.slice(5)}`
          colorClass = 'bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25'
        } else {
          label = `@${mentionType}`
          colorClass = 'bg-primary/15 text-primary hover:bg-primary/25'
        }
        return (
          <span
            className={`inline-flex items-center rounded p-1 leading-none text-xs font-medium cursor-default transition-colors ${colorClass}`}
          >
            {label}
          </span>
        )
      }
      // Timestamp tokens (inserted by preTimestampMarkdown) — render inline badge
      // alt format: "timestamp:unix"
      if (alt && alt.startsWith('timestamp:')) {
        const unix = parseInt(alt.slice(10), 10)
        if (!isNaN(unix)) return <TimestampToken unix={unix} />
      }
      // NIP-30 custom emoji images (inserted by preEmojify) — render inline at emoji size
      // alt format: "emoji:shortcode" or "emoji:shortcode|setAddress"
      if (alt && alt.startsWith('emoji:')) {
        // When custom emojis are disabled, show a gray pill placeholder
        if (effectiveDisableEmojis) {
          const rest = alt.slice(6)
          const pipeIdx = rest.indexOf('|')
          const shortcode = pipeIdx >= 0 ? rest.slice(0, pipeIdx) : rest
          return (
            <span className="inline-flex items-center bg-muted-foreground/20 text-muted-foreground text-[11px] rounded px-1 py-0.5 align-text-bottom" title={`:${shortcode}:`}>
              &lt;disabled&gt;
            </span>
          )
        }
        const rest = alt.slice(6)
        const pipeIdx = rest.indexOf('|')
        const shortcode = pipeIdx >= 0 ? rest.slice(0, pipeIdx) : rest
        const setAddress = pipeIdx >= 0 ? rest.slice(pipeIdx + 1) : undefined
        // Size gate: skip rendering if emoji exceeds 1 MB
        if (src && !isEmojiSizeOk(src)) {
          return <span title={`Emoji too large (>${getRenderLimit('chat')} MB limit)`}>{`:${shortcode}:`}</span>
        }
        return (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <BlossomImg
                  src={src || ''}
                  alt={`:${shortcode}:`}
                  className="inline h-5 w-5 align-text-bottom object-contain cursor-pointer hover:scale-125 transition-transform"
                  loading="lazy"
                  data-set-address={setAddress || undefined}
                  onClick={(e) => dispatchEmojiClick(e, shortcode)}
                />
              </TooltipTrigger>
              <TooltipContent side="top" className="flex items-center gap-2 px-2.5 py-1.5 z-[150]">
                <img src={src} alt={shortcode} className="w-8 h-8 object-contain" />
                <span className="text-xs font-mono">:{shortcode}:</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )
      }
      // Channel mention pills (inserted by preChannelMarkdown) — alt "channel:id|type|name"
      if (alt && alt.startsWith('channel:')) {
        const rest = alt.slice(8)
        const p1 = rest.indexOf('|')
        const p2 = rest.indexOf('|', p1 + 1)
        const channelId = p1 >= 0 ? rest.slice(0, p1) : rest
        const type = p1 >= 0 && p2 >= 0 ? rest.slice(p1 + 1, p2) : ''
        const name = p2 >= 0 ? rest.slice(p2 + 1) : (p1 >= 0 ? rest.slice(p1 + 1) : rest)
        return <ChannelPill channelId={channelId} name={name} voice={type === 'voice'} />
      }
      // Normal images
      return <BlossomImage src={src || ''} alt={alt || ''} />
    },
  }), [effectiveDisablePreviews, effectiveDisableEmojis, effectiveDisableMedia, redactChildren, hubRoleNames])

  // Split content on nostr bech32 identifiers to render cards inline
  const nostrSegments = useMemo(() => splitNostr(content), [content])
  const hasNostr = nostrSegments.some(s => s.type === 'nostr')

  const renderMarkdown = (text: string) => {
    // Clear the deferred embeds collector before each render pass
    collectedEmbedsRef.current = []
    // Pre-process: replace @everyone, @here, @roleName with markdown image syntax for inline rendering
    const mentioned = preMentionMarkdown(text, hubRoleNames)
    // Pre-process: replace <t:unix> with markdown image syntax for inline rendering
    const timestamped = preTimestampMarkdown(mentioned)
    // Pre-process: replace :shortcode: with markdown image syntax for NIP-30 emojis
    const emojified = effectiveDisableEmojis ? timestamped : preEmojifyMarkdown(timestamped, emojiTags)
    // Pre-process: replace #channel-name (matching a real hub channel) with a clickable pill
    const channeled = preChannelMarkdown(emojified, hubChannels)
    const proc = channeled.replace(/\n{3,}/g, (m) => {
      const spacers = Array(m.length - 2).fill('\u00a0').join('\n\n')
      return '\n\n' + spacers + '\n\n'
    })
    return (
      <>
        <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
          {proc}
        </Markdown>
        <DeferredEmbeds />
      </>
    )
  }

  /** Wrap output with suffix that appears inline at the end of the last paragraph */
  const wrapWithSuffix = (node: React.ReactNode) => {
    if (!suffix) return node
    return (
      <span className="msg-with-suffix">
        {node}
        {suffix}
      </span>
    )
  }

  // If content has nostr references, render segments with cards
  if (hasNostr) {
    return wrapWithSuffix(
      <>
        {nostrSegments.map((seg, i) => {
          if (seg.type === 'nostr') {
            return <NostrCard key={i} bech32={seg.value} onProfileClick={onProfileClick} disableHubInviteCards={disableHubInviteCards} />
          }
          if (hasSpoilers) {
            const segs = splitSpoilerSegments(seg.value)
            return segs.map((s, j) =>
              s.type === 'spoiler'
                ? <SpoilerText key={`${i}-${j}`}>{s.value}</SpoilerText>
                : <span key={`${i}-${j}`}>{renderMarkdown(s.value)}</span>
            )
          }
          // If the text segment is simple (no markdown block syntax and no URLs),
          // render inline to avoid <p> tags pushing content to a new line after
          // mentions. Segments containing a URL must go through markdown so the link
          // stays clickable and its preview/embed renders (the inline path doesn't
          // linkify) — otherwise a link after an @mention renders as plain text.
          const hasBlockSyntax = /^(\s*(#{1,6}\s|[-*]\s|\d+\.\s|>|```|---|\|))|\n\n/m.test(seg.value)
          const hasUrl = /(https?:\/\/|www\.)\S/i.test(seg.value)
          if (!hasBlockSyntax && !hasUrl) {
            return <span key={i}>{emojifyTimestampAndMention(seg.value, emojiTags, hubRoleNames, hubChannels)}</span>
          }
          return <span key={i}>{renderMarkdown(seg.value)}</span>
        })}
      </>
    )
  }

  // If content has spoilers, split into segments and render each
  if (hasSpoilers) {
    const segments = splitSpoilerSegments(content)
    return wrapWithSuffix(
      <>
        {segments.map((seg, i) => {
          if (seg.type === 'spoiler') {
            return <SpoilerText key={i}>{seg.value}</SpoilerText>
          }
          return <span key={i}>{renderMarkdown(seg.value)}</span>
        })}
      </>
    )
  }

  return wrapWithSuffix(renderMarkdown(content))
})

/* ─── Emoji click → discovery dispatch ───────────────────── */

/** Dispatch a custom DOM event when a rendered emoji is clicked */
function dispatchEmojiClick(e: React.MouseEvent, shortcode: string) {
  e.stopPropagation()
  const emojiMap = getEmojiMap()
  const entry = emojiMap.get(shortcode)
  // Also check for set address from data attribute (event-level tag)
  const imgEl = e.target as HTMLImageElement
  const eventSetAddr = imgEl.dataset?.setAddress
  window.dispatchEvent(new CustomEvent('emoji-click', {
    detail: {
      shortcode,
      url: entry?.url || imgEl.src,
      setAddress: entry?.setAddress || eventSetAddr || null,
    },
  }))
}

/* ─── Timestamp pre-processing for markdown ──────────────── */

/**
 * Pre-process text for markdown rendering: replace <t:unix> with markdown image syntax.
 * Uses alt="timestamp:unix" as a marker for the custom img component to render a TimestampToken.
 * The src is a dummy value since the img handler intercepts before loading.
 */
function preTimestampMarkdown(text: string): string {
  TIMESTAMP_REGEX.lastIndex = 0
  return text.replace(TIMESTAMP_REGEX, (_full, unix: string) => {
    return `![timestamp:${unix}](ts)`
  })
}

/* ─── Group/role mention pre-processing ──────────────────── */

/**
 * Pre-process text for markdown rendering: replace @everyone, @here, and @roleName
 * with markdown image syntax. Uses alt="mention:type" as a marker for the custom
 * img component to render as styled inline mention pills.
 *
 * Word-boundary matching ensures we don't match partial words like "everywhere".
 */
function preMentionMarkdown(text: string, hubRoleNames?: string[]): string {
  // Replace @everyone (case-insensitive, word-boundary)
  let result = text.replace(/(^|[^a-zA-Z0-9_])@everyone(?=[^a-zA-Z0-9_]|$)/gi, '$1![mention:everyone](m)')

  // Replace @here (case-insensitive, word-boundary)
  result = result.replace(/(^|[^a-zA-Z0-9_])@here(?=[^a-zA-Z0-9_]|$)/gi, '$1![mention:here](m)')

  // Replace @roleName for each hub role
  if (hubRoleNames && hubRoleNames.length > 0) {
    for (const roleName of hubRoleNames) {
      if (!roleName || roleName === 'everyone') continue // skip 'everyone' — already handled
      // Escape regex special characters in role name
      const escaped = roleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const roleRegex = new RegExp(`(^|[^a-zA-Z0-9_])@${escaped}(?=[^a-zA-Z0-9_]|$)`, 'gi')
      result = result.replace(roleRegex, `$1![mention:role:${roleName}](m)`)
    }
  }

  return result
}

/* ─── Custom emoji (NIP-30) :shortcode: rendering ────────── */

const EMOJI_SHORTCODE = /:([a-zA-Z0-9_-]+):/g

/**
 * Pre-process text for markdown rendering: replace :shortcode: with markdown image syntax.
 * Uses alt="emoji:shortcode" as a marker for the custom img component to render at emoji size.
 */
function preEmojifyMarkdown(text: string, eventEmojiTags?: [string, string, string?][]): string {
  const emojiMap = getEmojiMap()
  // Build fallback map from event-level emoji tags: shortcode -> { url, setAddress }
  const eventMap = new Map<string, { url: string; setAddress?: string }>()
  if (eventEmojiTags) {
    for (const [sc, url, addr] of eventEmojiTags) {
      if (!emojiMap.has(sc)) eventMap.set(sc, { url, setAddress: addr })
    }
  }
  if (emojiMap.size === 0 && eventMap.size === 0) return text

  EMOJI_SHORTCODE.lastIndex = 0
  return text.replace(EMOJI_SHORTCODE, (full, shortcode: string) => {
    const emoji = emojiMap.get(shortcode)
    if (emoji) {
      const addrSuffix = emoji.setAddress ? `|${emoji.setAddress}` : ''
      return `![emoji:${shortcode}${addrSuffix}](${emoji.url})`
    }
    const ev = eventMap.get(shortcode)
    if (ev) {
      const addrSuffix = ev.setAddress ? `|${ev.setAddress}` : ''
      return `![emoji:${shortcode}${addrSuffix}](${ev.url})`
    }
    return full
  })
}

/** Convert :shortcode: patterns to inline <img> elements (for non-markdown paths) */
function emojify(text: string, eventEmojiTags?: [string, string, string?][]): React.ReactNode {
  const emojiMap = getEmojiMap()
  const eventMap = new Map<string, { url: string; setAddress?: string }>()
  if (eventEmojiTags) {
    for (const [sc, url, addr] of eventEmojiTags) {
      if (!emojiMap.has(sc)) eventMap.set(sc, { url, setAddress: addr })
    }
  }
  if (emojiMap.size === 0 && eventMap.size === 0) return text

  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  EMOJI_SHORTCODE.lastIndex = 0
  while ((match = EMOJI_SHORTCODE.exec(text)) !== null) {
    const shortcode = match[1]
    const emoji = emojiMap.get(shortcode)
    const ev = eventMap.get(shortcode)
    const url = emoji?.url || ev?.url
    if (!url) continue
    // Size gate: skip rendering if emoji exceeds the render limit
    if (!isEmojiSizeOk(url)) continue
    const setAddr = emoji?.setAddress || ev?.setAddress

    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    parts.push(
      <TooltipProvider key={`emoji-${match.index}`} delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <BlossomImg
              src={url}
              alt={`:${shortcode}:`}
              className="inline h-5 w-5 align-text-bottom object-contain cursor-pointer hover:scale-125 transition-transform"
              loading="lazy"
              data-set-address={setAddr || undefined}
              onClick={(e) => dispatchEmojiClick(e, shortcode)}
            />
          </TooltipTrigger>
          <TooltipContent side="top" className="flex items-center gap-2 px-2.5 py-1.5 z-[150]">
            <img src={url} alt={shortcode} className="w-8 h-8 object-contain" />
            <span className="text-xs font-mono">:{shortcode}:</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
    lastIndex = match.index + match[0].length
  }

  if (parts.length === 0) return text
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return <>{parts}</>
}

/** Process both :shortcode: emojis AND <t:unix> timestamp tokens in one pass (for non-markdown inline paths) */
function emojifyAndTimestamp(text: string, eventEmojiTags?: [string, string, string?][]): React.ReactNode {
  // First pass: emojify
  const emojified = emojify(text, eventEmojiTags)

  // If emojify returned a string (no emojis found), check for timestamps directly
  if (typeof emojified === 'string') {
    if (!hasTimestampTokens(emojified)) return emojified
    const tsSegs = splitTimestampSegments(emojified)
    return (
      <>
        {tsSegs.map((seg, i) =>
          seg.type === 'timestamp'
            ? <TimestampToken key={`ts-${i}`} unix={parseInt(seg.value, 10)} />
            : <span key={`t-${i}`}>{seg.value}</span>
        )}
      </>
    )
  }

  // If emojified is already a ReactNode tree, we need to process string children for timestamps
  // The emojify function returns a fragment with mixed string and element children
  // Walk the children array and expand timestamp tokens in string parts
  if (emojified && typeof emojified === 'object' && 'props' in emojified) {
    const children = (emojified as any).props.children
    if (Array.isArray(children)) {
      const processed = children.flatMap((child: React.ReactNode, ci: number): React.ReactNode[] => {
        if (typeof child === 'string' && hasTimestampTokens(child)) {
          return splitTimestampSegments(child).map((seg, si) =>
            seg.type === 'timestamp'
              ? <TimestampToken key={`ts-${ci}-${si}`} unix={parseInt(seg.value, 10)} />
              : seg.value
          )
        }
        return [child]
      })
      return <>{processed}</>
    }
  }

  return emojified
}

/** Inline mention pill styles — shared between markdown and inline paths */
const MENTION_STYLES: Record<string, { label: string; className: string }> = {
  everyone: { label: '@everyone', className: 'bg-primary/15 text-primary hover:bg-primary/25' },
  here: { label: '@here', className: 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25' },
}

/** Build a regex matching @everyone, @here, and all hub role names */
function buildMentionRegex(hubRoleNames?: string[]): RegExp | null {
  const patterns = ['everyone', 'here']
  if (hubRoleNames) {
    for (const name of hubRoleNames) {
      if (name && name !== 'everyone') patterns.push(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    }
  }
  return new RegExp(`(^|[^a-zA-Z0-9_])@(${patterns.join('|')})(?=[^a-zA-Z0-9_]|$)`, 'gi')
}

/** Split text on mention patterns and return React nodes with styled mention pills (for non-markdown inline paths) */
function mentionifyInline(node: React.ReactNode, hubRoleNames?: string[]): React.ReactNode {
  const regex = buildMentionRegex(hubRoleNames)
  if (!regex) return node

  const processString = (text: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null

    regex.lastIndex = 0
    while ((match = regex.exec(text)) !== null) {
      const prefix = match[1] // leading boundary char (space, etc.)
      const mentionName = match[2]
      const fullMatchStart = match.index
      const contentStart = fullMatchStart + prefix.length // start of @mention

      if (contentStart > lastIndex) {
        parts.push(text.slice(lastIndex, contentStart))
      }

      const lower = mentionName.toLowerCase()
      const style = MENTION_STYLES[lower]
      const label = style?.label || `@${mentionName}`
      const colorClass = style?.className || 'bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25'

      parts.push(
        <span
          key={`mention-${fullMatchStart}`}
          className={`inline-flex items-center rounded p-1 leading-none text-xs font-medium cursor-default transition-colors ${colorClass}`}
        >
          {label}
        </span>
      )
      lastIndex = regex.lastIndex
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex))
    return parts.length > 0 ? parts : [text]
  }

  // If it's a simple string, process directly
  if (typeof node === 'string') {
    const parts = processString(node)
    return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <>{parts}</>
  }

  // If it's a React element with children, walk children and process string parts
  if (node && typeof node === 'object' && 'props' in node) {
    const children = (node as any).props.children
    if (Array.isArray(children)) {
      const processed = children.flatMap((child: React.ReactNode, ci: number) => {
        if (typeof child === 'string') return processString(child)
        return [child]
      })
      return <>{processed}</>
    }
  }

  return node
}

/* ─── Channel mention (#channel) pre-processing ──────────── */

/**
 * Pre-process text for markdown: replace #channel-name (matching a real hub channel)
 * with markdown image syntax. alt="channel:channelId|name" → clickable ChannelPill.
 */
function preChannelMarkdown(text: string, channels?: HubChannel[]): string {
  const m = channelMatcher(channels)
  if (!m) return text
  m.re.lastIndex = 0
  return text.replace(m.re, (full, pre: string, name: string) => {
    const c = m.byName.get(name.toLowerCase())
    return c ? `${pre}![channel:${c.channelId}|${c.type || ''}|${c.name}](c)` : full
  })
}

/** Split text on #channel patterns and return nodes with ChannelPills (inline paths). */
function channelifyInline(node: React.ReactNode, channels?: HubChannel[]): React.ReactNode {
  const m = channelMatcher(channels)
  if (!m) return node

  const processString = (text: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null
    m.re.lastIndex = 0
    while ((match = m.re.exec(text)) !== null) {
      const c = m.byName.get(match[2].toLowerCase())
      if (!c) continue
      const contentStart = match.index + match[1].length  // after the leading boundary char
      if (contentStart > lastIndex) parts.push(text.slice(lastIndex, contentStart))
      parts.push(<ChannelPill key={`ch-${match.index}`} channelId={c.channelId} name={c.name} voice={c.type === 'voice'} />)
      lastIndex = m.re.lastIndex
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex))
    return parts.length > 0 ? parts : [text]
  }

  if (typeof node === 'string') {
    const parts = processString(node)
    return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <>{parts}</>
  }
  if (node && typeof node === 'object' && 'props' in node) {
    const children = (node as any).props.children
    if (Array.isArray(children)) {
      const processed = children.flatMap((child: React.ReactNode) => typeof child === 'string' ? processString(child) : [child])
      return <>{processed}</>
    }
  }
  return node
}

/** Process emojis, timestamps, mentions, AND channels in one pass (for non-markdown inline paths) */
function emojifyTimestampAndMention(text: string, eventEmojiTags?: [string, string, string?][], hubRoleNames?: string[], hubChannels?: HubChannel[]): React.ReactNode {
  const result = emojifyAndTimestamp(text, eventEmojiTags)
  return channelifyInline(mentionifyInline(result, hubRoleNames), hubChannels)
}

/* ─── Nostr reference detection + rendering ────────────────── */

/** Matches bare bech32 (npub1, nprofile1, note1, nevent1, naddr1), nostr:-prefixed URIs, and @-prefixed npub */
const NOSTR_PATTERN = /(?:nostr:)?@?(?:npub1|nprofile1|note1|nevent1|naddr1)[a-zA-Z0-9]+/g

function splitNostr(content: string): { type: 'text' | 'nostr'; value: string }[] {
  const segments: { type: 'text' | 'nostr'; value: string }[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  NOSTR_PATTERN.lastIndex = 0

  while ((match = NOSTR_PATTERN.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: content.slice(lastIndex, match.index) })
    }
    // Strip nostr: and @ prefixes if present
    const raw = match[0].replace('nostr:', '').replace(/^@/, '')
    segments.push({ type: 'nostr', value: raw })
    lastIndex = NOSTR_PATTERN.lastIndex
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', value: content.slice(lastIndex) })
  }
  return segments
}

/** Decodes a bech32 nostr identifier and renders the appropriate card */
function NostrCard({ bech32, onProfileClick, disableHubInviteCards }: { bech32: string; onProfileClick?: (pubkey: string) => void; disableHubInviteCards?: boolean }) {
  try {
    const decoded = nip19.decode(bech32)

    if (decoded.type === 'npub') {
      return <ProfileCard pubkey={decoded.data as string} onProfileClick={onProfileClick} />
    }
    if (decoded.type === 'nprofile') {
      const data = decoded.data as { pubkey: string }
      return <ProfileCard pubkey={data.pubkey} onProfileClick={onProfileClick} />
    }
    if (decoded.type === 'note') {
      return <NoteCard eventId={decoded.data as string} />
    }
    if (decoded.type === 'nevent') {
      const data = decoded.data as { id: string; kind?: number; relays?: string[] }
      if (data.kind === 1111) {
        return <CommentCard eventId={data.id} relays={data.relays} />
      }
      return <NoteCard eventId={data.id} />
    }
    if (decoded.type === 'naddr') {
      const data = decoded.data as { identifier: string; pubkey: string; kind: number; relays?: string[] }
      if (data.kind === 36942) {
        if (disableHubInviteCards) {
          return (
            <div className="my-1 max-w-[350px] rounded-lg border border-border bg-secondary/20 p-2.5 flex items-center gap-2">
              <Hash size={14} className="text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground truncate flex-1">Hub invite</span>
              <button
                onClick={() => { navigator.clipboard.writeText(bech32); }}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] text-muted-foreground hover:text-foreground bg-secondary hover:bg-accent/50 transition-colors cursor-pointer shrink-0"
              >
                <Copy size={10} /> Copy
              </button>
            </div>
          )
        }
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
      if (data.kind === 31923) {
        return <CalendarTimeEventCard identifier={data.identifier} pubkey={data.pubkey} relays={data.relays} />
      }
    }
  } catch { }
  // Fallback: unsupported kind
  return <UnsupportedKindCard bech32={bech32} />
}

/** Fallback card for nostr references we don't have a specific renderer for */
function UnsupportedKindCard({ bech32 }: { bech32: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(bech32)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="my-1 max-w-[350px] rounded-lg border border-border bg-secondary/30 p-3 flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">Kind not supported</span>
      <button
        onClick={handleCopy}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground bg-secondary hover:bg-accent/50 transition-colors cursor-pointer"
      >
        {copied ? <><Check size={10} className="text-green-500" /> Copied</> : <><Copy size={10} /> Copy Event Address</>}
      </button>
    </div>
  )
}
