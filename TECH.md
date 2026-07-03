# TECH.md — Multi-machine claude-observer

## Feature: reporter + hub + dashboard

`dashboard.js` currently collects data and renders it in one process, for the local
machine only — it shells out to `claude agents`, `ps`, `df`, `iostat`, `netstat`,
`top`, and reads local `~/.claude/projects/*.jsonl` transcripts, then draws
everything straight to the terminal in the same tick.

As Claude Code starts running on additional remote machines, that model breaks down:
there's no single place to see every machine's agent activity, get notified when a
remote session needs input, or jump into it. Claude Code's own `--remote-control`
flag was evaluated and ruled out — it's a UI-only relay through Anthropic's API with
no programmatic way to list sessions or inject input from a script. A pull/SSH model
(dashboard reaches out to each remote machine) was also ruled out — it requires
inbound reachability to every remote box and breaks behind NAT/firewalls.

The direction instead is **push, not pull**: every machine runs a lightweight
reporter that POSTs its local snapshot to a central always-on hub; the dashboard
pulls the aggregated view from the hub instead of collecting anything itself, always
— there is no local-collection fallback, even for single-machine use, to keep the
dashboard to one code path. The hub speaks plain HTTP on an internal port; TLS is
handled externally by an Apache reverse proxy already running on a public server, so
no cert/TLS handling is needed in this project's code.

Outcome: three small Node processes — a shared `collector.js` module, `reporter.js`,
`hub.js`, and a rewritten `dashboard.js` — still dependency-free, reusing nearly all
existing rendering code as-is.

## Architecture

**`collector.js`** (new, shared module) — everything in the current file that
touches the OS/filesystem, extracted behind one function:

- `collectSnapshot()`: runs `fetchAgents`, `fetchDiskUsage`, `fetchDiskIoRate`,
  `fetchNetworkTotals`/`networkRates`, `fetchMemoryUsage`, `cpuUsagePerCore`,
  `fetchProcessTree` in parallel (same as today's `tick()`), then enriches each
  agent with `model: shortenModelName(currentModelForSession(a.sessionId))` and
  `subAgents: activeSubAgentsForSession(a.sessionId)` — both currently computed in
  `render()`, moving here because only the machine itself can read its own
  `~/.claude/projects/*.jsonl` transcripts.
- `fetchProcessTree()`'s `Map<ppid, [{pid,command}]>` isn't JSON-serializable —
  `pruneAndFlattenProcessTree()` (Map → flat `{pid,ppid,command}[]`) converts it here,
  and `inflateProcessTree()` (flat array → Map) reverses it on the dashboard side.
  `buildProcessTree` (already a pure function, no OS access) stays in this module and
  gets imported by the dashboard, called on the *inflated* map — no logic changes to it.
- **The process tree is pruned reporter-side**: the dashboard only ever renders
  descendants of agent session pids (`buildProcessTree(a.pid, ...)`), so before
  flattening, the ppid map is walked once keeping only the subtrees rooted at the
  snapshot's agent pids — typically dozens of rows instead of the full machine's
  ~500. This is also a privacy measure: unrelated processes' command lines (which
  can carry secrets in args) never leave the machine. Each surviving `command` is
  truncated to 200 chars (the dashboard renders at most ~48 anyway).
- **mtime-based transcript caching**: `transcriptDerivedForSession` (model +
  sub-agents, one parse per file) caches per file path keyed by `fs.statSync`
  mtimeMs+size, so idle sessions' unchanged transcripts are never re-read on
  subsequent ticks. `scanTokenHistory` likewise caches the extracted
  `(timestamp, tokens)` pairs per file keyed by mtime/size and only re-buckets each
  scan (buckets depend on "now", the extracted pairs don't), and skips files whose
  mtime predates the 30-day window start entirely — they can't contain in-window
  entries.
- `scanTokenHistory()` keeps its own 30s cadence and module-level `tokenCache`,
  exactly as today; add `tokenBucketsSnapshot()` returning all three raw bucket
  arrays (minute/hour/day) — the reporter doesn't know what time range the dashboard
  user has selected, so it sends all of them and the dashboard does the range
  selection (`getTokenBuckets(range, tokenBuckets)`, same logic as today's
  `getTokenBuckets`, just parameterized instead of reading a module global).
- Everything else moves in verbatim: `fetchAgents`, `fetchDiskUsage`,
  `fetchDiskIoRate`, `fetchNetworkTotals`, `networkRates`, `fetchMemoryUsage`,
  `cpuUsagePerCore`, `fetchProcessTree`, `activeSubAgentsForSession`,
  `currentModelForSession`, `findSessionTranscript`, `listTranscriptFiles`,
  `tokensForUsage`, `unitToBytes`, `shortenModelName`.

**`reporter.js`** (new) — runs on every machine (including the one you're sitting
at, if it also runs agents). Loop: `collectSnapshot()` → `POST <hub>/report` with
`Authorization: Bearer <token>`, every `--interval` seconds (default 3). No
TTY/rendering — plain `console.log`/`console.error`, meant to run under
`launchd`/`pm2`/a background shell. On a failed push, log and let the next interval
retry (each push is a full fresh snapshot, so one miss just means the hub's copy is
a tick stale — self-healing, no local buffering needed).

Connection handling: pushes go through a keep-alive `http(s).Agent` (through the
Apache HTTPS proxy, each push would otherwise pay a fresh TCP+TLS handshake at 3s
cadence), with a ~5s request timeout and an in-flight flag so a slow hub can't stack
overlapping collect+push cycles. The dashboard's `pollHub()` gets the identical
treatment.

**`hub.js`** (new) — bare Node `http` server (no Express, matching the project's
zero-dependency style), binds to a local/internal port that Apache reverse-proxies
to. Intentionally self-contained (no imports from the rest of the repo) so it can be
deployed by copying the one file to the server:

- **Binds `127.0.0.1` by default** (`--bind` to override for LAN setups) — the
  plain-HTTP port must not be directly reachable from outside, or it would bypass
  the proxy's TLS entirely. Token comparison uses `crypto.timingSafeEqual` on sha256
  hashes of both sides (hashing sidesteps the equal-length requirement), not `===`.
  Request bodies are capped at 5MB (generous once the process tree is pruned); the
  socket is destroyed past that.
- `POST /report` — bearer-auth checked, body parsed as JSON, stored in an in-memory
  `Map<machineName, {snapshot, lastSeen}>` (last-write-wins, no history). `401` on
  bad/missing token, `400` on malformed body or missing `machine` field, `204` on
  success.
- `GET /snapshot` — same auth, returns `{ machines: [...], serverTime }`. Staleness
  (`stale: (now - lastSeen) > staleMs`) is computed fresh on every read from
  `lastSeen`, not stored, so it's always accurate. Default `staleMs` = 15s against a
  3s push interval (5x margin), configurable.
- No persistence needed — a hub restart just means machines reappear as reporters
  push again within a few seconds.

**`dashboard.js`** (rewritten) — same rendering code, new data source:

- `pollHub()` replaces `tick()`'s collection half: one `GET /snapshot` instead of 6
  parallel local fetches. Stores the whole parsed response as `lastHubResponse`
  (replaces the individual `lastAgents`/`lastDisk`/etc. cache vars — `renderNow()`
  just re-renders from this).
- **Always goes through the hub** — no local-collection fallback. Even
  single-machine use runs a local reporter + hub alongside the dashboard. This keeps
  the dashboard to one code path (`pollHub` → render) instead of branching between
  local collection and hub polling.
- `render()` becomes a per-machine section builder (agents table + sub-agents +
  process tree on the left, CPU/memory/disk/diskIO/network on the right — unchanged
  `buildAgentsColumn`/`buildStatsColumn` logic), called once per machine in the hub
  response; a new outer loop concatenates all machines' sections with a header per
  machine (name, online/stale indicator, last-seen age). Token spend becomes **one
  graph per machine** (matches the data model — buckets arrive per-machine) instead
  of today's single global graph.
- `buildAgentsColumn` drops its `currentModelForSession`/`activeSubAgentsForSession`
  calls (data now arrives pre-computed on each agent object as `.model`/`.subAgents`)
  and takes the *inflated* process-tree Map instead of calling `fetchProcessTree`
  itself.
- `detectWaitingTransitions` moves here from the collector (so the alert fires on
  whichever machine you're actually watching, not the remote one), keyed by
  `` `${machine}:${sessionId||pid}` `` to avoid pid collisions across machines,
  message prefixed with the machine name. A machine marked `stale` is skipped for
  transition comparison (and its tracked keys frozen, not updated) so a reconnect
  after an outage isn't misread as a fresh "just started waiting" — and a machine
  flipping `stale: false → true` fires one "machine went offline" notification via
  the same bell/banner mechanism.
- Auth/connectivity errors (401 vs. connection-refused/timeout) render as a distinct
  top-level banner, not a silent empty machine list — with the last known data still
  shown beneath it when available.
- Machine age displays as `ageMs + (Date.now() - receivedAt)` so "last seen Ns ago"
  keeps counting between polls instead of freezing at the last poll's value (and
  avoids trusting the hub's clock directly, which may be skewed).
- New small helper: `connectHint(machineSnapshot, agent)` →
  `` `ssh ${machineSnapshot.sshHint || machineSnapshot.machine} 'claude attach ${agent.sessionId}'` ``,
  rendered as a dim line under each agent row for copy-paste.

## Payload shape (reporter → hub → dashboard)

```jsonc
{
  "schemaVersion": 1,                        // bumped on payload-shape changes so mismatched reporter/dashboard versions fail loudly
  "machine": "marcos-mac-mini",
  "sshHint": "marco@mini.tailnet.ts.net",   // optional; falls back to `machine`
  "collectedAt": 1751500000000,
  "agentsError": null,
  "agents": [{
    "pid": 4821, "sessionId": "abc123", "name": "refactor-auth",
    "status": "waiting", "waitingFor": "permission: Bash(rm)",
    "startedAt": 1751495000000, "cwd": "/Users/marco/dev/foo",
    "model": "sonnet-4-5",
    "subAgents": [{ "description": "search for auth usages", "startedAt": 1751499000000 }]
  }],
  "vitals": {
    "cpuCores": [12.3, 45.1, 3.0, 88.2],
    "memory": { "used": 8589934592, "total": 17179869184, "pct": 50 },
    "disk": { "size": "460Gi", "used": "210Gi", "avail": "230Gi", "pct": 46 },
    "diskIo": { "mbps": 3.2, "tps": 45 },
    "net": { "rxRate": 12345.6, "txRate": 890.1 }
  },
  "processTree": [{ "pid": 4900, "ppid": 4821, "command": "/bin/bash -c npm test" }],  // pruned to agent-descendant subtrees, commands truncated to 200 chars
  "tokenBuckets": { "scannedAt": 1751499990000, "minuteBuckets": [], "hourBuckets": [], "dayBuckets": [] }
}
```

Every `vitals.*` sub-shape matches the existing render function signatures exactly
(`{used,total,pct}`, `{mbps,tps}`, `{rxRate,txRate}`) — no changes needed to
`renderCpuSection`/`renderMemorySection`/`renderDiskSection`/`renderDiskIoSection`/
`renderNetworkSection`.

## CLI args / env vars

CLI flag wins over env var wins over `.env` wins over default, consistent across
all three processes. Each process loads a `.env` file (KEY=VALUE lines, gitignored,
see `.env.template`) from its own directory at startup, populating only variables
not already set in the real environment — so the shared token never has to appear
on a command line or in shell history. `hub.js` carries its own copy of the tiny
loader to stay single-file deployable.

| Process | Flag | Env var | Default |
|---|---|---|---|
| reporter | `--hub <url>`, `--token <t>` | `CLAUDE_OBSERVER_HUB_URL`, `CLAUDE_OBSERVER_TOKEN` | required, no default |
| reporter | `--name <n>` | `CLAUDE_OBSERVER_MACHINE` | `os.hostname()` |
| reporter | `--ssh-hint <s>` | `CLAUDE_OBSERVER_SSH_HINT` | none |
| reporter | `--interval <s>` | `CLAUDE_OBSERVER_PUSH_INTERVAL_S` | 3 |
| hub | `--port <p>` | `CLAUDE_OBSERVER_HUB_PORT` | 7345 |
| hub | `--token <t>` | `CLAUDE_OBSERVER_TOKEN` | required |
| hub | `--stale-after <s>` | `CLAUDE_OBSERVER_STALE_S` | 15 |
| hub | `--bind <addr>` | `CLAUDE_OBSERVER_HUB_BIND` | `127.0.0.1` |
| dashboard | `--hub <url>`, `--token <t>` | same as above | required, no default |
| dashboard | positional refresh-seconds (unchanged) | — | 2 |

## Edge cases handled

- **Stale machine**: shown grayed out with "last seen Ns ago", never hidden — a dead
  reporter is exactly when you most want visibility.
- **Reconnect after outage**: transition tracking frozen while stale, so coming back
  online isn't misread as a fresh waiting-transition.
- **Rendering volume with many machines**: no collapsing/pagination in v1 (full
  section per machine, same as today, just repeated) — flag "collapse idle
  machines" / "focused single-machine view" as a v2 idea if it becomes noisy in
  practice, not building it now.
- **Clock skew**: `elapsed()` mixes the dashboard's clock with reporter-stamped
  timestamps; fine for NTP-synced machines, worth a code comment, not worth solving
  now.
- **Hub restart**: in-memory only — machines just reappear as reporters push again,
  within one push interval.

## Critical files

- `dashboard.js` — split apart; becomes the hub-polling renderer
- `collector.js` (new) — shared collection logic + `buildProcessTree`/(de)serialization helpers
- `reporter.js` (new) — collect-and-push loop
- `hub.js` (new) — bare-`http` store-and-serve server
- `README.md` — needs a rewrite pass covering the three-process architecture, env
  vars, and that the macOS-only constraint applies per-reporter, not globally

## Verification

1. `node hub.js --token test123` — starts, listens on default port.
2. `node reporter.js --hub http://localhost:7345 --token test123 --name test-machine`
   — collects and pushes; confirm with
   `curl -H "Authorization: Bearer test123" http://localhost:7345/snapshot` that the
   JSON matches the payload shape above and looks like real local data.
3. `node dashboard.js --hub http://localhost:7345 --token test123` — renders the one
   machine's section; compare visually against today's local dashboard output for
   the same machine (agents table, sub-agents, process tree, CPU/mem/disk/net, token
   graph) — should match.
4. Run a second `reporter.js` on the same machine with a different `--name`, pointed
   at the same hub, to simulate multi-machine without needing a second box — confirm
   the dashboard shows two distinct sections.
5. Kill one reporter, wait past `--stale-after` — confirm that machine's section
   grays out with a "stale" indicator and no crash, and that no false waiting-alert
   fires off its now-frozen data.
6. Reproduce a real waiting-transition (reuse the same synthetic-agent or
   stubbed-`fetchAgents` technique used earlier in this project to test the original
   waiting-alert) — confirm the bell/notification/banner fire with the machine name
   in the message, once, not once per tick.
7. Run the dashboard with a wrong `--token` — confirm a clear "unauthorized" banner
   rather than a silent empty machine list, and separately confirm a clear "hub
   unreachable" banner when the hub is down (connection refused), so the two failure
   modes are visually distinguishable.
8. Once local verification passes, point a reporter and the dashboard at the real
   Apache-fronted HTTPS URL from an actually separate machine, confirming the
   reverse-proxied path works end-to-end for both push and pull.
