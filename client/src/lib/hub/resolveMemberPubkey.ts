/**
 * resolveMemberPubkey — map a wire pubkey to the member's real key `R`.
 *
 * On a v2 hub the wire pubkey is the member pseudonym `P` (the author of calendar
 * events + RSVPs, and the leaf id in the roster tree). The roster keys members by
 * their real key `R` in `m.pubkey` and their pseudonym `P` in `m.p`, so we resolve
 * `m.p === pk → m.pubkey`.
 *
 * Falls back to `pk` unchanged for:
 *   - v1 hubs, where the wire key already IS `R` and no roster entry carries a `p`;
 *   - a facilitated author (`Pf`) with no roster entry — degrades to an npub, no crash.
 *
 * Mirrors the same-page roster fallback in `useVoiceDisplayPubkey`.
 */

import type { HubMember } from '@/stores/hubStore'

export function resolveMemberPubkey(
  pk: string,
  members: HubMember[] | undefined
): string {
  return members?.find((m) => m.p === pk)?.pubkey ?? pk
}
