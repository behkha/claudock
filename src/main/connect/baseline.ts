/**
 * When Disconnect can put settings.json back byte for byte. Pure, so `npm test` loads it as is.
 *
 * The baseline is the snapshot of settings.json taken by the first Connect's write (the bytes from before Claudock
 * touched it; no snapshot = the file did not exist), plus the SHA-256 of the text Claudock wrote last. While the file
 * still hashes to that, nothing else has changed it, and restoring the snapshot loses nobody's edit.
 */

export interface Baseline {
  existed: boolean
  snapshotId: string | null
  sha: string
}

/**
 * The baseline after a successful Connect write. `first`: nothing was connected before this write. `currentSha`: the
 * file's hash read just before the write (null = missing), inside the same lock.
 */
export function baselineAfterConnect(prev: Baseline | null, first: boolean, currentSha: string | null, writtenSha: string, snapshotId: string | null): Baseline | null {
  if (first) return { existed: snapshotId !== null, snapshotId, sha: writtenSha }
  if (prev && currentSha !== null && currentSha === prev.sha) return { ...prev, sha: writtenSha }
  return null
}

/**
 * - `restore`: write the snapshot's bytes back.
 * - `trash`: the file did not exist before; move it to the Trash.
 * - `keys`: something else changed the file (or the baseline is gone): remove only Claudock's keys.
 */
export type DisconnectPlan = 'restore' | 'trash' | 'keys'

export function disconnectPlan(b: Baseline | null, currentSha: string | null): DisconnectPlan {
  if (!b || currentSha === null || currentSha !== b.sha) return 'keys'
  if (!b.existed) return 'trash'
  return b.snapshotId ? 'restore' : 'keys'
}
