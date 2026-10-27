/**
 * The session hooks "Connect to Claude Code" adds, and the sh script they run. No Electron or Node imports, so
 * `npm test` loads it as is.
 *
 * Each hook runs `sh '<connect dir>/hook.sh' <step>` and the script appends ONE line to
 * `<connect dir>/sessions/<session id>.jsonl`: the step, the time and a few top-level strings from the hook input
 * (never the prompt or tool output). It reads nothing back and decides nothing, so hooks that run at the same time
 * (they are async) can't overwrite each other; Claudock works out the state from the lines in order
 * (src/main/connect/sessionModel.ts). SessionEnd deletes the file. The script prints nothing (UserPromptSubmit stdout
 * would reach Claude's context) and always exits 0.
 */

/** POSIX single quoting: safe for any string, including quotes and `$`. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** What a hook tells the script: the argument after the script path, and the `e` of the line it appends. */
export type HookStep = 'prompt' | 'ask' | 'question' | 'tool' | 'notify' | 'stop' | 'end'

export interface HookSpec {
  event: string
  /** Claude Code matcher, or null for every occurrence. */
  matcher: string | null
  step: HookStep
  /** Async hooks never hold Claude Code up. SessionEnd stays synchronous: Claude Code exits right after it. */
  async: boolean
}

/**
 * The hooks, in the order they are added. What each line means is decided in `applyEvent()`.
 * - UserPromptSubmit (prompt): working.
 * - PermissionRequest (ask): a permission dialog is up, for this tool and agent. Not a wait by itself.
 * - PreToolUse on AskUserQuestion (question): Claude asked a question.
 * - PostToolUse, PostToolUseFailure (tool): a tool finished or failed.
 * - Notification on a permission prompt or an MCP input request (notify): Claude Code's own "needs you", sent only
 *   once a permission dialog has waited about 6 seconds. Not `idle_prompt`, which comes about a minute after every
 *   finished turn.
 * - Stop, StopFailure (stop): the turn ended, also on an API or rate-limit error.
 * - SessionEnd (end): the file goes.
 */
export const HOOKS: readonly HookSpec[] = [
  { event: 'UserPromptSubmit', matcher: null, step: 'prompt', async: true },
  { event: 'PermissionRequest', matcher: null, step: 'ask', async: true },
  { event: 'PreToolUse', matcher: 'AskUserQuestion', step: 'question', async: true },
  { event: 'PostToolUse', matcher: null, step: 'tool', async: true },
  { event: 'PostToolUseFailure', matcher: null, step: 'tool', async: true },
  { event: 'Notification', matcher: 'permission_prompt|elicitation_dialog|elicitation_url_dialog', step: 'notify', async: true },
  { event: 'Stop', matcher: null, step: 'stop', async: true },
  { event: 'StopFailure', matcher: null, step: 'stop', async: true },
  { event: 'SessionEnd', matcher: null, step: 'end', async: false }
]

export const HOOK_TIMEOUT_S = 5

/** Bytes of hook input the script parses. Claude Code puts session_id, cwd and the event's short fields first. */
export const INPUT_CAP = 16_384

export const hookScriptPath = (dir: string): string => `${dir.replace(/\/+$/, '')}/hook.sh`

export const hookCommand = (dir: string, step: HookStep): string => `sh ${shQuote(hookScriptPath(dir))} ${step}`

/** The settings.json hook entry for one spec. */
export function hookEntry(dir: string, spec: HookSpec): Record<string, unknown> {
  return { type: 'command', command: hookCommand(dir, spec.step), timeout: HOOK_TIMEOUT_S, ...(spec.async ? { async: true } : {}) }
}

/**
 * Prints `key<TAB>token` for the wanted top-level keys whose value is a string, where token is the JSON string
 * exactly as it appears in the input (quotes and escapes kept, so it can be written back into JSON unchanged).
 * String-aware: braces and quotes inside strings do not count. A token longer than its key's limit is left out (a tool
 * or agent name becomes "?", which matches nothing), so a whole line stays under 2.5 KB.
 * No single quotes in here: the program sits in a sh '...' string.
 */
const PICK_AWK = String.raw`BEGIN { want["session_id"] = 128; want["cwd"] = 1024; want["notification_type"] = 100; want["message"] = 600; want["tool_name"] = 200; want["agent_id"] = 200 }
{ s = s $0 "\n" }
END {
  n = length(s); d = 0; i = 1; key = ""; expect = 0
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") {
      j = i + 1
      while (j <= n) { e = substr(s, j, 1); if (e == "\\") j += 2; else if (e == "\"") break; else j++ }
      t = substr(s, i, j - i + 1); i = j + 1
      if (d == 1 && expect) {
        if (key in want && !(key in got)) {
          got[key] = 1
          if (length(t) <= want[key] + 2) print key "\t" t
          else if (key == "tool_name" || key == "agent_id") print key "\t" "\"?\""
        }
        expect = 0
        continue
      }
      if (d == 1) {
        m = i
        while (m <= n && substr(s, m, 1) ~ /[ \t\r\n]/) m++
        if (substr(s, m, 1) == ":") { key = substr(t, 2, length(t) - 2); expect = 1; i = m + 1 }
      }
      continue
    }
    if (c == "{" || c == "[") { d++; expect = 0 }
    else if (c == "}" || c == "]") d--
    else if (expect && c !~ /[ \t\r\n]/) expect = 0
    i++
  }
}`

/** The hook script for a connect folder. `dir` is absolute. */
export function hookScript(dir: string): string {
  return [
    '#!/bin/sh',
    '# Claudock session status. Claude Code runs this from the hooks Claudock added to settings.json: it appends one',
    '# line about this session to a file in this folder and prints nothing. Disconnect in Claudock to remove the hooks.',
    'exec >/dev/null 2>&1',
    `dir=${shQuote(dir.replace(/\/+$/, ''))}`,
    'step="$1"',
    '# the fields read here come first in the input; the rest (prompts, tool output) is drained unread, so a large',
    '# payload costs no parsing time',
    `in=$(head -c ${INPUT_CAP})`,
    'cat >/dev/null',
    `vals=$(printf '%s' "$in" | LC_ALL=C awk '${PICK_AWK}')`,
    `get() { printf '%s\\n' "$vals" | LC_ALL=C awk -F '\\t' -v k="$1" '$1 == k { print substr($0, length(k) + 2); exit }'; }`,
    'sid=$(get session_id); sid=${sid#\\"}; sid=${sid%\\"}',
    'case "$sid" in ""|*[!A-Za-z0-9_-]*) exit 0 ;; esac',
    'f="$dir/sessions/$sid.jsonl"',
    'case "$step" in',
    '  prompt|ask|question|tool|notify|stop) ;;',
    '  end) rm -f "$f"; exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
    '# a JSON string token as is, or null',
    'tok() { v=$(get "$1"); [ -n "$v" ] && printf \'%s\' "$v" || printf null; }',
    'tool=$(tok tool_name); agent=$(tok agent_id); nt=$(tok notification_type)',
    'msg=null; cwd=null; app=null',
    '# the Claude Code process, on every line, so Claudock can drop the session once it exits (sh -c may sit between)',
    'pid=$PPID',
    'case "$(ps -o comm= -p "$pid" 2>/dev/null)" in',
    '  sh|bash|dash|zsh|-sh|-bash|-zsh|*/sh|*/bash|*/dash|*/zsh) pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d \' \') ;;',
    'esac',
    'case "$pid" in ""|*[!0-9]*) pid=0 ;; esac',
    '# a finished tool is the most frequent line: keep it short',
    'if [ "$step" != tool ]; then',
    '  msg=$(tok message); cwd=$(tok cwd)',
    '  # the terminal app, so "Show" can bring it forward (macOS sets this for apps it launches)',
    '  case "${__CFBundleIdentifier:-}" in ""|[!A-Za-z0-9]*|*[!A-Za-z0-9.-]*) ;; *) [ ${#__CFBundleIdentifier} -le 200 ] && app="\\"$__CFBundleIdentifier\\"" ;; esac',
    'fi',
    'mkdir -p "$dir/sessions" || exit 0',
    '# the line goes into a file of its own first, then cat appends it with one write: the shell printf may write a',
    '# long line in pieces, which hooks running at the same time would interleave',
    'tmp="$dir/sessions/.$sid.$$.line"',
    `printf '{"v":2,"at":%s,"e":"%s","tool":%s,"agent":%s,"nt":%s,"message":%s,"cwd":%s,"pid":%s,"app":%s}\\n' "$(date +%s)" "$step" "$tool" "$agent" "$nt" "$msg" "$cwd" "$pid" "$app" > "$tmp" && cat "$tmp" >> "$f"`,
    'rm -f "$tmp"',
    'exit 0',
    ''
  ].join('\n')
}
