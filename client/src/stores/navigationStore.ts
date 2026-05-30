/**
 * Lightweight navigation store for cross-component page navigation
 * (e.g., clicking "DM" in a profile modal navigates to the DMs page)
 */
import { create } from 'zustand'

type ActivePage = 'hubs' | 'dms' | 'social' | 'discover' | 'settings' | 'wallet' | 'public-chat'
type MobileView = 'home' | 'chat'

interface NavigationStore {
  activePage: ActivePage
  setActivePage: (page: ActivePage) => void
  /** Optional: which tab to open when navigating to settings */
  settingsTab: string | null
  setSettingsTab: (tab: string | null) => void
  /** Optional: prefill a search/filter field when navigating to a settings tab */
  settingsSearchPrefill: string | null
  setSettingsSearchPrefill: (value: string | null) => void
  /** Global trigger for the Join/Create Hub choice modal */
  showHubChoiceModal: boolean
  setShowHubChoiceModal: (show: boolean) => void

  // ── Mobile navigation ──
  /** Which view is active on mobile: 'home' (sidebar+channels) or 'chat' (full-screen chat) */
  mobileView: MobileView
  setMobileView: (view: MobileView) => void
  /** Whether the mobile members overlay is visible */
  showMobileMembers: boolean
  setShowMobileMembers: (show: boolean) => void
}

export const useNavigationStore = create<NavigationStore>((set) => ({
  activePage: 'hubs',
  setActivePage: (page) => set({ activePage: page }),
  settingsTab: null,
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  settingsSearchPrefill: null,
  setSettingsSearchPrefill: (value) => set({ settingsSearchPrefill: value }),
  showHubChoiceModal: false,
  setShowHubChoiceModal: (show) => set({ showHubChoiceModal: show }),
  mobileView: 'home',
  setMobileView: (view) => set({ mobileView: view }),
  showMobileMembers: false,
  setShowMobileMembers: (show) => set({ showMobileMembers: show }),
}))

