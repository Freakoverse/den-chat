/**
 * Shared helpers for the hub "dedicated relay / Blossom server" marker (NIP-CHAT 6.1.1): a server the hub
 * operates itself for reliable retention, flagged with a `dedicated` element on the r/o tag.
 */

/** A relay/server is dedicated when any element after the URL equals `dedicated`. */
export function isDedicatedTag(tag: string[]): boolean {
  return tag.slice(2).includes('dedicated')
}

/** Tooltip copy for the "Dedicated" badge, accurate to which servers the hub actually operates. */
export function dedicatedTooltip(relay: boolean, blossom: boolean): string {
  if (relay && blossom) return "This hub runs its own dedicated relay and Blossom server, so its message history, media, and vital hub files (the member list, structure, and key material) are reliably retained rather than left on shared public servers."
  if (relay) return "This hub runs its own dedicated relay, so its message history is reliably retained rather than left on shared public relays. (No dedicated Blossom server, so its media and vital hub files like the member list and structure rely on shared servers.)"
  return "This hub runs its own dedicated Blossom server, so its media and vital hub files (the member list, structure, and key material) are reliably retained rather than left on shared servers. (No dedicated relay, so its message history relies on shared relays.)"
}
