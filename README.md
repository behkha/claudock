# Claudock

An **unofficial** desktop app (Electron, macOS / Windows / Linux) for managing the Claude Code config folder, `~/.claude`: settings, rules, hooks, permissions, skills, agents, commands, plugins, MCP servers, projects, memory, plans, history, storage and backups. It uses Anthropic's palette and type styles but not the Claude or Anthropic logos, and is not affiliated with or endorsed by Anthropic.

The build spec is [docs/SPEC.md](docs/SPEC.md).

## Setup

```sh
npm install
npm run fixture   # builds ./.fixture/claude, a synthetic config folder
npm run dev       # runs the app on the fixture
```

Node 22+ and npm 10+.

## The fixture rule

**Development and tests never write to the real `~/.claude`.** `npm run dev` and `npm run shot` set `CLAUDE_CONFIG_DIR=./.fixture/claude`. An unpackaged build also refuses every write unless `CLAUDE_CONFIG_DIR` is set (or `CLAUDOCK_ALLOW_REAL_WRITES=1`), so `npm run dev:real` is a read-only look at your own folder. The fixture is generated from scratch; nothing is copied from a real config. `.credentials.json` there contains `FAKE-DO-NOT-READ` on purpose.

All writes go through `src/main/safeWrite.ts` (snapshot to `<userData>/snapshots`, temp file + atomic rename, JSON validated, deletes to the OS Trash). `.credentials.json` and `sessions/*.key` are never read.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server + Electron on the fixture |
| `npm run dev:real` | Same on your real folder, writes disabled |
| `npm run build` | Production build into `./out` |
| `npm run typecheck` / `npm run lint` | tsc (main + renderer) / ESLint |
| `npm run fixture` | Rebuild `./.fixture/claude` |
| `npm run shot` | Headless screenshots of every screen, light and dark, into `./.shots`. `-- --only skills,palette`, `-- --out <dir>` |
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
