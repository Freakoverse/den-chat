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
  Copy, Scissors, ClipboardPaste, MousePointerClick, Link, Image, TextSelect, Bell, CheckCheck,
} from 'lucide-react'

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
      const isEditable = target.closest('input, textarea, [contenteditable="true"]') !== null

      // Check if right-clicked on a link
      const linkEl = target.closest('a[href]') as HTMLAnchorElement | null
      const linkHref = linkEl?.href

      // Check if right-clicked on an image
      const imgEl = target.closest('img') as HTMLImageElement | null
      const imgSrc = imgEl?.src

      // --- Text selection actions ---
      if (hasSelection) {
        if (isEditable) {
          items.push({
            label: 'Cut',
            icon: <Scissors size={14} />,
            action: () => { document.execCommand('cut'); close() },
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
            try {
              const text = await navigator.clipboard.readText()
              document.execCommand('insertText', false, text)
            } catch {
              document.execCommand('paste')
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
            const editableEl = target.closest('input, textarea, [contenteditable="true"]') as HTMLInputElement | HTMLTextAreaElement | null
            if (editableEl && 'select' in editableEl) {
              editableEl.select()
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
          label: 'Copy Image Address',
          icon: <Image size={14} />,
          action: () => {
            navigator.clipboard.writeText(imgSrc).catch(() => {})
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
    </ContextMenuContext.Provider>
  )
}
