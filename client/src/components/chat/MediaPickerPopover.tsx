/**
 * MediaPickerPopover — unified emoji / sticker / GIF picker.
 *
 * One trigger button (the emoji Smile icon) opens this single popover. A bottom bar switches between
 * Emoji, Stickers and GIFs (Emoji is the default). The Stickers and GIFs modes only appear when the
 * host passes their respective select callbacks — so a surface that only wants emoji (or a composer
 * without sticker/gif support) gets an emoji-only picker with no bottom bar.
 *
 * The actual picker content is reused from the three individual pickers via their exported *Body
 * components; this file only owns the portal, positioning, outside-click, and the bottom mode bar.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Smile, Sticker, ImagePlay } from 'lucide-react'
import { EmojiPickerBody } from './EmojiPickerPopover'
import { StickerPickerBody } from './StickerPickerPopover'
import { GifPickerBody } from './GifPickerPopover'

const PICKER_WIDTH = 396
const PICKER_HEIGHT = 488
const GAP = 8

type Mode = 'emoji' | 'sticker' | 'gif'

interface Props {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onSelectEmoji: (emoji: string) => void
  /** Omit to hide the Stickers mode. */
  onSelectSticker?: (sticker: { shortcode: string; url: string; setAddress: string }) => void
  /** Omit to hide the GIFs mode. */
  onSelectGif?: (gif: { name: string; url: string; nsfw: boolean }) => void
  initialMode?: Mode
}

export function MediaPickerPopover({ anchorRef, onClose, onSelectEmoji, onSelectSticker, onSelectGif, initialMode = 'emoji' }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: PICKER_WIDTH })
  const [mode, setMode] = useState<Mode>(initialMode)
  const containerRef = useRef<HTMLDivElement>(null)

  const computePosition = useCallback(() => {
    if (!anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth

    const spaceAbove = rect.top
    const spaceBelow = vh - rect.bottom
    let top: number
    if (spaceAbove >= PICKER_HEIGHT + GAP) {
      top = rect.top - PICKER_HEIGHT - GAP
    } else if (spaceBelow >= PICKER_HEIGHT + GAP) {
      top = rect.bottom + GAP
    } else {
      top = spaceAbove > spaceBelow
        ? Math.max(GAP, rect.top - PICKER_HEIGHT - GAP)
        : rect.bottom + GAP
    }
    if (top < GAP) top = GAP

    // Clamp width to the viewport so the wider picker never overflows on mobile.
    const width = Math.min(PICKER_WIDTH, vw - GAP * 2)
    let left = rect.right - width
    if (left < GAP) left = rect.left
    if (left + width > vw - GAP) left = vw - width - GAP
    left = Math.max(GAP, left)

    setPos({ top, left, width })
  }, [anchorRef])

  useEffect(() => {
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [computePosition])

  // Close on outside click — ignore the trigger and any portaled children (tooltips, discovery modals).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (anchorRef.current?.contains(target)) return
      if (containerRef.current && !containerRef.current.contains(target) &&
          !target.closest('[data-emoji-picker-portal]') &&
          !target.closest('[data-sticker-picker-portal]') &&
          !target.closest('[data-gif-picker-portal]') &&
          !target.closest('[data-radix-popper-content-wrapper]')) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  const modes: { id: Mode; label: string; icon: React.ReactNode }[] = [
    { id: 'emoji', label: 'Emoji', icon: <Smile size={17} /> },
    ...(onSelectSticker ? [{ id: 'sticker' as Mode, label: 'Stickers', icon: <Sticker size={17} /> }] : []),
    ...(onSelectGif ? [{ id: 'gif' as Mode, label: 'GIFs', icon: <ImagePlay size={17} /> }] : []),
  ]

  return createPortal(
    <div
      ref={containerRef}
      data-emoji-picker
      data-sticker-picker
      data-gif-picker
      className="fixed z-[300] flex flex-col rounded-xl border border-border bg-background shadow-2xl overflow-hidden"
      style={{ top: pos.top, left: pos.left, width: pos.width, height: PICKER_HEIGHT }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Active mode's picker content */}
      {mode === 'emoji' && <EmojiPickerBody onSelect={onSelectEmoji} onClose={onClose} width={pos.width} />}
      {mode === 'sticker' && onSelectSticker && <StickerPickerBody onSelect={onSelectSticker} onClose={onClose} />}
      {mode === 'gif' && onSelectGif && <GifPickerBody onSelect={onSelectGif} onClose={onClose} />}

      {/* Bottom mode bar (only when more than one mode is available) */}
      {modes.length > 1 && (
        <div className="flex border-t border-border bg-muted/30 shrink-0">
          {modes.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors cursor-pointer ${
                mode === m.id
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
              }`}
            >
              {m.icon}
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body
  )
}
