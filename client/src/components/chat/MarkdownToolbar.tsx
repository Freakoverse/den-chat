/**
 * MarkdownToolbar — the shared formatting bar (bold/italic/headings/lists/link/code/spoiler + insert
 * timestamp) that operates on a given textarea. Used by the composer (ChatInputBar) and the inline
 * message editor so both offer the same formatting affordances.
 */
import { useRef, useState } from 'react'
import {
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6,
  List, ListOrdered, Link, Code, CodeSquare, Eye, Clock,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { TimestampPickerPopover } from '@/components/chat/ChatInputBar'

export function MarkdownToolbar({ textareaRef, value, onChange, autoResize, className }: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (v: string) => void
  autoResize?: (el: HTMLTextAreaElement) => void
  /** Container classes; defaults to a standalone rounded bar. */
  className?: string
}) {
  const [showTimestamp, setShowTimestamp] = useState(false)
  const timestampButtonRef = useRef<HTMLButtonElement>(null)

  const insertMarkdown = (prefix: string, suffix = '', placeholder = '') => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const text = value.substring(start, end) || placeholder
    onChange(`${value.substring(0, start)}${prefix}${text}${suffix}${value.substring(end)}`)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(start + prefix.length, start + prefix.length + text.length)
      autoResize?.(ta)
    })
  }

  const insertLinePrefix = (prefix: string) => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    onChange(`${value.substring(0, lineStart)}${prefix}${value.substring(lineStart)}`)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(start + prefix.length, start + prefix.length)
      autoResize?.(ta)
    })
  }

  const insertTimestamp = (unix: number) => {
    const token = `<t:${unix}>`
    const ta = textareaRef.current
    if (ta) {
      const start = ta.selectionStart
      const end = ta.selectionEnd
      onChange(`${value.substring(0, start)}${token}${value.substring(end)}`)
      requestAnimationFrame(() => {
        ta.focus()
        const pos = start + token.length
        ta.setSelectionRange(pos, pos)
        autoResize?.(ta)
      })
    } else {
      onChange(value + token)
    }
    setShowTimestamp(false)
  }

  const buttons = [
    { icon: Bold, action: () => insertMarkdown('**', '**', 'bold'), tip: 'Bold' },
    { icon: Italic, action: () => insertMarkdown('*', '*', 'italic'), tip: 'Italic' },
    { icon: Strikethrough, action: () => insertMarkdown('~~', '~~', 'strikethrough'), tip: 'Strikethrough' },
    { icon: Heading1, action: () => insertLinePrefix('# '), tip: 'Heading 1' },
    { icon: Heading2, action: () => insertLinePrefix('## '), tip: 'Heading 2' },
    { icon: Heading3, action: () => insertLinePrefix('### '), tip: 'Heading 3' },
    { icon: Heading4, action: () => insertLinePrefix('#### '), tip: 'Heading 4' },
    { icon: Heading5, action: () => insertLinePrefix('##### '), tip: 'Heading 5' },
    { icon: Heading6, action: () => insertLinePrefix('###### '), tip: 'Heading 6' },
    { icon: List, action: () => insertLinePrefix('- '), tip: 'Bullet List' },
    { icon: ListOrdered, action: () => insertLinePrefix('1. '), tip: 'Numbered List' },
    { icon: Link, action: () => insertMarkdown('[', '](url)', 'text'), tip: 'Link' },
    { icon: Code, action: () => insertMarkdown('`', '`', 'code'), tip: 'Inline Code' },
    { icon: CodeSquare, action: () => insertMarkdown('```\n', '\n```', 'code'), tip: 'Code Block' },
    { icon: Eye, action: () => insertMarkdown('||', '||', 'spoiler'), tip: 'Spoiler' },
  ]

  return (
    <TooltipProvider delayDuration={200}>
      <div className={className ?? 'flex flex-wrap items-center gap-0.5 px-2 py-1 bg-secondary/60 border border-border rounded-lg'}>
        {buttons.map(({ icon: Icon, action, tip }) => (
          <Tooltip key={tip}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={action}
                className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <Icon size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">{tip}</TooltipContent>
          </Tooltip>
        ))}
        {/* Clock button + popover — relative wrapper so the popover anchors to the button */}
        <div className="relative">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                ref={timestampButtonRef}
                onClick={() => setShowTimestamp(!showTimestamp)}
                className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <Clock size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Insert Timestamp</TooltipContent>
          </Tooltip>
          {showTimestamp && (
            <TimestampPickerPopover
              triggerRef={timestampButtonRef}
              onClose={() => setShowTimestamp(false)}
              onInsert={insertTimestamp}
            />
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
