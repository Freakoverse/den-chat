/**
 * NIP-CHAT hub format version helpers (NIP-CHAT §0).
 *
 * v1 and v2 coexist. The `version` tag on the hub event is the master format selector. It is mutable, so
 * a downgrade (a validly-signed owner event dropping v2→v1) must not be allowed to flip a hub onto the
 * plaintext-R v1 path. That protection is ENFORCED at the two hub-event apply paths (useHubEventSubscription
 * + useHubLoader.processHub) via `versionGuard.ts`: a persisted per-hub version high-water mark rejects any
 * event whose version is below the highest ever accepted. `isV2(hub)` therefore reads `hub.version` safely,
 * because a downgraded event never reaches `setHubData`.
 *
 * The optional `signals` param on `isV2`/`hasVersionMismatch` below is a legacy alternative fail-safe (weigh
 * the hub-list recorded format / encrypted content); the high-water guard supersedes it and callers pass
 * `hub` alone.
 */

/** Signals feeding the v2 fail-safe. Callers supply whichever they have. */
export interface VersionSignals {
  /** Hub format recorded in the user's hub list at join (§6.4): 2 or "2" ⇒ v2. */
  recordedFormat?: string | number
  /** True when the hub event's structural `content` is encrypted (v2, unspoofable). */
  contentEncrypted?: boolean
}

/** The hub's declared format version from its live `version` tag (absent ⇒ 1). */
export function getHubVersion(hub: { version?: number }): number {
  return hub.version && hub.version >= 1 ? hub.version : 1
}

/** Whether the hub's version is a known, supported one (1 or 2). Higher ⇒ "update client". */
export function isSupportedVersion(hub: { version?: number }): boolean {
  const v = getHubVersion(hub)
  return v === 1 || v === 2
}

/**
 * Fail-safe v2 detection (NIP-CHAT §0): the hub is treated as v2 if the live
 * `version` tag, the hub-list record, OR the encrypted content says v2. Only
 * treated as v1 when *all* agree v1.
 */
export function isV2(hub: { version?: number }, signals?: VersionSignals): boolean {
  const liveV2 = hub.version === 2
  const recordedV2 = signals?.recordedFormat === 2 || signals?.recordedFormat === '2'
  const encryptedV2 = signals?.contentEncrypted === true
  return liveV2 || recordedV2 || encryptedV2
}

/**
 * Detect a version-integrity mismatch (§0): a signal says v2 but the live tag
 * reads v1 (a stripped/tampered tag, or a legacy hub). Callers MUST warn the
 * user and block publishing rather than acting as v1.
 */
export function hasVersionMismatch(hub: { version?: number }, signals?: VersionSignals): boolean {
  const liveV1 = !hub.version || hub.version === 1
  const otherSaysV2 =
    signals?.recordedFormat === 2 || signals?.recordedFormat === '2' || signals?.contentEncrypted === true
  return liveV1 && otherSaysV2
}

/** NIP-SKD scheme the hub was created under (default "skd:1" — the 48-byte wide-reduction derivation). */
export function getSignerScheme(hub: { signerScheme?: string }): string {
  return hub.signerScheme || 'skd:1'
}

/**
 * Whether this client can correctly derive the hub's pseudonyms. A hub advertising a signer scheme this
 * client doesn't implement (a future `skd:2`, or a malformed value) would yield MISMATCHED pseudonyms if we
 * tried — so v2 participation MUST be refused (fail closed) rather than silently deriving wrong keys. Only
 * meaningful for v2 hubs.
 */
export function isSupportedSignerScheme(hub: { signerScheme?: string }): boolean {
  return getSignerScheme(hub) === 'skd:1'
}
