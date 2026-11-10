# Claude Time Tracker

Tray app that records active Claude Code time per task. Everything stays on this machine. See [PLAN.md](PLAN.md).

## Run

```bash
npm install
npm run dev      # dev mode with hot reload
npm test         # unit + local server tests
npm run build && npm start
```

On first launch the app opens **Claude Code setup**. It shows the exact changes to `~/.claude/settings.json`, saves a backup, and writes:

- telemetry env vars (metrics only, OTLP `http/json`, every 10 s, delta) pointing to `http://127.0.0.1:47821/v1/metrics`
- HTTP hooks for `UserPromptSubmit`, `Stop` and `SessionEnd`, plus a `curl` command hook for `SessionStart`

Restart open Claude Code sessions afterwards. **Remove tracker settings** in the same screen undoes it.

## Install (no terminal needed)

```bash
npm run dist:mac   # release/Claude-Time-Tracker-<version>-arm64.dmg and -x64.dmg
npm run dist:win   # release/Claude-Time-Tracker-Setup-<version>.exe
```

The builds are **not code-signed**. On macOS, the first time: right-click the app → Open → Open (or System Settings → Privacy & Security → Open Anyway). On Windows, SmartScreen → More info → Run anyway.

The installed app turns on **Start at login** on first run (toggle it in the menu bar). When started at login it stays in the menu bar without opening its window. Dev and installed builds share the same data folder; only one can run at a time.

## Features

- **Tasks:** Auto mode, pin a task, rename, merge one task into another.
- **Dashboard:** time per day, task and project folder for today / 7 / 30 days, and **Export CSV** (date, task, folder, h:mm, decimal hours).
- **Time log:** one day's time in blocks (session + task); move a block to another task.
- **Reminder:** a notification when 5+ minutes of the last 30 have no task, at most every 30 minutes. Toggle in the menu bar.

## How time is attributed

**Auto mode (default):** each Claude Code session gets a task named from its conversation. After Claude's first reply, the app runs `claude -p --model haiku` (your existing Claude login, a fraction of a cent per call) with the first prompt and the latest few messages, plus your task list. The model either reuses an existing task or names a new one ("Add CSV export"). Every 3 replies it checks again, so a change of topic starts a new task from that point. Time from before the first name is moved onto it. If naming fails (CLI missing, not logged in), the session goes under its folder name.

**Pinned:** pick a task in the tray and all time goes to it until you switch back to Auto.

Metrics arrive every 10 s, so a task switch can be off by about 10 s.

Prompts and replies are held in memory only (a few per session) to name tasks. They are never written to the database. The naming calls run with hooks and telemetry off, so they aren't tracked themselves.

## Layout

```
src/main/server/   local HTTP server: /hooks, /v1/metrics, /health
src/main/db/       SQLite schema, migrations, queries
src/main/tracker.ts pinned/auto task + tagging
src/main/naming/   auto task naming from the conversation (claude -p)
src/main/setup.ts  settings.json merge, backup, undo
src/main/tray.ts   tray menu
src/main/export.ts timesheet CSV
src/main/reminder.ts untagged time reminder
src/renderer/      task and setup window (React)
tests/             vitest
```

Data: `~/Library/Application Support/claude-time-tracker/tracker.db` on macOS. Port can be changed with `CTT_PORT` (re-run setup after).
