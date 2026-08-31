/**
 * Hub membership-mutation concurrency guard (version-agnostic).
 *
 * A hub's whole state (members, bans, roles, channels) lives in ONE index file, referenced by ONE
 * pointer (the `m` tag) in the hub event. Every membership op is a read-modify-write of that pointer:
 * read the current index → mutate blobs → upload a new index → republish the hub event. With no guard,
 * two OVERLAPPING owner ops (two tabs, two devices, a fast double-click) clobber each other — a lost
 * kick/ban/role-change — and a non-rotating op racing a rotation can publish an epoch/secret/tree-
 * INCONSISTENT hub event (undecryptable hub). Two mechanisms fix it:
 *
 *  1. SINGLE-FLIGHT (`withHubMutationLock`) — an in-memory, per-hub lock so this DEVICE runs one
 *     membership op at a time; the second waits, then re-reads the current index. Kills the common
 *     same-device (two-tab/modal) races.
 *  2. CAS (`assertIndexUnchanged`) — right before republishing, re-fetch the current hub event and
 *     assert its index pointer still equals the base the op started from; abort if another writer
 *     (another device) moved it. Nostr has no atomic conditional write, so this narrows-and-usually-
 *     catches rather than eliminates, but it is the correct optimistic-concurrency backstop and is what
 *     protects across devices.
 */

/** Thrown by the CAS when the hub's index pointer moved under an in-flight mutation. */
export class HubConcurrencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HubConcurrencyError'
  }
}

/** Per-hub single-flight chain: each dTag serializes its membership mutations on this device. */
const _chains = new Map<string, Promise<unknown>>()

/**
 * Serialize a hub membership mutation with every other mutation for the same `dTag` on this device.
 * The `fn` runs only after any in-flight mutation for this hub settles (success or failure), so it can
 * re-read the current index from the store and build on the latest state instead of a stale snapshot.
 */
export function withHubMutationLock<T>(dTag: string, fn: () => Promise<T>): Promise<T> {
  const prev = _chains.get(dTag) ?? Promise.resolve()
  // Run `fn` only after the prior op settles — whether it resolved OR rejected (both handlers = fn).
  const run = prev.then(fn, fn)
  // The next op chains onto a NON-rejecting tracker, so one op's failure never wedges the chain.
  _chains.set(dTag, run.then(() => undefined, () => undefined))
  return run
}

/**
 * Acquire the per-hub mutation lock imperatively — for existing handlers with their own try/finally.
 * Awaits any in-flight mutation for this hub, then returns a `release()` to call in `finally`. Use it
 * as: `const release = await acquireHubMutationLock(dTag); try { …re-read the index… } finally { release() }`.
 */
export async function acquireHubMutationLock(dTag: string): Promise<() => void> {
  const prev = _chains.get(dTag) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  // The next op waits on `held` (which never rejects), so it can't start until we release.
  _chains.set(dTag, prev.then(() => held, () => held))
  await prev.catch(() => {}) // wait our turn
  return release
}

/**
 * CAS check: `current` is the freshly-fetched hub event; `baseIndexHash` is the index pointer the op
 * started from (`hub.indexFileHash`). If the on-relay pointer differs, another writer changed the hub
 * since this op read it — throw so the caller aborts (its uploaded blobs are orphaned/harmless) rather
 * than blindly overwriting the other change or publishing an inconsistent event.
 */
export function assertIndexUnchanged(current: { tags: string[][] }, baseIndexHash: string | undefined): void {
  if (!baseIndexHash) return // op had no known base (fresh hub) — nothing to compare
  const currentIndexHash = current.tags.find((t) => t[0] === 'm')?.[1]
  if (currentIndexHash && currentIndexHash !== baseIndexHash) {
    throw new HubConcurrencyError(
      `This hub was changed by another action while your change was in progress (index ${currentIndexHash.slice(0, 8)}… ≠ ${baseIndexHash.slice(0, 8)}…). Please try again.`,
    )
  }
}

/**
 * Fetch the current hub event and run the CAS in one call — for handlers that publish the hub event
 * DIRECTLY (not through republishV2/treeUpdater). A genuine pointer move throws HubConcurrencyError to
 * abort. `authorPubkey` is the hub author (`R_creator` on v1, `O` on v2).
 *
 * If the current event can't be fetched (relays unreachable), we retry once and then WARN LOUDLY and
 * proceed — we deliberately do NOT silently skip. The single-flight's store re-read (each handler
 * re-reads the index AFTER acquiring the lock) is the primary same-document protection; this CAS is the
 * cross-tab/cross-device backstop, and it simply can't run when relays are unreachable — but that must
 * be visible, not swallowed (else a stale-base + skipped-CAS = a silent lost update, the round-9 bug).
 */
export async function casCheckIndex(dTag: string, authorPubkey: string, baseIndexHash: string | undefined): Promise<void> {
  if (!baseIndexHash) return
  let current: { tags: string[][]; created_at: number } | null = null
  for (let attempt = 0; attempt < 2 && !current; attempt++) {
    try {
      const { fetchEvents } = await import('@/lib/nostr/relay-pool')
      const { KINDS } = await import('@/lib/crypto/constants')
      current = (await fetchEvents({ kinds: [KINDS.HUB_EVENT], authors: [authorPubkey], '#d': [dTag], limit: 4 }))
        .sort((a, b) => b.created_at - a.created_at)[0] ?? null
    } catch { /* transient — retry once */ }
  }
  if (!current) {
    // Couldn't confirm the current pointer after a retry. FAIL CLOSED — do NOT proceed as "unchanged"
    // (that's the round-9 silent-lost-update path). A rare owner membership op aborting on a total relay
    // outage is acceptable: it would fail at the publish step anyway. The owner retries when relays recover.
    throw new HubConcurrencyError('Could not confirm the hub’s current state (relays unreachable). Please try again.')
  }
  assertIndexUnchanged(current, baseIndexHash) // throws HubConcurrencyError on a real pointer move
}
