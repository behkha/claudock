# Contributing

Bug reports and ideas go in [Issues](https://github.com/behkha/claudock/issues/new/choose). Security problems go to [SECURITY.md](SECURITY.md) instead.

## Before you change code

Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): setup, scripts, code layout and how to add an IPC method. The build spec is [docs/SPEC.md](docs/SPEC.md).

**The fixture rule:** development and tests never write to the real `~/.claude`. `npm run dev` runs on a generated folder in `./.fixture/claude`, and a build run from a clone refuses every write unless `CLAUDE_CONFIG_DIR` is set. Don't copy anything from a real config into the fixture or into a test; generate it.

Every write to the user's config goes through `src/main/safeWrite.ts`. Never read `.credentials.json` or `sessions/*.key`.

## Pull requests

- One change per pull request, with a sentence on why.
- Run `npm run typecheck`, `npm run lint` and `npm test` before you push.
- For a change to a screen, add a before and after screenshot (`npm run shot -- --only <screen>`).
- By opening a pull request you agree that your change is released under the [MIT License](LICENSE.md).
