# Claude Code Time Tracker – Electron App Plan
 
Nov 10, 2026 · @Ankit
 
## Goal
 
Build a desktop tray app that automatically records how much active time a developer spends in Claude Code, broken down by task, and shows it in a simple dashboard. Version 1 needs no cloud service.
 
The plan assumes one developer on one machine to start, designed so team syncing can be added later without a rewrite.
 
## Architecture
 
One Electron process holds three parts: a local server, a SQLite database, and a tray with a dashboard window.
 
```
Claude Code (developer's machine)
   |-- OTLP metrics (active time) --> Local server (127.0.0.1) --tagged with current task--> SQLite
   |-- HTTP hook events ------------>        ^                                                  |
                                             | current task                         time totals |
                                      Tray + dashboard window <------------------------------------
```
 
He selects a task in the tray. Claude Code sends active-time metrics and hook events to the local server, which tags each record with the task selected at that moment and saves it. The dashboard reads the totals back from the database.
 
- **Local server (main process):** listens on `127.0.0.1` only, with one endpoint for OpenTelemetry metrics and one for hook events.
- **SQLite database:** uses `better-sqlite3` to store tasks, sessions, events, and time records.
- **Tray and dashboard (React):** the tray shows the current task, today's total, and a quick switcher; the dashboard shows time per task, per day, and per project folder.
## What each data source provides
 
Telemetry supplies the time numbers; hooks supply the structure around them.
 
| Source | What it gives | Key setting |
| --- | --- | --- |
| [Telemetry](https://docs.claude.com/en/docs/claude-code/monitoring-usage) | `claude_code.active_time.total` in seconds, idle time excluded, split into user and cli time | Export interval of about 10 s instead of the default 60 s, so task switches are attributed accurately |
| [Hooks](https://code.claude.com/docs/en/hooks.md) | SessionStart and SessionEnd (once per session), UserPromptSubmit and Stop (once per turn), with session ID and working folder | Configured as HTTP hooks, so Claude Code POSTs each event straight to the app with no script |
 
For time tracking, the four hook events above are enough. They show when a session began, which folder it ran in, and when he was prompting versus when Claude was working.
 
## Data model
 
Four SQLite tables hold everything; prompt text is never stored.
 
| Table | Columns |
| --- | --- |
| tasks | id, name, project, status, created\_at |
| sessions | session\_id, cwd (project folder), started\_at, ended\_at, task\_id |
| events | id, session\_id, type, timestamp, task\_id |
| time\_records | id, session\_id, task\_id, kind (user or cli), seconds, timestamp |
 
Privacy choice: the UserPromptSubmit hook payload includes the prompt text, and Stop includes Claude's last reply. The app keeps a few recent messages per session in memory only, to name tasks automatically, and never saves them; the database keeps only the timestamp, event type and the task name.

## Auto task naming (added Nov 10, 2026)

Tasks are named from the conversation instead of picked by hand. After Claude's first reply in a session, the app runs `claude -p --model haiku` with the first prompt, the latest messages and the existing task list; the model reuses a task or names a new one. It re-checks every 3 replies, so a topic change starts a new task. Each session has its own task, so parallel sessions are tracked separately. A task pinned in the tray overrides auto mode. Naming calls run with hooks and telemetry turned off so they aren't tracked.
 
## Build phases
 
A usable single-developer tracker takes about 2 weeks; the team version adds 2 to 3 weeks and is optional.
 
### Phase 1: Core tracker (about 1 week)
 
- [x] Scaffold Electron with `electron-vite` and React
- [x] Build the local server with OTLP and hook endpoints (use the `http/json` protocol, which is easier to parse than protobuf)
- [x] Set up the SQLite schema and the logic that tags records with the current task
- [x] Add the tray menu with a task picker, a "no task" state, and today's total
- [x] Add one-click setup that writes the telemetry variables and HTTP hooks into `~/.claude/settings.json`, backing up the original and asking for confirmation first
### Phase 2: Dashboard and polish (about 1 week)
 
- [x] Charts of time per task, per day, and per project folder (Recharts)
- [x] Manual correction screen to move a time block to another task (Time log tab; plus rename and merge tasks)
- [ ] CSV export for timesheets or invoicing
- [ ] Reminder when Claude Code is active but no task is selected
- [ ] Auto-start at login; Windows and Mac installers with `electron-builder`
### Phase 3: Team version (2 to 3 weeks, only if needed)
 
- [ ] Central server (Node with Postgres) where each app pushes records using a device token
- [ ] Web dashboard showing all developers
- [ ] Optional task import from Jira, ClickUp, or similar, so developers pick real tickets
## Risks
 
Forgotten task switches are the biggest threat to accuracy.
 
| Risk | Mitigation |
| --- | --- |
| Forgotten task switches | Reminders, the correction screen, and optional task suggestions based on the project folder |
| Claude Code updates change metric or hook details | Rely only on documented features, never on parsing transcript files; retest after Claude Code updates |
| App not running, so data is lost | Auto-start at login; the tray icon clearly shows when tracking is active |
| Trust | The developer knows about the app and can see his own data; visible tracking works far better than hidden tracking |
 
## Confirm before coding
 
These are small details, but the code depends on them; check each against the current Claude Code docs.
 
- [x] Exact HTTP hook config format: `{"type": "http", "url": "...", "timeout": 2}`. **SessionStart does not support HTTP hooks** (command and mcp_tool only), so it uses a `curl` command hook; sessions are also created on first sight from any hook or metric. Replies must be 2xx with an empty or JSON body; plain text counts as a hook error.
- [x] Metric temporality setting: `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` (already the default; set explicitly). The parser also handles cumulative.
- [x] Name of the export-interval variable: `OTEL_METRIC_EXPORT_INTERVAL` (milliseconds, default 60000; set to 10000)

Checked against the docs on Nov 10, 2026. Also: the Stop hook payload includes `last_assistant_message`, which is dropped like the prompt text.
## Sources
 
- [Claude Code monitoring usage](https://docs.claude.com/en/docs/claude-code/monitoring-usage)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks.md)
