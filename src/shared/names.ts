/** Windows device names: a file called `con`, `nul.md` or `com1.txt` cannot be created there (or opens the device instead). */
const WIN_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\s*(?:\..*)?$/i

/** True for Windows reserved device names, with or without an extension. Checked on every OS so a config folder stays portable. */
export function isReservedName(name: string): boolean {
  return WIN_RESERVED_RE.test(name.trim())
}

export const RESERVED_NAME_ERROR = 'That name is reserved by Windows (con, prn, aux, nul, com1-9, lpt1-9). Pick another.'
