# Claudock — build spec

Claudock is a desktop app for managing the Claude Code config folder (`~/.claude`) on macOS, Windows and Linux. It is an unofficial tool: it uses Anthropic's brand palette and type, but never the Claude or Anthropic logos.

Design source of truth: the "Claudock design options" canvas, Option A (three-pane workbench), with Option B's dashboard as the home screen.

## Stack

- Electron + electron-vite + React 18 + TypeScript (strict). Package manager: npm.
- Routing: a small in-app router (state-based, no URL routing needed) or `react-router` memory router.
- Editors: CodeMirror 6 (`@uiw/react-codemirror` or the raw packages) for JSON and Markdown, with light and dark themes made from our tokens.
- Markdown preview: `react-markdown` + `remark-gfm`. Never use `dangerouslySetInnerHTML` on file content.
- Packaging: electron-builder → macOS `dmg` (arm64 + x64), Windows `nsis`, Linux `AppImage` + `deb`.
- No CSS framework. Plain CSS modules or one global stylesheet using the tokens below.

## Folder resolution (main process)

- Launch folder: `process.env.CLAUDE_CONFIG_DIR` if set, else `path.join(os.homedir(), '.claude')`. This is the same rule Claude Code uses, so it works on all three OSes.
- Config dir: the folder of the profile open in the window (see Profiles), which is the launch folder until another profile is opened. Every domain reads it through `configDir()`.
- Global state file: `.claude.json` inside the config dir, except for `~/.claude` started without the env var, which uses `~/.claude.json` (as Claude Code does).
- Always use `path.join` / `path.sep`. Never hard-code `/`.

## Safety rules (non-negotiable)

1. **Never read, display, copy or back up `.credentials.json`** or any `*.key` file under `sessions/`. Show them only as a locked row ("Credentials — hidden").
2. **Every write goes through `safeWrite()`** in the main process: snapshot the current file into the snapshot store, write to a temp file in the same folder, then `rename` over the target (atomic). JSON files are validated before writing and keep 2-space indentation and a trailing newline. The one write that adds a file from Claudock's own data (a session put back from the archive, `placeNewFile`) never replaces anything, so it has nothing to snapshot.
3. **Snapshot store**: `<app userData>/snapshots/<ISO timestamp>/<path relative to config dir>`, plus a `manifest.json` per snapshot (`{ at, reason, files: [rel paths], dir }`, `dir` being the config folder it was taken in). Backups lists only the open profile's snapshots (those without `dir`, from before profiles, belong to the launch folder Claudock had when profiles first loaded), and a restore never crosses profiles. Snapshots never go into `~/.claude` itself.
4. **Deletes go to the OS Trash** via `shell.trashItem`, never `fs.rm`. The session archive removes only its own extra names for bytes that are also somewhere else (Claude Code's file, or the Trash after a delete); whatever only the archive has goes to the Trash.
5. **`.claude.json` is written by Claude Code constantly.** Re-read it immediately before writing, change only the key being edited (e.g. `mcpServers`), and write atomically.
6. **The renderer has no Node access.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. On Linux systems that block Chromium's OS sandbox for unpackaged apps (Ubuntu 24.04), `npx claudock` and the AppImage start with `--no-sandbox`, like electron-builder's AppImage launcher; the `.deb` keeps it. Every file path coming from the renderer is resolved and checked to be inside the config dir (or the global state file) before use.
7. **Development and tests never write to the real `~/.claude`.** Use `npm run fixture` to build `./.fixture/claude` (a synthetic config dir) and run with `CLAUDE_CONFIG_DIR=./.fixture/claude`. Reading the real folder for a look is fine; writing to it is not.

## Architecture

```
src/
  shared/            types + IPC contracts shared by main and renderer
    ipc.ts           channel names + the `ClaudockApi` type (one namespace per domain)
    types.ts
  main/
    index.ts         app lifecycle
    windows.ts       the main window, page loading, the Dock icon while the menu bar is shown
    menubar.ts       the menu bar item (tray), its popover window, the limit alerts
    menubar/         pure parts of the menu bar (what it shows, the limit alert rule, login item files), unit-tested
    loginItem.ts     Open at login
    paths.ts         config dir resolution + `resolveInside()` guard
    safeWrite.ts     snapshot + atomic write + JSON validation
    domains/         ONE file per domain; each exports `register(ipcMain)`
      today.ts overview.ts storage.ts backups.ts settings.ts rules.ts hooks.ts
      permissions.ts context.ts skills.ts agents.ts commands.ts plugins.ts mods.ts mcp.ts
      projects.ts memory.ts plans.ts history.ts search.ts system.ts
      limits.ts sessions.ts connect.ts   (live limits, "needs me" sessions, Connect to Claude Code; per profile folder)
      menubar.ts       (what the popover asks of the menu bar)
      profiles.ts      (profiles: which folder the window shows, every profile's glance for the menu bar)
      archive.ts       (the session archive behind the Sessions screen; per profile folder)
      context.ts       (what each skill, MCP server and CLAUDE.md file adds to every session; per profile folder)
    profiles/        pure parts of profiles (names, the start command), unit-tested
    archive/         pure parts of the session archive (search text, matching, Markdown, the resume command, link or copy), unit-tested
    context/         pure parts of Context (Claude Code's session-start records, the rows, the switch values), unit-tested
    transcripts/     reading Claude Code transcripts (lines, entries), shared by Projects and the archive
    connect/         pure parts of Connect (hook script, settings merge, session model, alert rule), unit-tested
    demo/            `--demo`: the synthetic config (fixture.ts, also `npm run fixture`) built in its own data folder
    domains/index.ts registers all of them (already lists every domain)
  preload/index.ts   exposes `window.claudock` built from the domain list
  renderer/
    main.tsx App.tsx
    styles/tokens.css styles/base.css
    components/      shared primitives (see below)
    screens/         ONE folder per screen, same names as the sidebar
    popover/         the menu bar popover (popover.html, a second page)
    lib/api.ts       typed `window.claudock` accessor + `useQuery`-style hook
scripts/
  make-fixture.mjs   builds ./.fixture/claude and ./.fixture/claude-work from src/main/demo/fixture.ts and workFixture.ts
  shot.mjs           launches the app on the fixture and saves a PNG per screen to ./.shots
```

Each domain owns: `src/main/domains/<domain>.ts`, its slice of types in `src/shared/api/<domain>.ts`, and its screen folder. Workers stay inside the files they own.

## Navigation (sidebar groups, in order)

- **Home**: Today
- **Configure**: Settings, CLAUDE.md & rules, Hooks, Permissions
- **Extend**: Context, Skills, Agents, Commands, Plugins, Mods, MCP servers
- **Your data**: Sessions, Projects, Memory, Plans, History
- **Maintain**: Storage, Backups

Each item shows a count or size on the right when one is cheap to get. A search field in the title bar opens a ⌘K / Ctrl+K command palette that searches across skills, agents, rules, hooks, sessions, memory and settings keys and jumps to the result; sessions match by title, then by the words of their prompts and replies, opening at the line that matched.

## Screens

Layout for every list-type screen: sidebar (220–240px) · list pane (300–360px, title in serif 24px, filter chips, rows) · detail pane (title serif 28px, mono path line, body, action row). Today, Settings and Storage use the full width instead of list + detail.

- **Today (home)**: one column, capped at a reading width. The headline is today's tokens and sessions, with the last 7 days of tokens as bars beside it (to scale, today in clay), a "Worth a look · <size>" chip that opens Storage (hidden when nothing is flagged) and Share (the Share stats dialog). Then the Claude Code card: running sessions (waiting, working with the last tool it finished, done), each named as Claude Code names it (else by its first prompt) with its folder beside it, both limits (the % Claude Code sent to the status line; "Limit reached" with the reset time when it refused a request; else the window's tokens, since desktop-app sessions never run the status line), and Connect / Disconnect. Then "Earlier today": today's other sessions (name, folder, first to last message, tokens), each opening its transcript in Projects; "No sessions yet today" when there are none. The sessions and the week come from the limits transcript scan (`today.get()`), so no number is invented. On Windows the card is left out.
- **Settings**: `settings.json` and `settings.local.json` (tabs). Views: Form · JSON · History. Form covers model, effort, theme, status line, env vars, and links to Hooks / Permissions / Skills / Plugins for those keys; unknown keys stay intact and are editable in JSON view. History lists snapshots of the file and the loose `.bak` copies, with a diff and Restore.
- **CLAUDE.md & rules**: `CLAUDE.md` plus every `rules/*.md`. Markdown editor with preview, new rule, rename, move to Trash.
- **Hooks**: grouped by event; each hook shows matcher + command; add / edit / remove; writes `hooks` in `settings.json`. Claudock's own hooks (Connect to Claude Code) are one read-only "Connect to Claude Code" row whose Disconnect… opens the Disconnect dialog on Today; they are left out of every hook count (sidebar badge, Settings form).
- **Permissions**: `defaultMode`, and allow / ask / deny rule lists with add / remove.
- **Context**: full width. What every session of the open profile starts with, from the newest transcript that recorded it: the total (`≈ 3.4k tokens per session`), a bar of it (the biggest item in clay), filters (All, Skills, MCP servers, CLAUDE.md & rules, Unused: nothing in 30 days), then one table, most tokens first and the ones turned off under "Off": a switch, the name and its kind (`MCP · 28 tools`, `skill · user`), Used (skills: Claude Code's own count and last use; servers: tool calls in the last 30 days, `0 in 30 d`), and Tokens with a bar. Every token number is an estimate (characters ÷ 3.5) and carries `≈`; an item turned off is an exact `0`; a server with nothing to measure says why (`needs login`, `failed`, `connecting`, `not seen`). Opening a row shows the exact text counted and, where one edits it, Open in Skills / MCP servers / CLAUDE.md & rules. A skill's switch writes `skillOverrides` `user-invocable-only` (Claude no longer sees it, `/name` still runs it) and on removes it; a user server's switch adds or removes `{ "serverName": … }` in settings.json `deniedMcpServers`, leaving its settings in the global state file untouched. Skills only the session listed (Claude Code's own, a project's, a plugin's installed elsewhere) switch the same way; synced skills (switched on the Skills screen), servers from plugins, claude.ai or the app running Claude Code, and CLAUDE.md & rules have no switch. Skills that won't load (plugin off, `disable-model-invocation`) are left out. The footer names the session measured. The sidebar shows the total.
- **Skills**: user skills (`skills/*/SKILL.md`), synced skills, and plugin skills (read-only). On/off toggle writes `skillOverrides` (`off`); a row set elsewhere to `name-only` or `user-invocable-only` reads "Name only" or "/name only". Detail: frontmatter, SKILL.md (editable for user skills), file list, size, Reveal, Open in editor, Duplicate, Move to Trash.
- **Agents** / **Commands**: `agents/*.md` and `commands/**/*.md`; list, edit with frontmatter form + body, new from template, Trash.
- **Plugins**: installed plugins, marketplaces, enable / disable (writes `enabledPlugins`).
- **Mods**: plugins whose `hooks/hooks.json` has `modules`. Installed ones (enable / disable via `enabledPlugins`), folders in `CLAUDE_CODE_PLUGIN_DIRS` and `mods/` (load / stop loading by editing that env var in `settings.json`), and drafts Claude wrote in `dev-mods/<session>/<name>` (Keep moves one to `mods/<name>` and loads it; Trash). Shows what the hooks module draws, hooks and calls (read from its source, never run), its `$.store` data in `plugins/store` (Clear sends it to the Trash) and its README.
- **MCP servers**: user-scope servers from the global state file; add / edit / remove (see safety rule 5), and an Enabled switch (settings.json `deniedMcpServers`, the same as Context's); a server turned off reads "off" in the list.
- **Sessions**: every session of the open profile, newest first, whether Claude Code still has its transcript or only the archive does (see Session archive): name (Claude Code's custom title, else the first prompt), folder, when, size, an Archived badge once Claude Code deleted it. "Search every session" matches every word in the title, prompts and replies (not tool output), each hit showing the line that matched; opening it scrolls the transcript there. Filters: All, Archived. Detail: the folder, when and how many messages, Copy resume command (`cd <folder> && claude --resume <id>`, with the profile's `CLAUDE_CONFIG_DIR`; a deleted session is put back in `projects/` first, dated now), Export… (Markdown: prompts and replies in full, each tool call one line), Move to Trash (Claude Code's files, and anything only the archive has, to the Trash), and the transcript viewer, which opens a search hit past its first page at that line, with Show from the start. The list's footer says what the archive holds and the disk it takes beyond Claude Code's folder ("Archive on · 41 archived · 120 MB") and its ⋯ menu has Show archive folder and Stop archiving this profile… (which can also move the archived sessions to the Trash).
- **Projects**: one row per project folder; the real path comes from the `cwd` in its transcripts, not the folder name. Detail: sessions (title = first user prompt, date, size, message count), transcript viewer, Move to Trash per session or for sessions older than N days (the archive lets go of those too).
- **Memory**: `projects/*/memory/*.md` grouped by project; view / edit / Trash; `MEMORY.md` index shown first.
- **Plans**: `plans/*.md` with preview.
- **History**: `history.jsonl` with search and project filter.
- **Storage**: drill-down bars per folder with sizes, plus the cleanup findings ("Worth a look": big project transcripts, large skills that are turned off, old CLI downloads, loose `*.bak*` files in the root, large logs, empty CLAUDE.md, etc.), each with a one-click action.
- **Backups**: Claudock snapshots (restore / diff / delete) and loose `.bak` files found in the config dir (diff against current, restore, or tidy into `backups/`).

## First run

The first launch shows the user's own Claude Code numbers in the whole window under the title bar, in place of the sidebar and the screen: "Your Claude Code since <month>", the 26-week heat map, then messages (or prompts), sessions, longest session and top model, from the same stats as Share stats. The heat map fills in week by week and the numbers count up, 1.2 s in all and once (nothing moves under Reduce Motion); the buttons work from the start. Connect to Claude Code opens the card's Connect sheet, Not now shows the window as usual (Today), Share opens the Share stats dialog. On Windows, where Connect doesn't run yet, the one button is Continue. With no recorded sessions the heat map stays empty and "No sessions yet" replaces the numbers. It shows once, to anyone with neither Connect part on; leaving it any way (a button, a navigation from ⌘K or the menu bar, or an error in it) sets `revealed` in prefs.json, and it never comes back.

## Profiles

A profile is a Claude Code config folder (what `CLAUDE_CONFIG_DIR` names) shown under a name; Claudock never reads or swaps the logins inside one. The launch folder is always a profile. The title bar's folder is the switcher: its menu lists every profile (name, folder, its higher limit or today's tokens, a clay dot while one of its sessions waits), the command that starts Claude Code on the open one (`CLAUDE_CONFIG_DIR=~/.claude-work claude`, or `claude` for `~/.claude`) with Copy, and Add profile…; right-click a profile to rename it, show its folder or remove it (forget it, never delete the folder; not the open one or the launch folder). The profile's name shows in the title bar once there are several. Add profile lists the Claude Code folders found beside the launch folder (`~/.claude-*`), New folder (an empty `~/.claude-<name>`; Claude Code asks to log in the first time it runs there) and Choose folder… (the system picker, hidden folders shown), with a name filled in from the folder. Opening a profile reloads every screen on its folder (asking first about unsaved edits). Each profile connects to Claude Code on its own. Started with `CLAUDE_CONFIG_DIR`, Claudock opens that folder; otherwise the profile open last.

## Session archive

Claude Code deletes a transcript `cleanupPeriodDays` (30) days after it was last touched, at its next start. Claudock keeps every session of every profile, from the first launch on: each transcript (and its folder of sub-agent transcripts) is hard-linked into `<app userData>/archive/<folder key>/`, so the archive shares Claude Code's bytes and costs nothing until Claude Code deletes its file; on a disk without hard links it is copied (taking the same space again), and what Claude Code appends is appended. A version only the archive has is never replaced by an older file put back under its name; it is kept beside it. A sweep runs a few seconds after launch, every 10 minutes and when Sessions opens: it holds every profile's transcripts first, then reads them for search one profile at a time. Nothing is written into the config folder to keep a session. Stopping is per profile (the Sessions footer menu) and leaves what only the archive has, unless the user also sends it to the Trash. A development build keeps its own archive (`archive.dev`) and archives only the fixture.

## Menu bar

On by default on macOS and Linux, off on Windows until Connect works there (View › Show in Menu Bar / Show in Tray; Open at Login is there too). The item shows the Claudock mark and the higher of the 5-hour and weekly percentages, only when Claude Code reported them and the window hasn't reset; while a session waits, the mark turns clay with a dot. With several profiles the number is the open profile's, the clay mark lights for a session waiting in any profile, and limit alerts name the profile. Clicking it opens a 320px popover: sessions (waiting first; every profile's, each naming its profile when there are several), both limits (the open profile's), one line per other profile (its limits or today's tokens; clicking it opens that profile in the window), today's tokens, "Search sessions" (opens the window with ⌘K), Pause 1 h, a gear for the settings view (reminder, done alert, limit alert %, limit reset alert, sound, Open at login, Show in menu bar, Quit) and Open Claudock. Right-click gives a native menu (Open Claudock, Pause, Quit). With the item shown, closing the window keeps Claudock running on macOS (the Dock icon goes with the window) and Windows; Linux quits as before, since many desktops show no tray and Electron can't tell.

Scanning 8+ GB must not block the UI: size scans run async in the main process with a concurrency limit, stream progress, and cache results by path + mtime.

## Design tokens

Fonts (no font files are shipped; the stacks fall back honestly):
- Sans: `'Anthropic Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`
- Serif: `'Anthropic Serif', Georgia, 'Times New Roman', Times, serif`
- Mono: `'Anthropic Mono', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Courier New', monospace`

Type scale: display 38/330 serif · title 28/500 serif · heading 24/500 serif · body 14–16/400 sans · small 13 · caption 12. Letter-spacing 0. Headings never bold beyond 500.

Theme follows the OS (`prefers-color-scheme`) with an override (System / Light / Dark) in the app menu.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#FAF9F5` | `#262624` |
| `--sidebar` | `#F5F4ED` | `#1F1E1D` |
| `--surface` | `#FFFFFF` | `#30302E` |
| `--surface-sunken` | `#F0EEE6` | `#1A1918` |
| `--text` | `#141413` | `#FAF9F5` |
| `--text-2` | `#5E5D59` | `#C2C0B6` |
| `--text-3` | `#73726C` | `#9C9A92` |
| `--border` | `rgba(31,30,29,0.15)` | `rgba(222,220,209,0.15)` |
| `--border-strong` | `rgba(31,30,29,0.3)` | `rgba(222,220,209,0.3)` |
| `--hover` | `rgba(115,114,108,0.10)` | `rgba(222,220,209,0.08)` |
| `--selected` | `rgba(115,114,108,0.14)` | `rgba(222,220,209,0.12)` |
| `--accent` (Clay) | `#D97757` | `#D97757` |
| `--oat` | `#E3DACC` | `#3D3D3A` |
| `--primary-bg` / `--primary-fg` | `#141413` / `#FAF9F5` | `#FAF9F5` / `#141413` |
| `--danger` | `#A13A2B` | `#E58D7C` |
| `--success` | `#558A42` | `#86B573` |
| `--focus` | `#2A78D6` | `#6A9BCC` |

Rules: Clay is the only accent and is used for indicators (toggle on, active dot, the biggest storage segment), never as a fill under white text. Borders are 0.5px using the border tokens; no coloured borders for structure. Radii: 8px controls, 12px cards. Hit targets ≥ 32px in this dense desktop UI, ≥ 44px for primary actions. Visible focus ring (`--focus`, 2px). No gradients, emoji, or left-border accent cards. Icons: inline stroke SVG (1.8px), or `lucide-react`.

## Shared components (renderer/components)

`Button` (primary / secondary / ghost / danger), `IconButton` (needs `aria-label`), `Toggle`, `Segmented`, `Chip`, `Badge`, `TextField`, `Select`, `SearchField`, `ListPane` + `ListRow`, `DetailPane` (title, path, actions slot), `EmptyState`, `ConfirmDialog`, `Toast`, `CodeEditor` (JSON / Markdown), `MarkdownView`, `DiffView`, `SizeBar`, `PathLabel` (mono, middle-truncated, Reveal on click), `Spinner`, `Kbd`.

## Definition of done

- `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
- `npm run shot` produces a screenshot of every screen in light and dark, on the fixture, with no console errors.
- `npm run dist:mac` produces a working `.dmg`. Windows and Linux targets are configured in electron-builder.
