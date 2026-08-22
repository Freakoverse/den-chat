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

import { useDMStore } from '@/stores/dmStore'
import { useDM04Store } from '@/stores/dm04Store'
import { useHubStore } from '@/stores/hubStore'
import { useMessageStore } from '@/stores/messageStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { clearCachedEvent } from '@/lib/notifications/readState'
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

  // 2) Notifications need special handling. Their read-state is cached in
  //    localStorage under GLOBAL (non-per-account) keys, and the store bakes that
  //    cache into its initial state at module-eval. So a plain hardReset would
  //    restore the PREVIOUS account's read-state, and the next account's init()
  //    would then read the same shared cache (whose fresh created_at beats the new
  //    account's relay event) — making the new account inherit "already read"
  //    timestamps and show no unread badges. Empty the store via its reset() action
  //    and wipe the shared caches so init() rehydrates purely from the new account's
  //    own relay read-state. (Affects hub badges, channel unread, DMs, and social.)
  try {
    useNotificationStore.getState().reset()
    clearCachedEvent('social')
    clearCachedEvent('hub')
    clearCachedEvent('dm')
    clearCachedEvent('pc')
  } catch { /* ignore */ }

  // 3) Hard-reset every other per-account store to its initial empty state.
  const stores: AnyStore[] = [
    useHubStore, useMessageStore, useDMStore, useDM04Store,
    useSocialStore, useFollowStore, useBlockStore,
    usePinStore, useForumStore, useEmojiStore, useStickerStore, useGifStore,
    useUserListsStore, useWotStore, useReportStore, useZapStore, usePublicChatStore,
  ] as unknown as AnyStore[]

  for (const store of stores) hardReset(store)
}
