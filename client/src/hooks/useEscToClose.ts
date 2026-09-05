/**
 * useEscToClose — opt-in "press Esc to close the topmost modal" (the configurable `closeModal`
 * keybind, default `Escape`).
 *
 * WHY opt-in: some modals have an X that does something DESTRUCTIVE — e.g. the "Adding Members…"
 * progress modal's X *cancels* the in-progress operation. Binding Esc to "click any X" would abort
 * such operations. So only modals whose close is a safe dismiss register via {@link useEscToClose};
 * an operation/progress modal instead calls {@link useEscBlock} so Esc is *absorbed* (does nothing)
 * while it's up — otherwise Esc would fall through and close the modal *underneath* it.
 *
 * Semantics: a global keydown fires the **topmost** registered entry's `close()`. It does NOT pop the
 * stack itself — the modal unmounts on real close, and the hook's cleanup removes its entry. So a
 * block entry (no-op close) simply swallows Esc without unregistering. Runs on the bubble phase and
 * respects `e.defaultPrevented`, so a component that wants to handle Esc first (a dropdown, an inline
 * editor) can `preventDefault()`/`stopPropagation()` and the modal stays open.
 */

import { useEffect, useId, useRef } from 'react'

type Entry = { id: string; close: () => void }
const stack: Entry[] = []

const KEYBINDS_KEY = 'den-chat-keybinds'

/** The configured close-modal key (`KeyboardEvent.code`), default `Escape`. Empty ⇒ disabled. */
function closeModalKey(): string {
  try {
    const kb = JSON.parse(localStorage.getItem(KEYBINDS_KEY) || '{}')
    return typeof kb.closeModal === 'string' ? kb.closeModal : 'Escape'
  } catch {
    return 'Escape'
  }
}

let listening = false
function ensureListener() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.repeat) return // an element already handled it, or key-repeat
    if (stack.length === 0) return
    const key = closeModalKey()
    if (!key || e.code !== key) return
    const top = stack[stack.length - 1]
    e.preventDefault()
    top.close() // topmost only; the modal unmounts → its entry is removed by cleanup
  })
}

/**
 * Register this modal so the close-modal keybind closes it (calls `onClose`) when it's the topmost
 * registered modal. `enabled` should track the modal's open state (or omit for always-open-while-mounted).
 */
export function useEscToClose(onClose: () => void, enabled = true): void {
  const id = useId()
  const cbRef = useRef(onClose)
  cbRef.current = onClose
  useEffect(() => {
    if (!enabled) return
    ensureListener()
    const entry: Entry = { id, close: () => cbRef.current() }
    stack.push(entry)
    return () => {
      const i = stack.findIndex((e) => e.id === id)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [enabled, id])
}

/**
 * Register a modal that must **absorb** the close-modal keybind without closing (progress/operation
 * modals). While `enabled`, Esc hits this (topmost) entry and does nothing, so it can't fall through
 * and close a dismissable modal underneath — and it can't trigger this modal's own (often destructive)
 * cancel. The user still closes it via its explicit button.
 */
export function useEscBlock(enabled = true): void {
  useEscToClose(noop, enabled)
}

function noop() {}
