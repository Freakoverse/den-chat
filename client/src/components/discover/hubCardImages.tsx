/**
 * Small hub banner/icon <img> helpers with Blossom fallback, shared by the Discover hub cards and the
 * Manage-recommendations picker. A broken/unreachable banner falls back to the DEN placeholder; a broken
 * icon falls back to the hub's initials. Kept in their own module so the recommendations modal can reuse
 * them without importing DiscoverPage (which would create a cycle via UserProfileModal).
 */

import { useEffect, useState } from 'react'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { HUB_BANNER_PLACEHOLDER } from '@/lib/constants'

export function BannerImage({ src, alt }: { src: string; alt: string }) {
  const blossom = useBlossomMedia(src)
  const [imgError, setImgError] = useState(false)
  useEffect(() => { setImgError(false) }, [src, blossom.src])
  if (blossom.loading) return <div className="w-full h-full bg-secondary animate-pulse" />
  // Unreachable / broken banner → DEN placeholder
  if (blossom.error || imgError) return <img src={HUB_BANNER_PLACEHOLDER} alt="" className="w-full h-full object-cover" loading="lazy" />
  return <img src={blossom.src || src} alt={alt} className="w-full h-full object-cover" loading="lazy" onError={() => { blossom.onImgError(); setImgError(true) }} />
}

export function IconImage({ src, name }: { src: string; name: string }) {
  const blossom = useBlossomMedia(src)
  if (blossom.error || blossom.loading) {
    return (
      <div className="w-full h-full bg-primary/20 flex items-center justify-center text-xs font-semibold text-primary">
        {name.slice(0, 2).toUpperCase()}
      </div>
    )
  }
  return <img src={blossom.src || src} alt="" className="w-full h-full object-cover" loading="lazy" />
}
