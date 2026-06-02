/**
 * ImageTooLarge — Placeholder shown when an image exceeds the render size limit.
 *
 * Displays the detected file size (if known) and a "Load anyway" button
 * that adds a session-only override for the URL.
 */

import { ImageOff } from 'lucide-react'
import { addSizeOverride, formatBytes } from '@/lib/imageSizeGuard'
import { useState } from 'react'

interface ImageTooLargeProps {
  /** The image URL that was blocked */
  url: string
  /** Detected file size in bytes (if known) */
  detectedSize?: number
  /** Callback after "Load anyway" is clicked — parent should re-trigger rendering */
  onOverride?: () => void
  /** Optional CSS class for the outer container */
  className?: string
  /** Compact mode for smaller contexts (avatars, small thumbnails) */
  compact?: boolean
}

export function ImageTooLarge({ url, detectedSize, onOverride, className, compact }: ImageTooLargeProps) {
  const [overridden, setOverridden] = useState(false)

  const handleLoadAnyway = () => {
    addSizeOverride(url)
    setOverridden(true)
    onOverride?.()
  }

  if (overridden) return null

  if (compact) {
    return (
      <div
        className={`flex items-center justify-center bg-muted/30 border border-border/50 rounded ${className || ''}`}
        title={detectedSize ? `Image too large (${formatBytes(detectedSize)})` : 'Image too large'}
      >
        <ImageOff size={14} className="text-muted-foreground/50" />
      </div>
    )
  }

  return (
    <div className={`rounded-lg bg-muted/20 border border-border/50 flex flex-col items-center justify-center gap-2 py-5 px-4 ${className || ''}`}>
      <ImageOff size={20} className="text-muted-foreground/50" />
      <div className="text-center">
        <p className="text-xs text-muted-foreground">Image too large</p>
        {detectedSize != null && detectedSize > 0 && (
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">{formatBytes(detectedSize)}</p>
        )}
      </div>
      <button
        onClick={handleLoadAnyway}
        className="text-[10px] text-primary/70 hover:text-primary hover:underline transition-colors mt-1"
      >
        Load anyway
      </button>
    </div>
  )
}
