/**
 * GroupNotificationSettings: the per-hub mute toggles, for one group. Same flags and the same
 * store (a group is a single-channel hub to the notification store), minus @roles and @here since
 * a group has neither (§21.12). Toggling saves locally at once; Save publishes the group read-state
 * event (§21.9), which is where these flags live (encrypted, next to the read timestamps).
 */
import { useRef, useState } from 'react'
import { BellOff, MessagesSquare, AtSign, UsersRound, Loader2, Check, AlertTriangle } from 'lucide-react'
import { useNotificationStore } from '@/stores/notificationStore'
import { useUserStore } from '@/stores/userStore'
import type { HubMuteSettings } from '@/lib/notifications/readState'

const EMPTY: HubMuteSettings = {}
const KEYS = ['all', 'normal', 'mentions', 'everyone'] as const

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0 ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
    >
      <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
    </button>
  )
}

export function GroupNotificationSettings({ dTag }: { dTag: string }) {
  const settings = useNotificationStore((s) => s.hubMuteSettings[dTag] ?? EMPTY)
  const setHubMuteSettings = useNotificationStore((s) => s.setHubMuteSettings)
  const publishGroupReadState = useNotificationStore((s) => s.publishGroupReadState)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const initialRef = useRef<HubMuteSettings>({ ...settings })
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<'saved' | 'error' | null>(null)

  const isDirty = KEYS.some((k) => (settings[k] ?? false) !== (initialRef.current[k] ?? false))
  const update = (next: HubMuteSettings) => {
    // No roles and no @here in a group: keep those flags in step with "all" so the master toggle stays consistent.
    const allSubsOn = !!(next.normal && next.mentions && next.everyone)
    setHubMuteSettings(dTag, { ...next, all: allSubsOn, here: allSubsOn, roles: allSubsOn })
    setResult(null)
  }
  const save = async () => {
    setSaving(true); setResult(null)
    try {
      const ok = await publishGroupReadState(signer, privateKey)
      if (ok) initialRef.current = { ...settings }
      setResult(ok ? 'saved' : 'error')
    } catch { setResult('error') } finally { setSaving(false) }
  }

  const rows = [
    { key: 'normal' as const, icon: MessagesSquare, label: 'Mute normal messages', desc: 'Regular messages that do not mention you' },
    { key: 'mentions' as const, icon: AtSign, label: 'Mute @mentions', desc: 'Personal @npub and @DNN mentions' },
    { key: 'everyone' as const, icon: UsersRound, label: 'Mute @everyone', desc: '@everyone mentions' },
  ]

  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-foreground">Notifications</span>
      <div className="rounded-lg border border-border p-1">
        <label className="flex items-center justify-between cursor-pointer group px-2.5 py-2 rounded-md hover:bg-secondary/40 transition-colors">
          <div className="flex items-center gap-3">
            <BellOff size={15} className="text-muted-foreground group-hover:text-foreground transition-colors" />
            <div>
              <span className="text-sm font-medium text-foreground">Mute all messages</span>
              <p className="text-[11px] text-muted-foreground">No badges or sounds from this group</p>
            </div>
          </div>
          <ToggleSwitch checked={settings.all ?? false} onChange={(v) => update({ all: v, normal: v, mentions: v, everyone: v })} />
        </label>
        <div className="h-px bg-border my-1" />
        {rows.map(({ key, icon: Icon, label, desc }) => (
          <label key={key} className="flex items-center justify-between cursor-pointer group px-2.5 py-2 rounded-md hover:bg-secondary/40 transition-colors">
            <div className="flex items-center gap-3">
              <Icon size={15} className="text-muted-foreground group-hover:text-foreground transition-colors" />
              <div>
                <span className="text-sm text-foreground">{label}</span>
                <p className="text-[11px] text-muted-foreground">{desc}</p>
              </div>
            </div>
            <ToggleSwitch checked={settings[key] ?? false} onChange={(v) => update({ ...settings, [key]: v })} />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={!isDirty || saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving && <Loader2 size={12} className="animate-spin" />} Save
        </button>
        {result === 'saved' && <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><Check size={12} /> Synced to your relays</span>}
        {result === 'error' && <span className="inline-flex items-center gap-1 text-xs text-destructive"><AlertTriangle size={12} /> Saved here, sync failed</span>}
        {!result && isDirty && <span className="text-[11px] text-muted-foreground">Saved on this device. Save to sync across devices.</span>}
      </div>
    </div>
  )
}
