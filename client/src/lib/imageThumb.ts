/**
 * imageThumb: crisp tiny renders of big images (reaction-pill avatars and custom emoji, ~20 CSS px).
 *
 * Drawing a large or animated image into a 20px box leaves the browser to downscale it on the fly.
 * On phones (DPR 2.6 to 3.5) that path is what the "blurry reactions" reports show: heavy on-GPU
 * downscaling without mipmaps, and animated GIF/WebP frames drawn at low filter quality. Here we
 * resample ONCE, at device resolution, with high quality, into a static thumbnail and reuse it.
 *
 * Source bytes come from the image cache (same-origin blob URLs), so the canvas is never tainted.
 * When the cache has no blob yet (fetch in flight, CORS refused) the caller keeps the original URL.
 */
import { useEffect, useState } from 'react'
import { useCachedImageUrl, IMAGE_TOO_LARGE } from '@/lib/imageCache'

type Fit = 'cover' | 'contain'
const thumbs = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

async function makeThumb(blobUrl: string, px: number, fit: Fit): Promise<string | null> {
  try {
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    const target = Math.round(px * dpr)
    const blob = await (await fetch(blobUrl)).blob()
    // createImageBitmap takes the FIRST frame of an animated image and can resample with high quality.
    const bmp = await createImageBitmap(blob)
    const { width: w, height: h } = bmp
    if (!w || !h) return null
    const canvas = document.createElement('canvas')
    canvas.width = target; canvas.height = target
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    if (fit === 'cover') {
      const s = Math.min(w, h)
      ctx.drawImage(bmp, (w - s) / 2, (h - s) / 2, s, s, 0, 0, target, target)
    } else {
      const scale = Math.min(target / w, target / h)
      const dw = w * scale, dh = h * scale
      ctx.drawImage(bmp, 0, 0, w, h, (target - dw) / 2, (target - dh) / 2, dw, dh)
    }
    bmp.close?.()
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return out ? URL.createObjectURL(out) : null
  } catch {
    return null
  }
}

/**
 * The best URL to render `src` at `px` CSS pixels: a cached device-resolution thumbnail when one
 * exists, the cached blob while it is being made, the original URL otherwise.
 */
export function useThumbnail(src: string | undefined, px: number, fit: Fit = 'cover'): string | undefined {
  const cached = useCachedImageUrl(src)
  const [, tick] = useState(0)
  const key = src ? `${src}|${px}|${fit}` : ''
  const ready = key ? thumbs.get(key) : undefined

  useEffect(() => {
    if (!key || ready || !cached || cached === IMAGE_TOO_LARGE || !cached.startsWith('blob:')) return
    if (typeof createImageBitmap !== 'function') return
    let alive = true
    let p = pending.get(key)
    if (!p) {
      p = makeThumb(cached, px, fit).then((url) => { if (url) thumbs.set(key, url); pending.delete(key); return url })
      pending.set(key, p)
    }
    p.then(() => { if (alive) tick((t) => t + 1) })
    return () => { alive = false }
  }, [key, ready, cached, px, fit])

  if (!src) return undefined
  if (ready) return ready
  if (cached === IMAGE_TOO_LARGE) return undefined
  return cached || src
}
