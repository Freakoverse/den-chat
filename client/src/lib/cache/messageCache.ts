/**
 * messageCache — IndexedDB persistence layer for chat messages
 *
 * Stores raw message events in IndexedDB, indexed by hubDTag + channelId.
 * Provides:
 *  - Write-through caching (new messages saved immediately)
 *  - Bulk load on startup (all messages for all hubs)
 *  - Per-hub size limit: 10MB max, prunes oldest when exceeded
 *  - Global size limit: 300MB max, prunes oldest from largest hubs
 */

import type { ChatMessage } from '@/stores/messageStore'

const DB_NAME = 'den-chat-messages'
const DB_VERSION = 3
const STORE_NAME = 'messages'

/** 10 MB per hub limit (approximate, based on JSON byte size) */
const MAX_HUB_BYTES = 10 * 1024 * 1024
/** 300 MB global limit across all hubs */
const MAX_GLOBAL_BYTES = 300 * 1024 * 1024

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      const db = request.result
      const oldVersion = event.oldVersion

      if (oldVersion < 1) {
        // Fresh install — create object store with all indexes
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('by_hub', 'hubDTag', { unique: false })
        store.createIndex('by_hub_channel', ['hubDTag', 'channelId'], { unique: false })
        store.createIndex('by_created', 'createdAt', { unique: false })
        store.createIndex('by_dtag_pubkey', ['dTag', 'pubkey'], { unique: false })
      }

      if (oldVersion >= 1 && oldVersion < 2) {
        // Migration: add dTag+pubkey index for cache dedup on write.
        // Also clear all existing data — old caches may contain stale pre-edit/pre-delete
        // versions that would never get cleaned up (no new write targets them).
        // The cache repopulates from relays on next subscription.
        const tx = (event.target as IDBOpenDBRequest).transaction!
        const store = tx.objectStore(STORE_NAME)
        store.clear()
        if (!store.indexNames.contains('by_dtag_pubkey')) {
          store.createIndex('by_dtag_pubkey', ['dTag', 'pubkey'], { unique: false })
        }
      }

      if (oldVersion >= 2 && oldVersion < 3) {
        // Migration v2→v3: clear stale cache data for users who upgraded to v2
        // before the cache-wipe was added to the v1→v2 migration.
        const tx = (event.target as IDBOpenDBRequest).transaction!
        tx.objectStore(STORE_NAME).clear()
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  return dbPromise
}

/**
 * Save a single message to IndexedDB (write-through).
 * Uses put() to handle duplicates gracefully.
 */
export async function cacheMessage(msg: ChatMessage): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(msg)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    console.warn('[MessageCache] Failed to cache message:', err)
  }
}

/**
 * Save a single message to IndexedDB with addressable-event deduplication.
 * Looks up existing entries with the same dTag + pubkey and removes older versions,
 * preventing stale edited/deleted messages from accumulating in the cache.
 */
export async function cacheMessageWithDedup(msg: ChatMessage): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('by_dtag_pubkey')
    const range = IDBKeyRange.only([msg.dTag, msg.pubkey])
    const request = index.getAll(range)

    request.onsuccess = () => {
      const existing = request.result as ChatMessage[] | undefined
      if (existing) {
        const msgTs = msg.eventCreatedAt || msg.createdAt
        for (const old of existing) {
          if (old.id !== msg.id) {
            const oldTs = old.eventCreatedAt || old.createdAt
            if (msgTs >= oldTs) {
              // Incoming is newer or same — delete stale entry
              store.delete(old.id)
            } else {
              // Incoming is older — skip writing it entirely
              return
            }
          }
        }
      }
      store.put(msg)
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    console.warn('[MessageCache] Failed to cache message with dedup:', err)
  }
}

/**
 * Save multiple messages to IndexedDB with addressable-event deduplication.
 * Deduplicates within the batch first (keeping newest per dTag+pubkey),
 * then cleans up any stale entries already in the cache.
 */
export async function cacheMessagesWithDedup(msgs: ChatMessage[]): Promise<void> {
  if (msgs.length === 0) return

  // Pre-deduplicate the batch: keep only the newest per dTag+pubkey
  const byKey = new Map<string, ChatMessage>()
  for (const msg of msgs) {
    const key = `${msg.dTag}:${msg.pubkey}`
    const existing = byKey.get(key)
    if (existing) {
      const msgTs = msg.eventCreatedAt || msg.createdAt
      const existingTs = existing.eventCreatedAt || existing.createdAt
      if (msgTs > existingTs) {
        byKey.set(key, msg)
      }
    } else {
      byKey.set(key, msg)
    }
  }
  const deduped = Array.from(byKey.values())

  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('by_dtag_pubkey')

    for (const msg of deduped) {
      // Look up existing entries with same dTag + pubkey and clean up stale ones
      const range = IDBKeyRange.only([msg.dTag, msg.pubkey])
      const request = index.getAll(range)
      request.onsuccess = () => {
        const existing = request.result as ChatMessage[] | undefined
        if (existing) {
          const msgTs = msg.eventCreatedAt || msg.createdAt
          for (const old of existing) {
            if (old.id !== msg.id) {
              const oldTs = old.eventCreatedAt || old.createdAt
              if (msgTs >= oldTs) {
                store.delete(old.id)
              }
            }
          }
        }
        store.put(msg)
      }
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    console.warn('[MessageCache] Failed to cache messages with dedup:', err)
  }
}

/**
 * Delete a cached message from IndexedDB by event ID.
 * Used when a message is request-deleted to remove the stale original entry.
 */
export async function deleteCachedMessage(eventId: string): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(eventId)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    console.warn('[MessageCache] Failed to delete cached message:', err)
  }
}

/**
 * Atomically replace a cached message: delete old entry + write new entry in a
 * single IDB transaction. Avoids the serial readwrite queue stall that happens
 * when delete and put are separate transactions competing with subscription writes.
 */
export async function replaceCachedMessage(oldEventId: string | undefined, newMsg: ChatMessage): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    if (oldEventId && oldEventId !== newMsg.id) {
      store.delete(oldEventId)
    }
    store.put(newMsg)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    console.warn('[MessageCache] Failed to replace cached message:', err)
  }
}

/**
 * Save multiple messages to IndexedDB in a single transaction.
 */
export async function cacheMessages(msgs: ChatMessage[]): Promise<void> {
  if (msgs.length === 0) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const msg of msgs) {
      store.put(msg)
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    console.warn('[MessageCache] Failed to cache messages:', err)
  }
}

/**
 * Load all cached messages from IndexedDB.
 * Returns all messages (caller filters by hub/channel as needed).
 */
export async function loadAllCachedMessages(): Promise<ChatMessage[]> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()

    const all: ChatMessage[] = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })

    // Deduplicate addressable events: same dTag + pubkey = keep newest eventCreatedAt.
    // Edits create new event IDs for the same dTag, leaving stale entries in cache.
    const byKey = new Map<string, ChatMessage>()
    const staleIds: string[] = []
    for (const msg of all) {
      const key = `${msg.dTag}:${msg.pubkey}`
      const existing = byKey.get(key)
      if (existing) {
        const msgTs = msg.eventCreatedAt || msg.createdAt
        const existingTs = existing.eventCreatedAt || existing.createdAt
        console.log(`[MessageCache] Dup found: dTag=${msg.dTag.slice(0, 12)}\u2026 existing(id=${existing.id.slice(0, 12)}\u2026 ts=${existingTs}) vs incoming(id=${msg.id.slice(0, 12)}\u2026 ts=${msgTs}) → keeping ${msgTs > existingTs ? 'incoming' : 'existing'}`)
        if (msgTs > existingTs) {
          staleIds.push(existing.id)
          byKey.set(key, msg)
        } else {
          staleIds.push(msg.id)
        }
      } else {
        byKey.set(key, msg)
      }
    }

    console.log(`[MessageCache] Loaded ${all.length} raw entries → ${byKey.size} after dedup (${staleIds.length} stale)`)

    // Clean up stale entries in the background
    if (staleIds.length > 0) {
      console.log(`[MessageCache] Pruning ${staleIds.length} stale duplicate(s) from cache`)
      openDB().then(db2 => {
        const tx2 = db2.transaction(STORE_NAME, 'readwrite')
        const store2 = tx2.objectStore(STORE_NAME)
        for (const id of staleIds) store2.delete(id)
      }).catch(() => {})
    }

    return Array.from(byKey.values())
  } catch (err) {
    console.warn('[MessageCache] Failed to load messages:', err)
    return []
  }
}



/**
 * Enforce per-hub size limit. If a hub's messages exceed MAX_HUB_BYTES,
 * delete oldest messages until within budget.
 */
export async function pruneHubBySize(hubDTag: string): Promise<number> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('by_hub')

    // Get all messages for this hub
    const range = IDBKeyRange.only(hubDTag)
    const request = index.getAll(range)

    const messages: ChatMessage[] = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })

    // Estimate total size (rough: JSON byte length)
    let totalBytes = 0
    for (const msg of messages) {
      totalBytes += estimateMessageSize(msg)
    }

    if (totalBytes <= MAX_HUB_BYTES) return 0

    // Sort oldest first, delete until under limit
    const sorted = messages.sort((a, b) => a.createdAt - b.createdAt)
    let pruned = 0

    const tx2 = db.transaction(STORE_NAME, 'readwrite')
    const store2 = tx2.objectStore(STORE_NAME)

    for (const msg of sorted) {
      if (totalBytes <= MAX_HUB_BYTES) break
      store2.delete(msg.id)
      totalBytes -= estimateMessageSize(msg)
      pruned++
    }

    await new Promise<void>((resolve, reject) => {
      tx2.oncomplete = () => resolve()
      tx2.onerror = () => reject(tx2.error)
    })

    return pruned
  } catch (err) {
    console.warn('[MessageCache] Failed to prune hub by size:', err)
    return 0
  }
}

/** Rough size estimate for a message in bytes */
function estimateMessageSize(msg: ChatMessage): number {
  return (
    msg.id.length +
    msg.hubDTag.length +
    msg.channelId.length +
    msg.pubkey.length +
    msg.content.length +
    (msg.replyTo?.length || 0) +
    50 // overhead for numbers + keys
  )
}

/**
 * Enforce global size limit across all hubs.
 * If total IndexedDB message size exceeds MAX_GLOBAL_BYTES, prune oldest
 * messages from the largest hubs until within budget.
 */
export async function pruneGlobalBySize(): Promise<number> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()

    const all: ChatMessage[] = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })

    let totalBytes = 0
    for (const msg of all) {
      totalBytes += estimateMessageSize(msg)
    }

    if (totalBytes <= MAX_GLOBAL_BYTES) return 0

    // Sort all messages oldest first, delete until under global limit
    const sorted = all.sort((a, b) => a.createdAt - b.createdAt)
    let pruned = 0

    const tx2 = db.transaction(STORE_NAME, 'readwrite')
    const store2 = tx2.objectStore(STORE_NAME)

    for (const msg of sorted) {
      if (totalBytes <= MAX_GLOBAL_BYTES) break
      store2.delete(msg.id)
      totalBytes -= estimateMessageSize(msg)
      pruned++
    }

    await new Promise<void>((resolve, reject) => {
      tx2.oncomplete = () => resolve()
      tx2.onerror = () => reject(tx2.error)
    })

    return pruned
  } catch (err) {
    console.warn('[MessageCache] Failed to prune globally by size:', err)
    return 0
  }
}

/**
 * Run all pruning: per-hub size limits, then global size limit.
 */
export async function pruneAll(hubDTags: string[]): Promise<void> {
  // Per-hub pruning
  for (const dTag of hubDTags) {
    const sizePruned = await pruneHubBySize(dTag)
    if (sizePruned > 0) {
      console.log(`[MessageCache] Pruned ${sizePruned} messages from hub ${dTag.slice(0, 8)}... (per-hub size limit)`)
    }
  }
  // Global pruning
  const globalPruned = await pruneGlobalBySize()
  if (globalPruned > 0) {
    console.log(`[MessageCache] Pruned ${globalPruned} messages globally (global size limit)`)
  }
}
