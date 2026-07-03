#!/usr/bin/env node
'use strict';

// Central always-on store for claude-observer: reporters POST their machine
// snapshots here, dashboards GET the aggregated view. Intentionally
// self-contained (no imports from the rest of this repo) so it can be
// deployed by copying this one file to the server. Speaks plain HTTP —
// TLS is terminated by the reverse proxy (Apache) in front of it, which is
// why it binds to 127.0.0.1 by default: the plain-HTTP port must not be
// directly reachable from outside, or it would bypass TLS entirely.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Duplicated from collector.js so this file stays deployable on its own:
// loads KEY=VALUE lines from .env next to this file; real environment
// variables win over .env entries, CLI flags win over both.
function loadDotEnv(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return;
  }
  for (const line of content.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

loadDotEnv(path.join(__dirname, '.env'));

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
const PORT = Number(flags.port || process.env.CLAUDE_OBSERVER_HUB_PORT) || 7345;
const BIND = flags.bind || process.env.CLAUDE_OBSERVER_HUB_BIND || '127.0.0.1';
const TOKEN = flags.token || process.env.CLAUDE_OBSERVER_TOKEN;
const STALE_MS = ((Number(flags['stale-after'] || process.env.CLAUDE_OBSERVER_STALE_S)) || 15) * 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

if (!TOKEN) {
  console.error('a shared token is required: --token <t> or CLAUDE_OBSERVER_TOKEN');
  process.exit(1);
}

const tokenHash = crypto.createHash('sha256').update(TOKEN).digest();

// Hashing both sides gives equal-length buffers (a timingSafeEqual
// requirement) regardless of what length token the client sent.
function checkAuth(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) return false;
  const givenHash = crypto.createHash('sha256').update(header.slice(7)).digest();
  return crypto.timingSafeEqual(givenHash, tokenHash);
}

const machines = new Map(); // machine name -> { snapshot, lastSeen }

function handleReport(req, res) {
  let body = '';
  let destroyed = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      destroyed = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (destroyed) return;
    let snapshot;
    try {
      snapshot = JSON.parse(body);
    } catch (e) {
      res.writeHead(400);
      return res.end('invalid json');
    }
    if (!snapshot || typeof snapshot.machine !== 'string' || !snapshot.machine) {
      res.writeHead(400);
      return res.end('missing machine name');
    }
    machines.set(snapshot.machine, { snapshot, lastSeen: Date.now() });
    res.writeHead(204);
    res.end();
  });
}

function handleSnapshot(req, res) {
  const now = Date.now();
  const out = [...machines.values()].map(({ snapshot, lastSeen }) => ({
    ...snapshot,
    lastSeen,
    ageMs: now - lastSeen,
    stale: now - lastSeen > STALE_MS,
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ machines: out, serverTime: now }));
}

const server = http.createServer((req, res) => {
  if (!checkAuth(req)) {
    res.writeHead(401);
    return res.end();
  }
  if (req.method === 'POST' && req.url === '/report') return handleReport(req, res);
  if (req.method === 'GET' && req.url === '/snapshot') return handleSnapshot(req, res);
  res.writeHead(404);
  res.end();
});

server.listen(PORT, BIND, () => {
  console.log(`claude-observer hub listening on http://${BIND}:${PORT} (stale after ${STALE_MS / 1000}s)`);
});

// In a container this process is PID 1, which gets no default signal
// behavior from the kernel — without explicit handlers, SIGINT/SIGTERM are
// ignored and Ctrl+C / `docker stop` can't shut it down. Reporters and
// dashboards hold keep-alive connections, so they must be closed explicitly
// or server.close() would never finish.
function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
