import { useState, useRef, useEffect, type ReactNode } from 'react'
import { ChevronsDown, ChevronsUp } from 'lucide-react'

const MAX_CONTENT_HEIGHT = 900

/**
 * Wraps message content in a height-constrained container (900px). When the content overflows it starts
 * clipped with a fade overlay and a "Show all" button. Expanding removes the height cap entirely (the
 * message flows at full height, no inner scroll) and surfaces a STICKY "Show less" button that floats at
 * the bottom of the viewport while reading, so a long message can always be collapsed from anywhere.
 */
export function ScrollableContent({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
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

  const collapse = () => {
    setExpanded(false)
    // Re-orient: once a tall message snaps back to the cap, keep its top in view so the user isn't left
    // stranded below where the long version used to extend.
    requestAnimationFrame(() => contentRef.current?.scrollIntoView({ block: 'nearest' }))
  }

  return (
    // flex-col: some callers place this inside a flex ROW (the compact grouped-message variant). A bare
    // fragment would make the content box and the toggle button siblings in that row, so the button
    // floated to the right of the text instead of below it. A column wrapper keeps them stacked anywhere.
    // min-w-0 w-full: inside a flex row a bare block would shrink-wrap its content, and a w-full textarea
    // inside it then collapses to the browser's intrinsic ~20 columns (the "edit box shrinks left" report).
    <div className="flex flex-col min-w-0 w-full">
      <div className="relative min-w-0 w-full">
        <div
          ref={contentRef}
          className={expanded ? '' : 'overflow-hidden'}
          style={expanded ? undefined : { maxHeight: MAX_CONTENT_HEIGHT }}
        >
          {children}
        </div>

        {/* Gradient fade while the content is clipped */}
        {overflows && !expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-16 pointer-events-none bg-gradient-to-t from-background to-transparent" />
        )}

        {/* Sticky "Show less" while expanded: floats at the viewport bottom so a long message can always be
            collapsed from anywhere. The row is click-through; only the pill itself is clickable. */}
        {overflows && expanded && (
          <div className="sticky bottom-2 z-10 mt-1 flex justify-end pointer-events-none">
            <button
              onClick={collapse}
              className="pointer-events-auto flex items-center gap-1.5 text-[11px] font-medium px-3 py-1 rounded-md cursor-pointer transition-colors bg-secondary text-foreground border border-border shadow-md hover:bg-accent"
            >
              <ChevronsUp size={13} /> Show less
            </button>
          </div>
        )}
      </div>

      {/* "Show all" while collapsed */}
      {overflows && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="ml-auto mt-1 flex items-center gap-1.5 text-[11px] font-medium px-3 py-1 rounded-md cursor-pointer transition-colors bg-secondary text-foreground border border-border shadow-sm hover:bg-accent"
        >
          <ChevronsDown size={13} /> Show all
        </button>
      )}
    </div>
  )
}
