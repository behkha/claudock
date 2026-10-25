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

**Development and tests never write to the real `~/.claude`.** `npm run dev` and `npm run shot` set `CLAUDE_CONFIG_DIR=./.fixture/claude`. An unpackaged build also refuses every write unless `CLAUDE_CONFIG_DIR` is set (or `CLAUDOCK_ALLOW_REAL_WRITES=1`), so `npm run dev:real` is a read-only look at your own folder. The fixture is generated from scratch; nothing is copied from a real config. `.credentials.json` there contains `FAKE-DO-NOT-READ` on purpose.

All writes to the user's config go through `src/main/safeWrite.ts` (snapshot to `<userData>/snapshots`, temp file + atomic rename, JSON validated, deletes to the OS Trash). The one other file the app writes is its own cache of the settings docs, `<userData>/settings-docs.json`: app data, not config, so it is written directly (temp file + rename) and never snapshotted. `.credentials.json` and `sessions/*.key` are never read.

At launch the main process downloads Anthropic's settings docs for the Settings JSON editor (`src/main/settingsDocs.ts`). `CLAUDOCK_OFFLINE=1` skips that fetch, so the editor uses the cache or the copy bundled with the app (screenshots skip it too).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server + Electron on the fixture |
| `npm run dev:real` | Same on your real folder, writes disabled |
| `npm run build` | Production build into `./out` |
| `npm run typecheck` / `npm run lint` | tsc (main + renderer) / ESLint |
| `npm run fixture` | Rebuild `./.fixture/claude` |
| `npm run shot` | Headless screenshots of every screen, light and dark, into `./.shots`. `-- --only skills,palette`, `-- --out <dir>` |
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
