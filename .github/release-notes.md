Claudock is an unofficial desktop app for your Claude Code setup: settings, hooks, skills, MCP servers, memory and sessions in one window, without hand-editing the files in `~/.claude`.

## What's new in 0.6.1

- **What's new waits for its notes.** If the notes couldn't be downloaded the first time a new version opened (offline, or GitHub busy), this list came up empty and didn't come back. Now it shows on a later launch, once the notes are in.

Coming from 0.5 or earlier? 0.6 added Update in the sidebar: from now on a new version downloads, installs and restarts from inside Claudock, and this list shows what changed.

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
