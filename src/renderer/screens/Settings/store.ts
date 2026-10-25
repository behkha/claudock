import type { SettingsFileName } from '@shared/api/settings'

/**
 * Unsaved edits, one per settings file. Module-level so they survive switching files and leaving the screen through the
 * sidebar (the screen unmounts then). An entry exists only while the draft differs from the file on disk.
 */
export interface Draft {
  text: string
  /** mtime of the file the draft was started from; sent with Save to detect that the file changed meanwhile. */
  baseMtime: number | null
}

const drafts = new Map<SettingsFileName, Draft>()

export const getDraft = (file: SettingsFileName): Draft | undefined => drafts.get(file)
export const setDraft = (file: SettingsFileName, d: Draft): void => void drafts.set(file, d)
export const clearDraft = (file: SettingsFileName): void => void drafts.delete(file)
