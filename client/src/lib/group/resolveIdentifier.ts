/**
 * resolveIdentifier: turn whatever a user pastes for a person into a hex pubkey.
 * Accepts npub / nprofile / hex, a NIP-05 address, or a DNN ID. Null when nothing resolves.
 */
import { nip05, nip19 } from 'nostr-tools'
import { isValidDnnFormat } from '@/lib/dnn/dnnUtils'
import { dnnService } from '@/lib/dnn/dnnService'

/** npub / nprofile / hex to hex, or null. */
export function keyFromInput(raw: string): string | null {
  const s = raw.trim().replace(/^nostr:/i, '')
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
  try {
    const d = nip19.decode(s)
    if (d.type === 'npub') return d.data as string
    if (d.type === 'nprofile') return d.data.pubkey
  } catch { /* not bech32 */ }
  return null
}

export async function resolveIdentifier(raw: string): Promise<string | null> {
  const direct = keyFromInput(raw)
  if (direct) return direct
  const s = raw.trim()
  if (s.includes('@')) {
    try { const p = await nip05.queryProfile(s); return p?.pubkey ?? null } catch { return null }
  }
  if (isValidDnnFormat(s)) {
    try { const r = await dnnService.resolve(s); return r?.npub ? keyFromInput(r.npub) : null } catch { return null }
  }
  return null
}
