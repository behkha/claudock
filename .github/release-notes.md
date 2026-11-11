Claudock is an unofficial desktop app for your Claude Code setup: settings, hooks, skills, MCP servers, memory and sessions in one window, without hand-editing the files in `~/.claude`.

## What's new in 0.3.0

- **Team.** Share one Claude Code setup with your team. Tick the skills, agents, commands, hooks and MCP servers the team should have, and Claudock writes them as a Claude Code plugin and marketplace into a git repo folder you pick. Teammates install it with one command and need only Claude Code, which then keeps them up to date by itself. Claudock never runs git and never sends anything: you commit and push.
- **A check before anything is written.** A token in an MCP server's settings, or a hook that runs a script from your home folder, stops the write until it is fixed. The token becomes a question each teammate answers once (or a variable), and the script is copied into the plugin. Every file is then listed before the one button that writes them.
- **Changes from both sides.** The repo is the source. Team shows what changed in your folder, in the repo, or in both, and can take the repo's version of a skill, agent or command into your own folder, with a snapshot in Backups.
- **Connect a project.** Two keys in a project's `.claude/settings.json` point it at the team's marketplace. Disconnect takes them out again and leaves the rest of the file as it was.
- **What an update changed.** On a teammate's side, Team shows what the last update added, changed and removed, and what the shared setup adds to every session in approximate tokens.
- **Every limit Claude Code reports.** The menu bar, the popover, Today and the alerts show each limit window Claude Code sends, not only the 5-hour and weekly ones.
- **Models and prices from their source.** The model list in Settings and the prices on the week card are read from Anthropic's own pages at launch, with a bundled copy for offline. Settings also offers the model ids found in your own transcripts.
- **Easier to read and to use from the keyboard.** Darker secondary text, quieter rows for things that are off, a sidebar that keeps the open screen in view, larger hit areas, and names and roles for screen readers in the diff view, the profile menu, the Context table and the popover.

CLAUDE.md, rules, model, permissions and environment variables stay yours: a Claude Code plugin cannot carry them, and Team says so on each.

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
