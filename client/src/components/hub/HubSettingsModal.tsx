/**
 * HubSettingsModal — Editable hub settings with publish
 *
 * Two-panel layout: sidebar nav (General, Roles) + content area.
 * General page: editable banner/icon (drag-drop), name, description,
 * tags (pill editor), categories + channels (drag-drop reorder).
 * Publish Changes button only active when changes detected.
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  X, Settings, Shield, Hash, Camera, ImageIcon,
  Loader2, Plus, Minus, Trash2, GripVertical, ChevronDown, ChevronUp,
  ChevronRight, Tag, XCircle, Zap, RotateCcw, AlertTriangle,
  Lock, ShieldCheck, RefreshCw, ShieldBan, Search, MessagesSquare, Megaphone, Pencil, Volume2,
  Radio, Info, Lightbulb, Flag, Users, Check, ChevronLeft, UserPlus, EyeOff, Ban,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { useHubStore, type HubData, type Channel, type Category, type Role, type HubMember, type HideEntry } from '@/stores/hubStore'
import { useMessageStore } from '@/stores/messageStore'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { useUserStore } from '@/stores/userStore'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { uploadToBlossomServers, blossomServers as blossomServerManager } from '@/lib/blossom'
import type { UploadProgress } from '@/lib/blossom'
import { buildHubEvent } from '@/lib/hub/buildHubEvent'
import { signWithSigner, createUnsignedEvent } from '@/lib/nostr'
import { publishToSpecificRelays, getRelayList } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { KINDS } from '@/lib/crypto/constants'
import { aesDecrypt } from '@/lib/crypto/aes'
import { deriveChannelKey } from '@/lib/crypto/hkdf'
import { benchmarkHashRate, estimateSolveTime } from '@/lib/pow/pow'
import { createAndUploadMemberFiles } from '@/lib/blossom/members'
import { toHex, fromHex } from '@/lib/crypto/lkh'
import { buildHubEvent as rebuildHubEvent } from '@/lib/hub/buildHubEvent'
import { DeleteConfirmDialog } from '@/components/hub/ChannelView'
import { useUserListsStore } from '@/stores/userListsStore'
import { useReportStore, type HubReport } from '@/stores/reportStore'
import { nip19 } from 'nostr-tools'
import { PERMISSION_KEYS, PERMISSION_LABELS, PERMISSION_DESCRIPTIONS, DISABLED_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, getPermissionsForUser, type ResolvedPermissions } from '@/lib/hub/permissions'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { Pagination } from '@/components/ui/Pagination'

const EMPTY_REPORTS: HubReport[] = []

/** Compact tooltip wrapper — avoids 6 lines of nesting per tooltip */
function Tip({ children, text, side = 'top' }: { children: React.ReactNode; text: string; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{text}</TooltipContent>
    </Tooltip>
  )
}

// ── Image upload helpers (shared with CreateHubDialog) ──

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const ACCEPTED_IMAGE_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.webp'

function isValidImageFile(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(file.type)
}

function shortServerName(url: string): string {
  try { return new URL(url).hostname.replace('www.', '') } catch { return url }
}

function formatSpeed(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

// ── Role Color Picker ──

const COLOR_PRESETS = [
  // Row 1 — warm
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  // Row 2 — cool
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1',
  // Row 3 — vivid
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e',
  // Row 4 — muted / pastel
  '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee',
  // Row 5 — deep
  '#818cf8', '#c084fc', '#e879f9', '#f472b6', '#fda4af',
]

function RoleColorPicker({ color, onChange }: { color?: string; onChange: (c: string | undefined) => void }) {
  const [open, setOpen] = useState(false)
  const [hexInput, setHexInput] = useState(color || '#6366f1')
  const ref = useRef<HTMLDivElement>(null)

  // Sync hex input when color prop changes
  useEffect(() => {
    setHexInput(color || '#6366f1')
  }, [color])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const activeColor = color || '#6366f1'

  const handleHexChange = (val: string) => {
    setHexInput(val)
    // Only apply if valid hex
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      onChange(val)
    }
  }

  return (
    <div ref={ref} className="relative">
      <label className="text-xs text-muted-foreground mb-1 block">Color</label>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 h-8 px-2 rounded-md border border-border hover:border-primary/40 transition-all cursor-pointer bg-secondary/30"
      >
        <div
          className="w-5 h-5 rounded-full ring-1 ring-white/10 shadow-sm transition-colors"
          style={{ backgroundColor: activeColor }}
        />
        <span className="text-xs text-muted-foreground font-mono">{activeColor}</span>
        <ChevronDown size={10} className={cn('text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-[70] mt-1.5 right-0 w-[220px] bg-card border border-border rounded-xl shadow-2xl p-3 flex flex-col gap-3 animate-in fade-in-0 zoom-in-95">
          {/* Active color preview */}
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-lg ring-1 ring-white/10 shadow-inner shrink-0"
              style={{ backgroundColor: activeColor }}
            />
            <div className="flex-1 min-w-0">
              <input
                value={hexInput}
                onChange={(e) => handleHexChange(e.target.value)}
                onBlur={() => {
                  if (!/^#[0-9a-fA-F]{6}$/.test(hexInput)) {
                    setHexInput(activeColor)
                  }
                }}
                maxLength={7}
                spellCheck={false}
                className="w-full h-7 rounded-md border border-border bg-background px-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                placeholder="#6366f1"
              />
            </div>
          </div>

          {/* Swatch grid */}
          <div className="grid grid-cols-5 gap-1.5">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                onClick={() => { onChange(c); setHexInput(c) }}
                className={cn(
                  'w-full aspect-square rounded-lg transition-all cursor-pointer hover:scale-110 hover:ring-2 hover:ring-white/20',
                  activeColor === c && 'ring-2 ring-white/50 scale-110',
                )}
                style={{ backgroundColor: c }}
              >
                {activeColor === c && (
                  <Check size={12} className="mx-auto text-white drop-shadow-[0_1px_2px_rgba(0,0,0,.5)]" />
                )}
              </button>
            ))}
          </div>

          {/* Reset */}
          {color && (
            <button
              onClick={() => { onChange(undefined); setHexInput('#6366f1'); setOpen(false) }}
              className="flex items-center justify-center gap-1.5 h-7 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors cursor-pointer border border-border/50"
            >
              <RotateCcw size={10} />
              Reset to Default
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Props ──

interface HubSettingsModalProps {
  open: boolean
  onClose: () => void
  hub: HubData
}


type SettingsPage = 'general' | 'channels' | 'roles' | 'members' | 'network' | 'security' | 'banned' | 'hidden' | 'reports' | 'dangerous'

const PAGES: { id: SettingsPage; label: string; icon: React.ElementType; danger?: boolean; creatorOnly?: boolean }[] = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'channels', label: 'Channels', icon: Hash },
  { id: 'roles', label: 'Roles', icon: Shield },
  { id: 'members', label: 'Members', icon: Users, creatorOnly: true },
  { id: 'network', label: 'Network', icon: Radio, creatorOnly: true },
  { id: 'security', label: 'Security', icon: Lock, creatorOnly: true },
  { id: 'banned', label: 'Banned Users', icon: ShieldBan, creatorOnly: true },
  { id: 'hidden', label: 'Hidden Messages', icon: EyeOff, creatorOnly: true },
  { id: 'reports', label: 'Reports', icon: Flag, creatorOnly: true },
  { id: 'dangerous', label: 'Dangerous', icon: AlertTriangle, danger: true },
]

// ── Main Modal ──

export function HubSettingsModal({ open, onClose, hub }: HubSettingsModalProps) {
  const [activePage, setActivePage] = useState<SettingsPage>('general')
  const [mobileShowNav, setMobileShowNav] = useState(true)

  // Editable state — cloned from hub on open
  const [editName, setEditName] = useState(hub.name)
  const [editDescription, setEditDescription] = useState(hub.description || '')
  const [editIcon, setEditIcon] = useState(hub.icon || '')
  const [editBanner, setEditBanner] = useState(hub.banner || '')
  const [editTags, setEditTags] = useState<string[]>(hub.tags || [])
  const [editCategories, setEditCategories] = useState<Category[]>(() => [...hub.categories].sort((a, b) => a.position - b.position))
  const [editChannels, setEditChannels] = useState<Channel[]>(() => [...hub.channels])
  const [editMinPow, setEditMinPow] = useState(hub.minPow || 0)
  const [editNsfw, setEditNsfw] = useState(hub.nsfw || false)
  const [editDiscoverable, setEditDiscoverable] = useState(hub.discoverable !== false)
  const [editRelays, setEditRelays] = useState<string[]>(() => [...hub.generalRelays])
  const [editBlossoms, setEditBlossoms] = useState<string[]>(() => [...hub.blossomServers])
  const [editRoles, setEditRoles] = useState<Role[]>(() => [...hub.roles])

  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishStep, setPublishStep] = useState<string | null>(null)
  const [publishStepsCompleted, setPublishStepsCompleted] = useState<string[]>([])

  // Member page footer state (reported by MembersPage)
  const [memberFooterState, setMemberFooterState] = useState<{
    isDirty: boolean
    saving: boolean
    error: string | null
    success: boolean
    modifiedCount: number
    onSave: (() => void) | null
    onDiscard: (() => void) | null
    saveStep: string | null
    saveStepsCompleted: string[]
  }>({ isDirty: false, saving: false, error: null, success: false, modifiedCount: 0, onSave: null, onDiscard: null, saveStep: null, saveStepsCompleted: [] })

  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const pubkey = useUserStore((s) => s.pubkey)
  const setHubData = useHubStore((s) => s.setHubData)
  const setHubStatus = useHubStore((s) => s.setHubStatus)

  const isCreator = pubkey === hub.creatorPubkey

  // Reset when hub changes or modal reopens
  useEffect(() => {
    if (open) {
      setEditName(hub.name)
      setEditDescription(hub.description || '')
      setEditIcon(hub.icon || '')
      setEditBanner(hub.banner || '')
      setEditTags(hub.tags || [])
      setEditCategories([...hub.categories].sort((a, b) => a.position - b.position))
      setEditChannels([...hub.channels])
      setEditMinPow(hub.minPow || 0)
      setEditNsfw(hub.nsfw || false)
      setEditDiscoverable(hub.discoverable !== false)
      setEditRelays([...hub.generalRelays])
      setEditBlossoms([...hub.blossomServers])
      setEditRoles([...hub.roles])
      setPublishError(null)
    }
  }, [open, hub])

  // Change detection
  const hasChanges = useMemo(() => {
    if (editName !== hub.name) return true
    if (editDescription !== (hub.description || '')) return true
    if (editIcon !== (hub.icon || '')) return true
    if (editBanner !== (hub.banner || '')) return true
    if (JSON.stringify(editTags) !== JSON.stringify(hub.tags || [])) return true
    if (JSON.stringify(editCategories.map(c => ({ id: c.categoryId, name: c.name, pos: c.position, perms: c.permissions }))) !==
      JSON.stringify([...hub.categories].sort((a, b) => a.position - b.position).map(c => ({ id: c.categoryId, name: c.name, pos: c.position, perms: c.permissions })))) return true
    if (JSON.stringify(editChannels.map(c => ({ id: c.channelId, name: c.name, cat: c.categoryId, pos: c.position, type: c.type, perms: c.permissions }))) !==
      JSON.stringify(hub.channels.map(c => ({ id: c.channelId, name: c.name, cat: c.categoryId, pos: c.position, type: c.type, perms: c.permissions })))) return true
    if (editMinPow !== (hub.minPow || 0)) return true
    if (editNsfw !== (hub.nsfw || false)) return true
    if (editDiscoverable !== (hub.discoverable !== false)) return true
    if (JSON.stringify([...editRelays].sort()) !== JSON.stringify([...hub.generalRelays].sort())) return true
    if (JSON.stringify([...editBlossoms].sort()) !== JSON.stringify([...hub.blossomServers].sort())) return true
    if (JSON.stringify(editRoles.map(r => ({ id: r.roleId, name: r.name, color: r.color, pos: r.position, hoist: r.hoist, perms: r.permissions }))) !==
      JSON.stringify(hub.roles.map(r => ({ id: r.roleId, name: r.name, color: r.color, pos: r.position, hoist: r.hoist, perms: r.permissions })))) return true
    return false
  }, [editName, editDescription, editIcon, editBanner, editTags, editCategories, editChannels, editMinPow, editNsfw, editDiscoverable, editRelays, editBlossoms, editRoles, hub])

  // Role change summary for the Roles page footer
  const roleChangeSummary = useMemo(() => {
    const hubRoleIds = new Set(hub.roles.map(r => r.roleId))
    const editRoleIds = new Set(editRoles.map(r => r.roleId))
    const deleted = hub.roles.filter(r => !editRoleIds.has(r.roleId)).length
    const added = editRoles.filter(r => !hubRoleIds.has(r.roleId)).length
    const modified = editRoles.filter(r => {
      if (!hubRoleIds.has(r.roleId)) return false
      const original = hub.roles.find(o => o.roleId === r.roleId)
      if (!original) return false
      return r.name !== original.name ||
        r.color !== original.color ||
        r.position !== original.position ||
        r.hoist !== original.hoist ||
        JSON.stringify(r.permissions) !== JSON.stringify(original.permissions)
    }).length
    const total = deleted + added + modified
    return { deleted, added, modified, total }
  }, [editRoles, hub.roles])

  // General page change summary
  const generalChangeSummary = useMemo(() => {
    const fields: string[] = []
    if (editName !== hub.name) fields.push('name')
    if (editDescription !== (hub.description || '')) fields.push('description')
    if (editIcon !== (hub.icon || '')) fields.push('icon')
    if (editBanner !== (hub.banner || '')) fields.push('banner')
    if (JSON.stringify(editTags) !== JSON.stringify(hub.tags || [])) fields.push('tags')
    if (editMinPow !== (hub.minPow || 0)) fields.push('proof of work')
    if (editNsfw !== (hub.nsfw || false)) fields.push('NSFW')
    if (editDiscoverable !== (hub.discoverable !== false)) fields.push('discoverability')
    return fields
  }, [editName, editDescription, editIcon, editBanner, editTags, editMinPow, editNsfw, editDiscoverable, hub])

  // Channels page change summary
  const channelChangeSummary = useMemo(() => {
    const hubChIds = new Set(hub.channels.map(c => c.channelId))
    const editChIds = new Set(editChannels.map(c => c.channelId))
    const hubCatIds = new Set(hub.categories.map(c => c.categoryId))
    const editCatIds = new Set(editCategories.map(c => c.categoryId))
    const chDeleted = hub.channels.filter(c => !editChIds.has(c.channelId)).length
    const chAdded = editChannels.filter(c => !hubChIds.has(c.channelId)).length
    const chModified = editChannels.filter(c => {
      if (!hubChIds.has(c.channelId)) return false
      const orig = hub.channels.find(o => o.channelId === c.channelId)
      if (!orig) return false
      return c.name !== orig.name || c.categoryId !== orig.categoryId ||
        c.type !== orig.type || c.synced !== orig.synced ||
        JSON.stringify(c.permissions) !== JSON.stringify(orig.permissions)
    }).length
    const catDeleted = hub.categories.filter(c => !editCatIds.has(c.categoryId)).length
    const catAdded = editCategories.filter(c => !hubCatIds.has(c.categoryId)).length
    const catModified = editCategories.filter(c => {
      if (!hubCatIds.has(c.categoryId)) return false
      const orig = hub.categories.find(o => o.categoryId === c.categoryId)
      if (!orig) return false
      return c.name !== orig.name || JSON.stringify(c.permissions) !== JSON.stringify(orig.permissions)
    }).length
    // Also check if positions changed (reorder)
    const posChanged = JSON.stringify(editChannels.map(c => c.channelId)) !== JSON.stringify(hub.channels.map(c => c.channelId)) ||
      JSON.stringify(editCategories.map(c => c.categoryId)) !== JSON.stringify([...hub.categories].sort((a, b) => a.position - b.position).map(c => c.categoryId))
    const total = chDeleted + chAdded + chModified + catDeleted + catAdded + catModified + (posChanged && chDeleted + chAdded + chModified + catDeleted + catAdded + catModified === 0 ? 1 : 0)
    return { chDeleted, chAdded, chModified, catDeleted, catAdded, catModified, posChanged, total }
  }, [editChannels, editCategories, hub.channels, hub.categories])

  // Network page change summary
  const networkChangeSummary = useMemo(() => {
    const relaysDiff = JSON.stringify([...editRelays].sort()) !== JSON.stringify([...hub.generalRelays].sort())
    const blossomDiff = JSON.stringify([...editBlossoms].sort()) !== JSON.stringify([...hub.blossomServers].sort())
    const parts: string[] = []
    if (relaysDiff) parts.push('relays')
    if (blossomDiff) parts.push('blossom servers')
    return { parts, total: parts.length }
  }, [editRelays, editBlossoms, hub.generalRelays, hub.blossomServers])

  const handlePublish = async () => {
    setPublishing(true)
    setPublishError(null)
    setPublishStepsCompleted([])

    /** Track publish progress — yields to let React render between sync steps */
    const markStep = async (step: string) => {
      setPublishStep(step)
      await new Promise(r => setTimeout(r, 0))
    }
    const markStepDone = (step: string) => setPublishStepsCompleted(prev => [...prev, step])

    try {
      await markStep('Preparing channels & categories')
      // Recalculate positions
      const finalCategories = editCategories.map((c, i) => ({ ...c, position: i }))
      const finalChannels = editChannels.map(ch => {
        // Find its position within its category group
        const siblings = editChannels.filter(c => c.categoryId === ch.categoryId)
        const pos = siblings.indexOf(ch)
        return { ...ch, position: pos >= 0 ? pos : 0 }
      })

      markStepDone('Preparing channels & categories')

      // ── Compute encryption from read_messages permissions ──
      // For voice channels, read_messages and connect_voice are locked together in the UI,
      // so checking read_messages covers both text and voice access control.
      await markStep('Computing channel encryption')
      const everyoneRole = editRoles.find(r => r.name === 'everyone')
      const { computeGroupId } = await import('@/lib/hub/groupEncryption')
      const existingGroups = hub.groupedRoles || []
      const newGroupedRoles: Array<{ groupId: string; roleIds: string[]; epoch: number }> = []

      // Helper: derive encryption for a channel/category from its permissions
      // Checks if 'everyone' has read_messages: deny (or connect_voice: deny, which is synced)
      const computeEncryptionFromPerms = async (permsObj: Record<string, Record<string, boolean>> | undefined, channelType?: string): Promise<{ groupId: string | null; roleIds: string[] }> => {
        if (!permsObj || !everyoneRole) return { groupId: null, roleIds: [] }
        const everyoneOverrides = permsObj[everyoneRole.roleId]
        // Check if everyone has read_messages: deny (or connect_voice: deny for voice channels)
        const isReadDenied = everyoneOverrides?.['read_messages'] === false
        const isConnectDenied = channelType === 'voice' && everyoneOverrides?.['connect_voice'] === false
        if (!isReadDenied && !isConnectDenied) return { groupId: null, roleIds: [] }
        // Channel is private — find roles with read_messages: allow (or connect_voice: allow for voice)
        const allowedRoleIds: string[] = []
        for (const role of editRoles) {
          if (role.name === 'everyone') continue
          const roleOverrides = permsObj[role.roleId]
          const hasReadAllow = roleOverrides?.['read_messages'] === true
          const hasConnectAllow = channelType === 'voice' && roleOverrides?.['connect_voice'] === true
          if (hasReadAllow || hasConnectAllow) {
            allowedRoleIds.push(role.roleId)
          }
        }
        // Compute group ID (empty roles = creator-only group, use special sentinel)
        if (allowedRoleIds.length === 0) {
          // Creator-only: use a deterministic ID from just the everyone role
          const groupId = await computeGroupId(['__creator_only__'])
          return { groupId, roleIds: [] }
        }
        const groupId = await computeGroupId(allowedRoleIds)
        return { groupId, roleIds: allowedRoleIds }
      }

      // Process categories — compute encryption from their permissions
      for (let i = 0; i < finalCategories.length; i++) {
        const { groupId, roleIds } = await computeEncryptionFromPerms(finalCategories[i].permissions)
        finalCategories[i] = { ...finalCategories[i], encryption: groupId }
        if (groupId) {
          const existing = existingGroups.find(g => g.groupId === groupId)
          if (existing && !newGroupedRoles.some(g => g.groupId === groupId)) {
            newGroupedRoles.push(existing)
          } else if (!newGroupedRoles.some(g => g.groupId === groupId)) {
            newGroupedRoles.push({ groupId, roleIds, epoch: 1 })
          }
        }
      }

      // Process channels — compute encryption from permissions (or inherit from synced category)
      for (let i = 0; i < finalChannels.length; i++) {
        const ch = finalChannels[i]
        if (ch.synced && ch.categoryId) {
          // Synced channels inherit encryption from their category
          const cat = finalCategories.find(c => c.categoryId === ch.categoryId)
          finalChannels[i] = { ...ch, encryption: null } // actual encryption comes from category at runtime
        } else {
          const { groupId, roleIds } = await computeEncryptionFromPerms(ch.permissions, ch.type)
          finalChannels[i] = { ...ch, encryption: groupId }
          if (groupId) {
            const existing = existingGroups.find(g => g.groupId === groupId)
            if (existing && !newGroupedRoles.some(g => g.groupId === groupId)) {
              newGroupedRoles.push(existing)
            } else if (!newGroupedRoles.some(g => g.groupId === groupId)) {
              newGroupedRoles.push({ groupId, roleIds, epoch: 1 })
            }
          }
        }
      }

      markStepDone('Computing channel encryption')

      // ── Auto-create group trees for new encryption groups ──
      let currentIndexHash = hub.indexFileHash
      const existingGroupTrees: Array<{ groupId: string; hash: string }> = []

      // Fetch the current index to get existing group tree hashes
      if (newGroupedRoles.length > 0) {
        try {
          await markStep('Fetching encryption index')
          const { downloadTextFromBlossom } = await import('@/lib/blossom/client')
          const { parseIndexFile, createAndUploadGroupTree } = await import('@/lib/blossom/members')
          const { getGroupMembers } = await import('@/lib/hub/groupEncryption')
          const indexContent = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
          const index = parseIndexFile(indexContent)
          markStepDone('Fetching encryption index')

          // Carry forward existing group trees
          existingGroupTrees.push(...index.groupTrees)

          // Check for new groups that need trees created
          const hubMembers = useHubStore.getState().hubMembers[hub.dTag] || []
          let indexChanged = false

          for (const group of newGroupedRoles) {
            const alreadyHasTree = index.groupTrees.some(gt => gt.groupId === group.groupId)
            if (!alreadyHasTree) {
              // New group — create tree
              await markStep(`Creating group tree (${group.roleIds.length} roles)`)
              const qualifying = getGroupMembers(hubMembers, group.roleIds)
              // Always include the creator
              const memberPubkeys = Array.from(new Set([
                hub.creatorPubkey,
                ...qualifying.map(m => m.pubkey),
              ]))

              // Generate random group secret (32 bytes)
              const groupSecret = crypto.getRandomValues(new Uint8Array(32))
              const groupTreeHash = await createAndUploadGroupTree(
                memberPubkeys, groupSecret, signer, privateKey, hub.blossomServers,
              )

              existingGroupTrees.push({ groupId: group.groupId, hash: groupTreeHash })
              indexChanged = true

              // Store group secret locally
              const { setGroupSecret } = useHubStore.getState()
              const secretHex = Array.from(groupSecret).map(b => b.toString(16).padStart(2, '0')).join('')
              setGroupSecret(hub.dTag, group.groupId, secretHex)

              console.log(`Created group tree for ${group.groupId}: ${groupTreeHash}`)
              markStepDone(`Creating group tree (${group.roleIds.length} roles)`)
            }
          }

          // Also remove group tree refs for groups that no longer exist
          const activeGroupIds = new Set(newGroupedRoles.map(g => g.groupId))
          const prunedGroupTrees = existingGroupTrees.filter(gt => activeGroupIds.has(gt.groupId))
          if (prunedGroupTrees.length !== existingGroupTrees.length) indexChanged = true

          // Re-upload index file if it changed
          if (indexChanged) {
            await markStep('Uploading encryption index')
            const banPageHashes = index.banPages.map(bp => bp.hash)
            const { createPaginatedIndexFile } = await import('@/lib/blossom/members')
            const newIndexContent = createPaginatedIndexFile(
              index.spineHash, index.leafPages, banPageHashes,
              index.historyHash || undefined,
              prunedGroupTrees.length > 0 ? prunedGroupTrees : undefined,
            )
            const indexBytes = new TextEncoder().encode(newIndexContent)
            const { uploadToBlossomServers } = await import('@/lib/blossom/client')
            const { hash: newIndexHash } = await uploadToBlossomServers(
              indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
            )

            // Verify the new index is downloadable and correct before committing
            const verifyContent = await downloadTextFromBlossom(newIndexHash, hub.blossomServers)
            const verifyIndex = parseIndexFile(verifyContent)
            if (verifyIndex.spineHash !== index.spineHash) {
              throw new Error(`Group tree index verification failed — spine hash mismatch`)
            }

            currentIndexHash = newIndexHash
            console.log(`Updated index file with group trees: ${newIndexHash}`)
            markStepDone('Uploading encryption index')
          }
        } catch (err) {
          // Don't swallow — if blossom upload/verify failed, abort the entire publish
          // to prevent the hub event from referencing unreachable files
          throw new Error(`Failed to process group trees: ${err instanceof Error ? err.message : err}`)
        }
      }

      // ── Role deletion cascade: clean permissions + update member tree ──
      const currentRoleIds = new Set(editRoles.map(r => r.roleId))
      const deletedRoleIds = hub.roles
        .filter(r => !currentRoleIds.has(r.roleId))
        .map(r => r.roleId)

      if (deletedRoleIds.length > 0) {
        // Strip stale permission overrides from channels and categories
        await markStep('Cleaning deleted roles')
        const deletedSet = new Set(deletedRoleIds)
        for (let i = 0; i < finalChannels.length; i++) {
          if (finalChannels[i].permissions) {
            const cleaned = Object.fromEntries(
              Object.entries(finalChannels[i].permissions!).filter(([rid]) => !deletedSet.has(rid))
            )
            finalChannels[i] = { ...finalChannels[i], permissions: Object.keys(cleaned).length > 0 ? cleaned : undefined }
          }
        }
        for (let i = 0; i < finalCategories.length; i++) {
          if (finalCategories[i].permissions) {
            const cleaned = Object.fromEntries(
              Object.entries(finalCategories[i].permissions!).filter(([rid]) => !deletedSet.has(rid))
            )
            finalCategories[i] = { ...finalCategories[i], permissions: Object.keys(cleaned).length > 0 ? cleaned : undefined }
          }
        }
        markStepDone('Cleaning deleted roles')

        // Update the member tree — strip deleted role IDs from each member
        // Downloads only affected pages, updates roles, rebuilds spine.
        await markStep('Updating member tree')
        const { downloadTextFromBlossom } = await import('@/lib/blossom/client')
        const { parseIndexFile, updateMemberRolesInPage } = await import('@/lib/blossom/members')
        const {
          deserializeLeafPage, serializeLeafPage,
          deserializeSpine, recoverPageRootKeys, buildSpine, serializeSpine,
          fromHex,
        } = await import('@/lib/crypto/lkh')

        const indexContent = await downloadTextFromBlossom(currentIndexHash, hub.blossomServers)
        const index = parseIndexFile(indexContent)

        if (index.spineHash && index.leafPages.length > 0) {
          const spineContent = await downloadTextFromBlossom(index.spineHash, hub.blossomServers)
          const spine = deserializeSpine(spineContent)
          const hubSecretHex = useHubStore.getState().hubSecrets[hub.dTag]
          const hubSecret = hubSecretHex ? fromHex(hubSecretHex) : null

          if (hubSecret) {
            const pageRootKeys = await recoverPageRootKeys(spine, hubSecret)
            const updatedPages: Array<{ pageIndex: number; content: string; firstPubkey: string }> = []
            let anyChanged = false

            // Download each page, update roles if needed
            for (let pi = 0; pi < index.leafPages.length; pi++) {
              const pageRef = index.leafPages[pi]
              const pageContent = await downloadTextFromBlossom(pageRef.hash, hub.blossomServers)
              const page = deserializeLeafPage(pageContent)

              let pageChanged = false
              for (const leaf of page.leaves) {
                const roles = (leaf.roles || 'everyone').split('|').map(s => s.trim())
                const filtered = roles.filter(r => !deletedSet.has(r))
                const newRoles = filtered.length > 0 ? filtered.join('|') : 'everyone'
                if (newRoles !== leaf.roles) {
                  leaf.roles = newRoles
                  pageChanged = true
                }
              }

              if (pageChanged) {
                // Re-serialize the page (roles are metadata, don't affect tree keys)
                updatedPages.push({
                  pageIndex: pageRef.pageIndex,
                  content: serializeLeafPage(page),
                  firstPubkey: page.leaves[0].pubkey,
                })
                anyChanged = true
              }
            }

            if (anyChanged) {
              // Upload updated pages + rebuild spine (spine keys unchanged since no add/remove)
              const { uploadToBlossomServers } = await import('@/lib/blossom/client')
              const newLeafPages = [...index.leafPages]

              for (const up of updatedPages) {
                const pageBytes = new TextEncoder().encode(up.content)
                const { hash } = await uploadToBlossomServers(
                  pageBytes, signer, privateKey, hub.blossomServers, 'text/plain',
                )
                const idx = newLeafPages.findIndex(p => p.pageIndex === up.pageIndex)
                if (idx >= 0) newLeafPages[idx] = { ...newLeafPages[idx], firstPubkey: up.firstPubkey, hash }
              }

              // Spine structure is unchanged (no add/remove), just re-serialize with same keys
              const newSpine = await buildSpine(pageRootKeys, hubSecret)
              const newSpineContent = serializeSpine(newSpine)
              const spineBytes = new TextEncoder().encode(newSpineContent)
              const { hash: newSpineHash } = await uploadToBlossomServers(
                spineBytes, signer, privateKey, hub.blossomServers, 'text/plain',
              )

              // Create new index
              const { createPaginatedIndexFile } = await import('@/lib/blossom/members')
              const banPageHashes = index.banPages.map(bp => bp.hash)
              const groupTrees = index.groupTrees.length > 0 ? index.groupTrees : undefined
              const newIndexContent = createPaginatedIndexFile(
                newSpineHash, newLeafPages, banPageHashes,
                index.historyHash || undefined, groupTrees,
              )
              const indexBytes = new TextEncoder().encode(newIndexContent)
              const { hash: newIndexHash } = await uploadToBlossomServers(
                indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
              )
              currentIndexHash = newIndexHash

              // Update local member list
              const setHubMembers = useHubStore.getState().setHubMembers
              const hubMembers = useHubStore.getState().hubMembers[hub.dTag] || []
              const updatedMembers = hubMembers.map(m => {
                const roles = (m.roles || 'everyone').split('|').map(s => s.trim())
                const filtered = roles.filter(r => !deletedSet.has(r))
                const newRoles = filtered.length > 0 ? filtered.join('|') : 'everyone'
                return newRoles !== m.roles ? { ...m, roles: newRoles } : m
              })
              setHubMembers(hub.dTag, updatedMembers)

              console.log(`Role deletion cascade: updated ${deletedRoleIds.length} deleted role(s) in paginated tree, new index: ${currentIndexHash}`)
            }
          }
        }
        markStepDone('Updating member tree')
      }

      await markStep('Signing hub event')
      const unsignedEvent = buildHubEvent({
        dTag: hub.dTag,
        name: editName.trim(),
        description: editDescription.trim() || undefined,
        epoch: hub.epoch,
        icon: editIcon || undefined,
        banner: editBanner || undefined,
        tags: editTags.length > 0 ? editTags : undefined,
        relays: editRelays,
        blossomServers: editBlossoms,
        indexFileHash: currentIndexHash,
        channels: finalChannels,
        categories: finalCategories,
        roles: editRoles,
        minPow: editMinPow > 0 ? editMinPow : undefined,
        nsfw: editNsfw || undefined,
        discoverable: editDiscoverable,
        groupedRoles: newGroupedRoles.length > 0 ? newGroupedRoles : undefined,
        publishedAt: hub.publishedAt,

      })

      const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
      markStepDone('Signing hub event')

      await markStep('Publishing to relays')
      await publishToSpecificRelays(getPublishRelays([...editRelays]), signedEvent)
      markStepDone('Publishing to relays')

      // Update local store
      setHubData(hub.dTag, {
        ...hub,
        name: editName.trim(),
        description: editDescription.trim(),
        icon: editIcon || undefined,
        banner: editBanner || undefined,
        tags: editTags.length > 0 ? editTags : undefined,
        channels: finalChannels,
        categories: finalCategories,
        roles: editRoles,
        generalRelays: editRelays,
        blossomServers: editBlossoms,
        minPow: editMinPow,
        nsfw: editNsfw,
        discoverable: editDiscoverable,
        groupedRoles: newGroupedRoles.length > 0 ? newGroupedRoles : undefined,
        indexFileHash: currentIndexHash,
      })

      await markStep('Done')
    } catch (err: any) {
      console.error('Failed to publish hub changes:', err)
      setPublishError(err.message || 'Failed to publish')
    } finally {
      setPublishing(false)
      setPublishStep(null)
    }
  }

  if (!open) return null

  return (
    <>
      <TooltipProvider delayDuration={200}>
        <div className="fixed inset-0 z-50 flex items-center justify-center px-2">
          <div className="absolute inset-0 bg-black/80" onClick={onClose} />

          <div className="relative z-10 w-full max-w-3xl h-[80vh] rounded-lg border border-border bg-background shadow-lg animate-in fade-in-0 zoom-in-95 flex flex-col overflow-hidden max-[1080px]:max-w-full max-[1080px]:h-[95vh] max-[1080px]:rounded-xl">
            <div className="flex flex-1 overflow-hidden">
              {/* Left sidebar — on mobile becomes full-width page list */}
              <div className={`w-52 min-w-52 bg-secondary/50 border-r border-border flex flex-col max-[1080px]:w-full max-[1080px]:min-w-full max-[1080px]:border-r-0 ${mobileShowNav ? '' : 'max-[1080px]:hidden'}`}>
                <div className="flex items-center justify-between px-4 py-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
                    {hub.name}
                  </h3>
                  <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer min-[1081px]:hidden">
                    <X size={18} />
                  </button>
                </div>
                <nav className="flex flex-col gap-1 px-2 flex-1 overflow-y-auto">
                  {PAGES.filter(page => {
                    if (page.id === 'dangerous' && !isCreator) return false
                    if (page.creatorOnly && !isCreator) return false
                    return true
                  }).map((page) => (
                    <>
                      {page.danger && <Separator className="my-2" />}
                      <button
                        key={page.id}
                        onClick={() => { setActivePage(page.id); setMobileShowNav(false) }}
                        className={cn(
                          'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer',
                          'max-[1080px]:py-3',
                          activePage === page.id
                            ? page.danger ? 'bg-destructive/20 text-destructive font-medium' : 'bg-accent text-accent-foreground'
                            : page.danger ? 'text-destructive hover:bg-destructive/20 hover:text-destructive' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                        )}
                      >
                        <page.icon size={16} />
                        {page.label}
                        <ChevronRight size={14} className="ml-auto text-muted-foreground min-[1081px]:hidden" />
                      </button>
                    </>
                  ))}
                </nav>
              </div>

              {/* Right content — on mobile hidden when nav is shown */}
              <div className={`flex-1 flex flex-col overflow-hidden ${mobileShowNav ? 'max-[1080px]:hidden' : ''}`}>
                <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
                  {/* Mobile back button */}
                  <div className="flex items-center gap-2">
                    <button onClick={() => setMobileShowNav(true)} className="text-muted-foreground hover:text-foreground cursor-pointer min-[1081px]:hidden">
                      <ChevronLeft size={18} />
                    </button>
                    <h2 className="text-lg font-semibold text-foreground">
                      {PAGES.find((p) => p.id === activePage)?.label}
                    </h2>
                  </div>
                  <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                    <X size={18} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                  {activePage === 'general' && (
                    <GeneralPage
                      hub={hub}
                      editName={editName} setEditName={setEditName}
                      editDescription={editDescription} setEditDescription={setEditDescription}
                      editIcon={editIcon} setEditIcon={setEditIcon}
                      editBanner={editBanner} setEditBanner={setEditBanner}
                      editTags={editTags} setEditTags={setEditTags}
                      editMinPow={editMinPow} setEditMinPow={setEditMinPow}
                      editNsfw={editNsfw} setEditNsfw={setEditNsfw}
                      editDiscoverable={editDiscoverable} setEditDiscoverable={setEditDiscoverable}
                    />
                  )}
                  {activePage === 'channels' && (
                    <ChannelsPage
                      editCategories={editCategories} setEditCategories={setEditCategories}
                      editChannels={editChannels} setEditChannels={setEditChannels}
                      editRoles={editRoles}
                    />
                  )}
                  {activePage === 'roles' && <RolesPage hub={hub} editRoles={editRoles} setEditRoles={setEditRoles} editChannels={editChannels} editCategories={editCategories} isCreator={isCreator} />}
                  {activePage === 'members' && isCreator && (
                    <MembersPage hub={hub} onFooterState={setMemberFooterState} />
                  )}
                  {activePage === 'security' && isCreator && (
                    <SecurityPage hub={hub} />
                  )}
                  {activePage === 'network' && isCreator && (
                    <NetworkPage hub={hub} editRelays={editRelays} setEditRelays={setEditRelays} editBlossoms={editBlossoms} setEditBlossoms={setEditBlossoms} />
                  )}
                  {activePage === 'banned' && isCreator && (
                    <BannedUsersPage hub={hub} />
                  )}
                  {activePage === 'hidden' && isCreator && (
                    <HiddenMessagesPage hub={hub} onClose={onClose} />
                  )}
                  {activePage === 'dangerous' && isCreator && (
                    <DangerousPage hub={hub} onClose={onClose} setHubStatus={setHubStatus} />
                  )}
                  {activePage === 'reports' && isCreator && (
                    <ReportsPage hub={hub} onClose={onClose} />
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-3 border-t border-border bg-secondary/30 shrink-0 max-[1080px]:flex-col max-[1080px]:items-stretch max-[1080px]:gap-2 max-[1080px]:px-4">
              {activePage === 'members' ? (
                <>
                  {memberFooterState.error && <div className="flex items-center gap-1.5 text-xs text-destructive flex-1 truncate mr-4"><AlertTriangle size={12} /> {memberFooterState.error}</div>}
                  {memberFooterState.success && <div className="flex items-center gap-1.5 text-xs text-emerald-400 flex-1"><Check size={12} /> Roles updated and published</div>}
                  {!memberFooterState.error && !memberFooterState.success && (
                    <div className="flex-1">
                      {memberFooterState.isDirty && <span className="text-xs text-primary">{memberFooterState.modifiedCount} member{memberFooterState.modifiedCount !== 1 ? 's' : ''} modified</span>}
                    </div>
                  )}
                  <div className="flex items-center gap-2 max-[1080px]:self-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => memberFooterState.onDiscard?.()}
                      disabled={!memberFooterState.isDirty || memberFooterState.saving}
                    >
                      Discard
                    </Button>
                    <Button
                      onClick={() => memberFooterState.onSave?.()}
                      disabled={!memberFooterState.isDirty || memberFooterState.saving}
                      className="min-w-[140px]"
                    >
                      {memberFooterState.saving ? (
                        <><Loader2 size={14} className="animate-spin mr-2" /> Saving...</>
                      ) : (
                        'Save & Publish'
                      )}
                    </Button>
                  </div>
                </>
              ) : activePage === 'roles' ? (
                <>
                  {publishError && <div className="flex items-center gap-1.5 text-xs text-destructive flex-1 truncate mr-4"><AlertTriangle size={12} /> {publishError}</div>}
                  {!publishError && (
                    <div className="flex-1">
                      {roleChangeSummary.total > 0 && (
                        <span className="text-xs text-primary">
                          {[
                            roleChangeSummary.deleted > 0 && `${roleChangeSummary.deleted} deleted`,
                            roleChangeSummary.added > 0 && `${roleChangeSummary.added} added`,
                            roleChangeSummary.modified > 0 && `${roleChangeSummary.modified} modified`,
                          ].filter(Boolean).join(', ')}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2 max-[1080px]:self-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditRoles([...hub.roles])}
                      disabled={roleChangeSummary.total === 0 || publishing}
                    >
                      Discard
                    </Button>
                    <Button
                      onClick={handlePublish}
                      disabled={!hasChanges || publishing}
                      className="min-w-[140px]"
                    >
                      {publishing ? (
                        <><Loader2 size={14} className="animate-spin mr-2" /> Publishing...</>
                      ) : (
                        'Publish Changes'
                      )}
                    </Button>
                  </div>
                </>
              ) : activePage === 'general' ? (
                <>
                  {publishError && <div className="flex items-center gap-1.5 text-xs text-destructive flex-1 truncate mr-4"><AlertTriangle size={12} /> {publishError}</div>}
                  {!publishError && (
                    <div className="flex-1">
                      {generalChangeSummary.length > 0 && (
                        <span className="text-xs text-primary">
                          {generalChangeSummary.join(', ')} changed
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2 max-[1080px]:self-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditName(hub.name)
                        setEditDescription(hub.description || '')
                        setEditIcon(hub.icon || '')
                        setEditBanner(hub.banner || '')
                        setEditTags(hub.tags || [])
                        setEditMinPow(hub.minPow || 0)
                        setEditNsfw(hub.nsfw || false)
                        setEditDiscoverable(hub.discoverable !== false)
                      }}
                      disabled={generalChangeSummary.length === 0 || publishing}
                    >
                      Discard
                    </Button>
                    <Button
                      onClick={handlePublish}
                      disabled={!hasChanges || publishing}
                      className="min-w-[140px]"
                    >
                      {publishing ? (
                        <><Loader2 size={14} className="animate-spin mr-2" /> Publishing...</>
                      ) : (
                        'Publish Changes'
                      )}
                    </Button>
                  </div>
                </>
              ) : activePage === 'channels' ? (
                <>
                  {publishError && <div className="flex items-center gap-1.5 text-xs text-destructive flex-1 truncate mr-4"><AlertTriangle size={12} /> {publishError}</div>}
                  {!publishError && (
                    <div className="flex-1">
                      {channelChangeSummary.total > 0 && (
                        <span className="text-xs text-primary">
                          {(() => {
                            const parts: string[] = []
                            const chParts: string[] = []
                            if (channelChangeSummary.chDeleted > 0) chParts.push(`${channelChangeSummary.chDeleted} deleted`)
                            if (channelChangeSummary.chAdded > 0) chParts.push(`${channelChangeSummary.chAdded} added`)
                            if (channelChangeSummary.chModified > 0) chParts.push(`${channelChangeSummary.chModified} modified`)
                            if (chParts.length > 0) parts.push(`${chParts.join(', ')} channel${(channelChangeSummary.chDeleted + channelChangeSummary.chAdded + channelChangeSummary.chModified) !== 1 ? 's' : ''}`)
                            const catParts: string[] = []
                            if (channelChangeSummary.catDeleted > 0) catParts.push(`${channelChangeSummary.catDeleted} deleted`)
                            if (channelChangeSummary.catAdded > 0) catParts.push(`${channelChangeSummary.catAdded} added`)
                            if (channelChangeSummary.catModified > 0) catParts.push(`${channelChangeSummary.catModified} modified`)
                            if (catParts.length > 0) parts.push(`${catParts.join(', ')} categor${(channelChangeSummary.catDeleted + channelChangeSummary.catAdded + channelChangeSummary.catModified) !== 1 ? 'ies' : 'y'}`)
                            if (parts.length === 0 && channelChangeSummary.posChanged) parts.push('order changed')
                            return parts.join(' · ')
                          })()}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2 max-[1080px]:self-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditCategories([...hub.categories].sort((a, b) => a.position - b.position))
                        setEditChannels([...hub.channels])
                      }}
                      disabled={channelChangeSummary.total === 0 || publishing}
                    >
                      Discard
                    </Button>
                    <Button
                      onClick={handlePublish}
                      disabled={!hasChanges || publishing}
                      className="min-w-[140px]"
                    >
                      {publishing ? (
                        <><Loader2 size={14} className="animate-spin mr-2" /> Publishing...</>
                      ) : (
                        'Publish Changes'
                      )}
                    </Button>
                  </div>
                </>
              ) : activePage === 'network' ? (
                <>
                  {publishError && <div className="flex items-center gap-1.5 text-xs text-destructive flex-1 truncate mr-4"><AlertTriangle size={12} /> {publishError}</div>}
                  {!publishError && (
                    <div className="flex-1">
                      {networkChangeSummary.total > 0 && (
                        <span className="text-xs text-primary">
                          {networkChangeSummary.parts.join(', ')} changed
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2 max-[1080px]:self-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditRelays([...hub.generalRelays])
                        setEditBlossoms([...hub.blossomServers])
                      }}
                      disabled={networkChangeSummary.total === 0 || publishing}
                    >
                      Discard
                    </Button>
                    <Button
                      onClick={handlePublish}
                      disabled={!hasChanges || publishing}
                      className="min-w-[140px]"
                    >
                      {publishing ? (
                        <><Loader2 size={14} className="animate-spin mr-2" /> Publishing...</>
                      ) : (
                        'Publish Changes'
                      )}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {publishError && <span className="text-sm text-destructive truncate mr-4">{publishError}</span>}
                  <div className="flex-1" />
                  <Button
                    onClick={handlePublish}
                    disabled={!hasChanges || publishing}
                    className="min-w-[140px]"
                  >
                    {publishing ? (
                      <><Loader2 size={14} className="animate-spin mr-2" /> Publishing...</>
                    ) : (
                      'Publish Changes'
                    )}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </TooltipProvider>

      {/* Publish progress modal */}
      {publishing && (
        <PublishProgressModal
          currentStep={publishStep}
          completedSteps={publishStepsCompleted}
          error={publishError}
        />
      )}

      {/* Member save progress modal */}
      {memberFooterState.saving && (
        <MemberSaveProgressModal
          currentStep={memberFooterState.saveStep}
          completedSteps={memberFooterState.saveStepsCompleted}
          error={memberFooterState.error}
        />
      )}
    </>
  )
}

/* ─── Publish Progress Modal ─── */

const PUBLISH_STEP_ORDER = [
  'Preparing channels & categories',
  'Computing channel encryption',
  'Fetching encryption index',
  'Creating group tree',
  'Uploading encryption index',
  'Cleaning deleted roles',
  'Updating member tree',
  'Signing hub event',
  'Publishing to relays',
]

const PUBLISH_CORE_STEPS = ['Preparing channels & categories', 'Signing hub event', 'Publishing to relays']

const MEMBER_SAVE_STEP_ORDER = [
  'Fetching member tree',
  'Updating member roles',
  'Uploading member tree',
  'Checking group access',
  'Rotating group encryption',
  'Uploading encryption index',
  'Publishing hub update',
]

const MEMBER_SAVE_CORE_STEPS = ['Fetching member tree', 'Updating member roles', 'Uploading member tree']

function PublishProgressModal({
  currentStep,
  completedSteps,
  error,
}: {
  currentStep: string | null
  completedSteps: string[]
  error: string | null
}) {
  return (
    <ProgressModal
      title="Publishing Changes"
      stepOrder={PUBLISH_STEP_ORDER}
      coreSteps={PUBLISH_CORE_STEPS}
      currentStep={currentStep}
      completedSteps={completedSteps}
      error={error}
    />
  )
}

function MemberSaveProgressModal({
  currentStep,
  completedSteps,
  error,
}: {
  currentStep: string | null
  completedSteps: string[]
  error: string | null
}) {
  return (
    <ProgressModal
      title="Saving Member Roles"
      stepOrder={MEMBER_SAVE_STEP_ORDER}
      coreSteps={MEMBER_SAVE_CORE_STEPS}
      currentStep={currentStep}
      completedSteps={completedSteps}
      error={error}
    />
  )
}

function ProgressModal({
  title,
  stepOrder,
  coreSteps,
  currentStep,
  completedSteps,
  error,
}: {
  title: string
  stepOrder: string[]
  coreSteps: string[]
  currentStep: string | null
  completedSteps: string[]
  error: string | null
}) {
  // Determine which steps are relevant
  // (some steps like group tree rotation may be skipped)
  const relevantSteps = stepOrder.filter(step => {
    // Always show core steps
    if (coreSteps.includes(step)) return true
    // Show optional steps only if they were reached
    return completedSteps.includes(step) || currentStep === step || currentStep?.startsWith(step.replace(/\s.*/, ''))
  })

  // Handle dynamic step names (e.g. "Creating group tree (2 roles)")
  const isStepActive = (step: string) => {
    if (!currentStep) return false
    if (currentStep === step) return true
    // Prefix match for dynamic step names
    if (currentStep.startsWith(step)) return true
    return false
  }

  const isStepDone = (step: string) => {
    if (completedSteps.includes(step)) return true
    // Prefix match for dynamic step names
    if (completedSteps.some(s => s.startsWith(step))) return true
    return false
  }

  // Calculate progress percentage
  const totalSteps = relevantSteps.length
  const doneCount = relevantSteps.filter(s => isStepDone(s)).length
  const progress = totalSteps > 0 ? Math.round((doneCount / totalSteps) * 100) : 0

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-2">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal card */}
      <div className="relative z-10 w-[380px] rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 p-6 flex flex-col items-center gap-6">
        {/* Header */}
        <div className="flex flex-col items-center gap-2">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Loader2 size={20} className="text-primary animate-spin" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>

        {/* Progress bar */}
        <div className="w-full">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-muted-foreground font-medium">{progress}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Step list */}
        <div className="w-full flex flex-col gap-1.5">
          {relevantSteps.map((step) => {
            const active = isStepActive(step)
            const done = isStepDone(step)
            return (
              <div
                key={step}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-1.5 rounded-md text-xs transition-all duration-300',
                  active ? 'bg-primary/5 text-foreground font-medium' :
                    done ? 'text-muted-foreground' :
                      'text-muted-foreground/40',
                )}
              >
                {/* Step icon */}
                <div className="w-4 h-4 shrink-0 flex items-center justify-center">
                  {done ? (
                    <Check size={14} className="text-emerald-400" />
                  ) : active ? (
                    <Loader2 size={14} className="text-primary animate-spin" />
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-muted-foreground/20" />
                  )}
                </div>
                <span>{step}</span>
              </div>
            )
          })}
        </div>

        {/* Error */}
        {error && (
          <div className="w-full px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/25">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ── General Page ──

interface GeneralPageProps {
  hub: HubData
  editName: string; setEditName: (v: string) => void
  editDescription: string; setEditDescription: (v: string) => void
  editIcon: string; setEditIcon: (v: string) => void
  editBanner: string; setEditBanner: (v: string) => void
  editTags: string[]; setEditTags: (v: string[]) => void
  editMinPow: number; setEditMinPow: (v: number) => void
  editNsfw: boolean; setEditNsfw: (v: boolean) => void
  editDiscoverable: boolean; setEditDiscoverable: (v: boolean) => void
}

function GeneralPage({
  hub, editName, setEditName, editDescription, setEditDescription,
  editIcon, setEditIcon, editBanner, setEditBanner,
  editTags, setEditTags, editMinPow, setEditMinPow,
  editNsfw, setEditNsfw,
  editDiscoverable, setEditDiscoverable,
}: GeneralPageProps) {
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  // Upload helpers
  const [iconStatus, setIconStatus] = useState<UploadStatus>('idle')
  const [iconProgress, setIconProgress] = useState<UploadProgress | null>(null)
  const iconAbortRef = useRef<AbortController | null>(null)
  const iconInputRef = useRef<HTMLInputElement>(null)
  const [iconDragOver, setIconDragOver] = useState(false)

  const [bannerStatus, setBannerStatus] = useState<UploadStatus>('idle')
  const [bannerProgress, setBannerProgress] = useState<UploadProgress | null>(null)
  const bannerAbortRef = useRef<AbortController | null>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const [bannerDragOver, setBannerDragOver] = useState(false)
  const [fileSizeWarning, setFileSizeWarning] = useState<{ name: string; limitMb: number } | null>(null)


  const [newTag, setNewTag] = useState('')

  const handleImageUpload = async (
    file: File,
    setUrl: (url: string) => void,
    setStatus: (s: UploadStatus) => void,
    setProgress: (p: UploadProgress | null) => void,
    abortRef: React.MutableRefObject<AbortController | null>,
  ) => {
    if (!isValidImageFile(file)) return
    // Enforce upload size limit from settings
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    if (file.size > limitMb * 1024 * 1024) {
      setFileSizeWarning({ name: file.name, limitMb })
      return
    }
    setStatus('uploading')
    setProgress(null)
    try {
      const buffer = await file.arrayBuffer()
      const data = new Uint8Array(buffer)
      const { hash } = await uploadToBlossomServers(
        data, signer, privateKey, undefined, file.type,
        (p) => setProgress({ ...p }),
        () => { const c = new AbortController(); abortRef.current = c; return c.signal },
      )
      const serverUrl = blossomServerManager.getServers()[0]
      setUrl(`${serverUrl}/${hash}`)
      setStatus('success')
    } catch {
      setStatus('error')
    } finally {
      setProgress(null)
      abortRef.current = null
    }
  }

  const handleDrop = (
    e: React.DragEvent,
    setUrl: (url: string) => void,
    setStatus: (s: UploadStatus) => void,
    setProgress: (p: UploadProgress | null) => void,
    abortRef: React.MutableRefObject<AbortController | null>,
    setDrag: (v: boolean) => void,
  ) => {
    e.preventDefault(); e.stopPropagation(); setDrag(false)
    const file = e.dataTransfer.files?.[0]
    if (!file || !isValidImageFile(file)) return
    handleImageUpload(file, setUrl, setStatus, setProgress, abortRef)
  }

  const dragOver = (e: React.DragEvent, set: (v: boolean) => void) => { e.preventDefault(); e.stopPropagation(); set(true) }
  const dragLeave = (e: React.DragEvent, set: (v: boolean) => void) => { e.preventDefault(); e.stopPropagation(); set(false) }

  return (
    <>
      <div className="flex flex-col gap-6">
        {/* Banner */}
        <div className="flex flex-col gap-1">
          <div className="relative">
            <button
              type="button"
              onClick={() => { if (bannerStatus !== 'uploading') bannerInputRef.current?.click() }}
              onDragOver={(e) => dragOver(e, setBannerDragOver)}
              onDragLeave={(e) => dragLeave(e, setBannerDragOver)}
              onDrop={(e) => handleDrop(e, setEditBanner, setBannerStatus, setBannerProgress, bannerAbortRef, setBannerDragOver)}
              className={cn(
                'w-full h-32 rounded-lg overflow-hidden border-2 border-dashed flex items-center justify-center cursor-pointer group transition-colors',
                bannerDragOver ? 'border-primary bg-primary/10' : editBanner ? 'border-transparent' : 'border-border hover:border-primary/50'
              )}
            >
              {editBanner ? (
                <BlossomImage src={editBanner} alt="Banner" className="w-full h-full object-cover" />
              ) : (
                <div className="flex flex-col items-center gap-1 text-muted-foreground group-hover:text-primary/70">
                  <ImageIcon size={24} />
                  <span className="text-xs">Click or drop banner image</span>
                </div>
              )}
              {bannerStatus === 'uploading' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-lg">
                  <Loader2 size={24} className="animate-spin text-white" />
                </div>
              )}
              {editBanner && bannerStatus !== 'uploading' && (
                <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity rounded-lg ${bannerDragOver ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                  <ImageIcon size={20} className="text-white" />
                </div>
              )}
            </button>
            {editBanner && bannerStatus !== 'uploading' && (
              <button
                onClick={(e) => { e.stopPropagation(); setEditBanner('') }}
                className="absolute top-2 right-2 bg-black/50 text-white p-1 rounded-full hover:bg-black/70 cursor-pointer z-10"
              >
                <X size={14} />
              </button>
            )}
          </div>
          {bannerStatus === 'uploading' && bannerProgress && (
            <UploadProgressBar progress={bannerProgress} abortRef={bannerAbortRef} />
          )}
          <div className="flex items-center gap-2 mt-1">
            <label className="text-xs text-muted-foreground shrink-0 w-16">Image URL</label>
            <Input
              className="text-xs font-mono"
              placeholder="https://..."
              value={editBanner}
              onChange={(e) => {
                const url = e.target.value
                setEditBanner(url)
              }}
            />
          </div>
        </div>

        <input ref={bannerInputRef} type="file" accept={ACCEPTED_IMAGE_EXTENSIONS} className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload(f, setEditBanner, setBannerStatus, setBannerProgress, bannerAbortRef); e.target.value = '' }} />

        {/* Icon + Name */}
        <div className="flex items-start gap-4 max-[1080px]:flex-col max-[1080px]:items-center">
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => { if (iconStatus !== 'uploading') iconInputRef.current?.click() }}
              onDragOver={(e) => dragOver(e, setIconDragOver)}
              onDragLeave={(e) => dragLeave(e, setIconDragOver)}
              onDrop={(e) => handleDrop(e, setEditIcon, setIconStatus, setIconProgress, iconAbortRef, setIconDragOver)}
              className={cn(
                'relative w-20 h-20 rounded-2xl border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer group transition-colors',
                iconDragOver ? 'border-primary bg-primary/10' : editIcon ? 'border-transparent' : 'border-border hover:border-primary/50'
              )}
            >
              {editIcon ? (
                <BlossomImage src={editIcon} alt="Icon" className="w-full h-full object-cover" />
              ) : (
                <Camera size={20} className="text-muted-foreground group-hover:text-primary/70" />
              )}
              {iconStatus === 'uploading' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <Loader2 size={18} className="animate-spin text-white" />
                </div>
              )}
              {editIcon && iconStatus !== 'uploading' && (
                <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity ${iconDragOver ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                  <Camera size={16} className="text-white" />
                </div>
              )}
            </button>
            {editIcon && iconStatus !== 'uploading' && (
              <button onClick={() => setEditIcon('')} className="text-xs text-destructive hover:underline cursor-pointer">Remove</button>
            )}
            {iconStatus === 'uploading' && iconProgress && (
              <UploadProgressBar progress={iconProgress} abortRef={iconAbortRef} small />
            )}
          </div>

          <input ref={iconInputRef} type="file" accept={ACCEPTED_IMAGE_EXTENSIONS} className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload(f, setEditIcon, setIconStatus, setIconProgress, iconAbortRef); e.target.value = '' }} />

          <div className="flex-1 flex flex-col gap-3 max-[1080px]:w-full">
            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">Hub Name</label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">Description</label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="What's this hub about?"
                rows={3}
                className="flex w-full rounded-md border border-input bg-background px-2 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground shrink-0 w-16">Icon URL</label>
              <Input
                className="text-xs font-mono"
                placeholder="https://..."
                value={editIcon}
                onChange={(e) => setEditIcon(e.target.value)}
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Tags */}
        <div>
          <label className="text-sm font-medium text-foreground mb-2 flex items-center gap-1.5">
            <Tag size={14} /> Tags
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {editTags.map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
                {tag}
                <button onClick={() => setEditTags(editTags.filter(t => t !== tag))} className="hover:text-destructive cursor-pointer">
                  <X size={10} />
                </button>
              </span>
            ))}
            {editTags.length === 0 && <span className="text-xs text-muted-foreground">No tags yet</span>}
          </div>
          <div className="flex items-center gap-1">
            <Input
              placeholder="Add tag..."
              className="text-xs"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const t = newTag.trim().toLowerCase()
                  if (t && !editTags.includes(t)) { setEditTags([...editTags, t]); setNewTag('') }
                }
              }}
            />
            <Button
              variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0"
              onClick={() => {
                const t = newTag.trim().toLowerCase()
                if (t && !editTags.includes(t)) { setEditTags([...editTags, t]); setNewTag('') }
              }}
            >
              <Plus size={14} />
            </Button>
          </div>
        </div>

        <Separator />

        {/* NSFW Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">NSFW Hub</label>
            <p className="text-xs text-muted-foreground">Is this hub primarily for NSFW content?</p>
          </div>
          <button
            onClick={() => setEditNsfw(!editNsfw)}
            className={cn(
              'relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0',
              editNsfw ? 'bg-primary' : 'bg-muted-foreground/30'
            )}
          >
            <div className={cn(
              'absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform',
              editNsfw ? 'translate-x-[22px]' : 'translate-x-[3px]'
            )} />
          </button>
        </div>

        <Separator />

        {/* Discoverable Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Discoverable</label>
            <p className="text-xs text-muted-foreground">Allow this hub to appear in public search and browse</p>
          </div>
          <button
            onClick={() => setEditDiscoverable(!editDiscoverable)}
            className={cn(
              'relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0',
              editDiscoverable ? 'bg-primary' : 'bg-muted-foreground/30'
            )}
          >
            <div className={cn(
              'absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform',
              editDiscoverable ? 'translate-x-[22px]' : 'translate-x-[3px]'
            )} />
          </button>
        </div>

        <Separator />

        {/* Proof of Work */}
        <PowSection editMinPow={editMinPow} setEditMinPow={setEditMinPow} />

      </div>

      {/* File size warning modal */}
      {fileSizeWarning && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={() => setFileSizeWarning(null)}>
          <div className="w-[400px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500 shrink-0" />
              <h4 className="text-sm font-semibold text-foreground">File Too Large</h4>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                The following file exceeds the {fileSizeWarning.limitMb} MB upload limit and was not added:
              </p>
              <div className="text-xs font-mono text-foreground bg-secondary/50 px-2 py-1 rounded truncate">{fileSizeWarning.name}</div>
              <p className="text-[10px] text-muted-foreground">
                This soft limit improves upload success rates across blossom servers. You can change it in <strong>Settings → Network → Media Upload Limit</strong>.
              </p>
            </div>
            <button onClick={() => setFileSizeWarning(null)} className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// ── Channels Page ──

interface ChannelsPageProps {
  editCategories: Category[]; setEditCategories: (v: Category[]) => void
  editChannels: Channel[]; setEditChannels: (v: Channel[]) => void
  editRoles: Role[]
}

function ChannelsPage({ editCategories, setEditCategories, editChannels, setEditChannels, editRoles }: ChannelsPageProps) {
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newChannelNames, setNewChannelNames] = useState<Record<string, string>>({})
  const [newChannelTypes, setNewChannelTypes] = useState<Record<string, 'chat' | 'forum' | 'announcement' | 'voice'>>({})
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [dragItem, setDragItem] = useState<{ type: 'category' | 'channel'; id: string } | null>(null)
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null)
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null)
  const [editingChannelName, setEditingChannelName] = useState('')
  const [permEditTarget, setPermEditTarget] = useState<{ type: 'channel' | 'category'; id: string } | null>(null)

  const addCategory = () => {
    const n = newCategoryName.trim()
    if (!n) return
    const cat: Category = { categoryId: crypto.randomUUID(), name: n, position: editCategories.length, encryption: null }
    setEditCategories([...editCategories, cat])
    setNewCategoryName('')
  }

  const removeCategory = (catId: string) => {
    setEditCategories(editCategories.filter(c => c.categoryId !== catId))
    setEditChannels(editChannels.map(ch => ch.categoryId === catId ? { ...ch, categoryId: null } : ch))
  }

  const addChannel = (categoryId: string | null) => {
    const key = categoryId || '__uncategorized'
    const n = (newChannelNames[key] || '').trim().toLowerCase().replace(/\s+/g, '-')
    if (!n) return
    if (editChannels.some(ch => ch.name === n)) return
    const siblingsCount = editChannels.filter(c => c.categoryId === categoryId).length
    const selectedType = newChannelTypes[key] || 'chat'
    const ch: Channel = { channelId: crypto.randomUUID(), name: n, type: selectedType, categoryId, synced: false, encryption: null, position: siblingsCount }
    setEditChannels([...editChannels, ch])
    setNewChannelNames({ ...newChannelNames, [key]: '' })
  }

  const removeChannel = (channelId: string) => setEditChannels(editChannels.filter(c => c.channelId !== channelId))

  const startEditChannel = (ch: Channel) => {
    setEditingChannelId(ch.channelId)
    setEditingChannelName(ch.name)
  }

  const commitEditChannel = () => {
    if (!editingChannelId) return
    const trimmed = editingChannelName.trim().toLowerCase().replace(/\s+/g, '-')
    if (trimmed && !editChannels.some(c => c.channelId !== editingChannelId && c.name === trimmed)) {
      setEditChannels(editChannels.map(c => c.channelId === editingChannelId ? { ...c, name: trimmed } : c))
    }
    setEditingChannelId(null)
    setEditingChannelName('')
  }

  const cancelEditChannel = () => {
    setEditingChannelId(null)
    setEditingChannelName('')
  }

  const onCategoryDragStart = (e: React.DragEvent, catId: string) => { setDragItem({ type: 'category', id: catId }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', catId) }
  const onCategoryDragOver = (e: React.DragEvent, catId: string) => { e.preventDefault(); if (dragItem?.type === 'category' && dragItem.id !== catId) setDragOverTarget(catId) }
  const onCategoryDrop = (e: React.DragEvent, targetCatId: string) => {
    e.preventDefault(); setDragOverTarget(null)
    if (!dragItem || dragItem.type !== 'category') return
    const fromIdx = editCategories.findIndex(c => c.categoryId === dragItem.id)
    const toIdx = editCategories.findIndex(c => c.categoryId === targetCatId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return
    const newCats = [...editCategories]; const [moved] = newCats.splice(fromIdx, 1); newCats.splice(toIdx, 0, moved)
    setEditCategories(newCats.map((c, i) => ({ ...c, position: i }))); setDragItem(null)
  }
  const onChannelDragStart = (e: React.DragEvent, channelId: string) => { setDragItem({ type: 'channel', id: channelId }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', channelId) }
  const onChannelDragOver = (e: React.DragEvent, targetChannelId: string) => { e.preventDefault(); if (dragItem?.type === 'channel' && dragItem.id !== targetChannelId) setDragOverTarget(targetChannelId) }
  const onChannelDrop = (e: React.DragEvent, targetChannelId: string, targetCategoryId: string | null) => {
    e.preventDefault(); setDragOverTarget(null)
    if (!dragItem || dragItem.type !== 'channel') return
    const channelsCopy = [...editChannels]; const fromIdx = channelsCopy.findIndex(c => c.channelId === dragItem.id)
    const toIdx = channelsCopy.findIndex(c => c.channelId === targetChannelId)
    if (fromIdx < 0 || toIdx < 0) return
    const [moved] = channelsCopy.splice(fromIdx, 1); moved.categoryId = targetCategoryId; channelsCopy.splice(toIdx, 0, moved)
    // Update positions for all channels in the target category
    let pos = 0
    for (const ch of channelsCopy) {
      if (ch.categoryId === targetCategoryId) { ch.position = pos; pos++ }
    }
    // Also update positions in the source category if it was different
    const sourceChannel = editChannels.find(c => c.channelId === dragItem.id)
    if (sourceChannel && sourceChannel.categoryId !== targetCategoryId) {
      let sPos = 0
      for (const ch of channelsCopy) {
        if (ch.categoryId === sourceChannel.categoryId) { ch.position = sPos; sPos++ }
      }
    }
    setEditChannels(channelsCopy); setDragItem(null)
  }
  const onCategoryHeaderChannelDrop = (e: React.DragEvent, targetCatId: string | null) => {
    e.preventDefault(); setDragOverTarget(null)
    if (!dragItem || dragItem.type !== 'channel') return
    setEditChannels(editChannels.map(ch => ch.channelId === dragItem.id ? { ...ch, categoryId: targetCatId } : ch)); setDragItem(null)
  }
  const onDragEnd = () => { setDragItem(null); setDragOverTarget(null) }
  const toggleCategory = (catId: string) => { const next = new Set(collapsedCategories); if (next.has(catId)) next.delete(catId); else next.add(catId); setCollapsedCategories(next) }

  const uncategorizedChannels = editChannels.filter(c => !c.categoryId).sort((a, b) => a.position - b.position)

  const renderChannelItem = (ch: Channel) => (
    <div key={ch.channelId} draggable={editingChannelId !== ch.channelId} onDragStart={(e) => onChannelDragStart(e, ch.channelId)} onDragOver={(e) => { e.stopPropagation(); onChannelDragOver(e, ch.channelId) }} onDrop={(e) => { e.stopPropagation(); onChannelDrop(e, ch.channelId, ch.categoryId) }} onDragEnd={onDragEnd}
      className={cn('flex items-center gap-3 px-3 py-2.5 rounded-lg bg-secondary text-sm group cursor-grab active:cursor-grabbing transition-colors', dragOverTarget === ch.channelId && 'ring-2 ring-primary/50', editingChannelId === ch.channelId && 'ring-1 ring-primary/30 cursor-default')}
    >
      <GripVertical size={14} className="text-muted-foreground/50 shrink-0" />
      {ch.type === 'voice' ? <Volume2 size={16} className="text-emerald-400 shrink-0" /> : ch.type === 'forum' ? <MessagesSquare size={16} className="text-muted-foreground shrink-0" /> : ch.type === 'announcement' ? <Megaphone size={16} className="text-muted-foreground shrink-0" /> : <Hash size={16} className="text-muted-foreground shrink-0" />}
      {editingChannelId === ch.channelId ? (
        <input
          autoFocus
          value={editingChannelName}
          onChange={(e) => setEditingChannelName(e.target.value)}
          onBlur={commitEditChannel}
          onKeyDown={(e) => { if (e.key === 'Enter') commitEditChannel(); if (e.key === 'Escape') cancelEditChannel() }}
          className="flex-1 bg-transparent text-foreground text-sm outline-none px-2 py-1 rounded-sm"
        />
      ) : (
        <Tip text="Double-click to rename" side="bottom">
          <span
            className="text-foreground flex-1 truncate cursor-text hover:text-primary/90 transition-colors px-1 py-0.5"
            onDoubleClick={() => startEditChannel(ch)}
          >{ch.name}</span>
        </Tip>
      )}
      <span className="text-xs text-muted-foreground">{ch.type}</span>
      <div className="flex items-center gap-1">
        <Tip text="Rename"><button onClick={() => startEditChannel(ch)} className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 cursor-pointer transition-colors"><Pencil size={14} /></button></Tip>
        <Tip text="Permissions"><button onClick={() => setPermEditTarget({ type: 'channel', id: ch.channelId })} className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 cursor-pointer transition-colors"><Settings size={14} /></button></Tip>
        <Tip text="Delete channel"><button onClick={() => removeChannel(ch.channelId)} className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer transition-colors"><Trash2 size={14} /></button></Tip>
      </div>
    </div>
  )

  const renderAddChannel = (categoryId: string | null) => {
    const key = categoryId || '__uncategorized'
    const selectedType = newChannelTypes[key] || 'chat'
    return (
      <div className="flex items-center gap-1 mt-1">
        <Input placeholder="channel-name" className="text-xs" value={newChannelNames[key] || ''}
          onChange={(e) => setNewChannelNames({ ...newChannelNames, [key]: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && addChannel(categoryId)} />
        <select
          value={selectedType}
          onChange={(e) => setNewChannelTypes({ ...newChannelTypes, [key]: e.target.value as 'chat' | 'forum' | 'announcement' | 'voice' })}
          className="h-9 px-2 rounded-lg border border-input bg-background text-xs text-foreground cursor-pointer outline-none appearance-none"
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.35rem center', paddingRight: '1.4rem' }}
        >
          <option value="chat">Chat</option>
          <option value="forum">Forum</option>
          <option value="announcement">Announcement</option>
          <option value="voice">Voice</option>
        </select>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => addChannel(categoryId)}><Plus size={14} /></Button>
      </div>
    )
  }

  // If editing permissions for a channel or category, show the editor
  if (permEditTarget) {
    return (
      <ChannelPermissionsEditor
        target={permEditTarget}
        editChannels={editChannels}
        setEditChannels={setEditChannels}
        editCategories={editCategories}
        setEditCategories={setEditCategories}
        editRoles={editRoles}
        onBack={() => setPermEditTarget(null)}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <label className="text-sm font-medium text-foreground mb-2 block">Categories & Channels</label>

        {/* Uncategorized channels */}
        <div
          className={cn('mb-3 p-2 rounded-md', dragOverTarget === '__uncategorized' && 'ring-2 ring-primary/30')}
          onDragOver={(e) => { e.preventDefault(); if (dragItem?.type === 'channel') setDragOverTarget('__uncategorized') }}
          onDrop={(e) => onCategoryHeaderChannelDrop(e, null)}
          onDragLeave={() => setDragOverTarget(null)}
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Uncategorized</div>
          <div className="flex flex-col gap-1">
            {uncategorizedChannels.map(renderChannelItem)}
            {renderAddChannel(null)}
          </div>
        </div>

        {/* Categories */}
        {editCategories.map((cat) => {
          const catChannels = editChannels.filter(c => c.categoryId === cat.categoryId).sort((a, b) => a.position - b.position)
          const isCollapsed = collapsedCategories.has(cat.categoryId)
          const isDragTarget = dragOverTarget === cat.categoryId

          return (
            <div key={cat.categoryId} className="mb-2" onDragEnd={onDragEnd}>
              {isDragTarget && dragItem?.type === 'category' && <div className="h-0.5 bg-primary rounded-full mx-2 mb-1" />}
              <div className={cn('rounded-md border transition-colors', isDragTarget ? 'border-primary/70 bg-primary/5' : 'border-border/50')}>
                <div draggable onDragStart={(e) => onCategoryDragStart(e, cat.categoryId)}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (dragItem?.type === 'category' && dragItem.id !== cat.categoryId) setDragOverTarget(cat.categoryId); if (dragItem?.type === 'channel') setDragOverTarget(cat.categoryId) }}
                  onDrop={(e) => { e.stopPropagation(); if (dragItem?.type === 'category') onCategoryDrop(e, cat.categoryId); if (dragItem?.type === 'channel') onCategoryHeaderChannelDrop(e, cat.categoryId) }}
                  onDragLeave={(e) => { e.stopPropagation(); setDragOverTarget(null) }}
                  className="flex items-center gap-2 px-3 py-2.5 cursor-grab active:cursor-grabbing bg-secondary/50 rounded-t-md group"
                >
                  <GripVertical size={14} className="text-muted-foreground/50 shrink-0" />
                  <button onClick={() => toggleCategory(cat.categoryId)} className="p-1.5 rounded-md hover:bg-secondary cursor-pointer transition-colors">
                    {isCollapsed ? <ChevronRight size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
                  </button>
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex-1">{cat.name}</span>
                  <div className="flex items-center gap-1">
                    <Tip text="Permissions"><button onClick={() => setPermEditTarget({ type: 'category', id: cat.categoryId })} className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 cursor-pointer transition-colors"><Settings size={14} /></button></Tip>
                    <Tip text="Delete category"><button onClick={() => removeCategory(cat.categoryId)} className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer transition-colors"><Trash2 size={14} /></button></Tip>
                  </div>
                </div>
                {!isCollapsed && (
                  <div className="px-2 py-2 flex flex-col gap-1.5">
                    {catChannels.map(renderChannelItem)}
                    {renderAddChannel(cat.categoryId)}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {/* Add category */}
        <div className="flex items-center gap-1 mt-2">
          <Input placeholder="New category name" className="text-xs" value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addCategory()} />
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={addCategory}><Plus size={14} /></Button>
        </div>
      </div>
    </div>
  )
}

// ── Channel / Category Permissions Editor ──

/** Read a permission cell state from a permissions record (standalone helper for derived state) */
function getCellStateFromPerms(perms: Record<string, Record<string, boolean>>, roleId: string, permKey: string): 'allow' | 'deny' | 'inherit' {
  const roleOverrides = perms[roleId]
  if (!roleOverrides || !(permKey in roleOverrides)) return 'inherit'
  return roleOverrides[permKey] ? 'allow' : 'deny'
}

/** Permission keys relevant to channel/category overrides (subset of all perms) */
const BASE_PERM_KEYS: { key: string; label: string; desc: string }[] = [
  { key: 'view_channel', label: 'View', desc: 'Can see this channel/category in the sidebar' },
  { key: 'read_messages', label: 'Read', desc: 'Can decrypt and read messages — deny to make private' },
  { key: 'send_messages', label: 'Send', desc: 'Can send messages' },
  { key: 'add_reactions', label: 'React', desc: 'Can add reactions' },
  { key: 'hide_messages', label: 'Hide Messages', desc: 'Can hide specific messages in this channel' },
  { key: 'attach_files', label: 'Files', desc: 'Can attach files' },
  { key: 'embed_links', label: 'Embeds & Previews', desc: 'Links show preview cards' },
  { key: 'create_polls', label: 'Polls', desc: 'Can create polls' },
  { key: 'mention_everyone', label: '@everyone', desc: '@everyone triggers notifications' },
  { key: 'mention_here', label: '@here', desc: '@here triggers notifications' },
  { key: 'mention_roles', label: '@roles', desc: '@role mentions trigger notifications' },
]

const VOICE_PERM_KEYS: { key: string; label: string; desc: string }[] = [
  { key: 'connect_voice', label: 'Connect Voice', desc: 'Can join voice channels — locked with Read' },
  { key: 'speak', label: 'Speak', desc: 'Can unmute and transmit audio' },
  { key: 'stream_video', label: 'Stream Video', desc: 'Can share screen' },
  { key: 'use_camera', label: 'Use Camera', desc: 'Can enable camera' },
  { key: 'use_spatial', label: 'Spatial Audio', desc: 'Can use spatial audio positioning' },
]

interface ChannelPermissionsEditorProps {
  target: { type: 'channel' | 'category'; id: string }
  editChannels: Channel[]; setEditChannels: (v: Channel[]) => void
  editCategories: Category[]; setEditCategories: (v: Category[]) => void
  editRoles: Role[]
  onBack: () => void
}

function ChannelPermissionsEditor({ target, editChannels, setEditChannels, editCategories, setEditCategories, editRoles, onBack }: ChannelPermissionsEditorProps) {
  const isChannel = target.type === 'channel'
  const channel = isChannel ? editChannels.find(c => c.channelId === target.id) : null
  const category = !isChannel ? editCategories.find(c => c.categoryId === target.id) : null
  const targetName = channel?.name || category?.name || 'Unknown'
  const isVoiceChannel = channel?.type === 'voice'

  // Determine which perm keys to show based on channel type
  // Voice channels + categories (which can contain voice channels) show voice perms
  const visiblePermKeys = useMemo(() => {
    if (isVoiceChannel || !isChannel) return [...BASE_PERM_KEYS, ...VOICE_PERM_KEYS]
    return BASE_PERM_KEYS
  }, [isVoiceChannel, isChannel])

  // Get existing permissions (or empty object)
  const perms: Record<string, Record<string, boolean>> = (isChannel ? channel?.permissions : category?.permissions) || {}

  // For channels: find the parent category permissions for "inherited" display
  const parentCategory = channel?.categoryId ? editCategories.find(c => c.categoryId === channel.categoryId) : null
  const isSynced = channel?.synced ?? false
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(new Set())

  // ── Private channel indicator (derived from read_messages / connect_voice permissions) ──
  // Channel is private when 'everyone' role has read_messages: deny (or connect_voice: deny for voice)
  const everyoneRole = editRoles.find(r => r.name === 'everyone')
  const everyoneReadState = everyoneRole ? getCellStateFromPerms(perms, everyoneRole.roleId, 'read_messages') : 'inherit'
  const everyoneConnectState = everyoneRole ? getCellStateFromPerms(perms, everyoneRole.roleId, 'connect_voice') : 'inherit'
  const isPrivateChannel = everyoneReadState === 'deny' || (isVoiceChannel && everyoneConnectState === 'deny')

  // Roles with read_messages: allow (these will be in the encryption group)
  const readableRoles = useMemo(() => {
    if (!isPrivateChannel) return []
    return editRoles.filter(r => {
      if (r.name === 'everyone') return false
      return getCellStateFromPerms(perms, r.roleId, 'read_messages') === 'allow'
    })
  }, [isPrivateChannel, editRoles, perms])

  const toggleRoleExpanded = (roleId: string) => {
    setExpandedRoles(prev => {
      const next = new Set(prev)
      if (next.has(roleId)) next.delete(roleId)
      else next.add(roleId)
      return next
    })
  }

  /** Count how many overrides a role has for this target */
  const getOverrideCount = (roleId: string): number => {
    const roleOverrides = perms[roleId]
    return roleOverrides ? Object.keys(roleOverrides).length : 0
  }

  /** Get the current tri-state value for a role/permission cell */
  const getCellState = (roleId: string, permKey: string): 'allow' | 'deny' | 'inherit' => {
    const roleOverrides = perms[roleId]
    if (!roleOverrides || !(permKey in roleOverrides)) return 'inherit'
    return roleOverrides[permKey] ? 'allow' : 'deny'
  }

  /** Cycle through states: inherit → allow → deny → inherit */
  const cycleCell = (roleId: string, permKey: string) => {
    if (isChannel && isSynced) return // can't edit synced channel overrides
    const current = getCellState(roleId, permKey)
    let nextState: 'allow' | 'deny' | 'inherit'
    if (current === 'inherit') nextState = 'allow'
    else if (current === 'allow') nextState = 'deny'
    else nextState = 'inherit'
    setCell(roleId, permKey, nextState)
  }

  /** Set a specific permission state for a role/permission cell */
  const setCell = (roleId: string, permKey: string, state: 'allow' | 'deny' | 'inherit') => {
    if (isChannel && isSynced) return // can't edit synced channel overrides
    // For voice channels: read_messages and connect_voice are locked together
    const linkedKey = isVoiceChannel && (permKey === 'read_messages' ? 'connect_voice' : permKey === 'connect_voice' ? 'read_messages' : null)
    const newPerms = { ...perms }
    if (!newPerms[roleId]) newPerms[roleId] = {}
    else newPerms[roleId] = { ...newPerms[roleId] }

    const applyState = (key: string, s: 'allow' | 'deny' | 'inherit') => {
      if (s === 'allow') {
        newPerms[roleId][key] = true
      } else if (s === 'deny') {
        newPerms[roleId][key] = false
      } else {
        delete newPerms[roleId][key]
      }
    }

    applyState(permKey, state)
    // Sync the linked permission (read ↔ connect_voice)
    if (linkedKey) applyState(linkedKey, state)

    // Clean up empty role entries
    if (newPerms[roleId] && Object.keys(newPerms[roleId]).length === 0) delete newPerms[roleId]

    // Clean up empty permissions object
    const cleanPerms = Object.keys(newPerms).length > 0 ? newPerms : undefined

    if (isChannel) {
      setEditChannels(editChannels.map(ch => ch.channelId === target.id ? { ...ch, permissions: cleanPerms } : ch))
    } else {
      setEditCategories(editCategories.map(cat => cat.categoryId === target.id ? { ...cat, permissions: cleanPerms } : cat))
    }
  }

  /** Toggle the synced state for channels */
  const toggleSync = () => {
    if (!isChannel || !channel) return
    const newSynced = !isSynced
    setEditChannels(editChannels.map(ch => {
      if (ch.channelId !== target.id) return ch
      if (newSynced) {
        // Syncing: clear channel-level overrides (inherit from category)
        return { ...ch, synced: true, permissions: undefined }
      } else {
        // Unsyncing: copy category overrides as starting point
        const catPerms = parentCategory?.permissions
        return { ...ch, synced: false, permissions: catPerms ? JSON.parse(JSON.stringify(catPerms)) : undefined }
      }
    }))
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
          <ChevronLeft size={16} /> Back
        </button>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          {isChannel && (channel?.type === 'voice' ? <Volume2 size={14} className="text-emerald-400" /> : channel?.type === 'forum' ? <MessagesSquare size={14} className="text-muted-foreground" /> : channel?.type === 'announcement' ? <Megaphone size={14} className="text-muted-foreground" /> : <Hash size={14} className="text-muted-foreground" />)}
          <span className="text-sm font-medium text-foreground">{targetName}</span>
          <span className="text-xs text-muted-foreground px-1.5 py-0.5 rounded bg-secondary">{isChannel ? 'Channel' : 'Category'}</span>
        </div>
      </div>

      {/* Sync toggle (channels only) */}
      {isChannel && channel?.categoryId && (
        <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
          <div>
            <p className="text-sm font-medium text-foreground">Sync with category</p>
            <p className="text-xs text-muted-foreground">
              {isSynced
                ? `Inheriting permissions from "${parentCategory?.name || 'category'}"`
                : 'Using custom permissions for this channel'}
            </p>
          </div>
          <button onClick={toggleSync} className={cn(
            'relative w-9 h-5 rounded-full transition-colors cursor-pointer',
            isSynced ? 'bg-primary' : 'bg-muted-foreground/30',
          )}>
            <div className={cn(
              'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
              isSynced ? 'translate-x-4' : 'translate-x-0.5',
            )} />
          </button>
        </div>
      )}

      {/* ── Private Channel Indicator (derived from read_messages) ── */}
      {isPrivateChannel && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 overflow-hidden">
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <Lock size={14} className="text-amber-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Private {isChannel ? 'Channel' : 'Category'}</p>
              <p className="text-[11px] text-muted-foreground leading-tight">
                {readableRoles.length > 0
                  ? 'Encrypted with a separate group key — only allowed roles can read'
                  : 'Only the creator can read this channel — set Read to Allow on roles below to grant access'}
              </p>
            </div>
          </div>
          {readableRoles.length > 0 && (
            <div className="border-t border-amber-500/20 px-3 py-2">
              <p className="text-[11px] text-muted-foreground mb-1.5">Readable by:</p>
              <div className="flex flex-wrap gap-1.5">
                {readableRoles.map(role => (
                  <span key={role.roleId} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-secondary/50 text-xs text-foreground border border-border/50">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: role.color || 'hsl(var(--primary))' }} />
                    {role.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Info size={12} className="shrink-0" />
        <span>Set permission overrides for each role below</span>
      </div>

      {/* Role accordions */}
      <div className={cn('flex flex-col gap-2', isChannel && isSynced && 'opacity-50 pointer-events-none')}>
        {editRoles.map(role => {
          const isExpanded = expandedRoles.has(role.roleId)
          const overrideCount = getOverrideCount(role.roleId)

          return (
            <div key={role.roleId} className="rounded-lg border border-border/50 overflow-hidden">
              {/* Role header — clickable accordion toggle */}
              <button
                onClick={() => toggleRoleExpanded(role.roleId)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer"
              >
                {isExpanded ? <ChevronDown size={14} className="text-muted-foreground shrink-0" /> : <ChevronRight size={14} className="text-muted-foreground shrink-0" />}
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: role.color || 'hsl(var(--primary))' }} />
                <span className="text-sm font-medium text-foreground flex-1 text-left">{role.name}</span>
                {overrideCount > 0 && (
                  <span className="text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded-full font-medium">
                    {overrideCount} override{overrideCount !== 1 ? 's' : ''}
                  </span>
                )}
              </button>

              {/* Expanded permission rows */}
              {isExpanded && (
                <div className="border-t border-border/30">
                  {visiblePermKeys.map((p, i) => {
                    const state = getCellState(role.roleId, p.key)
                    return (
                      <div
                        key={p.key}
                        className={cn(
                          'flex items-center justify-between px-3 py-2 hover:bg-secondary/20 transition-colors',
                          i > 0 && 'border-t border-border/20',
                        )}
                      >
                        <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-3">
                          <span className="text-sm text-foreground">{p.label}</span>
                          <span className="text-[11px] text-muted-foreground leading-tight">{p.desc}</span>
                        </div>
                        {/* 3-segment toggle: Inherit / Allow / Deny */}
                        <div className="shrink-0 flex items-center h-7 rounded-lg border border-border/40 bg-secondary/20 overflow-hidden">
                          <button
                            onClick={() => setCell(role.roleId, p.key, 'inherit')}
                            className={cn(
                              'h-full px-2 flex items-center gap-1 text-[11px] font-medium transition-all cursor-pointer border-r border-border/30',
                              state === 'inherit'
                                ? 'bg-secondary text-foreground'
                                : 'text-muted-foreground/40 hover:text-muted-foreground/70',
                            )}
                          >
                            <Minus size={11} strokeWidth={2.5} />
                          </button>
                          <button
                            onClick={() => setCell(role.roleId, p.key, 'allow')}
                            className={cn(
                              'h-full px-2 flex items-center gap-1 text-[11px] font-medium transition-all cursor-pointer border-r border-border/30',
                              state === 'allow'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : 'text-muted-foreground/40 hover:text-muted-foreground/70',
                            )}
                          >
                            <Check size={11} strokeWidth={2.5} />
                          </button>
                          <button
                            onClick={() => setCell(role.roleId, p.key, 'deny')}
                            className={cn(
                              'h-full px-2 flex items-center gap-1 text-[11px] font-medium transition-all cursor-pointer',
                              state === 'deny'
                                ? 'bg-red-500/20 text-red-400'
                                : 'text-muted-foreground/40 hover:text-muted-foreground/70',
                            )}
                          >
                            <Ban size={11} strokeWidth={2.5} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Synced overlay hint */}
      {isChannel && isSynced && (
        <p className="text-xs text-muted-foreground text-center">
          Unsync this channel to set custom permissions
        </p>
      )}
    </div>
  )
}

// ── PoW Section ──


function PowSection({ editMinPow, setEditMinPow }: { editMinPow: number; setEditMinPow: (v: number) => void }) {
  const [hashRate, setHashRate] = useState<number | null>(null)
  const [manualInput, setManualInput] = useState(editMinPow.toString())

  // Benchmark on mount
  useEffect(() => {
    benchmarkHashRate().then(setHashRate)
  }, [])

  // Keep manual input in sync when slider changes
  useEffect(() => {
    setManualInput(editMinPow.toString())
  }, [editMinPow])

  const solveTimeStr = useMemo(() => {
    if (editMinPow <= 0) return 'Disabled'
    const seconds = estimateSolveTime(editMinPow, hashRate ?? undefined)
    if (seconds < 0.001) return '<1ms on this device'
    if (seconds < 1) return `~${Math.round(seconds * 1000)}ms on this device`
    if (seconds < 60) return `~${seconds.toFixed(1)}s on this device`
    if (seconds < 3600) return `~${(seconds / 60).toFixed(1)} min on this device`
    if (seconds < 86400) return `~${(seconds / 3600).toFixed(1)} hours on this device`
    return `~${(seconds / 86400).toFixed(1)} days on this device`
  }, [editMinPow, hashRate])

  return (
    <div>
      <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5">
        Proof of Work
      </label>
      <p className="text-xs text-muted-foreground mb-3">
        Require computational work before sending messages or join requests. Higher difficulty = more spam protection but slower sending.
      </p>

      <div className="flex items-center gap-3 mb-2">
        <div className="flex-1 relative h-6 flex items-center">
          {/* Track background */}
          <div className="absolute left-0 right-0 h-1.5 rounded-full bg-muted-foreground/20" />
          {/* Filled track */}
          <div
            className="absolute left-0 h-1.5 rounded-full bg-amber-400 transition-all"
            style={{ width: `${Math.min(editMinPow, 100)}%` }}
          />
          {/* Visible thumb */}
          <div
            className="absolute w-4 h-4 rounded-full bg-amber-400 border-2 border-background shadow-lg pointer-events-none transition-all"
            style={{ left: `calc(${Math.min(editMinPow, 100)}% - 8px)` }}
          />
          {/* Invisible native range */}
          <input
            type="range"
            min={0}
            max={100}
            value={Math.min(editMinPow, 100)}
            onChange={(e) => setEditMinPow(parseInt(e.target.value, 10))}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>
        <div className="flex items-center h-7 rounded-md border border-input bg-background overflow-hidden">
          <button
            onClick={() => { const v = Math.max(0, editMinPow - 1); setEditMinPow(v) }}
            className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
          >
            <Minus size={12} />
          </button>
          <span className="px-2 text-sm text-foreground tabular-nums min-w-[28px] text-center">
            {editMinPow}
          </span>
          <button
            onClick={() => setEditMinPow(editMinPow + 1)}
            className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
          >
            <Plus size={12} />
          </button>
        </div>
        {editMinPow !== 15 ? (
          <Tip text="Reset to default (15)">
            <button
              onClick={() => setEditMinPow(15)}
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <RotateCcw size={14} />
            </button>
          </Tip>
        ) : (
          <div className="p-1 w-[22px]" />
        )}
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className={cn(
          'font-medium',
          editMinPow === 0 ? 'text-muted-foreground' : editMinPow <= 16 ? 'text-emerald-400' : editMinPow <= 24 ? 'text-amber-400' : 'text-red-400'
        )}>
          {editMinPow === 0 ? 'No PoW required' : `Difficulty: ${editMinPow} bits`}
        </span>
        <span className="text-muted-foreground">
          {hashRate ? solveTimeStr : 'Benchmarking…'}
        </span>
      </div>
    </div>
  )
}

// ── Upload Progress Bar ──

function UploadProgressBar({ progress, abortRef, small }: {
  progress: UploadProgress
  abortRef: React.MutableRefObject<AbortController | null>
  small?: boolean
}) {
  return (
    <div className={cn('flex flex-col gap-0.5 w-full', small ? 'mt-0.5' : 'mt-1 px-2')}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-amber-400 truncate max-w-[120px]">
          {shortServerName(progress.serverUrl)} ({progress.serverIndex + 1}/{progress.totalServers})
        </span>
        <button
          onClick={() => { abortRef.current?.abort(); abortRef.current = null }}
          className="text-muted-foreground hover:text-destructive cursor-pointer flex items-center gap-0.5"
        >
          <XCircle size={10} /><span className="text-[10px]">Skip</span>
        </button>
      </div>
      <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{Math.round(progress.percent)}%</span>
        <span>{formatSpeed(progress.speed)}</span>
      </div>
    </div>
  )
}

// ── Roles Page ──

function RolesPage({ hub, editRoles, setEditRoles, editChannels, editCategories, isCreator }: { hub: HubData; editRoles: Role[]; setEditRoles: (roles: Role[]) => void; editChannels: Channel[]; editCategories: Category[]; isCreator: boolean }) {
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const hubMembers = useHubStore((s) => s.hubMembers[hub.dTag]) || []

  /** Compute usage stats for a role to display in the delete warning */
  const getRoleUsageStats = (roleId: string) => {
    const affectedMembers = hubMembers.filter(m => {
      if (m.pubkey === hub.creatorPubkey) return false
      const roles = (m.roles || 'everyone').split('|').map(s => s.trim())
      return roles.includes(roleId)
    })
    const affectedChannels = editChannels.filter(ch => ch.permissions && ch.permissions[roleId] !== undefined)
    const affectedCategories = editCategories.filter(cat => cat.permissions && cat.permissions[roleId] !== undefined)
    return { affectedMembers, affectedChannels, affectedCategories }
  }

  const addRole = () => {
    const maxPos = Math.max(0, ...editRoles.map(r => r.position))
    const newRole: Role = {
      roleId: crypto.randomUUID(),
      name: 'New Role',
      position: maxPos + 1,
      permissions: { ...DEFAULT_EVERYONE_PERMISSIONS },
    }
    setEditRoles([...editRoles, newRole])
    setExpandedRoleId(newRole.roleId)
  }

  const deleteRole = (roleId: string) => {
    setEditRoles(editRoles.filter(r => r.roleId !== roleId))
    setDeleteConfirmId(null)
    if (expandedRoleId === roleId) setExpandedRoleId(null)
  }

  const updateRole = (roleId: string, updates: Partial<Role>) => {
    // Prevent renaming to 'everyone' — reserved for the default role
    if (updates.name !== undefined && updates.name.trim().toLowerCase() === 'everyone') {
      const existingRole = editRoles.find(r => r.roleId === roleId)
      if (existingRole && existingRole.name !== 'everyone') return
    }
    setEditRoles(editRoles.map(r => r.roleId === roleId ? { ...r, ...updates } : r))
  }

  const updatePermission = (roleId: string, perm: string, value: boolean) => {
    setEditRoles(editRoles.map(r =>
      r.roleId === roleId
        ? { ...r, permissions: { ...r.permissions, [perm]: value } }
        : r
    ))
  }

  // Sort roles: everyone first (position 0), then by ascending position
  const sortedRoles = useMemo(() => {
    const everyone = editRoles.filter(r => r.name === 'everyone')
    const rest = editRoles.filter(r => r.name !== 'everyone').sort((a, b) => a.position - b.position)
    return { everyone, rest }
  }, [editRoles])

  /** Move a non-everyone role up or down in position */
  const moveRole = (roleId: string, direction: 'up' | 'down') => {
    const rest = editRoles.filter(r => r.name !== 'everyone').sort((a, b) => a.position - b.position)
    const idx = rest.findIndex(r => r.roleId === roleId)
    if (idx < 0) return
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= rest.length) return
    // Reorder array
    const reordered = [...rest]
    const [moved] = reordered.splice(idx, 1)
    reordered.splice(swapIdx, 0, moved)
    // Renumber positions sequentially (1, 2, 3, ...)
    const posMap = new Map<string, number>()
    reordered.forEach((r, i) => posMap.set(r.roleId, i + 1))
    setEditRoles(editRoles.map(r => posMap.has(r.roleId) ? { ...r, position: posMap.get(r.roleId)! } : r))
  }

  const renderRoleCard = (role: Role) => {
    const isEveryone = role.name === 'everyone'
    const isExpanded = expandedRoleId === role.roleId
    const sortedRest = editRoles.filter(r => r.name !== 'everyone').sort((a, b) => a.position - b.position)
    const restIdx = sortedRest.findIndex(r => r.roleId === role.roleId)

    return (
      <div key={role.roleId} className="rounded-lg border border-border overflow-hidden">
        {/* Role header */}
        <button
          onClick={() => setExpandedRoleId(isExpanded ? null : role.roleId)}
          className="w-full flex items-center gap-2 px-4 py-3 hover:bg-secondary/30 transition-colors cursor-pointer"
        >
          {/* Color indicator */}
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: role.color || 'hsl(var(--primary))' }}
          />
          <span className="font-medium text-foreground text-sm flex-1 text-left">
            {role.name}
            {isEveryone && <span className="text-xs text-muted-foreground ml-1.5 font-normal">(default)</span>}
          </span>
          {/* Perm summary */}
          <span className="text-xs text-muted-foreground mr-2">
            {Object.values(role.permissions).filter(Boolean).length}/{PERMISSION_KEYS.length}
          </span>
          <ChevronDown size={14} className={cn('text-muted-foreground transition-transform', isExpanded && 'rotate-180')} />
        </button>

        {/* Expanded editor */}
        {isExpanded && (
          <div className="px-4 pb-4 border-t border-border/50 pt-3 space-y-4">
            {/* Role name */}
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground mb-1 block">Role Name</label>
                {isEveryone || !isCreator ? (
                  <span className="text-sm text-foreground">{role.name}</span>
                ) : (
                  <Input
                    value={role.name}
                    onChange={(e) => updateRole(role.roleId, { name: e.target.value })}
                    className="text-sm h-8"
                    placeholder="Role name"
                  />
                )}
              </div>

              {/* Color picker */}
              {isCreator && (
                <RoleColorPicker
                  color={role.color}
                  onChange={(c) => updateRole(role.roleId, { color: c })}
                />
              )}
            </div>

            {/* Hoist toggle — display role members separately in sidebar */}
            {!isEveryone && isCreator && (
              <div className="flex items-center justify-between px-3 py-2 rounded-md bg-secondary/20">
                <div className="flex flex-col gap-0 min-w-0 flex-1 mr-3">
                  <span className="text-sm text-foreground">Display role members separately</span>
                  <span className="text-[11px] text-muted-foreground leading-tight">Members with this role will appear in their own section in the member list</span>
                </div>
                <button
                  onClick={() => updateRole(role.roleId, { hoist: !role.hoist })}
                  className={cn(
                    'relative w-9 h-[20px] rounded-full transition-colors cursor-pointer shrink-0',
                    role.hoist ? 'bg-primary' : 'bg-muted-foreground/30'
                  )}
                >
                  <div className={cn(
                    'absolute top-[2px] w-4 h-4 rounded-full bg-white shadow transition-transform',
                    role.hoist ? 'translate-x-[18px]' : 'translate-x-[2px]'
                  )} />
                </button>
              </div>
            )}

            {/* Reorder controls */}
            {!isEveryone && isCreator && sortedRest.length > 1 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Position</span>
                <div className="flex items-center gap-1">
                  <Tip text="Move up">
                    <button
                      onClick={() => moveRole(role.roleId, 'up')}
                      disabled={restIdx === 0}
                      className={cn('p-1 rounded text-muted-foreground transition-colors cursor-pointer', restIdx === 0 ? 'opacity-30' : 'hover:text-foreground hover:bg-secondary/40')}
                    >
                      <ChevronUp size={14} />
                    </button>
                  </Tip>
                  <Tip text="Move down">
                    <button
                      onClick={() => moveRole(role.roleId, 'down')}
                      disabled={restIdx === sortedRest.length - 1}
                      className={cn('p-1 rounded text-muted-foreground transition-colors cursor-pointer', restIdx === sortedRest.length - 1 ? 'opacity-30' : 'hover:text-foreground hover:bg-secondary/40')}
                    >
                      <ChevronDown size={14} />
                    </button>
                  </Tip>
                </div>
              </div>
            )}

            <Separator />

            {/* Permission toggles */}
            <div>
              <label className="text-xs text-muted-foreground mb-2 block font-medium uppercase tracking-wider">Permissions</label>
              <div className="grid grid-cols-1 gap-1.5">
                {PERMISSION_KEYS.map((perm) => {
                  const enabled = role.permissions[perm] ?? false
                  const isDisabled = DISABLED_PERMISSIONS.has(perm)
                  return (
                    <div key={perm} className={cn(
                      'flex items-center justify-between px-3 py-2 rounded-md transition-colors',
                      isDisabled ? 'bg-secondary/10 opacity-50' : 'bg-secondary/20 hover:bg-secondary/40'
                    )}>
                      <div className="flex flex-col gap-0 min-w-0 flex-1 mr-3">
                        <span className="text-sm text-foreground flex items-center gap-2">
                          {PERMISSION_LABELS[perm]}
                          {isDisabled && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted-foreground/15 text-muted-foreground font-medium">Coming soon</span>
                          )}
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-tight">{PERMISSION_DESCRIPTIONS[perm]}</span>
                      </div>
                      {isCreator ? (
                        <button
                          onClick={() => !isDisabled && updatePermission(role.roleId, perm, !enabled)}
                          disabled={isDisabled}
                          className={cn(
                            'relative w-9 h-[20px] rounded-full transition-colors shrink-0',
                            isDisabled ? 'cursor-not-allowed' : 'cursor-pointer',
                            enabled && !isDisabled ? 'bg-primary' : 'bg-muted-foreground/30'
                          )}
                        >
                          <div className={cn(
                            'absolute top-[2px] w-4 h-4 rounded-full bg-white shadow transition-transform',
                            enabled && !isDisabled ? 'translate-x-[18px]' : 'translate-x-[2px]'
                          )} />
                        </button>
                      ) : (
                        <div className={cn('w-2 h-2 rounded-full shrink-0', enabled && !isDisabled ? 'bg-emerald-400' : 'bg-muted-foreground/30')} />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Delete role */}
            {isCreator && !isEveryone && (
              <>
                <Separator />
                {deleteConfirmId === role.roleId ? (() => {
                  const { affectedMembers, affectedChannels, affectedCategories } = getRoleUsageStats(role.roleId)
                  const hasImpact = affectedMembers.length > 0 || affectedChannels.length > 0 || affectedCategories.length > 0
                  return (
                    <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 space-y-2.5">
                      <div className="flex items-start gap-2">
                        <AlertTriangle size={14} className="text-destructive shrink-0 mt-0.5" />
                        <div className="flex-1 space-y-1">
                          <span className="text-xs font-medium block">Delete "{role.name}"?</span>
                          {hasImpact ? (
                            <div className="text-xs space-y-1">
                              <p>This role is currently in use. Deleting it will:</p>
                              <ul className="list-disc list-inside space-y-0.5 ml-1">
                                {affectedMembers.length > 0 && (
                                  <li>Remove it from <strong>{affectedMembers.length}</strong> member{affectedMembers.length !== 1 ? 's' : ''} (they'll fall back to "everyone")</li>
                                )}
                                {affectedChannels.length > 0 && (
                                  <li>Remove permission overrides from <strong>{affectedChannels.length}</strong> channel{affectedChannels.length !== 1 ? 's' : ''}</li>
                                )}
                                {affectedCategories.length > 0 && (
                                  <li>Remove permission overrides from <strong>{affectedCategories.length}</strong> categor{affectedCategories.length !== 1 ? 'ies' : 'y'}</li>
                                )}
                              </ul>
                              <p className="mt-1.5 text-[11px]">
                                The member tree and encryption groups will be updated automatically when you publish.
                              </p>
                            </div>
                          ) : (
                            <span className="text-xs text-destructive/80">This role is not assigned to any members or used in any permissions.</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 justify-end">
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setDeleteConfirmId(null)}>
                          Cancel
                        </Button>
                        <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={() => deleteRole(role.roleId)}>
                          {hasImpact ? 'Delete Anyway' : 'Delete'}
                        </Button>
                      </div>
                    </div>
                  )
                })() : (
                  <button
                    onClick={() => setDeleteConfirmId(role.roleId)}
                    className="flex items-center gap-1.5 text-xs text-destructive hover:text-destructive/80 transition-colors cursor-pointer"
                  >
                    <Trash2 size={12} />
                    Delete Role
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Everyone role (always first) */}
      {sortedRoles.everyone.map(renderRoleCard)}

      {/* Separator between everyone and custom roles */}
      {sortedRoles.rest.length > 0 && (
        <div className="flex items-center gap-3 py-1">
          <Separator className="flex-1" />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">Custom Roles</span>
          <Separator className="flex-1" />
        </div>
      )}

      {/* Custom roles sorted by position */}
      {sortedRoles.rest.map(renderRoleCard)}

      {/* Add role button */}
      {isCreator && (
        <button
          onClick={addRole}
          className="flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors cursor-pointer"
        >
          <Plus size={14} />
          Add Role
        </button>
      )}

      {!isCreator && (
        <p className="text-xs text-muted-foreground">Only the hub creator can manage roles.</p>
      )}
    </div>
  )
}
// ── Security Page ──

function SecurityPage({ hub }: { hub: HubData }) {
  const [showConfirm, setShowConfirm] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [fixSuccess, setFixSuccess] = useState(false)
  const [fixStep, setFixStep] = useState<string | null>(null)
  const [fixSteps, setFixSteps] = useState<string[]>([])

  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const pubkey = useUserStore((s) => s.pubkey)
  const authMethod = useUserStore((s) => s.authMethod)
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const setHubData = useHubStore((s) => s.setHubData)
  const setHubSecret = useHubStore((s) => s.setHubSecret)
  const setHubMembers = useHubStore((s) => s.setHubMembers)

  /** Yield to let React render between sync steps */
  const markStep = async (step: string) => {
    setFixStep(step)
    await new Promise(r => setTimeout(r, 0))
  }
  const markDone = (step: string) => setFixSteps(prev => [...prev, step])

  // ── Time guesstimate ──
  const currentMembers = useHubStore((s) => s.hubMembers[hub.dTag]) || []
  const memberCount = Math.max(currentMembers.length, 1) // at least creator
  const groupedRoles = hub.groupedRoles || []

  const computeEstimate = () => {
    // Per-encrypt rate based on signer type
    const isLocalKey = authMethod === 'nsec' || authMethod === 'seed'
    const msPerEncrypt = isLocalKey ? 1 : 200

    // Count total NIP-04 encryptions: hub tree + all group trees
    let totalGroupMembers = 0
    if (groupedRoles.length > 0) {
      // Lazy import would be async — use a rough estimate: assume each group
      // has ~60% of total members on average (some groups are small, some large)
      totalGroupMembers = Math.ceil(memberCount * 0.6) * groupedRoles.length
    }
    const totalEncryptions = memberCount + totalGroupMembers
    const numPages = Math.ceil(memberCount / 10_000)
    const numUploads = numPages + groupedRoles.length + 3 // pages + group trees + spine + history + index
    const downloadOverheadMs = 5_000
    const uploadOverheadMs = numUploads * 2_000
    const estimateMs = (totalEncryptions * msPerEncrypt) + downloadOverheadMs + uploadOverheadMs

    // Round up to nearest 30s, minimum 30s
    const estimateSec = Math.max(30, Math.ceil(estimateMs / 30_000) * 30)
    if (estimateSec <= 30) return 'up to 30 seconds'
    if (estimateSec <= 60) return 'up to 1 minute'
    const mins = Math.ceil(estimateSec / 60)
    return `up to ${mins} minutes`
  }

  const handleFixEncryption = async () => {
    if (!pubkey || fixing) return
    setFixing(true)
    setFixError(null)
    setFixSuccess(false)
    setFixStep(null)
    setFixSteps([])

    try {
      await markStep('Downloading current tree')
      const { downloadTextFromBlossom, parseIndexFile, uploadToBlossomServers } = await import('@/lib/blossom')
      const { aesEncrypt, aesDecrypt } = await import('@/lib/crypto/aes')
      const { createPaginatedIndexFile } = await import('@/lib/blossom/members')

      const oldSecretHex = hubSecrets[hub.dTag]
      const oldSecret = oldSecretHex ? fromHex(oldSecretHex) : null

      // 1. Download and parse old index — capture ban pages + group tree refs
      let oldEpochLines: string[] = []
      let oldSpineHash = ''
      let oldHistoryHash = ''
      let oldBanPageHashes: string[] = []
      let oldGroupTreeRefs: Array<{ groupId: string; hash: string }> = []
      let oldLeafPageHashes: string[] = []
      if (oldSecret && hub.indexFileHash && hub.blossomServers.length > 0) {
        try {
          const indexContent = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
          const index = parseIndexFile(indexContent)
          oldSpineHash = index.spineHash
          oldHistoryHash = index.historyHash
          oldBanPageHashes = index.banPages.map(bp => bp.hash)
          oldGroupTreeRefs = [...index.groupTrees]
          oldLeafPageHashes = index.leafPages.map(lp => lp.hash)

          if (index.historyHash) {
            const historyBlob = await downloadTextFromBlossom(index.historyHash, hub.blossomServers)
            try {
              const plaintext = await aesDecrypt(oldSecret, historyBlob)
              oldEpochLines = plaintext.split('\n').filter(l => l.trim())
            } catch {
              console.warn('Could not decrypt history blob — trying legacy per-row format')
              for (const line of historyBlob.split('\n')) {
                const trimmed = line.trim()
                if (!trimmed || !trimmed.startsWith('hub:')) continue
                const colonIdx = trimmed.indexOf(':', 4)
                if (colonIdx === -1) continue
                const epochNum = parseInt(trimmed.slice(4, colonIdx), 10)
                const encryptedSecret = trimmed.slice(colonIdx + 1)
                try {
                  const decryptedHex = await aesDecrypt(oldSecret, encryptedSecret)
                  oldEpochLines.push(`hub:${epochNum}:${decryptedHex}`)
                } catch {
                  console.warn(`Could not decrypt epoch ${epochNum} from legacy history`)
                }
              }
            }
          }
        } catch (err) {
          console.warn('Could not load old history file:', err)
        }
      }
      markDone('Downloading current tree')

      // 2. Generate a new hub secret
      await markStep('Rebuilding member tree')
      const newHubSecret = crypto.getRandomValues(new Uint8Array(32))
      const newSecretHex = toHex(newHubSecret)
      const newEpoch = hub.epoch + 1

      // 3. Build updated hub history — preserve old epoch lines, add old current + new epoch
      const lines = [...oldEpochLines]
      if (oldSecretHex) {
        const alreadyStored = lines.some(l => l.startsWith(`hub:${hub.epoch}:`))
        if (!alreadyStored) {
          lines.push(`hub:${hub.epoch}:${oldSecretHex}`)
        }
      }
      lines.push(`hub:${newEpoch}:${newSecretHex}`)

      // 4. Build a new paginated LKH tree with ALL current members
      const {
        createLeaf, buildLeafPage, buildSpine,
        serializeLeafPage, serializeSpine, PAGE_SIZE,
      } = await import('@/lib/crypto/lkh')
      const { nip04Encrypt } = await import('@/lib/blossom/members')
      const storeMembers = useHubStore.getState().hubMembers[hub.dTag] || []

      const memberPubkeySet = new Set<string>()
      memberPubkeySet.add(pubkey)
      for (const m of storeMembers) {
        memberPubkeySet.add(m.pubkey)
      }

      // Create leaves sorted by pubkey for deterministic page assignment
      const allLeaves = []
      for (const memberPk of [...memberPubkeySet].sort()) {
        const memberRoles = storeMembers.find(m => m.pubkey === memberPk)?.roles || 'everyone'
        const leaf = createLeaf(memberPk, memberRoles)
        const leafKeyHex = toHex(leaf.rawKey!)
        leaf.encryptedLeafKey = await nip04Encrypt(memberPk, leafKeyHex, signer, privateKey)
        allLeaves.push(leaf)
      }

      // Split into pages
      const pageChunks: typeof allLeaves[] = []
      for (let i = 0; i < allLeaves.length; i += PAGE_SIZE) {
        pageChunks.push(allLeaves.slice(i, i + PAGE_SIZE))
      }

      // Build leaf pages
      const builtPages = []
      for (let pi = 0; pi < pageChunks.length; pi++) {
        const page = await buildLeafPage(pageChunks[pi], pi)
        builtPages.push(page)
      }

      // Upload each page
      const leafPageRefs: Array<{ pageIndex: number; firstPubkey: string; hash: string }> = []
      const pageRoots: Array<{ nodeId: string; rawKey: Uint8Array }> = []
      for (let pi = 0; pi < builtPages.length; pi++) {
        const serialized = serializeLeafPage(builtPages[pi])
        const pageBytes = new TextEncoder().encode(serialized)
        const { hash } = await uploadToBlossomServers(
          pageBytes, signer, privateKey, hub.blossomServers, 'text/plain',
        )
        leafPageRefs.push({
          pageIndex: pi,
          firstPubkey: builtPages[pi].leaves[0].pubkey,
          hash,
        })
        pageRoots.push({
          nodeId: builtPages[pi].pageRoot.nodeId,
          rawKey: builtPages[pi].pageRoot.rawKey!,
        })
      }

      // Build and upload spine
      const spine = await buildSpine(pageRoots, newHubSecret)
      const spineContent = serializeSpine(spine)
      const spineBytes = new TextEncoder().encode(spineContent)
      const { hash: spineHash } = await uploadToBlossomServers(
        spineBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )

      console.log(`Fix encryption: rebuilt paginated LKH tree with ${allLeaves.length} members across ${builtPages.length} page(s), epoch ${newEpoch}`)
      markDone('Rebuilding member tree')

      // 5. Rebuild group trees with new secrets + bumped epochs
      let updatedGroupedRoles = [...(hub.groupedRoles || [])]
      const updatedGroupTrees: Array<{ groupId: string; hash: string }> = []
      const groupHistoryEntries: Array<{ groupId: string; epoch: number; secretHex: string }> = []
      const oldGroupTreeHashesForCleanup: string[] = oldGroupTreeRefs.map(gt => gt.hash)

      if (updatedGroupedRoles.length > 0) {
        await markStep('Rebuilding group encryption')
        const { memberQualifiesForGroup, getGroupMembers } = await import('@/lib/hub/groupEncryption')
        const { createAndUploadGroupTree } = await import('@/lib/blossom/members')

        for (let gi = 0; gi < updatedGroupedRoles.length; gi++) {
          const group = updatedGroupedRoles[gi]
          try {
            // Determine qualifying members for this group
            const qualifying = getGroupMembers(storeMembers, group.roleIds)
            // Always include the hub creator
            const groupMemberPubkeys = Array.from(new Set([
              pubkey,
              ...qualifying.map(m => m.pubkey),
            ]))

            if (groupMemberPubkeys.length === 0) continue

            // Record old group secret for history
            const oldGroupSecretHex = useHubStore.getState().groupSecrets[hub.dTag]?.[group.groupId]
            if (oldGroupSecretHex) {
              groupHistoryEntries.push({
                groupId: group.groupId,
                epoch: group.epoch,
                secretHex: oldGroupSecretHex,
              })
            }

            // Generate new group secret
            const newGroupSecret = crypto.getRandomValues(new Uint8Array(32))
            const newGroupSecretHex = Array.from(newGroupSecret)
              .map(b => b.toString(16).padStart(2, '0')).join('')

            // Create and upload new group tree
            const groupTreeHash = await createAndUploadGroupTree(
              groupMemberPubkeys, newGroupSecret, signer, privateKey, hub.blossomServers,
            )

            updatedGroupTrees.push({ groupId: group.groupId, hash: groupTreeHash })

            // Bump group epoch
            const newGroupEpoch = group.epoch + 1
            updatedGroupedRoles[gi] = { ...group, epoch: newGroupEpoch }

            // Record new group secret for history
            groupHistoryEntries.push({
              groupId: group.groupId,
              epoch: newGroupEpoch,
              secretHex: newGroupSecretHex,
            })

            // Update local group secret
            useHubStore.getState().setGroupSecret(hub.dTag, group.groupId, newGroupSecretHex)

            console.log(`Fix encryption: rebuilt group tree for ${group.groupId} with ${groupMemberPubkeys.length} members, epoch ${newGroupEpoch}`)
          } catch (err) {
            console.warn(`Failed to rebuild group tree ${group.groupId}:`, err)
          }
        }
        markDone('Rebuilding group encryption')
      }

      // 6. Append group history entries to the history blob
      if (groupHistoryEntries.length > 0) {
        for (const entry of groupHistoryEntries) {
          const line = `group:${entry.groupId}:${entry.epoch}:${entry.secretHex}`
          const existIdx = lines.findIndex(l => l.startsWith(`group:${entry.groupId}:${entry.epoch}:`))
          if (existIdx >= 0) lines[existIdx] = line
          else lines.push(line)
        }
      }

      // 7. Encrypt and upload final history blob (with hub + group entries)
      await markStep('Uploading tree & index')
      const finalHistoryBlob = await aesEncrypt(newHubSecret, lines.join('\n'))
      const finalHistoryBytes = new TextEncoder().encode(finalHistoryBlob)
      const { hash: historyHash } = await uploadToBlossomServers(
        finalHistoryBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )

      // 8. Create and upload index file with preserved ban pages + rebuilt group trees
      const indexContent = createPaginatedIndexFile(
        spineHash,
        leafPageRefs,
        oldBanPageHashes,
        historyHash,
        updatedGroupTrees.length > 0 ? updatedGroupTrees : undefined,
      )
      const indexBytes = new TextEncoder().encode(indexContent)
      const { hash: finalIndexHash } = await uploadToBlossomServers(
        indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )
      markDone('Uploading tree & index')

      // 9. Publish updated hub event
      await markStep('Publishing hub event')
      const unsignedEvent = rebuildHubEvent({
        dTag: hub.dTag,
        name: hub.name,
        description: hub.description || undefined,
        epoch: newEpoch,
        icon: hub.icon || undefined,
        banner: hub.banner || undefined,
        tags: hub.tags,
        relays: [...hub.generalRelays, ...hub.filterRelays],
        blossomServers: hub.blossomServers,
        indexFileHash: finalIndexHash,
        channels: hub.channels,
        categories: hub.categories,
        roles: hub.roles,
        minPow: hub.minPow > 0 ? hub.minPow : undefined,
        nsfw: hub.nsfw || undefined,
        discoverable: hub.discoverable,
        groupedRoles: updatedGroupedRoles,
        publishedAt: hub.publishedAt,
      })
      const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signedEvent)
      markDone('Publishing hub event')

      // 10. Update local store
      setHubSecret(hub.dTag, newSecretHex)
      // Update hub epoch history locally so old messages remain decryptable
      const epochMap: Record<number, string> = {}
      for (const l of lines) {
        if (l.startsWith('hub:')) {
          const parts = l.split(':')
          if (parts.length >= 3) epochMap[parseInt(parts[1], 10)] = parts.slice(2).join(':')
        }
      }
      if (Object.keys(epochMap).length > 0) {
        useHubStore.getState().setEpochSecrets(hub.dTag, epochMap)
      }
      // Update group epoch secrets locally
      if (groupHistoryEntries.length > 0) {
        const groupEpochMaps: Record<string, Record<number, string>> = {}
        for (const entry of groupHistoryEntries) {
          if (!groupEpochMaps[entry.groupId]) groupEpochMaps[entry.groupId] = {}
          groupEpochMaps[entry.groupId][entry.epoch] = entry.secretHex
        }
        for (const [gid, gmap] of Object.entries(groupEpochMaps)) {
          useHubStore.getState().setGroupEpochSecrets(hub.dTag, gid, gmap)
        }
      }
      // Members are preserved — same list in the new tree
      setHubData(hub.dTag, {
        ...hub,
        indexFileHash: finalIndexHash,
        epoch: newEpoch,
        groupedRoles: updatedGroupedRoles,
      })

      // 11. Cleanup old files (best-effort, only after everything succeeded)
      const { deleteFromBlossom } = await import('@/lib/blossom/client')
      const oldIndexHash = hub.indexFileHash
      if (oldSpineHash && oldSpineHash !== spineHash) {
        deleteFromBlossom(oldSpineHash, signer, privateKey, hub.blossomServers).catch(() => { })
      }
      if (oldIndexHash && oldIndexHash !== finalIndexHash) {
        deleteFromBlossom(oldIndexHash, signer, privateKey, hub.blossomServers).catch(() => { })
      }
      if (oldHistoryHash && oldHistoryHash !== historyHash) {
        deleteFromBlossom(oldHistoryHash, signer, privateKey, hub.blossomServers).catch(() => { })
      }
      // Clean up old leaf pages
      for (const oldPageHash of oldLeafPageHashes) {
        if (!leafPageRefs.some(lp => lp.hash === oldPageHash)) {
          deleteFromBlossom(oldPageHash, signer, privateKey, hub.blossomServers).catch(() => { })
        }
      }
      // Clean up old group tree blobs
      for (const oldGtHash of oldGroupTreeHashesForCleanup) {
        if (!updatedGroupTrees.some(gt => gt.hash === oldGtHash)) {
          deleteFromBlossom(oldGtHash, signer, privateKey, hub.blossomServers).catch(() => { })
        }
      }

      setFixSuccess(true)
      setShowConfirm(false)
    } catch (err: any) {
      console.error('Fix encryption failed:', err)
      setFixError(err?.message || 'Failed to fix hub encryption')
    } finally {
      setFixing(false)
    }
  }

  // ── Progress overlay steps ──
  const allFixStepLabels = [
    'Downloading current tree',
    'Rebuilding member tree',
    ...(groupedRoles.length > 0 ? ['Rebuilding group encryption'] : []),
    'Uploading tree & index',
    'Publishing hub event',
  ]

  // ── Time estimate for confirmation dialog ──
  const timeEstimate = computeEstimate()

  return (
    <div className="flex flex-col gap-6">
      {/* Explanation */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} className="text-primary shrink-0 mt-0.5" />
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Hub Encryption</h3>
            <p className="text-sm text-muted-foreground">
              Your hub uses an <strong className="text-foreground">LKH (Logical Key Hierarchy)</strong> tree
              to manage channel encryption. Each member has a unique leaf key in the tree, and the hub secret
              is derived through layered AES encryption from their leaf up to the root.
            </p>
          </div>
        </div>
      </div>

      {/* Fix Encryption section */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <RefreshCw size={14} />
          Fix Hub Encryption
        </h4>
        <p className="text-sm text-muted-foreground">
          If members are unable to decrypt messages or the encryption tree becomes corrupted,
          you can rebuild it from scratch. This will:
        </p>
        <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1 ml-1">
          <li>Generate a <strong className="text-foreground">new hub secret</strong></li>
          <li>Rebuild the LKH tree with <strong className="text-foreground">all current members</strong> (balanced tree)</li>
          {groupedRoles.length > 0 && (
            <li>Rebuild <strong className="text-foreground">{groupedRoles.length} group tree{groupedRoles.length !== 1 ? 's' : ''}</strong> with new secrets</li>
          )}
          <li>Bump the <strong className="text-foreground">epoch number</strong> (signals key rotation)</li>
          <li>Preserve the <strong className="text-foreground">epoch history</strong> so old messages remain readable</li>
          <li>Upload the new tree, history, and index to Blossom</li>
          <li>Publish an updated hub event</li>
        </ul>
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 mt-2">
          <p className="text-xs text-amber-400">
            <strong>⚠ Note:</strong> All current members are preserved in the new tree.
            They will automatically pick up the new epoch and secret on their next sync.
            Old messages from previous epochs remain readable through the epoch history chain.
          </p>
        </div>
      </div>

      {/* Progress overlay when fixing */}
      {fixing && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Loader2 size={16} className="animate-spin text-primary" />
            <span className="text-sm font-semibold text-foreground">Rebuilding encryption…</span>
          </div>
          <div className="space-y-2 ml-1">
            {allFixStepLabels.map((label) => {
              const isDone = fixSteps.includes(label)
              const isActive = fixStep === label && !isDone
              return (
                <div key={label} className="flex items-center gap-2 text-sm">
                  {isDone ? (
                    <Check size={14} className="text-emerald-400 shrink-0" />
                  ) : isActive ? (
                    <Loader2 size={14} className="animate-spin text-primary shrink-0" />
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-border shrink-0" />
                  )}
                  <span className={isDone ? 'text-emerald-400' : isActive ? 'text-foreground' : 'text-muted-foreground/50'}>
                    {label}
                    {label === 'Rebuilding member tree' && isActive && ` (${memberCount} members)`}
                    {label === 'Rebuilding group encryption' && isActive && ` (${groupedRoles.length} group${groupedRoles.length !== 1 ? 's' : ''})`}
                  </span>
                </div>
              )
            })}
          </div>
          {fixError && (
            <div className="mt-2 space-y-2">
              <p className="text-sm text-destructive">{fixError}</p>
              <div className="flex gap-2">
                <Button onClick={handleFixEncryption} variant="destructive" size="sm">
                  <RefreshCw size={12} className="mr-1.5" /> Retry
                </Button>
                <Button onClick={() => { setFixing(false); setFixError(null); setFixStep(null); setFixSteps([]) }} variant="ghost" size="sm">
                  Dismiss
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {!showConfirm && !fixing ? (
        <Button
          onClick={() => setShowConfirm(true)}
          variant="outline"
          className="w-fit"
        >
          <RefreshCw size={14} className="mr-2" />
          Fix Hub Encryption
        </Button>
      ) : !fixing && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-amber-400">Are you sure?</h4>
              <p className="text-sm text-muted-foreground">
                This will <strong className="text-foreground">rebuild the encryption tree</strong> with a new hub secret
                and bump the epoch.
                All current members are preserved — they will automatically receive the new keys on sync.
                Only do this if members are experiencing decryption failures or the tree is corrupted.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                This hub has <strong className="text-foreground">{memberCount.toLocaleString()} member{memberCount !== 1 ? 's' : ''}</strong>
                {groupedRoles.length > 0 && <> and <strong className="text-foreground">{groupedRoles.length} group tree{groupedRoles.length !== 1 ? 's' : ''}</strong></>}.
                {' '}Estimated time: <strong className="text-amber-400">{timeEstimate}</strong>.
              </p>
            </div>
          </div>

          {fixError && (
            <p className="text-sm text-destructive">{fixError}</p>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleFixEncryption}
              disabled={fixing}
              variant="destructive"
              className="min-w-[160px]"
            >
              Yes, Fix Encryption
            </Button>
            <Button
              onClick={() => { setShowConfirm(false); setFixError(null) }}
              variant="ghost"
              disabled={fixing}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {fixSuccess && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
          <p className="text-sm text-emerald-400 flex items-center gap-2">
            <ShieldCheck size={14} />
            Encryption fixed successfully! The hub now uses a fresh encryption tree with epoch {hub.epoch + 1}.
            {groupedRoles.length > 0 && ` ${groupedRoles.length} group tree${groupedRoles.length !== 1 ? 's were' : ' was'} also rebuilt.`}
          </p>
        </div>
      )}
    </div>
  )
}

// ── Dangerous Page ──

interface DangerousPageProps {
  hub: HubData
  onClose: () => void
  setHubStatus: (dTag: string, status: 'loaded' | 'not-found' | 'deleted') => void
}

function DangerousPage({ hub, onClose, setHubStatus }: DangerousPageProps) {
  const [confirmName, setConfirmName] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const nameMatches = confirmName === hub.name

  const handleDelete = async () => {
    try {
      // 1. Re-publish hub event with deleted tag (primary — addressable replaceable overwrite)
      const deletedHubEvent = createUnsignedEvent(KINDS.HUB_EVENT, '', [
        ['d', hub.dTag],
        ['n', hub.name],
        ['epoch', hub.epoch.toString()],
        ['deleted', 'true'],
      ] as [string, ...string[]][])

      const signedDeletedHub = await signWithSigner(deletedHubEvent, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signedDeletedHub)

      // 2. NIP-09 Kind 5 deletion request as fallback
      const deleteEvent = createUnsignedEvent(5, 'Hub deletion requested', [
        ['a', `36942:${hub.creatorPubkey}:${hub.dTag}`],
      ] as [string, ...string[]][])

      const signedDelete = await signWithSigner(deleteEvent, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signedDelete)

      // Update local state
      setHubStatus(hub.dTag, 'deleted')

      onClose()
    } catch (err: any) {
      setDeleteError(err?.message || 'Failed to publish delete request')
      setShowDeleteDialog(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Warning */}
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} className="text-destructive shrink-0 mt-0.5" />
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-destructive">Delete Hub</h3>
            <p className="text-sm text-muted-foreground">
              This will publish a deletion request for <strong className="text-foreground">{hub.name}</strong>.
              Because this is a decentralized network, deletion is a <strong className="text-foreground">request</strong> — relays may or may not honor it.
              This action may or may not be permanent and irreversible.
            </p>
          </div>
        </div>
      </div>

      {/* Confirmation */}
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          To confirm, type the hub name below (case-sensitive):
        </p>
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 mb-2">
          <span className="text-sm font-mono text-foreground">{hub.name}</span>
        </div>
        <Input
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
          placeholder="Type the hub name to confirm..."
          className="font-mono"
        />
      </div>

      {deleteError && (
        <p className="text-sm text-destructive">{deleteError}</p>
      )}

      <Button
        onClick={() => setShowDeleteDialog(true)}
        disabled={!nameMatches}
        variant="destructive"
        className="w-full"
      >
        Publish Delete Request
      </Button>

      {showDeleteDialog && (
        <DeleteConfirmDialog
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteDialog(false)}
          title="Request Delete Hub"
          confirmLabel="Yes, Delete Hub"
        />
      )}
    </div>
  )
}

// ── Banned Users Page ──

function BannedUsersPage({ hub }: { hub: HubData }) {
  const hubBanLists = useHubStore((s) => s.hubBanLists)
  const hubMembers = useHubStore((s) => s.hubMembers)
  const setHubBanList = useHubStore((s) => s.setHubBanList)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const pubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const modBanLists = useHubStore((s) => s.modBanLists[hub.dTag]) || {}

  const bannedPubkeys = hubBanLists[hub.dTag] || []
  const members = hubMembers[hub.dTag] || []
  const memberPubkeySet = useMemo(() => new Set(members.map(m => m.pubkey)), [members])

  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [unbanning, setUnbanning] = useState(false)
  const [unbanError, setUnbanError] = useState<string | null>(null)
  const [unbanStep, setUnbanStep] = useState<string | null>(null)
  const [unbanSteps, setUnbanSteps] = useState<string[]>([])
  const [refreshingModBans, setRefreshingModBans] = useState(false)
  const [unbanMode, setUnbanMode] = useState<'unban' | 'readd'>('unban')
  const UNBAN_STEPS = ['Downloading current index', 'Uploading ban pages', 'Publishing hub event']

  // Refresh mod ban lists from relays/Blossom
  const handleRefreshModBans = async () => {
    if (refreshingModBans) return
    setRefreshingModBans(true)
    try {
      const { loadModBanLists } = await import('@/hooks/useHubLoader')
      const modBans = await loadModBanLists(hub, members)
      const setModBanList = useHubStore.getState().setModBanList
      for (const [modPubkey, bannedPks] of Object.entries(modBans)) {
        setModBanList(hub.dTag, modPubkey, bannedPks)
      }
    } catch (err) {
      console.error('Failed to refresh mod ban lists:', err)
    } finally {
      setRefreshingModBans(false)
    }
  }

  const filteredBanned = useMemo(() => {
    if (!search.trim()) return bannedPubkeys
    const q = search.toLowerCase().trim()
    return bannedPubkeys.filter((pk) => {
      if (pk.toLowerCase().includes(q)) return true
      const profile = getProfile(pk)
      if (profile?.display_name?.toLowerCase().includes(q)) return true
      if (profile?.name?.toLowerCase().includes(q)) return true
      return false
    })
  }, [bannedPubkeys, search, getProfile])

  const toggleSelect = (pk: string) => {
    const next = new Set(selected)
    if (next.has(pk)) next.delete(pk)
    else next.add(pk)
    setSelected(next)
  }

  const selectAll = () => {
    if (selected.size === filteredBanned.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filteredBanned))
    }
  }

  const handleUnban = async () => {
    if (selected.size === 0 || unbanning) return
    setUnbanMode('unban')
    setUnbanning(true)
    setUnbanError(null)
    setUnbanSteps([])

    const markStep = async (step: string) => {
      setUnbanStep(step)
      await new Promise(r => setTimeout(r, 0))
    }
    const markDone = (step: string) => setUnbanSteps(prev => [...prev, step])

    try {
      // Remove selected pubkeys from the local ban list
      const remaining = bannedPubkeys.filter(pk => !selected.has(pk))
      setHubBanList(hub.dTag, remaining)

      await markStep('Downloading current index')
      // Re-upload ban page + index to Blossom
      const { uploadBanPages, createPaginatedIndexFile, parseIndexFile, downloadTextFromBlossom } = await import('@/lib/blossom')

      // Download current index to preserve spine/history hashes
      let spineHash = ''
      let historyHash = ''
      let groupTrees: Array<{ groupId: string; hash: string }> = []
      let leafPages: Array<{ pageIndex: number; firstPubkey: string; hash: string }> = []
      if (hub.indexFileHash && hub.blossomServers.length > 0) {
        try {
          const indexContent = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
          const index = parseIndexFile(indexContent)
          spineHash = index.spineHash
          historyHash = index.historyHash
          groupTrees = index.groupTrees
          leafPages = index.leafPages
        } catch {
          console.warn('Could not download current index for unban')
        }
      }
      markDone('Downloading current index')

      // Upload new ban pages (or empty if no bans remain)
      await markStep('Uploading ban pages')
      const banPageHashes = remaining.length > 0
        ? await uploadBanPages(
          remaining.map(pk => ({ pubkey: pk, reason: '' })),
          signer, privateKey, hub.blossomServers,
        )
        : []

      // Build and upload new index file
      const { uploadToBlossomServers } = await import('@/lib/blossom')
      const indexContent = createPaginatedIndexFile(spineHash, leafPages, banPageHashes, historyHash || undefined, groupTrees.length > 0 ? groupTrees : undefined)
      const indexBytes = new TextEncoder().encode(indexContent)
      const { hash: newIndexHash } = await uploadToBlossomServers(
        indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )
      markDone('Uploading ban pages')

      // Re-publish hub event with new index hash
      await markStep('Publishing hub event')
      const { signWithSigner } = await import('@/lib/nostr/events')
      const { publishToSpecificRelays: pubToRelays } = await import('@/lib/nostr/relay-pool')
      const unsignedEvent = buildHubEvent({
        dTag: hub.dTag,
        name: hub.name,
        description: hub.description || undefined,
        epoch: hub.epoch,
        icon: hub.icon,
        banner: hub.banner,
        tags: hub.tags,
        relays: [...hub.generalRelays, ...hub.filterRelays],
        blossomServers: hub.blossomServers,
        indexFileHash: newIndexHash,
        channels: hub.channels,
        categories: hub.categories,
        roles: hub.roles,
        minPow: hub.minPow || undefined,
        nsfw: hub.nsfw || undefined,
        discoverable: hub.discoverable,
        groupedRoles: hub.groupedRoles,
        publishedAt: hub.publishedAt,

      })
      const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
      await pubToRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signedEvent)
      markDone('Publishing hub event')

      // Update local store
      useHubStore.getState().setHubData(hub.dTag, { ...hub, indexFileHash: newIndexHash })
      setSelected(new Set())

      await markStep('Done')
    } catch (err: any) {
      console.error('Unban failed:', err)
      setUnbanError(err?.message || 'Failed to unban')
    } finally {
      setUnbanning(false)
    }
  }

  const READD_STEPS = ['Downloading current index', 'Re-adding to member tree', 'Uploading ban pages', 'Publishing hub event']

  const handleUnbanAndReadd = async () => {
    if (selected.size === 0 || unbanning) return
    setUnbanMode('readd')
    setUnbanning(true)
    setUnbanError(null)
    setUnbanSteps([])

    const markStep = async (step: string) => {
      setUnbanStep(step)
      await new Promise(r => setTimeout(r, 0))
    }
    const markDone = (step: string) => setUnbanSteps(prev => [...prev, step])

    try {
      const remaining = bannedPubkeys.filter(pk => !selected.has(pk))
      const toReadd = [...selected]
      setHubBanList(hub.dTag, remaining)

      await markStep('Downloading current index')
      const {
        uploadBanPages, createPaginatedIndexFile, parseIndexFile,
        downloadTextFromBlossom, uploadToBlossomServers,
        rehydratePageKeys, addMemberToPage, findPageForPubkey,
      } = await import('@/lib/blossom')
      const {
        fromHex, deserializeSpine, recoverPageRootKeys,
        buildSpine, serializeLeafPage, serializeSpine,
        getPageMembers,
      } = await import('@/lib/crypto/lkh')

      // Download current index
      let spineHash = ''
      let historyHash = ''
      let groupTrees: Array<{ groupId: string; hash: string }> = []
      let leafPages: Array<{ pageIndex: number; firstPubkey: string; hash: string }> = []
      if (hub.indexFileHash && hub.blossomServers.length > 0) {
        try {
          const indexContent = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
          const index = parseIndexFile(indexContent)
          spineHash = index.spineHash
          historyHash = index.historyHash
          groupTrees = index.groupTrees
          leafPages = [...index.leafPages]
        } catch {
          console.warn('Could not download current index for unban+readd')
        }
      }
      markDone('Downloading current index')

      // Re-add unbanned users to the LKH tree (page-level)
      await markStep('Re-adding to member tree')
      let newSpineHash = spineHash
      if (spineHash && leafPages.length > 0) {
        const hubSecretHex = useHubStore.getState().hubSecrets[hub.dTag]
        if (hubSecretHex) {
          const hubSecret = fromHex(hubSecretHex)

          const spineContent = await downloadTextFromBlossom(spineHash, hub.blossomServers)
          const spine = deserializeSpine(spineContent)
          const pageRootKeys = await recoverPageRootKeys(spine, hubSecret)

          // Group members by target page
          const pageMods = new Map<number, { pageRef: typeof leafPages[0]; newMembers: string[] }>()
          const index = { spineHash, leafPages, pageSize: leafPages.length > 0 ? 10000 : 0 } as any

          for (const pk of toReadd) {
            const pageRef = findPageForPubkey(index, pk)
            if (!pageRef) continue
            const existing = pageMods.get(pageRef.pageIndex)
            if (existing) existing.newMembers.push(pk)
            else pageMods.set(pageRef.pageIndex, { pageRef, newMembers: [pk] })
          }

          const updatedPages: Array<{ pageIndex: number; content: string; firstPubkey: string; hash: string }> = []
          const updatedPageRoots = new Map<number, { nodeId: string; rawKey: Uint8Array }>()
          const allNewMembers: string[] = []

          for (const [pageIndex, mod] of pageMods) {
            const pageContent = await downloadTextFromBlossom(mod.pageRef.hash, hub.blossomServers)
            let rehydrated = await rehydratePageKeys(pageContent, signer, privateKey)

            for (const pk of mod.newMembers) {
              if (rehydrated.leaves.some(l => l.pubkey === pk)) continue
              try {
                const result = await addMemberToPage(rehydrated, pk, 'everyone', signer, privateKey)
                rehydrated = result.pages[0]
                allNewMembers.push(pk)
              } catch (err) {
                console.error(`Failed to re-add ${pk}:`, err)
              }
            }

            const serialized = serializeLeafPage(rehydrated)
            const pageBytes = new TextEncoder().encode(serialized)
            const { hash } = await uploadToBlossomServers(
              pageBytes, signer, privateKey, hub.blossomServers, 'text/plain',
            )
            updatedPages.push({ pageIndex, content: serialized, firstPubkey: rehydrated.leaves[0].pubkey, hash })
            updatedPageRoots.set(pageIndex, { nodeId: rehydrated.pageRoot.nodeId, rawKey: rehydrated.pageRoot.rawKey! })
          }

          // Rebuild spine with updated page roots
          const allPageRoots = pageRootKeys.map((prk, i) => {
            const updated = updatedPageRoots.get(leafPages[i]?.pageIndex)
            return updated || prk
          })
          const newSpine = await buildSpine(allPageRoots, hubSecret)
          const newSpineContent = serializeSpine(newSpine)
          const spineBytes = new TextEncoder().encode(newSpineContent)
          const { hash: sHash } = await uploadToBlossomServers(
            spineBytes, signer, privateKey, hub.blossomServers, 'text/plain',
          )
          newSpineHash = sHash

          // Update leaf page hashes
          for (const up of updatedPages) {
            const idx = leafPages.findIndex(p => p.pageIndex === up.pageIndex)
            if (idx >= 0) leafPages[idx] = { ...leafPages[idx], firstPubkey: up.firstPubkey, hash: up.hash }
          }

          // Update local member list
          const existingMembers = useHubStore.getState().hubMembers[hub.dTag] || []
          useHubStore.getState().setHubMembers(hub.dTag, [
            ...existingMembers,
            ...allNewMembers.map(pk => ({ pubkey: pk, roles: 'everyone' })),
          ])
        }
      }
      markDone('Re-adding to member tree')

      // Upload new ban pages
      await markStep('Uploading ban pages')
      const banPageHashes = remaining.length > 0
        ? await uploadBanPages(
          remaining.map(pk => ({ pubkey: pk, reason: '' })),
          signer, privateKey, hub.blossomServers,
        )
        : []

      const indexContent = createPaginatedIndexFile(newSpineHash, leafPages, banPageHashes, historyHash || undefined, groupTrees.length > 0 ? groupTrees : undefined)
      const indexBytes = new TextEncoder().encode(indexContent)
      const { hash: newIndexHash } = await uploadToBlossomServers(
        indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )
      markDone('Uploading ban pages')

      // Publish hub event
      await markStep('Publishing hub event')
      const { signWithSigner } = await import('@/lib/nostr/events')
      const { publishToSpecificRelays: pubToRelays } = await import('@/lib/nostr/relay-pool')
      const unsignedEvent = buildHubEvent({
        dTag: hub.dTag,
        name: hub.name,
        description: hub.description || undefined,
        epoch: hub.epoch,
        icon: hub.icon,
        banner: hub.banner,
        tags: hub.tags,
        relays: [...hub.generalRelays, ...hub.filterRelays],
        blossomServers: hub.blossomServers,
        indexFileHash: newIndexHash,
        channels: hub.channels,
        categories: hub.categories,
        roles: hub.roles,
        minPow: hub.minPow || undefined,
        nsfw: hub.nsfw || undefined,
        discoverable: hub.discoverable,
        groupedRoles: hub.groupedRoles,
        publishedAt: hub.publishedAt,

      })
      const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
      await pubToRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signedEvent)
      markDone('Publishing hub event')

      // Cleanup old files (best-effort)
      try {
        const { deleteFromBlossom } = await import('@/lib/blossom/client')
        if (spineHash && spineHash !== newSpineHash) {
          deleteFromBlossom(spineHash, signer, privateKey, hub.blossomServers).catch(() => { })
        }
        if (hub.indexFileHash && hub.indexFileHash !== newIndexHash) {
          deleteFromBlossom(hub.indexFileHash, signer, privateKey, hub.blossomServers).catch(() => { })
        }
      } catch { /* best-effort */ }

      useHubStore.getState().setHubData(hub.dTag, { ...hub, indexFileHash: newIndexHash })
      setSelected(new Set())

      await markStep('Done')
    } catch (err: any) {
      console.error('Unban & re-add failed:', err)
      setUnbanError(err?.message || 'Failed to unban & re-add')
    } finally {
      setUnbanning(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-muted-foreground mb-3">
          {bannedPubkeys.length === 0
            ? 'No users have been banned from this hub.'
            : `${bannedPubkeys.length} banned user${bannedPubkeys.length !== 1 ? 's' : ''}`}
        </p>
      </div>

      {bannedPubkeys.length > 0 && (
        <>
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 border border-border">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search banned users..."
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Select all + unban buttons */}
          <div className="flex items-center justify-between">
            <button
              onClick={selectAll}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              {selected.size === filteredBanned.length && filteredBanned.length > 0 ? 'Deselect All' : 'Select All'}
            </button>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={handleUnban}
                disabled={selected.size === 0 || unbanning}
                className="gap-1.5 h-7 text-xs"
              >
                {unbanning && unbanMode === 'unban' ? (
                  <><Loader2 size={12} className="animate-spin" /> Unbanning...</>
                ) : (
                  <><ShieldCheck size={12} /> Unban</>
                )}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleUnbanAndReadd}
                disabled={selected.size === 0 || unbanning}
                className="gap-1.5 h-7 text-xs"
              >
                {unbanning && unbanMode === 'readd' ? (
                  <><Loader2 size={12} className="animate-spin" /> Re-adding...</>
                ) : (
                  <><UserPlus size={12} /> Unban & Re-add</>
                )}
              </Button>
            </div>
          </div>

          {unbanError && (
            <p className="text-xs text-destructive">{unbanError}</p>
          )}

          {/* Banned user list */}
          <div className="rounded-lg border border-border overflow-hidden max-h-[50vh] overflow-y-auto">
            {filteredBanned.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">No results</div>
            ) : (
              filteredBanned.map((pk) => {
                const profile = getProfile(pk)
                const name = profile?.display_name || profile?.name || truncateNpub(pk, 10)
                const isSelected = selected.has(pk)
                const stillInTree = memberPubkeySet.has(pk)

                return (
                  <label
                    key={pk}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors border-b border-border last:border-b-0',
                      isSelected ? 'bg-primary/5' : 'hover:bg-secondary/50'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(pk)}
                      className="rounded border-border"
                    />
                    <Avatar className="h-7 w-7 shrink-0">
                      {profile?.picture && <AvatarImage src={profile.picture} />}
                      <AvatarFallback className="text-[10px] bg-destructive/10 text-destructive">
                        {name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">{name}</p>
                      <p className="text-[10px] text-muted-foreground font-mono truncate">{truncateNpub(pk, 16)}</p>
                    </div>
                    {stillInTree && (
                      <Tip text="This user is still in the member tree. Remove them from the tree to revoke access.">
                        <div className="flex items-center gap-1 text-amber-400">
                          <AlertTriangle size={12} />
                        </div>
                      </Tip>
                    )}
                  </label>
                )
              })
            )}
          </div>
        </>
      )}

      {/* ── Mod Bans Review ── */}
      {(() => {
        const mods = members.filter(m => {
          if (m.pubkey === hub.creatorPubkey) return false
          const perms = getPermissionsForUser(hub, m.pubkey, members)
          return perms.ban_members === true
        })
        // Collect all unique mod-banned pubkeys
        const allModBanned = new Map<string, string[]>() // bannedPk -> [modPk1, modPk2]
        for (const mod of mods) {
          const bans = modBanLists[mod.pubkey] || []
          for (const pk of bans) {
            if (!allModBanned.has(pk)) allModBanned.set(pk, [])
            allModBanned.get(pk)!.push(mod.pubkey)
          }
        }
        if (mods.length === 0 && allModBanned.size === 0) return null

        return (
          <div className="mt-6 pt-6 border-t border-border">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Users size={14} />
                Mod Bans Review
                {allModBanned.size > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">({allModBanned.size} user{allModBanned.size !== 1 ? 's' : ''})</span>
                )}
              </h3>
              <Tip text="Fetch latest mod ban lists from relays">
                <button
                  onClick={handleRefreshModBans}
                  disabled={refreshingModBans}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-40 px-2 py-1 rounded-md hover:bg-secondary/50"
                >
                  <RefreshCw size={12} className={refreshingModBans ? 'animate-spin' : ''} />
                  {refreshingModBans ? 'Checking...' : 'Refresh'}
                </button>
              </Tip>
            </div>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              Members with the <strong className="text-foreground">soft-ban</strong> permission have flagged the following users.
              You can promote a soft-ban to a hard ban (removes from tree + epoch rotation) or override it to keep the user in the hub.
            </p>

            {allModBanned.size === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">No mod bans to review</p>
            ) : (
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {Array.from(allModBanned.entries()).map(([bannedPk, modPks]) => {
                  const profile = getProfile(bannedPk)
                  const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(bannedPk), 10)
                  const isAlreadyBanned = bannedPubkeys.includes(bannedPk)
                  const isWhitelisted = members.find(m => m.pubkey === bannedPk)?.flags?.includes('w')

                  return (
                    <div key={bannedPk} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-secondary/30 border border-border">
                      <Avatar className="h-8 w-8 shrink-0">
                        {profile?.picture && <AvatarImage src={profile.picture} />}
                        <AvatarFallback className="text-[10px] bg-destructive/20 text-destructive">
                          {name.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          Banned by {modPks.length} mod{modPks.length !== 1 ? 's' : ''}: {modPks.map(mp => {
                            const mp2 = getProfile(mp)
                            return mp2?.display_name || mp2?.name || truncateNpub(nip19.npubEncode(mp), 8)
                          }).join(', ')}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {isWhitelisted && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">Overridden</span>
                        )}
                        {isAlreadyBanned && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive font-medium">Hard Banned</span>
                        )}
                        {!isAlreadyBanned && !isWhitelisted && (
                          <>
                            <Tip text="Override: keep user in hub (whitelist)">
                              <button
                                onClick={async () => {
                                   // Add 'w' flag to member
                                  try {
                                    const { downloadTextFromBlossom, uploadToBlossomServers: uploadFn } = await import('@/lib/blossom/client')
                                    const { parseIndexFile, createPaginatedIndexFile, findPageForPubkey } = await import('@/lib/blossom/members')
                                    const {
                                      deserializeLeafPage, serializeLeafPage,
                                      deserializeSpine, recoverPageRootKeys, buildSpine, serializeSpine,
                                      fromHex,
                                    } = await import('@/lib/crypto/lkh')

                                    if (!hub.indexFileHash) return
                                    const ic = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
                                    const idx = parseIndexFile(ic)
                                    if (!idx.spineHash || idx.leafPages.length === 0) return

                                    const pageEntry = findPageForPubkey(idx, bannedPk)
                                    if (!pageEntry) return

                                    const pageContent = await downloadTextFromBlossom(pageEntry.hash, hub.blossomServers)
                                    const page = deserializeLeafPage(pageContent)
                                    const leaf = page.leaves.find(l => l.pubkey === bannedPk)
                                    if (leaf) {
                                      const existingFlags = leaf.flags || ''
                                      if (!existingFlags.includes('w')) {
                                        leaf.flags = existingFlags ? existingFlags + ',w' : 'w'
                                        const newPageContent = serializeLeafPage(page)
                                        const pageBytes = new TextEncoder().encode(newPageContent)
                                        const { hash: newPageHash } = await uploadFn(
                                          pageBytes, signer, privateKey, hub.blossomServers, 'text/plain',
                                        )

                                        // Rebuild spine + index
                                        const hubSecretHex = useHubStore.getState().hubSecrets[hub.dTag]
                                        if (hubSecretHex) {
                                          const hubSecret = fromHex(hubSecretHex)
                                          const spineContent = await downloadTextFromBlossom(idx.spineHash, hub.blossomServers)
                                          const spine = deserializeSpine(spineContent)
                                          const pageRootKeys = await recoverPageRootKeys(spine, hubSecret)
                                          const newSpine = await buildSpine(pageRootKeys, hubSecret)
                                          const newSpineBytes = new TextEncoder().encode(serializeSpine(newSpine))
                                          const { hash: newSpineHash } = await uploadFn(
                                            newSpineBytes, signer, privateKey, hub.blossomServers, 'text/plain',
                                          )

                                          const updatedPages = idx.leafPages.map(p =>
                                            p.pageIndex === pageEntry.pageIndex
                                              ? { ...p, firstPubkey: page.leaves[0].pubkey, hash: newPageHash }
                                              : p
                                          )
                                          const newIdxContent = createPaginatedIndexFile(
                                            newSpineHash, updatedPages,
                                            idx.banPages.map(bp => bp.hash),
                                            idx.historyHash || undefined,
                                            idx.groupTrees.length > 0 ? idx.groupTrees : undefined,
                                          )
                                          const idxBytes = new TextEncoder().encode(newIdxContent)
                                          const { hash: newIdxHash } = await uploadFn(
                                            idxBytes, signer, privateKey, hub.blossomServers, 'text/plain',
                                          )

                                          // Publish hub event
                                          const { signWithSigner: signFn } = await import('@/lib/nostr/events')
                                          const { publishToSpecificRelays: pubRelays } = await import('@/lib/nostr/relay-pool')
                                          const evt = buildHubEvent({
                                            dTag: hub.dTag, name: hub.name, description: hub.description || undefined,
                                            epoch: hub.epoch, icon: hub.icon, banner: hub.banner, tags: hub.tags,
                                            relays: [...hub.generalRelays, ...hub.filterRelays],
                                            blossomServers: hub.blossomServers, indexFileHash: newIdxHash,
                                            channels: hub.channels, categories: hub.categories, roles: hub.roles,
                                            minPow: hub.minPow || undefined, nsfw: hub.nsfw || undefined,
                                            discoverable: hub.discoverable, groupedRoles: hub.groupedRoles,
                                            publishedAt: hub.publishedAt,
                                    
                                          })
                                          const signed = await signFn(evt, signer, privateKey)
                                          await pubRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signed)
                                          useHubStore.getState().setHubData(hub.dTag, { ...hub, indexFileHash: newIdxHash })
                                        }

                                        // Update local members
                                        const updatedMembers = members.map(m => m.pubkey === bannedPk ? { ...m, flags: leaf.flags } : m)
                                        useHubStore.getState().setHubMembers(hub.dTag, updatedMembers)
                                      }
                                    }
                                  } catch (err) {
                                    console.error('Override failed:', err)
                                  }
                                }}
                                className="p-1.5 rounded-md text-emerald-400 hover:bg-emerald-500/10 transition-colors cursor-pointer"
                              >
                                <ShieldCheck size={14} />
                              </button>
                            </Tip>
                            <Tip text="Promote to Hard Ban">
                              <button
                                onClick={() => {
                                  // Use existing ban flow: add to ban list
                                  const currentBans = bannedPubkeys
                                  if (!currentBans.includes(bannedPk)) {
                                    setHubBanList(hub.dTag, [...currentBans, bannedPk])
                                  }
                                }}
                                className="p-1.5 rounded-md text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
                              >
                                <ShieldBan size={14} />
                              </button>
                            </Tip>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })()}

      {/* Unban progress overlay */}
      {(unbanning || unbanSteps.length > 0) && createPortal(
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.stopPropagation()}>
          <div className="bg-card rounded-xl border border-border shadow-2xl w-[340px] p-5 space-y-4 animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2.5">
              {unbanStep === 'Done' && !unbanError ? (
                <div className="w-8 h-8 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                  <Check size={16} className="text-emerald-400" />
                </div>
              ) : unbanError ? (
                <div className="w-8 h-8 rounded-full bg-destructive/15 flex items-center justify-center shrink-0">
                  <AlertTriangle size={16} className="text-destructive" />
                </div>
              ) : (
                <div className="w-8 h-8 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                  <Loader2 size={16} className="text-emerald-400 animate-spin" />
                </div>
              )}
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  {unbanError ? 'Operation Failed' : unbanStep === 'Done' ? (unbanMode === 'readd' ? 'Users Unbanned & Re-added' : 'Users Unbanned') : (unbanMode === 'readd' ? 'Unbanning & Re-adding...' : 'Unbanning Users...')}
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  {unbanError ? unbanError : unbanStep === 'Done' ? 'All steps completed successfully' : unbanStep || 'Starting...'}
                </p>
              </div>
            </div>

            {/* Step list */}
            <div className="space-y-1.5">
              {(unbanMode === 'readd' ? READD_STEPS : UNBAN_STEPS).map((step) => {
                const isDone = unbanSteps.includes(step)
                const isCurrent = unbanStep === step
                return (
                  <div key={step} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs">
                    {isDone ? (
                      <Check size={12} className="text-emerald-400 shrink-0" />
                    ) : isCurrent ? (
                      <Loader2 size={12} className="text-amber-400 animate-spin shrink-0" />
                    ) : (
                      <div className="w-3 h-3 rounded-full border border-border shrink-0" />
                    )}
                    <span className={cn(
                      'transition-colors',
                      isDone ? 'text-emerald-400' : isCurrent ? 'text-foreground' : 'text-muted-foreground/50'
                    )}>
                      {step}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Done / Error dismiss */}
            {(unbanStep === 'Done' || unbanError) && (
              <button
                onClick={() => { setUnbanSteps([]); setUnbanStep(null); setUnbanError(null) }}
                className={cn(
                  'w-full h-8 text-xs rounded-lg font-medium transition-colors cursor-pointer',
                  unbanError
                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                )}
              >
                {unbanError ? 'Dismiss' : 'Done'}
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

// ── Network Page (Relays + Blossom Servers) ──

function NetworkPage({ hub, editRelays, setEditRelays, editBlossoms, setEditBlossoms }: {
  hub: HubData
  editRelays: string[]
  setEditRelays: (relays: string[]) => void
  editBlossoms: string[]
  setEditBlossoms: (blossoms: string[]) => void
}) {
  const userRelays = useUserListsStore((s) => s.userRelays)
  const userBlossoms = useUserListsStore((s) => s.userBlossoms)
  const [customRelayInput, setCustomRelayInput] = useState('')
  const [customBlossomInput, setCustomBlossomInput] = useState('')
  const [showClientRelays, setShowClientRelays] = useState(false)
  const [showUserRelays, setShowUserRelays] = useState(false)
  const [showClientBlossoms, setShowClientBlossoms] = useState(false)
  const [showUserBlossoms, setShowUserBlossoms] = useState(false)

  // Client relays not already in hub
  const clientRelays = getRelayList().filter(r => r.enabled).map(r => r.url)
  const availableClientRelays = clientRelays.filter(url => !editRelays.includes(url))

  // User NIP-65 relays not already in hub
  const availableUserRelays = userRelays.filter(url => !editRelays.includes(url))

  // Client blossom servers not already in hub
  const clientBlossoms = blossomServerManager.getList().filter(s => s.enabled).map(s => s.url)
  const availableClientBlossoms = clientBlossoms.filter(url => !editBlossoms.includes(url))

  // User blossom servers not already in hub
  const availableUserBlossoms = userBlossoms.filter(url => !editBlossoms.includes(url))

  const addRelay = (url: string) => {
    if (!editRelays.includes(url)) {
      setEditRelays([...editRelays, url])
    }
  }

  const removeRelay = (url: string) => {
    setEditRelays(editRelays.filter(r => r !== url))
  }

  const addCustomRelay = () => {
    const trimmed = customRelayInput.trim()
    if (!trimmed || editRelays.includes(trimmed)) return
    setEditRelays([...editRelays, trimmed])
    setCustomRelayInput('')
  }

  const addBlossom = (url: string) => {
    if (!editBlossoms.includes(url)) {
      setEditBlossoms([...editBlossoms, url])
    }
  }

  const removeBlossom = (url: string) => {
    setEditBlossoms(editBlossoms.filter(b => b !== url))
  }

  const addCustomBlossom = () => {
    const trimmed = customBlossomInput.trim()
    if (!trimmed || editBlossoms.includes(trimmed)) return
    setEditBlossoms([...editBlossoms, trimmed])
    setCustomBlossomInput('')
  }

  return (
    <div className="space-y-6">
      {/* ═══════════════ RELAYS SECTION ═══════════════ */}
      <h3 className="text-base font-bold text-foreground">Relays</h3>

      {/* Info note */}
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-primary/5 border border-primary/20">
        <Info size={14} className="text-primary shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          These relays determine where hub messages are read from and written to. All members will use them to send and receive messages. If you don't know what you're doing, leave things as they are.
        </p>
      </div>

      {/* Current Hub Relays */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Hub Relays</h4>
        <div className="space-y-1.5">
          {editRelays.length === 0 ? (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-500">No relays configured. Members won't be able to send or receive messages.</p>
            </div>
          ) : (
            editRelays.map((url) => (
              <div key={url} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
                <span className="text-sm text-foreground font-mono truncate flex-1">{url}</span>
                <select
                  className="h-6 text-[10px] rounded border border-border bg-background px-1 text-muted-foreground cursor-pointer"
                  disabled
                  value="general"
                >
                  <option value="general">general</option>
                </select>
                <button
                  onClick={() => removeRelay(url)}
                  className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <Separator />

      {/* Add from Client Relays */}
      <section className="space-y-2">
        <button
          onClick={() => setShowClientRelays(!showClientRelays)}
          className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors cursor-pointer"
        >
          <ChevronDown size={14} className={cn('transition-transform', showClientRelays && 'rotate-180')} />
          Add from Client Relays
          {availableClientRelays.length > 0 && (
            <span className="text-xs text-muted-foreground">({availableClientRelays.length})</span>
          )}
        </button>
        {showClientRelays && (
          <div className="space-y-1 pl-1">
            {availableClientRelays.length > 0 ? (
              availableClientRelays.map(url => (
                <div key={url} className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-secondary/20 border border-border/60">
                  <span className="text-xs text-muted-foreground font-mono truncate flex-1">{url}</span>
                  <button
                    onClick={() => addRelay(url)}
                    className="text-xs text-primary hover:text-primary/80 font-medium cursor-pointer flex items-center gap-0.5"
                  >
                    <Plus size={12} /> Add
                  </button>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground/60 italic pl-1">All client relays are already added</p>
            )}
          </div>
        )}
      </section>

      {/* Add from User Relay List (NIP-65) */}
      <section className="space-y-2">
        <button
          onClick={() => setShowUserRelays(!showUserRelays)}
          className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors cursor-pointer"
        >
          <ChevronDown size={14} className={cn('transition-transform', showUserRelays && 'rotate-180')} />
          Add from User Relay List (NIP-65)
          {availableUserRelays.length > 0 && (
            <span className="text-xs text-muted-foreground">({availableUserRelays.length})</span>
          )}
        </button>
        {showUserRelays && (
          <div className="space-y-1 pl-1">
            {availableUserRelays.length > 0 ? (
              availableUserRelays.map(url => (
                <div key={url} className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-secondary/20 border border-border/60">
                  <span className="text-xs text-muted-foreground font-mono truncate flex-1">{url}</span>
                  <button
                    onClick={() => addRelay(url)}
                    className="text-xs text-primary hover:text-primary/80 font-medium cursor-pointer flex items-center gap-0.5"
                  >
                    <Plus size={12} /> Add
                  </button>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground/60 italic pl-1">
                {userRelays.length === 0 ? 'No NIP-65 relay list published' : 'All user relays are already added'}
              </p>
            )}
          </div>
        )}
      </section>

      <Separator />

      {/* Custom Relay */}
      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-foreground">Custom Relay</h4>
        <div className="flex gap-2">
          <input
            value={customRelayInput}
            onChange={(e) => setCustomRelayInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustomRelay()}
            placeholder="wss://relay.example.com"
            className="flex-1 h-9 rounded-lg border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            onClick={addCustomRelay}
            className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <Plus size={14} /> Add
          </button>
        </div>
      </section>

      {/* Warning note */}
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
        <AlertTriangle size={13} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[11px] text-amber-500/90 leading-relaxed">
          Removing relays that other members are using may cause them to miss messages. Only change relays if you know what you're doing.
        </p>
      </div>

      {/* ═══════════════ BLOSSOM SERVERS SECTION ═══════════════ */}
      <Separator className="my-4" />
      <h3 className="text-base font-bold text-foreground">Blossom Servers</h3>

      {/* Info note */}
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-primary/5 border border-primary/20">
        <Info size={14} className="text-primary shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Blossom servers store hub files (member trees, icons, banners). Members download these files to join and participate in the hub.
        </p>
      </div>

      {/* Current Hub Blossom Servers */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Hub Blossom Servers</h4>
        <div className="space-y-1.5">
          {editBlossoms.length === 0 ? (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-500">No blossom servers configured. Hub files won't be accessible.</p>
            </div>
          ) : (
            editBlossoms.map((url) => (
              <div key={url} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
                <span className="text-sm text-foreground font-mono truncate flex-1">{url}</span>
                <button
                  onClick={() => removeBlossom(url)}
                  className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <Separator />

      {/* Add from Client Blossom Servers */}
      <section className="space-y-2">
        <button
          onClick={() => setShowClientBlossoms(!showClientBlossoms)}
          className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors cursor-pointer"
        >
          <ChevronDown size={14} className={cn('transition-transform', showClientBlossoms && 'rotate-180')} />
          Add from Client Blossom Servers
          {availableClientBlossoms.length > 0 && (
            <span className="text-xs text-muted-foreground">({availableClientBlossoms.length})</span>
          )}
        </button>
        {showClientBlossoms && (
          <div className="space-y-1 pl-1">
            {availableClientBlossoms.length > 0 ? (
              availableClientBlossoms.map(url => (
                <div key={url} className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-secondary/20 border border-border/60">
                  <span className="text-xs text-muted-foreground font-mono truncate flex-1">{url}</span>
                  <button
                    onClick={() => addBlossom(url)}
                    className="text-xs text-primary hover:text-primary/80 font-medium cursor-pointer flex items-center gap-0.5"
                  >
                    <Plus size={12} /> Add
                  </button>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground/60 italic pl-1">All client blossom servers are already added</p>
            )}
          </div>
        )}
      </section>

      {/* Add from User Blossom Server List */}
      <section className="space-y-2">
        <button
          onClick={() => setShowUserBlossoms(!showUserBlossoms)}
          className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors cursor-pointer"
        >
          <ChevronDown size={14} className={cn('transition-transform', showUserBlossoms && 'rotate-180')} />
          Add from User Blossom List
          {availableUserBlossoms.length > 0 && (
            <span className="text-xs text-muted-foreground">({availableUserBlossoms.length})</span>
          )}
        </button>
        {showUserBlossoms && (
          <div className="space-y-1 pl-1">
            {availableUserBlossoms.length > 0 ? (
              availableUserBlossoms.map(url => (
                <div key={url} className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-secondary/20 border border-border/60">
                  <span className="text-xs text-muted-foreground font-mono truncate flex-1">{url}</span>
                  <button
                    onClick={() => addBlossom(url)}
                    className="text-xs text-primary hover:text-primary/80 font-medium cursor-pointer flex items-center gap-0.5"
                  >
                    <Plus size={12} /> Add
                  </button>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground/60 italic pl-1">
                {userBlossoms.length === 0 ? 'No user blossom server list published' : 'All user blossom servers are already added'}
              </p>
            )}
          </div>
        )}
      </section>

      <Separator />

      {/* Custom Blossom Server */}
      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-foreground">Custom Blossom Server</h4>
        <div className="flex gap-2">
          <input
            value={customBlossomInput}
            onChange={(e) => setCustomBlossomInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustomBlossom()}
            placeholder="https://blossom.example.com"
            className="flex-1 h-9 rounded-lg border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            onClick={addCustomBlossom}
            className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <Plus size={14} /> Add
          </button>
        </div>
      </section>

      {/* Warning note */}
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
        <AlertTriangle size={13} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[11px] text-amber-500/90 leading-relaxed">
          Removing blossom servers may prevent members from downloading hub files needed to join or participate. Only change these if you know what you're doing.
        </p>
      </div>
    </div>
  )
}

// ── Reports Page ──

const REPORT_TYPE_COLORS: Record<string, string> = {
  Spam: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  NSFW: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
  Scam: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  Illegal: 'bg-red-500/15 text-red-400 border-red-500/30',
  Malware: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  Harassment: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  Other: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
}

// ── Hidden Messages Page ──

const HIDDEN_PER_PAGE = 10

const KIND_BADGES: Record<number, { label: string; className: string }> = {
  36943: { label: 'Message', className: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  1067: { label: 'Poll', className: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
  31923: { label: 'Calendar', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
}

function HiddenMessagesPage({ hub, onClose }: { hub: HubData; onClose: () => void }) {
  const [tab, setTab] = useState<'creator' | 'moderators'>('creator')
  const [entries, setEntries] = useState<HideEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [unhidingRef, setUnhidingRef] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const { getProfile } = useProfileCache()
  const hubMembers = useHubStore((s) => s.hubMembers[hub.dTag]) || []
  const pubkey = useUserStore((s) => s.pubkey)

  // Build authorized moderator pubkeys (all members with hide_messages perm, excluding creator)
  const modPubkeys = useMemo(() => {
    const mods: string[] = []
    for (const m of hubMembers) {
      if (m.pubkey === hub.creatorPubkey) continue
      const perms = getPermissionsForUser(hub, m.pubkey, hubMembers)
      if (perms.hide_messages) mods.push(m.pubkey)
    }
    return mods
  }, [hub, hubMembers])

  const fetchHideEvents = useCallback(async () => {
    setLoading(true)
    try {
      const { fetchEvents } = await import('@/lib/nostr/relay-pool')
      const { parseHideEvent } = await import('@/hooks/useHideMessages')

      const allAuthors = [hub.creatorPubkey, ...modPubkeys]
      if (allAuthors.length === 0) { setLoading(false); return }

      const events = await fetchEvents({
        kinds: [KINDS.HIDE_MESSAGE],
        authors: allAuthors,
        '#h': [hub.dTag],
      } as any)

      const parsed: HideEntry[] = []
      for (const ev of events) {
        const entry = parseHideEvent(ev)
        if (!entry) continue
        if (!allAuthors.includes(entry.hiderPubkey)) continue
        parsed.push(entry)
      }

      // Sort newest first
      parsed.sort((a, b) => b.createdAt - a.createdAt)
      setEntries(parsed)
    } catch (err) {
      console.error('[HiddenMessagesPage] Failed to fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [hub, modPubkeys])

  // Fetch on mount
  useEffect(() => { fetchHideEvents() }, [fetchHideEvents])

  // Reset page when tab changes
  useEffect(() => { setPage(1) }, [tab])

  // Filter by tab
  const filtered = useMemo(() => {
    if (tab === 'creator') return entries.filter(e => e.hiderPubkey === hub.creatorPubkey)
    return entries.filter(e => e.hiderPubkey !== hub.creatorPubkey)
  }, [entries, tab, hub.creatorPubkey])

  const totalPages = Math.max(1, Math.ceil(filtered.length / HIDDEN_PER_PAGE))
  const safePage = Math.min(page, totalPages)
  const pageEntries = filtered.slice((safePage - 1) * HIDDEN_PER_PAGE, safePage * HIDDEN_PER_PAGE)

  // Unhide handler (creator can unhide anything — but for mod-hidden items, the creator
  // publishes a new hide event with deleted=true using their own key, which overrides the mod's hide)
  const handleUnhide = useCallback(async (entry: HideEntry) => {
    setUnhidingRef(entry.ref)
    try {
      const { createDeletedHideEvent, createDeletionEvent } = await import('@/lib/nostr/events')
      const { signWithSigner: signFn } = await import('@/lib/nostr')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
      const { signer, privateKey } = useUserStore.getState()
      const relays = [...hub.filterRelays, ...hub.generalRelays]
      const publishRelays = getPublishRelays(relays)

      // Phase 1: Re-publish with deleted tag
      const deletedHide = createDeletedHideEvent(hub.dTag, entry.ref, entry.createdAt)
      const signedDeleted = await signFn(deletedHide, signer, privateKey)
      await publishToSpecificRelays(publishRelays, signedDeleted)

      // Phase 2: NIP-09 deletion request
      const dTag = `${hub.dTag}:${entry.ref}`
      const aRef = `${KINDS.HIDE_MESSAGE}:${pubkey}:${dTag}`
      const deletionReq = createDeletionEvent([], [aRef], 'unhide')
      const signedDeletion = await signFn(deletionReq, signer, privateKey)
      await publishToSpecificRelays(publishRelays, signedDeletion)

      // Optimistic update
      useHubStore.getState().removeHiddenMessage(hub.dTag, entry.ref)
      setEntries(prev => prev.filter(e => e.ref !== entry.ref))
    } catch (err) {
      console.error('[HiddenMessagesPage] Unhide failed:', err)
    } finally {
      setUnhidingRef(null)
    }
  }, [hub, pubkey])

  const formatTimeAgo = (ts: number) => {
    const diff = Math.floor(Date.now() / 1000) - ts
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`
    return new Date(ts * 1000).toLocaleDateString()
  }

  // Jump to message in channel view
  const handleJumpToMessage = useCallback((entry: HideEntry) => {
    // For addressable events (kind:pubkey:dTag format)
    const parts = entry.ref.split(':')
    if (parts.length >= 3) {
      const msgPubkey = parts[1]
      const msgDTag = parts.slice(2).join(':')
      // Find which channel the message is in
      const hubMessages = useMessageStore.getState().messages[hub.dTag] || {}
      for (const channelId of Object.keys(hubMessages)) {
        const msg = hubMessages[channelId].find((m: any) => m.dTag === msgDTag && m.pubkey === msgPubkey)
        if (msg) {
          useHubStore.getState().setActiveChannel(channelId)
          break
        }
      }
    }
    onClose()
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('pin-jump-to-message', {
        detail: { aRef: entry.ref }
      }))
    }, 150)
  }, [hub.dTag, onClose])

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 bg-secondary/50 rounded-lg p-1">
          <button
            onClick={() => setTab('creator')}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
              tab === 'creator' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Hidden by Creator
          </button>
          <button
            onClick={() => setTab('moderators')}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
              tab === 'moderators' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Hidden by Moderators
          </button>
        </div>
        <div className="flex-1" />
        <button
          onClick={fetchHideEvents}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Content */}
      {loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <EyeOff size={32} className="mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {tab === 'creator' ? 'No messages hidden by the creator.' : 'No messages hidden by moderators.'}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-1">
            {pageEntries.map((entry) => {
              const targetProfile = getProfile(entry.targetPubkey)
              const targetName = targetProfile?.display_name || targetProfile?.name || (entry.targetPubkey ? truncateNpub(nip19.npubEncode(entry.targetPubkey)) : 'Unknown')
              const badge = KIND_BADGES[entry.kind] || { label: `Kind ${entry.kind}`, className: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' }

              // For moderators tab, show who hid it
              const hiderProfile = tab === 'moderators' ? getProfile(entry.hiderPubkey) : null
              const hiderName = hiderProfile ? (hiderProfile.display_name || hiderProfile.name || truncateNpub(nip19.npubEncode(entry.hiderPubkey))) : null

              return (
                <div
                  key={entry.ref}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-card hover:bg-accent/10 transition-colors"
                >
                  {/* Kind badge */}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium shrink-0 ${badge.className}`}>
                    {badge.label}
                  </span>

                  {/* Target author */}
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Avatar className="h-6 w-6 shrink-0">
                      {targetProfile?.picture && <AvatarImage src={targetProfile.picture} />}
                      <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
                        {targetName.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <span className="text-sm text-foreground truncate block">{targetName}</span>
                      {tab === 'moderators' && hiderName && (
                        <span className="text-[10px] text-amber-400 block">hidden by {hiderName}</span>
                      )}
                    </div>
                  </div>

                  {/* Ref preview (truncated) */}
                  <span className="text-[10px] text-muted-foreground/50 font-mono truncate max-w-[120px] shrink-0 hidden sm:block">
                    {entry.ref.length > 20 ? entry.ref.slice(0, 10) + '…' + entry.ref.slice(-8) : entry.ref}
                  </span>

                  {/* Timestamp */}
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {formatTimeAgo(entry.createdAt)}
                  </span>

                  {/* Unhide button — creator can unhide anything */}
                  <button
                    onClick={() => handleUnhide(entry)}
                    disabled={unhidingRef === entry.ref}
                    className="text-[11px] px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-pointer font-medium shrink-0 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                  >
                    {unhidingRef === entry.ref && <Loader2 size={10} className="animate-spin" />}
                    {unhidingRef === entry.ref ? 'Unhiding…' : 'Unhide'}
                  </button>

                  {/* Jump to message */}
                  <button
                    onClick={() => handleJumpToMessage(entry)}
                    className="text-[11px] px-2 py-1 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer font-medium shrink-0"
                  >
                    Go to
                  </button>
                </div>
              )
            })}
          </div>

          {/* Pagination */}
          <Pagination currentPage={safePage} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </div>
  )
}

function ReportsPage({ hub, onClose }: { hub: HubData; onClose: () => void }) {
  const secret = useHubStore((s) => s.hubSecrets[hub.dTag])
  const fetchHubReports = useReportStore((s) => s.fetchHubReports)
  const reports = useReportStore((s) => s.reportsByHub[hub.dTag])
  const loading = useReportStore((s) => s.loadingHub[hub.dTag])
  const { getProfile } = useProfileCache()

  const reportsList = reports ?? EMPTY_REPORTS
  const isLoading = loading ?? false

  // Filters — simple time range dropdown
  type TimeRange = '24h' | '48h' | 'week'
  const TIME_RANGE_LABELS: Record<TimeRange, string> = { '24h': 'Last 24 hours', '48h': 'Last 48 hours', 'week': 'Last week' }
  const TIME_RANGE_SECONDS: Record<TimeRange, number> = { '24h': 24 * 3600, '48h': 48 * 3600, 'week': 7 * 24 * 3600 }
  const [timeRange, setTimeRange] = useState<TimeRange>('48h')
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'retracted'>('open')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [searchReporter, setSearchReporter] = useState('')
  const [searchViolator, setSearchViolator] = useState('')

  // Custom dropdown state
  const [timeRangeOpen, setTimeRangeOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [typeOpen, setTypeOpen] = useState(false)
  const timeRangeRef = useRef<HTMLDivElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const typeRef = useRef<HTMLDivElement>(null)

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (timeRangeRef.current && !timeRangeRef.current.contains(e.target as Node)) setTimeRangeOpen(false)
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) setStatusOpen(false)
      if (typeRef.current && !typeRef.current.contains(e.target as Node)) setTypeOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Convert time range to unix timestamps
  const since = useMemo(() => {
    return Math.floor(Date.now() / 1000) - TIME_RANGE_SECONDS[timeRange]
  }, [timeRange])

  const until = useMemo(() => {
    return Math.floor(Date.now() / 1000)
  }, [timeRange])

  // Derive available report types from fetched data (supports custom types)
  const availableTypes = useMemo(() => {
    const known = ['spam', 'nudity', 'profanity', 'illegal', 'malware', 'impersonation', 'other']
    const fromData = reportsList.map((r) => r.reportType).filter(Boolean)
    const all = [...new Set([...known, ...fromData])]
    return all.sort()
  }, [reportsList])

  // Fetch on mount and filter change
  useEffect(() => {
    if (!secret) return
    const relays = [...new Set([...hub.filterRelays, ...hub.generalRelays])].filter(Boolean)
    fetchHubReports(hub.dTag, hub.creatorPubkey, secret, relays, {
      since,
      until,
      status: statusFilter,
    })
  }, [since, until, statusFilter, secret, hub.dTag])

  // Client-side search filter
  const filtered = useMemo(() => {
    let result = [...reportsList]

    // Type filter
    if (typeFilter !== 'all') {
      result = result.filter((r) => r.reportType === typeFilter)
    }

    if (searchReporter.trim()) {
      const q = searchReporter.toLowerCase()
      result = result.filter((r) => {
        const p = getProfile(r.reporterPubkey)
        const name = (p?.display_name || p?.name || '').toLowerCase()
        const npub = nip19.npubEncode(r.reporterPubkey).toLowerCase()
        return name.includes(q) || npub.includes(q) || r.reporterPubkey.includes(q)
      })
    }

    if (searchViolator.trim()) {
      const q = searchViolator.toLowerCase()
      result = result.filter((r) => {
        const p = getProfile(r.reportedPubkey)
        const name = (p?.display_name || p?.name || '').toLowerCase()
        const npub = nip19.npubEncode(r.reportedPubkey).toLowerCase()
        return name.includes(q) || npub.includes(q) || r.reportedPubkey.includes(q)
      })
    }

    result.sort((a, b) => b.createdAt - a.createdAt)
    return result
  }, [reportsList, searchReporter, searchViolator, getProfile])

  if (!secret) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Lock size={24} className="mb-2" />
        <p className="text-sm">Hub secret required to view reports</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ── Filter controls row ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Time range dropdown */}
        <div ref={timeRangeRef} className="relative">
          <button
            onClick={() => { setTimeRangeOpen(!timeRangeOpen); setStatusOpen(false); setTypeOpen(false) }}
            className={cn(
              'flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm font-medium border transition-all cursor-pointer',
              'bg-primary/10 text-primary border-primary/20'
            )}
          >
            {TIME_RANGE_LABELS[timeRange]}
            <ChevronDown size={12} className={cn('transition-transform', timeRangeOpen && 'rotate-180')} />
          </button>
          {timeRangeOpen && (
            <div className="absolute z-[60] mt-1 left-0 min-w-[160px] bg-card border border-border rounded-xl shadow-2xl p-1 flex flex-col gap-1 animate-in fade-in-0 zoom-in-95">
              {(['24h', '48h', 'week'] as TimeRange[]).map((val) => (
                <button
                  key={val}
                  onClick={() => { setTimeRange(val); setTimeRangeOpen(false) }}
                  className={cn(
                    'w-full text-left px-3 py-1.5 text-sm transition-colors cursor-pointer rounded-md',
                    timeRange === val
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-foreground hover:bg-accent/50'
                  )}
                >
                  {TIME_RANGE_LABELS[val]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Status dropdown */}
        <div ref={statusRef} className="relative">
          <button
            onClick={() => { setStatusOpen(!statusOpen); setTimeRangeOpen(false); setTypeOpen(false) }}
            className={cn(
              'flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm font-medium border transition-all cursor-pointer',
              statusFilter !== 'all'
                ? 'bg-primary/10 text-primary border-primary/20'
                : 'bg-secondary/50 text-muted-foreground border-border hover:text-foreground hover:border-primary/20'
            )}
          >
            {statusFilter === 'all' ? 'All Status' : statusFilter === 'open' ? 'Open' : 'Retracted'}
            <ChevronDown size={12} className={cn('transition-transform', statusOpen && 'rotate-180')} />
          </button>
          {statusOpen && (
            <div className="absolute z-[60] mt-1 left-0 min-w-[140px] bg-card border border-border rounded-xl shadow-2xl p-1 flex flex-col gap-1 animate-in fade-in-0 zoom-in-95">
              {([['all', 'All Status'], ['open', 'Open'], ['retracted', 'Retracted']] as const).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => { setStatusFilter(val); setStatusOpen(false) }}
                  className={cn(
                    'w-full text-left px-3 py-1.5 text-sm transition-colors cursor-pointer rounded-md',
                    statusFilter === val
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-foreground hover:bg-accent/50'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Type dropdown */}
        <div ref={typeRef} className="relative">
          <button
            onClick={() => { setTypeOpen(!typeOpen); setTimeRangeOpen(false); setStatusOpen(false) }}
            className={cn(
              'flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm font-medium border transition-all cursor-pointer',
              typeFilter !== 'all'
                ? 'bg-primary/10 text-primary border-primary/20'
                : 'bg-secondary/50 text-muted-foreground border-border hover:text-foreground hover:border-primary/20'
            )}
          >
            {typeFilter === 'all' ? 'All Types' : typeFilter.charAt(0).toUpperCase() + typeFilter.slice(1)}
            <ChevronDown size={12} className={cn('transition-transform', typeOpen && 'rotate-180')} />
          </button>
          {typeOpen && (
            <div className="absolute z-[60] mt-1 left-0 min-w-[160px] max-h-[200px] overflow-y-auto bg-card border border-border rounded-xl shadow-2xl p-1 flex flex-col gap-1 animate-in fade-in-0 zoom-in-95">
              <button
                onClick={() => { setTypeFilter('all'); setTypeOpen(false) }}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-sm transition-colors cursor-pointer rounded-md',
                  typeFilter === 'all'
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-foreground hover:bg-accent/50'
                )}
              >
                All Types
              </button>
              {availableTypes.map((t) => (
                <button
                  key={t}
                  onClick={() => { setTypeFilter(t); setTypeOpen(false) }}
                  className={cn(
                    'w-full text-left px-3 py-1.5 text-sm transition-colors cursor-pointer rounded-md',
                    typeFilter === t
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-foreground hover:bg-accent/50'
                  )}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Search filters ── */}
      <div className="flex flex-wrap gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-secondary/30 border border-border hover:border-primary/20 transition-colors">
            <Search size={13} className="text-muted-foreground/50 shrink-0" />
            <input
              type="text"
              placeholder="Reporter (name or npub)"
              value={searchReporter}
              onChange={(e) => setSearchReporter(e.target.value)}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
            />
          </div>
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-secondary/30 border border-border hover:border-primary/20 transition-colors">
            <Search size={13} className="text-muted-foreground/50 shrink-0" />
            <input
              type="text"
              placeholder="Violator (name or npub)"
              value={searchViolator}
              onChange={(e) => setSearchViolator(e.target.value)}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
            />
          </div>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={18} className="animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Results */}
      {!isLoading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Flag size={24} className="mb-2 opacity-40" />
          <p className="text-sm">No reports found</p>
          <p className="text-xs mt-1">Try adjusting the date range or filters</p>
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((report) => (
            <ReportCard key={report.dTag} report={report} getProfile={getProfile} hub={hub} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  )
}

function ReportCard({ report, getProfile, hub, onClose }: { report: HubReport; getProfile: (pk: string) => any; hub: HubData; onClose: () => void }) {
  const reporterProfile = getProfile(report.reporterPubkey)
  const violatorProfile = getProfile(report.reportedPubkey)
  const reporterName = reporterProfile?.display_name || reporterProfile?.name || truncateNpub(nip19.npubEncode(report.reporterPubkey))
  const violatorName = violatorProfile?.display_name || violatorProfile?.name || truncateNpub(nip19.npubEncode(report.reportedPubkey))
  const typeColor = REPORT_TYPE_COLORS[report.reportType] || REPORT_TYPE_COLORS.other
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null)
  const [decryptedContent, setDecryptedContent] = useState<string | null>(null)

  // Look up and decrypt the reported message content
  useEffect(() => {
    if (!report.reportedMessageATag) return
    const parts = report.reportedMessageATag.split(':')
    if (parts.length < 3) return
    const msgPubkey = parts[1]
    const msgDTag = parts.slice(2).join(':')
    const hubMessages = useMessageStore.getState().messages[hub.dTag] || {}
    let foundMsg: any = null
    let foundChannel: string | null = null
    for (const channelId of Object.keys(hubMessages)) {
      const msg = hubMessages[channelId].find(m => m.dTag === msgDTag && m.pubkey === msgPubkey)
      if (msg) { foundMsg = msg; foundChannel = channelId; break }
    }
    if (!foundMsg || !foundChannel) return

    // Decrypt the content using the correct epoch's secret + channel key
    const store = useHubStore.getState()
    const msgEpoch = foundMsg.epoch || 1
    const currentEpoch = hub.epoch || 1
    let secretHex: string | undefined
    if (msgEpoch === currentEpoch) {
      secretHex = store.hubSecrets[hub.dTag]
    } else {
      secretHex = store.epochSecrets[hub.dTag]?.[msgEpoch]
      if (!secretHex) secretHex = store.hubSecrets[hub.dTag] // fallback
    }
    if (!secretHex || !foundMsg.content) {
      setDecryptedContent(foundMsg.content || null)
      return
    }
    const secret = new Uint8Array(secretHex.length / 2)
    for (let i = 0; i < secretHex.length; i += 2) {
      secret[i / 2] = parseInt(secretHex.substring(i, i + 2), 16)
    }
    const channelKey = deriveChannelKey(secret, foundChannel, msgEpoch)
    aesDecrypt(channelKey, foundMsg.content)
      .then(plaintext => {
        // Try parsing JSON message format {text, ...}
        try {
          const parsed = JSON.parse(plaintext)
          if (parsed && typeof parsed.text === 'string') {
            setDecryptedContent(parsed.text)
            return
          }
        } catch { }
        setDecryptedContent(plaintext)
      })
      .catch(() => setDecryptedContent('[Could not decrypt]'))
  }, [report.reportedMessageATag, hub.dTag, hub.epoch])

  const handleJumpToMessage = useCallback(() => {
    if (!report.reportedMessageATag) return
    const parts = report.reportedMessageATag.split(':')
    if (parts.length < 3) return
    const msgPubkey = parts[1]
    const msgDTag = parts.slice(2).join(':')
    // Find which channel the message is in
    const hubMessages = useMessageStore.getState().messages[hub.dTag] || {}
    let targetChannelId: string | null = null
    for (const channelId of Object.keys(hubMessages)) {
      const msg = hubMessages[channelId].find(m => m.dTag === msgDTag && m.pubkey === msgPubkey)
      if (msg) {
        targetChannelId = channelId
        break
      }
    }
    // Navigate to the channel and dispatch jump event
    if (targetChannelId) {
      useHubStore.getState().setActiveChannel(targetChannelId)
    }
    onClose()
    // Give the channel view time to mount/render before dispatching the jump
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('pin-jump-to-message', {
        detail: { aRef: report.reportedMessageATag }
      }))
    }, 150)
  }, [report.reportedMessageATag, hub.dTag, onClose])

  return (
    <div className={`p-3 rounded-lg border transition-colors ${report.status === 'retracted' ? 'bg-secondary/20 border-border/50 opacity-60' : 'bg-secondary/30 border-border'}`}>
      {/* Header: reporter → violator */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => setProfilePubkey(report.reporterPubkey)}
          className="flex items-center gap-1.5 min-w-0 hover:opacity-80 transition-opacity cursor-pointer"
        >
          <Avatar className="h-5 w-5">
            {reporterProfile?.picture && <AvatarImage src={reporterProfile.picture} />}
            <AvatarFallback className="text-[8px]">{reporterName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="text-sm font-medium text-foreground truncate max-w-[120px] hover:underline">{reporterName}</span>
        </button>
        <span className="text-xs text-muted-foreground">→</span>
        <button
          onClick={() => setProfilePubkey(report.reportedPubkey)}
          className="flex items-center gap-1.5 min-w-0 hover:opacity-80 transition-opacity cursor-pointer"
        >
          <Avatar className="h-5 w-5">
            {violatorProfile?.picture && <AvatarImage src={violatorProfile.picture} />}
            <AvatarFallback className="text-[8px] bg-red-500/20 text-red-400">{violatorName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="text-sm font-medium text-foreground truncate max-w-[120px] hover:underline">{violatorName}</span>
        </button>
        <div className="flex-1" />
        {/* Badges */}
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${typeColor}`}>
          {report.reportType}
        </span>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${report.status === 'open'
          ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
          : 'bg-zinc-500/15 text-zinc-500 border-zinc-500/30 line-through'
          }`}>
          {report.status}
        </span>
      </div>
      {/* Reason text */}
      {report.reasonText && (
        <p className="text-sm text-foreground/80 mb-1.5 leading-relaxed">{report.reasonText}</p>
      )}
      {/* Reported message preview + jump */}
      {report.reportedMessageATag && (
        <button
          onClick={handleJumpToMessage}
          className="w-full text-left mt-1 px-2.5 py-1.5 rounded-md bg-secondary/40 border border-border/50 hover:border-primary/30 hover:bg-secondary/60 transition-all cursor-pointer group"
        >
          {decryptedContent ? (
            <p className="text-sm text-foreground/70 group-hover:text-foreground/90 transition-colors line-clamp-2 break-words">
              {decryptedContent}
            </p>
          ) : (
            <p className="text-[10px] text-muted-foreground font-mono truncate group-hover:text-foreground/70 transition-colors">
              {report.reportedMessageATag}
            </p>
          )}
          <p className="text-[9px] text-primary/60 group-hover:text-primary mt-0.5 transition-colors">Click to jump to message →</p>
        </button>
      )}
      {/* Timestamp */}
      <p className="text-[10px] text-muted-foreground mt-1.5">
        {new Date(report.createdAt * 1000).toLocaleString()}
      </p>
      {/* Profile modal */}
      {profilePubkey && createPortal(
        <UserProfileModal
          open={!!profilePubkey}
          onClose={() => setProfilePubkey(null)}
          targetPubkey={profilePubkey}
        />,
        document.body
      )}
    </div>
  )
}

// ── Members Page (creator-only) ──

function MembersPage({ hub, onFooterState }: { hub: HubData; onFooterState: (state: any) => void }) {
  const hubMembers = useHubStore((s) => s.hubMembers[hub.dTag]) || []
  const setHubMembers = useHubStore((s) => s.setHubMembers)
  const setHubData = useHubStore((s) => s.setHubData)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const { getProfile } = useProfileCache()

  const [search, setSearch] = useState('')
  const [expandedPubkey, setExpandedPubkey] = useState<string | null>(null)
  const [stagedChanges, setStagedChanges] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveStep, setSaveStep] = useState<string | null>(null)
  const [saveStepsCompleted, setSaveStepsCompleted] = useState<string[]>([])

  const isDirty = Object.keys(stagedChanges).length > 0
  const modifiedCount = Object.keys(stagedChanges).length

  // Report footer state to parent
  const handleSaveRef = useRef<() => void>(() => { })
  const handleDiscardRef = useRef<() => void>(() => { })
  handleDiscardRef.current = () => { setStagedChanges({}); setSaveError(null) }

  useEffect(() => {
    onFooterState({
      isDirty,
      saving,
      error: saveError,
      success: saveSuccess,
      modifiedCount,
      onSave: () => handleSaveRef.current(),
      onDiscard: () => handleDiscardRef.current(),
      saveStep,
      saveStepsCompleted,
    })
  }, [isDirty, saving, saveError, saveSuccess, modifiedCount, saveStep, saveStepsCompleted, onFooterState])

  const filteredMembers = useMemo(() => {
    const list = hubMembers.filter(m => m.pubkey !== hub.creatorPubkey)
    if (!search.trim()) return list
    const q = search.toLowerCase().trim()
    return list.filter(m => {
      const profile = getProfile(m.pubkey)
      const name = (profile?.display_name || profile?.name || '').toLowerCase()
      const npub = nip19.npubEncode(m.pubkey).toLowerCase()
      return name.includes(q) || npub.includes(q)
    })
  }, [hubMembers, hub.creatorPubkey, search, getProfile])

  const getRolesForMember = (m: HubMember): string => {
    return stagedChanges[m.pubkey] ?? m.roles ?? 'everyone'
  }

  const toggleRole = (memberPubkey: string, roleId: string, roleName: string) => {
    if (roleName === 'everyone') return
    const currentMember = hubMembers.find(m => m.pubkey === memberPubkey)
    if (!currentMember) return
    const currentRoles = getRolesForMember(currentMember)
    const roleIds = currentRoles.split('|').map(s => s.trim()).filter(Boolean)
    const hasRole = roleIds.includes(roleId)
    let newRoles: string[]
    if (hasRole) {
      newRoles = roleIds.filter(r => r !== roleId)
      if (newRoles.length === 0) newRoles = ['everyone']
    } else {
      newRoles = [...roleIds.filter(r => r !== 'everyone'), roleId]
    }
    const newRoleStr = newRoles.join('|') || 'everyone'
    const originalRoles = currentMember.roles || 'everyone'
    // Compare as sorted sets so order doesn't matter (e.g. "r1|r2" === "r2|r1")
    const sortedNew = newRoles.slice().sort().join('|')
    const sortedOriginal = originalRoles.split('|').map(s => s.trim()).sort().join('|')
    if (sortedNew === sortedOriginal) {
      setStagedChanges(prev => { const next = { ...prev }; delete next[memberPubkey]; return next })
    } else {
      setStagedChanges(prev => ({ ...prev, [memberPubkey]: newRoleStr }))
    }
  }

  const handleSave = async () => {
    if (!isDirty || saving) return
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    setSaveStepsCompleted([])

    const markStep = async (step: string) => {
      setSaveStep(step)
      await new Promise(r => setTimeout(r, 0))
    }
    const markStepDone = (step: string) => setSaveStepsCompleted(prev => [...prev, step])

    try {
      await markStep('Fetching member tree')
      const { downloadTextFromBlossom, uploadToBlossomServers } = await import('@/lib/blossom/client')
      const { parseIndexFile, updateMemberRolesInPage, createPaginatedIndexFile } = await import('@/lib/blossom/members')
      const {
        deserializeLeafPage, serializeLeafPage,
        deserializeSpine, recoverPageRootKeys, buildSpine, serializeSpine,
        fromHex,
      } = await import('@/lib/crypto/lkh')

      if (!hub.indexFileHash) throw new Error('No index file hash')
      const indexContent = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
      const index = parseIndexFile(indexContent)
      if (!index.spineHash || index.leafPages.length === 0) throw new Error('No paginated tree in index')

      const spineContent = await downloadTextFromBlossom(index.spineHash, hub.blossomServers)
      const spine = deserializeSpine(spineContent)
      const hubSecretHex = useHubStore.getState().hubSecrets[hub.dTag]
      if (!hubSecretHex) throw new Error('No hub secret')
      const hubSecret = fromHex(hubSecretHex)
      const pageRootKeys = await recoverPageRootKeys(spine, hubSecret)
      markStepDone('Fetching member tree')

      await markStep('Updating member roles')
      // Build a map of which page each changed member is on
      const updatedPages = new Map<number, { content: string; firstPubkey: string }>()

      for (let pi = 0; pi < index.leafPages.length; pi++) {
        const pageRef = index.leafPages[pi]
        // Check if any staged changes affect this page
        const pageContent = await downloadTextFromBlossom(pageRef.hash, hub.blossomServers)
        const page = deserializeLeafPage(pageContent)

        let pageChanged = false
        for (const leaf of page.leaves) {
          if (stagedChanges[leaf.pubkey]) {
            leaf.roles = stagedChanges[leaf.pubkey]
            pageChanged = true
          }
        }

        if (pageChanged) {
          updatedPages.set(pageRef.pageIndex, {
            content: serializeLeafPage(page),
            firstPubkey: page.leaves[0].pubkey,
          })
        }
      }
      markStepDone('Updating member roles')

      await markStep('Uploading member tree')
      const newLeafPages = [...index.leafPages]

      // Upload modified pages
      for (const [pageIndex, pageData] of updatedPages) {
        const pageBytes = new TextEncoder().encode(pageData.content)
        const { hash } = await uploadToBlossomServers(
          pageBytes, signer, privateKey, hub.blossomServers, 'text/plain',
        )
        const idx = newLeafPages.findIndex(p => p.pageIndex === pageIndex)
        if (idx >= 0) newLeafPages[idx] = { ...newLeafPages[idx], firstPubkey: pageData.firstPubkey, hash }
      }

      // Rebuild spine with same keys (role changes don't affect tree keys)
      const newSpine = await buildSpine(pageRootKeys, hubSecret)
      const newSpineContent = serializeSpine(newSpine)
      const spineBytes = new TextEncoder().encode(newSpineContent)
      const { hash: newSpineHash } = await uploadToBlossomServers(
        spineBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )

      // Create new index
      const groupedRoles = hub.groupedRoles || []
      const banPageHashes = index.banPages.map(bp => bp.hash)
      const groupTrees = index.groupTrees.length > 0 ? index.groupTrees : undefined
      const skipPublish = groupedRoles.length > 0
      const newIndexContent = createPaginatedIndexFile(
        newSpineHash, newLeafPages, banPageHashes,
        index.historyHash || undefined, groupTrees,
      )
      const indexBytes = new TextEncoder().encode(newIndexContent)
      const { hash: newIndexHash } = await uploadToBlossomServers(
        indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )
      const result = { newIndexHash }

      // Publish hub event if no group trees to rotate
      if (!skipPublish) {
        const unsignedEvent = buildHubEvent({
          dTag: hub.dTag,
          name: hub.name,
          description: hub.description || undefined,
          epoch: hub.epoch,
          icon: hub.icon || undefined,
          banner: hub.banner || undefined,
          tags: hub.tags,
          relays: [...hub.generalRelays, ...hub.filterRelays],
          blossomServers: hub.blossomServers,
          indexFileHash: newIndexHash,
          channels: hub.channels,
          categories: hub.categories,
          roles: hub.roles,
          minPow: hub.minPow || undefined,
          nsfw: hub.nsfw || undefined,
          discoverable: hub.discoverable,
          groupedRoles: hub.groupedRoles,
          publishedAt: hub.publishedAt,
  
        })
        const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
        await publishToSpecificRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signedEvent)
      }
      markStepDone('Uploading member tree')

      // ── Auto-rotate group trees for affected groups ──
      let finalIndexHash = result.newIndexHash
      let updatedGroupedRoles = [...groupedRoles]

      if (groupedRoles.length > 0) {
        try {
          await markStep('Checking group access')
          const { memberQualifiesForGroup } = await import('@/lib/hub/groupEncryption')
          const { rehydrateTreeKeys, removeMemberFromGroupTree, addMemberToGroupTree, createPaginatedIndexFile: createIdx } = await import('@/lib/blossom/members')
          const { downloadTextFromBlossom, uploadToBlossomServers: uploadFn } = await import('@/lib/blossom/client')

          // Re-parse the index (it was just updated by the paginated tree update above)
          const updatedIndexContent = await downloadTextFromBlossom(finalIndexHash, hub.blossomServers)
          const updatedIndex = parseIndexFile(updatedIndexContent)

          let updatedGroupTrees = [...updatedIndex.groupTrees]
          let groupsChanged = false
          // Track old group secrets for history updates
          const groupHistoryEntries: Array<{ groupId: string; epoch: number; secretHex: string }> = []
          markStepDone('Checking group access')

          for (const [memberPubkey, newRoles] of Object.entries(stagedChanges)) {
            const originalMember = hubMembers.find(m => m.pubkey === memberPubkey)
            if (!originalMember) continue

            for (let gi = 0; gi < updatedGroupedRoles.length; gi++) {
              const group = updatedGroupedRoles[gi]
              const wasInGroup = memberQualifiesForGroup(originalMember.roles, group.roleIds)
              const isInGroup = memberQualifiesForGroup(newRoles, group.roleIds)
              console.log(`[GroupRotation] Member ${memberPubkey.slice(0, 8)}: originalRoles="${originalMember.roles}", newRoles="${newRoles}", group=${group.groupId.slice(0, 8)}, groupRoleIds=${JSON.stringify(group.roleIds)}, wasIn=${wasInGroup}, isIn=${isInGroup}`)

              if (wasInGroup && !isInGroup) {
                // Member was removed from this group — rotate the group tree
                await markStep('Rotating group encryption')
                const groupTreeRef = updatedGroupTrees.find(gt => gt.groupId === group.groupId)
                if (!groupTreeRef) {
                  console.warn(`[GroupRotation] No groupTreeRef found for ${group.groupId.slice(0, 8)} in updatedGroupTrees (${updatedGroupTrees.length} trees: ${updatedGroupTrees.map(t => t.groupId.slice(0, 8)).join(', ')})`)
                  continue
                }
                console.log(`[GroupRotation] Found groupTreeRef hash=${groupTreeRef.hash.slice(0, 12)}…`)

                try {
                  const groupTreeContent = await downloadTextFromBlossom(groupTreeRef.hash, hub.blossomServers)
                  console.log(`[GroupRotation] Downloaded group tree (${groupTreeContent.length} bytes)`)
                  const { deserializeTree } = await import('@/lib/crypto/lkh')
                  let groupTree = deserializeTree(groupTreeContent)

                  // Get current group secret from store
                  const groupSecretHex = useHubStore.getState().groupSecrets[hub.dTag]?.[group.groupId]
                  if (!groupSecretHex) {
                    console.warn(`[GroupRotation] No group secret for ${group.groupId.slice(0, 8)} — skipping rotation`)
                    continue
                  }
                  console.log(`[GroupRotation] Got group secret (${groupSecretHex.length / 2} bytes)`)
                  const groupSecret = new Uint8Array(groupSecretHex.length / 2)
                  for (let i = 0; i < groupSecretHex.length; i += 2) {
                    groupSecret[i / 2] = parseInt(groupSecretHex.substring(i, i + 2), 16)
                  }

                  // Rehydrate tree keys (creator needs to decrypt leaf keys)
                  groupTree = await rehydrateTreeKeys(groupTree, groupSecret, signer, privateKey)
                  console.log(`[GroupRotation] Rehydrated tree keys`)

                  // Remove the member and rotate the secret
                  const removeResult = await removeMemberFromGroupTree(groupTree, memberPubkey)
                  console.log(`[GroupRotation] removeMemberFromGroupTree result:`, removeResult ? 'success' : 'null (member not in tree?)')
                  if (removeResult) {
                    // Upload new group tree
                    const newGroupTreeBytes = new TextEncoder().encode(removeResult.newTreeContent)
                    const { hash: newGroupTreeHash } = await uploadFn(
                      newGroupTreeBytes, signer, privateKey, hub.blossomServers, 'text/plain',
                    )

                    // Update the group tree ref
                    updatedGroupTrees = updatedGroupTrees.map(gt =>
                      gt.groupId === group.groupId ? { ...gt, hash: newGroupTreeHash } : gt
                    )

                    // Track old group secret for history
                    groupHistoryEntries.push({
                      groupId: group.groupId,
                      epoch: group.epoch,
                      secretHex: groupSecretHex,
                    })

                    // Increment group epoch
                    updatedGroupedRoles[gi] = { ...group, epoch: group.epoch + 1 }

                    // Update local group secret
                    const newSecretHex = Array.from(removeResult.newGroupSecret)
                      .map(b => b.toString(16).padStart(2, '0')).join('')
                    useHubStore.getState().setGroupSecret(hub.dTag, group.groupId, newSecretHex)

                    // Also track new group secret in history
                    groupHistoryEntries.push({
                      groupId: group.groupId,
                      epoch: group.epoch + 1,
                      secretHex: newSecretHex,
                    })

                    groupsChanged = true
                    console.log(`[GroupRotation] ✅ Rotated group tree for ${group.groupId.slice(0, 8)} epoch ${group.epoch} → ${group.epoch + 1} (removed ${memberPubkey.slice(0, 8)}…)`)
                    markStepDone('Rotating group encryption')
                  }
                } catch (err) {
                  console.warn(`[GroupRotation] ❌ Failed to rotate group tree ${group.groupId.slice(0, 8)}:`, err)
                }
              } else if (!wasInGroup && isInGroup) {
                // Member was added to this group — add them to the group tree
                const groupTreeRef = updatedGroupTrees.find(gt => gt.groupId === group.groupId)
                if (!groupTreeRef) {
                  console.warn(`[GroupRotation] No groupTreeRef for add to ${group.groupId.slice(0, 8)}`)
                  continue
                }

                try {
                  await markStep('Adding to group tree')
                  const groupTreeContent = await downloadTextFromBlossom(groupTreeRef.hash, hub.blossomServers)
                  const { deserializeTree: deserializeGT } = await import('@/lib/crypto/lkh')
                  let groupTree = deserializeGT(groupTreeContent)

                  const groupSecretHex = useHubStore.getState().groupSecrets[hub.dTag]?.[group.groupId]
                  if (!groupSecretHex) {
                    console.warn(`[GroupRotation] No group secret for add to ${group.groupId.slice(0, 8)}`)
                    continue
                  }
                  const groupSecret = new Uint8Array(groupSecretHex.length / 2)
                  for (let i = 0; i < groupSecretHex.length; i += 2) {
                    groupSecret[i / 2] = parseInt(groupSecretHex.substring(i, i + 2), 16)
                  }

                  groupTree = await rehydrateTreeKeys(groupTree, groupSecret, signer, privateKey)
                  const newTreeContent = await addMemberToGroupTree(groupTree, memberPubkey, groupSecret, signer, privateKey)
                  const newTreeBytes = new TextEncoder().encode(newTreeContent)
                  const { hash: newGroupTreeHash } = await uploadFn(
                    newTreeBytes, signer, privateKey, hub.blossomServers, 'text/plain',
                  )

                  updatedGroupTrees = updatedGroupTrees.map(gt =>
                    gt.groupId === group.groupId ? { ...gt, hash: newGroupTreeHash } : gt
                  )
                  groupsChanged = true
                  console.log(`[GroupRotation] ✅ Added ${memberPubkey.slice(0, 8)}… to group tree ${group.groupId.slice(0, 8)}`)
                  markStepDone('Adding to group tree')
                } catch (err) {
                  console.warn(`[GroupRotation] ❌ Failed to add to group tree ${group.groupId.slice(0, 8)}:`, err)
                }
              }
            }
          }

          // Re-upload index if group trees changed (with updated history blob)
          if (groupsChanged) {
            await markStep('Uploading encryption index')

            // Update history blob with group epoch entries
            let historyHash = updatedIndex.historyHash
            if (groupHistoryEntries.length > 0) {
              const { aesEncrypt, aesDecrypt: aesDecryptFn } = await import('@/lib/crypto/aes')
              const hubSecretHex = useHubStore.getState().hubSecrets[hub.dTag]
              if (hubSecretHex) {
                const hubSecret = new Uint8Array(hubSecretHex.length / 2)
                for (let i = 0; i < hubSecretHex.length; i += 2) {
                  hubSecret[i / 2] = parseInt(hubSecretHex.substring(i, i + 2), 16)
                }

                // Decrypt existing history blob
                let historyPlaintext = ''
                if (historyHash) {
                  try {
                    const blob = await downloadTextFromBlossom(historyHash, hub.blossomServers)
                    historyPlaintext = await aesDecryptFn(hubSecret, blob)
                  } catch { /* start fresh */ }
                }

                // Append group history lines
                const lines = historyPlaintext ? historyPlaintext.split('\n').filter(l => l.trim()) : []
                for (const entry of groupHistoryEntries) {
                  const line = `group:${entry.groupId}:${entry.epoch}:${entry.secretHex}`
                  // Replace existing line for same group+epoch if present
                  const existIdx = lines.findIndex(l => l.startsWith(`group:${entry.groupId}:${entry.epoch}:`))
                  if (existIdx >= 0) lines[existIdx] = line
                  else lines.push(line)
                }

                // Re-encrypt and upload
                const updatedBlob = await aesEncrypt(hubSecret, lines.join('\n'))
                const historyBytes = new TextEncoder().encode(updatedBlob)
                const { hash: newHistoryHash } = await uploadFn(
                  historyBytes, signer, privateKey, hub.blossomServers, 'text/plain',
                )
                historyHash = newHistoryHash
              }
            }

            const newIndexContent = createIdx(
              updatedIndex.spineHash,
              updatedIndex.leafPages,
              updatedIndex.banPages.map(bp => bp.hash),
              historyHash || undefined,
              updatedGroupTrees.length > 0 ? updatedGroupTrees : undefined,
            )
            const indexBytes = new TextEncoder().encode(newIndexContent)
            const { hash: newIdxHash } = await uploadFn(
              indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
            )
            finalIndexHash = newIdxHash
            markStepDone('Uploading encryption index')

            // Best-effort cleanup of old Blossom files
            try {
              const { deleteFromBlossom } = await import('@/lib/blossom/client')
              // Old group tree files
              for (const oldGt of updatedIndex.groupTrees) {
                const newGt = updatedGroupTrees.find(g => g.groupId === oldGt.groupId)
                if (newGt && newGt.hash !== oldGt.hash) {
                  deleteFromBlossom(oldGt.hash, signer, privateKey, hub.blossomServers).catch(() => { })
                }
              }
              // Old history file
              if (updatedIndex.historyHash && historyHash && updatedIndex.historyHash !== historyHash) {
                deleteFromBlossom(updatedIndex.historyHash, signer, privateKey, hub.blossomServers).catch(() => { })
              }
              // Old index file (the one from before paginated update + group rotation)
              if (hub.indexFileHash && hub.indexFileHash !== finalIndexHash) {
                deleteFromBlossom(hub.indexFileHash, signer, privateKey, hub.blossomServers).catch(() => { })
              }
            } catch { /* cleanup is best-effort */ }
          }

          // Always publish a final hub event when grouped roles exist.
          // This covers both the group-rotated case (new index, bumped epochs)
          // and the non-rotated case (same index from tree update, original epochs).
          // We skipped publishing earlier to avoid a stale intermediate event.
          await markStep('Publishing hub update')
          const unsignedEvent = buildHubEvent({
            dTag: hub.dTag,
            name: hub.name,
            description: hub.description || undefined,
            epoch: hub.epoch,
            icon: hub.icon || undefined,
            banner: hub.banner || undefined,
            tags: hub.tags,
            relays: [...hub.generalRelays, ...hub.filterRelays],
            blossomServers: hub.blossomServers,
            indexFileHash: finalIndexHash,
            channels: hub.channels,
            categories: hub.categories,
            roles: hub.roles,
            minPow: hub.minPow || undefined,
            nsfw: hub.nsfw || undefined,
            discoverable: hub.discoverable,
            groupedRoles: updatedGroupedRoles,
            publishedAt: hub.publishedAt,
    
          })
          const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
          await publishToSpecificRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signedEvent)
          markStepDone('Publishing hub update')
        } catch (err) {
          console.warn('Group tree rotation during role save failed:', err)
        }
      }

      const updatedMembers = hubMembers.map(m =>
        stagedChanges[m.pubkey] ? { ...m, roles: stagedChanges[m.pubkey] } : m
      )
      setHubMembers(hub.dTag, updatedMembers)
      setHubData(hub.dTag, {
        ...hub,
        indexFileHash: finalIndexHash,
        ...(groupedRoles.length > 0 ? { groupedRoles: updatedGroupedRoles } : {}),
      })

      await markStep('Done')
      setStagedChanges({})
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
    } catch (err: any) {
      console.error('Failed to save member roles:', err)
      setSaveError(err?.message || 'Failed to save')
    } finally {
      setSaving(false)
      setSaveStep(null)
    }
  }
  handleSaveRef.current = handleSave

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground leading-relaxed">
        Manage member roles. Changes are staged locally — click <strong>Save &amp; Publish</strong> to update the tree and publish.
      </p>
      <p className="text-xs text-muted-foreground/70 leading-relaxed">
        Only members from your local page are shown. To manage a specific member, search by their user address (npub).
      </p>

      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 border border-border">
        <Search size={14} className="text-muted-foreground shrink-0" />
        <input type="text" placeholder="Search members..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none" />
        <span className="text-xs text-muted-foreground shrink-0">
          {filteredMembers.length} member{filteredMembers.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto">
        {filteredMembers.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            {hubMembers.length <= 1 ? 'No members besides you.' : 'No members match your search.'}
          </p>
        ) : filteredMembers.map(member => {
          const profile = getProfile(member.pubkey)
          const npubStr = nip19.npubEncode(member.pubkey)
          const name = profile?.display_name || profile?.name || truncateNpub(npubStr, 12)
          const isExpanded = expandedPubkey === member.pubkey
          const currentRoles = getRolesForMember(member)
          const roleIds = currentRoles.split('|').map(s => s.trim()).filter(Boolean)
          const isChanged = !!stagedChanges[member.pubkey]
          return (
            <div key={member.pubkey} className={cn('rounded-lg border transition-colors', isChanged ? 'border-primary/30 bg-primary/5' : 'border-transparent hover:bg-secondary/30')}>
              <button onClick={() => setExpandedPubkey(isExpanded ? null : member.pubkey)}
                className="flex items-center gap-3 w-full px-3 py-2.5 text-left cursor-pointer">
                <Avatar className="h-8 w-8">
                  {profile?.picture && <AvatarImage src={profile.picture} />}
                  <AvatarFallback className="text-xs bg-primary/20 text-primary">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{name}</p>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {hub.roles.filter(r => {
                      if (r.name === 'everyone') return roleIds.length === 0 || (roleIds.length === 1 && roleIds[0] === 'everyone')
                      return roleIds.includes(r.roleId)
                    }).map(role => (
                      <span key={role.roleId} className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                        style={{ backgroundColor: role.color ? `${role.color}20` : 'hsl(var(--primary) / 0.1)', color: role.color || 'hsl(var(--primary))' }}>
                        {role.name}
                      </span>
                    ))}
                  </div>
                </div>
                {isChanged && <span className="text-[10px] text-primary font-medium shrink-0">modified</span>}
                <ChevronRight size={14} className={cn('text-muted-foreground transition-transform shrink-0', isExpanded && 'rotate-90')} />
              </button>
              {isExpanded && (
                <div className="border-t border-border/30 mx-3 mb-3 ml-14">
                  {hub.roles.map((role, i) => {
                    const hasRole = role.name === 'everyone' || roleIds.includes(role.roleId)
                    const isEveryone = role.name === 'everyone'
                    return (
                      <div
                        key={role.roleId}
                        className={cn(
                          'flex items-center justify-between py-2 px-1',
                          i > 0 && 'border-t border-border/20',
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: role.color || 'hsl(var(--primary))' }} />
                          <span className="text-sm text-foreground truncate">{role.name}</span>
                          {isEveryone && <span className="text-[10px] text-muted-foreground">default</span>}
                        </div>
                        <button
                          onClick={() => toggleRole(member.pubkey, role.roleId, role.name)}
                          disabled={isEveryone}
                          className={cn(
                            'shrink-0 h-7 px-2.5 rounded-md flex items-center gap-1.5 text-xs font-medium transition-all border',
                            isEveryone && 'opacity-40 cursor-not-allowed',
                            !isEveryone && 'cursor-pointer',
                            hasRole
                              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                              : 'bg-transparent border-border/40 text-muted-foreground/60 hover:border-border/70',
                          )}
                        >
                          {hasRole ? <><Check size={12} strokeWidth={3} /> Assigned</> : <><Minus size={12} strokeWidth={3} /> None</>}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}


