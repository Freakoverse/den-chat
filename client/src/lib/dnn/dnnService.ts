/**
 * DNN (Decentralized Naming Network) — Node Service
 *
 * Manages DNN node discovery, health checking, failover, and resolution.
 * Adapted from the DENOS reference implementation.
 *
 * Node sources (tagged via `source` field):
 *   - 'default': Hardcoded fallback nodes (e.g. https://node.icannot.xyz)
 *   - 'user':    Manually added by the user in Settings > Network
 *   - 'discovered': Auto-discovered via peer query or Nostr kind:64600 events
 *
 * Known nodes = default + user. Discovered nodes = peer/nostr only.
 * Both are used for resolution, but never cross-listed in the UI.
 *
 * Failover: if a node fails 3 times within 3 hours, mark unhealthy and try alternatives.
 * Max 5 auto-discovered nodes are retained.
 */

import { fetchEvents } from '@/lib/nostr/relay-pool'

/* ─── Constants ─── */

const FALLBACK_NODES = ['https://node.icannot.xyz']
const STORAGE_KEY_NODES = 'den_dnn_nodes'
const STORAGE_KEY_USER_NODES = 'den_dnn_user_nodes' // legacy, read on init
const MAX_DISCOVERED = 5
const HEALTH_TIMEOUT = 5000
const RESOLVE_TIMEOUT = 8000
const FAIL_THRESHOLD = 3
const FAIL_WINDOW_MS = 3 * 60 * 60 * 1000 // 3 hours

/* ─── Types ─── */

export type DnnNodeSource = 'default' | 'user' | 'discovered'

export interface DnnNodeInfo {
  url: string
  healthy: boolean
  failCount: number
  lastFail: number
  lastChecked: number
  source: DnnNodeSource
}

export interface DnnResolveResult {
  npub: string
  name?: string
  block?: number
  position?: number
  encoded?: string
  name_event?: string
  connection_event?: string
  metadata_event?: string
  metadata?: {
    relays?: string[]
    description?: string
    updated_at?: number
    raw?: Record<string, unknown>
  }
}

/* ─── Queue for concurrent request limiting ─── */

type QueuedTask<T> = {
  fn: () => Promise<T>
  resolve: (value: T) => void
  reject: (err: any) => void
}

class ConcurrencyQueue {
  private running = 0
  private queue: QueuedTask<any>[] = []
  private maxConcurrent: number

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject })
      this.flush()
    })
  }

  private flush() {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!
      this.running++
      task.fn()
        .then(task.resolve)
        .catch(task.reject)
        .finally(() => {
          this.running--
          this.flush()
        })
    }
  }
}

/* ─── Service ─── */

class DnnService {
  private nodes: DnnNodeInfo[] = []
  private initialized = false
  private initPromise: Promise<void> | null = null
  private resolveQueue = new ConcurrencyQueue(3)

  /** Initialize the service — safe to call multiple times */
  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._init()
    await this.initPromise
  }

  private async _init(): Promise<void> {
    // Load persisted nodes from new unified storage
    try {
      const stored = localStorage.getItem(STORAGE_KEY_NODES)
      if (stored) this.nodes = JSON.parse(stored)
    } catch { /* ignore */ }

    // Migrate legacy user nodes (old key) if present
    try {
      const legacy = localStorage.getItem(STORAGE_KEY_USER_NODES)
      if (legacy) {
        const userUrls: string[] = JSON.parse(legacy)
        for (const url of userUrls) {
          if (!this.nodes.find(n => n.url === url)) {
            this.nodes.push({ url, healthy: false, failCount: 0, lastFail: 0, lastChecked: 0, source: 'user' })
          }
        }
        localStorage.removeItem(STORAGE_KEY_USER_NODES) // clean up legacy key
      }
    } catch { /* ignore */ }

    // Ensure fallback nodes exist with source='default'
    for (const url of FALLBACK_NODES) {
      const existing = this.nodes.find(n => n.url === url)
      if (existing) {
        existing.source = 'default'
      } else {
        this.nodes.push({ url, healthy: false, failCount: 0, lastFail: 0, lastChecked: 0, source: 'default' })
      }
    }

    // Health check all nodes
    await this.healthCheckAll()

    // Discover peers from the first online node
    await this.discoverPeers()

    this.initialized = true
    this.persist()
  }

  /* ── Node accessors by source ── */

  /** Get known nodes: default + user-added */
  getKnownNodes(): DnnNodeInfo[] {
    return this.nodes.filter(n => n.source === 'default' || n.source === 'user')
  }

  /** Get discovered nodes only (peer/nostr) */
  getDiscoveredNodes(): DnnNodeInfo[] {
    return this.nodes.filter(n => n.source === 'discovered').slice(0, MAX_DISCOVERED)
  }

  /** Get user-configured node URLs */
  getUserNodes(): string[] {
    return this.nodes.filter(n => n.source === 'user').map(n => n.url)
  }

  /** Get fallback (hardcoded) nodes */
  getFallbackNodes(): DnnNodeInfo[] {
    return this.nodes.filter(n => n.source === 'default')
  }

  /* ── Node management ── */

  /** Add a user-configured node */
  addUserNode(url: string): void {
    const normalized = url.replace(/\/+$/, '')
    if (!normalized) return
    // Must be a valid http/https URL
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) return
    try { new URL(normalized) } catch { return }
    // Don't duplicate any existing node regardless of source
    if (this.nodes.find(n => n.url === normalized)) return

    const node: DnnNodeInfo = { url: normalized, healthy: false, failCount: 0, lastFail: 0, lastChecked: 0, source: 'user' }
    this.nodes.push(node)
    this.persist()
    this.healthCheckNode(node)
  }

  /** Remove a user-configured node (only removes source='user') */
  removeUserNode(url: string): void {
    this.nodes = this.nodes.filter(n => !(n.url === url && n.source === 'user'))
    this.persist()
  }

  /* ── Health checking ── */

  /** Get first healthy node (prefer known, then discovered) */
  getOnlineNode(): DnnNodeInfo | null {
    const userHealthy = this.nodes.find(n => n.source === 'user' && n.healthy)
    if (userHealthy) return userHealthy
    const defaultHealthy = this.nodes.find(n => n.source === 'default' && n.healthy)
    if (defaultHealthy) return defaultHealthy
    return this.nodes.find(n => n.healthy) || null
  }

  /** Health check a single node */
  async healthCheckNode(node: DnnNodeInfo): Promise<boolean> {
    try {
      const response = await fetch(`${node.url}/dnn/status`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT),
      })
      node.lastChecked = Date.now()
      if (response.ok) {
        node.healthy = true
        node.failCount = 0
        return true
      }
      this.recordFail(node)
      return false
    } catch {
      this.recordFail(node)
      return false
    }
  }

  /** Health check all nodes */
  async healthCheckAll(): Promise<void> {
    await Promise.allSettled(this.nodes.map(n => this.healthCheckNode(n)))
    this.persist()
  }

  /** Record a failure for a node — mark unhealthy after threshold */
  private recordFail(node: DnnNodeInfo) {
    const now = Date.now()
    if (now - node.lastFail > FAIL_WINDOW_MS) {
      node.failCount = 0
    }
    node.failCount++
    node.lastFail = now
    if (node.failCount >= FAIL_THRESHOLD) {
      node.healthy = false
    }
  }

  /* ── Discovery ── */

  /** Discover peers from online nodes + kind:64600 events */
  async discoverPeers(): Promise<void> {
    const onlineNode = this.getOnlineNode()
    if (!onlineNode) return

    try {
      const response = await fetch(`${onlineNode.url}/dnn/peers`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT),
      })
      if (response.ok) {
        const peers = await response.json()
        if (Array.isArray(peers)) {
          for (const peerUrl of peers) {
            if (typeof peerUrl !== 'string') continue
            const normalized = peerUrl.replace(/\/+$/, '')
            if (this.nodes.find(n => n.url === normalized)) continue
            if (this.getDiscoveredNodes().length >= MAX_DISCOVERED) break
            this.nodes.push({ url: normalized, healthy: false, failCount: 0, lastFail: 0, lastChecked: 0, source: 'discovered' })
          }
        }
      }
    } catch (e) {
      console.warn('[DnnService] Failed to discover peers:', e)
    }

    // Also discover via kind:64600 events
    await this.discoverViaNostr()

    // Health check unchecked nodes
    const unchecked = this.nodes.filter(n => n.lastChecked === 0)
    if (unchecked.length > 0) {
      await Promise.allSettled(unchecked.map(n => this.healthCheckNode(n)))
    }

    this.persist()
  }

  /** Discover nodes from kind:64600 Nostr events */
  private async discoverViaNostr(): Promise<void> {
    try {
      const events = await fetchEvents({
        kinds: [64600],
        '#t': ['DNNNode'],
        limit: 20,
      })

      for (const event of events) {
        try {
          const content = JSON.parse(event.content)
          if (content.addresses && Array.isArray(content.addresses)) {
            for (const addr of content.addresses) {
              if (typeof addr !== 'string') continue
              if (!addr.startsWith('http://') && !addr.startsWith('https://')) continue
              const normalized = addr.replace(/\/+$/, '')
              if (this.nodes.find(n => n.url === normalized)) continue
              if (this.getDiscoveredNodes().length >= MAX_DISCOVERED) return
              this.nodes.push({ url: normalized, healthy: false, failCount: 0, lastFail: 0, lastChecked: 0, source: 'discovered' })
            }
          }
        } catch { /* ignore parse errors */ }
      }
    } catch (e) {
      console.warn('[DnnService] Failed kind:64600 discovery:', e)
    }
  }

  /* ── Persistence ── */

  /** Persist all nodes to localStorage */
  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY_NODES, JSON.stringify(this.nodes))
    } catch { /* ignore */ }
  }

  /* ── Resolution ── */

  /**
   * Resolve a DNN ID to its owner info.
   * Uses the concurrency queue (max 3 concurrent).
   */
  async resolve(dnnId: string): Promise<DnnResolveResult | null> {
    return this.resolveQueue.enqueue(() => this._resolve(dnnId))
  }

  private async _resolve(dnnId: string): Promise<DnnResolveResult | null> {
    await this.initialize()

    const normalized = dnnId.toLowerCase().trim()
    const healthyNodes = this.nodes.filter(n => n.healthy)
    const candidates = healthyNodes.length > 0 ? healthyNodes : [...this.nodes]

    for (const node of candidates) {
      try {
        const response = await fetch(`${node.url}/dnn/resolve/${normalized}`, {
          signal: AbortSignal.timeout(RESOLVE_TIMEOUT),
        })
        if (response.ok) {
          const data = await response.json()
          node.healthy = true
          node.failCount = 0
          return data as DnnResolveResult
        }
        if (response.status === 404) {
          return null
        }
        this.recordFail(node)
      } catch {
        this.recordFail(node)
      }
    }

    return null
  }

  /**
   * Verify that a DNN ID belongs to a specific npub.
   * Returns the full resolve result if verified, null otherwise.
   * The caller can extract relays from result.metadata.relays.
   */
  async verifyDnnId(dnnId: string, expectedNpub: string): Promise<DnnResolveResult | null> {
    if (!dnnId || !expectedNpub) return null
    const result = await this.resolve(dnnId)
    if (!result) return null
    return result.npub === expectedNpub ? result : null
  }
}

// Singleton
export const dnnService = new DnnService()
