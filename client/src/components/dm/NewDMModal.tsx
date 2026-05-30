/**
 * NewDMModal — Start a new DM conversation
 *
 * Two tabs:
 * - "Following": search through the user's follow list by name/npub
 * - "Other": search publicly by npub or NIP-05 identifier
 *
 * Select a user → highlight → "Start Messaging" button → closes modal.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useDMStore } from '@/stores/dmStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { X, Search, MessageSquarePlus, Loader2, Users, UserPlus } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  onStartConversation: (pubkey: string) => void
}

interface SearchResult {
  pubkey: string
  name?: string
  picture?: string
  nip05?: string
}

export function NewDMModal({ open, onClose, onStartConversation }: Props) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const addPendingConversation = useDMStore((s) => s.addPendingConversation)

  const [followList, setFollowList] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'following' | 'other'>('following')
  const [publicResults, setPublicResults] = useState<SearchResult[]>([])
  const [publicSearching, setPublicSearching] = useState(false)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load follow list
  useEffect(() => {
    if (!open || !myPubkey) return
    setLoading(true)
    setSearch('')
    setSelected(null)
    setTab('following')
    setPublicResults([])

    fetchEvents({ kinds: [3], authors: [myPubkey] }).then((events) => {
      if (events.length > 0) {
        const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
        const pubs = latest.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1])
        setFollowList(pubs.filter((pk) => pk !== myPubkey))
      }
      setLoading(false)
    })
  }, [open, myPubkey])

  // Filter follow list by search (Following tab)
  const filteredFollows = useMemo(() => {
    if (!search.trim()) return followList

    const q = search.toLowerCase().trim()

    // Direct npub match
    if (q.startsWith('npub1')) {
      try {
        const { data } = nip19.decode(q)
        const pk = data as string
        if (pk && pk !== myPubkey && followList.includes(pk)) return [pk]
      } catch { /* not valid npub */ }
    }

    // Search by name/display_name
    return followList.filter((pk) => {
      const profile = getProfile(pk)
      const name = (profile?.display_name || profile?.name || '').toLowerCase()
      const npubStr = nip19.npubEncode(pk).toLowerCase()
      const nip05 = (profile?.nip05 || '').toLowerCase()
      return name.includes(q) || npubStr.includes(q) || nip05.includes(q)
    })
  }, [search, followList, getProfile, myPubkey])

  // Public search (Other tab) — debounced
  const doPublicSearch = useCallback(async (query: string) => {
    const q = query.trim()
    if (!q) {
      setPublicResults([])
      return
    }

    setPublicSearching(true)

    try {
      // Check if it's an npub
      if (q.toLowerCase().startsWith('npub1')) {
        try {
          const { data } = nip19.decode(q.toLowerCase())
          const pk = data as string
          if (pk && pk !== myPubkey) {
            // Fetch their profile
            const profiles = await fetchEvents({ kinds: [0], authors: [pk], limit: 1 })
            if (profiles.length > 0) {
              try {
                const meta = JSON.parse(profiles[0].content)
                setPublicResults([{
                  pubkey: pk,
                  name: meta.display_name || meta.name,
                  picture: meta.picture,
                  nip05: meta.nip05,
                }])
              } catch {
                setPublicResults([{ pubkey: pk }])
              }
            } else {
              setPublicResults([{ pubkey: pk }])
            }
            setPublicSearching(false)
            return
          }
        } catch { /* not valid npub */ }
      }

      // NIP-05 lookup: check if query looks like user@domain
      if (q.includes('@')) {
        try {
          const [name, domain] = q.split('@')
          if (name && domain && domain.includes('.')) {
            const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
            const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
            if (resp.ok) {
              const json = await resp.json()
              const pk = json?.names?.[name] || json?.names?.[name.toLowerCase()]
              if (pk && pk !== myPubkey) {
                // Got pubkey from NIP-05, fetch their profile
                const profiles = await fetchEvents({ kinds: [0], authors: [pk], limit: 1 })
                if (profiles.length > 0) {
                  try {
                    const meta = JSON.parse(profiles[0].content)
                    setPublicResults([{
                      pubkey: pk,
                      name: meta.display_name || meta.name,
                      picture: meta.picture,
                      nip05: meta.nip05,
                    }])
                  } catch {
                    setPublicResults([{ pubkey: pk }])
                  }
                } else {
                  setPublicResults([{ pubkey: pk }])
                }
                setPublicSearching(false)
                return
              }
            }
          }
        } catch { /* NIP-05 lookup failed */ }
      }

      // Generic search: search kind 0 metadata events by content
      // This is a broad search — relay support varies
      const events = await fetchEvents({ kinds: [0], search: q, limit: 20 })
      const results: SearchResult[] = []
      const seen = new Set<string>()
      for (const e of events) {
        if (seen.has(e.pubkey) || e.pubkey === myPubkey) continue
        seen.add(e.pubkey)
        try {
          const meta = JSON.parse(e.content)
          results.push({
            pubkey: e.pubkey,
            name: meta.display_name || meta.name,
            picture: meta.picture,
            nip05: meta.nip05,
          })
        } catch {
          results.push({ pubkey: e.pubkey })
        }
      }
      setPublicResults(results)
    } catch {
      setPublicResults([])
    } finally {
      setPublicSearching(false)
    }
  }, [myPubkey])

  // Debounce public search
  useEffect(() => {
    if (tab !== 'other') return
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)

    if (!search.trim()) {
      setPublicResults([])
      setPublicSearching(false)
      return
    }

    setPublicSearching(true)
    searchTimeoutRef.current = setTimeout(() => {
      doPublicSearch(search)
    }, 500)

    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    }
  }, [search, tab, doPublicSearch])

  const handleStart = () => {
    if (!selected) return
    addPendingConversation(selected)
    onStartConversation(selected)
    onClose()
  }

  if (!open) return null

  // Determine displayed list based on tab
  const displayList = tab === 'following' ? filteredFollows : publicResults.map((r) => r.pubkey)
  const isLoading = tab === 'following' ? loading : publicSearching
  const emptyMessage = tab === 'following'
    ? (search ? 'No follows match your search.' : 'No follows yet.')
    : (search ? (publicSearching ? '' : 'No users found.') : 'Search by npub or NIP-05 (user@domain.com)')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60" onClick={onClose}>
      <div
        className="bg-background rounded-xl w-full max-w-md max-h-[70vh] overflow-hidden shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-base font-semibold text-foreground">New Message</h3>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-accent/50 transition-colors cursor-pointer">
            <X size={16} className="text-muted-foreground" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-4 pt-3 gap-1">
          <button
            onClick={() => { setTab('following'); setSelected(null) }}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer
              ${tab === 'following' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}
          >
            <Users size={13} /> Following
          </button>
          <button
            onClick={() => { setTab('other'); setSelected(null) }}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer
              ${tab === 'other' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}
          >
            <UserPlus size={13} /> Other
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 border border-border">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder={tab === 'following'
                ? 'Search by name, npub, or NIP-05...'
                : 'Paste npub or NIP-05 (user@domain.com)...'
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              autoFocus
            />
          </div>
        </div>

        {/* User list */}
        <div className="flex-1 overflow-y-auto p-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 size={18} className="animate-spin mr-2" />
              {tab === 'following' ? 'Loading...' : 'Searching...'}
            </div>
          ) : displayList.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              {emptyMessage}
            </div>
          ) : (
            <div className="space-y-0.5">
              {displayList.map((pk) => {
                // Use public search result data if on Other tab, else profile cache
                const publicResult = tab === 'other' ? publicResults.find((r) => r.pubkey === pk) : null
                const profile = publicResult || getProfile(pk)
                const npubStr = nip19.npubEncode(pk)
                const displayName = (profile as any)?.display_name || profile?.name || truncateNpub(npubStr, 10)
                const displayPicture = profile?.picture
                const displayNip05 = (profile as any)?.nip05
                const isSelected = selected === pk
                return (
                  <button
                    key={pk}
                    onClick={() => setSelected(isSelected ? null : pk)}
                    className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors cursor-pointer text-left
                      ${isSelected
                        ? 'bg-primary/15 border border-primary/30'
                        : 'hover:bg-secondary/50 border border-transparent'
                      }`}
                  >
                    <Avatar className="h-9 w-9">
                      {displayPicture && <AvatarImage src={displayPicture} />}
                      <AvatarFallback className="text-xs bg-primary/20 text-primary">
                        {displayName.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
                      <p className="text-xs text-muted-foreground font-mono truncate">
                        {displayNip05 || truncateNpub(npubStr, 16)}
                      </p>
                    </div>
                    {isSelected && (
                      <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                        <div className="w-2 h-2 rounded-full bg-white" />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border">
          <button
            onClick={handleStart}
            disabled={!selected}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <MessageSquarePlus size={16} />
            Start Messaging
          </button>
        </div>
      </div>
    </div>
  )
}
