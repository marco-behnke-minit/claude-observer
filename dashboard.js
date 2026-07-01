#!/usr/bin/env node
'use strict';

const { execFile } = require('child_process');

const REFRESH_MS = (Number(process.argv[2]) || 2) * 1000;

const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const STATUS_ORDER = { waiting: 0, busy: 1, idle: 2, completed: 3 };
const STATUS_COLOR = {
  waiting: COLOR.red + COLOR.bold,
  busy: COLOR.yellow,
  idle: COLOR.gray,
  completed: COLOR.green,
};

function shortenPath(p) {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) p = '~' + p.slice(home.length);
  const max = 46;
  if (p.length <= max) return p;
  return COLOR.dim + '…' + COLOR.reset + p.slice(-(max - 1));
}

function elapsed(startedAt) {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function pad(str, len) {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  const gap = Math.max(0, len - visible.length);
  return str + ' '.repeat(gap);
}

function fetchAgents() {
  return new Promise((resolve) => {
    execFile('claude', ['agents', '--json', '--all'], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ error: err.message });
      try {
        resolve({ agents: JSON.parse(stdout) });
      } catch (e) {
        resolve({ error: 'failed to parse claude agents output: ' + e.message });
      }
    });
  });
}

function render(agents, error) {
  const cols = process.stdout.columns || 100;
  const lines = [];
  const title = ` Claude Agents Dashboard `;
  const now = new Date().toLocaleTimeString();
  lines.push(COLOR.bold + COLOR.cyan + title + COLOR.reset + COLOR.dim + `  refreshing every ${REFRESH_MS / 1000}s  •  ${now}` + COLOR.reset);
  lines.push('─'.repeat(Math.min(cols, 100)));

  if (error) {
    lines.push(COLOR.red + 'Error: ' + error + COLOR.reset);
  } else if (!agents.length) {
    lines.push(COLOR.dim + 'No background agent sessions found.' + COLOR.reset);
  } else {
    const sorted = [...agents].sort((a, b) => {
      const oa = STATUS_ORDER[a.status] ?? 9;
      const ob = STATUS_ORDER[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      return b.startedAt - a.startedAt;
    });

    const header = [
      pad('NAME', 20),
      pad('STATUS', 12),
      pad('DETAIL', 22),
      pad('ELAPSED', 9),
      pad('PID', 8),
      'PROJECT',
    ].join(' ');
    lines.push(COLOR.bold + header + COLOR.reset);

    for (const a of sorted) {
      const statusColor = STATUS_COLOR[a.status] || COLOR.reset;
      const row = [
        pad((a.name || '').slice(0, 20), 20),
        pad(statusColor + a.status + COLOR.reset, 12),
        pad((a.waitingFor || '-').slice(0, 22), 22),
        pad(elapsed(a.startedAt), 9),
        pad(String(a.pid), 8),
        shortenPath(a.cwd),
      ].join(' ');
      lines.push(row);
    }
  }

  lines.push('');
  lines.push(COLOR.dim + 'Ctrl+C to quit' + COLOR.reset);

  process.stdout.write('\x1b[H\x1b[J' + lines.join('\n') + '\n');
}

async function tick() {
  const { agents, error } = await fetchAgents();
  render(agents || [], error);
}

function main() {
  process.stdout.write('\x1b[?1049h\x1b[?25l');

  const cleanup = () => {
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  tick();
  setInterval(tick, REFRESH_MS);
}

main();
