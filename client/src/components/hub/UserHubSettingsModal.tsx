/**
 * UserHubSettingsModal — Per-hub settings for message visibility and facilitator management
 *
 * Sections:
 * 1. Message Visibility: "Show facilitated messages" toggle
 * 2. Facilitator: Search member list, check status, set facilitator (non-members)
 * 3. My Facilitation List: Create/manage own mesh tree for adding non-members (members only)
 * 4. Secret Mismatch Warning: when facilitator's secret differs from hub epoch
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useHubStore, type HubData, type HubMember, type HubPrefs, type HideEntry } from '@/stores/hubStore'
import { useMessageStore } from '@/stores/messageStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub, cn } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import {
  X, Search, Loader2, Check, AlertTriangle, SlidersHorizontal, UserCheck, Shield, ShieldOff, ShieldBan, Lock, LockOpen,
  Users, Plus, Trash2, Volume2, Globe, Server, Wifi, WifiOff, Flag, MessagesSquare, Undo2, EyeOff, RefreshCw, Bell,
  BellOff, AtSign, UsersRound, Radio, Tag, ChevronLeft, ChevronRight, BookOpen,
} from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { aesDecrypt } from '@/lib/crypto/aes'
import { deriveChannelKey } from '@/lib/crypto/hkdf'
import { useVoiceStore } from '@/stores/voiceStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useNavigationStore } from '@/stores/navigationStore'
import type { HubMuteSettings } from '@/lib/notifications/readState'
import { useReportStore, type HubReport } from '@/stores/reportStore'
import type { VoiceProviderType, CloudflareConfig, LiveKitConfig } from '@/lib/voice/types'
import { getPermissionsForUser } from '@/lib/hub/permissions'
import { Pagination } from '@/components/ui/Pagination'
import { CustomSelect } from '@/components/ui/custom-select'

interface UserHubSettingsModalProps {
  open: boolean
  onClose: () => void
  hub: HubData
  initialTab?: UserHubTab
}

const EMPTY_MEMBERS: HubMember[] = []
const EMPTY_GROUP_SECRETS: Record<string, string> = {}
const EMPTY_MY_REPORTS: HubReport[] = []
const EMPTY_MUTE_SETTINGS: HubMuteSettings = {}

const DEFAULT_PREFS: HubPrefs = {
  showFacilitatedMessages: true,
}

type UserHubTab = 'messages' | 'notifications' | 'voice' | 'reports' | 'moderation' | 'hidden'

export function UserHubSettingsModal({ open, onClose, hub, initialTab }: UserHubSettingsModalProps) {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const hubMembers = useHubStore((s) => s.hubMembers[hub.dTag]) || EMPTY_MEMBERS
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const hubPrefs = useHubStore((s) => s.hubPrefs[hub.dTag]) || DEFAULT_PREFS
  const setHubPref = useHubStore((s) => s.setHubPref)
  const setHubSecret = useHubStore((s) => s.setHubSecret)
  const hubMuteSettings = useNotificationStore((s) => s.hubMuteSettings[hub.dTag] ?? EMPTY_MUTE_SETTINGS)
  const setHubMuteSettings = useNotificationStore((s) => s.setHubMuteSettings)
  const publishHubReadState = useNotificationStore((s) => s.publishHubReadState)
  const { getProfile } = useProfileCache()

  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<UserHubTab>(initialTab ?? 'messages')
  const [mobileShowNav, setMobileShowNav] = useState(true)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [checkResult, setCheckResult] = useState<'found' | 'not-found' | null>(null)
  const [selectedFacilitator, setSelectedFacilitator] = useState<string | null>(
    hubPrefs.facilitator || null
  )
  const [settingFacilitator, setSettingFacilitator] = useState(false)
  const [facilitatorError, setFacilitatorError] = useState<string | null>(null)

  // ── My Facilitation List state ──
  const [meshMembers, setMeshMembers] = useState<string[]>([])
  const [meshLoading, setMeshLoading] = useState(false)
  const [meshListHash, setMeshListHash] = useState<string | null>(null)
  const [meshError, setMeshError] = useState<string | null>(null)
  const [meshBusy, setMeshBusy] = useState(false)
  const [addNpub, setAddNpub] = useState('')
  const [meshCreated, setMeshCreated] = useState(false)

  // ── Moderation state ──
  const [myBanList, setMyBanList] = useState<string[]>([])
  const [modBanLoading, setModBanLoading] = useState(false)
  const [modBanBusy, setModBanBusy] = useState(false)
  const [modBanError, setModBanError] = useState<string | null>(null)
  const [modBanStep, setModBanStep] = useState<string | null>(null)
  const [modBanSteps, setModBanSteps] = useState<string[]>([])
  const [modBanActionType, setModBanActionType] = useState<'ban' | 'unban'>('ban')
  const [banNpub, setBanNpub] = useState('')
  const [selectedMod, setSelectedMod] = useState<string | null>(null)
  const [otherModBanList, setOtherModBanList] = useState<string[]>([])
  const [otherModLoading, setOtherModLoading] = useState(false)
  const modBanLists = useHubStore((s) => s.modBanLists[hub.dTag]) || {}

  // ── Notification save state ──
  const initialMuteRef = useRef<HubMuteSettings>(EMPTY_MUTE_SETTINGS)
  const [muteSaving, setMuteSaving] = useState(false)
  const [muteSaveResult, setMuteSaveResult] = useState<'saved' | 'error' | null>(null)

  // ── Voice Hosting state ──
  const [voiceProviderType, setVoiceProviderType] = useState<VoiceProviderType>('cloudflare')
  const [cfAppId, setCfAppId] = useState('')
  const [cfApiToken, setCfApiToken] = useState('')
  const [cfTurnKeyId, setCfTurnKeyId] = useState('')
  const [cfTurnToken, setCfTurnToken] = useState('')
  const [lkUrl, setLkUrl] = useState('')
  const [lkApiKey, setLkApiKey] = useState('')
  const [lkApiSecret, setLkApiSecret] = useState('')
  const [voiceHostStatus, setVoiceHostStatus] = useState<'available' | 'paused'>('available')
  const [voicePublishing, setVoicePublishing] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceSaved, setVoiceSaved] = useState(false)
  const publishHostAvailability = useVoiceStore((s) => s.publishHostAvailability)
  const hostsByHub = useVoiceStore((s) => s.hostsByHub)

  // ── Voice scope state ──
  // null = hub-wide, string = groupId
  const [voiceScope, setVoiceScope] = useState<string | null>(null)
  // Per-scope saved credential snapshots: scopeKey -> { providerType, cf*, lk*, status }
  const [voiceScopeConfigs, setVoiceScopeConfigs] = useState<Record<string, {
    providerType: VoiceProviderType
    cfAppId: string; cfApiToken: string; cfTurnKeyId: string; cfTurnToken: string
    lkUrl: string; lkApiKey: string; lkApiSecret: string
    status: 'available' | 'paused'
  }>>({})
  const _groupSecretsRaw = useHubStore((s) => s.groupSecrets[hub.dTag])
  const groupSecrets = _groupSecretsRaw ?? EMPTY_GROUP_SECRETS

  // Grouped roles the user has secrets for (i.e., user is a member of these groups)
  const availableGroupScopes = useMemo(() => {
    const groups = hub.groupedRoles || []
    return groups.filter((g) => !!groupSecrets[g.groupId])
  }, [hub.groupedRoles, groupSecrets])

  // When switching scope, save current fields and load the new scope's fields
  const switchVoiceScope = useCallback((newScope: string | null) => {
    // Save current scope's state
    const currentKey = voiceScope ?? '__hub__'
    setVoiceScopeConfigs((prev) => ({
      ...prev,
      [currentKey]: {
        providerType: voiceProviderType, cfAppId, cfApiToken, cfTurnKeyId, cfTurnToken,
        lkUrl, lkApiKey, lkApiSecret, status: voiceHostStatus,
      },
    }))
    // Load new scope's state (or defaults)
    const newKey = newScope ?? '__hub__'
    const saved = voiceScopeConfigs[newKey]
    if (saved) {
      setVoiceProviderType(saved.providerType)
      setCfAppId(saved.cfAppId); setCfApiToken(saved.cfApiToken)
      setCfTurnKeyId(saved.cfTurnKeyId); setCfTurnToken(saved.cfTurnToken)
      setLkUrl(saved.lkUrl); setLkApiKey(saved.lkApiKey); setLkApiSecret(saved.lkApiSecret)
      setVoiceHostStatus(saved.status)
    } else {
      // Check if there's an existing published host event for this scope
      const hosts = hostsByHub[hub.dTag] || []
      const myHost = hosts.find((h) => h.pubkey === pubkey && (newScope ? h.groupId === newScope : !h.groupId))
      if (myHost?.config) {
        const cfg = myHost.config as any
        // Check if the config has actual credentials (not just the stub { provider: '...' })
        const hasCredentials = myHost.providerType === 'cloudflare'
          ? !!(cfg.cfAppId || cfg.cfApiToken)
          : !!(cfg.lkUrl || cfg.lkApiKey)
        if (hasCredentials) {
          setVoiceProviderType(myHost.providerType)
          setCfAppId(cfg.cfAppId || ''); setCfApiToken(cfg.cfApiToken || '')
          setCfTurnKeyId(cfg.cfTurnKeyId || ''); setCfTurnToken(cfg.cfTurnToken || '')
          setLkUrl(cfg.lkUrl || ''); setLkApiKey(cfg.lkApiKey || ''); setLkApiSecret(cfg.lkApiSecret || '')
          setVoiceHostStatus(myHost.status)
        } else if (myHost.encryptedContent) {
          // Config not yet decrypted — attempt on-demand decryption
          setVoiceProviderType(myHost.providerType)
          setVoiceHostStatus(myHost.status)
          setCfAppId(''); setCfApiToken(''); setCfTurnKeyId(''); setCfTurnToken('')
          setLkUrl(''); setLkApiKey(''); setLkApiSecret('')
            // Async: try to decrypt now that secrets may be available
            ;(async () => {
              try {
                const { decryptHostConfig } = await import('@/stores/voiceStore')
                const { useHubStore } = await import('@/stores/hubStore')
                let config: import('@/lib/voice/types').VoiceProviderConfig | null = null

                if (newScope) {
                  // Group-scoped: try current group secret first
                  const groupSecret = groupSecrets[newScope]
                  if (groupSecret) {
                    config = await decryptHostConfig(myHost.encryptedContent!, groupSecret, myHost.epoch)
                  }
                  // Fallback: try historical group epoch secret
                  if (!config) {
                    const oldSecret = useHubStore.getState().groupEpochSecrets[hub.dTag]?.[newScope]?.[myHost.epoch]
                    if (oldSecret) {
                      config = await decryptHostConfig(myHost.encryptedContent!, oldSecret, myHost.epoch)
                    }
                  }
                } else {
                  // Hub-wide: try current hub secret first
                  const secret = hubSecrets[hub.dTag]
                  if (secret) {
                    config = await decryptHostConfig(myHost.encryptedContent!, secret, myHost.epoch)
                  }
                  // Fallback: try historical hub epoch secret
                  if (!config) {
                    const oldSecret = useHubStore.getState().epochSecrets[hub.dTag]?.[myHost.epoch]
                    if (oldSecret) {
                      config = await decryptHostConfig(myHost.encryptedContent!, oldSecret, myHost.epoch)
                    }
                  }
                }

                if (!config) return
                // Update the store
                const voiceStore = (await import('@/stores/voiceStore')).useVoiceStore.getState()
                const currentHosts = voiceStore.hostsByHub[hub.dTag] || []
                const idx = currentHosts.findIndex((h) => h.pubkey === myHost.pubkey && h.groupId === myHost.groupId)
                if (idx >= 0) {
                  const updated = [...currentHosts]
                  updated[idx] = { ...updated[idx], config, encryptedContent: undefined }
                  ;(await import('@/stores/voiceStore')).useVoiceStore.setState({
                    hostsByHub: { ...voiceStore.hostsByHub, [hub.dTag]: updated },
                  })
                }
                // Also fill the form fields
                const c = config as any
                if (myHost.providerType === 'cloudflare') {
                  setCfAppId(c.cfAppId || ''); setCfApiToken(c.cfApiToken || '')
                  setCfTurnKeyId(c.cfTurnKeyId || ''); setCfTurnToken(c.cfTurnToken || '')
                } else {
                  setLkUrl(c.lkUrl || ''); setLkApiKey(c.lkApiKey || ''); setLkApiSecret(c.lkApiSecret || '')
                }
              } catch { /* decryption failed — user can republish */ }
            })()
        } else {
          // Host exists but config not yet decrypted — show defaults with correct status/provider
          setVoiceProviderType(myHost.providerType)
          setVoiceHostStatus(myHost.status)
          setCfAppId(''); setCfApiToken(''); setCfTurnKeyId(''); setCfTurnToken('')
          setLkUrl(''); setLkApiKey(''); setLkApiSecret('')
        }
      } else {
        setCfAppId(''); setCfApiToken(''); setCfTurnKeyId(''); setCfTurnToken('')
        setLkUrl(''); setLkApiKey(''); setLkApiSecret('')
        setVoiceProviderType('cloudflare')
        setVoiceHostStatus('available')
      }
    }
    setVoiceScope(newScope)
    setVoiceError(null)
    setVoiceSaved(false)
  }, [voiceScope, voiceProviderType, cfAppId, cfApiToken, cfTurnKeyId, cfTurnToken, lkUrl, lkApiKey, lkApiSecret, voiceHostStatus, voiceScopeConfigs, hostsByHub, hub.dTag, pubkey, groupSecrets, hubSecrets])

  // Is current user a direct member (in the creator's tree)?
  const isMember = useMemo(() => {
    if (!pubkey) return false
    return hubMembers.some((m) => m.pubkey === pubkey)
  }, [hubMembers, pubkey])

  const hasSecret = !!(hub.dTag && hubSecrets[hub.dTag])

  // Filter members for facilitator search
  const filteredMembers = useMemo(() => {
    if (!search.trim()) return hubMembers.filter((m) => m.pubkey !== pubkey)
    const q = search.toLowerCase().trim()
    return hubMembers
      .filter((m) => m.pubkey !== pubkey)
      .filter((m) => {
        const profile = getProfile(m.pubkey)
        const name = (profile?.display_name || profile?.name || '').toLowerCase()
        const npub = nip19.npubEncode(m.pubkey).toLowerCase()
        return name.includes(q) || npub.includes(q)
      })
  }, [hubMembers, search, getProfile, pubkey])

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setSearch('')
      setCheckResult(null)
      setFacilitatorError(null)
      setSelectedFacilitator(hubPrefs.facilitator || null)
      setMeshError(null)
      setAddNpub('')
      setActiveTab(initialTab ?? 'messages')
      // Snapshot the current mute settings so we can detect changes
      const currentMute = useNotificationStore.getState().hubMuteSettings[hub.dTag] ?? EMPTY_MUTE_SETTINGS
      initialMuteRef.current = { ...currentMute }
      setMuteSaveResult(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hubPrefs.facilitator])

  // Load own mod ban list when moderation tab is selected
  useEffect(() => {
    if (!open || activeTab !== 'moderation' || !pubkey) return
    // Seed from store first
    const stored = useHubStore.getState().modBanLists[hub.dTag]?.[pubkey]
    if (stored && stored.length > 0) {
      setMyBanList(stored)
      return
    }
    // Otherwise fetch from Blossom
    let cancelled = false
    setModBanLoading(true)
      ; (async () => {
        try {
          const { fetchEvents: fetchEvt } = await import('@/lib/nostr/relay-pool')
          const { KINDS } = await import('@/lib/crypto/constants')
          const { downloadTextFromBlossom, parseIndexFile, downloadBanList } = await import('@/lib/blossom')

          const jrs = await fetchEvt({ kinds: [KINDS.JOIN_REQUEST], authors: [pubkey], '#d': [hub.dTag], limit: 1 })
          if (cancelled) return
          if (jrs.length === 0) { setModBanLoading(false); return }

          const listTag = jrs[0].tags.find((t: string[]) => t[0] === 'list')
          if (!listTag?.[1]) { setModBanLoading(false); return }

          const indexContent = await downloadTextFromBlossom(listTag[1], hub.blossomServers)
          const index = parseIndexFile(indexContent)
          if (index.banPages.length > 0) {
            const entries = await downloadBanList(index.banPages, hub.blossomServers)
            if (!cancelled) {
              const pks = entries.map(e => e.pubkey)
              setMyBanList(pks)
              useHubStore.getState().setModBanList(hub.dTag, pubkey, pks)
            }
          }
        } catch (err) {
          console.warn('Failed to load own mod ban list:', err)
        }
        if (!cancelled) setModBanLoading(false)
      })()
    return () => { cancelled = true }
  }, [open, activeTab, pubkey, hub.dTag, hub.blossomServers])

  // Load existing voice host config on open
  useEffect(() => {
    if (!open || !pubkey) return
    const hosts = hostsByHub[hub.dTag] || []
    // Initial scope is hub-wide (voiceScope = null), so only load hub-wide host (no groupId)
    const myHost = hosts.find((h) => h.pubkey === pubkey && !h.groupId)
    if (myHost) {
      setVoiceProviderType(myHost.providerType)
      setVoiceHostStatus(myHost.status)
      // Pre-fill decrypted credentials (if available)
      const cfg = myHost.config as any
      if (cfg && myHost.providerType === 'cloudflare') {
        if (cfg.cfAppId) setCfAppId(cfg.cfAppId)
        if (cfg.cfApiToken) setCfApiToken(cfg.cfApiToken)
        if (cfg.cfTurnKeyId) setCfTurnKeyId(cfg.cfTurnKeyId)
        if (cfg.cfTurnToken) setCfTurnToken(cfg.cfTurnToken)
      } else if (cfg && myHost.providerType === 'livekit') {
        if (cfg.lkUrl) setLkUrl(cfg.lkUrl)
        if (cfg.lkApiKey) setLkApiKey(cfg.lkApiKey)
        if (cfg.lkApiSecret) setLkApiSecret(cfg.lkApiSecret)
      }
    }
  }, [open, pubkey, hostsByHub, hub.dTag])

  // Load own mesh list on open (members only)
  useEffect(() => {
    if (!open || !isMember || !pubkey) return
    let cancelled = false
    setMeshLoading(true)

      ; (async () => {
        try {
          const { fetchEvents } = await import('@/lib/nostr/relay-pool')
          const { KINDS } = await import('@/lib/crypto/constants')
          const { downloadTextFromBlossom, parseIndexFile } = await import('@/lib/blossom')
          const { deserializeTree, getMembers } = await import('@/lib/crypto/lkh')

          const joinRequests = await fetchEvents({
            kinds: [KINDS.JOIN_REQUEST],
            authors: [pubkey],
            '#d': [hub.dTag],
            limit: 1,
          })

          if (cancelled) return

          if (joinRequests.length === 0) {
            setMeshMembers([])
            setMeshListHash(null)
            setMeshCreated(false)
            setMeshLoading(false)
            return
          }

          const listTag = joinRequests[0].tags.find((t: string[]) => t[0] === 'list')
          if (!listTag || !listTag[1]) {
            setMeshMembers([])
            setMeshListHash(null)
            setMeshCreated(false)
            setMeshLoading(false)
            return
          }

          const indexHash = listTag[1]
          setMeshListHash(indexHash)
          setMeshCreated(true)

          // Download index → tree → extract member pubkeys
          const indexContent = await downloadTextFromBlossom(indexHash, hub.blossomServers)
          const index = parseIndexFile(indexContent)
          if (index.treeHash) {
            const treeContent = await downloadTextFromBlossom(index.treeHash, hub.blossomServers)
            const tree = deserializeTree(treeContent)
            const members = getMembers(tree)
            // Exclude self from the displayed list
            if (!cancelled) setMeshMembers(members.filter(m => m.pubkey !== pubkey).map(m => m.pubkey))
          }
        } catch (err) {
          console.warn('Failed to load own mesh list:', err)
          if (!cancelled) setMeshError('Failed to load your facilitation list')
        } finally {
          if (!cancelled) setMeshLoading(false)
        }
      })()

    return () => { cancelled = true }
  }, [open, isMember, pubkey, hub.dTag, hub.blossomServers])

  /** Check if current user's pubkey is in the selected member's mesh tree */
  const handleCheckStatus = useCallback(async () => {
    if (!selectedFacilitator || !pubkey) return
    setCheckingStatus(true)
    setCheckResult(null)
    setFacilitatorError(null)

    try {
      const { downloadTextFromBlossom, parseIndexFile } = await import('@/lib/blossom')
      const { deserializeTree } = await import('@/lib/crypto/lkh')
      const { fetchEvents } = await import('@/lib/nostr/relay-pool')
      const { KINDS } = await import('@/lib/crypto/constants')

      // Fetch the facilitator's join request (kind 36944) to get their `list` tag
      const joinRequests = await fetchEvents({
        kinds: [KINDS.JOIN_REQUEST],
        authors: [selectedFacilitator],
        '#d': [hub.dTag],
        limit: 1,
      })

      if (joinRequests.length === 0) {
        setCheckResult('not-found')
        setFacilitatorError('This member has no join request for this hub.')
        setCheckingStatus(false)
        return
      }

      const listTag = joinRequests[0].tags.find((t: string[]) => t[0] === 'list')
      if (!listTag || !listTag[1]) {
        setCheckResult('not-found')
        setFacilitatorError('This member does not maintain a facilitation list for this hub.')
        setCheckingStatus(false)
        return
      }

      // Download their index → tree
      const indexContent = await downloadTextFromBlossom(listTag[1], hub.blossomServers)
      const index = parseIndexFile(indexContent)
      if (!index.treeHash) {
        setCheckResult('not-found')
        setFacilitatorError('No tree hash in facilitator\'s index file.')
        setCheckingStatus(false)
        return
      }

      const treeContent = await downloadTextFromBlossom(index.treeHash, hub.blossomServers)
      const tree = deserializeTree(treeContent)

      // Check if current user is a leaf in their tree
      const isInTree = tree.leaves.some((leaf: any) => leaf.pubkey === pubkey)

      if (isInTree) {
        setCheckResult('found')
      } else {
        setCheckResult('not-found')
        setFacilitatorError('You are not in this member\'s list.')
      }
    } catch (err: any) {
      console.error('Check status failed:', err)
      setCheckResult('not-found')
      setFacilitatorError(err?.message || 'Failed to check status')
    } finally {
      setCheckingStatus(false)
    }
  }, [selectedFacilitator, pubkey, hub.dTag, hub.blossomServers])

  /** Set the selected member as facilitator and decrypt secret from their tree */
  const handleSetFacilitator = useCallback(async () => {
    if (!selectedFacilitator || !pubkey || checkResult !== 'found') return
    setSettingFacilitator(true)
    setFacilitatorError(null)

    try {
      const { downloadTextFromBlossom, parseIndexFile } = await import('@/lib/blossom')
      const { decryptHubSecret } = await import('@/lib/blossom/members')
      const { toHex } = await import('@/lib/crypto/lkh')
      const { fetchEvents } = await import('@/lib/nostr/relay-pool')
      const { KINDS } = await import('@/lib/crypto/constants')

      // Fetch the facilitator's join request to get their `list` tag (§6.3)
      const joinRequests = await fetchEvents({
        kinds: [KINDS.JOIN_REQUEST],
        authors: [selectedFacilitator],
        '#d': [hub.dTag],
        limit: 1,
      })

      if (joinRequests.length === 0) throw new Error('Facilitator join request not found')

      const listTag = joinRequests[0].tags.find((t: string[]) => t[0] === 'list')
      if (!listTag?.[1]) throw new Error('Facilitator has no mesh list published')

      const indexHash = listTag[1]

      const indexContent = await downloadTextFromBlossom(indexHash, hub.blossomServers)
      const index = parseIndexFile(indexContent)
      if (!index.treeHash) throw new Error('No tree hash in facilitator index')

      const treeContent = await downloadTextFromBlossom(index.treeHash, hub.blossomServers)

      // Decrypt the hub secret from the facilitator's tree
      // Note: the tree was encrypted with the FACILITATOR's key, so creatorPubkey = facilitator
      const hubSecretBytes = await decryptHubSecret(
        pubkey,
        privateKey,
        signer,
        selectedFacilitator,
        treeContent
      )

      if (!hubSecretBytes) throw new Error('Could not decrypt hub secret — you may not be in the tree')

      const secretHex = toHex(hubSecretBytes)

      // Save to store
      setHubSecret(hub.dTag, secretHex)
      setHubPref(hub.dTag, 'facilitator', selectedFacilitator)
      setHubPref(hub.dTag, 'facilitatorSecret', secretHex)

    } catch (err: any) {
      console.error('Set facilitator failed:', err)
      setFacilitatorError(err?.message || 'Failed to set facilitator')
    } finally {
      setSettingFacilitator(false)
    }
  }, [selectedFacilitator, pubkey, checkResult, hub, signer, privateKey, setHubSecret, setHubPref])

  // ── Mesh List Handlers ──

  /**
   * Create a new facilitation list (LKH tree with self as sole member).
   * Uploads tree + index to blossom, then publishes/updates join request with `list` tag.
   */
  const handleCreateMeshList = useCallback(async () => {
    if (!pubkey || meshBusy) return
    setMeshBusy(true)
    setMeshError(null)

    try {
      const { createAndUploadMemberFiles } = await import('@/lib/blossom/members')
      const { createJoinRequest } = await import('@/lib/nostr/events')
      const { signWithSigner } = await import('@/lib/nostr/events')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')

      // Get or generate the hub secret that we obtained from the creator's tree
      const currentSecret = hubSecrets[hub.dTag]
      if (!currentSecret) throw new Error('You do not have the hub secret yet')

      // Convert hex secret to Uint8Array
      const secretBytes = new Uint8Array(currentSecret.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))

      // Create + upload tree to same blossom servers as the hub
      const { indexHash } = await createAndUploadMemberFiles(
        pubkey,
        hub.dTag,
        secretBytes,
        privateKey,
        signer,
        hub.blossomServers,
      )

      // Publish/update join request with `list` tag
      const hubData = useHubStore.getState().hubs[hub.dTag]
      const creatorPubkey = hubData?.creatorPubkey || ''
      const unsignedEvent = createJoinRequest(hub.dTag, creatorPubkey, indexHash)
      const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signedEvent)

      console.log('Facilitation list created with index:', indexHash)

      setMeshListHash(indexHash)
      setMeshCreated(true)
      setMeshMembers([]) // Only self in tree, excluded from display
    } catch (err: any) {
      console.error('Create mesh list failed:', err)
      setMeshError(err?.message || 'Failed to create facilitation list')
    } finally {
      setMeshBusy(false)
    }
  }, [pubkey, meshBusy, hub, signer, privateKey, hubSecrets])

  /**
   * Add a user to the facilitation list.
   * Downloads current tree → rehydrates → adds leaf → re-uploads → updates join request.
   */
  const handleAddToMesh = useCallback(async () => {
    if (!pubkey || meshBusy || !addNpub.trim()) return
    setMeshBusy(true)
    setMeshError(null)

    try {
      // Parse input as npub or hex pubkey
      let targetPubkey: string
      const trimmed = addNpub.trim()
      if (trimmed.startsWith('npub1')) {
        const decoded = nip19.decode(trimmed)
        if (decoded.type !== 'npub') throw new Error('Invalid npub')
        targetPubkey = decoded.data
      } else if (/^[0-9a-f]{64}$/i.test(trimmed)) {
        targetPubkey = trimmed.toLowerCase()
      } else {
        throw new Error('Enter a valid npub or hex pubkey')
      }

      // Check if already in list
      if (meshMembers.includes(targetPubkey)) throw new Error('User is already in your list')
      if (targetPubkey === pubkey) throw new Error('Cannot add yourself')

      const { downloadTextFromBlossom, parseIndexFile, uploadToBlossomServers, computeHash } = await import('@/lib/blossom')
      const { addMemberToTree, rehydrateTreeKeys, createIndexFile } = await import('@/lib/blossom/members')
      const { deserializeTree, fromHex } = await import('@/lib/crypto/lkh')
      const { createJoinRequest, signWithSigner } = await import('@/lib/nostr/events')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')

      // Get current hub secret
      const currentSecret = hubSecrets[hub.dTag]
      if (!currentSecret) throw new Error('Hub secret not available')
      const secretBytes = fromHex(currentSecret)

      // Download current tree
      if (!meshListHash) throw new Error('No mesh list index hash')
      const indexContent = await downloadTextFromBlossom(meshListHash, hub.blossomServers)
      const index = parseIndexFile(indexContent)
      if (!index.treeHash) throw new Error('No tree hash')

      const treeContent = await downloadTextFromBlossom(index.treeHash, hub.blossomServers)
      const tree = deserializeTree(treeContent)

      // Rehydrate keys (we are the tree creator)
      const rehydratedTree = await rehydrateTreeKeys(tree, secretBytes, signer, privateKey)

      // Add the new member leaf
      const newTreeContent = await addMemberToTree(
        rehydratedTree, targetPubkey, 'everyone', secretBytes, signer, privateKey
      )

      // Upload new tree
      const treeBytes = new TextEncoder().encode(newTreeContent)
      const { hash: newTreeHash } = await uploadToBlossomServers(treeBytes, signer, privateKey, hub.blossomServers, 'text/plain')

      // Create + upload new index
      const newIndexContent = createIndexFile(newTreeHash, [], index.historyHash || undefined)
      const indexBytes = new TextEncoder().encode(newIndexContent)
      const { hash: newIndexHash } = await uploadToBlossomServers(indexBytes, signer, privateKey, hub.blossomServers, 'text/plain')

      // Update join request with new list hash
      const hubData = useHubStore.getState().hubs[hub.dTag]
      const creatorPubkey = hubData?.creatorPubkey || ''
      const unsignedEvent = createJoinRequest(hub.dTag, creatorPubkey, newIndexHash)
      const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signedEvent)

      setMeshListHash(newIndexHash)
      setMeshMembers(prev => [...prev, targetPubkey])
      setAddNpub('')
      console.log('Added', targetPubkey, 'to facilitation list')

      // Cleanup old files (best-effort, after everything succeeded)
      const { deleteFromBlossom } = await import('@/lib/blossom/client')
      if (index.treeHash && index.treeHash !== newTreeHash) {
        deleteFromBlossom(index.treeHash, signer, privateKey, hub.blossomServers).catch(() => { })
      }
      if (meshListHash && meshListHash !== newIndexHash) {
        deleteFromBlossom(meshListHash, signer, privateKey, hub.blossomServers).catch(() => { })
      }
    } catch (err: any) {
      console.error('Add to mesh failed:', err)
      setMeshError(err?.message || 'Failed to add user')
    } finally {
      setMeshBusy(false)
    }
  }, [pubkey, meshBusy, addNpub, meshMembers, meshListHash, hub, signer, privateKey, hubSecrets])

  /**
   * Remove a user from the facilitation list.
   * Downloads tree → rehydrates → removes leaf → re-uploads → updates join request.
   */
  const handleRemoveFromMesh = useCallback(async (targetPubkey: string) => {
    if (!pubkey || meshBusy) return
    setMeshBusy(true)
    setMeshError(null)

    try {
      const { downloadTextFromBlossom, parseIndexFile, uploadToBlossomServers } = await import('@/lib/blossom')
      const { removeMemberFromTree, rehydrateTreeKeys, createIndexFile } = await import('@/lib/blossom/members')
      const { deserializeTree, fromHex, serializeTree } = await import('@/lib/crypto/lkh')
      const { createJoinRequest, signWithSigner } = await import('@/lib/nostr/events')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')

      const currentSecret = hubSecrets[hub.dTag]
      if (!currentSecret) throw new Error('Hub secret not available')
      const secretBytes = fromHex(currentSecret)

      if (!meshListHash) throw new Error('No mesh list index hash')
      const indexContent = await downloadTextFromBlossom(meshListHash, hub.blossomServers)
      const index = parseIndexFile(indexContent)
      if (!index.treeHash) throw new Error('No tree hash')

      const treeContent = await downloadTextFromBlossom(index.treeHash, hub.blossomServers)
      const tree = deserializeTree(treeContent)

      // Rehydrate keys
      const rehydratedTree = await rehydrateTreeKeys(tree, secretBytes, signer, privateKey)

      // Remove the member (note: for mesh lists we DON'T rotate the hub secret — we're not the creator)
      // We just remove the leaf and re-build with the same secret
      const result = await removeMemberFromTree(rehydratedTree, targetPubkey)
      if (!result) throw new Error('Member not found in tree')

      // For mesh lists, we keep the original hub secret (not the rotated one)
      // Re-build tree with remaining members using original secret
      const { buildTree } = await import('@/lib/crypto/lkh')
      const remainingLeaves = rehydratedTree.leaves.filter(l => l.pubkey !== targetPubkey)
      const newTree = await buildTree(remainingLeaves, secretBytes)
      const newTreeContent = serializeTree(newTree)

      // Upload new tree
      const treeBytes = new TextEncoder().encode(newTreeContent)
      const { hash: newTreeHash } = await uploadToBlossomServers(treeBytes, signer, privateKey, hub.blossomServers, 'text/plain')

      // Create + upload new index
      const newIndexContent = createIndexFile(newTreeHash, [], index.historyHash || undefined)
      const indexBytes = new TextEncoder().encode(newIndexContent)
      const { hash: newIndexHash } = await uploadToBlossomServers(indexBytes, signer, privateKey, hub.blossomServers, 'text/plain')

      // Update join request
      const hubData = useHubStore.getState().hubs[hub.dTag]
      const creatorPubkey = hubData?.creatorPubkey || ''
      const unsignedEvent = createJoinRequest(hub.dTag, creatorPubkey, newIndexHash)
      const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays([...hub.generalRelays, ...hub.filterRelays]), signedEvent)

      setMeshListHash(newIndexHash)
      setMeshMembers(prev => prev.filter(pk => pk !== targetPubkey))
      console.log('Removed', targetPubkey, 'from facilitation list')

      // Cleanup old files (best-effort, after everything succeeded)
      const { deleteFromBlossom } = await import('@/lib/blossom/client')
      if (index.treeHash && index.treeHash !== newTreeHash) {
        deleteFromBlossom(index.treeHash, signer, privateKey, hub.blossomServers).catch(() => { })
      }
      if (meshListHash && meshListHash !== newIndexHash) {
        deleteFromBlossom(meshListHash, signer, privateKey, hub.blossomServers).catch(() => { })
      }
    } catch (err: any) {
      console.error('Remove from mesh failed:', err)
      setMeshError(err?.message || 'Failed to remove user')
    } finally {
      setMeshBusy(false)
    }
  }, [pubkey, meshBusy, meshListHash, hub, signer, privateKey, hubSecrets])

  if (!open) return null

  const currentFacilitator = hubPrefs.facilitator
  const facProfile = currentFacilitator ? getProfile(currentFacilitator) : null
  const facName = facProfile?.display_name || facProfile?.name || (currentFacilitator ? truncateNpub(nip19.npubEncode(currentFacilitator), 12) : '')

  // Check if current user has ban_members permission
  const myPerms = (() => {
    if (!pubkey) return { ban_members: false }
    return getPermissionsForUser(hub, pubkey, hubMembers)
  })()
  const canModerate = myPerms.ban_members === true && hub.creatorPubkey !== pubkey

  // Check if current user has hide_messages permission
  const canHideMessages = (() => {
    if (!pubkey) return false
    if (hub.creatorPubkey === pubkey) return false // creators use HubSettingsModal
    return getPermissionsForUser(hub, pubkey, hubMembers).hide_messages === true
  })()

  const USER_PAGES = [
    { id: 'messages' as UserHubTab, label: 'Messages', icon: MessagesSquare },
    { id: 'notifications' as UserHubTab, label: 'Notifications', icon: Bell },
    { id: 'voice' as UserHubTab, label: 'Voice Hosting', icon: Volume2 },
    { id: 'reports' as UserHubTab, label: 'My Reports', icon: Flag },
    ...(canModerate ? [{ id: 'moderation' as UserHubTab, label: 'Moderation', icon: ShieldBan }] : []),
    ...(canHideMessages ? [{ id: 'hidden' as UserHubTab, label: 'Hidden Messages', icon: EyeOff }] : []),
  ]

  return (
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
            <nav className="flex flex-col gap-0.5 px-2 flex-1">
              {USER_PAGES.map((page) => (
                <button
                  key={page.id}
                  onClick={() => { setActiveTab(page.id); setMobileShowNav(false) }}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer',
                    'max-[1080px]:py-3',
                    activeTab === page.id
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )}
                >
                  <page.icon size={16} />
                  {page.label}
                  <ChevronRight size={14} className="ml-auto text-muted-foreground min-[1081px]:hidden" />
                </button>
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
                {USER_PAGES.find((p) => p.id === activeTab)?.label}
                </h2>
              </div>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {activeTab === 'notifications' && (
                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Notification Settings</h4>
                  <p className="text-xs text-muted-foreground mb-4">Control which messages trigger unread badges and notifications for this hub.</p>
                  <div className="space-y-1">
                    {/* Master toggle */}
                    <label className="flex items-center justify-between cursor-pointer group p-3 rounded-lg hover:bg-secondary/40 transition-colors">
                      <div className="flex items-center gap-3">
                        <BellOff size={16} className="text-muted-foreground group-hover:text-foreground transition-colors" />
                        <div>
                          <span className="text-sm font-medium text-foreground">Mute all messages</span>
                          <p className="text-xs text-muted-foreground mt-0.5">Suppress all notifications from this hub</p>
                        </div>
                      </div>
                      <ToggleSwitch
                        checked={hubMuteSettings.all ?? false}
                        onChange={(v) => {
                          // Master toggle: set all flags together
                          setHubMuteSettings(hub.dTag, {
                            all: v, normal: v, mentions: v, everyone: v, here: v, roles: v,
                          })
                        }}
                      />
                    </label>

                    <div className="w-full h-px bg-border my-2" />

                    {/* Sub-toggles */}
                    {[
                      { key: 'normal' as const, icon: MessagesSquare, label: 'Mute normal messages', desc: 'Suppress regular (non-mention) messages' },
                      { key: 'mentions' as const, icon: AtSign, label: 'Mute @mentions', desc: 'Suppress personal @npub and @DNN mentions' },
                      { key: 'everyone' as const, icon: UsersRound, label: 'Mute @everyone', desc: 'Suppress @everyone mentions' },
                      { key: 'here' as const, icon: Radio, label: 'Mute @here', desc: 'Suppress @here mentions' },
                      { key: 'roles' as const, icon: Tag, label: 'Mute @roles', desc: 'Suppress @role mentions' },
                    ].map(({ key, icon: Icon, label, desc }) => (
                      <label key={key} className="flex items-center justify-between cursor-pointer group p-3 rounded-lg hover:bg-secondary/40 transition-colors">
                        <div className="flex items-center gap-3">
                          <Icon size={16} className="text-muted-foreground group-hover:text-foreground transition-colors" />
                          <div>
                            <span className="text-sm text-foreground">{label}</span>
                            <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                          </div>
                        </div>
                        <ToggleSwitch
                          checked={hubMuteSettings[key] ?? false}
                          onChange={(v) => {
                            const updated: HubMuteSettings = { ...hubMuteSettings, [key]: v }
                            // Auto-sync master toggle
                            const allSubsOn = !!(updated.normal && updated.mentions && updated.everyone && updated.here && updated.roles)
                            updated.all = allSubsOn
                            setHubMuteSettings(hub.dTag, updated)
                          }}
                        />
                      </label>
                    ))}
                  </div>

                  {/* Save button — only active when settings differ from the snapshot */}
                  {(() => {
                    const ini = initialMuteRef.current
                    const isDirty = (['all', 'normal', 'mentions', 'everyone', 'here', 'roles'] as const).some(
                      (k) => (hubMuteSettings[k] ?? false) !== (ini[k] ?? false)
                    )
                    return (
                      <div className="flex items-center gap-3 mt-4 pt-4 border-t border-border">
                        <button
                          disabled={!isDirty || muteSaving}
                          onClick={async () => {
                            setMuteSaving(true)
                            setMuteSaveResult(null)
                            try {
                              const ok = await publishHubReadState(signer, privateKey)
                              if (ok) {
                                initialMuteRef.current = { ...hubMuteSettings }
                                setMuteSaveResult('saved')
                              } else {
                                setMuteSaveResult('error')
                              }
                            } catch {
                              setMuteSaveResult('error')
                            } finally {
                              setMuteSaving(false)
                            }
                          }}
                          className={cn(
                            'h-9 px-5 rounded-lg text-sm font-medium transition-all flex items-center gap-2',
                            isDirty && !muteSaving
                              ? 'bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer'
                              : 'bg-secondary text-muted-foreground cursor-not-allowed opacity-50'
                          )}
                        >
                          {muteSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                          Save
                        </button>
                        {muteSaveResult === 'saved' && (
                          <span className="text-xs text-emerald-400 flex items-center gap-1">
                            <Check size={12} /> Saved
                          </span>
                        )}
                        {muteSaveResult === 'error' && (
                          <span className="text-xs text-destructive flex items-center gap-1">
                            <AlertTriangle size={12} /> Failed to save
                          </span>
                        )}
                        {!isDirty && !muteSaveResult && (
                          <span className="text-xs text-muted-foreground">No unsaved changes</span>
                        )}
                      </div>
                    )
                  })()}
                </section>
              )}

              {activeTab === 'messages' && (<>
                <section className="mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Message Visibility</h4>
                  <div className="space-y-3">
                    <label className="flex items-center justify-between cursor-pointer group">
                      <div className="flex items-center gap-2">
                        <UserCheck size={14} className="text-muted-foreground group-hover:text-foreground transition-colors" />
                        <span className="text-sm text-foreground">Show facilitated messages</span>
                      </div>
                      <ToggleSwitch
                        checked={hubPrefs.showFacilitatedMessages}
                        onChange={(v) => setHubPref(hub.dTag, 'showFacilitatedMessages', v)}
                      />
                    </label>
                  </div>
                </section>

                {/* Section 2: Facilitator */}
                {!isMember && (
                  <section>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Facilitator</h4>

                    {currentFacilitator ? (
                      /* Already has a facilitator */
                      <div className="space-y-2">
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-secondary/30 border border-border">
                          <Avatar className="h-8 w-8">
                            {facProfile?.picture && <AvatarImage src={facProfile.picture} />}
                            <AvatarFallback className="text-xs bg-emerald-500/20 text-emerald-400">
                              {facName.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{facName}</p>
                            <p className="text-xs text-emerald-400">Facilitator active</p>
                          </div>
                          <button
                            onClick={() => {
                              setHubPref(hub.dTag, 'facilitator', undefined)
                              setSelectedFacilitator(null)
                              setCheckResult(null)
                            }}
                            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-accent/50 transition-colors cursor-pointer"
                          >
                            Change
                          </button>
                        </div>

                        {/* Secret mismatch warning */}
                        {hubPrefs.facilitatorSecret && hubSecrets[hub.dTag] &&
                          hubPrefs.facilitatorSecret !== hubSecrets[hub.dTag] && (
                            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                              <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
                              <div className="text-xs text-amber-200">
                                <p className="font-medium">Secret mismatch</p>
                                <p className="text-amber-300/70 mt-0.5">Your facilitator's secret differs from the hub's current secret. The hub may have rotated keys.</p>
                              </div>
                            </div>
                          )}
                      </div>
                    ) : (
                      /* No facilitator — show search + selection */
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          You are not a direct member. Select a member who has added you to their list as your facilitator to get encryption access.
                        </p>

                        {/* Member search */}
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 border border-border">
                          <Search size={14} className="text-muted-foreground shrink-0" />
                          <input
                            type="text"
                            placeholder="Search members..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                          />
                        </div>

                        {/* Member list */}
                        <div className="max-h-[200px] overflow-y-auto space-y-0.5 rounded-lg border border-border">
                          {filteredMembers.length === 0 ? (
                            <p className="text-xs text-muted-foreground text-center py-4">No members found</p>
                          ) : (
                            filteredMembers.map((m) => {
                              const profile = getProfile(m.pubkey)
                              const npubStr = nip19.npubEncode(m.pubkey)
                              const name = profile?.display_name || profile?.name || truncateNpub(npubStr, 10)
                              const isSelected = selectedFacilitator === m.pubkey

                              return (
                                <button
                                  key={m.pubkey}
                                  onClick={() => {
                                    setSelectedFacilitator(m.pubkey)
                                    setCheckResult(null)
                                    setFacilitatorError(null)
                                  }}
                                  className={`flex items-center gap-2 w-full px-3 py-2 text-left transition-colors cursor-pointer
                              ${isSelected ? 'bg-primary/10' : 'hover:bg-secondary/50'}`}
                                >
                                  <Avatar className="h-7 w-7">
                                    {profile?.picture && <AvatarImage src={profile.picture} />}
                                    <AvatarFallback className="text-[10px] bg-primary/20 text-primary">
                                      {name.slice(0, 2).toUpperCase()}
                                    </AvatarFallback>
                                  </Avatar>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm text-foreground truncate">{name}</p>
                                  </div>
                                  {isSelected && <Check size={14} className="text-primary shrink-0" />}
                                </button>
                              )
                            })
                          )}
                        </div>

                        {/* Check Status + Set as Facilitator */}
                        {selectedFacilitator && (
                          <div className="flex items-center gap-2 pt-1">
                            <button
                              onClick={handleCheckStatus}
                              disabled={checkingStatus}
                              className="flex items-center gap-1.5 flex-1 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed justify-center"
                            >
                              {checkingStatus ? (
                                <><Loader2 size={14} className="animate-spin" /> Checking...</>
                              ) : (
                                <><Search size={14} /> Check Status</>
                              )}
                            </button>

                            <button
                              onClick={handleSetFacilitator}
                              disabled={checkResult !== 'found' || settingFacilitator}
                              className="flex items-center gap-1.5 flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed justify-center"
                            >
                              {settingFacilitator ? (
                                <><Loader2 size={14} className="animate-spin" /> Setting...</>
                              ) : (
                                <><UserCheck size={14} /> Set as Facilitator</>
                              )}
                            </button>
                          </div>
                        )}

                        {/* Status result */}
                        {checkResult === 'found' && (
                          <div className="flex items-center gap-2 text-xs text-emerald-400">
                            <Check size={12} /> You are in this member's list
                          </div>
                        )}
                        {facilitatorError && (
                          <div className="flex items-center gap-2 text-xs text-destructive">
                            <AlertTriangle size={12} /> {facilitatorError}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )}

                {/* Info when user IS a member */}
                {isMember && (
                  <section className="mb-2">
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                      <Lock size={14} className="text-emerald-400" />
                      <span className="text-sm text-emerald-400">You are a member — encryption active</span>
                    </div>
                  </section>
                )}

                {/* Section 3: My Facilitation List (members only) */}
                {isMember && hub.creatorPubkey !== pubkey && (
                  <section>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                      <Users size={12} />
                      My Facilitation List
                    </h4>

                    {meshLoading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
                        <Loader2 size={12} className="animate-spin" /> Loading your list...
                      </div>
                    ) : !meshCreated ? (
                      /* No mesh list yet — offer to create */
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Create a facilitation list to grant non-members access to encrypted messages through your tree.
                        </p>
                        <button
                          onClick={handleCreateMeshList}
                          disabled={meshBusy}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {meshBusy ? (
                            <><Loader2 size={14} className="animate-spin" /> Creating...</>
                          ) : (
                            <><Plus size={14} /> Create Facilitation List</>
                          )}
                        </button>
                      </div>
                    ) : (
                      /* Mesh list exists — show members + add/remove */
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          Facilitating <strong>{meshMembers.length}</strong> user{meshMembers.length !== 1 ? 's' : ''}
                        </p>

                        {/* Current facilitated members */}
                        {meshMembers.length > 0 && (
                          <div className="max-h-[160px] overflow-y-auto space-y-0.5 rounded-lg border border-border">
                            {meshMembers.map((pk) => {
                              const profile = getProfile(pk)
                              const npubStr = nip19.npubEncode(pk)
                              const name = profile?.display_name || profile?.name || truncateNpub(npubStr, 10)
                              return (
                                <div key={pk} className="flex items-center gap-2 px-3 py-2 group">
                                  <Avatar className="h-6 w-6">
                                    {profile?.picture && <AvatarImage src={profile.picture} />}
                                    <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
                                      {name.slice(0, 2).toUpperCase()}
                                    </AvatarFallback>
                                  </Avatar>
                                  <span className="flex-1 text-sm text-foreground truncate">{name}</span>
                                  <button
                                    onClick={() => handleRemoveFromMesh(pk)}
                                    disabled={meshBusy}
                                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all cursor-pointer disabled:opacity-40"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        )}

                        {/* Add member */}
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-2 flex-1 px-3 py-2 rounded-lg bg-secondary/50 border border-border">
                            <Plus size={14} className="text-muted-foreground shrink-0" />
                            <input
                              type="text"
                              placeholder="npub1... or hex pubkey"
                              value={addNpub}
                              onChange={(e) => setAddNpub(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleAddToMesh()}
                              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none px-2 py-1.5 rounded-md"
                            />
                          </div>
                          <button
                            onClick={handleAddToMesh}
                            disabled={meshBusy || !addNpub.trim()}
                            className="px-4 py-3.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                          >
                            {meshBusy ? <Loader2 size={14} className="animate-spin" /> : 'Add'}
                          </button>
                        </div>

                        {meshError && (
                          <div className="flex items-center gap-2 text-xs text-destructive">
                            <AlertTriangle size={12} /> {meshError}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </>)}

              {activeTab === 'voice' && (<>
                {/* Section 4: Voice Hosting */}
                {hasSecret && (
                  <section>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                      <Volume2 size={12} />
                      Voice Hosting
                    </h4>
                    <p className="text-xs text-muted-foreground leading-relaxed mb-2">
                      Provide SFU hosting for this hub's voice channels. Your credentials are encrypted with the hub secret — only members can use them.
                    </p>
                    <button
                      onClick={() => {
                        useNavigationStore.getState().setSettingsSearchPrefill('voice channel')
                        useNavigationStore.getState().setSettingsTab('guides')
                        useNavigationStore.getState().setActivePage('settings')
                        onClose()
                      }}
                      className="inline-flex items-center gap-1.5 text-xs text-primary/80 hover:text-primary transition-colors cursor-pointer mb-3"
                    >
                      <BookOpen size={12} />
                      View setup guide →
                    </button>

                    {/* Epoch mismatch warning — checks both hub and group epochs */}
                    {(() => {
                      const hosts = hostsByHub[hub.dTag] || []
                      const myHost = hosts.find((h) => h.pubkey === pubkey && (voiceScope ? h.groupId === voiceScope : !h.groupId))
                      if (!myHost || myHost.epoch === 0) return null

                      // Determine expected epoch based on scope
                      const expectedEpoch = voiceScope
                        ? hub.groupedRoles?.find((g) => g.groupId === voiceScope)?.epoch ?? hub.epoch
                        : hub.epoch

                      if (myHost.epoch === expectedEpoch) return null

                      // Only show the warning if the user has actual credentials
                      const cfg = myHost.config as any
                      const hasDecryptedCreds = cfg && (
                        (myHost.providerType === 'cloudflare' && (cfg.cfAppId || cfg.cfApiToken)) ||
                        (myHost.providerType === 'livekit' && (cfg.lkUrl || cfg.lkApiKey))
                      )
                      const hasEnteredCreds = voiceProviderType === 'cloudflare'
                        ? !!(cfAppId || cfApiToken)
                        : !!(lkUrl || lkApiKey)

                      if (!hasDecryptedCreds && !hasEnteredCreds) return null

                      // Get scope-specific label for the warning
                      const scopeLabel = voiceScope
                        ? (() => {
                          const group = hub.groupedRoles?.find((g) => g.groupId === voiceScope)
                          if (!group) return 'this group'
                          const roleNames = group.roleIds
                            .map((rid) => hub.roles.find((r) => r.roleId === rid)?.name)
                            .filter(Boolean)
                            .join(', ')
                          return roleNames || 'this group'
                        })()
                        : 'the hub'

                      return (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-3">
                          <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
                          <div className="text-xs text-amber-200">
                            <p className="font-medium">Encryption key changed</p>
                            <p className="text-amber-300/70 mt-0.5">
                              The encryption key for {scopeLabel} has been updated (a member was removed). Re-publish your credentials to encrypt them with the current key. Consider rotating your API credentials in your provider dashboard.
                            </p>
                          </div>
                        </div>
                      )
                    })()}

                    {/* Scope selector — hub-wide or grouped role */}
                    <div className="mb-3">
                      <label className="text-xs text-muted-foreground mb-1 block">Publish scope</label>
                      <CustomSelect
                        value={voiceScope ?? '__hub__'}
                        onChange={(val) => switchVoiceScope(val === '__hub__' ? null : val)}
                        options={[
                          { value: '__hub__', label: 'Hub (all members)' },
                          ...availableGroupScopes
                            .filter((g) => g.roleIds.length > 0)
                            .map((g) => ({ value: g.groupId, label: `Group #${g.groupId.slice(0, 6)}` })),
                        ]}
                        className="w-full"
                      />
                      {/* Contextual helper — channels in the selected scope */}
                      {(() => {
                        if (!voiceScope) return null
                        const scopeChannels = hub.channels
                          .filter((ch) => ch.encryption === voiceScope)
                          .map((ch) => `#${ch.name}`)
                        const scopeCategories = hub.categories
                          .filter((cat) => cat.encryption === voiceScope)
                          .map((cat) => cat.name)
                        const group = availableGroupScopes.find((g) => g.groupId === voiceScope)
                        const roleNames = group?.roleIds
                          .map((rid) => hub.roles.find((r) => r.roleId === rid)?.name)
                          .filter(Boolean) || []
                        return (
                          <div className="mt-1.5 text-[11px] text-muted-foreground/70 leading-relaxed">
                            {roleNames.length > 0 && (
                              <span>Roles: {roleNames.join(', ')}</span>
                            )}
                            {roleNames.length === 0 && group && (
                              <span>Access: creator only</span>
                            )}
                            {(scopeChannels.length > 0 || scopeCategories.length > 0) && (
                              <span>
                                {roleNames.length > 0 || (roleNames.length === 0 && group) ? ' · ' : ''}
                                Channels: {[...scopeCategories, ...scopeChannels].join(', ')}
                              </span>
                            )}
                            {scopeChannels.length === 0 && scopeCategories.length === 0 && (
                              <span>
                                {roleNames.length > 0 || (roleNames.length === 0 && group) ? ' · ' : ''}
                                No channels using this scope yet
                              </span>
                            )}
                          </div>
                        )
                      })()}
                    </div>

                    {/* Per-scope epoch mismatch summary */}
                    {(() => {
                      const hosts = hostsByHub[hub.dTag] || []
                      const myHosts = hosts.filter((h) => h.pubkey === pubkey)
                      const staleScopes: { label: string; scopeKey: string | null }[] = []
                      for (const h of myHosts) {
                        if (h.epoch === 0) continue
                        if (h.groupId) {
                          const group = hub.groupedRoles?.find((g) => g.groupId === h.groupId)
                          if (group && h.epoch !== group.epoch) {
                            staleScopes.push({ label: `Group #${h.groupId.slice(0, 6)}`, scopeKey: h.groupId })
                          }
                        } else if (h.epoch !== hub.epoch) {
                          staleScopes.push({ label: 'Hub (all members)', scopeKey: null })
                        }
                      }
                      if (staleScopes.length === 0) return null
                      return (
                        <div className="my-2 flex flex-col gap-1">
                          {staleScopes.map((s) => (
                            <button
                              key={s.scopeKey ?? '__hub__'}
                              onClick={() => switchVoiceScope(s.scopeKey)}
                              className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/8 border border-amber-500/15 text-[11px] text-amber-400/90 hover:bg-amber-500/15 transition-colors cursor-pointer"
                            >
                              <AlertTriangle size={10} className="shrink-0" />
                              <span>{s.label} — needs re-publish</span>
                            </button>
                          ))}
                        </div>
                      )
                    })()}

                    {/* Provider type selector */}
                    <div className="flex gap-2 mb-3">
                      <button
                        onClick={() => setVoiceProviderType('cloudflare')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer
                    ${voiceProviderType === 'cloudflare'
                            ? 'bg-orange-500/10 text-orange-400 border border-orange-500/30'
                            : 'bg-secondary/50 text-muted-foreground border border-border hover:bg-secondary'}`}
                      >
                        <Globe size={12} />
                        Cloudflare
                      </button>
                      <button
                        onClick={() => setVoiceProviderType('livekit')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer
                    ${voiceProviderType === 'livekit'
                            ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
                            : 'bg-secondary/50 text-muted-foreground border border-border hover:bg-secondary'}`}
                      >
                        <Server size={12} />
                        LiveKit
                      </button>
                    </div>

                    {/* Credential fields */}
                    {voiceProviderType === 'cloudflare' ? (
                      <div className="space-y-2">
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">SFU App ID</label>
                          <input
                            type="text"
                            placeholder="Your Cloudflare Realtime App ID"
                            value={cfAppId}
                            onChange={(e) => setCfAppId(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">SFU API Token</label>
                          <input
                            type="password"
                            placeholder="Bearer token"
                            value={cfApiToken}
                            onChange={(e) => setCfApiToken(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none"
                          />
                        </div>
                        <div className="pt-2 border-t border-border/50">
                          <p className="text-[10px] text-muted-foreground mb-1.5">TURN Relay (required for connectivity)</p>
                          <div className="space-y-2">
                            <div>
                              <label className="text-xs text-muted-foreground mb-1 block">TURN Token ID</label>
                              <input
                                type="text"
                                placeholder="TURN key from CF Dashboard → Realtime → TURN"
                                value={cfTurnKeyId}
                                onChange={(e) => setCfTurnKeyId(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-muted-foreground mb-1 block">TURN API Token</label>
                              <input
                                type="password"
                                placeholder="TURN key API token"
                                value={cfTurnToken}
                                onChange={(e) => setCfTurnToken(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">Server URL</label>
                          <input
                            type="text"
                            placeholder="wss://lk.example.com"
                            value={lkUrl}
                            onChange={(e) => setLkUrl(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">API Key</label>
                          <input
                            type="text"
                            placeholder="API Key"
                            value={lkApiKey}
                            onChange={(e) => setLkApiKey(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">API Secret</label>
                          <input
                            type="password"
                            placeholder="API Secret"
                            value={lkApiSecret}
                            onChange={(e) => setLkApiSecret(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none"
                          />
                        </div>
                      </div>
                    )}

                    {/* Availability toggle */}
                    <div className="flex items-center justify-between mt-3">
                      <div className="flex items-center gap-2">
                        {voiceHostStatus === 'available' ? (
                          <Wifi size={14} className="text-emerald-400" />
                        ) : (
                          <WifiOff size={14} className="text-muted-foreground" />
                        )}
                        <span className="text-sm text-foreground">
                          {voiceHostStatus === 'available' ? 'Hosting Active' : 'Hosting Paused'}
                        </span>
                      </div>
                      <ToggleSwitch
                        checked={voiceHostStatus === 'available'}
                        onChange={(v) => setVoiceHostStatus(v ? 'available' : 'paused')}
                      />
                    </div>

                    {/* Publish button */}
                    <button
                      onClick={async () => {
                        setVoicePublishing(true)
                        setVoiceError(null)
                        setVoiceSaved(false)
                        try {
                          const secret = voiceScope
                            ? groupSecrets[voiceScope]
                            : hubSecrets[hub.dTag]
                          if (!secret) throw new Error(voiceScope ? 'Group secret not available' : 'Hub secret not available — cannot encrypt credentials')

                          // Determine the correct epoch for this scope
                          const epoch = voiceScope
                            ? hub.groupedRoles?.find((g) => g.groupId === voiceScope)?.epoch ?? hub.epoch
                            : hub.epoch

                          const config = voiceProviderType === 'cloudflare'
                            ? {
                              provider: 'cloudflare' as const, cfAppId, cfApiToken, cfTurnKeyId, cfTurnToken,
                            }
                            : { provider: 'livekit' as const, lkUrl, lkApiKey, lkApiSecret }

                          const relays = [...new Set([...hub.generalRelays, ...hub.filterRelays])].filter(Boolean)
                          await publishHostAvailability(
                            hub.dTag, config, voiceHostStatus,
                            epoch, secret, relays, signer, privateKey,
                            voiceScope ?? undefined,
                          )
                          setVoiceSaved(true)
                          setTimeout(() => setVoiceSaved(false), 3000)
                        } catch (err: any) {
                          setVoiceError(err?.message || 'Failed to publish')
                        } finally {
                          setVoicePublishing(false)
                        }
                      }}
                      disabled={voicePublishing || (() => {
                        // All fields must be filled
                        const allFilled = voiceProviderType === 'cloudflare'
                          ? !!(cfAppId && cfApiToken && cfTurnKeyId && cfTurnToken)
                          : !!(lkUrl && lkApiKey && lkApiSecret)
                        if (!allFilled) return true
                        // Check if values differ from what's already published
                        const hosts = hostsByHub[hub.dTag] || []
                        const myHost = hosts.find((h) => h.pubkey === pubkey && (voiceScope ? h.groupId === voiceScope : !h.groupId))
                        if (!myHost) return false // no prior event — always allow
                        // Epoch mismatch — needs re-publish
                        const expectedEpoch = voiceScope
                          ? hub.groupedRoles?.find((g) => g.groupId === voiceScope)?.epoch ?? hub.epoch
                          : hub.epoch
                        if (myHost.epoch !== expectedEpoch) return false
                        // Config not yet decrypted — allow publish
                        if (!myHost.config) return false
                        // Provider type changed
                        if (myHost.providerType !== voiceProviderType) return false
                        // Status changed
                        if (myHost.status !== voiceHostStatus) return false
                        // Compare credential fields
                        const cfg = myHost.config as any
                        if (voiceProviderType === 'cloudflare') {
                          return cfg?.cfAppId === cfAppId && cfg?.cfApiToken === cfApiToken &&
                            cfg?.cfTurnKeyId === cfTurnKeyId && cfg?.cfTurnToken === cfTurnToken
                        } else {
                          return cfg?.lkUrl === lkUrl && cfg?.lkApiKey === lkApiKey &&
                            cfg?.lkApiSecret === lkApiSecret
                        }
                      })()}
                      className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {voicePublishing ? (
                        <><Loader2 size={14} className="animate-spin" /> Publishing...</>
                      ) : voiceSaved ? (
                        <><Check size={14} /> Saved!</>
                      ) : (
                        'Save & Publish'
                      )}
                    </button>

                    {voiceError && (
                      <div className="flex items-center gap-2 text-xs text-destructive mt-1">
                        <AlertTriangle size={12} /> {voiceError}
                      </div>
                    )}
                  </section>
                )}
                {!hasSecret && (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Lock size={24} className="mb-2" />
                    <p className="text-sm">Hub secret required for voice hosting</p>
                  </div>
                )}
              </>)}

              {activeTab === 'reports' && (
                <MyReportsPage hub={hub} onClose={onClose} />
              )}

              {activeTab === 'moderation' && (
                <>
                  {/* My Ban List */}
                  <section>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                      <ShieldBan size={12} />
                      My Ban List
                    </h4>
                    <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                      Users you ban here will have their messages hidden for all hub members who load your moderation list. The hub creator can review and override your bans.
                    </p>

                    {/* Add user to ban list */}
                    <div className="flex items-center gap-2 mb-3">
                      <input
                        type="text"
                        placeholder="npub or hex pubkey to ban..."
                        value={banNpub}
                        onChange={(e) => setBanNpub(e.target.value)}
                        className="flex-1 px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none"
                      />
                      <button
                        onClick={async () => {
                          if (!pubkey || modBanBusy || !banNpub.trim()) return
                          setModBanBusy(true)
                          setModBanError(null)
                          setModBanSteps([])
                          setModBanActionType('ban')

                          const markStep = async (step: string) => {
                            setModBanStep(step)
                            await new Promise(r => setTimeout(r, 0))
                          }
                          const markDone = (step: string) => setModBanSteps(prev => [...prev, step])

                          try {
                            let targetPubkey: string
                            const trimmed = banNpub.trim()
                            if (trimmed.startsWith('npub1')) {
                              const decoded = nip19.decode(trimmed)
                              if (decoded.type !== 'npub') throw new Error('Invalid npub')
                              targetPubkey = decoded.data
                            } else if (/^[0-9a-f]{64}$/i.test(trimmed)) {
                              targetPubkey = trimmed.toLowerCase()
                            } else {
                              throw new Error('Enter a valid npub or hex pubkey')
                            }
                            if (targetPubkey === pubkey) throw new Error('Cannot ban yourself')
                            if (myBanList.includes(targetPubkey)) throw new Error('Already in your ban list')

                            await markStep('Fetching join request')
                            const { downloadTextFromBlossom, parseIndexFile, uploadToBlossomServers, uploadBanPages, createIndexFile } = await import('@/lib/blossom')
                            const { createJoinRequest, signWithSigner: signFn } = await import('@/lib/nostr/events')
                            const { publishToSpecificRelays: pubToRelays, fetchEvents: fetchEvt } = await import('@/lib/nostr/relay-pool')
                            const { getPublishRelays: getRelays } = await import('@/stores/postingBehaviourStore')
                            const { KINDS } = await import('@/lib/crypto/constants')

                            const joinRequests = await fetchEvt({ kinds: [KINDS.JOIN_REQUEST], authors: [pubkey], '#d': [hub.dTag], limit: 1 })
                            let existingTreeHash = ''
                            let existingHistoryHash = ''
                            if (joinRequests.length > 0) {
                              const listTag = joinRequests[0].tags.find((t: string[]) => t[0] === 'list')
                              if (listTag?.[1]) {
                                try {
                                  const indexContent = await downloadTextFromBlossom(listTag[1], hub.blossomServers)
                                  const index = parseIndexFile(indexContent)
                                  existingTreeHash = index.treeHash
                                  existingHistoryHash = index.historyHash
                                } catch { /* fresh */ }
                              }
                            }
                            markDone('Fetching join request')

                            await markStep('Uploading ban page')
                            const allBans = [...myBanList, targetPubkey]
                            const banPageHashes = await uploadBanPages(
                              allBans.map(pk => ({ pubkey: pk, reason: '' })),
                              signer, privateKey, hub.blossomServers,
                            )
                            markDone('Uploading ban page')

                            await markStep('Uploading index file')
                            const newIndexContent = createIndexFile(existingTreeHash, banPageHashes, existingHistoryHash || undefined)
                            const indexBytes = new TextEncoder().encode(newIndexContent)
                            const { hash: newIndexHash } = await uploadToBlossomServers(indexBytes, signer, privateKey, hub.blossomServers, 'text/plain')
                            markDone('Uploading index file')

                            await markStep('Publishing join request')
                            const unsignedEvent = createJoinRequest(hub.dTag, hub.creatorPubkey, newIndexHash)
                            const signedEvent = await signFn(unsignedEvent, signer, privateKey)
                            await pubToRelays(getRelays([...hub.generalRelays, ...hub.filterRelays]), signedEvent)
                            markDone('Publishing join request')

                            useHubStore.getState().setModBanList(hub.dTag, pubkey, allBans)
                            setMyBanList(allBans)
                            setBanNpub('')

                            await markStep('Done')
                          } catch (err: any) {
                            setModBanError(err?.message || 'Failed to ban')
                          } finally {
                            setModBanBusy(false)
                            setModBanStep(null)
                          }
                        }}
                        disabled={modBanBusy || !banNpub.trim()}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm hover:bg-destructive/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {modBanBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                        Ban
                      </button>
                    </div>

                    {modBanError && (
                      <div className="flex items-center gap-2 text-xs text-destructive mb-2">
                        <AlertTriangle size={12} /> {modBanError}
                      </div>
                    )}

                    {/* Ban list entries */}
                    {myBanList.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-6">Your ban list is empty</p>
                    ) : (
                      <div className="space-y-1 max-h-[240px] overflow-y-auto">
                        {myBanList.map((pk) => {
                          const p = getProfile(pk)
                          const name = p?.display_name || p?.name || truncateNpub(nip19.npubEncode(pk), 10)
                          return (
                            <div key={pk} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
                              <Avatar className="h-7 w-7">
                                {p?.picture && <AvatarImage src={p.picture} />}
                                <AvatarFallback className="text-[10px] bg-destructive/20 text-destructive">
                                  {name.slice(0, 2).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                              <span className="flex-1 text-sm text-foreground truncate">{name}</span>
                              <TooltipProvider delayDuration={300}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      onClick={async () => {
                                        if (modBanBusy || !pubkey) return
                                        setModBanBusy(true)
                                        setModBanError(null)
                                        setModBanSteps([])
                                        setModBanActionType('unban')

                                        const markStep = async (step: string) => {
                                          setModBanStep(step)
                                          await new Promise(r => setTimeout(r, 0))
                                        }
                                        const markDone = (step: string) => setModBanSteps(prev => [...prev, step])

                                        try {
                                          await markStep('Fetching join request')
                                          const { downloadTextFromBlossom, parseIndexFile, uploadToBlossomServers, uploadBanPages, createIndexFile } = await import('@/lib/blossom')
                                          const { createJoinRequest, signWithSigner: signFn } = await import('@/lib/nostr/events')
                                          const { publishToSpecificRelays: pubToRelays, fetchEvents: fetchEvt } = await import('@/lib/nostr/relay-pool')
                                          const { getPublishRelays: getRelays } = await import('@/stores/postingBehaviourStore')
                                          const { KINDS } = await import('@/lib/crypto/constants')

                                          const joinRequests = await fetchEvt({ kinds: [KINDS.JOIN_REQUEST], authors: [pubkey], '#d': [hub.dTag], limit: 1 })
                                          let existingTreeHash = ''
                                          let existingHistoryHash = ''
                                          if (joinRequests.length > 0) {
                                            const listTag = joinRequests[0].tags.find((t: string[]) => t[0] === 'list')
                                            if (listTag?.[1]) {
                                              try {
                                                const indexContent = await downloadTextFromBlossom(listTag[1], hub.blossomServers)
                                                const index = parseIndexFile(indexContent)
                                                existingTreeHash = index.treeHash
                                                existingHistoryHash = index.historyHash
                                              } catch { /* ok */ }
                                            }
                                          }
                                          markDone('Fetching join request')

                                          await markStep('Uploading ban page')
                                          const newBans = myBanList.filter(p => p !== pk)
                                          let banPageHashes: string[] = []
                                          if (newBans.length > 0) {
                                            banPageHashes = await uploadBanPages(
                                              newBans.map(p => ({ pubkey: p, reason: '' })),
                                              signer, privateKey, hub.blossomServers,
                                            )
                                          }
                                          markDone('Uploading ban page')

                                          await markStep('Uploading index file')
                                          const newIndexContent = createIndexFile(existingTreeHash, banPageHashes, existingHistoryHash || undefined)
                                          const indexBytes = new TextEncoder().encode(newIndexContent)
                                          const { hash: newIndexHash } = await uploadToBlossomServers(indexBytes, signer, privateKey, hub.blossomServers, 'text/plain')
                                          markDone('Uploading index file')

                                          await markStep('Publishing join request')
                                          const unsignedEvent = createJoinRequest(hub.dTag, hub.creatorPubkey, newIndexHash)
                                          const signedEvent = await signFn(unsignedEvent, signer, privateKey)
                                          await pubToRelays(getRelays([...hub.generalRelays, ...hub.filterRelays]), signedEvent)
                                          markDone('Publishing join request')

                                          useHubStore.getState().setModBanList(hub.dTag, pubkey, newBans)
                                          setMyBanList(newBans)

                                          await markStep('Done')
                                        } catch (err: any) {
                                          setModBanError(err?.message || 'Failed to unban')
                                        } finally {
                                          setModBanBusy(false)
                                          setModBanStep(null)
                                        }
                                      }}
                                      disabled={modBanBusy}
                                      className="text-xs text-muted-foreground hover:text-destructive transition-colors cursor-pointer disabled:opacity-40"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="text-xs">Remove from ban list</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </section>

                  {/* Other Moderators */}
                  {(() => {
                    // Find other members with ban_members permission who have ban lists
                    const otherMods = hubMembers.filter(m => {
                      if (m.pubkey === pubkey || m.pubkey === hub.creatorPubkey) return false
                      const perms = getPermissionsForUser(hub, m.pubkey, hubMembers)
                      return perms.ban_members === true
                    })
                    const modsWithBans = otherMods.filter(m => (modBanLists[m.pubkey]?.length ?? 0) > 0)

                    if (modsWithBans.length === 0 && otherMods.length <= 0) return null

                    return (
                      <section className="mt-6">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                          <Users size={12} />
                          Other Moderators
                        </h4>

                        {otherMods.length === 0 ? (
                          <p className="text-xs text-muted-foreground text-center py-4">No other moderators with ban permission</p>
                        ) : (
                          <>
                            <CustomSelect
                              value={selectedMod || ''}
                              onChange={async (val) => {
                                const modPk = val || null
                                setSelectedMod(modPk)
                                setOtherModBanList([])
                                if (modPk && modBanLists[modPk]) {
                                  setOtherModBanList(modBanLists[modPk])
                                } else if (modPk) {
                                  // Try fetching from Blossom
                                  setOtherModLoading(true)
                                  try {
                                    const { downloadTextFromBlossom, parseIndexFile, downloadBanList: dlBans } = await import('@/lib/blossom')
                                    const { fetchEvents: fetchEvt } = await import('@/lib/nostr/relay-pool')
                                    const { KINDS } = await import('@/lib/crypto/constants')
                                    const jrs = await fetchEvt({ kinds: [KINDS.JOIN_REQUEST], authors: [modPk], '#d': [hub.dTag], limit: 1 })
                                    if (jrs.length > 0) {
                                      const listTag = jrs[0].tags.find((t: string[]) => t[0] === 'list')
                                      if (listTag?.[1]) {
                                        const ic = await downloadTextFromBlossom(listTag[1], hub.blossomServers)
                                        const idx = parseIndexFile(ic)
                                        if (idx.banPages.length > 0) {
                                          const entries = await dlBans(idx.banPages, hub.blossomServers)
                                          const pks = entries.map(e => e.pubkey)
                                          setOtherModBanList(pks)
                                          useHubStore.getState().setModBanList(hub.dTag, modPk, pks)
                                        }
                                      }
                                    }
                                  } catch { /* ignore */ }
                                  setOtherModLoading(false)
                                }
                              }}
                              options={[
                                { value: '', label: 'Select a moderator...' },
                                ...otherMods.map((m) => {
                                  const p = getProfile(m.pubkey)
                                  const name = p?.display_name || p?.name || truncateNpub(nip19.npubEncode(m.pubkey), 10)
                                  const banCount = modBanLists[m.pubkey]?.length || 0
                                  return {
                                    value: m.pubkey,
                                    label: `${name}${banCount > 0 ? ` (${banCount} ban${banCount !== 1 ? 's' : ''})` : ''}`,
                                  }
                                }),
                              ]}
                              className="w-full mb-3"
                            />

                            {selectedMod && (
                              otherModLoading ? (
                                <div className="flex items-center justify-center py-4">
                                  <Loader2 size={16} className="animate-spin text-muted-foreground" />
                                </div>
                              ) : otherModBanList.length === 0 ? (
                                <p className="text-xs text-muted-foreground text-center py-4">No bans from this moderator</p>
                              ) : (
                                <div className="space-y-1 max-h-[200px] overflow-y-auto">
                                  {otherModBanList.map((pk) => {
                                    const p = getProfile(pk)
                                    const name = p?.display_name || p?.name || truncateNpub(nip19.npubEncode(pk), 10)
                                    const isWhitelisted = hubMembers.find(m => m.pubkey === pk)?.flags?.includes('w')
                                    // Count how many mods banned this person
                                    const modCount = Object.values(modBanLists).filter(list => list.includes(pk)).length

                                    return (
                                      <div key={pk} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
                                        <Avatar className="h-7 w-7">
                                          {p?.picture && <AvatarImage src={p.picture} />}
                                          <AvatarFallback className="text-[10px] bg-destructive/20 text-destructive">
                                            {name.slice(0, 2).toUpperCase()}
                                          </AvatarFallback>
                                        </Avatar>
                                        <span className="flex-1 text-sm text-foreground truncate">{name}</span>
                                        {modCount > 1 && (
                                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">
                                            {modCount} mods
                                          </span>
                                        )}
                                        {isWhitelisted && (
                                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">
                                            Overridden
                                          </span>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              )
                            )}
                          </>
                        )}
                      </section>
                    )
                  })()}
                </>
              )}

              {activeTab === 'hidden' && (
                <ModHiddenMessagesTab hub={hub} onClose={onClose} />
              )}
            </div>
          </div>
        </div>
      </div>
      {/* Mod ban/unban progress overlay */}
      {(modBanBusy || modBanSteps.length > 0) && createPortal(
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.stopPropagation()}>
          <div className="bg-card rounded-xl border border-border shadow-2xl w-[340px] p-5 space-y-4 animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2.5">
              {modBanSteps.includes('Publishing join request') && !modBanError ? (
                <div className="w-8 h-8 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                  <Check size={16} className="text-emerald-400" />
                </div>
              ) : modBanError ? (
                <div className="w-8 h-8 rounded-full bg-destructive/15 flex items-center justify-center shrink-0">
                  <AlertTriangle size={16} className="text-destructive" />
                </div>
              ) : (
                <div className="w-8 h-8 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0">
                  <Loader2 size={16} className="text-amber-400 animate-spin" />
                </div>
              )}
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  {modBanError ? 'Operation Failed' : modBanSteps.includes('Publishing join request') ? (modBanActionType === 'ban' ? 'User Mod Banned' : 'User Mod Unbanned') : (modBanActionType === 'ban' ? 'Mod Banning User...' : 'Unbanning User...')}
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  {modBanError ? modBanError : modBanSteps.includes('Publishing join request') ? 'All steps completed successfully' : modBanStep || 'Starting...'}
                </p>
              </div>
            </div>

            {/* Step list */}
            <div className="space-y-1.5">
              {['Fetching join request', 'Uploading ban page', 'Uploading index file', 'Publishing join request'].map((step) => {
                const isDone = modBanSteps.includes(step)
                const isCurrent = modBanStep === step
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
            {(modBanSteps.includes('Publishing join request') || modBanError) && (
              <button
                onClick={() => { setModBanSteps([]); setModBanError(null) }}
                className={cn(
                  'w-full h-8 text-xs rounded-lg font-medium transition-colors cursor-pointer',
                  modBanError
                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                )}
              >
                {modBanError ? 'Dismiss' : 'Done'}
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

// ── My Reports Page ──

const MY_REPORT_TYPE_COLORS: Record<string, string> = {
  spam: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  nudity: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
  profanity: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  illegal: 'bg-red-500/15 text-red-400 border-red-500/30',
  malware: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  impersonation: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  other: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
}

function MyReportsPage({ hub, onClose }: { hub: HubData; onClose: () => void }) {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const secret = useHubStore((s) => s.hubSecrets[hub.dTag])
  const { getProfile } = useProfileCache()
  const fetchMyReports = useReportStore((s) => s.fetchMyReports)
  const retractReport = useReportStore((s) => s.retractReport)
  const myReportsRaw = useReportStore((s) => s.myReportsByHub[hub.dTag])
  const loadingRaw = useReportStore((s) => s.loadingMy[hub.dTag])

  const myReports = myReportsRaw ?? EMPTY_MY_REPORTS
  const loading = loadingRaw ?? false
  const [retractingId, setRetractingId] = useState<string | null>(null)

  useEffect(() => {
    if (!secret || !pubkey) return
    const relays = [...new Set([...hub.filterRelays, ...hub.generalRelays])].filter(Boolean)
    fetchMyReports(hub.dTag, hub.creatorPubkey, secret, pubkey, relays)
  }, [secret, pubkey, hub.dTag])

  const handleRetract = useCallback(async (report: HubReport) => {
    if (!secret || !pubkey) return
    setRetractingId(report.dTag)
    try {
      const relays = [...new Set([...hub.filterRelays, ...hub.generalRelays])].filter(Boolean)
      await retractReport({
        report,
        hubDTag: hub.dTag,
        hubCreatorPubkey: hub.creatorPubkey,
        hubSecretHex: secret,
        epoch: hub.epoch,
        relays,
        signer,
        privateKey,
        pubkey,
        minPow: hub.minPow > 0 ? hub.minPow : undefined,
      })
    } catch (err: any) {
      console.error('Failed to retract report:', err)
    } finally {
      setRetractingId(null)
    }
  }, [secret, pubkey, hub, signer, privateKey, retractReport])

  if (!secret) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Lock size={24} className="mb-2" />
        <p className="text-sm">Hub secret required to view reports</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={18} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (myReports.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Flag size={24} className="mb-2 opacity-40" />
        <p className="text-sm">No reports submitted</p>
        <p className="text-xs mt-1">Use the message dropdown or profile modal to report a user</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {myReports.map((report) => {
        const violatorProfile = getProfile(report.reportedPubkey)
        const violatorName = violatorProfile?.display_name || violatorProfile?.name ||
          truncateNpub(nip19.npubEncode(report.reportedPubkey), 12)
        const typeColor = MY_REPORT_TYPE_COLORS[report.reportType] || MY_REPORT_TYPE_COLORS.other

        return (
          <MyReportCard
            key={report.dTag}
            report={report}
            violatorProfile={violatorProfile}
            violatorName={violatorName}
            typeColor={typeColor}
            hub={hub}
            retractingId={retractingId}
            onRetract={handleRetract}
            onClose={onClose}
          />
        )
      })}
    </div>
  )
}

function MyReportCard({ report, violatorProfile, violatorName, typeColor, hub, retractingId, onRetract, onClose }: {
  report: HubReport
  violatorProfile: any
  violatorName: string
  typeColor: string
  hub: HubData
  retractingId: string | null
  onRetract: (report: HubReport) => void
  onClose: () => void
}) {
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
    const hubMessages = useMessageStore.getState().messages[hub.dTag] || {}
    let targetChannelId: string | null = null
    for (const channelId of Object.keys(hubMessages)) {
      const msg = hubMessages[channelId].find(m => m.dTag === msgDTag && m.pubkey === msgPubkey)
      if (msg) { targetChannelId = channelId; break }
    }
    if (targetChannelId) {
      useHubStore.getState().setActiveChannel(targetChannelId)
    }
    onClose()
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('pin-jump-to-message', {
        detail: { aRef: report.reportedMessageATag }
      }))
    }, 150)
  }, [report.reportedMessageATag, hub.dTag, onClose])

  return (
    <div
      className={`p-3 rounded-lg border transition-colors ${report.status === 'retracted'
        ? 'bg-secondary/20 border-border/50 opacity-60'
        : 'bg-secondary/30 border-border'
        }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => setProfilePubkey(report.reportedPubkey)}
          className="flex items-center gap-1.5 min-w-0 hover:opacity-80 transition-opacity cursor-pointer"
        >
          <Avatar className="h-5 w-5">
            {violatorProfile?.picture && <AvatarImage src={violatorProfile.picture} />}
            <AvatarFallback className="text-[8px] bg-red-500/20 text-red-400">
              {violatorName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="text-sm font-medium text-foreground truncate hover:underline">{violatorName}</span>
        </button>
        <div className="flex-1" />
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
      {/* Reason */}
      {report.reasonText && (
        <p className="text-sm text-foreground/80 mb-1.5 leading-relaxed">{report.reasonText}</p>
      )}
      {/* Message preview + jump */}
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
      {/* Footer: timestamp + retract */}
      <div className="flex items-center justify-between mt-2">
        <p className="text-[10px] text-muted-foreground">
          {new Date(report.createdAt * 1000).toLocaleString()}
        </p>
        {report.status === 'open' && (
          <button
            onClick={() => onRetract(report)}
            disabled={retractingId === report.dTag}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-amber-400 transition-colors cursor-pointer disabled:opacity-40"
          >
            {retractingId === report.dTag ? (
              <><Loader2 size={10} className="animate-spin" /> Retracting...</>
            ) : (
              <><Undo2 size={10} /> Retract</>
            )}
          </button>
        )}
      </div>
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

// ── Moderator Hidden Messages Tab ──


const MOD_HIDDEN_PER_PAGE = 10

const MOD_KIND_BADGES: Record<number, { label: string; className: string }> = {
  36943: { label: 'Message', className: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  1067: { label: 'Poll', className: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
  31923: { label: 'Calendar', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
}

function ModHiddenMessagesTab({ hub, onClose }: { hub: HubData; onClose: () => void }) {
  const [subTab, setSubTab] = useState<'mine' | 'others'>('mine')
  const [entries, setEntries] = useState<HideEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [unhidingRef, setUnhidingRef] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const { getProfile } = useProfileCache()
  const hubMembers = useHubStore((s) => s.hubMembers[hub.dTag]) || []
  const pubkey = useUserStore((s) => s.pubkey)

  // Build list of all authorized hiders (creator + mods)
  const authorizedPubkeys = useMemo(() => {
    const pks: string[] = [hub.creatorPubkey]
    for (const m of hubMembers) {
      if (m.pubkey === hub.creatorPubkey) continue
      const perms = getPermissionsForUser(hub, m.pubkey, hubMembers)
      if (perms.hide_messages) pks.push(m.pubkey)
    }
    return pks
  }, [hub, hubMembers])

  const fetchHideEvents = useCallback(async () => {
    setLoading(true)
    try {
      const { fetchEvents } = await import('@/lib/nostr/relay-pool')
      const { parseHideEvent } = await import('@/hooks/useHideMessages')
      const { KINDS } = await import('@/lib/crypto/constants')

      if (authorizedPubkeys.length === 0) { setLoading(false); return }

      const events = await fetchEvents({
        kinds: [KINDS.HIDE_MESSAGE],
        authors: authorizedPubkeys,
        '#h': [hub.dTag],
      } as any)

      const parsed: HideEntry[] = []
      for (const ev of events) {
        const entry = parseHideEvent(ev)
        if (!entry) continue
        if (!authorizedPubkeys.includes(entry.hiderPubkey)) continue
        parsed.push(entry)
      }

      parsed.sort((a, b) => b.createdAt - a.createdAt)
      setEntries(parsed)
    } catch (err) {
      console.error('[ModHiddenMessagesTab] Failed to fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [hub, authorizedPubkeys])

  useEffect(() => { fetchHideEvents() }, [fetchHideEvents])
  useEffect(() => { setPage(1) }, [subTab])

  // Filter by sub-tab
  const filtered = useMemo(() => {
    if (subTab === 'mine') return entries.filter(e => e.hiderPubkey === pubkey)
    return entries.filter(e => e.hiderPubkey !== pubkey)
  }, [entries, subTab, pubkey])

  const totalPages = Math.max(1, Math.ceil(filtered.length / MOD_HIDDEN_PER_PAGE))
  const safePage = Math.min(page, totalPages)
  const pageEntries = filtered.slice((safePage - 1) * MOD_HIDDEN_PER_PAGE, safePage * MOD_HIDDEN_PER_PAGE)

  // Unhide handler — mods can only unhide their own items
  const handleUnhide = useCallback(async (entry: HideEntry) => {
    if (entry.hiderPubkey !== pubkey) return // safety check
    setUnhidingRef(entry.ref)
    try {
      const { createDeletedHideEvent, createDeletionEvent } = await import('@/lib/nostr/events')
      const { signWithSigner: signFn } = await import('@/lib/nostr')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
      const { KINDS } = await import('@/lib/crypto/constants')
      const { signer, privateKey } = useUserStore.getState()
      const relays = [...hub.filterRelays, ...hub.generalRelays]
      const publishRelays = getPublishRelays(relays)

      const deletedHide = createDeletedHideEvent(hub.dTag, entry.ref, entry.createdAt)
      const signedDeleted = await signFn(deletedHide, signer, privateKey)
      await publishToSpecificRelays(publishRelays, signedDeleted)

      const dTag = `${hub.dTag}:${entry.ref}`
      const aRef = `${KINDS.HIDE_MESSAGE}:${pubkey}:${dTag}`
      const deletionReq = createDeletionEvent([], [aRef], 'unhide')
      const signedDeletion = await signFn(deletionReq, signer, privateKey)
      await publishToSpecificRelays(publishRelays, signedDeletion)

      useHubStore.getState().removeHiddenMessage(hub.dTag, entry.ref)
      setEntries(prev => prev.filter(e => e.ref !== entry.ref))
    } catch (err) {
      console.error('[ModHiddenMessagesTab] Unhide failed:', err)
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
    const parts = entry.ref.split(':')
    if (parts.length >= 3) {
      const msgPubkey = parts[1]
      const msgDTag = parts.slice(2).join(':')
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
      {/* Sub-tab bar */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 bg-secondary/50 rounded-lg p-1">
          <button
            onClick={() => setSubTab('mine')}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
              subTab === 'mine' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            My Hidden Messages
          </button>
          <button
            onClick={() => setSubTab('others')}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
              subTab === 'others' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Others
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
            {subTab === 'mine' ? 'You haven\'t hidden any messages.' : 'No hidden messages from other moderators.'}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-1">
            {pageEntries.map((entry) => {
              const targetProfile = getProfile(entry.targetPubkey)
              const targetName = targetProfile?.display_name || targetProfile?.name || (entry.targetPubkey ? truncateNpub(nip19.npubEncode(entry.targetPubkey)) : 'Unknown')
              const badge = MOD_KIND_BADGES[entry.kind] || { label: `Kind ${entry.kind}`, className: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' }

              // For "others" tab, show who hid it
              const isOther = subTab === 'others'
              const hiderProfile = isOther ? getProfile(entry.hiderPubkey) : null
              const hiderName = hiderProfile ? (hiderProfile.display_name || hiderProfile.name || truncateNpub(nip19.npubEncode(entry.hiderPubkey))) : null
              const isCreatorHide = entry.hiderPubkey === hub.creatorPubkey

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
                      {isOther && hiderName && (
                        <span className="text-[10px] text-amber-400 block">
                          hidden by {hiderName}{isCreatorHide ? ' (creator)' : ''}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Timestamp */}
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {formatTimeAgo(entry.createdAt)}
                  </span>

                  {/* Unhide button — only for own items */}
                  {subTab === 'mine' && (
                    <button
                      onClick={() => handleUnhide(entry)}
                      disabled={unhidingRef === entry.ref}
                      className="text-[11px] px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-pointer font-medium shrink-0 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                    >
                      {unhidingRef === entry.ref && <Loader2 size={10} className="animate-spin" />}
                      {unhidingRef === entry.ref ? 'Unhiding…' : 'Unhide'}
                    </button>
                  )}

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

/** Simple toggle switch component — matches HubSettingsModal style */
function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0
        ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
    >
      <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform
        ${checked ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
    </button>
  )
}
