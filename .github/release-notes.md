Claudock is an unofficial desktop app for your Claude Code setup: settings, hooks, skills, MCP servers, memory and sessions in one window, without hand-editing the files in `~/.claude`.

## What's new in 0.5.0

- **What Claudock really takes on disk.** Storage opens with Claude Code's folder and Claudock's own data on one scale. Claudock keeps every session by linking Claude Code's transcripts, so Finder and cleaner apps count those bytes twice and Claudock can look many gigabytes large. The bar shows its real size, draws the linked part hatched, and shows Finder's number struck beside it. The chevron says what the real size holds.
- **Old sessions, gone in one move.** Pick an age (14 days to a year) and see how many sessions were untouched that long and how much space they take. **See them** opens Sessions filtered to that age; **Move to Trash** moves Claude Code's files and Claudock's copies together, so the space is really freed. It never moves more than the dialog named.
- **Auto delete.** A switch under the slider moves sessions untouched for 30, 60, 90, 180 or 365 days to the Trash by itself, once a day while Claudock runs. Off until you turn it on; turning it on first shows what would go now. Each profile has its own.

Everything goes to the Trash, so you can put a session back from there.

## Download

| Your computer | File |
|---|---|
| Mac with Apple silicon (M1 or later) | `Claudock-…-arm64.dmg` |
| Mac with Intel | `Claudock-…-x64.dmg` |
| Windows | `Claudock-Setup-….exe` |
| Linux | `.AppImage` (any distribution) or `.deb` (Debian, Ubuntu), `x86_64`/`amd64` or `arm64` |

The `.zip` and `latest*.yml` files are what Update in Claudock's sidebar downloads; you don't need them.

### First launch

`npx claudock` and the install scripts skip these steps.

**macOS.** The app is not notarized by Apple yet, so macOS stops the first launch. Open the `.dmg`, drag Claudock to Applications and open it once. When macOS says it can't verify the app, click Done, then open **System Settings › Privacy & Security**, scroll down, click **Open Anyway** next to Claudock and confirm. You only do this once. If macOS says the app is damaged instead, run this in Terminal and open it again:

```
xattr -dr com.apple.quarantine /Applications/Claudock.app
```

**Windows.** The installer is not code-signed yet. If SmartScreen shows "Windows protected your PC", click **More info**, then **Run anyway**.

**Linux.** For the AppImage: `chmod +x Claudock-*.AppImage`, then run it. For the `.deb`: `sudo apt install ./Claudock-*.deb`.

Claudock reads and writes `~/.claude` (or `CLAUDE_CONFIG_DIR`). It saves a snapshot of every file before changing it, and you can restore it from **Backups**. Team also writes into the team folder you pick and two keys in a connected project's `.claude/settings.json`, and Permissions › Projects takes a rule out of a project's `.claude/settings.json` or `settings.local.json` when you remove it there. Nowhere else.
