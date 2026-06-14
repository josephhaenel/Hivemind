# @workingtogether/cli (`wt`)

One-command setup and control for [WorkingTogether](../../README.md).

```bash
wt init      # save config + wire the Claude Code hooks for this repo
wt up        # start syncing this folder (background daemon)
wt status    # server health + who's editing this repo
wt down      # stop the daemon
```

`wt init` asks for your server URL, token, repo id, and actor id (or pass `--server/--token/--repo/--actor`), then:
- writes `.wt/config.json` and adds `.wt/` to `.gitignore` (so your token is never committed),
- wires `PreToolUse`/`PostToolUse` hooks into `.claude/settings.json` (they call `wt hook pre|post` — no script paths to manage).

Config is read from `.wt/config.json` or the env vars `WT_SERVER_URL`, `WT_TOKEN`, `WT_REPO`, `WT_ACTOR_ID`, `WT_RELAY` (env wins).

> Until the package is published to npm, run it from the build: `node packages/cli/dist/index.js <cmd>` (or `npm link` it to get the `wt` command).
