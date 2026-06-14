#!/usr/bin/env node
/**
 * wt — WorkingTogether CLI.
 */
import { status } from "./status.js";
import { hookPre, hookPost } from "./hook.js";
import { init } from "./init.js";
import { up, down } from "./daemon.js";

const HELP = `wt — WorkingTogether CLI

Usage:
  wt init                Set up this repo: save config + wire the Claude Code hooks
  wt up                  Start syncing this folder (background daemon)
  wt down                Stop the daemon
  wt status              Show server health + who's editing this repo
  wt hook pre|post       Internal: the Claude Code Edit/Write hooks (wired by init)

Config comes from .wt/config.json (written by init) or env:
  WT_SERVER_URL  WT_TOKEN  WT_REPO  WT_ACTOR_ID  WT_RELAY

Docs: https://github.com/josephhaenel/WorkingTogether`;

async function main(): Promise<void> {
  const [cmd, sub] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      await init();
      break;
    case "up":
      up();
      break;
    case "down":
      down();
      break;
    case "status":
      await status();
      break;
    case "hook":
      if (sub === "pre") await hookPre();
      else if (sub === "post") await hookPost();
      else {
        console.error("usage: wt hook <pre|post>");
        process.exit(2);
      }
      break;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
