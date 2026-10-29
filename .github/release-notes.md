Claudock is an unofficial desktop app for your Claude Code setup: settings, hooks, skills, MCP servers, memory and sessions in one window, without hand-editing the files in `~/.claude`.

## What's new in 0.2.0

- **`npx claudock`.** Claudock is on npm. One command starts it, with no installer and no macOS or Windows security warning. Run `npx claudock@latest` to update, or `npm i -g claudock` to keep it installed.
- **One-line install.** `curl -fsSL https://behkha.github.io/claudock/install.sh | sh` on macOS and Linux, or `irm https://behkha.github.io/claudock/install.ps1 | iex` in PowerShell. These put the normal app in place without the warning. The scripts are in the repo, so you can read them first.
- **Update notice.** Claudock tells you when a new version is out and links to it.
- **Your numbers on first launch.** A 26-week activity map, sessions, messages, longest session and top model, read from `~/.claude`.
- **Connect to Claude Code.** One step, one snapshot: it adds a step in front of your status line and a few session hooks, and Disconnect removes both. Everything they record goes to Claudock's own folder, never `~/.claude`.
- **Live limits.** Once connected, Claudock shows the 5-hour and weekly % Claude Code sends to your status line, with reset times. Your status line runs as before. Until then you see token counts from transcripts.
- **Needs me.** A session waiting on a permission prompt or a question turns the menu bar mark clay, and you get one notification when it starts waiting. Several at once group into one, Focus is respected, and "Pause alerts" is in the popover. "Done" is a quiet state; its alert and sounds are opt-in.
- **Menu bar.** The higher of your two limits in the menu bar (a tray icon on Windows and Linux), a popover with waiting sessions, both limits, today's tokens and search, and an opt-in alert when either limit reaches a percentage you choose. Launch at login stays off until you turn it on.
- **Today.** The new home screen: limits, today's sessions, this week's activity, and what's worth cleaning up.
- **Profiles.** Keep separate Claude Code folders, such as work and personal, and switch between them from the title bar. Each keeps its own settings, sessions, limits and backups, and the menu bar shows every profile's waiting sessions. Add profile finds the `~/.claude-*` folders you already have. Profiles never switch logins.
- **Sessions.** Every session, live or archived, newest first. Search every prompt and reply, open a transcript at the line that matched, export it to Markdown, or copy a command that resumes it. Claudock keeps each transcript in its own archive, with hard links where the disk allows, so sessions stay after Claude Code's cleanup deletes them (30 days by default). You can turn the archive off per profile.
- **Context.** What each skill, MCP server and CLAUDE.md file adds to every session, in approximate tokens, with a switch on each skill and on your MCP servers. A skill switched off still runs when you type its `/name`, and switching it back on leaves `settings.json` byte for byte as it was.
- **Share stats by week.** A Week view next to All time: what the week would have cost at API prices, beside the plan you pick, with day bars, models, sessions, prompts and tokens. All time adds your longest run of active days. An opt-in Monday recap brings last week's card.

## Download

| Your computer | File |
|---|---|
| Mac with Apple silicon (M1 or later) | `Claudock-…-arm64.dmg` |
| Mac with Intel | `Claudock-…-x64.dmg` |
| Windows | `Claudock-Setup-….exe` |
| Linux | `.AppImage` (any distribution) or `.deb` (Debian, Ubuntu), `x86_64`/`amd64` or `arm64` |

### First launch

`npx claudock` and the install scripts skip these steps.

**macOS.** The app is not notarized by Apple yet, so macOS stops the first launch. Open the `.dmg`, drag Claudock to Applications and open it once. When macOS says it can't verify the app, click Done, then open **System Settings › Privacy & Security**, scroll down, click **Open Anyway** next to Claudock and confirm. You only do this once. If macOS says the app is damaged instead, run this in Terminal and open it again:

```
xattr -dr com.apple.quarantine /Applications/Claudock.app
```

**Windows.** The installer is not code-signed yet. If SmartScreen shows "Windows protected your PC", click **More info**, then **Run anyway**.

**Linux.** For the AppImage: `chmod +x Claudock-*.AppImage`, then run it. For the `.deb`: `sudo apt install ./Claudock-*.deb`.

Claudock reads and writes `~/.claude` (or `CLAUDE_CONFIG_DIR`). It saves a snapshot of every file before changing it, and you can restore it from **Backups**.
