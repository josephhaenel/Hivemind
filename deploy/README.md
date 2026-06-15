# Self-hosting Hivemind

Run your own Hivemind server so you and your collaborators can use it on your own repos. One script handles TLS, a service user, systemd, a firewall, and an auth token.

## 1. Server (one VPS, run once)

On a fresh Ubuntu/Debian VPS:

```bash
git clone https://github.com/josephhaenel/Hivemind.git hivemind
cd hivemind
sudo bash deploy/setup.sh
```

What it does:
- installs Node + [Caddy](https://caddyserver.com), runs the **coordination server** (`:4100`) and **sync relay** (`:4200`) under `systemd` as a non-root service user, with persistence on;
- gets **automatic HTTPS/WSS** via Caddy + Let's Encrypt — using [`sslip.io`](https://sslip.io) so you **don't need to buy a domain** (your URL will look like `https://203-0-113-5.sslip.io`). Want a nicer URL? Point a domain's A-record at the VPS and re-run with `WT_DOMAIN=hive.example.com sudo -E bash deploy/setup.sh`;
- locks the firewall to ports **22/80/443** only (the app ports are reachable only via Caddy on localhost);
- generates a shared **auth token** and prints the exact settings collaborators need.

At the end it prints something like:

```
Coordination (server URL):  https://203-0-113-5.sslip.io
Relay        (--relay):     wss://203-0-113-5.sslip.io/sync
Shared token:               a1b2c3...
```

Share the URL + token **only** with people you want in (anyone with both can join). Treat the token like a password. Open the URL in a browser for the live dashboard (enter the token in-page).

### Updating / managing

```bash
sudo bash deploy/update.sh                     # pull latest + rebuild + restart
systemctl status wt-coordination wt-relay      # health
journalctl -u wt-coordination -f               # logs
```

## 2. Each collaborator (per machine)

Everyone clones the **shared repo** you're collaborating on (start from the same commit), then connects with the `hive` CLI — one command wires the hooks, registers the MCP server, and drops a `CLAUDE.md` so the agents coordinate automatically.

```bash
# build the CLI once (until it's published to npm)
npm run install:all && npm run build

# optional: so you can just type `hive`
alias hive="node $(pwd)/packages/cli/dist/index.js"

# connect this repo (writes .hive/config.json, wires hooks + MCP, gitignores the token)
hive init \
  --server https://203-0-113-5.sslip.io \
  --token  a1b2c3... \
  --repo   my-repo \
  --actor  alice          # UNIQUE per person; --repo is the SAME for everyone

# start syncing your working tree
hive up
```

`hive init` writes the `PreToolUse`/`PostToolUse` hooks into `.claude/settings.json` for you, registers the coordination MCP server in `.mcp.json` (so the agent gets the `hive_*` tools natively), and adds a "Working together" section to `CLAUDE.md`. The hooks **fail open** — if the server is unreachable, your editing is never blocked (you just lose coordination until it's back).

Useful commands: `hive status` (connection + your claims), `hive who` (who's editing what), `hive decisions [--path <file>]` (read the shared brain), `hive down` (stop syncing).

> Prefer no CLI? The hooks and daemon also read `WT_SERVER_URL` / `WT_TOKEN` / `WT_REPO` / `WT_ACTOR_ID` from the environment, and you can run the daemon directly (`node packages/sync-daemon/dist/index.js --dir . --relay wss://<host>/sync --coord https://<host> --room <repo> --actor <name> --token <token>`). The CLI just automates all of that.

## 3. Verify

Two people, same `--repo`, different `--actor`: have one person's agent start editing a file — the other sees it appear, and their agent is blocked from editing that same function until it's released. The dashboard at `https://<server>/` shows both of you online.

## Security notes

- **The token is the only access control** in this MVP — anyone with the URL + token has full read/write to the shared state. Per-user accounts and per-repo access control are a future milestone.
- TLS is enforced end-to-end (Caddy). The app ports (4100/4200) are not exposed publicly; only Caddy reaches them.
- Run on a VPS you control; keep the OS patched and SSH key-only.
- To rotate the token: edit `/etc/wt/wt.env`, `systemctl restart wt-coordination wt-relay`, and redistribute it.
