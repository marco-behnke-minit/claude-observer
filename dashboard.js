#!/usr/bin/env node
'use strict';

const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const REFRESH_MS = (Number(process.argv[2]) || 2) * 1000;
const TOKEN_SCAN_MS = 30 * 1000;

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

let diskIoFetchInFlight = false;
let lastDiskIo = null;

function fetchDiskIoRate() {
  if (diskIoFetchInFlight) return Promise.resolve(lastDiskIo);
  diskIoFetchInFlight = true;
  return new Promise((resolve) => {
    execFile('iostat', ['-d', '-c', '2', '-w', '1'], (err, stdout) => {
      diskIoFetchInFlight = false;
      if (err) {
        lastDiskIo = null;
        return resolve(null);
      }
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      const nums = lastLine.trim().split(/\s+/).map(Number);
      if (!nums.length || nums.some(Number.isNaN) || nums.length % 3 !== 0) {
        lastDiskIo = null;
        return resolve(null);
      }
      let mbps = 0;
      let tps = 0;
      for (let i = 0; i < nums.length; i += 3) {
        tps += nums[i + 1];
        mbps += nums[i + 2];
      }
      lastDiskIo = { mbps, tps };
      resolve(lastDiskIo);
    });
  });
}

function renderDiskIoSection(diskIo) {
  const lines = [];
  lines.push(COLOR.bold + 'Disk I/O' + COLOR.reset);
  if (!diskIo) {
    lines.push(COLOR.dim + 'disk throughput unavailable' + COLOR.reset);
    return lines;
  }
  lines.push(
    `${COLOR.cyan}⇅${COLOR.reset} ${pad(diskIo.mbps.toFixed(2) + ' MB/s', 12)} ` +
    `${pad(Math.round(diskIo.tps) + ' tps', 10)}`
  );
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

const TOKEN_RANGES = ['hour', 'day', 'week', 'month'];
const TOKEN_RANGE_CONFIG = {
  hour: { buckets: 60, bucketMs: 60 * 1000, label: 'hour' },
  day: { buckets: 24, bucketMs: 60 * 60 * 1000, label: 'day' },
  week: { buckets: 7, bucketMs: 24 * 60 * 60 * 1000, label: 'week' },
  month: { buckets: 30, bucketMs: 24 * 60 * 60 * 1000, label: 'month' },
};
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

let currentRange = 'hour';
// Cache covers the widest window (month, bucketed by day) plus we also keep
// a fine-grained (per-minute, last hour) and per-hour (last day) cache so
// each view can be re-bucketed cheaply without re-scanning files.
let tokenCache = {
  scannedAt: 0,
  minuteBuckets: [], // last 60 minutes, index 0 = oldest
  hourBuckets: [],   // last 24 hours
  dayBuckets: [],    // last 30 days
};

function listTranscriptFiles() {
  const files = [];
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir);
  } catch (e) {
    return files;
  }
  for (const projectSlug of projectDirs) {
    const projectPath = path.join(projectsDir, projectSlug);
    let stat;
    try {
      stat = fs.statSync(projectPath);
    } catch (e) {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(projectPath);
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = path.join(projectPath, entry);
      try {
        if (!fs.statSync(filePath).isFile()) continue;
      } catch (e) {
        continue;
      }
      files.push(filePath);
    }
  }
  return files;
}

function tokensForUsage(usage) {
  const fields = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  let sum = 0;
  for (const f of fields) {
    if (typeof usage[f] === 'number') sum += usage[f];
  }
  return sum;
}

// Scans all transcripts and buckets token usage into fixed-size rolling
// windows: per-minute (60), per-hour (24), per-day (30). Runs on its own
// slow cadence (TOKEN_SCAN_MS) since transcripts can be large/numerous.
function scanTokenHistory() {
  const now = Date.now();
  const minuteMs = 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;

  const minuteBuckets = new Array(60).fill(0);
  const hourBuckets = new Array(24).fill(0);
  const dayBuckets = new Array(30).fill(0);

  const minuteStart = now - 60 * minuteMs;
  const hourStart = now - 24 * hourMs;
  const dayStart = now - 30 * dayMs;

  const files = listTranscriptFiles();
  for (const filePath of files) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      continue;
    }
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line || !line.includes('"usage"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        continue;
      }
      const usage = obj && obj.message && obj.message.usage;
      if (!usage || typeof usage !== 'object') continue;
      if (!obj.timestamp) continue;
      const ts = new Date(obj.timestamp).getTime();
      if (Number.isNaN(ts)) continue;
      const tokens = tokensForUsage(usage);
      if (tokens <= 0) continue;

      if (ts >= minuteStart && ts <= now) {
        const idx = Math.min(59, Math.floor((ts - minuteStart) / minuteMs));
        minuteBuckets[idx] += tokens;
      }
      if (ts >= hourStart && ts <= now) {
        const idx = Math.min(23, Math.floor((ts - hourStart) / hourMs));
        hourBuckets[idx] += tokens;
      }
      if (ts >= dayStart && ts <= now) {
        const idx = Math.min(29, Math.floor((ts - dayStart) / dayMs));
        dayBuckets[idx] += tokens;
      }
    }
  }

  tokenCache = { scannedAt: now, minuteBuckets, hourBuckets, dayBuckets };
}

function getTokenBuckets(range) {
  if (range === 'hour') return tokenCache.minuteBuckets;
  if (range === 'day') return tokenCache.hourBuckets;
  if (range === 'week') return tokenCache.dayBuckets.slice(-7);
  return tokenCache.dayBuckets; // month
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

function renderTokenSection(cols) {
  const lines = [];
  const cfg = TOKEN_RANGE_CONFIG[currentRange];
  const buckets = getTokenBuckets(currentRange);
  lines.push(COLOR.bold + COLOR.magenta + 'Token Spend' + COLOR.reset + `  [${currentRange}]  ` +
    COLOR.dim + '(press h/d/w/m to switch, tab to cycle)' + COLOR.reset);

  const max = Math.max(1, ...buckets);
  const spark = buckets.map((v) => {
    const level = Math.round((v / max) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[level];
  }).join('');
  lines.push(COLOR.magenta + spark + COLOR.reset);

  const total = buckets.reduce((a, b) => a + b, 0);
  const windowMs = buckets.length * cfg.bucketMs;
  const startLabel = humanizeAgo(windowMs) + ' ago';
  lines.push(`${COLOR.dim}total:${COLOR.reset} ${total.toLocaleString()} tokens   ${startLabel} → now`);

  return lines;
}

function findSessionTranscript(sessionId) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir);
  } catch (e) {
    return null;
  }
  for (const slug of projectDirs) {
    const candidate = path.join(projectsDir, slug, `${sessionId}.jsonl`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (e) {
      // not this project
    }
  }
  return null;
}

// A session's own transcript logs every sub-agent it dispatches (a
// tool_use block named "Agent") immediately, but `claude agents --json`
// has no visibility into them at all — they run inside the parent
// process, not as separate OS-level sessions. Completion is logged
// later as a queue-operation carrying a <task-notification> with a
// matching <tool-use-id>. A dispatched id with no such notification
// yet is still running.
function activeSubAgentsForSession(sessionId) {
  const filePath = findSessionTranscript(sessionId);
  if (!filePath) return [];
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return [];
  }

  const dispatched = new Map();
  const resolved = new Set();
  const errored = new Set();

  for (const line of content.split('\n')) {
    if (!line) continue;

    if (line.includes('"tool_use"') && line.includes('"name":"Agent"')) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        continue;
      }
      const blocks = obj && obj.message && obj.message.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block && block.type === 'tool_use' && block.name === 'Agent' && block.id) {
            const desc = (block.input && (block.input.description || block.input.prompt)) || 'agent task';
            const ts = new Date(obj.timestamp).getTime();
            dispatched.set(block.id, { description: String(desc).slice(0, 40), startedAt: Number.isNaN(ts) ? Date.now() : ts });
          }
        }
      }
      continue;
    }

    // A dispatch that failed immediately (e.g. an isolation setup error)
    // never actually starts a background task, so it will never receive
    // a task-notification — it must be excluded explicitly via is_error,
    // not just left to look perpetually "running".
    if (line.includes('"is_error":true') && line.includes('"tool_use_id"')) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        continue;
      }
      const blocks = obj && obj.message && obj.message.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block && block.is_error === true && block.tool_use_id) errored.add(block.tool_use_id);
        }
      }
      continue;
    }

    if (line.includes('task-notification')) {
      const m = line.match(/<tool-use-id>([^<]+)<\/tool-use-id>/);
      if (m) resolved.add(m[1]);
    }
  }

  const active = [];
  for (const [id, info] of dispatched) {
    if (resolved.has(id) || errored.has(id)) continue;
    active.push(info);
  }
  return active.sort((a, b) => a.startedAt - b.startedAt);
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

function render(agents, error, disk, diskIo, net) {
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

      for (const sub of activeSubAgentsForSession(a.sessionId)) {
        lines.push(
          `  ${COLOR.dim}↳ ${COLOR.reset}${pad(sub.description, 40)} ` +
          `${COLOR.yellow}running${COLOR.reset}  ${elapsed(sub.startedAt)}`
        );
      }
    }
  }

  lines.push('');
  lines.push('─'.repeat(Math.min(cols, 100)));
  lines.push(...renderCpuSection(cols));
  lines.push('');
  lines.push(...renderDiskSection(disk));
  lines.push('');
  lines.push(...renderDiskIoSection(diskIo));
  lines.push('');
  lines.push(...renderNetworkSection(net));
  lines.push('');
  lines.push(...renderTokenSection(cols));

  lines.push('');
  lines.push(COLOR.dim + 'h/d/w/m switch range • q or Ctrl+C to quit' + COLOR.reset);

  process.stdout.write('\x1b[H\x1b[J' + lines.join('\n') + '\n');
}

// Last-known stats from the most recent tick(), kept so keypress-driven
// range changes can re-render immediately without re-running subprocesses.
let lastAgents = [];
let lastError = null;
let lastDisk = null;
let lastDiskIoStat = null;
let lastNet = null;

function renderNow() {
  render(lastAgents, lastError, lastDisk, lastDiskIoStat, lastNet);
}

async function tick() {
  const [{ agents, error }, disk, diskIo, netTotals] = await Promise.all([
    fetchAgents(),
    fetchDiskUsage(),
    fetchDiskIoRate(),
    fetchNetworkTotals(),
  ]);
  lastAgents = agents || [];
  lastError = error;
  lastDisk = disk;
  lastDiskIoStat = diskIo;
  lastNet = networkRates(netTotals);
  render(lastAgents, lastError, lastDisk, lastDiskIoStat, lastNet);
}

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

    if (changed) renderNow();
  });
}

function main() {
  process.stdout.write('\x1b[?1049h\x1b[?25l');

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  setupKeyboard();

  scanTokenHistory();
  setInterval(scanTokenHistory, TOKEN_SCAN_MS);

  tick();
  setInterval(tick, REFRESH_MS);
}

main();
