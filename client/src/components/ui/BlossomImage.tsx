/**
 * BlossomImage — Shared image component with Blossom server fallback + hash verification
 *
 * Detects Blossom hash URLs, tries all configured servers until one responds,
 * verifies SHA-256 integrity, and renders a verified blob URL.
 *
 * Used for any image sourced from Blossom: hub icons, banners, attachments, etc.
 */

import { useState, useEffect } from 'react'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { useCachedImageUrl } from '@/lib/imageCache'

interface BlossomImageProps {
  src: string | undefined
  alt?: string
  className?: string
  /** Extra classes for the inner <img> element (e.g. object-position) */
  imgClassName?: string
  /** Fallback content when image is not available (defaults to nothing) */
  fallback?: React.ReactNode
}

export function BlossomImage({ src, alt, className, imgClassName, fallback }: BlossomImageProps) {
  const blossom = useBlossomMedia(src)
  const [loaded, setLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)

  // Reset loaded/error state when src changes
  useEffect(() => { setLoaded(false); setImgError(false) }, [src])

  const resolvedSrc = blossom.src || src
  const cachedSrc = useCachedImageUrl(resolvedSrc)

  if (!src) return fallback ? <>{fallback}</> : null

  if (blossom.error || imgError) {
    if (fallback) return <>{fallback}</>
    return null
  }

  const isLoading = blossom.loading || !loaded

  // Only inject 'relative' if caller hasn't specified an explicit position class
  const hasPosition = className && /\b(absolute|fixed|sticky|relative)\b/.test(className)

  return (
    <div className={`${hasPosition ? '' : 'relative '}${className || ''}`} style={{ overflow: 'hidden' }}>
      {/* Shimmer skeleton while loading */}
      {isLoading && (
        <div className="media-skeleton absolute inset-0" />
      )}
      {!blossom.loading && resolvedSrc && (
        <img
          src={cachedSrc}
          alt={alt || ''}
          className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}${imgClassName ? ` ${imgClassName}` : ''}`}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setImgError(true)}
        />
      )}
    </div>
  )
}
