/**
 * Sound Effects Manager — Plays audio feedback for voice channel actions.
 *
 * Supports 8 sound effect slots: mute, unmute, deafen, undeafen, join, leave, message, dm_message.
 * Default sounds ship in /audio/*.mp3.
 * Users can override each sound with a custom file (stored as base64 data URI in localStorage).
 * Each sound can be individually enabled/disabled and have its own volume.
 */

export type SoundEffectName = 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'join' | 'leave' | 'message' | 'dm_message'

export interface SoundEffectConfig {
  enabled: boolean
  volume: number          // 0-100
  customDataUri: string | null  // base64 data URI, or null for default
}

export interface SoundEffectsState {
  globalEnabled: boolean
  effects: Record<SoundEffectName, SoundEffectConfig>
}

const STORAGE_KEY = 'den-chat-sound-effects'

const SOUND_NAMES: SoundEffectName[] = ['mute', 'unmute', 'deafen', 'undeafen', 'join', 'leave', 'message', 'dm_message']

/** Default audio paths (served from /public/audio/) */
const DEFAULT_PATHS: Record<SoundEffectName, string> = {
  mute: '/audio/mute.mp3',
  unmute: '/audio/unmute.mp3',
  deafen: '/audio/deafen.mp3',
  undeafen: '/audio/undeafen.mp3',
  join: '/audio/join.mp3',
  leave: '/audio/leave.mp3',
  message: '/audio/message.mp3',
  dm_message: '/audio/message.mp3',
}

/** Human-readable labels for each sound */
export const SOUND_LABELS: Record<SoundEffectName, string> = {
  mute: 'Mute',
  unmute: 'Unmute',
  deafen: 'Deafen',
  undeafen: 'Undeafen',
  join: 'Join Voice Channel',
  leave: 'Leave Voice Channel',
  message: 'Hub Message',
  dm_message: 'DM Message',
}

function defaultEffectConfig(): SoundEffectConfig {
  return { enabled: true, volume: 80, customDataUri: null }
}

function defaultState(): SoundEffectsState {
  const effects = {} as Record<SoundEffectName, SoundEffectConfig>
  for (const name of SOUND_NAMES) {
    effects[name] = defaultEffectConfig()
  }
  return { globalEnabled: true, effects }
}

function loadState(): SoundEffectsState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      const state = defaultState()
      if (typeof parsed.globalEnabled === 'boolean') state.globalEnabled = parsed.globalEnabled
      if (parsed.effects && typeof parsed.effects === 'object') {
        for (const name of SOUND_NAMES) {
          if (parsed.effects[name]) {
            const e = parsed.effects[name]
            state.effects[name] = {
              enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
              volume: typeof e.volume === 'number' ? e.volume : 80,
              customDataUri: typeof e.customDataUri === 'string' ? e.customDataUri : null,
            }
          }
        }
      }
      return state
    }
  } catch { /* ignore */ }
  return defaultState()
}

function saveState(state: SoundEffectsState) {
  try {
    // Save without the large data URIs bloating the save on every write
    // (data URIs are saved separately only when changed)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* ignore — localStorage full, etc. */ }
}

// ── Module state ──

let state: SoundEffectsState = loadState()

// Audio element cache — reused to avoid creating new elements on every play
const audioCache: Partial<Record<SoundEffectName, HTMLAudioElement>> = {}

/** Resolve the audio source URL for a sound effect */
function getAudioSrc(name: SoundEffectName): string {
  const config = state.effects[name]
  if (config.customDataUri) return config.customDataUri
  return DEFAULT_PATHS[name]
}

/** Get or create the cached Audio element for a sound */
function getAudioElement(name: SoundEffectName): HTMLAudioElement {
  let audio = audioCache[name]
  const src = getAudioSrc(name)
  if (!audio || audio.getAttribute('data-src') !== src) {
    audio = new Audio(src)
    audio.setAttribute('data-src', src)
    audioCache[name] = audio
  }
  return audio
}

// ── Public API ──

/**
 * Play a sound effect. Fire-and-forget.
 * Respects global enable, per-sound enable, and volume settings.
 */
export function playSoundEffect(name: SoundEffectName): void {
  if (!state.globalEnabled) return
  const config = state.effects[name]
  if (!config.enabled) return

  try {
    const audio = getAudioElement(name)
    audio.volume = Math.max(0, Math.min(1, config.volume / 100))
    audio.currentTime = 0
    audio.play().catch(() => {
      // Autoplay policy may block — silently ignore
    })
  } catch {
    // Audio creation failed — silently ignore
  }
}

/**
 * Preview a sound effect (always plays regardless of enabled state).
 * Used by the Settings UI preview button.
 */
export function previewSoundEffect(name: SoundEffectName): void {
  try {
    const audio = getAudioElement(name)
    audio.volume = Math.max(0, Math.min(1, state.effects[name].volume / 100))
    audio.currentTime = 0
    audio.play().catch(() => {})
  } catch {}
}

/** Get the current sound effects config (for Settings UI) */
export function getSoundEffectsConfig(): SoundEffectsState {
  return { ...state, effects: { ...state.effects } }
}

/** Get the list of sound names */
export function getSoundNames(): SoundEffectName[] {
  return [...SOUND_NAMES]
}

/** Set global sound effects enabled/disabled */
export function setGlobalSoundEffectsEnabled(enabled: boolean): void {
  state = { ...state, globalEnabled: enabled }
  saveState(state)
}

/** Set a sound effect enabled/disabled */
export function setSoundEffectEnabled(name: SoundEffectName, enabled: boolean): void {
  state = {
    ...state,
    effects: {
      ...state.effects,
      [name]: { ...state.effects[name], enabled },
    },
  }
  saveState(state)
}

/** Set volume for a sound effect (0-100) */
export function setSoundEffectVolume(name: SoundEffectName, volume: number): void {
  state = {
    ...state,
    effects: {
      ...state.effects,
      [name]: { ...state.effects[name], volume: Math.max(0, Math.min(100, volume)) },
    },
  }
  saveState(state)
}

/**
 * Set a custom sound file for a sound effect.
 * Pass null to reset to the default sound.
 */
export async function setSoundEffect(name: SoundEffectName, file: File | null): Promise<void> {
  let dataUri: string | null = null

  if (file) {
    // Convert file to base64 data URI
    const buffer = await file.arrayBuffer()
    const base64 = btoa(
      new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    )
    dataUri = `data:${file.type || 'audio/mpeg'};base64,${base64}`
  }

  state = {
    ...state,
    effects: {
      ...state.effects,
      [name]: { ...state.effects[name], customDataUri: dataUri },
    },
  }

  // Invalidate audio cache for this sound
  delete audioCache[name]

  saveState(state)
}

/** Check if a sound effect has a custom (user-uploaded) sound */
export function hasCustomSound(name: SoundEffectName): boolean {
  return state.effects[name].customDataUri !== null
}
