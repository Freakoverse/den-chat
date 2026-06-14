/**
 * ChatInputBar — Shared chat input component
 *
 * Provides: textarea with auto-resize, markdown toolbar, emoji picker, send button,
 * file upload (Blossom) with drag-drop, pending file previews, upload progress.
 *
 * Used by DMs (DMPage, DM04ChatView), ForumView, and PublicChatPage.
 *
 * ⚠️ NOTE: The hub chat (ChannelView.tsx → MessageInput) has its own inline
 * implementation of file upload UI. When updating file preview cards, remove
 * button styling, or encryption toggle here, also update MessageInput in
 * ChannelView.tsx to keep them in sync.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { getFileDraft, setFileDraft, clearFileDraft } from '@/stores/draftStore'
import {
  Send, Smile, Sticker, Bold, Italic, Strikethrough,
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6,
  List, ListOrdered, Link, Code, CodeSquare, ALargeSmall, Eye,
  Plus, Upload, Loader2, FileIcon, X, AlertTriangle, ImagePlay, ShieldOff,
  Clock, Mic, Lock, LockOpen, Scissors, ClipboardPaste, Copy, Type,
} from 'lucide-react'
import { EmojiPickerPopover } from '@/components/chat/EmojiPickerPopover'
import { StickerPickerPopover } from '@/components/chat/StickerPickerPopover'
import { GifPickerPopover } from '@/components/chat/GifPickerPopover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { uploadToBlossomServers, computeHash } from '@/lib/blossom'
import { getUploadBlossoms } from '@/stores/postingBehaviourStore'
import { encryptFile } from '@/lib/crypto/fileEncryption'
import { getEmojiMap } from '@/stores/emojiStore'
import { DatePicker } from '@/components/ui/DatePicker'
import { TimePicker } from '@/components/ui/TimePicker'
import { VoiceNoteModal } from '@/components/chat/VoiceNoteModal'
import type { UploadProgress } from '@/lib/blossom'
import type { ISigner } from '@/stores/userStore'

/* ─── Constants ─── */

/** Maximum message content length (characters) — shared across all chat types */
export const MESSAGE_MAX_LENGTH = 5120
/** Show the character counter when remaining chars ≤ this threshold */
export const MESSAGE_CHAR_WARN_THRESHOLD = 256

/* ─── Types ─── */

export type PendingFile = {
  id: string
  file: File
  status: 'pending' | 'uploading' | 'encrypting' | 'success' | 'failed'
  hash?: string
  progress?: UploadProgress
  previewUrl?: string
  /** Encryption metadata (populated when encryptBeforeUpload is true) */
  encryption?: {
    keyHex: string
    nonceHex: string
    originalHashHex: string
    encryptedHashHex: string
    cipherSize: number
  }
}

export interface FileAttachment {
  hash: string
  type: string
  name: string
  size: number
  /** Encryption metadata (present when file was encrypted before upload) */
  encryption?: {
    keyHex: string
    nonceHex: string
    originalHashHex: string
    encryptedHashHex: string
    cipherSize: number
  }
}

/* ─── Props ─── */

interface ChatInputBarProps {
  /** The message text (controlled) */
  message: string
  /** Update the message text */
  onMessageChange: (msg: string) => void
  /** Called when user presses Send. Receives file attachments if any were uploaded. */
  onSend: (attachments?: FileAttachment[]) => void
  /** Placeholder text for the textarea */
  placeholder?: string
  /** Whether the input is disabled */
  disabled?: boolean
  /** Whether a send is currently in progress (shows spinner in send button) */
  sending?: boolean
  /** Override whether the send button should be shown */
  canSend?: boolean
  /** Extra left-side buttons (hub NSFW toggle, etc.) */
  leftActions?: React.ReactNode
  /** Content to render above the input bar (reply indicator, etc.) */
  topContent?: React.ReactNode
  /** Whether topContent is present (affects rounding) */
  hasTopContent?: boolean
  /** Ref to expose the textarea element */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  /** Enable file uploads (needs signer + blossom servers) */
  enableFileUpload?: boolean
  /** ISigner for Blossom auth */
  signer?: ISigner | null
  /** Private key hex for Blossom auth */
  privateKey?: string | null
  /** Hub-specific blossom servers to merge into posting behaviour (optional) */
  hubBlossomServers?: string[]
  /** Ref to the container element for drag-drop scope (must have position: relative) */
  dragContainerRef?: React.RefObject<HTMLElement | null>
  /** Callback when user selects a sticker from the picker */
  onStickerSelect?: (sticker: { shortcode: string; url: string; setAddress: string }) => void
  /** Callback when user selects a GIF from the picker */
  onGifSelect?: (gif: { name: string; url: string; nsfw: boolean }) => void
  /** Hide the 'uploads are not encrypted' privacy notice (e.g. public chat) */
  hideUploadWarning?: boolean
  /**
   * When true, encrypt files with AES-256-GCM before uploading to Blossom.
   * The ciphertext is uploaded instead of the plaintext, and encryption
   * metadata (key, nonce, hashes) is attached to the FileAttachment.
   * Used by NIP-17 DMs for end-to-end encrypted file attachments.
   * This sets the default toggle state — user can toggle on/off per-upload.
   */
  encryptBeforeUpload?: boolean
  /**
   * When true, the encryption toggle is hidden and encryption is forced.
   * Used by NIP-17 DMs where encryption is mandatory.
   */
  forceEncrypt?: boolean
  /**
   * Key used to persist pending file attachments across navigation.
   * Should match the text draft key (e.g. dm17:<pubkey>, hub:<dtag>:<channel>).
   * When provided, files are saved to an in-memory store on unmount and
   * restored on mount so they survive switching conversations.
   */
  draftKey?: string
}

/* ─── Helpers ─── */

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSpeed(bps: number) {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

function shortServerName(url: string) {
  try { return new URL(url).hostname.replace('www.', '') } catch { return url }
}

/* ─── Component ─── */

export function ChatInputBar({
  message,
  onMessageChange,
  onSend,
  placeholder = 'Type a message...',
  disabled = false,
  sending = false,
  canSend: canSendOverride,
  leftActions,
  topContent,
  hasTopContent = false,
  textareaRef: externalTextareaRef,
  enableFileUpload = false,
  signer,
  privateKey,
  hubBlossomServers,
  dragContainerRef,
  onStickerSelect,
  onGifSelect,
  hideUploadWarning = false,
  encryptBeforeUpload = false,
  forceEncrypt = false,
  draftKey,
}: ChatInputBarProps) {
  const [showEmoji, setShowEmoji] = useState(false)
  const [showSticker, setShowSticker] = useState(false)
  const [showGif, setShowGif] = useState(false)
  const [showVoiceNote, setShowVoiceNote] = useState(false)
  const [showToolbar, setShowToolbar] = useState(false)
  const [showTimestamp, setShowTimestamp] = useState(false)
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const stickerButtonRef = useRef<HTMLButtonElement>(null)
  const gifButtonRef = useRef<HTMLButtonElement>(null)
  const timestampButtonRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)

  const textareaRef = externalTextareaRef || internalTextareaRef

  // File upload state — initialise from draft store if draftKey provided
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(() => draftKey ? getFileDraft(draftKey) : [])
  const [isUploading, setIsUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [fileSizeWarning, setFileSizeWarning] = useState<{ names: string[]; limitMb: number } | null>(null)
  const knownHashesRef = useRef<Set<string>>((() => {
    // Pre-populate known hashes from restored draft files
    const s = new Set<string>()
    if (draftKey) {
      for (const f of getFileDraft(draftKey)) {
        if (f.hash) s.add(f.hash)
      }
    }
    return s
  })())

  // ─── File Draft Persistence ───
  // Save pending files to in-memory draft store whenever draftKey changes or on unmount
  const pendingFilesRef = useRef(pendingFiles)
  pendingFilesRef.current = pendingFiles

  const _prevDraftKey = useRef(draftKey)
  useEffect(() => {
    if (_prevDraftKey.current !== draftKey) {
      // Switching context — save old files, load new
      if (_prevDraftKey.current) setFileDraft(_prevDraftKey.current, pendingFilesRef.current)
      _prevDraftKey.current = draftKey
      const restored = draftKey ? getFileDraft(draftKey) : []
      setPendingFiles(restored)
      // Update known hashes
      knownHashesRef.current.clear()
      for (const f of restored) {
        if (f.hash) knownHashesRef.current.add(f.hash)
      }
    }
  }, [draftKey])

  // Save files to draft store on unmount
  useEffect(() => {
    return () => {
      if (draftKey) setFileDraft(draftKey, pendingFilesRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])
  // Encryption toggle — defaults to encryptBeforeUpload prop, user can toggle
  const [encryptUploads, setEncryptUploads] = useState(() => {
    if (forceEncrypt) return true
    if (encryptBeforeUpload) return true
    return localStorage.getItem('den-chat-encrypt-uploads') === 'true'
  })
  const toggleEncryptUploads = useCallback(() => {
    if (forceEncrypt) return // can't toggle when forced
    setEncryptUploads((prev) => {
      const next = !prev
      localStorage.setItem('den-chat-encrypt-uploads', String(next))
      return next
    })
  }, [forceEncrypt])

  // Auto-resize textarea to fit content, up to 500px
  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 500)}px`
  }, [])

  // Re-run autoResize when message changes externally (e.g. cleared after send)
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) autoResize(ta)
  }, [message, autoResize, textareaRef])

  // ─── Emoji shortcode autocomplete state ───
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null)
  const [emojiIndex, setEmojiIndex] = useState(0)
  const emojiStartRef = useRef<number | null>(null)
  const emojiListRef = useRef<HTMLDivElement>(null)

  const emojiSuggestions = useMemo(() => {
    if (emojiQuery === null) return []
    const q = emojiQuery.toLowerCase()
    const map = getEmojiMap()
    const results: { shortcode: string; url: string }[] = []
    for (const [shortcode, entry] of map) {
      if (shortcode.toLowerCase().includes(q)) {
        results.push({ shortcode, url: entry.url })
      }
      if (results.length >= 8) break
    }
    return results
  }, [emojiQuery])

  const updateEmojiQuery = useCallback((text: string, cursorPos: number) => {
    const beforeCursor = text.slice(0, cursorPos)
    const colonMatch = beforeCursor.match(/:([a-zA-Z0-9_-]+)$/)
    if (colonMatch) {
      const prefix = beforeCursor.slice(0, colonMatch.index)
      const lastColonInPrefix = prefix.lastIndexOf(':')
      if (lastColonInPrefix >= 0) {
        const between = prefix.slice(lastColonInPrefix + 1)
        if (/^[a-zA-Z0-9_-]+$/.test(between)) {
          setEmojiQuery(null)
          emojiStartRef.current = null
          return
        }
      }
      setEmojiQuery(colonMatch[1])
      emojiStartRef.current = cursorPos - colonMatch[0].length
      setEmojiIndex(0)
    } else {
      setEmojiQuery(null)
      emojiStartRef.current = null
    }
  }, [])

  const applyEmojiSuggestion = useCallback((suggestion: { shortcode: string; url: string }) => {
    const start = emojiStartRef.current
    if (start === null) return
    const ta = textareaRef.current
    const before = message.slice(0, start)
    const afterCursor = ta ? message.slice(ta.selectionStart) : ''
    const emojiText = `:${suggestion.shortcode}:`
    const newText = `${before}${emojiText} ${afterCursor}`
    onMessageChange(newText)
    setEmojiQuery(null)
    emojiStartRef.current = null
    requestAnimationFrame(() => {
      if (ta) {
        const pos = before.length + emojiText.length + 1
        ta.focus()
        ta.setSelectionRange(pos, pos)
        autoResize(ta)
      }
    })
  }, [message, autoResize, onMessageChange, textareaRef])


  // Insert markdown syntax around selection or at cursor
  const insertMarkdown = useCallback((prefix: string, suffix = '', mdPlaceholder = '') => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = message.substring(start, end)
    const text = selected || mdPlaceholder
    const before = message.substring(0, start)
    const after = message.substring(end)
    const newText = `${before}${prefix}${text}${suffix}${after}`
    onMessageChange(newText)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(
        start + prefix.length,
        start + prefix.length + text.length
      )
      autoResize(ta)
    })
  }, [message, autoResize, onMessageChange, textareaRef])

  const insertLinePrefix = useCallback((prefix: string) => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const lineStart = message.lastIndexOf('\n', start - 1) + 1
    const before = message.substring(0, lineStart)
    const after = message.substring(lineStart)
    const newText = `${before}${prefix}${after}`
    onMessageChange(newText)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(start + prefix.length, start + prefix.length)
      autoResize(ta)
    })
  }, [message, autoResize, onMessageChange, textareaRef])

  // ─── File Upload Logic ───

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    const limitBytes = limitMb * 1024 * 1024
    const tooLarge = files.filter((f) => f.size > limitBytes)
    const allowed = files.filter((f) => f.size <= limitBytes)
    if (tooLarge.length > 0) {
      setFileSizeWarning({ names: tooLarge.map((f) => f.name), limitMb })
    }
    if (allowed.length === 0) return

    // Compute hashes and filter duplicates using ref (synchronous, no stale state)
    const newPending: PendingFile[] = []
    for (const file of allowed) {
      const buffer = await file.arrayBuffer()
      const hash = computeHash(new Uint8Array(buffer))
      // Skip if this hash is already known
      if (knownHashesRef.current.has(hash)) continue
      // Mark as known immediately (synchronous, prevents race conditions)
      knownHashesRef.current.add(hash)

      const pf: PendingFile = {
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        file,
        status: 'pending',
        hash,
      }
      if (file.type.startsWith('image/')) {
        pf.previewUrl = URL.createObjectURL(file)
      }
      newPending.push(pf)
    }
    if (newPending.length > 0) {
      setPendingFiles((prev) => [...prev, ...newPending])
    }
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files || []))
    e.target.value = ''
  }, [addFiles])

  const removeFile = useCallback((fileId: string) => {
    setPendingFiles((prev) => {
      const removed = prev.find((f) => f.id === fileId)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      if (removed?.hash) knownHashesRef.current.delete(removed.hash)
      return prev.filter((f) => f.id !== fileId)
    })
  }, [])

  const handleUploadFiles = useCallback(async () => {
    const toUpload = pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed')
    if (toUpload.length === 0) return

    setIsUploading(true)

    for (const pf of toUpload) {
      setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: encryptUploads ? 'encrypting' as const : 'uploading' as const, progress: undefined } : f))
      try {
        const buffer = await pf.file.arrayBuffer()
        let data = new Uint8Array(buffer)
        let contentType = pf.file.type
        let encMeta: PendingFile['encryption'] | undefined

        // Encrypt before upload when toggle is on
        if (encryptUploads) {
          const encrypted = await encryptFile(data)
          encMeta = {
            keyHex: encrypted.keyHex,
            nonceHex: encrypted.nonceHex,
            originalHashHex: encrypted.originalHashHex,
            encryptedHashHex: encrypted.encryptedHashHex,
            cipherSize: encrypted.cipherBytes.length,
          }
          data = encrypted.cipherBytes.slice() as Uint8Array<ArrayBuffer>
          contentType = 'application/octet-stream' // ciphertext has no meaningful MIME
          setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'uploading' as const } : f))
        }

        // Resolve blossom servers at upload time from posting behaviour settings
        const servers = getUploadBlossoms(hubBlossomServers)

        const { hash } = await uploadToBlossomServers(
          data, signer || null, privateKey || null, servers, contentType,
          (progress) => {
            setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, progress: { ...progress } } : f))
          },
          () => { const c = new AbortController(); uploadAbortRef.current = c; return c.signal },
        )
        setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'success' as const, hash, progress: undefined, encryption: encMeta } : f))
      } catch {
        setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'failed' as const, progress: undefined } : f))
      }
    }
    setIsUploading(false)
  }, [pendingFiles, signer, privateKey, hubBlossomServers, encryptUploads])

  // ─── Send Logic ───

  const hasFailedFiles = pendingFiles.some((f) => f.status === 'failed')
  const hasPendingOrUploading = pendingFiles.some((f) => f.status === 'pending' || f.status === 'uploading' || f.status === 'encrypting')
  const allFilesSuccess = pendingFiles.length > 0 && pendingFiles.every((f) => f.status === 'success')

  // Character limit
  const charsRemaining = MESSAGE_MAX_LENGTH - message.length
  const isOverLimit = charsRemaining < 0
  const showCharCounter = charsRemaining <= MESSAGE_CHAR_WARN_THRESHOLD

  const showSend = canSendOverride !== undefined
    ? (canSendOverride && !isOverLimit)
    : ((message.trim() || allFilesSuccess) && !hasPendingOrUploading && !hasFailedFiles && !sending && !isOverLimit)

  const handleSend = useCallback(() => {
    if (isOverLimit) return
    // Build attachments from successful uploads
    const attachments: FileAttachment[] = pendingFiles
      .filter((f) => f.status === 'success' && f.hash)
      .map((f) => ({
        hash: f.hash || '',
        type: f.file.type || 'application/octet-stream',
        name: f.file.name,
        size: f.file.size,
        ...(f.encryption ? { encryption: f.encryption } : {}),
      }))

    onSend(attachments.length > 0 ? attachments : undefined)

    // Clean up files after send
    if (attachments.length > 0) {
      pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl) })
      setPendingFiles([])
      knownHashesRef.current.clear()
      if (draftKey) clearFileDraft(draftKey)
    }
  }, [onSend, pendingFiles, draftKey])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // :emoji: autocomplete keyboard handling
    if (emojiQuery !== null && emojiSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setEmojiIndex((i) => Math.min(i + 1, emojiSuggestions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setEmojiIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        applyEmojiSuggestion(emojiSuggestions[emojiIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setEmojiQuery(null)
        emojiStartRef.current = null
        return
      }
    }
    // Tab without emoji autocomplete → insert 3 spaces for markdown indentation
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = textareaRef.current
      if (ta) {
        const start = ta.selectionStart
        const end = ta.selectionEnd
        const spaces = '   '
        const before = message.substring(0, start)
        const after = message.substring(end)
        onMessageChange(`${before}${spaces}${after}`)
        requestAnimationFrame(() => {
          ta.focus()
          const pos = start + spaces.length
          ta.setSelectionRange(pos, pos)
          autoResize(ta)
        })
      }
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (showSend && !isOverLimit) handleSend()
    }
  }

  // ─── Paste-to-attach: document-level listener ───
  // Listen on document so right-click→Paste works even after the context
  // menu steals focus away from the textarea.  Only file pastes are
  // intercepted — plain-text pastes flow through normally.
  useEffect(() => {
    if (!enableFileUpload) return
    const onPaste = (e: ClipboardEvent) => {
      const cd = e.clipboardData
      if (!cd) return
      const files: File[] = []
      if (cd.items) {
        for (let i = 0; i < cd.items.length; i++) {
          const item = cd.items[i]
          if (item.kind === 'file') {
            const file = item.getAsFile()
            if (file) files.push(file)
          }
        }
      }
      if (files.length === 0 && cd.files && cd.files.length > 0) {
        for (let i = 0; i < cd.files.length; i++) {
          files.push(cd.files[i])
        }
      }
      if (files.length > 0) {
        e.preventDefault()
        addFiles(files)
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [enableFileUpload, addFiles])

  // ─── Custom context menu for textarea (right-click → Paste with file support) ───
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  // Use native listener so preventDefault() fires before the browser shows its own menu.
  // Firefox fires proper paste events from its native context menu — skip the custom
  // menu on Firefox and let its native context menu handle paste.
  useEffect(() => {
    const ta = textareaRef.current
    if (!enableFileUpload || !ta) return
    if (/firefox/i.test(navigator.userAgent)) return
    const onCtx = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
    ta.addEventListener('contextmenu', onCtx)
    return () => ta.removeEventListener('contextmenu', onCtx)
  }, [enableFileUpload])

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const ctxPaste = useCallback(async () => {
    setCtxMenu(null)

    // Helper: insert text into the textarea at cursor
    const insertText = (text: string) => {
      const ta = textareaRef.current
      if (!ta || !text) return
      const start = ta.selectionStart
      const end = ta.selectionEnd
      onMessageChange(message.slice(0, start) + text + message.slice(end))
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + text.length
        autoResize(ta)
      })
    }

    // Helper: last-resort fallback — focus textarea and trigger native paste
    const execFallback = () => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      try { document.execCommand('paste') } catch { /* blocked */ }
    }

    try {
      // 1. Try Clipboard API read() for images/files
      if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
        const items = await navigator.clipboard.read()
        const files: File[] = []
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type)
              const ext = type.split('/')[1] || 'png'
              const file = new File([blob], `image.${ext}`, { type })
              files.push(file)
            }
          }
        }
        if (files.length > 0) {
          addFiles(files)
          return
        }
        // No images found — paste text
        const text = await navigator.clipboard.readText()
        insertText(text)
        return
      }
      // clipboard.read not available — try readText
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        const text = await navigator.clipboard.readText()
        insertText(text)
        return
      }
      // No Clipboard API at all — execCommand fallback
      execFallback()
    } catch {
      // clipboard.read() or readText() threw (permission denied / unsupported)
      try {
        const text = await navigator.clipboard.readText()
        insertText(text)
      } catch {
        // Everything failed — try native execCommand as last resort
        execFallback()
      }
    }
  }, [addFiles, message, onMessageChange, autoResize])

  const ctxPasteTextOnly = useCallback(async () => {
    setCtxMenu(null)
    try {
      const text = await navigator.clipboard.readText()
      if (text && textareaRef.current) {
        const ta = textareaRef.current
        const start = ta.selectionStart
        const end = ta.selectionEnd
        onMessageChange(message.slice(0, start) + text + message.slice(end))
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + text.length
          autoResize(ta)
        })
      }
    } catch {
      // Fallback for browsers without clipboard permission
      const ta = textareaRef.current
      if (ta) { ta.focus(); try { document.execCommand('paste') } catch { /* blocked */ } }
    }
  }, [message, onMessageChange, autoResize])

  const ctxCut = useCallback(() => {
    setCtxMenu(null)
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (start === end) return
    const selected = message.slice(start, end)
    navigator.clipboard.writeText(selected)
    onMessageChange(message.slice(0, start) + message.slice(end))
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start
      autoResize(ta)
    })
  }, [message, onMessageChange, autoResize])

  const ctxCopy = useCallback(() => {
    setCtxMenu(null)
    const ta = textareaRef.current
    if (!ta) return
    const selected = message.slice(ta.selectionStart, ta.selectionEnd)
    if (selected) navigator.clipboard.writeText(selected)
  }, [message])

  const ctxSelectAll = useCallback(() => {
    setCtxMenu(null)
    const ta = textareaRef.current
    if (!ta) return
    ta.focus()
    ta.selectionStart = 0
    ta.selectionEnd = message.length
  }, [message])

  // ─── Drag & Drop (scoped to dragContainerRef) ───

  useEffect(() => {
    const el = dragContainerRef?.current
    if (!enableFileUpload || !el) return
    let counter = 0

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
      counter++
      if (e.dataTransfer?.types.includes('Files')) setIsDragging(true)
    }
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
      counter--
      if (counter === 0) setIsDragging(false)
    }
    const onDragOver = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
      counter = 0
      setIsDragging(false)
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        addFiles(Array.from(e.dataTransfer.files))
      }
    }

    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
    }
  }, [enableFileUpload, dragContainerRef, addFiles])


  // Detect custom emoji shortcodes in the message
  const detectedEmojis = useMemo(() => {
    const map = getEmojiMap()
    if (map.size === 0 || !message) return []
    const found: { shortcode: string; url: string }[] = []
    const seen = new Set<string>()
    const re = /:([a-zA-Z0-9_-]+):/g
    let m: RegExpExecArray | null
    while ((m = re.exec(message)) !== null) {
      const sc = m[1]
      if (seen.has(sc)) continue
      seen.add(sc)
      const entry = map.get(sc)
      if (entry) found.push({ shortcode: sc, url: entry.url })
    }
    return found
  }, [message])

  // Determine rounding classes
  const hasAboveContent = hasTopContent || !!topContent || showToolbar || pendingFiles.length > 0 || detectedEmojis.length > 0

  return (
    <>
      {/* Drop overlay — rendered via portal into the container so it covers the chat area */}
      {isDragging && dragContainerRef?.current && createPortal(
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary px-12 py-8 flex flex-col items-center gap-2 text-primary bg-background/60">
            <Upload size={24} />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>,
        dragContainerRef.current
      )}

      <div
        className="px-2 pb-2"
      >
        {/* Content above bar (reply indicator, etc.) */}
        {topContent}

        {/* Markdown toolbar */}
        {showToolbar && (
          <TooltipProvider delayDuration={200}>
            <div className={`flex flex-wrap items-center gap-0.5 px-3 py-1.5 bg-secondary/80 border border-border border-b-0 ${hasTopContent || topContent ? '' : 'rounded-t-xl'}`}>
              {[
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
              ].map(({ icon: Icon, action, tip }) => (
                <Tooltip key={tip}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={action}
                      className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                    >
                      <Icon size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {tip}
                  </TooltipContent>
                </Tooltip>
              ))}
              {/* Clock button + popover — wrapped in relative so popover appears above the button */}
              <div className="relative">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      ref={timestampButtonRef}
                      onClick={() => setShowTimestamp(!showTimestamp)}
                      className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                    >
                      <Clock size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    Insert Timestamp
                  </TooltipContent>
                </Tooltip>
                {showTimestamp && (
                  <TimestampPickerPopover
                    triggerRef={timestampButtonRef}
                    onClose={() => setShowTimestamp(false)}
                    onInsert={(unix) => {
                      const token = `<t:${unix}>`
                      const ta = textareaRef.current
                      if (ta) {
                        const start = ta.selectionStart
                        const end = ta.selectionEnd
                        const before = message.substring(0, start)
                        const after = message.substring(end)
                        const newText = `${before}${token}${after}`
                        onMessageChange(newText)
                        requestAnimationFrame(() => {
                          ta.focus()
                          const pos = start + token.length
                          ta.setSelectionRange(pos, pos)
                          autoResize(ta)
                        })
                      } else {
                        onMessageChange(message + token)
                      }
                      setShowTimestamp(false)
                    }}
                  />
                )}
              </div>
            </div>
          </TooltipProvider>
        )}

        {/* File preview strip */}
        {pendingFiles.length > 0 && (
          <div className={`flex flex-col gap-2 px-3 py-2 bg-secondary/60 border border-border border-b-0 ${!topContent && !hasTopContent && !showToolbar ? 'rounded-t-xl' : ''}`}>
            {/* Scrollable file cards row */}
            <div className="flex gap-2 overflow-x-auto">
            {pendingFiles.map((pf) => (
              <div key={pf.id} className="flex items-stretch bg-background rounded-lg border border-border min-w-[140px] max-w-[220px] shrink-0">
                <div className="flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5">
                {/* Thumbnail or file icon */}
                {pf.previewUrl ? (
                  <img src={pf.previewUrl} alt={pf.file.name} className="w-10 h-10 rounded object-cover shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded bg-secondary flex items-center justify-center shrink-0">
                    <FileIcon size={18} className="text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-foreground truncate">{pf.file.name}</p>
                  <p className="text-[10px] text-muted-foreground">{formatFileSize(pf.file.size)}</p>
                  {/* Upload progress */}
                  {pf.status === 'uploading' && pf.progress && (
                    <div className="mt-0.5">
                      <div className="w-full h-1 rounded-full bg-secondary overflow-hidden">
                        <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${pf.progress.percent}%` }} />
                      </div>
                      <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-0.5">
                        <span className="truncate">{shortServerName(pf.progress.serverUrl)} ({pf.progress.serverIndex + 1}/{pf.progress.totalServers})</span>
                        <span className="flex items-center gap-1">
                          {pf.progress.percent >= 100
                            ? <span className="text-amber-400">Processing...</span>
                            : formatSpeed(pf.progress.speed)
                          }
                          <TooltipProvider delayDuration={300}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => { uploadAbortRef.current?.abort(); uploadAbortRef.current = null }}
                                  className="text-muted-foreground hover:text-destructive cursor-pointer ml-0.5"
                                >
                                  skip
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">Skip this server</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </span>
                      </div>
                    </div>
                  )}
                  {pf.status === 'encrypting' && <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Lock size={9} /> Encrypting…</span>}
                  {pf.status === 'success' && (
                    pf.encryption
                      ? <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Lock size={9} /> Encrypted & uploaded</span>
                      : <span className="text-[10px] text-amber-400 flex items-center gap-1"><LockOpen size={9} /> Unencrypted & uploaded</span>
                  )}
                  {pf.status === 'failed' && (
                    <button onClick={() => setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'pending' as const } : f))} className="text-[10px] text-destructive hover:underline cursor-pointer">Failed — retry</button>
                  )}
                </div>
                </div>
                {/* Remove button — full-height column */}
                {pf.status !== 'uploading' && pf.status !== 'encrypting' && (
                  <button
                    onClick={() => removeFile(pf.id)}
                    className="flex items-center justify-center px-1.5 border-l border-border text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer transition-colors rounded-r-lg"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
            </div>
            {/* Upload button + status — always visible below scroll */}
            <div className="flex items-center gap-2">
            {pendingFiles.some((f) => f.status === 'pending' || f.status === 'failed') && !isUploading && (
              <button
                onClick={handleUploadFiles}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors cursor-pointer"
              >
                <Upload size={14} />
                Upload {pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed').length} file{pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed').length > 1 ? 's' : ''}
              </button>
            )}
            {isUploading && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                Uploading...
              </div>
            )}
            </div>
            {/* Encrypt uploads toggle + privacy notice */}
            {!hideUploadWarning && (
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer select-none transition-colors"
                style={{ background: encryptUploads ? 'rgba(16,185,129,0.06)' : 'rgba(245,158,11,0.06)', border: `1px solid ${encryptUploads ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)'}` }}
                onClick={toggleEncryptUploads}
              >
                {/* Toggle switch */}
                {!forceEncrypt && (
                  <div className={`relative w-8 h-4 rounded-full shrink-0 transition-colors ${encryptUploads ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`}>
                    <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${encryptUploads ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                  </div>
                )}
                {encryptUploads ? (
                  <>
                    <Lock size={12} className="text-emerald-500 shrink-0" />
                    <span className="text-sm text-emerald-500/80 leading-tight">Files will be encrypted before upload — only chat participants can view them, but images/video/audio must fully download before displaying.</span>
                  </>
                ) : (
                  <>
                    <ShieldOff size={12} className="text-amber-500 shrink-0" />
                    <span className="text-sm text-amber-500/80 leading-tight">Media uploads are not encrypted — blossom server operators can view uploaded files, but images/video/audio are streamed immediately.</span>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {enableFileUpload && (
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
        )}
        {/* Detected emoji preview bar */}
        {detectedEmojis.length > 0 && (
          <div className={`flex items-center gap-1.5 px-3 py-1 bg-secondary/60 border border-border border-b-0 ${hasTopContent || !!topContent || showToolbar || pendingFiles.length > 0 ? '' : 'rounded-t-md'}`}>
            <span className="text-[10px] text-muted-foreground shrink-0">Emojis:</span>
            {detectedEmojis.map((e) => (
              <TooltipProvider key={e.shortcode} delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <img src={e.url} alt={`:${e.shortcode}:`} className="h-5 w-5 object-contain" loading="lazy" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">:{e.shortcode}:</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          </div>
        )}

        {/* Main input bar */}
        <div className={`relative flex items-center gap-2 px-3 py-2 bg-secondary border border-border ${hasAboveContent ? 'rounded-b-md' : 'rounded-md'} max-[1080px]:flex-wrap`}>
          {/* Emoji autocomplete dropdown */}
          {emojiQuery !== null && emojiSuggestions.length > 0 && (
            <div
              ref={emojiListRef}
              className="absolute bottom-full left-0 right-0 mb-1 bg-popover/95 backdrop-blur-md border border-border rounded-lg shadow-xl overflow-hidden z-50 max-h-[240px] overflow-y-auto"
            >
              {emojiSuggestions.map((s, i) => (
                <button
                  key={s.shortcode}
                  onMouseDown={(e) => { e.preventDefault(); applyEmojiSuggestion(s) }}
                  onMouseEnter={() => setEmojiIndex(i)}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors cursor-pointer ${i === emojiIndex ? 'bg-primary/15' : 'hover:bg-accent/40'
                    }`}
                >
                  <img src={s.url} alt={`:${s.shortcode}:`} className="h-6 w-6 object-contain shrink-0" loading="lazy" />
                  <span className="text-sm text-foreground truncate">:{s.shortcode}:</span>
                </button>
              ))}
            </div>
          )}
          {/* File attach button */}
          {enableFileUpload && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={() => fileInputRef.current?.click()} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
                  <Plus size={20} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Attach files</TooltipContent>
            </Tooltip>
          )}

          {/* Left actions (hub: NSFW toggle, etc.) */}
          {leftActions}

          {/* Toolbar toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => setShowToolbar(!showToolbar)} className={`p-1 cursor-pointer transition-colors ${showToolbar ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                <ALargeSmall size={20} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Formatting toolbar</TooltipContent>
          </Tooltip>

          {/* Emoji picker */}
          <button ref={emojiButtonRef} onClick={() => setShowEmoji(!showEmoji)} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors min-[1081px]:order-1">
            <Smile size={20} />
          </button>
          {showEmoji && (
            <EmojiPickerPopover
              anchorRef={emojiButtonRef}
              onClose={() => setShowEmoji(false)}
              onSelect={(emoji) => {
                onMessageChange(message + emoji)
                setShowEmoji(false)
                textareaRef.current?.focus()
              }}
            />
          )}

          {/* Sticker picker */}
          {onStickerSelect && (
            <>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button ref={stickerButtonRef} onClick={() => setShowSticker(!showSticker)} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors min-[1081px]:order-1">
                      <Sticker size={20} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Stickers</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {showSticker && (
                <StickerPickerPopover
                  anchorRef={stickerButtonRef}
                  onClose={() => setShowSticker(false)}
                  onSelect={(sticker) => {
                    onStickerSelect(sticker)
                    setShowSticker(false)
                  }}
                />
              )}
            </>
          )}

          {/* GIF picker */}
          {onGifSelect && (
            <>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button ref={gifButtonRef} onClick={() => setShowGif(!showGif)} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors min-[1081px]:order-1">
                      <ImagePlay size={20} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">GIFs</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {showGif && (
                <GifPickerPopover
                  anchorRef={gifButtonRef}
                  onClose={() => setShowGif(false)}
                  onSelect={(gif) => {
                    onGifSelect(gif)
                    setShowGif(false)
                  }}
                />
              )}
            </>
          )}

          {/* Voice note */}
          {enableFileUpload && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={() => setShowVoiceNote(true)} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors min-[1081px]:order-1">
                    <Mic size={20} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Voice Note</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {showVoiceNote && (
            <VoiceNoteModal
              onAttach={(file) => { addFiles([file]); setShowVoiceNote(false) }}
              onClose={() => setShowVoiceNote(false)}
            />
          )}

          {/* Mobile: flex-break + divider between button row and textarea row */}
          <div className="hidden max-[1080px]:block basis-full h-px bg-border/30 order-[1]" aria-hidden />

          {/* Textarea — on mobile, drops to its own row below the buttons */}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => {
              onMessageChange(e.target.value)
              autoResize(e.target)
              updateEmojiQuery(e.target.value, e.target.selectionStart)
            }}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder}
            className="flex-1 p-2 bg-transparent resize-none outline-none text-sm min-h-[32px] text-foreground placeholder:text-muted-foreground rounded-sm disabled:opacity-50 max-[1080px]:order-[2]"
            style={{ maxHeight: '500px', overflowY: 'auto' }}
            rows={1}
          />

          {/* Custom context menu (right-click) */}
          {ctxMenu && createPortal(
            <div
              ref={(el) => {
                if (!el) return
                const rect = el.getBoundingClientRect()
                let x = ctxMenu.x
                let y = ctxMenu.y
                if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4
                if (x < 4) x = 4
                if (y + rect.height > window.innerHeight) y = ctxMenu.y - rect.height
                if (y < 4) y = 4
                el.style.left = `${x}px`
                el.style.top = `${y}px`
                el.style.opacity = '1'
              }}
              className="fixed z-[9999] w-48 bg-popover border border-border rounded-md shadow-lg p-1 flex flex-col gap-1"
              style={{ left: -9999, top: -9999, opacity: 0 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                onMouseDown={(e) => { e.stopPropagation(); ctxCut() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <Scissors size={14} /> Cut
              </button>
              <button
                onMouseDown={(e) => { e.stopPropagation(); ctxCopy() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <Copy size={14} /> Copy
              </button>
              <button
                onMouseDown={(e) => { e.stopPropagation(); ctxPaste() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <ClipboardPaste size={14} /> Paste
              </button>
              <button
                onMouseDown={(e) => { e.stopPropagation(); ctxPasteTextOnly() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <Type size={14} /> Paste as text
              </button>
              <div className="h-px bg-border mx-2" />
              <button
                onMouseDown={(e) => { e.stopPropagation(); ctxSelectAll() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <ALargeSmall size={14} /> Select all
              </button>
            </div>,
            document.body
          )}

          {/* Character counter */}
          {showCharCounter && (
            <span className={`text-[11px] font-mono tabular-nums select-none transition-colors min-[1081px]:order-1 max-[1080px]:order-[2] ${
              isOverLimit ? 'text-red-400 font-semibold' : charsRemaining <= 100 ? 'text-amber-400' : 'text-muted-foreground/60'
            }`}>
              {charsRemaining}
            </span>
          )}

          {/* Send button */}
          {showSend && (
            <button
              onClick={handleSend}
              className="h-8 w-8 flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer shrink-0 min-[1081px]:order-1 max-[1080px]:order-[2]"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          )}
        </div>
      </div>

      {/* File size limit warning modal */}
      {fileSizeWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={() => setFileSizeWarning(null)}>
          <div className="w-[400px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500 shrink-0" />
              <h4 className="text-sm font-semibold text-foreground">File Too Large</h4>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                The following file{fileSizeWarning.names.length > 1 ? 's exceed' : ' exceeds'} the {fileSizeWarning.limitMb} MB upload limit and {fileSizeWarning.names.length > 1 ? 'were' : 'was'} not added:
              </p>
              <div className="space-y-1">
                {fileSizeWarning.names.map((name) => (
                  <div key={name} className="text-xs font-mono text-foreground bg-secondary/50 px-2 py-1 rounded truncate">{name}</div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                This soft limit improves upload success rates across blossom servers. You can change it in <strong>Settings → Network → Media Upload Limit</strong>.
              </p>
            </div>
            <button onClick={() => setFileSizeWarning(null)} className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/* ─── TimestampPickerPopover ─── */

function TimestampPickerPopover({
  triggerRef,
  onClose,
  onInsert,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onInsert: (unix: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  const [dateVal, setDateVal] = useState(todayStr)
  const [timeVal, setTimeVal] = useState(nowTime)

  // Close on outside click (exclude trigger button to allow toggle)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, triggerRef])

  // Compute preview unix timestamp
  const unix = useMemo(() => {
    if (!dateVal || !timeVal) return null
    const [y, mo, d] = dateVal.split('-').map(Number)
    const [h, mi] = timeVal.split(':').map(Number)
    const dt = new Date(y, mo - 1, d, h, mi, 0)
    return Math.floor(dt.getTime() / 1000)
  }, [dateVal, timeVal])

  // Live-updating preview text
  const [previewText, setPreviewText] = useState('')
  useEffect(() => {
    if (!unix) { setPreviewText(''); return }
    const update = () => {
      const dt = new Date(unix * 1000)
      const datePart = dt.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
      const timePart = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      const diffMs = dt.getTime() - Date.now()
      const absDiffMs = Math.abs(diffMs)
      let relative = ''
      if (absDiffMs < 60_000) {
        relative = diffMs >= 0 ? 'now' : 'just now'
      } else if (absDiffMs < 3_600_000) {
        const mins = Math.round(absDiffMs / 60_000)
        relative = diffMs >= 0 ? `in ${mins} minute${mins !== 1 ? 's' : ''}` : `${mins} minute${mins !== 1 ? 's' : ''} ago`
      } else if (absDiffMs < 86_400_000) {
        const hrs = Math.round(absDiffMs / 3_600_000)
        relative = diffMs >= 0 ? `in ${hrs} hour${hrs !== 1 ? 's' : ''}` : `${hrs} hour${hrs !== 1 ? 's' : ''} ago`
      } else {
        const days = Math.round(absDiffMs / 86_400_000)
        relative = diffMs >= 0 ? `in ${days} day${days !== 1 ? 's' : ''}` : `${days} day${days !== 1 ? 's' : ''} ago`
      }
      setPreviewText(`${datePart} – ${timePart} (${relative})`)
    }
    update()
    const id = setInterval(update, 30_000)
    return () => clearInterval(id)
  }, [unix])

  const handleAdd = () => {
    if (unix) onInsert(unix)
  }

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 mb-2 z-[60] w-[290px] bg-card border border-border rounded-xl shadow-2xl p-4 space-y-3"
    >
      <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
        <Clock size={13} className="text-primary" />
        Insert Timestamp
      </h4>

      {/* Date */}
      <div className="space-y-1">
        <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Date</label>
        <DatePicker value={dateVal} onChange={setDateVal} />
      </div>

      {/* Time */}
      <div className="space-y-1">
        <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Time</label>
        <TimePicker value={timeVal} onChange={setTimeVal} />
      </div>

      {/* Preview */}
      {previewText && (
        <div className="text-xs text-muted-foreground bg-secondary/50 rounded-lg px-2.5 py-1.5 border border-border/50">
          <span className="text-[10px] text-muted-foreground/60 block mb-0.5">Preview</span>
          <span className="inline-block bg-primary/10 text-primary rounded-sm px-1 py-0.5 text-xs font-medium">
            {previewText}
          </span>
        </div>
      )}

      {/* Add button */}
      <button
        onClick={handleAdd}
        disabled={!unix}
        className="w-full h-8 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Add Timestamp
      </button>
    </div>
  )
}
