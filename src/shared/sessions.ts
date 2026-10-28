import type { LiveSession } from './api/sessions'

/** What a waiting session needs from you, in words: Claude Code's own text when it sent one. */
export function waitText(s: Pick<LiveSession, 'kind' | 'message' | 'tool'>): string {
  if (s.message) return s.message
  if (s.kind === 'question') return 'Claude has a question'
  if (s.kind === 'input') return 'Claude needs your input'
  return s.tool ? `Claude needs your permission to use ${s.tool}` : 'Claude needs your permission'
}

const DID: Record<string, string> = {
  Bash: 'Ran a command',
  BashOutput: 'Checked a command',
  Edit: 'Edited a file',
  MultiEdit: 'Edited a file',
  Write: 'Wrote a file',
  NotebookEdit: 'Edited a notebook',
  Read: 'Read a file',
  Glob: 'Looked for files',
  Grep: 'Searched the code',
  WebFetch: 'Read a web page',
  WebSearch: 'Searched the web',
  Task: 'Ran an agent',
  Agent: 'Ran an agent',
  TodoWrite: 'Updated its to-do list',
  Skill: 'Used a skill'
}

/** What a working session did last, in words: "Ran a command", "Used claude-in-chrome" for an MCP tool. */
export function activityText(tool: string): string {
  const mcp = /^mcp__(.+?)__/.exec(tool)
  return DID[tool] ?? `Used ${mcp ? mcp[1] : tool}`
}
