import { useHubStore, type Role } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useDMStore } from '@/stores/dmStore'
import { useDM04Store } from '@/stores/dm04Store'
import { useNavigationStore } from '@/stores/navigationStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub, cn } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { useState, useMemo } from 'react'
import { Crown, Search, ChevronDown, Info } from 'lucide-react'
import { useDnnStore } from '@/stores/dnnStore'
import { formatDnnId } from '@/lib/dnn/formatDnnId'

/** PAGE_SIZE matches the constant in lkh.ts — used for approximate total count display */
const PAGE_SIZE = 10_000

export function MemberList() {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const hubMembers = useHubStore((s) => (activeHubId ? s.hubMembers[activeHubId] : undefined))
  const pageCount = useHubStore((s) => (activeHubId ? s.hubPageCounts[activeHubId] : undefined))
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()

  const [profileModalPubkey, setProfileModalPubkey] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [showInfoTooltip, setShowInfoTooltip] = useState(false)

  if (!hub) return null

  /**
   * Large hub detection: if the paginated index has more than 1 page,
   * we only have our own page's members (up to PAGE_SIZE).
   * The sidebar shows "Active Members" and an approximate total.
   */
  const isLargeHub = (pageCount ?? 0) > 1
  const approxTotal = isLargeHub ? (pageCount! * PAGE_SIZE) : 0

  // Build the members list including the creator
  const allMembers = useMemo(() => {
    const members: Array<{ pubkey: string; roles: string; isCreator: boolean }> = []
    const seen = new Set<string>()

    // Add creator first
    if (hub.creatorPubkey) {
      members.push({ pubkey: hub.creatorPubkey, roles: 'creator', isCreator: true })
      seen.add(hub.creatorPubkey)
    }

    // Add LKH tree members
    if (hubMembers) {
      for (const m of hubMembers) {
        if (!seen.has(m.pubkey)) {
          members.push({ pubkey: m.pubkey, roles: m.roles || 'everyone', isCreator: false })
          seen.add(m.pubkey)
        }
      }
    }

    return members
  }, [hub.creatorPubkey, hubMembers])

  // Filter by search
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return allMembers
    const q = searchQuery.toLowerCase()
    return allMembers.filter((m) => {
      const profile = getProfile(m.pubkey)
      const npub = nip19.npubEncode(m.pubkey)
      return (
        npub.toLowerCase().includes(q) ||
        (profile?.display_name || '').toLowerCase().includes(q) ||
        (profile?.name || '').toLowerCase().includes(q)
      )
    })
  }, [allMembers, searchQuery, getProfile])

  // Group members by hoisted roles
  const groupedMembers = useMemo(() => {
    // Get hoisted roles sorted by position (ascending, lower = higher priority)
    const hoistedRoles = hub.roles
      .filter(r => r.hoist && r.name !== 'everyone')
      .sort((a, b) => a.position - b.position)

    const groups: Array<{ role: Role | null; label: string; members: typeof filtered }> = []
    const placed = new Set<string>()

    // Place members into hoisted role groups
    for (const role of hoistedRoles) {
      const membersInRole = filtered.filter(m => {
        if (placed.has(m.pubkey)) return false
        const memberRoleIds = m.roles.split('|').map(s => s.trim())
        return memberRoleIds.includes(role.roleId)
      })
      if (membersInRole.length > 0) {
        for (const m of membersInRole) placed.add(m.pubkey)
        groups.push({ role, label: role.name, members: membersInRole })
      }
    }

    // Remaining members go into "everyone" (always last)
    const remaining = filtered.filter(m => !placed.has(m.pubkey))
    const everyoneRole = hub.roles.find(r => r.name === 'everyone') || null
    groups.push({ role: everyoneRole, label: 'everyone', members: remaining })

    return groups
  }, [filtered, hub.roles])

  const hasHoistedGroups = groupedMembers.length > 1

  const totalCount = allMembers.length

  const toggleSection = (label: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  /** Format large numbers with K/M suffix */
  const formatCount = (n: number): string => {
    if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`
    if (n >= 10_000) return `~${Math.round(n / 1000)}K`
    return String(n)
  }

  return (
    <div className="flex flex-col w-full h-full overflow-hidden bg-background border-l border-border">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 border-b border-border/50">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Active Members — {totalCount}
          </span>
          {isLargeHub && (
            <div className="relative">
              <button
                onClick={() => setShowInfoTooltip(!showInfoTooltip)}
                onBlur={() => setTimeout(() => setShowInfoTooltip(false), 150)}
                className="text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
                title={`~${formatCount(approxTotal)} total members across ${pageCount} pages`}
              >
                <Info size={11} />
              </button>
              {showInfoTooltip && (
                <div className="absolute left-0 top-full mt-1 z-50 w-52 p-2.5 rounded-lg bg-popover border border-border shadow-lg text-[10px] text-muted-foreground leading-relaxed animate-in fade-in-0 zoom-in-95">
                  <p className="font-medium text-foreground mb-1">{formatCount(approxTotal)} total members</p>
                  <p>This hub has {pageCount} member pages. Only members from your page are shown here. Use Hub Settings → Members to search by npub.</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Search (show only when 6+ members) */}
        {totalCount >= 6 && (
          <div className="relative mt-2">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder={isLargeHub ? "Search active members..." : "Search members..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-7 rounded-md border border-border bg-background pl-6 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        )}
      </div>

      {/* Member list */}
      <div className="flex flex-col overflow-y-auto scrollbar-hide py-1 px-1">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            {searchQuery ? 'No matching members' : 'Loading members...'}
          </p>
        ) : hasHoistedGroups ? (
          // Grouped display with collapsible sections
          groupedMembers.map((group) => {
            if (group.members.length === 0) return null
            const isCollapsed = collapsedSections.has(group.label)
            return (
              <div key={group.label} className="mb-1">
                <button
                  onClick={() => toggleSection(group.label)}
                  className="flex items-center gap-1 w-full px-2 py-1.5 text-left cursor-pointer group/section"
                >
                  <ChevronDown
                    size={10}
                    className={cn(
                      'text-muted-foreground shrink-0 transition-transform',
                      isCollapsed && '-rotate-90'
                    )}
                  />
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wider truncate"
                    style={{ color: group.role?.color || undefined }}
                  >
                    {group.label}
                  </span>
                  <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                    — {group.members.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="flex flex-col gap-0.5">
                    {group.members.map((member) => (
                      <MemberCard
                        key={member.pubkey}
                        pubkey={member.pubkey}
                        isCreator={member.isCreator}
                        isSelf={member.pubkey === myPubkey}
                        getProfile={getProfile}
                        onClick={() => setProfileModalPubkey(member.pubkey)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })
        ) : (
          // Flat display (no hoisted roles)
          <div className="flex flex-col gap-0.5">
            {filtered.map((member) => (
              <MemberCard
                key={member.pubkey}
                pubkey={member.pubkey}
                isCreator={member.isCreator}
                isSelf={member.pubkey === myPubkey}
                getProfile={getProfile}
                onClick={() => setProfileModalPubkey(member.pubkey)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Profile modal */}
      <UserProfileModal
        open={!!profileModalPubkey}
        onClose={() => setProfileModalPubkey(null)}
        targetPubkey={profileModalPubkey}
        hubContext={hub.creatorPubkey ? { dTag: hub.dTag, creatorPubkey: hub.creatorPubkey } : null}
        onDM={(pubkey) => {
          useDM04Store.getState().setActiveConversation(pubkey)
          useDMStore.getState().setActiveConversation(pubkey)
          useNavigationStore.getState().setActivePage('dms')
          setProfileModalPubkey(null)
        }}
      />
    </div>
  )
}

function MemberCard({
  pubkey,
  isCreator,
  isSelf,
  getProfile,
  onClick,
}: {
  pubkey: string
  isCreator: boolean
  isSelf: boolean
  getProfile: (pk: string) => any
  onClick: () => void
}) {
  const profile = getProfile(pubkey)
  const npub = nip19.npubEncode(pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(npub, 12)

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-accent/40 transition-colors cursor-pointer group text-left rounded-sm"
    >
      <Avatar className="h-8 w-8 shrink-0">
        {profile?.picture && <AvatarImage src={profile.picture} alt={displayName} />}
        <AvatarFallback className="text-[10px] bg-primary/15 text-primary">
          {displayName.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="text-md font-medium text-foreground truncate group-hover:text-primary transition-colors">
            {displayName}
          </span>
          {isCreator && (
            <Crown size={11} className="text-amber-400 shrink-0" />
          )}
          {isSelf && (
            <span className="text-[9px] text-muted-foreground/60 shrink-0">(you)</span>
          )}
        </div>
        <MemberSubline pubkey={pubkey} npub={npub} />
      </div>
    </button>
  )
}

/** Shows verified DNN ID or truncated npub below the member name */
function MemberSubline({ pubkey, npub }: { pubkey: string; npub: string }) {
  const dnnId = useDnnStore((s) => s.verified[pubkey]?.dnnId)
  const status = useDnnStore((s) => s.status[pubkey])

  if (status === 'verified' && dnnId) {
    return (
      <p className="text-sm text-primary/70 font-mono truncate">
        @{formatDnnId(dnnId)}
      </p>
    )
  }

  return (
    <p className="text-sm text-muted-foreground font-mono truncate">
      {truncateNpub(npub, 5)}
    </p>
  )
}
