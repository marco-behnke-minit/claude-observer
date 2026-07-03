# claude-observer

A dependency-free terminal dashboard for observing Claude Code agent activity
across **all your machines** — every agent session, the sub-agents and
processes it spawned, system vitals, and token spend, aggregated in one live
view with alerts when any session needs your input.

Three small Node processes, no npm packages:

```
┌────────────┐  POST /report   ┌─────────┐  GET /snapshot  ┌───────────┐
│ reporter.js│ ───────────────▶│  hub.js │ ◀────────────── │dashboard.js│
│ (each mac) │    every 3s     │(always- │    every 2s     │ (wherever  │
└────────────┘                 │  on)    │                 │  you are)  │
      ⋮ more machines ────────▶└─────────┘                 └───────────┘
```

- **`reporter.js`** runs on every machine with Claude Code sessions: collects
  agent sessions (`claude agents --json`), in-flight sub-agents and current
  model (from session transcripts), spawned process trees, CPU/memory/disk/
  network vitals, and token-spend history, then pushes a compact JSON snapshot
  to the hub. Push-based, so machines behind NAT/firewalls work — only
  outbound access to the hub is needed.
- **`hub.js`** is a tiny always-on HTTP server holding the latest snapshot per
  machine in memory. Self-contained single file — deploy it by copying it to
  the server. Speaks plain HTTP on `127.0.0.1` by default; put a TLS reverse
  proxy (e.g. Apache/nginx/Caddy) in front for internet exposure.
- **`dashboard.js`** is the terminal UI: pulls the aggregated snapshot from the
  hub and renders one section per machine. It never collects anything locally —
  even single-machine use runs a local reporter + hub.

## Quick start (single machine, all three locally)

```sh
cp .env.template .env    # then set CLAUDE_OBSERVER_TOKEN in .env
node hub.js &
node reporter.js &
node dashboard.js
```

All three processes read `.env` from their own directory (never committed —
it's gitignored). Every setting can also be passed as a CLI flag or a real
environment variable; precedence is flag > environment > `.env` > default.

Add machines by running another `reporter.js` on each, with its own `.env`
pointing at the hub's public HTTPS URL if proxied:

```sh
node reporter.js --name mac-mini --ssh-hint marco@mini.local
```

Press `q` or `Ctrl+C` to quit the dashboard — it uses the terminal's alternate
screen buffer, so quitting restores your scrollback.

## What the dashboard shows

Per machine (online machines first, stale ones grayed out at the bottom):

**Header** — `● name · last seen 2s ago · 3 sessions`, flipping to a red `○`
with a staleness note when the machine's reporter stops reporting (last-known
data stays visible, dimmed — a dead reporter is exactly when you want
visibility, not a blank). With `--hide-stale-after <seconds>`, machines
offline longer than that collapse into a one-line hidden count instead of
taking up a full section.

**Agent sessions** — every Claude Code session with status (waiting → busy →
idle → completed), current model, elapsed time, and project path. Under each
session: a ready-to-copy `ssh <hint> 'claude attach <sessionId>'` line to jump
into it, in-flight sub-agents as `↳` rows (reconstructed from the session's
transcript — `claude agents` itself can't see them), and the real process tree
of everything the session spawned (builds, tests, servers), with identical
sibling processes collapsed into `×N` rows.

**System vitals** — CPU per core, memory (Activity Monitor's accounting, not
Node's misleading `os.freemem()`), disk usage and I/O throughput, network
RX/TX.

**Token spend** — a bar chart with time/value axes of token usage mined from
that machine's `~/.claude/projects/*/*.jsonl` transcripts, switchable between
four rolling windows:

| Key | Range | Bucketed by |
|-----|-------|-------------|
| `h` | last hour  | minute |
| `d` | last day   | hour   |
| `w` | last week  | day    |
| `m` | last month | day    |

`Tab`/`→` and `←` cycle through the ranges.

**Alerts** — the moment any session on any machine transitions into `waiting`
(needs a permission prompt or other input), the dashboard fires a terminal
bell, a macOS notification, and an on-screen banner naming the machine and
session. Same mechanism fires once when a machine goes offline. Edge-triggered:
no re-alerting every refresh, and nothing fires for sessions already waiting
when the dashboard starts.

## Configuration

CLI flag wins over env var wins over `.env` (loaded from the script's own
directory, see `.env.template`) wins over default:

| Process | Flag | Env var | Default |
|---|---|---|---|
| reporter | `--hub <url>` | `CLAUDE_OBSERVER_HUB_URL` | required |
| reporter | `--token <t>` | `CLAUDE_OBSERVER_TOKEN` | required |
| reporter | `--name <n>` | `CLAUDE_OBSERVER_MACHINE` | hostname |
| reporter | `--ssh-hint <s>` | `CLAUDE_OBSERVER_SSH_HINT` | none (falls back to name) |
| reporter | `--interval <s>` | `CLAUDE_OBSERVER_PUSH_INTERVAL_S` | 3 |
| hub | `--port <p>` | `CLAUDE_OBSERVER_HUB_PORT` | 7345 |
| hub | `--bind <addr>` | `CLAUDE_OBSERVER_HUB_BIND` | `127.0.0.1` |
| hub | `--token <t>` | `CLAUDE_OBSERVER_TOKEN` | required |
| hub | `--stale-after <s>` | `CLAUDE_OBSERVER_STALE_S` | 15 |
| dashboard | `--hub <url>`, `--token <t>` | same as reporter | required |
| dashboard | `--hide-stale-after <s>` | `CLAUDE_OBSERVER_HIDE_STALE_S` | never hide |
| dashboard | positional first arg | — | refresh seconds, default 2 |

## Docker (hub and dashboard)

GitHub workflows build multi-arch (amd64/arm64) images for the hub and the
dashboard on every push to `main` touching their files, published to GitHub
Container Registry as `<repo>-hub` and `<repo>-dashboard`. Both read their
config from the environment, so run them with your `.env`:

```sh
# hub — inside the container it binds 0.0.0.0; the published port is the boundary
docker run -d -p 7345:7345 --env-file .env ghcr.io/<owner>/claude-observer-hub

# dashboard — needs an interactive TTY
docker run -it --env-file .env ghcr.io/<owner>/claude-observer-dashboard
```

Alternatively mount the file itself: `-v ./.env:/app/.env`. The reporter is
not dockerized — it must run directly on each macOS host to see its
sessions and system stats.

## Notes

- **Reporters are macOS-only** — they parse macOS-flavored `top`, `iostat`,
  `netstat`, `df`, `ps` output. The **hub runs anywhere** Node runs (it's pure
  `http`, typically a Linux server). The dashboard renders anywhere, though
  its desktop notifications use macOS `osascript` (bell and banner still work
  elsewhere).
- The hub is in-memory only: a restart just means machines reappear within one
  push interval. Reporters are self-healing too — a failed push is simply
  superseded by the next full snapshot.
- Security model: one shared bearer token for pushes and reads, TLS via your
  reverse proxy. Snapshots include command lines and paths from your machines
  — the reporter prunes the process tree to agent-spawned processes only and
  truncates commands, so unrelated processes never leave the machine.
- See `TECH.md` for the full architecture and payload schema.

## License

MIT — see [LICENSE](LICENSE).
