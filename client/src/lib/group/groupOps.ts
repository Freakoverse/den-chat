/**
 * groupOps — the store-aware group operations (NIP-CHAT §21): create, add/remove members, edit,
 * delete, leave, accept an invite. Composes the pure lib/group/groupEvent with the hub/group/user
 * stores, publishes with failover on the group's relays, and re-applies the signed event locally
 * through the same path the loader uses, so local state is exactly what relays hold.
 */
import { nip19 } from 'nostr-tools'
import { KINDS } from '@/lib/crypto/constants'
import { useHubStore, type HubMember } from '@/stores/hubStore'
import { useGroupStore } from '@/stores/groupStore'
import { useUserStore } from '@/stores/userStore'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { publishCriticalWithFailover } from '@/lib/nostr/relay-pool'
import { fromHex, toHex } from '@/lib/crypto/lkh'
import { makeSubkeySigner } from '@/lib/nostr/v2send'
import { ChatContext, canUseV2 } from '@/lib/crypto/skd'
import {
  buildGroupTree, buildAndSignGroupEvent, addGroupMember, removeGroupMember, encryptHistory, joinTreeText,
  readGroupSettings, republishOptions, newGroupSecret, groupCoord, isGroupV2,
  GROUP_MAX_MEMBERS, type GroupData, type GroupSettings, type CreatorKeys,
} from '@/lib/group/groupEvent'
import { makeGroupEntry, publishGroupList, parseGroupCoord } from '@/lib/group/groupList'
import { applyGroupEvent, fetchGroupEvent } from '@/hooks/useGroupLoader'

function keys(): CreatorKeys & { me: string } {
  const { pubkey, privateKey, signer } = useUserStore.getState()
  if (!pubkey) throw new Error('Not logged in')
  return { pubkey, privateKey, signer, me: pubkey }
}

function current(dTag: string): { g: GroupData; secret: Uint8Array; members: HubMember[] } {
  const g = useGroupStore.getState().groups[dTag]
  const hex = useHubStore.getState().hubSecrets[dTag]
  if (!g || !hex) throw new Error('Group not loaded')
  return { g, secret: fromHex(hex), members: useHubStore.getState().hubMembers[dTag] ?? [] }
}

/** Publish a signed group event to its relays with failover, then apply it locally. */
async function publishAndApply(signed: import('nostr-tools').Event, relays: string[], v2: boolean) {
  const accepted = await publishCriticalWithFailover(signed, getPublishRelays([...relays], { hubOnly: v2 }), [...relays])
  if (accepted.length === 0) throw new Error('No relay accepted the group event — please try again.')
  const k = keys()
  await applyGroupEvent(signed, k.me, { privateKey: k.privateKey, signer: k.signer })
  return accepted
}

async function saveGroupList() {
  const k = keys()
  const entries = useGroupStore.getState().entries
  const { createdAt } = await publishGroupList(entries, k.me, k.signer, k.privateKey)
  useGroupStore.getState().setEntries(entries, createdAt)
}

/** The shareable invite: an naddr for the group's coordinate with its relays as hints. */
export function groupInviteAddress(g: { creatorPubkey: string; dTag: string; relays: string[] }): string {
  return nip19.naddrEncode({ identifier: g.dTag, pubkey: g.creatorPubkey, kind: KINDS.GROUP_EVENT, relays: g.relays.slice(0, 3) })
}

// ─── Create ───

export async function createGroup(opts: {
  name: string
  about?: string
  description?: string
  picture?: string
  banner?: string
  relays: string[]
  version: 1 | 2
  /** Initial members' REAL keys (besides the creator, who is always a member). */
  members?: string[]
  minPow?: number
  /**
   * Pre-chosen d tag. The create modal picks it up front so a v2 group's picture/banner Blossom
   * auth can be signed as the owner pseudonym O (derived from this d tag) before the event exists.
   */
  dTag?: string
}): Promise<GroupData> {
  const k = keys()
  if (opts.version === 2 && !canUseV2({ privateKey: k.privateKey, signer: k.signer })) {
    throw new Error('A private (v2) group needs the DEN Chat client or a NIP-SKD signer.')
  }
  const dTag = opts.dTag || crypto.randomUUID()
  const secret = newGroupSecret()
  const epoch = 1
  const members = [k.me, ...(opts.members ?? []).filter((m) => m !== k.me)]
  if (members.length > GROUP_MAX_MEMBERS) throw new Error(`A group can hold at most ${GROUP_MAX_MEMBERS} members`)

  const { tree, roster } = await buildGroupTree({ dTag, version: opts.version, members, secret, epoch, keys: k })
  const history = await encryptHistory(secret, { [epoch]: toHex(secret) })
  const now = Math.floor(Date.now() / 1000)
  const settings: GroupSettings = { description: opts.description || undefined }

  const signed = await buildAndSignGroupEvent({
    dTag, name: opts.name, epoch, relays: opts.relays, blossomServers: [], minPow: opts.minPow ?? 0,
    picture: opts.picture, banner: opts.banner, about: opts.about, publishedAt: now,
    version: opts.version, signerScheme: opts.version === 2 ? 'skd:1' : undefined,
    treeText: joinTreeText(tree, roster), history, settings, secret, keys: k,
  })
  await publishAndApply(signed, opts.relays, opts.version === 2)

  const g = useGroupStore.getState().groups[dTag]
  if (!g) throw new Error('Group did not load after publish')
  useGroupStore.getState().addEntry(makeGroupEntry(g, useGroupStore.getState().entries.length))
  await saveGroupList()
  return g
}

// ─── Membership (creator only) ───

export async function addMember(dTag: string, memberR: string): Promise<void> {
  const k = keys()
  const { g, secret, members } = current(dTag)
  const { tree, roster } = await addGroupMember({ g, memberR, secret, currentMembers: members, keys: k })
  const settings = await readGroupSettings(g, secret)
  const signed = await buildAndSignGroupEvent({
    ...republishOptions(g, { treeText: joinTreeText(tree, roster), history: g.history, settings }),
    secret, keys: k,
  })
  await publishAndApply(signed, g.relays, isGroupV2(g))
}

export async function removeMember(dTag: string, member: HubMember): Promise<void> {
  const k = keys()
  const { g, secret, members } = current(dTag)
  if (member.pubkey === k.me) throw new Error('You cannot remove yourself — delete the group instead.')
  const res = await removeGroupMember({ g, member, secret, currentMembers: members, keys: k })
  const settings = await readGroupSettings(g, secret)
  const signed = await buildAndSignGroupEvent({
    ...republishOptions(g, { treeText: joinTreeText(res.tree, res.roster), history: res.history, settings, epoch: res.newEpoch }),
    secret: res.newSecret, keys: k,
  })
  await publishAndApply(signed, g.relays, isGroupV2(g))
}

// ─── Edit / delete (creator only) ───

export async function updateGroup(dTag: string, patch: {
  name?: string; about?: string; description?: string; picture?: string; banner?: string; relays?: string[]; minPow?: number
}): Promise<void> {
  const k = keys()
  const { g, secret } = current(dTag)
  const settings = await readGroupSettings(g, secret)
  if (patch.description !== undefined) settings.description = patch.description || undefined
  const signed = await buildAndSignGroupEvent({
    ...republishOptions(g, { treeText: joinTreeText(g.tree, g.roster), history: g.history, settings }),
    name: patch.name ?? g.name,
    about: patch.about ?? g.about,
    picture: patch.picture ?? g.picture,
    banner: patch.banner ?? g.banner,
    relays: patch.relays ?? g.relays,
    minPow: patch.minPow ?? g.minPow,
    secret, keys: k,
  })
  await publishAndApply(signed, patch.relays ?? g.relays, isGroupV2(g))
}

/** Tombstone (blanks the tree so the event stops distributing the secret) + NIP-09, then drop from the list. */
export async function deleteGroup(dTag: string): Promise<void> {
  const k = keys()
  const { g, secret } = current(dTag)
  const signed = await buildAndSignGroupEvent({
    ...republishOptions(g, { treeText: '', history: '', settings: {} }),
    deleted: true, secret, keys: k,
  })
  await publishCriticalWithFailover(signed, getPublishRelays([...g.relays], { hubOnly: isGroupV2(g) }), [...g.relays])
  // NIP-09 request as well (relays that honour it drop the coordinate entirely)
  try {
    const { createDeletionEvent, signWithSigner } = await import('@/lib/nostr/events')
    const del = createDeletionEvent([], [groupCoord(g)], 'Group deleted by its creator')
    if (isGroupV2(g)) {
      const owner = makeSubkeySigner(ChatContext.owner(g.dTag), { privateKey: k.privateKey, signer: k.signer })
      const signedDel = await owner.signEvent(del)
      await publishCriticalWithFailover(signedDel, getPublishRelays([...g.relays], { hubOnly: true }), [...g.relays])
    } else {
      const signedDel = await signWithSigner(del, k.signer, k.privateKey)
      await publishCriticalWithFailover(signedDel, getPublishRelays([...g.relays]), [...g.relays])
    }
  } catch (err) {
    console.warn('[Groups] NIP-09 deletion not published:', err)
  }
  useGroupStore.getState().removeEntry(dTag)
  useGroupStore.getState().removeGroup(dTag)
  useHubStore.getState().setHubStatus(dTag, 'deleted')
  await saveGroupList()
}

// ─── Leave (member) ───

/** A member can't edit the tree; leaving = dropping the group from your own list. The creator removes the leaf. */
export async function leaveGroup(dTag: string): Promise<void> {
  useGroupStore.getState().removeEntry(dTag)
  useGroupStore.getState().removeGroup(dTag)
  if (useHubStore.getState().activeHubId === dTag) useHubStore.setState({ activeHubId: null, activeChannelId: null })
  await saveGroupList()
}

// ─── Accept an invite ───

export interface InvitePreview {
  coord: { pubkey: string; dTag: string }
  relays: string[]
  event: import('nostr-tools').Event
  group: GroupData
  /** Whether my leaf is in the tree (v2: my P; v1: my R). */
  isMember: boolean
}

/** Parse `naddr1…`, `nostr:naddr1…`, or a bare `36950:<pubkey>:<d>` coordinate. */
export function parseInviteAddress(input: string): { pubkey: string; dTag: string; relays: string[] } | null {
  const raw = input.trim().replace(/^nostr:/i, '')
  try {
    const d = nip19.decode(raw)
    if (d.type === 'naddr' && d.data.kind === KINDS.GROUP_EVENT) return { pubkey: d.data.pubkey, dTag: d.data.identifier, relays: d.data.relays ?? [] }
  } catch { /* not bech32 */ }
  const c = parseGroupCoord(raw)
  return c ? { ...c, relays: [] } : null
}

/** Fetch the group event for an invite and check whether I'm in its tree (no state changes). */
export async function previewInvite(input: string): Promise<InvitePreview | null> {
  const addr = parseInviteAddress(input)
  if (!addr) return null
  const k = keys()
  const event = await fetchGroupEvent(addr.pubkey, addr.dTag, addr.relays[0])
  if (!event) return null
  const { parseGroupEvent, deriveGroupSecret } = await import('@/lib/group/groupEvent')
  const group = parseGroupEvent(event)
  if (!group || group.deleted) return null
  let isMember = false
  try { isMember = !!(await deriveGroupSecret(group, k.me, { privateKey: k.privateKey, signer: k.signer })) } catch { isMember = false }
  return { coord: addr, relays: addr.relays, event, group, isMember }
}

/** Accept: register the group (loader path) and add it to my list. */
export async function acceptInvite(preview: InvitePreview): Promise<void> {
  const k = keys()
  await applyGroupEvent(preview.event, k.me, { privateKey: k.privateKey, signer: k.signer })
  const g = preview.group
  const entry = makeGroupEntry({ ...g, relays: g.relays.length ? g.relays : preview.relays }, useGroupStore.getState().entries.length)
  useGroupStore.getState().addEntry(entry)
  await saveGroupList()
}
