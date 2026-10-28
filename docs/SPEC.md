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

- Config dir: `process.env.CLAUDE_CONFIG_DIR` if set, else `path.join(os.homedir(), '.claude')`. This is the same rule Claude Code uses, so it works on all three OSes.
- Global state file: `$CLAUDE_CONFIG_DIR/.claude.json` when the env var is set, else `~/.claude.json`.
- Always use `path.join` / `path.sep`. Never hard-code `/`.

## Safety rules (non-negotiable)

1. **Never read, display, copy or back up `.credentials.json`** or any `*.key` file under `sessions/`. Show them only as a locked row ("Credentials — hidden").
2. **Every write goes through `safeWrite()`** in the main process: snapshot the current file into the snapshot store, write to a temp file in the same folder, then `rename` over the target (atomic). JSON files are validated before writing and keep 2-space indentation and a trailing newline.
3. **Snapshot store**: `<app userData>/snapshots/<ISO timestamp>/<path relative to config dir>`, plus a `manifest.json` per snapshot (`{ at, reason, files: [rel paths] }`). Snapshots never go into `~/.claude` itself.
4. **Deletes go to the OS Trash** via `shell.trashItem`, never `fs.rm`.
5. **`.claude.json` is written by Claude Code constantly.** Re-read it immediately before writing, change only the key being edited (e.g. `mcpServers`), and write atomically.
6. **The renderer has no Node access.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Every file path coming from the renderer is resolved and checked to be inside the config dir (or the global state file) before use.
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
      overview.ts storage.ts backups.ts settings.ts rules.ts hooks.ts
      permissions.ts skills.ts agents.ts commands.ts plugins.ts mods.ts mcp.ts
      projects.ts memory.ts plans.ts history.ts search.ts system.ts
      limits.ts sessions.ts connect.ts   (live limits, "needs me" sessions, Connect to Claude Code)
      menubar.ts       (what the popover asks of the menu bar)
    connect/         pure parts of Connect (hook script, settings merge, session model, alert rule), unit-tested
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
  make-fixture.mjs   builds ./.fixture/claude
  shot.mjs           launches the app on the fixture and saves a PNG per screen to ./.shots
```

Each domain owns: `src/main/domains/<domain>.ts`, its slice of types in `src/shared/api/<domain>.ts`, and its screen folder. Workers stay inside the files they own.

## Navigation (sidebar groups, in order)

- **Home**: Overview
- **Configure**: Settings, CLAUDE.md & rules, Hooks, Permissions
- **Extend**: Skills, Agents, Commands, Plugins, Mods, MCP servers
- **Your data**: Projects, Memory, Plans, History
- **Maintain**: Storage, Backups

Each item shows a count or size on the right when one is cheap to get. A search field in the title bar opens a ⌘K / Ctrl+K command palette that searches across skills, agents, rules, hooks, sessions, memory and settings keys and jumps to the result.

## Screens

Layout for every list-type screen: sidebar (220–240px) · list pane (300–360px, title in serif 24px, filter chips, rows) · detail pane (title serif 28px, mono path line, body, action row). Overview, Settings and Storage use the full width instead of list + detail.

- **Overview (home)**: storage bar by top-level folder; "Worth a look" list computed from real data (big project transcripts, large skills that are turned off, old CLI downloads, loose `*.bak*` files in the root, large logs, empty CLAUDE.md, etc.), each with a one-click action; "What you have" counts; "Settings at a glance".
- **Settings**: `settings.json` and `settings.local.json` (tabs). Views: Form · JSON · History. Form covers model, effort, theme, status line, env vars, and links to Hooks / Permissions / Skills / Plugins for those keys; unknown keys stay intact and are editable in JSON view. History lists snapshots of the file and the loose `.bak` copies, with a diff and Restore.
- **CLAUDE.md & rules**: `CLAUDE.md` plus every `rules/*.md`. Markdown editor with preview, new rule, rename, move to Trash.
- **Hooks**: grouped by event; each hook shows matcher + command; add / edit / remove; writes `hooks` in `settings.json`. Claudock's own hooks (Connect to Claude Code) are one read-only "Connect to Claude Code" row whose Disconnect… opens the Overview card's Disconnect dialog; they are left out of every hook count (sidebar badge, Overview tile, Settings form).
- **Permissions**: `defaultMode`, and allow / ask / deny rule lists with add / remove.
- **Skills**: user skills (`skills/*/SKILL.md`), synced skills, and plugin skills (read-only). On/off toggle writes `skillOverrides`. Detail: frontmatter, SKILL.md (editable for user skills), file list, size, Reveal, Open in editor, Duplicate, Move to Trash.
- **Agents** / **Commands**: `agents/*.md` and `commands/**/*.md`; list, edit with frontmatter form + body, new from template, Trash.
- **Plugins**: installed plugins, marketplaces, enable / disable (writes `enabledPlugins`).
- **Mods**: plugins whose `hooks/hooks.json` has `modules`. Installed ones (enable / disable via `enabledPlugins`), folders in `CLAUDE_CODE_PLUGIN_DIRS` and `mods/` (load / stop loading by editing that env var in `settings.json`), and drafts Claude wrote in `dev-mods/<session>/<name>` (Keep moves one to `mods/<name>` and loads it; Trash). Shows what the hooks module draws, hooks and calls (read from its source, never run), its `$.store` data in `plugins/store` (Clear sends it to the Trash) and its README.
- **MCP servers**: user-scope servers from the global state file; add / edit / remove (see safety rule 5).
- **Projects**: one row per project folder; the real path comes from the `cwd` in its transcripts, not the folder name. Detail: sessions (title = first user prompt, date, size, message count), transcript viewer, Move to Trash per session or for sessions older than N days.
- **Memory**: `projects/*/memory/*.md` grouped by project; view / edit / Trash; `MEMORY.md` index shown first.
- **Plans**: `plans/*.md` with preview.
- **History**: `history.jsonl` with search and project filter.
- **Storage**: drill-down bars per folder with sizes, plus the cleanup actions from Overview.
- **Backups**: Claudock snapshots (restore / diff / delete) and loose `.bak` files found in the config dir (diff against current, restore, or tidy into `backups/`).

## Menu bar

On by default on macOS and Linux, off on Windows until Connect works there (View › Show in Menu Bar / Show in Tray; Open at Login is there too). The item shows the Claudock mark and the higher of the 5-hour and weekly percentages, only when Claude Code reported them and the window hasn't reset; while a session waits, the mark turns clay with a dot. Clicking it opens a 320px popover: sessions (waiting first), both limits, today's tokens, "Search sessions" (opens the window with ⌘K), Pause 1 h, a gear for the settings view (reminder, done alert, limit alert %, limit reset alert, sound, Open at login, Show in menu bar, Quit) and Open Claudock. Right-click gives a native menu (Open Claudock, Pause, Quit). With the item shown, closing the window keeps Claudock running on macOS (the Dock icon goes with the window) and Windows; Linux quits as before, since many desktops show no tray and Electron can't tell.

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
