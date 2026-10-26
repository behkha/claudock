# Security

## Reporting a problem

Report it privately on GitHub: [Security › Report a vulnerability](https://github.com/behkha/claudock/security/advisories/new). Please don't open a public issue for it. Include the Claudock version (shown at the bottom of the sidebar), how you installed it, your OS, and the steps that show the problem.

Replies come on the advisory. Fixes go into the next release, and the advisory is published once that release is out. Only the latest release gets fixes.

## What Claudock reads and writes

Claudock works on the Claude Code config folder (`~/.claude`, or the folder in `CLAUDE_CONFIG_DIR`) and the MCP servers in `~/.claude.json`.

- Before every change it saves a snapshot of the file outside `~/.claude`. It then writes to a temp file and renames it over the original, so a crash can't leave a half-written file. JSON is validated before it is written.
- For `~/.claude.json` it re-reads the file right before writing and changes only the key you edited.
- Deletes go to the OS Trash.
- It doesn't run, update or sign in to Claude Code, and it doesn't touch the `.claude/` folders inside your repositories.

## What it never reads

- `.credentials.json`
- `sessions/*.key`

Both show up as locked rows.

## What it sends

Nothing about your config. At launch it downloads Anthropic's public settings docs (code.claude.com) and the Claude Code JSON schema (json.schemastore.org, or its mirror on raw.githubusercontent.com) for the JSON editor's suggestions, and asks api.github.com for the latest Claudock release. `CLAUDOCK_OFFLINE=1` turns both off. There's no telemetry and no account.

## Trying it without your real config

`npm run dev` from a clone runs the app on a generated fake config folder. `npm run dev:real` opens your real `~/.claude` with every write turned off. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
