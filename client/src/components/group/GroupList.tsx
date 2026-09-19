/**
 * GroupList — the Groups section of the DM page's left panel (NIP-CHAT §21).
 * Lists the user's groups (kind-16943 entries) with the loaded face from the hub store, unread
 * count, and a status pill for anything that isn't a normal loaded group.
 */
import { Loader2, Plus, Link2, Users, Lock, AlertTriangle } from 'lucide-react'
import { useGroupStore, type GroupStatus } from '@/stores/groupStore'
import { useHubStore } from '@/stores/hubStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const STATUS_LABEL: Partial<Record<GroupStatus, string>> = {
  loading: 'Loading…',
  'not-found': 'Not found on relays',
  removed: 'You were removed',
  deleted: 'Deleted by the creator',
  unsupported: 'Needs a NIP-SKD signer',
  error: 'Failed to load',
}

export function GroupList({ activeDTag, onSelect, onCreate, onJoin }: {
  activeDTag: string | null
  onSelect: (dTag: string) => void
  onCreate: () => void
  onJoin: () => void
}) {
  const entries = useGroupStore((s) => s.entries)
  const listLoaded = useGroupStore((s) => s.listLoaded)
  const status = useGroupStore((s) => s.status)
  const hubs = useHubStore((s) => s.hubs)
  const members = useHubStore((s) => s.hubMembers)
  const unreads = useNotificationStore((s) => s.hubUnreads)

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2 p-2 rounded-md bg-secondary/50 shadow-md">
      <div className="flex items-center gap-1.5 shrink-0">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onCreate}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/15 transition-colors cursor-pointer"
              >
                <Plus size={13} /> New group
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Create a group — up to 100 people, one conversation</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onJoin}
                className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
              >
                <Link2 size={13} /> Invite
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Paste a group address someone sent you</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {!listLoaded ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 size={16} className="animate-spin mr-2" />
            <span className="text-xs">Loading groups...</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-center px-4">
            <Users size={20} className="text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              No groups yet. Create one, or paste an invite address someone sent you.
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {entries.map((entry) => {
              const hub = hubs[entry.dTag]
              const st = status[entry.dTag]
              const name = hub?.name || 'Group'
              const count = members[entry.dTag]?.length ?? 0
              const unread = unreads[entry.dTag]?.[entry.dTag]
              const isActive = activeDTag === entry.dTag
              const problem = st && st !== 'loaded' ? STATUS_LABEL[st] : null
              return (
                <button
                  key={entry.dTag}
                  onClick={() => onSelect(entry.dTag)}
                  className={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg transition-colors cursor-pointer text-left
                    ${isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-secondary/60 border border-transparent'}`}
                >
                  <Avatar className="h-9 w-9 shrink-0 rounded-lg">
                    {hub?.icon && <AvatarImage src={hub.icon} />}
                    <AvatarFallback className="text-xs bg-primary/20 text-primary rounded-lg">
                      {name.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {entry.format === '2' && <Lock size={10} className="text-emerald-400 shrink-0" />}
                      <p className="text-sm font-medium text-foreground truncate">{name}</p>
                    </div>
                    <p className={`text-xs truncate ${problem ? 'text-amber-400' : 'text-muted-foreground'}`}>
                      {problem ? (
                        <span className="inline-flex items-center gap-1">
                          {st === 'loading' ? <Loader2 size={10} className="animate-spin" /> : <AlertTriangle size={10} />}
                          {problem}
                        </span>
                      ) : (
                        `${count} member${count !== 1 ? 's' : ''}`
                      )}
                    </p>
                  </div>
                  {unread && unread.count > 0 && !isActive && (
                    <div className={`min-w-5 h-5 px-1.5 rounded-full flex items-center justify-center shrink-0 ${unread.hasMention ? 'bg-amber-500' : 'bg-primary'}`}>
                      <span className="text-[10px] font-bold text-primary-foreground">{unread.count > 99 ? '99+' : unread.count}</span>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
