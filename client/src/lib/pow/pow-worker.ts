/**
 * pow-worker.ts — Web Worker for NIP-13 Proof of Work mining
 *
 * Receives an unsigned event (serialized as NIP-01 canonical form),
 * iterates nonce until the SHA-256 hash has the required leading zero bits.
 *
 * Message protocol:
 *   IN:  { type: 'mine', event: UnsignedEvent, difficulty: number, pubkey: string }
 *   OUT: { type: 'mined', event: UnsignedEvent }
 *   IN:  { type: 'benchmark' }
 *   OUT: { type: 'benchmarked', hashRate: number }
 */

// Count leading zero bits of a hex string
function countLeadingZeroBits(hex: string): number {
  let count = 0
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16)
    if (nibble === 0) {
      count += 4
    } else {
      // Count leading zeros in this nibble (4-bit value)
      count += Math.clz32(nibble) - 28
      break
    }
  }
  return count
}

// Serialize event to NIP-01 canonical form for hashing
function serializeForHash(event: any): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ])
}

// SHA-256 hash a string, return hex
async function sha256Hex(message: string): Promise<string> {
  const data = new TextEncoder().encode(message)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = new Uint8Array(hashBuffer)
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Mine PoW: find a nonce that produces an event ID with required leading zero bits
async function minePoW(event: any, difficulty: number, pubkey: string) {
  if (difficulty <= 0) {
    self.postMessage({ type: 'mined', event })
    return
  }

  // Ensure pubkey is on the event
  const miningEvent = { ...event, pubkey }

  // Find or create the nonce tag
  const tags = [...miningEvent.tags.map((t: any) => [...t])]
  let nonceIdx = tags.findIndex((t: any) => t[0] === 'nonce')
  if (nonceIdx < 0) {
    tags.push(['nonce', '0', difficulty.toString()])
    nonceIdx = tags.length - 1
  } else {
    tags[nonceIdx] = ['nonce', '0', difficulty.toString()]
  }

  miningEvent.tags = tags

  let nonce = 0
  const batchSize = 1000 // Check in batches to avoid blocking

  while (true) {
    for (let i = 0; i < batchSize; i++) {
      tags[nonceIdx][1] = nonce.toString()
      const serialized = serializeForHash(miningEvent)
      const hash = await sha256Hex(serialized)

      if (countLeadingZeroBits(hash) >= difficulty) {
        self.postMessage({ type: 'mined', event: { ...miningEvent, tags } })
        return
      }
      nonce++
    }
    // Yield to message loop periodically
  }
}

// Benchmark: how many hashes/sec can this device do
async function benchmark() {
  const testEvent = {
    pubkey: '0'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [['nonce', '0', '1']],
    content: 'benchmark test',
  }

  const start = performance.now()
  const iterations = 2000

  for (let i = 0; i < iterations; i++) {
    testEvent.tags[0][1] = i.toString()
    const serialized = serializeForHash(testEvent)
    await sha256Hex(serialized)
  }

  const elapsed = (performance.now() - start) / 1000 // seconds
  const hashRate = iterations / elapsed

  self.postMessage({ type: 'benchmarked', hashRate })
}

// Listen for messages
self.onmessage = (e: MessageEvent) => {
  const { type } = e.data
  if (type === 'mine') {
    minePoW(e.data.event, e.data.difficulty, e.data.pubkey)
  } else if (type === 'benchmark') {
    benchmark()
  }
}
