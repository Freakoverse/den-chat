/**
 * OverlayScroll — a vertical scroll area whose scrollbar is drawn OVER the content instead of taking a
 * layout gutter. Chromium (and this app's webview) reserves ~15px for a classic/styled scrollbar and no
 * longer honours `overflow: overlay`, so there is no pure-CSS overlay scrollbar: we hide the native bar
 * (scrollbar-hide) and render our own thin thumb, synced to scrollTop and shown on hover / while scrolling.
 *
 * Content keeps full width (so e.g. full-bleed section headers stay edge to edge); the thumb floats on the
 * right. Wheel / touch / keyboard scrolling are all native — only the visible bar is custom.
 */

import { useRef, useState, useEffect, useCallback, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

const MIN_THUMB = 24 // px, so a tiny thumb on a huge list is still grabbable
const HIDE_DELAY = 1200 // ms of inactivity before the thumb fades (unless hovered/dragging)

export function OverlayScroll({
  children,
  className,
  viewportClassName,
  viewportRef: externalRef,
}: {
  children: ReactNode
  /** Sizing for the wrapper (e.g. "flex-1 min-h-0"). The wrapper is position:relative. */
  className?: string
  /** Classes for the scrolling viewport (e.g. "flex flex-col pb-1"). */
  viewportClassName?: string
  /** Optional outparam to reach the scrolling element (for programmatic scroll). */
  viewportRef?: (el: HTMLDivElement | null) => void
}) {
  const viewport = useRef<HTMLDivElement | null>(null)
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null)
  const [visible, setVisible] = useState(false)
  const hideTimer = useRef<number | undefined>(undefined)
  const rafId = useRef<number | undefined>(undefined)
  const dragging = useRef<{ startY: number; startScroll: number } | null>(null)
  const overThumb = useRef(false) // keep the thumb up while the pointer rests on it

  const recompute = useCallback(() => {
    const el = viewport.current
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    if (scrollHeight <= clientHeight + 1) { setThumb(null); return }
    const h = Math.max((clientHeight / scrollHeight) * clientHeight, MIN_THUMB)
    const maxTop = clientHeight - h
    const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop
    setThumb({ top, height: h })
  }, [])

  // Coalesce bursty updates (scroll, progressive member loading) to one measure per frame.
  const schedule = useCallback(() => {
    if (rafId.current) return
    rafId.current = requestAnimationFrame(() => { rafId.current = undefined; recompute() })
  }, [recompute])

  const flash = useCallback(() => {
    setVisible(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => { if (!dragging.current && !overThumb.current) setVisible(false) }, HIDE_DELAY)
  }, [])

  const setViewport = useCallback((el: HTMLDivElement | null) => {
    viewport.current = el
    externalRef?.(el)
  }, [externalRef])

  useEffect(() => {
    const el = viewport.current
    if (!el) return
    recompute()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    const mo = new MutationObserver(schedule)
    mo.observe(el, { childList: true, subtree: true })
    return () => { ro.disconnect(); mo.disconnect() }
  }, [recompute, schedule])

  // Drag the thumb to scroll.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = viewport.current
      if (!dragging.current || !el) return
      const { scrollHeight, clientHeight } = el
      const h = Math.max((clientHeight / scrollHeight) * clientHeight, MIN_THUMB)
      const maxTop = clientHeight - h
      if (maxTop <= 0) return
      const dy = e.clientY - dragging.current.startY
      el.scrollTop = dragging.current.startScroll + (dy / maxTop) * (scrollHeight - clientHeight)
    }
    const onUp = () => { if (dragging.current) { dragging.current = null; flash() } }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [flash])

  useEffect(() => () => { window.clearTimeout(hideTimer.current); if (rafId.current) cancelAnimationFrame(rafId.current) }, [])

  return (
    <div
      className={cn('relative', className)}
      onMouseEnter={flash}
      onMouseLeave={() => { if (!dragging.current) setVisible(false) }}
    >
      <div
        ref={setViewport}
        onScroll={() => { schedule(); flash() }}
        className={cn('absolute inset-0 overflow-y-auto scrollbar-hide', viewportClassName)}
      >
        {children}
      </div>
      {thumb && (
        <div
          onMouseEnter={() => { overThumb.current = true; window.clearTimeout(hideTimer.current); setVisible(true) }}
          onMouseLeave={() => { overThumb.current = false; flash() }}
          onMouseDown={(e) => {
            const el = viewport.current
            if (!el) return
            dragging.current = { startY: e.clientY, startScroll: el.scrollTop }
            setVisible(true)
            e.preventDefault()
          }}
          style={{ top: thumb.top, height: thumb.height }}
          className={cn(
            'absolute right-0.5 z-20 w-1.5 rounded-full cursor-pointer bg-foreground/25 hover:bg-foreground/40 transition-opacity duration-200',
            visible ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </div>
  )
}
