/**
 * Embed detection — centralised URL → embed-info extraction.
 *
 * Add new platforms here and every consumer (chat, social feed, etc.)
 * picks them up automatically.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type EmbedType = 'youtube' | 'twitch' | 'kick' | 'twitter' | 'spotify' | 'steam' | 'tiktok'

/** Layout hint for the Embed component */
export type EmbedLayout =
  | 'video'     // 16:9 aspect ratio (YouTube, Twitch, Kick)
  | 'vertical'  // 9:16 portrait (TikTok)
  | 'compact'   // Fixed short height, full width (Spotify track, Steam widget)
  | 'card'      // Min-height, bordered (Twitter)

interface BaseEmbed {
  type: EmbedType
  src: string
  title: string
  allow: string
  layout: EmbedLayout
  /** Sandbox attribute for the iframe (e.g. Twitter) */
  sandbox?: string
  /** Explicit height — used for compact / card layouts instead of aspect-ratio */
  height?: number
}

export interface YouTubeEmbed extends BaseEmbed { type: 'youtube'; videoId: string }
export interface TwitchEmbed extends BaseEmbed { type: 'twitch'; variant: 'channel' | 'video' | 'clip'; id: string }
export interface KickEmbed extends BaseEmbed { type: 'kick'; channel: string }
export interface TwitterEmbed extends BaseEmbed { type: 'twitter'; tweetId: string }
export interface SpotifyEmbed extends BaseEmbed { type: 'spotify'; variant: 'track' | 'album' | 'playlist' | 'episode' | 'show'; id: string }
export interface SteamEmbed extends BaseEmbed { type: 'steam'; appId: string }
export interface TikTokEmbed extends BaseEmbed { type: 'tiktok'; videoId: string }

export type EmbedInfo =
  | YouTubeEmbed | TwitchEmbed | KickEmbed | TwitterEmbed
  | SpotifyEmbed | SteamEmbed | TikTokEmbed

// ── Regexes ────────────────────────────────────────────────────────────

const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
const TWITCH_CLIP_RE = /^https?:\/\/(?:(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/|clips\.twitch\.tv\/)([a-zA-Z0-9_-]+)/
const TWITCH_VIDEO_RE = /^https?:\/\/(?:www\.)?twitch\.tv\/videos\/(\d+)/
const TWITCH_CHANNEL_RE = /^https?:\/\/(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]{1,25})\/?$/
const KICK_RE = /^https?:\/\/(?:www\.)?kick\.com\/([a-zA-Z0-9_-]+)\/?$/
const TWITTER_RE = /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/
const SPOTIFY_RE = /^https?:\/\/open\.spotify\.com\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/
const STEAM_RE = /^https?:\/\/store\.steampowered\.com\/app\/(\d+)/
const TIKTOK_RE = /^https?:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/(\d+)/

// ── Detection ──────────────────────────────────────────────────────────

/**
 * Detect whether a URL should be rendered as an embed.
 * Returns structured embed info or `null` if the URL is not embeddable.
 */
export function detectEmbed(url: string): EmbedInfo | null {
  // YouTube
  const yt = url.match(YOUTUBE_RE)
  if (yt) {
    return {
      type: 'youtube',
      layout: 'video',
      videoId: yt[1],
      src: `https://www.youtube-nocookie.com/embed/${yt[1]}`,
      title: 'YouTube video',
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
    }
  }

  // Twitch — check clips first (most specific), then videos, then channels
  const parent = typeof window !== 'undefined' ? window.location.hostname : 'localhost'

  const tc = url.match(TWITCH_CLIP_RE)
  if (tc) {
    return {
      type: 'twitch',
      layout: 'video',
      variant: 'clip',
      id: tc[1],
      src: `https://clips.twitch.tv/embed?clip=${tc[1]}&parent=${parent}&autoplay=false`,
      title: 'Twitch clip',
      allow: 'fullscreen',
    }
  }

  const tv = url.match(TWITCH_VIDEO_RE)
  if (tv) {
    return {
      type: 'twitch',
      layout: 'video',
      variant: 'video',
      id: tv[1],
      src: `https://player.twitch.tv/?video=${tv[1]}&parent=${parent}&autoplay=false`,
      title: 'Twitch video',
      allow: 'fullscreen',
    }
  }

  const tch = url.match(TWITCH_CHANNEL_RE)
  if (tch) {
    return {
      type: 'twitch',
      layout: 'video',
      variant: 'channel',
      id: tch[1],
      src: `https://player.twitch.tv/?channel=${tch[1]}&parent=${parent}&autoplay=false`,
      title: 'Twitch stream',
      allow: 'fullscreen',
    }
  }

  // Kick
  const kick = url.match(KICK_RE)
  if (kick) {
    return {
      type: 'kick',
      layout: 'video',
      channel: kick[1],
      src: `https://player.kick.com/${kick[1]}?autoplay=false`,
      title: 'Kick stream',
      allow: 'fullscreen',
    }
  }

  // Twitter / X
  const tw = url.match(TWITTER_RE)
  if (tw) {
    return {
      type: 'twitter',
      layout: 'card',
      tweetId: tw[1],
      src: `https://platform.twitter.com/embed/Tweet.html?id=${tw[1]}&theme=dark`,
      title: 'Twitter post',
      allow: '',
      sandbox: 'allow-scripts allow-same-origin allow-popups',
      height: 250,
    }
  }

  // Spotify (track, album, playlist, episode, show)
  const sp = url.match(SPOTIFY_RE)
  if (sp) {
    const variant = sp[1] as 'track' | 'album' | 'playlist' | 'episode' | 'show'
    const isCompact = variant === 'track' || variant === 'episode'
    return {
      type: 'spotify',
      layout: 'compact',
      variant,
      id: sp[2],
      src: `https://open.spotify.com/embed/${variant}/${sp[2]}?theme=0`,
      title: `Spotify ${variant}`,
      allow: 'encrypted-media',
      height: isCompact ? 152 : 352,
    }
  }

  // Steam store page → widget
  const steam = url.match(STEAM_RE)
  if (steam) {
    return {
      type: 'steam',
      layout: 'compact',
      appId: steam[1],
      src: `https://store.steampowered.com/widget/${steam[1]}/`,
      title: 'Steam store',
      allow: '',
      height: 190,
    }
  }

  // TikTok
  const tt = url.match(TIKTOK_RE)
  if (tt) {
    return {
      type: 'tiktok',
      layout: 'vertical',
      videoId: tt[1],
      src: `https://www.tiktok.com/player/v1/${tt[1]}?autoplay=0&music_info=1&description=1`,
      title: 'TikTok video',
      allow: 'fullscreen',
      height: 740,
    }
  }

  return null
}

/**
 * Quick boolean check — useful for content parsing / segment classification.
 */
export function isEmbeddable(url: string): boolean {
  return detectEmbed(url) !== null
}
