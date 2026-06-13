import { forwardRef, useState, useEffect } from 'react'

/**
 * "NEW MESSAGES" divider line — inserted between the last-read message
 * and the first unread message. Styled like DateSeparator but with accent color.
 */
const NewMessagesDivider = forwardRef<HTMLDivElement, { hidden?: boolean }>((props, ref) => {
  const [gone, setGone] = useState(false)

  useEffect(() => {
    if (!props.hidden) { setGone(false); return }
    const t = setTimeout(() => setGone(true), 500)
    return () => clearTimeout(t)
  }, [props.hidden])

  if (gone) return null

  return (
    <div
      ref={ref}
      className={`flex items-center gap-3 select-none overflow-hidden transition-all duration-500 ease-in-out ${props.hidden ? 'my-0 max-h-0 opacity-0 pointer-events-none' : 'my-3 max-h-8 opacity-100'}`}
      aria-label="New messages"
    >
      <div className="flex-1 h-px bg-destructive/60" />
      <span className="text-[11px] font-semibold text-destructive uppercase tracking-wider">
        new
      </span>
      <div className="flex-1 h-px bg-destructive/60" />
    </div>
  )
})
NewMessagesDivider.displayName = 'NewMessagesDivider'

export { NewMessagesDivider }
