/**
 * resetSession — wipe all per-account, in-memory state on an account change.
 *
 * DEN Chat is a long-lived SPA: logging out and back in (or switching accounts via the
 * carousel) never reloads the page, so Zustand stores are module singletons that survive
 * the transition, and relay subscriptions started for the previous account keep running.
 * That produced three related bugs:
 *   1. Ghost notification sounds for the *previous* account's incoming messages/DMs.
 *   2. The previous account's DM conversations showing after switching.
 *   3. The previous account's hub list flashing in the sidebar before the new one loads.
 *
 * The fix is one shared teardown: close live relay subscriptions first (so the old
 * account genuinely stops receiving), then hard-reset every per-account store to its
 * initial empty state (Zustand v5 `getInitialState()` + replace). Called from
 * userStore.login() (only when actually switching accounts) and userStore.logout().
 *
 * Global stores that are NOT tied to the signed-in account are intentionally left alone:
 * posting behaviour, UI preferences, app-update state, and DNN node discovery.
 */

import { useUserStore } from '@/stores/userStore'
import { useDMStore } from '@/stores/dmStore'
import { useDM04Store } from '@/stores/dm04Store'
import { useHubStore } from '@/stores/hubStore'
import { useMessageStore } from '@/stores/messageStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useSocialStore } from '@/stores/socialStore'
import { useFollowStore } from '@/stores/followStore'
import { useBlockStore } from '@/stores/blockStore'
import { usePinStore } from '@/stores/pinStore'
import { useForumStore } from '@/stores/forumStore'
import { useEmojiStore } from '@/stores/emojiStore'
import { useStickerStore } from '@/stores/stickerStore'
import { useGifStore } from '@/stores/gifStore'
import { useUserListsStore } from '@/stores/userListsStore'
import { useWotStore } from '@/stores/wotStore'
import { useReportStore } from '@/stores/reportStore'
import { useZapStore } from '@/stores/zapStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { usePublicChatStore } from '@/stores/publicChatStore'
import { useCalendarStore } from '@/stores/calendarStore'
import { usePollStore } from '@/stores/pollStore'
import { clearPKeyCache } from '@/lib/hub/hubMemberSign'
import { clearFacListDedup } from '@/hooks/useMessages'
import { clearVoiceDisplayCache } from '@/hooks/useVoiceDisplayPubkey'
import { clearVirtualAvatarCache } from '@/lib/voice/virtualAvatar'
import { clearAllCachedMessages } from '@/lib/cache/messageCache'
import { clearCachedEvent } from '@/lib/notifications/readState'

/** Any Zustand v5 store — reset it to its created (empty) state, actions included. */
type AnyStore = { getInitialState: () => unknown; setState: (state: never, replace: true) => void }

function hardReset(store: AnyStore): void {
  try {
    store.setState(store.getInitialState() as never, true)
  } catch { /* one bad store shouldn't block the rest */ }
}

export function resetSession(): void {
  // 1) Close live relay subscriptions BEFORE their handles get wiped — otherwise the
  //    socket keeps delivering the old account's events (ghost notifications, stale DMs).
  try { useDMStore.getState().stopSubscription() } catch { /* ignore */ }
  try { useDM04Store.getState().stopSubscription() } catch { /* ignore */ }

  // Public chat keeps its relay subscriptions in the store (they outlive the chat view),
  // so — like DMs — they must be stopped explicitly on an account switch, otherwise they
  // keep delivering under the new account.
  try {
    const pc = usePublicChatStore.getState()
    pc.stopSubscription()
    pc.stopDeletionSubscription()
    pc.stopReactionSubscription()
    pc.stopZapSubscription()
  } catch { /* ignore */ }

  // Voice: if a call is live, run the real teardown — releases mic/camera, disconnects
  // the WebRTC provider, clears the keepalive/broadcast intervals, and cleans up the E2EE
  // workers (a blind reset would leave the mic on and the call running). leaveChannel owns
  // voiceStore's state and has an async "left"-publish tail, so we let it manage the store
  // rather than replacing state under it. When idle there are no live handles, so a plain
  // reset is safe and clears any stale voice presence/host data from the old account.
  try {
    const voice = useVoiceStore.getState()
    if (voice.connectionState !== 'disconnected' && voice.connectionState !== 'disconnecting') {
      void voice.leaveChannel([], null, null)
    } else {
      hardReset(useVoiceStore as unknown as AnyStore)
    }
  } catch { /* ignore */ }

  // 2) Notifications need special handling. The store bakes the module-eval preload
  //    (the PREVIOUS account's read-state) into its initial state, so a plain
  //    hardReset would restore that account's timestamps and init() would merge them
  //    into the new account. Empty it via its reset() action instead; the incoming
  //    init() re-points the per-account caches (setReadStateAccount) and rehydrates
  //    from the new account's own namespaced cache + relay read-state.
  try {
    useNotificationStore.getState().reset()
  } catch { /* ignore */ }

  // 3) Hard-reset every other per-account store to its initial empty state.
  const stores: AnyStore[] = [
    useHubStore, useMessageStore, useDMStore, useDM04Store,
    useSocialStore, useFollowStore, useBlockStore,
    usePinStore, useForumStore, useEmojiStore, useStickerStore, useGifStore,
    useUserListsStore, useWotStore, useReportStore, useZapStore, usePublicChatStore,
    // v2: these hold hub-scoped events whose author is the pseudonym P/Pf — a stale copy would
    // let the next account see the prior account's cached calendar/poll data for its hubs.
    useCalendarStore, usePollStore,
  ] as unknown as AnyStore[]

  for (const store of stores) hardReset(store)

  // 4) Clear module-level (non-store) caches keyed by hub but NOT by account — otherwise they
  //    return the previous account's derived pseudonyms / suppress its fetches under the new one.
  try { clearPKeyCache() } catch { /* ignore */ }
  try { clearVoiceDisplayCache() } catch { /* ignore */ }
  try { clearVirtualAvatarCache() } catch { /* ignore */ }
  // DECRYPTED message content persists in a global (non-account) IndexedDB store — wipe it so the next
  // account on this device can't read the previous account's private-hub messages. Fire-and-forget; it
  // repopulates from relays on the next subscription.
  void clearAllCachedMessages().catch(() => { /* non-fatal */ })
  // Read-state localStorage lists every hub's d-tag (incl. private v2 hubs) + last-read times in
  // plaintext under the OUTGOING account's key — clear it so the prior account's private-hub membership
  // doesn't linger on disk after a switch/logout (it re-syncs from the encrypted relay copy on re-login).
  try { clearCachedEvent('hub'); clearCachedEvent('dm') } catch { /* ignore */ }
  try { clearFacListDedup() } catch { /* ignore */ }
  // A facilitator's `den_fac_vouched:<account>` list holds the REAL keys (R_f) of everyone they vouched
  // into a private v2 hub — the same private-hub-membership-in-plaintext class we wipe above for hub
  // read-state. It's account-namespaced (no cross-account leak) but still lingers on disk after logout.
  // Clear ONLY the outgoing account's key (resetSession runs before userStore swaps pubkey, so getState()
  // still holds the previous account) — never a blanket wipe: this list has no relay backup, so nuking
  // another account's copy would be permanent data loss. The facilitator re-adds vouched people (by npub)
  // if needed; the mesh tree + their access are unaffected (keyed on Pf, which persists on Blossom).
  try {
    const outgoing = useUserStore.getState().pubkey
    if (outgoing) localStorage.removeItem(`den_fac_vouched:${outgoing}`)
  } catch { /* ignore */ }
  // `den_last_active_hub` is a plaintext, non-account-scoped startup hint holding the last hub's d-tag —
  // if that was a private v2 hub, it's a "this device was last in private hub X" footprint that outlives
  // logout, the same class as the read-state d-tags cleared above. Trivially recoverable (re-set on the
  // next setActiveHub), so clear it outright rather than namespacing.
  try { localStorage.removeItem('den_last_active_hub') } catch { /* ignore */ }
}
