/**
 * CreateGroupModal (NIP-CHAT §21): banner + picture uploaded to Blossom (same multi-server bar as
 * hub creation), name, public and private blurbs, the private-group (v2) toggle guarded the
 * same way as hub creation (signer capability + the confirmation password), relays under Advanced
 * (deterministic 3-pick, toggles, custom add, like hub creation), and members picked from the
 * user's follow list or added by npub / NIP-05 / DNN ID. Creates + publishes the kind-36950
 * event and adds it to the user's group list (lib/group/groupOps.createGroup).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import { X, Loader2, Plus, Trash2, AlertTriangle, ChevronDown, Info, Search, Check, Lock } from 'lucide-react'
import { GroupFaceEditor, type GroupFaceState } from '@/components/group/GroupFaceEditor'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useUserStore } from '@/stores/userStore'
import { useFollowStore } from '@/stores/followStore'
import { useUserListsStore } from '@/stores/userListsStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { getRelayList } from '@/lib/nostr/relay-pool'
import { canUseV2 } from '@/lib/crypto/skd'
import { createGroup } from '@/lib/group/groupOps'
import { GROUP_NAME_MAX, GROUP_ABOUT_MAX, GROUP_MAX_MEMBERS } from '@/lib/group/groupEvent'
import { HUB_DESCRIPTION_MAX } from '@/lib/hub/hubLimits'
import { MAX_GENERAL_RELAYS } from '@/lib/hub/hubLimits'
import { resolveIdentifier } from '@/lib/group/resolveIdentifier'
import { cn, truncateNpub } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** Same confirmation password as the private-hub toggle in hub creation. */
const V2_TOGGLE_PASSWORD = 'denchat'

interface RelayEntry { url: string; enabled: boolean }

export function CreateGroupModal({ onClose, onCreated }: { onClose: () => void; onCreated: (dTag: string) => void }) {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const userRelays = useUserListsStore((s) => s.userRelays)
  const followed = useFollowStore((s) => s.followedPubkeys)
  const { getProfile } = useProfileCache()
  const v2Capable = canUseV2({ privateKey, signer })

  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [description, setDescription] = useState('')

  // Stable d tag chosen up front so a v2 group's image uploads can be auth-signed as the owner pseudonym O.
  const dTagRef = useRef(crypto.randomUUID())
  const [face, setFace] = useState<GroupFaceState>({ face: { picture: null, banner: null }, uploading: false, overlayOpen: false })

  // Private (v2) toggle: OFF by default; ON only after the confirmation password, only when the signer can do NIP-SKD.
  const [createV2, setCreateV2] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [pw, setPw] = useState('')
  const [pwError, setPwError] = useState(false)
  useEscToClose(() => setShowPw(false), showPw)
  useEscToClose(onClose, !showPw && !face.overlayOpen)
  const handleV2Toggle = () => {
    if (!v2Capable) return
    if (createV2) { setCreateV2(false); return }
    setPw(''); setPwError(false); setShowPw(true)
  }
  const confirmPw = () => {
    if (pw === V2_TOGGLE_PASSWORD) { setCreateV2(true); setShowPw(false); setPw(''); setPwError(false) }
    else setPwError(true)
  }

  // Relays (Advanced): deterministic 3-pick per list seeded by the author's pubkey, like hub creation.
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [clientRelays, setClientRelays] = useState<RelayEntry[]>([])
  const [nip65Relays, setNip65Relays] = useState<RelayEntry[]>([])
  const [customRelays, setCustomRelays] = useState<RelayEntry[]>([])
  const [customRelayInput, setCustomRelayInput] = useState('')
  useEffect(() => {
    const pick = (urls: string[], max: number): Set<string> => {
      if (urls.length <= max) return new Set(urls)
      const sorted = [...urls].sort()
      const start = pubkey ? parseInt(pubkey.slice(0, 8), 16) % sorted.length : 0
      return new Set(Array.from({ length: max }, (_, i) => sorted[(start + i) % sorted.length]))
    }
    const client = getRelayList().filter((r) => r.enabled).map((r) => r.url)
    const clientPicked = pick(client, 3)
    setClientRelays(client.map((url) => ({ url, enabled: clientPicked.has(url) })))
    const clientSet = new Set(client)
    const user = userRelays.filter((u) => !clientSet.has(u))
    const userPicked = pick(user, 3)
    setNip65Relays(user.map((url) => ({ url, enabled: userPicked.has(url) })))
  }, [pubkey, userRelays])
  const selectedRelays = useMemo(
    () => [...new Set([...clientRelays, ...nip65Relays, ...customRelays].filter((r) => r.enabled).map((r) => r.url))],
    [clientRelays, nip65Relays, customRelays],
  )
  const addCustomRelay = () => {
    const r = customRelayInput.trim().replace(/\/+$/, '')
    if (!/^wss?:\/\//.test(r)) { setError('Relay must start with wss://'); return }
    if (![...clientRelays, ...nip65Relays, ...customRelays].some((e) => e.url === r)) setCustomRelays([...customRelays, { url: r, enabled: true }])
    setCustomRelayInput(''); setError(null)
  }
  const toggle = (list: RelayEntry[], set: (v: RelayEntry[]) => void, i: number) => {
    const copy = [...list]; copy[i] = { ...copy[i], enabled: !copy[i].enabled }; set(copy)
  }

  // Members: follows with search + a custom add (npub / nprofile / hex / NIP-05 / DNN ID).
  const [members, setMembers] = useState<string[]>([])
  const [followSearch, setFollowSearch] = useState('')
  const [customInput, setCustomInput] = useState('')
  const [resolving, setResolving] = useState(false)
  const followList = useMemo(() => {
    const q = followSearch.trim().toLowerCase()
    const all = [...followed].filter((pk) => pk !== pubkey)
    if (!q) return all
    return all.filter((pk) => {
      const p = getProfile(pk)
      const n = `${p?.display_name ?? ''} ${p?.name ?? ''} ${p?.nip05 ?? ''}`.toLowerCase()
      return n.includes(q) || pk.startsWith(q)
    })
  }, [followed, followSearch, getProfile, pubkey])
  const toggleMember = (pk: string) => {
    if (members.includes(pk)) { setMembers(members.filter((m) => m !== pk)); return }
    if (members.length + 1 >= GROUP_MAX_MEMBERS) { setError(`At most ${GROUP_MAX_MEMBERS} members including you`); return }
    setMembers([...members, pk]); setError(null)
  }
  const addCustom = async () => {
    if (!customInput.trim()) return
    setResolving(true); setError(null)
    try {
      const pk = await resolveIdentifier(customInput)
      if (!pk) { setError('Could not resolve that. Use an npub, nprofile, hex pubkey, NIP-05 address, or DNN ID.'); return }
      if (pk === pubkey) { setError("That's you. You're always a member."); return }
      toggleMember(pk)
      if (!members.includes(pk)) setCustomInput('')
    } finally { setResolving(false) }
  }

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    if (!name.trim()) { setError('Name is required'); return }
    if (selectedRelays.length === 0) { setError('Select at least one relay under Advanced'); return }
    if (selectedRelays.length > MAX_GENERAL_RELAYS) { setError(`At most ${MAX_GENERAL_RELAYS} relays`); return }
    if (face.uploading) { setError('Wait for the image upload to finish'); return }
    setBusy(true); setError(null)
    try {
      const g = await createGroup({
        dTag: dTagRef.current,
        name: name.trim(),
        about: about.trim() || undefined,
        description: description.trim() || undefined,
        picture: face.face.picture ?? undefined,
        banner: face.face.banner ?? undefined,
        relays: selectedRelays,
        version: createV2 && v2Capable ? 2 : 1,
        members,
      })
      onCreated(g.dTag)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group')
      setBusy(false)
    }
  }

  const field = 'w-full h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40'
  const Switch = ({ on, onClick, disabled, small }: { on: boolean; onClick: () => void; disabled?: boolean; small?: boolean }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn('relative rounded-full transition-colors cursor-pointer shrink-0', small ? 'w-8 h-[18px]' : 'w-10 h-[22px]', on ? 'bg-primary' : 'bg-muted-foreground/30', disabled && 'opacity-40 cursor-not-allowed')}
    >
      <div className={cn('absolute rounded-full bg-white shadow transition-transform', small ? 'top-[2px] w-[14px] h-[14px]' : 'top-[3px] w-4 h-4', on ? (small ? 'translate-x-[16px]' : 'translate-x-[22px]') : (small ? 'translate-x-[2px]' : 'translate-x-[3px]'))} />
    </button>
  )
  const relayRow = (list: RelayEntry[], set: (v: RelayEntry[]) => void, removable = false) => (
    <div className="space-y-1">
      {list.map((entry, i) => (
        <div key={entry.url} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-secondary/30 border border-border">
          <Switch small on={entry.enabled} onClick={() => toggle(list, set, i)} />
          <span className="text-xs text-foreground font-mono truncate flex-1">{entry.url}</span>
          {removable && <button onClick={() => set(list.filter((e) => e.url !== entry.url))} className="text-muted-foreground hover:text-destructive cursor-pointer"><Trash2 size={12} /></button>}
        </div>
      ))}
    </div>
  )

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center">
      {/* Only the backdrop closes. The crop editor, size warning and password prompt render inside this
          root, and a slider drag released outside its thumb fires a click on the shared ancestor. */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative z-10 w-full max-w-[520px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-foreground">New group</h3>
            <p className="text-[11px] text-muted-foreground">One conversation, up to {GROUP_MAX_MEMBERS} people. You add and remove members.</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-5 overflow-y-auto min-h-0">
          <GroupFaceEditor dTag={dTagRef.current} v2={createV2 && v2Capable} onChange={setFace} onError={setError} />

          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Name</span>
            <input value={name} maxLength={GROUP_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="Weekend crew" className={field} autoFocus />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Public short description <span className="font-normal text-muted-foreground">(shown to invitees)</span></span>
            <textarea value={about} maxLength={GROUP_ABOUT_MAX} rows={3} onChange={(e) => setAbout(e.target.value)} placeholder="Optional" className={`${field} h-auto py-2 resize-none`} />
            <div className="text-right text-[11px] text-muted-foreground/60">{about.length}/{GROUP_ABOUT_MAX}</div>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Private short description <span className="font-normal text-muted-foreground">(encrypted, members only)</span></span>
            <textarea value={description} maxLength={HUB_DESCRIPTION_MAX} rows={3} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" className={`${field} h-auto py-2 resize-none`} />
            <div className="text-right text-[11px] text-muted-foreground/60">{description.length}/{HUB_DESCRIPTION_MAX}</div>
          </label>

          {/* Members */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">Members <span className="font-normal text-muted-foreground">(optional now, you can add later)</span></span>
              <span className="text-xs font-mono tabular-nums text-muted-foreground/60">{members.length + 1}/{GROUP_MAX_MEMBERS}</span>
            </div>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/30">
                <Search size={14} className="text-muted-foreground shrink-0" />
                <input value={followSearch} onChange={(e) => setFollowSearch(e.target.value)} placeholder="Search people you follow" className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none" />
              </div>
              <div className="max-h-56 overflow-y-auto p-2 space-y-0.5">
                {followList.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-muted-foreground/70">{followed.size === 0 ? "You don't follow anyone yet. Add people below." : 'No matches.'}</p>
                ) : followList.map((pk) => {
                  const p = getProfile(pk)
                  const npub = (() => { try { return nip19.npubEncode(pk) } catch { return pk } })()
                  const label = p?.display_name || p?.name || truncateNpub(npub, 10)
                  const on = members.includes(pk)
                  return (
                    <button key={pk} onClick={() => toggleMember(pk)} className={cn('w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer', on ? 'bg-primary/10' : 'hover:bg-secondary/40')}>
                      <Avatar className="h-9 w-9 shrink-0">
                        {p?.picture && <AvatarImage src={p.picture} />}
                        <AvatarFallback className="text-xs bg-primary/20 text-primary">{label.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm text-foreground truncate flex-1">{label}</span>
                      <span className={cn('w-[18px] h-[18px] rounded border flex items-center justify-center shrink-0', on ? 'bg-primary border-primary' : 'border-border')}>{on && <Check size={12} className="text-primary-foreground" />}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            {/* Selected people who aren't in the follow list (added by identifier) */}
            {members.filter((m) => !followed.has(m)).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {members.filter((m) => !followed.has(m)).map((m) => {
                  const p = getProfile(m)
                  const npub = (() => { try { return nip19.npubEncode(m) } catch { return m } })()
                  return (
                    <span key={m} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary/60 border border-border/60 text-xs text-foreground">
                      {p?.display_name || p?.name || truncateNpub(npub, 8)}
                      <button onClick={() => toggleMember(m)} className="text-muted-foreground hover:text-destructive cursor-pointer"><X size={12} /></button>
                    </span>
                  )
                })}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input value={customInput} onChange={(e) => setCustomInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCustom() }} placeholder="npub, NIP-05 address, or DNN ID" className={field} />
              <button onClick={addCustom} disabled={resolving || !customInput.trim()} className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer disabled:opacity-50">
                {resolving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground/70">People you add still need the invite address to see the group. Copy it from the group's menu and send it however you like.</p>
          </div>

          {/* Private group (v2) toggle, guarded like the private-hub toggle */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground flex items-center gap-1.5"><Lock size={13} className="text-emerald-400" /> Private group (v2)</label>
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-500 select-none">Experimental</span>
              </div>
              <p className="text-xs text-muted-foreground">
                A more private group.{' '}
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="underline decoration-dotted underline-offset-2 cursor-help text-foreground/80 hover:text-foreground">Learn more</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="z-[300] max-w-xs text-xs leading-relaxed whitespace-pre-line">
                      {"A private group masks who created it, who its members are, and who is posting from anyone outside it. In a public (v1) group the messages are still encrypted, but the member keys are visible in the group event.\n\nOnly the DEN Chat client, or a browser extension or remote signer that supports NIP-SKD, can create a private group or take part in one."}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {!v2Capable && <span className="block mt-1 text-amber-500">Your current signer can't do this. Sign in with a local key or a supported signer to create a private group.</span>}
              </p>
            </div>
            <Switch on={createV2 && v2Capable} onClick={handleV2Toggle} disabled={!v2Capable} />
          </div>

          {/* Advanced: relays */}
          <div>
            <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
              <ChevronDown size={14} className={cn('transition-transform', showAdvanced && 'rotate-180')} /> Advanced
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-4 pl-1">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-foreground">Relays</h4>
                  <span className={`text-[11px] font-mono tabular-nums select-none ${selectedRelays.length >= MAX_GENERAL_RELAYS ? 'text-amber-400' : 'text-muted-foreground/60'}`}>{selectedRelays.length}/{MAX_GENERAL_RELAYS}</span>
                </div>
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20">
                  <Info size={14} className="text-primary shrink-0 mt-0.5" />
                  <p className="text-[11px] text-muted-foreground leading-relaxed">These relays hold the group and its messages. Every member reads and writes there. If you're unsure, leave the defaults.</p>
                </div>
                {clientRelays.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Client relays</h4>
                    {relayRow(clientRelays, setClientRelays)}
                  </div>
                )}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">User relay list (NIP-65)</h4>
                  {nip65Relays.length > 0 ? relayRow(nip65Relays, setNip65Relays) : <p className="text-[11px] text-muted-foreground/60">No NIP-65 relays published.</p>}
                </div>
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Custom</h4>
                  {customRelays.length > 0 && relayRow(customRelays, setCustomRelays, true)}
                  <div className="flex items-center gap-2">
                    <input value={customRelayInput} onChange={(e) => setCustomRelayInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCustomRelay() }} placeholder="wss://relay.example.com" className={field} />
                    <button onClick={addCustomRelay} className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"><Plus size={14} /></button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer">Cancel</button>
          <button onClick={create} disabled={busy || !name.trim()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
            {busy && <Loader2 size={11} className="animate-spin" />} Create group
          </button>
        </div>
      </div>

      {/* Confirmation password for turning the private toggle ON */}
      {showPw && (
        <div className="fixed inset-0 z-[260] flex items-center justify-center bg-black/60 p-4" onClick={() => setShowPw(false)}>
          <div className="bg-background rounded-xl border border-border shadow-2xl w-full max-w-sm p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-foreground">Enable private group</h3>
            <p className="text-xs text-muted-foreground">Turning on private (v2) group creation requires a confirmation password.</p>
            <input
              type="password"
              autoFocus
              value={pw}
              onChange={(e) => { setPw(e.target.value); setPwError(false) }}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmPw() }}
              placeholder="Password"
              className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground outline-none focus:border-primary"
            />
            {pwError && <p className="text-xs text-destructive">Incorrect password.</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowPw(false)} className="px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground cursor-pointer">Cancel</button>
              <button onClick={confirmPw} disabled={!pw} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}
