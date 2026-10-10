/**
 * Preferences store — persists language and time format settings.
 * Language is currently English-only (others coming soon).
 * Time format is applied globally via formatTimestamp/toLocaleTimeString helpers.
 */
import { create } from 'zustand'

export type LanguageCode = 'en' | 'ja' | 'zh-CN' | 'ar' | 'de' | 'pt' | 'ro' | 'ko'

export type TimeFormat = 'auto' | '12h' | '24h'

export interface SearchEngine {
  id: string
  /** Display name shown in the right-click "search selection" menu, e.g. "Google". */
  name: string
  /** URL prefix; the URL-encoded selection is appended to the END, e.g. "https://www.google.com/search?q=". */
  url: string
}

interface PreferencesState {
  language: LanguageCode
  timeFormat: TimeFormat
  /** Global toggle for link previews & embeds (YouTube, Twitch, etc.) — default ON */
  showEmbeds: boolean
  /** Global toggle for OpenGraph link preview cards — default ON (desktop only) */
  showLinkPreviews: boolean
  /** Global toggle for muted word redaction — default ON */
  hideMutedWords: boolean
  /** Global toggle for inline media (images, video, audio) — default ON */
  showMedia: boolean
  /** Global toggle for custom emoji rendering — default ON */
  showCustomEmojis: boolean
  /** Max voice note recording duration in seconds — default 30 */
  voiceNoteMaxDuration: number
  /** Voice note audio bitrate in bps — default 32000 (32kbps Opus) */
  voiceNoteBitrate: number
  /** User-defined search engines for the right-click "search selected text" action. No defaults: empty until the user adds some. */
  searchEngines: SearchEngine[]
  setLanguage: (lang: LanguageCode) => void
  setTimeFormat: (format: TimeFormat) => void
  setShowEmbeds: (v: boolean) => void
  setShowLinkPreviews: (v: boolean) => void
  setHideMutedWords: (v: boolean) => void
  setShowMedia: (v: boolean) => void
  setShowCustomEmojis: (v: boolean) => void
  setVoiceNoteMaxDuration: (v: number) => void
  setVoiceNoteBitrate: (v: number) => void
  /** Append a new user-defined search engine. */
  addSearchEngine: (name: string, url: string) => void
  /** Remove a user-defined search engine by id. */
  removeSearchEngine: (id: string) => void
}

const STORAGE_KEY = 'den-chat-preferences'

type PrefsData = { language: LanguageCode; timeFormat: TimeFormat; showEmbeds: boolean; showLinkPreviews: boolean; hideMutedWords: boolean; showMedia: boolean; showCustomEmojis: boolean; voiceNoteMaxDuration: number; voiceNoteBitrate: number; searchEngines: SearchEngine[] }

function loadPrefs(): PrefsData {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return {
        language: parsed.language || 'en',
        timeFormat: parsed.timeFormat || 'auto',
        showEmbeds: parsed.showEmbeds !== false,
        showLinkPreviews: parsed.showLinkPreviews !== false,
        hideMutedWords: parsed.hideMutedWords !== false,
        showMedia: parsed.showMedia !== false,
        showCustomEmojis: parsed.showCustomEmojis !== false,
        voiceNoteMaxDuration: parsed.voiceNoteMaxDuration ?? 30,
        voiceNoteBitrate: parsed.voiceNoteBitrate ?? 32000,
        searchEngines: Array.isArray(parsed.searchEngines) ? parsed.searchEngines : [],
      }
    }
  } catch { /* ignore */ }
  return { language: 'en', timeFormat: 'auto', showEmbeds: true, showLinkPreviews: true, hideMutedWords: true, showMedia: true, showCustomEmojis: true, voiceNoteMaxDuration: 30, voiceNoteBitrate: 32000, searchEngines: [] }
}

function savePrefs(prefs: PrefsData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch { /* ignore */ }
}

export const usePreferencesStore = create<PreferencesState>((set, get) => {
  const initial = loadPrefs()
  return {
    ...initial,
    setLanguage: (language) => {
      set({ language })
      savePrefs({ ...get(), language })
    },
    setTimeFormat: (timeFormat) => {
      set({ timeFormat })
      savePrefs({ ...get(), timeFormat })
    },
    setShowEmbeds: (showEmbeds) => {
      set({ showEmbeds })
      savePrefs({ ...get(), showEmbeds })
    },
    setShowLinkPreviews: (showLinkPreviews) => {
      set({ showLinkPreviews })
      savePrefs({ ...get(), showLinkPreviews })
    },
    setHideMutedWords: (hideMutedWords) => {
      set({ hideMutedWords })
      savePrefs({ ...get(), hideMutedWords })
    },
    setShowMedia: (showMedia) => {
      set({ showMedia })
      savePrefs({ ...get(), showMedia })
    },
    setShowCustomEmojis: (showCustomEmojis) => {
      set({ showCustomEmojis })
      savePrefs({ ...get(), showCustomEmojis })
    },
    setVoiceNoteMaxDuration: (voiceNoteMaxDuration) => {
      set({ voiceNoteMaxDuration })
      savePrefs({ ...get(), voiceNoteMaxDuration })
    },
    setVoiceNoteBitrate: (voiceNoteBitrate) => {
      set({ voiceNoteBitrate })
      savePrefs({ ...get(), voiceNoteBitrate })
    },
    addSearchEngine: (name, url) => {
      const engine: SearchEngine = { id: crypto.randomUUID(), name, url }
      const searchEngines = [...get().searchEngines, engine]
      set({ searchEngines })
      savePrefs({ ...get(), searchEngines })
    },
    removeSearchEngine: (id) => {
      const searchEngines = get().searchEngines.filter((e) => e.id !== id)
      set({ searchEngines })
      savePrefs({ ...get(), searchEngines })
    },
  }
})

// ── Language metadata ──

export interface LanguageInfo {
  code: LanguageCode
  flag: string
  nativeName: string
  /** Name in English (or whatever the current language is — for now always English) */
  englishName: string
  available: boolean
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'en', flag: '🇺🇸', nativeName: 'English', englishName: 'English', available: true },
  { code: 'ja', flag: '🇯🇵', nativeName: '日本語', englishName: 'Japanese', available: false },
  { code: 'zh-CN', flag: '🇨🇳', nativeName: '简体中文', englishName: 'Chinese (Simplified)', available: false },
  { code: 'ar', flag: '🇸🇦', nativeName: 'العربية', englishName: 'Arabic', available: false },
  { code: 'de', flag: '🇩🇪', nativeName: 'Deutsch', englishName: 'German', available: false },
  { code: 'pt', flag: '🇧🇷', nativeName: 'Português', englishName: 'Portuguese', available: false },
  { code: 'ro', flag: '🇷🇴', nativeName: 'Română', englishName: 'Romanian', available: false },
  { code: 'ko', flag: '🇰🇷', nativeName: '한국어', englishName: 'Korean', available: false },
]

// ── Time format helper ──

/** Returns the `hour12` option for toLocaleTimeString based on user preference */
export function getHour12(): boolean | undefined {
  const tf = usePreferencesStore.getState().timeFormat
  if (tf === '12h') return true
  if (tf === '24h') return false
  return undefined // 'auto' — let browser locale decide
}
