/**
 * pow.ts — Main-thread PoW utilities
 *
 * - mineEvent(): spawns web worker to mine PoW, returns mined event
 * - benchmarkHashRate(): measures device hash rate for time estimates
 * - estimateSolveTime(): calculates expected solve time for a difficulty
 * - countLeadingZeroBits(): utility for validation
 */

import type { UnsignedEvent } from 'nostr-tools'

let cachedHashRate: number | null = null

/**
 * Count leading zero bits of a hex string.
 */
export function countLeadingZeroBits(hex: string): number {
  let count = 0
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16)
    if (nibble === 0) {
      count += 4
    } else {
      count += Math.clz32(nibble) - 28
      break
    }
  }
  return count
}

/**
 * Estimate solve time in seconds for a given difficulty,
 * based on the device's measured hash rate.
 */
export function estimateSolveTime(difficulty: number, hashRate?: number): number {
  const rate = hashRate ?? cachedHashRate ?? 50000 // Default fallback: 50k hashes/sec
  if (difficulty <= 0 || rate <= 0) return 0
  // Expected attempts = 2^difficulty
  const expectedAttempts = Math.pow(2, difficulty)
  return expectedAttempts / rate
}

/**
 * Benchmark device hash rate using the PoW worker.
 * Caches the result for future use.
 */
export function benchmarkHashRate(): Promise<number> {
  return new Promise((resolve) => {
    if (cachedHashRate !== null) {
      resolve(cachedHashRate)
      return
    }

    const worker = new Worker(
      new URL('./pow-worker.ts', import.meta.url),
      { type: 'module' }
    )

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'benchmarked') {
        cachedHashRate = e.data.hashRate
        worker.terminate()
        resolve(e.data.hashRate)
      }
    }

    worker.onerror = () => {
      worker.terminate()
      cachedHashRate = 50000 // Fallback
      resolve(50000)
    }

    worker.postMessage({ type: 'benchmark' })
  })
}

/**
 * Get the cached hash rate, or null if not yet benchmarked.
 */
export function getCachedHashRate(): number | null {
  return cachedHashRate
}

/**
 * Mine PoW on an unsigned event using a Web Worker.
 * Returns the event with a nonce tag that satisfies the difficulty.
 *
 * MUST be called BEFORE signing, because the nonce tag changes the event ID.
 */
export function mineEvent(
  event: UnsignedEvent,
  difficulty: number,
  pubkey: string
): Promise<UnsignedEvent> {
  return new Promise((resolve, reject) => {
    if (difficulty <= 0) {
      resolve(event)
      return
    }

    const worker = new Worker(
      new URL('./pow-worker.ts', import.meta.url),
      { type: 'module' }
    )

    const timeout = setTimeout(() => {
      worker.terminate()
      reject(new Error(`PoW mining timed out after 120 seconds (difficulty ${difficulty})`))
    }, 120_000)

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'mined') {
        clearTimeout(timeout)
        worker.terminate()
        // Return as UnsignedEvent (without the pubkey set by worker)
        const mined = e.data.event
        resolve({
          kind: mined.kind,
          content: mined.content,
          tags: mined.tags,
          created_at: mined.created_at,
          pubkey: '', // Will be set by signWithSigner
        })
      }
    }

    worker.onerror = (err) => {
      clearTimeout(timeout)
      worker.terminate()
      reject(new Error(`PoW worker error: ${err.message}`))
    }

    worker.postMessage({
      type: 'mine',
      event: {
        kind: event.kind,
        content: event.content,
        tags: event.tags,
        created_at: event.created_at,
        pubkey, // Needed for canonical serialization
      },
      difficulty,
      pubkey,
    })
  })
}
