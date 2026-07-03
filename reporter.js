#!/usr/bin/env node
'use strict';

// Runs on every observed machine: collects a local snapshot (agent sessions,
// system vitals, process tree, token history) and pushes it to the central
// hub on an interval. No TTY/rendering — meant to run under launchd/pm2/a
// plain background shell.

const os = require('os');
const { collectSnapshot, scanTokenHistory, TOKEN_SCAN_MS, requestJson } = require('./collector');

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

const flags = parseArgs();
const HUB_URL = (flags.hub || process.env.CLAUDE_OBSERVER_HUB_URL || '').replace(/\/$/, '');
const TOKEN = flags.token || process.env.CLAUDE_OBSERVER_TOKEN;
const MACHINE = flags.name || process.env.CLAUDE_OBSERVER_MACHINE || os.hostname();
const SSH_HINT = flags['ssh-hint'] || process.env.CLAUDE_OBSERVER_SSH_HINT || null;
const PUSH_MS = ((Number(flags.interval || process.env.CLAUDE_OBSERVER_PUSH_INTERVAL_S)) || 3) * 1000;

if (!HUB_URL || !TOKEN) {
  console.error('hub URL and token are required: --hub <url> --token <t> (or CLAUDE_OBSERVER_HUB_URL / CLAUDE_OBSERVER_TOKEN)');
  process.exit(1);
}

// A slow hub or network must not stack collect+push cycles — skip the tick
// and let the in-flight one finish (same pattern as the collector's
// diskIoFetchInFlight guard).
let pushInFlight = false;
let lastPushFailed = false;

async function pushTick() {
  if (pushInFlight) return;
  pushInFlight = true;
  try {
    const snapshot = await collectSnapshot({ machine: MACHINE, sshHint: SSH_HINT });
    const { status } = await requestJson('POST', `${HUB_URL}/report`, { token: TOKEN, body: snapshot });
    if (status === 204) {
      if (lastPushFailed) console.log(`push ok again (${snapshot.agents.length} agents)`);
      lastPushFailed = false;
    } else {
      lastPushFailed = true;
      console.error(`hub rejected report: HTTP ${status}${status === 401 ? ' (check token)' : ''}`);
    }
  } catch (e) {
    lastPushFailed = true;
    console.error(`push failed: ${e.message}`);
  } finally {
    pushInFlight = false;
  }
}

function main() {
  console.log(`reporting as "${MACHINE}" to ${HUB_URL} every ${PUSH_MS / 1000}s${SSH_HINT ? ` (ssh hint: ${SSH_HINT})` : ''}`);
  scanTokenHistory();
  setInterval(scanTokenHistory, TOKEN_SCAN_MS);
  pushTick();
  setInterval(pushTick, PUSH_MS);
}

main();
