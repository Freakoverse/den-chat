/**
 * groupInvite: hand a member the group address by DM, the way the hub invite modal does (NIP-04,
 * the widely supported DM kind). §21.6 leaves the transport to the client; the address is not a
 * secret, membership is gated by the tree. Sends one DM per recipient, keeps going on failures.
 */
import { useUserStore } from '@/stores/userStore'
import { useDM04Store } from '@/stores/dm04Store'
import { useGroupStore } from '@/stores/groupStore'
import { groupInviteAddress } from '@/lib/group/groupOps'

export function groupInviteText(dTag: string): string | null {
  const g = useGroupStore.getState().groups[dTag]
  if (!g) return null
  return `Join this DEN Chat group:\n${groupInviteAddress(g)}`
}

/** DM the group address to each pubkey. Resolves with the ones that failed (empty = all sent). */
export async function sendGroupInviteDMs(dTag: string, recipients: string[]): Promise<string[]> {
  const { pubkey, signer, privateKey } = useUserStore.getState()
  if (!pubkey) throw new Error('Not logged in')
  const text = groupInviteText(dTag)
  if (!text) throw new Error('Group not loaded')
  const failed: string[] = []
  for (const to of recipients) {
    if (to === pubkey) continue
    try {
      await useDM04Store.getState().sendMessage(to, text, pubkey, signer, privateKey)
    } catch (err) {
      console.warn('[Groups] invite DM failed:', to.slice(0, 8), err)
      failed.push(to)
    }
  }
  return failed
}
