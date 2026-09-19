/**
 * GroupInviteCard: a kind-36950 group address (naddr) shared in chat / social renders as its face
 * with Join (opens the invite flow) or Open (already in your list). The address is the invite (§21.6).
 */
import { useState } from 'react'
import { nip19 } from 'nostr-tools'
import { Users, Lock, Loader2 } from 'lucide-react'
import { useCachedFetch } from '@/hooks/useCachedFetch'
import { KINDS } from '@/lib/crypto/constants'
import { fetchGroupEvent } from '@/hooks/useGroupLoader'
import { parseGroupEvent, type GroupData } from '@/lib/group/groupEvent'
import { useGroupStore } from '@/stores/groupStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { JoinGroupModal } from '@/components/group/JoinGroupModal'

export function GroupInviteCard({ identifier, pubkey, relays }: { identifier: string; pubkey: string; relays?: string[] }) {
  const relayKey = (relays || []).join('|')
  const { data: group, loading } = useCachedFetch<GroupData>(`36950:${pubkey}:${identifier}|${relayKey}`, async () => {
    const ev = await fetchGroupEvent(pubkey, identifier, relays?.[0])
    const g = ev ? parseGroupEvent(ev) : null
    return g && !g.deleted ? g : null
  })
  const inList = useGroupStore((s) => s.entries.some((e) => e.dTag === identifier))
  const [showJoin, setShowJoin] = useState(false)
  const naddr = nip19.naddrEncode({ identifier, pubkey, kind: KINDS.GROUP_EVENT, relays: relays || [] })

  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 flex items-center gap-2 text-xs text-muted-foreground max-w-[350px]">
        <Loader2 size={12} className="animate-spin" /> Loading group...
      </div>
    )
  }
  if (!group) {
    return (
      <span className="inline-flex items-center gap-1.5 my-1 px-2 py-1 rounded-md border border-border text-xs text-muted-foreground">
        <Users size={12} /> Group not found
      </span>
    )
  }

  const open = () => {
    useGroupStore.getState().requestOpenGroup(identifier)
    useNavigationStore.getState().setActivePage('dms')
  }

  return (
    <>
      <div className="my-2 rounded-lg border border-border overflow-hidden bg-secondary/10 hover:bg-secondary/20 transition-colors max-w-[350px]">
        {group.banner && (
          <div className="h-20 overflow-hidden">
            <img src={group.banner} alt="" className="w-full h-full object-cover" loading="lazy" />
          </div>
        )}
        <div className="p-3 space-y-2">
          <div className="flex items-center gap-2.5">
            <Avatar className="h-9 w-9 rounded-lg shrink-0">
              {group.picture && <AvatarImage src={group.picture} />}
              <AvatarFallback className="text-xs bg-primary/20 text-primary rounded-lg">{group.name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground truncate flex items-center gap-1.5">
                {group.version === 2 ? <Lock size={11} className="text-emerald-400 shrink-0" /> : <Users size={11} className="text-primary shrink-0" />}
                {group.name}
              </p>
              <p className="text-[10px] text-muted-foreground">{group.version === 2 ? 'Private group' : 'Group'} · invite</p>
            </div>
          </div>
          {group.about && <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{group.about}</p>}
          <button
            onClick={inList ? open : () => setShowJoin(true)}
            className="w-full py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
          >
            {inList ? 'Open group' : 'Join group'}
          </button>
        </div>
      </div>
      {showJoin && (
        <JoinGroupModal
          initialAddress={naddr}
          onClose={() => setShowJoin(false)}
          onJoined={() => open()}
        />
      )}
    </>
  )
}
