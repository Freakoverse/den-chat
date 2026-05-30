/**
 * pollStore — State management for NIP-88 polls in hub channels
 *
 * Polls (kind 1067) are stored separately from messages.
 * Votes (kind 1017) are fetched on-demand when a poll card mounts.
 */

import { create } from 'zustand'
import { subscribeToRelays } from '@/lib/nostr/relay-pool'
import { useHubStore } from '@/stores/hubStore'
import { KINDS } from '@/lib/crypto/constants'
import type { Event } from 'nostr-tools'

export interface PollOption {
  id: string
  label: string
}

export interface RawPoll {
  id: string
  pubkey: string
  hubDTag: string
  channelId: string
  createdAt: number
  epoch: number
  /** Raw encrypted content — decrypted client-side */
  content: string
  facilitator?: string
  /** Raw event JSON for View Raw Event */
  rawEvent?: string
}

export interface VoteData {
  id: string
  pubkey: string
  pollEventId: string
  createdAt: number
  /** Raw encrypted content — decrypted client-side */
  content: string
}

interface PollStore {
  /** polls[hubDTag][channelId] → RawPoll[] */
  polls: Record<string, Record<string, RawPoll[]>>
  /** votes[pollEventId] → VoteData[] (raw, dedup'd by pubkey keeping latest) */
  votes: Record<string, VoteData[]>
  /** Track which polls have had votes fetched */
  voteFetchStatus: Record<string, 'idle' | 'loading' | 'done'>

  addPoll: (poll: RawPoll) => void
  addVote: (vote: VoteData) => void
  fetchVotes: (pollEventId: string, hubDTag: string, pollCreatedAt: number, endsAt?: number) => Promise<void>
}

export function parsePollEvent(event: Event): RawPoll | null {
  const hubDTag = event.tags.find((t) => t[0] === 'h')?.[1]
  const channelId = event.tags.find((t) => t[0] === 'c')?.[1]
  const epochStr = event.tags.find((t) => t[0] === 'epoch')?.[1]
  const facilitatorTag = event.tags.find((t) => t[0] === 'facilitator')?.[1]

  if (!hubDTag || !channelId) return null

  return {
    id: event.id,
    pubkey: event.pubkey,
    hubDTag,
    channelId,
    createdAt: event.created_at,
    epoch: epochStr ? parseInt(epochStr, 10) : 1,
    content: event.content,
    facilitator: facilitatorTag,
    rawEvent: JSON.stringify(event),
  }
}

export function parseVoteEvent(event: Event): VoteData | null {
  const pollEventId = event.tags.find((t) => t[0] === 'e')?.[1]
  if (!pollEventId) return null

  return {
    id: event.id,
    pubkey: event.pubkey,
    pollEventId,
    createdAt: event.created_at,
    content: event.content,
  }
}

export const usePollStore = create<PollStore>((set, get) => ({
  polls: {},
  votes: {},
  voteFetchStatus: {},

  addPoll: (poll) => {
    set((state) => {
      const hubPolls = state.polls[poll.hubDTag] || {}
      const channelPolls = hubPolls[poll.channelId] || []

      // Deduplicate by event ID
      if (channelPolls.some((p) => p.id === poll.id)) return state

      return {
        polls: {
          ...state.polls,
          [poll.hubDTag]: {
            ...hubPolls,
            [poll.channelId]: [...channelPolls, poll].sort((a, b) => a.createdAt - b.createdAt),
          },
        },
      }
    })
  },

  addVote: (vote) => {
    set((state) => {
      const existing = state.votes[vote.pollEventId] || []

      // Deduplicate by pubkey — keep the one with latest createdAt
      const filtered = existing.filter((v) => {
        if (v.pubkey !== vote.pubkey) return true
        return v.createdAt > vote.createdAt // keep existing if it's newer
      })

      // Only add if no newer vote from same pubkey exists
      const dominated = existing.some((v) => v.pubkey === vote.pubkey && v.createdAt > vote.createdAt)
      if (dominated) return state

      // Also remove if same event ID already present
      const deduped = filtered.filter((v) => v.id !== vote.id)

      return {
        votes: {
          ...state.votes,
          [vote.pollEventId]: [...deduped, vote],
        },
      }
    })
  },

  fetchVotes: async (pollEventId, hubDTag, pollCreatedAt, endsAt) => {
    const status = get().voteFetchStatus[pollEventId]
    if (status === 'loading' || status === 'done') return

    set((state) => ({
      voteFetchStatus: { ...state.voteFetchStatus, [pollEventId]: 'loading' },
    }))

    const hubs = useHubStore.getState().hubs
    const hub = hubs[hubDTag]
    if (!hub) {
      set((state) => ({
        voteFetchStatus: { ...state.voteFetchStatus, [pollEventId]: 'done' },
      }))
      return
    }

    const relays = [...new Set([...hub.generalRelays, ...hub.filterRelays])].filter(Boolean)
    if (relays.length === 0) {
      set((state) => ({
        voteFetchStatus: { ...state.voteFetchStatus, [pollEventId]: 'done' },
      }))
      return
    }

    const addVote = get().addVote

    return new Promise<void>((resolve) => {
      const filter: Record<string, any> = {
        kinds: [KINDS.POLL_VOTE],
        '#e': [pollEventId],
        since: pollCreatedAt,
      }
      if (endsAt) {
        filter.until = endsAt
      }

      const sub = subscribeToRelays(
        relays,
        filter,
        (event: Event) => {
          const vote = parseVoteEvent(event)
          if (vote) addVote(vote)
        },
        () => {
          sub.close()
          set((state) => ({
            voteFetchStatus: { ...state.voteFetchStatus, [pollEventId]: 'done' },
          }))
          resolve()
        }
      )

      // Safety timeout
      setTimeout(() => {
        sub.close()
        set((state) => ({
          voteFetchStatus: { ...state.voteFetchStatus, [pollEventId]: 'done' },
        }))
        resolve()
      }, 15000)
    })
  },
}))
