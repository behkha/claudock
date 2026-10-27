import type { LiveSession } from './api/sessions'

/** What a waiting session needs from you, in words: Claude Code's own text when it sent one. */
export function waitText(s: Pick<LiveSession, 'kind' | 'message' | 'tool'>): string {
  if (s.message) return s.message
  if (s.kind === 'question') return 'Claude has a question'
  if (s.kind === 'input') return 'Claude needs your input'
  return s.tool ? `Claude needs your permission to use ${s.tool}` : 'Claude needs your permission'
}
