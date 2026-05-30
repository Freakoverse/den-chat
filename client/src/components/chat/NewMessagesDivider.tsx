import { forwardRef } from 'react'

/**
 * "NEW MESSAGES" divider line — inserted between the last-read message
 * and the first unread message. Styled like DateSeparator but with accent color.
 */
const NewMessagesDivider = forwardRef<HTMLDivElement>((_, ref) => {
  return (
    <div ref={ref} className="flex items-center gap-3 my-3 select-none" aria-label="New messages">
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
