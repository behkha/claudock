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
- "Connect to Claude Code" is the one change that makes Claude Code run something of Claudock's. You see the exact settings.json change first. It adds a status line step and nine hooks, small `sh` scripts in Claudock's own app data folder. The status line step saves the limits Claude Code sends (its `rate_limits`: the 5-hour and weekly windows today, and any it adds), then runs your own status line unchanged. Claudock rewrites that script, in its own folder, when a newer Claudock changes it. The hooks save each running session's state (working, waiting for you or done), its folder, and Claude Code's short notification text. They never save prompts or tool output, print nothing, and use no network. Claudock shows a system notification when a session starts waiting. Clicking it brings that session's terminal app forward (`open -b` on macOS). Disconnect removes both parts and puts settings.json back exactly as it was, or removes only Claudock's keys if something else changed the file in between.
- With the menu bar item shown (the default on macOS and Linux), closing the window on macOS or Windows leaves Claudock running in the menu bar or tray so alerts can arrive; Linux quits as before. Quit it from the item's menu, or turn the item off in View › Show in Menu Bar.
- The menu bar alerts are system notifications too: a session waiting, and, only if you turn them on, a limit reaching the % you chose or a limit resetting.
- **Open at login**, only when you turn it on, writes `~/Library/LaunchAgents/app.claudock.login.plist` on macOS or `~/.config/autostart/claudock.desktop` on Linux (Windows: the usual Run entry). Turning it off deletes the file.
- On macOS, `npx claudock` copies npm's Electron to `Claudock.app` in Claudock's app data folder, renames it Claudock and signs it ad hoc on your Mac, as npm's Electron already is. `CLAUDOCK_PLAIN_ELECTRON=1` runs npm's Electron instead.

## What it never reads

- `.credentials.json`
- `sessions/*.key`

Both show up as locked rows.

## What it sends

Nothing about your config. At launch it downloads Anthropic's public settings docs (code.claude.com) and the Claude Code JSON schema (json.schemastore.org, or its mirror on raw.githubusercontent.com) for the JSON editor's suggestions, Anthropic's public pricing page (platform.claude.com) and Claude Code's model configuration page (code.claude.com) for the model list and the share card's prices, and asks api.github.com for the latest Claudock release. These are plain GETs with no cookies and nothing of yours in them; the model ids from your transcripts that Settings offers are read on your machine and never sent. `CLAUDOCK_OFFLINE=1` turns all of them off. There's no telemetry and no account.

## Trying it without your real config

`npm run dev` from a clone runs the app on a generated fake config folder. `npm run dev:real` opens your real `~/.claude` with every write turned off. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
