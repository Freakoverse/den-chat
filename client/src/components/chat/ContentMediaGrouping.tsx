/**
 * ContentMediaGrouping — Shared utility for grouping consecutive image URLs in message content
 *
 * Used by hub ChannelView, NIP-17 DMs, and NIP-04 DMs to render grouped inline images
 * with a 2-column grid layout and unified gallery lightbox.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { VerificationBadge } from '@/components/ui/VerificationBadge'
import { ImageGallery } from '@/components/social/RichContent'
import { getRenderLimit } from '@/lib/imageSizeGuard'
import { ImageTooLarge } from '@/components/ui/ImageTooLarge'

/* ────────────── URL detection helpers ────────────── */

const CONTENT_IMAGE_RE = /\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?[^\s]*)?$/i
/** Blossom server URLs with a bare sha256 hash path (no file extension) */
const CONTENT_BLOSSOM_SIMPLE = /^https?:\/\/(blossom\.(primal\.net|band|nostr\.hu|data\.haus)|cdn\.sovbit\.host)\/[a-f0-9]{64}(\?[^\s]*)?$/i

/** Check if a string is a single URL (starts with http(s), no spaces) */
function isSingleUrl(s: string): boolean {
  return /^https?:\/\/\S+$/.test(s)
}

/** Check if a URL points to an image */
function isImageUrl(url: string): boolean {
  return CONTENT_IMAGE_RE.test(url) || CONTENT_BLOSSOM_SIMPLE.test(url)
}

/* ────────────── Types ────────────── */

export interface ContentMediaGroup {
  kind: 'image-group'
  urls: string[]
}

/* ────────────── Extraction ────────────── */

/**
 * Extract consecutive image URL groups from message text content.
 * Returns the groups and the text content with those grouped URLs stripped out.
 * Non-image URLs, text, and nostr refs break the grouping (like RichContent.tsx).
 */
export function extractContentMediaGroups(content: string): { groups: ContentMediaGroup[]; strippedContent: string } {
  const groups: ContentMediaGroup[] = []
  const urlsToStrip = new Set<string>()

  // Split content into lines and process each
  const lines = content.split('\n')
  let currentImageUrls: string[] = []

  const flushImages = () => {
    if (currentImageUrls.length >= 1) {
      groups.push({ kind: 'image-group', urls: [...currentImageUrls] })
      for (const u of currentImageUrls) urlsToStrip.add(u)
    }
    currentImageUrls = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    // Empty/whitespace line — keep collecting if we have images
    if (trimmed === '') {
      if (currentImageUrls.length > 0) continue
      flushImages()
      continue
    }

    // Check if this line is ONLY a single URL pointing to an image
    if (isSingleUrl(trimmed) && isImageUrl(trimmed)) {
      currentImageUrls.push(trimmed)
      continue
    }

    // Non-image line — flush any current image group
    flushImages()
  }

  flushImages()

  // If no groups found, return original content unchanged
  if (groups.length === 0) {
    return { groups: [], strippedContent: content }
  }

  // Build stripped content by removing grouped image URLs
  const strippedLines = lines.filter(line => {
    const trimmed = line.trim()
    return !urlsToStrip.has(trimmed)
  })
  const strippedContent = strippedLines.join('\n').trim()

  return { groups, strippedContent }
}

/* ────────────── Components ────────────── */

/** Simple inline image with blossom fallback + skeleton (for content URLs) */
export function ContentMediaImage({ src, className, style, onClick }: {
  src: string
  className?: string
  style?: React.CSSProperties
  onClick?: () => void
}) {
  const chatLimitMB = getRenderLimit('chat')
  const blossom = useBlossomMedia(src, chatLimitMB)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [overridden, setOverridden] = useState(false)

  useEffect(() => { setLoaded(false); setError(false); setOverridden(false) }, [src])

  // Size limit exceeded
  if (blossom.sizeExceeded && !overridden) {
    return (
      <ImageTooLarge
        url={src}
        detectedSize={blossom.detectedSize}
        onOverride={() => setOverridden(true)}
        className="rounded-lg mt-2 max-w-[400px] max-[1080px]:max-w-full"
      />
    )
  }

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
    <div className="relative w-full h-full" style={style}>
      {isLoading && (
        <div className="media-skeleton w-full h-full" style={{ minHeight: 160 }} />
      )}
      {error && !blossom.loading && (
        <div className="rounded-lg bg-secondary/40 border border-border/50 flex items-center justify-center text-xs text-muted-foreground/60 w-full h-full" style={{ minHeight: 80 }}>
          Failed to load image
        </div>
      )}
      {!blossom.loading && resolvedSrc && (
        <img
          src={resolvedSrc}
          alt=""
          className={`${className || ''} transition-opacity duration-300 cursor-pointer ${loaded ? 'opacity-100' : 'opacity-0 h-0 overflow-hidden'}`}
          loading="lazy"
          onClick={onClick}
          onLoad={() => { setLoaded(true); setError(false) }}
          onError={() => setError(true)}
        />
      )}
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

/** Renders grouped inline content images in grid layouts with gallery lightbox */
export function ContentMediaGroups({ groups, galleryImages, onGalleryOpen }: {
  groups: ContentMediaGroup[]
  galleryImages: string[]
  onGalleryOpen: (url: string) => void
}) {
  if (groups.length === 0) return null

  return (
    <>
      {groups.map((group, gi) => {
        if (group.urls.length === 1) {
          const url = group.urls[0]
          return (
            <ContentMediaImage
              key={`cg-${gi}`}
              src={url}
              className="rounded-lg mt-2 w-full max-w-[400px] max-[1080px]:max-w-full max-h-[300px] object-contain cursor-pointer hover:brightness-110 transition-all border border-border"
              onClick={() => onGalleryOpen(url)}
            />
          )
        }
        // 2-column grid with equal row heights
        return (
          <div key={`cg-${gi}`} className="grid grid-cols-2 gap-1 mt-2 rounded-lg overflow-hidden max-w-[500px] max-[1080px]:max-w-full" style={{ gridAutoRows: '200px' }}>
            {group.urls.map((url, j) => (
              <div key={`cg-${gi}-${j}`} className="relative overflow-hidden">
                <ContentMediaImage
                  src={url}
                  className="w-full h-full object-cover cursor-pointer hover:brightness-110 transition-all"
                  onClick={() => onGalleryOpen(url)}
                />
              </div>
            ))}
          </div>
        )
      })}
    </>
  )
}

/**
 * Hook to manage content media grouping state for a message.
 * Returns the grouped content, stripped content, and gallery handlers.
 */
export function useContentMediaGrouping(content: string) {
  const { groups, strippedContent } = useMemo(
    () => extractContentMediaGroups(content),
    [content]
  )

  const allContentImages = useMemo(
    () => groups.flatMap(g => g.urls),
    [groups]
  )

  const [galleryIndex, setGalleryIndex] = useState<number | null>(null)

  const openGallery = useCallback((url: string) => {
    const idx = allContentImages.indexOf(url)
    setGalleryIndex(idx >= 0 ? idx : 0)
  }, [allContentImages])

  const closeGallery = useCallback(() => setGalleryIndex(null), [])

  return {
    groups,
    strippedContent,
    allContentImages,
    galleryIndex,
    openGallery,
    closeGallery,
  }
}

/**
 * Renders the content media groups + gallery lightbox together.
 * Drop-in component for DM message rows.
 */
export function ContentMediaGroupsWithGallery({ content }: { content: string }) {
  const { groups, allContentImages, galleryIndex, openGallery, closeGallery } = useContentMediaGrouping(content)

  if (groups.length === 0) return null

  return (
    <>
      <ContentMediaGroups groups={groups} galleryImages={allContentImages} onGalleryOpen={openGallery} />
      {galleryIndex !== null && (
        <ImageGallery images={allContentImages} startIndex={galleryIndex} onClose={closeGallery} />
      )}
    </>
  )
}
