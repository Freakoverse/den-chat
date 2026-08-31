/**
 * usePoll — Hook for creating polls and casting votes in a hub channel
 *
 * Handles encryption, PoW mining, signing, and progressive publishing.
 * Uses the same channel key derivation as useMessages.
 */

import { useCallback } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { usePollStore } from '@/stores/pollStore'
import { createPollEvent, createVoteEvent, mineAndSign } from '@/lib/nostr/events'
import { signHubMemberEvent } from '@/lib/hub/hubMemberSign'
import { isV2 } from '@/lib/hub/version'
import { stampHubExpiration } from '@/lib/hub/messageExpiration'
import { aesEncrypt } from '@/lib/crypto/aes'
import { deriveChannelKey } from '@/lib/crypto/hkdf'

import { publishEventProgressive } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { isClientTagEnabled } from '@/components/social/ComposeSettings'

export interface PollCreationData {
  text: string
  options: { id: string; label: string }[]
  polltype: 'singlechoice' | 'multiplechoice'
  endsAt?: number
  allowVoteChange: boolean
  showResultsBeforeVoting: boolean
  showVoterIdentity: boolean
}

export function usePoll(hubDTag: string | null, channelId: string | null) {
  const privateKey = useUserStore((s) => s.privateKey)
  const signer = useUserStore((s) => s.signer)
  const pubkey = useUserStore((s) => s.pubkey)
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const hubs = useHubStore((s) => s.hubs)
  const hubPrefs = useHubStore((s) => hubDTag ? s.hubPrefs[hubDTag] : undefined)

  const getChannelKey = useCallback((): Uint8Array | null => {
    if (!hubDTag || !channelId) return null
    const hub = hubs[hubDTag]
    if (!hub) return null

    // A group/private channel (or a synced channel under an encrypted category) is keyed by its GROUP
    // secret + group epoch — NOT the hub-wide secret. Using the hub secret here would let any hub
    // member (not just the group) decrypt the poll/votes. Mirror useMessages' getChannelKey.
    const channel = hub.channels?.find((c) => c.channelId === channelId)
    let groupId: string | undefined
    if (channel?.encryption) groupId = channel.encryption
    else if (channel?.synced && channel.categoryId) {
      const cat = hub.categories?.find((c) => c.categoryId === channel.categoryId)
      if (cat?.encryption) groupId = cat.encryption
    }

    let secretHex: string | undefined
    let epoch: number
    if (groupId) {
      epoch = hub.groupedRoles?.find((g) => g.groupId === groupId)?.epoch || 1
      secretHex = useHubStore.getState().groupSecrets[hubDTag]?.[groupId]
    } else {
      epoch = hub.epoch || 1
      secretHex = hubSecrets[hubDTag]
    }
    if (!secretHex) return null

    const secret = new Uint8Array(secretHex.length / 2)
    for (let i = 0; i < secretHex.length; i += 2) {
      secret[i / 2] = parseInt(secretHex.substring(i, i + 2), 16)
    }
    return deriveChannelKey(secret, channelId, epoch)
  }, [hubDTag, channelId, hubSecrets, hubs])

  // Epoch to STAMP on an outgoing poll/vote. Group channels rotate on their own epoch counter, which
  // is what getChannelKey() encrypts with — stamping hub.epoch instead risks a reader deriving the
  // wrong key when the group- and hub-epoch integer values collide. Mirror useMessages' getChannelEpoch.
  const getChannelEpoch = useCallback((): number => {
    if (!hubDTag || !channelId) return 1
    const hub = hubs[hubDTag]
    if (!hub) return 1
    const channel = hub.channels?.find((c) => c.channelId === channelId)
    let groupId: string | undefined
    if (channel?.encryption) groupId = channel.encryption
    else if (channel?.synced && channel.categoryId) {
      const cat = hub.categories?.find((c) => c.categoryId === channel.categoryId)
      if (cat?.encryption) groupId = cat.encryption
    }
    if (groupId) return hub.groupedRoles?.find((g) => g.groupId === groupId)?.epoch || 1
    return hub.epoch || 1
  }, [hubDTag, channelId, hubs])

  const createPoll = useCallback(async (data: PollCreationData) => {
    if (!hubDTag || !channelId || (!signer && !privateKey)) return

    const key = getChannelKey()
    const plaintext = JSON.stringify({
      text: data.text,
      options: data.options,
      polltype: data.polltype,
      allowVoteChange: data.allowVoteChange,
      showResultsBeforeVoting: data.showResultsBeforeVoting,
      showVoterIdentity: data.showVoterIdentity,
      ...(data.endsAt ? { endsAt: data.endsAt } : {}),
    })

    let content = plaintext
    if (key) {
      content = await aesEncrypt(key, plaintext)
    }

    const hub = hubs[hubDTag]
    const minPow = hub?.minPow || 0

    // Only a genuinely-facilitated (non-member) author tags a poll with `facilitator`.
    // Guard against a stale `facilitator` pref leaking onto a member/creator's own poll.
    // The roster keys members by real key R in BOTH versions, so `pubkey (R) ∈ members`
    // (or creator/owner) is the correct membership check for v1 and v2. (Mirrors useMessages.)
    let facilitator = hubPrefs?.facilitator || undefined
    if (facilitator && hub) {
      const members = useHubStore.getState().hubMembers[hubDTag]
      const amMember = pubkey === hub.creatorPubkey || pubkey === hub.ownerRealPubkey
        || !!members?.some((m) => m.pubkey === pubkey)
      if (amMember) facilitator = undefined
    }

    const stampEpoch = getChannelEpoch()
    let unsigned = createPollEvent(content, hubDTag, channelId, stampEpoch, facilitator)

    if (isClientTagEnabled()) {
      unsigned = { ...unsigned, tags: [...unsigned.tags, ['client', 'DEN Chat']] }
    }

    stampHubExpiration(unsigned, hubDTag)
    const signed = await (hub
      ? signHubMemberEvent({ hub, unsigned, pubkey: pubkey!, privateKey, signer, minPow, channelKey: key })
      : mineAndSign(unsigned, minPow, pubkey, signer, privateKey))

    const hubRelays = hub?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays, { hubOnly: !!hub && isV2(hub) })
    await publishEventProgressive(signed, () => {}, publishRelays)

    // Add to local store immediately
    usePollStore.getState().addPoll({
      id: signed.id,
      pubkey: signed.pubkey,
      hubDTag,
      channelId,
      createdAt: signed.created_at,
      epoch: stampEpoch,
      content: signed.content,
      facilitator,
      rawEvent: JSON.stringify(signed),
    })
  }, [hubDTag, channelId, signer, privateKey, pubkey, hubs, hubPrefs, getChannelKey])

  const castVote = useCallback(async (pollEventId: string, selectedOptionIds: string[]) => {
    if (!hubDTag || !channelId || (!signer && !privateKey)) return

    const key = getChannelKey()
    const plaintext = JSON.stringify({ response: selectedOptionIds })

    let content = plaintext
    if (key) {
      content = await aesEncrypt(key, plaintext)
    }

    const hub = hubs[hubDTag]
    const minPow = hub?.minPow || 0

    let unsigned = createVoteEvent(content, pollEventId, hubDTag, channelId, getChannelEpoch())

    // Facilitated (non-member) voters carry a `facilitator` tag so their vote resolves to the
    // right leaf, same as messages. Guard against a stale pref on a member/creator (mirrors
    // useMessages ~608 + createPoll above). createVoteEvent has no facilitator param, so the
    // tag is appended here.
    if (hub) {
      let facilitator = hubPrefs?.facilitator || undefined
      if (facilitator) {
        const members = useHubStore.getState().hubMembers[hubDTag]
        const amMember = pubkey === hub.creatorPubkey || pubkey === hub.ownerRealPubkey
          || !!members?.some((m) => m.pubkey === pubkey)
        if (amMember) facilitator = undefined
      }
      if (facilitator) {
        unsigned = { ...unsigned, tags: [...unsigned.tags, ['facilitator', facilitator]] }
      }
    }

    stampHubExpiration(unsigned, hubDTag)
    const signed = await (hub
      ? signHubMemberEvent({ hub, unsigned, pubkey: pubkey!, privateKey, signer, minPow, channelKey: key })
      : mineAndSign(unsigned, minPow, pubkey, signer, privateKey))

    const hubRelays = hub?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays, { hubOnly: !!hub && isV2(hub) })
    await publishEventProgressive(signed, () => {}, publishRelays)

    // Add to local store immediately
    usePollStore.getState().addVote({
      id: signed.id,
      pubkey: signed.pubkey,
      pollEventId,
      createdAt: signed.created_at,
      content: signed.content,
      rawEvent: JSON.stringify(signed),
    })
  }, [hubDTag, channelId, signer, privateKey, pubkey, hubs, hubPrefs, getChannelKey])

  return { createPoll, castVote }
}
