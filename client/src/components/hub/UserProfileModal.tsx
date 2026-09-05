/**
 * UserProfileModal — View any user's Nostr profile (kind:0)
 *
 * When viewing self: Edit Profile button in banner, no Follow button
 * When viewing others: Follow button, DM button, "View Social Posts", Block
 * Always: banner, avatar, name, npub (copy), bio, nip-05, website, lightning
 */

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { useUserStore } from '@/stores/userStore'
import { useBlockStore } from '@/stores/blockStore'
import type { BlockType } from '@/stores/blockStore'
import { BlockTypeModal } from '@/components/ui/BlockTypeModal'
import { FollowSafetyModal } from '@/components/ui/FollowSafetyModal'
import { useFollowStore } from '@/stores/followStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useDMStore } from '@/stores/dmStore'
import { useDM04Store } from '@/stores/dm04Store'
import { useSocialStore } from '@/stores/socialStore'
import { useHubStore } from '@/stores/hubStore'
import {
  X, Copy, Check, Pencil, UserPlus, UserMinus, ExternalLink,
  MoreVertical, ShieldBan, ShieldCheck, MessageCircle,
  Globe, Zap, AtSign, Camera, ImageIcon, Loader2, XCircle, AlertTriangle,
  Link2, Flag, BadgeCheck, RotateCw, Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { uploadToBlossomServers, blossomServers as blossomServerManager } from '@/lib/blossom'
import { ImageCropModal } from '@/components/ui/ImageCropModal'
import type { UploadProgress } from '@/lib/blossom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { fetchEvents, publishToSpecificRelays, publishCriticalWithFailover } from '@/lib/nostr/relay-pool'
import { publishPersonal, getPublishRelays } from '@/stores/postingBehaviourStore'
import { signWithSigner } from '@/lib/nostr/events'
import { nip19 } from 'nostr-tools'
import { LinksViewerModal, LinksEditorModal } from '@/components/hub/LinksModal'
import { ReportModal } from '@/components/hub/ReportModal'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { useDnnStore } from '@/stores/dnnStore'
import { isDnnId } from '@/lib/dnn/dnnUtils'
import { formatDnnId } from '@/lib/dnn/formatDnnId'
import { getPermissionsForUser } from '@/lib/hub/permissions'
import { useProfileCache, updateCachedProfile } from '@/hooks/useProfileCache'

/** Banner image with blossom fallback */
function BlossomBannerImg({ src }: { src: string }) {
  const blossom = useBlossomMedia(src)
  return <img src={blossom.src || src} alt="Banner" className="w-full h-full object-cover" />
}

interface UserProfileModalProps {
  open: boolean
  onClose: () => void
  /** Pubkey to display. If omitted, shows logged-in user's profile. */
  targetPubkey?: string | null
  /** Navigate to social profile page */
  onViewSocialPosts?: (pubkey: string) => void
  /** Navigate to DM conversation with this user */
  onDM?: (pubkey: string) => void
  /** If true, open directly in edit mode */
  startEditing?: boolean
  /** Hub context for ban actions (only when opened from hub) */
  hubContext?: { dTag: string; creatorPubkey: string; ownerRealPubkey?: string } | null
}

interface ProfileData {
  name: string
  display_name: string
  about: string
  picture: string
  banner: string
  nip05: string
  website: string
  lud16: string
}

/** Client-side cap for the NIP-38 general status text. */
const STATUS_MAX = 128

const EMPTY_PROFILE: ProfileData = {
  name: '',
  display_name: '',
  about: '',
  picture: '',
  banner: '',
  nip05: '',
  website: '',
  lud16: '',
}

// Ban/remove progress step labels — MUST match the labels the running flow actually emits, or the
// unmatched rows never light up (they'd sit greyed while the flow reports "completed"). There are three
// flows: the v1 creator ban (inline, below), the v2 member kick/ban (lib/hub/v2kick), and the v2
// non-member ban (ban-page rewrite only). Each emits a different set of step labels.
const V1_CREATOR_BAN_STEPS = ['Downloading index & tree', 'Removing member & rotating secret', 'Rotating group encryption', 'Uploading ban page & index', 'Publishing hub event']
const V2_MEMBER_BAN_STEPS = ['Downloading index & tree', 'Removing member & rotating secret', 'Uploading page & spine', 'Building index', 'Publishing hub event']
const V2_NONMEMBER_BAN_STEPS = ['Downloading index & tree', 'Uploading ban pages', 'Publishing hub event']

export function UserProfileModal({ open, onClose, targetPubkey, onViewSocialPosts, onDM, startEditing: startEditingProp, hubContext }: UserProfileModalProps) {
  useEscToClose(onClose, open)
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const setUserProfile = useUserStore((s) => s.setProfile)
  const isBlocked = useBlockStore((s) => s.isBlocked)
  const blockUser = useBlockStore((s) => s.blockUser)
  const unblockUser = useBlockStore((s) => s.unblockUser)
  const followStoreState = useFollowStore()

  // Determine which pubkey to show
  const displayPubkey = targetPubkey || myPubkey
  const isSelf = displayPubkey === myPubkey

  const [profile, setProfileData] = useState<ProfileData>(EMPTY_PROFILE)
  const [editProfile, setEditProfile] = useState<ProfileData>(EMPTY_PROFILE)
  const [editing, setEditing] = useState(false)
  // NIP-38 general status (kind 30315, d="general")
  const [status, setStatus] = useState('')
  const [editingStatus, setEditingStatus] = useState(false)
  const [statusDraft, setStatusDraft] = useState('')
  const [statusSaving, setStatusSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const dropdownMenuRef = useRef<HTMLDivElement>(null)
  // Fixed-viewport coords for the portaled dropdown menu (so the modal's overflow can't clip it).
  const [dropdownPos, setDropdownPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null)

  // Links modal state
  const [showLinksViewer, setShowLinksViewer] = useState(false)
  const [showLinksEditor, setShowLinksEditor] = useState(false)
  const [hasLinks, setHasLinks] = useState(false)

  // Upload state for profile picture
  type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'
  const [picStatus, setPicStatus] = useState<UploadStatus>('idle')
  const [picProgress, setPicProgress] = useState<UploadProgress | null>(null)
  const picAbortRef = useRef<AbortController | null>(null)
  const picInputRef = useRef<HTMLInputElement>(null)
  const [picDragOver, setPicDragOver] = useState(false)
  const [picEditFile, setPicEditFile] = useState<File | null>(null)     // pic crop editor target
  const [bannerEditFile, setBannerEditFile] = useState<File | null>(null) // banner crop editor target

  // Upload state for banner
  const [bannerUpStatus, setBannerUpStatus] = useState<UploadStatus>('idle')
  const [bannerUpProgress, setBannerUpProgress] = useState<UploadProgress | null>(null)
  const bannerAbortRef = useRef<AbortController | null>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const [bannerDragOver, setBannerDragOver] = useState(false)
  const [fileSizeWarning, setFileSizeWarning] = useState<{ name: string; limitMb: number } | null>(null)

  // Report modal state
  const [showReportModal, setShowReportModal] = useState(false)

  // Block type modal state
  const [showBlockTypeModal, setShowBlockTypeModal] = useState(false)

  // Follow safety modal state
  const [showFollowSafetyModal, setShowFollowSafetyModal] = useState(false)
  const [pendingFollowSafetyStatus, setPendingFollowSafetyStatus] = useState<'empty-list' | 'not-loaded' | 'load-error'>('empty-list')

  // Following list modal state
  const [showFollowingList, setShowFollowingList] = useState(false)
  const [followingPubkeys, setFollowingPubkeys] = useState<string[]>([])
  const [followingLoaded, setFollowingLoaded] = useState(false)

  const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  const ACCEPTED_IMAGE_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.webp'
  const isValidImageFile = (file: File) => ACCEPTED_IMAGE_TYPES.includes(file.type)

  const handleImageUpload = async (
    file: File,
    setUrl: (url: string) => void,
    setStatus: (s: UploadStatus) => void,
    setProgressCb: (p: UploadProgress | null) => void,
    abortRef: React.MutableRefObject<AbortController | null>,
  ) => {
    if (!isValidImageFile(file)) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    if (file.size > limitMb * 1024 * 1024) {
      setFileSizeWarning({ name: file.name, limitMb })
      return
    }
    setStatus('uploading')
    setProgressCb(null)
    try {
      const buffer = await file.arrayBuffer()
      const data = new Uint8Array(buffer)
      const { hash } = await uploadToBlossomServers(
        data, signer, privateKey, undefined, file.type,
        (p) => setProgressCb({ ...p }),
        () => { const c = new AbortController(); abortRef.current = c; return c.signal },
      )
      const serverUrl = blossomServerManager.getServers()[0]
      setUrl(`${serverUrl}/${hash}`)
      setStatus('success')
    } catch {
      setStatus('error')
    } finally {
      setProgressCb(null)
      abortRef.current = null
    }
  }

  const handleDrop = (
    e: React.DragEvent,
    setUrl: (url: string) => void,
    setStatus: (s: UploadStatus) => void,
    setProgressCb: (p: UploadProgress | null) => void,
    abortRef: React.MutableRefObject<AbortController | null>,
    setDrag: (v: boolean) => void,
  ) => {
    e.preventDefault(); e.stopPropagation(); setDrag(false)
    const file = e.dataTransfer.files?.[0]
    if (!file || !isValidImageFile(file)) return
    handleImageUpload(file, setUrl, setStatus, setProgressCb, abortRef)
  }

  const imgDragOver = (e: React.DragEvent, set: (v: boolean) => void) => { e.preventDefault(); e.stopPropagation(); set(true) }
  const imgDragLeave = (e: React.DragEvent, set: (v: boolean) => void) => { e.preventDefault(); e.stopPropagation(); set(false) }

  // Profile picture: open the crop editor (size-checked up front so the user doesn't
  // edit then get rejected). The editor returns a file we then upload as the picture.
  const uploadPicture = (f: File) => handleImageUpload(f, (url) => setEditProfile((p) => ({ ...p, picture: url })), setPicStatus, setPicProgress, picAbortRef)
  const startPicEdit = (f: File) => {
    if (!isValidImageFile(f)) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    if (f.size > limitMb * 1024 * 1024) { setFileSizeWarning({ name: f.name, limitMb }); return }
    setPicEditFile(f)
  }

  const uploadBanner = (f: File) => handleImageUpload(f, (url) => setEditProfile((p) => ({ ...p, banner: url })), setBannerUpStatus, setBannerUpProgress, bannerAbortRef)
  const startBannerEdit = (f: File) => {
    if (!isValidImageFile(f)) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    if (f.size > limitMb * 1024 * 1024) { setFileSizeWarning({ name: f.name, limitMb }); return }
    setBannerEditFile(f)
  }

  const npub = displayPubkey ? nip19.npubEncode(displayPubkey) : ''
  const blocked = displayPubkey ? isBlocked(displayPubkey) : false

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      // The menu is portaled to <body>, so a click inside it is NOT inside dropdownRef — check both.
      if (dropdownRef.current?.contains(t) || dropdownMenuRef.current?.contains(t)) return
      setShowDropdown(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDropdown])

  // Fetch profile on open
  useEffect(() => {
    if (!open || !displayPubkey || loaded) return

    fetchEvents({
      kinds: [0],
      authors: [displayPubkey],
      limit: 1,
    }).then((events) => {
      if (events.length > 0) {
        const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
        try {
          const parsed = JSON.parse(latest.content)
          const data: ProfileData = {
            name: parsed.name || '',
            display_name: parsed.display_name || '',
            about: parsed.about || '',
            picture: parsed.picture || '',
            banner: parsed.banner || '',
            nip05: parsed.nip05 || '',
            website: parsed.website || '',
            lud16: parsed.lud16 || '',
          }
          setProfileData(data)
          setEditProfile(data)
          // Push into global profile cache so all components (hub chat, member list, etc.) update
          updateCachedProfile(displayPubkey, parsed)
        } catch { /* ignore */ }
      }
      setLoaded(true)
    })

    // Fetch NIP-38 general status (kind 30315, d="general")
    fetchEvents({ kinds: [30315], authors: [displayPubkey], '#d': ['general'], limit: 1 }).then((events) => {
      if (events.length > 0) {
        const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
        setStatus(latest.content || '')
      }
    }).catch(() => { /* non-critical */ })

    // Fetch link sets to know if "Links" button should show
    fetchEvents({ kinds: [30003], authors: [displayPubkey] }).then((events) => {
      const linkSets = events.filter((ev) => ev.tags.some((t) => t[0] === 'd' && t[1]?.startsWith('links-')))
      setHasLinks(linkSets.some((ev) => ev.tags.some((t) => t[0] === 'r' && t[1])))
    })

    // Fetch target user's follow list (kind 3) for the "Following" button
    fetchEvents({ kinds: [3], authors: [displayPubkey], limit: 1 }).then((events) => {
      if (events.length > 0) {
        const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
        const follows: string[] = []
        for (const tag of latest.tags) {
          if (tag[0] === 'p' && tag[1]) follows.push(tag[1])
        }
        setFollowingPubkeys(follows)
      }
      setFollowingLoaded(true)
    }).catch(() => setFollowingLoaded(true))
  }, [open, displayPubkey, loaded, isSelf, myPubkey])

  // Reset on close / auto-enter edit mode
  useEffect(() => {
    if (!open) {
      setProfileData(EMPTY_PROFILE)
      setEditProfile(EMPTY_PROFILE)
      setEditing(false)
      setLoaded(false)
      setShowDropdown(false)
      setShowLinksViewer(false)
      setShowLinksEditor(false)
      setHasLinks(false)
      setShowFollowingList(false)
      setFollowingPubkeys([])
      setFollowingLoaded(false)
      setStatus('')
      setEditingStatus(false)
      setStatusDraft('')
    } else if (startEditingProp && isSelf) {
      setEditing(true)
    }
  }, [open, startEditingProp, isSelf])

  const hasChanges = JSON.stringify(profile) !== JSON.stringify(editProfile)

  const handleCopyNpub = () => {
    navigator.clipboard.writeText(npub)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const saveStatus = async () => {
    if (statusSaving || !myPubkey || (!signer && !privateKey)) return
    setStatusSaving(true)
    try {
      const content = statusDraft.trim().slice(0, STATUS_MAX)
      const unsigned = {
        kind: 30315, // NIP-38 user status
        pubkey: myPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', 'general']] as string[][],
        content,
      }
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishPersonal(signed)
      setStatus(content)
      setEditingStatus(false)
    } catch (e) {
      console.error('Failed to publish status:', e)
    } finally {
      setStatusSaving(false)
    }
  }

  const handlePublish = async () => {
    if (!myPubkey || (!signer && !privateKey)) return
    setPublishing(true)

    try {
      const content = JSON.stringify({
        name: editProfile.name,
        display_name: editProfile.display_name,
        about: editProfile.about,
        picture: editProfile.picture,
        banner: editProfile.banner,
        nip05: editProfile.nip05,
        website: editProfile.website,
        lud16: editProfile.lud16,
      })

      const unsigned = {
        kind: 0,
        pubkey: myPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [] as string[][],
        content,
      }

      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishPersonal(signed)

      setUserProfile({
        displayName: editProfile.display_name || editProfile.name,
        avatar: editProfile.picture,
      })

      setProfileData(editProfile)
      // Update global profile cache so all components reflect the new profile
      updateCachedProfile(myPubkey, {
        name: editProfile.name,
        display_name: editProfile.display_name,
        about: editProfile.about,
        picture: editProfile.picture,
        banner: editProfile.banner,
        nip05: editProfile.nip05,
        website: editProfile.website,
        lud16: editProfile.lud16,
      })
      setEditing(false)
    } catch (err) {
      console.error('Failed to publish profile:', err)
    } finally {
      setPublishing(false)
    }
  }

  const following = displayPubkey ? followStoreState.isFollowing(displayPubkey) : false

  const handleFollow = async () => {
    if (!myPubkey || !displayPubkey || (!signer && !privateKey)) return

    // For follow (not unfollow), check safety status
    if (!following) {
      const safety = followStoreState.getFollowSafetyStatus()
      if (safety !== 'safe') {
        setPendingFollowSafetyStatus(safety as 'empty-list' | 'not-loaded' | 'load-error')
        setShowFollowSafetyModal(true)
        return
      }
    }

    await executeFollow()
  }

  const executeFollow = async () => {
    if (!myPubkey || !displayPubkey || (!signer && !privateKey)) return
    setFollowLoading(true)

    try {
      if (following) {
        await followStoreState.unfollowUser(displayPubkey, myPubkey, signer, privateKey)
      } else {
        await followStoreState.followUser(displayPubkey, myPubkey, signer, privateKey)
      }
    } catch (err) {
      console.error('Failed to toggle follow:', err)
    } finally {
      setFollowLoading(false)
    }
  }

  const handleDM = () => {
    if (!displayPubkey) return
    if (onDM) {
      onDM(displayPubkey)
    } else {
      // Self-sufficient DM navigation: set both stores and navigate
      useDM04Store.getState().setActiveConversation(displayPubkey)
      useDMStore.getState().setActiveConversation(displayPubkey)
      useNavigationStore.getState().setActivePage('dms')
    }
    onClose()
  }

  const handleToggleBlock = async () => {
    if (!displayPubkey || !myPubkey) return
    setShowDropdown(false)
    if (blocked) {
      await unblockUser(displayPubkey, myPubkey, signer, privateKey)
    } else {
      setShowBlockTypeModal(true)
    }
  }

  const handleBlockWithType = async (blockType: BlockType) => {
    if (!displayPubkey || !myPubkey) return
    setShowBlockTypeModal(false)
    await blockUser(displayPubkey, myPubkey, signer, privateKey, blockType)
  }

  // Hub-level ban
  const isHubCreator = hubContext && (myPubkey === hubContext.creatorPubkey || myPubkey === hubContext.ownerRealPubkey)
  // Whether the profile's target is a current member (so "Remove from Hub" only shows for members).
  const targetIsMember = useHubStore((s) => {
    const dTag = hubContext?.dTag
    return !!(dTag && displayPubkey && s.hubMembers[dTag]?.some((m) => m.pubkey === displayPubkey))
  })
  const [banning, setBanning] = useState(false)
  const [banStep, setBanStep] = useState<string | null>(null)
  const [banSteps, setBanSteps] = useState<string[]>([])
  // Which step-label list to render — set per-flow at the start of handleRemoveOrBan (see the constants
  // above). Defaults to the v1 list; the v2 branches override it before emitting steps.
  const [banStepLabels, setBanStepLabels] = useState<string[]>(V1_CREATOR_BAN_STEPS)
  const [banError, setBanError] = useState<string | null>(null)
  const [modBanning, setModBanning] = useState(false)
  const [modBanStep, setModBanStep] = useState<string | null>(null)
  const [modBanSteps, setModBanSteps] = useState<string[]>([])
  const [modBanError, setModBanError] = useState<string | null>(null)

  // Auto-dismiss ban overlay on success after 1.5s
  useEffect(() => {
    if (banStep === 'Done' && !banError) {
      const timer = setTimeout(() => { setBanSteps([]); setBanStep(null) }, 1500)
      return () => clearTimeout(timer)
    }
  }, [banStep, banError])

  // Auto-dismiss mod-ban overlay on success after 1.5s
  useEffect(() => {
    if (modBanStep === 'Done' && !modBanError) {
      const timer = setTimeout(() => { setModBanSteps([]); setModBanStep(null) }, 1500)
      return () => clearTimeout(timer)
    }
  }, [modBanStep, modBanError])

  // Check if current user can mod-ban (has ban_members permission, not creator)
  const hubDTagForPerms = hubContext?.dTag || ''
  const hubForPerms = useHubStore((s) => hubDTagForPerms ? s.hubs[hubDTagForPerms] : undefined)
  const hubMembersForPerms = useHubStore((s) => hubDTagForPerms ? s.hubMembers[hubDTagForPerms] : undefined)
  const canModBan = (() => {
    if (!hubContext || !myPubkey || isHubCreator || !hubForPerms) return false
    const members = hubMembersForPerms || []
    const perms = getPermissionsForUser(hubForPerms, myPubkey, members)
    return perms.ban_members === true
  })()

  // Check if user is already mod-banned by us
  const modBanListsForHub = useHubStore((s) => hubDTagForPerms ? s.modBanLists[hubDTagForPerms] : undefined)
  const isModBanned = (() => {
    if (!displayPubkey || !myPubkey || !hubDTagForPerms) return false
    return (modBanListsForHub?.[myPubkey] || []).includes(displayPubkey)
  })()

  const handleRemoveOrBan = async (mode: 'ban' | 'remove') => {
    if (!displayPubkey || !hubContext || !myPubkey || banning) return
    setShowDropdown(false)
    setBanning(true)
    setBanError(null)
    setBanSteps([])
    setBanStepLabels(V1_CREATOR_BAN_STEPS) // default (v1 inline path); v2 branches override before emitting

    const markStep = async (step: string) => {
      setBanStep(step)
      await new Promise(r => setTimeout(r, 0))
    }
    const markDone = (step: string) => setBanSteps(prev => [...prev, step])

    // Single-flight: serialize this kick/ban with every other membership mutation for this hub on this
    // device, so it re-reads the CURRENT index below instead of racing a concurrent op. (The CAS in
    // republishV2 is the cross-device backstop.)
    const { acquireHubMutationLock } = await import('@/lib/hub/hubMutationGuard')
    const releaseHubLock = await acquireHubMutationLock(hubContext.dTag)
    try {
      const { dTag } = hubContext
      const hub = useHubStore.getState().hubs[dTag]
      if (!hub) throw new Error('Hub not found')

      // 1. Ban list. 'ban' adds the user (and persists it); 'remove' leaves the list untouched —
      // the member is still kicked from the tree and the secret rotated (so they lose access), they
      // just aren't blocked from rejoining. The ban PAGE below is rewritten with `effectiveBans`.
      //
      // Base the list on a FRESH, fail-closed download of the current ban pages — NOT the store. A partial
      // hub load can leave hubBanLists[dTag] TRUNCATED (a ban page that failed to fetch/decrypt is swallowed
      // to []), and rewriting that truncated set as the new ban page would durably ERASE every prior ban.
      // downloadBanListV2 throws if any page is unreadable, so we block rather than silently truncate. (v1
      // ban lists are plaintext/legacy — keep the store value there.)
      const { isV2: isV2Ban } = await import('@/lib/hub/version')
      let currentBans: string[]
      if (isV2Ban(hub) && hub.indexFileHash && hub.blossomServers.length > 0) {
        const secretHexBans = useHubStore.getState().hubSecrets[dTag]
        if (!secretHexBans) throw new Error('Hub secret not available')
        try {
          const { downloadTextFromBlossom, parseIndexFile, downloadBanListV2 } = await import('@/lib/blossom')
          const { fromHex } = await import('@/lib/crypto/lkh')
          const idx = parseIndexFile(await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers))
          currentBans = idx.banPages.length > 0
            ? (await downloadBanListV2(idx.banPages, fromHex(secretHexBans), hub.blossomServers)).map(e => e.pubkey)
            : []
        } catch {
          throw new Error('Could not load the hub’s current ban list — can’t safely update it right now. Please try again.')
        }
      } else {
        currentBans = useHubStore.getState().hubBanLists[dTag] || []
      }
      if (mode === 'ban' && currentBans.includes(displayPubkey)) {
        setBanning(false)
        setBanSteps([])
        return // already banned
      }
      const effectiveBans = mode === 'ban' ? [...currentBans, displayPubkey] : currentBans
      if (mode === 'ban') useHubStore.getState().setHubBanList(dTag, effectiveBans)

      await markStep('Downloading index & tree')
      // 2. Check if user is in member tree — if so, remove + rotate secret
      const members = useHubStore.getState().hubMembers[dTag] || []
      const isInTree = members.some(m => m.pubkey === displayPubkey)

      // 'remove' only makes sense for an actual member — removing a non-member does nothing (and
      // unlike 'ban' there's no ban-list entry to add for a non-member).
      if (mode === 'remove' && !isInTree) {
        setBanning(false)
        setBanSteps([])
        return
      }

      // ── v2 hubs: isolated kick (remove by pseudonym P + rotate secret + republish as O). ──
      // Runs the whole flow in lib/hub/v2kick and short-circuits the v1 path below entirely.
      const { isV2 } = await import('@/lib/hub/version')
      if (isV2(hub)) {
        if (!isInTree) {
          setBanStepLabels(V2_NONMEMBER_BAN_STEPS) // ban-page rewrite only — no tree surgery/rotation
          // Not in the member tree, but a v2 ban must still be PERSISTED to the encrypted ban page and
          // republished — otherwise it's local-only: invisible to other moderators/devices and lost on
          // reload (the ban list is re-derived from Blossom). This mirrors the v1 non-member ban and the
          // owner "Banned Members" flow — no tree surgery, no rotation: just rewrite the ban pages and
          // republish the index as O, preserving the spine/leaf-pages/group-trees/history unchanged.
          if (!hub.indexFileHash || hub.blossomServers.length === 0) {
            markDone('Downloading index & tree')
            await markStep('Done')
            return // no index to update — the local add above is all we can do
          }
          const secretHexNM = useHubStore.getState().hubSecrets[dTag]
          if (!secretHexNM) throw new Error('Hub secret not available')
          const { fromHex: fromHexNM } = await import('@/lib/crypto/lkh')
          const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
          const { ChatContext: ChatContextNM } = await import('@/lib/crypto/skd')
          const { downloadTextFromBlossom, parseIndexFile, uploadBanPagesV2, createPaginatedIndexFile, uploadToBlossomServers } = await import('@/lib/blossom')
          const { republishV2HubIndex } = await import('@/lib/hub/republishV2')

          // Blossom 24242 auth + hub-event author as O (never R_owner).
          const ownerSignerNM = makeSubkeySigner(ChatContextNM.owner(dTag), { privateKey, signer })
          const ownerAuthNM = (e: any) => ownerSignerNM.signEvent(e)

          markDone('Downloading index & tree')
          await markStep('Uploading ban pages')
          const indexContent = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
          const index = parseIndexFile(indexContent)
          const banEntries = effectiveBans.map(pk => ({ pubkey: pk, reason: '' }))
          const banPageHashes = await uploadBanPagesV2(banEntries, fromHexNM(secretHexNM), hub.epoch, signer, privateKey, hub.blossomServers, ownerAuthNM)
          const newIndexContent = createPaginatedIndexFile(
            index.spineHash, index.leafPages, banPageHashes, index.historyHash || undefined,
            index.groupTrees && index.groupTrees.length > 0 ? index.groupTrees : undefined,
          )
          const indexBytes = new TextEncoder().encode(newIndexContent)
          const { hash: newIndexHash } = await uploadToBlossomServers(
            indexBytes, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, ownerAuthNM,
          )
          markDone('Uploading ban pages')

          await markStep('Publishing hub event')
          const pub = await republishV2HubIndex({ hub, ownerPub: hub.creatorPubkey, newIndexHash, privateKey, signer })
          markDone('Publishing hub event')
          useHubStore.getState().setHubData(dTag, { ...hub, indexFileHash: newIndexHash, eventCreatedAt: pub.eventCreatedAt ?? hub.eventCreatedAt })
          await markStep('Done')
          return
        }
        setBanStepLabels(V2_MEMBER_BAN_STEPS) // kickMemberV2 emits these labels via onStep
        let memberP = members.find(m => m.pubkey === displayPubkey)?.p
        if (!memberP && privateKey) {
          // Local owner: re-derive P from R (ECDH symmetry) when it isn't cached.
          const { deriveMemberPseudonymForOwner } = await import('@/lib/crypto/skd')
          memberP = deriveMemberPseudonymForOwner(privateKey, dTag, displayPubkey)
        }
        if (!memberP) {
          // Remote signer (no local ECDH shortcut): resolve P by scanning the roster segments.
          const { resolveMemberPByRoster } = await import('@/lib/hub/v2kick')
          const secretHexNow = useHubStore.getState().hubSecrets[dTag]
          const epochSecretsNow = {
            ...(useHubStore.getState().epochSecrets[dTag] || {}),
            ...(secretHexNow ? { [hub.epoch]: secretHexNow } : {}),
          }
          memberP = (await resolveMemberPByRoster({ hub, memberR: displayPubkey, epochSecrets: epochSecretsNow })) ?? undefined
        }
        if (!memberP) throw new Error('Member pseudonym unknown — reload the hub and try again')
        const oldSecretHexV2 = useHubStore.getState().hubSecrets[dTag]
        if (!oldSecretHexV2) throw new Error('Hub secret not available')

        const { fromHex: fromHexV2 } = await import('@/lib/crypto/lkh')
        const { kickMemberV2 } = await import('@/lib/hub/v2kick')

        let prevStep: string | null = null
        const onStep = (s: string) => { if (prevStep) markDone(prevStep); void markStep(s); prevStep = s }

        // Groups the kicked member was in → remove them INCREMENTALLY (kickMemberV2 patches each
        // existing tree, preserving members on other roster pages). We just pass the group ids + the
        // current group secret (which the owner holds); the tree itself supplies the full membership.
        const kickFromGroups: Array<{ groupId: string; currentSecretHex: string }> = []
        if (hub.groupedRoles && hub.groupedRoles.length > 0) {
          const { memberQualifiesForGroup } = await import('@/lib/hub/groupEncryption')
          const kickedRoles = members.find(m => m.pubkey === displayPubkey)?.roles || ''
          const groupSecrets = useHubStore.getState().groupSecrets[dTag] || {}
          for (const group of hub.groupedRoles) {
            if (!memberQualifiesForGroup(kickedRoles, group.roleIds)) continue // wasn't in this group
            // The kicked member MUST be removed from every group they were in — even if this client
            // doesn't currently hold that group's secret. removeMemberFromGroupTreeV2 rebuilds the tree
            // from the leaves (recovered via O↔P nip44) + a FRESH secret; the "current" secret we pass is
            // only used to build a throwaway intermediate tree that removeLeaf discards. So when it's
            // missing, pass a random placeholder rather than SKIP — skipping would leave the kicked
            // member with the old group secret and continued read access to that group channel.
            const curHex = groupSecrets[group.groupId]
              ?? Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')
            kickFromGroups.push({ groupId: group.groupId, currentSecretHex: curHex })
          }
        }
        // Defensive coverage: also rotate any encryption group referenced by a CHANNEL or CATEGORY that
        // has NO `groupedRoles` entry (so the qualification loop above never enumerated it). Without this,
        // a kicked member could retain that group's secret → continued read access. removeMemberFromGroupTreeV2
        // no-ops when the member has no leaf there, so including an extra group is safe/cheap.
        {
          const groupedRoleIds = new Set((hub.groupedRoles || []).map(g => g.groupId))
          const covered = new Set(kickFromGroups.map(g => g.groupId))
          const encIds = new Set<string>()
          for (const ch of hub.channels || []) if (ch.encryption) encIds.add(ch.encryption)
          for (const cat of hub.categories || []) if (cat.encryption) encIds.add(cat.encryption)
          const gSecrets = useHubStore.getState().groupSecrets[dTag] || {}
          for (const gid of encIds) {
            if (groupedRoleIds.has(gid) || covered.has(gid)) continue // already handled (or intentionally skipped as not-qualified)
            const curHex = gSecrets[gid]
              ?? Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')
            kickFromGroups.push({ groupId: gid, currentSecretHex: curHex })
          }
        }

        const result = await kickMemberV2({
          hub,
          memberR: displayPubkey,
          memberP,
          oldSecret: fromHexV2(oldSecretHexV2),
          epochSecrets: useHubStore.getState().epochSecrets[dTag] || {},
          // Persist the full ban set as an encrypted ban page (real keys R) under the new secret.
          banEntries: effectiveBans.map(pk => ({ pubkey: pk, reason: '' })),
          kickFromGroups: kickFromGroups.length > 0 ? kickFromGroups : undefined,
          privateKey, signer,
          onStep,
        })
        if (prevStep) markDone(prevStep)

        useHubStore.getState().setHubSecret(dTag, result.newSecretHex)
        useHubStore.getState().setEpochSecrets(dTag, result.epochMap)
        useHubStore.getState().setHubMembers(dTag, members.filter(m => m.pubkey !== displayPubkey))
        for (const [gid, secretHex] of Object.entries(result.groupSecrets)) {
          // Preserve the old group secret at its old epoch so old group messages stay readable.
          const oldEpoch = hub.groupedRoles?.find(g => g.groupId === gid)?.epoch ?? 1
          const newGEpoch = result.groupedRoles?.find(g => g.groupId === gid)?.epoch ?? (oldEpoch + 1)
          const oldGSecret = useHubStore.getState().groupSecrets?.[dTag]?.[gid]
          const gmap: Record<number, string> = { ...(useHubStore.getState().groupEpochSecrets?.[dTag]?.[gid] || {}) }
          if (oldGSecret) gmap[oldEpoch] = oldGSecret
          gmap[newGEpoch] = secretHex
          useHubStore.getState().setGroupEpochSecrets(dTag, gid, gmap)
          useHubStore.getState().setGroupSecret(dTag, gid, secretHex)
        }
        useHubStore.getState().setHubData(dTag, {
          ...hub,
          epoch: result.newEpoch,
          indexFileHash: result.newIndexHash,
          groupedRoles: result.groupedRoles ?? hub.groupedRoles,
          eventCreatedAt: result.eventCreatedAt ?? hub.eventCreatedAt,
        })

        // Surface any group whose revocation FAILED — the kicked member still has access to it, so the
        // owner needs to know to retry (a silent skip would leave a forward-secrecy hole unannounced).
        if (result.groupsNotRotated && result.groupsNotRotated.length > 0) {
          setBanError(`Kicked, but ${result.groupsNotRotated.length} group channel(s) couldn’t be re-keyed — the user may still read those. Run “Fix hub encryption” or retry.`)
        }

        await markStep('Done')
        return
      }

      let newEpoch = hub.epoch
      let newSpineHash = ''
      let newHistoryHash = ''
      let oldSpineHash = ''
      let oldHistoryHash = ''
      // Track updated pages for safePaginatedTreeUpdate
      let updatedPageData: { pageIndex: number; content: string; firstPubkey: string } | null = null
      let newHubSecretBytes: Uint8Array | undefined
      let oldHubSecretBytes: Uint8Array | undefined

      if (isInTree && hub.indexFileHash && hub.blossomServers.length > 0) {
        const {
          parseIndexFile, findPageForPubkey, rehydratePageKeys, removeMemberFromPage,
          downloadTextFromBlossom, uploadToBlossomServers,
        } = await import('@/lib/blossom')
        const {
          fromHex, deserializeSpine, recoverPageRootKeys,
          buildSpine, serializeLeafPage, serializeSpine,
        } = await import('@/lib/crypto/lkh')
        const { aesEncrypt } = await import('@/lib/crypto/aes')

        // Download current index
        const indexContent = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
        const index = parseIndexFile(indexContent)
        oldSpineHash = index.spineHash
        oldHistoryHash = index.historyHash

        if (!index.spineHash || index.leafPages.length === 0) {
          throw new Error('Hub does not use paginated format')
        }

        // Find which page contains the banned user
        const pageEntry = findPageForPubkey(index, displayPubkey)
        if (!pageEntry) {
          throw new Error('Banned user not found in any page')
        }

        // Download and rehydrate only the affected page + spine
        const [pageContent, spineContent] = await Promise.all([
          downloadTextFromBlossom(pageEntry.hash, hub.blossomServers),
          downloadTextFromBlossom(index.spineHash, hub.blossomServers),
        ])
        const spine = deserializeSpine(spineContent)
        markDone('Downloading index & tree')

        await markStep('Removing member & rotating secret')
        const hubSecretHex = useHubStore.getState().hubSecrets[dTag]
        if (hubSecretHex) {
          const hubSecret = fromHex(hubSecretHex)
          oldHubSecretBytes = hubSecret

          // Rehydrate the page containing the banned user
          const rehydratedPage = await rehydratePageKeys(pageContent, signer, privateKey)
          const updatedPage = await removeMemberFromPage(rehydratedPage, displayPubkey)

          if (updatedPage) {
            newEpoch = hub.epoch + 1

            // Generate new hub secret (32 random bytes)
            newHubSecretBytes = crypto.getRandomValues(new Uint8Array(32))

            // Save updated page data for later upload
            updatedPageData = {
              pageIndex: pageEntry.pageIndex,
              content: serializeLeafPage(updatedPage),
              firstPubkey: updatedPage.leaves[0].pubkey,
            }

            // Recover all page-root keys and rebuild spine with new secret
            const pageRootKeys = await recoverPageRootKeys(spine, hubSecret)

            // Replace the modified page's root key
            const updatedPageRoots = pageRootKeys.map((prk, i) => {
              if (index.leafPages[i]?.pageIndex === pageEntry.pageIndex) {
                return { nodeId: updatedPage.pageRoot.nodeId, rawKey: updatedPage.pageRoot.rawKey! }
              }
              return prk
            })

            const newSpine = await buildSpine(updatedPageRoots, newHubSecretBytes)
            const newSpineContent = serializeSpine(newSpine)

            // Upload page + spine
            const pageBytes = new TextEncoder().encode(updatedPageData.content)
            const { hash: pHash } = await uploadToBlossomServers(
              pageBytes, signer, privateKey, hub.blossomServers, 'text/plain',
            )

            const spineBytes = new TextEncoder().encode(newSpineContent)
            const { hash: sHash } = await uploadToBlossomServers(
              spineBytes, signer, privateKey, hub.blossomServers, 'text/plain',
            )
            newSpineHash = sHash

            // Update history — single-blob: decrypt old, append old epoch, re-encrypt with new secret
            const { toHex } = await import('@/lib/crypto/lkh')
            const { aesDecrypt } = await import('@/lib/crypto/aes')
            const newSecretHex = toHex(newHubSecretBytes)
            const oldSecretHex = hubSecretHex

            let historyPlaintext = ''
            if (index.historyHash) {
              try {
                const historyBlob = await downloadTextFromBlossom(index.historyHash, hub.blossomServers)
                historyPlaintext = await aesDecrypt(hubSecret, historyBlob)
              } catch { /* start fresh */ }
            }

            const oldEpochLine = `hub:${hub.epoch}:${oldSecretHex}`
            const newEpochLine = `hub:${newEpoch}:${newSecretHex}`
            const lines = historyPlaintext ? historyPlaintext.split('\n').filter(l => l.trim()) : []
            const hasOldEpoch = lines.some(l => l.startsWith(`hub:${hub.epoch}:`))
            if (!hasOldEpoch) lines.push(oldEpochLine)
            const newEpochIdx = lines.findIndex(l => l.startsWith(`hub:${newEpoch}:`))
            if (newEpochIdx >= 0) lines[newEpochIdx] = newEpochLine
            else lines.push(newEpochLine)

            const updatedBlob = await aesEncrypt(newHubSecretBytes, lines.join('\n'))
            const historyBytes = new TextEncoder().encode(updatedBlob)
            const { hash: hHash } = await uploadToBlossomServers(
              historyBytes, signer, privateKey, hub.blossomServers, 'text/plain',
            )
            newHistoryHash = hHash

            // Update local secret
            useHubStore.getState().setHubSecret(dTag, newSecretHex)
            const epochMap: Record<number, string> = {}
            for (const l of lines) {
              if (l.startsWith('hub:')) {
                const parts = l.split(':')
                if (parts.length >= 3) epochMap[parseInt(parts[1], 10)] = parts.slice(2).join(':')
              }
            }
            if (Object.keys(epochMap).length > 0) {
              useHubStore.getState().setEpochSecrets(dTag, epochMap)
            }
            useHubStore.getState().setHubMembers(dTag, members.filter(m => m.pubkey !== displayPubkey))

            // Update the page hash in the index leaf pages for later index rebuild
            updatedPageData = { ...updatedPageData, content: pHash } // Reuse content field for hash
          }
        }
        markDone('Removing member & rotating secret')
      } else {
        markDone('Downloading index & tree')
        markDone('Removing member & rotating secret')
      }

      // 2b. Rotate group LKH trees for any groups the banned user was in
      const groupedRoles = hub.groupedRoles || []
      let updatedGroupedRoles = [...groupedRoles]
      let updatedGroupTrees: Array<{ groupId: string; hash: string }> = []
      const groupHistoryEntries: Array<{ groupId: string; epoch: number; secretHex: string }> = []
      let oldGroupTreeHashes: string[] = []

      if (isInTree && groupedRoles.length > 0) {
        await markStep('Rotating group encryption')
        const bannedMember = members.find(m => m.pubkey === displayPubkey)
        if (bannedMember) {
          const { memberQualifiesForGroup } = await import('@/lib/hub/groupEncryption')
          const {
            rehydrateTreeKeys: rehydrateGT, removeMemberFromGroupTree,
          } = await import('@/lib/blossom/members')
          const {
            downloadTextFromBlossom: dlGroupText, uploadToBlossomServers: uploadGroupFn,
          } = await import('@/lib/blossom')
          const { deserializeTree: deserializeGT } = await import('@/lib/crypto/lkh')

          // Get current group tree refs from index
          if (hub.indexFileHash && hub.blossomServers.length > 0) {
            try {
              const ic = await dlGroupText(hub.indexFileHash, hub.blossomServers)
              const idx = (await import('@/lib/blossom')).parseIndexFile(ic)
              updatedGroupTrees = [...idx.groupTrees]
            } catch { /* use empty */ }
          }

          for (let gi = 0; gi < updatedGroupedRoles.length; gi++) {
            const group = updatedGroupedRoles[gi]
            if (!memberQualifiesForGroup(bannedMember.roles, group.roleIds)) continue

            // This banned user was in this group — rotate it
            const groupTreeRef = updatedGroupTrees.find(gt => gt.groupId === group.groupId)
            if (!groupTreeRef) continue

            try {
              const groupTreeContent = await dlGroupText(groupTreeRef.hash, hub.blossomServers)
              let groupTree = deserializeGT(groupTreeContent)

              const groupSecretHex = useHubStore.getState().groupSecrets[hub.dTag]?.[group.groupId]
              if (!groupSecretHex) {
                console.warn(`No group secret for ${group.groupId} — skipping rotation`)
                continue
              }
              const groupSecret = new Uint8Array(groupSecretHex.length / 2)
              for (let i = 0; i < groupSecretHex.length; i += 2) {
                groupSecret[i / 2] = parseInt(groupSecretHex.substring(i, i + 2), 16)
              }

              groupTree = await rehydrateGT(groupTree, groupSecret, signer, privateKey)
              const removeResult = await removeMemberFromGroupTree(groupTree, displayPubkey)

              if (removeResult) {
                // Upload new group tree
                const newGroupTreeBytes = new TextEncoder().encode(removeResult.newTreeContent)
                const { hash: newGroupTreeHash } = await uploadGroupFn(
                  newGroupTreeBytes, signer, privateKey, hub.blossomServers, 'text/plain',
                )

                // Track old hash for cleanup
                oldGroupTreeHashes.push(groupTreeRef.hash)

                // Update group tree ref
                updatedGroupTrees = updatedGroupTrees.map(gt =>
                  gt.groupId === group.groupId ? { ...gt, hash: newGroupTreeHash } : gt
                )

                // Track old + new group secrets for history
                groupHistoryEntries.push({
                  groupId: group.groupId,
                  epoch: group.epoch,
                  secretHex: groupSecretHex,
                })
                const newGroupSecretHex = Array.from(removeResult.newGroupSecret)
                  .map(b => b.toString(16).padStart(2, '0')).join('')
                groupHistoryEntries.push({
                  groupId: group.groupId,
                  epoch: group.epoch + 1,
                  secretHex: newGroupSecretHex,
                })

                // Bump group epoch
                updatedGroupedRoles[gi] = { ...group, epoch: group.epoch + 1 }

                // Update local group secret
                useHubStore.getState().setGroupSecret(hub.dTag, group.groupId, newGroupSecretHex)
                console.log(`Rotated group tree for ${group.groupId} (banned ${displayPubkey.slice(0, 8)}…)`)
              }
            } catch (err) {
              console.warn(`Failed to rotate group tree ${group.groupId}:`, err)
            }
          }
        }
        markDone('Rotating group encryption')
      } else {
        markDone('Rotating group encryption')
      }

      // 3. Upload ban page + new index
      await markStep('Uploading ban page & index')
      const {
        uploadBanPages, createPaginatedIndexFile, parseIndexFile: parseIdx,
        downloadTextFromBlossom: dlText, uploadToBlossomServers: uploadFn,
      } = await import('@/lib/blossom')

      // Get current index data if we didn't already
      let spineHash = newSpineHash
      let historyHash = newHistoryHash
      let leafPages: Array<{ pageIndex: number; firstPubkey: string; hash: string }> = []

      if (hub.indexFileHash && hub.blossomServers.length > 0) {
        try {
          const ic = await dlText(hub.indexFileHash, hub.blossomServers)
          const idx = parseIdx(ic)
          if (!spineHash) spineHash = idx.spineHash
          historyHash = historyHash || idx.historyHash
          leafPages = [...idx.leafPages]
          if (updatedGroupTrees.length === 0) updatedGroupTrees = idx.groupTrees

          // Apply page updates from member removal
          if (updatedPageData) {
            leafPages = leafPages.map(p =>
              p.pageIndex === updatedPageData!.pageIndex
                ? { ...p, firstPubkey: updatedPageData!.firstPubkey, hash: updatedPageData!.content }
                : p
            )
          }
        } catch { /* use empty */ }
      }

      // Append group history entries to the history blob if needed
      if (groupHistoryEntries.length > 0 && historyHash) {
        try {
          const { aesEncrypt: aesEnc2, aesDecrypt: aesDec2 } = await import('@/lib/crypto/aes')
          const currentSecretHex = useHubStore.getState().hubSecrets[dTag]
          if (currentSecretHex) {
            const currentSecret = new Uint8Array(currentSecretHex.length / 2)
            for (let i = 0; i < currentSecretHex.length; i += 2) {
              currentSecret[i / 2] = parseInt(currentSecretHex.substring(i, i + 2), 16)
            }

            let plaintext = ''
            try {
              const blob = await dlText(historyHash, hub.blossomServers)
              plaintext = await aesDec2(currentSecret, blob)
            } catch { /* start fresh */ }

            const lines = plaintext ? plaintext.split('\n').filter(l => l.trim()) : []
            for (const entry of groupHistoryEntries) {
              const line = `group:${entry.groupId}:${entry.epoch}:${entry.secretHex}`
              const existIdx = lines.findIndex(l => l.startsWith(`group:${entry.groupId}:${entry.epoch}:`))
              if (existIdx >= 0) lines[existIdx] = line
              else lines.push(line)
            }

            const updatedBlob = await aesEnc2(currentSecret, lines.join('\n'))
            const historyBytes2 = new TextEncoder().encode(updatedBlob)
            const { hash: hHash2 } = await uploadFn(
              historyBytes2, signer, privateKey, hub.blossomServers, 'text/plain',
            )
            historyHash = hHash2
          }
        } catch (err) {
          console.warn('Failed to update history with group entries:', err)
        }
      }

      // Update local group epoch secrets so old group-encrypted messages remain decryptable
      if (groupHistoryEntries.length > 0) {
        const groupEpochMaps: Record<string, Record<number, string>> = {}
        for (const entry of groupHistoryEntries) {
          if (!groupEpochMaps[entry.groupId]) groupEpochMaps[entry.groupId] = {}
          groupEpochMaps[entry.groupId][entry.epoch] = entry.secretHex
        }
        for (const [gid, gmap] of Object.entries(groupEpochMaps)) {
          useHubStore.getState().setGroupEpochSecrets(dTag, gid, gmap)
        }
      }

      const banPageHashes = await uploadBanPages(
        effectiveBans.map(pk => ({ pubkey: pk, reason: '' })),
        signer, privateKey, hub.blossomServers,
      )

      const indexContent2 = createPaginatedIndexFile(
        spineHash,
        leafPages,
        banPageHashes,
        historyHash || undefined,
        updatedGroupTrees.length > 0 ? updatedGroupTrees : undefined,
      )
      const indexBytes = new TextEncoder().encode(indexContent2)
      const { hash: newIndexHash } = await uploadFn(
        indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )
      markDone('Uploading ban page & index')

      // 4. Re-publish hub event
      await markStep('Publishing hub event')
      const { buildHubEvent } = await import('@/lib/hub/buildHubEvent')
      const { mineAndSign: signFn } = await import('@/lib/nostr/events')
      const { publishToSpecificRelays: pubToRelays } = await import('@/lib/nostr/relay-pool')
      const unsignedEvent = buildHubEvent({
        dTag: hub.dTag,
        name: hub.name,
        description: hub.description || undefined,
        epoch: newEpoch,
        icon: hub.icon,
        banner: hub.banner,
        tags: hub.tags,
        relays: [...hub.generalRelays],
        blossomServers: hub.blossomServers,
        indexFileHash: newIndexHash,
        channels: hub.channels,
        categories: hub.categories,
        roles: hub.roles,
        minPow: hub.minPow || undefined,
        joinMinPow: hub.joinMinPow > 0 ? hub.joinMinPow : undefined,
        messageExpiration: hub.messageExpiration || undefined, // preserve the disappearing-messages timer
        nsfw: hub.nsfw || undefined,
        discoverable: hub.discoverable,
        groupedRoles: updatedGroupedRoles.length > 0 ? updatedGroupedRoles : hub.groupedRoles,
        publishedAt: hub.publishedAt,
        eventCreatedAt: hub.eventCreatedAt,
      })
      const signedEvent = await signFn(unsignedEvent, hub.minPow, myPubkey, signer, privateKey)
      await publishCriticalWithFailover(signedEvent, getPublishRelays([...hub.generalRelays]), [...hub.generalRelays])
      markDone('Publishing hub event')

      // Update local store
      useHubStore.getState().setHubData(dTag, {
        ...hub,
        indexFileHash: newIndexHash,
        epoch: newEpoch,
        groupedRoles: updatedGroupedRoles.length > 0 ? updatedGroupedRoles : hub.groupedRoles,
        eventCreatedAt: signedEvent.created_at,
      })

      // Best-effort cleanup of old Blossom files
      if (isInTree) {
        try {
          const { deleteFromBlossom } = await import('@/lib/blossom/client')
          if (oldSpineHash && oldSpineHash !== newSpineHash) {
            deleteFromBlossom(oldSpineHash, signer, privateKey, hub.blossomServers).catch(() => {})
          }
          if (oldHistoryHash && oldHistoryHash !== newHistoryHash) {
            deleteFromBlossom(oldHistoryHash, signer, privateKey, hub.blossomServers).catch(() => {})
          }
          if (hub.indexFileHash && hub.indexFileHash !== newIndexHash) {
            deleteFromBlossom(hub.indexFileHash, signer, privateKey, hub.blossomServers).catch(() => {})
          }
          for (const oldHash of oldGroupTreeHashes) {
            deleteFromBlossom(oldHash, signer, privateKey, hub.blossomServers).catch(() => {})
          }
        } catch { /* cleanup is best-effort */ }
      }

      await markStep('Done')
    } catch (err: any) {
      console.error(`${mode === 'remove' ? 'Remove member' : 'Ban from hub'} failed:`, err)
      // Revert the OPTIMISTIC ban-list add (done before publish): the change didn't land, so the target
      // isn't actually banned — leaving it would show a phantom ban that a reload silently undoes.
      if (mode === 'ban' && displayPubkey && hubContext) {
        const cur = useHubStore.getState().hubBanLists[hubContext.dTag] || []
        useHubStore.getState().setHubBanList(hubContext.dTag, cur.filter((pk) => pk !== displayPubkey))
      }
      setBanError(err?.message || `${mode === 'remove' ? 'Remove member' : 'Ban from hub'} failed`)
    } finally {
      releaseHubLock()
      setBanning(false)
      // Don't clear banStep on success — keep 'Done' so the dialog shows the dismiss button
      // Only clear if there was no successful completion (error or early return)
    }
  }

  const handleBanFromHub = () => handleRemoveOrBan('ban')
  const handleRemoveMember = () => handleRemoveOrBan('remove')

  /**
   * Mod Ban: add the target user to the current user's own Blossom ban list.
   * This is a soft-ban — the user's messages are hidden client-side for all members
   * who load this mod's ban list. No LKH tree rotation or epoch change.
   */
  const handleModBan = async () => {
    if (!displayPubkey || !hubContext || !myPubkey || modBanning) return
    setShowDropdown(false)
    setModBanning(true)
    setModBanError(null)
    setModBanSteps([])

    const markStep = async (step: string) => {
      setModBanStep(step)
      await new Promise(r => setTimeout(r, 0))
    }
    const markDone = (step: string) => setModBanSteps(prev => [...prev, step])

    try {
      const { dTag } = hubContext
      const hub = useHubStore.getState().hubs[dTag]
      if (!hub) throw new Error('Hub not found')

      const existingModBans = useHubStore.getState().modBanLists[dTag]?.[myPubkey] || []
      if (existingModBans.includes(displayPubkey)) {
        setModBanning(false)
        return
      }

      // ── v2 hubs: author the list JR under the mod's pseudonym P, encrypt the ban page
      //    under the hub secret, and auth every Blossom write as P — so neither the mod's
      //    real key R_mod nor the banned members' real keys R ever appear on the wire. ──
      const { isV2 } = await import('@/lib/hub/version')
      if (isV2(hub)) {
        const { hubMemberIdentity } = await import('@/lib/hub/hubMemberSign')
        const identity = await hubMemberIdentity(hub, { privateKey, signer })
        if (!identity) throw new Error('This hub is private (v2) — a local key or NIP-SKD signer is required to moderate here.')
        const { authKey: modP, authSigner } = identity

        const hubSecretHexV2 = useHubStore.getState().hubSecrets[dTag]
        if (!hubSecretHexV2) throw new Error('Hub secret not available')
        const { fromHex: fromHexV2 } = await import('@/lib/crypto/lkh')
        const hubSecretV2 = fromHexV2(hubSecretHexV2)

        const {
          downloadTextFromBlossom, parseIndexFile, uploadToBlossomServers,
          uploadBanPagesV2, createIndexFile,
        } = await import('@/lib/blossom')
        const { createJoinRequest } = await import('@/lib/nostr/events')
        const { publishToSpecificRelays: pubToRelays, fetchEvents: fetchEvt } = await import('@/lib/nostr/relay-pool')
        const { getPublishRelays: getRelays } = await import('@/stores/postingBehaviourStore')
        const { KINDS } = await import('@/lib/crypto/constants')

        await markStep('Fetching join request')
        // On v2 the mod's own list JR is authored by their pseudonym P, not R.
        const joinRequestsV2 = await fetchEvt({
          kinds: [KINDS.JOIN_REQUEST],
          authors: [modP],
          '#d': [dTag],
          limit: 1,
        })
        let existingTreeHashV2 = ''
        let existingHistoryHashV2 = ''
        if (joinRequestsV2.length > 0) {
          const listTag = joinRequestsV2[0].tags.find((t: string[]) => t[0] === 'list')
          if (listTag?.[1]) {
            try {
              const index = parseIndexFile(await downloadTextFromBlossom(listTag[1], hub.blossomServers))
              existingTreeHashV2 = index.treeHash
              existingHistoryHashV2 = index.historyHash
            } catch { /* fresh start */ }
          }
        }
        markDone('Fetching join request')

        await markStep('Uploading ban page')
        const allBanPubkeysV2 = [...existingModBans, displayPubkey]
        const banPageHashesV2 = await uploadBanPagesV2(
          allBanPubkeysV2.map(pk => ({ pubkey: pk, reason: '' })),
          hubSecretV2, hub.epoch, signer, privateKey, hub.blossomServers, authSigner,
        )
        markDone('Uploading ban page')

        await markStep('Uploading index file')
        const newIndexContentV2 = createIndexFile(
          existingTreeHashV2,
          banPageHashesV2,
          existingHistoryHashV2 || undefined,
        )
        const indexBytesV2 = new TextEncoder().encode(newIndexContentV2)
        const { hash: newIndexHashV2 } = await uploadToBlossomServers(
          indexBytesV2, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, authSigner,
        )
        markDone('Uploading index file')

        await markStep('Publishing join request')
        const unsignedEventV2 = createJoinRequest(dTag, hubContext.creatorPubkey, newIndexHashV2)
        const signedEventV2 = await authSigner({ ...unsignedEventV2, pubkey: modP })
        await publishCriticalWithFailover(signedEventV2, getRelays([...hub.generalRelays], { hubOnly: true }), [...hub.generalRelays])
        markDone('Publishing join request')

        useHubStore.getState().setModBanList(dTag, myPubkey, allBanPubkeysV2)
        console.log(`Mod-banned ${displayPubkey.slice(0, 8)}... from hub ${dTag} (v2)`)

        await markStep('Done')
        return
      }

      await markStep('Fetching join request')
      const {
        downloadTextFromBlossom, parseIndexFile, uploadToBlossomServers,
        uploadBanPages, createIndexFile,
      } = await import('@/lib/blossom')
      const { createJoinRequest, signWithSigner: signFn } = await import('@/lib/nostr/events')
      const { publishToSpecificRelays: pubToRelays, fetchEvents: fetchEvt } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays: getRelays } = await import('@/stores/postingBehaviourStore')
      const { KINDS } = await import('@/lib/crypto/constants')

      const joinRequests = await fetchEvt({
        kinds: [KINDS.JOIN_REQUEST],
        authors: [myPubkey],
        '#d': [dTag],
        limit: 1,
      })

      let existingIndexHash = ''
      let existingTreeHash = ''
      let existingHistoryHash = ''

      if (joinRequests.length > 0) {
        const listTag = joinRequests[0].tags.find((t: string[]) => t[0] === 'list')
        if (listTag?.[1]) {
          existingIndexHash = listTag[1]
          try {
            const indexContent = await downloadTextFromBlossom(existingIndexHash, hub.blossomServers)
            const index = parseIndexFile(indexContent)
            existingTreeHash = index.treeHash
            existingHistoryHash = index.historyHash
          } catch { /* fresh start */ }
        }
      }
      markDone('Fetching join request')

      await markStep('Uploading ban page')
      const allBanPubkeys = [...existingModBans, displayPubkey]
      const banPageHashes = await uploadBanPages(
        allBanPubkeys.map(pk => ({ pubkey: pk, reason: '' })),
        signer, privateKey, hub.blossomServers,
      )
      markDone('Uploading ban page')

      await markStep('Uploading index file')
      const newIndexContent = createIndexFile(
        existingTreeHash,
        banPageHashes,
        existingHistoryHash || undefined,
      )
      const indexBytes = new TextEncoder().encode(newIndexContent)
      const { hash: newIndexHash } = await uploadToBlossomServers(
        indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )
      markDone('Uploading index file')

      await markStep('Publishing join request')
      const unsignedEvent = createJoinRequest(dTag, hubContext.creatorPubkey, newIndexHash)
      const signedEvent = await signFn(unsignedEvent, signer, privateKey)
      await publishCriticalWithFailover(signedEvent, getRelays([...hub.generalRelays]), [...hub.generalRelays])
      markDone('Publishing join request')

      useHubStore.getState().setModBanList(dTag, myPubkey, allBanPubkeys)
      console.log(`Mod-banned ${displayPubkey.slice(0, 8)}... from hub ${dTag}`)

      await markStep('Done')
    } catch (err: any) {
      console.error('Mod ban failed:', err)
      setModBanError(err?.message || 'Mod ban failed')
    } finally {
      setModBanning(false)
      setModBanStep(null)
    }
  }

  const handleModUnban = async () => {
    if (!displayPubkey || !hubContext || !myPubkey || modBanning) return
    setShowDropdown(false)
    setModBanning(true)
    setModBanError(null)
    setModBanSteps([])

    const markStep = async (step: string) => {
      setModBanStep(step)
      await new Promise(r => setTimeout(r, 0))
    }
    const markDone = (step: string) => setModBanSteps(prev => [...prev, step])

    try {
      const { dTag } = hubContext
      const hub = useHubStore.getState().hubs[dTag]
      if (!hub) throw new Error('Hub not found')

      const existingModBans = useHubStore.getState().modBanLists[dTag]?.[myPubkey] || []
      const remaining = existingModBans.filter(pk => pk !== displayPubkey)

      // ── v2 hubs: mirror handleModBan — author the list JR under the mod's pseudonym P,
      //    encrypt any remaining ban page under the hub secret, and auth every Blossom write
      //    as P — so neither R_mod nor the still-banned members' real keys R leak. ──
      const { isV2 } = await import('@/lib/hub/version')
      if (isV2(hub)) {
        const { hubMemberIdentity } = await import('@/lib/hub/hubMemberSign')
        const identity = await hubMemberIdentity(hub, { privateKey, signer })
        if (!identity) throw new Error('This hub is private (v2) — a local key or NIP-SKD signer is required to moderate here.')
        const { authKey: modP, authSigner } = identity

        const {
          downloadTextFromBlossom, parseIndexFile, uploadToBlossomServers,
          uploadBanPagesV2, createIndexFile,
        } = await import('@/lib/blossom')
        const { createJoinRequest } = await import('@/lib/nostr/events')
        const { publishToSpecificRelays: pubToRelays, fetchEvents: fetchEvt } = await import('@/lib/nostr/relay-pool')
        const { getPublishRelays: getRelays } = await import('@/stores/postingBehaviourStore')
        const { KINDS } = await import('@/lib/crypto/constants')

        await markStep('Fetching join request')
        // On v2 the mod's own list JR is authored by their pseudonym P, not R.
        const joinRequestsV2 = await fetchEvt({
          kinds: [KINDS.JOIN_REQUEST],
          authors: [modP],
          '#d': [dTag],
          limit: 1,
        })
        let existingTreeHashV2 = ''
        let existingHistoryHashV2 = ''
        if (joinRequestsV2.length > 0) {
          const listTag = joinRequestsV2[0].tags.find((t: string[]) => t[0] === 'list')
          if (listTag?.[1]) {
            try {
              const index = parseIndexFile(await downloadTextFromBlossom(listTag[1], hub.blossomServers))
              existingTreeHashV2 = index.treeHash
              existingHistoryHashV2 = index.historyHash
            } catch { /* fresh start */ }
          }
        }
        markDone('Fetching join request')

        await markStep('Uploading ban page')
        let banPageHashesV2: string[] = []
        if (remaining.length > 0) {
          const hubSecretHexV2 = useHubStore.getState().hubSecrets[dTag]
          if (!hubSecretHexV2) throw new Error('Hub secret not available')
          const { fromHex: fromHexV2 } = await import('@/lib/crypto/lkh')
          banPageHashesV2 = await uploadBanPagesV2(
            remaining.map(pk => ({ pubkey: pk, reason: '' })),
            fromHexV2(hubSecretHexV2), hub.epoch, signer, privateKey, hub.blossomServers, authSigner,
          )
        }
        markDone('Uploading ban page')

        await markStep('Uploading index file')
        const newIndexContentV2 = createIndexFile(
          existingTreeHashV2,
          banPageHashesV2,
          existingHistoryHashV2 || undefined,
        )
        const indexBytesV2 = new TextEncoder().encode(newIndexContentV2)
        const { hash: newIndexHashV2 } = await uploadToBlossomServers(
          indexBytesV2, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, authSigner,
        )
        markDone('Uploading index file')

        await markStep('Publishing join request')
        const unsignedEventV2 = createJoinRequest(dTag, hubContext.creatorPubkey, newIndexHashV2)
        const signedEventV2 = await authSigner({ ...unsignedEventV2, pubkey: modP })
        await publishCriticalWithFailover(signedEventV2, getRelays([...hub.generalRelays], { hubOnly: true }), [...hub.generalRelays])
        markDone('Publishing join request')

        useHubStore.getState().setModBanList(dTag, myPubkey, remaining)
        console.log(`Mod-unbanned ${displayPubkey.slice(0, 8)}... from hub ${dTag} (v2)`)

        await markStep('Done')
        return
      }

      await markStep('Fetching join request')
      const {
        downloadTextFromBlossom, parseIndexFile, uploadToBlossomServers,
        uploadBanPages, createIndexFile,
      } = await import('@/lib/blossom')
      const { createJoinRequest, signWithSigner: signFn } = await import('@/lib/nostr/events')
      const { publishToSpecificRelays: pubToRelays, fetchEvents: fetchEvt } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays: getRelays } = await import('@/stores/postingBehaviourStore')
      const { KINDS } = await import('@/lib/crypto/constants')

      const joinRequests = await fetchEvt({
        kinds: [KINDS.JOIN_REQUEST],
        authors: [myPubkey],
        '#d': [dTag],
        limit: 1,
      })

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
          } catch { /* fresh start */ }
        }
      }
      markDone('Fetching join request')

      await markStep('Uploading ban page')
      let banPageHashes: string[] = []
      if (remaining.length > 0) {
        banPageHashes = await uploadBanPages(
          remaining.map(pk => ({ pubkey: pk, reason: '' })),
          signer, privateKey, hub.blossomServers,
        )
      }
      markDone('Uploading ban page')

      await markStep('Uploading index file')
      const newIndexContent = createIndexFile(
        existingTreeHash,
        banPageHashes,
        existingHistoryHash || undefined,
      )
      const indexBytes = new TextEncoder().encode(newIndexContent)
      const { hash: newIndexHash } = await uploadToBlossomServers(
        indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )
      markDone('Uploading index file')

      await markStep('Publishing join request')
      const unsignedEvent = createJoinRequest(dTag, hubContext.creatorPubkey, newIndexHash)
      const signedEvent = await signFn(unsignedEvent, signer, privateKey)
      await publishCriticalWithFailover(signedEvent, getRelays([...hub.generalRelays]), [...hub.generalRelays])
      markDone('Publishing join request')

      useHubStore.getState().setModBanList(dTag, myPubkey, remaining)
      console.log(`Mod-unbanned ${displayPubkey.slice(0, 8)}... from hub ${dTag}`)

      await markStep('Done')
    } catch (err: any) {
      console.error('Mod unban failed:', err)
      setModBanError(err?.message || 'Mod unban failed')
    } finally {
      setModBanning(false)
      setModBanStep(null)
    }
  }

  if (!open) return null

  const bannerSrc = editing ? editProfile.banner : profile.banner
  const picSrc = editing ? editProfile.picture : profile.picture
  const displayName = profile.display_name || profile.name || truncateNpub(npub)

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-2" onClick={onClose}>
      <div
        className={`bg-card rounded-2xl w-full max-h-[85vh] overflow-hidden shadow-2xl border border-border/50 flex flex-col animate-in fade-in-0 zoom-in-95 duration-200 transition-[max-width] ${editing ? 'max-w-[540px]' : 'max-w-lg'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Banner ── (hidden in edit mode) */}
        {!editing && (
          <div className="relative h-32 bg-gradient-to-br from-primary/30 via-primary/10 to-secondary overflow-hidden">
            {bannerSrc && (
              <BlossomBannerImg src={bannerSrc} />
            )}
            {/* Gradient overlay at bottom for smooth transition */}
            <div className="absolute inset-x-0 bottom-0 h-12" />
            <button
              onClick={onClose}
              className="absolute top-2.5 right-2.5 p-1.5 rounded-full bg-black/40 text-white/90 hover:bg-black/60 hover:text-white cursor-pointer transition-all backdrop-blur-sm"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* ── Avatar + Actions row ── (hidden in edit mode) */}
        {!editing && (
          <div className="px-5 -mt-8 relative z-10 flex items-end justify-between">
            <div className="relative group">
              <Avatar className="h-[84px] w-[84px] border-[3px] border-card shadow-lg">
                {picSrc && <AvatarImage src={picSrc} />}
                <AvatarFallback className="text-xl font-semibold bg-gradient-to-br from-primary to-primary/60 text-primary-foreground">
                  {displayName.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            </div>

            {/* Action buttons */}
            <div className="flex gap-1.5 pb-1.5">
              {isSelf && (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="gap-1 h-8 rounded-full text-xs px-3">
                  <Pencil size={12} /> Edit
                </Button>
              )}
              {!isSelf && (
                <>
                  {/* DM button */}
                  {(
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleDM}
                            className="h-8 w-8 p-0 rounded-full"
                          >
                            <MessageCircle size={14} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Send Message</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}

                  {/* Follow button */}
                  <Button
                    variant={following ? 'outline' : 'default'}
                    size="sm"
                    onClick={handleFollow}
                    disabled={followLoading}
                    className="gap-1 h-8 rounded-full text-xs px-3"
                  >
                    {following ? <><UserMinus size={12} /> Unfollow</> : <><UserPlus size={12} /> Follow</>}
                  </Button>

                  {/* More options dropdown */}
                  <div className="relative" ref={dropdownRef}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!showDropdown) {
                          const r = dropdownRef.current?.getBoundingClientRect()
                          if (r) {
                            const right = Math.max(8, window.innerWidth - r.right)
                            const spaceBelow = window.innerHeight - r.bottom
                            // Open upward when there isn't room below and there's more room above — so a
                            // long menu is never clipped by the modal/viewport bottom.
                            setDropdownPos(spaceBelow < 320 && r.top > spaceBelow
                              ? { bottom: window.innerHeight - r.top + 4, right }
                              : { top: r.bottom + 4, right })
                          }
                        }
                        setShowDropdown(!showDropdown)
                      }}
                      className="h-8 w-8 p-0 rounded-full"
                    >
                      <MoreVertical size={14} />
                    </Button>
                    {showDropdown && dropdownPos && createPortal(
                      <div
                        ref={dropdownMenuRef}
                        style={{ position: 'fixed', right: dropdownPos.right, ...(dropdownPos.top != null ? { top: dropdownPos.top } : { bottom: dropdownPos.bottom }) }}
                        className="w-52 max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-popover/95 backdrop-blur-md shadow-xl z-[210] p-1 flex flex-col gap-1 animate-in fade-in-0 zoom-in-95">
                        {displayPubkey && (
                          <button
                            onClick={() => {
                              useSocialStore.getState().setActiveProfile(displayPubkey)
                              useNavigationStore.getState().setActivePage('social')
                              onClose()
                            }}
                            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-foreground hover:bg-accent/50 transition-colors cursor-pointer rounded-md"
                          >
                            <ExternalLink size={14} className="text-muted-foreground" />
                            Visit Social Profile
                          </button>
                        )}
                        <button
                          onClick={handleToggleBlock}
                          className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm transition-colors cursor-pointer rounded-md ${blocked
                            ? 'text-foreground hover:bg-accent/50'
                            : 'text-destructive hover:bg-destructive/10'
                            }`}
                        >
                          {blocked ? (
                            <><ShieldCheck size={14} className="text-muted-foreground" /> Unblock User</>
                          ) : (
                            <><ShieldBan size={14} /> Block User</>
                          )}
                        </button>
                        {isHubCreator && displayPubkey && targetIsMember && (
                          <button
                            onClick={handleRemoveMember}
                            disabled={banning}
                            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-amber-400 hover:bg-amber-500/10 transition-colors cursor-pointer disabled:opacity-40 rounded-md"
                          >
                            <UserMinus size={14} />
                            {banning ? 'Removing...' : 'Remove from Hub'}
                          </button>
                        )}
                        {isHubCreator && displayPubkey && (
                          <button
                            onClick={handleBanFromHub}
                            disabled={banning}
                            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors cursor-pointer disabled:opacity-40 rounded-md"
                          >
                            <ShieldBan size={14} />
                            {banning ? 'Banning...' : 'Ban from Hub'}
                          </button>
                        )}
                        {canModBan && displayPubkey && (
                          <button
                            onClick={isModBanned ? handleModUnban : handleModBan}
                            disabled={modBanning}
                            className={cn(
                              'flex items-center gap-2.5 w-full px-3 py-2 text-sm transition-colors cursor-pointer disabled:opacity-40 rounded-md',
                              isModBanned
                                ? 'text-foreground hover:bg-accent/50'
                                : 'text-amber-400 hover:bg-amber-500/10'
                            )}
                          >
                            {isModBanned ? <ShieldCheck size={14} className="text-muted-foreground" /> : <ShieldBan size={14} />}
                            {modBanning ? (isModBanned ? 'Unbanning...' : 'Banning...') : (isModBanned ? 'Mod Unban' : 'Mod Ban')}
                          </button>
                        )}
                        {hubContext && displayPubkey && (
                          <button
                            onClick={() => {
                              setShowDropdown(false)
                              setShowReportModal(true)
                            }}
                            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-amber-400 hover:bg-amber-500/10 transition-colors cursor-pointer rounded-md"
                          >
                            <Flag size={14} />
                            Report User
                          </button>
                        )}
                      </div>,
                      document.body,
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Edit mode header bar ── */}
        {editing && (
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <h3 className="text-sm font-semibold text-foreground">Edit Profile</h3>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
              <X size={16} />
            </button>
          </div>
        )}

        {/* ── Content (scrolls; header above and footer below stay fixed) ── */}
        <div className={`px-5 pb-5 overflow-y-auto flex-1 min-h-0 ${editing ? 'pt-4' : 'pt-3'}`}>
          {editing ? (
            /* Edit mode */
            <>
              <div className="space-y-4">
                {/* Banner upload */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground mb-0.5">Banner</label>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => { if (bannerUpStatus !== 'uploading') bannerInputRef.current?.click() }}
                      onDragOver={(e) => imgDragOver(e, setBannerDragOver)}
                      onDragLeave={(e) => imgDragLeave(e, setBannerDragOver)}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setBannerDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) startBannerEdit(f) }}
                      className={cn(
                        'w-full h-28 rounded-lg overflow-hidden border-2 border-dashed flex items-center justify-center cursor-pointer group transition-colors',
                        bannerDragOver ? 'border-primary bg-primary/10' : editProfile.banner ? 'border-transparent' : 'border-border hover:border-primary/50'
                      )}
                    >
                      {editProfile.banner ? (
                        <img src={editProfile.banner} alt="Banner" className="w-full h-full object-cover" />
                      ) : (
                        <div className="flex flex-col items-center gap-1 text-muted-foreground group-hover:text-primary/70">
                          <ImageIcon size={22} />
                          <span className="text-xs">Click or drop banner image</span>
                        </div>
                      )}
                      {bannerUpStatus === 'uploading' && (
                        <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-lg">
                          <Loader2 size={22} className="animate-spin text-white" />
                        </div>
                      )}
                      {editProfile.banner && bannerUpStatus !== 'uploading' && (
                        <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity rounded-lg ${bannerDragOver ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                          <ImageIcon size={18} className="text-white" />
                        </div>
                      )}
                    </button>
                    {editProfile.banner && bannerUpStatus !== 'uploading' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditProfile({ ...editProfile, banner: '' }) }}
                        className="absolute top-2 right-2 bg-black/50 text-white p-1 rounded-full hover:bg-black/70 cursor-pointer z-10"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  {bannerUpStatus === 'uploading' && bannerUpProgress && (
                    <ProfileUploadProgressBar progress={bannerUpProgress} abortRef={bannerAbortRef} />
                  )}
                  <div className="flex items-center gap-2 mt-0.5">
                    <label className="text-[10px] text-muted-foreground shrink-0">URL</label>
                    <Input className="h-6 text-[11px] font-mono" placeholder="https://..." value={editProfile.banner}
                      onChange={(e) => setEditProfile({ ...editProfile, banner: e.target.value })} />
                  </div>
                </div>
                <input ref={bannerInputRef} type="file" accept={ACCEPTED_IMAGE_EXTENSIONS} className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) startBannerEdit(f); e.target.value = '' }} />

                {/* Profile picture upload + name fields */}
                <div className="flex items-start gap-4">
                  <div className="flex flex-col items-center gap-1">
                    <button
                      type="button"
                      onClick={() => { if (picStatus !== 'uploading') picInputRef.current?.click() }}
                      onDragOver={(e) => imgDragOver(e, setPicDragOver)}
                      onDragLeave={(e) => imgDragLeave(e, setPicDragOver)}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setPicDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) startPicEdit(f) }}
                      className={cn(
                        'relative w-18 h-18 rounded-2xl border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer group transition-colors',
                        picDragOver ? 'border-primary bg-primary/10' : editProfile.picture ? 'border-transparent' : 'border-border hover:border-primary/50'
                      )}
                    >
                      {editProfile.picture ? (
                        <img src={editProfile.picture} alt="Avatar" className="w-full h-full object-cover" />
                      ) : (
                        <Camera size={18} className="text-muted-foreground group-hover:text-primary/70" />
                      )}
                      {picStatus === 'uploading' && (
                        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                          <Loader2 size={16} className="animate-spin text-white" />
                        </div>
                      )}
                      {editProfile.picture && picStatus !== 'uploading' && (
                        <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity ${picDragOver ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                          <Camera size={14} className="text-white" />
                        </div>
                      )}
                    </button>
                    {editProfile.picture && picStatus !== 'uploading' && (
                      <button onClick={() => setEditProfile({ ...editProfile, picture: '' })} className="text-[10px] text-destructive hover:underline cursor-pointer">Remove</button>
                    )}
                    {picStatus === 'uploading' && picProgress && (
                      <ProfileUploadProgressBar progress={picProgress} abortRef={picAbortRef} small />
                    )}
                  </div>
                  <input ref={picInputRef} type="file" accept={ACCEPTED_IMAGE_EXTENSIONS} className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) startPicEdit(f); e.target.value = '' }} />

                  <div className="flex-1 flex flex-col gap-2">
                    <Field label="Display Name" value={editProfile.display_name} onChange={(v) => setEditProfile({ ...editProfile, display_name: v })} />
                  </div>
                </div>

                {/* URL fallback for picture */}
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-muted-foreground shrink-0">Picture URL</label>
                  <Input className="h-6 text-[11px] font-mono" placeholder="https://..." value={editProfile.picture}
                    onChange={(e) => setEditProfile({ ...editProfile, picture: e.target.value })} />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">About</label>
                  <textarea
                    value={editProfile.about}
                    onChange={(e) => setEditProfile({ ...editProfile, about: e.target.value })}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground resize-none outline-none transition-shadow"
                    rows={3}
                  />
                </div>
                <Field label="NIP-05" value={editProfile.nip05} onChange={(v) => setEditProfile({ ...editProfile, nip05: v })} placeholder="user@domain.com" />
                <Field label="Website" value={editProfile.website} onChange={(v) => setEditProfile({ ...editProfile, website: v })} placeholder="https://..." />
                <Field label="Lightning Address" value={editProfile.lud16} onChange={(v) => setEditProfile({ ...editProfile, lud16: v })} placeholder="user@wallet.com" />
              </div>

              {/* File size warning modal */}
              {picEditFile && (
                <ImageCropModal
                  file={picEditFile}
                  aspect={1}
                  round
                  maxOutput={1024}
                  title="Edit profile picture"
                  onCancel={() => setPicEditFile(null)}
                  onUploadOriginal={() => { const f = picEditFile; setPicEditFile(null); uploadPicture(f) }}
                  onSave={(f) => { setPicEditFile(null); uploadPicture(f) }}
                />
              )}

              {bannerEditFile && (
                <ImageCropModal
                  file={bannerEditFile}
                  aspect={3}
                  maxOutput={1500}
                  title="Edit banner"
                  onCancel={() => setBannerEditFile(null)}
                  onUploadOriginal={() => { const f = bannerEditFile; setBannerEditFile(null); uploadBanner(f) }}
                  onSave={(f) => { setBannerEditFile(null); uploadBanner(f) }}
                />
              )}

              {fileSizeWarning && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={() => setFileSizeWarning(null)}>
                  <div className="w-[360px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={18} className="text-amber-500 shrink-0" />
                      <h4 className="text-sm font-semibold text-foreground">File Too Large</h4>
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        The file exceeds the {fileSizeWarning.limitMb} MB upload limit:
                      </p>
                      <div className="text-xs font-mono text-foreground bg-secondary/50 px-2 py-1 rounded truncate">{fileSizeWarning.name}</div>
                      <p className="text-[10px] text-muted-foreground">
                        You can change this limit in <strong>Settings → Network → Media Upload Limit</strong>.
                      </p>
                    </div>
                    <button onClick={() => setFileSizeWarning(null)} className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
                      Got it
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* View mode */
            <div className="">
              {/* Name + username */}
              <div className="mb-2">
                <h2 className="text-lg font-bold text-foreground leading-tight">
                  {displayName}
                </h2>
                {displayPubkey && (
                  <div className="mt-0.5 flex items-center">
                    <DnnBadge pubkey={displayPubkey} />
                  </div>
                )}
              </div>

              {/* NIP-38 general status (kind 30315, d="general") */}
              {editingStatus ? (
                <div className="mb-2 flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={statusDraft}
                    onChange={(e) => setStatusDraft(e.target.value.slice(0, STATUS_MAX))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveStatus()
                      if (e.key === 'Escape') { setEditingStatus(false); setStatusDraft(status) }
                    }}
                    maxLength={STATUS_MAX}
                    placeholder="Set a status…"
                    className="flex-1 min-w-0 bg-secondary/60 rounded-full px-3 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <span className={`text-[10px] font-mono tabular-nums select-none shrink-0 ${statusDraft.length >= STATUS_MAX ? 'text-amber-400' : 'text-muted-foreground/40'}`}>
                    {statusDraft.length}/{STATUS_MAX}
                  </span>
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={saveStatus}
                          disabled={statusSaving}
                          className="p-1 rounded-md text-emerald-400 hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:opacity-40"
                        >
                          {statusSaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">Save status</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => { setEditingStatus(false); setStatusDraft(status) }}
                          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
                        >
                          <X size={13} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">Cancel</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              ) : status ? (
                <div className="mb-2 flex items-center gap-1.5 min-w-0">
                  <span className="inline-flex items-center min-w-0 max-w-full px-2.5 py-1 rounded-full bg-secondary/60 text-xs text-foreground/90">
                    <span className="truncate">{status}</span>
                  </span>
                  {isSelf && (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => { setStatusDraft(status); setEditingStatus(true) }}
                            className="p-1 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0"
                          >
                            <Pencil size={12} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Edit status</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              ) : isSelf ? (
                <button
                  onClick={() => { setStatusDraft(''); setEditingStatus(true) }}
                  className="mb-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-secondary/40 hover:bg-secondary/70 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <Pencil size={11} /> Set a status
                </button>
              ) : null}

              {/* npub */}
              <button
                onClick={handleCopyNpub}
                className="flex items-center gap-1.5 px-2.5 py-1 mb-2 rounded-full bg-secondary/60 hover:bg-secondary text-xs text-muted-foreground hover:text-foreground transition-all cursor-pointer group"
              >
                <span className="font-mono text-[11px]">{truncateNpub(npub, 12)}</span>
                {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} className="opacity-60 group-hover:opacity-100 transition-opacity" />}
              </button>

              {/* Following button */}
              {followingLoaded && followingPubkeys.length > 0 && (
                <button
                  onClick={() => setShowFollowingList(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 mb-2 rounded-full bg-secondary/60 hover:bg-secondary text-xs text-muted-foreground hover:text-foreground transition-all cursor-pointer group"
                >
                  <Users size={11} className="opacity-60 group-hover:opacity-100 transition-opacity" />
                  <span className="font-medium">{followingPubkeys.length}</span>
                  <span>Following</span>
                </button>
              )}

              {/* Bio */}
              {profile.about && (
                <p className="text-sm text-foreground/85 whitespace-pre-wrap break-words leading-relaxed mb-2">{profile.about}</p>
              )}

              {/* Links button */}
              {(hasLinks || isSelf) && (
                <div className="flex items-center gap-1.5 mb-2">
                  <button
                    onClick={() => setShowLinksViewer(true)}
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/15 border border-primary/20 text-xs font-medium text-primary transition-colors cursor-pointer justify-center items-center"
                  >
                    <Link2 size={13} />
                    Links
                  </button>
                  {isSelf && (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => setShowLinksEditor(true)}
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
                          >
                            <Pencil size={12} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Edit links</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              )}

              {/* Metadata cards */}
              {(profile.nip05 || profile.website || profile.lud16) && (
                <div className="rounded-xl bg-secondary/30 border border-border/50 overflow-hidden divide-y divide-border/50">
                  {profile.nip05 && (
                    <DnnNip05Row pubkey={displayPubkey} nip05={profile.nip05} />
                  )}
                  {profile.website && (
                    <MetadataRow icon={<Globe size={14} />} label="Website" value={profile.website} isLink />
                  )}
                  {profile.lud16 && (
                    <MetadataRow icon={<Zap size={14} />} label="Lightning" value={profile.lud16} />
                  )}
                </div>
              )}

              {/* ── Roles (read-only display) ── */}
              {hubContext && displayPubkey && (
                <RoleAssignmentPanel hubDTag={hubContext.dTag} memberPubkey={displayPubkey} />
              )}
            </div>
          )}
        </div>
        {/* ── Sticky footer — Cancel / Publish (edit mode), always visible ── */}
        {editing && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setEditProfile(profile) }} className="h-8 rounded-full text-xs px-3">
              Cancel
            </Button>
            <Button size="sm" onClick={handlePublish} disabled={!hasChanges || publishing} className="h-8 rounded-full text-xs px-3">
              {publishing ? 'Publishing...' : 'Publish'}
            </Button>
          </div>
        )}
      </div>

      {/* Links modals */}
      {displayPubkey && (
        <>
          <LinksViewerModal
            open={showLinksViewer}
            onClose={() => setShowLinksViewer(false)}
            pubkey={displayPubkey}
            isSelf={isSelf}
            onEdit={() => { setShowLinksViewer(false); setShowLinksEditor(true) }}
          />
          {isSelf && (
            <LinksEditorModal
              open={showLinksEditor}
              onClose={() => setShowLinksEditor(false)}
              onSaved={() => {
                // Re-fetch links to update hasLinks
                fetchEvents({ kinds: [30003], authors: [displayPubkey] }).then((events) => {
                  const linkSets = events.filter((ev) => ev.tags.some((t) => t[0] === 'd' && t[1]?.startsWith('links-')))
                  setHasLinks(linkSets.some((ev) => ev.tags.some((t) => t[0] === 'r' && t[1])))
                })
              }}
            />
          )}
        </>
      )}
      {/* Report modal */}
      {showReportModal && hubContext && displayPubkey && (
        <ReportModal
          open={showReportModal}
          onClose={() => setShowReportModal(false)}
          hubDTag={hubContext.dTag}
          hubCreatorPubkey={hubContext.creatorPubkey}
          reportedPubkey={displayPubkey}
        />
      )}
      {/* Block type modal */}
      <BlockTypeModal
        open={showBlockTypeModal}
        onClose={() => setShowBlockTypeModal(false)}
        onSelect={handleBlockWithType}
        displayName={displayName}
      />
      {/* Follow safety warning modal */}
      {displayPubkey && (
        <FollowSafetyModal
          open={showFollowSafetyModal}
          onClose={() => setShowFollowSafetyModal(false)}
          targetPubkey={displayPubkey}
          onConfirmFollow={executeFollow}
          status={pendingFollowSafetyStatus}
        />
      )}
      {/* Following list modal */}
      <FollowingListModal
        open={showFollowingList}
        onClose={() => setShowFollowingList(false)}
        pubkeys={followingPubkeys}
      />
      {/* Creator ban progress overlay */}
      {(banning || banSteps.length > 0) && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.stopPropagation()}>
          <div className="bg-card rounded-xl border border-border shadow-2xl w-[340px] p-5 space-y-4 animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2.5">
              {banStep === 'Done' ? (
                <div className="w-8 h-8 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                  <Check size={16} className="text-emerald-400" />
                </div>
              ) : banError ? (
                <div className="w-8 h-8 rounded-full bg-destructive/15 flex items-center justify-center shrink-0">
                  <AlertTriangle size={16} className="text-destructive" />
                </div>
              ) : (
                <div className="w-8 h-8 rounded-full bg-destructive/15 flex items-center justify-center shrink-0">
                  <Loader2 size={16} className="text-destructive animate-spin" />
                </div>
              )}
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  {banError ? 'Ban Failed' : banStep === 'Done' ? 'User Banned from Hub' : 'Banning from Hub...'}
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  {banError ? banError : banStep === 'Done' ? 'All steps completed successfully' : banStep || 'Starting...'}
                </p>
              </div>
              <div className="flex-1" />
              <button
                onClick={() => { setBanning(false); setBanSteps([]); setBanStep(null); setBanError(null) }}
                className="p-1 rounded-full hover:bg-accent/50 transition-colors cursor-pointer shrink-0 self-start"
                title="Close"
              >
                <X size={14} className="text-muted-foreground" />
              </button>
            </div>

            {/* Step list */}
            <div className="space-y-1.5">
              {banStepLabels.map((step) => {
                const isDone = banSteps.includes(step)
                const isCurrent = banStep === step
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

            {/* Error: Retry + Dismiss */}
            {banError && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setBanError(null)
                    setBanStep(null)
                    setBanSteps([])
                    handleBanFromHub()
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 h-8 text-xs rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  <RotateCw size={12} /> Retry
                </button>
                <button
                  onClick={() => { setBanSteps([]); setBanStep(null); setBanError(null) }}
                  className="flex-1 h-8 text-xs rounded-lg font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Mod ban/unban progress overlay */}
      {(modBanning || modBanSteps.length > 0) && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.stopPropagation()}>
          <div className="bg-card rounded-xl border border-border shadow-2xl w-[340px] p-5 space-y-4 animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2.5">
              {modBanStep === 'Done' ? (
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
                  {modBanError ? 'Operation Failed' : modBanStep === 'Done' ? (isModBanned ? 'User Mod Banned' : 'User Mod Unbanned') : (isModBanned ? 'Unbanning User...' : 'Mod Banning User...')}
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  {modBanError ? modBanError : modBanStep === 'Done' ? 'All steps completed successfully' : modBanStep || 'Starting...'}
                </p>
              </div>
              <div className="flex-1" />
              <button
                onClick={() => { setModBanning(false); setModBanSteps([]); setModBanStep(null); setModBanError(null) }}
                className="p-1 rounded-full hover:bg-accent/50 transition-colors cursor-pointer shrink-0 self-start"
                title="Close"
              >
                <X size={14} className="text-muted-foreground" />
              </button>
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

            {/* Error: Retry + Dismiss */}
            {modBanError && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setModBanError(null)
                    setModBanStep(null)
                    setModBanSteps([])
                    isModBanned ? handleModUnban() : handleModBan()
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 h-8 text-xs rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  <RotateCw size={12} /> Retry
                </button>
                <button
                  onClick={() => { setModBanSteps([]); setModBanStep(null); setModBanError(null) }}
                  className="flex-1 h-8 text-xs rounded-lg font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange, placeholder }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 text-sm rounded-lg"
      />
    </div>
  )
}
/** NIP-05 row that shows verified DNN badge when applicable */
function DnnNip05Row({ pubkey, nip05 }: { pubkey: string | null; nip05: string }) {
  const dnnStatus = useDnnStore((s) => pubkey ? s.status[pubkey] : undefined)
  const dnnId = useDnnStore((s) => pubkey ? s.verified[pubkey]?.dnnId : undefined)
  const isVerifiedDnn = dnnStatus === 'verified' && !!dnnId && isDnnId(nip05)

  if (isVerifiedDnn) {
    return (
      <div className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
      <AtSign size={14} className="text-muted-foreground shrink-0" />
        <span className="text-muted-foreground text-xs w-14 shrink-0">NIP-05</span>
        <span className="text-primary truncate font-medium text-sm flex items-center gap-1">
          {formatDnnId(nip05)}
          <BadgeCheck size={12} className="text-primary shrink-0" />
        </span>
      </div>
    )
  }

  return (
    <MetadataRow icon={<AtSign size={14} />} label="NIP-05" value={nip05} />
  )
}

function MetadataRow({ icon, label, value, isLink }: { icon: React.ReactNode; label: string; value: string; isLink?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <span className="text-muted-foreground text-xs w-14 shrink-0">{label}</span>
      {isLink ? (
        <a href={value.startsWith('http') ? value : `https://${value}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate text-sm">
          {value}
        </a>
      ) : (
        <span className="text-foreground truncate font-medium text-sm">{value}</span>
      )}
    </div>
  )
}

function shortServerName(url: string): string {
  try { return new URL(url).hostname.replace('www.', '') } catch { return url }
}

function formatSpeed(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

function ProfileUploadProgressBar({ progress, abortRef, small }: {
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

/** Read-only role display — shows which roles a member has in this hub */
function RoleAssignmentPanel({ hubDTag, memberPubkey }: { hubDTag: string; memberPubkey: string }) {
  const hubData = useHubStore((s) => s.hubs[hubDTag])
  const hubMembers = useHubStore((s) => s.hubMembers[hubDTag])
  const member = hubMembers?.find(m => m.pubkey === memberPubkey)

  if (!hubData || !member) return null

  const currentRoleIds = member.roles ? member.roles.split('|').map(s => s.trim()).filter(Boolean) : []

  // Only show roles the member actually has
  const assignedRoles = hubData.roles.filter(r => {
    if (r.name === 'everyone') return currentRoleIds.length === 0 || (currentRoleIds.length === 1 && currentRoleIds[0] === 'everyone')
    return currentRoleIds.includes(r.roleId)
  })

  if (assignedRoles.length === 0) return null

  return (
    <div className="mt-3 rounded-xl bg-secondary/30 border border-border/50 p-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Roles</div>
      <div className="flex flex-wrap gap-1.5">
        {assignedRoles.map(role => (
          <span
            key={role.roleId}
            className="px-2 py-1 rounded-full text-[11px] font-medium"
            style={{
              backgroundColor: role.color ? `${role.color}20` : 'hsl(var(--primary) / 0.12)',
              color: role.color || 'hsl(var(--primary))',
            }}
          >
            {role.name}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ─── Following List Modal ─── */
function FollowingListModal({ open, onClose, pubkeys }: { open: boolean; onClose: () => void; pubkeys: string[] }) {
  useEscToClose(onClose, open)
  const { getProfile } = useProfileCache()
  const [search, setSearch] = useState('')

  if (!open) return null

  const filtered = pubkeys.filter((pk) => {
    if (!search.trim()) return true
    const p = getProfile(pk)
    const q = search.toLowerCase()
    return (
      pk.toLowerCase().includes(q) ||
      (p?.name || '').toLowerCase().includes(q) ||
      (p?.display_name || '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/60 backdrop-blur-sm p-2" onClick={onClose}>
      <div
        className="bg-card rounded-2xl w-full max-w-[400px] max-h-[70vh] overflow-hidden shadow-2xl border border-border/50 animate-in fade-in-0 zoom-in-95 duration-200 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Users size={14} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Following</h3>
            <span className="text-xs text-muted-foreground">({pubkeys.length})</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Search */}
        {pubkeys.length > 10 && (
          <div className="px-4 py-2 border-b border-border shrink-0">
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-8 rounded-lg bg-secondary/60 border border-border px-3 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40 transition-colors"
            />
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {filtered.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              {search ? 'No matches found' : 'Not following anyone'}
            </div>
          ) : (
            filtered.map((pk) => <FollowingListItem key={pk} pubkey={pk} />)
          )}
        </div>
      </div>
    </div>
  )
}

function FollowingListItem({ pubkey }: { pubkey: string }) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(pubkey)
  const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(pubkey), 10)
  const picture = profile?.picture
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(nip19.npubEncode(pubkey))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/30 transition-colors">
      <Avatar className="h-9 w-9 shrink-0">
        {picture && <AvatarImage src={picture} />}
        <AvatarFallback className="text-[10px] font-semibold bg-primary/20 text-primary">
          {name.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{name}</div>
        <div className="text-[10px] text-muted-foreground font-mono truncate">{truncateNpub(nip19.npubEncode(pubkey), 14)}</div>
      </div>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer shrink-0"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Copy npub</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
