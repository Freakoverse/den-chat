/**
 * useMentionAutocomplete — shared @mention autocomplete state for hub chat inputs.
 *
 * Extracted from the message composer so both the composer and the message edit
 * field can suggest people / @everyone / @here / roles as the user types
 * `@something`. The hook owns the query/suggestion state and key handling; render
 * the matching list with <MentionSuggestionsDropdown> (parent must be relative).
 */
import { useState, useMemo, useCallback, useRef } from 'react'
import type { RefObject, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useDnnStore } from '@/stores/dnnStore'
import { useProfileCache, getCachedProfile } from '@/hooks/useProfileCache'
import { usePermissions } from '@/lib/hub/permissions'
import { nip19 } from 'nostr-tools'

export type MentionSuggestion =
  | { type: 'user'; pubkey: string; name: string; npub: string; picture?: string; dnnId?: string }
  | { type: 'group'; keyword: 'everyone' | 'here'; label: string; description: string }
  | { type: 'role'; roleId: string; roleName: string; color?: string }
  | { type: 'channel'; channelId: string; channelName: string; categoryName?: string; position?: number }

export function useMentionAutocomplete(opts: {
  hubDTag: string
  channelId: string
  text: string
  setText: (v: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  autoResize?: (el: HTMLTextAreaElement) => void
}) {
  const { hubDTag, channelId, text, setText, textareaRef, autoResize } = opts

  const hubMembers = useHubStore((s) => (hubDTag ? s.hubMembers[hubDTag] : undefined))
  const hub = useHubStore((s) => (hubDTag ? s.hubs[hubDTag] : null))
  const { getProfile } = useProfileCache()
  const inputPerms = usePermissions(hubDTag || undefined, channelId || undefined)

  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionTrigger, setMentionTrigger] = useState<'@' | '#'>('@')   // '#' = channel autocomplete
  const [mentionIndex, setMentionIndex] = useState(0)
  const mentionStartRef = useRef<number | null>(null)

  const mentionSuggestions: MentionSuggestion[] = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    // #channel suggestions
    if (mentionTrigger === '#') {
      return (hub?.channels || [])
        .filter((c) => c.name && (!q || c.name.toLowerCase().includes(q)))
        .slice(0, 10)
        .map((c) => {
          const cat = c.categoryId ? (hub?.categories || []).find((k) => k.categoryId === c.categoryId) : null
          return { type: 'channel' as const, channelId: c.channelId, channelName: c.name, categoryName: cat?.name, position: c.position }
        })
    }
    if (!hubMembers) return []
    const results: MentionSuggestion[] = []

    // 1. Group mentions (@everyone, @here) — permission-gated
    if (inputPerms.mention_everyone && 'everyone'.includes(q)) {
      results.push({ type: 'group', keyword: 'everyone', label: '@everyone', description: 'Notify all hub members' })
    }
    if (inputPerms.mention_here && 'here'.includes(q)) {
      results.push({ type: 'group', keyword: 'here', label: '@here', description: 'Notify members in this channel' })
    }

    // 2. Hub role mentions — permission-gated
    if (inputPerms.mention_roles && hub?.roles) {
      for (const role of hub.roles) {
        if (role.name === 'everyone') continue // skip — already handled as group mention
        if (!q || role.name.toLowerCase().includes(q)) {
          results.push({ type: 'role', roleId: role.roleId, roleName: role.name, color: role.color })
        }
      }
    }

    // 3. User mentions
    const dnnVerified = useDnnStore.getState().verified
    const userResults = hubMembers
      .map((m) => {
        const profile = getCachedProfile(m.pubkey)
        getProfile(m.pubkey)
        const name = profile?.display_name || profile?.name || ''
        const npub = nip19.npubEncode(m.pubkey)
        const dnnEntry = dnnVerified[m.pubkey]
        const dnnId = dnnEntry ? dnnEntry.dnnId : undefined
        return { type: 'user' as const, pubkey: m.pubkey, name, npub, picture: profile?.picture, dnnId }
      })
      .filter((s) => {
        if (!q) return true
        return s.name.toLowerCase().includes(q) || s.npub.toLowerCase().includes(q) || (s.dnnId && s.dnnId.toLowerCase().includes(q))
      })

    results.push(...userResults)
    return results.slice(0, 10) // limit total suggestions
  }, [mentionQuery, mentionTrigger, hub?.channels, hub?.categories, hubMembers, getProfile, inputPerms.mention_everyone, inputPerms.mention_here, inputPerms.mention_roles, hub?.roles])

  // Detect @mention or #channel query from cursor position
  const updateMentionQuery = useCallback((value: string, cursorPos: number) => {
    const beforeCursor = value.slice(0, cursorPos)
    const atMatch = beforeCursor.match(/@([^\s@]*)$/)
    if (atMatch) {
      setMentionTrigger('@')
      setMentionQuery(atMatch[1])
      mentionStartRef.current = cursorPos - atMatch[0].length
      setMentionIndex(0)
      return
    }
    const hashMatch = beforeCursor.match(/(?:^|\s)#([^\s#]*)$/)
    if (hashMatch) {
      setMentionTrigger('#')
      setMentionQuery(hashMatch[1])
      mentionStartRef.current = cursorPos - hashMatch[1].length - 1   // position of '#'
      setMentionIndex(0)
      return
    }
    setMentionQuery(null)
    mentionStartRef.current = null
  }, [])

  const closeMention = useCallback(() => {
    setMentionQuery(null)
    mentionStartRef.current = null
  }, [])

  const applyMention = useCallback((suggestion: MentionSuggestion) => {
    const start = mentionStartRef.current
    if (start === null) return
    const ta = textareaRef.current
    const before = text.slice(0, start)
    const afterCursor = ta ? text.slice(ta.selectionStart) : ''
    let mention: string
    if (suggestion.type === 'user') mention = `@${suggestion.npub}`
    else if (suggestion.type === 'group') mention = `@${suggestion.keyword}`
    else if (suggestion.type === 'channel') mention = `#${suggestion.channelName}`
    else mention = `@${suggestion.roleName}`
    const newText = `${before}${mention} ${afterCursor}`
    setText(newText)
    setMentionQuery(null)
    mentionStartRef.current = null
    requestAnimationFrame(() => {
      if (ta) {
        const pos = before.length + mention.length + 1
        ta.focus()
        ta.setSelectionRange(pos, pos)
        autoResize?.(ta)
      }
    })
  }, [text, setText, textareaRef, autoResize])

  /** Handle keyboard nav while the dropdown is open. Returns true if consumed. */
  const handleMentionKeyDown = useCallback((e: ReactKeyboardEvent): boolean => {
    if (mentionQuery === null || mentionSuggestions.length === 0) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => Math.min(i + 1, mentionSuggestions.length - 1)); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return true }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); applyMention(mentionSuggestions[mentionIndex]); return true }
    if (e.key === 'Escape') { e.preventDefault(); closeMention(); return true }
    return false
  }, [mentionQuery, mentionSuggestions, mentionIndex, applyMention, closeMention])

  return {
    mentionQuery,
    mentionIndex,
    setMentionIndex,
    mentionSuggestions,
    updateMentionQuery,
    applyMention,
    handleMentionKeyDown,
    closeMention,
  }
}
