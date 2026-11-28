Claudock is an unofficial desktop app for your Claude Code setup: settings, hooks, skills, MCP servers, memory and sessions in one window, without hand-editing the files in `~/.claude`.

## What's new in 0.6.0

- **Update from inside Claudock.** When a newer version is out, the sidebar says so and shows what's in it. Update downloads it with its progress in the sidebar, and Restart to update puts it in place and opens it again. The download is checked against the release's checksum before anything changes; if macOS doesn't let Claudock replace itself, the version you had opens again and says why. With `npx claudock`, Update installs the new version in the background. This is the last version you install by hand.
- **What's new, after every update.** The first time a new version opens, it lists what changed, with a button to the screen a note is about. Click the version at the bottom of the sidebar to see it again.
- **Auto delete listens again.** In Storage, its switch turns off, and a new age sticks, without waiting for a run first.

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
