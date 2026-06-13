import { useState, useRef, useEffect, type ReactNode } from 'react'
import { ChevronsDown, ChevronsUp } from 'lucide-react'

const MAX_CONTENT_HEIGHT = 600

/**
 * Wraps message content in a height-constrained container (600px).
 * When content overflows, it starts clipped with a fade overlay.
 * "Show all" enables scrolling within the same 600px box.
 */
export function ScrollableContent({ children }: { children: ReactNode }) {
  const [scrollEnabled, setScrollEnabled] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const check = () => setOverflows(el.scrollHeight > MAX_CONTENT_HEIGHT)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleToggle = () => {
    const next = !scrollEnabled
    setScrollEnabled(next)
    if (!next && contentRef.current) {
      contentRef.current.scrollTop = 0
    }
  }

  return (
    <>
      <div className="relative">
        <div
          ref={contentRef}
          className={scrollEnabled ? 'overflow-y-auto' : 'overflow-hidden'}
          style={{ maxHeight: MAX_CONTENT_HEIGHT, scrollbarWidth: 'thin' as const }}
        >
          {children}
        </div>
        {/* Gradient fade when content is clipped */}
        {overflows && !scrollEnabled && (
          <div className="absolute bottom-0 left-0 right-0 h-16 pointer-events-none bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
      {overflows && (
        <button
          onClick={handleToggle}
          className="flex items-center justify-center gap-1.5 w-full text-[11px] font-medium py-1 mt-0.5 rounded-md cursor-pointer transition-all text-muted-foreground hover:text-foreground hover:bg-accent/50"
        >
          {scrollEnabled ? (
            <><ChevronsUp size={13} /> Show less</>
          ) : (
            <><ChevronsDown size={13} /> Show all</>
          )}
        </button>
      )}
    </>
  )
}
