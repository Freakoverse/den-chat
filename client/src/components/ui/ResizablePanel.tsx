/**
 * ResizablePanel — A panel with a draggable right edge for resizing
 *
 * Used for sidebars across the app (hub channel list, DM list, social column, settings nav).
 * Persists width to localStorage per panel ID.
 */

import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react'

interface ResizablePanelProps {
  /** Unique key for localStorage persistence */
  id: string
  /** Default width in px */
  defaultWidth: number
  /** Minimum width in px */
  minWidth: number
  /** Maximum width in px */
  maxWidth: number
  /** Which side of the layout this panel is on — affects drag handle position & direction */
  side?: 'left' | 'right'
  /** Panel content */
  children: ReactNode
  /** Additional className for the panel container */
  className?: string
}

export function ResizablePanel({
  id,
  defaultWidth,
  minWidth,
  maxWidth,
  side = 'left',
  children,
  className = '',
}: ResizablePanelProps) {
  const storageKey = `den-panel-width-${id}`
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      const parsed = parseInt(saved, 10)
      if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) return parsed
    }
    return defaultWidth
  })

  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const delta = e.clientX - startX.current
      const adjusted = side === 'right' ? -delta : delta
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth.current + adjusted))
      setWidth(newWidth)
    }

    const onMouseUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Persist
      localStorage.setItem(storageKey, String(width))
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [width, minWidth, maxWidth, storageKey])

  return (
    <div
      className={`relative flex-shrink-0 ${className}`}
      style={{ width, minWidth, maxWidth }}
    >
      {children}

      {/* Drag handle — thin bar on the edge */}
      <div
        onMouseDown={onMouseDown}
        className={`absolute top-0 ${side === 'right' ? 'left-0' : 'right-0'} w-1 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors z-20`}
      />
    </div>
  )
}
