/**
 * TypingIndicator — "X is typing…" presence line (NIP-CHAT §6.14).
 *
 * View-agnostic: pass a conversation key (hubTypingKey / dm04TypingKey) and a
 * name resolver. Reads live typers from the typing store (timeout applied, self
 * excluded) and renders nothing when no one is typing.
 */

import { useTypers } from '@/stores/typingStore'

export function TypingIndicator({
  convKey,
  resolveName,
  className,
}: {
  convKey: string | null
  resolveName: (pubkey: string) => string
  className?: string
}) {
  const typers = useTypers(convKey)
  if (typers.length === 0) return null

  const names = typers.map(resolveName)
  let text: string
  if (names.length === 1) text = `${names[0]} is typing`
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing`
  else if (names.length === 3) text = `${names[0]}, ${names[1]}, and ${names[2]} are typing`
  else text = `${names[0]}, ${names[1]}, and ${names.length - 2} more are typing`

  return (
    <div
      className={`flex items-center gap-1.5 text-xs text-muted-foreground/80 ${className || ''}`}
      aria-live="polite"
    >
      <span className="inline-flex items-center gap-0.5 shrink-0">
        <span className="w-1 h-1 rounded-full bg-current animate-pulse [animation-delay:0ms]" />
        <span className="w-1 h-1 rounded-full bg-current animate-pulse [animation-delay:150ms]" />
        <span className="w-1 h-1 rounded-full bg-current animate-pulse [animation-delay:300ms]" />
      </span>
      <span className="truncate">{text}</span>
    </div>
  )
}
