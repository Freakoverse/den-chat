/**
 * BlossomServerPicker: the group's `o` servers (NIP-CHAT §21.2), chosen the way hub creation chooses
 * them: the client's Blossom servers, the user's own list (kind 10063), and custom URLs, each with a
 * toggle. New groups start with a deterministic pick of 3 per list seeded by the author's pubkey;
 * editing starts from the group's current list. Media sent in the group uploads to these servers.
 */
import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Info } from 'lucide-react'
import { useUserStore } from '@/stores/userStore'
import { useUserListsStore } from '@/stores/userListsStore'
import { blossomServers as blossomServerManager } from '@/lib/blossom'
import { MAX_BLOSSOM_SERVERS } from '@/lib/hub/hubLimits'
import { cn } from '@/lib/utils'

interface Entry { url: string; enabled: boolean }
const norm = (u: string) => u.trim().replace(/\/+$/, '')

function pickForAuthor(urls: string[], max: number, pubkey: string | null): Set<string> {
  if (urls.length <= max) return new Set(urls)
  const sorted = [...urls].sort()
  const start = pubkey ? parseInt(pubkey.slice(0, 8), 16) % sorted.length : 0
  return new Set(Array.from({ length: max }, (_, i) => sorted[(start + i) % sorted.length]))
}

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn('relative w-8 h-[18px] rounded-full transition-colors cursor-pointer shrink-0', on ? 'bg-primary' : 'bg-muted-foreground/30')}>
      <div className={cn('absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform', on ? 'translate-x-[16px]' : 'translate-x-[2px]')} />
    </button>
  )
}

export function BlossomServerPicker({ initial, onChange, onError }: {
  /** The group's current servers when editing; omit for a new group (deterministic default pick). */
  initial?: string[]
  onChange: (selected: string[]) => void
  onError: (message: string) => void
}) {
  const pubkey = useUserStore((s) => s.pubkey)
  const userBlossoms = useUserListsStore((s) => s.userBlossoms)
  const [client, setClient] = useState<Entry[]>([])
  const [user, setUser] = useState<Entry[]>([])
  const [custom, setCustom] = useState<Entry[]>([])
  const [input, setInput] = useState('')

  useEffect(() => {
    const clientUrls = blossomServerManager.getList().filter((s) => s.enabled).map((s) => norm(s.url))
    const userUrls = userBlossoms.map(norm).filter((u) => !clientUrls.includes(u))
    if (initial) {
      const cur = new Set(initial.map(norm))
      setClient(clientUrls.map((url) => ({ url, enabled: cur.has(url) })))
      setUser(userUrls.map((url) => ({ url, enabled: cur.has(url) })))
      setCustom([...cur].filter((u) => !clientUrls.includes(u) && !userUrls.includes(u)).map((url) => ({ url, enabled: true })))
    } else {
      const cp = pickForAuthor(clientUrls, 3, pubkey)
      const up = pickForAuthor(userUrls, 3, pubkey)
      setClient(clientUrls.map((url) => ({ url, enabled: cp.has(url) })))
      setUser(userUrls.map((url) => ({ url, enabled: up.has(url) })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, userBlossoms])

  const selected = [...new Set([...client, ...user, ...custom].filter((e) => e.enabled).map((e) => e.url))]
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const key = selected.join('|')
  useEffect(() => { onChangeRef.current(selected) }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (list: Entry[], set: (v: Entry[]) => void, i: number) => { const c = [...list]; c[i] = { ...c[i], enabled: !c[i].enabled }; set(c) }
  const add = () => {
    const u = norm(input)
    if (!/^https?:\/\//.test(u)) { onError('Blossom server must start with https://'); return }
    if (![...client, ...user, ...custom].some((e) => e.url === u)) setCustom([...custom, { url: u, enabled: true }])
    setInput('')
  }
  const rows = (list: Entry[], set: (v: Entry[]) => void, removable = false) => (
    <div className="space-y-1">
      {list.map((e, i) => (
        <div key={e.url} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-secondary/30 border border-border">
          <Switch on={e.enabled} onClick={() => toggle(list, set, i)} />
          <span className="text-xs text-foreground font-mono truncate flex-1">{e.url}</span>
          {removable && <button type="button" onClick={() => set(list.filter((x) => x.url !== e.url))} className="text-muted-foreground hover:text-destructive cursor-pointer"><Trash2 size={12} /></button>}
        </div>
      ))}
    </div>
  )
  const field = 'w-full h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">Blossom servers</h4>
        <span className={cn('text-[11px] font-mono tabular-nums select-none', selected.length >= MAX_BLOSSOM_SERVERS ? 'text-amber-400' : 'text-muted-foreground/60')}>{selected.length}/{MAX_BLOSSOM_SERVERS}</span>
      </div>
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20">
        <Info size={14} className="text-primary shrink-0 mt-0.5" />
        <p className="text-[11px] text-muted-foreground leading-relaxed">Images, files and voice notes sent in the group are uploaded here and fetched from here by members. Nothing about membership is stored on them.</p>
      </div>
      {client.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Client Blossom servers</h4>
          {rows(client, setClient)}
        </div>
      )}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Your Blossom list (kind 10063)</h4>
        {user.length > 0 ? rows(user, setUser) : <p className="text-[11px] text-muted-foreground/60">No Blossom server list published.</p>}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Custom</h4>
        {custom.length > 0 && rows(custom, setCustom, true)}
        <div className="flex items-center gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add() }} placeholder="https://blossom.example.com" className={field} />
          <button type="button" onClick={add} className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"><Plus size={14} /></button>
        </div>
      </div>
    </div>
  )
}
