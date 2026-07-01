#!/usr/bin/env node
'use strict';

const { execFile } = require('child_process');
const os = require('os');

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

let prevCpuSnapshot = os.cpus();

function cpuUsagePerCore() {
  const curr = os.cpus();
  const prev = prevCpuSnapshot;
  prevCpuSnapshot = curr;

  return curr.map((core, i) => {
    const prevTimes = prev[i] ? prev[i].times : core.times;
    const currTimes = core.times;
    const idleDelta = currTimes.idle - prevTimes.idle;
    const totalDelta = Object.keys(currTimes).reduce((sum, k) => sum + (currTimes[k] - prevTimes[k]), 0);
    const usagePct = totalDelta > 0 ? 100 * (1 - idleDelta / totalDelta) : 0;
    return Math.max(0, Math.min(100, usagePct));
  });
}

function usageColor(pct) {
  if (pct >= 85) return COLOR.red;
  if (pct >= 60) return COLOR.yellow;
  return COLOR.green;
}

function usageBar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  return usageColor(pct) + bar + COLOR.reset;
}

function renderCpuSection(cols) {
  const cores = cpuUsagePerCore();
  const lines = [];
  lines.push(COLOR.bold + 'CPU' + COLOR.reset);

  const barWidth = 8;
  const cellText = (i, pct) => {
    const label = pad(`C${i}`, 3);
    const pctStr = pad(Math.round(pct) + '%', 4);
    return `${label} ${usageBar(pct, barWidth)} ${pctStr}`;
  };
  const cellWidth = 3 + 1 + barWidth + 1 + 4 + 2; // label + bar + pct + gap
  const perLine = Math.max(1, Math.floor(Math.min(cols, 100) / cellWidth));

  for (let i = 0; i < cores.length; i += perLine) {
    const rowCells = [];
    for (let j = i; j < Math.min(i + perLine, cores.length); j++) {
      rowCells.push(cellText(j, cores[j]));
    }
    lines.push(rowCells.join('  '));
  }
  return lines;
}

function fetchDiskUsage() {
  return new Promise((resolve) => {
    execFile('df', ['-h', '/'], (err, stdout) => {
      if (err) return resolve(null);
      const dataLine = stdout.trim().split('\n')[1];
      if (!dataLine) return resolve(null);
      const parts = dataLine.trim().split(/\s+/);
      // Filesystem Size Used Avail Capacity ...
      if (parts.length < 5) return resolve(null);
      const [, size, used, avail, capacity] = parts;
      const pct = parseInt(capacity, 10);
      if (Number.isNaN(pct)) return resolve(null);
      resolve({ size, used, avail, pct });
    });
  });
}

function renderDiskSection(disk) {
  const lines = [];
  lines.push(COLOR.bold + 'Disk (/)' + COLOR.reset);
  if (!disk) {
    lines.push(COLOR.dim + 'disk usage unavailable' + COLOR.reset);
    return lines;
  }
  const barWidth = 30;
  const bar = usageBar(disk.pct, barWidth);
  const label = `${disk.used}/${disk.size}`;
  lines.push(`${bar} ${pad(disk.pct + '%', 4)} ${COLOR.dim}${label} used${COLOR.reset}`);
  return lines;
}

let prevNet = null;

function fetchNetworkTotals() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ib'], (err, stdout) => {
      if (err) return resolve(null);
      const seen = new Map();
      for (const line of stdout.trim().split('\n').slice(1)) {
        const tokens = line.trim().split(/\s+/);
        if (tokens.length < 7) continue;
        const name = tokens[0].replace(/\*$/, '');
        if (name === 'lo0' || seen.has(name)) continue;
        const rx = Number(tokens[tokens.length - 5]);
        const tx = Number(tokens[tokens.length - 2]);
        if (Number.isNaN(rx) || Number.isNaN(tx)) continue;
        seen.set(name, { rx, tx });
      }
      let rx = 0;
      let tx = 0;
      for (const v of seen.values()) {
        rx += v.rx;
        tx += v.tx;
      }
      resolve({ rx, tx });
    });
  });
}

function networkRates(curr) {
  const now = Date.now();
  if (!curr) return null;
  if (!prevNet) {
    prevNet = { ...curr, time: now };
    return { rxRate: 0, txRate: 0 };
  }
  const dt = (now - prevNet.time) / 1000;
  const rxRate = dt > 0 ? Math.max(0, (curr.rx - prevNet.rx) / dt) : 0;
  const txRate = dt > 0 ? Math.max(0, (curr.tx - prevNet.tx) / dt) : 0;
  prevNet = { ...curr, time: now };
  return { rxRate, txRate };
}

function formatRate(bytesPerSec) {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

function renderNetworkSection(net) {
  const lines = [];
  lines.push(COLOR.bold + 'Network' + COLOR.reset);
  if (!net) {
    lines.push(COLOR.dim + 'network usage unavailable' + COLOR.reset);
    return lines;
  }
  lines.push(
    `${COLOR.cyan}↓ RX${COLOR.reset} ${pad(formatRate(net.rxRate), 12)} ` +
    `${COLOR.cyan}↑ TX${COLOR.reset} ${pad(formatRate(net.txRate), 12)}`
  );
  return lines;
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

function render(agents, error, disk, net) {
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
  lines.push('─'.repeat(Math.min(cols, 100)));
  lines.push(...renderCpuSection(cols));
  lines.push('');
  lines.push(...renderDiskSection(disk));
  lines.push('');
  lines.push(...renderNetworkSection(net));

  lines.push('');
  lines.push(COLOR.dim + 'Ctrl+C to quit' + COLOR.reset);

  process.stdout.write('\x1b[H\x1b[J' + lines.join('\n') + '\n');
}

async function tick() {
  const [{ agents, error }, disk, netTotals] = await Promise.all([
    fetchAgents(),
    fetchDiskUsage(),
    fetchNetworkTotals(),
  ]);
  render(agents || [], error, disk, networkRates(netTotals));
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
