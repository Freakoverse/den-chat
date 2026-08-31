/**
 * Virtual-space avatar (NIP-78).
 *
 * A user's two-sided "standee" images for the 3D virtual space, stored as a
 * kind-30078 replaceable event with d = "virtual-space-avatar" and content
 * { front?: blossomUrl, back?: blossomUrl }.
 *
 * Images are uploaded via the normal multi-server Blossom flow (failover + hash);
 * here we only store/resolve URLs. Resolving fetches the bytes through
 * downloadFromBlossom (which fails over across servers by sha256) and returns a
 * same-origin blob URL so the WebGL texture isn't blocked by CORS — capped by the
 * "profile" render-size limit from settings.
 */
import type { Event } from 'nostr-tools'
import { fetchReplaceable, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { createUnsignedEvent, signWithSigner } from '@/lib/nostr/events'
import { publishPersonal, getPublishRelays } from '@/stores/postingBehaviourStore'
import { downloadFromBlossom } from '@/lib/blossom/client'
import { getRenderLimit } from '@/lib/imageSizeGuard'
import type { ISigner } from '@/stores/userStore'

export const VIRTUAL_AVATAR_KIND = 30078
export const VIRTUAL_AVATAR_DTAG = 'virtual-space-avatar'

export interface VirtualAvatar {
  front?: string
  back?: string
}

export function parseVirtualAvatar(event: Event | null): VirtualAvatar | null {
  if (!event) return null
  try {
    const obj = JSON.parse(event.content || '{}')
    const front = typeof obj.front === 'string' && obj.front ? obj.front : undefined
    const back = typeof obj.back === 'string' && obj.back ? obj.back : undefined
    if (!front && !back) return null
    return { front, back }
  } catch {
    return null
  }
}

export async function publishVirtualAvatar(
  avatar: VirtualAvatar,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<void> {
  if (!signer && !privateKey) throw new Error('Not signed in')
  const content = JSON.stringify({ front: avatar.front || '', back: avatar.back || '' })
  const tags: [string, ...string[]][] = [['d', VIRTUAL_AVATAR_DTAG]]
  const unsigned = createUnsignedEvent(VIRTUAL_AVATAR_KIND, content, tags)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishPersonal(signed)
  if (signed?.pubkey) _cache.delete(signed.pubkey)   // our avatar changed — re-fetch next time
}

// ── Per-pubkey cache (the event is replaceable; cleared on our own publish) ──
const _cache = new Map<string, Promise<VirtualAvatar | null>>()

export function fetchVirtualAvatarCached(pubkey: string): Promise<VirtualAvatar | null> {
  let p = _cache.get(pubkey)
  if (!p) {
    p = fetchReplaceable(pubkey, VIRTUAL_AVATAR_KIND, VIRTUAL_AVATAR_DTAG)
      .then(parseVirtualAvatar)
      .catch(() => null)
    _cache.set(pubkey, p)
  }
  return p
}

export function clearVirtualAvatarCache(pubkey?: string): void {
  if (pubkey) _cache.delete(pubkey)
  else _cache.clear()
}

/** Extract the sha256 hash + server origin from a blossom URL. */
function parseBlossomUrl(url: string): { hash: string; origin: string } | null {
  try {
    const u = new URL(url)
    const seg = u.pathname.split('/').filter(Boolean).pop() || ''
    const hash = seg.split('.')[0].toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(hash)) return null
    return { hash, origin: u.origin }
  } catch {
    return null
  }
}

/** Sniff an image MIME from magic bytes — a blob URL needs a type or the <img>/
 *  texture loader can decode it to a blank (white) image. */
function sniffImageMime(b: Uint8Array): string {
  if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b.length > 5 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  return 'image/png'
}

/**
 * Resolve a blossom image URL to a same-origin blob URL (CORS-safe for WebGL
 * textures), via failover download + the profile render-size cap. Returns null on
 * failure or if it exceeds the limit. The caller owns the blob URL (revoke when done).
 */
export async function loadAvatarBlobUrl(url: string | undefined): Promise<string | null> {
  if (!url) return null
  const parsed = parseBlossomUrl(url)
  if (!parsed) return null
  try {
    const bytes = await downloadFromBlossom(parsed.hash, [parsed.origin])
    const limitBytes = getRenderLimit('profile') * 1024 * 1024
    if (bytes.byteLength > limitBytes) return null
    return URL.createObjectURL(new Blob([bytes], { type: sniffImageMime(bytes) }))
  } catch {
    return null
  }
}
