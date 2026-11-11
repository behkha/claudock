import { shQuote } from './hookScript.ts'

/**
 * The live limits status line step: a small sh script in Claudock's connect folder that saves the whole `rate_limits`
 * object Claude Code hands the status line (whatever windows it holds) to limits.json there, then runs the statusLine
 * command the user had before, with the same input. No Electron or Node imports, so `npm test` runs it as is.
 * src/main/domains/limits.ts installs it and reads what it saves.
 */

/**
 * Finds the top-level "rate_limits" value in the status line JSON and prints it. String-aware (braces inside strings
 * do not count), so it needs no jq. Single quotes are not allowed in here: the program sits in a sh '...' string.
 */
const EXTRACT_AWK = String.raw`{ s = s $0 "\n" }
END {
  n = length(s); d = 0; i = 1; f = 0
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") {
      j = i + 1
      while (j <= n) { e = substr(s, j, 1); if (e == "\\") j += 2; else if (e == "\"") break; else j++ }
      k = substr(s, i, j - i + 1); i = j + 1
      if (d == 1 && k == "\"rate_limits\"") {
        while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
        if (substr(s, i, 1) == ":") { f = 1; i++; break }
      }
      continue
    }
    if (c == "{" || c == "[") d++
    else if (c == "}" || c == "]") d--
    i++
  }
  if (!f) exit 1
  while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
  if (substr(s, i, 1) != "{") exit 1
  b = i; d = 0
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") { j = i + 1; while (j <= n) { e = substr(s, j, 1); if (e == "\\") j += 2; else if (e == "\"") break; else j++ }; i = j + 1; continue }
    if (c == "{" || c == "[") d++
    else if (c == "}" || c == "]") { d--; if (d == 0) { print substr(s, b, i - b + 1); exit 0 } }
    i++
  }
  exit 1
}`

/**
 * For people with no status line of their own: "5h 42% · week 61%", every window Claude Code sent, in its order.
 * Reads the extracted rate_limits object and names each key the short way (`five_hour` "5h", `seven_day` "week",
 * `spend_limit` "spend", `seven_day_opus` "week opus"); no list of windows in here either.
 */
const LINE_AWK = String.raw`{ s = s $0 }
function count(w,   a, m, j) {
  if (w ~ /^[0-9]+$/) return w + 0
  m = split("one two three four five six seven eight nine ten eleven twelve", a, " ")
  for (j = 1; j <= m; j++) if (a[j] == w) return j
  return 0
}
function short(k,   p, m, c, u, o, j) {
  m = split(k, p, "_"); o = ""; j = 1
  c = count(p[1]); u = p[2]; sub(/s$/, "", u)
  if (m >= 2 && c > 0 && (u == "hour" || u == "day" || u == "week" || u == "month")) {
    o = (c == 7 && u == "day") ? "week" : c (u == "month" ? "mo" : substr(u, 1, 1)); j = 3
  }
  for (; j <= m; j++) {
    if (j == m && p[j] == "limit" && (o != "" || m > 1)) break
    o = (o == "" ? "" : o " ") p[j]
  }
  return o == "" ? k : o
}
END {
  n = length(s); d = 0; i = 1; o = ""
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") {
      j = i + 1
      while (j <= n) { e = substr(s, j, 1); if (e == "\\") j += 2; else if (e == "\"") break; else j++ }
      k = substr(s, i + 1, j - i - 1); i = j + 1
      if (d != 1) continue
      while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
      if (substr(s, i, 1) != ":") continue
      i++
      while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
      if (substr(s, i, 1) != "{") continue
      b = i
      while (i <= n && substr(s, i, 1) != "}") i++
      w = substr(s, b, i - b + 1); i++
      if (!match(w, /"used_percentage"[ \t\r\n]*:[ \t\r\n]*-?[0-9.]+/)) continue
      v = substr(w, RSTART, RLENGTH); sub(/.*:[ \t\r\n]*/, "", v)
      o = (o == "" ? "" : o " · ") short(k) " " int(v + 0.5) "%"
      continue
    }
    if (c == "{" || c == "[") d++
    else if (c == "}" || c == "]") d--
    i++
  }
  if (o != "") print o
}`

/** The step's script. `original` is the previous statusLine.command, run with the same stdin, cwd and env. */
export function stepScript(original: string | null, conn: string): string {
  return [
    '#!/bin/sh',
    '# Claudock live limits. Claude Code runs this as your status line: it saves the rate_limits it receives into',
    '# this folder, then runs the status line you had before. Disconnect in Claudock to put that back.',
    `dir=${shQuote(conn)}`,
    `cmd=${shQuote(original ?? '')}`,
    'in="$dir/.in.$$"',
    `trap 'rm -f "$in" "$dir/.limits.$$"; exit 143' HUP INT TERM`,
    'if ! cat 2>/dev/null > "$in"; then',
    '  rm -f "$in" 2>/dev/null',
    '  [ -n "$cmd" ] && exec /bin/sh -c "$cmd"',
    '  exit 0',
    'fi',
    `rl=$(LC_ALL=C awk '${EXTRACT_AWK}' "$in" 2>/dev/null)`,
    'if [ -n "$rl" ]; then',
    `  if printf '{"v":1,"at":%s,"rate_limits":%s}\\n' "$(date +%s)" "$rl" > "$dir/.limits.$$" 2>/dev/null; then`,
    '    mv -f "$dir/.limits.$$" "$dir/limits.json" 2>/dev/null || rm -f "$dir/.limits.$$"',
    '  else',
    '    rm -f "$dir/.limits.$$" 2>/dev/null',
    '  fi',
    'fi',
    'if [ -n "$cmd" ]; then',
    '  exec < "$in"',
    '  rm -f "$in"',
    '  trap - HUP INT TERM',
    '  if command -v bash >/dev/null 2>&1; then exec bash -c "$cmd"; fi',
    '  exec /bin/sh -c "$cmd"',
    'fi',
    'rm -f "$in"',
    `[ -n "$rl" ] && printf '%s\\n' "$rl" | LC_ALL=C awk '${LINE_AWK}'`,
    'exit 0',
    ''
  ].join('\n')
}
