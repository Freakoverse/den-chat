/**
 * historyGuard — the one rule for the epoch-secret history blob (NIP-CHAT §5.4):
 *
 *   A rotation MUST NOT proceed without the prior history.
 *
 * Every rotation path (kick, manual rotate, v1 and v2) used to wrap the history download in
 * `catch { /* start fresh */ }`. A transient Blossom miss at that exact moment then rebuilt the blob
 * from only the old + new epochs and dropped every earlier secret. Existing members never noticed —
 * they hold those secrets locally — but anyone added afterwards could never decrypt anything from
 * before that rotation, and nothing told the creator. "Start fresh" is only legitimate when the
 * index carries no history hash at all (a hub that has genuinely never rotated).
 */
export function historyReadFailure(historyHash: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err)
  return (
    `Epoch history (${historyHash.slice(0, 12)}…) could not be read from the hub's Blossom servers, so the rotation was aborted rather than lose past secrets. ` +
    `Run "Check & fix Blossom servers" and try again. (${reason})`
  )
}
