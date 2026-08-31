import { create } from 'zustand'
import { fetchEvents, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { publishPersonal, getPublishRelays } from '@/stores/postingBehaviourStore'
import { signWithSigner } from '@/lib/nostr/events'
import { encryptNip04, decryptNip04 } from '@/lib/nostr/nip04dm'
import type { ISigner } from '@/stores/userStore'

/* ─── NIP-51 Mute/Block List (kind 10000) ─── */

export type BlockType = 'public' | 'private'

export interface BlockState {
  /** All blocked pubkeys — Set for backward compat with all consumers (.has()) */
  blockedPubkeys: Set<string>
  /** Block type per pubkey — 'public' = in plaintext tags, 'private' = encrypted */
  blockTypes: Map<string, BlockType>
  mutedWords: Set<string>
  /** Tags we don't recognise — preserved so we never lose data from other clients */
  otherTags: string[][]
  hideBlockedCompletely: boolean
  loaded: boolean

  loadBlockList: (pubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  blockUser: (pubkey: string, myPubkey: string, signer: ISigner | null, privateKey: string | null, blockType: BlockType) => Promise<void>
  unblockUser: (pubkey: string, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  /** Change a block from public↔private without unblocking */
  changeBlockType: (pubkey: string, newType: BlockType, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  setHideBlockedCompletely: (hide: boolean) => void
  isBlocked: (pubkey: string) => boolean
  /** Get the block type for a pubkey, or undefined if not blocked */
  getBlockType: (pubkey: string) => BlockType | undefined

  /** Add a single muted word and publish */
  addMutedWord: (word: string, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  /** Remove a single muted word and publish */
  removeMutedWord: (word: string, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  /** Bulk-set muted words (from the settings modal Save button) and publish */
  setMutedWords: (words: string[], myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  /** Check if a word is muted */
  isWordMuted: (word: string) => boolean
}

/**
 * Publish a kind 10000 mute list with public/private block separation.
 *
 * Public blocks → plaintext `tags` array (visible to WoT/relays)
 * Private blocks → encrypted `content` (only visible to self)
 * Muted words + other tags → always encrypted in content
 */
async function publishMuteList(
  blockTypes: Map<string, BlockType>,
  mutedWords: Set<string>,
  otherTags: string[][],
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
) {
  // Split blocks into public and private
  const publicBlocks: string[] = []
  const privateBlocks: string[] = []
  for (const [pk, type] of blockTypes) {
    if (type === 'public') publicBlocks.push(pk)
    else privateBlocks.push(pk)
  }

  // Public tags — only public blocks
  const publicTags: string[][] = publicBlocks.map((pk) => ['p', pk])

  // Private tags (encrypted in content) — private blocks + muted words + other tags
  const privateTags: string[][] = [
    ...privateBlocks.map((pk) => ['p', pk]),
    ...Array.from(mutedWords).map((w) => ['word', w]),
    ...otherTags,
  ]

  const encrypted = await encryptNip04(
    JSON.stringify(privateTags),
    myPubkey,
    signer,
    privateKey,
  )

  const unsigned = {
    kind: 10000,
    pubkey: myPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: publicTags,
    content: encrypted,
  }

  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishPersonal(signed)
}

export const useBlockStore = create<BlockState>((set, get) => ({
  blockedPubkeys: new Set(),
  blockTypes: new Map(),
  mutedWords: new Set(),
  otherTags: [],
  hideBlockedCompletely: localStorage.getItem('den_hide_blocked_completely') === 'true',
  loaded: false,

  loadBlockList: async (pubkey, signer, privateKey) => {
    try {
      const events = await fetchEvents({
        kinds: [10000],
        authors: [pubkey],
        limit: 1,
      })

      if (events.length === 0) {
        set({ loaded: true })
        return
      }

      const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
      const blocked = new Set<string>()
      const types = new Map<string, BlockType>()
      const words = new Set<string>()
      const other: string[][] = []

      // Parse public tags — these are public blocks
      for (const tag of latest.tags) {
        if (tag[0] === 'p' && tag[1]) {
          blocked.add(tag[1])
          types.set(tag[1], 'public')
        } else if (tag[0] === 'word' && tag[1]) {
          words.add(tag[1].toLowerCase())
        } else if (tag.length >= 2) {
          other.push(tag)
        }
      }

      // Decrypt and parse private tags from content
      if (latest.content) {
        try {
          const decrypted = await decryptNip04(latest.content, pubkey, signer, privateKey)
          const privateTags: string[][] = JSON.parse(decrypted)
          for (const tag of privateTags) {
            if (tag[0] === 'p' && tag[1]) {
              blocked.add(tag[1])
              // Only set as private if not already marked public
              // (public takes precedence if somehow in both)
              if (!types.has(tag[1])) {
                types.set(tag[1], 'private')
              }
            } else if (tag[0] === 'word' && tag[1]) {
              words.add(tag[1].toLowerCase())
            } else if (tag.length >= 2) {
              other.push(tag)
            }
          }
        } catch (err) {
          console.warn('[blockStore] Failed to decrypt mute list content:', err)
        }
      }

      set({ blockedPubkeys: blocked, blockTypes: types, mutedWords: words, otherTags: other, loaded: true })
    } catch (err) {
      console.error('[blockStore] Failed to load block list:', err)
      set({ loaded: true })
    }
  },

  blockUser: async (pubkey, myPubkey, signer, privateKey, blockType) => {
    const blocked = new Set(get().blockedPubkeys)
    const types = new Map(get().blockTypes)
    blocked.add(pubkey)
    types.set(pubkey, blockType)
    set({ blockedPubkeys: blocked, blockTypes: types })

    try {
      await publishMuteList(types, get().mutedWords, get().otherTags, myPubkey, signer, privateKey)
    } catch (err) {
      console.error('[blockStore] Failed to publish block:', err)
      // Revert on failure
      blocked.delete(pubkey)
      types.delete(pubkey)
      set({ blockedPubkeys: new Set(blocked), blockTypes: new Map(types) })
    }
  },

  unblockUser: async (pubkey, myPubkey, signer, privateKey) => {
    const blocked = new Set(get().blockedPubkeys)
    const types = new Map(get().blockTypes)
    const prevType = types.get(pubkey)
    blocked.delete(pubkey)
    types.delete(pubkey)
    set({ blockedPubkeys: blocked, blockTypes: types })

    try {
      await publishMuteList(types, get().mutedWords, get().otherTags, myPubkey, signer, privateKey)
    } catch (err) {
      console.error('[blockStore] Failed to publish unblock:', err)
      // Revert on failure
      blocked.add(pubkey)
      if (prevType) types.set(pubkey, prevType)
      set({ blockedPubkeys: new Set(blocked), blockTypes: new Map(types) })
    }
  },

  changeBlockType: async (pubkey, newType, myPubkey, signer, privateKey) => {
    if (!get().blockedPubkeys.has(pubkey)) return
    const types = new Map(get().blockTypes)
    const prevType = types.get(pubkey)
    types.set(pubkey, newType)
    set({ blockTypes: types })

    try {
      await publishMuteList(types, get().mutedWords, get().otherTags, myPubkey, signer, privateKey)
    } catch (err) {
      console.error('[blockStore] Failed to change block type:', err)
      // Revert on failure
      const reverted = new Map(get().blockTypes)
      if (prevType) reverted.set(pubkey, prevType)
      else reverted.delete(pubkey)
      set({ blockTypes: reverted })
    }
  },

  setHideBlockedCompletely: (hide) => {
    localStorage.setItem('den_hide_blocked_completely', String(hide))
    set({ hideBlockedCompletely: hide })
  },

  isBlocked: (pubkey) => get().blockedPubkeys.has(pubkey),

  getBlockType: (pubkey) => get().blockTypes.get(pubkey),

  addMutedWord: async (word, myPubkey, signer, privateKey) => {
    const w = word.trim().toLowerCase()
    if (!w) return
    const words = new Set(get().mutedWords)
    words.add(w)
    set({ mutedWords: words })

    try {
      await publishMuteList(get().blockTypes, words, get().otherTags, myPubkey, signer, privateKey)
    } catch (err) {
      console.error('[blockStore] Failed to publish muted word:', err)
      words.delete(w)
      set({ mutedWords: new Set(words) })
    }
  },

  removeMutedWord: async (word, myPubkey, signer, privateKey) => {
    const w = word.trim().toLowerCase()
    const words = new Set(get().mutedWords)
    words.delete(w)
    set({ mutedWords: words })

    try {
      await publishMuteList(get().blockTypes, words, get().otherTags, myPubkey, signer, privateKey)
    } catch (err) {
      console.error('[blockStore] Failed to publish muted word removal:', err)
      words.add(w)
      set({ mutedWords: new Set(words) })
    }
  },

  setMutedWords: async (wordList, myPubkey, signer, privateKey) => {
    const words = new Set(wordList.map((w) => w.trim().toLowerCase()).filter(Boolean))
    const prev = get().mutedWords
    set({ mutedWords: words })

    try {
      await publishMuteList(get().blockTypes, words, get().otherTags, myPubkey, signer, privateKey)
    } catch (err) {
      console.error('[blockStore] Failed to publish muted words:', err)
      set({ mutedWords: prev })
    }
  },

  isWordMuted: (word) => get().mutedWords.has(word.toLowerCase()),
}))
