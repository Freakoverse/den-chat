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
 *   - card:     fixed min-height with border (Twitter)
 */

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

  return (
    <div
      className={`rounded-lg overflow-hidden ${isCard ? 'border border-border' : ''} ${className || ''}`}
      style={{
        aspectRatio: layout === 'video' ? '16/9' : undefined,
        maxWidth: isVertical ? 325 : maxWidth,
        width: isVertical ? 325 : undefined,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <iframe
        src={embed.src}
        title={embed.title}
        allow={embed.allow || undefined}
        allowFullScreen
        className="w-full border-0"
        style={{
          height: (isCard || isCompact || isVertical) && height ? height : undefined,
          // Video layout uses aspect-ratio on the container, so iframe fills it
          ...(layout === 'video' ? { height: '100%' } : {}),
        }}
        sandbox={embed.sandbox || undefined}
        loading={isCard ? 'lazy' : undefined}
      />
    </div>
  )
}
