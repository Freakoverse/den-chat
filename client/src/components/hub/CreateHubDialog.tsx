/**
 * CreateHubDialog — Dialog to create a new Hub
 *
 * Creates a hub event (Kind 36942), generates a hub secret,
 * encrypts it for the creator, uploads member files + images to Blossom,
 * and publishes to relays.
 */

import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Loader2, Plus, Hash, X, Camera, ImageIcon, Check, AlertTriangle, XCircle, ChevronDown, Trash2, Info, Lightbulb, KeyRound, Upload, FileSignature, Radio, ListPlus, Database, CheckCircle2 } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { HUB_NAME_MAX, HUB_DESCRIPTION_MAX, MAX_GENERAL_RELAYS, MAX_BLOSSOM_SERVERS } from '@/lib/hub/hubLimits'
import { useUserStore } from '@/stores/userStore'
import { useHubStore } from '@/stores/hubStore'
import { useUserListsStore } from '@/stores/userListsStore'
import { createUnsignedEvent, signWithSigner, createHubListEvent } from '@/lib/nostr'
import { publishToSpecificRelays, getRelayList } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { getRelays } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { createAndUploadMemberFiles, blossomServers as blossomServerManager, uploadToBlossomServers } from '@/lib/blossom'
import { DEFAULT_EVERYONE_PERMISSIONS } from '@/lib/hub/permissions'
import type { UploadProgress } from '@/lib/blossom'

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

/** Steps during hub creation */
type CreationStep =
  | 'generating-secret'
  | 'uploading-member-files'
  | 'building-event'
  | 'signing-event'
  | 'publishing-hub'
  | 'updating-hub-list'
  | 'finalizing'
  | 'done'
  | 'error'

const CREATION_STEPS: { key: CreationStep; label: string; icon: typeof KeyRound }[] = [
  { key: 'generating-secret', label: 'Generating hub secret', icon: KeyRound },
  { key: 'uploading-member-files', label: 'Uploading member files', icon: Upload },
  { key: 'building-event', label: 'Building hub event', icon: Database },
  { key: 'signing-event', label: 'Signing hub event', icon: FileSignature },
  { key: 'publishing-hub', label: 'Publishing to relays', icon: Radio },
  { key: 'updating-hub-list', label: 'Updating hub list', icon: ListPlus },
  { key: 'finalizing', label: 'Finalizing', icon: CheckCircle2 },
]

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const ACCEPTED_IMAGE_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.webp'

function isValidImageFile(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(file.type)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
}

/** Extract short server name from URL */
function shortServerName(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '')
  } catch {
    return url
  }
}

interface CreateHubDialogProps {
  open: boolean
  onClose: () => void
}

export function CreateHubDialog({ open, onClose }: CreateHubDialogProps) {
  const pubkey = useUserStore((s) => s.pubkey)
  const privateKey = useUserStore((s) => s.privateKey)
  const signer = useUserStore((s) => s.signer)
  const hubEntries = useHubStore((s) => s.hubEntries)
  const folders = useHubStore((s) => s.folders)
  const setHubEntries = useHubStore((s) => s.setHubEntries)
  const setHubData = useHubStore((s) => s.setHubData)
  const setHubSecret = useHubStore((s) => s.setHubSecret)
  const setActiveHub = useHubStore((s) => s.setActiveHub)
  const setHubStatus = useHubStore((s) => s.setHubStatus)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [nsfw, setNsfw] = useState(false)
  const [discoverable, setDiscoverable] = useState(true)
  const [addClientTag, setAddClientTag] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creationStep, setCreationStep] = useState<CreationStep | null>(null)
  const [completedSteps, setCompletedSteps] = useState<Set<CreationStep>>(new Set())
  const [memberFileProgress, setMemberFileProgress] = useState<{ fileIndex: number; totalFiles: number; label: string } | null>(null)

  // Image state
  const [iconPreview, setIconPreview] = useState<string | null>(null)
  const [iconHash, setIconHash] = useState<string | null>(null)
  const [iconStatus, setIconStatus] = useState<UploadStatus>('idle')
  const [iconProgress, setIconProgress] = useState<UploadProgress | null>(null)
  const [iconSuccessCount, setIconSuccessCount] = useState(0)

  const [bannerPreview, setBannerPreview] = useState<string | null>(null)
  const [bannerHash, setBannerHash] = useState<string | null>(null)
  const [bannerStatus, setBannerStatus] = useState<UploadStatus>('idle')
  const [bannerProgress, setBannerProgress] = useState<UploadProgress | null>(null)
  const [bannerSuccessCount, setBannerSuccessCount] = useState(0)

  const iconInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)

  // Per-server abort controllers
  const iconAbortRef = useRef<AbortController | null>(null)
  const bannerAbortRef = useRef<AbortController | null>(null)

  // Drag-drop state
  const [iconDragOver, setIconDragOver] = useState(false)
  const [bannerDragOver, setBannerDragOver] = useState(false)
  const [fileSizeWarning, setFileSizeWarning] = useState<{ name: string; limitMb: number } | null>(null)

  // ── Advanced relay selection ──
  const [showAdvanced, setShowAdvanced] = useState(false)
  const userRelays = useUserListsStore((s) => s.userRelays)
  const userBlossoms = useUserListsStore((s) => s.userBlossoms)

  // Relay entries: { url, enabled, type }
  interface RelayEntry { url: string; enabled: boolean; type: 'general' }
  const [clientRelayEntries, setClientRelayEntries] = useState<RelayEntry[]>([])
  const [userRelayEntries, setUserRelayEntries] = useState<RelayEntry[]>([])
  const [customRelayEntries, setCustomRelayEntries] = useState<RelayEntry[]>([])
  const [customRelayInput, setCustomRelayInput] = useState('')

  // Blossom entries: { url, enabled }
  interface BlossomEntry { url: string; enabled: boolean }
  const [clientBlossomEntries, setClientBlossomEntries] = useState<BlossomEntry[]>([])
  const [userBlossomEntries, setUserBlossomEntries] = useState<BlossomEntry[]>([])
  const [customBlossomEntries, setCustomBlossomEntries] = useState<BlossomEntry[]>([])
  const [customBlossomInput, setCustomBlossomInput] = useState('')

  const [relaysInitialized, setRelaysInitialized] = useState(false)

  // Initialize relay + blossom lists on first open — pick up to 3 random from each
  useEffect(() => {
    if (!open || relaysInitialized) return

    const pickRandom = (urls: string[], max: number): Set<string> => {
      const shuffled = [...urls].sort(() => Math.random() - 0.5)
      return new Set(shuffled.slice(0, max))
    }

    // Client relays
    const clientList = getRelayList().filter(r => r.enabled)
    const clientPicked = pickRandom(clientList.map(r => r.url), 3)
    setClientRelayEntries(clientList.map(r => ({
      url: r.url,
      enabled: clientPicked.has(r.url),
      type: 'general' as const,
    })))

    // User NIP-65 relays (dedup against client)
    const clientUrls = new Set(clientList.map(r => r.url))
    const uniqueUserRelays = userRelays.filter(u => !clientUrls.has(u))
    const userPicked = pickRandom(uniqueUserRelays, 3)
    setUserRelayEntries(uniqueUserRelays.map(url => ({
      url,
      enabled: userPicked.has(url),
      type: 'general' as const,
    })))

    // Client blossom servers
    const clientBlossomList = blossomServerManager.getList().filter(s => s.enabled)
    const blossomPicked = pickRandom(clientBlossomList.map(s => s.url), 3)
    setClientBlossomEntries(clientBlossomList.map(s => ({
      url: s.url,
      enabled: blossomPicked.has(s.url),
    })))

    // User blossom server list (dedup against client)
    const clientBlossomUrls = new Set(clientBlossomList.map(s => s.url))
    const uniqueUserBlossoms = userBlossoms.filter(u => !clientBlossomUrls.has(u))
    const userBlossomPicked = pickRandom(uniqueUserBlossoms, 3)
    setUserBlossomEntries(uniqueUserBlossoms.map(url => ({
      url,
      enabled: userBlossomPicked.has(url),
    })))

    setRelaysInitialized(true)
  }, [open, relaysInitialized, userRelays, userBlossoms])

  // Reset all state when dialog closes
  useEffect(() => {
    if (!open) {
      setRelaysInitialized(false)
      setShowAdvanced(false)
      setCustomRelayEntries([])
      setCustomRelayInput('')
      setCustomBlossomEntries([])
      setCustomBlossomInput('')
      setCreationStep(null)
      setCompletedSteps(new Set())
      setMemberFileProgress(null)
    }
  }, [open])

  // Collect all selected relays (deduplicated)
  const getSelectedRelays = (): string[] => {
    const all = [...clientRelayEntries, ...userRelayEntries, ...customRelayEntries]
    const enabled = all.filter(r => r.enabled).map(r => r.url)
    return [...new Set(enabled)]
  }

  // Collect all selected blossom servers (deduplicated)
  const getSelectedBlossoms = (): string[] => {
    const all = [...clientBlossomEntries, ...userBlossomEntries, ...customBlossomEntries]
    const enabled = all.filter(s => s.enabled).map(s => s.url)
    return [...new Set(enabled)]
  }

  if (!open) return null

  const handleDrop = (
    e: React.DragEvent,
    setPreview: (url: string | null) => void,
    setHash: (hash: string | null) => void,
    setStatus: (s: UploadStatus) => void,
    setProgress: (p: UploadProgress | null) => void,
    setSuccessCount: (n: number) => void,
    abortRef: React.MutableRefObject<AbortController | null>,
    setDragOver: (v: boolean) => void,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    if (!isValidImageFile(file)) {
      setError('Only image files are allowed (PNG, JPG, GIF, WebP)')
      return
    }
    handleImageUpload(file, setPreview, setHash, setStatus, setProgress, setSuccessCount, abortRef)
  }

  const handleDragOver = (e: React.DragEvent, setDragOver: (v: boolean) => void) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent, setDragOver: (v: boolean) => void) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }


  // Upload image to Blossom servers (sequential, with progress)
  const handleImageUpload = async (
    file: File,
    setPreview: (url: string | null) => void,
    setHash: (hash: string | null) => void,
    setStatus: (s: UploadStatus) => void,
    setProgress: (p: UploadProgress | null) => void,
    setSuccessCount: (n: number) => void,
    abortRef: React.MutableRefObject<AbortController | null>,
  ) => {
    // Enforce upload size limit from settings
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    if (file.size > limitMb * 1024 * 1024) {
      setFileSizeWarning({ name: file.name, limitMb })
      return
    }
    setStatus('uploading')
    setProgress(null)
    setSuccessCount(0)
    try {
      // Show local preview immediately
      const previewUrl = URL.createObjectURL(file)
      setPreview(previewUrl)

      // Read file as bytes
      const buffer = await file.arrayBuffer()
      const data = new Uint8Array(buffer)

      // Upload to 3 random Blossom servers sequentially
      const { hash, successCount } = await uploadToBlossomServers(
        data,
        signer,
        privateKey,
        undefined, // use default servers
        file.type,
        (progress) => setProgress({ ...progress }),
        () => {
          // Create a new AbortController for each server
          const controller = new AbortController()
          abortRef.current = controller
          return controller.signal
        },
      )
      setHash(hash)
      setSuccessCount(successCount)
      setStatus('success')
    } catch (err) {
      console.error('Image upload failed:', err)
      setStatus('error')
    } finally {
      setProgress(null)
      abortRef.current = null
    }
  }

  const cancelCurrentServerUpload = (abortRef: React.MutableRefObject<AbortController | null>) => {
    abortRef.current?.abort()
    abortRef.current = null
  }

  const removeImage = (
    setPreview: (v: null) => void,
    setHash: (v: null) => void,
    setStatus: (s: UploadStatus) => void,
    setProgress: (p: null) => void,
    setSuccessCount: (n: number) => void,
  ) => {
    setPreview(null)
    setHash(null)
    setStatus('idle')
    setProgress(null)
    setSuccessCount(0)
  }

  /** Progress indicator for an image upload */
  const UploadStatusDisplay = ({ status, progress, successCount, abortRef }: {
    status: UploadStatus
    progress: UploadProgress | null
    successCount: number
    abortRef: React.MutableRefObject<AbortController | null>
  }) => {
    if (status === 'uploading' && progress) {
      return (
        <div className="flex flex-col gap-0.5 w-full mt-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-amber-400 truncate max-w-[120px]">
              {shortServerName(progress.serverUrl)} ({progress.serverIndex + 1}/{progress.totalServers})
            </span>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => cancelCurrentServerUpload(abortRef)}
                    className="text-muted-foreground hover:text-destructive cursor-pointer flex items-center gap-0.5"
                  >
                    <XCircle size={10} />
                    <span className="text-[10px]">Skip</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Skip this server</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {/* Progress bar */}
          <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full bg-amber-400 rounded-full transition-all duration-150"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{progress.percent}%</span>
            <span>{formatSpeed(progress.speed)}</span>
          </div>
        </div>
      )
    }
    if (status === 'uploading') {
      return (
        <span className="flex items-center gap-1 text-xs text-amber-400 mt-1">
          <Loader2 size={10} className="animate-spin" /> Preparing…
        </span>
      )
    }
    if (status === 'success') {
      return (
        <span className="flex items-center gap-1 text-xs text-emerald-400 mt-1">
          <Check size={10} /> {successCount} server{successCount !== 1 ? 's' : ''}
        </span>
      )
    }
    if (status === 'error') {
      return (
        <span className="flex items-center gap-1 text-xs text-destructive mt-1">
          <AlertTriangle size={10} /> Failed
        </span>
      )
    }
    return null
  }

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Hub name is required')
      return
    }
    if (!pubkey || (!signer && !privateKey)) {
      setError('Must be logged in to create hubs')
      return
    }

    setLoading(true)
    setError(null)
    setCreationStep('generating-secret')
    setCompletedSteps(new Set())

    const markDone = (step: CreationStep) => setCompletedSteps(prev => new Set(prev).add(step))

    try {
      const dTag = crypto.randomUUID()
      const epoch = 1

      // Generate hub secret (32 random bytes)
      const hubSecret = crypto.getRandomValues(new Uint8Array(32))
      const hubSecretHex = Array.from(hubSecret).map(b => b.toString(16).padStart(2, '0')).join('')
      markDone('generating-secret')

      // Build single default 'general' channel
      const channelDefs = [{
        channel_id: crypto.randomUUID(),
        name: 'general',
        type: 'chat' as const,
        category_id: null,
        synced: false,
        encryption: null,
        position: 0,
        permissions: {},
      }]

      // Default "everyone" role
      const roles = [{
        role_id: crypto.randomUUID(),
        name: 'everyone',
        position: 0,
        permissions: { ...DEFAULT_EVERYONE_PERMISSIONS },
      }]

      // Build image URLs from Blossom hashes (dedup by normalized URL to avoid trailing-slash duplicates)
      const rawBlossoms = getSelectedBlossoms().length > 0 ? getSelectedBlossoms() : blossomServerManager.getServers().slice(0, 3)
      const blossomServerList = [...new Set(rawBlossoms.map(u => u.replace(/\/+$/, '')))]
      const iconUrl = iconHash ? `${blossomServerList[0]}/${iconHash}` : undefined
      const bannerUrl = bannerHash ? `${blossomServerList[0]}/${bannerHash}` : undefined

      // JSON content per NIP-CHAT spec §6.1
      const contentObj = {
        settings: {
          description: description.trim() || undefined,
          icon: iconUrl,
          banner: bannerUrl,
        },
        roles,
        grouped_roles: [],
        categories: [],
        channels: channelDefs,
        plugins: {},
      }

      // Get relays from advanced selection (or fall back to client relays)
      const selectedRelays = getSelectedRelays()
      const relays = selectedRelays.length > 0 ? selectedRelays : getRelays()

      // Upload member files to Blossom
      setCreationStep('uploading-member-files')
      let indexHash = ''
      if (pubkey) {
        try {
           const result = await createAndUploadMemberFiles(
            pubkey,
            dTag,
            hubSecret,
            privateKey,
            signer,
            blossomServerList,
            (info) => setMemberFileProgress(info),
          )
          indexHash = result.indexHash
        } catch (err) {
          console.warn('Blossom upload failed, hub created without member files:', err)
        }
        markDone('uploading-member-files')
        setMemberFileProgress(null)
      }

      // Build hub event tags per NIP-CHAT spec
      setCreationStep('building-event')
      const tags: [string, ...string[]][] = [
        ['d', dTag],
        ['n', name.trim()],
        ['epoch', epoch.toString()],
      ]

      for (const relay of relays) {
        tags.push(['r', relay, 'general'])
      }
      for (const server of blossomServerList) {
        tags.push(['o', server])
      }
      if (indexHash) {
        tags.push(['m', indexHash, epoch.toString()])
      }
      // NSFW / content-warning tags
      if (nsfw) {
        tags.push(['content-warning', ''])
        tags.push(['L', 'content-warning'])
      }
      // PoW difficulty tag
      tags.push(['w', '15'])
      // Discoverable flag
      tags.push(['f', discoverable ? 'on' : 'off'])
      // Client tag for hub discovery
      if (addClientTag) {
        tags.push(['client', 'DEN Chat'])
      }

      markDone('building-event')

      // Create and sign hub event with JSON content
      setCreationStep('signing-event')
      const unsigned = createUnsignedEvent(KINDS.HUB_EVENT, JSON.stringify(contentObj), tags)
      // Set published_at to match created_at on first creation (per NIP-CHAT spec §6.1)
      unsigned.tags = [...unsigned.tags, ['published_at', unsigned.created_at.toString()]]
      const signed = await signWithSigner(unsigned, signer, privateKey)
      markDone('signing-event')

      // Publish to relays
      setCreationStep('publishing-hub')
      const accepted = await publishToSpecificRelays(getPublishRelays(), signed)
      if (accepted.length === 0) {
        console.warn('No relays accepted the hub event yet')
      }
      markDone('publishing-hub')

      // Set hub data in store BEFORE updating hub entries — prevents the hub loader
      // from racing with the signer to decrypt the secret (which causes extension drops)
      setCreationStep('finalizing')
      const secretHexStr = Array.from(hubSecret).map(b => b.toString(16).padStart(2, '0')).join('')
      setHubData(dTag, {
        dTag,
        creatorPubkey: pubkey!,
        name: name.trim(),
        icon: iconUrl,
        banner: bannerUrl,
        description: description.trim(),
        epoch,
        generalRelays: relays,
        filterRelays: [],
        blossomServers: blossomServerList,
        indexFileHash: indexHash,
        channels: channelDefs.map((ch) => ({
          channelId: ch.channel_id,
          name: ch.name,
          type: ch.type,
          categoryId: null,
          synced: false,
          encryption: null,
          position: ch.position,
        })),
        categories: [],
        roles: roles.map(r => ({
          roleId: r.role_id,
          name: r.name,
          position: r.position,
          permissions: r.permissions as Record<string, boolean>,
        })),
        minPow: 15,
        nsfw,
        discoverable,
      })
      setHubSecret(dTag, secretHexStr)
      setHubStatus(dTag, 'loaded')

      // Update user's hub list — safe now because hub data/secret are already in store,
      // so the hub loader will find it "loaded" and skip the NIP-04 decrypt
      setCreationStep('updating-hub-list')
      const newEntry = { dTag, relayHint: relays[0] || '', position: hubEntries.length, folderId: undefined }
      const newEntries = [...hubEntries, newEntry]
      setHubEntries(newEntries, folders)

      const hubListEvent = createHubListEvent(
        newEntries.map(e => ({ dTag: e.dTag, relayHint: e.relayHint, position: e.position, folderId: e.folderId })),
        folders
      )
      const signedHubList = await signWithSigner(hubListEvent, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(), signedHubList)
      markDone('updating-hub-list')
      markDone('finalizing')

      setCreationStep('done')
      // Brief pause so the user sees the completed state
      await new Promise(r => setTimeout(r, 800))

      setActiveHub(dTag)
      onClose()
    } catch (err) {
      setCreationStep('error')
      setError(err instanceof Error ? err.message : 'Failed to create hub')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2">
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />

      <div className="relative z-10 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg animate-in fade-in-0 zoom-in-95 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">Create Hub</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4">
          {/* Hub Icon & Banner */}
          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium text-foreground">Hub Images <span className="text-muted-foreground font-normal">(optional)</span></label>

            <div className="flex items-start gap-4">
              {/* Icon */}
              <div className="flex flex-col items-center gap-0 min-w-[72px]">
                <button
                  type="button"
                  onClick={() => iconInputRef.current?.click()}
                  disabled={iconStatus === 'uploading'}
                  onDragOver={(e) => handleDragOver(e, setIconDragOver)}
                  onDragLeave={(e) => handleDragLeave(e, setIconDragOver)}
                  onDrop={(e) => handleDrop(e, setIconPreview, setIconHash, setIconStatus, setIconProgress, setIconSuccessCount, iconAbortRef, setIconDragOver)}
                  className={`relative w-16 h-16 rounded-2xl border-2 border-dashed flex items-center justify-center overflow-hidden transition-colors cursor-pointer group ${
                    iconDragOver ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'
                  }`}
                >
                  {iconPreview ? (
                    <img src={iconPreview} alt="Hub icon" className="w-full h-full object-cover" />
                  ) : (
                    <Camera size={20} className="text-muted-foreground group-hover:text-primary/70" />
                  )}
                  {iconStatus === 'uploading' && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <Loader2 size={18} className="animate-spin text-white" />
                    </div>
                  )}
                  {iconPreview && iconStatus !== 'uploading' && (
                    <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity ${iconDragOver ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                      <Camera size={16} className="text-white" />
                    </div>
                  )}
                </button>
                <span className="text-xs text-muted-foreground mt-1">Icon</span>
                <UploadStatusDisplay status={iconStatus} progress={iconProgress} successCount={iconSuccessCount} abortRef={iconAbortRef} />
                {iconPreview && iconStatus !== 'uploading' && (
                  <button
                    onClick={() => removeImage(setIconPreview, setIconHash, setIconStatus, setIconProgress, setIconSuccessCount)}
                    className="text-xs text-destructive hover:underline cursor-pointer mt-0.5"
                  >
                    Remove
                  </button>
                )}
              </div>

              {/* Banner */}
              <div className="flex-1 flex flex-col items-center gap-0">
                <button
                  type="button"
                  onClick={() => bannerInputRef.current?.click()}
                  disabled={bannerStatus === 'uploading'}
                  onDragOver={(e) => handleDragOver(e, setBannerDragOver)}
                  onDragLeave={(e) => handleDragLeave(e, setBannerDragOver)}
                  onDrop={(e) => handleDrop(e, setBannerPreview, setBannerHash, setBannerStatus, setBannerProgress, setBannerSuccessCount, bannerAbortRef, setBannerDragOver)}
                  className={`relative w-full h-16 rounded-lg border-2 border-dashed flex items-center justify-center overflow-hidden transition-colors cursor-pointer group ${
                    bannerDragOver ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'
                  }`}
                >
                  {bannerPreview ? (
                    <img src={bannerPreview} alt="Hub banner" className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon size={20} className="text-muted-foreground group-hover:text-primary/70" />
                  )}
                  {bannerStatus === 'uploading' && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <Loader2 size={18} className="animate-spin text-white" />
                    </div>
                  )}
                  {bannerPreview && bannerStatus !== 'uploading' && (
                    <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity ${bannerDragOver ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                      <ImageIcon size={16} className="text-white" />
                    </div>
                  )}
                </button>
                <span className="text-xs text-muted-foreground mt-1">Banner</span>
                <UploadStatusDisplay status={bannerStatus} progress={bannerProgress} successCount={bannerSuccessCount} abortRef={bannerAbortRef} />
                {bannerPreview && bannerStatus !== 'uploading' && (
                  <button
                    onClick={() => removeImage(setBannerPreview, setBannerHash, setBannerStatus, setBannerProgress, setBannerSuccessCount)}
                    className="text-xs text-destructive hover:underline cursor-pointer mt-0.5"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            {/* Hidden file inputs */}
            <input
              ref={iconInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_EXTENSIONS}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleImageUpload(file, setIconPreview, setIconHash, setIconStatus, setIconProgress, setIconSuccessCount, iconAbortRef)
                e.target.value = ''
              }}
            />
            <input
              ref={bannerInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_EXTENSIONS}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleImageUpload(file, setBannerPreview, setBannerHash, setBannerStatus, setBannerProgress, setBannerSuccessCount, bannerAbortRef)
                e.target.value = ''
              }}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-foreground">Hub Name</label>
              <span className={`text-[11px] font-mono tabular-nums select-none transition-colors ${
                name.length > HUB_NAME_MAX ? 'text-red-400 font-semibold' : name.length > HUB_NAME_MAX - 20 ? 'text-amber-400' : 'text-muted-foreground/60'
              }`}>
                {name.length}/{HUB_NAME_MAX}
              </span>
            </div>
            <Input
              placeholder="My Awesome Hub"
              value={name}
              maxLength={HUB_NAME_MAX}
              onChange={(e) => { setName(e.target.value); setError(null) }}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-foreground">Description</label>
              <span className={`text-[11px] font-mono tabular-nums select-none transition-colors ${
                description.length > HUB_DESCRIPTION_MAX ? 'text-red-400 font-semibold' : description.length > HUB_DESCRIPTION_MAX - 100 ? 'text-amber-400' : 'text-muted-foreground/60'
              }`}>
                {description.length}/{HUB_DESCRIPTION_MAX}
              </span>
            </div>
            <textarea
              placeholder="What's this hub about?"
              value={description}
              maxLength={HUB_DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            />
          </div>

          {/* NSFW Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-foreground">NSFW Hub</label>
              <p className="text-xs text-muted-foreground">Is this hub primarily for NSFW content?</p>
            </div>
            <button
              onClick={() => setNsfw(!nsfw)}
              className={cn(
                'relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0',
                nsfw ? 'bg-primary' : 'bg-muted-foreground/30'
              )}
            >
              <div className={cn(
                'absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform',
                nsfw ? 'translate-x-[22px]' : 'translate-x-[3px]'
              )} />
            </button>
          </div>

          {/* Discoverable Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-foreground">Discoverable</label>
              <p className="text-xs text-muted-foreground">Allow this hub to appear in public search and browse</p>
            </div>
            <button
              onClick={() => setDiscoverable(!discoverable)}
              className={cn(
                'relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0',
                discoverable ? 'bg-primary' : 'bg-muted-foreground/30'
              )}
            >
              <div className={cn(
                'absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform',
                discoverable ? 'translate-x-[22px]' : 'translate-x-[3px]'
              )} />
            </button>
          </div>

          {/* ── Advanced: Relay Selection ── */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <ChevronDown size={14} className={cn('transition-transform', showAdvanced && 'rotate-180')} />
              Advanced
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-4 pl-1">
                {/* Client Tag Toggle */}
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <label className="text-sm font-medium text-foreground">Client Tag</label>
                    <p className="text-xs text-muted-foreground mt-0.5">Adds a <code className="text-[10px] bg-secondary px-1 py-0.5 rounded">client</code> tag identifying the app used to create this hub. Helps with discovery — recommended to keep on.</p>
                  </div>
                  <button
                    onClick={() => setAddClientTag(!addClientTag)}
                    className={cn(
                      'relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0 ml-3',
                      addClientTag ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                  >
                    <div className={cn(
                      'absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform',
                      addClientTag ? 'translate-x-[22px]' : 'translate-x-[3px]'
                    )} />
                  </button>
                </div>

                <Separator className="my-2" />

                {/* Relay header with counter */}
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-foreground">Relays</h4>
                  <span className={`text-[11px] font-mono tabular-nums select-none transition-colors ${
                    getSelectedRelays().length >= MAX_GENERAL_RELAYS ? 'text-amber-400' : 'text-muted-foreground/60'
                  }`}>
                    {getSelectedRelays().length}/{MAX_GENERAL_RELAYS}
                  </span>
                </div>

                {/* Info note */}
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20">
                  <Info size={14} className="text-primary shrink-0 mt-0.5" />
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    These relays determine where hub messages are read from and written to. All members will use them to send and receive messages. If you're unsure, leave the defaults.
                  </p>
                </div>

                {/* Client Relays */}
                {clientRelayEntries.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Client Relays</h4>
                    <div className="space-y-1">
                      {clientRelayEntries.map((entry, i) => (
                        <div key={entry.url} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-secondary/30 border border-border">
                          <button
                            type="button"
                            onClick={() => {
                              const copy = [...clientRelayEntries]
                              copy[i] = { ...entry, enabled: !entry.enabled }
                              setClientRelayEntries(copy)
                            }}
                            className={cn(
                              'relative w-8 h-[18px] rounded-full transition-colors cursor-pointer shrink-0',
                              entry.enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                            )}
                          >
                            <div className={cn(
                              'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform',
                              entry.enabled ? 'translate-x-[16px]' : 'translate-x-[2px]'
                            )} />
                          </button>
                          <span className="text-xs text-foreground font-mono truncate flex-1">{entry.url}</span>
                          <span className="h-6 flex items-center text-[10px] rounded border border-border bg-background px-1.5 text-muted-foreground select-none">general</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* User Relay List (NIP-65) */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">User Relay List (NIP-65)</h4>
                  {userRelayEntries.length > 0 ? (
                    <div className="space-y-1">
                      {userRelayEntries.map((entry, i) => (
                        <div key={entry.url} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-secondary/30 border border-border">
                          <button
                            type="button"
                            onClick={() => {
                              const copy = [...userRelayEntries]
                              copy[i] = { ...entry, enabled: !entry.enabled }
                              setUserRelayEntries(copy)
                            }}
                            className={cn(
                              'relative w-8 h-[18px] rounded-full transition-colors cursor-pointer shrink-0',
                              entry.enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                            )}
                          >
                            <div className={cn(
                              'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform',
                              entry.enabled ? 'translate-x-[16px]' : 'translate-x-[2px]'
                            )} />
                          </button>
                          <span className="text-xs text-foreground font-mono truncate flex-1">{entry.url}</span>
                          <span className="h-6 flex items-center text-[10px] rounded border border-border bg-background px-1.5 text-muted-foreground select-none">general</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground/60 italic">No NIP-65 relay list published</p>
                  )}
                </div>

                {/* Custom Relays */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Custom</h4>
                  {customRelayEntries.length > 0 && (
                    <div className="space-y-1">
                      {customRelayEntries.map((entry, i) => (
                        <div key={entry.url} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-secondary/30 border border-border">
                          <button
                            type="button"
                            onClick={() => {
                              const copy = [...customRelayEntries]
                              copy[i] = { ...entry, enabled: !entry.enabled }
                              setCustomRelayEntries(copy)
                            }}
                            className={cn(
                              'relative w-8 h-[18px] rounded-full transition-colors cursor-pointer shrink-0',
                              entry.enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                            )}
                          >
                            <div className={cn(
                              'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform',
                              entry.enabled ? 'translate-x-[16px]' : 'translate-x-[2px]'
                            )} />
                          </button>
                          <span className="text-xs text-foreground font-mono truncate flex-1">{entry.url}</span>
                          <span className="h-6 flex items-center text-[10px] rounded border border-border bg-background px-1.5 text-muted-foreground select-none">general</span>
                          <button
                            type="button"
                            onClick={() => setCustomRelayEntries(customRelayEntries.filter((_, j) => j !== i))}
                            className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      value={customRelayInput}
                      onChange={(e) => setCustomRelayInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          const trimmed = customRelayInput.trim()
                          if (!trimmed || !trimmed.startsWith('wss://')) return
                          const allUrls = [...clientRelayEntries, ...userRelayEntries, ...customRelayEntries].map(r => r.url)
                          if (allUrls.includes(trimmed)) return
                          setCustomRelayEntries([...customRelayEntries, { url: trimmed, enabled: true, type: 'general' }])
                          setCustomRelayInput('')
                        }
                      }}
                      placeholder="wss://relay.example.com"
                      className={`flex-1 h-7 rounded-md border bg-background px-2 text-xs placeholder:text-muted-foreground focus:outline-none ${customRelayInput.trim() && !customRelayInput.trim().startsWith('wss://') ? 'border-destructive/60 text-destructive' : 'border-input'}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const trimmed = customRelayInput.trim()
                        if (!trimmed || !trimmed.startsWith('wss://')) return
                        const allUrls = [...clientRelayEntries, ...userRelayEntries, ...customRelayEntries].map(r => r.url)
                        if (allUrls.includes(trimmed)) return
                        setCustomRelayEntries([...customRelayEntries, { url: trimmed, enabled: true, type: 'general' }])
                        setCustomRelayInput('')
                      }}
                      className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1"
                    >
                      <Plus size={12} /> Add
                    </button>
                  </div>
                  {customRelayInput.trim() && !customRelayInput.trim().startsWith('wss://') && (
                    <p className="text-[11px] text-destructive mt-0.5">Relay URL must start with wss://</p>
                  )}
                </div>

                {/* Tip */}
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
                  <Lightbulb size={13} className="text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-muted-foreground">3 relays from each list is more than enough for most hubs.</p>
                </div>

                <Separator className="my-2" />

                {/* ── Blossom Servers ── */}
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-foreground">Blossom Servers</h4>
                  <span className={`text-[11px] font-mono tabular-nums select-none transition-colors ${
                    getSelectedBlossoms().length >= MAX_BLOSSOM_SERVERS ? 'text-amber-400' : 'text-muted-foreground/60'
                  }`}>
                    {getSelectedBlossoms().length}/{MAX_BLOSSOM_SERVERS}
                  </span>
                </div>

                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20">
                  <Info size={14} className="text-primary shrink-0 mt-0.5" />
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Blossom servers store hub files (member trees, icons, banners). Members download these files to join and participate.
                  </p>
                </div>

                {/* Client Blossom Servers */}
                {clientBlossomEntries.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Client Blossom Servers</h4>
                    <div className="space-y-1">
                      {clientBlossomEntries.map((entry, i) => (
                        <div key={entry.url} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-secondary/30 border border-border">
                          <button
                            type="button"
                            onClick={() => {
                              const copy = [...clientBlossomEntries]
                              copy[i] = { ...entry, enabled: !entry.enabled }
                              setClientBlossomEntries(copy)
                            }}
                            className={cn(
                              'relative w-8 h-[18px] rounded-full transition-colors cursor-pointer shrink-0',
                              entry.enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                            )}
                          >
                            <div className={cn(
                              'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform',
                              entry.enabled ? 'translate-x-[16px]' : 'translate-x-[2px]'
                            )} />
                          </button>
                          <span className="text-xs text-foreground font-mono truncate flex-1">{entry.url}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* User Blossom Server List */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">User Blossom List</h4>
                  {userBlossomEntries.length > 0 ? (
                    <div className="space-y-1">
                      {userBlossomEntries.map((entry, i) => (
                        <div key={entry.url} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-secondary/30 border border-border">
                          <button
                            type="button"
                            onClick={() => {
                              const copy = [...userBlossomEntries]
                              copy[i] = { ...entry, enabled: !entry.enabled }
                              setUserBlossomEntries(copy)
                            }}
                            className={cn(
                              'relative w-8 h-[18px] rounded-full transition-colors cursor-pointer shrink-0',
                              entry.enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                            )}
                          >
                            <div className={cn(
                              'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform',
                              entry.enabled ? 'translate-x-[16px]' : 'translate-x-[2px]'
                            )} />
                          </button>
                          <span className="text-xs text-foreground font-mono truncate flex-1">{entry.url}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground/60 italic">No user blossom server list published</p>
                  )}
                </div>

                {/* Custom Blossom Servers */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Custom</h4>
                  {customBlossomEntries.length > 0 && (
                    <div className="space-y-1">
                      {customBlossomEntries.map((entry, i) => (
                        <div key={entry.url} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-secondary/30 border border-border">
                          <button
                            type="button"
                            onClick={() => {
                              const copy = [...customBlossomEntries]
                              copy[i] = { ...entry, enabled: !entry.enabled }
                              setCustomBlossomEntries(copy)
                            }}
                            className={cn(
                              'relative w-8 h-[18px] rounded-full transition-colors cursor-pointer shrink-0',
                              entry.enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                            )}
                          >
                            <div className={cn(
                              'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform',
                              entry.enabled ? 'translate-x-[16px]' : 'translate-x-[2px]'
                            )} />
                          </button>
                          <span className="text-xs text-foreground font-mono truncate flex-1">{entry.url}</span>
                          <button
                            type="button"
                            onClick={() => setCustomBlossomEntries(customBlossomEntries.filter((_, j) => j !== i))}
                            className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      value={customBlossomInput}
                      onChange={(e) => setCustomBlossomInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          const trimmed = customBlossomInput.trim()
                          if (!trimmed || !trimmed.startsWith('https://')) return
                          const allUrls = [...clientBlossomEntries, ...userBlossomEntries, ...customBlossomEntries].map(s => s.url)
                          if (allUrls.includes(trimmed)) return
                          setCustomBlossomEntries([...customBlossomEntries, { url: trimmed, enabled: true }])
                          setCustomBlossomInput('')
                        }
                      }}
                      placeholder="https://blossom.example.com"
                      className={`flex-1 h-7 rounded-md border bg-background px-2 text-xs placeholder:text-muted-foreground focus:outline-none ${customBlossomInput.trim() && !customBlossomInput.trim().startsWith('https://') ? 'border-destructive/60 text-destructive' : 'border-input'}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const trimmed = customBlossomInput.trim()
                        if (!trimmed || !trimmed.startsWith('https://')) return
                        const allUrls = [...clientBlossomEntries, ...userBlossomEntries, ...customBlossomEntries].map(s => s.url)
                        if (allUrls.includes(trimmed)) return
                        setCustomBlossomEntries([...customBlossomEntries, { url: trimmed, enabled: true }])
                        setCustomBlossomInput('')
                      }}
                      className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1"
                    >
                      <Plus size={12} /> Add
                    </button>
                  </div>
                  {customBlossomInput.trim() && !customBlossomInput.trim().startsWith('https://') && (
                    <p className="text-[11px] text-destructive mt-0.5">Blossom URL must start with https://</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="flex gap-2 mt-2">
            <Button variant="outline" onClick={onClose} className="flex-1" disabled={loading}>
              Cancel
            </Button>
            <Button onClick={handleCreate} className="flex-1" disabled={loading || name.length > HUB_NAME_MAX || description.length > HUB_DESCRIPTION_MAX}>
              {loading ? <Loader2 size={16} className="animate-spin" /> : 'Create Hub'}
            </Button>
          </div>
        </div>
      </div>

      {/* Hub creation progress overlay */}
      {creationStep && creationStep !== 'error' && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center px-2 bg-black/70 backdrop-blur-sm">
          <div className="w-[380px] bg-card border border-border rounded-xl shadow-2xl p-6 space-y-5 animate-in fade-in-0 zoom-in-95" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center gap-3">
              {creationStep === 'done' ? (
                <div className="w-10 h-10 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                  <CheckCircle2 size={22} className="text-emerald-400" />
                </div>
              ) : (
                <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                  <Loader2 size={22} className="text-primary animate-spin" />
                </div>
              )}
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  {creationStep === 'done' ? 'Hub Created!' : 'Creating Hub…'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {creationStep === 'done'
                    ? 'Your hub is ready. Redirecting…'
                    : 'Please wait while we set everything up'
                  }
                </p>
              </div>
            </div>

            {/* Overall progress bar */}
            {(() => {
              const doneCount = CREATION_STEPS.filter(s => completedSteps.has(s.key)).length
              const pct = creationStep === 'done' ? 100 : Math.round((doneCount / CREATION_STEPS.length) * 100)
              return (
                <div className="space-y-1">
                  <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all duration-500 ease-out',
                        creationStep === 'done' ? 'bg-emerald-500' : 'bg-primary'
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground text-right">{pct}%</p>
                </div>
              )
            })()}

            {/* Step list */}
            <div className="space-y-1">
              {CREATION_STEPS.map((step) => {
                const isDone = completedSteps.has(step.key)
                const isCurrent = creationStep === step.key
                const Icon = step.icon
                return (
                  <div key={step.key}>
                    <div
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-300',
                        isCurrent && 'bg-primary/8 border border-primary/20',
                        isDone && !isCurrent && 'opacity-70',
                        !isDone && !isCurrent && 'opacity-35',
                      )}
                    >
                      {/* Status icon */}
                      <div className="w-5 h-5 flex items-center justify-center shrink-0">
                        {isDone ? (
                          <Check size={14} className="text-emerald-400" />
                        ) : isCurrent ? (
                          <Loader2 size={14} className="text-primary animate-spin" />
                        ) : (
                          <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
                        )}
                      </div>
                      {/* Step icon + label */}
                      <Icon size={14} className={cn(
                        isDone ? 'text-emerald-400' : isCurrent ? 'text-primary' : 'text-muted-foreground/50'
                      )} />
                      <span className={cn(
                        'text-xs',
                        isDone ? 'text-foreground' : isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground'
                      )}>
                        {step.label}
                      </span>
                    </div>
                    {/* Member file sub-progress */}
                    {step.key === 'uploading-member-files' && isCurrent && memberFileProgress && (
                      <div className="ml-11 mr-3 mt-1 mb-1 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-muted-foreground">
                            {memberFileProgress.label} ({memberFileProgress.fileIndex + 1}/{memberFileProgress.totalFiles})
                          </span>
                        </div>
                        {/* Mini segmented progress */}
                        <div className="flex gap-1">
                          {Array.from({ length: memberFileProgress.totalFiles }, (_, i) => (
                            <div
                              key={i}
                              className={cn(
                                'h-1 flex-1 rounded-full transition-all duration-300',
                                i < memberFileProgress.fileIndex ? 'bg-emerald-400'
                                  : i === memberFileProgress.fileIndex ? 'bg-primary animate-pulse'
                                  : 'bg-muted-foreground/20'
                              )}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

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
    </div>
  )
}
