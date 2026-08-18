/**
 * MentionSuggestionsDropdown — presentational list for @mention autocomplete.
 *
 * Rendered in a portal with fixed positioning anchored to the textarea, so it
 * escapes ancestor clipping (e.g. the message edit field lives inside an
 * `overflow-hidden` ScrollableContent box). Pair with the useMentionAutocomplete hook.
 */
import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { formatDnnId } from '@/lib/dnn/formatDnnId'
import { Globe, Radio, Shield, BadgeCheck, Hash } from 'lucide-react'
import type { MentionSuggestion } from './useMentionAutocomplete'

export function MentionSuggestionsDropdown({ suggestions, activeIndex, onSelect, onHover, anchorRef }: {
  suggestions: MentionSuggestion[]
  activeIndex: number
  onSelect: (s: MentionSuggestion) => void
  onHover: (i: number) => void
  /** The textarea the dropdown anchors above. */
  anchorRef: RefObject<HTMLTextAreaElement | null>
}) {
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null)

  // Track the anchor's viewport position (recompute on scroll/resize). Prefer placing
  // the list above the textarea (like the composer), but flip below when there's more
  // room there, and clamp the height to the available space so it never runs off-screen.
  useLayoutEffect(() => {
    if (suggestions.length === 0) return // component returns null below; keep last pos
    const GAP = 4
    const MAX_HEIGHT = 240
    const update = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const spaceAbove = r.top - GAP
      const spaceBelow = window.innerHeight - r.bottom - GAP
      const placeAbove = spaceAbove >= spaceBelow
      const maxHeight = Math.min(MAX_HEIGHT, Math.max(spaceAbove, spaceBelow))
      if (placeAbove) {
        setPos({ left: r.left, width: r.width, bottom: window.innerHeight - r.top + GAP, maxHeight })
      } else {
        setPos({ left: r.left, width: r.width, top: r.bottom + GAP, maxHeight })
      }
    }
    update()
    // capture=true so we catch scrolling in inner containers (the message list)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [suggestions, anchorRef])

  if (suggestions.length === 0 || !pos) return null

  return createPortal(
    <div
      style={{ position: 'fixed', left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight, zIndex: 200 }}
      className="bg-popover/95 backdrop-blur-md border border-border rounded-lg shadow-xl overflow-hidden overflow-y-auto"
    >
      {suggestions.map((s, i) => {
        const key = s.type === 'user' ? s.pubkey : s.type === 'group' ? s.keyword : s.type === 'channel' ? s.channelId : s.roleId
        return (
          <button
            key={key}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onSelect(s) }}
            onMouseEnter={() => onHover(i)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer ${i === activeIndex ? 'bg-primary/15' : 'hover:bg-accent/40'}`}
          >
            {s.type === 'user' ? (
              <>
                <Avatar className="h-6 w-6 shrink-0">
                  {s.picture && <AvatarImage src={s.picture} />}
                  <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
                    {(s.name || s.npub.slice(5, 7)).slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground truncate flex items-center gap-1">
                    {s.name || truncateNpub(s.npub)}
                    {s.dnnId && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-primary font-medium shrink-0">
                        @{formatDnnId(s.dnnId)}
                        <BadgeCheck size={11} className="text-primary" />
                      </span>
                    )}
                  </span>
                  {s.name && (
                    <span className="text-[10px] text-muted-foreground truncate block">
                      {truncateNpub(s.npub)}
                    </span>
                  )}
                </div>
              </>
            ) : s.type === 'group' ? (
              <>
                <div className="h-6 w-6 shrink-0 rounded-full bg-amber-500/20 flex items-center justify-center">
                  {s.keyword === 'everyone' ? <Globe size={13} className="text-amber-400" /> : <Radio size={13} className="text-amber-400" />}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold text-amber-400 truncate block">{s.label}</span>
                  <span className="text-[10px] text-muted-foreground truncate block">{s.description}</span>
                </div>
              </>
            ) : s.type === 'channel' ? (
              <>
                <div className="h-6 w-6 shrink-0 rounded-full bg-primary/15 flex items-center justify-center">
                  <Hash size={13} className="text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold text-primary truncate block">#{s.channelName}</span>
                  <span className="text-[10px] text-muted-foreground truncate block">
                    {s.categoryName ? s.categoryName : 'Uncategorized'}
                    {s.position != null && <span className="text-muted-foreground/60"> · #{s.position}</span>}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="h-6 w-6 shrink-0 rounded-full flex items-center justify-center bg-secondary">
                  <Shield size={13} style={{ color: s.color || 'hsl(var(--primary))' }} />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold truncate block" style={{ color: s.color || 'hsl(var(--primary))' }}>@{s.roleName}</span>
                  <span className="text-[10px] text-muted-foreground truncate block">Notify all members with this role</span>
                </div>
              </>
            )}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
