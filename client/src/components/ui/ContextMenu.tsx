/**
 * ContextMenu — Custom styled right-click context menu that replaces the native browser menu.
 *
 * Usage: Wrap your app root with <ContextMenuProvider> and every right-click
 * will show the custom menu instead of the native one.
 *
 * The menu auto-detects context:
 * - Text selection → Cut (if editable), Copy, Select All
 * - Editable field → Paste, Select All
 * - Links → Open Link, Copy Link
 * - Images → Copy Image Address
 * - General → Select All (if applicable)
 */
import { useState, useEffect, useCallback, useRef, createContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Copy, Scissors, ClipboardPaste, MousePointerClick, Link, Image, TextSelect, Bell, CheckCheck, Download, Film, Volume2,
} from 'lucide-react'

/** Trigger a browser "Save As" dialog for the given URL */
function downloadMediaUrl(url: string, fallbackName?: string) {
  const filename = fallbackName || url.split('/').pop()?.split('?')[0] || 'download'
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''

  // MIME type map for the save dialog file-type filter
  const mimeMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4',
  }

  fetch(url)
    .then((r) => r.blob())
    .then(async (blob) => {
      // Try the File System Access API for a proper "Save As" dialog
      if ('showSaveFilePicker' in window) {
        try {
          const accept: Record<string, string[]> = {}
          const mime = mimeMap[ext] || blob.type || 'application/octet-stream'
          accept[mime] = ext ? [`.${ext}`] : []
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'Media file', accept }],
          })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
          return
        } catch (err: any) {
          // User cancelled the dialog — just bail silently
          if (err?.name === 'AbortError') return
          // Otherwise fall through to legacy approach
        }
      }
      // Legacy fallback — auto-downloads to default location
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      document.body.appendChild(a)
      a.click()
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 100)
    })
    .catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer')
    })
}

interface MenuItem {
  label: string
  icon: ReactNode
  action: () => void
  disabled?: boolean
  separator?: false
}

interface MenuSeparator {
  separator: true
}

type MenuEntry = MenuItem | MenuSeparator

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  items: MenuEntry[]
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const ContextMenuContext = createContext<null>(null)

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, items: [] })
  const menuRef = useRef<HTMLDivElement>(null)
  const animatingOut = useRef(false)
  const targetEditableRef = useRef<HTMLElement | null>(null)
  const [pasteHint, setPasteHint] = useState(false)
  const pasteHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showPasteHint = useCallback(() => {
    if (pasteHintTimer.current) clearTimeout(pasteHintTimer.current)
    setPasteHint(true)
    pasteHintTimer.current = setTimeout(() => setPasteHint(false), 3000)
  }, [])

  const close = useCallback(() => {
    if (animatingOut.current) return
    animatingOut.current = true
    const el = menuRef.current
    if (el) {
      el.classList.add('context-menu-out')
      const onEnd = () => {
        el.removeEventListener('animationend', onEnd)
        setMenu((prev) => ({ ...prev, visible: false }))
        animatingOut.current = false
      }
      el.addEventListener('animationend', onEnd)
      // Fallback if animation doesn't fire
      setTimeout(onEnd, 200)
    } else {
      setMenu((prev) => ({ ...prev, visible: false }))
      animatingOut.current = false
    }
  }, [])

  // Close on click outside, escape, scroll
  useEffect(() => {
    if (!menu.visible) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close()
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const handleScroll = () => close()

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [menu.visible, close])

  // Global right-click handler
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // Don't intercept in dev tools or if modifier keys held
      if (e.ctrlKey && e.shiftKey) return // Allow Ctrl+Shift+Right-click for native menu

      const target = e.target as HTMLElement
      if (!target) return

      // Build menu items based on context
      const items: MenuEntry[] = []
      const selection = window.getSelection()
      const hasSelection = selection && selection.toString().trim().length > 0
      const editableEl = target.closest('input, textarea, [contenteditable="true"]') as HTMLElement | null
      const isEditable = editableEl !== null
      // Store the editable element so paste/cut/selectAll can re-focus it
      targetEditableRef.current = editableEl

      // Check if right-clicked on a link
      const linkEl = target.closest('a[href]') as HTMLAnchorElement | null
      const linkHref = linkEl?.href

      // Check if right-clicked on an image
      const imgEl = target.closest('img') as HTMLImageElement | null
      const imgSrc = imgEl?.src

      // Check if right-clicked on a video
      const videoEl = target.closest('video') as HTMLVideoElement | null
      const videoSrc = videoEl ? (videoEl.currentSrc || videoEl.src || videoEl.querySelector('source')?.src) : null

      // Check if right-clicked on audio
      const audioEl = target.closest('audio') as HTMLAudioElement | null
      const audioSrc = audioEl ? (audioEl.currentSrc || audioEl.src || audioEl.querySelector('source')?.src) : null

      // --- Text selection actions ---
      if (hasSelection) {
        if (isEditable) {
          items.push({
            label: 'Cut',
            icon: <Scissors size={14} />,
            action: () => { targetEditableRef.current?.focus(); document.execCommand('cut'); close() },
          })
        }
        items.push({
          label: 'Copy',
          icon: <Copy size={14} />,
          action: () => {
            const text = selection!.toString()
            navigator.clipboard.writeText(text).catch(() => document.execCommand('copy'))
            close()
          },
        })
      }

      // --- Paste (for editable fields) ---
      if (isEditable) {
        items.push({
          label: 'Paste',
          icon: <ClipboardPaste size={14} />,
          action: async () => {
            // Re-focus the original field so execCommand targets it, not the menu
            targetEditableRef.current?.focus()
            try {
              const text = await navigator.clipboard.readText()
              document.execCommand('insertText', false, text)
            } catch {
              // Clipboard blocked (Firefox) — show hint to use Ctrl+V
              showPasteHint()
            }
            close()
          },
        })
      }

      // --- Select All ---
      if (isEditable) {
        if (items.length > 0) items.push({ separator: true })
        items.push({
          label: 'Select All',
          icon: <TextSelect size={14} />,
          action: () => {
            const el = targetEditableRef.current as HTMLInputElement | HTMLTextAreaElement | null
            if (el && 'select' in el) {
              el.focus()
              el.select()
            } else {
              document.execCommand('selectAll')
            }
            close()
          },
        })
      }

      // --- Link actions ---
      if (linkHref) {
        if (items.length > 0) items.push({ separator: true })
        items.push({
          label: 'Open Link',
          icon: <MousePointerClick size={14} />,
          action: () => {
            window.open(linkHref, '_blank', 'noopener,noreferrer')
            close()
          },
        })
        items.push({
          label: 'Copy Link',
          icon: <Link size={14} />,
          action: () => {
            navigator.clipboard.writeText(linkHref).catch(() => {})
            close()
          },
        })
      }

      // --- Image actions ---
      if (imgSrc) {
        if (items.length > 0) items.push({ separator: true })
        items.push({
          label: 'Download Image',
          icon: <Download size={14} />,
          action: () => {
            downloadMediaUrl(imgSrc)
            close()
          },
        })
        items.push({
          label: 'Copy Image Address',
          icon: <Image size={14} />,
          action: () => {
            navigator.clipboard.writeText(imgSrc).catch(() => {})
            close()
          },
        })
      }

      // --- Video actions ---
      if (videoSrc) {
        if (items.length > 0) items.push({ separator: true })
        items.push({
          label: 'Download Video',
          icon: <Download size={14} />,
          action: () => {
            downloadMediaUrl(videoSrc)
            close()
          },
        })
        items.push({
          label: 'Copy Video Address',
          icon: <Film size={14} />,
          action: () => {
            navigator.clipboard.writeText(videoSrc).catch(() => {})
            close()
          },
        })
      }

      // --- Audio actions ---
      if (audioSrc) {
        if (items.length > 0) items.push({ separator: true })
        items.push({
          label: 'Download Audio',
          icon: <Download size={14} />,
          action: () => {
            downloadMediaUrl(audioSrc)
            close()
          },
        })
        items.push({
          label: 'Copy Audio Address',
          icon: <Volume2 size={14} />,
          action: () => {
            navigator.clipboard.writeText(audioSrc).catch(() => {})
            close()
          },
        })
      }

      // --- Hub icon actions ---
      const hubEl = target.closest('[data-hub-dtag]') as HTMLElement | null
      const hubDTag = hubEl?.dataset.hubDtag
      if (hubDTag) {
        if (items.length > 0) items.push({ separator: true })
        items.push({
          label: 'Mark Hub as Read',
          icon: <CheckCheck size={14} />,
          action: async () => {
            const { useNotificationStore } = await import('@/stores/notificationStore')
            useNotificationStore.getState().markHubRead(hubDTag)
            close()
          },
        })
        items.push({
          label: 'Notification Settings',
          icon: <Bell size={14} />,
          action: async () => {
            const { useNavigationStore } = await import('@/stores/navigationStore')
            const { useHubStore } = await import('@/stores/hubStore')
            useNavigationStore.getState().setActivePage('hubs')
            useHubStore.getState().setActiveHub(hubDTag)
            useNavigationStore.getState().setPendingHubNotifDTag(hubDTag)
            close()
          },
        })
      }

      // --- Folder actions (right-click on a folder icon) ---
      const folderEl = target.closest('[data-folder-id]') as HTMLElement | null
      const folderId = folderEl?.dataset.folderId
      if (folderId) {
        if (items.length > 0) items.push({ separator: true })
        items.push({
          label: 'Mark Folder as Read',
          icon: <CheckCheck size={14} />,
          action: async () => {
            const { useHubStore } = await import('@/stores/hubStore')
            const { useNotificationStore } = await import('@/stores/notificationStore')
            const notif = useNotificationStore.getState()
            for (const entry of useHubStore.getState().hubEntries) {
              if (entry.folderId === folderId) notif.markHubRead(entry.dTag)
            }
            close()
          },
        })
      }

      // --- Channel actions (right-click on a channel in the channel list) ---
      const channelEl = target.closest('[data-channel-id]') as HTMLElement | null
      const channelId = channelEl?.dataset.channelId
      const channelHub = channelEl?.dataset.channelHub
      if (channelId && channelHub) {
        if (items.length > 0) items.push({ separator: true })
        items.push({
          label: 'Mark Channel as Read',
          icon: <CheckCheck size={14} />,
          action: async () => {
            const { useNotificationStore } = await import('@/stores/notificationStore')
            useNotificationStore.getState().markChannelRead(channelHub, channelId)
            close()
          },
        })
      }

      // If no actions, show a minimal "no actions" or fallback to native
      if (items.length === 0) {
        // For non-interactive areas, just show Select All if there's text content
        if (target.closest('[data-context-menu="false"]')) return // opt-out
        items.push({
          label: 'Select All',
          icon: <TextSelect size={14} />,
          action: () => {
            // Select all text in the nearest scrollable container or body
            const range = document.createRange()
            const container = target.closest('.overflow-y-auto, .overflow-y-scroll') || document.body
            range.selectNodeContents(container)
            const sel = window.getSelection()
            sel?.removeAllRanges()
            sel?.addRange(range)
            close()
          },
        })
      }

      e.preventDefault()

      // Calculate position, clamping to viewport
      const menuWidth = 200
      const menuHeight = items.length * 36 + 12 // rough estimate
      let x = e.clientX
      let y = e.clientY
      if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8
      if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8
      if (x < 4) x = 4
      if (y < 4) y = 4

      setMenu({ visible: true, x, y, items })
    }

    document.addEventListener('contextmenu', handleContextMenu)
    return () => document.removeEventListener('contextmenu', handleContextMenu)
  }, [close])

  return (
    <ContextMenuContext.Provider value={null}>
      {children}
      {menu.visible &&
        createPortal(
          <div
            ref={menuRef}
            className="context-menu-root"
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {menu.items.map((item, i) => {
              if (item.separator) {
                return <div key={`sep-${i}`} className="context-menu-separator" />
              }
              return (
                <button
                  key={i}
                  className="context-menu-item"
                  onClick={(e) => {
                    e.stopPropagation()
                    item.action()
                  }}
                  disabled={item.disabled}
                >
                  <span className="context-menu-icon">{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>,
          document.body
        )}
      {/* Paste hint — shown when browser blocks clipboard access (Firefox) */}
      {pasteHint && createPortal(
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-lg bg-popover border border-border shadow-lg flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <ClipboardPaste size={14} className="text-amber-400 shrink-0" />
          <span className="text-xs text-foreground/80">Your browser blocked paste — use <kbd className="px-1.5 py-0.5 rounded bg-secondary text-foreground text-[11px] font-mono mx-0.5">Ctrl+V</kbd> instead</span>
        </div>,
        document.body
      )}
    </ContextMenuContext.Provider>
  )
}
