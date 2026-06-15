# @hivemind/cli (`hive`)

One-command setup and control for [Hivemind](../../README.md).

```bash
hive init      # save config + wire the Claude Code hooks for this repo
hive up        # start syncing this folder (background daemon)
hive status    # server health + who's editing this repo
hive down      # stop the daemon
```

`hive init` asks for your server URL, token, repo id, and actor id (or pass `--server/--token/--repo/--actor`), then:
- writes `.wt/config.json` and adds `.wt/` to `.gitignore` (so your token is never committed),
- wires `PreToolUse`/`PostToolUse` hooks into `.claude/settings.json` (they call `hive hook pre|post` — no script paths to manage).

Config is read from `.wt/config.json` or the env vars `WT_SERVER_URL`, `WT_TOKEN`, `WT_REPO`, `WT_ACTOR_ID`, `WT_RELAY` (env wins).

> Until the package is published to npm, run it from the build: `node packages/cli/dist/index.js <cmd>` (or `npm link` it to get the `hive` command).
