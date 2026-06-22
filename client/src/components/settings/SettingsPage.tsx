import { useState, useEffect, useMemo, useCallback, useRef, Fragment, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTheme } from '@/providers/ThemeProvider'
import { useUserStore, type ISigner } from '@/stores/userStore'
import { useHubStore, type HubStatus, type HubFolder } from '@/stores/hubStore'
import { useBlockStore } from '@/stores/blockStore'
import { useFollowStore } from '@/stores/followStore'
import { useMessageStore } from '@/stores/messageStore'
import { useUserListsStore } from '@/stores/userListsStore'
import { usePostingBehaviourStore } from '@/stores/postingBehaviourStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useUpdateStore, startUpdateDownload, startUpdateInstall, detectOS } from '@/stores/updateStore'
import { useDnnStore } from '@/stores/dnnStore'
import { formatDnnId } from '@/lib/dnn/formatDnnId'
import { useRpcStore, DEFAULT_BITCOIN_NODES, DEFAULT_EVM_CHAINS, type EvmChain } from '@/stores/rpcStore'
import { useWotStore } from '@/stores/wotStore'
import { dnnService, type DnnNodeInfo } from '@/lib/dnn/dnnService'
import { useVoiceStore } from '@/stores/voiceStore'
import { usePreferencesStore, LANGUAGES, type LanguageCode } from '@/stores/preferencesStore'
import { useTypingStore } from '@/stores/typingStore'
import { StorageKey, ADMIN_NPUB, ADMIN_PUBKEY } from '@/lib/constants'
import { STANDARD_KINDS, KINDS } from '@/lib/crypto/constants'
import { blossomServers, uploadToBlossomServers, downloadFromBlossomWithProgress } from '@/lib/blossom'
import type { DownloadProgress } from '@/lib/blossom'
import { getRelayList, getDefaultRelays, setRelays, publishToSpecificRelays, fetchReplaceable, fetchEvents } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { createUnsignedEvent, signWithSigner, createHubListEvent, createDeletionEvent } from '@/lib/nostr/events'
import { DeleteConfirmDialog } from '@/components/hub/ChannelView'
import {
  getSoundEffectsConfig as getSfxConfig,
  getSoundNames as getSfxNames,
  setGlobalSoundEffectsEnabled as setGlobalSfxEnabled,
  setSoundEffectEnabled as setSfxEnabled,
  setSoundEffectVolume as setSfxVolume,
  setSoundEffect as setSfxFile,
  previewSoundEffect as previewSfx,
  hasCustomSound as hasSfxCustom,
  SOUND_LABELS as SFX_LABELS,
  type SoundEffectName as SfxName,
} from '@/lib/voice/soundEffects'
import { DenChatLogo } from '@/components/ui/DenChatLogo'
import {
  Settings, Palette, Globe, Shield, ShieldCheck, Info, Keyboard, MessageSquare, Users,
  Sun, Moon, Monitor, Plus, Minus, Trash2, Eye, EyeOff, Search,
  Copy, Check, Lock, FileDown, AlertTriangle, X, RotateCcw, RefreshCw,
  Loader2, Send, HelpCircle, XCircle, UserMinus, ShieldOff, Tag, Download, QrCode,
  GripVertical, FolderPlus, ChevronDown, ChevronRight, Pencil, ListPlus, Upload, Undo2,
  BookOpen, Mic, Volume2, Camera, MonitorPlay, Megaphone, Crown, Sparkles, Zap, Palette as PaletteIcon, BadgeCheck, MessageCircleOff, ArrowUp, ArrowDown, Heart, LogOut, Gamepad2, Activity, Save,
} from 'lucide-react'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { getVaultClient } from '@/lib/auth/vaultClient'
import { PinInput } from '@/components/auth/PinInput'
import { QRCodeSVG } from 'qrcode.react'
import { UserPanel } from '@/components/ui/UserPanel'
import { ResizablePanel } from '@/components/ui/ResizablePanel'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { DoodleBackground } from '@/components/ui/DoodleBackground'
import { DonateModal } from '@/components/settings/DonateModal'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { nip19 } from 'nostr-tools'
import { isTauri } from '@/lib/utils'
import {
  exportSeed, exportNsec, changePin, verifyPin,
  listSeeds, renameSeed,
} from '@/lib/auth/secure-storage'
import type { StoredSeed } from '@/lib/auth/secure-storage'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { MediaUploadStrip, useMediaUpload } from '@/components/social/MediaUploadStrip'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  getRenderLimit, setRenderLimit, resetRenderLimits, getRenderLimitDefault,
  LIMIT_MAX_SLIDER, type RenderLimitCategory,
} from '@/lib/imageSizeGuard'
import { getCacheBudgetMB, setCacheBudgetMB, getCacheStats, clearPersistentCache } from '@/lib/cache/blossomMediaCache'
import { MAX_HUB_LIST_ENTRIES, MAX_HUB_FOLDERS, FOLDER_NAME_MAX } from '@/lib/hub/hubLimits'

/* ─────────── types ─────────── */

type Tab = 'general' | 'preferences' | 'voice-video' | 'network' | 'keybinds' | 'game-chat' | 'my-hubs' | 'social-network' | 'moderation' | 'security' | 'dnn' | 'updates' | 'about' | 'faq' | 'guides' | 'advertisements' | 'premium' | 'admin'

const TABS: { id: Tab; label: string; icon: React.ReactNode; separatorBefore?: boolean; tooltip?: string }[] = [
  { id: 'general', label: 'General', icon: <Settings size={18} />, tooltip: 'Profile, language, and appearance' },
  { id: 'preferences', label: 'Preferences', icon: <Palette size={18} />, tooltip: 'Client behavior and media settings' },
  { id: 'voice-video', label: 'Voice & Video', icon: <Mic size={18} />, tooltip: 'Audio, video, and voice settings' },
  { id: 'network', label: 'Network', icon: <Globe size={18} />, tooltip: 'Relays and blossom servers' },
  { id: 'keybinds', label: 'Keybinds', icon: <Keyboard size={18} />, tooltip: 'Keyboard shortcuts' },
  { id: 'game-chat', label: 'Game Chat', icon: <Gamepad2 size={18} />, tooltip: 'In-game chat integration' },
  { id: 'my-hubs', label: 'My Hubs', icon: <MessageSquare size={18} />, tooltip: 'Manage your joined hubs' },
  { id: 'social-network', label: 'Social Network', icon: <Users size={18} />, tooltip: 'Follows, mutes, and web of trust' },
  { id: 'moderation', label: 'Moderation', icon: <ShieldCheck size={18} />, tooltip: 'Block lists and content filters' },
  { id: 'security', label: 'Security', icon: <Shield size={18} />, tooltip: 'Keys, seed phrase, and encryption' },
  { id: 'dnn', label: 'DNN', icon: <Activity size={18} />, tooltip: 'Decentralized node network' },
  { id: 'updates', label: 'Updates', icon: <Download size={18} />, separatorBefore: true, tooltip: 'Available builds and downloads' },
  { id: 'faq', label: 'FAQ', icon: <HelpCircle size={18} />, tooltip: 'Frequently asked questions' },
  { id: 'guides', label: 'Guides', icon: <BookOpen size={18} />, tooltip: 'Video tutorials and walkthroughs' },
  { id: 'about', label: 'About', icon: <Info size={18} />, tooltip: 'App info and credits' },
  { id: 'advertisements', label: 'Advertisements', icon: <Megaphone size={18} />, tooltip: 'Ad preferences and opt-out' },
  { id: 'premium', label: 'Premium', icon: <Crown size={18} />, tooltip: 'Subscription benefits' },
]



/* ─────────── main ─────────── */

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('general')
  const currentPubkey = useUserStore((s) => s.pubkey)
  const logout = useUserStore((s) => s.logout)
  const isAdmin = currentPubkey === ADMIN_PUBKEY

  // Allow other components to deep-link to a specific settings tab
  useEffect(() => {
    const { settingsTab, setSettingsTab } = useNavigationStore.getState()
    if (settingsTab && TABS.some(t => t.id === settingsTab)) {
      setTab(settingsTab as Tab)
      setSettingsTab(null) // consume it so it doesn't persist
    }
  }, [])

  // Find current tab config for mobile selector
  const allTabs = isAdmin ? [...TABS, { id: 'admin' as Tab, label: 'Admin', icon: <ShieldCheck size={18} />, separatorBefore: true, tooltip: 'Administration tools' }] : TABS
  const currentTab = allTabs.find(t => t.id === tab)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  return (
    <div className="flex flex-1 h-full overflow-hidden bg-background">
      {/* Left nav — hidden on mobile */}
      <ResizablePanel id="settings" defaultWidth={280} minWidth={200} maxWidth={420} className="flex flex-col border-r border-border bg-secondary/30 pt-4 max-[1080px]:hidden">
        <h2 className="px-4 text-sm font-semibold text-foreground mb-3">Settings</h2>
        <TooltipProvider delayDuration={400}>
          <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-1.5">
            {TABS.map((t) => {
              const btn = (
                <Tooltip key={t.id}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setTab(t.id)}
                      className={`flex items-center gap-3 w-full px-4 py-2.5 text-sm transition-colors cursor-pointer rounded-md
                      ${tab === t.id
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                        }`}
                    >
                      {t.icon}
                      {t.label}
                    </button>
                  </TooltipTrigger>
                  {t.tooltip && <TooltipContent side="right" className="text-xs">{t.tooltip}</TooltipContent>}
                </Tooltip>
              )
              return t.separatorBefore ? (
                <Fragment key={t.id}>
                  <div className="mx-4 my-2 border-t border-border" />
                  {btn}
                </Fragment>
              ) : (
                <Fragment key={t.id}>{btn}</Fragment>
              )
            })}
            {isAdmin && (
              <>
                <div className="mx-4 my-2 border-t border-border" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setTab('admin')}
                      className={`flex items-center gap-3 w-full px-4 py-2.5 text-sm transition-colors cursor-pointer rounded-md
                      ${tab === 'admin'
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                        }`}
                    >
                      <ShieldCheck size={18} />
                      Admin
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="text-xs">Administration tools</TooltipContent>
                </Tooltip>
              </>
            )}
            {/* Log out — always at bottom, separated */}
            <div className="mx-4 my-2 border-t border-border" />
            <button
              onClick={logout}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm transition-colors cursor-pointer rounded-md text-destructive hover:bg-destructive hover:text-white"
            >
              <LogOut size={18} />
              Log Out
            </button>
          </div>
        </TooltipProvider>
        <div className="mt-auto">
          <UserPanel />
        </div>
      </ResizablePanel>

      {/* Right content */}
      <div className="flex-1 relative overflow-hidden">
        <DoodleBackground className="[mask-image:linear-gradient(to_top_left,black,transparent_70%)] max-[1300px]:opacity-0 transition-opacity duration-300" />
        <div className="absolute inset-0 overflow-y-auto p-6 max-[1080px]:p-3 max-[1080px]:pb-12">
          {/* Mobile tab selector — shown only on mobile, sticky at top */}
          <div className="hidden max-[1080px]:block max-[1080px]:-top-3 mb-4 sticky top-0 z-30 -mx-3 px-3 -mt-3 pt-3 pb-2 bg-background">
            <button
              onClick={() => setMobileNavOpen(!mobileNavOpen)}
              className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg bg-secondary/60 border border-border text-sm font-medium text-foreground cursor-pointer"
            >
              <span className="flex items-center gap-2.5">
                {currentTab?.icon}
                {currentTab?.label || 'Settings'}
              </span>
              <ChevronDown size={14} className={`text-muted-foreground transition-transform ${mobileNavOpen ? 'rotate-180' : ''}`} />
            </button>
            {mobileNavOpen && (
              <div className="absolute top-full left-2 right-2 mt-1 rounded-xl border border-border bg-popover/95 backdrop-blur-md shadow-xl z-50 p-1 max-h-[60vh] overflow-y-auto animate-in fade-in-0 zoom-in-95">
                {allTabs.map((t) => (
                  <Fragment key={t.id}>
                    {t.separatorBefore && <div className="mx-3 my-1 border-t border-border" />}
                    <button
                      onClick={() => { setTab(t.id); setMobileNavOpen(false) }}
                      className={`flex items-center gap-3 w-full px-3 py-2 text-sm transition-colors cursor-pointer rounded-md
                        ${tab === t.id
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                        }`}
                    >
                      {t.icon}
                      {t.label}
                    </button>
                  </Fragment>
                ))}
                {/* Log out — mobile (desktop has it in the left nav) */}
                <div className="mx-3 my-1 border-t border-border" />
                <button
                  onClick={() => { setMobileNavOpen(false); logout() }}
                  className="flex items-center gap-3 w-full px-3 py-2 text-sm transition-colors cursor-pointer rounded-md text-destructive hover:bg-destructive hover:text-white"
                >
                  <LogOut size={18} />
                  Log Out
                </button>
              </div>
            )}
          </div>

          <div className="max-w-2xl relative z-10">
            {tab === 'general' && <GeneralTab />}
            {tab === 'preferences' && <PreferencesTab />}
            {tab === 'voice-video' && <VoiceVideoTab />}
            {tab === 'network' && <NetworkTab />}
            {tab === 'keybinds' && <KeybindsTab />}
            {tab === 'game-chat' && <GameChatTab />}
            {tab === 'my-hubs' && <MyHubsTab />}
            {tab === 'social-network' && <SocialNetworkTab />}
            {tab === 'moderation' && <ModerationTab />}
            {tab === 'security' && <SecurityTab />}
            {tab === 'dnn' && <DnnTab />}
            {tab === 'updates' && <UpdatesTab />}
            {tab === 'faq' && <FaqTab />}
            {tab === 'guides' && <GuidesTab />}
            {tab === 'about' && <AboutTab />}
            {tab === 'advertisements' && <AdvertisementsTab />}
            {tab === 'premium' && <PremiumTab />}
            {tab === 'admin' && isAdmin && <AdminTab />}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─────────── General ─────────── */

function GeneralTab() {
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const profile = myPubkey ? getProfile(myPubkey) : undefined
  const displayName = profile?.display_name || profile?.name || 'Anonymous'
  const npub = myPubkey ? nip19.npubEncode(myPubkey) : ''
  const [profileModalOpen, setProfileModalOpen] = useState(false)

  const [clientTag, setClientTag] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem('den-chat-client-tag') !== 'false' : true
  )

  const toggleClientTag = () => {
    const next = !clientTag
    setClientTag(next)
    localStorage.setItem('den-chat-client-tag', String(next))
  }

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">General</h3>

      <div className="space-y-4">
        {/* User Profile Card */}
        <button
          onClick={() => setProfileModalOpen(true)}
          className="flex items-center gap-3 w-full px-3 py-3 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer text-left group"
        >
          <Avatar className="w-11 h-11 shrink-0 ring-2 ring-primary/20 group-hover:ring-primary/40 transition-all">
            <AvatarImage src={profile?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
              {displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
            <p className="text-[11px] text-muted-foreground font-mono truncate">{truncateNpub(npub)}</p>
          </div>
          <span className="flex items-center gap-1.5 text-xs text-primary font-medium shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
            <Pencil size={12} />
            Edit User Profile
          </span>
        </button>

        {/* Client tag */}
        <div className="flex items-center justify-between px-3 py-3 rounded-lg border border-border bg-secondary/30">
          <div>
            <label className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <Tag size={14} /> Client Tag
            </label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Mentions that your posts, messages, and DMs were sent via DEN Chat. Other users and clients can see which app was used.
            </p>
          </div>
          <button
            onClick={toggleClientTag}
            className={`relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0
              ${clientTag ? 'bg-primary' : 'bg-muted-foreground/30'}`}
          >
            <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform
              ${clientTag ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>
      </div>

      {/* User Profile Modal — opens in edit mode */}
      <UserProfileModal
        open={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
        targetPubkey={myPubkey}
        startEditing
      />
    </div>
  )
}

/* ─────────── Preferences ─────────── */

function PreferencesTab() {
  const { themeSetting, setThemeSetting } = useTheme()
  const [showNsfw, setShowNsfw] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem('SHOW_NSFW') === 'true'
  )

  const toggleShowNsfw = () => {
    const next = !showNsfw
    setShowNsfw(next)
    localStorage.setItem('SHOW_NSFW', String(next))
  }

  // Background Showcase toggle — on by default (key absent = on)
  const [bgShowcase, setBgShowcase] = useState(() => {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(StorageKey.BG_SHOWCASE)
    return stored === null || stored === 'true'
  })

  const toggleBgShowcase = () => {
    const next = !bgShowcase
    setBgShowcase(next)
    localStorage.setItem(StorageKey.BG_SHOWCASE, String(next))
  }

  // Skip Splash Screen toggle — off by default (splash plays)
  const [skipSplash, setSkipSplash] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(StorageKey.SKIP_SPLASH) === 'true'
  })

  const toggleSkipSplash = () => {
    const next = !skipSplash
    setSkipSplash(next)
    localStorage.setItem(StorageKey.SKIP_SPLASH, String(next))
  }

  const themeOptions: { value: 'dark' | 'light' | 'system'; label: string; icon: React.ReactNode }[] = [
    { value: 'dark', label: 'Dark', icon: <Moon size={16} /> },
    { value: 'light', label: 'Light', icon: <Sun size={16} /> },
    { value: 'system', label: 'System', icon: <Monitor size={16} /> },
  ]

  // Language
  const language = usePreferencesStore((s) => s.language)
  const setLanguage = usePreferencesStore((s) => s.setLanguage)
  const [showLangModal, setShowLangModal] = useState(false)
  const currentLang = LANGUAGES.find(l => l.code === language) || LANGUAGES[0]

  // Time format
  const timeFormat = usePreferencesStore((s) => s.timeFormat)
  const setTimeFormat = usePreferencesStore((s) => s.setTimeFormat)

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Preferences</h3>

      <div className="space-y-6">
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Theme</label>
          <div className="flex gap-2">
            {themeOptions.map((o) => (
              <button
                key={o.value}
                onClick={() => setThemeSetting(o.value)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-all cursor-pointer
                  ${themeSetting === o.value
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border bg-secondary/30 text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                  }`}
              >
                {o.icon}
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Language selector */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Language</label>
          <p className="text-xs text-muted-foreground">Select your preferred display language</p>
          <button
            onClick={() => setShowLangModal(true)}
            className="flex items-center justify-between w-full max-w-xs px-3 py-2 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/60 transition-colors cursor-pointer text-sm"
          >
            <span className="flex items-center gap-2">
              <span className="text-base">{currentLang.flag}</span>
              <span className="text-foreground">{currentLang.nativeName}</span>
            </span>
            <ChevronDown size={14} className="text-muted-foreground" />
          </button>
        </div>

        {/* Time format */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Time Format</label>
          <p className="text-xs text-muted-foreground">How timestamps are displayed throughout the app</p>
          <div className="flex gap-2">
            {([
              { value: 'auto' as const, label: 'Auto' },
              { value: '24h' as const, label: '24-hour' },
              { value: '12h' as const, label: '12-hour (AM/PM)' },
            ]).map((o) => (
              <button
                key={o.value}
                onClick={() => setTimeFormat(o.value)}
                className={`px-4 py-2 rounded-lg border text-sm transition-all cursor-pointer
                  ${timeFormat === o.value
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border bg-secondary/30 text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                  }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {timeFormat === 'auto' ? 'Using your browser\'s locale setting' : timeFormat === '24h' ? 'Example: 14:30' : 'Example: 2:30 PM'}
          </p>
        </div>

        {/* Show NSFW content */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Show NSFW Content</label>
            <p className="text-xs text-muted-foreground">Display all NSFW/sensitive content without blur overlays</p>
          </div>
          <ToggleSwitch checked={showNsfw} onChange={toggleShowNsfw} />
        </div>

        {/* Background Showcase */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Background Showcase</label>
            <p className="text-xs text-muted-foreground">Show featured artwork backgrounds on the login screen</p>
          </div>
          <ToggleSwitch checked={bgShowcase} onChange={toggleBgShowcase} />
        </div>

        {/* Skip Splash Screen */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Skip Splash Screen</label>
            <p className="text-xs text-muted-foreground">Skip the logo animation and go straight to the login screen</p>
          </div>
          <ToggleSwitch checked={skipSplash} onChange={toggleSkipSplash} />
        </div>

        {/* Show Link Previews */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Show Link Previews</label>
            <p className="text-xs text-muted-foreground">Display OpenGraph preview cards for URLs. Only works on the desktop app.</p>
          </div>
          <LinkPreviewToggleInline />
        </div>

        {/* Show Embeds */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Show Embeds</label>
            <p className="text-xs text-muted-foreground">Render rich embeds for supported services like YouTube, Twitch, Twitter, Spotify, and Steam.</p>
          </div>
          <EmbedsToggleInline />
        </div>

        {/* Typing Indicators */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Typing Indicators</label>
            <p className="text-xs text-muted-foreground">Show when others are typing in hub channels and DMs — and let them see when you are. Turning this off stops both.</p>
          </div>
          <TypingIndicatorToggleInline />
        </div>

        {/* Divider */}
        <div className="h-px bg-border" />

        {/* Sound Effects */}
        <SoundEffectsSection />

        {/* Divider */}
        <div className="h-px bg-border" />

        {/* Media Cache */}
        <MediaCacheSection />

      </div>

      {/* Language selector modal */}
      <LanguageModal
        open={showLangModal}
        onClose={() => setShowLangModal(false)}
        currentLanguage={language}
        onSelect={(code) => { setLanguage(code); setShowLangModal(false) }}
      />
    </div>
  )
}

/** Media cache budget slider + clear button (Preferences tab). */
function MediaCacheSection() {
  const [budgetMB, setBudgetMB] = useState(() => getCacheBudgetMB())
  const [usageMB, setUsageMB] = useState<number | null>(null)
  const [clearing, setClearing] = useState(false)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshUsage = useCallback(() => {
    getCacheStats().then((s) => setUsageMB(s.totalSizeMB)).catch(() => {})
  }, [])
  useEffect(() => { refreshUsage() }, [refreshUsage])

  const onSlide = (mb: number) => {
    setBudgetMB(mb)
    // Debounce the actual apply (persists + evicts excess) until the user settles
    if (commitTimer.current) clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => {
      setCacheBudgetMB(mb).then(refreshUsage).catch(() => {})
    }, 400)
  }

  const handleClear = async () => {
    setClearing(true)
    try { await clearPersistentCache() } finally { setClearing(false); refreshUsage() }
  }

  const pct = Math.min((budgetMB / 1024) * 100, 100)
  const valueLabel = budgetMB === 0 ? 'Off' : budgetMB >= 1024 ? '1 GB' : `${budgetMB} MB`

  return (
    <div className="space-y-3">
      <div>
        <label className="text-sm font-medium text-foreground">Media Storage</label>
        <p className="text-xs text-muted-foreground">
          Images and GIFs you've seen in chats, DMs, and posts are saved on this device so they load instantly next time (and after restarting) instead of downloading again. Bigger limit = more saved.
        </p>
      </div>

      {/* Budget slider — 0 (off) … 1 GB, 5 MB steps */}
      <div className="flex items-center gap-4 px-2 py-1 rounded-sm bg-secondary">
        <div className="flex-1 relative h-6 flex items-center">
          <div className="absolute left-0 right-0 h-2 rounded-full overflow-hidden">
            <div className="absolute inset-0 bg-muted-foreground/20" />
            <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <div
            className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
            style={{ left: `calc(${pct}% - 10px)` }}
          />
          <input
            type="range"
            min={0}
            max={1024}
            step={5}
            value={budgetMB}
            onChange={(e) => onSlide(Number(e.target.value))}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>
        <span className="text-sm font-medium tabular-nums min-w-[60px] text-right text-foreground">
          {valueLabel}
        </span>
      </div>

      {/* Plain-language warning */}
      <p className="text-[11px] text-amber-500/90">
        {budgetMB === 0
          ? 'Saving is off — nothing is kept on this device, so images download again every time you open a chat or post.'
          : 'Choosing a smaller size (or Off) immediately deletes saved images to fit the new limit.'}
      </p>

      {/* Clear button + current usage */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleClear}
          disabled={clearing}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-secondary/50 text-xs hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50"
        >
          <Trash2 size={14} />
          {clearing ? 'Clearing…' : 'Clear Media Storage'}
        </button>
        {usageMB !== null && (
          <span className="text-xs text-muted-foreground">Using {usageMB} MB</span>
        )}
      </div>
    </div>
  )
}

function LanguageModal({ open, onClose, currentLanguage, onSelect }: {
  open: boolean
  onClose: () => void
  currentLanguage: LanguageCode
  onSelect: (code: LanguageCode) => void
}) {
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (open) setSearch('')
  }, [open])

  if (!open) return null

  const filtered = LANGUAGES.filter(lang => {
    const q = search.toLowerCase()
    return lang.nativeName.toLowerCase().includes(q)
      || lang.englishName.toLowerCase().includes(q)
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Select Language</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 pt-4 pb-2">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search languages..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none p-1 rounded-sm"
              autoFocus
            />
          </div>
        </div>

        {/* Language list */}
        <div className="px-2 py-2 max-h-[360px] overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground text-center">No languages found</p>
          ) : (
            filtered.map((lang) => (
              <button
                key={lang.code}
                onClick={() => lang.available ? onSelect(lang.code) : undefined}
                className={`flex items-center w-full px-3 py-2.5 rounded-lg text-sm transition-colors
                  ${currentLanguage === lang.code
                    ? 'bg-primary/10 text-primary'
                    : lang.available
                      ? 'text-foreground hover:bg-secondary/60 cursor-pointer'
                      : 'text-muted-foreground/60 cursor-not-allowed'
                  }`}
              >
                <span className="text-lg mr-3 w-6 text-center">{lang.flag}</span>
                <span className={`flex-1 text-left ${currentLanguage === lang.code ? 'font-medium' : ''}`}>
                  {lang.nativeName}
                </span>
                {!lang.available && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted-foreground/15 text-muted-foreground mr-2">
                    Coming soon
                  </span>
                )}
                <span className="text-xs text-muted-foreground">{lang.englishName}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/* ─────────── Muted Words (Preferences) ─────────── */

function MutedWordsPreference() {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const storeMutedWords = useBlockStore((s) => s.mutedWords)
  const setMutedWords = useBlockStore((s) => s.setMutedWords)

  const [localWords, setLocalWords] = useState<string[]>(() => Array.from(storeMutedWords))
  const [inputValue, setInputValue] = useState('')
  const [saving, setSaving] = useState(false)

  // Sync when store changes externally
  useEffect(() => {
    const storeArr = Array.from(storeMutedWords).sort()
    const localArr = [...localWords].sort()
    if (storeArr.length !== localArr.length || storeArr.some((w, i) => w !== localArr[i])) {
      setLocalWords(Array.from(storeMutedWords))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeMutedWords])

  const isDirty = useMemo(() => {
    const storeArr = Array.from(storeMutedWords).sort()
    const localArr = [...localWords].sort()
    if (storeArr.length !== localArr.length) return true
    return storeArr.some((w, i) => w !== localArr[i])
  }, [storeMutedWords, localWords])

  const handleAdd = () => {
    const w = inputValue.trim().toLowerCase()
    if (!w || localWords.includes(w)) return
    setLocalWords((prev) => [...prev, w])
    setInputValue('')
  }

  const handleRemove = (word: string) => {
    setLocalWords((prev) => prev.filter((w) => w !== word))
  }

  const handleSave = async () => {
    if (!myPubkey || !isDirty) return
    setSaving(true)
    try {
      await setMutedWords(localWords, myPubkey, signer, privateKey)
    } catch (err) {
      console.error('[MutedWords] Failed to save:', err)
    }
    setSaving(false)
  }

  return (
    <div>
      <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5">
        <MessageCircleOff size={14} className="text-red-400" />
        Muted Words
      </label>
      <p className="text-xs text-muted-foreground mb-3">
        These words will be redacted across all messages — hub chats, DMs, social posts, and public chat.
      </p>

      {/* Input + Add */}
      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="Type a word to mute..."
          className="flex-1 px-3 py-1.5 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-primary/50"
        />
        <button
          onClick={handleAdd}
          disabled={!inputValue.trim()}
          className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          Add
        </button>
      </div>

      {/* Word pills */}
      {localWords.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {localWords.map((word) => (
            <span
              key={word}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-secondary border border-border text-xs text-foreground"
            >
              {word}
              <button
                onClick={() => handleRemove(word)}
                className="text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {localWords.length === 0 && (
        <p className="text-xs text-muted-foreground/60 mb-3 italic">No muted words yet.</p>
      )}

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={!isDirty || saving}
        className={`w-full py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:cursor-not-allowed ${isDirty
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'bg-secondary text-muted-foreground'
          }`}
      >
        {saving ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            Saving...
          </span>
        ) : isDirty ? (
          'Save Changes'
        ) : (
          'Saved'
        )}
      </button>
    </div>
  )
}

/* ─────────── Voice & Video ─────────── */

const VOICE_SETTINGS_KEY = 'den-chat-voice-settings'

interface VoiceSettings {
  inputDeviceId: string
  outputDeviceId: string
  cameraDeviceId: string
  voiceMode: 'activity' | 'alwaysOn' | 'pushToTalk'
  inputSensitivity: number   // 0-20 threshold (internally * 0.5 = 0-10 RMS)
  releaseDelay: number       // 0.1-2.0 seconds
  pushToTalkKey: string      // key code for PTT e.g. 'KeyV'
  noiseSuppression: 'off' | 'basic' | 'rnnoise'
  micGain: number            // 0.5-3.0 gain multiplier
  screenShareResolution: '360p' | '480p' | '720p' | '1080p'
  screenShareFps: 15 | 30 | 60
}

const VOICE_DEFAULTS: VoiceSettings = {
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  voiceMode: 'activity',
  inputSensitivity: 1.5,
  releaseDelay: 0.3,
  pushToTalkKey: 'KeyV',
  noiseSuppression: 'rnnoise',
  micGain: 1.0,
  screenShareResolution: '720p',
  screenShareFps: 30,
}

/**
 * Whether this webview can route audio output to a non-default device
 * (HTMLMediaElement.setSinkId). Present in Chromium (Windows WebView2), but absent
 * in WebKit-based webviews (macOS WKWebView, Linux WebKitGTK) — there the system
 * default output is always used regardless of the in-app selection.
 */
const OUTPUT_DEVICE_SELECTION_SUPPORTED =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(VOICE_SETTINGS_KEY)
    if (raw) {
      const parsed = { ...VOICE_DEFAULTS, ...JSON.parse(raw) }
      // Migrate old boolean noiseCancellation → noiseSuppression enum
      if ('noiseCancellation' in parsed && typeof parsed.noiseCancellation === 'boolean') {
        parsed.noiseSuppression = parsed.noiseCancellation ? 'basic' : 'off'
        delete parsed.noiseCancellation
      }
      return parsed
    }
  } catch { }
  return { ...VOICE_DEFAULTS }
}

function saveVoiceSettings(s: VoiceSettings) {
  localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(s))
}

/** Exported so the speaking detection hook can read it */
export function getVoiceSensitivity(): number {
  try {
    const raw = localStorage.getItem(VOICE_SETTINGS_KEY)
    if (raw) return (JSON.parse(raw).inputSensitivity ?? 1.5) * 0.5 // slider 0-20 → RMS 0-10
  } catch { }
  return 1.5 * 0.5 // default 1.5 → RMS 0.75
}

/** Exported so voiceStore can read the selected camera device */
export function getCameraDeviceId(): string {
  try {
    const raw = localStorage.getItem(VOICE_SETTINGS_KEY)
    if (raw) return JSON.parse(raw).cameraDeviceId ?? ''
  } catch { }
  return ''
}

const RESOLUTION_MAP: Record<string, { width: number; height: number }> = {
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
}

/** Exported so voiceStore can read screenshare quality settings */
export function getScreenShareQuality(): { width: number; height: number; fps: number } {
  try {
    const raw = localStorage.getItem(VOICE_SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      const res = RESOLUTION_MAP[parsed.screenShareResolution] || RESOLUTION_MAP['720p']
      return { ...res, fps: parsed.screenShareFps || 30 }
    }
  } catch { }
  return { width: 1280, height: 720, fps: 30 }
}

/** Exported so voiceStore can read noise suppression mode */
export function getNoiseSuppression(): 'off' | 'basic' | 'rnnoise' {
  try {
    const raw = localStorage.getItem(VOICE_SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      // Handle old boolean format
      if ('noiseCancellation' in parsed && typeof parsed.noiseCancellation === 'boolean') {
        return parsed.noiseCancellation ? 'basic' : 'off'
      }
      return parsed.noiseSuppression ?? 'rnnoise'
    }
  } catch { }
  return 'rnnoise'
}

/** Custom-styled device select dropdown — matches DatePicker design pattern */
function DeviceSelect({
  value,
  onChange,
  options,
  placeholder = 'Default',
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, openUp: false })

  // Calculate position when opening
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < 260 && rect.top > 260
    setPos({
      top: openUp ? rect.top : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      openUp,
    })
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return
      if (dropdownRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on scroll of any ancestor (but not the dropdown itself)
  useEffect(() => {
    if (!open) return
    const handler = (e: Event) => {
      // Don't close when scrolling inside the dropdown
      if (dropdownRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('scroll', handler, true)
    return () => window.removeEventListener('scroll', handler, true)
  }, [open])

  const selected = options.find((o) => o.value === value)
  const displayText = selected?.label || placeholder

  return (
    <div className="relative">
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center justify-between gap-2 h-9 px-3 bg-secondary/50 border border-border rounded-lg text-sm outline-none transition-colors cursor-pointer hover:border-primary/30 ${value ? 'text-foreground' : 'text-muted-foreground'
          }`}
      >
        <span className="truncate">{displayText}</span>
        <ChevronDown
          size={14}
          className={`text-muted-foreground/50 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown — rendered via portal to avoid overflow clipping */}
      {open && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            left: pos.left,
            width: pos.width,
            ...(pos.openUp
              ? { bottom: window.innerHeight - pos.top + 4 }
              : { top: pos.top }),
          }}
          className="z-[200] bg-card border border-border rounded-xl shadow-2xl p-1 flex flex-col gap-1 max-h-[240px] overflow-y-auto"
        >
          {/* Default option */}
          <button
            type="button"
            onClick={() => { onChange(''); setOpen(false) }}
            className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-colors cursor-pointer ${!value
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-foreground hover:bg-accent/40'
              }`}
          >
            {placeholder}
          </button>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-colors cursor-pointer ${value === opt.value
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-foreground hover:bg-accent/40'
                }`}
            >
              {opt.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

function VoiceVideoTab() {
  const [settings, setSettings] = useState(loadVoiceSettings)
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([])
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([])

  // Mic test state
  const [isTesting, setIsTesting] = useState(false)
  const testStreamRef = useRef<MediaStream | null>(null)
  const testCtxRef = useRef<AudioContext | null>(null)
  // Loopback playback element — routes the test audio to the selected output via setSinkId
  const testAudioRef = useRef<HTMLAudioElement | null>(null)
  // Level meter bar, driven imperatively to avoid a React re-render every animation frame
  const levelBarRef = useRef<HTMLDivElement | null>(null)
  // Ref to always have current sensitivity in the mic test RAF loop
  const sensitivityRef = useRef(settings.inputSensitivity)
  const releaseDelayRef = useRef(settings.releaseDelay)
  const testRafRef = useRef<number>(0)
  // Save pre-test mute/deafen state so we can restore it after
  const preTestVoiceStateRef = useRef<{ isMuted: boolean; isDeafened: boolean } | null>(null)

  // PTT keybind capture
  const [capturingPTT, setCapturingPTT] = useState(false)

  // Enumerate devices
  useEffect(() => {
    async function enumerate() {
      try {
        // Need a temp stream to get labels on some browsers
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        tempStream.getTracks().forEach((t) => t.stop())
      } catch { }

      const devices = await navigator.mediaDevices.enumerateDevices()
      setInputDevices(devices.filter((d) => d.kind === 'audioinput'))
      setOutputDevices(devices.filter((d) => d.kind === 'audiooutput'))
      setVideoDevices(devices.filter((d) => d.kind === 'videoinput'))
    }
    enumerate()

    navigator.mediaDevices.addEventListener('devicechange', enumerate)
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate)
  }, [])

  const update = (partial: Partial<VoiceSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial }
      saveVoiceSettings(next)
      if (next.inputSensitivity !== undefined) sensitivityRef.current = next.inputSensitivity
      if (next.releaseDelay !== undefined) releaseDelayRef.current = next.releaseDelay
      return next
    })
  }

  // Clear test on unmount
  useEffect(() => {
    return () => stopMicTest()
  }, [])

  // PTT keybind capture listener
  useEffect(() => {
    if (!capturingPTT) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      update({ pushToTalkKey: e.code })
      // Sync to keybinds store so the Keybinds tab stays in sync
      try {
        const kb = JSON.parse(localStorage.getItem('den-chat-keybinds') || '{}')
        kb.pushToTalk = e.code
        localStorage.setItem('den-chat-keybinds', JSON.stringify(kb))
      } catch { /* ignore */ }
      setCapturingPTT(false)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [capturingPTT])

  function startMicTest() {
    if (isTesting) { stopMicTest(); return }

    setIsTesting(true)

    // If in a voice call, save current mute/deafen state and force mute+deafen
    // so others don't hear the test audio and we don't hear them during the test
    const voiceState = useVoiceStore.getState()
    if (voiceState.connectionState === 'connected' && voiceState.provider) {
      preTestVoiceStateRef.current = {
        isMuted: voiceState.isMuted,
        isDeafened: voiceState.isDeafened,
      }
      if (!voiceState.isMuted) {
        voiceState.provider.setMuted('audio', true)
      }
      if (!voiceState.isDeafened) {
        voiceState.provider.setDeafened(true)
      }
      useVoiceStore.setState({ isMuted: true, isDeafened: true })
      voiceState._broadcastStateNow()
    }

    // Read fresh from localStorage to avoid stale closure after auto-restart
    const freshSettings = loadVoiceSettings()
    const noiseMode = freshSettings.noiseSuppression ?? 'rnnoise'
    const useBrowserNC = noiseMode === 'basic'
    const audioConstraints: MediaTrackConstraints = {
      ...(freshSettings.inputDeviceId ? { deviceId: { exact: freshSettings.inputDeviceId } } : {}),
      noiseSuppression: useBrowserNC,
      echoCancellation: true,
      autoGainControl: useBrowserNC,
    }
    const constraints: MediaStreamConstraints = { audio: audioConstraints }

    // Try the configured mic; if it's unavailable (unplugged/removed) the { exact }
    // constraint throws, so fall back to the system default so the test still runs —
    // mirrors the voice-join behaviour.
    const acquireTestStream = async (): Promise<MediaStream> => {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints)
      } catch (err) {
        if (freshSettings.inputDeviceId) {
          console.warn('[MicTest] Configured mic unavailable, falling back to default:', err)
          return await navigator.mediaDevices.getUserMedia({
            audio: { noiseSuppression: useBrowserNC, echoCancellation: true, autoGainControl: useBrowserNC },
          })
        }
        throw err
      }
    }

    acquireTestStream().then(async (stream) => {
      testStreamRef.current = stream
      // RNNoise requires 48kHz
      const ctx = new AudioContext(noiseMode === 'rnnoise' ? { sampleRate: 48000 } : undefined)

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.85
      const source = ctx.createMediaStreamSource(stream)
      source.connect(analyser)

      // Determine what feeds the loopback: source or RNNoise output
      let audioSource: AudioNode = source

      // Insert RNNoise node if selected
      if (noiseMode === 'rnnoise') {
        try {
          const { createRnnoiseNode } = await import('@/lib/voice/rnnoise')
          const rnnoiseNode = await createRnnoiseNode(ctx)
          source.connect(rnnoiseNode)
          // RNNoise outputs mono — merge to both L+R channels
          const merger = ctx.createChannelMerger(2)
          rnnoiseNode.connect(merger, 0, 0) // mono → left
          rnnoiseNode.connect(merger, 0, 1) // mono → right
          audioSource = merger
        } catch (err) {
          console.warn('[MicTest] Failed to initialize RNNoise:', err)
        }
      }

      // Apply user mic gain (applies to all noise suppression modes)
      const micGainNode = ctx.createGain()
      micGainNode.gain.value = freshSettings.micGain ?? 1.0
      audioSource.connect(micGainNode)

      // Audio loopback — gated by sensitivity so you hear what others would hear
      const delayNode = ctx.createDelay(0.2)
      delayNode.delayTime.value = 0.1
      const gainNode = ctx.createGain()
      gainNode.gain.value = 0
      micGainNode.connect(delayNode)
      delayNode.connect(gainNode)

      // Play the gated loopback through an <audio> element so it can be routed to
      // the selected output device via setSinkId (AudioContext.setSinkId is
      // unreliable; HTMLMediaElement.setSinkId is what the voice providers use).
      const loopbackDest = ctx.createMediaStreamDestination()
      gainNode.connect(loopbackDest)
      const audioEl = new Audio()
      audioEl.srcObject = loopbackDest.stream
      audioEl.autoplay = true
      testAudioRef.current = audioEl
      if (freshSettings.outputDeviceId && 'setSinkId' in audioEl) {
        try {
          await (audioEl as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(freshSettings.outputDeviceId)
        } catch (err) {
          console.warn('[MicTest] Failed to set output device:', err)
        }
      }
      audioEl.play().catch(() => {})

      testCtxRef.current = ctx

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      let lastAbove = 0       // start closed
      const holdMs = Math.round(releaseDelayRef.current * 1000)
      let consecutiveAbove = 0
      const ATTACK_FRAMES = 2
      let consecutiveBelow = 0
      const RELEASE_FRAMES = 4
      const rmsHistory: number[] = [0, 0, 0, 0]
      let rmsIdx = 0
      let gateOpen = false

      const tick = () => {
        analyser.getByteTimeDomainData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          const val = (dataArray[i] - 128) / 128
          sum += val * val
        }
        const rawRms = Math.sqrt(sum / dataArray.length) * 100

        // Rolling average of last 4 frames for smoother readings
        rmsHistory[rmsIdx % 4] = rawRms
        rmsIdx++
        const rms = rmsHistory.reduce((a, b) => a + b, 0) / rmsHistory.length

        // Drive the level meter imperatively (no React state) so the test doesn't
        // re-render the settings page every frame — that was the source of the lag.
        const bar = levelBarRef.current
        if (bar) {
          bar.style.width = `${Math.min(rms * 10, 100)}%`
          bar.style.background = rms > sensitivityRef.current * 0.5
            ? 'linear-gradient(90deg, #22c55e 0%, #4ade80 50%, #86efac 100%)'
            : 'linear-gradient(90deg, #6b7280 0%, #9ca3af 100%)'
        }

        const now = Date.now()
        const threshold = sensitivityRef.current * 0.5 // slider 0-20 → RMS 0-10
        const currentHoldMs = Math.round(releaseDelayRef.current * 1000)

        if (rms > threshold) {
          consecutiveAbove++
          consecutiveBelow = 0
          if (consecutiveAbove >= ATTACK_FRAMES) { gateOpen = true; lastAbove = now }
        } else {
          consecutiveBelow++
          consecutiveAbove = 0
          if (consecutiveBelow >= RELEASE_FRAMES && (now - lastAbove) >= currentHoldMs) { gateOpen = false }
        }

        gainNode.gain.cancelScheduledValues(ctx.currentTime)
        gainNode.gain.setValueAtTime(gateOpen ? 0.8 : 0, ctx.currentTime)

        testRafRef.current = requestAnimationFrame(tick)
      }
      testRafRef.current = requestAnimationFrame(tick)
    }).catch(() => {
      setIsTesting(false)
    })
  }

  function stopMicTest() {
    cancelAnimationFrame(testRafRef.current)
    testStreamRef.current?.getTracks().forEach((t) => t.stop())
    if (testAudioRef.current) {
      testAudioRef.current.pause()
      testAudioRef.current.srcObject = null
      testAudioRef.current = null
    }
    testCtxRef.current?.close()
    testStreamRef.current = null
    testCtxRef.current = null
    if (levelBarRef.current) levelBarRef.current.style.width = '0%'
    setIsTesting(false)

    // Restore pre-test mute/deafen state if we were in a voice call
    const saved = preTestVoiceStateRef.current
    if (saved) {
      const voiceState = useVoiceStore.getState()
      if (voiceState.connectionState === 'connected' && voiceState.provider) {
        voiceState.provider.setMuted('audio', saved.isMuted)
        voiceState.provider.setDeafened(saved.isDeafened)
        useVoiceStore.setState({ isMuted: saved.isMuted, isDeafened: saved.isDeafened })
        voiceState._broadcastStateNow()
      }
      preTestVoiceStateRef.current = null
    }
  }

  // Sensitivity slider visual — map [0, 20] → [0%, 100%]
  const sensitivityPercent = (settings.inputSensitivity / 20) * 100
  // Release delay slider visual — map [0.1, 2.0] → [0%, 100%]
  const releasePercent = ((settings.releaseDelay - 0.1) / 1.9) * 100
  // Mic gain slider visual — map [0.5, 3.0] → [0%, 100%]
  const micGainPercent = ((settings.micGain - 0.5) / 2.5) * 100

  return (
    <div className="space-y-8">
      <h3 className="text-lg font-semibold">Voice & Video</h3>

      {/* ── Voice Section ── */}
      <section className="space-y-5">
        <h4 className="text-sm font-semibold text-foreground uppercase tracking-wider text-muted-foreground">Voice</h4>

        {/* Input / Output device selectors */}
        <div className="grid grid-cols-2 max-[1080px]:grid-cols-1 gap-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Input Device</label>
            <DeviceSelect
              value={settings.inputDeviceId}
              onChange={(val) => {
                update({ inputDeviceId: val })
                // Apply immediately to an active voice call (mirrors output device)
                useVoiceStore.getState().setInputDevice(val)
                // Restart a running mic test so it switches to the new mic
                if (isTesting) { stopMicTest(); setTimeout(() => startMicTest(), 100) }
              }}
              placeholder="Default"
              options={inputDevices.map((d) => ({
                value: d.deviceId,
                label: d.label || `Microphone ${d.deviceId.slice(0, 8)}...`,
              }))}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Output Device</label>
            <DeviceSelect
              value={settings.outputDeviceId}
              onChange={(val) => {
                update({ outputDeviceId: val })
                // Apply immediately to active voice call
                useVoiceStore.getState().setOutputDevice(val)
                // Route a running mic test's loopback to the new output device too
                const tAudio = testAudioRef.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null
                if (isTesting && tAudio?.setSinkId) {
                  tAudio.setSinkId(val).catch((err) => console.warn('[MicTest] Failed to set output device:', err))
                }
              }}
              placeholder="Default"
              options={outputDevices.map((d) => ({
                value: d.deviceId,
                label: d.label || `Speaker ${d.deviceId.slice(0, 8)}...`,
              }))}
            />
            {!OUTPUT_DEVICE_SELECTION_SUPPORTED && (
              <p className="flex items-start gap-1.5 text-[11px] text-amber-500/90">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                <span>This app build can&apos;t switch the output device — your system&apos;s default output is always used. Change it in your OS sound settings.</span>
              </p>
            )}
          </div>
        </div>

        {/* Mic Test */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Mic Test</label>
          <div className="flex items-center gap-3 max-[1080px]:flex-col max-[1080px]:items-stretch">
            <button
              onClick={startMicTest}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer flex items-center gap-2 ${isTesting
                ? 'bg-red-500 hover:bg-red-600 text-white'
                : 'bg-primary hover:bg-primary/90 text-primary-foreground'
                }`}
            >
              <Mic size={14} />
              {isTesting ? 'Stop Test' : 'Mic Test'}
            </button>

            {/* Level meter */}
            <div className="flex-1 max-[1080px]:flex-none w-full h-6 rounded-md bg-secondary/50 border border-border overflow-hidden relative">
              {/* Audio level bar — width/background driven imperatively in the RAF loop */}
              <div
                ref={levelBarRef}
                className="absolute inset-y-0 left-0 rounded-md transition-[width] duration-[50ms] ease-out"
                style={{
                  width: '0%',
                  background: 'linear-gradient(90deg, #6b7280 0%, #9ca3af 100%)',
                }}
              />

              {/* Threshold marker — slider value 0-100 maps directly to 0-100% position */}
              <div
                className="absolute inset-y-0 w-0.5 bg-amber-400 z-10"
                style={{ left: `${Math.min(settings.inputSensitivity / 20 * 100, 100)}%` }}
              />

              {/* Segment lines for visual flair */}
              <div className="absolute inset-0 flex">
                {Array.from({ length: 40 }).map((_, i) => (
                  <div key={i} className="flex-1 border-r border-background/30" />
                ))}
              </div>

              {!isTesting && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[10px] text-muted-foreground/70">Click "Mic Test" to check your microphone</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="h-px bg-border" />

        {/* Voice Mode Selector */}
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium text-foreground">Input Mode</label>
            <p className="text-xs text-muted-foreground">
              Choose how your microphone is activated during voice calls.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {([
              { value: 'activity' as const, label: 'Voice Activity', desc: 'Threshold-based' },
              { value: 'alwaysOn' as const, label: 'Always On', desc: 'Always transmitting' },
              { value: 'pushToTalk' as const, label: 'Push to Talk', desc: 'Hold key to speak' },
            ]).map((opt) => (
              <button
                key={opt.value}
                onClick={() => update({ voiceMode: opt.value })}
                className={`flex flex-col items-start px-4 py-2.5 rounded-lg border text-sm transition-all cursor-pointer min-w-[120px]
                  ${settings.voiceMode === opt.value
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border bg-secondary/30 text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                  }`}
              >
                <span>{opt.label}</span>
                <span className="text-[10px] opacity-60 font-normal">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Voice Activity settings — only shown when mode is 'activity' */}
        {settings.voiceMode === 'activity' && (
          <>
            {/* Input Sensitivity */}
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-foreground">Input Sensitivity</label>
                <p className="text-xs text-muted-foreground">
                  Adjust the minimum audio level required to activate the speaking indicator. Lower values are more sensitive.
                </p>
              </div>

              <div className="flex items-center gap-4 px-2 py-1 rounded-sm bg-secondary">
                <div className="flex-1 relative h-6 flex items-center">
                  <div className="absolute left-0 right-0 h-2 rounded-full overflow-hidden">
                    <div className="absolute inset-0 bg-muted-foreground/20" />
                    <div
                      className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-amber-400"
                      style={{ width: `${sensitivityPercent}%` }}
                    />
                  </div>

                  <div
                    className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
                    style={{ left: `calc(${sensitivityPercent}% - 10px)` }}
                  />

                  <input
                    type="range"
                    min={0}
                    max={20}
                    step={0.1}
                    value={settings.inputSensitivity}
                    onChange={(e) => update({ inputSensitivity: Number(e.target.value) })}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                </div>

                <span className="text-sm font-medium tabular-nums min-w-[36px] text-right text-foreground">
                  {settings.inputSensitivity % 1 === 0 ? settings.inputSensitivity : settings.inputSensitivity.toFixed(1)}
                </span>

                {settings.inputSensitivity !== 1.5 && (
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => update({ inputSensitivity: 1.5 })}
                          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        >
                          <RotateCcw size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">Reset to default (1.5)</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>

              <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
                <span>More sensitive</span>
                <span>Less sensitive</span>
              </div>
            </div>

            {/* Release Delay */}
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-foreground">Release Delay</label>
                <p className="text-xs text-muted-foreground">
                  How long audio continues transmitting after your voice drops below the sensitivity threshold.
                </p>
              </div>

              <div className="flex items-center gap-4 px-2 py-1 rounded-sm bg-secondary">
                <div className="flex-1 relative h-6 flex items-center">
                  <div className="absolute left-0 right-0 h-2 rounded-full overflow-hidden">
                    <div className="absolute inset-0 bg-muted-foreground/20" />
                    <div
                      className="absolute inset-y-0 left-0 bg-gradient-to-r from-sky-500 to-violet-400"
                      style={{ width: `${releasePercent}%` }}
                    />
                  </div>

                  <div
                    className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
                    style={{ left: `calc(${releasePercent}% - 10px)` }}
                  />

                  <input
                    type="range"
                    min={0.1}
                    max={2.0}
                    step={0.1}
                    value={settings.releaseDelay}
                    onChange={(e) => update({ releaseDelay: Number(e.target.value) })}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                </div>

                <span className="text-sm font-medium tabular-nums min-w-[42px] text-right text-foreground">
                  {settings.releaseDelay.toFixed(1)}s
                </span>

                {settings.releaseDelay !== 0.3 && (
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => update({ releaseDelay: 0.3 })}
                          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        >
                          <RotateCcw size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">Reset to default (0.3s)</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>

              <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
                <span>Shorter</span>
                <span>Longer</span>
              </div>
            </div>
          </>
        )}

        {/* Always On note */}
        {settings.voiceMode === 'alwaysOn' && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <p className="text-xs text-amber-400">
              Your microphone will always be transmitting while in a voice channel. Use the mute button to temporarily silence yourself.
            </p>
          </div>
        )}

        {/* Push to Talk keybind */}
        {settings.voiceMode === 'pushToTalk' && (
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-foreground">Keybind</label>
              <p className="text-xs text-muted-foreground">
                Press and hold this key to transmit. On the desktop app, this works system-wide even when another window is focused.
              </p>
            </div>
            <button
              onClick={() => setCapturingPTT(true)}
              className={`px-4 py-2.5 rounded-lg border text-sm transition-all cursor-pointer min-w-[140px] text-left
                ${capturingPTT
                  ? 'border-primary bg-primary/10 text-primary animate-pulse font-medium'
                  : 'border-border bg-secondary/30 text-foreground hover:bg-secondary/60'
                }`}
            >
              {capturingPTT
                ? 'Press any key...'
                : formatKeyCode(settings.pushToTalkKey || 'KeyV') || 'V'
              }
            </button>
          </div>
        )}

        <div className="h-px bg-border" />

        {/* Noise Suppression */}
        <div className="space-y-2">
          <div>
            <label className="text-sm font-medium text-foreground">Noise Suppression</label>
            <p className="text-xs text-muted-foreground">
              Reduce background noise from your microphone. RNNoise uses AI-based processing for superior quality.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {([
              { value: 'off' as const, label: 'Off', desc: 'No processing' },
              { value: 'basic' as const, label: 'Basic', desc: 'Browser built-in' },
              { value: 'rnnoise' as const, label: 'RNNoise', desc: 'AI-powered' },
            ]).map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  update({ noiseSuppression: opt.value })
                  if (isTesting) {
                    stopMicTest()
                    setTimeout(() => startMicTest(), 100)
                  }
                }}
                className={`flex flex-col items-start px-4 py-2.5 rounded-lg border text-sm transition-all cursor-pointer min-w-[100px]
                  ${settings.noiseSuppression === opt.value
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border bg-secondary/30 text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                  }`}
              >
                <span>{opt.label}</span>
                <span className="text-[10px] opacity-60 font-normal">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="h-px bg-border" />

        {/* Mic Gain / Input Volume */}
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium text-foreground">Mic Gain</label>
            <p className="text-xs text-muted-foreground">
              Boost or reduce your microphone volume. Useful for compensating quiet mics or noise suppression attenuation.
            </p>
          </div>

          <div className="flex items-center gap-4 px-2 py-1 rounded-sm bg-secondary">
            <div className="flex-1 relative h-6 flex items-center">
              <div className="absolute left-0 right-0 h-2 rounded-full overflow-hidden">
                <div className="absolute inset-0 bg-muted-foreground/20" />
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-blue-500 to-cyan-400"
                  style={{ width: `${micGainPercent}%` }}
                />
              </div>

              <div
                className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
                style={{ left: `calc(${micGainPercent}% - 10px)` }}
              />

              <input
                type="range"
                min={0.5}
                max={3.0}
                step={0.1}
                value={settings.micGain}
                onChange={(e) => {
                  const val = Number(e.target.value)
                  update({ micGain: val })
                  // Live-update gain node if in a voice call
                  useVoiceStore.getState().updateMicGain(val)
                  if (isTesting) {
                    stopMicTest()
                    setTimeout(() => startMicTest(), 100)
                  }
                }}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>

            <span className="text-sm font-medium tabular-nums min-w-[42px] text-right text-foreground">
              {Math.round(settings.micGain * 100)}%
            </span>

            {settings.micGain !== 1.0 && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => {
                        update({ micGain: 1.0 })
                        useVoiceStore.getState().updateMicGain(1.0)
                        if (isTesting) {
                          stopMicTest()
                          setTimeout(() => startMicTest(), 100)
                        }
                      }}
                      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      <RotateCcw size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Reset to default (100%)</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
            <span>50%</span>
            <span>300%</span>
          </div>
        </div>
      </section>

      {/* ── Camera Section ── */}
      <section className="space-y-5">
        <h4 className="text-sm font-semibold text-foreground uppercase tracking-wider text-muted-foreground">
          <Camera size={14} className="inline mr-1.5 -mt-0.5" />
          Camera
        </h4>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">Camera Device</label>
          <p className="text-xs text-muted-foreground">Select which camera to use when enabling video in voice channels.</p>
          <div className="max-w-md">
            <DeviceSelect
              value={settings.cameraDeviceId}
              onChange={(val) => update({ cameraDeviceId: val })}
              placeholder="Default"
              options={videoDevices.map((d) => ({
                value: d.deviceId,
                label: d.label || `Camera ${d.deviceId.slice(0, 8)}...`,
              }))}
            />
          </div>
          {videoDevices.length === 0 && (
            <p className="text-xs text-muted-foreground/60 italic">No cameras detected. Grant camera permission to see available devices.</p>
          )}
        </div>
      </section>

      {/* ── Screen Share Section ── */}
      <section className="space-y-5">
        <h4 className="text-sm font-semibold text-foreground uppercase tracking-wider text-muted-foreground">
          <MonitorPlay size={14} className="inline mr-1.5 -mt-0.5" />
          Screen Share
        </h4>

        {/* Resolution */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Resolution</label>
          <p className="text-xs text-muted-foreground">Higher resolutions use more bandwidth. 720p is recommended for most connections.</p>
          <div className="flex gap-2 flex-wrap">
            {(['360p', '480p', '720p', '1080p'] as const).map((res) => (
              <button
                key={res}
                onClick={() => update({ screenShareResolution: res })}
                className={`px-4 py-2 rounded-lg border text-sm transition-all cursor-pointer
                  ${settings.screenShareResolution === res
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border bg-secondary/30 text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                  }`}
              >
                {res}
                <span className="text-[10px] ml-1 opacity-60">
                  {RESOLUTION_MAP[res].width}×{RESOLUTION_MAP[res].height}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Frame Rate */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Frame Rate</label>
          <p className="text-xs text-muted-foreground">Higher frame rates are smoother but use more bandwidth and CPU.</p>
          <div className="flex gap-2">
            {([15, 30, 60] as const).map((fps) => (
              <button
                key={fps}
                onClick={() => update({ screenShareFps: fps })}
                className={`px-4 py-2 rounded-lg border text-sm transition-all cursor-pointer
                  ${settings.screenShareFps === fps
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border bg-secondary/30 text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                  }`}
              >
                {fps} FPS
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

/* ─────────── Network ─────────── */

function NetworkTab() {
  /* ── Client Relays ── */
  const [clientRelays, setClientRelays] = useState<{ url: string; enabled: boolean }[]>([])
  const [newRelay, setNewRelay] = useState('')

  useEffect(() => {
    setClientRelays(getRelayList())
  }, [])

  const saveClientRelays = (list: { url: string; enabled: boolean }[]) => {
    setClientRelays(list)
    setRelays(list)
  }

  const addRelay = () => {
    const trimmed = newRelay.trim()
    if (!trimmed || !trimmed.startsWith('wss://') || clientRelays.some((r) => r.url === trimmed)) return
    saveClientRelays([...clientRelays, { url: trimmed, enabled: true }])
    setNewRelay('')
  }

  /* ── Client Blossom ── */
  const [clientBlossom, setClientBlossom] = useState<{ url: string; enabled: boolean }[]>([])
  const [newBlossom, setNewBlossom] = useState('')

  useEffect(() => {
    setClientBlossom(blossomServers.getList())
  }, [])

  const saveClientBlossom = (list: { url: string; enabled: boolean }[]) => {
    setClientBlossom(list)
    blossomServers.saveList(list)
  }

  const addBlossom = () => {
    const trimmed = newBlossom.trim()
    if (!trimmed || !trimmed.startsWith('https://') || clientBlossom.some((s) => s.url === trimmed)) return
    saveClientBlossom([...clientBlossom, { url: trimmed, enabled: true }])
    setNewBlossom('')
  }

  /* ── Upload Limit ── */
  const [uploadLimit, setUploadLimit] = useState(10)
  const [sliderMaxGb, setSliderMaxGb] = useState(0.1)
  const sliderMaxMb = sliderMaxGb * 1024

  useEffect(() => {
    const stored = localStorage.getItem(StorageKey.UPLOAD_LIMIT_MB)
    if (stored) {
      const val = Number(stored) || 10
      setUploadLimit(val)
      // If stored value exceeds default max, adjust slider max
      if (val > 102) setSliderMaxGb(Math.ceil(val / 1024 * 10) / 10)
    }
  }, [])

  const saveUploadLimit = (mb: number) => {
    const clamped = Math.max(1, Math.min(mb, sliderMaxMb))
    setUploadLimit(clamped)
    localStorage.setItem(StorageKey.UPLOAD_LIMIT_MB, String(clamped))
  }

  const handleMaxGbChange = (delta: number) => {
    const step = sliderMaxGb < 1 ? 0.1 : sliderMaxGb < 10 ? 1 : 10
    const next = Math.round((sliderMaxGb + delta * step) * 100) / 100
    if (next < 0.1) return
    setSliderMaxGb(next)
    if (uploadLimit > next * 1024) {
      saveUploadLimit(Math.round(next * 1024))
    }
  }

  const sliderPercent = Math.min((uploadLimit / sliderMaxMb) * 100, 100)

  const [netTab, setNetTab] = useState<'posting' | 'relays' | 'blossom' | 'dnn' | 'rpc'>('posting')

  // Allow deep-linking to a specific network sub-tab (e.g., from wallet page → RPC)
  useEffect(() => {
    const { settingsNetworkTab, setSettingsNetworkTab } = useNavigationStore.getState()
    if (settingsNetworkTab && ['posting', 'relays', 'blossom', 'dnn', 'rpc'].includes(settingsNetworkTab)) {
      setNetTab(settingsNetworkTab as typeof netTab)
      setSettingsNetworkTab(null)
    }
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Network</h3>
        <p className="text-sm text-muted-foreground mt-1">Manage relays, media servers, and identity infrastructure.</p>
      </div>

      {/* Inner tabs */}
      <div className="flex flex-wrap gap-1.5 pb-4 border-b border-border">
        {([
          { id: 'posting' as const, label: 'Posting Behaviour' },
          { id: 'relays' as const, label: 'Relays' },
          { id: 'blossom' as const, label: 'Blossom Servers' },
          { id: 'dnn' as const, label: 'DNN Nodes' },
          { id: 'rpc' as const, label: 'RPC' },
        ]).map((t) => (
          <button
            key={t.id}
            onClick={() => setNetTab(t.id)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer ${netTab === t.id
              ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
              : 'bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70'
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Posting Behaviour ── */}
      {netTab === 'posting' && (
        <PostingBehaviourSection />
      )}

      {/* ── Relays ── */}
      {netTab === 'relays' && (
        <div className="space-y-8">
          {/* Client Relays */}
          <section className="space-y-3">
            <h4 className="text-sm font-semibold text-foreground">Client Relays</h4>
            <p className="text-xs text-muted-foreground">These relays are used for general Nostr communication. Changes take effect immediately.</p>
            <div className="space-y-1.5">
              {clientRelays.map((r, i) => (
                <div key={r.url} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
                  <ToggleSwitch checked={r.enabled} onChange={(v) => {
                    const copy = [...clientRelays]; copy[i] = { ...r, enabled: v }; saveClientRelays(copy)
                  }} />
                  <span className="text-sm text-foreground flex-1 font-mono truncate">{r.url}</span>
                  <RelayHealthDot url={r.url} />
                  {!getDefaultRelays().includes(r.url) && (
                    <button onClick={() => saveClientRelays(clientRelays.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={newRelay}
                onChange={(e) => setNewRelay(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addRelay()}
                placeholder="wss://relay.example.com"
                className={`flex-1 h-9 rounded-lg border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none ${newRelay.trim() && !newRelay.trim().startsWith('wss://') ? 'border-destructive/60 text-destructive' : 'border-input'}`}
              />
              <button onClick={addRelay} className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1.5">
                <Plus size={14} /> Add
              </button>
            </div>
            {newRelay.trim() && !newRelay.trim().startsWith('wss://') && (
              <p className="text-[11px] text-destructive mt-0.5">Relay URL must start with wss://</p>
            )}
            {clientRelays.every((r) => !r.enabled) && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-500">
                  All relays are disabled. The app won't be able to communicate with the Nostr network.
                </p>
              </div>
            )}
          </section>

          <div className="h-px bg-border" />

          {/* User Relay List */}
          <UserRelayListSection />
        </div>
      )}

      {/* ── Blossom Servers ── */}
      {netTab === 'blossom' && (
        <div className="space-y-8">
          {/* Client Blossom */}
          <section className="space-y-3">
            <h4 className="text-sm font-semibold text-foreground">Client Blossom Servers</h4>
            <p className="text-xs text-muted-foreground">Blossom servers are used for media file storage. Enabled servers are used for uploads and downloads.</p>
            <div className="space-y-1.5">
              {clientBlossom.map((s, i) => (
                <div key={s.url} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
                  <ToggleSwitch checked={s.enabled} onChange={(v) => {
                    const copy = [...clientBlossom]; copy[i] = { ...s, enabled: v }; saveClientBlossom(copy)
                  }} />
                  <span className="text-sm text-foreground flex-1 font-mono truncate">{s.url}</span>
                  <BlossomHealthDot url={s.url} />
                  {!blossomServers.getDefaults().includes(s.url) && (
                    <button onClick={() => saveClientBlossom(clientBlossom.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={newBlossom}
                onChange={(e) => setNewBlossom(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addBlossom()}
                placeholder="https://blossom.example.com"
                className={`flex-1 h-9 rounded-lg border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none ${newBlossom.trim() && !newBlossom.trim().startsWith('https://') ? 'border-destructive/60 text-destructive' : 'border-input'}`}
              />
              <button onClick={addBlossom} className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1.5">
                <Plus size={14} /> Add
              </button>
            </div>
            {newBlossom.trim() && !newBlossom.trim().startsWith('https://') && (
              <p className="text-[11px] text-destructive mt-0.5">Blossom URL must start with https://</p>
            )}
            {clientBlossom.every((s) => !s.enabled) && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-500">
                  All blossom servers are disabled. The app won't be able to upload or display media.
                </p>
              </div>
            )}
          </section>

          <div className="h-px bg-border" />

          {/* User Blossom Server List */}
          <UserBlossomListSection />

          <div className="h-px bg-border" />

          {/* Upload Limit */}
          <section className="space-y-3">
            <h4 className="text-sm font-semibold text-foreground">Media Upload Limit</h4>
            <p className="text-xs text-muted-foreground">
              Maximum file size per media upload. Lower values improve upload success rates across blossom servers.
            </p>

            <div className="space-y-3">
              <div className="flex items-center gap-4 px-2 py-1 rounded-sm bg-secondary">
                <div className="flex-1 relative h-6 flex items-center">
                  <div className="absolute left-0 right-0 h-2 rounded-full bg-muted-foreground/20" />
                  <div
                    className="absolute left-0 h-2 rounded-full bg-primary transition-all"
                    style={{ width: `${sliderPercent}%` }}
                  />
                  <div
                    className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
                    style={{ left: `calc(${sliderPercent}% - 10px)` }}
                  />
                  <input
                    type="range"
                    min={1}
                    max={sliderMaxMb}
                    step={sliderMaxMb <= 512 ? 1 : Math.max(1, Math.round(sliderMaxMb / 512))}
                    value={Math.min(uploadLimit, sliderMaxMb)}
                    onChange={(e) => saveUploadLimit(Number(e.target.value))}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground min-w-[72px] text-right tabular-nums">
                    {uploadLimit >= 512
                      ? `${(uploadLimit / 1024).toFixed(uploadLimit >= 1024 ? 1 : 2)} GB`
                      : `${uploadLimit} MB`
                    }
                  </span>
                  {uploadLimit !== 10 ? (
                    <button
                      onClick={() => saveUploadLimit(10)}
                      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      <RotateCcw size={14} />
                    </button>
                  ) : (
                    <div className="p-1 w-[22px]" />
                  )}
                </div>
              </div>
              <div className="flex justify-between items-center text-[10px] text-muted-foreground px-0.5">
                <span>1 MB</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Max:</span>
                  <div className="flex items-center h-6 rounded border border-input bg-background overflow-hidden">
                    <button
                      onClick={() => handleMaxGbChange(-1)}
                      className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
                    >
                      <Minus size={10} />
                    </button>
                    <span className="px-2 text-xs text-foreground tabular-nums min-w-[36px] text-center">
                      {sliderMaxGb < 1 ? sliderMaxGb.toFixed(1) : sliderMaxGb.toFixed(0)}
                    </span>
                    <button
                      onClick={() => handleMaxGbChange(1)}
                      className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
                    >
                      <Plus size={10} />
                    </button>
                  </div>
                  <span className="text-[10px] text-muted-foreground">GB</span>
                </div>
              </div>
            </div>

            {uploadLimit > 10 && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-500">
                  Increasing the upload limit above 10 MB may result in higher upload failure rates, as some blossom servers reject large files.
                </p>
              </div>
            )}
          </section>

          <div className="h-px bg-border" />

          {/* Emoji Upload Limit */}
          <EmojiUploadLimitSection />

          <div className="h-px bg-border" />

          {/* Sticker Upload Limit */}
          <StickerUploadLimitSection />

          <div className="h-px bg-border" />

          {/* Voice Notes */}
          <VoiceNoteSettingsSection uploadLimitMb={uploadLimit} />
        </div>
      )}

      {/* ── DNN Nodes ── */}
      {netTab === 'dnn' && (
        <DnnNodesSection />
      )}

      {/* ── RPC Endpoints ── */}
      {netTab === 'rpc' && (
        <RpcSettingsSection />
      )}
    </div>
  )
}
/* ─────────── RPC Endpoint Settings ─────────── */

const EVM_CHAIN_LIST: { id: EvmChain; name: string; symbol: string }[] = [
  { id: 'ethereum', name: 'Ethereum', symbol: 'ETH' },
  { id: 'bnb', name: 'BNB Chain', symbol: 'BNB' },
  { id: 'polygon', name: 'Polygon', symbol: 'POL' },
  { id: 'avalanche', name: 'Avalanche', symbol: 'AVAX' },
  { id: 'base', name: 'Base', symbol: 'ETH' },
]

function RpcSettingsSection() {
  const bitcoinNodes = useRpcStore((s) => s.bitcoinNodes)
  const setBitcoinNodes = useRpcStore((s) => s.setBitcoinNodes)
  const addBitcoinNode = useRpcStore((s) => s.addBitcoinNode)
  const removeBitcoinNode = useRpcStore((s) => s.removeBitcoinNode)
  const evmChains = useRpcStore((s) => s.evmChains)
  const setEvmNodes = useRpcStore((s) => s.setEvmNodes)
  const addEvmNode = useRpcStore((s) => s.addEvmNode)
  const removeEvmNode = useRpcStore((s) => s.removeEvmNode)
  const etherscanApiKey = useRpcStore((s) => s.etherscanApiKey)
  const setEtherscanApiKey = useRpcStore((s) => s.setEtherscanApiKey)
  const goldrushApiKey = useRpcStore((s) => s.goldrushApiKey)
  const setGoldrushApiKey = useRpcStore((s) => s.setGoldrushApiKey)
  const resetDefaults = useRpcStore((s) => s.resetDefaults)
  const resetChain = useRpcStore((s) => s.resetChain)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, 'ok' | 'fail' | null>>({})
  const [newBtcNode, setNewBtcNode] = useState('')
  const [newEvmNode, setNewEvmNode] = useState<Record<string, string>>({})

  const handleTestBtcNode = async (url: string) => {
    setTesting(url)
    setTestResult((p) => ({ ...p, [url]: null }))
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 6000)
      try {
        const res = await fetch(`${url}/blocks/tip/height`, { signal: controller.signal })
        clearTimeout(timeout)
        if (res.ok) {
          setTestResult((p) => ({ ...p, [url]: 'ok' }))
          return
        }
      } catch {
        clearTimeout(timeout)
      }
      const res2 = await fetch(`${url}/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`, { signal: AbortSignal.timeout(6000) })
      setTestResult((p) => ({ ...p, [url]: res2.ok ? 'ok' : 'fail' }))
    } catch {
      setTestResult((p) => ({ ...p, [url]: 'fail' }))
    } finally {
      setTesting(null)
    }
  }

  const handleTestEvmNode = async (url: string) => {
    setTesting(url)
    setTestResult((p) => ({ ...p, [url]: null }))
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
        signal: AbortSignal.timeout(6000),
      })
      const data = await res.json()
      setTestResult((p) => ({ ...p, [url]: data.result ? 'ok' : 'fail' }))
    } catch {
      setTestResult((p) => ({ ...p, [url]: 'fail' }))
    } finally { setTesting(null) }
  }

  const handleAddBtcNode = () => {
    const url = newBtcNode.trim().replace(/\/+$/, '')
    if (!url) return
    addBitcoinNode(url)
    setNewBtcNode('')
  }

  const handleMoveBtcNode = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= bitcoinNodes.length) return
    const updated = [...bitcoinNodes]
      ;[updated[index], updated[newIndex]] = [updated[newIndex], updated[index]]
    setBitcoinNodes(updated)
  }

  const handleAddEvmNode = (chain: EvmChain) => {
    const url = (newEvmNode[chain] || '').trim().replace(/\/+$/, '')
    if (!url) return
    addEvmNode(chain, url)
    setNewEvmNode((p) => ({ ...p, [chain]: '' }))
  }

  const handleMoveEvmNode = (chain: EvmChain, index: number, direction: -1 | 1) => {
    const nodes = evmChains[chain].nodes
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= nodes.length) return
    const updated = [...nodes]
      ;[updated[index], updated[newIndex]] = [updated[newIndex], updated[index]]
    setEvmNodes(chain, updated)
  }

  const isChainDefault = (chain: EvmChain) => {
    const cfg = evmChains[chain]
    const def = DEFAULT_EVM_CHAINS[chain]
    return JSON.stringify(cfg.nodes) === JSON.stringify(def.nodes)
  }

  // Shared node row renderer
  const renderNodeRow = (
    url: string, i: number, total: number,
    onTest: (url: string) => void,
    onMove: (i: number, dir: -1 | 1) => void,
    onRemove: (url: string) => void,
  ) => {
    const result = testResult[url]
    return (
      <div key={url} className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-secondary/30 border border-border/30">
        <span className="text-[10px] text-muted-foreground/50 w-4 text-center shrink-0 font-mono">{i + 1}</span>
        <code className="text-xs text-foreground font-mono flex-1 truncate">{url}</code>
        {result === 'ok' && <Check size={14} className="text-green-500 shrink-0" />}
        {result === 'fail' && <X size={14} className="text-destructive shrink-0" />}
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => onTest(url)} disabled={testing !== null}
                className="p-1.5 text-primary hover:bg-primary/10 rounded-md transition-colors cursor-pointer disabled:opacity-50 shrink-0">
                {testing === url ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Test connection</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => onMove(i, -1)} disabled={i === 0}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors cursor-pointer disabled:opacity-20 shrink-0">
                <ArrowUp size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Move up (higher priority)</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => onMove(i, 1)} disabled={i === total - 1}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors cursor-pointer disabled:opacity-20 shrink-0">
                <ArrowDown size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Move down (lower priority)</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => onRemove(url)} disabled={total <= 1}
                className="p-1.5 text-destructive/60 hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors cursor-pointer disabled:opacity-20 shrink-0">
                <Trash2 size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Remove node</p></TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-foreground">RPC Endpoints</h4>
            <p className="text-xs text-muted-foreground mt-0.5">Configure blockchain RPC nodes. Nodes are tried in order for automatic failover.</p>
          </div>
          <button onClick={resetDefaults}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground bg-secondary/40 hover:bg-secondary/70 rounded-md transition-colors cursor-pointer">
            Reset All
          </button>
        </div>

        {/* ── Bitcoin Nodes ── */}
        <div className="rounded-xl border border-border/60 bg-background/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">Bitcoin</span>
              <span className="text-[10px] text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded">BTC</span>
              <span className="text-[10px] text-muted-foreground/60 bg-secondary/30 px-1.5 py-0.5 rounded">
                {bitcoinNodes.length} node{bitcoinNodes.length !== 1 ? 's' : ''}
              </span>
            </div>
            {JSON.stringify(bitcoinNodes) !== JSON.stringify(DEFAULT_BITCOIN_NODES) && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button onClick={() => resetChain('bitcoin')}
                      className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors cursor-pointer">
                      <RotateCcw size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top"><p>Reset to default nodes</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          <div className="space-y-1.5">
            {bitcoinNodes.map((url, i) => renderNodeRow(url, i, bitcoinNodes.length, handleTestBtcNode, handleMoveBtcNode, removeBitcoinNode))}
          </div>

          <div className="flex gap-2">
            <Input value={newBtcNode} onChange={(e) => setNewBtcNode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddBtcNode()}
              placeholder="https://mempool.space/api" className="text-xs font-mono h-8 flex-1" />
            <button onClick={handleAddBtcNode} disabled={!newBtcNode.trim()}
              className="px-3 h-8 text-xs text-primary bg-primary/10 hover:bg-primary/20 rounded-md transition-colors cursor-pointer disabled:opacity-50 shrink-0 flex items-center gap-1.5">
              <Plus size={14} /> Add
            </button>
          </div>
        </div>

        {/* ── EVM Chains ── */}
        {EVM_CHAIN_LIST.map((chain) => {
          const cfg = evmChains[chain.id]
          const chainIsDefault = isChainDefault(chain.id)

          return (
            <div key={chain.id} className="rounded-xl border border-border/60 bg-background/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{chain.name}</span>
                  <span className="text-[10px] text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded">{chain.symbol}</span>
                  <span className="text-[10px] text-muted-foreground/60 bg-secondary/30 px-1.5 py-0.5 rounded">
                    {cfg.nodes.length} node{cfg.nodes.length !== 1 ? 's' : ''}
                  </span>
                </div>
                {!chainIsDefault && (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button onClick={() => resetChain(chain.id)}
                          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors cursor-pointer">
                          <RotateCcw size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top"><p>Reset to default</p></TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>

              {/* Node list */}
              <div className="space-y-1.5">
                {cfg.nodes.map((url, i) => renderNodeRow(
                  url, i, cfg.nodes.length,
                  handleTestEvmNode,
                  (idx, dir) => handleMoveEvmNode(chain.id, idx, dir),
                  (u) => removeEvmNode(chain.id, u),
                ))}
              </div>
              <div className="flex gap-2">
                <Input value={newEvmNode[chain.id] || ''} onChange={(e) => setNewEvmNode((p) => ({ ...p, [chain.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddEvmNode(chain.id)}
                  placeholder="https://rpc.example.com" className="text-xs font-mono h-8 flex-1" />
                <button onClick={() => handleAddEvmNode(chain.id)} disabled={!(newEvmNode[chain.id] || '').trim()}
                  className="px-3 h-8 text-xs text-primary bg-primary/10 hover:bg-primary/20 rounded-md transition-colors cursor-pointer disabled:opacity-50 shrink-0 flex items-center gap-1.5">
                  <Plus size={14} /> Add
                </button>
              </div>
            </div>
          )
        })}

        {/* ── Etherscan API Key ── */}
        <div className="rounded-xl border border-border/60 bg-background/60 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">Etherscan</span>
            <span className="text-[10px] text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded">All chains</span>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            API key for Etherscan V2 unified endpoint — used for transaction history across all EVM chains. Free tier available at <strong>etherscan.io</strong>. Without a key, chain-specific explorers and Routescan are used as fallback.
          </p>
          <div className="mt-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-1 block">
              API Key <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <Input
              value={etherscanApiKey}
              onChange={(e) => setEtherscanApiKey(e.target.value)}
              placeholder="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              className="text-xs font-mono h-8"
            />
          </div>
        </div>

        {/* ── GoldRush (Covalent) API Key ── */}
        <div className="rounded-xl border border-border/60 bg-background/60 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">GoldRush (Covalent)</span>
            <span className="text-[10px] text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded">Fallback</span>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Optional API key for GoldRush (Covalent) — used as a last-resort fallback for transaction history. Covers all EVM chains. Get a free key at <strong>goldrush.dev</strong>.
          </p>
          <div className="mt-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-1 block">
              API Key <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <Input
              value={goldrushApiKey}
              onChange={(e) => setGoldrushApiKey(e.target.value)}
              placeholder="cqt_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="text-xs font-mono h-8"
            />
          </div>
        </div>

        <div className="rounded-lg bg-secondary/30 border border-border/40 px-4 py-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground text-xs">Tips</p>
          <p>• Each chain has 3 free public nodes by default. Nodes are tried in order for automatic failover.</p>
          <p>• For better reliability, add your own RPC endpoint from <strong>Alchemy</strong>, <strong>Infura</strong>, or <strong>QuickNode</strong>.</p>
          <p>• Transaction history uses a 4-layer fallback: Etherscan V2 → chain explorer (bscscan, etc.) → Routescan → GoldRush.</p>
          <p>• Even without API keys, chain-specific explorers and Routescan provide basic tx history for most chains.</p>
        </div>
      </section>
    </div>
  )
}


/* ─────────── Voice Notes Settings ─────────── */

function VoiceNoteSettingsSection({ uploadLimitMb }: { uploadLimitMb: number }) {
  const maxDuration = usePreferencesStore((s) => s.voiceNoteMaxDuration)
  const setMaxDuration = usePreferencesStore((s) => s.setVoiceNoteMaxDuration)

  // WAV size estimate: 16-bit PCM mono at 48kHz = sampleRate * 2 bytes * duration + 44-byte header
  const WAV_SAMPLE_RATE = 48000
  const estimatedBytes = (WAV_SAMPLE_RATE * 2 * maxDuration) + 44
  const estimatedKb = estimatedBytes / 1024
  const estimatedMb = estimatedBytes / (1024 * 1024)
  const exceedsLimit = estimatedMb > uploadLimitMb

  const durationPercent = Math.min(((maxDuration - 10) / (120 - 10)) * 100, 100)

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Mic size={16} className="text-primary" />
        <h4 className="text-sm font-semibold text-foreground">Voice Notes</h4>
      </div>
      <p className="text-xs text-muted-foreground">
        Configure voice note maximum duration. Output is WAV (uncompressed 16-bit mono) for reliable seeking.
      </p>

      {/* Max Duration slider */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Max Recording Duration</label>
        <div className="flex items-center gap-4 px-2 py-1 rounded-sm bg-secondary">
          <div className="flex-1 relative h-6 flex items-center">
            <div className="absolute left-0 right-0 h-2 rounded-full bg-muted-foreground/20" />
            <div
              className="absolute left-0 h-2 rounded-full bg-primary transition-all"
              style={{ width: `${durationPercent}%` }}
            />
            <div
              className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
              style={{ left: `calc(${durationPercent}% - 10px)` }}
            />
            <input
              type="range"
              min={10}
              max={120}
              step={5}
              value={maxDuration}
              onChange={(e) => setMaxDuration(Number(e.target.value))}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
          <span className="text-sm font-semibold text-foreground min-w-[50px] text-right tabular-nums">
            {maxDuration}s
          </span>
          {maxDuration !== 30 && (
            <button
              onClick={() => setMaxDuration(30)}
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
          <span>10s</span>
          <span>120s</span>
        </div>
      </div>

      {/* Size estimate */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
        <span className="text-xs text-muted-foreground">Estimated size:</span>
        <span className="text-xs font-semibold text-foreground tabular-nums">
          ~{estimatedKb < 1024 ? `${estimatedKb.toFixed(0)} KB` : `${estimatedMb.toFixed(1)} MB`}
        </span>
        <span className="text-[10px] text-muted-foreground">
          for {maxDuration}s WAV (16-bit mono)
        </span>
      </div>

      {/* Upload limit warning */}
      {exceedsLimit && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
          <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-500">
            Estimated size (~{estimatedMb.toFixed(1)} MB) exceeds your upload limit of {uploadLimitMb} MB. Consider reducing the duration.
          </p>
        </div>
      )}
    </section>
  )
}

/* ─────────── DNN Nodes ─────────── */

function DnnNodesSection() {
  const addUserNode = useDnnStore((s) => s.addUserNode)
  const removeUserNode = useDnnStore((s) => s.removeUserNode)
  const refreshNodes = useDnnStore((s) => s.refreshNodes)
  const serviceReady = useDnnStore((s) => s.serviceReady)
  const initService = useDnnStore((s) => s.initService)

  const [knownNodes, setKnownNodes] = useState<DnnNodeInfo[]>([])
  const [discovered, setDiscovered] = useState<DnnNodeInfo[]>([])
  const [newNode, setNewNode] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const reloadNodes = () => {
    setKnownNodes(dnnService.getKnownNodes())
    setDiscovered(dnnService.getDiscoveredNodes())
  }

  // Initialize service and load nodes
  useEffect(() => {
    initService().then(reloadNodes)
  }, [initService])

  const handleAddNode = () => {
    const trimmed = newNode.trim()
    if (!trimmed) return
    addUserNode(trimmed)
    setNewNode('')
    reloadNodes()
  }

  const handleRemoveNode = (url: string) => {
    removeUserNode(url)
    reloadNodes()
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshNodes()
      reloadNodes()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <BadgeCheck size={16} className="text-primary" />
        <h4 className="text-sm font-semibold text-foreground">DNN Nodes</h4>
      </div>
      <p className="text-xs text-muted-foreground">
        DNN nodes resolve decentralized identity names. Add trusted nodes or let the app discover them automatically.
      </p>

      {/* Known nodes — default + user-added */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">Known Nodes</span>
        {knownNodes.map((node) => (
          <div key={node.url} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
            <span className={`w-2 h-2 rounded-full shrink-0 ${node.healthy ? 'bg-emerald-400' : 'bg-red-400'}`} />
            <span className="text-sm text-foreground flex-1 font-mono truncate">{node.url}</span>
            {node.source === 'default' && (
              <span className="text-[10px] text-muted-foreground/60 shrink-0">default</span>
            )}
            {node.source === 'user' && (
              <button
                onClick={() => handleRemoveNode(node.url)}
                className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Add node */}
      <div className="flex gap-2">
        <input
          value={newNode}
          onChange={(e) => setNewNode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddNode()}
          placeholder="https://node.example.com"
          className="flex-1 h-9 rounded-lg border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none"
        />
        <button
          onClick={handleAddNode}
          className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1.5"
        >
          <Plus size={14} /> Add
        </button>
      </div>

      {/* Discovered nodes */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Discovered Nodes (up to 5)</span>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 transition-colors cursor-pointer disabled:opacity-50"
          >
            {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            {refreshing ? 'Discovering...' : 'Re-discover'}
          </button>
        </div>
        {discovered.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 italic px-3 py-2">
            {serviceReady ? 'No additional nodes discovered yet.' : 'Initializing DNN service...'}
          </p>
        ) : (
          discovered.map((node) => (
            <div key={node.url} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-secondary/20 border border-border/50">
              <span className={`w-2 h-2 rounded-full shrink-0 ${node.healthy ? 'bg-emerald-400' : 'bg-red-400'}`} />
              <span className="text-sm text-foreground/80 flex-1 font-mono truncate">{node.url}</span>
              {node.failCount > 0 && (
                <span className="text-[10px] text-red-400/70">{node.failCount} fails</span>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  )
}

/* ─────────── Posting Behaviour ─────────── */

function PostingBehaviourSection() {
  const {
    postToClientRelays, setPostToClientRelays,
    postToUserRelays, setPostToUserRelays,
    postToHubRelays, setPostToHubRelays,
    limitRelaysPerList, setLimitRelaysPerList,
    limitBlossomsPerList, setLimitBlossomsPerList,
  } = usePostingBehaviourStore()

  return (
    <section className="space-y-3">
      <h4 className="text-sm font-semibold text-foreground">Posting Behaviour</h4>
      <p className="text-xs text-muted-foreground">
        Control which relay and blossom server lists are used when publishing events or uploading media. These settings apply across hub messages, social posts, DMs, and profile updates.
      </p>
      <div className="space-y-2">
        <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-secondary/30">
          <div>
            <p className="text-sm font-medium text-foreground">Post to client relays</p>
            <p className="text-xs text-muted-foreground">Publish events to your configured client relays</p>
          </div>
          <ToggleSwitch checked={postToClientRelays} onChange={setPostToClientRelays} />
        </div>
        <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-secondary/30">
          <div>
            <p className="text-sm font-medium text-foreground">Post to user relays</p>
            <p className="text-xs text-muted-foreground">Publish events to your NIP-65 relay list</p>
          </div>
          <ToggleSwitch checked={postToUserRelays} onChange={setPostToUserRelays} />
        </div>
        <div className={`px-3 py-2 rounded-lg border ${!postToHubRelays ? 'border-amber-500/30 bg-amber-500/5' : 'border-border bg-secondary/30'}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Post to hub relays</p>
              <p className="text-xs text-muted-foreground">Publish hub messages to hub-specific relays (from hub event)</p>
            </div>
            <ToggleSwitch checked={postToHubRelays} onChange={setPostToHubRelays} />
          </div>
          {!postToHubRelays && (
            <div className="flex items-start gap-1.5 mt-2 pt-2 border-t border-amber-500/20">
              <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-500/90 leading-tight">
                Other hub members who only subscribe to hub relays may not see your messages.
              </p>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-secondary/30">
          <div>
            <p className="text-sm font-medium text-foreground">Limit to max 3 relays per list</p>
            <p className="text-xs text-muted-foreground">Randomly pick up to 3 relays from each enabled list to reduce publish load</p>
          </div>
          <ToggleSwitch checked={limitRelaysPerList} onChange={setLimitRelaysPerList} />
        </div>
        <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-secondary/30">
          <div>
            <p className="text-sm font-medium text-foreground">Limit to max 3 blossoms per list</p>
            <p className="text-xs text-muted-foreground">Upload media to at most 3 blossom servers from each list</p>
          </div>
          <ToggleSwitch checked={limitBlossomsPerList} onChange={setLimitBlossomsPerList} />
        </div>
      </div>
      {!postToClientRelays && !postToUserRelays && !postToHubRelays && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
          <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-500">
            All relay sources are disabled. Events won't be published to any relays.
          </p>
        </div>
      )}
    </section>
  )
}

/* ─────────── Emoji Upload Limit ─────────── */

function EmojiUploadLimitSection() {
  const [emojiLimit, setEmojiLimit] = useState(1)
  const [allowLarge, setAllowLarge] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(StorageKey.EMOJI_UPLOAD_LIMIT_MB)
    if (stored) setEmojiLimit(Math.max(0, Math.min(10, Number(stored) || 1)))
    setAllowLarge(localStorage.getItem(StorageKey.ALLOW_LARGE_EMOJIS) === 'true')
  }, [])

  const saveEmojiLimit = (mb: number) => {
    const clamped = Math.max(0, Math.min(mb, 10))
    setEmojiLimit(clamped)
    localStorage.setItem(StorageKey.EMOJI_UPLOAD_LIMIT_MB, String(clamped))
  }

  const toggleAllowLarge = () => {
    const next = !allowLarge
    setAllowLarge(next)
    localStorage.setItem(StorageKey.ALLOW_LARGE_EMOJIS, String(next))
  }

  const emojiSliderPercent = Math.min((emojiLimit / 10) * 100, 100)

  return (
    <section className="space-y-3">
      <h4 className="text-sm font-semibold text-foreground">Emoji Upload Limit</h4>
      <p className="text-xs text-muted-foreground">
        Maximum file size per custom emoji image upload. Emojis should generally be small for optimal rendering.
      </p>

      <div className="space-y-3">
        <div className="flex items-center gap-4 px-2 py-1 rounded-sm bg-secondary">
          <div className="flex-1 relative h-6 flex items-center">
            <div className="absolute left-0 right-0 h-2 rounded-full bg-muted-foreground/20" />
            <div
              className="absolute left-0 h-2 rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all"
              style={{ width: `${emojiSliderPercent}%` }}
            />
            <div
              className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
              style={{ left: `calc(${emojiSliderPercent}% - 10px)` }}
            />
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={emojiLimit}
              onChange={(e) => saveEmojiLimit(Number(e.target.value))}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground min-w-[48px] text-right tabular-nums">
              {emojiLimit} MB
            </span>
            {emojiLimit !== 1 ? (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => saveEmojiLimit(1)}
                      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      <RotateCcw size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Reset to default (1 MB)</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <div className="p-1 w-[22px]" />
            )}
          </div>
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
          <span>0 MB</span>
          <span>10 MB</span>
        </div>
      </div>

      {/* Allow large emojis toggle */}
      <div className="pt-2 border-t border-border">
        <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
          <div>
            <p className="text-xs font-medium text-foreground">Show large emojis</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              When off, custom emojis larger than 1 MB won't render in messages and oversized sets are hidden in discovery. Enable if you don't mind loading large images.
            </p>
          </div>
          <button
            onClick={toggleAllowLarge}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${allowLarge ? 'bg-[hsl(var(--primary))]' : 'bg-muted-foreground/30'}`}
          >
            <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${allowLarge ? 'left-[18px]' : 'left-[2px]'}`} />
          </button>
        </label>
      </div>
    </section>
  )
}

/* ─────────── Sticker Upload Limit ─────────── */

function StickerUploadLimitSection() {
  const [stickerLimit, setStickerLimit] = useState(5)
  const [allowLarge, setAllowLarge] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(StorageKey.STICKER_UPLOAD_LIMIT_MB)
    if (stored) setStickerLimit(Math.max(0, Math.min(10, Number(stored) || 5)))
    setAllowLarge(localStorage.getItem(StorageKey.ALLOW_LARGE_STICKERS) === 'true')
  }, [])

  const saveStickerLimit = (mb: number) => {
    const clamped = Math.max(0, Math.min(mb, 10))
    setStickerLimit(clamped)
    localStorage.setItem(StorageKey.STICKER_UPLOAD_LIMIT_MB, String(clamped))
  }

  const toggleAllowLarge = () => {
    const next = !allowLarge
    setAllowLarge(next)
    localStorage.setItem(StorageKey.ALLOW_LARGE_STICKERS, String(next))
  }

  const sliderPercent = Math.min((stickerLimit / 10) * 100, 100)

  return (
    <section className="space-y-3">
      <h4 className="text-sm font-semibold text-foreground">Sticker Upload Limit</h4>
      <p className="text-xs text-muted-foreground">
        Maximum file size per custom sticker image upload. Stickers are typically larger than emojis.
      </p>

      <div className="space-y-3">
        <div className="flex items-center gap-4 px-2 py-1 rounded-sm bg-secondary">
          <div className="flex-1 relative h-6 flex items-center">
            <div className="absolute left-0 right-0 h-2 rounded-full bg-muted-foreground/20" />
            <div
              className="absolute left-0 h-2 rounded-full bg-gradient-to-r from-violet-500 to-purple-400 transition-all"
              style={{ width: `${sliderPercent}%` }}
            />
            <div
              className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
              style={{ left: `calc(${sliderPercent}% - 10px)` }}
            />
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={stickerLimit}
              onChange={(e) => saveStickerLimit(Number(e.target.value))}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground min-w-[48px] text-right tabular-nums">
              {stickerLimit} MB
            </span>
            {stickerLimit !== 5 ? (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => saveStickerLimit(5)}
                      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      <RotateCcw size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Reset to default (5 MB)</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <div className="p-1 w-[22px]" />
            )}
          </div>
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
          <span>0 MB</span>
          <span>10 MB</span>
        </div>
      </div>

      {/* Allow large stickers toggle */}
      <div className="pt-2 border-t border-border">
        <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
          <div>
            <p className="text-xs font-medium text-foreground">Show large stickers</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              When off, custom stickers larger than 5 MB won't render in messages and oversized sets are hidden in discovery. Enable if you don't mind loading large images.
            </p>
          </div>
          <button
            onClick={toggleAllowLarge}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${allowLarge ? 'bg-[hsl(var(--primary))]' : 'bg-muted-foreground/30'}`}
          >
            <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${allowLarge ? 'left-[18px]' : 'left-[2px]'}`} />
          </button>
        </label>
      </div>
    </section>
  )
}

/* ─────────── User Relay List (NIP-65) ─────────── */

function UserRelayListSection() {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const refreshingRelays = useUserListsStore((s) => s.refreshingRelays)
  const refreshUserRelays = useUserListsStore((s) => s.refreshUserRelays)

  const [relays, setRelayList] = useState<string[]>([])
  const [savedRelays, setSavedRelays] = useState<string[]>([])
  const [newRelay, setNewRelay] = useState('')
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<'success' | 'error' | null>(null)

  useEffect(() => {
    if (!pubkey) { setLoading(false); return }
    fetchReplaceable(pubkey, STANDARD_KINDS.RELAY_LIST).then((ev) => {
      if (ev) {
        const urls = ev.tags.filter((t) => t[0] === 'r').map((t) => t[1])
        setRelayList(urls)
        setSavedRelays(urls)
      }
    }).finally(() => setLoading(false))
  }, [pubkey])

  const hasChanges = JSON.stringify(relays) !== JSON.stringify(savedRelays)

  const addRelay = () => {
    const trimmed = newRelay.trim()
    if (!trimmed || !trimmed.startsWith('wss://') || relays.includes(trimmed)) return
    setRelayList([...relays, trimmed])
    setNewRelay('')
  }

  const removeRelay = (url: string) => {
    setRelayList(relays.filter((r) => r !== url))
  }

  const handlePublish = async () => {
    setPublishing(true)
    setPublishResult(null)
    try {
      const tags: [string, ...string[]][] = relays.map((url) => ['r', url])
      const unsigned = createUnsignedEvent(STANDARD_KINDS.RELAY_LIST, '', tags)
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(), signed)
      setSavedRelays([...relays])
      setPublishResult('success')
      setTimeout(() => setPublishResult(null), 3000)
    } catch (err) {
      console.error('Failed to publish relay list:', err)
      setPublishResult('error')
    } finally {
      setPublishing(false)
    }
  }

  if (!pubkey) return null

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-foreground">User Relay List</h4>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  if (!pubkey) return
                  refreshUserRelays(pubkey).then(() => {
                    const updated = useUserListsStore.getState().userRelays
                    setRelayList(updated)
                    setSavedRelays(updated)
                  })
                }}
                disabled={refreshingRelays}
                className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw size={13} className={refreshingRelays ? 'animate-spin' : ''} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Refresh from relays</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <p className="text-xs text-muted-foreground">
        Your published relay list (NIP-65). Other clients use this to find you. Changes require publishing to take effect.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 size={14} className="animate-spin" /> Fetching your relay list…
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {relays.map((url) => (
              <div key={url} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
                <span className="text-sm text-foreground flex-1 font-mono truncate">{url}</span>
                <RelayHealthDot url={url} />
                <button onClick={() => removeRelay(url)} className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {relays.length === 0 && (
              <p className="text-xs text-muted-foreground italic py-1">No relays published yet. Add some and publish.</p>
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={newRelay}
              onChange={(e) => setNewRelay(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addRelay()}
              placeholder="wss://relay.example.com"
              className={`flex-1 h-9 rounded-lg border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none ${newRelay.trim() && !newRelay.trim().startsWith('wss://') ? 'border-destructive/60 text-destructive' : 'border-input'}`}
            />
            <button onClick={addRelay} className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1.5">
              <Plus size={14} /> Add
            </button>
          </div>
          {newRelay.trim() && !newRelay.trim().startsWith('wss://') && (
            <p className="text-[11px] text-destructive mt-0.5">Relay URL must start with wss://</p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handlePublish}
              disabled={!hasChanges || publishing}
              className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {publishing ? <><Loader2 size={14} className="animate-spin" /> Publishing…</> : <><Send size={14} /> Publish Changes</>}
            </button>
            {publishResult === 'success' && <span className="text-xs text-emerald-400 flex items-center gap-1"><Check size={12} /> Published!</span>}
            {publishResult === 'error' && <span className="text-xs text-destructive">Failed to publish</span>}
          </div>
        </>
      )}
    </section>
  )
}

/* ─────────── User Blossom Server List ─────────── */

function UserBlossomListSection() {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const refreshingBlossoms = useUserListsStore((s) => s.refreshingBlossoms)
  const refreshUserBlossoms = useUserListsStore((s) => s.refreshUserBlossoms)

  const [servers, setServerList] = useState<string[]>([])
  const [savedServers, setSavedServers] = useState<string[]>([])
  const [newServer, setNewServer] = useState('')
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<'success' | 'error' | null>(null)

  useEffect(() => {
    if (!pubkey) { setLoading(false); return }
    fetchReplaceable(pubkey, STANDARD_KINDS.BLOSSOM_SERVER_LIST).then((ev) => {
      if (ev) {
        const urls = ev.tags.filter((t) => t[0] === 'server').map((t) => t[1])
        setServerList(urls)
        setSavedServers(urls)
      }
    }).finally(() => setLoading(false))
  }, [pubkey])

  const hasChanges = JSON.stringify(servers) !== JSON.stringify(savedServers)

  const addServer = () => {
    const trimmed = newServer.trim()
    if (!trimmed || !trimmed.startsWith('https://') || servers.includes(trimmed)) return
    setServerList([...servers, trimmed])
    setNewServer('')
  }

  const removeServer = (url: string) => {
    setServerList(servers.filter((s) => s !== url))
  }

  const handlePublish = async () => {
    setPublishing(true)
    setPublishResult(null)
    try {
      const tags: [string, ...string[]][] = servers.map((url) => ['server', url])
      const unsigned = createUnsignedEvent(STANDARD_KINDS.BLOSSOM_SERVER_LIST, '', tags)
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(), signed)
      setSavedServers([...servers])
      setPublishResult('success')
      setTimeout(() => setPublishResult(null), 3000)
    } catch (err) {
      console.error('Failed to publish blossom server list:', err)
      setPublishResult('error')
    } finally {
      setPublishing(false)
    }
  }

  if (!pubkey) return null

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-foreground">User Blossom Server List</h4>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  if (!pubkey) return
                  refreshUserBlossoms(pubkey).then(() => {
                    const updated = useUserListsStore.getState().userBlossoms
                    setServerList(updated)
                    setSavedServers(updated)
                  })
                }}
                disabled={refreshingBlossoms}
                className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw size={13} className={refreshingBlossoms ? 'animate-spin' : ''} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Refresh from relays</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <p className="text-xs text-muted-foreground">
        Your published blossom server list. Other clients use this to discover your media servers. Changes require publishing.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 size={14} className="animate-spin" /> Fetching your blossom server list…
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {servers.map((url) => (
              <div key={url} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
                <span className="text-sm text-foreground flex-1 font-mono truncate">{url}</span>
                <BlossomHealthDot url={url} />
                <button onClick={() => removeServer(url)} className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {servers.length === 0 && (
              <p className="text-xs text-muted-foreground italic py-1">No blossom servers published yet. Add some and publish.</p>
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={newServer}
              onChange={(e) => setNewServer(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addServer()}
              placeholder="https://blossom.example.com"
              className={`flex-1 h-9 rounded-lg border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none ${newServer.trim() && !newServer.trim().startsWith('https://') ? 'border-destructive/60 text-destructive' : 'border-input'}`}
            />
            <button onClick={addServer} className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1.5">
              <Plus size={14} /> Add
            </button>
          </div>
          {newServer.trim() && !newServer.trim().startsWith('https://') && (
            <p className="text-[11px] text-destructive mt-0.5">Blossom URL must start with https://</p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handlePublish}
              disabled={!hasChanges || publishing}
              className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {publishing ? <><Loader2 size={14} className="animate-spin" /> Publishing…</> : <><Send size={14} /> Publish Changes</>}
            </button>
            {publishResult === 'success' && <span className="text-xs text-emerald-400 flex items-center gap-1"><Check size={12} /> Published!</span>}
            {publishResult === 'error' && <span className="text-xs text-destructive">Failed to publish</span>}
          </div>
        </>
      )}
    </section>
  )
}

/* ─────────── Moderation ─────────── */

function ModerationTab() {
  const wotSettings = useWotStore((s) => s.settings)
  const updateWot = useWotStore((s) => s.updateSettings)
  const building = useWotStore((s) => s.building)
  const graphDepth = useWotStore((s) => s.graphDepth)
  const graphSize = useWotStore((s) => s.graphSize)
  const buildGraph = useWotStore((s) => s.buildGraph)
  const refreshGraph = useWotStore((s) => s.refreshGraph)
  const buildPhase = useWotStore((s) => s.buildPhase)
  const buildProgress = useWotStore((s) => s.buildProgress)
  const buildTotal = useWotStore((s) => s.buildTotal)
  const buildDepthTarget = useWotStore((s) => s.buildDepthTarget)
  const buildDepthCurrent = useWotStore((s) => s.buildDepthCurrent)

  return (
    <div className="space-y-8">
      <h3 className="text-lg font-semibold">Moderation</h3>

      {/* Muted Words */}
      <section className="space-y-3">
        <MutedWordsPreference />
      </section>

      {/* Global muted words toggle */}
      <MutedWordsGlobalToggle />

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Content Filters */}
      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground uppercase tracking-wider text-muted-foreground">Content Filters</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Global toggles that control what content is rendered across the entire app. When a toggle is off, the corresponding public chat toggle is also forced off.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <EmbedPreferenceToggle />
          <MediaPreferenceToggle />
          <CustomEmojiPreferenceToggle />
        </div>
      </section>

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Image Render Limits */}
      <ImageRenderLimitSettings />

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Web of Trust */}
      <section className="space-y-5">
        <div>
          <h4 className="text-sm font-semibold text-foreground uppercase tracking-wider text-muted-foreground">Web of Trust</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Score users based on your social graph. Users scoring below your threshold are hidden. Direct follows always bypass WoT.
          </p>
        </div>

        {/* Score Threshold Slider */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">Score Threshold</label>
            <span className={`text-sm font-mono font-semibold px-2 py-0.5 rounded ${wotSettings.scoreThreshold > 0 ? 'bg-emerald-500/15 text-emerald-400' :
              wotSettings.scoreThreshold < 0 ? 'bg-red-500/15 text-red-400' :
                'bg-secondary text-muted-foreground'
              }`}>
              {wotSettings.scoreThreshold > 0 ? '+' : ''}{wotSettings.scoreThreshold}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Users with a score below this value are hidden. Lower = more permissive, higher = stricter.
          </p>
          <div className="flex items-center gap-3 px-2 py-1 rounded-sm bg-secondary">
            <div className="flex-1 relative h-6 flex items-center">
              <div className="absolute left-0 right-0 h-2 rounded-full overflow-hidden">
                <div className="absolute inset-0 bg-muted-foreground/20" />
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-red-400 via-amber-400 to-emerald-400"
                  style={{ width: `${((wotSettings.scoreThreshold + 5) / 10) * 100}%` }}
                />
              </div>
              <div
                className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
                style={{ left: `calc(${((wotSettings.scoreThreshold + 5) / 10) * 100}% - 10px)` }}
              />
              <input
                type="range"
                min={-5}
                max={5}
                step={1}
                value={wotSettings.scoreThreshold}
                onChange={(e) => updateWot({ scoreThreshold: Number(e.target.value) })}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground/60 px-0.5">
            <span>-5</span>
            <span>0</span>
            <span>+5</span>
          </div>
        </div>

        {/* Follow Depth Slider */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">Follow Depth</label>
            <span className="text-sm font-mono font-semibold px-2 py-0.5 rounded bg-secondary text-muted-foreground">
              {wotSettings.followDepth}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {wotSettings.followDepth === 0 && 'Only your direct follows contribute to scores.'}
            {wotSettings.followDepth === 1 && 'Follows of your follows also contribute (+1 depth).'}
            {wotSettings.followDepth === 2 && 'Two degrees of separation from your follows (+2 depth).'}
            {wotSettings.followDepth === 3 && 'Three degrees deep — wide trust radius (+3 depth).'}
          </p>
          <div className="flex items-center gap-3 px-2 py-1 rounded-sm bg-secondary">
            <div className="flex-1 relative h-6 flex items-center">
              <div className="absolute left-0 right-0 h-2 rounded-full overflow-hidden">
                <div className="absolute inset-0 bg-muted-foreground/20" />
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-sky-500 to-violet-400"
                  style={{ width: `${(wotSettings.followDepth / 3) * 100}%` }}
                />
              </div>
              <div
                className="absolute w-5 h-5 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
                style={{ left: `calc(${(wotSettings.followDepth / 3) * 100}% - 10px)` }}
              />
              <input
                type="range"
                min={0}
                max={3}
                step={1}
                value={wotSettings.followDepth}
                onChange={(e) => updateWot({ followDepth: Number(e.target.value) })}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground/60 px-0.5">
            <span>0</span>
            <span>1</span>
            <span>2</span>
            <span>3</span>
          </div>
        </div>

        {/* DNN Bonus Toggle */}
        <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
          <div>
            <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <BadgeCheck size={14} className="text-primary" /> DNN ID Bonus
            </p>
            <p className="text-xs text-muted-foreground">Verified DNN ID adds +1 to a user's trust score</p>
          </div>
          <ToggleSwitch checked={wotSettings.dnnBonus} onChange={(v) => updateWot({ dnnBonus: v })} />
        </div>

        {/* Application Toggles */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Apply WoT Filtering To</h4>

          <div className="space-y-2">
            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
              <div>
                <p className="text-sm font-medium text-foreground">Social Feed</p>
                <p className="text-xs text-muted-foreground">Hide low-trust posts in the social page</p>
              </div>
              <ToggleSwitch checked={wotSettings.applySocial} onChange={(v) => updateWot({ applySocial: v })} />
            </div>

            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
              <div>
                <p className="text-sm font-medium text-foreground">Public Chat</p>
                <p className="text-xs text-muted-foreground">Hide low-trust messages in public chat</p>
              </div>
              <ToggleSwitch checked={wotSettings.applyPublicChat} onChange={(v) => updateWot({ applyPublicChat: v })} />
            </div>

            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
              <div>
                <p className="text-sm font-medium text-foreground">Hub Chat</p>
                <p className="text-xs text-muted-foreground">Hide low-trust messages in hub channels</p>
              </div>
              <ToggleSwitch checked={wotSettings.applyHubChat} onChange={(v) => updateWot({ applyHubChat: v })} />
            </div>

            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
              <div>
                <p className="text-sm font-medium text-foreground">Direct Messages</p>
                <p className="text-xs text-muted-foreground">Hide DM conversations from low-trust users</p>
              </div>
              <ToggleSwitch checked={wotSettings.applyDMs} onChange={(v) => updateWot({ applyDMs: v })} />
            </div>
          </div>
        </div>

        {/* Graph Status */}
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Trust Graph</h4>
          <div className="rounded-lg border border-border bg-secondary/30 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2.5">
              <div className="flex items-center gap-2">
                {building ? (
                  <Loader2 size={14} className="text-primary animate-spin" />
                ) : (
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0" />
                )}
                <div>
                  <p className="text-sm text-foreground">
                    {building ? 'Building graph…' : `${graphSize.toLocaleString()} users indexed`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {building
                      ? `Target depth: ${buildDepthTarget}`
                      : graphDepth >= 0 ? `Depth: ${graphDepth}` : 'Not built yet'
                    }
                  </p>
                </div>
              </div>
              <button
                onClick={() => building ? undefined : refreshGraph()}
                disabled={building}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw size={12} className={building ? 'animate-spin' : ''} />
                {building ? 'Building…' : 'Refresh'}
              </button>
            </div>

            {/* Progress bar — shown only while building */}
            {building && buildTotal > 0 && (
              <div className="px-3 pb-3 space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">{buildPhase}</span>
                  <span className="text-foreground font-medium tabular-nums">
                    {buildProgress.toLocaleString()} / {buildTotal.toLocaleString()}
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-muted-foreground/20 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-500 to-violet-400 transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(100, (buildProgress / buildTotal) * 100)}%` }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {buildDepthCurrent > 0 && `Depth ${buildDepthCurrent} of ${buildDepthTarget} • `}
                  {graphSize.toLocaleString()} users indexed so far
                </p>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function EmbedPreferenceToggle() {
  const showEmbeds = usePreferencesStore((s) => s.showEmbeds)
  const setShowEmbeds = usePreferencesStore((s) => s.setShowEmbeds)

  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
      <div>
        <p className="text-sm font-medium text-foreground">Show Link Previews & Embeds</p>
        <p className="text-xs text-muted-foreground">URLs display as clickable links only — no iframes or preview cards are loaded.</p>
      </div>
      <ToggleSwitch checked={showEmbeds} onChange={setShowEmbeds} />
    </div>
  )
}

function LinkPreviewPreferenceToggle() {
  const showLinkPreviews = usePreferencesStore((s) => s.showLinkPreviews)
  const setShowLinkPreviews = usePreferencesStore((s) => s.setShowLinkPreviews)

  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
      <div>
        <p className="text-sm font-medium text-foreground">Show Link Previews</p>
        <p className="text-xs text-muted-foreground">Display OpenGraph preview cards for URLs. Only works on the desktop app.</p>
      </div>
      <ToggleSwitch checked={showLinkPreviews} onChange={setShowLinkPreviews} />
    </div>
  )
}

/** Inline toggle for Preferences tab — just the switch, no card wrapper */
function LinkPreviewToggleInline() {
  const showLinkPreviews = usePreferencesStore((s) => s.showLinkPreviews)
  const setShowLinkPreviews = usePreferencesStore((s) => s.setShowLinkPreviews)
  return <ToggleSwitch checked={showLinkPreviews} onChange={setShowLinkPreviews} />
}

/** Inline toggle for Preferences tab — just the switch, no card wrapper */
function EmbedsToggleInline() {
  const showEmbeds = usePreferencesStore((s) => s.showEmbeds)
  const setShowEmbeds = usePreferencesStore((s) => s.setShowEmbeds)
  return <ToggleSwitch checked={showEmbeds} onChange={setShowEmbeds} />
}

function TypingIndicatorToggleInline() {
  const enabled = useTypingStore((s) => s.enabled)
  const setEnabled = useTypingStore((s) => s.setEnabled)
  return <ToggleSwitch checked={enabled} onChange={setEnabled} />
}

function MediaPreferenceToggle() {
  const showMedia = usePreferencesStore((s) => s.showMedia)
  const setShowMedia = usePreferencesStore((s) => s.setShowMedia)

  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
      <div>
        <p className="text-sm font-medium text-foreground">Show Media</p>
        <p className="text-xs text-muted-foreground">Render images, videos, stickers, and GIFs inline in messages.</p>
      </div>
      <ToggleSwitch checked={showMedia} onChange={setShowMedia} />
    </div>
  )
}

function CustomEmojiPreferenceToggle() {
  const showCustomEmojis = usePreferencesStore((s) => s.showCustomEmojis)
  const setShowCustomEmojis = usePreferencesStore((s) => s.setShowCustomEmojis)

  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
      <div>
        <p className="text-sm font-medium text-foreground">Show Custom Emojis</p>
        <p className="text-xs text-muted-foreground">Render custom emoji images in text and reactions.</p>
      </div>
      <ToggleSwitch checked={showCustomEmojis} onChange={setShowCustomEmojis} />
    </div>
  )
}

function ImageRenderLimitSettings() {
  const [limits, setLimits] = useState(() => ({
    profile: getRenderLimit('profile'),
    banner: getRenderLimit('banner'),
    chat: getRenderLimit('chat'),
    social: getRenderLimit('social'),
  }))

  const handleChange = (cat: RenderLimitCategory, val: number) => {
    setRenderLimit(cat, val)
    setLimits(prev => ({ ...prev, [cat]: val }))
  }

  const handleReset = () => {
    resetRenderLimits()
    setLimits({
      profile: getRenderLimitDefault('profile'),
      banner: getRenderLimitDefault('banner'),
      chat: getRenderLimitDefault('chat'),
      social: getRenderLimitDefault('social'),
    })
  }

  const isDefault =
    limits.profile === getRenderLimitDefault('profile') &&
    limits.banner === getRenderLimitDefault('banner') &&
    limits.chat === getRenderLimitDefault('chat') &&
    limits.social === getRenderLimitDefault('social')

  const rows: { key: RenderLimitCategory; label: string; desc: string; max: number }[] = [
    { key: 'profile', label: 'Profile Pictures', desc: 'User avatars, hub icons', max: LIMIT_MAX_SLIDER.profile },
    { key: 'banner', label: 'Banners', desc: 'User & hub banners', max: LIMIT_MAX_SLIDER.banner },
    { key: 'chat', label: 'Chat Images', desc: 'Hub chat, DMs, public chat', max: LIMIT_MAX_SLIDER.chat },
    { key: 'social', label: 'Social Images', desc: 'Posts, articles, note cards', max: LIMIT_MAX_SLIDER.social },
  ]

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Image Render Limits</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Images larger than these limits show a placeholder instead of auto-downloading. You can still load them with one click.
          </p>
        </div>
        {!isDefault && (
          <button onClick={handleReset} className="text-[11px] text-primary hover:underline cursor-pointer shrink-0">
            Reset defaults
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {rows.map(({ key, label, desc, max }) => (
          <div key={key} className="px-3 py-2.5 rounded-lg border border-border bg-secondary/30 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="text-[11px] text-muted-foreground">{desc}</p>
              </div>
              <span className="text-sm font-mono font-semibold px-2 py-0.5 rounded bg-secondary text-foreground tabular-nums">
                {limits[key]} MB
              </span>
            </div>
            <div className="flex items-center gap-3 px-1">
              <div className="flex-1 relative h-5 flex items-center">
                <div className="absolute left-0 right-0 h-1.5 rounded-full overflow-hidden">
                  <div className="absolute inset-0 bg-muted-foreground/20" />
                  <div
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-amber-400"
                    style={{ width: `${(limits[key] / max) * 100}%` }}
                  />
                </div>
                <div
                  className="absolute w-4 h-4 rounded-full bg-primary border-2 border-background shadow-lg pointer-events-none transition-all"
                  style={{ left: `calc(${(limits[key] / max) * 100}% - 8px)` }}
                />
                <input
                  type="range"
                  min={1}
                  max={max}
                  step={1}
                  value={limits[key]}
                  onChange={(e) => handleChange(key, Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>
            <div className="flex justify-between text-[9px] text-muted-foreground/60 px-1">
              <span>1 MB</span>
              <span>{max} MB</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function MutedWordsGlobalToggle() {
  const hideMutedWords = usePreferencesStore((s) => s.hideMutedWords)
  const setHideMutedWords = usePreferencesStore((s) => s.setHideMutedWords)
  const wordCount = useBlockStore((s) => s.mutedWords).size

  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
      <div>
        <p className="text-sm font-medium text-foreground">Hide Muted Words</p>
        <p className="text-xs text-muted-foreground">Redact your {wordCount} muted word{wordCount !== 1 ? 's' : ''} in messages across the app.</p>
      </div>
      <ToggleSwitch checked={hideMutedWords} onChange={setHideMutedWords} />
    </div>
  )
}

/* ─────────── Sound Effects ─────────── */

function SoundEffectsSection() {
  const [config, setConfig] = useState(() => getSfxConfig())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [editingSound, setEditingSound] = useState<SfxName | null>(null)

  // Re-read config from module after any change
  const refresh = () => setConfig(getSfxConfig())

  const handleGlobalToggle = (enabled: boolean) => {
    setGlobalSfxEnabled(enabled)
    refresh()
  }

  const handleToggle = (name: SfxName, enabled: boolean) => {
    setSfxEnabled(name, enabled)
    refresh()
  }

  const handleCustomFile = (name: SfxName) => {
    setEditingSound(name)
    fileInputRef.current?.click()
  }

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !editingSound) return
    await setSfxFile(editingSound, file)
    setEditingSound(null)
    refresh()
  }

  const handleReset = async (name: SfxName) => {
    await setSfxFile(name, null)
    refresh()
  }

  const names = getSfxNames()
  const globalOff = !config.globalEnabled

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-foreground uppercase tracking-wider text-muted-foreground">Sound Effects</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Audio feedback for voice channel actions. Customise or disable individual sounds.
          </p>
        </div>
        <ToggleSwitch checked={config.globalEnabled} onChange={handleGlobalToggle} />
      </div>

      <div className={`flex flex-col gap-1.5 transition-opacity ${globalOff ? 'opacity-40 pointer-events-none' : ''}`}>
        {names.map((name) => {
          const effect = config.effects[name]
          const isCustom = hasSfxCustom(name)
          return (
            <div key={name} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-secondary/30">
              {/* Preview button */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => previewSfx(name)}
                    className="w-7 h-7 rounded-md bg-secondary/60 hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
                  >
                    <Volume2 size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Preview sound</TooltipContent>
              </Tooltip>

              {/* Label */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{SFX_LABELS[name]}</p>
                {isCustom && (
                  <p className="text-[10px] text-primary/70">Custom sound</p>
                )}
              </div>

              {/* Change / Reset buttons */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => handleCustomFile(name)}
                    className="px-2 py-1 rounded text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer shrink-0"
                  >
                    Change
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Upload custom sound</TooltipContent>
              </Tooltip>
              {isCustom && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleReset(name)}
                      className="px-2 py-1 rounded text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer shrink-0"
                    >
                      <Undo2 size={12} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Reset to default sound</TooltipContent>
                </Tooltip>
              )}

              {/* Enable/Disable toggle */}
              <ToggleSwitch checked={effect.enabled} onChange={(v) => handleToggle(name, v)} />
            </div>
          )
        })}
      </div>

      {/* Hidden file input for custom sound uploads */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/mpeg,audio/wav,audio/ogg,audio/webm,.mp3,.wav,.ogg,.webm"
        className="hidden"
        onChange={handleFileSelected}
      />
    </section>
  )
}

/* ─────────── Security ─────────── */

/** Security controls for a vault-backed account (export backup + delete from device). */
function VaultSecuritySection({ pubkey, fingerprint }: { pubkey: string; fingerprint: string }) {
  const logout = useUserStore((s) => s.logout)
  const [exportPin, setExportPin] = useState('')
  const [exportErr, setExportErr] = useState('')
  const [exportBusy, setExportBusy] = useState(false)
  const [qrText, setQrText] = useState<string | null>(null)
  const [showDelete, setShowDelete] = useState(false)
  const [deletePin, setDeletePin] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteErr, setDeleteErr] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)

  // Decrypt + re-export the encrypted backup payload (PIN-gated). Shared by file + QR.
  const getPayloadJson = async (): Promise<string | null> => {
    if (!exportPin) { setExportErr('Enter your PIN'); return null }
    setExportBusy(true); setExportErr('')
    try {
      const { payload } = await getVaultClient().exportBackup(pubkey, exportPin)
      return JSON.stringify(payload)
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : 'Wrong PIN')
      return null
    } finally { setExportBusy(false) }
  }

  const handleExport = async () => {
    const json = await getPayloadJson()
    if (!json) return
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `den-backup-${Date.now()}.json`
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
    setExportPin('')
  }

  const handleShowQR = async () => {
    const json = await getPayloadJson()
    if (!json) return
    setQrText(json); setExportPin('')
  }

  const handleDelete = async () => {
    if (!deletePin) { setDeleteErr('Enter your PIN'); return }
    if (deleteConfirm.trim() !== fingerprint) { setDeleteErr(`Type "${fingerprint}" to confirm.`); return }
    setDeleteBusy(true); setDeleteErr('')
    try {
      await getVaultClient().removeAccount(pubkey, deletePin)
      logout()
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : 'Wrong PIN')
      setDeleteBusy(false)
    }
  }

  return (
    <>
      <div className="rounded-xl border border-border bg-secondary/20 p-4 flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <ShieldCheck size={18} className="text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">Vault account</p>
          <p className="text-xs text-muted-foreground mt-0.5">Your key is stored in the isolated DEN vault. Export an encrypted backup, or remove it from this device below.</p>
        </div>
      </div>

      {/* Export encrypted backup (PIN-gated) */}
      <section className="rounded-xl border border-border bg-secondary/10 overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/50 bg-secondary/20">
          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><FileDown size={14} className="text-primary" /></div>
          <h4 className="text-sm font-semibold text-foreground">Export encrypted backup</h4>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground">Re-download your PIN-encrypted backup file, or show it as a QR to transfer to another device. Enter your PIN to confirm.</p>
          <PinInput value={exportPin} onChange={setExportPin} placeholder="PIN" onEnter={handleExport} />
          {exportErr && <p className="text-xs text-destructive">{exportErr}</p>}
          <div className="grid grid-cols-2 gap-2">
            <button onClick={handleExport} disabled={exportBusy} className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5">
              {exportBusy ? <Loader2 size={15} className="animate-spin" /> : <><Download size={15} /> File</>}
            </button>
            <button onClick={handleShowQR} disabled={exportBusy} className="h-9 px-3 rounded-lg border border-border text-sm font-medium hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5">
              <QrCode size={15} /> QR
            </button>
          </div>
        </div>
      </section>

      {/* PIN-gated QR of the encrypted backup */}
      {qrText && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setQrText(null)}>
          <div className="w-full max-w-xs rounded-xl bg-card border border-border shadow-xl p-6 flex flex-col items-center gap-4 text-center" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-foreground">Encrypted backup QR</h3>
            <div className="bg-white p-3 rounded-lg"><QRCodeSVG value={qrText} size={232} level="M" /></div>
            <p className="text-xs text-muted-foreground">Scan this from <span className="font-medium text-foreground">Import → Scan QR</span> on the other device. It's still encrypted — the PIN is required to open it.</p>
            <button onClick={() => setQrText(null)} className="w-full h-9 px-3 rounded-lg border border-border text-sm font-medium hover:bg-secondary transition-colors cursor-pointer">Done</button>
          </div>
        </div>
      )}

      {/* Delete from this device (PIN + fingerprint confirm) */}
      <section className="rounded-xl border border-destructive/30 bg-destructive/5 overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-destructive/20 bg-destructive/10">
          <div className="w-7 h-7 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0"><Trash2 size={14} className="text-destructive" /></div>
          <h4 className="text-sm font-semibold text-destructive">Delete from this device</h4>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground">Removes this account's key from the vault on this device. <span className="text-foreground font-medium">Make sure you have your backup file and PIN</span> — this can't be undone.</p>
          {!showDelete ? (
            <button onClick={() => setShowDelete(true)} className="w-full h-9 px-3 rounded-lg border border-destructive/40 text-destructive text-sm font-medium hover:bg-destructive hover:text-white transition-colors cursor-pointer flex items-center justify-center gap-1.5"><Trash2 size={15} /> Delete account</button>
          ) : (
            <>
              <PinInput value={deletePin} onChange={setDeletePin} placeholder="PIN" />
              <Input placeholder={`Type "${fingerprint}" to confirm`} value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} />
              {deleteErr && <p className="text-xs text-destructive">{deleteErr}</p>}
              <div className="flex gap-2">
                <button onClick={() => { setShowDelete(false); setDeletePin(''); setDeleteConfirm(''); setDeleteErr('') }} className="flex-1 h-9 px-3 rounded-lg border border-border text-sm font-medium hover:bg-secondary transition-colors cursor-pointer">Cancel</button>
                <button onClick={handleDelete} disabled={deleteBusy} className="flex-1 h-9 px-3 rounded-lg bg-destructive text-white text-sm font-medium hover:bg-destructive/90 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">{deleteBusy ? <Loader2 size={15} className="animate-spin" /> : 'Delete'}</button>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  )
}

function SecurityTab() {
  const authMethod = useUserStore((s) => s.authMethod)
  const pubkey = useUserStore((s) => s.pubkey)
  const logout = useUserStore((s) => s.logout)
  const isDesktop = isTauri()

  // PIN entry
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [pinErr, setPinErr] = useState('')
  const [loading, setLoading] = useState(false)

  // Reveal seed
  const [revealedSeed, setRevealedSeed] = useState<string | null>(null)
  const [showSeedWords, setShowSeedWords] = useState(false)

  // Uncensor confirmation + 5s countdown (guards against shoulder-surfing)
  const [showSeedRevealConfirm, setShowSeedRevealConfirm] = useState(false)
  const [seedRevealCountdown, setSeedRevealCountdown] = useState<number | null>(null)
  const seedRevealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [showSeedCopyConfirm, setShowSeedCopyConfirm] = useState(false)

  const startSeedRevealCountdown = () => {
    let remaining = 5
    setSeedRevealCountdown(remaining)
    if (seedRevealTimerRef.current) clearInterval(seedRevealTimerRef.current)
    seedRevealTimerRef.current = setInterval(() => {
      remaining -= 1
      if (remaining <= 0) {
        if (seedRevealTimerRef.current) { clearInterval(seedRevealTimerRef.current); seedRevealTimerRef.current = null }
        setSeedRevealCountdown(null)
        setShowSeedRevealConfirm(false)
        setShowSeedWords(true)
      } else {
        setSeedRevealCountdown(remaining)
      }
    }, 1000)
  }

  const cancelSeedReveal = () => {
    if (seedRevealTimerRef.current) { clearInterval(seedRevealTimerRef.current); seedRevealTimerRef.current = null }
    setSeedRevealCountdown(null)
    setShowSeedRevealConfirm(false)
  }

  // Clear any pending reveal countdown on unmount
  useEffect(() => () => { if (seedRevealTimerRef.current) clearInterval(seedRevealTimerRef.current) }, [])

  // Reveal nsec
  const [revealedNsec, setRevealedNsec] = useState<string | null>(null)

  // Copy
  const [copied, setCopied] = useState(false)

  // Export modal
  const [showExport, setShowExport] = useState(false)
  const [exportPwd, setExportPwd] = useState('')
  const [exportPwdConfirm, setExportPwdConfirm] = useState('')
  const [exportErr, setExportErr] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [showPwdConfirm, setShowPwdConfirm] = useState(false)
  const [exportUsePin, setExportUsePin] = useState(true)
  const [exportPinConfirm, setExportPinConfirm] = useState('')
  const [showExportPin, setShowExportPin] = useState(false)
  const [exportLoading, setExportLoading] = useState(false)

  // Change PIN
  const [showChangePin, setShowChangePin] = useState(false)
  const [currentPin, setCurrentPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [newPinHint, setNewPinHint] = useState('')
  const [changePinErr, setChangePinErr] = useState('')

  // Delete account
  const [showDelete, setShowDelete] = useState(false)
  const [deletePin, setDeletePin] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteErr, setDeleteErr] = useState('')
  const [showSeedWarning, setShowSeedWarning] = useState(false)

  // Seed label renaming
  const [seedInfo, setSeedInfo] = useState<StoredSeed | null>(null)
  const [editingSeedName, setEditingSeedName] = useState(false)
  const [seedNameDraft, setSeedNameDraft] = useState('')
  const [seedNameSaving, setSeedNameSaving] = useState(false)

  const isSeed = authMethod === 'seed'
  const isNsec = authMethod === 'nsec'
  const isVault = authMethod === 'vault'
  const hasLocal = isDesktop && (isSeed || isNsec)

  const npubStr = pubkey ? nip19.npubEncode(pubkey) : ''
  const npubFingerprint = npubStr ? npubStr.slice(-6) : ''

  // Fetch the seed info for the current account so we can show/edit its label
  useEffect(() => {
    if (!isDesktop || !isSeed) return
    listSeeds().then((seeds) => {
      // Find the seed that contains the current pubkey
      const match = seeds.find((s) => s.account_pubkeys.includes(pubkey || ''))
      if (match) setSeedInfo(match)
    }).catch(() => { })
  }, [isDesktop, isSeed, pubkey])

  const handleSaveSeedName = async () => {
    if (!seedInfo || !seedNameDraft.trim()) return
    setSeedNameSaving(true)
    try {
      await renameSeed(seedInfo.id, seedNameDraft.trim())
      setSeedInfo((prev) => prev ? { ...prev, name: seedNameDraft.trim() } : prev)
      setEditingSeedName(false)
    } catch (err) {
      console.error('Failed to rename seed:', err)
    } finally {
      setSeedNameSaving(false)
    }
  }

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // ── Reveal Seed (PIN-gated) ──
  const handleRevealSeed = async () => {
    if (!pubkey || !pin) { setPinErr('Enter your PIN'); return }
    setLoading(true); setPinErr('')
    try {
      const mnemonic = await exportSeed(pubkey, pin)
      setRevealedSeed(mnemonic)
      setPin(''); setShowPin(false)
    } catch (err) {
      setPinErr(err instanceof Error ? err.message : 'Wrong PIN')
    } finally { setLoading(false) }
  }

  // ── Reveal nsec (PIN-gated) ──
  const handleRevealNsec = async () => {
    if (!pubkey || !pin) { setPinErr('Enter your PIN'); return }
    setLoading(true); setPinErr('')
    try {
      const nsec = await exportNsec(pubkey, pin)
      setRevealedNsec(nsec)
      setPin(''); setShowPin(false)
    } catch (err) {
      setPinErr(err instanceof Error ? err.message : 'Wrong PIN')
    } finally { setLoading(false) }
  }

  // ── Export encrypted backup ──
  const handleExportEncrypted = async () => {
    setExportErr('')
    if (!revealedSeed) { setExportErr('Reveal your seed first.'); return }

    let encryptionPassword: string

    if (exportUsePin) {
      // PIN-based: verify the entered PIN against the stored hash first
      if (!exportPinConfirm) { setExportErr('Enter your PIN to confirm.'); return }
      if (!pubkey) { setExportErr('No active account.'); return }
      setExportLoading(true)
      try {
        const valid = await verifyPin(pubkey, exportPinConfirm)
        if (!valid) { setExportErr('Incorrect PIN.'); setExportLoading(false); return }
        encryptionPassword = exportPinConfirm
      } catch {
        setExportErr('PIN verification failed.'); setExportLoading(false); return
      }
    } else {
      // Custom password mode
      if (!exportPwd) { setExportErr('Password is required.'); return }
      if (exportPwd !== exportPwdConfirm) { setExportErr('Passwords do not match.'); return }
      encryptionPassword = exportPwd
      setExportLoading(true)
    }

    try {
      const enc = new TextEncoder()
      const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(encryptionPassword), 'PBKDF2', false, ['deriveKey'])
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
        keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
      )
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(revealedSeed))
      const payload = JSON.stringify({
        version: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: 600000,
        salt: btoa(String.fromCharCode(...salt)),
        iv: btoa(String.fromCharCode(...iv)),
        ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
      })
      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'den-chat-seed-backup.json'
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setShowExport(false); setExportPwd(''); setExportPwdConfirm(''); setExportPinConfirm('')
    } catch (e) { setExportErr(String(e)) }
    finally { setExportLoading(false) }
  }

  // ── Change PIN ──
  const handleChangePin = async () => {
    if (!pubkey) return
    setChangePinErr('')
    if (!currentPin || !newPin) { setChangePinErr('Both fields are required.'); return }
    setLoading(true)
    try {
      await changePin(pubkey, currentPin, newPin, newPinHint || undefined)
      setShowChangePin(false); setCurrentPin(''); setNewPin(''); setNewPinHint('')
    } catch (err) {
      setChangePinErr(err instanceof Error ? err.message : 'PIN change failed')
    } finally { setLoading(false) }
  }

  // ── Delete Account ──
  const isLastSeedAccount = isSeed && seedInfo && seedInfo.account_pubkeys.length === 1

  const handleDeleteAccount = async () => {
    if (!pubkey) return
    setDeleteErr('')
    if (!deletePin) { setDeleteErr('PIN is required.'); return }
    if (deleteConfirm !== npubFingerprint) {
      setDeleteErr('Type "' + npubFingerprint + '" to confirm.'); return
    }
    setLoading(true)
    try {
      // Verify PIN first — don't attempt deletion until we know it's correct
      const valid = await verifyPin(pubkey, deletePin)
      if (!valid) { setDeleteErr('Incorrect PIN'); setLoading(false); return }
      // If this is the last account under a seed, show a warning modal first
      if (isLastSeedAccount && !showSeedWarning) {
        setShowSeedWarning(true)
        setLoading(false)
        return
      }
      // PIN is valid. Store pending deletion in sessionStorage so LoginScreen
      // can perform the actual delete after all subscriptions are torn down.
      sessionStorage.setItem('pending-delete', JSON.stringify({ pubkey, pin: deletePin }))
      logout()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Verification failed'
      setDeleteErr(msg)
      setLoading(false)
    }
  }

  // Called from the seed warning modal — user has already confirmed PIN
  const handleConfirmSeedDeletion = () => {
    if (!pubkey) return
    sessionStorage.setItem('pending-delete', JSON.stringify({ pubkey, pin: deletePin }))
    logout()
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold">Security</h3>
        <p className="text-xs text-muted-foreground mt-1">Manage your keys, PINs, backups, and account deletion.</p>
      </div>

      {!hasLocal && !isVault && (
        <div className="rounded-xl border border-border bg-secondary/20 p-4 flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Shield size={18} className="text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">External Signer Active</p>
            <p className="text-xs text-muted-foreground mt-0.5">No local key material found on this device. Your keys are managed by an external signer.</p>
          </div>
        </div>
      )}

      {isVault && pubkey && <VaultSecuritySection pubkey={pubkey} fingerprint={npubFingerprint} />}

      {/* ── Seed phrase section (PIN-gated reveal) ── */}
      {hasLocal && isSeed && (
        <section className="rounded-xl border border-border bg-secondary/10 overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/50 bg-secondary/20">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Shield size={14} className="text-primary" />
            </div>
            <h4 className="text-sm font-semibold text-foreground">Seed Phrase</h4>
          </div>
          <div className="p-4 space-y-3">

            {!revealedSeed ? (
              <div className="space-y-2">
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30">
                  <AlertTriangle size={14} className="text-destructive shrink-0 mt-0.5" />
                  <p className="text-xs text-destructive">
                    Never share your seed phrase. Anyone with these words can access your keys and funds.
                  </p>
                </div>
                <div className="flex gap-2 items-end">
                  <div className="flex-1 relative">
                    <Input
                      type={showPin ? 'text' : 'password'}
                      placeholder="Enter PIN to reveal"
                      value={pin}
                      onChange={(e) => { setPin(e.target.value); setPinErr('') }}
                      className="h-9 pr-9"
                      onKeyDown={(e) => e.key === 'Enter' && handleRevealSeed()}
                    />
                    <button type="button" onClick={() => setShowPin(!showPin)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      {showPin ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <button onClick={handleRevealSeed} disabled={loading}
                    className="flex items-center gap-2 px-4 h-9 rounded-lg bg-secondary/50 border border-border text-sm hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50">
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />} Reveal
                  </button>
                </div>
                {pinErr && <p className="text-xs text-destructive">{pinErr}</p>}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {revealedSeed.split(' ').map((word, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 bg-secondary/50 rounded-lg border border-border">
                      <span className="text-[10px] text-muted-foreground w-5 text-right">{i + 1}.</span>
                      <span className="font-mono text-sm">{showSeedWords ? word : '••••'}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => {
                    if (showSeedWords) {
                      setShowSeedWords(false)
                    } else {
                      // Uncensoring is gated behind an "are you sure" + countdown
                      setSeedRevealCountdown(null)
                      setShowSeedRevealConfirm(true)
                    }
                  }} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs hover:bg-secondary transition-colors cursor-pointer">
                    {showSeedWords ? <><EyeOff size={14} /> Censor</> : <><Eye size={14} /> Uncensor</>}
                  </button>
                  <button onClick={() => setShowSeedCopyConfirm(true)} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs hover:bg-secondary transition-colors cursor-pointer">
                    {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy</>}
                  </button>
                  <button onClick={() => { setRevealedSeed(null); setShowSeedWords(false) }} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs hover:bg-secondary transition-colors cursor-pointer">
                    <EyeOff size={14} /> Hide
                  </button>
                  <button onClick={() => { setShowExport(true); setExportErr('') }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-xs text-primary hover:bg-primary/20 transition-colors cursor-pointer">
                    <FileDown size={14} /> Export Encrypted Backup
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── nsec section (PIN-gated reveal) ── */}
      {hasLocal && isNsec && (
        <section className="rounded-xl border border-border bg-secondary/10 overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/50 bg-secondary/20">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Shield size={14} className="text-primary" />
            </div>
            <h4 className="text-sm font-semibold text-foreground">Private Key (nsec)</h4>
          </div>
          <div className="p-4 space-y-3">

            {!revealedNsec ? (
              <div className="space-y-2">
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30">
                  <AlertTriangle size={14} className="text-destructive shrink-0 mt-0.5" />
                  <p className="text-xs text-destructive">
                    Never share your private key. Anyone with this key can impersonate you.
                  </p>
                </div>
                <div className="flex gap-2 items-end">
                  <div className="flex-1 relative">
                    <Input
                      type={showPin ? 'text' : 'password'}
                      placeholder="Enter PIN to reveal"
                      value={pin}
                      onChange={(e) => { setPin(e.target.value); setPinErr('') }}
                      className="h-9 pr-9"
                      onKeyDown={(e) => e.key === 'Enter' && handleRevealNsec()}
                    />
                    <button type="button" onClick={() => setShowPin(!showPin)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      {showPin ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <button onClick={handleRevealNsec} disabled={loading}
                    className="flex items-center gap-2 px-4 h-9 rounded-lg bg-secondary/50 border border-border text-sm hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50">
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />} Reveal
                  </button>
                </div>
                {pinErr && <p className="text-xs text-destructive">{pinErr}</p>}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="p-3 bg-secondary/50 rounded-lg border border-border font-mono text-sm break-all">
                  {revealedNsec}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => copyText(revealedNsec)} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs hover:bg-secondary transition-colors cursor-pointer">
                    {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy</>}
                  </button>
                  <button onClick={() => setRevealedNsec(null)} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs hover:bg-secondary transition-colors cursor-pointer">
                    <EyeOff size={14} /> Hide
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Seed Label ── */}
      {hasLocal && isSeed && seedInfo && (
        <section className="rounded-xl border border-border bg-secondary/10 overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/50 bg-secondary/20">
            <div className="w-7 h-7 rounded-lg bg-secondary/50 flex items-center justify-center shrink-0">
              <Tag size={14} />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-foreground">Seed Label</h4>
              <p className="text-[11px] text-muted-foreground">A friendly name stored locally to help you identify this seed.</p>
            </div>
          </div>
          <div className="p-4">
            {!editingSeedName ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground font-medium">{seedInfo.name}</span>
                <button
                  onClick={() => { setEditingSeedName(true); setSeedNameDraft(seedInfo.name) }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary/50 border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
                >
                  <Pencil size={12} /> Edit
                </button>
              </div>
            ) : (
              <div className="flex gap-2 items-center max-w-xs">
                <Input
                  type="text"
                  value={seedNameDraft}
                  onChange={(e) => setSeedNameDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveSeedName()}
                  className="h-9 flex-1"
                  autoFocus
                  placeholder="Seed name"
                />
                <button
                  onClick={handleSaveSeedName}
                  disabled={seedNameSaving || !seedNameDraft.trim()}
                  className="flex items-center gap-1.5 px-3 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {seedNameSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
                </button>
                <button
                  onClick={() => setEditingSeedName(false)}
                  className="flex items-center px-2 h-9 rounded-lg border border-border bg-secondary/50 text-sm hover:bg-secondary transition-colors cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Change PIN ── */}
      {hasLocal && (
        <section className="rounded-xl border border-border bg-secondary/10 overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/50 bg-secondary/20">
            <div className="w-7 h-7 rounded-lg bg-secondary/50 flex items-center justify-center shrink-0">
              <Lock size={14} />
            </div>
            <h4 className="text-sm font-semibold text-foreground">Change PIN</h4>
          </div>
          <div className="p-4">
            {!showChangePin ? (
              <button onClick={() => setShowChangePin(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary/50 border border-border text-sm hover:bg-secondary transition-colors cursor-pointer">
                <Lock size={14} /> Change PIN
              </button>
            ) : (
              <div className="space-y-2 max-w-xs">
                <Input type="password" placeholder="Current PIN" value={currentPin}
                  onChange={(e) => { setCurrentPin(e.target.value); setChangePinErr('') }} className="h-9" />
                <Input type="password" placeholder="New PIN" value={newPin}
                  onChange={(e) => { setNewPin(e.target.value); setChangePinErr('') }} className="h-9" />
                <Input type="text" placeholder="New hint (optional)" value={newPinHint}
                  onChange={(e) => setNewPinHint(e.target.value)} className="h-9" />
                {changePinErr && <p className="text-xs text-destructive">{changePinErr}</p>}
                <div className="flex gap-2">
                  <button onClick={() => { setShowChangePin(false); setCurrentPin(''); setNewPin(''); setNewPinHint('') }}
                    className="flex-1 h-9 rounded-lg border border-border bg-secondary/50 text-sm hover:bg-secondary transition-colors cursor-pointer">Cancel</button>
                  <button onClick={handleChangePin} disabled={loading}
                    className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50">
                    {loading ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Delete Account ── */}
      {hasLocal && (
        <section className="rounded-xl border border-destructive/30 bg-destructive/5 overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-destructive/20 bg-destructive/10">
            <div className="w-7 h-7 rounded-lg bg-destructive/15 flex items-center justify-center shrink-0">
              <Trash2 size={14} className="text-destructive" />
            </div>
            <h4 className="text-sm font-semibold text-destructive">Delete Account</h4>
          </div>
          <div className="p-4">
            {!showDelete ? (
              <button onClick={() => { setShowDelete(true); setDeleteErr(''); setDeletePin(''); setDeleteConfirm('') }}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive hover:bg-destructive/20 transition-colors cursor-pointer">
                <Trash2 size={14} /> Delete from device
              </button>
            ) : (
              <div className="space-y-2 max-w-xs">
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30">
                  <AlertTriangle size={14} className="text-destructive shrink-0 mt-0.5" />
                  <p className="text-xs text-destructive">
                    This permanently removes your account from this device. Make sure you have a backup of your seed phrase or private key.
                  </p>
                </div>
                <Input type="password" placeholder="Enter PIN" value={deletePin}
                  onChange={(e) => { setDeletePin(e.target.value); setDeleteErr('') }} className="h-9" />
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    Type <code className="px-1.5 py-0.5 rounded bg-secondary border border-border text-foreground font-mono text-[11px] select-all">{npubFingerprint}</code> to confirm
                  </label>
                  <Input type="text" placeholder={npubFingerprint} value={deleteConfirm}
                    onChange={(e) => { setDeleteConfirm(e.target.value); setDeleteErr('') }} className="h-9" />
                </div>
                {deleteErr && <p className="text-xs text-destructive">{deleteErr}</p>}
                <div className="flex gap-2">
                  <button onClick={() => setShowDelete(false)}
                    className="flex-1 h-9 rounded-lg border border-border bg-secondary/50 text-sm hover:bg-secondary transition-colors cursor-pointer">Cancel</button>
                  <button onClick={handleDeleteAccount} disabled={loading}
                    className="flex items-center justify-center gap-2 flex-1 h-9 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-colors cursor-pointer disabled:opacity-50">
                    {loading ? <><Loader2 size={14} className="animate-spin" /> Verifying…</> : 'Delete'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Seed Deletion Warning Modal ── */}
      {showSeedWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm">
          <div className="w-[400px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                <AlertTriangle size={20} className="text-destructive" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-destructive">Seed Phrase Will Be Deleted</h4>
                <p className="text-xs text-muted-foreground mt-0.5">
                  This is the only account derived from &ldquo;{seedInfo?.name || 'this seed'}&rdquo;
                </p>
              </div>
            </div>

            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                Deleting this account will also <span className="font-semibold text-destructive">permanently remove the entire seed phrase</span> from this device's secure storage.
              </p>
              <p>
                If you have not backed up your seed phrase, <span className="font-semibold text-foreground">all accounts derived from it will be unrecoverable</span>.
              </p>
            </div>

            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
              <Shield size={14} className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Make sure you have exported or written down your seed phrase before proceeding.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setShowSeedWarning(false)}
                className="px-4 h-9 rounded-lg border border-border bg-secondary/50 text-sm hover:bg-secondary transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSeedDeletion}
                className="flex items-center justify-center gap-2 flex-1 h-9 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-colors cursor-pointer"
              >
                <Trash2 size={14} /> Delete Account & Seed
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Seed uncensor confirmation + countdown */}
      {showSeedRevealConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={seedRevealCountdown === null ? () => setShowSeedRevealConfirm(false) : undefined}
        >
          <div
            className="w-[400px] bg-card border border-border rounded-xl shadow-2xl p-5 flex flex-col items-center gap-4 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            {seedRevealCountdown === null ? (
              <>
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle size={22} className="text-destructive" />
                </div>
                <h4 className="text-base font-bold text-foreground">Reveal your secret keys?</h4>
                <p className="text-xs text-muted-foreground">
                  These 24 words <strong>are</strong> your account. Anyone who sees them — over your shoulder, on a screen share, or in a screenshot — gains <strong className="text-destructive">full and permanent control</strong> of your identity and funds. There is no recovery and no undo.
                </p>
                <p className="text-[11px] text-muted-foreground">Make sure no one is watching your screen and nothing is recording.</p>
                <div className="flex gap-2 w-full pt-1">
                  <button
                    onClick={() => setShowSeedRevealConfirm(false)}
                    className="flex-1 h-9 rounded-lg border border-border bg-secondary/50 text-sm hover:bg-secondary transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={startSeedRevealCountdown}
                    className="flex items-center justify-center gap-2 flex-1 h-9 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-colors cursor-pointer"
                  >
                    <Eye size={14} /> Yes, show
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="relative flex items-center justify-center w-16 h-16">
                  <svg className="animate-spin h-16 w-16 text-destructive/30" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span key={seedRevealCountdown} className="absolute text-2xl font-bold text-foreground tabular-nums animate-in zoom-in-50 fade-in duration-300">
                    {seedRevealCountdown}
                  </span>
                </div>
                <h4 className="text-base font-bold text-foreground">Showing keys in {seedRevealCountdown}…</h4>
                <p className="text-xs text-muted-foreground">Last chance — make sure no one can see your screen.</p>
                <button
                  onClick={cancelSeedReveal}
                  className="flex items-center justify-center gap-2 w-full h-9 rounded-lg border border-border bg-secondary/50 text-sm hover:bg-secondary transition-colors cursor-pointer"
                >
                  <EyeOff size={14} /> Wait, never mind
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Seed copy-to-clipboard confirmation */}
      {showSeedCopyConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setShowSeedCopyConfirm(false)}
        >
          <div
            className="w-[400px] bg-card border border-border rounded-xl shadow-2xl p-5 flex flex-col items-center gap-4 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle size={22} className="text-destructive" />
            </div>
            <h4 className="text-base font-bold text-foreground">Copy seed to clipboard?</h4>
            <p className="text-xs text-muted-foreground">
              Your clipboard can be read by other apps and clipboard-history tools, and may sync across your devices. Only copy if you're pasting it somewhere safe <strong>right now</strong> — and clear your clipboard afterward.
            </p>
            <div className="flex gap-2 w-full pt-1">
              <button
                onClick={() => setShowSeedCopyConfirm(false)}
                className="flex-1 h-9 rounded-lg border border-border bg-secondary/50 text-sm hover:bg-secondary transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => { if (revealedSeed) copyText(revealedSeed); setShowSeedCopyConfirm(false) }}
                className="flex items-center justify-center gap-2 flex-1 h-9 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-colors cursor-pointer"
              >
                <Copy size={14} /> Yes, copy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export encrypted backup modal */}
      {showExport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm">
          <div className="w-[380px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold flex items-center gap-2"><Lock size={16} /> Encrypt Backup</h4>
              <button onClick={() => setShowExport(false)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose a password to encrypt your seed backup. You'll need this password to import it into DEN Chat or the DENOS signer.
            </p>

            {/* Use current PIN toggle */}
            <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-secondary/30">
              <p className="text-xs font-medium text-foreground">Use current PIN</p>
              <ToggleSwitch checked={exportUsePin} onChange={(v) => { setExportUsePin(v); setExportErr(''); setExportPinConfirm(''); setExportPwd(''); setExportPwdConfirm('') }} />
            </div>

            {exportErr && (
              <div className="px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30">
                <p className="text-xs text-destructive">{exportErr}</p>
              </div>
            )}

            {exportUsePin ? (
              /* PIN confirmation mode — single field */
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Confirm your PIN</label>
                <div className="relative">
                  <input type={showExportPin ? 'text' : 'password'} value={exportPinConfirm} onChange={(e) => { setExportPinConfirm(e.target.value); setExportErr('') }} placeholder="Enter PIN"
                    onKeyDown={(e) => e.key === 'Enter' && handleExportEncrypted()}
                    className="w-full h-9 rounded-lg border border-input bg-background px-3 pr-9 text-sm focus:outline-none [&::-ms-reveal]:hidden [&::-webkit-credentials-auto-fill-button]:hidden" />
                  <button type="button" onClick={() => setShowExportPin(!showExportPin)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    {showExportPin ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
            ) : (
              /* Custom password mode — two fields */
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Other PIN</label>
                  <div className="relative">
                    <input type={showPwd ? 'text' : 'password'} value={exportPwd} onChange={(e) => setExportPwd(e.target.value)} placeholder="Enter password"
                      className="w-full h-9 rounded-lg border border-input bg-background px-3 pr-9 text-sm focus:outline-none [&::-ms-reveal]:hidden [&::-webkit-credentials-auto-fill-button]:hidden" />
                    <button type="button" onClick={() => setShowPwd(!showPwd)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      {showPwd ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Confirm other PIN</label>
                  <div className="relative">
                    <input type={showPwdConfirm ? 'text' : 'password'} value={exportPwdConfirm} onChange={(e) => setExportPwdConfirm(e.target.value)} placeholder="Confirm password"
                      onKeyDown={(e) => e.key === 'Enter' && handleExportEncrypted()}
                      className="w-full h-9 rounded-lg border border-input bg-background px-3 pr-9 text-sm focus:outline-none [&::-ms-reveal]:hidden [&::-webkit-credentials-auto-fill-button]:hidden" />
                    <button type="button" onClick={() => setShowPwdConfirm(!showPwdConfirm)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      {showPwdConfirm ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
              </>
            )}
            <div className="flex gap-2 pt-1">
              <button onClick={() => setShowExport(false)} className="flex-1 h-9 rounded-lg border border-border bg-secondary/50 text-sm hover:bg-secondary transition-colors cursor-pointer">
                Cancel
              </button>
              <button onClick={handleExportEncrypted} disabled={exportLoading || (exportUsePin ? !exportPinConfirm : !exportPwd)} className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                {exportLoading ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />} Export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}



/* ─────────── Hide Non-Member Messages Toggle ─────────── */

function HideNonMemberToggle() {
  const hideNonMember = useHubStore((s) => s.hideNonMemberMessages)
  const setHideNonMember = useHubStore((s) => s.setHideNonMemberMessages)

  return (
    <div className="flex items-center justify-between">
      <div>
        <label className="text-sm font-medium text-foreground">Hide non-member messages</label>
        <p className="text-xs text-muted-foreground">Filter out messages from users not in the hub member list. Verified facilitated messages are exempt.</p>
      </div>
      <button
        onClick={() => setHideNonMember(!hideNonMember)}
        className={`relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0
          ${hideNonMember ? 'bg-primary' : 'bg-muted-foreground/30'}`}
      >
        <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform
          ${hideNonMember ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
      </button>
    </div>
  )
}

/* ─────────── My Hubs ─────────── */

const FOLDER_COLORS = [
  '#5865F2', '#57F287', '#FEE75C', '#ED4245', '#EB459E',
  '#9B59B6', '#E67E22', '#1ABC9C', '#3498DB', '#E91E63',
]

type HubSubTab = 'hublist' | 'created'

function MyHubsTab() {
  const [subTab, setSubTab] = useState<HubSubTab>('hublist')
  const hubEntries = useHubStore((s) => s.hubEntries)
  const hubs = useHubStore((s) => s.hubs)
  const hubStatus = useHubStore((s) => s.hubStatus)
  const folders = useHubStore((s) => s.folders)
  const setHubEntries = useHubStore((s) => s.setHubEntries)
  const removeHubEntry = useHubStore((s) => s.removeHubEntry)
  const setHubStatus = useHubStore((s) => s.setHubStatus)
  const hideDeletedHubs = useHubStore((s) => s.hideDeletedHubs)
  const hideNotFoundHubs = useHubStore((s) => s.hideNotFoundHubs)
  const setHideDeletedHubs = useHubStore((s) => s.setHideDeletedHubs)
  const setHideNotFoundHubs = useHubStore((s) => s.setHideNotFoundHubs)
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [removing, setRemoving] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [confirmReDelete, setConfirmReDelete] = useState<string | null>(null)
  const [reDeleting, setReDeleting] = useState<string | null>(null)
  const [hideDeletedInList, setHideDeletedInList] = useState(true)
  const [adding, setAdding] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)

  // DnD state
  const [dragItem, setDragItem] = useState<{ type: 'hub' | 'folder'; id: string } | null>(null)
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null)

  // Folder editing
  const [newFolderName, setNewFolderName] = useState('')
  const [editingFolder, setEditingFolder] = useState<string | null>(null)
  const [editFolderName, setEditFolderName] = useState('')
  const [colorPickerFolder, setColorPickerFolder] = useState<string | null>(null)

  // ── Saved-state snapshot for dirty detection ──
  // Serializes entries + folders into a comparable string (sorted by stable key for order-independence)
  const serialize = useCallback((entries: typeof hubEntries, flds: typeof folders) => {
    const e = [...entries].sort((a, b) => a.dTag.localeCompare(b.dTag)).map(({ dTag, position, folderId }) => `${dTag}:${position}:${folderId || ''}`).join(',')
    const f = [...flds].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, name, color, position }) => `${id}:${name}:${color || ''}:${position}`).join(',')
    return `${e}||${f}`
  }, [])

  // savedSnapshot tracks the last published / loaded state
  const [savedSnapshot, setSavedSnapshot] = useState(() => serialize(hubEntries, folders))
  // Sync saved snapshot when store is externally updated (e.g. on startup load)
  const storeSnapshotRef = useRef(serialize(hubEntries, folders))
  useEffect(() => {
    const current = serialize(hubEntries, folders)
    // Only reset saved snapshot if the store changed externally (not from our local edits)
    if (current !== storeSnapshotRef.current) {
      storeSnapshotRef.current = current
      setSavedSnapshot(current)
    }
  }, [hubEntries, folders, serialize])

  const hasChanges = useMemo(() => serialize(hubEntries, folders) !== savedSnapshot, [hubEntries, folders, savedSnapshot, serialize])

  // Created hubs not in list
  const createdHubsInList = hubEntries.filter((e) => {
    const hub = hubs[e.dTag]
    return hub && hub.creatorPubkey === pubkey
  })
  const createdHubsNotInList = useMemo(() => {
    const inListDTags = new Set(hubEntries.map(e => e.dTag))
    return Object.values(hubs).filter(h => h.creatorPubkey === pubkey && !inListDTags.has(h.dTag))
  }, [hubs, hubEntries, pubkey])

  // ── Publish helper — only called explicitly ──
  const publishHubList = async (entries: typeof hubEntries, flds: typeof folders) => {
    const ev = createHubListEvent(
      entries.map(e => ({ dTag: e.dTag, relayHint: e.relayHint, position: e.position, folderId: e.folderId })),
      flds,
    )
    const signed = await signWithSigner(ev, signer, privateKey)
    await publishToSpecificRelays(getPublishRelays(), signed)
  }

  // ── Local-only update (no publish) ──
  const updateLocal = (entries: typeof hubEntries, flds: typeof folders) => {
    setHubEntries(entries, flds)
    storeSnapshotRef.current = serialize(entries, flds)
  }

  // ── Publish Changes ──
  const handlePublish = async () => {
    setPublishing(true)
    try {
      await publishHubList(hubEntries, folders)
      const snap = serialize(hubEntries, folders)
      setSavedSnapshot(snap)
      storeSnapshotRef.current = snap
    } catch (err) {
      console.error('Failed to publish hub list:', err)
    } finally {
      setPublishing(false)
    }
  }

  // Track saved state with refs for discard
  const savedEntriesRef = useRef(hubEntries)
  const savedFoldersRef = useRef(folders)
  // Keep refs in sync with snapshot resets
  useEffect(() => {
    if (!hasChanges) {
      savedEntriesRef.current = hubEntries
      savedFoldersRef.current = folders
    }
  }, [hasChanges, hubEntries, folders])

  const discardChanges = () => {
    setHubEntries(savedEntriesRef.current, savedFoldersRef.current)
    const snap = serialize(savedEntriesRef.current, savedFoldersRef.current)
    storeSnapshotRef.current = snap
  }

  // ── Hub removal (local only — user must publish) ──
  const handleRemoveFromList = (dTag: string) => {
    const remaining = hubEntries.filter((e) => e.dTag !== dTag)
    removeHubEntry(dTag)
    // Clean up in-memory messages, reactions, and unread counts for this hub
    useMessageStore.getState().clearHubData(dTag)
    storeSnapshotRef.current = serialize(remaining, folders)
    setConfirmRemove(null)
  }

  // ── Add created hub back to list (local only — user must publish) ──
  const handleAddToList = (dTag: string) => {
    if (hubEntries.length >= MAX_HUB_LIST_ENTRIES) return
    const hub = hubs[dTag]
    if (!hub) return
    const relayHint = hub.generalRelays[0] || ''
    const newEntry = { dTag, relayHint, position: hubEntries.length, folderId: undefined }
    const newEntries = [...hubEntries, newEntry]
    updateLocal(newEntries, folders)
  }

  // ── Re-publish deletion (this IS an immediate publish — it's a separate event type) ──
  const handleRePublishDelete = async (dTag: string) => {
    const hub = hubs[dTag]
    if (!hub) return
    setReDeleting(dTag)
    try {
      const deleteEvent = createUnsignedEvent(5, 'Hub deletion requested', [
        ['a', `36942:${hub.creatorPubkey}:${hub.dTag}`],
      ] as [string, ...string[]][])
      const signedDelete = await signWithSigner(deleteEvent, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(), signedDelete)

      const deleteCreatedAt = hub.eventCreatedAt ? hub.eventCreatedAt + 1 : undefined
      const deletedHubEvent = createUnsignedEvent(KINDS.HUB_EVENT, '', [
        ['d', hub.dTag],
        ['n', hub.name],
        ['epoch', hub.epoch.toString()],
        ['deleted', 'true'],
      ] as [string, ...string[]][], deleteCreatedAt)
      const signedDeletedHub = await signWithSigner(deletedHubEvent, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(), signedDeletedHub)

      setHubStatus(dTag, 'deleted')
    } catch (err) {
      console.error('Failed to re-publish delete request:', err)
    } finally {
      setReDeleting(null)
      setConfirmReDelete(null)
    }
  }

  // ── DnD handlers (local-only mutations) ──
  const onHubDragStart = (e: React.DragEvent, dTag: string) => {
    setDragItem({ type: 'hub', id: dTag })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', dTag)
  }
  const onHubDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (dragItem?.type === 'hub' && dragItem.id !== targetId) setDragOverTarget(targetId)
  }
  const onHubDrop = (e: React.DragEvent, targetDTag: string, targetFolderId: string | undefined) => {
    e.preventDefault(); e.stopPropagation(); setDragOverTarget(null)
    if (!dragItem || dragItem.type !== 'hub') return
    const copy = [...hubEntries]
    const fromIdx = copy.findIndex(e => e.dTag === dragItem.id)
    const toIdx = copy.findIndex(e => e.dTag === targetDTag)
    if (fromIdx < 0 || toIdx < 0) return
    const [moved] = copy.splice(fromIdx, 1)
    moved.folderId = targetFolderId
    copy.splice(toIdx, 0, moved)
    const updated = copy.map((e, i) => ({ ...e, position: i }))
    updateLocal(updated, folders)
    setDragItem(null)
  }
  const onFolderHeaderHubDrop = (e: React.DragEvent, folderId: string | undefined) => {
    e.preventDefault(); setDragOverTarget(null)
    if (!dragItem || dragItem.type !== 'hub') return
    const updated = hubEntries.map(e =>
      e.dTag === dragItem.id ? { ...e, folderId } : e
    )
    updateLocal(updated, folders)
    setDragItem(null)
  }
  const onFolderDragStart = (e: React.DragEvent, folderId: string) => {
    setDragItem({ type: 'folder', id: folderId })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', folderId)
  }
  const onFolderDragOver = (e: React.DragEvent, folderId: string) => {
    e.preventDefault()
    if (dragItem?.type === 'folder' && dragItem.id !== folderId) setDragOverTarget(folderId)
  }
  const onFolderDrop = (e: React.DragEvent, targetFolderId: string) => {
    e.preventDefault(); setDragOverTarget(null)
    if (!dragItem || dragItem.type !== 'folder') return
    const copy = [...folders]
    const fromIdx = copy.findIndex(f => f.id === dragItem.id)
    const toIdx = copy.findIndex(f => f.id === targetFolderId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return
    const [moved] = copy.splice(fromIdx, 1)
    copy.splice(toIdx, 0, moved)
    const updated = copy.map((f, i) => ({ ...f, position: i }))
    updateLocal(hubEntries, updated)
    setDragItem(null)
  }
  const onDragEnd = () => { setDragItem(null); setDragOverTarget(null) }

  // ── Folder management (local-only) ──
  const addFolder = () => {
    if (folders.length >= MAX_HUB_FOLDERS) return
    const name = newFolderName.trim().slice(0, FOLDER_NAME_MAX)
    if (!name) return
    const newFolder: HubFolder = { id: crypto.randomUUID(), name, position: folders.length, color: FOLDER_COLORS[folders.length % FOLDER_COLORS.length] }
    const newFolders = [...folders, newFolder]
    updateLocal(hubEntries, newFolders)
    setNewFolderName('')
  }
  const deleteFolder = (folderId: string) => {
    const newFolders = folders.filter(f => f.id !== folderId).map((f, i) => ({ ...f, position: i }))
    const updatedEntries = hubEntries.map(e => e.folderId === folderId ? { ...e, folderId: undefined } : e)
    updateLocal(updatedEntries, newFolders)
  }
  const renameFolder = (folderId: string) => {
    const name = editFolderName.trim().slice(0, FOLDER_NAME_MAX)
    if (!name) return
    const newFolders = folders.map(f => f.id === folderId ? { ...f, name } : f)
    updateLocal(hubEntries, newFolders)
    setEditingFolder(null)
  }
  const setFolderColor = (folderId: string, color: string) => {
    const newFolders = folders.map(f => f.id === folderId ? { ...f, color } : f)
    updateLocal(hubEntries, newFolders)
    setColorPickerFolder(null)
  }

  // ── Hub list item renderer ──
  const renderHubItem = (entry: typeof hubEntries[0], folderId?: string) => {
    const hub = hubs[entry.dTag]
    const status = hubStatus[entry.dTag]
    const isNotFound = status === 'not-found'
    const isRemoving = removing === entry.dTag

    return (
      <div
        key={entry.dTag}
        draggable
        onDragStart={(e) => onHubDragStart(e, entry.dTag)}
        onDragOver={(e) => onHubDragOver(e, entry.dTag)}
        onDrop={(e) => onHubDrop(e, entry.dTag, folderId)}
        onDragEnd={onDragEnd}
        className={`flex items-center gap-3 rounded-lg border p-3 cursor-grab active:cursor-grabbing transition-colors ${dragOverTarget === entry.dTag ? 'ring-2 ring-primary/50 border-primary/40' : 'border-border'
          }`}
      >
        <GripVertical size={14} className="text-muted-foreground/40 shrink-0" />
        {/* Hub icon */}
        <div className="relative w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0 overflow-hidden">
          {hub?.icon ? (
            <BlossomImage src={hub.icon} alt={hub.name} className="w-full h-full object-cover" fallback={
              <span className="text-xs font-semibold text-muted-foreground">{(hub?.name ?? entry.dTag).slice(0, 2).toUpperCase()}</span>
            } />
          ) : (
            <span className="text-xs font-semibold text-muted-foreground">
              {(hub?.name ?? entry.dTag).slice(0, 2).toUpperCase()}
            </span>
          )}
          {status === 'not-found' && (
            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-amber-500 flex items-center justify-center">
              <HelpCircle size={10} className="text-white" />
            </div>
          )}
          {status === 'deleted' && (
            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-destructive flex items-center justify-center">
              <XCircle size={10} className="text-white" />
            </div>
          )}
        </div>

        {/* Hub info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{hub?.name ?? entry.dTag.slice(0, 12)}</p>
          {isNotFound && <p className="text-xs text-amber-500">Hub not found on relays</p>}
          {status === 'deleted' && <p className="text-xs text-destructive">Hub has been deleted</p>}
          {hub && hub.creatorPubkey === pubkey && <p className="text-[10px] text-primary/60">Created by you</p>}
        </div>

        {/* Remove button */}
        {confirmRemove === entry.dTag ? (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => handleRemoveFromList(entry.dTag)}
              disabled={isRemoving}
              className="text-xs text-destructive hover:text-destructive/80 font-medium cursor-pointer"
            >
              {isRemoving ? 'Removing...' : 'Confirm'}
            </button>
            <button
              onClick={() => setConfirmRemove(null)}
              className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              if (isNotFound) {
                setConfirmRemove(entry.dTag)
              } else {
                handleRemoveFromList(entry.dTag)
              }
            }}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    )
  }

  // Sorted data
  const topLevelHubs = hubEntries.filter(e => !e.folderId).sort((a, b) => a.position - b.position)
  const sortedFolders = [...folders].sort((a, b) => a.position - b.position)

  return (
    <div className="flex flex-col gap-4">
      {/* ── Publish Changes bar ── */}
      {hasChanges && (
        <div className="flex items-center justify-between rounded-lg border border-primary/40 bg-primary/5 p-3 animate-in slide-in-from-top-2">
          <p className="text-sm text-foreground font-medium">You have unsaved changes</p>
          <div className="flex items-center gap-2">
            <button
              onClick={discardChanges}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground bg-secondary hover:bg-accent transition-colors cursor-pointer"
            >
              <Undo2 size={12} /> Discard
            </button>
            <button
              onClick={handlePublish}
              disabled={publishing}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
            >
              {publishing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {publishing ? 'Publishing...' : 'Publish Changes'}
            </button>
          </div>
        </div>
      )}
      {/* Message visibility */}
      <div className="rounded-lg border border-border p-4 space-y-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Message Visibility</p>
        <HideNonMemberToggle />
      </div>
      {/* Sidebar visibility toggles */}
      <div className="rounded-lg border border-border p-4 space-y-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Sidebar Visibility</p>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Hide deleted hubs</label>
            <p className="text-xs text-muted-foreground">Remove deleted hubs from the sidebar</p>
          </div>
          <button
            onClick={() => setHideDeletedHubs(!hideDeletedHubs)}
            className={`relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0
              ${hideDeletedHubs ? 'bg-primary' : 'bg-muted-foreground/30'}`}
          >
            <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform
              ${hideDeletedHubs ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">Hide not-found hubs</label>
            <p className="text-xs text-muted-foreground">Remove hubs that couldn't be found on relays</p>
          </div>
          <button
            onClick={() => setHideNotFoundHubs(!hideNotFoundHubs)}
            className={`relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0
              ${hideNotFoundHubs ? 'bg-primary' : 'bg-muted-foreground/30'}`}
          >
            <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform
              ${hideNotFoundHubs ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
        <button
          onClick={() => setSubTab('hublist')}
          className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer
            ${subTab === 'hublist' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Hub List ({hubEntries.length}/{MAX_HUB_LIST_ENTRIES})
        </button>
        <button
          onClick={() => setSubTab('created')}
          className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer
            ${subTab === 'created' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Created Hubs ({createdHubsInList.length + createdHubsNotInList.length})
        </button>
      </div>

      {/* ── Hub List tab ── */}
      {subTab === 'hublist' && (
        <div className="flex flex-col gap-3">
          {hubEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Your hub list is empty. Create or join a hub to get started.</p>
          ) : (
            <>
              {/* Top-level (unfiled) hubs */}
              <div
                className={`rounded-lg p-2 transition-colors ${topLevelHubs.length === 0
                  ? `border border-dashed ${dragOverTarget === '__toplevel' ? 'border-primary/60 bg-primary/5' : 'border-border/60'}`
                  : `rounded-md ${dragOverTarget === '__toplevel' ? 'ring-2 ring-primary/30' : ''}`
                  }`}
                onDragOver={(e) => { e.preventDefault(); if (dragItem?.type === 'hub') setDragOverTarget('__toplevel') }}
                onDrop={(e) => onFolderHeaderHubDrop(e, undefined)}
                onDragLeave={() => setDragOverTarget(null)}
              >
                {topLevelHubs.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {topLevelHubs.map(entry => renderHubItem(entry, undefined))}
                  </div>
                ) : sortedFolders.length > 0 ? (
                  <p className="text-[10px] text-muted-foreground/50 text-center py-2">
                    {dragOverTarget === '__toplevel' ? 'Drop here to ungroup' : 'Ungrouped hubs appear here — drag hubs out of folders to ungroup'}
                  </p>
                ) : null}
              </div>

              {/* Folders */}
              {sortedFolders.map((folder) => {
                const folderHubs = hubEntries.filter(e => e.folderId === folder.id).sort((a, b) => a.position - b.position)
                const isDragTarget = dragOverTarget === folder.id

                return (
                  <div key={folder.id} onDragEnd={onDragEnd}>
                    {isDragTarget && dragItem?.type === 'folder' && <div className="h-0.5 bg-primary rounded-full mx-2 mb-1" />}
                    <div className={`rounded-lg border transition-colors ${isDragTarget ? 'border-primary/70 bg-primary/5' : 'border-border'}`}>
                      {/* Folder header */}
                      <div
                        draggable
                        onDragStart={(e) => onFolderDragStart(e, folder.id)}
                        onDragOver={(e) => {
                          e.preventDefault(); e.stopPropagation()
                          if (dragItem?.type === 'folder' && dragItem.id !== folder.id) setDragOverTarget(folder.id)
                          if (dragItem?.type === 'hub') setDragOverTarget(folder.id)
                        }}
                        onDrop={(e) => {
                          e.stopPropagation()
                          if (dragItem?.type === 'folder') onFolderDrop(e, folder.id)
                          if (dragItem?.type === 'hub') onFolderHeaderHubDrop(e, folder.id)
                        }}
                        onDragLeave={(e) => { e.stopPropagation(); setDragOverTarget(null) }}
                        className="flex items-center gap-2 px-3 py-2 cursor-grab active:cursor-grabbing bg-secondary/50 rounded-t-lg group"
                      >
                        <GripVertical size={12} className="text-muted-foreground/50 shrink-0" />
                        <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: folder.color || '#5865F2' }} />
                        {editingFolder === folder.id ? (
                          <input
                            autoFocus
                            value={editFolderName}
                            onChange={(e) => setEditFolderName(e.target.value.slice(0, FOLDER_NAME_MAX))}
                            maxLength={FOLDER_NAME_MAX}
                            onKeyDown={(e) => { if (e.key === 'Enter') renameFolder(folder.id); if (e.key === 'Escape') setEditingFolder(null) }}
                            onBlur={() => renameFolder(folder.id)}
                            className="text-xs font-semibold uppercase tracking-wide text-foreground bg-transparent outline-none flex-1 border-b border-primary"
                          />
                        ) : (
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex-1">{folder.name}</span>
                        )}
                        <span className="text-[10px] text-muted-foreground/50">{folderHubs.length}</span>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <TooltipProvider delayDuration={300}>
                            {/* Color picker */}
                            <div className="relative">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setColorPickerFolder(colorPickerFolder === folder.id ? null : folder.id) }}
                                    className="p-0.5 rounded text-muted-foreground hover:text-foreground cursor-pointer"
                                  >
                                    <Palette size={12} />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">Change color</TooltipContent>
                              </Tooltip>
                              {colorPickerFolder === folder.id && (
                                <div className="absolute right-0 top-6 z-20 bg-popover border border-border rounded-lg p-2 shadow-lg flex gap-1 flex-wrap w-[140px]" onClick={(e) => e.stopPropagation()}>
                                  {FOLDER_COLORS.map(c => (
                                    <button
                                      key={c}
                                      onClick={() => setFolderColor(folder.id, c)}
                                      className="w-5 h-5 rounded-full cursor-pointer hover:scale-110 transition-transform border border-border/50"
                                      style={{ backgroundColor: c }}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => { setEditingFolder(folder.id); setEditFolderName(folder.name) }}
                                  className="p-0.5 rounded text-muted-foreground hover:text-foreground cursor-pointer"
                                ><Pencil size={12} /></button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">Rename</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => deleteFolder(folder.id)}
                                  className="p-0.5 rounded text-muted-foreground hover:text-destructive cursor-pointer"
                                ><Trash2 size={12} /></button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">Delete folder</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      </div>
                      {/* Folder contents */}
                      <div
                        className="px-2 py-1.5 flex flex-col gap-1.5 min-h-[32px]"
                        onDragOver={(e) => {
                          e.preventDefault(); e.stopPropagation()
                          if (dragItem?.type === 'hub') setDragOverTarget(folder.id)
                        }}
                        onDrop={(e) => {
                          e.stopPropagation()
                          onFolderHeaderHubDrop(e, folder.id)
                        }}
                        onDragLeave={(e) => { e.stopPropagation(); setDragOverTarget(null) }}
                      >
                        {folderHubs.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground/50 text-center py-2">
                            {dragOverTarget === folder.id && dragItem?.type === 'hub' ? 'Drop here' : 'Drag hubs here'}
                          </p>
                        ) : (
                          folderHubs.map(entry => renderHubItem(entry, folder.id))
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {/* Create folder */}
          {/* Folder counter */}
          <div className="flex items-center justify-between mt-2 mb-1">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <FolderPlus size={13} />
              Folders
            </span>
            <span className={`text-[11px] font-mono tabular-nums select-none transition-colors ${folders.length >= MAX_HUB_FOLDERS ? 'text-amber-400' : 'text-muted-foreground/60'}`}>
              {folders.length}/{MAX_HUB_FOLDERS}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <input
                placeholder={folders.length >= MAX_HUB_FOLDERS ? 'Folder limit reached' : 'New folder name...'}
                className="w-full h-7 rounded-md border border-input bg-background px-2 pr-12 text-xs placeholder:text-muted-foreground focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value.slice(0, FOLDER_NAME_MAX))}
                maxLength={FOLDER_NAME_MAX}
                onKeyDown={(e) => e.key === 'Enter' && addFolder()}
                disabled={folders.length >= MAX_HUB_FOLDERS}
              />
              {newFolderName.length > 0 && (
                <span className={`absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono tabular-nums select-none ${newFolderName.length >= FOLDER_NAME_MAX ? 'text-amber-400' : 'text-muted-foreground/50'}`}>
                  {newFolderName.length}/{FOLDER_NAME_MAX}
                </span>
              )}
            </div>
            <button
              onClick={addFolder}
              disabled={!newFolderName.trim() || folders.length >= MAX_HUB_FOLDERS}
              className="h-7 px-3 rounded-md bg-secondary text-xs text-foreground hover:bg-accent transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>

          {hubEntries.some((e) => hubStatus[e.dTag] === 'not-found') && (
            <p className="text-xs text-muted-foreground mt-1">
              <AlertTriangle size={11} className="inline mr-1 text-amber-500" />
              Hubs marked with <strong>?</strong> couldn't be found on relays. We can't verify if you created them — removing is irreversible.
            </p>
          )}
        </div>
      )}

      {/* ── Created Hubs tab ── */}
      {subTab === 'created' && (
        <div className="flex flex-col gap-2">
          {/* Hide deleted toggle */}
          <div className="flex items-center justify-between px-1 py-1">
            <span className="text-xs text-muted-foreground">Hide deleted hubs</span>
            <button
              onClick={() => setHideDeletedInList(!hideDeletedInList)}
              className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer
                ${hideDeletedInList ? 'bg-primary' : 'bg-muted-foreground/30'}`}
            >
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
                ${hideDeletedInList ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
            </button>
          </div>

          {/* Hubs in list */}
          {(() => {
            const allCreated = [...createdHubsInList.map(e => ({ ...e, inList: true })), ...createdHubsNotInList.map(h => ({ dTag: h.dTag, relayHint: h.generalRelays[0] || '', position: 0, inList: false }))]
            const visible = hideDeletedInList
              ? allCreated.filter((e) => hubStatus[e.dTag] !== 'deleted')
              : allCreated
            return visible.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {allCreated.length > 0 ? 'All created hubs are deleted.' : "You haven't created any hubs yet."}
              </p>
            ) : (
              visible.map((entry) => {
                const hub = hubs[entry.dTag]
                if (!hub) return null
                const status = hubStatus[entry.dTag]
                const isDeleted = status === 'deleted'
                const isReDeleting = reDeleting === entry.dTag
                const inList = 'inList' in entry ? (entry as any).inList : true
                const isAdding = adding === entry.dTag

                return (
                  <div key={entry.dTag} className={`flex items-center gap-3 rounded-lg border p-3 ${isDeleted ? 'border-destructive/30 bg-destructive/5' : !inList ? 'border-dashed border-muted-foreground/30' : 'border-border'}`}>
                    {/* Hub icon */}
                    <div className="relative w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0 overflow-hidden">
                      {hub.icon ? (
                        <BlossomImage src={hub.icon} alt={hub.name} className="w-full h-full object-cover" fallback={
                          <span className="text-xs font-semibold text-muted-foreground">{hub.name.slice(0, 2).toUpperCase()}</span>
                        } />
                      ) : (
                        <span className="text-xs font-semibold text-muted-foreground">
                          {hub.name.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                      {isDeleted && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-destructive flex items-center justify-center">
                          <XCircle size={10} className="text-white" />
                        </div>
                      )}
                    </div>

                    {/* Hub info */}
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium truncate ${isDeleted ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{hub.name}</p>
                      {isDeleted && <p className="text-xs text-destructive">Marked as deleted</p>}
                      {!inList && !isDeleted && <p className="text-xs text-muted-foreground">Not in your hub list</p>}
                    </div>

                    {/* Actions */}
                    {!inList && !isDeleted && (
                      <button
                        onClick={() => handleAddToList(entry.dTag)}
                        disabled={isAdding || hubEntries.length >= MAX_HUB_LIST_ENTRIES}
                        className="flex items-center gap-1 text-xs text-primary font-medium hover:text-primary/80 transition-colors cursor-pointer px-3 py-1.5 rounded-md bg-primary/10 hover:bg-primary/20 border border-primary/30 disabled:opacity-50"
                      >
                        {isAdding ? <Loader2 size={12} className="animate-spin" /> : <ListPlus size={12} />}
                        {hubEntries.length >= MAX_HUB_LIST_ENTRIES ? 'Hub limit reached' : isAdding ? 'Adding...' : 'Add to Hub List'}
                      </button>
                    )}
                    {isDeleted && (
                      confirmReDelete === entry.dTag ? (
                        <div className="flex flex-col items-end gap-1">
                          <p className="text-xs text-muted-foreground max-w-[200px] text-right">
                            Re-publish a deletion request? Relay behavior is not guaranteed.
                          </p>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => handleRePublishDelete(entry.dTag)}
                              disabled={isReDeleting}
                              className="text-xs text-destructive hover:text-destructive/80 font-medium cursor-pointer"
                            >
                              {isReDeleting ? 'Publishing...' : 'Re-publish'}
                            </button>
                            <button
                              onClick={() => setConfirmReDelete(null)}
                              className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmReDelete(entry.dTag)}
                          className="text-xs text-destructive font-medium hover:text-white transition-colors cursor-pointer px-3 py-1.5 rounded-md bg-destructive/20 hover:bg-destructive border border-destructive/40"
                        >
                          Re-publish Delete
                        </button>
                      )
                    )}
                  </div>
                )
              })
            )
          })()}
        </div>
      )}
    </div>
  )
}

/* ─────────── Keybinds ─────────── */

/** Convert KeyboardEvent.code to a human-readable label */
function formatKeyCode(code: string): string {
  if (!code) return ''
  return code
    .replace('Key', '')
    .replace('Digit', '')
    .replace('ShiftLeft', 'Left Shift')
    .replace('ShiftRight', 'Right Shift')
    .replace('ControlLeft', 'Left Ctrl')
    .replace('ControlRight', 'Right Ctrl')
    .replace('AltLeft', 'Left Alt')
    .replace('AltRight', 'Right Alt')
    .replace('Backquote', '`')
    .replace('BracketLeft', '[')
    .replace('BracketRight', ']')
    .replace('Backslash', '\\')
    .replace('Semicolon', ';')
    .replace('Quote', "'")
    .replace('Comma', ',')
    .replace('Period', '.')
    .replace('Slash', '/')
    .replace('Minus', '-')
    .replace('Equal', '=')
    .replace('ArrowUp', 'Up')
    .replace('ArrowDown', 'Down')
    .replace('ArrowLeft', 'Left')
    .replace('ArrowRight', 'Right')
    .replace('NumpadAdd', 'Num +')
    .replace('NumpadSubtract', 'Num -')
    .replace('NumpadMultiply', 'Num *')
    .replace('NumpadDivide', 'Num /')
    .replace('NumpadDecimal', 'Num .')
    .replace('NumpadEnter', 'Num Enter')
    .replace(/^Numpad(\d)$/, 'Num $1')
}

const KEYBINDS_KEY = 'den-chat-keybinds'

interface KeybindSettings {
  pushToTalk: string
  muteToggle: string
  deafenToggle: string
}

const KEYBIND_DEFAULTS: KeybindSettings = {
  pushToTalk: '',
  muteToggle: '',
  deafenToggle: '',
}

function loadKeybinds(): KeybindSettings {
  try {
    const raw = localStorage.getItem(KEYBINDS_KEY)
    if (raw) return { ...KEYBIND_DEFAULTS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...KEYBIND_DEFAULTS }
}

function saveKeybinds(kb: KeybindSettings) {
  localStorage.setItem(KEYBINDS_KEY, JSON.stringify(kb))
}

interface KeybindRowProps {
  label: string
  description: string
  value: string
  capturing: boolean
  onCapture: () => void
  onClear: () => void
}

function KeybindRow({ label, description, value, capturing, onCapture, onClear }: KeybindRowProps) {
  return (
    <div className="flex items-center justify-between py-3 px-1">
      <div className="flex-1 min-w-0 mr-4">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">
        {value && !capturing ? (
          /* Split button: [key label | X] */
          <div className="flex items-stretch rounded-lg border border-border overflow-hidden">
            <button
              onClick={onCapture}
              className="px-4 py-2 text-sm text-foreground bg-secondary/30 hover:bg-secondary/60 transition-colors cursor-pointer min-w-[110px] text-center"
            >
              {formatKeyCode(value)}
            </button>
            <button
              onClick={onClear}
              className="px-2.5 flex items-center justify-center border-l border-border bg-secondary/30 hover:bg-destructive hover:text-white text-muted-foreground transition-colors cursor-pointer"
              title="Clear keybind"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          /* Single button (capturing or no value) */
          <button
            onClick={onCapture}
            className={`px-4 py-2 rounded-lg border text-sm transition-all cursor-pointer min-w-[140px] text-center
              ${capturing
                ? 'border-primary bg-primary/10 text-primary animate-pulse font-medium'
                : 'border-border/50 bg-secondary/20 text-muted-foreground hover:bg-secondary/40 hover:text-foreground'
              }`}
          >
            {capturing ? 'Press any key...' : 'Not set'}
          </button>
        )}
      </div>
    </div>
  )
}

function KeybindsTab() {
  const [keybinds, setKeybinds] = useState(loadKeybinds)
  // Which keybind action is currently being captured (null = none)
  const [capturingAction, setCapturingAction] = useState<keyof KeybindSettings | null>(null)

  // Sync PTT from voice settings on mount (voice settings is the source of truth for PTT)
  useEffect(() => {
    try {
      const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
      if (vs.pushToTalkKey) {
        setKeybinds((prev) => {
          if (prev.pushToTalk !== vs.pushToTalkKey) {
            const next = { ...prev, pushToTalk: vs.pushToTalkKey }
            saveKeybinds(next)
            return next
          }
          return prev
        })
      }
    } catch { /* ignore */ }
  }, [])

  // Capture listener
  useEffect(() => {
    if (!capturingAction) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const code = e.code
      setKeybinds((prev) => {
        const next = { ...prev, [capturingAction]: code }
        saveKeybinds(next)

        // If PTT was changed, also update voice settings to stay in sync
        if (capturingAction === 'pushToTalk') {
          try {
            const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
            vs.pushToTalkKey = code
            localStorage.setItem('den-chat-voice-settings', JSON.stringify(vs))
          } catch { /* ignore */ }
        }

        return next
      })
      setCapturingAction(null)
    }
    // Escape cancels capture
    const escHandler = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setCapturingAction(null)
      }
    }
    window.addEventListener('keydown', escHandler, true)
    // Small delay so the click event doesn't immediately trigger
    const timer = setTimeout(() => {
      window.addEventListener('keydown', handler, true)
    }, 50)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', handler, true)
      window.removeEventListener('keydown', escHandler, true)
    }
  }, [capturingAction])

  const updateKeybind = (action: keyof KeybindSettings, value: string) => {
    setKeybinds((prev) => {
      const next = { ...prev, [action]: value }
      saveKeybinds(next)

      // Sync PTT to voice settings
      if (action === 'pushToTalk') {
        try {
          const vs = JSON.parse(localStorage.getItem('den-chat-voice-settings') || '{}')
          vs.pushToTalkKey = value
          localStorage.setItem('den-chat-voice-settings', JSON.stringify(vs))
        } catch { /* ignore */ }
      }

      return next
    })
  }

  const voiceCallBinds: { action: keyof KeybindSettings; label: string; desc: string }[] = [
    { action: 'pushToTalk', label: 'Push to Talk', desc: 'Hold to transmit while in a voice channel' },
    { action: 'muteToggle', label: 'Toggle Mute', desc: 'Mute or unmute your microphone' },
    { action: 'deafenToggle', label: 'Toggle Deafen', desc: 'Deafen or undeafen all audio' },
  ]

  return (
    <div className="space-y-6">
      {/* Voice Call */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Mic size={16} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Voice Call</h3>
        </div>
        <div className="divide-y divide-border/50">
          {voiceCallBinds.map((bind) => (
            <KeybindRow
              key={bind.action}
              label={bind.label}
              description={bind.desc}
              value={keybinds[bind.action]}
              capturing={capturingAction === bind.action}
              onCapture={() => setCapturingAction(bind.action)}
              onClear={() => updateKeybind(bind.action, '')}
            />
          ))}
        </div>
      </div>

      {/* Other */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Keyboard size={16} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Other</h3>
        </div>
        <p className="text-xs text-muted-foreground py-4 px-1">No keybinds available yet.</p>
      </div>

      {/* Tip */}
      <p className="text-xs text-muted-foreground/60 pt-2">
        Press Escape while capturing to cancel. Click the X on a keybind to clear it.
      </p>
    </div>
  )
}

/* ─────────── Game Chat ─────────── */

function GameChatTab() {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-muted/50 border border-border/50">
        <Gamepad2 size={28} className="text-muted-foreground" />
      </div>
      <div className="text-center space-y-2">
        <h3 className="text-lg font-semibold text-foreground">Game Chat</h3>
        <p className="text-sm text-muted-foreground">Coming soon</p>
      </div>
      <p className="text-sm text-muted-foreground/70 text-center max-w-md leading-relaxed mt-2">
        Chat with players from your online games and matches without invasive moderation or the fear of unreasonable bans, kicks, or suspensions. A freer game chat experience, built outside the game, for your game.
      </p>
    </div>
  )
}

/* ─── Verified Download Button ─── */

type DownloadState =
  | { status: 'idle' }
  | { status: 'downloading'; progress: DownloadProgress }
  | { status: 'verifying' }
  | { status: 'complete' }
  | { status: 'hash_mismatch'; data: Uint8Array; expectedHash: string; actualHash: string; serverUrl: string }
  | { status: 'failed'; error: string }

function formatDlSpeed(bps: number) {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

function formatDlSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function triggerFileSave(data: Uint8Array, filename: string, mimeType: string = 'application/octet-stream') {
  const blob = new Blob([data.slice() as Uint8Array<ArrayBuffer>], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function VerifiedDownloadButton({ url, label, filename, icon, fileExt }: {
  url: string
  label: string
  filename: string
  icon: React.ReactNode
  fileExt?: string
}) {
  const [state, setState] = useState<DownloadState>({ status: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  // Determine file extension: prefer explicit fileExt, then try URL, then .bin
  const urlFilename = url.split('/').pop() || ''
  const urlExt = urlFilename.includes('.') ? '.' + urlFilename.split('.').pop() : ''
  const ext = fileExt ? (fileExt.startsWith('.') ? fileExt : '.' + fileExt) : urlExt || '.bin'
  const fullFilename = filename + ext

  // Check if this is a blossom URL (hash as last segment)
  const isBlossom = /\/[a-f0-9]{64}$/i.test(new URL(url, 'https://x').pathname)

  const startDownload = async (targetUrl?: string, skipServers?: string[]) => {
    const downloadUrl = targetUrl || url

    // Non-blossom URLs (GitHub, external links) — open directly instead of fetch+verify
    if (!isBlossom) {
      if ('__TAURI__' in window) {
        import('@tauri-apps/plugin-opener').then(({ openUrl }) => {
          openUrl(downloadUrl).catch(() => window.open(downloadUrl, '_blank', 'noopener,noreferrer'))
        })
      } else {
        window.open(downloadUrl, '_blank', 'noopener,noreferrer')
      }
      return
    }

    abortRef.current = new AbortController()
    setState({ status: 'downloading', progress: { serverUrl: downloadUrl, percent: 0, speed: 0, loaded: 0, total: 0 } })

    try {
      const result = await downloadFromBlossomWithProgress(
        downloadUrl,
        (progress) => setState({ status: 'downloading', progress }),
        abortRef.current.signal,
        skipServers,
      )

      // Verification phase
      setState({ status: 'verifying' })

      if (!result.verified && result.hash && isBlossom) {
        // Hash mismatch
        const pathParts = new URL(downloadUrl, 'https://x').pathname.split('/').filter(Boolean)
        const expectedHash = pathParts[pathParts.length - 1]?.toLowerCase() || ''
        setState({
          status: 'hash_mismatch',
          data: result.data,
          expectedHash,
          actualHash: result.hash,
          serverUrl: result.serverUrl,
        })
        return
      }

      // Success — save file
      triggerFileSave(result.data, fullFilename)
      setState({ status: 'complete' })
      setTimeout(() => setState({ status: 'idle' }), 3000)
    } catch (err) {
      if (abortRef.current?.signal.aborted) {
        setState({ status: 'idle' })
      } else {
        setState({ status: 'failed', error: err instanceof Error ? err.message : 'Download failed' })
      }
    }
  }

  const handleDownloadAnyway = () => {
    if (state.status !== 'hash_mismatch') return
    triggerFileSave(state.data, fullFilename)
    setState({ status: 'complete' })
    setTimeout(() => setState({ status: 'idle' }), 3000)
  }

  const handleTryDifferentSource = () => {
    if (state.status !== 'hash_mismatch') return
    const failedOrigin = new URL(state.serverUrl, 'https://x').origin
    startDownload(url, [failedOrigin])
  }

  const handleCancel = () => {
    abortRef.current?.abort()
    setState({ status: 'idle' })
  }

  // Idle state — clickable button
  if (state.status === 'idle') {
    return (
      <button
        onClick={() => startDownload()}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/40 border border-border hover:bg-secondary/60 transition-colors group cursor-pointer w-full text-left"
      >
        {icon}
        <span className="text-sm text-foreground font-medium">{label}</span>
        <span className="text-xs text-muted-foreground truncate flex-1 text-right group-hover:text-foreground/60 transition-colors">{urlFilename || 'download'}</span>
      </button>
    )
  }

  // Downloading state — progress bar
  if (state.status === 'downloading') {
    const { progress } = state
    return (
      <div className="rounded-lg bg-secondary/40 border border-border px-3 py-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="text-primary animate-spin shrink-0" />
          <span className="text-sm text-foreground font-medium flex-1">{label}</span>
          <button onClick={handleCancel} className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer">
            <X size={14} />
          </button>
        </div>
        <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all duration-150" style={{ width: `${progress.percent}%` }} />
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="truncate">{progress.total > 0 ? `${formatDlSize(progress.loaded)} / ${formatDlSize(progress.total)}` : 'Connecting...'}</span>
          <span>{progress.speed > 0 ? formatDlSpeed(progress.speed) : ''} {progress.percent > 0 ? `${progress.percent}%` : ''}</span>
        </div>
      </div>
    )
  }

  // Verifying state
  if (state.status === 'verifying') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/40 border border-border">
        <Loader2 size={14} className="text-primary animate-spin shrink-0" />
        <span className="text-sm text-foreground font-medium">{label}</span>
        <span className="text-xs text-muted-foreground flex-1 text-right">Verifying integrity...</span>
      </div>
    )
  }

  // Complete state
  if (state.status === 'complete') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
        <Check size={14} className="text-emerald-400 shrink-0" />
        <span className="text-sm text-emerald-400 font-medium">{label}</span>
        <span className="text-xs text-emerald-400/70 flex-1 text-right">Downloaded & verified ✓</span>
      </div>
    )
  }

  // Hash mismatch state
  if (state.status === 'hash_mismatch') {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-400 shrink-0" />
          <span className="text-sm text-amber-400 font-medium">Hash Mismatch</span>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          The downloaded file&apos;s SHA-256 hash doesn&apos;t match the expected hash. The file may have been modified or corrupted.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDownloadAnyway}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-[11px] font-medium text-amber-400 hover:bg-amber-500/20 transition-colors cursor-pointer"
          >
            Download Anyway
          </button>
          <button
            onClick={handleTryDifferentSource}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-border bg-secondary/40 text-[11px] font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
          >
            <RotateCcw size={11} /> Try Different Source
          </button>
          <button
            onClick={() => setState({ status: 'idle' })}
            className="text-muted-foreground hover:text-foreground text-[11px] cursor-pointer ml-auto transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // Failed state
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <XCircle size={14} className="text-destructive shrink-0" />
        <span className="text-sm text-destructive font-medium">{label}</span>
        <span className="text-xs text-destructive/70 truncate flex-1 text-right">{state.error}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => startDownload()}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-border bg-secondary/40 text-[11px] font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
        >
          <RotateCcw size={11} /> Retry
        </button>
        <button
          onClick={() => setState({ status: 'idle' })}
          className="text-muted-foreground hover:text-foreground text-[11px] cursor-pointer transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

/* ─────────── Updates ─────────── */

interface BuildEvent {
  id: string
  version: string
  body: string
  sourceUrl: string
  sourceExt: string
  platforms: { platform: string; url: string; ext: string }[]
  published_at: number
  created_at: number
}

function UpdateBanner() {
  const version = useUpdateStore((s) => s.availableVersion)
  const notes = useUpdateStore((s) => s.releaseNotes)
  const matched = useUpdateStore((s) => s.matchedPlatform)
  const allPlatforms = useUpdateStore((s) => s.allPlatforms)
  const showAll = useUpdateStore((s) => s.showAllPlatforms)
  const status = useUpdateStore((s) => s.downloadStatus)
  const progress = useUpdateStore((s) => s.downloadProgress)
  const speed = useUpdateStore((s) => s.downloadSpeed)
  const downloadedBytes = useUpdateStore((s) => s.downloadedBytes)
  const totalBytes = useUpdateStore((s) => s.totalBytes)
  const error = useUpdateStore((s) => s.error)

  if (!version) return null

  const os = detectOS()
  const isWindows = os === 'windows'
  const activePlatform = showAll ? null : matched

  const handleDownload = (platform: { url: string; ext: string; hash?: string }) => {
    startUpdateDownload(platform.url, platform.ext, platform.hash)
  }

  const formatSpeed = (bps: number) => {
    if (bps < 1024) return `${Math.round(bps)} B/s`
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3 mb-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
          <ArrowUp size={16} className="text-primary" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">Update Available — v{version}</p>
          <p className="text-xs text-muted-foreground">You&apos;re on v{__APP_VERSION__}</p>
        </div>
      </div>

      {/* Release notes preview */}
      {notes && (
        <div className="prose prose-sm prose-invert max-w-none text-muted-foreground text-xs leading-relaxed max-h-32 overflow-y-auto [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_a]:text-primary [&_p]:my-1 [&_h1]:text-sm [&_h1]:font-bold [&_h1]:text-foreground [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-foreground">
          <Markdown remarkPlugins={[remarkGfm]}>{notes}</Markdown>
        </div>
      )}

      {/* Download / Install section */}
      {status === 'idle' && (
        <div className="space-y-2">
          {activePlatform ? (
            /* Auto-detected platform — single prominent button */
            <div className="space-y-1.5">
              <button
                onClick={() => handleDownload(activePlatform)}
                className="flex items-center gap-2 w-full px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer justify-center"
              >
                <Download size={14} />
                {isWindows ? 'Download & Install' : 'Download & Save'}
                <span className="text-xs opacity-70 ml-1">({activePlatform.platform})</span>
              </button>
              <button
                onClick={() => useUpdateStore.getState().setShowAllPlatforms(true)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer w-full text-center"
              >
                Not your OS? Show all platforms
              </button>
            </div>
          ) : (
            /* All platforms list */
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">Select your platform:</p>
              {allPlatforms.map((p, i) => (
                <button
                  key={i}
                  onClick={() => handleDownload(p)}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-secondary/40 border border-border hover:bg-secondary/60 transition-colors cursor-pointer text-left text-sm text-foreground"
                >
                  <Download size={14} className="text-primary shrink-0" />
                  <span className="font-medium">{p.platform}</span>
                  <span className="text-xs text-muted-foreground flex-1 text-right">{p.ext || ''}</span>
                </button>
              ))}
              {matched && (
                <button
                  onClick={() => useUpdateStore.getState().setShowAllPlatforms(false)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer w-full text-center"
                >
                  Auto-detect my platform
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Downloading */}
      {status === 'downloading' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="text-primary animate-spin shrink-0" />
            <span className="text-sm text-foreground font-medium flex-1">Downloading update...</span>
            <button
              onClick={() => useUpdateStore.getState().setFailed('Cancelled')}
              className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
          <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{totalBytes > 0 ? `${formatSize(downloadedBytes)} / ${formatSize(totalBytes)}` : 'Connecting...'}</span>
            <span>{speed > 0 ? formatSpeed(speed) : ''} {progress > 0 ? `${progress}%` : ''}</span>
          </div>
        </div>
      )}

      {/* Ready to install */}
      {status === 'ready' && (
        <div className="space-y-2">
          {isWindows ? (
            <button
              onClick={() => startUpdateInstall()}
              className="flex items-center gap-2 w-full px-4 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors cursor-pointer justify-center"
            >
              <Sparkles size={14} />
              Install Now — Restarts DEN Chat
            </button>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
              <Check size={14} className="text-emerald-400 shrink-0" />
              <span className="text-sm text-emerald-400 font-medium">Downloaded! Open the file from your Downloads folder to install.</span>
            </div>
          )}
        </div>
      )}

      {/* Installing */}
      {status === 'installing' && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-primary/10 border border-primary/30">
          <Loader2 size={14} className="text-primary animate-spin shrink-0" />
          <span className="text-sm text-foreground font-medium">Installing update... DEN Chat will restart.</span>
        </div>
      )}

      {/* Failed */}
      {status === 'failed' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-destructive/30 bg-destructive/5">
            <XCircle size={14} className="text-destructive shrink-0" />
            <span className="text-sm text-destructive font-medium flex-1">{error || 'Update failed'}</span>
          </div>
          <button
            onClick={() => useUpdateStore.getState().reset()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
          >
            <RotateCcw size={12} /> Try Again
          </button>
        </div>
      )}
    </div>
  )
}

function DnnTab() {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
        <Activity size={28} className="text-primary" />
      </div>
      <h2 className="text-lg font-semibold text-foreground mb-2">Decentralized Node Network</h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        Coming soon. DNN settings and node management will be available here in a future update.
      </p>
    </div>
  )
}

function UpdatesTab() {
  const [builds, setBuilds] = useState<BuildEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  const fetchBuilds = useCallback(() => {
    setLoading(true)
    setError(false)
    fetchEvents({ authors: [ADMIN_PUBKEY], kinds: [30078] }).then((events) => {
      const parsed: BuildEvent[] = []
      for (const ev of events) {
        const dTag = ev.tags.find((t) => t[0] === 'd')?.[1]
        if (!dTag || !dTag.startsWith(BUILD_DTAG_PREFIX)) continue
        try {
          const data = JSON.parse(ev.content)
          // Skip deleted builds
          if (data.deleted) continue
          if (ev.tags.some((t) => t[0] === 'deleted')) continue
          if (data.version) {
            parsed.push({
              id: ev.id,
              version: data.version,
              body: data.body || '',
              sourceUrl: data.sourceUrl || '',
              sourceExt: data.sourceExt || '',
              platforms: Array.isArray(data.platforms) ? data.platforms.map((p: Record<string, string>) => ({ platform: p.platform || '', url: p.url || '', ext: p.ext || '' })) : [],
              published_at: data.published_at || ev.created_at,
              created_at: ev.created_at,
            })
          }
        } catch { /* ignore */ }
      }
      // Sort by published_at (stable original publish date), newest first
      parsed.sort((a, b) => b.published_at - a.published_at)
      setBuilds(parsed)
    }).catch(() => setError(true)).finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchBuilds() }, [fetchBuilds])

  const toggle = (idx: number) => setOpenIdx(openIdx === idx ? null : idx)

  if (loading) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-4">Updates <span className="text-xs font-normal text-muted-foreground ml-1.5">v{__APP_VERSION__}</span></h3>
        <UpdateBanner />
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border border-border bg-secondary/20 animate-pulse">
              <div className="px-4 py-3"><div className="h-4 w-1/2 rounded bg-muted-foreground/15" /></div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-4">Updates <span className="text-xs font-normal text-muted-foreground ml-1.5">v{__APP_VERSION__}</span></h3>
        <UpdateBanner />
        <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
          <p className="text-sm">Failed to load updates.</p>
          <button onClick={fetchBuilds} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer">
            <RotateCcw size={14} /> Try Again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Updates <span className="text-xs font-normal text-muted-foreground ml-1.5">v{__APP_VERSION__}</span></h3>
      <UpdateBanner />
      {builds.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No builds published yet.</p>
      ) : (
        <div className="space-y-2">
          {builds.map((build, idx) => {
            const isOpen = openIdx === idx
            const date = new Date(build.published_at * 1000)
            return (
              <div key={build.id} className="rounded-lg border border-border overflow-hidden bg-secondary/20">
                <button onClick={() => toggle(idx)} className="flex items-center justify-between w-full px-4 py-3 text-left cursor-pointer hover:bg-secondary/40 transition-colors">
                  <div className="flex items-center gap-3 pr-4">
                    <span className="text-sm font-semibold text-foreground">{build.version}</span>
                    <span className="text-xs text-muted-foreground">{date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                  </div>
                  <svg className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {isOpen && (
                  <div className="px-4 py-4 space-y-3">
                    {build.body && (
                      <div className="prose prose-sm prose-invert max-w-none text-muted-foreground [&_strong]:text-foreground [&_code]:bg-secondary/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_a]:text-primary [&_a]:underline [&_p]:my-2 [&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-foreground [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:mb-1 [&_h4]:text-sm [&_h4]:font-medium [&_h4]:text-foreground [&_h4]:mb-1 [&_hr]:border-border [&_hr]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground/80">
                        <Markdown remarkPlugins={[remarkGfm]}>{build.body}</Markdown>
                      </div>
                    )}
                    {(build.platforms.length > 0 || build.sourceUrl) && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-foreground">Downloads</p>
                        {build.platforms.map((p, pi) => (
                          <VerifiedDownloadButton
                            key={pi}
                            url={p.url}
                            label={p.platform}
                            filename={`DEN-Chat-${build.version}-${p.platform.replace(/\s+/g, '-')}`}
                            icon={<Download size={14} className="text-primary shrink-0" />}
                            fileExt={p.ext}
                          />
                        ))}
                        {build.sourceUrl && (
                          <VerifiedDownloadButton
                            url={build.sourceUrl}
                            label="Source Code"
                            filename={`DEN-Chat-${build.version}-source`}
                            icon={<FileDown size={14} className="text-muted-foreground shrink-0" />}
                            fileExt={build.sourceExt}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ─────────── FAQ ─────────── */

const FAQ_DTAG = 'den-chat-faq'
const BUILD_DTAG_PREFIX = 'den-chat-build-'

interface DynamicFaqItem {
  title: string
  body: string // markdown
}

function FaqTab() {
  const prefill = useNavigationStore((s) => s.settingsSearchPrefill)
  const [search, setSearch] = useState(prefill || '')
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [items, setItems] = useState<DynamicFaqItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const fetchFaq = useCallback(() => {
    setLoading(true)
    setError(false)
    fetchReplaceable(ADMIN_PUBKEY, 30078, FAQ_DTAG).then((event) => {
      if (event && event.content) {
        try {
          const arr = JSON.parse(event.content)
          if (Array.isArray(arr)) {
            setItems(arr.filter((item: Record<string, unknown>) => item.title && item.body))
          }
        } catch { setError(true) }
      } else {
        setItems([])
      }
    }).catch(() => setError(true)).finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchFaq() }, [fetchFaq])

  // Consume and clear prefill on mount
  useEffect(() => {
    if (prefill) {
      setSearch(prefill)
      useNavigationStore.getState().setSettingsSearchPrefill(null)
    }
  }, [prefill])

  const filtered = useMemo(() => {
    if (!search.trim()) return items
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter((item) => {
      const haystack = `${item.title} ${item.body}`.toLowerCase()
      return words.every((w) => haystack.includes(w))
    })
  }, [search, items])

  useEffect(() => {
    if (filtered.length === 1) {
      setOpenIdx(items.indexOf(filtered[0]))
    }
  }, [filtered, items])

  const toggle = (idx: number) => setOpenIdx(openIdx === idx ? null : idx)

  if (loading) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-4">Facts & Questions</h3>
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-lg border border-border bg-secondary/20 animate-pulse">
              <div className="px-4 py-3"><div className="h-4 w-2/3 rounded bg-muted-foreground/15" /></div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-4">Facts & Questions</h3>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <p className="text-sm text-muted-foreground">Failed to fetch FAQ content.</p>
          <button onClick={fetchFaq} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
            <RefreshCw size={14} /> Try Again
          </button>
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-4">Facts & Questions</h3>
        <p className="text-sm text-muted-foreground text-center py-16">No FAQ content available yet.</p>
      </div>
    )
  }

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Facts & Questions</h3>
      <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-secondary/50 border border-border mb-4">
        <Search size={16} className="text-muted-foreground shrink-0" />
        <input
          type="text"
          placeholder="Search questions..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpenIdx(null) }}
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none rounded-sm px-1 py-1"
        />
        {search && (
          <button onClick={() => { setSearch(''); setOpenIdx(null) }} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No matching questions found.</p>
        ) : (
          filtered.map((item, fi) => {
            const realIdx = items.indexOf(item)
            const isOpen = openIdx === realIdx
            return (
              <div key={fi} className="rounded-lg border border-border overflow-hidden bg-secondary/20">
                <button onClick={() => toggle(realIdx)} className="flex items-center justify-between w-full px-4 py-3 text-left cursor-pointer hover:bg-secondary/40 transition-colors">
                  <span className="text-sm font-medium text-foreground pr-4">{item.title}</span>
                  <svg className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 pt-1 prose prose-sm prose-invert max-w-none text-muted-foreground [&_strong]:text-foreground [&_code]:bg-secondary/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono [&_table]:text-xs [&_table]:my-1 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:text-foreground [&_td]:px-3 [&_td]:py-1.5 [&_thead]:bg-secondary/40 [&_thead]:border-b [&_thead]:border-border [&_tbody_tr]:border-b [&_tbody_tr]:border-border [&_table]:w-full [&_table]:border [&_table]:border-border [&_table]:rounded-lg [&_blockquote]:border-l-2 [&_blockquote]:border-amber-500/50 [&_blockquote]:pl-3 [&_blockquote]:text-amber-400 [&_blockquote]:not-italic [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-2">
                    <Markdown remarkPlugins={[remarkGfm]}>{item.body}</Markdown>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

const GUIDES_DTAG = 'den-chat-guides'

/** Resolved guide from a kind:30023 event */
interface ResolvedGuide {
  /** a-tag coordinate: "30023:<pubkey>:<dTag>" */
  coordinate: string
  title: string
  summary: string
  imageUrl: string
  videoUrl: string
  content: string
  publishedAt: number
}

/** Featured media for a guide — video > image with 15s fallback */
function GuideMedia({ videoUrl, imageUrl }: { videoUrl?: string; imageUrl?: string }) {
  const [videoFailed, setVideoFailed] = useState(false)
  const videoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const blossom = useBlossomMedia(videoUrl && !videoFailed ? videoUrl : '')
  const [videoLoaded, setVideoLoaded] = useState(false)

  // 15s timeout for video loading
  useEffect(() => {
    if (!videoUrl || videoFailed) return
    videoTimerRef.current = setTimeout(() => {
      if (!videoLoaded) setVideoFailed(true)
    }, 15_000)
    return () => { if (videoTimerRef.current) clearTimeout(videoTimerRef.current) }
  }, [videoUrl, videoFailed, videoLoaded])

  const handleVideoLoaded = () => {
    setVideoLoaded(true)
    if (videoTimerRef.current) clearTimeout(videoTimerRef.current)
  }

  // Show video if we have a video URL and it hasn't failed
  if (videoUrl && !videoFailed) {
    const resolvedSrc = blossom.src || videoUrl
    const isLoading = blossom.loading || !videoLoaded

    if (blossom.error === 'not-found') {
      // Video not found on any server — fall through to image
      if (imageUrl) {
        return (
          <div className="relative rounded-lg overflow-hidden border border-border mt-3" style={{ maxHeight: 400 }}>
            <BlossomImage src={imageUrl} alt="Guide" className="w-full h-full" imgClassName="object-cover" />
          </div>
        )
      }
      return null
    }

    return (
      <div className="relative mt-3">
        {!blossom.loading && resolvedSrc && (
          <video
            ref={videoRef}
            src={resolvedSrc}
            controls
            preload="none"
            className="rounded-lg w-full"
            style={{ maxHeight: 500 }}
            onLoadedData={handleVideoLoaded}
            onError={() => setVideoFailed(true)}
          />
        )}
      </div>
    )
  }

  // Fallback to image
  if (imageUrl) {
    return (
      <div className="relative rounded-lg overflow-hidden border border-border mt-3" style={{ maxHeight: 400 }}>
        <BlossomImage src={imageUrl} alt="Guide" className="w-full h-full" imgClassName="object-cover" />
      </div>
    )
  }

  return null
}

function GuidesTab() {
  const prefill = useNavigationStore((s) => s.settingsSearchPrefill)
  const [search, setSearch] = useState(prefill || '')
  const [activeGuide, setActiveGuide] = useState<ResolvedGuide | null>(null)
  const [guides, setGuides] = useState<ResolvedGuide[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const fetchGuides = useCallback(() => {
    setLoading(true)
    setError(false)
    fetchReplaceable(ADMIN_PUBKEY, 30078, GUIDES_DTAG).then(async (event) => {
      if (!event || !event.content) {
        setGuides([])
        setLoading(false)
        return
      }
      try {
        const coordinates: string[] = JSON.parse(event.content)
        if (!Array.isArray(coordinates) || coordinates.length === 0) {
          setGuides([])
          setLoading(false)
          return
        }

        // Parse a-tag coordinates and batch-fetch the kind:30023 events
        const filters = coordinates.map((coord) => {
          const parts = coord.split(':')
          // "30023:<pubkey>:<dTag>"
          if (parts.length >= 3) {
            return { kinds: [parseInt(parts[0])], authors: [parts[1]], '#d': [parts.slice(2).join(':')] }
          }
          return null
        }).filter(Boolean) as { kinds: number[]; authors: string[]; '#d': string[] }[]

        // Fetch all referenced events in parallel
        const results = await Promise.allSettled(
          filters.map((f) => fetchEvents(f))
        )

        const resolved: ResolvedGuide[] = []
        for (let i = 0; i < results.length; i++) {
          const result = results[i]
          if (result.status !== 'fulfilled' || result.value.length === 0) continue
          // Take the latest event (replaceable)
          const ev = result.value.sort((a, b) => b.created_at - a.created_at)[0]
          const getTag = (name: string) => ev.tags.find((t) => t[0] === name)?.[1] || ''
          resolved.push({
            coordinate: coordinates[i],
            title: getTag('title'),
            summary: getTag('summary'),
            imageUrl: getTag('image'),
            videoUrl: getTag('video'),
            content: ev.content,
            publishedAt: parseInt(getTag('published_at')) || ev.created_at,
          })
        }

        // Preserve the order from the NIP-78 a-tag list
        const ordered = coordinates
          .map((coord) => resolved.find((g) => g.coordinate === coord))
          .filter(Boolean) as ResolvedGuide[]

        setGuides(ordered)
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    }).catch(() => { setError(true); setLoading(false) })
  }, [])

  useEffect(() => { fetchGuides() }, [fetchGuides])

  // Consume and clear prefill on mount
  useEffect(() => {
    if (prefill) {
      setSearch(prefill)
      useNavigationStore.getState().setSettingsSearchPrefill(null)
    }
  }, [prefill])

  const filtered = useMemo(() => {
    if (!search.trim()) return guides
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    return guides.filter((g) => {
      const haystack = `${g.title} ${g.summary} ${g.content}`.toLowerCase()
      return words.every((w) => haystack.includes(w))
    })
  }, [search, guides])

  if (loading) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-1">Guides</h3>
        <p className="text-xs text-muted-foreground mb-4">Video walkthroughs and tutorials to help you get the most out of DEN Chat.</p>
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border border-border bg-secondary/20 animate-pulse">
              <div className="px-4 py-3"><div className="h-4 w-2/3 rounded bg-muted-foreground/15" /></div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-1">Guides</h3>
        <p className="text-xs text-muted-foreground mb-4">Video walkthroughs and tutorials to help you get the most out of DEN Chat.</p>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <p className="text-sm text-muted-foreground">Failed to fetch guides.</p>
          <button onClick={fetchGuides} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
            <RefreshCw size={14} /> Try Again
          </button>
        </div>
      </div>
    )
  }

  if (guides.length === 0) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-1">Guides</h3>
        <p className="text-xs text-muted-foreground mb-4">Video walkthroughs and tutorials to help you get the most out of DEN Chat.</p>
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <BookOpen size={32} className="opacity-30" />
          <p className="text-sm">No guides available yet.</p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h3 className="text-lg font-semibold mb-1">Guides</h3>
      <p className="text-xs text-muted-foreground mb-4">Video walkthroughs and tutorials to help you get the most out of DEN Chat.</p>

      {/* Search */}
      {(guides.length > 1 || search) && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-secondary/50 border border-border mb-4">
          <Search size={16} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search guides..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none rounded-sm px-1 py-1"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {/* Guide cards */}
      <div className="space-y-1.5">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No matching guides found.</p>
        ) : (
          filtered.map((guide) => (
            <button
              key={guide.coordinate}
              onClick={() => setActiveGuide(guide)}
              className="flex items-center gap-3 w-full px-4 py-3 rounded-lg border border-border bg-secondary/20 hover:bg-secondary/40 transition-colors cursor-pointer text-left group"
            >
              <BookOpen size={16} className="text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-foreground block truncate">{guide.title || 'Untitled Guide'}</span>
                {guide.summary && <span className="text-[11px] text-muted-foreground mt-0.5 block truncate">{guide.summary}</span>}
              </div>
              <ChevronRight size={14} className="text-muted-foreground shrink-0 group-hover:text-foreground transition-colors" />
            </button>
          ))
        )}
      </div>

      {/* Guide reader modal */}
      {activeGuide && (
        <GuideReaderModal guide={activeGuide} onClose={() => setActiveGuide(null)} />
      )}
    </div>
  )
}

/* ── Guide Reader Modal ─────────────────────────────────────── */

/** Code block with a header (language label + Copy button) and bottom spacing.
 *  Mirrors ArticleCodeBlock in the social long-form reader. */
function GuideCodeBlock({ children, language }: { children: ReactNode; language?: string }) {
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  const handleCopy = () => {
    const text = preRef.current?.textContent || ''
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between px-3 py-1.5 rounded-t-lg bg-secondary/60 border border-border border-b-0">
        <span className="text-[10px] text-muted-foreground/60 font-mono">{language || ''}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre ref={preRef} className="rounded-b-lg rounded-t-none bg-secondary/80 border border-border p-4 overflow-x-auto text-xs !mt-0">
        {children}
      </pre>
    </div>
  )
}

function GuideReaderModal({ guide, onClose }: { guide: ResolvedGuide; onClose: () => void }) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-[760px] max-h-[90vh] mx-4 rounded-xl border border-border bg-background shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-foreground truncate pr-4">{guide.title || 'Untitled Guide'}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <article className="w-full mx-auto py-6 px-6 max-[640px]:px-4" style={{ maxWidth: 680 }}>
            {/* Featured media */}
            {(guide.videoUrl || guide.imageUrl) && (
              <GuideMedia videoUrl={guide.videoUrl || undefined} imageUrl={guide.imageUrl || undefined} />
            )}

            {/* Summary */}
            {guide.summary && (
              <div className="mb-5 mt-4 px-4 py-3 rounded-r-lg bg-secondary/40 border-l-3 border-primary/40">
                <p className="text-sm text-foreground/80 italic leading-relaxed">{guide.summary}</p>
              </div>
            )}

            {/* Markdown body */}
            {guide.content && (
              <div className="prose prose-sm dark:prose-invert max-w-none article-body">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    img: ({ src, alt }) => {
                      if (!src) return null
                      return (
                        <span className="block relative my-4 rounded-lg overflow-hidden border border-border/50">
                          <BlossomImage src={src} alt={alt || ''} className="w-full rounded-lg" />
                        </span>
                      )
                    },
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {children}
                      </a>
                    ),
                    pre: ({ node, children }) => {
                      // Extract the language from the code child in the AST
                      const codeNode = (node?.children as any[])?.find((c: any) => c.tagName === 'code')
                      const langClass = codeNode?.properties?.className?.[0] || ''
                      const language = langClass.replace('language-', '')
                      return <GuideCodeBlock language={language}>{children}</GuideCodeBlock>
                    },
                    code: ({ children, className }) => {
                      const isInline = !className
                      if (isInline) {
                        return <code className="px-1.5 py-0.5 rounded bg-secondary text-primary text-[12px] font-mono">{children}</code>
                      }
                      return <code className={`text-[12px] font-mono ${className || ''}`}>{children}</code>
                    },
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-3 border-primary/40 pl-4 py-1 text-foreground/70 italic my-4">
                        {children}
                      </blockquote>
                    ),
                    h1: ({ children }) => <h1 className="text-xl font-bold text-foreground mt-8 mb-3">{children}</h1>,
                    h2: ({ children }) => <h2 className="text-lg font-bold text-foreground mt-6 mb-2.5">{children}</h2>,
                    h3: ({ children }) => <h3 className="text-base font-semibold text-foreground mt-5 mb-2">{children}</h3>,
                    h4: ({ children }) => <h4 className="text-sm font-semibold text-foreground mt-4 mb-1.5">{children}</h4>,
                    p: ({ children }) => <p className="text-sm leading-relaxed text-foreground/90 mb-4">{children}</p>,
                    ul: ({ children }) => <ul className="list-disc list-inside text-sm text-foreground/90 mb-4 space-y-1">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal list-inside text-sm text-foreground/90 mb-4 space-y-1">{children}</ol>,
                    table: ({ children }) => (
                      <div className="overflow-x-auto my-4 rounded-lg border border-border">
                        <table className="w-full text-xs">{children}</table>
                      </div>
                    ),
                    th: ({ children }) => <th className="px-3 py-2 bg-secondary text-left text-xs font-semibold text-foreground border-b border-border">{children}</th>,
                    td: ({ children }) => <td className="px-3 py-2 text-xs text-foreground/80 border-b border-border/50">{children}</td>,
                    hr: () => <hr className="my-6 border-border/50" />,
                  }}
                >
                  {guide.content}
                </Markdown>
              </div>
            )}
          </article>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ─────────── About ─────────── */

function AboutTab() {
  const { getProfile } = useProfileCache()
  const adminProfile = getProfile(ADMIN_PUBKEY)
  const [donateOpen, setDonateOpen] = useState(false)
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null)

  // Fetch other products from NIP-78
  const [products, setProducts] = useState<{ profilePic: string; banner: string; name: string; description: string; buttons: { text: string; link: string }[] }[]>([])
  const [productsLoading, setProductsLoading] = useState(true)

  // Fetch sponsors from NIP-78
  const currentYear = new Date().getFullYear()
  const [sponsorsYear, setSponsorsYear] = useState(currentYear)
  const [sponsorsData, setSponsorsData] = useState<SponsorsData | null>(null)
  const [sponsorsLoading, setSponsorsLoading] = useState(true)

  useEffect(() => {
    fetchReplaceable(ADMIN_PUBKEY, 30078, 'den-chat-about-other-products').then((event) => {
      if (event && event.content) {
        try {
          const arr = JSON.parse(event.content)
          if (Array.isArray(arr)) setProducts(arr.filter((p: Record<string, unknown>) => p.name))
        } catch { /* ignore */ }
      }
    }).finally(() => setProductsLoading(false))
  }, [])

  useEffect(() => {
    setSponsorsLoading(true)
    const sponsorDTag = SPONSORS_DTAG_PREFIX + sponsorsYear
    fetchReplaceable(ADMIN_PUBKEY, 30078, sponsorDTag).then((event) => {
      if (event && event.content) {
        const parsed = parseSponsorsJson(event.content)
        if (parsed) { setSponsorsData(parsed.data); return }
      }
      setSponsorsData(null)
    }).finally(() => setSponsorsLoading(false))
  }, [sponsorsYear])

  return (
    <div className="flex flex-col items-center justify-center py-12 gap-6">
      <DenChatLogo size={80} />
      <div className="text-center space-y-2">
        <h3 className="text-xl font-bold text-foreground">DEN Chat</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          A decentralized, end-to-end encrypted chat application built on the Nostr protocol.
          Connect with communities through hubs, channels, and direct messages — all without centralized servers.
        </p>
      </div>

      {/* By — creator card */}
      <div className="mt-4 w-full max-w-xs">
        <p className="text-xs text-muted-foreground text-center mb-2 uppercase tracking-wider">By</p>
        <button
          onClick={() => setProfilePubkey(ADMIN_PUBKEY)}
          className="flex items-center gap-3 rounded-xl border border-border bg-secondary/40 p-3 w-full text-left cursor-pointer hover:bg-secondary/60 transition-colors"
        >
          <Avatar className="h-10 w-10 shrink-0">
            {adminProfile?.picture ? (
              <AvatarImage src={adminProfile.picture} alt={adminProfile.display_name || adminProfile.name || 'Creator'} />
            ) : null}
            <AvatarFallback className="text-xs bg-primary/20 text-primary">
              {(adminProfile?.display_name || adminProfile?.name || 'D')[0].toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground truncate">
              {adminProfile?.display_name || adminProfile?.name || 'Loading...'}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {truncateNpub(ADMIN_NPUB)}
            </p>
          </div>
        </button>
      </div>

      {/* Donate button */}
      <div className="w-full max-w-xs">
        <button
          onClick={() => setDonateOpen(true)}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 hover:border-rose-500/40 transition-all cursor-pointer text-sm font-medium"
        >
          <Heart size={16} />
          Donate
        </button>
      </div>

      <DonateModal open={donateOpen} onClose={() => setDonateOpen(false)} />

      {/* Other Products — loading skeleton */}
      {productsLoading && (
        <div className="mt-6 w-full">
          <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">Other Products</p>
          <div className="grid grid-cols-1 max-[1080px]:grid-cols-1 sm:grid-cols-2 gap-4 w-full">
            {[0, 1].map((i) => (
              <div key={i} className="rounded-xl border border-border bg-secondary/30 overflow-hidden animate-pulse">
                <div className="h-24 bg-muted-foreground/10" />
                <div className="p-3 space-y-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-full bg-muted-foreground/15 shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3.5 w-24 rounded bg-muted-foreground/15" />
                      <div className="h-2.5 w-40 rounded bg-muted-foreground/10" />
                    </div>
                  </div>
                  <div className="flex gap-1.5 pt-1">
                    <div className="h-6 w-16 rounded-md bg-muted-foreground/10" />
                    <div className="h-6 w-14 rounded-md bg-muted-foreground/10" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Other Products */}
      {!productsLoading && products.length > 0 && (
        <div className="mt-6 w-full">
          <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">Other Products</p>
          <div className="grid grid-cols-1 max-[1080px]:grid-cols-1 sm:grid-cols-2 gap-4 w-full">
            {products.map((product, i) => (
              <div key={i} className="rounded-xl border border-border bg-secondary/30 overflow-hidden hover:bg-secondary/50 transition-colors">
                {/* Banner */}
                {product.banner && (
                  <div className="h-24 overflow-hidden">
                    <BlossomImage src={product.banner} alt="" className="w-full h-full object-cover" />
                  </div>
                )}
                {/* Body */}
                <div className="p-3 space-y-2">
                  <div className="flex items-center gap-2.5">
                    {product.profilePic ? (
                      <BlossomImage src={product.profilePic} alt="" className="w-9 h-9 rounded-full object-cover shrink-0 border border-border" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-muted-foreground/20 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground truncate">{product.name}</p>
                      {product.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{product.description}</p>
                      )}
                    </div>
                  </div>
                  {product.buttons && product.buttons.filter((b) => b.text?.trim()).length > 0 && (
                    <div className="flex gap-1.5 pt-1">
                      {product.buttons.filter((b) => b.text?.trim()).map((btn, j) => (
                        <a
                          key={j}
                          href={btn.link || '#'}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 text-center px-2.5 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors border border-primary/20"
                        >
                          {btn.text}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sponsors */}
      <div className="mt-6 w-full">
        <div className="flex items-center gap-3 mb-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Sponsors</p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSponsorsYear(y => Math.max(2026, y - 1))}
              disabled={sponsorsYear <= 2026}
              className="w-6 h-6 flex items-center justify-center rounded-md bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronDown size={13} className="rotate-90" />
            </button>
            <span className="text-xs font-semibold text-foreground tabular-nums w-10 text-center">{sponsorsYear}</span>
            <button
              onClick={() => setSponsorsYear(y => Math.min(currentYear, y + 1))}
              disabled={sponsorsYear >= currentYear}
              className="w-6 h-6 flex items-center justify-center rounded-md bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronDown size={13} className="-rotate-90" />
            </button>
          </div>
        </div>

        {sponsorsLoading && (
          <div className="flex gap-3">
            <div className="w-40 h-24 rounded-xl bg-muted-foreground/10 animate-pulse" />
            <div className="w-40 h-24 rounded-xl bg-muted-foreground/10 animate-pulse" style={{ animationDelay: '.15s' }} />
          </div>
        )}

        {!sponsorsLoading && sponsorsData && (() => {
          const visibleTiers = SPONSOR_TIERS.filter(t => sponsorsData[t].sponsors.length > 0 || sponsorsData[t].anonymous > 0)
          if (visibleTiers.length === 0) return null
          return (
            <div className="space-y-5">
              {visibleTiers.map(tier => {
                const td = sponsorsData[tier]
                return (
                  <div key={tier}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-sm font-bold ${TIER_COLORS[tier]}`}>{TIER_LABELS[tier]}</span>
                      <span className="text-[10px] text-muted-foreground">{TIER_PRICES[tier]}</span>
                    </div>
                    {tier === 'common' ? (
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {td.sponsors.filter(s => s.name).map((s, i) => (
                          s.link ? (
                            <a key={i} href={s.link} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:text-primary/80 underline transition-colors">{s.name}</a>
                          ) : (
                            <span key={i} className="text-sm text-muted-foreground">{s.name}</span>
                          )
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-3">
                        {td.sponsors.map((s, i) => (
                          <a
                            key={i}
                            href={s.link || '#'}
                            target={s.link ? '_blank' : undefined}
                            rel={s.link ? 'noopener noreferrer' : undefined}
                            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors overflow-hidden"
                            style={{ width: tier === 'mythic' ? 208 : tier === 'legendary' ? 192 : tier === 'epic' ? 160 : 144, height: tier === 'mythic' ? 128 : tier === 'legendary' ? 112 : tier === 'epic' ? 96 : 80 }}
                          >
                            {s.logo && <img src={s.logo} alt={s.name} className="max-w-[80%] max-h-[55%] object-contain" />}
                            {s.name && <span className="text-[11px] text-muted-foreground font-medium text-center px-2 truncate w-full">{s.name}</span>}
                          </a>
                        ))}
                      </div>
                    )}
                    {td.anonymous > 0 && (
                      <p className="text-xs text-muted-foreground/50 mt-2">Anonymous {TIER_LABELS[tier]} sponsors: {td.anonymous}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })()}
      </div>

      {/* Profile Modal */}
      <UserProfileModal pubkey={profilePubkey} onClose={() => setProfilePubkey(null)} />
    </div>
  )
}

/* ─────────── Admin ─────────── */

const LOGIN_BG_DTAG = 'den-chat-background-login'

interface LoginBgButton {
  text: string
  link: string
}

interface LoginBgEntry {
  id: string
  imageUrl: string
  profilePicUrl: string
  name: string
  buttons: LoginBgButton[]
}

function emptyEntry(): LoginBgEntry {
  return {
    id: crypto.randomUUID(),
    imageUrl: '',
    profilePicUrl: '',
    name: '',
    buttons: [{ text: '', link: '' }],
  }
}

/** Serialize entries to kind:30078 content */
function entriesToContent(entries: LoginBgEntry[]): string {
  return JSON.stringify(entries.map((e) => ({
    id: e.id,
    image: e.imageUrl,
    profilePic: e.profilePicUrl,
    name: e.name,
    buttons: e.buttons.filter((b) => b.text.trim() || b.link.trim()),
  })))
}

/** Parse kind:30078 content back to entries */
function contentToEntries(content: string): LoginBgEntry[] {
  try {
    const arr = JSON.parse(content)
    if (!Array.isArray(arr)) return []
    return arr.map((item: Record<string, unknown>) => ({
      id: (item.id as string) || crypto.randomUUID(),
      imageUrl: (item.image as string) || '',
      profilePicUrl: (item.profilePic as string) || '',
      name: (item.name as string) || '',
      buttons: Array.isArray(item.buttons) ? (item.buttons as LoginBgButton[]).map((b) => ({ text: b.text || '', link: b.link || '' })) : [{ text: '', link: '' }],
    }))
  } catch { return [] }
}

function AdminTab() {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [entries, setEntries] = useState<LoginBgEntry[]>([emptyEntry()])
  const [cachedContent, setCachedContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [publishStatus, setPublishStatus] = useState<string | null>(null)
  const [adminTab, setAdminTab] = useState<'backgrounds' | 'products' | 'advertisements' | 'premium' | 'faq' | 'guides' | 'builds' | 'sponsors'>('backgrounds')

  // Fetch existing event on mount
  useEffect(() => {
    if (!pubkey) return
    setLoading(true)
    fetchReplaceable(pubkey, 30078, LOGIN_BG_DTAG).then((event) => {
      if (event && event.content) {
        const parsed = contentToEntries(event.content)
        if (parsed.length > 0) {
          setEntries(parsed)
          setCachedContent(event.content)
        }
      }
    }).finally(() => setLoading(false))
  }, [pubkey])

  const currentContent = entriesToContent(entries)
  const hasChanges = currentContent !== cachedContent

  const addEntry = () => setEntries((prev) => [...prev, emptyEntry()])
  const removeEntry = (id: string) => setEntries((prev) => prev.filter((e) => e.id !== id))

  const updateEntry = (id: string, patch: Partial<LoginBgEntry>) => {
    setEntries((prev) => prev.map((e) => e.id === id ? { ...e, ...patch } : e))
  }

  const updateButton = (entryId: string, btnIdx: number, patch: Partial<LoginBgButton>) => {
    setEntries((prev) => prev.map((e) => {
      if (e.id !== entryId) return e
      const buttons = [...e.buttons]
      buttons[btnIdx] = { ...buttons[btnIdx], ...patch }
      return { ...e, buttons }
    }))
  }

  const addButton = (entryId: string) => {
    setEntries((prev) => prev.map((e) => {
      if (e.id !== entryId || e.buttons.length >= 3) return e
      return { ...e, buttons: [...e.buttons, { text: '', link: '' }] }
    }))
  }

  const removeButton = (entryId: string, btnIdx: number) => {
    setEntries((prev) => prev.map((e) => {
      if (e.id !== entryId) return e
      return { ...e, buttons: e.buttons.filter((_, i) => i !== btnIdx) }
    }))
  }

  const handlePublish = async () => {
    if (!pubkey || (!signer && !privateKey)) return
    setPublishing(true)
    setPublishStatus(null)
    try {
      const content = entriesToContent(entries)
      const unsigned = createUnsignedEvent(30078, content, [['d', LOGIN_BG_DTAG]])
      const signed = await signWithSigner(unsigned, signer, privateKey)
      const accepted = await publishToSpecificRelays(getPublishRelays(), signed)
      setCachedContent(content)
      setPublishStatus(`Published to ${accepted.length} relay${accepted.length !== 1 ? 's' : ''}`)
    } catch (err) {
      setPublishStatus(`Error: ${err instanceof Error ? err.message : 'Publishing failed'}`)
    } finally {
      setPublishing(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Admin</h3>
          <p className="text-sm text-muted-foreground mt-1">Administration tools and configuration.</p>
        </div>
        <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
          <Loader2 size={16} className="animate-spin" /> Loading...
        </div>
      </div>
    )
  }


  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Admin</h3>
        <p className="text-sm text-muted-foreground mt-1">Administration tools and configuration.</p>
      </div>

      {/* Inner tabs */}
      <div className="flex flex-wrap gap-1.5 pb-4 border-b border-border">
        {(['backgrounds', 'products', 'advertisements', 'premium', 'faq', 'guides', 'builds', 'sponsors'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setAdminTab(t)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer ${adminTab === t
              ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
              : 'bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70'
              }`}
          >
            {t === 'backgrounds' ? 'Login Backgrounds' : t === 'products' ? 'Other Products' : t === 'advertisements' ? 'Advertisements' : t === 'premium' ? 'Premium' : t === 'faq' ? 'FAQ' : t === 'guides' ? 'Guides' : t === 'builds' ? 'Builds' : 'Sponsors'}
          </button>
        ))}
      </div>

      {/* Login Backgrounds */}
      {adminTab === 'backgrounds' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold text-foreground">Login Backgrounds</h4>
              <p className="text-xs text-muted-foreground mt-0.5">Images shown at random on the login screen. Each entry has a background image, creator card, and optional link buttons.</p>
            </div>
            <button
              onClick={addEntry}
              className="flex text-nowrap items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
            >
              <Plus size={14} /> Add Entry
            </button>
          </div>

          {entries.map((entry, idx) => (
            <LoginBgEntryEditor
              key={entry.id}
              entry={entry}
              index={idx}
              onUpdate={(patch) => updateEntry(entry.id, patch)}
              onUpdateButton={(btnIdx, patch) => updateButton(entry.id, btnIdx, patch)}
              onAddButton={() => addButton(entry.id)}
              onRemoveButton={(btnIdx) => removeButton(entry.id, btnIdx)}
              onRemove={() => removeEntry(entry.id)}
              canRemove={entries.length > 1}
              signer={signer}
              privateKey={privateKey}
            />
          ))}

          {/* Publish Button */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handlePublish}
              disabled={!hasChanges || publishing}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
                ${hasChanges && !publishing
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
                }`}
            >
              {publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Publish Changes
            </button>
            {publishStatus && (
              <span className={`text-xs ${publishStatus.startsWith('Error') ? 'text-destructive' : 'text-emerald-400'}`}>
                {publishStatus}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Other Products */}
      {adminTab === 'products' && (
        <AdminProductsSection pubkey={pubkey} signer={signer} privateKey={privateKey} />
      )}

      {/* Advertisements */}
      {adminTab === 'advertisements' && (
        <AdminAdsSection pubkey={pubkey} signer={signer} privateKey={privateKey} />
      )}

      {/* Premium Benefits */}
      {adminTab === 'premium' && (
        <AdminPremiumSection pubkey={pubkey} signer={signer} privateKey={privateKey} />
      )}

      {/* FAQ */}
      {adminTab === 'faq' && (
        <AdminFaqSection pubkey={pubkey} signer={signer} privateKey={privateKey} />
      )}

      {/* Guides */}
      {adminTab === 'guides' && (
        <AdminGuidesSection pubkey={pubkey} signer={signer} privateKey={privateKey} />
      )}

      {/* Builds */}
      {adminTab === 'builds' && (
        <AdminBuildsSection pubkey={pubkey} signer={signer} privateKey={privateKey} />
      )}

      {/* Sponsors */}
      {adminTab === 'sponsors' && (
        <AdminSponsorsSection pubkey={pubkey} signer={signer} privateKey={privateKey} />
      )}
    </div>
  )
}

/* ── Login Background Entry Editor ── */

function LoginBgEntryEditor({
  entry, index, onUpdate, onUpdateButton, onAddButton, onRemoveButton, onRemove, canRemove, signer, privateKey,
}: {
  entry: LoginBgEntry
  index: number
  onUpdate: (patch: Partial<LoginBgEntry>) => void
  onUpdateButton: (btnIdx: number, patch: Partial<LoginBgButton>) => void
  onAddButton: () => void
  onRemoveButton: (btnIdx: number) => void
  onRemove: () => void
  canRemove: boolean
  signer: ISigner | null
  privateKey: string | null
}) {
  const bgUpload = useMediaUpload(signer, privateKey)
  const pfpUpload = useMediaUpload(signer, privateKey)

  // When BG upload completes, set the URL
  useEffect(() => {
    if (bgUpload.allSuccess && bgUpload.pendingFiles.length > 0) {
      const urls = bgUpload.getUploadedUrls()
      if (urls.length > 0 && urls[0] !== entry.imageUrl) {
        onUpdate({ imageUrl: urls[0] })
      }
    }
  }, [bgUpload.allSuccess, bgUpload.pendingFiles])

  // When PFP upload completes, set the URL
  useEffect(() => {
    if (pfpUpload.allSuccess && pfpUpload.pendingFiles.length > 0) {
      const urls = pfpUpload.getUploadedUrls()
      if (urls.length > 0 && urls[0] !== entry.profilePicUrl) {
        onUpdate({ profilePicUrl: urls[0] })
      }
    }
  }, [pfpUpload.allSuccess, pfpUpload.pendingFiles])

  const bgInputRef = useRef<HTMLInputElement>(null)
  const pfpInputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Entry {index + 1}</span>
        {canRemove && (
          <button onClick={onRemove} className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* Background Image */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">Background Image</label>
        <div className="flex items-center gap-2">
          <Input
            value={entry.imageUrl}
            onChange={(e) => onUpdate({ imageUrl: e.target.value })}
            placeholder="https://... or upload"
            className="h-9 text-xs flex-1"
          />
          <input ref={bgInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { if (e.target.files) { bgUpload.addFiles(Array.from(e.target.files)); e.target.value = '' } }} />
          <button onClick={() => bgInputRef.current?.click()} className="p-2 rounded-lg border border-border bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors cursor-pointer shrink-0">
            <Upload size={14} />
          </button>
        </div>
        <MediaUploadStrip
          pendingFiles={bgUpload.pendingFiles}
          isUploading={bgUpload.isUploading}
          onRemove={bgUpload.removeFile}
          onUpload={bgUpload.uploadAll}
          onRetry={(id) => { bgUpload.setPendingFiles((prev) => prev.map((f) => f.id === id ? { ...f, status: 'pending' as const } : f)); bgUpload.uploadAll() }}
          onSkipServer={() => bgUpload.uploadAbortRef.current?.abort()}
          fileSizeWarning={bgUpload.fileSizeWarning}
          onDismissSizeWarning={bgUpload.dismissSizeWarning}
        />
        {entry.imageUrl && (
          <div className="relative rounded-lg overflow-hidden border border-border h-32">
            <BlossomImage src={entry.imageUrl} alt="Background preview" className="w-full h-full object-cover" />
          </div>
        )}
      </div>

      {/* Profile Picture */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">Profile Picture</label>
        <div className="flex items-center gap-2">
          <Input
            value={entry.profilePicUrl}
            onChange={(e) => onUpdate({ profilePicUrl: e.target.value })}
            placeholder="https://... or upload"
            className="h-9 text-xs flex-1"
          />
          <input ref={pfpInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { if (e.target.files) { pfpUpload.addFiles(Array.from(e.target.files)); e.target.value = '' } }} />
          <button onClick={() => pfpInputRef.current?.click()} className="p-2 rounded-lg border border-border bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors cursor-pointer shrink-0">
            <Upload size={14} />
          </button>
        </div>
        <MediaUploadStrip
          pendingFiles={pfpUpload.pendingFiles}
          isUploading={pfpUpload.isUploading}
          onRemove={pfpUpload.removeFile}
          onUpload={pfpUpload.uploadAll}
          onRetry={(id) => { pfpUpload.setPendingFiles((prev) => prev.map((f) => f.id === id ? { ...f, status: 'pending' as const } : f)); pfpUpload.uploadAll() }}
          onSkipServer={() => pfpUpload.uploadAbortRef.current?.abort()}
          fileSizeWarning={pfpUpload.fileSizeWarning}
          onDismissSizeWarning={pfpUpload.dismissSizeWarning}
        />
        {entry.profilePicUrl && (
          <div className="flex items-center gap-2">
            <BlossomImage src={entry.profilePicUrl} alt="Profile preview" className="w-10 h-10 rounded-full object-cover border border-border" />
          </div>
        )}
      </div>

      {/* Name */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">Name</label>
        <Input
          value={entry.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="Creator or artist name"
          className="h-9 text-xs"
        />
      </div>

      {/* Buttons */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-foreground">Link Buttons</label>
          {entry.buttons.length < 3 && (
            <button onClick={onAddButton} className="text-xs text-primary hover:text-primary/80 cursor-pointer">+ Add Button</button>
          )}
        </div>
        {entry.buttons.map((btn, btnIdx) => (
          <div key={btnIdx} className="flex items-center gap-2">
            <Input
              value={btn.text}
              onChange={(e) => onUpdateButton(btnIdx, { text: e.target.value })}
              placeholder="Button text"
              className="h-8 text-xs flex-1"
            />
            <Input
              value={btn.link}
              onChange={(e) => onUpdateButton(btnIdx, { link: e.target.value })}
              placeholder="https://..."
              className="h-8 text-xs flex-1"
            />
            {entry.buttons.length > 1 && (
              <button onClick={() => onRemoveButton(btnIdx)} className="p-1 rounded text-muted-foreground hover:text-destructive cursor-pointer">
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Preview */}
      {entry.imageUrl && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Preview</label>
          <LoginBgPreview entry={entry} />
        </div>
      )}
    </div>
  )
}

/* ── Mini preview of what a login entry looks like ── */

function LoginBgPreview({ entry }: { entry: LoginBgEntry }) {
  return (
    <div className="relative rounded-lg overflow-hidden border border-border h-40 bg-black">
      <BlossomImage src={entry.imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover opacity-80" />
      {/* Overlay card — bottom left */}
      <div className="absolute bottom-2 left-2 flex items-end gap-2 max-w-[200px]">
        <div className="rounded-lg bg-black/70 backdrop-blur-sm p-2 space-y-1.5">
          <div className="flex items-center gap-2">
            {entry.profilePicUrl ? (
              <BlossomImage src={entry.profilePicUrl} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
            ) : (
              <div className="w-6 h-6 rounded-full bg-muted-foreground/30 shrink-0" />
            )}
            <span className="text-[10px] text-white font-medium truncate">{entry.name || 'Name'}</span>
          </div>
          {entry.buttons.filter((b) => b.text.trim()).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {entry.buttons.filter((b) => b.text.trim()).map((btn, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded text-[8px] bg-white/20 text-white/90 truncate max-w-[80px]">{btn.text}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Other Products (Admin Section) ── */

const PRODUCTS_DTAG = 'den-chat-about-other-products'

interface ProductButton {
  text: string
  link: string
}

interface ProductEntry {
  id: string
  profilePicUrl: string
  bannerUrl: string
  name: string
  description: string
  buttons: ProductButton[]
}

function emptyProduct(): ProductEntry {
  return {
    id: crypto.randomUUID(),
    profilePicUrl: '',
    bannerUrl: '',
    name: '',
    description: '',
    buttons: [{ text: '', link: '' }],
  }
}

function productsToContent(products: ProductEntry[]): string {
  return JSON.stringify(products.map((p) => ({
    id: p.id,
    profilePic: p.profilePicUrl,
    banner: p.bannerUrl,
    name: p.name,
    description: p.description,
    buttons: p.buttons.filter((b) => b.text.trim() || b.link.trim()),
  })))
}

function contentToProducts(content: string): ProductEntry[] {
  try {
    const arr = JSON.parse(content)
    if (!Array.isArray(arr)) return []
    return arr.map((item: Record<string, unknown>) => ({
      id: (item.id as string) || crypto.randomUUID(),
      profilePicUrl: (item.profilePic as string) || '',
      bannerUrl: (item.banner as string) || '',
      name: (item.name as string) || '',
      description: (item.description as string) || '',
      buttons: Array.isArray(item.buttons) ? (item.buttons as ProductButton[]).map((b) => ({ text: b.text || '', link: b.link || '' })) : [{ text: '', link: '' }],
    }))
  } catch { return [] }
}

function AdminProductsSection({ pubkey, signer, privateKey }: { pubkey: string | null; signer: ISigner | null; privateKey: string | null }) {
  const [products, setProducts] = useState<ProductEntry[]>([emptyProduct()])
  const [cachedContent, setCachedContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [publishStatus, setPublishStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!pubkey) return
    setLoading(true)
    fetchReplaceable(pubkey, 30078, PRODUCTS_DTAG).then((event) => {
      if (event && event.content) {
        const parsed = contentToProducts(event.content)
        if (parsed.length > 0) {
          setProducts(parsed)
          setCachedContent(event.content)
        }
      }
    }).finally(() => setLoading(false))
  }, [pubkey])

  const currentContent = productsToContent(products)
  const hasChanges = currentContent !== cachedContent

  const addProduct = () => setProducts((prev) => [...prev, emptyProduct()])
  const removeProduct = (id: string) => setProducts((prev) => prev.filter((p) => p.id !== id))

  const updateProduct = (id: string, patch: Partial<ProductEntry>) => {
    setProducts((prev) => prev.map((p) => p.id === id ? { ...p, ...patch } : p))
  }

  const updateProductButton = (productId: string, btnIdx: number, patch: Partial<ProductButton>) => {
    setProducts((prev) => prev.map((p) => {
      if (p.id !== productId) return p
      const buttons = [...p.buttons]
      buttons[btnIdx] = { ...buttons[btnIdx], ...patch }
      return { ...p, buttons }
    }))
  }

  const addProductButton = (productId: string) => {
    setProducts((prev) => prev.map((p) => {
      if (p.id !== productId || p.buttons.length >= 3) return p
      return { ...p, buttons: [...p.buttons, { text: '', link: '' }] }
    }))
  }

  const removeProductButton = (productId: string, btnIdx: number) => {
    setProducts((prev) => prev.map((p) => {
      if (p.id !== productId) return p
      return { ...p, buttons: p.buttons.filter((_, i) => i !== btnIdx) }
    }))
  }

  const handlePublish = async () => {
    if (!pubkey || (!signer && !privateKey)) return
    setPublishing(true)
    setPublishStatus(null)
    try {
      const content = productsToContent(products)
      const unsigned = createUnsignedEvent(30078, content, [['d', PRODUCTS_DTAG]])
      const signed = await signWithSigner(unsigned, signer, privateKey)
      const accepted = await publishToSpecificRelays(getPublishRelays(), signed)
      setCachedContent(content)
      setPublishStatus(`Published to ${accepted.length} relay${accepted.length !== 1 ? 's' : ''}`)
    } catch (err) {
      setPublishStatus(`Error: ${err instanceof Error ? err.message : 'Publishing failed'}`)
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="space-y-4 pt-2">
      <div className="">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-foreground">Other Products</h4>
            <p className="text-xs text-muted-foreground mt-0.5">Showcase cards displayed in the About page. Each card has a banner, profile picture, name, description, and link buttons.</p>
          </div>
          <button
            onClick={addProduct}
            className="flex text-nowrap items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
          >
            <Plus size={14} /> Add Product
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
          <Loader2 size={16} className="animate-spin" /> Loading...
        </div>
      ) : (
        <>
          {products.map((product, idx) => (
            <ProductEntryEditor
              key={product.id}
              product={product}
              index={idx}
              onUpdate={(patch) => updateProduct(product.id, patch)}
              onUpdateButton={(btnIdx, patch) => updateProductButton(product.id, btnIdx, patch)}
              onAddButton={() => addProductButton(product.id)}
              onRemoveButton={(btnIdx) => removeProductButton(product.id, btnIdx)}
              onRemove={() => removeProduct(product.id)}
              canRemove={products.length > 1}
              signer={signer}
              privateKey={privateKey}
            />
          ))}

          {/* Publish Button */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handlePublish}
              disabled={!hasChanges || publishing}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
                ${hasChanges && !publishing
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
                }`}
            >
              {publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Publish Changes
            </button>
            {publishStatus && (
              <span className={`text-xs ${publishStatus.startsWith('Error') ? 'text-destructive' : 'text-emerald-400'}`}>
                {publishStatus}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/* ── Product Entry Editor ── */

function ProductEntryEditor({
  product, index, onUpdate, onUpdateButton, onAddButton, onRemoveButton, onRemove, canRemove, signer, privateKey,
  itemLabel = 'Product', bannerLabel = 'Banner Image',
}: {
  product: ProductEntry
  index: number
  onUpdate: (patch: Partial<ProductEntry>) => void
  onUpdateButton: (btnIdx: number, patch: Partial<ProductButton>) => void
  onAddButton: () => void
  onRemoveButton: (btnIdx: number) => void
  onRemove: () => void
  canRemove: boolean
  signer: ISigner | null
  privateKey: string | null
  itemLabel?: string
  bannerLabel?: string
}) {
  const pfpUpload = useMediaUpload(signer, privateKey)
  const bannerUpload = useMediaUpload(signer, privateKey)

  useEffect(() => {
    if (pfpUpload.allSuccess && pfpUpload.pendingFiles.length > 0) {
      const urls = pfpUpload.getUploadedUrls()
      if (urls.length > 0 && urls[0] !== product.profilePicUrl) {
        onUpdate({ profilePicUrl: urls[0] })
      }
    }
  }, [pfpUpload.allSuccess, pfpUpload.pendingFiles])

  useEffect(() => {
    if (bannerUpload.allSuccess && bannerUpload.pendingFiles.length > 0) {
      const urls = bannerUpload.getUploadedUrls()
      if (urls.length > 0 && urls[0] !== product.bannerUrl) {
        onUpdate({ bannerUrl: urls[0] })
      }
    }
  }, [bannerUpload.allSuccess, bannerUpload.pendingFiles])

  const pfpInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{itemLabel} {index + 1}</span>
        {canRemove && (
          <button onClick={onRemove} className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* Banner */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">{bannerLabel}</label>
        <div className="flex items-center gap-2">
          <Input
            value={product.bannerUrl}
            onChange={(e) => onUpdate({ bannerUrl: e.target.value })}
            placeholder="https://... or upload"
            className="h-9 text-xs flex-1"
          />
          <input ref={bannerInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { if (e.target.files) { bannerUpload.addFiles(Array.from(e.target.files)); e.target.value = '' } }} />
          <button onClick={() => bannerInputRef.current?.click()} className="p-2 rounded-lg border border-border bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors cursor-pointer shrink-0">
            <Upload size={14} />
          </button>
        </div>
        <MediaUploadStrip
          pendingFiles={bannerUpload.pendingFiles}
          isUploading={bannerUpload.isUploading}
          onRemove={bannerUpload.removeFile}
          onUpload={bannerUpload.uploadAll}
          onRetry={(id) => { bannerUpload.setPendingFiles((prev) => prev.map((f) => f.id === id ? { ...f, status: 'pending' as const } : f)); bannerUpload.uploadAll() }}
          onSkipServer={() => bannerUpload.uploadAbortRef.current?.abort()}
          fileSizeWarning={bannerUpload.fileSizeWarning}
          onDismissSizeWarning={bannerUpload.dismissSizeWarning}
        />
        {product.bannerUrl && (
          <div className="relative rounded-lg overflow-hidden border border-border h-24">
            <BlossomImage src={product.bannerUrl} alt="Banner preview" className="w-full h-full object-cover" />
          </div>
        )}
      </div>

      {/* Profile Picture */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">Profile Picture</label>
        <div className="flex items-center gap-2">
          <Input
            value={product.profilePicUrl}
            onChange={(e) => onUpdate({ profilePicUrl: e.target.value })}
            placeholder="https://... or upload"
            className="h-9 text-xs flex-1"
          />
          <input ref={pfpInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { if (e.target.files) { pfpUpload.addFiles(Array.from(e.target.files)); e.target.value = '' } }} />
          <button onClick={() => pfpInputRef.current?.click()} className="p-2 rounded-lg border border-border bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors cursor-pointer shrink-0">
            <Upload size={14} />
          </button>
        </div>
        <MediaUploadStrip
          pendingFiles={pfpUpload.pendingFiles}
          isUploading={pfpUpload.isUploading}
          onRemove={pfpUpload.removeFile}
          onUpload={pfpUpload.uploadAll}
          onRetry={(id) => { pfpUpload.setPendingFiles((prev) => prev.map((f) => f.id === id ? { ...f, status: 'pending' as const } : f)); pfpUpload.uploadAll() }}
          onSkipServer={() => pfpUpload.uploadAbortRef.current?.abort()}
          fileSizeWarning={pfpUpload.fileSizeWarning}
          onDismissSizeWarning={pfpUpload.dismissSizeWarning}
        />
        {product.profilePicUrl && (
          <div className="flex items-center gap-2">
            <BlossomImage src={product.profilePicUrl} alt="Profile preview" className="w-10 h-10 rounded-full object-cover border border-border" />
          </div>
        )}
      </div>

      {/* Name */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">Name</label>
        <Input
          value={product.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="Product name"
          className="h-9 text-xs"
        />
      </div>

      {/* Description */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">Short Description</label>
        <textarea
          value={product.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="A brief description of this product..."
          className="w-full h-16 rounded-lg border border-input bg-transparent px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none resize-none"
        />
      </div>

      {/* Buttons */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-foreground">Link Buttons</label>
          {product.buttons.length < 3 && (
            <button onClick={onAddButton} className="text-xs text-primary hover:text-primary/80 cursor-pointer">+ Add Button</button>
          )}
        </div>
        {product.buttons.map((btn, btnIdx) => (
          <div key={btnIdx} className="flex items-center gap-2">
            <Input
              value={btn.text}
              onChange={(e) => onUpdateButton(btnIdx, { text: e.target.value })}
              placeholder="Button text"
              className="h-8 text-xs flex-1"
            />
            <Input
              value={btn.link}
              onChange={(e) => onUpdateButton(btnIdx, { link: e.target.value })}
              placeholder="https://..."
              className="h-8 text-xs flex-1"
            />
            {product.buttons.length > 1 && (
              <button onClick={() => onRemoveButton(btnIdx)} className="p-1 rounded text-muted-foreground hover:text-destructive cursor-pointer">
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
/* ─────────── Advertisements Tab (viewer) ─────────── */

const ADS_DTAG = 'den-chat-ads'

function AdvertisementsTab() {
  const [ads, setAds] = useState<{ profilePic: string; banner: string; name: string; description: string; buttons: { text: string; link: string }[] }[]>([])
  const [loading, setLoading] = useState(true)

  // Ad Showcase toggle — on by default
  const [adShowcase, setAdShowcase] = useState(() => {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(StorageKey.AD_SHOWCASE)
    return stored === null || stored === 'true'
  })

  const toggleAdShowcase = () => {
    const next = !adShowcase
    setAdShowcase(next)
    localStorage.setItem(StorageKey.AD_SHOWCASE, String(next))
  }

  useEffect(() => {
    fetchReplaceable(ADMIN_PUBKEY, 30078, ADS_DTAG).then((event) => {
      if (event && event.content) {
        try {
          const arr = JSON.parse(event.content)
          if (Array.isArray(arr)) setAds(arr.filter((p: Record<string, unknown>) => p.name))
        } catch { /* ignore */ }
      }
    }).finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Advertisements</h3>
        <p className="text-sm text-muted-foreground mt-1">Sponsored products, services, and community highlights.</p>
      </div>

      {/* Ad Showcase toggle */}
      <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-secondary/30 border border-border">
        <div>
          <label className="text-sm font-medium text-foreground">Ad Showcase</label>
          <p className="text-xs text-muted-foreground">Show advertisement backgrounds on the login screen</p>
        </div>
        <ToggleSwitch checked={adShowcase} onChange={toggleAdShowcase} />
      </div>

      {loading && (
        <div className="grid grid-cols-2 gap-4 w-full">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl border border-border bg-secondary/30 overflow-hidden animate-pulse">
              <div className="h-24 bg-muted-foreground/10" />
              <div className="p-3 space-y-2.5">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-full bg-muted-foreground/15 shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-24 rounded bg-muted-foreground/15" />
                    <div className="h-2.5 w-40 rounded bg-muted-foreground/10" />
                  </div>
                </div>
                <div className="flex gap-1.5 pt-1">
                  <div className="h-6 w-16 rounded-md bg-muted-foreground/10" />
                  <div className="h-6 w-14 rounded-md bg-muted-foreground/10" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && ads.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <Megaphone size={32} className="opacity-30" />
          <p className="text-sm">No advertisements available</p>
        </div>
      )}

      {!loading && ads.length > 0 && (
        <div className="grid grid-cols-2 gap-4 w-full">
          {ads.map((ad, i) => (
            <div key={i} className="rounded-xl border border-border bg-secondary/30 overflow-hidden hover:bg-secondary/50 transition-colors">
              {ad.banner && (
                <div className="h-24 overflow-hidden">
                  <BlossomImage src={ad.banner} alt="" className="w-full h-full" imgClassName="object-right-bottom" />
                </div>
              )}
              <div className="p-3 space-y-2">
                <div className="flex items-center gap-2.5">
                  {ad.profilePic ? (
                    <BlossomImage src={ad.profilePic} alt="" className="w-9 h-9 rounded-full object-cover shrink-0 border border-border" />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-muted-foreground/20 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground truncate">{ad.name}</p>
                    {ad.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">{ad.description}</p>
                    )}
                  </div>
                </div>
                {ad.buttons && ad.buttons.filter((b) => b.text?.trim()).length > 0 && (
                  <div className="flex gap-1.5 pt-1">
                    {ad.buttons.filter((b) => b.text?.trim()).map((btn, j) => (
                      <a
                        key={j}
                        href={btn.link || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-center px-2.5 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors border border-primary/20"
                      >
                        {btn.text}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ─────────── Premium Tab ─────────── */

const PREMIUM_DTAG = 'den-chat-premium'

/** Map icon name strings (stored in the event) to lucide components */
const PREMIUM_ICON_MAP: Record<string, React.ReactNode> = {
  palette: <PaletteIcon size={20} />,
  badge: <BadgeCheck size={20} />,
  sparkles: <Sparkles size={20} />,
  upload: <Upload size={20} />,
  zap: <Zap size={20} />,
  crown: <Crown size={20} />,
  shield: <Shield size={20} />,
  star: <Sparkles size={20} />,
  mic: <Mic size={20} />,
  camera: <Camera size={20} />,
  globe: <Globe size={20} />,
  settings: <Settings size={20} />,
  download: <Download size={20} />,
  eye: <Eye size={20} />,
}

interface PremiumBenefit {
  icon: string
  title: string
  description: string
}

function PremiumTab() {
  const [benefits, setBenefits] = useState<PremiumBenefit[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchReplaceable(ADMIN_PUBKEY, 30078, PREMIUM_DTAG).then((event) => {
      if (event && event.content) {
        try {
          const arr = JSON.parse(event.content)
          if (Array.isArray(arr)) setBenefits(arr.filter((b: Record<string, unknown>) => b.title))
        } catch { /* ignore */ }
      }
    }).finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-amber-500/10 via-yellow-500/5 to-orange-500/10 p-8">


        <div className="relative flex items-start gap-4">
          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-500 to-yellow-600 text-white shrink-0">
            <Crown size={28} />
          </div>
          <div className="space-y-2">
            <h3 className="text-2xl font-bold text-foreground tracking-tight">DEN Chat Premium</h3>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-lg">
              Premium is a small optional subscription that would help fund the development of DEN Chat.
              The benefits listed below are <span className="text-foreground font-medium">client-side enhancements only</span> —
              they won't change how other Nostr clients display your data, and none of them are essential to using the app.
              Think of them as neat little extras you get as a thank-you for supporting the project.
            </p>
          </div>
        </div>
      </div>

      {/* Funding callout */}
      <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-primary/5 border border-primary/15">
        <p className="text-sm text-muted-foreground leading-relaxed">
          <span className="text-foreground font-medium">Where does the money go?</span>{' '}
          The subscription revenue may go toward paying for server infrastructure costs, development time (salaries),
          and may help fund other projects as well by the same creators.
        </p>
      </div>

      {/* Benefits list */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">What you get</h4>

        {loading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-start gap-4 px-4 py-4 rounded-xl border border-border bg-secondary/30 animate-pulse">
                <div className="w-10 h-10 rounded-xl bg-muted-foreground/10 shrink-0" />
                <div className="flex-1 space-y-2 py-1">
                  <div className="h-3.5 w-40 rounded bg-muted-foreground/10" />
                  <div className="h-2.5 w-full rounded bg-muted-foreground/8" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && benefits.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
            <Crown size={28} className="opacity-30" />
            <p className="text-sm">No benefits listed yet</p>
          </div>
        )}

        {!loading && benefits.length > 0 && (
          <div className="space-y-2">
            {benefits.map((b, i) => (
              <div
                key={i}
                className="group flex items-start gap-4 px-4 py-4 rounded-xl border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors"
              >
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 text-amber-500 shrink-0 group-hover:bg-amber-500/15 transition-colors">
                  {PREMIUM_ICON_MAP[b.icon] || <Sparkles size={20} />}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{b.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{b.description}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Subject to change note */}
      <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
        Benefits are subject to change at any time — features may be added or removed as the project evolves, though this is unlikely.
      </p>

      {/* CTA */}
      <button
        className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-amber-500 to-yellow-500 text-white hover:brightness-110 transition-all cursor-pointer"
      >
        <Crown size={16} />
        Subscribe — Coming Soon
      </button>
    </div>
  )
}

/* ─────────── Admin Premium Section (editor) ─────────── */

function AdminPremiumSection({ pubkey, signer, privateKey }: { pubkey: string | null; signer: ISigner | null; privateKey: string | null }) {
  const [benefits, setBenefits] = useState<PremiumBenefit[]>([{ icon: 'sparkles', title: '', description: '' }])
  const [cachedContent, setCachedContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [publishStatus, setPublishStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!pubkey) return
    setLoading(true)
    fetchReplaceable(pubkey, 30078, PREMIUM_DTAG).then((event) => {
      if (event && event.content) {
        try {
          const arr = JSON.parse(event.content)
          if (Array.isArray(arr) && arr.length > 0) {
            setBenefits(arr.map((b: Record<string, unknown>) => ({
              icon: (b.icon as string) || 'sparkles',
              title: (b.title as string) || '',
              description: (b.description as string) || '',
            })))
            setCachedContent(event.content)
          }
        } catch { /* ignore */ }
      }
    }).finally(() => setLoading(false))
  }, [pubkey])

  const currentContent = JSON.stringify(benefits.map((b) => ({ icon: b.icon, title: b.title, description: b.description })))
  const hasChanges = currentContent !== cachedContent

  const addBenefit = () => setBenefits((prev) => [...prev, { icon: 'sparkles', title: '', description: '' }])
  const removeBenefit = (idx: number) => setBenefits((prev) => prev.filter((_, i) => i !== idx))
  const updateBenefit = (idx: number, patch: Partial<PremiumBenefit>) => {
    setBenefits((prev) => prev.map((b, i) => i === idx ? { ...b, ...patch } : b))
  }

  const handlePublish = async () => {
    if (!pubkey || (!signer && !privateKey)) return
    setPublishing(true)
    setPublishStatus(null)
    try {
      const content = JSON.stringify(benefits.map((b) => ({ icon: b.icon, title: b.title, description: b.description })))
      const unsigned = createUnsignedEvent(30078, content, [['d', PREMIUM_DTAG]])
      const signed = await signWithSigner(unsigned, signer, privateKey)
      const accepted = await publishToSpecificRelays(getPublishRelays(), signed)
      setCachedContent(content)
      setPublishStatus(`Published to ${accepted.length} relay${accepted.length !== 1 ? 's' : ''}`)
    } catch (err) {
      setPublishStatus(`Error: ${err instanceof Error ? err.message : 'Publishing failed'}`)
    } finally {
      setPublishing(false)
    }
  }

  const iconOptions = Object.keys(PREMIUM_ICON_MAP)

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-4 pt-2">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-foreground">Premium Benefits</h4>
            <p className="text-xs text-muted-foreground mt-0.5">Manage the list of benefits shown on the Premium page.</p>
          </div>
          <button
            onClick={addBenefit}
            className="flex text-nowrap items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
          >
            <Plus size={14} /> Add Benefit
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
            <Loader2 size={16} className="animate-spin" /> Loading...
          </div>
        ) : (
          <>
            {benefits.map((b, idx) => (
              <div key={idx} className="rounded-xl border border-border bg-secondary/20 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Benefit {idx + 1}</span>
                  {benefits.length > 1 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button onClick={() => removeBenefit(idx)} className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer">
                          <Trash2 size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">Remove benefit</TooltipContent>
                    </Tooltip>
                  )}
                </div>

                {/* Icon selector */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Icon</label>
                  <div className="flex flex-wrap gap-1.5">
                    {iconOptions.map((name) => (
                      <Tooltip key={name}>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => updateBenefit(idx, { icon: name })}
                            className={`flex items-center justify-center w-8 h-8 rounded-lg border transition-colors cursor-pointer ${b.icon === name
                              ? 'border-amber-500 bg-amber-500/15 text-amber-500'
                              : 'border-border bg-secondary/30 text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                              }`}
                          >
                            {PREMIUM_ICON_MAP[name]}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">{name}</TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </div>

                {/* Title */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Title</label>
                  <Input
                    value={b.title}
                    onChange={(e) => updateBenefit(idx, { title: e.target.value })}
                    placeholder="Benefit title"
                    className="h-9 text-xs"
                  />
                </div>

                {/* Description */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Description</label>
                  <textarea
                    value={b.description}
                    onChange={(e) => updateBenefit(idx, { description: e.target.value })}
                    placeholder="Brief description of this benefit"
                    rows={2}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none resize-none"
                  />
                </div>
              </div>
            ))}

            {/* Publish Button */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handlePublish}
                disabled={!hasChanges || publishing}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
                ${hasChanges && !publishing
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
                  }`}
              >
                {publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                Publish Changes
              </button>
              {publishStatus && (
                <span className={`text-xs ${publishStatus.startsWith('Error') ? 'text-destructive' : 'text-emerald-400'}`}>
                  {publishStatus}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}

/* ─────────── Admin Ads Section (editor) ─────────── */

function AdminAdsSection({ pubkey, signer, privateKey }: { pubkey: string | null; signer: ISigner | null; privateKey: string | null }) {
  const [ads, setAds] = useState<ProductEntry[]>([emptyProduct()])
  const [cachedContent, setCachedContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [publishStatus, setPublishStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!pubkey) return
    setLoading(true)
    fetchReplaceable(pubkey, 30078, ADS_DTAG).then((event) => {
      if (event && event.content) {
        const parsed = contentToProducts(event.content)
        if (parsed.length > 0) {
          setAds(parsed)
          setCachedContent(event.content)
        }
      }
    }).finally(() => setLoading(false))
  }, [pubkey])

  const currentContent = productsToContent(ads)
  const hasChanges = currentContent !== cachedContent

  const addAd = () => setAds((prev) => [...prev, emptyProduct()])
  const removeAd = (id: string) => setAds((prev) => prev.filter((p) => p.id !== id))

  const updateAd = (id: string, patch: Partial<ProductEntry>) => {
    setAds((prev) => prev.map((p) => p.id === id ? { ...p, ...patch } : p))
  }

  const updateAdButton = (adId: string, btnIdx: number, patch: Partial<ProductButton>) => {
    setAds((prev) => prev.map((p) => {
      if (p.id !== adId) return p
      const buttons = [...p.buttons]
      buttons[btnIdx] = { ...buttons[btnIdx], ...patch }
      return { ...p, buttons }
    }))
  }

  const addAdButton = (adId: string) => {
    setAds((prev) => prev.map((p) => {
      if (p.id !== adId || p.buttons.length >= 3) return p
      return { ...p, buttons: [...p.buttons, { text: '', link: '' }] }
    }))
  }

  const removeAdButton = (adId: string, btnIdx: number) => {
    setAds((prev) => prev.map((p) => {
      if (p.id !== adId) return p
      return { ...p, buttons: p.buttons.filter((_, i) => i !== btnIdx) }
    }))
  }

  const handlePublish = async () => {
    if (!pubkey || (!signer && !privateKey)) return
    setPublishing(true)
    setPublishStatus(null)
    try {
      const content = productsToContent(ads)
      const unsigned = createUnsignedEvent(30078, content, [['d', ADS_DTAG]])
      const signed = await signWithSigner(unsigned, signer, privateKey)
      const accepted = await publishToSpecificRelays(getPublishRelays(), signed)
      setCachedContent(content)
      setPublishStatus(`Published to ${accepted.length} relay${accepted.length !== 1 ? 's' : ''}`)
    } catch (err) {
      setPublishStatus(`Error: ${err instanceof Error ? err.message : 'Publishing failed'}`)
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Advertisements</h4>
          <p className="text-xs text-muted-foreground mt-0.5">Sponsored cards displayed on the Advertisements page and alternated with login backgrounds on the login screen.</p>
        </div>
        <button
          onClick={addAd}
          className="flex text-nowrap items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
        >
          <Plus size={14} /> Add Ad
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
          <Loader2 size={16} className="animate-spin" /> Loading...
        </div>
      ) : (
        <>
          {ads.map((ad, idx) => (
            <ProductEntryEditor
              key={ad.id}
              product={ad}
              index={idx}
              onUpdate={(patch) => updateAd(ad.id, patch)}
              onUpdateButton={(btnIdx, patch) => updateAdButton(ad.id, btnIdx, patch)}
              onAddButton={() => addAdButton(ad.id)}
              onRemoveButton={(btnIdx) => removeAdButton(ad.id, btnIdx)}
              onRemove={() => removeAd(ad.id)}
              canRemove={ads.length > 1}
              signer={signer}
              privateKey={privateKey}
              itemLabel="Ad"
              bannerLabel="Background Image"
            />
          ))}

          {/* Publish Button */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handlePublish}
              disabled={!hasChanges || publishing}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
                ${hasChanges && !publishing
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
                }`}
            >
              {publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Publish Changes
            </button>
            {publishStatus && (
              <span className={`text-xs ${publishStatus.startsWith('Error') ? 'text-destructive' : 'text-emerald-400'}`}>
                {publishStatus}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/* ─────────── Social Network ─────────── */

function SocialNetworkTab() {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const { getProfile } = useProfileCache()
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)
  const unblockUser = useBlockStore((s) => s.unblockUser)
  const blockTypes = useBlockStore((s) => s.blockTypes)
  const changeBlockType = useBlockStore((s) => s.changeBlockType)
  const hideBlockedCompletely = useBlockStore((s) => s.hideBlockedCompletely)
  const setHideBlockedCompletely = useBlockStore((s) => s.setHideBlockedCompletely)

  const followedPubkeys = useFollowStore((s) => s.followedPubkeys)
  const followsLoaded = useFollowStore((s) => s.loaded)
  const unfollowUser = useFollowStore((s) => s.unfollowUser)

  // Profile modal
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null)

  // Block type switch confirmation
  const [switchConfirm, setSwitchConfirm] = useState<{ pk: string; toType: 'public' | 'private' } | null>(null)

  // Unblock confirmation
  const [unblockConfirm, setUnblockConfirm] = useState<string | null>(null)

  const handleUnfollow = async (pk: string) => {
    if (!pubkey) return
    await unfollowUser(pk, pubkey, signer, privateKey)
  }

  const handleUnblock = async (pk: string) => {
    if (!pubkey) return
    setUnblockConfirm(null)
    await unblockUser(pk, pubkey, signer, privateKey)
  }

  const handleConfirmSwitch = async () => {
    if (!switchConfirm || !pubkey) return
    const { pk, toType } = switchConfirm
    setSwitchConfirm(null)
    await changeBlockType(pk, toType, pubkey, signer, privateKey)
  }

  const activeFollows = Array.from(followedPubkeys)
  const blockedArr = Array.from(blockedPubkeys)

  // Pagination
  const PER_PAGE = 10
  const [followPage, setFollowPage] = useState(1)
  const [blockPage, setBlockPage] = useState(1)
  const [followSearch, setFollowSearch] = useState('')
  const [blockSearch, setBlockSearch] = useState('')

  // Filter by search
  const filteredFollows = followSearch.trim()
    ? activeFollows.filter((pk) => {
      const q = followSearch.toLowerCase()
      const profile = getProfile(pk)
      const npubStr = nip19.npubEncode(pk)
      return (
        npubStr.toLowerCase().includes(q) ||
        (profile?.display_name || '').toLowerCase().includes(q) ||
        (profile?.name || '').toLowerCase().includes(q)
      )
    })
    : activeFollows

  const filteredBlocked = blockSearch.trim()
    ? blockedArr.filter((pk) => {
      const q = blockSearch.toLowerCase()
      const profile = getProfile(pk)
      const npubStr = nip19.npubEncode(pk)
      return (
        npubStr.toLowerCase().includes(q) ||
        (profile?.display_name || '').toLowerCase().includes(q) ||
        (profile?.name || '').toLowerCase().includes(q)
      )
    })
    : blockedArr

  const followTotalPages = Math.max(1, Math.ceil(filteredFollows.length / PER_PAGE))
  const blockTotalPages = Math.max(1, Math.ceil(filteredBlocked.length / PER_PAGE))

  // Reset page if out of bounds
  useEffect(() => { if (followPage > followTotalPages) setFollowPage(followTotalPages) }, [filteredFollows.length])
  useEffect(() => { if (blockPage > blockTotalPages) setBlockPage(blockTotalPages) }, [filteredBlocked.length])

  const pagedFollows = filteredFollows.slice((followPage - 1) * PER_PAGE, followPage * PER_PAGE)
  const pagedBlocked = filteredBlocked.slice((blockPage - 1) * PER_PAGE, blockPage * PER_PAGE)

  return (
    <div className="space-y-8">
      {/* Following */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">Following ({activeFollows.length})</h3>
        </div>

        {!followsLoaded ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 size={16} className="animate-spin" /> Loading follows...
          </div>
        ) : activeFollows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">Not following anyone yet.</p>
        ) : (
          <div className="space-y-2">
            {activeFollows.length > PER_PAGE && (
              <Input
                placeholder="Search following..."
                value={followSearch}
                onChange={(e) => { setFollowSearch(e.target.value); setFollowPage(1) }}
                className="h-8 text-xs mb-2"
              />
            )}
            {pagedFollows.map((pk) => {
              const profile = getProfile(pk)
              const npubStr = nip19.npubEncode(pk)
              return (
                <div key={pk} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors max-[1080px]:flex-wrap">
                  <button onClick={() => setProfilePubkey(pk)} className="shrink-0 cursor-pointer">
                    <Avatar className="h-9 w-9">
                      {profile?.picture && <AvatarImage src={profile.picture} />}
                      <AvatarFallback className="text-xs bg-primary/20 text-primary">
                        {(profile?.display_name || profile?.name || npubStr).slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setProfilePubkey(pk)}
                        className="text-sm font-medium text-foreground truncate hover:underline cursor-pointer"
                      >
                        {profile?.display_name || profile?.name || truncateNpub(npubStr, 12)}
                      </button>
                      <DnnBadge pubkey={pk} />
                    </div>
                    <SettingsDnnSubline pubkey={pk} npub={npubStr} />
                  </div>
                  <button
                    onClick={() => handleUnfollow(pk)}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer max-[1080px]:w-full max-[1080px]:justify-center max-[1080px]:py-1.5 max-[1080px]:border max-[1080px]:border-border max-[1080px]:rounded-md"
                  >
                    <UserMinus size={12} /> Unfollow
                  </button>
                </div>
              )
            })}
            {/* Pagination */}
            {followTotalPages > 1 && (
              <div className="flex items-center justify-center gap-1 pt-3">
                <button
                  onClick={() => setFollowPage(Math.max(1, followPage - 1))}
                  disabled={followPage <= 1}
                  className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ‹ Prev
                </button>
                {Array.from({ length: followTotalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    onClick={() => setFollowPage(p)}
                    className={`w-7 h-7 rounded text-xs font-medium transition-colors cursor-pointer ${p === followPage ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      }`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  onClick={() => setFollowPage(Math.min(followTotalPages, followPage + 1))}
                  disabled={followPage >= followTotalPages}
                  className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Next ›
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Block List */}
      <div>
        <h3 className="text-lg font-semibold text-foreground mb-4">Blocked Users ({blockedArr.length})</h3>

        {blockedArr.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No blocked users.</p>
        ) : (
          <div className="space-y-2">
            {blockedArr.length > PER_PAGE && (
              <Input
                placeholder="Search blocked users..."
                value={blockSearch}
                onChange={(e) => { setBlockSearch(e.target.value); setBlockPage(1) }}
                className="h-8 text-xs mb-2"
              />
            )}
            {pagedBlocked.map((pk) => {
              const profile = getProfile(pk)
              const npubStr = nip19.npubEncode(pk)
              const bType = blockTypes.get(pk)
              const isPublic = bType === 'public'
              return (
                <div key={pk} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors max-[1080px]:flex-wrap">
                  <button onClick={() => setProfilePubkey(pk)} className="shrink-0 cursor-pointer">
                    <Avatar className="h-9 w-9">
                      {profile?.picture && <AvatarImage src={profile.picture} />}
                      <AvatarFallback className="text-xs bg-destructive/20 text-destructive">
                        {(profile?.display_name || profile?.name || npubStr).slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setProfilePubkey(pk)}
                        className="text-sm font-medium text-foreground truncate hover:underline cursor-pointer"
                      >
                        {profile?.display_name || profile?.name || truncateNpub(npubStr, 12)}
                      </button>
                      <DnnBadge pubkey={pk} />
                      <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${isPublic
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground'
                        }`}>
                        {isPublic ? <Globe size={9} /> : <Lock size={9} />}
                        {isPublic ? 'Public' : 'Private'}
                      </span>
                    </div>
                    <SettingsDnnSubline pubkey={pk} npub={npubStr} />
                  </div>
                  <div className="flex items-center gap-1 max-[1080px]:w-full max-[1080px]:border-t max-[1080px]:border-border max-[1080px]:pt-2 max-[1080px]:mt-1">
                    <button
                      onClick={() => {
                        if (!pubkey) return
                        setSwitchConfirm({ pk, toType: isPublic ? 'private' : 'public' })
                      }}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer max-[1080px]:flex-1 max-[1080px]:justify-center max-[1080px]:py-1.5 max-[1080px]:border max-[1080px]:border-border max-[1080px]:rounded-md"
                    >
                      {isPublic ? <Lock size={11} /> : <Globe size={11} />}
                      {isPublic ? 'Private' : 'Public'}
                    </button>
                    <button
                      onClick={() => setUnblockConfirm(pk)}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer max-[1080px]:flex-1 max-[1080px]:justify-center max-[1080px]:py-1.5 max-[1080px]:border max-[1080px]:border-border max-[1080px]:rounded-md"
                    >
                      <ShieldOff size={12} /> Unblock
                    </button>
                  </div>
                </div>
              )
            })}
            {/* Pagination */}
            {blockTotalPages > 1 && (
              <div className="flex items-center justify-center gap-1 pt-3">
                <button
                  onClick={() => setBlockPage(Math.max(1, blockPage - 1))}
                  disabled={blockPage <= 1}
                  className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ‹ Prev
                </button>
                {Array.from({ length: blockTotalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    onClick={() => setBlockPage(p)}
                    className={`w-7 h-7 rounded text-xs font-medium transition-colors cursor-pointer ${p === blockPage ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      }`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  onClick={() => setBlockPage(Math.min(blockTotalPages, blockPage + 1))}
                  disabled={blockPage >= blockTotalPages}
                  className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Next ›
                </button>
              </div>
            )}
          </div>
        )}

        {/* Hide blocked toggle */}
        <div className="flex items-center justify-between mt-4 px-3 py-2.5 rounded-lg border border-border bg-secondary/30">
          <div>
            <p className="text-sm font-medium text-foreground">Completely hide blocked users' messages</p>
            <p className="text-xs text-muted-foreground">When enabled, messages from blocked users won't appear at all in chat</p>
          </div>
          <ToggleSwitch checked={hideBlockedCompletely} onChange={setHideBlockedCompletely} />
        </div>
      </div>

      {/* Profile Modal */}
      <UserProfileModal
        open={!!profilePubkey}
        onClose={() => setProfilePubkey(null)}
        targetPubkey={profilePubkey}
      />

      {/* Block Type Switch Confirmation */}
      {switchConfirm && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center" onClick={() => setSwitchConfirm(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative z-10 w-full max-w-[380px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">
                Switch to {switchConfirm.toType === 'public' ? 'Public' : 'Private'} Block?
              </h3>
            </div>
            <div className="px-5 py-4 space-y-2">
              {switchConfirm.toType === 'public' ? (
                <>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Switching to <strong className="text-foreground">public</strong> will make this block visible to others. Your followers and Web of Trust connections will be able to see that you've blocked this user.
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    This helps others filter unwanted users from their feeds.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Switching to <strong className="text-foreground">private</strong> will hide this block from others. Only you will know you've blocked this user.
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    This block will no longer contribute to Web of Trust scores for your followers.
                  </p>
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
              <button
                onClick={() => setSwitchConfirm(null)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSwitch}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
              >
                Switch to {switchConfirm.toType === 'public' ? 'Public' : 'Private'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unblock Confirmation */}
      {unblockConfirm && (() => {
        const profile = getProfile(unblockConfirm)
        const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(unblockConfirm), 12)
        return (
          <div className="fixed inset-0 z-[250] flex items-center justify-center" onClick={() => setUnblockConfirm(null)}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
              className="relative z-10 w-full max-w-[380px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 py-4 border-b border-border">
                <h3 className="text-sm font-semibold text-foreground">Unblock User?</h3>
              </div>
              <div className="px-5 py-4">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Are you sure you want to unblock <strong className="text-foreground">{name}</strong>? They will be able to appear in your feeds, chats, and DMs again.
                </p>
              </div>
              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
                <button
                  onClick={() => setUnblockConfirm(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleUnblock(unblockConfirm)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors cursor-pointer"
                >
                  Unblock
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

/* ─────────── DNN / npub subline for settings lists ─────────── */

/** Shows DNN ID when verified, otherwise truncated npub */
function SettingsDnnSubline({ pubkey, npub }: { pubkey: string; npub: string }) {
  const dnnId = useDnnStore((s) => s.verified[pubkey]?.dnnId)
  const status = useDnnStore((s) => s.status[pubkey])

  if (status === 'verified' && dnnId) {
    return (
      <p className="text-xs text-primary/70 font-mono truncate">@{formatDnnId(dnnId)}</p>
    )
  }

  return (
    <p className="text-xs text-muted-foreground font-mono truncate">{truncateNpub(npub, 16)}</p>
  )
}

/* ─────────── Toggle Switch ─────────── */

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-[22px] rounded-full transition-colors cursor-pointer shrink-0
        ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
    >
      <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform
        ${checked ? 'translate-x-[22px]' : 'translate-x-[3px]'}`}
      />
    </button>
  )
}

/* ─────────── Health Check Indicators ─────────── */

type HealthStatus = 'checking' | 'online' | 'offline'

function RelayHealthDot({ url }: { url: string }) {
  const [status, setStatus] = useState<HealthStatus>('checking')
  const [latency, setLatency] = useState<number | null>(null)

  useEffect(() => {
    setStatus('checking')
    setLatency(null)
    const start = Date.now()
    let ws: WebSocket | null = null
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) { settled = true; setStatus('offline'); ws?.close() }
    }, 5000)

    try {
      ws = new WebSocket(url)
      ws.onopen = () => {
        if (!settled) {
          settled = true
          setLatency(Date.now() - start)
          setStatus('online')
          ws?.close()
        }
      }
      ws.onerror = () => {
        if (!settled) { settled = true; setStatus('offline') }
      }
      ws.onclose = () => {
        if (!settled) { settled = true; setStatus('offline') }
      }
    } catch {
      if (!settled) { settled = true; setStatus('offline') }
    }

    return () => { clearTimeout(timeout); settled = true; ws?.close() }
  }, [url])

  const color = status === 'online' ? 'bg-emerald-500' : status === 'offline' ? 'bg-red-500' : 'bg-muted-foreground/40'
  const label = status === 'online'
    ? `Online${latency !== null ? ` (${latency}ms)` : ''}`
    : status === 'offline' ? 'Unreachable' : 'Checking…'

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`shrink-0 w-2.5 h-2.5 rounded-full ${color} ${status === 'checking' ? 'animate-pulse' : ''}`} />
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function BlossomHealthDot({ url }: { url: string }) {
  const [status, setStatus] = useState<HealthStatus>('checking')
  const [latency, setLatency] = useState<number | null>(null)

  useEffect(() => {
    setStatus('checking')
    setLatency(null)
    const start = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    fetch(url, { method: 'HEAD', mode: 'no-cors', signal: controller.signal })
      .then(() => {
        setLatency(Date.now() - start)
        setStatus('online')
      })
      .catch(() => setStatus('offline'))
      .finally(() => clearTimeout(timeout))

    return () => { clearTimeout(timeout); controller.abort() }
  }, [url])

  const color = status === 'online' ? 'bg-emerald-500' : status === 'offline' ? 'bg-red-500' : 'bg-muted-foreground/40'
  const label = status === 'online'
    ? `Reachable${latency !== null ? ` (${latency}ms)` : ''}`
    : status === 'offline' ? 'Unreachable' : 'Checking…'

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`shrink-0 w-2.5 h-2.5 rounded-full ${color} ${status === 'checking' ? 'animate-pulse' : ''}`} />
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/* ─────────── Admin FAQ Section ─────────── */

interface AdminFaqItem {
  id: string
  title: string
  body: string
}

function AdminFaqSection({ pubkey, signer, privateKey }: { pubkey: string | null; signer: ISigner | null; privateKey: string | null }) {
  const [items, setItems] = useState<AdminFaqItem[]>([])
  const [cachedContent, setCachedContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [publishStatus, setPublishStatus] = useState<string | null>(null)
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)

  useEffect(() => {
    if (!pubkey) return
    setLoading(true)
    fetchReplaceable(pubkey, 30078, FAQ_DTAG).then((event) => {
      if (event && event.content) {
        try {
          const arr = JSON.parse(event.content)
          if (Array.isArray(arr)) {
            setItems(arr.map((item: Record<string, unknown>) => ({
              id: crypto.randomUUID(),
              title: (item.title as string) || '',
              body: (item.body as string) || '',
            })))
            setCachedContent(event.content)
          }
        } catch { /* ignore */ }
      }
    }).finally(() => setLoading(false))
  }, [pubkey])

  const itemsToContent = (list: AdminFaqItem[]) =>
    JSON.stringify(list.map(({ title, body }) => ({ title, body })), null, 2)

  const currentContent = itemsToContent(items)
  const hasChanges = currentContent !== cachedContent

  const addItem = () => setItems((prev) => [...prev, { id: crypto.randomUUID(), title: '', body: '' }])
  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id))
  const updateItem = (id: string, patch: Partial<AdminFaqItem>) =>
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, ...patch } : i))

  const moveItem = (idx: number, dir: -1 | 1) => {
    setItems((prev) => {
      const next = [...prev]
      const target = idx + dir
      if (target < 0 || target >= next.length) return prev
        ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  const handlePublish = async () => {
    if (!pubkey || (!signer && !privateKey)) return
    setPublishing(true)
    setPublishStatus(null)
    try {
      const content = itemsToContent(items)
      const unsigned = createUnsignedEvent(30078, content, [['d', FAQ_DTAG]])
      const signed = await signWithSigner(unsigned, signer, privateKey)
      const accepted = await publishToSpecificRelays(getPublishRelays(), signed)
      setCachedContent(content)
      setPublishStatus(`Published to ${accepted.length} relay${accepted.length !== 1 ? 's' : ''}`)
    } catch (err) {
      setPublishStatus(`Error: ${err instanceof Error ? err.message : 'Publishing failed'}`)
    } finally {
      setPublishing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading FAQ...
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-foreground">FAQ Items</h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              Manage FAQ entries shown in Settings → FAQ. Body supports markdown.
            </p>
          </div>
          <button
            onClick={addItem}
            className="flex text-nowrap items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
          >
            <Plus size={14} /> Add Item
          </button>
        </div>

        {items.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">No FAQ items yet. Click &quot;Add Item&quot; to create one.</p>
        )}

        {items.map((item, idx) => (
          <div key={item.id} className="rounded-lg border border-border bg-secondary/10 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-secondary/30 border-b border-border">
              <span className="text-xs text-muted-foreground font-mono">#{idx + 1}</span>
              <div className="flex-1" />
              <Tooltip><TooltipTrigger asChild><button onClick={() => moveItem(idx, -1)} disabled={idx === 0} className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"><ArrowUp size={14} /></button></TooltipTrigger><TooltipContent side="top" className="text-xs">Move up</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><button onClick={() => moveItem(idx, 1)} disabled={idx === items.length - 1} className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"><ArrowDown size={14} /></button></TooltipTrigger><TooltipContent side="top" className="text-xs">Move down</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><button onClick={() => setPreviewIdx(previewIdx === idx ? null : idx)} className={`p-1 rounded hover:bg-secondary/60 transition-colors cursor-pointer ${previewIdx === idx ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}><Eye size={14} /></button></TooltipTrigger><TooltipContent side="top" className="text-xs">Toggle preview</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><button onClick={() => removeItem(item.id)} className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"><Trash2 size={14} /></button></TooltipTrigger><TooltipContent side="top" className="text-xs">Remove item</TooltipContent></Tooltip>
            </div>
            <div className="p-3 space-y-2">
              <input
                type="text"
                placeholder="Question title..."
                value={item.title}
                onChange={(e) => updateItem(item.id, { title: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors"
              />
              {previewIdx === idx ? (
                <div className="px-3 py-3 rounded-lg border border-border bg-background min-h-[120px] prose prose-sm prose-invert max-w-none text-muted-foreground [&_strong]:text-foreground [&_code]:bg-secondary/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono [&_table]:text-xs [&_table]:my-1 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:text-foreground [&_td]:px-3 [&_td]:py-1.5 [&_thead]:bg-secondary/40 [&_thead]:border-b [&_thead]:border-border [&_tbody_tr]:border-b [&_tbody_tr]:border-border [&_table]:w-full [&_table]:border [&_table]:border-border [&_table]:rounded-lg [&_blockquote]:border-l-2 [&_blockquote]:border-amber-500/50 [&_blockquote]:pl-3 [&_blockquote]:text-amber-400 [&_blockquote]:not-italic [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-2">
                  <Markdown remarkPlugins={[remarkGfm]}>{item.body || '*No content yet*'}</Markdown>
                </div>
              ) : (
                <textarea
                  placeholder="Answer body (markdown)..."
                  value={item.body}
                  onChange={(e) => updateItem(item.id, { body: e.target.value })}
                  rows={6}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors font-mono resize-y"
                />
              )}
            </div>
          </div>
        ))}

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handlePublish}
            disabled={!hasChanges || publishing}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
            ${hasChanges && !publishing
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
              }`}
          >
            {publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Publish FAQ
          </button>
          {publishStatus && (
            <span className={`text-xs ${publishStatus.startsWith('Error') ? 'text-destructive' : 'text-emerald-400'}`}>
              {publishStatus}
            </span>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}

/* ─────────── Admin Guides Section ─────────── */

interface AdminGuideRef {
  /** a-tag coordinate: "30023:<pubkey>:<dTag>" */
  coordinate: string
  /** Resolved metadata (from the kind:30023 event) */
  title: string
  summary: string
}

interface AvailableGuide {
  coordinate: string
  title: string
  summary: string
  publishedAt: number
}

function AdminGuidesSection({ pubkey, signer, privateKey }: { pubkey: string | null; signer: ISigner | null; privateKey: string | null }) {
  const [guides, setGuides] = useState<AdminGuideRef[]>([])
  const [cachedContent, setCachedContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [publishStatus, setPublishStatus] = useState<string | null>(null)

  // Picker state
  const [pickerOpen, setPickerOpen] = useState(false)
  const [available, setAvailable] = useState<AvailableGuide[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerSearch, setPickerSearch] = useState('')

  // Load existing guide references from NIP-78
  useEffect(() => {
    if (!pubkey) return
    setLoading(true)
    fetchReplaceable(pubkey, 30078, GUIDES_DTAG).then(async (event) => {
      if (event && event.content) {
        try {
          const coordinates: string[] = JSON.parse(event.content)
          if (Array.isArray(coordinates) && coordinates.length > 0) {
            // Resolve each a-tag to get title/summary for display
            const resolved: AdminGuideRef[] = []
            const filters = coordinates.map((coord) => {
              const parts = coord.split(':')
              if (parts.length >= 3) {
                return { kinds: [parseInt(parts[0])], authors: [parts[1]], '#d': [parts.slice(2).join(':')] }
              }
              return null
            }).filter(Boolean) as { kinds: number[]; authors: string[]; '#d': string[] }[]

            const results = await Promise.allSettled(filters.map((f) => fetchEvents(f)))
            for (let i = 0; i < results.length; i++) {
              const result = results[i]
              if (result.status === 'fulfilled' && result.value.length > 0) {
                const ev = result.value.sort((a, b) => b.created_at - a.created_at)[0]
                const getTag = (name: string) => ev.tags.find((t) => t[0] === name)?.[1] || ''
                resolved.push({
                  coordinate: coordinates[i],
                  title: getTag('title') || coordinates[i],
                  summary: getTag('summary'),
                })
              } else {
                // Couldn't resolve — show coordinate as fallback
                resolved.push({ coordinate: coordinates[i], title: coordinates[i], summary: '' })
              }
            }
            setGuides(resolved)
            setCachedContent(event.content)
          }
        } catch { /* ignore */ }
      }
    }).finally(() => setLoading(false))
  }, [pubkey])

  const coordinatesToContent = (list: AdminGuideRef[]) =>
    JSON.stringify(list.map((g) => g.coordinate), null, 2)

  const currentContent = coordinatesToContent(guides)
  const hasChanges = currentContent !== cachedContent

  const removeGuide = (coord: string) => setGuides((prev) => prev.filter((g) => g.coordinate !== coord))

  const moveGuide = (idx: number, dir: -1 | 1) => {
    setGuides((prev) => {
      const next = [...prev]
      const target = idx + dir
      if (target < 0 || target >= next.length) return prev
        ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  // Fetch available kind:30023 articles for the picker
  const openPicker = async () => {
    setPickerOpen(true)
    setPickerLoading(true)
    setPickerSearch('')
    try {
      const events = await fetchEvents({ kinds: [30023], authors: [pubkey!], '#t': ['guide'] })
      const items: AvailableGuide[] = events.map((ev) => {
        const getTag = (name: string) => ev.tags.find((t) => t[0] === name)?.[1] || ''
        const dTag = getTag('d')
        return {
          coordinate: `30023:${ev.pubkey}:${dTag}`,
          title: getTag('title') || dTag,
          summary: getTag('summary'),
          publishedAt: parseInt(getTag('published_at')) || ev.created_at,
        }
      })
      // Deduplicate by coordinate (keep latest)
      const deduped = new Map<string, AvailableGuide>()
      for (const item of items) {
        const existing = deduped.get(item.coordinate)
        if (!existing || item.publishedAt > existing.publishedAt) {
          deduped.set(item.coordinate, item)
        }
      }
      setAvailable(Array.from(deduped.values()).sort((a, b) => b.publishedAt - a.publishedAt))
    } catch {
      setAvailable([])
    } finally {
      setPickerLoading(false)
    }
  }

  const addGuide = (guide: AvailableGuide) => {
    setGuides((prev) => [...prev, { coordinate: guide.coordinate, title: guide.title, summary: guide.summary }])
    setPickerOpen(false)
  }

  const handlePublish = async () => {
    if (!pubkey || (!signer && !privateKey)) return
    setPublishing(true)
    setPublishStatus(null)
    try {
      const content = coordinatesToContent(guides)
      const unsigned = createUnsignedEvent(30078, content, [['d', GUIDES_DTAG]])
      const signed = await signWithSigner(unsigned, signer, privateKey)
      const accepted = await publishToSpecificRelays(getPublishRelays(), signed)
      setCachedContent(content)
      setPublishStatus(`Published to ${accepted.length} relay${accepted.length !== 1 ? 's' : ''}`)
    } catch (err) {
      setPublishStatus(`Error: ${err instanceof Error ? err.message : 'Publishing failed'}`)
    } finally {
      setPublishing(false)
    }
  }

  // Filter picker items
  const linkedCoords = new Set(guides.map((g) => g.coordinate))
  const filteredAvailable = available.filter((g) => {
    if (linkedCoords.has(g.coordinate)) return false
    if (!pickerSearch.trim()) return true
    const haystack = `${g.title} ${g.summary}`.toLowerCase()
    return pickerSearch.toLowerCase().split(/\s+/).every((w) => haystack.includes(w))
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading guides...
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-foreground">Guide Articles</h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              Link kind:30023 long-form articles (tagged <code className="bg-secondary/60 px-1 py-0.5 rounded text-[10px] font-mono">#t guide</code>) to appear in Settings → Guides.
            </p>
          </div>
          <button
            onClick={openPicker}
            className="flex text-nowrap items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
          >
            <Plus size={14} /> Add Guide
          </button>
        </div>

        {guides.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">No guides linked yet. Click &quot;Add Guide&quot; to link a long-form article.</p>
        )}

        {guides.map((guide, idx) => (
          <div key={guide.coordinate} className="rounded-lg border border-border bg-secondary/10 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-secondary/30 border-b border-border">
              <span className="text-xs text-muted-foreground font-mono">#{idx + 1}</span>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-foreground block truncate">{guide.title}</span>
                {guide.summary && <span className="text-[11px] text-muted-foreground block truncate">{guide.summary}</span>}
              </div>
              <Tooltip><TooltipTrigger asChild><button onClick={() => moveGuide(idx, -1)} disabled={idx === 0} className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"><ArrowUp size={14} /></button></TooltipTrigger><TooltipContent side="top" className="text-xs">Move up</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><button onClick={() => moveGuide(idx, 1)} disabled={idx === guides.length - 1} className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"><ArrowDown size={14} /></button></TooltipTrigger><TooltipContent side="top" className="text-xs">Move down</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><button onClick={() => removeGuide(guide.coordinate)} className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"><Trash2 size={14} /></button></TooltipTrigger><TooltipContent side="top" className="text-xs">Remove</TooltipContent></Tooltip>
            </div>
            <div className="px-3 py-2">
              <span className="text-[10px] text-muted-foreground font-mono break-all">{guide.coordinate}</span>
            </div>
          </div>
        ))}

        {/* Publish */}
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handlePublish}
            disabled={!hasChanges || publishing}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
            ${hasChanges && !publishing
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
              }`}
          >
            {publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Publish Guides
          </button>
          {publishStatus && (
            <span className={`text-xs ${publishStatus.startsWith('Error') ? 'text-destructive' : 'text-emerald-400'}`}>
              {publishStatus}
            </span>
          )}
        </div>
      </div>

      {/* Guide Picker Modal */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setPickerOpen(false)}>
          <div className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[70vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h4 className="text-sm font-semibold text-foreground">Select a Guide Article</h4>
              <button onClick={() => setPickerOpen(false)} className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                <X size={16} />
              </button>
            </div>

            {/* Search */}
            <div className="px-4 py-2 border-b border-border">
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 border border-border">
                <Search size={14} className="text-muted-foreground shrink-0" />
                <input
                  type="text"
                  placeholder="Search articles..."
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                  autoFocus
                />
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
              {pickerLoading ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
                  <Loader2 size={16} className="animate-spin" /> Fetching articles...
                </div>
              ) : filteredAvailable.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                  <BookOpen size={24} className="opacity-30" />
                  <p className="text-sm">{available.length === 0 ? 'No guide articles found.' : 'No matching articles.'}</p>
                  <p className="text-xs text-muted-foreground/60">Publish kind:30023 articles with <code className="bg-secondary/60 px-1 py-0.5 rounded text-[10px] font-mono">#t guide</code> tag.</p>
                </div>
              ) : (
                filteredAvailable.map((g) => (
                  <button
                    key={g.coordinate}
                    onClick={() => addGuide(g)}
                    className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-secondary/50 transition-colors cursor-pointer"
                  >
                    <span className="text-sm font-medium text-foreground block">{g.title}</span>
                    {g.summary && <span className="text-[11px] text-muted-foreground mt-0.5 block line-clamp-2">{g.summary}</span>}
                    <span className="text-[10px] text-muted-foreground/50 mt-1 block">
                      {new Date(g.publishedAt * 1000).toLocaleDateString()}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </TooltipProvider>
  )
}

/* ─────────── Admin Builds Section ─────────── */

interface BuildPlatformEntry {
  id: string
  platform: string
  url: string
  ext: string
  hash: string
  originalFilename: string
  size: number
  mimeType: string
}

interface AdminBuildEntry {
  id: string
  dTag: string
  version: string
  body: string
  sourceUrl: string
  sourceExt: string
  publishedAt: number
  createdAt: number
  platforms: BuildPlatformEntry[]
  isNew: boolean
}

function AdminBuildsSection({ pubkey, signer, privateKey }: { pubkey: string | null; signer: ISigner | null; privateKey: string | null }) {
  const [builds, setBuilds] = useState<AdminBuildEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [publishingId, setPublishingId] = useState<string | null>(null)
  const [publishStatusMap, setPublishStatusMap] = useState<Record<string, string>>({})
  const [previewBody, setPreviewBody] = useState(false)
  // Snapshot of each build's content at last load/publish, for dirty tracking
  const [snapshots, setSnapshots] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<AdminBuildEntry | null>(null)

  useEffect(() => {
    if (!pubkey) return
    setLoading(true)
    fetchEvents({ authors: [pubkey], kinds: [30078] }).then((events) => {
      const parsed: AdminBuildEntry[] = []
      for (const ev of events) {
        const dTag = ev.tags.find((t) => t[0] === 'd')?.[1]
        if (!dTag || !dTag.startsWith(BUILD_DTAG_PREFIX)) continue
        try {
          const data = JSON.parse(ev.content)
          if (data.deleted) continue
          if (ev.tags.some((t) => t[0] === 'deleted')) continue
          if (data.version) {
            parsed.push({
              id: crypto.randomUUID(),
              dTag,
              version: data.version,
              body: data.body || '',
              sourceUrl: data.sourceUrl || '',
              sourceExt: data.sourceExt || '',
              platforms: (Array.isArray(data.platforms) ? data.platforms : []).map((p: Record<string, unknown>) => ({
                id: crypto.randomUUID(),
                platform: (p.platform as string) || '',
                url: (p.url as string) || '',
                ext: (p.ext as string) || '',
                hash: (p.hash as string) || '',
                originalFilename: (p.originalFilename as string) || '',
                size: (p.size as number) || 0,
                mimeType: (p.mimeType as string) || '',
              })),
              publishedAt: data.published_at || ev.created_at,
              createdAt: ev.created_at,
              isNew: false,
            })
          }
        } catch { /* ignore */ }
      }
      parsed.sort((a, b) => b.publishedAt - a.publishedAt)
      setBuilds(parsed)
      // Create initial snapshots for dirty tracking
      const snaps: Record<string, string> = {}
      for (const b of parsed) snaps[b.id] = buildContentKey(b)
      setSnapshots(snaps)
    }).finally(() => setLoading(false))
  }, [pubkey])

  const addBuild = () => {
    const newBuild: AdminBuildEntry = {
      id: crypto.randomUUID(),
      dTag: BUILD_DTAG_PREFIX + crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      version: '',
      body: '',
      sourceUrl: '',
      sourceExt: '',
      publishedAt: 0,
      createdAt: 0,
      platforms: [],
      isNew: true,
    }
    setBuilds((prev) => [...prev, newBuild])
    setEditingId(newBuild.id)
  }

  const removeBuild = (id: string) => {
    const build = builds.find((b) => b.id === id)
    if (!build) return
    if (build.isNew) {
      // New builds haven't been published — just remove locally
      setBuilds((prev) => prev.filter((b) => b.id !== id))
      if (editingId === id) setEditingId(null)
    } else {
      // Published builds need relay deletion — show confirmation
      setDeleteTarget(build)
    }
  }

  const updateBuild = (id: string, patch: Partial<AdminBuildEntry>) =>
    setBuilds((prev) => prev.map((b) => b.id === id ? { ...b, ...patch } : b))

  const addPlatform = (buildId: string) => {
    setBuilds((prev) => prev.map((b) => b.id === buildId ? {
      ...b,
      platforms: [...b.platforms, { id: crypto.randomUUID(), platform: '', url: '', ext: '', hash: '', originalFilename: '', size: 0, mimeType: '' }],
    } : b))
  }

  const updatePlatform = (buildId: string, platId: string, patch: Partial<BuildPlatformEntry>) => {
    setBuilds((prev) => prev.map((b) => b.id === buildId ? {
      ...b,
      platforms: b.platforms.map((p) => p.id === platId ? { ...p, ...patch } : p),
    } : b))
  }

  const removePlatform = (buildId: string, platId: string) => {
    setBuilds((prev) => prev.map((b) => b.id === buildId ? {
      ...b,
      platforms: b.platforms.filter((p) => p.id !== platId),
    } : b))
  }

  const handlePublishBuild = async (build: AdminBuildEntry) => {
    if (!pubkey || (!signer && !privateKey) || !build.version.trim()) return
    setPublishingId(build.id)
    setPublishStatusMap((prev) => ({ ...prev, [build.id]: '' }))
    try {
      const publishedAt = build.publishedAt || Math.floor(Date.now() / 1000)
      const content = JSON.stringify({
        version: build.version,
        body: build.body,
        sourceUrl: build.sourceUrl,
        sourceExt: build.sourceExt,
        published_at: publishedAt,
        platforms: build.platforms.map(({ platform, url, ext, hash, originalFilename, size, mimeType }) => ({ platform, url, ext, hash, originalFilename, size, mimeType })),
      })
      // For existing builds: use created_at + 1 so the replacement doesn't jump in timeline
      // For new builds: use default (now)
      const createdAt = !build.isNew && build.createdAt ? build.createdAt + 1 : undefined
      const unsigned = createUnsignedEvent(30078, content, [['d', build.dTag]], createdAt)
      const signed = await signWithSigner(unsigned, signer, privateKey)
      const publishRelays = getPublishRelays()
      const accepted = await publishToSpecificRelays(publishRelays, signed)
      const newCreatedAt = signed.created_at
      updateBuild(build.id, { isNew: false, publishedAt, createdAt: newCreatedAt })
      // Update snapshot so it's no longer dirty
      setSnapshots((prev) => ({ ...prev, [build.id]: buildContentKey({ ...build, publishedAt }) }))

      // Also publish/update the den-chat-latest pointer event
      const latestContent = JSON.stringify({ version: build.version })
      const aRef = `30078:${pubkey}:${build.dTag}`
      const latestUnsigned = createUnsignedEvent(30078, latestContent, [['d', 'den-chat-latest'], ['a', aRef]])
      const latestSigned = await signWithSigner(latestUnsigned, signer, privateKey)
      await publishToSpecificRelays(publishRelays, latestSigned)

      setPublishStatusMap((prev) => ({ ...prev, [build.id]: `Published to ${accepted.length} relay${accepted.length !== 1 ? 's' : ''}` }))
    } catch (err) {
      setPublishStatusMap((prev) => ({ ...prev, [build.id]: `Error: ${err instanceof Error ? err.message : 'Publishing failed'}` }))
    } finally {
      setPublishingId(null)
    }
  }

  /** Generate a stable content key for dirty comparison */
  function buildContentKey(b: AdminBuildEntry): string {
    return JSON.stringify({
      version: b.version,
      body: b.body,
      sourceUrl: b.sourceUrl,
      sourceExt: b.sourceExt,
      platforms: b.platforms.map(({ platform, url, ext, hash, originalFilename, size, mimeType }) => ({ platform, url, ext, hash, originalFilename, size, mimeType })),
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading builds...
      </div>
    )
  }

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold text-foreground">Builds</h4>
              <p className="text-xs text-muted-foreground mt-0.5">
                Publish release builds shown in Settings → Updates.
              </p>
            </div>
            <button
              onClick={addBuild}
              className="flex text-nowrap items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-secondary/40 text-xs font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
            >
              <Plus size={14} /> New Build
            </button>
          </div>

          {builds.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No builds yet. Click &quot;New Build&quot; to create one.</p>
          )}

          {builds.map((build) => {
            const isEditing = editingId === build.id
            return (
              <div key={build.id} className="rounded-lg border border-border bg-secondary/10 overflow-hidden">
                {/* Header */}
                <div className="flex items-center gap-2 px-3 py-2 bg-secondary/30 border-b border-border">
                  <span className="text-xs font-mono text-muted-foreground truncate flex-1">{build.version || '(untitled)'}</span>
                  {build.isNew && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">NEW</span>}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setEditingId(isEditing ? null : build.id)}
                        className={`p-1 rounded hover:bg-secondary/60 transition-colors cursor-pointer ${isEditing ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                      >
                        <Pencil size={14} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">{isEditing ? 'Close editor' : 'Edit'}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => removeBuild(build.id)}
                        className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                      >
                        <Trash2 size={14} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">Remove</TooltipContent>
                  </Tooltip>
                </div>

                {/* Editor */}
                {isEditing && (
                  <div className="p-3 space-y-3">
                    {/* Version */}
                    <div>
                      <label className="text-xs font-medium text-foreground mb-1 block">Version / Title</label>
                      <input
                        type="text"
                        placeholder="e.g. v0.3.0-beta"
                        value={build.version}
                        onChange={(e) => updateBuild(build.id, { version: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors"
                      />
                    </div>

                    {/* Body */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-foreground">Release Notes (markdown)</label>
                        <button
                          onClick={() => setPreviewBody(!previewBody)}
                          className={`text-xs px-2 py-0.5 rounded cursor-pointer transition-colors ${previewBody ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                          {previewBody ? 'Edit' : 'Preview'}
                        </button>
                      </div>
                      {previewBody ? (
                        <div className="px-3 py-3 rounded-lg border border-border bg-background min-h-[100px] prose prose-sm prose-invert max-w-none text-muted-foreground [&_strong]:text-foreground [&_code]:bg-secondary/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_a]:text-primary [&_a]:underline [&_p]:my-2">
                          <Markdown remarkPlugins={[remarkGfm]}>{build.body || '*No content yet*'}</Markdown>
                        </div>
                      ) : (
                        <textarea
                          placeholder="What changed in this release..."
                          value={build.body}
                          onChange={(e) => updateBuild(build.id, { body: e.target.value })}
                          rows={5}
                          className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors font-mono resize-y"
                        />
                      )}
                    </div>

                    {/* Source Code URL */}
                    <BuildSourceUploadField
                      url={build.sourceUrl}
                      onUpdate={(url, ext) => updateBuild(build.id, { sourceUrl: url, ...(ext !== undefined ? { sourceExt: ext } : {}) })}
                      signer={signer}
                      privateKey={privateKey}
                    />

                    {/* Platforms */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs font-medium text-foreground">Platform Downloads</label>
                        <button
                          onClick={() => addPlatform(build.id)}
                          className="flex items-center gap-1 px-2 py-1 rounded border border-border bg-secondary/40 text-[11px] font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
                        >
                          <Plus size={12} /> Add Platform
                        </button>
                      </div>
                      <div className="space-y-2">
                        {build.platforms.map((plat) => (
                          <BuildPlatformRow
                            key={plat.id}
                            plat={plat}
                            onUpdate={(patch) => updatePlatform(build.id, plat.id, patch)}
                            onRemove={() => removePlatform(build.id, plat.id)}
                            signer={signer}
                            privateKey={privateKey}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Publish this build */}
                    {(() => {
                      const isPublishing = publishingId === build.id
                      const isDirty = build.isNew || buildContentKey(build) !== (snapshots[build.id] || '')
                      const status = publishStatusMap[build.id]
                      return (
                        <div className="flex items-center gap-3 pt-1">
                          <button
                            onClick={() => handlePublishBuild(build)}
                            disabled={!build.version.trim() || isPublishing || !isDirty}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
                          ${build.version.trim() && !isPublishing && isDirty
                                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                                : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
                              }`}
                          >
                            {isPublishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                            {isDirty ? 'Publish Build' : 'Published'}
                          </button>
                          {status && (
                            <span className={`text-xs ${status.startsWith('Error') ? 'text-destructive' : 'text-emerald-400'}`}>
                              {status}
                            </span>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </TooltipProvider>

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <DeleteConfirmDialog
          title="Delete Build Release"
          description="This will mark the build as deleted and send a deletion request to relays. The build data may still be cached by some relays."
          progressSteps={[
            'Marking build as deleted...',
            'Publishing deleted version...',
            'Sending deletion request...',
          ]}
          confirmLabel="Yes, Delete Build"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            if (!pubkey || (!signer && !privateKey)) return
            const build = deleteTarget
            const publishRelays = getPublishRelays()

            // Step 1+2: Re-publish with deleted content (replaces original on relay)
            // Use created_at + 1 so the replacement doesn't jump in timeline (consistent with other soft-deletes)
            const deletedContent = JSON.stringify({ deleted: true })
            const deleteCreatedAt = build.createdAt ? build.createdAt + 1 : undefined
            const unsigned = createUnsignedEvent(30078, deletedContent, [['d', build.dTag], ['deleted', 'true']], deleteCreatedAt)
            const signed = await signWithSigner(unsigned, signer, privateKey)
            await publishToSpecificRelays(publishRelays, signed)

            // Step 3: NIP-09 deletion request
            const aRef = `30078:${pubkey}:${build.dTag}`
            const deletionEvent = createDeletionEvent([], [aRef], 'User requested deletion')
            const signedDeletion = await signWithSigner(deletionEvent, signer, privateKey)
            await publishToSpecificRelays(publishRelays, signedDeletion)

            // Remove from local state
            setBuilds((prev) => prev.filter((b) => b.id !== build.id))
            if (editingId === build.id) setEditingId(null)
            setDeleteTarget(null)
          }}
        />
      )}
    </>
  )
}

/* ─── Build Platform Row with Upload ─── */

function formatBuildFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function MetadataRow({ label, value, mono, copiable }: { label: string; value: string; mono?: boolean; copiable?: boolean }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className={`text-xs text-foreground break-all flex-1 ${mono ? 'font-mono' : ''} ${value === '—' ? 'text-muted-foreground' : ''}`}>
          {value}
        </span>
        {copiable && value !== '—' && (
          <button onClick={handleCopy} className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0">
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>
        )}
      </div>
    </div>
  )
}

function BuildPlatformRow({ plat, onUpdate, onRemove, signer, privateKey }: {
  plat: BuildPlatformEntry
  onUpdate: (patch: Partial<BuildPlatformEntry>) => void
  onRemove: () => void
  signer: ISigner | null
  privateKey: string | null
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; serverUrl: string; serverIndex: number; totalServers: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [metadataOpen, setMetadataOpen] = useState(false)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    // Extract extension from original filename
    const nameParts = file.name.split('.')
    const fileExt = nameParts.length > 1 ? '.' + nameParts.pop() : ''

    setUploading(true)
    setError(null)
    setSuccessMsg(null)
    setProgress(null)
    try {
      const buffer = await file.arrayBuffer()
      const data = new Uint8Array(buffer)
      const { hash, serverUrls, successCount } = await uploadToBlossomServers(
        data, signer || null, privateKey || null, undefined, file.type,
        (p) => setProgress({ percent: p.percent, serverUrl: p.serverUrl, serverIndex: p.serverIndex, totalServers: p.totalServers }),
        () => { const c = new AbortController(); uploadAbortRef.current = c; return c.signal },
      )
      const baseUrl = serverUrls[0] || 'https://blossom.primal.net'
      onUpdate({ url: `${baseUrl}/${hash}`, ext: fileExt, hash, originalFilename: file.name, size: file.size, mimeType: file.type })
      setProgress(null)
      setSuccessMsg(`Uploaded to ${successCount} server${successCount !== 1 ? 's' : ''}`)
      setTimeout(() => setSuccessMsg(null), 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      setProgress(null)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex items-start gap-2 p-2 rounded-lg bg-secondary/20 border border-border">
      <div className="flex-1 space-y-1.5">
        <DeviceSelect
          value={plat.platform}
          onChange={(v) => onUpdate({ platform: v })}
          placeholder="Select platform…"
          options={[
            { value: 'Windows x64', label: 'Windows x64' },
            { value: 'Windows ARM', label: 'Windows ARM' },
            { value: 'Linux AppImage x64', label: 'Linux AppImage x64' },
            { value: 'Linux AppImage ARM', label: 'Linux AppImage ARM' },
            { value: 'Linux deb x64', label: 'Linux .deb x64' },
            { value: 'Linux deb ARM', label: 'Linux .deb ARM' },
            { value: 'Linux rpm x64', label: 'Linux .rpm x64' },
            { value: 'Linux rpm ARM', label: 'Linux .rpm ARM' },
            { value: 'macOS Intel', label: 'macOS Intel' },
            { value: 'macOS ARM', label: 'macOS ARM' },
          ]}
        />
        <div className="flex gap-1.5">
          <input
            type="text"
            placeholder="Download URL"
            value={plat.url}
            onChange={(e) => onUpdate({ url: e.target.value })}
            className="flex-1 px-2.5 py-1.5 rounded border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors font-mono"
          />
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelect} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1 px-2 py-1.5 rounded border border-border bg-secondary/40 text-[11px] font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                Upload
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Upload file to Blossom</TooltipContent>
          </Tooltip>
        </div>
        {/* SHA-256 Hash */}
        <div className="flex gap-1.5 items-center">
          <input
            type="text"
            placeholder="SHA-256 hash (auto-filled on upload, or paste for external URLs)"
            value={plat.hash}
            onChange={(e) => onUpdate({ hash: e.target.value.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 64) })}
            className={`flex-1 px-2.5 py-1.5 rounded border bg-background text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors font-mono ${
              plat.hash
                ? plat.hash.length === 64
                  ? 'border-emerald-500/40'
                  : 'border-amber-500/40'
                : 'border-border'
            }`}
          />
          {plat.hash && plat.hash.length === 64 && (
            <Check size={14} className="text-emerald-400 shrink-0" />
          )}
          {plat.hash && plat.hash.length !== 64 && (
            <span className="text-[10px] text-amber-400 shrink-0 whitespace-nowrap">{plat.hash.length}/64</span>
          )}
        </div>
        {/* Upload progress */}
        {uploading && progress && (
          <div className="mt-1">
            <div className="w-full h-1 rounded-full bg-secondary overflow-hidden">
              <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${progress.percent}%` }} />
            </div>
            <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-0.5">
              <span className="truncate">{new URL(progress.serverUrl).hostname} ({progress.serverIndex + 1}/{progress.totalServers})</span>
              <span className="flex items-center gap-1">
                {progress.percent >= 100 ? 'Processing...' : `${progress.percent}%`}
                <button
                  onClick={() => { uploadAbortRef.current?.abort(); uploadAbortRef.current = null }}
                  className="text-muted-foreground hover:text-destructive cursor-pointer flex items-center gap-0.5 ml-0.5"
                >
                  <XCircle size={10} /><span className="text-[9px]">Skip</span>
                </button>
              </span>
            </div>
          </div>
        )}
        {/* Error */}
        {error && (
          <p className="text-[10px] text-destructive mt-0.5">{error}</p>
        )}
        {/* Success */}
        {successMsg && (
          <p className="text-[10px] text-emerald-400 mt-0.5">✓ {successMsg}</p>
        )}
      </div>
      <div className="flex flex-col gap-1 mt-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setMetadataOpen(true)}
              disabled={!plat.url}
              className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Info size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">File metadata</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRemove}
              className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
            >
              <Trash2 size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Remove platform</TooltipContent>
        </Tooltip>
      </div>

      {/* File Metadata Modal */}
      {metadataOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setMetadataOpen(false)}>
          <div className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2"><Info size={14} className="text-primary" /> File Metadata</h4>
              <button onClick={() => setMetadataOpen(false)} className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              {/* Original Filename */}
              <MetadataRow label="Original Filename" value={plat.originalFilename || '—'} />

              {/* Extension (editable) */}
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Extension</span>
                <div className="flex items-center gap-2 mt-0.5">
                  <input
                    type="text"
                    value={plat.ext}
                    onChange={(e) => onUpdate({ ext: e.target.value })}
                    placeholder="e.g. .exe"
                    className="flex-1 px-2.5 py-1.5 rounded border border-border bg-secondary/30 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors font-mono"
                  />
                  <span className="text-[10px] text-muted-foreground">editable</span>
                </div>
              </div>

              {/* File Size */}
              <MetadataRow label="File Size" value={plat.size ? formatBuildFileSize(plat.size) : '—'} />

              {/* SHA-256 Hash (editable — auto-filled for Blossom uploads) */}
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">SHA-256 Hash</span>
                <div className="flex items-center gap-2 mt-0.5">
                  <input
                    type="text"
                    value={plat.hash}
                    onChange={(e) => onUpdate({ hash: e.target.value.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 64) })}
                    placeholder="Paste SHA-256 hash for non-Blossom URLs"
                    className="flex-1 px-2.5 py-1.5 rounded border border-border bg-secondary/30 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors font-mono"
                  />
                  {plat.hash && (
                    <button
                      onClick={() => { navigator.clipboard.writeText(plat.hash); }}
                      className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
                    >
                      <Copy size={12} />
                    </button>
                  )}
                </div>
                {plat.hash && plat.hash.length !== 64 && (
                  <p className="text-[10px] text-amber-400 mt-0.5">Hash should be 64 hex characters</p>
                )}
              </div>

              {/* MIME Type */}
              <MetadataRow label="MIME Type" value={plat.mimeType || '—'} />

              {/* Download URL */}
              <MetadataRow label="Download URL" value={plat.url || '—'} mono copiable />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Source Code URL with Upload ─── */

function BuildSourceUploadField({ url, onUpdate, signer, privateKey }: {
  url: string
  onUpdate: (url: string, ext?: string) => void
  signer: ISigner | null
  privateKey: string | null
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; serverUrl: string; serverIndex: number; totalServers: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const nameParts = file.name.split('.')
    const fileExt = nameParts.length > 1 ? '.' + nameParts.pop() : ''

    setUploading(true)
    setError(null)
    setSuccessMsg(null)
    setProgress(null)
    try {
      const buffer = await file.arrayBuffer()
      const data = new Uint8Array(buffer)
      const { hash, serverUrls, successCount } = await uploadToBlossomServers(
        data, signer || null, privateKey || null, undefined, file.type || 'application/zip',
        (p) => setProgress({ percent: p.percent, serverUrl: p.serverUrl, serverIndex: p.serverIndex, totalServers: p.totalServers }),
        () => { const c = new AbortController(); uploadAbortRef.current = c; return c.signal },
      )
      const baseUrl = serverUrls[0] || 'https://blossom.primal.net'
      onUpdate(`${baseUrl}/${hash}`, fileExt)
      setProgress(null)
      setSuccessMsg(`Uploaded to ${successCount} server${successCount !== 1 ? 's' : ''}`)
      setTimeout(() => setSuccessMsg(null), 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      setProgress(null)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <label className="text-xs font-medium text-foreground mb-1 block">Source Code URL</label>
      <div className="flex gap-1.5">
        <input
          type="text"
          placeholder="e.g. https://github.com/org/repo/archive/refs/tags/v0.3.0.zip"
          value={url}
          onChange={(e) => onUpdate(e.target.value)}
          className="flex-1 px-2.5 py-1.5 rounded border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors font-mono"
        />
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelect} />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1 px-2 py-1.5 rounded border border-border bg-secondary/40 text-[11px] font-medium text-foreground hover:bg-secondary/70 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              Upload
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Upload source archive to Blossom</TooltipContent>
        </Tooltip>
      </div>
      {uploading && progress && (
        <div className="mt-1">
          <div className="w-full h-1 rounded-full bg-secondary overflow-hidden">
            <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-0.5">
            <span className="truncate">{new URL(progress.serverUrl).hostname} ({progress.serverIndex + 1}/{progress.totalServers})</span>
            <span className="flex items-center gap-1">
              {progress.percent >= 100 ? 'Processing...' : `${progress.percent}%`}
              <button
                onClick={() => { uploadAbortRef.current?.abort(); uploadAbortRef.current = null }}
                className="text-muted-foreground hover:text-destructive cursor-pointer flex items-center gap-0.5 ml-0.5"
              >
                <XCircle size={10} /><span className="text-[9px]">Skip</span>
              </button>
            </span>
          </div>
        </div>
      )}
      {error && (
        <p className="text-[10px] text-destructive mt-0.5">{error}</p>
      )}
      {successMsg && (
        <p className="text-[10px] text-emerald-400 mt-0.5">✓ {successMsg}</p>
      )}
    </div>
  )
}

/* ─────────── Sponsors ─────────── */

const SPONSORS_DTAG_PREFIX = 'den-sponsors-'
const SPONSOR_TIERS = ['mythic', 'legendary', 'epic', 'rare', 'common'] as const
type SponsorTier = typeof SPONSOR_TIERS[number]

const TIER_LABELS: Record<SponsorTier, string> = {
  mythic: 'Mythic',
  legendary: 'Legendary',
  epic: 'Epic',
  rare: 'Rare',
  common: 'Common',
}

const TIER_COLORS: Record<SponsorTier, string> = {
  mythic: 'text-orange-400',
  legendary: 'text-amber-400',
  epic: 'text-purple-400',
  rare: 'text-blue-400',
  common: 'text-muted-foreground',
}

const TIER_PRICES: Record<SponsorTier, string> = {
  mythic: '$100k/yr or 1 BTC/yr',
  legendary: '$50k/yr or 0.5 BTC/yr',
  epic: '$10k/yr or 0.1 BTC/yr',
  rare: '$3k/yr or 0.03 BTC/yr',
  common: '$1k/yr or 0.01 BTC/yr',
}

interface SponsorEntry {
  id: string
  name: string
  logo: string
  link: string
}

interface TierData {
  sponsors: SponsorEntry[]
  anonymous: number
}

type SponsorsData = Record<SponsorTier, TierData>

function emptySponsorsData(): SponsorsData {
  return Object.fromEntries(SPONSOR_TIERS.map(t => [t, { sponsors: [], anonymous: 0 }])) as SponsorsData
}

function sponsorsToJson(year: number, data: SponsorsData): string {
  const tiers: Record<string, { sponsors: { name: string; logo: string; link: string }[]; anonymous: number }> = {}
  for (const tier of SPONSOR_TIERS) {
    tiers[tier] = {
      sponsors: data[tier].sponsors.map(s => ({ name: s.name, logo: s.logo, link: s.link })),
      anonymous: data[tier].anonymous,
    }
  }
  return JSON.stringify({ year, tiers })
}

function parseSponsorsJson(json: string): { year: number; data: SponsorsData } | null {
  try {
    const obj = JSON.parse(json)
    if (!obj.year || !obj.tiers) return null
    const data = emptySponsorsData()
    for (const tier of SPONSOR_TIERS) {
      if (obj.tiers[tier]) {
        data[tier] = {
          sponsors: (Array.isArray(obj.tiers[tier].sponsors) ? obj.tiers[tier].sponsors : []).map((s: Record<string, string>) => ({
            id: crypto.randomUUID(),
            name: s.name || '',
            logo: s.logo || '',
            link: s.link || '',
          })),
          anonymous: typeof obj.tiers[tier].anonymous === 'number' ? obj.tiers[tier].anonymous : 0,
        }
      }
    }
    return { year: obj.year, data }
  } catch {
    return null
  }
}

function AdminSponsorsSection({ pubkey, signer, privateKey }: { pubkey: string | null; signer: ISigner | null; privateKey: string | null }) {
  const [yearEntries, setYearEntries] = useState<{ year: number; data: SponsorsData; cachedJson: string; publishStatus: string | null; publishing: boolean }[]>([])
  const [loading, setLoading] = useState(true)
  const [openYear, setOpenYear] = useState<number | null>(null)
  const [newYearInput, setNewYearInput] = useState('')
  const [newYearError, setNewYearError] = useState<string | null>(null)

  // Fetch all existing sponsor events on mount
  useEffect(() => {
    if (!pubkey) return
    setLoading(true)
    fetchEvents({ authors: [pubkey], kinds: [30078] }).then((events) => {
      const entries: typeof yearEntries = []
      for (const ev of events) {
        const dTag = ev.tags.find((t) => t[0] === 'd')?.[1]
        if (!dTag || !dTag.startsWith(SPONSORS_DTAG_PREFIX)) continue
        const parsed = parseSponsorsJson(ev.content)
        if (!parsed) continue
        // Deduplicate by year — keep latest
        const existing = entries.find(e => e.year === parsed.year)
        if (existing) {
          const existingJson = sponsorsToJson(existing.year, existing.data)
          const newJson = sponsorsToJson(parsed.year, parsed.data)
          if (ev.created_at > 0) { // always replace if we find another
            existing.data = parsed.data
            existing.cachedJson = newJson
          }
        } else {
          const json = sponsorsToJson(parsed.year, parsed.data)
          entries.push({ year: parsed.year, data: parsed.data, cachedJson: json, publishStatus: null, publishing: false })
        }
      }
      entries.sort((a, b) => b.year - a.year)
      setYearEntries(entries)
      if (entries.length > 0) setOpenYear(entries[0].year)
    }).finally(() => setLoading(false))
  }, [pubkey])

  const addYear = () => {
    const y = parseInt(newYearInput)
    if (isNaN(y) || y < 2026 || y > 2999) {
      setNewYearError('Year must be between 2026 and 2999')
      return
    }
    if (yearEntries.some(e => e.year === y)) {
      setNewYearError(`${y} already exists`)
      return
    }
    setNewYearError(null)
    const entry = { year: y, data: emptySponsorsData(), cachedJson: '', publishStatus: null, publishing: false }
    setYearEntries(prev => [entry, ...prev].sort((a, b) => b.year - a.year))
    setOpenYear(y)
    setNewYearInput('')
  }

  const updateYearEntry = (year: number, patch: Partial<typeof yearEntries[0]>) => {
    setYearEntries(prev => prev.map(e => e.year === year ? { ...e, ...patch } : e))
  }

  const addSponsor = (year: number, tier: SponsorTier) => {
    setYearEntries(prev => prev.map(e => {
      if (e.year !== year) return e
      return { ...e, data: { ...e.data, [tier]: { ...e.data[tier], sponsors: [...e.data[tier].sponsors, { id: crypto.randomUUID(), name: '', logo: '', link: '' }] } } }
    }))
  }

  const removeSponsor = (year: number, tier: SponsorTier, id: string) => {
    setYearEntries(prev => prev.map(e => {
      if (e.year !== year) return e
      return { ...e, data: { ...e.data, [tier]: { ...e.data[tier], sponsors: e.data[tier].sponsors.filter(s => s.id !== id) } } }
    }))
  }

  const updateSponsor = (year: number, tier: SponsorTier, id: string, patch: Partial<SponsorEntry>) => {
    setYearEntries(prev => prev.map(e => {
      if (e.year !== year) return e
      return { ...e, data: { ...e.data, [tier]: { ...e.data[tier], sponsors: e.data[tier].sponsors.map(s => s.id === id ? { ...s, ...patch } : s) } } }
    }))
  }

  const setAnonymous = (year: number, tier: SponsorTier, count: number) => {
    setYearEntries(prev => prev.map(e => {
      if (e.year !== year) return e
      return { ...e, data: { ...e.data, [tier]: { ...e.data[tier], anonymous: Math.max(0, count) } } }
    }))
  }

  const handlePublish = async (year: number) => {
    if (!pubkey || (!signer && !privateKey)) return
    const entry = yearEntries.find(e => e.year === year)
    if (!entry) return
    updateYearEntry(year, { publishing: true, publishStatus: null })
    try {
      const content = sponsorsToJson(year, entry.data)
      const dTag = SPONSORS_DTAG_PREFIX + year
      const unsigned = createUnsignedEvent(30078, content, [['d', dTag], ['first_year', '2026']])
      const signed = await signWithSigner(unsigned, signer, privateKey)
      const accepted = await publishToSpecificRelays(getPublishRelays(), signed)
      updateYearEntry(year, { cachedJson: content, publishing: false, publishStatus: `Published to ${accepted.length} relay${accepted.length !== 1 ? 's' : ''}` })
    } catch (err) {
      updateYearEntry(year, { publishing: false, publishStatus: `Error: ${err instanceof Error ? err.message : 'Publishing failed'}` })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading sponsors...
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Sponsors</h4>
          <p className="text-xs text-muted-foreground mt-0.5">Manage sponsor tiers and entries per year.</p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={newYearInput}
            onChange={(e) => { setNewYearInput(e.target.value.replace(/\D/g, '').slice(0, 4)); setNewYearError(null) }}
            placeholder="Year"
            className="h-8 w-20 text-xs text-center"
          />
          <button
            onClick={addYear}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer"
          >
            <Plus size={13} /> Add Year
          </button>
        </div>
      </div>
      {newYearError && <p className="text-xs text-destructive -mt-3">{newYearError}</p>}

      {yearEntries.length === 0 && (
        <p className="text-xs text-muted-foreground/50 text-center py-8">No sponsor years yet. Add a year to get started.</p>
      )}

      {/* Year accordions */}
      {yearEntries.map(entry => {
        const isOpen = openYear === entry.year
        const currentJson = sponsorsToJson(entry.year, entry.data)
        const hasChanges = currentJson !== entry.cachedJson
        const totalSponsors = SPONSOR_TIERS.reduce((sum, t) => sum + entry.data[t].sponsors.length + entry.data[t].anonymous, 0)

        return (
          <div key={entry.year} className="rounded-xl border border-border overflow-hidden bg-secondary/20">
            {/* Year accordion header */}
            <button
              onClick={() => setOpenYear(isOpen ? null : entry.year)}
              className="flex items-center justify-between w-full px-4 py-3 text-left cursor-pointer hover:bg-secondary/40 transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-foreground">{entry.year}</span>
                <span className="text-xs text-muted-foreground">{totalSponsors} sponsor{totalSponsors !== 1 ? 's' : ''}</span>
                {hasChanges && <span className="text-[10px] text-amber-400 font-medium">● unsaved</span>}
              </div>
              <svg className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isOpen && (
              <div className="border-t border-border/50 px-4 py-4 space-y-5">
                {/* Tiers */}
                {SPONSOR_TIERS.map(tier => (
                  <div key={tier} className="rounded-lg border border-border/50 bg-secondary/10 overflow-hidden">
                    {/* Tier header */}
                    <div className="px-3 py-2.5 border-b border-border/30 flex items-center justify-between bg-secondary/20">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold ${TIER_COLORS[tier]}`}>{TIER_LABELS[tier]}</span>
                        <span className="text-[10px] text-muted-foreground">{TIER_PRICES[tier]}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground">Anonymous:</span>
                        <Input
                          type="number"
                          min={0}
                          value={entry.data[tier].anonymous}
                          onChange={(e) => setAnonymous(entry.year, tier, parseInt(e.target.value) || 0)}
                          className="w-14 h-7 text-xs text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </div>
                    </div>

                    {/* Sponsors list */}
                    <div className="p-3 space-y-2.5">
                      {entry.data[tier].sponsors.length === 0 && (
                        <p className="text-xs text-muted-foreground/50 text-center py-1.5">No sponsors in this tier yet.</p>
                      )}
                      {entry.data[tier].sponsors.map((sponsor) => (
                        <SponsorEntryEditor
                          key={sponsor.id}
                          sponsor={sponsor}
                          tier={tier}
                          signer={signer}
                          privateKey={privateKey}
                          onUpdate={(patch) => updateSponsor(entry.year, tier, sponsor.id, patch)}
                          onRemove={() => removeSponsor(entry.year, tier, sponsor.id)}
                        />
                      ))}
                      <button
                        onClick={() => addSponsor(entry.year, tier)}
                        className="flex items-center gap-1.5 text-xs text-primary font-medium hover:text-primary/80 transition-colors cursor-pointer"
                      >
                        <Plus size={13} /> Add Sponsor
                      </button>
                    </div>
                  </div>
                ))}

                {/* Per-year publish */}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={() => handlePublish(entry.year)}
                    disabled={entry.publishing || !hasChanges}
                    className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {entry.publishing ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    {entry.publishing ? 'Publishing...' : `Publish ${entry.year}`}
                  </button>
                  {entry.publishStatus && (
                    <span className={`text-xs ${entry.publishStatus.startsWith('Error') ? 'text-destructive' : 'text-emerald-400'}`}>
                      {entry.publishStatus}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ── Sponsor Entry Editor ── */

function SponsorEntryEditor({
  sponsor, tier, signer, privateKey, onUpdate, onRemove,
}: {
  sponsor: SponsorEntry
  tier: SponsorTier
  signer: ISigner | null
  privateKey: string | null
  onUpdate: (patch: Partial<SponsorEntry>) => void
  onRemove: () => void
}) {
  const logoUpload = useMediaUpload(signer, privateKey)
  const logoInputRef = useRef<HTMLInputElement>(null)
  const isCommon = tier === 'common'

  // When logo upload completes, set URL
  useEffect(() => {
    if (logoUpload.allSuccess && logoUpload.pendingFiles.length > 0) {
      const urls = logoUpload.getUploadedUrls()
      if (urls.length > 0 && urls[0] !== sponsor.logo) {
        onUpdate({ logo: urls[0] })
      }
    }
  }, [logoUpload.allSuccess, logoUpload.pendingFiles])

  return (
    <div className="rounded-lg border border-border/50 bg-secondary/10 p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Logo preview */}
          {!isCommon && sponsor.logo && (
            <img src={sponsor.logo} alt="" className="w-8 h-8 rounded object-cover border border-border/50" />
          )}
          <span className="text-xs font-medium text-foreground">{sponsor.name || 'Unnamed'}</span>
        </div>
        <button onClick={onRemove} className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer">
          <Trash2 size={13} />
        </button>
      </div>

      {/* Name */}
      <div className="space-y-1">
        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Name</label>
        <Input
          value={sponsor.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="Sponsor name"
          className="h-8 text-xs"
        />
      </div>

      {/* Logo (hidden for Common) */}
      {!isCommon && (
        <div className="space-y-1">
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Logo</label>
          <div className="flex items-center gap-2">
            <Input
              value={sponsor.logo}
              onChange={(e) => onUpdate({ logo: e.target.value })}
              placeholder="https://... or upload"
              className="h-8 text-xs flex-1"
            />
            <input ref={logoInputRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { if (e.target.files) { logoUpload.addFiles(Array.from(e.target.files)); e.target.value = '' } }} />
            <button onClick={() => logoInputRef.current?.click()} className="p-1.5 rounded-lg border border-border bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors cursor-pointer shrink-0">
              <Upload size={13} />
            </button>
          </div>
          <MediaUploadStrip
            pendingFiles={logoUpload.pendingFiles}
            isUploading={logoUpload.isUploading}
            onRemove={logoUpload.removeFile}
            onUpload={logoUpload.uploadAll}
            onRetry={(id) => { logoUpload.setPendingFiles((prev) => prev.map((f) => f.id === id ? { ...f, status: 'pending' as const } : f)); logoUpload.uploadAll() }}
            onSkipServer={() => logoUpload.uploadAbortRef.current?.abort()}
            fileSizeWarning={logoUpload.fileSizeWarning}
            onDismissSizeWarning={logoUpload.dismissSizeWarning}
          />
        </div>
      )}

      {/* Link */}
      <div className="space-y-1">
        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Link</label>
        <Input
          value={sponsor.link}
          onChange={(e) => onUpdate({ link: e.target.value })}
          placeholder="https://sponsor-website.com"
          className="h-8 text-xs"
        />
      </div>
    </div>
  )
}
