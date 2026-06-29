/**
 * ComposeBox — Post composer for kind:1 text notes
 * With emoji picker, media upload, and settings panel (PoW + relay toggles)
 */

import { useState, useRef, useCallback } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useSocialStore } from '@/stores/socialStore'
import { EmojiPickerPopover } from '@/components/chat/EmojiPickerPopover'
import { useMediaUpload, MediaUploadStrip, AddMediaButton } from '@/components/social/MediaUploadStrip'
import { useComposeSettings, ComposeSettingsPanel, ComposeSettingsButton } from '@/components/social/ComposeSettings'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Send, Smile, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ComposeBoxProps {
  /** If replying, the parent event */
  replyTo?: { id: string; pubkey: string; rootId?: string }
  placeholder?: string
  onPosted?: () => void
}

export function ComposeBox({ replyTo, placeholder, onPosted }: ComposeBoxProps) {
  const [text, setText] = useState('')
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [nsfw, setNsfw] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const avatar = useUserStore((s) => s.avatar)
  const displayName = useUserStore((s) => s.displayName)
  const addPost = useSocialStore((s) => s.addPost)

  const emojiBtnRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const media = useMediaUpload(signer, privateKey)
  const settings = useComposeSettings()

  const handlePost = async () => {
    if (!pubkey || (!signer && !privateKey)) return

    // If there are pending files, upload them first
    if (media.hasPendingOrFailed) {
      await media.uploadAll()
      return // User clicks Post again after upload completes
    }

    const mediaUrls = media.getUploadedUrls()
    const fullContent = mediaUrls.length > 0
      ? [text.trim(), ...mediaUrls].filter(Boolean).join('\n')
      : text.trim()

    if (!fullContent) return

    setPosting(true)
    setPostError(null)

    try {
      const tags: string[][] = []

      if (replyTo) {
        const rootId = replyTo.rootId || replyTo.id
        tags.push(['e', rootId, '', 'root'])
        tags.push(['e', replyTo.id, '', 'reply'])
        tags.push(['p', replyTo.pubkey])
      }

      if (nsfw) {
        tags.push(['content-warning', ''])
        tags.push(['L', 'content-warning'])
      }

      const unsigned = {
        kind: 1,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: fullContent,
      }

      const signed = await settings.publishWithSettings(unsigned)

      addPost(signed as any)
      setText('')
      setNsfw(false)
      media.clearAll()
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      onPosted?.()
    } catch (err) {
      console.error('Failed to post:', err)
      setPostError(err instanceof Error ? err.message : 'Failed to post. Please try again.')
    } finally {
      setPosting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = textareaRef.current
      if (ta) {
        const start = ta.selectionStart
        const end = ta.selectionEnd
        const spaces = '   '
        const before = text.substring(0, start)
        const after = text.substring(end)
        setText(`${before}${spaces}${after}`)
        requestAnimationFrame(() => {
          ta.focus()
          const pos = start + spaces.length
          ta.setSelectionRange(pos, pos)
          autoResize()
        })
      }
      return
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handlePost()
    }
  }

  /** Auto-resize textarea to fit content, up to MAX_HEIGHT then scroll */
  const MAX_TEXTAREA_HEIGHT = 200
  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px'
  }, [])

  const canPost = (text.trim() || media.allSuccess) && !media.isUploading && !posting

  return (
    <div className="flex gap-3 p-4 bg-secondary/50 rounded-lg max-[1080px]:p-0 max-[1080px]:bg-transparent">
      <Avatar className="h-10 w-10 shrink-0 max-[1080px]:hidden">
        {avatar && <AvatarImage src={avatar} />}
        <AvatarFallback className="text-sm bg-primary text-primary-foreground">
          {(displayName || 'U').slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); autoResize() }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || "What's happening?"}
          className="w-full bg-transparent resize-none outline-none text-sm min-h-[48px] text-foreground placeholder:text-muted-foreground rounded-sm py-2 px-2 overflow-y-auto"
          style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
          rows={2}
        />

        {/* Media upload previews */}
        <MediaUploadStrip
          pendingFiles={media.pendingFiles}
          isUploading={media.isUploading}
          onRemove={media.removeFile}
          onUpload={() => media.uploadAll()}
          onRetry={(id) => media.setPendingFiles((prev) => prev.map((f) => f.id === id ? { ...f, status: 'pending' as const } : f))}
          onSkipServer={() => { media.uploadAbortRef.current?.abort(); media.uploadAbortRef.current = null }}
          fileSizeWarning={media.fileSizeWarning}
          onDismissSizeWarning={media.dismissSizeWarning}
        />

        <div className="flex flex-wrap justify-between items-center gap-2 pt-2 border-t border-border/50">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setNsfw(!nsfw)}
              className={cn(
                'flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors cursor-pointer',
                nsfw ? 'text-red-500 bg-red-500/10' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <div className={cn(
                'relative w-7 h-[16px] rounded-full transition-colors shrink-0',
                nsfw ? 'bg-red-500' : 'bg-muted-foreground/30'
              )}>
                <div className={cn(
                  'absolute top-[3px] w-2.5 h-2.5 rounded-full bg-white shadow transition-all duration-200',
                  nsfw ? 'left-[15px]' : 'left-[3px]'
                )} />
              </div>
              NSFW
            </button>

            {/* Emoji picker */}
            <button
              ref={emojiBtnRef}
              onClick={() => setShowEmoji(!showEmoji)}
              className="p-1.5 rounded-full cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <Smile size={18} />
            </button>
            {showEmoji && (
              <EmojiPickerPopover
                anchorRef={emojiBtnRef}
                onClose={() => setShowEmoji(false)}
                onSelect={(emoji) => {
                  setText(text + emoji)
                  setShowEmoji(false)
                  textareaRef.current?.focus()
                }}
              />
            )}

            {/* Media upload */}
            <AddMediaButton
              onFilesSelected={(files) => media.addFiles(files)}
              uploading={media.isUploading}
            />

            {/* Settings gear */}
            <ComposeSettingsButton
              open={showSettings}
              onClick={() => setShowSettings(!showSettings)}
            />
          </div>

          <Button
            onClick={handlePost}
            disabled={!canPost}
            size="sm"
            className="gap-2 max-[1080px]:w-full"
          >
            {posting ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            {media.hasPendingOrFailed ? 'Upload & Post' : posting ? 'Posting...' : 'Post'}
          </Button>
        </div>
        {postError && <p className="text-xs text-red-400 mt-1.5">{postError}</p>}

        {/* Settings panel (collapsible) — below the toolbar */}
        {showSettings && (
          <div className="mt-2">
            <ComposeSettingsPanel settings={settings} />
          </div>
        )}
      </div>
    </div>
  )
}
