/**
 * hubEventCache — local IndexedDB copy of hub definition events (kind 36942).
 *
 * Purpose: keep a durable local copy of hubs the user has seen, so the hub's raw
 * event can still be exported (and manually rebroadcast) even if it later gets
 * wiped from every relay. Newest-wins by created_at, so a deletion tombstone
 * (a newer event with ['deleted','true']) overwrites the live copy rather than
 * the other way around.
 *
 * We NEVER auto-rebroadcast from this cache — it only backs the "Export .json"
 * action and the raw-event view's offline fallback. Rebroadcasting is always a
 * deliberate, warned, file-based user action (Settings → My Hubs).
 */

import type { Event } from 'nostr-tools'

const DB_NAME = 'den-hub-events'
const DB_VERSION = 1
const STORE = 'events'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'addr' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

const addrOf = (kind: number, pubkey: string, dTag: string) => `${kind}:${pubkey}:${dTag}`

interface StoredHubEvent { addr: string; event: Event; cachedAt: number }

/** Cache a hub event locally (newest-wins). Fire-and-forget; never throws. */
export async function putHubEvent(event: Event): Promise<void> {
  try {
    const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
    if (dTag === undefined) return
    const addr = addrOf(event.kind, event.pubkey, dTag)
    const db = await openDb()

    const existing = await new Promise<StoredHubEvent | undefined>((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).get(addr)
      r.onsuccess = () => res(r.result as StoredHubEvent | undefined)
      r.onerror = () => res(undefined)
    })
    // Newest-wins — keep the most recent version (a deletion tombstone included).
    if (existing?.event && existing.event.created_at >= event.created_at) return

    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ addr, event, cachedAt: Date.now() } satisfies StoredHubEvent)
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
  } catch { /* IndexedDB unavailable (private mode, etc.) — ignore */ }
}

/**
 * All cached hub events. Used at load time to recover the newest version of a hub
 * when relays only return a stale copy (or the fresh copy lives on an unreachable
 * relay) — matched by d tag, since the author pubkey isn't known up front. This is
 * a read for DISPLAY only; it never triggers a rebroadcast.
 */
export async function getAllHubEvents(): Promise<Event[]> {
  try {
    const db = await openDb()
    return await new Promise<Event[]>((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).getAll()
      r.onsuccess = () => res(((r.result as StoredHubEvent[] | undefined) ?? []).map((s) => s.event))
      r.onerror = () => res([])
    })
  } catch { return [] }
}

/** Read a cached hub event, or null if not cached / unavailable. */
export async function getHubEvent(kind: number, pubkey: string, dTag: string): Promise<Event | null> {
  try {
    const db = await openDb()
    return await new Promise<Event | null>((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).get(addrOf(kind, pubkey, dTag))
      r.onsuccess = () => res((r.result as StoredHubEvent | undefined)?.event ?? null)
      r.onerror = () => res(null)
    })
  } catch { return null }
}
