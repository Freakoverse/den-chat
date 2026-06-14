/**
 * BlossomImg — A lightweight image component with Blossom failover + hash verification.
 *
 * Wraps useBlossomMedia to provide automatic server failover and hash checking
 * for any image URL hosted on a Blossom server. For non-Blossom URLs, renders
 * a plain <img>.
 *
 * Used for custom emojis, stickers, and any other small blossom-hosted images.
 */

import { useState } from 'react'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { VerificationBadge } from '@/components/ui/VerificationBadge'

interface BlossomImgProps {
  src: string
  alt?: string
  className?: string
  style?: React.CSSProperties
  loading?: 'lazy' | 'eager'
  onClick?: (e: React.MouseEvent) => void
  'data-set-address'?: string
  /** If true, show verification badge overlay (default: false for inline images like emojis) */
  showBadge?: boolean
  /** If true, show a skeleton placeholder while loading (default: false for inline emojis) */
  showSkeleton?: boolean
  /** Skeleton dimensions — width in px (default: uses style.maxWidth or 120) */
  skeletonWidth?: number
  /** Skeleton dimensions — height in px (default: uses style.maxHeight or 120) */
  skeletonHeight?: number
}

export function BlossomImg({ src, alt, className, style, loading = 'lazy', onClick, showBadge = false, showSkeleton = false, skeletonWidth, skeletonHeight, ...rest }: BlossomImgProps) {
  const blossom = useBlossomMedia(src)
  const [loaded, setLoaded] = useState(false)

  // Use the resolved src (with failover) or fall back to original
  const resolvedSrc = blossom.src || src

  const skelW = skeletonWidth || (style?.maxWidth as number) || 120
  const skelH = skeletonHeight || (style?.maxHeight as number) || 120

  return (
    <span className={showBadge || showSkeleton ? 'relative inline-block' : 'inline'}>
      {showSkeleton && !loaded && (
        <span className="media-skeleton inline-block" style={{ width: skelW, height: skelH, maxWidth: '100%' }} />
      )}
      <img
        src={resolvedSrc}
        alt={alt || ''}
        className={`${className || ''} ${showSkeleton && !loaded ? 'opacity-0 h-0 overflow-hidden block' : ''}`}
        style={style}
        loading={loading}
        onClick={onClick}
        onLoad={() => setLoaded(true)}
        onError={blossom.onImgError}
        {...rest}
      />
      {showBadge && blossom.verified !== 'verified' && blossom.expectedHash && (
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
    </span>
  )
}
