/** Unsaved edits per file id, kept at module level so they survive selecting another file or leaving the screen. */
export interface Draft {
  text: string
  /** mtime the draft started from (null = the file did not exist). */
  baseMtime: number | null
}

const drafts = new Map<string, Draft>()

export const getDraft = (id: string): Draft | undefined => drafts.get(id)
export const setDraft = (id: string, d: Draft): void => void drafts.set(id, d)
export const clearDraft = (id: string): void => void drafts.delete(id)
export const hasDraft = (id: string): boolean => drafts.has(id)
