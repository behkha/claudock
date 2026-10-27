/**
 * Version order and the choice of which published version to offer, kept free of Electron so `npm test` can run it.
 * The npm dist-tags are the channels: `latest` for stable releases, `beta` for pre-releases (`npx claudock@beta`).
 */

export type Channel = 'latest' | 'beta'

export interface Pick {
  version: string
  channel: Channel
}

type Version = { nums: number[]; pre: string[] | null }

function parse(v: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim())
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null } : null
}

/** Semver precedence of two pre-release identifier lists: numbers numerically and below words, a shorter prefix first. */
function comparePre(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const an = /^\d+$/.test(a[i])
    const bn = /^\d+$/.test(b[i])
    if (an && bn && a[i] !== b[i]) return Number(a[i]) - Number(b[i])
    if (an !== bn) return an ? -1 : 1
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** Positive when `a` is newer than `b` (semver order). 0 when either isn't a version. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1
  return comparePre(x.pre, y.pre)
}

export function isPrerelease(v: string): boolean {
  return parse(v)?.pre != null
}

/**
 * The newest published version newer than `current`, and the channel that installs it. A stable build only follows
 * `latest`, so it never hears about a beta. A pre-release build follows both and takes the newer one, `latest` on a tie,
 * so a beta tester moves to the stable release once it catches up.
 */
export function pickUpdate(current: string, tags: Partial<Record<Channel, string>>): Pick | null {
  const channels: Channel[] = isPrerelease(current) ? ['latest', 'beta'] : ['latest']
  let best: Pick | null = null
  for (const channel of channels) {
    const version = tags[channel]
    if (version === undefined || compareVersions(version, current) <= 0) continue
    if (best && compareVersions(version, best.version) <= 0) continue
    best = { version: version.trim().replace(/^v/, ''), channel }
  }
  return best
}
