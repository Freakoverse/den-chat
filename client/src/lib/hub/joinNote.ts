/**
 * Join note (NIP-CHAT §6.3.1) — the short free-text a requester attaches to a join request
 * ("why I want in", an intro, a passphrase the community asks for), and the hub's optional
 * prompt for it.
 *
 * The hub advertises the prompt in a PLAINTEXT tag, because a prospective member holds no secret
 * yet (same reasoning as the join PoW `W` tag):
 *
 *   ["join_note", "optional" | "required", "<prompt text>"]
 *
 * The note itself is never plaintext on relays — v1 NIP-44 to the creator, v2 inside the sealed
 * payload — see lib/hub/hubListPrivacy (nip44EncryptTo) and lib/hub/v2join.
 */

export type JoinNoteMode = 'optional' | 'required'

export interface JoinNotePolicy {
  mode: JoinNoteMode
  prompt: string
}

/** Max note length — the classic short-post limit. Enforced on send; ignored beyond on read. */
export const JOIN_NOTE_MAX = 280
/** Max prompt length shown to requesters. */
export const JOIN_PROMPT_MAX = 200

/** Read the `join_note` tag; undefined when absent or malformed (⇒ optional, no prompt). */
export function parseJoinNoteTag(tags: string[][]): JoinNotePolicy | undefined {
  const t = tags.find((x) => x[0] === 'join_note')
  if (!t) return undefined
  const mode: JoinNoteMode = t[1] === 'required' ? 'required' : 'optional'
  const prompt = (t[2] ?? '').slice(0, JOIN_PROMPT_MAX)
  // A tag with neither a requirement nor a prompt says nothing — treat as absent.
  if (mode === 'optional' && !prompt.trim()) return undefined
  return { mode, prompt }
}

/** The tag for a policy; null when there's nothing to advertise. */
export function joinNoteTag(policy: JoinNotePolicy | undefined): [string, string, string] | null {
  if (!policy) return null
  const prompt = policy.prompt.trim().slice(0, JOIN_PROMPT_MAX)
  if (policy.mode === 'optional' && !prompt) return null
  return ['join_note', policy.mode, prompt]
}

/** Same policy on the wire? (both absent, or same mode + trimmed prompt) */
export function joinNoteEqual(a: JoinNotePolicy | undefined, b: JoinNotePolicy | undefined): boolean {
  const ta = joinNoteTag(a)
  const tb = joinNoteTag(b)
  if (!ta && !tb) return true
  if (!ta || !tb) return false
  return ta[1] === tb[1] && ta[2] === tb[2]
}

/** Trim + cap a note for sending; empty string when nothing usable. */
export function normalizeJoinNote(note: string | undefined | null): string {
  return (note ?? '').trim().slice(0, JOIN_NOTE_MAX)
}
