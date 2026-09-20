/**
 * Groups (NIP-CHAT §21) — kind 36950: one conversation, ≤100 members, the LKH member tree and the
 * epoch-secret history INLINE in the event (no Blossom for membership), creator-only add/remove,
 * v1 (real keys, NIP-04 leaves) and v2 (NIP-SKD pseudonyms O/P, NIP-44 O↔P leaves + roster).
 *
 * Runtime model: a loaded group is registered in the hub store as a single-channel hub flagged
 * `isGroup` (channel id = the group's d-tag), so every message path (send/receive/cache/replies/
 * reactions/pins/typing) reuses unchanged — see toHubData(). Messages are kind 36943 with h = c = d.
 *
 * Everything here is pure: it takes/returns strings and bytes and never touches a store, so the
 * loader and the creator UI compose it.
 */
import type { Event, UnsignedEvent } from 'nostr-tools'
import { KINDS } from '@/lib/crypto/constants'
import { buildTree, createLeaf, serializeTree, deserializeTree, getMembers, toHex, fromHex, type LkhLeaf } from '@/lib/crypto/lkh'
import {
  nip04Encrypt, decryptHubSecret, decryptGroupSecretV2,
  addMemberToGroupTree, removeMemberFromGroupTree, addMemberToGroupTreeV2, removeMemberFromGroupTreeV2,
} from '@/lib/blossom/members'
import {
  encryptRoster, decryptRoster, deriveHubContentKey, encryptHubContent, decryptHubContent,
  buildOwnerAttestation, encryptOwnerAttestation, decryptOwnerAttestation, verifyOwnerAttestation,
  type RosterMap,
} from '@/lib/hub/hubContent'
import { aesEncrypt, aesDecrypt } from '@/lib/crypto/aes'
import { ChatContext, resolveMemberPseudonymForOwner, canUseV2 } from '@/lib/crypto/skd'
import { makeSubkeySigner, mineAndSignAsSubkey } from '@/lib/nostr/v2send'
import { createUnsignedEvent, mineAndSign } from '@/lib/nostr/events'
import { DEFAULT_EVERYONE_PERMISSIONS } from '@/lib/hub/permissions'
import type { HubData, HubMember } from '@/stores/hubStore'
import type { ISigner } from '@/stores/userStore'

// ─── Limits (§21.9) ───

export const GROUP_MAX_MEMBERS = 100
export const GROUP_MAX_EPOCHS = 100
/** Serialized-event guard so a long description / URL can never push a full group past a relay's ceiling. */
export const GROUP_MAX_EVENT_BYTES = 60_000
export const GROUP_NAME_MAX = 60
export const GROUP_ABOUT_MAX = 300
export const GROUP_DESCRIPTION_MAX = 2000
/** Leaf role for every group member (the tree format needs one; groups have no roles). */
const GROUP_LEAF_ROLE = 'everyone'

// ─── Types ───

export interface GroupSettings {
  description?: string
}

export interface GroupData {
  dTag: string
  /** Event author: the creator's real key R (v1) or the owner pseudonym O (v2). */
  creatorPubkey: string
  name: string
  epoch: number
  relays: string[]
  blossomServers: string[]
  minPow: number
  /** Join-request PoW (`W` tag, §21.6.1). Requests mined below it are dropped before any decrypt. */
  joinMinPow: number
  picture?: string
  banner?: string
  about?: string
  publishedAt: number
  eventCreatedAt: number
  version?: number
  signerScheme?: string
  deleted: boolean
  /** Tree text WITHOUT the roster line (leaf/node/root lines only). */
  tree: string
  /** v2: the group-encrypted {P:R} segment carried as a `roster:<epoch>:<blob>` line in `tree`. */
  roster?: { epoch: number; blob: string }
  /** AES-GCM blob of the epoch history under the CURRENT secret (`hub:<epoch>:<hex>` lines). */
  history: string
  /** v1: plaintext object. v2: base64 AES-GCM blob under the epoch's content key. */
  settingsRaw: unknown
  /** v2: encrypted owner attestation. */
  ownerRaw?: string
}

export const isGroupV2 = (g: { version?: number }) => g.version === 2
export const groupCoord = (g: { creatorPubkey: string; dTag: string }) => `${KINDS.GROUP_EVENT}:${g.creatorPubkey}:${g.dTag}`

// ─── Tree text: roster line handling ───

/** The monolithic serializer knows leaf/node/root only; the roster rides as one extra line. */
export function joinTreeText(tree: string, roster?: { epoch: number; blob: string }): string {
  const base = tree.trim()
  return roster ? `${base}\nroster:${roster.epoch}:${roster.blob}` : base
}

export function splitTreeText(text: string): { tree: string; roster?: { epoch: number; blob: string } } {
  const lines = text.split('\n')
  const rosterLine = lines.find((l) => l.startsWith('roster:'))
  const tree = lines.filter((l) => !l.startsWith('roster:')).join('\n')
  if (!rosterLine) return { tree }
  const [, epochStr, ...rest] = rosterLine.split(':')
  const epoch = parseInt(epochStr, 10)
  const blob = rest.join(':')
  return Number.isFinite(epoch) && blob ? { tree, roster: { epoch, blob } } : { tree }
}

// ─── Epoch history (§21.9: capped at 100, oldest pruned) ───

export function parseHistoryLines(plaintext: string): Record<number, string> {
  const out: Record<number, string> = {}
  for (const line of plaintext.split('\n')) {
    const m = /^hub:(\d+):([0-9a-f]{64})$/i.exec(line.trim())
    if (m) out[parseInt(m[1], 10)] = m[2].toLowerCase()
  }
  return out
}

export function serializeHistory(secrets: Record<number, string>): string {
  const epochs = Object.keys(secrets).map(Number).sort((a, b) => a - b)
  // Keep the NEWEST GROUP_MAX_EPOCHS — pruning the oldest is the documented trade-off (§21.9)
  const kept = epochs.slice(Math.max(0, epochs.length - GROUP_MAX_EPOCHS))
  return kept.map((e) => `hub:${e}:${secrets[e]}`).join('\n')
}

export async function encryptHistory(currentSecret: Uint8Array, secrets: Record<number, string>): Promise<string> {
  return aesEncrypt(currentSecret, serializeHistory(secrets))
}

export async function decryptHistory(currentSecret: Uint8Array, blob: string): Promise<Record<number, string>> {
  if (!blob) return {}
  return parseHistoryLines(await aesDecrypt(currentSecret, blob))
}

// ─── Parse ───

export function parseGroupEvent(event: Event): GroupData | null {
  if (event.kind !== KINDS.GROUP_EVENT) return null
  const tag = (k: string) => event.tags.find((t) => t[0] === k)?.[1]
  const dTag = tag('d')
  if (!dTag) return null
  const deleted = event.tags.some((t) => t[0] === 'deleted' && t[1] === 'true')

  let content: { tree?: string; history?: string; settings?: unknown; owner?: string } = {}
  if (event.content) {
    try { content = JSON.parse(event.content) } catch { if (!deleted) return null }
  }
  const { tree, roster } = splitTreeText(content.tree ?? '')
  const versionTag = tag('version')
  const schemeTag = event.tags.find((t) => t[0] === 'signer_scheme')

  return {
    dTag,
    creatorPubkey: event.pubkey,
    name: tag('n') ?? 'Group',
    epoch: parseInt(tag('epoch') ?? '1', 10) || 1,
    relays: event.tags.filter((t) => t[0] === 'r' && t[1]).map((t) => t[1]),
    blossomServers: event.tags.filter((t) => t[0] === 'o' && t[1]).map((t) => t[1]),
    minPow: parseInt(tag('w') ?? '0', 10) || 0,
    joinMinPow: parseInt(tag('W') ?? '0', 10) || 0,
    picture: tag('picture') || undefined,
    banner: tag('banner') || undefined,
    about: tag('about') || undefined,
    publishedAt: parseInt(tag('published_at') ?? '', 10) || event.created_at,
    eventCreatedAt: event.created_at,
    version: versionTag ? parseInt(versionTag, 10) || undefined : undefined,
    signerScheme: schemeTag ? `${schemeTag[1]}:${schemeTag[2] ?? '1'}` : undefined,
    deleted,
    tree,
    roster,
    history: content.history ?? '',
    settingsRaw: content.settings,
    ownerRaw: content.owner,
  }
}

// ─── Member side: derive the secret from the inline tree ───

/**
 * The group secret for `me` — walking my own leaf. v1: NIP-04 leaf to R (creator as peer).
 * v2: my pseudonym P (blinded toward O) and the O↔P NIP-44 leaf. Null when I'm not in the tree.
 */
export async function deriveGroupSecret(
  g: GroupData,
  me: string,
  opts: { privateKey: string | null; signer: ISigner | null },
): Promise<{ secret: Uint8Array; memberP?: string } | null> {
  if (!g.tree) return null
  if (isGroupV2(g)) {
    if (!canUseV2(opts)) return null
    const pSigner = makeSubkeySigner(ChatContext.member(g.dTag), { privateKey: opts.privateKey, signer: opts.signer, peerPub: g.creatorPubkey })
    const memberP = await pSigner.getPublicKey()
    const secret = await decryptGroupSecretV2(memberP, g.dTag, opts.privateKey, opts.signer, g.creatorPubkey, g.tree)
    return secret ? { secret, memberP } : null
  }
  const secret = await decryptHubSecret(me, opts.privateKey, opts.signer, g.creatorPubkey, g.tree)
  return secret ? { secret } : null
}

/** Members as the hub store expects them. v2 resolves P→R through the roster when the roster epoch's secret is known. */
export async function listGroupMembers(g: GroupData, epochSecrets: Record<number, string>): Promise<HubMember[]> {
  if (!g.tree) return []
  const leaves = getMembers(deserializeTree(g.tree))
  if (!isGroupV2(g)) return leaves.map((l) => ({ pubkey: l.pubkey, roles: l.roles, flags: l.flags }))
  let roster: RosterMap = {}
  if (g.roster) {
    const hex = epochSecrets[g.roster.epoch]
    if (hex) {
      try { roster = await decryptRoster(fromHex(hex), g.roster.blob, g.roster.epoch) } catch { /* stale/unknown epoch — show pseudonyms */ }
    }
  }
  return leaves.map((l) => ({ pubkey: roster[l.pubkey] ?? l.pubkey, roles: l.roles, flags: l.flags, p: l.pubkey }))
}

/** v2: decrypt + verify the owner attestation → R_owner; undefined when absent/invalid. */
export async function resolveOwnerRealPubkey(g: GroupData, secret: Uint8Array): Promise<string | undefined> {
  if (!isGroupV2(g) || !g.ownerRaw) return undefined
  try {
    const att = await decryptOwnerAttestation(secret, g.ownerRaw)
    return verifyOwnerAttestation(groupCoord(g), att) ? att.rOwnerPub : undefined
  } catch { return undefined }
}

export async function readGroupSettings(g: GroupData, secret: Uint8Array): Promise<GroupSettings> {
  if (!isGroupV2(g)) return (g.settingsRaw && typeof g.settingsRaw === 'object' ? g.settingsRaw : {}) as GroupSettings
  if (typeof g.settingsRaw !== 'string' || !g.settingsRaw) return {}
  try { return await decryptHubContent<GroupSettings>(deriveHubContentKey(secret, g.epoch), g.settingsRaw) } catch { return {} }
}

/** Register a group in the hub store shape: one channel (id = d), the `everyone` role, `isGroup`. */
export function toHubData(g: GroupData, settings: GroupSettings, ownerRealPubkey?: string): HubData {
  return {
    dTag: g.dTag,
    creatorPubkey: g.creatorPubkey,
    name: g.name,
    icon: g.picture,
    banner: g.banner,
    description: settings.description ?? g.about,
    epoch: g.epoch,
    generalRelays: g.relays,
    blossomServers: g.blossomServers,
    indexFileHash: '',
    channels: [{ channelId: g.dTag, name: g.name, type: 'chat', categoryId: null, synced: false, encryption: null, position: 0 }],
    categories: [],
    roles: [{ roleId: 'everyone', name: 'everyone', position: 0, permissions: { ...DEFAULT_EVERYONE_PERMISSIONS } }],
    minPow: g.minPow,
    joinMinPow: g.joinMinPow,
    version: g.version,
    signerScheme: g.signerScheme,
    ownerRealPubkey,
    deleted: g.deleted,
    publishedAt: g.publishedAt,
    eventCreatedAt: g.eventCreatedAt,
    isGroup: true,
  }
}

// ─── Creator side: tree ops ───

export interface CreatorKeys {
  /** The creator's real pubkey R. */
  pubkey: string
  privateKey: string | null
  signer: ISigner | null
}

/** Resolve a member's v2 pseudonym P from their real key R (owner-side blinded verifier). */
async function memberP(dTag: string, memberR: string, keys: CreatorKeys): Promise<string> {
  return resolveMemberPseudonymForOwner(dTag, memberR, { ownerPrivateKey: keys.privateKey, signer: keys.signer })
}

/**
 * Build the inline tree for `members` (real keys, creator included) under `secret`.
 * v1 leaves are R wrapped NIP-04 by the creator; v2 leaves are P wrapped NIP-44 O↔P, plus the roster.
 */
export async function buildGroupTree(opts: {
  dTag: string; version: 1 | 2; members: string[]; secret: Uint8Array; epoch: number; keys: CreatorKeys
}): Promise<{ tree: string; roster?: { epoch: number; blob: string } }> {
  const { dTag, version, members, secret, epoch, keys } = opts
  if (members.length === 0) throw new Error('A group needs at least one member')
  if (members.length > GROUP_MAX_MEMBERS) throw new Error(`A group can hold at most ${GROUP_MAX_MEMBERS} members`)
  const leaves: LkhLeaf[] = []
  if (version === 2) {
    const ownerSigner = makeSubkeySigner(ChatContext.owner(dTag), { privateKey: keys.privateKey, signer: keys.signer })
    const roster: RosterMap = {}
    for (const r of members) {
      const p = await memberP(dTag, r, keys)
      const leaf = createLeaf(p, GROUP_LEAF_ROLE)
      leaf.encryptedLeafKey = await ownerSigner.nip44Encrypt(p, toHex(leaf.rawKey!))
      leaves.push(leaf)
      roster[p] = r
    }
    const tree = serializeTree(await buildTree(leaves, secret))
    return { tree, roster: { epoch, blob: await encryptRoster(secret, roster, epoch) } }
  }
  for (const r of members) {
    const leaf = createLeaf(r, GROUP_LEAF_ROLE)
    leaf.encryptedLeafKey = await nip04Encrypt(r, toHex(leaf.rawKey!), keys.signer, keys.privateKey)
    leaves.push(leaf)
  }
  return { tree: serializeTree(await buildTree(leaves, secret)) }
}

/** Add one member (real key). No rotation. Returns the new tree (+ roster for v2). */
export async function addGroupMember(opts: {
  g: GroupData; memberR: string; secret: Uint8Array; currentMembers: HubMember[]; keys: CreatorKeys
}): Promise<{ tree: string; roster?: { epoch: number; blob: string }; member: HubMember }> {
  const { g, memberR, secret, currentMembers, keys } = opts
  if (currentMembers.length >= GROUP_MAX_MEMBERS) throw new Error(`This group is full (${GROUP_MAX_MEMBERS} members)`)
  if (currentMembers.some((m) => m.pubkey === memberR)) throw new Error('Already a member')
  if (isGroupV2(g)) {
    const p = await memberP(g.dTag, memberR, keys)
    const tree = await addMemberToGroupTreeV2(g.tree, p, secret, g.dTag, keys.privateKey, keys.signer)
    const roster: RosterMap = {}
    for (const m of currentMembers) if (m.p) roster[m.p] = m.pubkey
    roster[p] = memberR
    return { tree, roster: { epoch: g.epoch, blob: await encryptRoster(secret, roster, g.epoch) }, member: { pubkey: memberR, roles: '', p } }
  }
  const tree = await addMemberToGroupTree(deserializeTree(g.tree), memberR, secret, keys.signer, keys.privateKey)
  return { tree, member: { pubkey: memberR, roles: '' } }
}

/**
 * Remove one member: LKH kick + rotation. Returns the new tree, secret, epoch and history.
 * The history MUST be readable first (§5.4 / §21.5): never rebuild it from only old+new.
 */
export async function removeGroupMember(opts: {
  g: GroupData; member: HubMember; secret: Uint8Array; currentMembers: HubMember[]; keys: CreatorKeys
}): Promise<{ tree: string; roster?: { epoch: number; blob: string }; newSecret: Uint8Array; newEpoch: number; history: string }> {
  const { g, member, secret, currentMembers, keys } = opts
  // Read history BEFORE mutating anything — a corrupt blob aborts the removal, it never starts fresh.
  let secrets: Record<number, string>
  try {
    secrets = g.history ? await decryptHistory(secret, g.history) : {}
  } catch (err) {
    throw new Error(`The group's epoch history could not be read, so the removal was aborted rather than lose past secrets. (${err instanceof Error ? err.message : String(err)})`)
  }

  let tree: string
  let newSecret: Uint8Array
  if (isGroupV2(g)) {
    const p = member.p ?? member.pubkey
    const res = await removeMemberFromGroupTreeV2(g.tree, p, secret, g.dTag, keys.privateKey, keys.signer)
    if (!res) throw new Error('Not a member')
    tree = res.newTreeContent
    newSecret = res.newGroupSecret
  } else {
    const res = await removeMemberFromGroupTree(deserializeTree(g.tree), member.pubkey)
    if (!res) throw new Error('Not a member')
    tree = res.newTreeContent
    newSecret = res.newGroupSecret
  }
  const newEpoch = g.epoch + 1
  secrets[g.epoch] = toHex(secret)
  secrets[newEpoch] = toHex(newSecret)
  const history = await encryptHistory(newSecret, secrets)

  let roster: { epoch: number; blob: string } | undefined
  if (isGroupV2(g)) {
    const map: RosterMap = {}
    for (const m of currentMembers) if (m.p && m.p !== (member.p ?? member.pubkey)) map[m.p] = m.pubkey
    roster = { epoch: newEpoch, blob: await encryptRoster(newSecret, map, newEpoch) }
  }
  return { tree, roster, newSecret, newEpoch, history }
}

// ─── Build + sign the group event ───

export interface BuildGroupEventOptions {
  dTag: string
  name: string
  epoch: number
  relays: string[]
  blossomServers?: string[]
  minPow?: number
  joinMinPow?: number
  picture?: string
  banner?: string
  about?: string
  publishedAt: number
  /** Previous event's created_at → +1 replacement (never wall-clock on updates). */
  eventCreatedAt?: number
  version: 1 | 2
  signerScheme?: string
  /** Tree text INCLUDING the roster line (use joinTreeText). */
  treeText: string
  history: string
  settings: GroupSettings
  deleted?: boolean
}

function groupTags(o: BuildGroupEventOptions): [string, ...string[]][] {
  const tags: [string, ...string[]][] = [
    ['d', o.dTag],
    ['n', o.name.slice(0, GROUP_NAME_MAX)],
    ['epoch', String(o.epoch)],
  ]
  if (o.deleted) { tags.push(['deleted', 'true']); return tags }
  for (const r of o.relays) tags.push(['r', r, 'general'])
  for (const s of o.blossomServers ?? []) tags.push(['o', s])
  if (o.minPow && o.minPow > 0) tags.push(['w', String(o.minPow)])
  if (o.joinMinPow && o.joinMinPow > 0) tags.push(['W', String(o.joinMinPow)])
  if (o.picture) tags.push(['picture', o.picture])
  if (o.banner) tags.push(['banner', o.banner])
  if (o.about) tags.push(['about', o.about.slice(0, GROUP_ABOUT_MAX)])
  tags.push(['published_at', String(o.publishedAt)])
  tags.push(['client', 'DEN Chat'])
  if (o.version === 2) {
    tags.push(['version', '2'])
    const [fam, ver] = (o.signerScheme ?? 'skd:1').split(':')
    tags.push(['signer_scheme', fam, ver ?? '1'])
  }
  return tags
}

export function assertGroupEventSize(unsigned: UnsignedEvent): void {
  const bytes = new TextEncoder().encode(JSON.stringify(unsigned)).length
  if (bytes > GROUP_MAX_EVENT_BYTES) {
    throw new Error(`This group event is ${(bytes / 1024).toFixed(1)} KB — over the ${GROUP_MAX_EVENT_BYTES / 1000} KB limit relays accept. Shorten the description or remove members.`)
  }
}

/**
 * Build and sign. v1: the creator's real key. v2: content encrypted under the epoch content key, the
 * owner attestation sealed with the secret, signed as the owner pseudonym O.
 */
export async function buildAndSignGroupEvent(opts: BuildGroupEventOptions & {
  secret: Uint8Array
  keys: CreatorKeys
}): Promise<Event> {
  const { secret, keys } = opts
  const createdAt = opts.eventCreatedAt != null ? opts.eventCreatedAt + 1 : undefined
  const tags = groupTags(opts)

  if (opts.deleted) {
    const unsigned = createUnsignedEvent(KINDS.GROUP_EVENT, '', tags, createdAt)
    return signGroupEvent(unsigned, opts, keys)
  }

  if (opts.version === 2) {
    const ownerSigner = makeSubkeySigner(ChatContext.owner(opts.dTag), { privateKey: keys.privateKey, signer: keys.signer })
    const ownerPub = await ownerSigner.getPublicKey()
    const coord = `${KINDS.GROUP_EVENT}:${ownerPub}:${opts.dTag}`
    const att = await buildOwnerAttestation(coord, keys.pubkey, keys.signer, keys.privateKey)
    const content = JSON.stringify({
      tree: opts.treeText,
      history: opts.history,
      settings: await encryptHubContent(deriveHubContentKey(secret, opts.epoch), opts.settings),
      owner: await encryptOwnerAttestation(secret, att),
    })
    const unsigned = createUnsignedEvent(KINDS.GROUP_EVENT, content, tags, createdAt)
    assertGroupEventSize(unsigned)
    return mineAndSignAsSubkey(unsigned, opts.minPow ?? 0, ownerSigner)
  }

  const content = JSON.stringify({ tree: opts.treeText, history: opts.history, settings: opts.settings })
  const unsigned = createUnsignedEvent(KINDS.GROUP_EVENT, content, tags, createdAt)
  assertGroupEventSize(unsigned)
  return signGroupEvent(unsigned, opts, keys)
}

async function signGroupEvent(unsigned: UnsignedEvent, opts: BuildGroupEventOptions, keys: CreatorKeys): Promise<Event> {
  if (opts.version === 2) {
    const ownerSigner = makeSubkeySigner(ChatContext.owner(opts.dTag), { privateKey: keys.privateKey, signer: keys.signer })
    return mineAndSignAsSubkey(unsigned, opts.minPow ?? 0, ownerSigner)
  }
  return mineAndSign(unsigned, opts.minPow ?? 0, keys.pubkey, keys.signer, keys.privateKey)
}

/** Fresh 32-byte group secret. */
export function newGroupSecret(): Uint8Array {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return b
}

/** The BuildGroupEventOptions for republishing an existing group with changes applied. */
export function republishOptions(g: GroupData, patch: Partial<BuildGroupEventOptions> & { treeText: string; history: string; settings: GroupSettings }): BuildGroupEventOptions {
  return {
    dTag: g.dTag,
    name: g.name,
    epoch: g.epoch,
    relays: g.relays,
    blossomServers: g.blossomServers,
    minPow: g.minPow,
    joinMinPow: g.joinMinPow,
    picture: g.picture,
    banner: g.banner,
    about: g.about,
    publishedAt: g.publishedAt,
    eventCreatedAt: g.eventCreatedAt,
    version: isGroupV2(g) ? 2 : 1,
    signerScheme: g.signerScheme,
    ...patch,
  }
}
