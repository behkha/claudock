Claudock is an unofficial desktop app for your Claude Code setup: settings, hooks, skills, MCP servers, memory and sessions in one window, without hand-editing the files in `~/.claude`.

## What's new in 0.4.0

- **How large each session is.** Every running Claude Code session shows the context it carries, on Today and in the menu bar popover, in tokens as Claude Code recorded them. A session that large re-reads all of it on every turn, which is where a weekly limit goes. It works for sessions in the Claude desktop app too, and it is never a "% full": Claudock does not know the model's window.
- **A size you pick, and one alert.** In the popover's alert settings, "A session's context reaches" offers 150k, 300k, 500k and 750k, each saying about how many times a day it would have alerted in your own last 14 days. Once you pick one, each row gets a thin bar that fills toward it, and Claudock alerts once when a session passes it. It is ready again after the session falls below half of it. Off until you choose.
- **Every rule your projects saved.** Answering a permission prompt with "don't ask again" makes Claude Code save the whole command as a rule inside the project. Permissions › Projects lists every such rule across the projects Claude Code knows, in one table.
- **Secrets in saved rules, flagged.** If the command carried a password or a token, the rule does too. Those rules are flagged and listed first, with the secret covered. The sheet says which file holds the rule and whether git tracks or ignores that file, and **Remove rule** takes that one rule out of the file after a snapshot you can restore from Backups. **Not a secret** clears a flag for that exact rule.
- **Rules that run any script.** A filter finds the rules that let Claude run any Python, Node or shell script. They are choices you made, so they are never flagged.
- **A chip, and an alert you switch on.** Today shows how many rules are waiting for a look, and so does Permissions in the sidebar. "A saved rule holds a secret" in the alert settings alerts when a new one appears. Off until you turn it on.

Removing the rule does not change the secret: change it where it was issued. Claudock covers a secret before showing it, never copies it and never sends it anywhere. To read the git line it runs two read-only git commands on the rule file and no other.

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

Claudock reads and writes `~/.claude` (or `CLAUDE_CONFIG_DIR`). It saves a snapshot of every file before changing it, and you can restore it from **Backups**. Team also writes into the team folder you pick and two keys in a connected project's `.claude/settings.json`, and Permissions › Projects takes a rule out of a project's `.claude/settings.json` or `settings.local.json` when you remove it there. Nowhere else.
