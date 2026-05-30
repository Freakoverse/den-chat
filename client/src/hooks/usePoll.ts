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
    const secretHex = hubSecrets[hubDTag]
    if (!secretHex) return null

    const secret = new Uint8Array(secretHex.length / 2)
    for (let i = 0; i < secretHex.length; i += 2) {
      secret[i / 2] = parseInt(secretHex.substring(i, i + 2), 16)
    }

    const hub = hubs[hubDTag]
    const epoch = hub?.epoch || 1
    return deriveChannelKey(secret, channelId, epoch)
  }, [hubDTag, channelId, hubSecrets, hubs])

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
    const facilitator = hubPrefs?.facilitator || undefined

    let unsigned = createPollEvent(content, hubDTag, channelId, hub?.epoch || 1, facilitator)

    if (isClientTagEnabled()) {
      unsigned = { ...unsigned, tags: [...unsigned.tags, ['client', 'DEN Chat']] }
    }

    const signed = await mineAndSign(unsigned, minPow, pubkey, signer, privateKey)

    const hubRelays = hub?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays)
    await publishEventProgressive(signed, () => {}, publishRelays)

    // Add to local store immediately
    usePollStore.getState().addPoll({
      id: signed.id,
      pubkey: signed.pubkey,
      hubDTag,
      channelId,
      createdAt: signed.created_at,
      epoch: hub?.epoch || 1,
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

    let unsigned = createVoteEvent(content, pollEventId, hubDTag, channelId, hub?.epoch || 1)

    const signed = await mineAndSign(unsigned, minPow, pubkey, signer, privateKey)

    const hubRelays = hub?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays)
    await publishEventProgressive(signed, () => {}, publishRelays)

    // Add to local store immediately
    usePollStore.getState().addVote({
      id: signed.id,
      pubkey: signed.pubkey,
      pollEventId,
      createdAt: signed.created_at,
      content: signed.content,
    })
  }, [hubDTag, channelId, signer, privateKey, pubkey, hubs, getChannelKey])

  return { createPoll, castVote }
}
