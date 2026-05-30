/**
 * Global Push-to-Talk via native key polling (Tauri desktop only).
 *
 * Uses a Rust-side background thread that polls GetAsyncKeyState (Windows)
 * every 10ms and emits 'ptt-state' events on key state changes.
 * This does NOT consume the keypress — other apps still receive it.
 *
 * Falls back silently on non-Tauri (browser) builds.
 */

import { isTauri } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UnlistenFn = () => void
let _unlisten: UnlistenFn | null = null

/**
 * Start the native PTT key watcher and listen for state changes.
 * `onPress` fires when the key is pressed, `onRelease` when released.
 */
export async function registerGlobalPtt(
  keyCode: string,
  onPress: () => void,
  onRelease: () => void,
): Promise<void> {
  if (!isTauri()) return

  // Clean up any previous watcher
  await unregisterGlobalPtt()

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauri = (window as any).__TAURI__
    if (!tauri?.core?.invoke || !tauri?.event?.listen) {
      console.warn('[GlobalPTT] Tauri API not available')
      return
    }

    // Listen for ptt-state events from the Rust watcher thread
    _unlisten = await tauri.event.listen('ptt-state', (event: { payload: boolean }) => {
      if (event.payload) {
        onPress()
      } else {
        onRelease()
      }
    })

    // Start the Rust-side key polling thread
    await tauri.core.invoke('start_ptt_watch', { keyCode })
    console.log(`[GlobalPTT] Started native PTT watcher for key: ${keyCode}`)
  } catch (err) {
    console.warn('[GlobalPTT] Failed to start PTT watcher:', err)
  }
}

/**
 * Stop the native PTT key watcher.
 */
export async function unregisterGlobalPtt(): Promise<void> {
  // Unlisten from events
  if (_unlisten) {
    _unlisten()
    _unlisten = null
  }

  if (!isTauri()) return

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauri = (window as any).__TAURI__
    if (tauri?.core?.invoke) {
      await tauri.core.invoke('stop_ptt_watch')
      console.log('[GlobalPTT] Stopped native PTT watcher')
    }
  } catch (err) {
    console.warn('[GlobalPTT] Failed to stop PTT watcher:', err)
  }
}
