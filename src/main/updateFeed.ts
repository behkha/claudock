/**
 * The update feed: electron-builder's `latest-mac.yml` / `latest.yml` / `latest-linux[-arm64].yml`, attached to each
 * GitHub release beside the installers. They name the version and, per file, its sha512 (base64) and size. No
 * Electron here, so it can be read and run on its own.
 *
 * CLAUDOCK_UPDATE_FEED=<folder URL> reads the yml, the files it names and `release.json` (GitHub's release shape: tag_name,
 * body, html_url) from that folder instead of GitHub, so a fake release served from this Mac can be installed end to end.
 */

export interface FeedFile {
  url: string
  sha512: string
  size: number | null
}

export interface Feed {
  version: string
  files: FeedFile[]
}

const REPO = 'https://github.com/behkha/claudock'

/** The folder override, with a trailing slash, or null. */
export function feedOverride(): string | null {
  const v = process.env.CLAUDOCK_UPDATE_FEED?.trim()
  if (!v) return null
  return v.endsWith('/') ? v : v + '/'
}

/** The folder a release's files are downloaded from. */
export function feedBase(version: string): string {
  return feedOverride() ?? `${REPO}/releases/download/v${version}/`
}

/** The yml electron-builder writes for this platform and arch (null where Claudock has none). */
export function feedName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'darwin') return 'latest-mac.yml'
  if (platform === 'win32') return 'latest.yml'
  if (platform === 'linux') return arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml'
  return null
}

const unquote = (v: string): string => {
  const t = v.trim()
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

/**
 * Reads the subset of YAML electron-builder writes: top-level `key: value` lines and a `files:` list of `- url:` items
 * with indented `sha512:` / `size:` keys. Throws when there is no version or no file with a sha512.
 */
export function parseFeed(text: string): Feed {
  let version = ''
  const files: FeedFile[] = []
  let inFiles = false
  let cur: Partial<FeedFile> | null = null
  const push = (): void => {
    if (cur?.url && cur.sha512) files.push({ url: cur.url, sha512: cur.sha512, size: cur.size ?? null })
    cur = null
  }
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    const top = !/^\s/.test(raw)
    if (top) {
      if (inFiles) push()
      const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(raw)
      inFiles = m?.[1] === 'files'
      if (m?.[1] === 'version') version = unquote(m[2])
      continue
    }
    if (!inFiles) continue
    const item = /^\s*-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(raw)
    const key = item ?? /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(raw)
    if (!key) continue
    if (item) {
      push()
      cur = {}
    }
    if (!cur) continue
    const value = unquote(key[2])
    if (key[1] === 'url') cur.url = value
    else if (key[1] === 'sha512') cur.sha512 = value
    else if (key[1] === 'size' && /^\d+$/.test(value)) cur.size = Number(value)
  }
  if (inFiles) push()
  if (!version) throw new Error('the update feed names no version')
  if (!files.length) throw new Error('the update feed lists no file with a sha512')
  return { version: version.replace(/^v/, ''), files }
}

/**
 * The file this copy updates from: the mac zip for this arch, the Windows setup, the AppImage for this arch. electron-builder
 * names them by electron-builder.yml's artifactName (`Claudock-0.6.0-arm64.zip`, `Claudock-Setup-0.6.0.exe`,
 * `Claudock-0.6.0-x86_64.AppImage`), and a feed built for both Mac chips lists both zips.
 */
export function pickFile(feed: Feed, platform: NodeJS.Platform = process.platform, arch: string = process.arch): FeedFile | null {
  const name = (f: FeedFile): string => decodeURIComponent(f.url.split('/').pop() ?? '')
  if (platform === 'darwin') {
    const zips = feed.files.filter((f) => name(f).endsWith('.zip'))
    return zips.find((f) => name(f).includes(`-${arch}.`)) ?? (zips.length === 1 && !/-(arm64|x64)\./.test(name(zips[0])) ? zips[0] : null)
  }
  if (platform === 'win32') return feed.files.find((f) => name(f).endsWith('.exe')) ?? null
  if (platform === 'linux') {
    const tag = arch === 'arm64' ? 'arm64' : 'x86_64'
    return feed.files.find((f) => name(f).endsWith('.AppImage') && name(f).includes(tag)) ?? null
  }
  return null
}

/** A file's download URL: absolute as given, else relative to the release's folder. */
export function fileUrl(file: FeedFile, version: string): string {
  return /^https?:\/\//.test(file.url) ? file.url : new URL(file.url, feedBase(version)).toString()
}
