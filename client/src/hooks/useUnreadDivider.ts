import { useRef, useState, useEffect, useCallback } from 'react'

/**
 * Hook that manages the "new messages" divider and unread banner state.
 *
 * @param lastReadTimestamp - The lastRead timestamp from the notification store
 * @param messages - Array of messages (must have a timestamp/createdAt field)
 * @param getTimestamp - Function to extract the timestamp from a message
 * @param channelKey - A string that changes when the channel/conversation changes (resets state)
 * @param myPubkey - The current user's pubkey (to exclude own messages from unread)
 * @param getPubkey - Function to extract the pubkey from a message
 *
 * @returns {
 *   dividerRef: Ref to attach to the NewMessagesDivider element
 *   dividerTimestamp: The lastRead snapshot (used to position the divider)
 *   unreadCount: Number of messages after the divider
 *   showBanner: Whether to show the floating unread banner
 *   dismissBanner: Callback to manually hide the banner
 *   jumpToDivider: Callback to scroll to the divider element
 *   shouldShowDivider: (msgTimestamp, prevMsgTimestamp) => boolean — check if the divider should be inserted before a message
 * }
 */
export function useUnreadDivider<T>(
  lastReadTimestamp: number,
  messages: T[],
  getTimestamp: (msg: T) => number,
  channelKey: string,
  myPubkey?: string | null,
  getPubkey?: (msg: T) => string,
) {
  // Snapshot the lastRead on channel open — don't shift as the user reads
  const snapshotRef = useRef<number>(0)
  const channelKeyRef = useRef<string>('')

  if (channelKeyRef.current !== channelKey) {
    channelKeyRef.current = channelKey
    snapshotRef.current = lastReadTimestamp
  }

  const snapshot = snapshotRef.current
  const dividerRef = useRef<HTMLDivElement>(null)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [dividerOffScreen, setDividerOffScreen] = useState(false)

  // Reset dismissed state when channel changes
  useEffect(() => {
    setBannerDismissed(false)
    setDividerOffScreen(false)
  }, [channelKey])

  // Count unread messages (those with timestamp > snapshot, excluding own messages)
  const unreadCount = snapshot > 0
    ? messages.filter((m) => {
        if (getTimestamp(m) <= snapshot) return false
        // Own messages are never "unread"
        if (myPubkey && getPubkey && getPubkey(m) === myPubkey) return false
        return true
      }).length
    : 0

  // IntersectionObserver to track if the divider is visible
  useEffect(() => {
    const el = dividerRef.current
    if (!el || unreadCount === 0) {
      setDividerOffScreen(false)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setDividerOffScreen(!entry.isIntersecting)
      },
      { threshold: 0 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [unreadCount, channelKey])

  const showBanner = unreadCount > 0 && dividerOffScreen && !bannerDismissed

  const dismissBanner = useCallback(() => {
    setBannerDismissed(true)
  }, [])

  const jumpToDivider = useCallback(() => {
    dividerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  /**
   * Check if the new-messages divider should be inserted BEFORE this message.
   * Call this in the rendering loop: if the previous message's timestamp <= snapshot
   * AND the current message's timestamp > snapshot, insert the divider.
   * Own messages are excluded — the divider won't appear before the user's own messages.
   */
  const shouldInsertDivider = useCallback(
    (msgTimestamp: number, prevMsgTimestamp: number | null, msgPubkey?: string): boolean => {
      if (snapshot <= 0 || unreadCount === 0) return false
      // Don't insert divider before own messages
      if (myPubkey && msgPubkey && msgPubkey === myPubkey) return false
      // First message in the list and it's unread
      if (prevMsgTimestamp === null) return msgTimestamp > snapshot
      // Boundary: previous message was read, current is unread
      return prevMsgTimestamp <= snapshot && msgTimestamp > snapshot
    },
    [snapshot, unreadCount, myPubkey]
  )

  return {
    dividerRef,
    dividerTimestamp: snapshot,
    unreadCount,
    showBanner,
    dismissBanner,
    jumpToDivider,
    shouldInsertDivider,
  }
}
