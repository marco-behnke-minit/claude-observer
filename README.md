# claude-observer

A single-file, dependency-free terminal dashboard for observing Claude Code
background activity — every agent session across every project, plus basic
system vitals — refreshing live in your terminal.

Built because `claude agents` (Claude Code's own background-session view)
didn't render as an interactive TUI in every terminal setup, and gave no
visibility into sub-agents spawned *within* a session or into system
resource usage while agents are running.

## Requirements

- macOS (uses `top`, `df`, `iostat`, `netstat` — all macOS-flavored output
  parsing, not portable to Linux/Windows as-is)
- Node.js (no npm install, no dependencies — just built-in modules)
- The `claude` CLI available on `PATH`

## Usage

```
node dashboard.js          # refreshes every 2s
node dashboard.js 5        # refresh every 5s
```

For live development, run it under Node's built-in watch mode so it
restarts automatically on save:

```
node --watch --watch-preserve-output dashboard.js
```

Press `q` or `Ctrl+C` to quit — the dashboard uses the terminal's alternate
screen buffer, so quitting restores your normal scrollback.

## What it shows

**Agent sessions** — every background Claude Code session across all
projects (from `claude agents --json --all`), sorted by state (waiting →
busy → idle → completed), with name, status, elapsed time, PID, and project
path. Sessions that are dispatching their own sub-agents (via the Agent
tool) show them nested underneath as `↳` rows — `claude agents` itself has
no visibility into those, since they run inside the parent process rather
than as separate OS-level sessions, so their live/finished state is
reconstructed by reading the session's own transcript.

**System vitals** — CPU usage per core, memory (matching Activity Monitor's
accounting, not Node's misleading `os.freemem()`), disk usage and I/O
throughput, and network RX/TX.

**Token spend** — a sparkline of token usage mined from
`~/.claude/projects/*/*.jsonl` transcripts across all projects, switchable
between four rolling windows:

| Key       | Range | Bucketed by |
|-----------|-------|-------------|
| `h`       | last hour  | minute |
| `d`       | last day   | hour   |
| `w`       | last week  | day    |
| `m`       | last month | day    |

`Tab`/`→` and `←` cycle through the ranges. The underlying scan runs on its
own 30s cadence (independent of the display refresh) since transcripts can
be large.

**Waiting alert** — the moment any session transitions into `waiting`
(needs a permission prompt or other input), the dashboard fires a terminal
bell, a macOS notification, and a short-lived on-screen banner. It only
fires on the transition, not on every tick, and doesn't fire for sessions
that were already waiting before the dashboard was started.

## Notes

- Nothing here is a general-purpose systems tool — the shell commands
  (`iostat`, `netstat -ib`, `top -l 1`, `df -h`) are parsed for their macOS
  output format specifically.
- All system-vitals fetches run in parallel each tick; disk I/O sampling
  takes ~1s (`iostat -w 1`) but is guarded against overlapping calls if the
  refresh interval is set lower than that.

## License

MIT — see [LICENSE](LICENSE).
