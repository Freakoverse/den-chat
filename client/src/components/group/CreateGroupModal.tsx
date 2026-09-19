/**
 * CreateGroupModal — name, public blurb, private/public format, relays (defaults to the user's
 * posting relays), optional initial members by npub. Creates + publishes the kind-36950 event and
 * adds it to the user's group list (lib/group/groupOps.createGroup).
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import { X, Loader2, Lock, Globe, Plus, Trash2, AlertTriangle } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useUserStore } from '@/stores/userStore'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { canUseV2 } from '@/lib/crypto/skd'
import { createGroup } from '@/lib/group/groupOps'
import { GROUP_NAME_MAX, GROUP_ABOUT_MAX, GROUP_MAX_MEMBERS } from '@/lib/group/groupEvent'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

function toHexPubkey(input: string): string | null {
  const raw = input.trim().replace(/^nostr:/i, '')
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase()
  try {
    const d = nip19.decode(raw)
    if (d.type === 'npub') return d.data as string
    if (d.type === 'nprofile') return d.data.pubkey
  } catch { /* not a key */ }
  return null
}

export function CreateGroupModal({ onClose, onCreated }: { onClose: () => void; onCreated: (dTag: string) => void }) {
  useEscToClose(onClose, true)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const v2Possible = canUseV2({ privateKey, signer })

  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [version, setVersion] = useState<1 | 2>(v2Possible ? 2 : 1)
  const [relays, setRelays] = useState<string[]>(() => getPublishRelays().slice(0, 3))
  const [relayInput, setRelayInput] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [memberInput, setMemberInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addRelay = () => {
    const r = relayInput.trim().replace(/\/+$/, '')
    if (!/^wss?:\/\//.test(r)) { setError('Relay must start with wss://'); return }
    if (!relays.includes(r)) setRelays([...relays, r])
    setRelayInput(''); setError(null)
  }
  const addMember = () => {
    const pk = toHexPubkey(memberInput)
    if (!pk) { setError('Enter an npub, nprofile, or hex pubkey'); return }
    if (members.length + 1 >= GROUP_MAX_MEMBERS) { setError(`At most ${GROUP_MAX_MEMBERS} members including you`); return }
    if (!members.includes(pk)) setMembers([...members, pk])
    setMemberInput(''); setError(null)
  }

  const create = async () => {
    if (!name.trim()) { setError('Name is required'); return }
    if (relays.length === 0) { setError('Add at least one relay'); return }
    setBusy(true); setError(null)
    try {
      const g = await createGroup({ name: name.trim(), about: about.trim() || undefined, relays, version, members })
      onCreated(g.dTag)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group')
      setBusy(false)
    }
  }

  const field = 'w-full h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40'
  const chip = 'inline-flex items-center gap-1 px-2 py-1 rounded-md bg-secondary/60 border border-border/60 text-[11px] text-foreground font-mono'

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-[480px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-foreground">New group</h3>
            <p className="text-[11px] text-muted-foreground">One conversation, up to {GROUP_MAX_MEMBERS} people. You add and remove members.</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto min-h-0">
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Name</span>
            <input value={name} maxLength={GROUP_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="Weekend crew" className={field} autoFocus />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Short description <span className="text-muted-foreground/60">(public — shown to invitees)</span></span>
            <input value={about} maxLength={GROUP_ABOUT_MAX} onChange={(e) => setAbout(e.target.value)} placeholder="Optional" className={field} />
          </label>

          {/* Format */}
          <div className="space-y-1.5">
            <span className="text-[11px] text-muted-foreground">Privacy</span>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => v2Possible && setVersion(2)}
                disabled={!v2Possible}
                className={`text-left rounded-lg border p-3 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${version === 2 ? 'border-emerald-500/40 bg-emerald-500/[0.07]' : 'border-border hover:bg-secondary/40'}`}
              >
                <p className="flex items-center gap-1.5 text-xs font-medium text-foreground"><Lock size={12} className="text-emerald-400" /> Private</p>
                <p className="text-[10px] text-muted-foreground leading-relaxed mt-1">Members post under pseudonyms; the public can't see who's in it or who created it. Members need a NIP-SKD signer.</p>
              </button>
              <button
                onClick={() => setVersion(1)}
                className={`text-left rounded-lg border p-3 transition-colors cursor-pointer ${version === 1 ? 'border-primary/40 bg-primary/[0.06]' : 'border-border hover:bg-secondary/40'}`}
              >
                <p className="flex items-center gap-1.5 text-xs font-medium text-foreground"><Globe size={12} className="text-primary" /> Public</p>
                <p className="text-[10px] text-muted-foreground leading-relaxed mt-1">Messages are encrypted, but member keys are visible in the group event. Works with any signer.</p>
              </button>
            </div>
            {!v2Possible && <p className="text-[10px] text-amber-400">Private groups need the DEN Chat client or a NIP-SKD signer — this login can only create public groups.</p>}
          </div>

          {/* Relays */}
          <div className="space-y-1.5">
            <span className="text-[11px] text-muted-foreground">Relays <span className="text-muted-foreground/60">(where the group and its messages live)</span></span>
            <div className="flex flex-wrap gap-1.5">
              {relays.map((r) => (
                <span key={r} className={chip}>
                  {r.replace(/^wss:\/\//, '')}
                  <button onClick={() => setRelays(relays.filter((x) => x !== r))} className="text-muted-foreground hover:text-destructive cursor-pointer"><X size={10} /></button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input value={relayInput} onChange={(e) => setRelayInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addRelay() }} placeholder="wss://…" className={field} />
              <button onClick={addRelay} className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"><Plus size={14} /></button>
            </div>
          </div>

          {/* Initial members */}
          <div className="space-y-1.5">
            <span className="text-[11px] text-muted-foreground">Members <span className="text-muted-foreground/60">(optional now — you can add later)</span></span>
            {members.length > 0 && (
              <div className="space-y-1">
                {members.map((m) => (
                  <div key={m} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-secondary/40 border border-border/60">
                    <span className="text-[11px] font-mono text-foreground truncate">{(() => { try { return nip19.npubEncode(m) } catch { return m } })().slice(0, 24)}…</span>
                    <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild>
                      <button onClick={() => setMembers(members.filter((x) => x !== m))} className="text-muted-foreground hover:text-destructive cursor-pointer"><Trash2 size={12} /></button>
                    </TooltipTrigger><TooltipContent side="left" className="text-xs">Remove</TooltipContent></Tooltip></TooltipProvider>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input value={memberInput} onChange={(e) => setMemberInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addMember() }} placeholder="npub1… or hex pubkey" className={field} />
              <button onClick={addMember} className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"><Plus size={14} /></button>
            </div>
            <p className="text-[10px] text-muted-foreground/70">People you add still need the invite address to see the group — copy it from the group's menu and send it however you like.</p>
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
    </div>,
    document.body,
  )
}
