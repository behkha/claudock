import path from 'node:path'

/**
 * The pure parts of profiles (src/main/domains/profiles.ts): names, the start command, folder names. No Electron here,
 * so `npm test` loads it as is.
 */

/** Folder names Claude Code config folders go by: `.claude`, `.claude-work`; in a fixture or demo folder, `claude-work`. */
export const configFolderRe = (dotted: boolean): RegExp => (dotted ? /^\.claude(?:[-_.](.+))?$/i : /^claude(?:[-_.](.+))?$/i)

/** The name a folder suggests: `.claude-acme` "Acme", `.claude_side-project` "Side project", `.claude` "Default". */
export function nameFor(dir: string): string {
  const base = path.basename(dir)
  const m = /^\.?claude(?:[-_. ]+(.*))?$/i.exec(base)
  const word = (m ? (m[1] ?? '') : base.replace(/^\.+/, '')).replace(/[-_.]+/g, ' ').trim()
  if (!word) return m ? 'Default' : base
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** A name from the renderer: trimmed, one line, at most 40 characters. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Give the profile a name')
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) throw new Error('Give the profile a name')
  if ([...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) throw new Error('The name has a character that can’t be used')
  if (name.length > 40) throw new Error('Keep the name to 40 characters')
  return name
}

/** `Side project` -> `side-project`, for the folder "New folder" makes. */
export function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'profile'
  )
}

const SAFE = /^[A-Za-z0-9._/@%+=:,-]+$/

/**
 * The command that starts Claude Code on a folder. `plain`: the folder is `~/.claude`, which plain `claude` uses.
 * POSIX shells (also fish and zsh) expand `~` after `=` in an assignment; anything that needs quoting gets "$HOME/…" or
 * single quotes. PowerShell sets the variable for the session first.
 */
export function startCommand(dir: string, home: string, opts: { plain: boolean; windows: boolean }): string {
  if (opts.plain) return 'claude'
  if (opts.windows) return `$env:CLAUDE_CONFIG_DIR="${dir.replace(/[`"$]/g, '`$&')}"; claude`
  const rel = path.relative(home, dir)
  const inHome = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  let value: string
  if (inHome && SAFE.test(rel)) value = `~/${rel}`
  else if (inHome && !/["\\$`]/.test(rel)) value = `"$HOME/${rel}"`
  else value = SAFE.test(dir) ? dir : `'${dir.replace(/'/g, `'\\''`)}'`
  return `CLAUDE_CONFIG_DIR=${value} claude`
}
