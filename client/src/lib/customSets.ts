/**
 * Resolve a human display name for an emoji / sticker / gif set from its
 * "<kind>:<pubkey>:<dtag>" address.
 *
 * Prefers the locally-known set's `title`; falls back to de-slugging a legacy
 * slug d-tag, or a neutral label for the UUIDv4 d-tags used by newer sets that
 * aren't loaded locally (so we never render a raw UUID at the user).
 */

import { useEmojiStore } from '@/stores/emojiStore'
import { useStickerStore } from '@/stores/stickerStore'
import { useGifStore } from '@/stores/gifStore'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function setNameFromAddress(address: string): string {
  const parts = address.split(':')
  const pubkey = parts[1]
  const dTag = parts.slice(2).join(':')

  const match = (s: { pubkey: string; dTag: string }) => s.pubkey === pubkey && s.dTag === dTag
  const emoji = useEmojiStore.getState()
  const sticker = useStickerStore.getState()
  const gif = useGifStore.getState()
  const found =
    emoji.myEmojiSets.find(match) || emoji.subscribedSets.find(match) ||
    sticker.myStickerSets.find(match) || sticker.subscribedSets.find(match) ||
    gif.myGifCollections.find(match) || gif.subscribedCollections.find(match)

  if (found?.name) return found.name
  return UUID_RE.test(dTag) ? 'a custom set' : dTag.replace(/[-_]/g, ' ')
}
