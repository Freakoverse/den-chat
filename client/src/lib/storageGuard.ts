/**
 * storageGuard — MUST be imported first (before any module that touches Web Storage).
 *
 * Firefox (and Safari, and Chrome to a lesser degree) throw a `SecurityError` the moment code
 * *accesses* `window.localStorage` / `window.sessionStorage` when the browser is blocking site data:
 * strict Enhanced Tracking Protection, a private window, "delete cookies and site data when Firefox
 * is closed", third-party/partitioned contexts, or cookies disabled entirely. Because the app reads
 * `localStorage` at module-eval (App.tsx) and during the very first render (ThemeProvider, the
 * outermost component), a single such throw takes down the whole tree — the user sees a blank white
 * page, most often on a fresh/first visit where those privacy defaults bite.
 *
 * This installs an in-memory fallback that satisfies the Storage interface so every existing
 * `localStorage.*` / `sessionStorage.*` call site degrades to a working-but-non-persistent store
 * instead of throwing. Persistence is lost (nothing survives a reload) but the app RENDERS.
 *
 * Everything here is wrapped so the guard itself can never throw.
 */

function makeMemoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear() { m.clear() },
    getItem(key: string) { return m.has(key) ? m.get(key)! : null },
    key(index: number) { return Array.from(m.keys())[index] ?? null },
    removeItem(key: string) { m.delete(key) },
    setItem(key: string, value: string) { m.set(key, String(value)) },
  } as Storage
}

/** True if `window[name]` can be accessed without throwing. A blocked store throws a SecurityError
 *  the moment it's touched (Firefox), so a plain read is enough to detect it — and, unlike a write
 *  probe, it doesn't emit a cross-tab `storage` event on every load in working browsers. */
function isUsable(name: 'localStorage' | 'sessionStorage'): boolean {
  try {
    const s = (window as unknown as Record<string, Storage>)[name]
    s.getItem('__den_storage_probe__')
    return true
  } catch {
    return false
  }
}

function guard(name: 'localStorage' | 'sessionStorage'): void {
  if (typeof window === 'undefined') return
  if (isUsable(name)) return
  try {
    Object.defineProperty(window, name, {
      value: makeMemoryStorage(),
      configurable: true,
      writable: false,
    })
    console.warn(`[storageGuard] ${name} is blocked by the browser — using a non-persistent in-memory fallback so the app still loads.`)
  } catch {
    // The property couldn't be redefined (rare). Nothing more we can do globally; call sites that
    // wrap their own access in try/catch still keep working.
  }
}

guard('localStorage')
guard('sessionStorage')
