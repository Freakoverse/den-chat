/**
 * Embed — universal iframe embed renderer.
 *
 * Accepts an EmbedInfo object (from detectEmbed) and renders the
 * appropriate iframe. All platform-specific logic lives in lib/embeds.ts;
 * this component is purely presentational.
 *
 * Layout modes:
 *   - video:    16:9 aspect ratio (YouTube, Twitch, Kick, Rumble)
 *   - vertical: portrait with fixed height (TikTok)
 *   - compact:  fixed short height, full width (Spotify, Steam)
 *   - card:     Twitter — reports its rendered height via postMessage
 *
 * Card embeds (Twitter) report their content height, so we size the iframe to
 * fit exactly and suppress its scrollbar — no internal scroll, no toggle needed.
 * If a card never reports a height (can't happen for Twitter, but just in case),
 * we fall back to a tight height with a "View full preview" toggle.
 */

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { EmbedInfo } from '@/lib/embeds'

interface EmbedProps {
  embed: EmbedInfo
  /** Max width constraint (chat uses 400px, social feed uses full width) */
  maxWidth?: number | string
  className?: string
}

export function Embed({ embed, maxWidth, className }: EmbedProps) {
  const { layout, height } = embed
  const isCard = layout === 'card'
  const isCompact = layout === 'compact'
  const isVertical = layout === 'vertical'

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [expanded, setExpanded] = useState(false)
  // Actual rendered content height, reported by the Twitter embed via postMessage.
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null)
  // After a grace period with no reported height, fall back to the toggle.
  const [measureTimedOut, setMeasureTimedOut] = useState(false)

  useEffect(() => {
    if (!isCard) return
    type ResizeMsg = { method?: string; params?: Array<{ height?: number; data?: { height?: number } }> }
    const onMessage = (e: MessageEvent) => {
      // Only trust messages from our own iframe.
      if (e.source !== iframeRef.current?.contentWindow) return
      let raw: unknown = e.data
      if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { return } }
      if (!raw || typeof raw !== 'object') return
      // Twitter posts { "twttr.embed": { method, params } } (sometimes unwrapped).
      const obj = raw as Record<string, unknown>
      const payload = (obj['twttr.embed'] ?? obj) as ResizeMsg
      if (payload.method !== 'twttr.private.resize') return
      const p = payload.params?.[0]
      const h = typeof p?.height === 'number' ? p.height : (typeof p?.data?.height === 'number' ? p.data.height : null)
      if (h && h > 0) setMeasuredHeight(Math.ceil(h))
    }
    window.addEventListener('message', onMessage)
    const timer = setTimeout(() => setMeasureTimedOut(true), 2500)
    return () => { window.removeEventListener('message', onMessage); clearTimeout(timer) }
  }, [isCard])

  const collapsedHeight = height ?? 250
  // Twitter reports its height → fit the iframe to it exactly (no scroll, no toggle).
  const autoFit = isCard && measuredHeight !== null
  // Toggle only as a fallback for a card that never reports a height.
  const showToggle = isCard && measuredHeight === null && measureTimedOut

  const effectiveHeight = !isCard
    ? height
    : autoFit
      // +4 absorbs the sub-pixel rounding that otherwise left a thin scrollbar.
      ? measuredHeight! + 4
      : (expanded ? Math.max(collapsedHeight * 3, 720) : collapsedHeight)

  return (
    <div style={{ maxWidth: isVertical ? 325 : maxWidth, width: isVertical ? 325 : undefined }}>
      <div
        className={`rounded-lg overflow-hidden ${isCard ? 'border border-border' : ''} ${className || ''}`}
        style={{ aspectRatio: layout === 'video' ? '16/9' : undefined }}
        onClick={(e) => e.stopPropagation()}
      >
        <iframe
          ref={iframeRef}
          src={embed.src}
          title={embed.title}
          allow={embed.allow || undefined}
          allowFullScreen
          // Suppress the iframe's own scrollbar once we've sized it to fit.
          scrolling={autoFit ? 'no' : undefined}
          className="w-full border-0"
          style={{
            height: (isCard || isCompact || isVertical) && effectiveHeight ? effectiveHeight : undefined,
            // Video layout uses aspect-ratio on the container, so iframe fills it
            ...(layout === 'video' ? { height: '100%' } : {}),
          }}
          sandbox={embed.sandbox || undefined}
          loading={isCard ? 'lazy' : undefined}
        />
      </div>

      {showToggle && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
          className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {expanded
            ? <><ChevronUp size={12} /> Shrink preview</>
            : <><ChevronDown size={12} /> View full preview</>}
        </button>
      )}
    </div>
  )
}
