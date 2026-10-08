/**
 * structFormat — master switch for the hub STRUCT-BLOB writer (NIP-CHAT struct-blob plan).
 *
 * The struct-blob moves a hub's structural arrays (channels/roles/categories/grouped_roles/plugins) out
 * of the kind-36942 event content into an encrypted Blossom blob referenced by a `["struct", hash, epoch]`
 * tag, so the event is O(1) no matter how big the hub grows. The READER (both formats) ships and
 * propagates in a release FIRST; only once that reader is widely deployed do we flip this ON so new and
 * upgraded hubs start emitting the struct tag. A pre-reader client renders a struct hub buggy/empty, which
 * is the accepted transition cost (there is no version bump to gate on).
 *
 * Until this is true the writer machinery is fully built but DORMANT: hubs are created and edited in the
 * legacy inline format, the per-format caps stay at the legacy (tighter) numbers, and the owner upgrade UX
 * stays hidden. A hub that already carries a struct tag (if any exist) is still read and re-published
 * correctly regardless of this flag; the flag only governs whether we ADOPT the format somewhere new.
 */
export const STRUCT_FORMAT_ENABLED = false
