/**
 * GroupChatView: the right pane of the DM page's Groups section (NIP-CHAT §21).
 *
 * A group is registered in the hub store as a single-channel hub (channel id = its d-tag), so the
 * chat itself IS <ChannelView hideHeader /> pointed at it. This component owns the group header
 * (face, member count, creator actions) and the store's active hub/channel while it is mounted -
 * set directly (not via setActiveHub, which persists "last active hub" for the hub sidebar) and
 * restored on unmount so leaving the DM page never leaves a group selected on the Hubs page.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Users, Lock, Loader2, AlertTriangle, MoreVertical } from 'lucide-react'
import { useHubStore } from '@/stores/hubStore'
import { useGroupStore } from '@/stores/groupStore'
import { useUserStore } from '@/stores/userStore'
import { ChannelView } from '@/components/hub/ChannelView'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { GroupMembersModal } from '@/components/group/GroupMembersModal'
import { GroupMenu } from '@/components/group/GroupMenu'

export function GroupChatView({ dTag, onBack }: { dTag: string; onBack?: () => void }) {
  const hub = useHubStore((s) => s.hubs[dTag])
  const members = useHubStore((s) => s.hubMembers[dTag])
  const status = useGroupStore((s) => s.status[dTag])
  const myPubkey = useUserStore((s) => s.pubkey)
  const [showMembers, setShowMembers] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const menuAnchorRef = useRef<HTMLButtonElement>(null)

  // Point the hub store at this group while mounted; restore whatever was active before.
  useEffect(() => {
    const prev = { hub: useHubStore.getState().activeHubId, channel: useHubStore.getState().activeChannelId }
    useHubStore.setState({ activeHubId: dTag, activeChannelId: dTag })
    return () => {
      const cur = useHubStore.getState()
      if (cur.activeHubId === dTag) useHubStore.setState({ activeHubId: prev.hub, activeChannelId: prev.channel })
    }
  }, [dTag])

  const isCreator = !!hub && !!myPubkey && (hub.creatorPubkey === myPubkey || hub.ownerRealPubkey === myPubkey)
  const name = hub?.name || 'Group'
  const count = members?.length ?? 0

  const blocked =
    status === 'removed' ? 'You were removed from this group. Its messages stay readable up to that point.'
    : status === 'deleted' ? 'The creator deleted this group.'
    : status === 'unsupported' ? 'This is a private group. It needs the DEN Chat client or a NIP-SKD signer.'
    : status === 'not-found' ? 'This group could not be found on its relays.'
    : status === 'error' ? 'This group failed to load.'
    : null

  return (
    <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden relative gap-2">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-secondary/50 rounded-md shadow-md shrink-0">
        {onBack && (
          <button onClick={onBack} className="hidden max-[1080px]:flex p-1.5 -ml-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer shrink-0">
            <ChevronLeft size={18} />
          </button>
        )}
        <Avatar className="h-8 w-8 rounded-lg">
          {hub?.icon && <AvatarImage src={hub.icon} />}
          <AvatarFallback className="text-xs bg-primary/20 text-primary rounded-lg">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground truncate flex items-center gap-1.5">
            {hub?.version === 2 && <Lock size={11} className="text-emerald-400 shrink-0" />}
            {name}
          </p>
          <p className="text-[10px] text-muted-foreground truncate">
            {hub?.version === 2 ? 'Private group' : 'Group'}{hub?.description ? ` · ${hub.description}` : ''}
          </p>
        </div>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setShowMembers(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 border border-border/50 transition-colors cursor-pointer shrink-0"
              >
                <Users size={12} /> {count}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Members{isCreator ? ' (add or remove)' : ''}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={menuAnchorRef}
                onClick={() => setShowMenu((v) => !v)}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer shrink-0"
              >
                <MoreVertical size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Group options</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Body */}
      {!hub || status === 'loading' || !status ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <Loader2 size={16} className="animate-spin mr-2" /> <span className="text-xs">Loading group…</span>
        </div>
      ) : blocked ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-sm text-center space-y-2">
            <AlertTriangle size={22} className="mx-auto text-amber-400" />
            <p className="text-sm text-muted-foreground leading-relaxed">{blocked}</p>
          </div>
        </div>
      ) : (
        <ChannelView hideHeader />
      )}

      {showMembers && hub && <GroupMembersModal dTag={dTag} isCreator={isCreator} onClose={() => setShowMembers(false)} />}
      {showMenu && hub && <GroupMenu dTag={dTag} isCreator={isCreator} anchorRef={menuAnchorRef} onClose={() => setShowMenu(false)} />}
    </div>
  )
}
