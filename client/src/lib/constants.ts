/** Theme types */
export type TTheme = 'light' | 'dark' | 'pure-black'
export type TThemeSetting = 'light' | 'dark' | 'system'

/** Primary color config for light and dark modes */
export interface PrimaryColorConfig {
  name: string
  light: {
    primary: string
    'primary-hover': string
    'primary-foreground': string
    ring: string
  }
  dark: {
    primary: string
    'primary-hover': string
    'primary-foreground': string
    ring: string
  }
}

/** 18 customizable primary colors — same as Jumble */
export const PRIMARY_COLORS: Record<string, PrimaryColorConfig> = {
  DEFAULT: {
    name: 'Default',
    light: { primary: '228 92% 63%', 'primary-hover': '228 92% 72%', 'primary-foreground': '0 0% 98%', ring: '228 92% 63%' },
    dark: { primary: '228 92% 63%', 'primary-hover': '228 92% 72%', 'primary-foreground': '0 0% 98%', ring: '228 92% 63%' }
  },
  RED: {
    name: 'Red',
    light: { primary: '0 65% 55%', 'primary-hover': '0 65% 65%', 'primary-foreground': '0 0% 98%', ring: '0 65% 55%' },
    dark: { primary: '0 65% 55%', 'primary-hover': '0 65% 65%', 'primary-foreground': '240 5.9% 10%', ring: '0 65% 55%' }
  },
  ORANGE: {
    name: 'Orange',
    light: { primary: '30 100% 50%', 'primary-hover': '30 100% 60%', 'primary-foreground': '0 0% 98%', ring: '30 100% 50%' },
    dark: { primary: '30 100% 50%', 'primary-hover': '30 100% 60%', 'primary-foreground': '240 5.9% 10%', ring: '30 100% 50%' }
  },
  AMBER: {
    name: 'Amber',
    light: { primary: '42 100% 50%', 'primary-hover': '42 100% 60%', 'primary-foreground': '0 0% 98%', ring: '42 100% 50%' },
    dark: { primary: '42 100% 50%', 'primary-hover': '42 100% 60%', 'primary-foreground': '240 5.9% 10%', ring: '42 100% 50%' }
  },
  GREEN: {
    name: 'Green',
    light: { primary: '140 60% 40%', 'primary-hover': '140 60% 50%', 'primary-foreground': '0 0% 98%', ring: '140 60% 40%' },
    dark: { primary: '140 60% 40%', 'primary-hover': '140 60% 50%', 'primary-foreground': '240 5.9% 10%', ring: '140 60% 40%' }
  },
  TEAL: {
    name: 'Teal',
    light: { primary: '180 70% 40%', 'primary-hover': '180 70% 50%', 'primary-foreground': '0 0% 98%', ring: '180 70% 40%' },
    dark: { primary: '180 70% 40%', 'primary-hover': '180 70% 50%', 'primary-foreground': '240 5.9% 10%', ring: '180 70% 40%' }
  },
  CYAN: {
    name: 'Cyan',
    light: { primary: '200 70% 40%', 'primary-hover': '200 70% 50%', 'primary-foreground': '0 0% 98%', ring: '200 70% 40%' },
    dark: { primary: '200 70% 40%', 'primary-hover': '200 70% 50%', 'primary-foreground': '240 5.9% 10%', ring: '200 70% 40%' }
  },
  SKY: {
    name: 'Sky',
    light: { primary: '210 70% 50%', 'primary-hover': '210 70% 60%', 'primary-foreground': '0 0% 98%', ring: '210 70% 50%' },
    dark: { primary: '210 70% 50%', 'primary-hover': '210 70% 60%', 'primary-foreground': '240 5.9% 10%', ring: '210 70% 50%' }
  },
  BLUE: {
    name: 'Blue',
    light: { primary: '220 80% 50%', 'primary-hover': '220 80% 60%', 'primary-foreground': '0 0% 98%', ring: '220 80% 50%' },
    dark: { primary: '220 80% 50%', 'primary-hover': '220 80% 60%', 'primary-foreground': '240 5.9% 10%', ring: '220 80% 50%' }
  },
  INDIGO: {
    name: 'Indigo',
    light: { primary: '230 80% 50%', 'primary-hover': '230 80% 60%', 'primary-foreground': '0 0% 98%', ring: '230 80% 50%' },
    dark: { primary: '230 80% 50%', 'primary-hover': '230 80% 60%', 'primary-foreground': '240 5.9% 10%', ring: '230 80% 50%' }
  },
  VIOLET: {
    name: 'Violet',
    light: { primary: '250 80% 50%', 'primary-hover': '250 80% 60%', 'primary-foreground': '0 0% 98%', ring: '250 80% 50%' },
    dark: { primary: '250 80% 50%', 'primary-hover': '250 80% 60%', 'primary-foreground': '240 5.9% 10%', ring: '250 80% 50%' }
  },
  PURPLE: {
    name: 'Purple',
    light: { primary: '280 80% 50%', 'primary-hover': '280 80% 60%', 'primary-foreground': '0 0% 98%', ring: '280 80% 50%' },
    dark: { primary: '280 80% 50%', 'primary-hover': '280 80% 60%', 'primary-foreground': '240 5.9% 10%', ring: '280 80% 50%' }
  },
  FUCHSIA: {
    name: 'Fuchsia',
    light: { primary: '310 80% 50%', 'primary-hover': '310 80% 60%', 'primary-foreground': '0 0% 98%', ring: '310 80% 50%' },
    dark: { primary: '310 80% 50%', 'primary-hover': '310 80% 60%', 'primary-foreground': '240 5.9% 10%', ring: '310 80% 50%' }
  },
  PINK: {
    name: 'Pink',
    light: { primary: '330 80% 60%', 'primary-hover': '330 80% 70%', 'primary-foreground': '0 0% 10%', ring: '330 80% 60%' },
    dark: { primary: '330 80% 60%', 'primary-hover': '330 80% 70%', 'primary-foreground': '240 5.9% 10%', ring: '330 80% 60%' }
  },
  ROSE: {
    name: 'Rose',
    light: { primary: '350 80% 60%', 'primary-hover': '350 80% 70%', 'primary-foreground': '0 0% 10%', ring: '350 80% 60%' },
    dark: { primary: '350 80% 60%', 'primary-hover': '350 80% 70%', 'primary-foreground': '240 5.9% 10%', ring: '350 80% 60%' }
  },
} as const

export type TPrimaryColor = keyof typeof PRIMARY_COLORS

/** Local storage keys */
export const StorageKey = {
  THEME_SETTING: 'den-chat-theme',
  PRIMARY_COLOR: 'den-chat-primary-color',
  ACCOUNTS: 'den-chat-accounts',
  CURRENT_ACCOUNT: 'den-chat-current-account',
  UPLOAD_LIMIT_MB: 'den-chat-upload-limit-mb',
  EMOJI_UPLOAD_LIMIT_MB: 'den-chat-emoji-upload-limit-mb',
  ALLOW_LARGE_EMOJIS: 'den-chat-allow-large-emojis',
  STICKER_UPLOAD_LIMIT_MB: 'den-chat-sticker-upload-limit-mb',
  ALLOW_LARGE_STICKERS: 'den-chat-allow-large-stickers',
  CLIENT_RELAYS: 'den-chat-client-relays',
  CLIENT_BLOSSOMS: 'den-chat-client-blossoms',
  BG_SHOWCASE: 'den-chat-bg-showcase',
  AD_SHOWCASE: 'den-chat-ad-showcase',
  SKIP_SPLASH: 'den-chat-skip-splash',
  /** Notification read-state event caches (NIP-78 event JSON) */
  NOTIF_SOCIAL_SEEN_AT: 'den-chat-notif-social',
  NOTIF_HUB_READ_STATE: 'den-chat-notif-hub',
  NOTIF_DM_READ_STATE: 'den-chat-notif-dm',
  NOTIF_PC_READ_STATE: 'den-chat-notif-pc',
} as const

/** Admin / creator identity */
export const ADMIN_NPUB = 'npub18ly7pqxzm4mmy8rd47cdt74ahc424y95xdtl9t7vek8777l5xqss3pttwf'
export const ADMIN_PUBKEY = '3fc9e080c2dd77b21c6dafb0d5fabdbe2aaa90b43357f2afcccd8fef7bf43021'
