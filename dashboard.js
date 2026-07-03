#!/usr/bin/env node
'use strict';

// Terminal dashboard for claude-observer. Renders the aggregated
// multi-machine view pulled from the hub — it never collects anything
// locally; every machine (including this one) reports via reporter.js.

const { execFile } = require('child_process');
const path = require('path');
const readline = require('readline');
const { SCHEMA_VERSION, buildProcessTree, inflateProcessTree, requestJson, loadDotEnv } = require('./collector');

loadDotEnv(path.join(__dirname, '.env'));

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  let positional = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else if (positional === null) {
      positional = args[i];
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs();
const HUB_URL = (flags.hub || process.env.CLAUDE_OBSERVER_HUB_URL || '').replace(/\/$/, '');
const TOKEN = flags.token || process.env.CLAUDE_OBSERVER_TOKEN;
const REFRESH_MS = (Number(positional) || 2) * 1000;
// Machines stale for longer than this disappear from the view entirely
// (replaced by a one-line count, so they don't vanish silently). Unset =
// never hide, only gray out — the default.
const HIDE_STALE_MS = (Number(flags['hide-stale-after'] || process.env.CLAUDE_OBSERVER_HIDE_STALE_S) || 0) * 1000;

if (!HUB_URL || !TOKEN) {
  console.error('hub URL and token are required: --hub <url> --token <t> (or CLAUDE_OBSERVER_HUB_URL / CLAUDE_OBSERVER_TOKEN)');
  process.exit(1);
}

const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

const STATUS_ORDER = { waiting: 0, busy: 1, idle: 2, completed: 3 };
const STATUS_COLOR = {
  waiting: COLOR.red + COLOR.bold,
  busy: COLOR.yellow,
  idle: COLOR.gray,
  completed: COLOR.green,
};

// ---------------------------------------------------------------------------
// Text helpers

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

function pad(str, len) {
  const visible = str.replace(ANSI_RE, '');
  const gap = Math.max(0, len - visible.length);
  return str + ' '.repeat(gap);
}

function padLeft(str, len) {
  return ' '.repeat(Math.max(0, len - str.length)) + str;
}

function shortenPath(p, max = 46) {
  // Home-relative shortening uses the DASHBOARD's $HOME as a heuristic —
  // remote machines' paths usually share the same layout; worst case the
  // path renders absolute.
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) p = '~' + p.slice(home.length);
  if (p.length <= max) return p;
  return COLOR.dim + '…' + COLOR.reset + p.slice(-(max - 1));
}

function shortenCommand(command, maxLen) {
  const parts = command.trim().split(/\s+/);
  if (parts.length && parts[0]) parts[0] = parts[0].split('/').pop();
  const joined = parts.join(' ');
  if (joined.length <= maxLen) return joined;
  return joined.slice(0, maxLen - 1) + '…';
}

// Timestamps come from the reporter's clock, "now" from the dashboard's —
// close enough on NTP-synced machines.
function elapsed(startedAt) {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function humanizeAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatCompactNumber(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function formatBytesShort(bytes) {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) {
    return `${gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(1)}G`;
  }
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)}M`;
}

function formatRate(bytesPerSec) {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
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

// ---------------------------------------------------------------------------
// Stats sections (all take plain data from the machine snapshot)

function renderCpuSection(cols, cores) {
  const lines = [];
  lines.push(COLOR.bold + 'CPU' + COLOR.reset);
  if (!cores || !cores.length) {
    lines.push(COLOR.dim + 'cpu usage unavailable' + COLOR.reset);
    return lines;
  }

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

function renderMemorySection(mem) {
  const lines = [];
  lines.push(COLOR.bold + 'Memory' + COLOR.reset);
  if (!mem) {
    lines.push(COLOR.dim + 'memory usage unavailable' + COLOR.reset);
    return lines;
  }
  const barWidth = 30;
  const bar = usageBar(mem.pct, barWidth);
  const label = `${formatBytesShort(mem.used)}/${formatBytesShort(mem.total)}`;
  lines.push(`${bar} ${pad(mem.pct + '%', 4)} ${COLOR.dim}${label} used${COLOR.reset}`);
  return lines;
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

// Disk I/O and Network share one two-line block — both are single short
// value lines, and stacking them as separate sections wasted four rows in
// the stats column.
function renderIoNetworkSection(diskIo, net) {
  const half = 26;
  const ioValue = diskIo
    ? `${COLOR.cyan}⇅${COLOR.reset} ${diskIo.mbps.toFixed(2)} MB/s  ${Math.round(diskIo.tps)} tps`
    : COLOR.dim + 'unavailable' + COLOR.reset;
  const netValue = net
    ? `${COLOR.cyan}↓${COLOR.reset} ${formatRate(net.rxRate)}  ${COLOR.cyan}↑${COLOR.reset} ${formatRate(net.txRate)}`
    : COLOR.dim + 'unavailable' + COLOR.reset;
  return [
    pad(COLOR.bold + 'Disk I/O' + COLOR.reset, half) + COLOR.bold + 'Network' + COLOR.reset,
    pad(ioValue, half) + netValue,
  ];
}

// ---------------------------------------------------------------------------
// Token spend graph

const TOKEN_RANGES = ['hour', 'day', 'week', 'month'];
const TOKEN_RANGE_CONFIG = {
  hour: { bucketMs: 60 * 1000 },
  day: { bucketMs: 60 * 60 * 1000 },
  week: { bucketMs: 24 * 60 * 60 * 1000 },
  month: { bucketMs: 24 * 60 * 60 * 1000 },
};
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SPARK_ROWS = 3;
const SPARK_WIDTH_MULTIPLIER = 2;
const Y_AXIS_WIDTH = 7; // label chars + 1 tick-glyph column

let currentRange = 'hour';

function getTokenBuckets(range, tokenBuckets) {
  if (!tokenBuckets) return [];
  if (range === 'hour') return tokenBuckets.minuteBuckets || [];
  if (range === 'day') return tokenBuckets.hourBuckets || [];
  if (range === 'week') return (tokenBuckets.dayBuckets || []).slice(-7);
  return tokenBuckets.dayBuckets || []; // month
}

// Merges adjacent buckets (summing — values are spend totals) so the graph
// fits a column narrower than one char per bucket, e.g. the 60-bucket hour
// view inside the ~50-char stats column.
function resampleBuckets(buckets, maxCols) {
  if (buckets.length <= maxCols) return { buckets, groupSize: 1 };
  const groupSize = Math.ceil(buckets.length / maxCols);
  const out = [];
  for (let i = 0; i < buckets.length; i += groupSize) {
    let sum = 0;
    for (let j = i; j < Math.min(i + groupSize, buckets.length); j++) sum += buckets[j];
    out.push(sum);
  }
  return { buckets: out, groupSize };
}

// A row of time-ago labels under the bars: window-start, evenly spaced
// points in between, and "now" pinned to the right edge — so you can tell
// where each bar actually falls in time without hovering. Narrow graphs
// get three labels instead of five to avoid overlap.
function buildTimeAxis(n, bucketMs, widthMultiplier) {
  const totalWidth = n * widthMultiplier;
  const chars = new Array(totalWidth).fill(' ');
  const positions = (n >= 10 && totalWidth >= 60)
    ? [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1]
    : [0, Math.floor(n / 2), n - 1];
  positions.forEach((idx, i) => {
    const isLast = i === positions.length - 1;
    const label = isLast ? 'now' : '-' + humanizeAgo((n - idx) * bucketMs);
    const col = isLast ? totalWidth - label.length : idx * widthMultiplier;
    for (let j = 0; j < label.length; j++) {
      const c = col + j;
      if (c >= 0 && c < totalWidth) chars[c] = label[j];
    }
  });
  return chars.join('');
}

function renderTokenSection(tokenBuckets, width) {
  const lines = [];
  const cfg = TOKEN_RANGE_CONFIG[currentRange];
  const rawBuckets = getTokenBuckets(currentRange, tokenBuckets);
  lines.push(COLOR.bold + COLOR.magenta + 'Token Spend' + COLOR.reset + `  [${currentRange}]`);
  if (!rawBuckets.length) {
    lines.push(COLOR.dim + 'no token data' + COLOR.reset);
    return lines;
  }

  // Fit the graph to the column: merge adjacent buckets when there are more
  // than one per available char, then widen each bar (up to the usual 2×)
  // with whatever room is left.
  const budget = Math.max(20, width - Y_AXIS_WIDTH);
  const { buckets, groupSize } = resampleBuckets(rawBuckets, budget);
  const bucketMs = cfg.bucketMs * groupSize;
  const widthMultiplier = Math.max(1, Math.min(SPARK_WIDTH_MULTIPLIER, Math.floor(budget / buckets.length)));

  // Stack SPARK_ROWS one-line sparklines to get real vertical resolution:
  // each bucket's value maps to a 0..(SPARK_ROWS * 8) level, the bottom row
  // draws the lowest 8 levels, the next row the next 8, and so on, using
  // the same eighth-block characters for the fractional top of the bar.
  const max = Math.max(1, ...buckets);
  const totalLevels = SPARK_ROWS * SPARK_CHARS.length;
  const levels = buckets.map((v) => Math.round((v / max) * totalLevels));

  for (let row = 0; row < SPARK_ROWS; row++) {
    const rowFloor = (SPARK_ROWS - 1 - row) * SPARK_CHARS.length;
    let rowStr = '';
    for (const level of levels) {
      const filled = Math.max(0, Math.min(SPARK_CHARS.length, level - rowFloor));
      const ch = filled === 0 ? ' ' : SPARK_CHARS[filled - 1];
      rowStr += ch.repeat(widthMultiplier);
    }

    const label = row === 0 ? formatCompactNumber(max) : '';
    const glyph = row === 0 ? '┤' : '│';
    const gutter = padLeft(label, Y_AXIS_WIDTH - 1) + glyph;
    lines.push(COLOR.dim + gutter + COLOR.reset + COLOR.magenta + rowStr + COLOR.reset);
  }

  const barWidth = buckets.length * widthMultiplier;
  const baseline = padLeft('0', Y_AXIS_WIDTH - 1) + '└' + '─'.repeat(barWidth);
  lines.push(COLOR.dim + baseline + COLOR.reset);

  lines.push(' '.repeat(Y_AXIS_WIDTH) + COLOR.dim + buildTimeAxis(buckets.length, bucketMs, widthMultiplier) + COLOR.reset);

  const total = rawBuckets.reduce((a, b) => a + b, 0);
  const windowMs = rawBuckets.length * cfg.bucketMs;
  lines.push(`${COLOR.dim}total:${COLOR.reset} ${total.toLocaleString()} tokens   ${humanizeAgo(windowMs)} ago → now`);

  return lines;
}

// ---------------------------------------------------------------------------
// Alerts

const WAITING_ALERT_DISPLAY_MS = 5000;
let waitingAlertBanner = null; // { message, expiresAt }

function notifyAlert(message) {
  process.stdout.write('\x07');
  execFile('osascript', ['-e', `display notification ${JSON.stringify(message)} with title "Claude Agents Dashboard"`], () => {});
  waitingAlertBanner = { message, expiresAt: Date.now() + WAITING_ALERT_DISPLAY_MS };
}

// Tracks each session's last-known status across polls so we alert on the
// moment a session transitions INTO "waiting" — not on every poll while it
// stays waiting. Keys are namespaced by machine: pids (and in theory even
// sessionIds) can collide across machines. On the very first poll, statuses
// are only seeded, so sessions already waiting at dashboard startup don't
// fire a false alert.
const lastStatusBySession = new Map();
const prevStaleByMachine = new Map();
let statusTrackingSeeded = false;

function detectTransitions(machines) {
  for (const m of machines) {
    const prevStale = prevStaleByMachine.get(m.machine);
    if (m.stale) {
      if (prevStale === false) {
        notifyAlert(`${m.machine} went offline (reporter stopped reporting)`);
      }
      prevStaleByMachine.set(m.machine, true);
      // Freeze this machine's session tracking while stale: its data is a
      // frozen snapshot, and comparing against it every poll would misread
      // the eventual reconnect as a burst of fresh transitions.
      continue;
    }
    prevStaleByMachine.set(m.machine, false);

    const seenIds = new Set();
    for (const a of m.agents || []) {
      const id = `${m.machine}:${a.sessionId || a.pid}`;
      seenIds.add(id);
      const prevStatus = lastStatusBySession.get(id);
      if (statusTrackingSeeded && prevStatus !== 'waiting' && a.status === 'waiting') {
        notifyAlert(`${m.machine}/${a.name || id} needs input: ${a.waitingFor || 'unknown'}`);
      }
      lastStatusBySession.set(id, a.status);
    }
    // Clean up entries for this machine's sessions that ended.
    for (const id of lastStatusBySession.keys()) {
      if (id.startsWith(`${m.machine}:`) && !seenIds.has(id)) lastStatusBySession.delete(id);
    }
  }
  statusTrackingSeeded = true;
}

// ---------------------------------------------------------------------------
// Machine section rendering

function connectHint(machine, agent) {
  const target = machine.sshHint || machine.machine;
  return `ssh ${target} 'claude attach ${agent.sessionId}'`;
}

function renderProcessTree(nodes, depth, lines, width) {
  for (const node of nodes) {
    const indent = '  '.repeat(depth + 1);
    const suffix = node.count > 1
      ? ` ${COLOR.dim}×${node.count}${COLOR.reset}`
      : ` ${COLOR.dim}(pid ${node.pid})${COLOR.reset}`;
    const budget = width - indent.length - 2 - 12; // icon + reserved space for the suffix
    const label = shortenCommand(node.command, Math.max(12, budget));
    lines.push(`${indent}${COLOR.cyan}⚙ ${COLOR.reset}${label}${suffix}`);
    renderProcessTree(node.children, depth + 1, lines, width);
  }
}

function buildAgentsColumn(machine, treeMap, width) {
  const lines = [];
  if (machine.agentsError) {
    lines.push(COLOR.red + 'Error: ' + machine.agentsError + COLOR.reset);
    return lines;
  }
  const agents = machine.agents || [];
  if (!agents.length) {
    lines.push(COLOR.dim + 'No background agent sessions.' + COLOR.reset);
    return lines;
  }

  const sorted = [...agents].sort((a, b) => {
    const oa = STATUS_ORDER[a.status] ?? 9;
    const ob = STATUS_ORDER[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return b.startedAt - a.startedAt;
  });

  const fixedWidths = 20 + 1 + 12 + 1 + 10 + 1 + 22 + 1 + 9 + 1 + 8 + 1; // NAME STATUS MODEL DETAIL ELAPSED PID + gaps
  const projectWidth = Math.max(10, width - fixedWidths);

  const header = [
    pad('NAME', 20),
    pad('STATUS', 12),
    pad('MODEL', 10),
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
      pad(String(a.model || '-').slice(0, 10), 10),
      pad((a.waitingFor || '-').slice(0, 22), 22),
      pad(elapsed(a.startedAt), 9),
      pad(String(a.pid), 8),
      shortenPath(a.cwd, projectWidth),
    ].join(' ');
    lines.push(row);

    lines.push(`  ${COLOR.dim}⤷ ${connectHint(machine, a)}${COLOR.reset}`);

    for (const sub of a.subAgents || []) {
      lines.push(
        `  ${COLOR.dim}↳ ${COLOR.reset}${pad(sub.description, 40)} ` +
        `${COLOR.yellow}running${COLOR.reset}  ${elapsed(sub.startedAt)}`
      );
    }

    const procTree = buildProcessTree(a.pid, treeMap, new Set([a.pid]));
    renderProcessTree(procTree, 0, lines, width);
  }
  return lines;
}

function buildStatsColumn(vitals, tokenBuckets, width) {
  const v = vitals || {};
  const lines = [];
  lines.push(...renderCpuSection(width, v.cpuCores));
  lines.push('');
  lines.push(...renderMemorySection(v.memory));
  lines.push('');
  lines.push(...renderDiskSection(v.disk));
  lines.push('');
  lines.push(...renderIoNetworkSection(v.diskIo, v.net));
  lines.push('');
  lines.push(...renderTokenSection(tokenBuckets, width));
  return lines;
}

// Below a minimum width, a side-by-side layout would squeeze both columns
// into illegibility, so fall back to a stacked single-column layout.
const MIN_SPLIT_COLS = 90;
const COLUMN_GUTTER = 3;

// Hub-reported age is frozen between polls; keep it counting using the time
// since we received the response (avoids trusting the hub's clock, which
// may be skewed relative to ours).
function liveAgeMs(machine) {
  return machine.ageMs + (Date.now() - lastReceivedAt);
}

function renderMachineSection(m, cols) {
  const lines = [];

  const dot = m.stale ? COLOR.red + '○' : COLOR.green + '●';
  const age = humanizeAgo(liveAgeMs(m)) + ' ago';
  const sessions = (m.agents || []).length;
  const staleNote = m.stale ? `  ${COLOR.red}stale — last seen ${age}${COLOR.reset}` : `  ${COLOR.dim}last seen ${age}${COLOR.reset}`;
  lines.push(`${dot}${COLOR.reset} ${COLOR.bold}${m.machine}${COLOR.reset}${staleNote}  ${COLOR.dim}${sessions} session${sessions === 1 ? '' : 's'}${COLOR.reset}`);
  lines.push('');

  if (m.schemaVersion !== SCHEMA_VERSION) {
    lines.push(COLOR.red + `reporter schema v${m.schemaVersion} ≠ dashboard v${SCHEMA_VERSION} — update ${m.machine}'s reporter` + COLOR.reset);
    return lines;
  }

  const treeMap = inflateProcessTree(m.processTree);

  const splitLayout = cols >= MIN_SPLIT_COLS;
  const rightWidth = splitLayout ? Math.min(64, Math.max(50, Math.floor(cols * 0.38))) : Math.min(cols, 100);
  const leftWidth = splitLayout ? (cols - rightWidth - COLUMN_GUTTER) : Math.min(cols, 100);

  const leftLines = buildAgentsColumn(m, treeMap, leftWidth);
  const rightLines = buildStatsColumn(m.vitals, m.tokenBuckets, rightWidth);

  const body = [];
  if (splitLayout) {
    const rowCount = Math.max(leftLines.length, rightLines.length);
    for (let i = 0; i < rowCount; i++) {
      body.push(pad(leftLines[i] || '', leftWidth) + ' '.repeat(COLUMN_GUTTER) + (rightLines[i] || ''));
    }
  } else {
    body.push(...leftLines);
    body.push('');
    body.push(...rightLines);
  }

  if (m.stale) {
    // Last-known data, visually muted: strip the section's own colors so
    // nothing cancels the dim wrapping.
    for (const line of body) {
      lines.push(COLOR.dim + stripAnsi(line) + COLOR.reset);
    }
  } else {
    lines.push(...body);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Top-level render

let lastHubResponse = null; // parsed GET /snapshot body
let lastReceivedAt = 0;     // Date.now() when lastHubResponse arrived
let lastPollError = null;   // { kind: 'auth'|'network'|'http', message }

function render() {
  const cols = process.stdout.columns || 100;
  const lines = [];
  const now = new Date().toLocaleTimeString();
  lines.push(
    COLOR.bold + COLOR.cyan + ' Claude Agents Dashboard ' + COLOR.reset +
    COLOR.dim + ` ${HUB_URL}  •  refreshing every ${REFRESH_MS / 1000}s  •  ${now}` + COLOR.reset
  );
  lines.push('─'.repeat(Math.min(cols, 120)));

  if (waitingAlertBanner && Date.now() < waitingAlertBanner.expiresAt) {
    lines.push(COLOR.bold + COLOR.red + `⚠ ${waitingAlertBanner.message}` + COLOR.reset);
    lines.push('');
  } else if (waitingAlertBanner) {
    waitingAlertBanner = null;
  }

  if (lastPollError) {
    const label = {
      auth: `✗ hub rejected the token (401) — check --token`,
      network: `✗ hub unreachable: ${lastPollError.message}`,
      http: `✗ hub error: ${lastPollError.message}`,
    }[lastPollError.kind];
    lines.push(COLOR.bold + COLOR.red + label + COLOR.reset + (lastHubResponse ? COLOR.dim + '  (showing last known data)' + COLOR.reset : ''));
    lines.push('');
  }

  if (!lastHubResponse) {
    if (!lastPollError) lines.push(COLOR.dim + 'connecting to hub…' + COLOR.reset);
  } else {
    const all = lastHubResponse.machines || [];
    // Only ever hide machines that are already past the hub's stale
    // threshold — a hide window shorter than that can't un-gray anything.
    const hidden = HIDE_STALE_MS > 0 ? all.filter((m) => m.stale && liveAgeMs(m) > HIDE_STALE_MS) : [];
    const machines = all.filter((m) => !hidden.includes(m)).sort((a, b) => {
      if (a.stale !== b.stale) return a.stale ? 1 : -1;
      return a.machine.localeCompare(b.machine);
    });

    if (!machines.length && !hidden.length) {
      lines.push(COLOR.dim + 'No machines have reported yet.' + COLOR.reset);
    }

    machines.forEach((m, i) => {
      if (i > 0) {
        lines.push('');
        lines.push(COLOR.dim + '─'.repeat(Math.min(cols, 120)) + COLOR.reset);
      }
      lines.push(...renderMachineSection(m, cols));
    });

    if (hidden.length) {
      lines.push('');
      const names = hidden.map((m) => m.machine).join(', ');
      lines.push(COLOR.dim + `○ ${hidden.length} stale machine${hidden.length === 1 ? '' : 's'} hidden (offline > ${humanizeAgo(HIDE_STALE_MS)}): ${names}` + COLOR.reset);
    }
  }

  lines.push('');
  lines.push(COLOR.dim + 'h/d/w/m or tab/←/→ switch token range • q or Ctrl+C to quit' + COLOR.reset);

  process.stdout.write('\x1b[H\x1b[J' + lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Hub polling

let pollInFlight = false;

async function pollHub() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const { status, json } = await requestJson('GET', `${HUB_URL}/snapshot`, { token: TOKEN });
    if (status === 401) {
      lastPollError = { kind: 'auth', message: 'unauthorized' };
    } else if (status !== 200 || !json) {
      lastPollError = { kind: 'http', message: `HTTP ${status}` };
    } else {
      lastHubResponse = json;
      lastReceivedAt = Date.now();
      lastPollError = null;
      detectTransitions(json.machines || []);
    }
  } catch (e) {
    lastPollError = { kind: 'network', message: e.message };
  } finally {
    pollInFlight = false;
  }
  render();
}

// ---------------------------------------------------------------------------
// Lifecycle

function cleanup() {
  process.stdout.write('\x1b[?1049l\x1b[?25h');
  process.exit(0);
}

function setupKeyboard() {
  if (!process.stdin.isTTY) return;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key && key.ctrl && key.name === 'c') return cleanup();
    if (str === 'q') return cleanup();

    let changed = false;
    if (str === 'h') {
      currentRange = 'hour';
      changed = true;
    } else if (str === 'd') {
      currentRange = 'day';
      changed = true;
    } else if (str === 'w') {
      currentRange = 'week';
      changed = true;
    } else if (str === 'm') {
      currentRange = 'month';
      changed = true;
    } else if ((key && key.name === 'tab') || (key && key.name === 'right')) {
      const idx = TOKEN_RANGES.indexOf(currentRange);
      currentRange = TOKEN_RANGES[(idx + 1) % TOKEN_RANGES.length];
      changed = true;
    } else if (key && key.name === 'left') {
      const idx = TOKEN_RANGES.indexOf(currentRange);
      currentRange = TOKEN_RANGES[(idx - 1 + TOKEN_RANGES.length) % TOKEN_RANGES.length];
      changed = true;
    }

    if (changed) render();
  });
}

function main() {
  process.stdout.write('\x1b[?1049h\x1b[?25l');

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  setupKeyboard();

  pollHub();
  setInterval(pollHub, REFRESH_MS);
}

main();
