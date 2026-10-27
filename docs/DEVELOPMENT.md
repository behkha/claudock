# Developing Claudock

The build spec is [SPEC.md](SPEC.md).

## Setup

Node 22.12 or later (Electron 45 and Vite 8 require it).

```sh
npm install
npm run fixture   # builds ./.fixture/claude, a synthetic config folder
npm run dev       # runs the app on the fixture
```

## The fixture rule

**Development and tests never write to the real `~/.claude`.** `npm run dev` and `npm run shot` set `CLAUDE_CONFIG_DIR=./.fixture/claude`. A build run from the git clone also refuses every write unless `CLAUDE_CONFIG_DIR` is set (or `CLAUDOCK_ALLOW_REAL_WRITES=1`), so `npm run dev:real` is a read-only look at your own folder. Installers and the npm copy (`npx claudock`, app folder inside a `node_modules`) write normally (`installKind()` in `src/main/paths.ts`). The fixture is generated from scratch; nothing is copied from a real config. `.credentials.json` there contains `FAKE-DO-NOT-READ` on purpose.

All writes to the user's config go through `src/main/safeWrite.ts` (snapshot to `<userData>/snapshots`, temp file + atomic rename, JSON validated, deletes to the OS Trash). Claudock's own data is written directly (temp file + rename) and never snapshotted: `<userData>/prefs.json` (theme and the "needs me" alert settings), the cache of the settings docs, `<userData>/settings-docs.json`, and the connect folder, `<userData>/connect/<config dir hash>/`. "Connect to Claude Code" (`src/main/domains/connect.ts`) adds two parts to settings.json in one safeWrite (snapshot, atomic write, under the settings.json lock): the live limits status line step (`statusline.sh`, which Claude Code runs as the status line and which saves the last `rate_limits` to `limits.json`; `src/main/domains/limits.ts`) and nine session hooks that run `hook.sh` (`src/main/connect/hookScript.ts`) and append one line per event to `sessions/<session id>.jsonl`; Claudock works out from those lines whether the session is working, waiting for you or done (`src/main/connect/sessionModel.ts`, read by `src/main/domains/sessions.ts`, which also posts the waiting alert). `state.json` there keeps the previous `statusLine`, what the hooks created, and the snapshot Disconnect uses to put settings.json back byte for byte when nothing else changed it. Disconnect leaves `hook.sh` as a no-op and `statusline.sh` in place, for sessions that run them until Claude Code reloads settings.json. `.credentials.json` and `sessions/*.key` are never read.

At launch the main process downloads Anthropic's settings docs for the Settings JSON editor (`src/main/settingsDocs.ts`). `CLAUDOCK_OFFLINE=1` skips that fetch, so the editor uses the cache or the copy bundled with the app (screenshots skip it too). Installed copies also check for a newer release to show a new-version notice (`src/main/update.ts`): a stable build asks GitHub for the latest release, a beta build (a version with `-`) asks npm for the `latest` and `beta` dist-tags. `CLAUDOCK_OFFLINE=1` skips that too. `CLAUDOCK_LATEST_VERSION=9.9.9 npm run dev` shows the notice without a request (a pre-release value counts as the newest beta, so a stable build ignores it).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server + Electron on the fixture |
| `npm run dev:real` | Same on your real folder, writes disabled |
| `npm run build` | Production build into `./out` |
| `npm run typecheck` / `npm run lint` | tsc (main + renderer) / ESLint |
| `npm test` | Unit tests (`src/**/*.test.ts`) with Node's test runner |
| `npm run fixture` | Rebuild `./.fixture/claude` |
| `npm run fixture:hooks` | After "Connect to Claude Code" in `npm run dev`: plays three Claude Code sessions through the fixture's hooks (one waiting on a permission prompt, one working, one done) and keeps them alive until Ctrl+C (`-- --group`: all three wait at once, for the grouped alert) |
| `npm run fixture:status` | Plays Claude Code calling the fixture's status line once with sample `rate_limits` (`-- --five 80`, `--week`, `--no-limits`, `--expired`) |
| `npm run shot` | Headless screenshots of every screen, light and dark, into `./.shots`. `-- --only skills,palette`, `-- --out <dir>`. `connect` runs Connect, plays the hooks, checks for exactly one alert, then Disconnect, and fails unless settings.json is byte for byte as before |
| `npm run settings-docs` | Re-downloads Anthropic's settings docs and JSON schema and rebuilds `src/main/settingsDocs.bundled.json`, the offline fallback for the JSON editor's suggestions. Run it before a release |
| `npm run dist:mac` / `dist:win` / `dist:linux` | electron-builder packages into `./dist` |

## Layout

```
src/shared     IPC contracts (api/<domain>.ts), nav, types, format and frontmatter helpers
src/main       window, menu, paths, safeWrite, fsx, domains/<domain>.ts (one file per domain)
src/preload    generic bridge, no per-method code
src/renderer   shell, components, lib, screens/<Screen>/index.tsx
```

### Adding an IPC method to a domain

1. Declare it in `src/shared/api/<domain>.ts` (`export interface SkillsApi { list(): Promise<SkillInfo[]> }`).
2. Implement it in `src/main/domains/<domain>.ts` inside `defineDomain(ipcMain, '<domain>', { ... })`. The object must satisfy the whole interface.
3. Call it from the screen: `const { data, error, loading, reload } = useApi(() => api.skills.list(), [])`.

Events from main to renderer: add `'<domain>:<name>': Payload` to `<Domain>Events`, send with `emit(...)` from `src/main/ipcx.ts`, receive with `useEvent(...)`.
