'use strict';

// Shared collection module: everything that must run on the machine being
// observed (shelling out to system tools, reading ~/.claude transcripts).
// The reporter calls collectSnapshot() and pushes the result to the hub;
// the dashboard only imports the pure helpers (buildProcessTree,
// inflateProcessTree, requestJson) and never collects anything itself.

const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// Bumped whenever the snapshot payload shape changes, so a dashboard
// talking to reporters of a different version fails loudly instead of
// rendering garbage.
const SCHEMA_VERSION = 1;

const TOKEN_SCAN_MS = 30 * 1000;
const PROCESS_COMMAND_MAX_LEN = 200;

// ---------------------------------------------------------------------------
// Agents

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

// ---------------------------------------------------------------------------
// System vitals

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

function unitToBytes(value, unit) {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return NaN;
  const mult = { G: 1024 ** 3, M: 1024 ** 2, K: 1024 }[unit.toUpperCase()];
  return n * (mult || 1);
}

function fetchMemoryUsage() {
  return new Promise((resolve) => {
    execFile('top', ['-l', '1', '-n', '0'], (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.split('\n').find((l) => l.includes('PhysMem:'));
      if (!line) return resolve(null);
      const m = line.match(/PhysMem:\s*([\d.]+)([GMK])\s*used.*?,\s*([\d.]+)([GMK])\s*unused/i);
      if (!m) return resolve(null);
      const used = unitToBytes(m[1], m[2]);
      const unused = unitToBytes(m[3], m[4]);
      if (Number.isNaN(used) || Number.isNaN(unused)) return resolve(null);
      const total = used + unused;
      if (total <= 0) return resolve(null);
      const pct = Math.round((used / total) * 100);
      resolve({ used, total, pct });
    });
  });
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

// ---------------------------------------------------------------------------
// Process tree

// A session's Bash tool calls (and anything a sub-agent dispatched within
// it runs) become real OS child processes of that session's own pid.
// Build a ppid -> children adjacency list once per snapshot.
function fetchProcessTree() {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid,ppid,command'], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(new Map());
      const childrenByPpid = new Map();
      for (const line of stdout.split('\n').slice(1)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        const command = m[3];
        if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, []);
        childrenByPpid.get(ppid).push({ pid, command });
      }
      resolve(childrenByPpid);
    });
  });
}

// The dashboard only ever renders descendants of agent session pids, so the
// full machine process list never leaves the machine: prune to the subtrees
// rooted at the given pids while flattening to a JSON-friendly array.
// Command lines are truncated — they can carry secrets in args, and the
// dashboard renders at most ~48 chars anyway.
function pruneAndFlattenProcessTree(childrenByPpid, rootPids) {
  const flat = [];
  const seen = new Set(rootPids);
  const stack = [...rootPids];
  while (stack.length) {
    const pid = stack.pop();
    for (const child of childrenByPpid.get(pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      flat.push({ pid: child.pid, ppid: pid, command: child.command.slice(0, PROCESS_COMMAND_MAX_LEN) });
      stack.push(child.pid);
    }
  }
  return flat;
}

// Dashboard-side inverse of pruneAndFlattenProcessTree's flattening.
function inflateProcessTree(flat) {
  const childrenByPpid = new Map();
  for (const { pid, ppid, command } of flat || []) {
    if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, []);
    childrenByPpid.get(ppid).push({ pid, command });
  }
  return childrenByPpid;
}

// Builds the actual process tree rooted at `pid` (not a flattened list) so
// e.g. a `turbo run test` node correctly shows its jest-worker processes
// as ITS children rather than as unrelated siblings of the session.
// Sibling processes with identical command lines are split into two
// buckets: those with no children of their own collapse into one node
// with a count (e.g. a dozen indistinguishable jest workers), while any
// sibling that DOES have children is always shown on its own line with
// its subtree attached — so collapsing duplicates never hides a real
// descendant (e.g. one jest worker that happens to shell out to `git`).
function buildProcessTree(pid, childrenByPpid, visited, depth = 0, maxDepth = 8) {
  if (depth >= maxDepth) return [];
  const kids = (childrenByPpid.get(pid) || []).filter((k) => !visited.has(k.pid));
  const groups = new Map();
  for (const kid of kids) {
    visited.add(kid.pid);
    if (!groups.has(kid.command)) groups.set(kid.command, []);
    groups.get(kid.command).push(kid);
  }

  const nodes = [];
  for (const members of groups.values()) {
    const leaves = [];
    for (const m of members) {
      const subtree = buildProcessTree(m.pid, childrenByPpid, visited, depth + 1, maxDepth);
      if (subtree.length > 0) {
        nodes.push({ command: m.command, pid: m.pid, count: 1, children: subtree });
      } else {
        leaves.push(m);
      }
    }
    if (leaves.length > 0) {
      nodes.push({ command: leaves[0].command, pid: leaves[0].pid, count: leaves.length, children: [] });
    }
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Transcript-derived data (sub-agents, current model)

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

function shortenModelName(model) {
  if (!model) return '-';
  return model.replace(/^claude-/, '').replace(/-\d{6,}$/, '');
}

// One pass over a transcript, extracting both the current model (last
// assistant message wins) and in-flight sub-agents. A sub-agent dispatch is
// a tool_use block named "Agent"; completion is a later queue-operation
// carrying a <task-notification> with a matching <tool-use-id>; a dispatch
// whose tool_result was an immediate is_error (e.g. a failed isolation
// setup) never actually started and must be excluded, or it would look
// perpetually running.
function parseTranscript(content) {
  const dispatched = new Map();
  const resolved = new Set();
  const errored = new Set();
  let model = null;

  for (const line of content.split('\n')) {
    if (!line) continue;

    if (line.includes('task-notification')) {
      const m = line.match(/<tool-use-id>([^<]+)<\/tool-use-id>/);
      if (m) resolved.add(m[1]);
      continue;
    }

    const isAgentToolUse = line.includes('"tool_use"') && line.includes('"name":"Agent"');
    const isErrorResult = line.includes('"is_error":true') && line.includes('"tool_use_id"');
    const isAssistant = line.includes('"type":"assistant"') && line.includes('"model"');
    if (!isAgentToolUse && !isErrorResult && !isAssistant) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }

    if (obj.type === 'assistant' && obj.message && obj.message.model) {
      model = obj.message.model;
    }

    const blocks = obj && obj.message && obj.message.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block && block.type === 'tool_use' && block.name === 'Agent' && block.id) {
        const desc = (block.input && (block.input.description || block.input.prompt)) || 'agent task';
        const ts = new Date(obj.timestamp).getTime();
        dispatched.set(block.id, { description: String(desc).slice(0, 40), startedAt: Number.isNaN(ts) ? Date.now() : ts });
      }
      if (block && block.is_error === true && block.tool_use_id) {
        errored.add(block.tool_use_id);
      }
    }
  }

  const subAgents = [];
  for (const [id, info] of dispatched) {
    if (resolved.has(id) || errored.has(id)) continue;
    subAgents.push(info);
  }
  subAgents.sort((a, b) => a.startedAt - b.startedAt);

  return { model, subAgents };
}

// Transcripts of idle sessions never change, so cache the parse keyed by
// mtime+size and only re-read files that actually changed.
const transcriptCache = new Map(); // filePath -> { mtimeMs, size, model, subAgents }

function transcriptDerivedForSession(sessionId) {
  const empty = { model: null, subAgents: [] };
  const filePath = findSessionTranscript(sessionId);
  if (!filePath) return empty;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return empty;
  }

  const cached = transcriptCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return empty;
  }
  const { model, subAgents } = parseTranscript(content);
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, model, subAgents };
  transcriptCache.set(filePath, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Token history

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

// Extracts [timestampMs, tokens] pairs from a transcript. Entries older than
// `minTs` are dropped at parse time — they can never fall inside a rolling
// window that only slides forward.
function parseTokenEntries(content, minTs) {
  const entries = [];
  for (const line of content.split('\n')) {
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
    if (Number.isNaN(ts) || ts < minTs) continue;
    const tokens = tokensForUsage(usage);
    if (tokens <= 0) continue;
    entries.push([ts, tokens]);
  }
  return entries;
}

// The extracted (timestamp, tokens) pairs only change when the file does, so
// they're cached per file keyed by mtime+size; only the bucketing (which
// depends on "now") is redone each scan.
const tokenFileCache = new Map(); // filePath -> { mtimeMs, size, entries }

let tokenCache = {
  scannedAt: 0,
  minuteBuckets: new Array(60).fill(0), // last 60 minutes, index 0 = oldest
  hourBuckets: new Array(24).fill(0),   // last 24 hours
  dayBuckets: new Array(30).fill(0),    // last 30 days
};

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
  const liveFiles = new Set(files);
  for (const cachedPath of tokenFileCache.keys()) {
    if (!liveFiles.has(cachedPath)) tokenFileCache.delete(cachedPath);
  }

  for (const filePath of files) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      continue;
    }
    // A file not modified since the widest window began can't contain
    // in-window entries (entries can't be newer than the file's mtime).
    if (stat.mtimeMs < dayStart) {
      tokenFileCache.delete(filePath);
      continue;
    }

    let entries;
    const cached = tokenFileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      entries = cached.entries;
    } else {
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        continue;
      }
      entries = parseTokenEntries(content, dayStart);
      tokenFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
    }

    for (const [ts, tokens] of entries) {
      if (ts > now) continue;
      if (ts >= minuteStart) {
        const idx = Math.min(59, Math.floor((ts - minuteStart) / minuteMs));
        minuteBuckets[idx] += tokens;
      }
      if (ts >= hourStart) {
        const idx = Math.min(23, Math.floor((ts - hourStart) / hourMs));
        hourBuckets[idx] += tokens;
      }
      if (ts >= dayStart) {
        const idx = Math.min(29, Math.floor((ts - dayStart) / dayMs));
        dayBuckets[idx] += tokens;
      }
    }
  }

  tokenCache = { scannedAt: now, minuteBuckets, hourBuckets, dayBuckets };
}

function tokenBucketsSnapshot() {
  return {
    scannedAt: tokenCache.scannedAt,
    minuteBuckets: tokenCache.minuteBuckets,
    hourBuckets: tokenCache.hourBuckets,
    dayBuckets: tokenCache.dayBuckets,
  };
}

// ---------------------------------------------------------------------------
// Snapshot

async function collectSnapshot({ machine, sshHint } = {}) {
  const [{ agents, error }, disk, diskIo, netTotals, memory, processTreeMap] = await Promise.all([
    fetchAgents(),
    fetchDiskUsage(),
    fetchDiskIoRate(),
    fetchNetworkTotals(),
    fetchMemoryUsage(),
    fetchProcessTree(),
  ]);

  const enrichedAgents = (agents || []).map((a) => {
    const derived = transcriptDerivedForSession(a.sessionId);
    return {
      ...a,
      model: shortenModelName(derived.model),
      subAgents: derived.subAgents,
    };
  });

  const agentPids = enrichedAgents.map((a) => a.pid).filter((p) => Number.isInteger(p));

  return {
    schemaVersion: SCHEMA_VERSION,
    machine: machine || os.hostname(),
    sshHint: sshHint || null,
    collectedAt: Date.now(),
    agentsError: error || null,
    agents: enrichedAgents,
    vitals: {
      cpuCores: cpuUsagePerCore(),
      memory,
      disk,
      diskIo,
      net: networkRates(netTotals),
    },
    processTree: pruneAndFlattenProcessTree(processTreeMap, agentPids),
    tokenBuckets: tokenBucketsSnapshot(),
  };
}

// ---------------------------------------------------------------------------
// HTTP client (shared by reporter and dashboard)

const keepAliveHttp = new http.Agent({ keepAlive: true });
const keepAliveHttps = new https.Agent({ keepAlive: true });

function requestJson(method, urlStr, { token, body, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`invalid URL: ${urlStr}`));
    }
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = mod.request(url, {
      method,
      agent: isHttps ? keepAliveHttps : keepAliveHttp,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch (e) {
          // non-JSON body (e.g. proxy error page); status alone is enough
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = {
  SCHEMA_VERSION,
  TOKEN_SCAN_MS,
  collectSnapshot,
  scanTokenHistory,
  buildProcessTree,
  inflateProcessTree,
  requestJson,
};
