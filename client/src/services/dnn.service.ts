/**
 * DNN Service — Resolve DNN IDs to Nostr pubkeys
 * Ported from Jumble's dnn.service.ts
 */

import { LRUCache } from 'lru-cache'
import { nip19 } from 'nostr-tools'

export interface DNNResolution {
  name: string
  dnn_id: string
  encoded?: string
  npub: string
  verified: boolean
  block: number
  position: number
  relays?: string[]
}

const DNN_NODE_URL = 'https://node.icannot.xyz'

class DNNService {
  private static instance: DNNService
  private cache = new LRUCache<string, DNNResolution>({ max: 500, ttl: 5 * 60 * 1000 })
  private nullCache = new Set<string>()
  private requests: number[] = []

  static getInstance(): DNNService {
    if (!DNNService.instance) {
      DNNService.instance = new DNNService()
    }
    return DNNService.instance
  }

  private canMakeRequest(): boolean {
    const now = Date.now()
    this.requests = this.requests.filter((t) => now - t < 60000)
    if (this.requests.length >= 100) return false
    this.requests.push(now)
    return true
  }

  async resolve(dnnId: string): Promise<DNNResolution | null> {
    if (!dnnId) return null

    const cached = this.cache.get(dnnId)
    if (cached !== undefined) return cached
    if (this.nullCache.has(dnnId)) return null
    if (!this.canMakeRequest()) return null

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(`${DNN_NODE_URL}/dnn/resolve/${dnnId}`, {
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        this.nullCache.add(dnnId)
        return null
      }

      const data = await response.json()
      if (!data.npub) {
        this.nullCache.add(dnnId)
        return null
      }

      // Extract relays from metadata
      let relays: string[] = []
      if (data.metadata?.relays && Array.isArray(data.metadata.relays)) {
        relays = data.metadata.relays.filter((r: string) => r.startsWith('wss://') || r.startsWith('ws://'))
      }

      const resolution: DNNResolution = {
        name: data.name || dnnId,
        dnn_id: dnnId,
        encoded: data.encoded || dnnId,
        npub: data.npub,
        verified: true,
        block: data.dnn_block || 0,
        position: data.position || 0,
        relays,
      }

      this.cache.set(dnnId, resolution)
      return resolution
    } catch (error) {
      this.nullCache.add(dnnId)
      return null
    }
  }

  npubToHex(npub: string): string {
    const { data } = nip19.decode(npub)
    return data as string
  }
}

const dnnService = DNNService.getInstance()
export default dnnService
export { DNNService }
