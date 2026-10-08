/**
 * hubStructBlob: the hub "struct blob", the structural arrays (roles, grouped_roles, categories,
 * channels, plugins) that used to live inline in the kind-36942 event content, moved verbatim into a
 * Blossom file so the event stays O(1) regardless of how many channels/roles a hub has. See
 * docs/NIP-MDM is unrelated; this is the NIP-CHAT hub struct-blob plan.
 *
 * The blob is encrypted exactly the way the hub already encrypts its event content: v2 hubs use the
 * `hub_content_key` (members-only); v1 (public) hubs are plaintext JSON. The event references it with a
 * `["struct", "<sha256>", "<epoch>"]` tag. The reader (useHubLoader) fetches + decrypts it; this module
 * is the writer half (build the object, serialize/hash, upload + verify + cache).
 */

import type { Channel, Category, Role } from '@/stores/hubStore'
import type { GroupedRole } from '@/lib/hub/groupEncryption'
import type { ISigner } from '@/stores/userStore'
import { encryptHubContent, deriveHubContentKey } from './hubContent'
import { computeHash, uploadToBlossomServers, type BlossomAuthSigner } from '@/lib/blossom/client'
import { downloadTextFromBlossom } from '@/lib/blossom'
import { cacheHubBlob } from '@/lib/blossom/hubBlobStore'

/** Hub tree/struct files are stored as text/plain in production (matches the member-tree blobs). */
const STRUCT_CONTENT_TYPE = 'text/plain'

export interface HubStructInput {
  channels: Channel[]
  categories: Category[]
  roles: Role[]
  groupedRoles?: GroupedRole[]
}

/**
 * The struct blob object: the structural arrays, mapped EXACTLY as they are built into the event content
 * today (see buildHubEvent) so moving them to the blob is byte-for-byte the same data, no reshaping.
 */
export function buildStructObject(input: HubStructInput): Record<string, unknown> {
  return {
    roles: input.roles.map(r => ({
      role_id: r.roleId, name: r.name, ...(r.color ? { color: r.color } : {}),
      position: r.position, ...(r.hoist ? { hoist: true } : {}), permissions: r.permissions,
    })),
    grouped_roles: (input.groupedRoles || []).map(g => ({ group_id: g.groupId, role_ids: g.roleIds, epoch: g.epoch })),
    categories: input.categories.map(c => ({
      category_id: c.categoryId, name: c.name, position: c.position, encryption: c.encryption, permissions: c.permissions || {},
    })),
    channels: input.channels.map(ch => ({
      channel_id: ch.channelId, name: ch.name, type: ch.type, category_id: ch.categoryId,
      synced: ch.synced, encryption: ch.encryption, position: ch.position,
      description: ch.description || undefined, permissions: ch.permissions || {},
    })),
    plugins: {},
  }
}

/**
 * Serialize the struct object to the bytes that will be uploaded. v2 encrypts with the hub content key
 * (same scheme as the event content); v1 (no key) is plaintext JSON. Returns the bytes, their sha256, and
 * the text (for caching).
 */
export async function serializeStructBlob(structObj: unknown, contentKey?: Uint8Array): Promise<{ bytes: Uint8Array; hash: string; text: string }> {
  const text = contentKey ? await encryptHubContent(contentKey, structObj) : JSON.stringify(structObj)
  const bytes = new TextEncoder().encode(text)
  return { bytes, hash: computeHash(bytes), text }
}

/**
 * Upload the struct blob to the hub's Blossom servers, VERIFY it reads back (so the event never points at
 * an unavailable/corrupt blob), and cache it locally for offline skeleton render. Returns the hash.
 *
 * `authSigner` lets a v2 caller sign the 24242 upload auth as the owner pseudonym `O` so the Blossom
 * server never sees the real key (v1 passes none, uploading under the real key like its other files).
 */
export async function uploadStructBlob(opts: {
  bytes: Uint8Array
  hash: string
  servers: string[]
  dTag: string
  signer: ISigner | null
  privateKey: string | null
  authSigner?: BlossomAuthSigner
}): Promise<string> {
  const { hash, successCount } = await uploadToBlossomServers(
    opts.bytes, opts.signer, opts.privateKey, opts.servers, STRUCT_CONTENT_TYPE, undefined, undefined, opts.authSigner,
  )
  if (hash !== opts.hash) throw new Error('Struct blob: upload returned a different hash than computed')
  if (successCount === 0) throw new Error('Struct blob: no Blossom server accepted the upload')
  // Read-back verify against the hash (same guard the member-tree health check uses).
  const readBack = await downloadTextFromBlossom(hash, opts.servers)
  if (computeHash(new TextEncoder().encode(readBack)) !== hash) throw new Error('Struct blob: read-back hash mismatch')
  await cacheHubBlob(hash, opts.bytes, opts.dTag).catch(() => { /* cache best-effort */ })
  return hash
}

/**
 * Resolve how a hub's struct blob is encrypted + authenticated, matching how the hub encrypts its event
 * content and uploads its member-tree blobs: v1 (public) → plaintext blob, Blossom auth as the real key
 * (no context returned); v2 (private) → the hub_content_key at `epoch` + a Blossom auth signer that signs
 * the 24242 auth as the owner pseudonym `O` (so the Blossom server never sees the real key). Owner-only:
 * structure edits are owner-only, so `O` is always the right author.
 */
export async function resolveStructUploadContext(
  hub: { dTag: string; creatorPubkey: string; version?: number },
  epoch: number,
  opts: { privateKey: string | null; signer: ISigner | null },
): Promise<{ contentKey?: Uint8Array; authSigner?: BlossomAuthSigner }> {
  if (hub.version !== 2) return {} // v1: plaintext blob, upload auth as the real key (like its other files)
  const { useHubStore } = await import('@/stores/hubStore')
  const secretHex = useHubStore.getState().hubSecrets[hub.dTag]
  if (!secretHex) throw new Error('Hub secret not available to build the struct blob')
  const { fromHex } = await import('@/lib/crypto/lkh')
  const contentKey = deriveHubContentKey(fromHex(secretHex), epoch)
  const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
  const { ChatContext } = await import('@/lib/crypto/skd')
  const ownerSigner = makeSubkeySigner(ChatContext.owner(hub.dTag), opts)
  return { contentKey, authSigner: (u) => ownerSigner.signEvent(u) }
}

/** Build + serialize + upload + verify in one call. Returns the struct hash to put in the `struct` tag. */
export async function publishStructBlob(opts: {
  input: HubStructInput
  contentKey?: Uint8Array
  servers: string[]
  dTag: string
  signer: ISigner | null
  privateKey: string | null
  authSigner?: BlossomAuthSigner
}): Promise<string> {
  const { bytes, hash } = await serializeStructBlob(buildStructObject(opts.input), opts.contentKey)
  return uploadStructBlob({ bytes, hash, servers: opts.servers, dTag: opts.dTag, signer: opts.signer, privateKey: opts.privateKey, authSigner: opts.authSigner })
}
