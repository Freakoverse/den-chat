/**
 * messageCache — IndexedDB persistence layer for chat messages
 *
 * Stores raw message events in IndexedDB, indexed by hubDTag + channelId.
 * Provides:
 *  - Write-through caching (new messages saved immediately)
 *  - Bulk load on startup (all messages for all hubs)
 *  - Per-hub size limit: 100MB max, prunes oldest when exceeded
 */

import type { ChatMessage } from '@/stores/messageStore'

const DB_NAME = 'den-chat-messages'
const DB_VERSION = 1
const STORE_NAME = 'messages'

/** 100 MB per hub limit (approximate, based on JSON byte size) */
const MAX_HUB_BYTES = 100 * 1024 * 1024

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('by_hub', 'hubDTag', { unique: false })
        store.createIndex('by_hub_channel', ['hubDTag', 'channelId'], { unique: false })
        store.createIndex('by_created', 'createdAt', { unique: false })
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

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
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
 * Run all pruning: size-based for each hub.
 */
export async function pruneAll(hubDTags: string[]): Promise<void> {
  for (const dTag of hubDTags) {
    const sizePruned = await pruneHubBySize(dTag)
    if (sizePruned > 0) {
      console.log(`[MessageCache] Pruned ${sizePruned} messages from hub ${dTag.slice(0, 8)}... (size limit)`)
    }
  }
}
